#include "rs_audio_reference.h"
#include "rs_audio_hub.h"
#include "rs_platform.h"
#include "rs_sha256.h"
#include <chrono>
#include <limits>
#include <stdexcept>
namespace grc::audio {
namespace {
constexpr std::string_view key="event:/reference";
}
ReferenceLink::ReferenceLink() {
  grc_audio_cue_get_v1(&cue_);
  cue_.key_id(key.data(),key.size(),id_.data());
  const grc_audio_gain groups[]={{"SFX",3,1},{"Music",5,0.25f}};
  cue_.groups(groups,2,1);
  worker_=std::thread([this] { run(); });
  const grc_audio_link_v1 link{1,sizeof(link),this,output};
  if (grc_audio_link_attach_v1(&link)!=1) {
    disconnect(); throw std::runtime_error("reference link attach failed");
  }
  std::unique_lock lock(mu_);
  const auto connected=cv_.wait_for(lock,std::chrono::seconds(10),[&] { return ready_ || failed_; });
  if (!connected || failed_) {
    lock.unlock(); disconnect(); throw std::runtime_error("reference link hello failed");
  }
}
ReferenceLink::~ReferenceLink() { disconnect(); }
void ReferenceLink::disconnect() {
  grc_audio_link_attach_v1(nullptr);
  { std::lock_guard lock(mu_); stopping_=true; }
  cv_.notify_all();
  if (worker_.joinable()) worker_.join();
}
int ReferenceLink::cue() {
  return cue_.cue(1,id_.data(),key.data(),key.size(),"SFX",3,cue_.now_us(),1,1);
}
int ReferenceLink::output(void *self,const std::uint8_t *msg,std::size_t len) {
  auto &link=*static_cast<ReferenceLink *>(self);
  { std::lock_guard lock(link.mu_);
    if (link.stopping_) return 0;
    link.incoming_.emplace_back(msg,msg+len);
  }
  // The constructor and host worker wait on different predicates of this CV.
  link.cv_.notify_all(); return 1;
}
bool ReferenceLink::send(const LinkMessage &msg) {
  const auto bytes=encode_link(msg);
  return grc_audio_link_in(bytes.data(),bytes.size())==1;
}
void ReferenceLink::take(const LinkMessage &want) {
  if (next_take_==std::numeric_limits<std::uint32_t>::max()) {
    LinkMessage m; m.type=4; m.key_id=want.key_id; m.reason=3; send(m); return;
  }
  const auto stream=next_take_++;
  LinkMessage m; m.type=2; m.key_id=want.key_id; m.stream=stream; m.frames=1024;
  if (!send(m)) return;
  // This immutable canonical WAV is the synthetic host's cache entry.
  static const auto wav=Hub::synthetic_wav();
  static const auto hash=sha256_hex(wav.data(),wav.size());
  for (unsigned n=0;n<2;++n) {
    Block b; b.header.stream=stream; b.header.block=n; b.header.frames=512;
    b.header.flags=n?2:1; b.header.made_us=now_us(); b.header.due_us=want.t_us+n*512000000ull/48000;
    b.payload.assign(wav.begin()+44+n*2048,wav.begin()+44+(n+1)*2048);
    m={}; m.type=1; m.block=encode_block(b.header,b.payload);
    if (!send(m)) return;
  }
  m={}; m.type=3; m.key_id=want.key_id; m.stream=stream; m.wav_sha256=hash; send(m);
}
void ReferenceLink::run() {
  rs::set_current_thread_name("rs-link-media");
  std::uint16_t mask=0;
  std::uint32_t epoch=0, block=0;
  std::uint64_t origin=0;
  std::unique_lock lock(mu_);
  while (!stopping_) {
    if (!incoming_.empty()) {
      auto bytes=std::move(incoming_.front()); incoming_.pop_front(); lock.unlock();
      const auto m=decode_link(bytes);
      if (m.type==0) {
        LinkMessage reply; reply.clock_domain=clock_domain(); reply.bankset=std::string(32,'1');
        reply.lanes={{1,"reference music","Music"}};
        const bool ok=send(reply);
        lock.lock(); ready_=ok; failed_=!ok; cv_.notify_all(); continue;
      }
      if (m.type==5) take(m);
      else if (m.type==6) {
        if (!mask && m.lane_mask) { ++epoch; block=0; origin=now_us(); }
        mask=m.lane_mask;
      }
      lock.lock(); continue;
    }
    if (!mask) { cv_.wait(lock,[&] { return stopping_ || !incoming_.empty(); }); continue; }
    // No lane clock or timed wake exists when the union mask is zero.
    const auto due=origin+std::uint64_t(block)*512000000ull/48000;
    if (cv_.wait_until(lock,std::chrono::steady_clock::time_point(std::chrono::microseconds(due)),
        [&] { return stopping_ || !incoming_.empty(); })) continue;
    lock.unlock();
    Block b; b.header.kind=2; b.header.lane=1; b.header.stream=epoch;
    b.header.block=block++; b.header.frames=512; b.header.made_us=now_us(); b.header.due_us=due;
    b.payload.resize(2048);
    LinkMessage m; m.type=1; m.block=encode_block(b.header,b.payload); send(m);
    lock.lock();
  }
}
} // namespace grc::audio
