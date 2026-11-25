#include "lane.hpp"
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <iostream>
using namespace grc::fmod;
namespace {
void check(Result r) { if (r!=ok) throw std::runtime_error("public label API result="+std::to_string(r)); }
template<class T> T symbol(void *lib, const char *name) {
  auto f=reinterpret_cast<T>(dlsym(lib,name)); if (!f) throw std::runtime_error(name); return f;
}
// Hand-declared public metadata, used only to discover labelled test parameters.
// https://www.fmod.com/docs/2.03/api/studio-api-common.html
struct Guid { std::uint32_t a; std::uint16_t b,c; std::uint8_t d[8]; };
struct Parameter {
  const char *name;
  std::uint32_t id[2];
  float minimum, maximum, default_value;
  int type;
  unsigned flags;
  Guid guid;
};
static_assert(sizeof(Guid)==16 && sizeof(Parameter)==56);
static_assert(offsetof(Parameter,flags)==32 && offsetof(Parameter,guid)==36);
}
int main() {
 try {
  namespace fs=std::filesystem;
  const auto *dir=std::getenv("GRC_FMOD_TEST_GAME_DIR");
  if (!dir || !*dir) { std::cout<<"SKIP label install: set GRC_FMOD_TEST_GAME_DIR\n"; return 0; }
  const auto core=(fs::path(dir)/"libfmod.so.14").string(), studio_name=(fs::path(dir)/"libfmodstudio.so.14").string();
  if (!dlopen(core.c_str(),RTLD_NOW|RTLD_GLOBAL)) throw std::runtime_error(dlerror());
  auto *lib=dlopen(studio_name.c_str(),RTLD_NOW|RTLD_LOCAL);if (!lib) throw std::runtime_error(dlerror());
  std::string pck;
  for (const auto &e:fs::directory_iterator(dir)) if(e.path().extension()==".pck") {
    if (!pck.empty()) throw std::runtime_error("ambiguous PCK"); pck=e.path().string();
  }
  Api api;api.bind(core.c_str(),studio_name.c_str());api.bind_render();api.bind_lane();
  Banks banks(nullptr,pck,"");
  struct System { Api &api;Studio *value;~System(){api.studio_release(value);} } system{api,api.create()};
  Core *native=nullptr;check(api.get_core(system.value,&native));check(api.set_output(native,4));
  check(api.set_format(native,48000,3,0));check(api.buffer_size(native,512,4));
  check(api.initialize(system.value,256,4|16,1|2,nullptr));banks.load(api,system.value);check(api.update(system.value));
  auto bank_count=symbol<Result (*)(Studio *,int *)>(lib,"FMOD_Studio_System_GetBankCount");
  auto bank_list=symbol<Result (*)(Studio *,Bank **,int,int *)>(lib,"FMOD_Studio_System_GetBankList");
  auto event_count=symbol<Result (*)(Bank *,int *)>(lib,"FMOD_Studio_Bank_GetEventCount");
  auto event_list=symbol<Result (*)(Bank *,Description **,int,int *)>(lib,"FMOD_Studio_Bank_GetEventList");
  auto path=symbol<Result (*)(Description *,char *,int,int *)>(lib,"FMOD_Studio_EventDescription_GetPath");
  auto param_count=symbol<Result (*)(Description *,int *)>(lib,"FMOD_Studio_EventDescription_GetParameterDescriptionCount");
  auto param=symbol<Result (*)(Description *,int,Parameter *)>(lib,"FMOD_Studio_EventDescription_GetParameterDescriptionByIndex");
  auto label=symbol<Result (*)(Description *,int,int,char *,int,int *)>(lib,"FMOD_Studio_EventDescription_GetParameterLabelByIndex");
  auto get=symbol<Result (*)(Instance *,const char *,float *,float *)>(lib,"FMOD_Studio_EventInstance_GetParameterByName");
  int n=0;check(bank_count(system.value,&n));std::vector<Bank *> all(n);check(bank_list(system.value,all.data(),n,&n));
  unsigned music=0, tested=0;
  for (auto *bank:all) {
    int count=0;check(event_count(bank,&count));if(!count)continue;
    std::vector<Description *> events(count);check(event_list(bank,events.data(),count,&count));
    for(auto *event:events) {
      char event_path[4096]{};check(path(event,event_path,sizeof(event_path),nullptr));
      if (!std::string(event_path).starts_with("event:/music/")) continue;
      ++music;int parameters=0;check(param_count(event,&parameters));
      for(int i=0;i<parameters;++i) {
        Parameter p{};check(param(event,i,&p));
        if (!(p.flags&16) || (p.flags&7)) continue;
        char value[4096]{};const int index=p.maximum>=1?1:0;check(label(event,i,index,value,sizeof(value),nullptr));
        Instance *instance=nullptr;check(api.instance_create(event,&instance));
        const auto result=api.parameter_label(instance,p.name,value,0);
        float actual=-1,final=-1;const auto got=get(instance,p.name,&actual,&final);check(api.event_release(instance));
        check(result);check(got);if(actual!=float(index))throw std::runtime_error("label value mismatch");
        LaneState state;state.apply({3,1,event_path,0});state.apply({10,1,std::string(p.name)+'\0'+value,0});
        for(unsigned rejoin=0;rejoin<2;++rejoin) {
          LaneSystem lanes({core,studio_name,pck,""},{},state);
          if(state.parameter_unknown!=rejoin*3)throw std::runtime_error("real labelled replay failed");
          auto observe=[&](const Observation &op) { if(state.apply(op))lanes.observe(op); };
          observe({10,1,std::string(p.name)+'\0'+"grc-unknown-label",0});
          observe({10,1,std::string("grc-unknown-parameter")+'\0'+value,0});
          observe({11,0,std::string("grc-unknown-parameter")+'\0'+value,0});
          if(state.events().at(1).labels.at(p.name)!=value || state.events().at(1).labels.size()!=1 || !state.global_labels().empty())
            throw std::runtime_error("real rejection replaced retained assignment");
        }
        if(state.parameter_unknown!=6)throw std::runtime_error("real lookup evidence failed");
        ++tested;std::cout<<"label event="<<event_path<<" parameter="<<p.name<<" value="<<value<<" replays=2\n";
      }
    }
  }
  if(!tested) {std::cout<<"SKIP label install: no labelled music parameter in "<<music<<" public event descriptions; synthetic coverage only\n";return 0;}
  std::cout<<"PASS real labelled parameters="<<tested<<" music_events="<<music<<'\n';
 } catch(const std::exception &e) {std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
