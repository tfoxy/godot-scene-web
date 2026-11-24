#include "audio_driver_probe.h"
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <map>

namespace {
int passed=0,failed=0;
void check(bool ok,const char *s) { if(ok) ++passed; else {++failed; std::fprintf(stderr,"FAIL: %s\n",s);} }
class Memory final : public grc::CalibMemoryReader {
 public:
  std::map<uint64_t,uint64_t> words;
  void text(uint64_t a,const std::string &s) {
    for(size_t i=0;i<=s.size();++i) words[(a+i)&~uint64_t(7)] |= uint64_t(i==s.size()?0:s[i])<<(8*((a+i)&7));
  }
  explicit Memory(const grc::audio::Abi &abi) {
    text(0x1100,"11AudioDriver"); text(0x1140,"16AudioDriverDummy");
    words[0x1200]=0x9000; words[0x1208]=0x1100;
    words[0x1240]=0x9000; words[0x1248]=0x1140; words[0x1250]=0x1200;
    words[0x1300]=0; words[0x1308]=0x1200; words[0x1500]=0; words[0x1508]=0x1240;
    for(size_t i=0;i<abi.slots.size();++i) {
      const auto &s=abi.slots[i];
      words[0x1310+i*8]=s.abstract_placeholder?0:0x9000+i*16;
      words[0x1510+i*8]=s.override?0xa000+i*16:words[0x1310+i*8];
    }
    words[0x2000]=0x1510;
  }
  grc::CalibWord read_u64(uint64_t a) const override {
    auto i=words.find(a); return i==words.end()?grc::CalibWord{}:grc::CalibWord{grc::CalibWord::value,i->second};
  }
  bool is_exec(uint64_t a) const override {return a>=0x9000 && a<0xb000;}
  uint64_t load_bias() const override {return 0;}
  std::vector<std::pair<uint64_t,uint64_t>> readonly_ranges() const override {return {{0x1000,0x1900}};}
};
}
int main(int argc,char **argv) {
  if(argc!=2)return 2;
  std::ifstream f(argv[1]); std::string json((std::istreambuf_iterator<char>(f)),{}),error;
  grc::audio::Abi abi; grc::audio::Probe p;
  check(grc::audio::parse_abi(json,&abi,&error),"parse header-derived ABI");
  if(abi.slots.size()!=38)return 2;
  check(abi.slots[21].name=="start_sample_playback","header slot order");
  check(grc::audio::dummy_name("Dummy",&error),"Dummy admitted");
  check(!grc::audio::dummy_name("PulseAudio",&error),"real driver refused before memory scanning");
  Memory m(abi);
  check(grc::audio::derive(m,{{0x2000,0x2100}},abi,&p,&error),"unique static object and complete slot pattern");
  check(p.object==0x2000 && p.vptr==0x1510 && p.object_matches==1,"object evidence");
  m.words[0x2008]=0x1510;
  check(!grc::audio::derive(m,{{0x2000,0x2100}},abi,&p,&error) && p.object_matches==2,"ambiguous objects refused");
  m.words.erase(0x2008); m.words[0x1310+19*8]=0;
  check(!grc::audio::derive(m,{{0x2000,0x2100}},abi,&p,&error),"incorrect sample slot refused");
  m=Memory(abi);m.words[0x1510+38*8]=0x9000;
  check(!grc::audio::derive(m,{{0x2000,0x2100}},abi,&p,&error),"extra trailing slot refused");
  m=Memory(abi);m.words.erase(0x2000);
  check(!grc::audio::derive(m,{{0x2000,0x2100}},abi,&p,&error),"missing object refused");
  grc::audio::Abi bad;
  check(!grc::audio::parse_abi("{}",&bad,&error),"bad schema refused");
  auto duplicate=json;duplicate.insert(duplicate.find('{')+1,"\"schema\":\"duplicate\",");
  check(!grc::audio::parse_abi(duplicate,&bad,&error),"duplicate keys refused");
  std::printf("audio_driver_probe: %d passed, %d failed\n",passed,failed);return failed?1:0;
}
