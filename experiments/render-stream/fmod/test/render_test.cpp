#include "take.hpp"
#include "lane.hpp"
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <new>
#include <sys/resource.h>
thread_local bool callback = false;
std::atomic<unsigned> allocations{0};
extern "C" void grc_test_callback_phase(int phase) { callback = phase; }
void *operator new(std::size_t n) { if(callback) ++allocations; if(auto *p=std::malloc(n?n:1)) return p; throw std::bad_alloc(); }
void operator delete(void *p) noexcept {std::free(p);}
void operator delete(void *p, std::size_t) noexcept {std::free(p);}
void *operator new[](std::size_t n) {return ::operator new(n);}
void operator delete[](void *p) noexcept {std::free(p);}
void operator delete[](void *p,std::size_t) noexcept {std::free(p);}
long rss() {std::ifstream f("/proc/self/statm");long size=0,resident=0;f>>size>>resident;return resident*4096;}
int main(int argc,char **argv) {
 if(argc!=5)return 2;
 try {
  namespace fs=std::filesystem;fs::path dir(argv[1]),pck;
  for(const auto &e:fs::directory_iterator(dir))if(e.path().extension()==".pck"){if(!pck.empty())throw std::runtime_error("ambiguous PCK");pck=e.path();}
  std::string core=(dir/"libfmod.so.14").string(),studio=(dir/"libfmodstudio.so.14").string();
  if(!dlopen(core.c_str(),RTLD_NOW|RTLD_GLOBAL)||!dlopen(studio.c_str(),RTLD_NOW|RTLD_LOCAL))throw std::runtime_error(dlerror());
  grc::fmod::RenderConfig changed{core,studio,pck.string(),""};changed.bankset=std::string(32,'0');
  unsigned rejected=0;
  try {grc::fmod::TakeSystem refused(changed);}catch(const std::exception &e){if(std::string(e.what())!="bank-load")throw;++rejected;}
  try {grc::fmod::LaneSystem refused(changed,{},grc::fmod::LaneState{});}catch(const std::exception &e){if(std::string(e.what())!="bank-load")throw;++rejected;}
  if(rejected!=2)throw std::runtime_error("changed bankset reached render systems");
  const auto before=rss();
  grc::fmod::TakeSystem renderer({core,studio,pck.string(),""});
  for(const auto *key:{"event:/music/act1_b1_v1","event:/ambience/act1","event:/sfx/ambience/loop"})
   if(renderer.render(key).reason!="refused-not-oneshot")throw std::runtime_error("non-one-shot accepted");
  std::ifstream keys(argv[2]);std::ofstream metrics(argv[4]);std::string key;unsigned index=0;
  while(std::getline(keys,key)) {
   auto take=renderer.render(key);
   if(!take.reason.empty()||!take.frames||take.frames>480000)throw std::runtime_error("invalid take: "+key+" "+take.reason);
   std::ofstream out(fs::path(argv[3])/(std::to_string(index++)+".pcm"),std::ios::binary);
   out.write(reinterpret_cast<const char *>(take.pcm.data()),take.pcm.size());
   metrics<<take.first_mix_us<<'\n';
  }
  const auto delta=rss()-before;
  std::cout<<"takes="<<index<<" rss_delta_bytes="<<delta<<" callback_allocations="<<allocations<<'\n';
  if(index!=30||allocations||delta>60L*1024*1024)throw std::runtime_error("RSS/callback/count acceptance");
 }catch(const std::exception &e){std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
