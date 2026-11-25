#include "cache.hpp"
#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <future>
#include <set>
#include <iostream>
#include <stdexcept>
using namespace grc::fmod;
void require(bool value, const char *why) { if (!value) throw std::runtime_error(why); }
int main(int argc, char **argv) {
 try {
  require(argc == 2, "scratch argument");
  require(!allow_oneshot(false), "non-one-shot accepted");
  require(allow_oneshot(true), "one-shot refused");
  std::vector<float> samples(3072 * 2, .1f);
  const double energy = samples.size() * .01;
  for (unsigned bus = 2; bus <= 3; ++bus) {
    std::array<double,4> meter{energy, energy, 0, 0}; meter[bus] = 20;
    auto take = validate_take(samples, meter, false);
    require(take.reason == "refused-bus" && take.wav.empty() && take.pcm.empty(), "late bus leaked PCM");
  }
  auto good = std::make_shared<Take>(validate_take(samples, {energy,energy,0,0}, false));
  require(good->frames == 3072 && good->wav.size() == 44+samples.size()*2, "pure SFX rejected");
  std::vector<float> long_samples(480000 * 2, .5f);
  auto capped = validate_take(long_samples, {1,1,0,0}, true);
  require(capped.frames == 480000 && capped.capped, "cap missing");
  require(capped.pcm[capped.pcm.size()-1] == 0, "cap fade missing");
  std::filesystem::path directory = std::filesystem::path(argv[1]) / "cache-test";
  std::filesystem::remove_all(directory);
  auto cache = std::make_shared<TakeCache>(std::string(32,'a'), good->wav.size(), directory.string());
  cache->put("event:/sfx/a", good);
  auto index = cache->index(); require(std::string(index->begin(), index->end()).find(good->hash) != std::string::npos, "index missing hash");
  require(cache->hash(good->hash) == good, "hash lookup");
  Buffers buffers; grc_fmod_buf lent{};
  require(buffers.lend(std::shared_ptr<const Bytes>(good,&good->wav), &lent)==1 && lent.owner, "lend failed");
  const auto first = lent.data[0];
  std::vector<float> other_samples(samples.size(), .2f);
  auto other = std::make_shared<Take>(validate_take(other_samples, {energy*4,energy*4,0,0}, false));
  cache->put("event:/sfx/b", other);
  require(cache->bytes() == good->wav.size() && lent.data[0] == first, "eviction invalidated buffer");
  require(cache->find("event:/sfx/a")->wav == good->wav, "disk reload failed");
  auto refused = std::make_shared<Take>(); refused->reason = "refused-bus";
  cache->put("event:/sfx/refused", refused);
  require(!cache->find("event:/sfx/refused"), "refusal cached");
  TakeCache restarted(std::string(32,'a'), 0, directory.string());
  require(restarted.hash(good->hash)->wav == good->wav, "persisted hash missing after restart");
  require(!cache->hash(other->hash) || cache->hash(other->hash)->hash == other->hash, "hash lookup returned wrong bytes");
  cache.reset(); good.reset();
  require(lent.data[0] == first, "cache destruction invalidated loan");
  buffers.release(lent.owner); buffers.release(lent.owner); buffers.release(nullptr);
  require(buffers.unknown()==2, "unknown releases uncounted");
  for (unsigned workers : {1u,2u}) {
    auto memory = std::make_shared<TakeCache>(std::string(32,'b'), 1<<20, "");
    std::atomic<unsigned> renders{0}, callbacks{0};
    std::promise<void> entered, unblock; auto gate = unblock.get_future().share();
    std::promise<void> finished; auto done = finished.get_future();
    const auto caller = std::this_thread::get_id();
    TakePool pool({}, workers, memory, [](const std::string &s){throw std::runtime_error(s);},
      [&](const std::string &) { ++renders; entered.set_value(); gate.wait(); return *other; });
    auto listener = [&](SharedTake take) {
      require(std::this_thread::get_id()!=caller && take->reason.empty(), "product thread callback");
      if (++callbacks == 3) finished.set_value();
    };
    pool.request("event:/sfx/shared",listener); entered.get_future().wait();
    pool.request("event:/sfx/shared",listener); pool.request("event:/sfx/shared",listener);
    unblock.set_value(); require(done.wait_for(std::chrono::seconds(10))==std::future_status::ready,"worker stalled");
    require(renders==1 && callbacks==3, "cold request not deduplicated");
    std::promise<void> hit; auto hit_done = hit.get_future();
    pool.request("event:/sfx/shared",[&](SharedTake){hit.set_value();}); hit_done.wait();
    require(renders==1, "cache hit rerendered"); pool.stop();
  }
  {
    auto memory = std::make_shared<TakeCache>(std::string(32,'c'), 1<<20, "");
    std::mutex gate; std::condition_variable arrived;
    std::set<std::thread::id> threads;
    unsigned entered = 0, completed = 0;
    TakePool pool({}, 2, memory, [](const std::string &){}, [&](const std::string &) {
      std::unique_lock lock(gate); threads.insert(std::this_thread::get_id());
      ++entered; arrived.notify_all();
      require(arrived.wait_for(lock, std::chrono::seconds(5), [&]{return entered==2;}), "two workers did not run concurrently");
      return *other;
    });
    auto listener = [&](SharedTake) {std::lock_guard lock(gate); ++completed; arrived.notify_all();};
    pool.request("event:/sfx/first", listener); pool.request("event:/sfx/second", listener);
    std::unique_lock lock(gate);
    require(arrived.wait_for(lock, std::chrono::seconds(10), [&]{return completed==2;}), "parallel requests stalled");
    require(threads.size()==2,"worker thread ownership");
  }
  std::cout << "PASS guards, cap/fade, LRU/disk, buffers, unknown releases, workers 1/2, cold dedup and cache hit\n";
 } catch (const std::exception &e) {std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
