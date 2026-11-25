#include "lane.hpp"
#include "clock.hpp"
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <dlfcn.h>
#include <iostream>
#include <limits>
#include <mutex>
using namespace grc::fmod;
namespace {
void require(bool value, const char *why) { if (!value) throw std::runtime_error(why); }
std::string packed(const std::string &name, const std::string &label) { return name+'\0'+label; }
void rejected_label_replay(const RenderConfig &config, unsigned (*count)(const char *), unsigned (*order)(const char *)) {
  for (auto op : {10u,11u}) {
    const bool global=op==11;
    const std::string name=global?"GlobalMood":"Mood", kind=global?"global":"event";
    const auto valid=kind+"-label:"+name+":Combat", rejected=kind+"-label:"+name+":unknown";
    const auto numeric=kind+"-numeric:"+name;
    for (bool dormant : {false,true}) for (bool was_numeric : {false,true}) {
      LaneState state;state.apply({3,1,"event:/music/test",0});
      auto lanes=std::make_unique<LaneSystem>(config,std::vector<LaneConfig>{},state);
      // Use the module's production order, including while no lane system exists.
      auto observe=[&](const Observation &o) { if(state.apply(o) && lanes)lanes->observe(o); };
      observe(was_numeric?Observation{global?8u:7u,1,name,2.f}:Observation{op,1,packed(name,"Combat"),0});
      if(dormant)lanes.reset();
      observe({op,1,packed(name,"unknown"),0});
      if(!dormant) {
        require(state.parameter_unknown==1,"live rejected label evidence");
        const auto &labels=global?state.global_labels():state.events().at(1).labels;
        const auto &values=global?state.globals():state.events().at(1).parameters;
        require(was_numeric?values.contains(name) && values.at(name)==2.f && !labels.contains(name)
                           :labels.contains(name) && labels.at(name)=="Combat","live rejection replaced retained assignment");
      }
      lanes.reset();
      const auto valid_before=count(valid.c_str()), numeric_before=count(numeric.c_str()), rejected_before=count(rejected.c_str());
      lanes=std::make_unique<LaneSystem>(config,std::vector<LaneConfig>{},state);
      const auto &labels=global?state.global_labels():state.events().at(1).labels;
      const auto &values=global?state.globals():state.events().at(1).parameters;
      require(was_numeric?values.contains(name) && values.at(name)==2.f && !labels.contains(name)
                         :labels.contains(name) && labels.at(name)=="Combat","rejoin lost accepted assignment");
      require(count(valid.c_str())==valid_before+!was_numeric && count(numeric.c_str())==numeric_before+was_numeric,"rejoin did not replay fallback");
      require(count(rejected.c_str())==rejected_before+dormant && state.parameter_unknown==1,"rejoin rejected label evidence");
      if(dormant)require(order((was_numeric?numeric:valid).c_str())<order(rejected.c_str()),"dormant label replay preceded fallback");
      lanes.reset();
      lanes=std::make_unique<LaneSystem>(config,std::vector<LaneConfig>{},state);
      require(count(rejected.c_str())==rejected_before+dormant && state.parameter_unknown==1,"resolved rejection replayed again");
    }
    // A failed first assignment must collapse to absence, including when dormant.
    for(bool dormant : {false,true}) {
      LaneState state;state.apply({3,1,"event:/music/test",0});
      std::unique_ptr<LaneSystem> lanes;
      if(!dormant)lanes=std::make_unique<LaneSystem>(config,std::vector<LaneConfig>{},state);
      Observation unknown{op,1,packed(name,"unknown"),0};
      require(state.apply(unknown),"well-formed unknown label ignored");if(lanes)lanes->observe(unknown);
      lanes.reset();lanes=std::make_unique<LaneSystem>(config,std::vector<LaneConfig>{},state);
      require((global?state.global_labels():state.events().at(1).labels).empty() && state.parameter_unknown==1,"rejected first label retained");
    }
    // Several dormant candidates must keep the last one FMOD accepts.
    LaneState state;state.apply({3,1,"event:/music/test",0});
    state.apply({op,1,packed(name,"Menu"),0});
    state.apply({op,1,packed(name,"unknown"),0});
    state.apply({op,1,packed(name,"Combat"),0});
    state.apply({op,1,packed(name,"unknown"),0});
    {
      LaneSystem lanes(config,{},state);
      require((global?state.global_labels():state.events().at(1).labels).at(name)=="Combat" && state.parameter_unknown==2,"dormant candidates lost last accepted label");
    }
    const auto before=count(rejected.c_str());
    LaneSystem lanes(config,{},state);
    require(count(rejected.c_str())==before,"dormant candidates did not collapse");
  }
}
struct Host {
  std::string lib, pck;
  std::mutex mutex;
  std::condition_variable changed;
  unsigned hellos = 0, blocks = 0;
  std::vector<std::string> logs;
  static const char *config(void *self, const char *key) {
    auto &h=*static_cast<Host *>(self); const std::string k(key);
    if (k=="core_lib" || k=="studio_lib") return h.lib.c_str();
    if (k=="pck_path") return h.pck.c_str();
    if (k=="lanes") return "1:music:bus:/master/music";
    return nullptr;
  }
  static void output(void *self, std::uint32_t, const std::uint8_t *data, std::size_t len) {
    auto &h=*static_cast<Host *>(self);
    const auto type=grc::audio::decode_link(Bytes(data,data+len)).type;
    std::lock_guard lock(h.mutex);
    if(type==0)++h.hellos;else if(type==1)++h.blocks;
    h.changed.notify_all();
  }
  static void log(void *self, int, const char *data, std::size_t len) {
    auto &h=*static_cast<Host *>(self);
    std::lock_guard lock(h.mutex); h.logs.emplace_back(data,len); h.changed.notify_all();
  }
  template<class F> void wait(F predicate) {
    std::unique_lock lock(mutex);
    require(changed.wait_for(lock,std::chrono::seconds(5),predicate),"module label command timeout");
  }
};
}
int main(int argc, char **argv) {
 try {
  require(argc==7,"label test arguments");
  auto *fake=dlopen(argv[3],RTLD_NOW|RTLD_LOCAL); require(fake,"fake load");
  auto count=reinterpret_cast<unsigned (*)(const char *)>(dlsym(fake,"fake_call_count")); require(count,"fake counter");
  auto order=reinterpret_cast<unsigned (*)(const char *)>(dlsym(fake,"fake_call_order")); require(order,"fake call order");
  RenderConfig config{argv[3],argv[4],argv[5],""};
  LaneState state; state.apply({3,1,"event:/music/test",0});
  state.apply({7,1,"Mood",1}); state.apply({8,0,"GlobalMood",1});
  state.apply({10,1,packed("Mood","Combat"),0}); state.apply({11,0,packed("GlobalMood","Menu"),0});
  state.apply({10,1,packed("unknown","Combat"),0}); state.apply({11,0,packed("unknown","Menu"),0});
  state.apply({4,1,"",0});
  for (unsigned join=1; join<=2; ++join) {
    LaneSystem lanes(config,{},state);
    require(count("event-label:Mood:Combat")==join && count("global-label:GlobalMood:Menu")==join,"label replay on rejoin");
    require(count("event-numeric:Mood")==1 && count("global-numeric:GlobalMood")==1,"dormant numeric fallback replay");
    require(count("start")==join,"replay start");
    for (auto op : {10u,11u}) {
      lanes.observe({op,1,packed("unknown","Menu"),0});
      lanes.observe({op,1,packed("Mood","unknown"),0});
    }
    require(state.parameter_unknown==2+join*4,"unknown labels/parameters evidence");
    unsigned blocks=0;lanes.render(0,1,0,0,[&](auto &,auto &){++blocks;});
    require(blocks==0,"unsubscribed lane emitted");
    bool fatal=false;
    try { lanes.observe({10,1,packed("fatal","Menu"),0}); } catch(const std::exception &e) { fatal=std::string(e.what())=="fmod-off"; }
    require(fatal,"non-lookup failure was swallowed");
  }
  auto *module=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL); require(module,"module load");
  auto get=reinterpret_cast<int (*)(grc_fmod_v1 *)>(dlsym(module,"grc_fmod_get_v1"));
  grc_fmod_v1 api{};require(get && get(&api),"module ABI");
  // Context outlives the module's asynchronous teardown.
  auto *h=new Host;h->lib=argv[3];h->pck=argv[5];
  grc_fmod_host_v1 host{1,sizeof(host),h,Host::config,Host::output,Host::log};char error[128]{};
  require(api.start(api.self,&host,nullptr,error,sizeof(error)),"module start");
  auto observe=[&](unsigned op, const std::string &s, float value=0) {api.observe(api.self,op,1,s.data(),s.size(),value);};
  observe(3,"event:/music/test");
  observe(10,packed("Mood","Combat"),std::numeric_limits<float>::quiet_NaN());
  observe(11,packed("GlobalMood","Menu"),std::numeric_limits<float>::infinity());
  observe(10,"Mood"); observe(11,"GlobalMood"); observe(10,packed("Mood",packed("Combat","extra")));
  api.seat_open(api.self,1);h->wait([&]{return h->hellos==1;});
  grc::audio::LinkMessage hello;hello.clock_domain=clock_domain();hello.bankset=std::string(32,'0');
  auto send=[&](auto &m){auto b=grc::audio::encode_link(m);api.link_in(api.self,1,b.data(),b.size());};send(hello);
  grc::audio::LinkMessage mask;mask.type=6;mask.lane_mask=2;send(mask);
  api.seat_open(api.self,2);h->wait([&]{return h->hellos==2;});
  h->wait([&]{return h->blocks>0;});
  require(count("event-label:Mood:Combat")==3 && count("global-label:GlobalMood:Menu")==3,"ABI packed payload/value ignored");
  observe(10,packed("unknown","Combat")); observe(11,packed("GlobalMood","unknown"));
  api.seat_open(api.self,3);h->wait([&]{return h->hellos==3;});
  require(api.state(api.self,error,sizeof(error)),"unknown label latched module off");
  api.stop(api.self);
  h->wait([&]{return std::find(h->logs.begin(),h->logs.end(),"grc_fmod parameters: label-malformed=3 parameter-unknown=2")!=h->logs.end();});
  rejected_label_replay(config,count,order);
  std::cout<<"PASS label retention, 2 rejoin replays, rejected live/dormant label and numeric fallbacks, lookup failures, malformed evidence, ABI strings and ignored values\n";
  std::cout.flush();std::_Exit(0);
 } catch(const std::exception &e) {std::cerr<<"FAIL "<<e.what()<<'\n';std::cerr.flush();std::_Exit(1);}
}
