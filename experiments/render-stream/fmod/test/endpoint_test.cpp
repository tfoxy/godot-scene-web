#include "grc_fmod.h"
#include "clock.hpp"
#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <iostream>
#include <map>
#include <mutex>
#include <new>
#include <thread>
using grc::audio::Bytes;
using grc::audio::LinkMessage;
namespace fs = std::filesystem;
namespace {
thread_local bool callback_phase = false;
std::atomic<unsigned> callback_allocations{0}, callbacks{0};
struct Message { unsigned seat; LinkMessage value; };
struct Harness {
  grc_fmod_v1 api{};
  std::map<std::string,std::string> config;
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<Message> messages;
  std::vector<std::string> logs;
  std::thread::id caller = std::this_thread::get_id();
  std::atomic<bool> wrong_thread{false};
  void thread() { if (std::this_thread::get_id() == caller) wrong_thread = true; }
  static const char *get(void *self, const char *name) {
    auto &h = *static_cast<Harness *>(self); h.thread();
    auto it = h.config.find(name); return it == h.config.end() ? nullptr : it->second.c_str();
  }
  static void output(void *self, uint32_t seat, const uint8_t *p, size_t n) {
    auto &h = *static_cast<Harness *>(self); h.thread();
    // A reentrant state query would deadlock if the module called out under its lock.
    char reason[128]; h.api.state(h.api.self, reason, sizeof(reason));
    std::lock_guard lock(h.mutex); h.messages.push_back({seat, grc::audio::decode_link(Bytes(p,p+n))}); h.changed.notify_all();
  }
  static void log(void *self, int, const char *p, size_t n) {
    auto &h = *static_cast<Harness *>(self); h.thread();
    std::lock_guard lock(h.mutex); h.logs.emplace_back(p,n); h.changed.notify_all();
  }
  void require(bool ok, const std::string &why) { if (!ok) throw std::runtime_error(why); }
  template<class F> void wait(F condition, const std::string &why) {
    std::unique_lock lock(mutex);
    if (!changed.wait_for(lock, std::chrono::seconds(10), condition)) {
      std::string detail = why; for (auto &line : logs) detail += " | " + line;
      throw std::runtime_error("timeout: " + detail);
    }
  }
  void send(unsigned seat, const LinkMessage &m) {
    auto b = grc::audio::encode_link(m); api.link_in(api.self,seat,b.data(),b.size());
  }
  void open(unsigned seat) {
    unsigned before; {std::lock_guard lock(mutex);before=count(seat,0);}
    api.seat_open(api.self,seat);
    wait([&] { return count(seat,0)>before; },"host hello");
    LinkMessage hello; hello.clock_domain = grc::fmod::clock_domain(); hello.bankset = std::string(32,'0'); send(seat,hello);
  }
  LinkMessage want(unsigned seat, const std::string &key) {
    LinkMessage m; m.type=5; m.key=key; m.key_id=grc::audio::key_id(key); m.t_us=grc::fmod::now_us(); send(seat,m); return m;
  }
  unsigned count(unsigned seat, unsigned type, const std::string &key = "") {
    return std::count_if(messages.begin(),messages.end(),[&](const auto &m){return m.seat==seat && m.value.type==type && (key.empty()||m.value.key_id==key);});
  }
  void mask(unsigned seat, unsigned bits) { LinkMessage m; m.type=6; m.lane_mask=bits; send(seat,m); }
  void observe(unsigned op, uint64_t id, const std::string &s = "", float v = 0) { api.observe(api.self,op,id,s.data(),s.size(),v); }
  std::string index() {
    grc_fmod_buf b{}; require(api.take_index(api.self,&b)==1,"index");
    std::string s(reinterpret_cast<const char *>(b.data),b.len); api.release(api.self,b.owner); return s;
  }
  // A hello sent after earlier commands is an ordered module-thread barrier.
  void barrier(unsigned seat) { open(seat); }
  bool lane(const Message &m, unsigned seat, unsigned id, bool energy=false) {
    if (m.seat!=seat || m.value.type!=1) return false;
    auto b=grc::audio::decode_block(m.value.block);
    return b.header.kind==2 && b.header.lane==id && (!energy || std::any_of(b.payload.begin(),b.payload.end(),[](auto c){return c!=0;}));
  }
};
void *load(const std::string &path, int flags=RTLD_NOW|RTLD_LOCAL) {
  auto *p=dlopen(path.c_str(),flags); if(!p) throw std::runtime_error(dlerror()); return p;
}
}
extern "C" void grc_test_callback_phase(int enabled) { callback_phase = enabled; if(enabled) ++callbacks; }
void *operator new(std::size_t n) { if(callback_phase) ++callback_allocations; if(auto *p=std::malloc(n?n:1))return p;throw std::bad_alloc(); }
void operator delete(void *p) noexcept {std::free(p);}
void operator delete(void *p,std::size_t) noexcept {std::free(p);}
void *operator new[](std::size_t n) {return ::operator new(n);}
void operator delete[](void *p) noexcept {std::free(p);}
void operator delete[](void *p,std::size_t) noexcept {std::free(p);}
int main(int argc,char **argv) {
 try {
  if(argc<4) throw std::runtime_error("endpoint arguments");
  Harness h; const bool install=std::string(argv[2])=="install";
  std::string core,studio,pck;
  if(install) {
    const char *dir=std::getenv("GRC_FMOD_TEST_GAME_DIR"), *ref=std::getenv("GRC_FMOD_TEST_REFERENCE");
    if(!dir||!*dir||!ref||!*ref) {std::cout<<"SKIP native endpoint: set GRC_FMOD_TEST_GAME_DIR and GRC_FMOD_TEST_REFERENCE\n";return 0;}
    h.require(fs::is_regular_file(fs::path(ref)/"manifest.json"),"missing reference manifest");
    core=(fs::path(dir)/"libfmod.so.14").string(); studio=(fs::path(dir)/"libfmodstudio.so.14").string();
    for(const auto &e:fs::directory_iterator(dir)) if(e.path().extension()==".pck") {h.require(pck.empty(),"ambiguous PCK");pck=e.path().string();}
    h.require(!pck.empty(),"missing PCK");load(core,RTLD_NOW|RTLD_GLOBAL);load(studio);
  } else { h.require(argc==6,"fake endpoint arguments"); core=studio=argv[4];pck=argv[5];load(core); }
  auto output=fs::path(argv[3]); fs::create_directories(output);
  const auto disk=output/"endpoint-cache";fs::remove_all(disk);
  h.config={{"core_lib",core},{"studio_lib",studio},{"pck_path",pck},{"take_cache_dir",disk.string()},
    {"lanes","1:music:bus:/master/music,2:ambience:bus:/master/ambience:amb,3:sfx:bus:/master/sfx"}};
  auto *module=load(argv[1]);
  auto get=reinterpret_cast<int (*)(grc_fmod_v1 *)>(dlsym(module,"grc_fmod_get_v1"));
  h.require(get&&get(&h.api)==1,"ABI");
  grc_fmod_host_v1 host{1,sizeof(host),&h,Harness::get,Harness::output,Harness::log};char error[128]{};
  h.require(h.api.start(h.api.self,&host,nullptr,error,sizeof(error))==1,std::string("start: ")+error);
  h.open(1);h.open(2);
  const std::string key="event:/sfx/ui/clicks/ui_hover";
  auto want=h.want(1,key);h.want(2,key);
  if(!install) {
    // The fake library has startup APIs but lacks render symbols: worker failure is asynchronous.
    h.wait([&]{return h.count(1,4)==1&&h.count(2,4)==1;},"pending wants lost on worker failure");
    h.require(h.api.state(h.api.self,error,sizeof(error))==0,"async failure did not turn off");
    h.want(1,key);h.open(3);h.want(3,key);
    h.wait([&]{return h.count(1,4)==2&&h.count(3,4)==1;},"disabled endpoint stopped answering");
    {std::lock_guard lock(h.mutex);h.require(h.logs.size()==1,"failure did not log once");
      for(auto &m:h.messages) if(m.value.type==4)h.require(m.value.reason==3,"async unavailable reason");}
    h.require(h.api.start(h.api.self,&host,nullptr,error,sizeof(error))==0,"async failure did not latch");
  } else {
    h.wait([&]{return h.count(1,3)==1&&h.count(2,3)==1;},"cold take fanout");
    std::string hash; Bytes pcm[2];unsigned streams[2]{};
    {std::lock_guard lock(h.mutex);
      for(unsigned seat=1;seat<=2;++seat) {
        unsigned frames=0,block=0,declared=0;bool last=false;
        for(const auto &m:h.messages) if(m.seat==seat) {
          if(m.value.type==2){streams[seat-1]=m.value.stream;declared=m.value.frames;}
          if(m.value.type==1) {
            auto b=grc::audio::decode_block(m.value.block);
            h.require(b.header.kind==1&&b.header.stream==streams[seat-1]&&b.header.block==block++&&b.header.sent_us==0,"take header");
            h.require(!last&&bool(b.header.flags&1)==(frames==0),"take block boundaries");last=b.header.flags&2;
            frames+=b.header.frames;pcm[seat-1].insert(pcm[seat-1].end(),b.payload.begin(),b.payload.end());
          }
          if(m.value.type==3){if(hash.empty())hash=m.value.wav_sha256;h.require(hash==m.value.wav_sha256,"dedup hash mismatch");}
        }
        h.require(frames==declared&&last&&frames>0,"incomplete take");
      }
      h.require(streams[0]!=streams[1]&&pcm[0]==pcm[1],"dedup canonical bytes/stream identity");
    }
    grc_fmod_buf wav{};Bytes digest;
    for(unsigned i=0;i<32;++i)digest.push_back(std::stoul(hash.substr(i*2,2),nullptr,16));
    h.require(h.api.take_get(h.api.self,digest.data(),&wav)==1,"warm WAV route");
    h.require(wav.len==pcm[0].size()+44&&std::equal(pcm[0].begin(),pcm[0].end(),wav.data+44),"WAV/PCM bytes");
    h.api.release(h.api.self,wav.owner);
    const auto cached=h.index();h.require(cached.find(hash)!=std::string::npos,"take absent from index");
    h.want(1,key);h.wait([&]{return h.count(1,3)==2;},"warm replay");
    auto loop=h.want(1,"event:/music/act1_b1_v1");
    auto unknown=h.want(1,"event:/sfx/does-not-exist");
    h.wait([&]{return h.count(1,4,loop.key_id)&&h.count(1,4,unknown.key_id);},"refusals");
    {std::lock_guard lock(h.mutex);for(auto &m:h.messages)if(m.value.type==4)h.require(m.value.reason==(m.value.key_id==loop.key_id?0:2),"refusal reason key="+m.value.key_id+" actual="+std::to_string(m.value.reason));}
    // Snapshot and bank evidence can arrive while the lane media clock is dormant.
    h.observe(1,0,"res://not-configured.bank");h.observe(2,0,"res://not-configured.bank");
    h.observe(8,0,"Progress",.5f);
    h.observe(3,11,"event:/music/act1_b1_v1");h.observe(9,11,"",1);h.observe(4,11);
    h.observe(3,12,"event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_slime");h.observe(7,12,"EnemyImpact_Intensity",2);h.observe(6,12);
    h.barrier(10);
    {std::lock_guard lock(h.mutex);h.require(std::none_of(h.messages.begin(),h.messages.end(),[&](const auto &m){return h.lane(m,1,1);}),"lane clock exists without subscription");}
    h.mask(1,2);h.mask(2,4);
    h.wait([&]{return std::count_if(h.messages.begin(),h.messages.end(),[&](auto &m){return h.lane(m,1,1);})>=3;},"paused lane");
    {std::lock_guard lock(h.mutex);for(const auto &m:h.messages)if(h.lane(m,1,1))h.require(grc::audio::decode_block(m.value.block).header.flags&4,"paused event made PCM");}
    h.observe(3,13,"event:/sfx/enemy/enemy_impact_enemy_size/enemy_impact_slime");
    h.observe(7,13,"EnemyImpact_Intensity",2);h.observe(4,13);h.observe(5,13,"",1);h.observe(6,13);
    h.observe(9,11,"",0);
    h.wait([&]{return std::count_if(h.messages.begin(),h.messages.end(),[&](auto &m){return h.lane(m,1,1,true);})>=3;},"music PCM");
    // Invalid canonical spellings fail seat 1 without stopping seat 2 or FMOD.
    for (const auto *suffix : {"|p=1.0", "|p"}) {
      auto bad=h.want(1,key+suffix);
      h.wait([&]{return h.count(1,4,bad.key_id)>0;},"noncanonical want unavailable");
      {std::lock_guard lock(h.mutex);for(const auto &m:h.messages)if(m.seat==1&&m.value.type==4&&m.value.key_id==bad.key_id)
        h.require(m.value.reason==4,"noncanonical want disabled whole module");}
      h.require(h.api.state(h.api.self,error,sizeof(error))==1,"noncanonical want latched FMOD off");
      unsigned ready;size_t blocks;
      {std::lock_guard lock(h.mutex);ready=h.count(2,3);blocks=std::count_if(h.messages.begin(),h.messages.end(),[&](const auto &m){return h.lane(m,2,2);});}
      h.want(1,key);h.want(2,key);
      h.wait([&]{return h.count(2,3)==ready+1&&std::count_if(h.messages.begin(),h.messages.end(),[&](const auto &m){return h.lane(m,2,2);})>static_cast<long>(blocks);},"noncanonical seat stopped peer take/lane");
      {std::lock_guard lock(h.mutex);h.require(std::any_of(h.messages.begin(),h.messages.end(),[&](const auto &m){return m.seat==1&&m.value.type==4&&m.value.key_id==want.key_id&&m.value.reason==4;}),"failed seat accepted subsequent want");}
      h.api.seat_close(h.api.self,1);h.open(1);h.mask(1,2);
    }
    h.require(h.index()==cached,"live lane entered take cache/index");
    unsigned epoch=0;uint64_t prior_due=0;unsigned prior_block=0,seen=0;
    {std::lock_guard lock(h.mutex);for(const auto &m:h.messages)if(m.value.type==1) {
      auto b=grc::audio::decode_block(m.value.block);if(b.header.kind!=2)continue;
      h.require((m.seat==1&&b.header.lane==1)||(m.seat==2&&b.header.lane==2),"lane leaked across masks");
      h.require(b.header.frames==512&&b.header.sent_us==0&&b.header.stream!=0,"lane header");
      if(m.seat==1) {
        if(!seen++)h.require(b.header.block==0&&(b.header.flags&1),"lane epoch first block");
        else h.require(b.header.block>prior_block&&b.header.due_us>prior_due,"lane clock order");
        epoch=b.header.stream;prior_block=b.header.block;prior_due=b.header.due_us;
      }
    }}
    h.mask(1,0);h.mask(2,0);h.barrier(20);
    size_t dormant;{std::lock_guard lock(h.mutex);dormant=h.messages.size();}
    h.barrier(21);
    {std::lock_guard lock(h.mutex);for(size_t i=dormant;i<h.messages.size();++i)h.require(h.messages[i].value.type!=1,"dormant renderer emitted PCM");}
    h.mask(1,2);
    h.wait([&]{for(const auto &m:h.messages)if(h.lane(m,1,1,true)&&grc::audio::decode_block(m.value.block).header.stream>epoch)return true;return false;},"rejoin snapshot music");
    {std::lock_guard lock(h.mutex);auto first=std::find_if(h.messages.begin(),h.messages.end(),[&](const auto &m){return h.lane(m,1,1)&&grc::audio::decode_block(m.value.block).header.stream>epoch;});
      h.require(first!=h.messages.end()&&grc::audio::decode_block(first->value.block).header.block==0,"rejoin epoch reset");}
    h.observe(5,11,"",1);h.observe(6,11);h.mask(1,0);h.barrier(22);
    unsigned files=0;for(const auto &e:fs::recursive_directory_iterator(disk))if(e.is_regular_file())++files;
    h.require(files==1&&h.index()==cached,"lanes or refusals stored on disk");
    h.require(h.api.state(h.api.self,error,sizeof(error))==1,std::string("lane state: ")+error);
    h.require(callbacks>0&&callback_allocations==0,"file/DSP callbacks allocated or uninstrumented");
    // A lane API failure latches the whole module, while preserving link service.
    h.mask(1,2);h.barrier(23);
    size_t failure_begin;{std::lock_guard lock(h.mutex);failure_begin=h.messages.size();}
    h.observe(3,99,"event:/does-not-exist");auto failed=h.want(1,key);
    h.wait([&]{return std::any_of(h.messages.begin()+failure_begin,h.messages.end(),[&](const auto &m){return m.seat==1&&m.value.type==4&&m.value.key_id==failed.key_id;});},"lane failure lost queued want");
    h.require(h.api.state(h.api.self,error,sizeof(error))==0,"lane error did not latch");
    h.open(24);h.want(24,key);
    h.wait([&]{return h.count(24,4)==1;},"lane failure killed endpoint");
    h.require(h.api.start(h.api.self,&host,nullptr,error,sizeof(error))==0,"lane failure restart");
    {std::lock_guard lock(h.mutex);
      h.require(std::count_if(h.logs.begin(),h.logs.end(),[](const auto &s){return s.starts_with("grc_fmod off:");})==1,"lane failure log count");
      for(size_t i=failure_begin;i<h.messages.size();++i) {
        const auto &m=h.messages[i];
        if(m.value.type==4&&m.value.key_id==failed.key_id)h.require(m.value.reason==3,"lane failure reason");
      }}
    std::cout<<"native takes=5 lane_epochs=3 cache_files="<<files<<" callback_allocations="<<callback_allocations<<'\n';
  }
  h.api.stop(h.api.self);
  if(install)h.wait([&]{return std::any_of(h.logs.begin(),h.logs.end(),[](const auto &s){return s=="grc_fmod banks: load=1 unload=1 bank-unknown=2";});},"bank observation evidence");
  h.require(!h.wrong_thread,"callback ran on product thread");
  std::cout<<"PASS native endpoint "<<(install?"install":"async-latch")<<'\n';
  // Callbacks and their context outlive asynchronous teardown through process exit.
  std::cout.flush();std::cerr.flush();std::_Exit(0);
 }catch(const std::exception &e){std::cerr<<"FAIL "<<e.what()<<'\n';std::cerr.flush();std::_Exit(1);}
}
