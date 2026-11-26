#include "rs_canvas_texture_derive.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <vector>
using namespace grc::rs;
namespace {
int checks = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { std::fprintf(stderr,"FAIL: %s\n",name); std::exit(1); }
}
using Range = CanvasTextureImageRange;
// Recorded from the official 4.5.1 Linux release template; relocated by the fake image.
constexpr const char *create_bytes =
    "415741564155415455534889fb4883ec18488b3da0360002488b07ff10";
constexpr const char *rd_channel =
    "4883ec084885f60f84b10000004189d089f08b97cc00000039d60f839e00000031d248c1ee20f7b7c8000000488bbfb8"
    "00000089d2488d14d248c1e204480314c74889d08b928800000039f275624183f80174544183f80274364585c0750348"
    "8908488b5068660fefc00f1140380f1140480f1140584885d27425488b707031ff4883c408ffe2660f1f840000000000"
    "48894810ebcc662e0f1f8400000000004883c408c30f1f0048894808ebb4";
constexpr const char *rd_filter =
    "4883ec084889f14885f6745289d689c88b97cc00000039d1734431d248c1e920f7b7c8000000488bbfb800000089d248"
    "8d14d248c1e204480314c74889d08b928800000039ca750889702c4883c408c3";
constexpr const char *rd_repeat =
    "4883ec084889f14885f6745289d689c88b97cc00000039d1734431d248c1e920f7b7c8000000488bbfb800000089d248"
    "8d14d248c1e204480314c74889d08b928800000039ca75088970304883c408c3";
constexpr const char *gl_channel =
    "4883ec084885f6747b4189d089f08b979c00000039d6736c31d248c1ee20f7b798000000488bbf8800000089d248c1e2"
    "06480314c78b423839f0753c4183f80174264183f80274104585c0750348890a4883c408c30f1f0048894a104883c408"
    "c30f1f800000000048894a084883c408c3";
constexpr const char *gl_filter =
    "4883ec084885f6744b89d189f08b979c00000039d6733d31d248c1ee20f7b798000000488bbf8800000089d248c1e206"
    "480314c78b423839f0750d894a2c4883c408c3";
constexpr const char *gl_repeat =
    "4883ec084885f6744b89d189f08b979c00000039d6733d31d248c1ee20f7b798000000488bbf8800000089d248c1e206"
    "480314c78b423839f0750d894a304883c408c3";
struct Fake : CanvasTextureDeriveReader {
  std::vector<unsigned char> memory = std::vector<unsigned char>(0x10000);
  struct Region { std::uint64_t start, end; Range kind; };
  std::vector<Region> regions{{0x1000,0x2000,Range::readonly},{0x2000,0x3000,Range::code},
      {0x3000,0x4000,Range::writable}};
  std::uint64_t bias = 0;
  int storage_reads = 0, global_reads = 0, copies = 0;
  bool gl = false;
  explicit Fake(bool g = false, std::uint64_t slide = 0, bool negative = false) : bias(slide), gl(g) {
    put<std::uint64_t>(0x1000, bias+0x2000);
    bytes(0x2000, create_bytes);
    put<std::int32_t>(0x2014, (negative ? 0x0800 : 0x3000)-0x2018);
    if (negative) regions.push_back({0x0800,0x0808,Range::writable});
    put<std::uint64_t>(negative ? 0x0800 : 0x3000, bias+0x4000);
    put<std::uint64_t>(0x4000,bias+0x1200);
    put<std::uint64_t>(0x11f0,0); put<std::uint64_t>(0x11f8,bias+0x1300);
    put<std::uint64_t>(0x1308,bias+0x1400);
    const char *name = gl ? "N5GLES314TextureStorageE" : "N10RendererRD14TextureStorageE";
    std::memcpy(memory.data()+0x1400,name,std::strlen(name)+1);
    put<std::uint64_t>(0x1218,bias+0x2100); put<std::uint64_t>(0x1228,bias+0x2200);
    put<std::uint64_t>(0x1230,bias+0x2300);
    bytes(0x2100, gl ? gl_channel : rd_channel);
    bytes(0x2200, gl ? gl_filter : rd_filter);
    bytes(0x2300, gl ? gl_repeat : rd_repeat);
  }
  template<class T> void put(std::size_t a,T v) { std::memcpy(memory.data()+a,&v,sizeof(v)); }
  void bytes(std::size_t a,const char *h) {
    for (std::size_t i=0; h[2*i]; ++i) {
      unsigned value=0; std::sscanf(h+2*i,"%2x",&value); memory[a+i]=value;
    }
  }
  bool image(std::uint64_t a,void *p,std::size_t n,Range kind) override {
    if (a<bias) return false;
    a-=bias;
    for (const auto &r:regions) if (r.kind==kind && a>=r.start && a<r.end && n<=r.end-a) {
      ++copies; if (kind==Range::writable) ++global_reads;
      std::memcpy(p,memory.data()+a,n); return true;
    }
    return false;
  }
  bool storage_vptr(std::uint64_t a,std::uint64_t *p) override {
    ++storage_reads;
    if (a!=bias+0x4000) return false;
    std::memcpy(p,memory.data()+0x4000,8); return true;
  }
  bool derive(CanvasTextureRecord *r,std::string *why) {
    return derive_canvas_texture_record(*this,"linux-x86_64","Godot Engine v4.5.1.stable.official",
                                        bias+0x1000,r,why);
  }
};
}
int main() {
  CanvasTextureRecord r; std::string why;
  for (bool gl:{false,true}) for (auto bias:{0ULL,0x700000000000ULL}) for (bool negative:{false,true}) {
    Fake f(gl,bias,negative);
    check(f.derive(&r,&why),"recorded instruction chain accepts RD/GLES3 with signed RIP and ASLR");
    const auto &l = gl ? r.gles3 : r.rd;
    check(r.global==bias+(negative?0x800:0x3000) && l.vptr==bias+0x1200 &&
          l.owner==(gl?128:176) && l.stride==(gl?64:144) && l.validator==(gl?56:136) &&
          l.diffuse==0 && l.normal==8 && l.specular==16 && l.filter==44 && l.repeat==48,
          "derived global and full layout");
    check((gl?r.rd.vptr:r.gles3.vptr)==0 && f.storage_reads==1,"only proven backend accepted");
  }
  for (std::size_t i=0;i<29;++i) {
    if (i>=20 && i<24) continue;
    Fake f; f.memory[0x2000+i]^=1;
    check(!f.derive(&r,&why) && why=="derive-create-pattern" &&
          !f.global_reads && !f.storage_reads && !r.global,"every create opcode mutation refuses before storage read");
  }
  for (bool gl:{false,true}) for (auto [a,n]:{std::pair{0x2100,gl?113:174},
           std::pair{0x2200,gl?67:80},std::pair{0x2300,gl?67:80}})
    for (int i=0;i<n;++i) {
      Fake f(gl); f.memory[a+i]^=1;
      check(!f.derive(&r,&why) && why=="derive-layout-pattern" && !r.global,
            "every setter opcode/layout mutation refuses without usable record");
    }
  { Fake f(false,UINT64_MAX-0x2fff);
    check(!f.derive(&r,&why) && why=="derive-global-overflow" && !f.storage_reads && !f.global_reads,
          "positive RIP displacement overflow refuses before storage read"); }
  auto refuses=[&](const char *name,const std::function<void(Fake &)> &mutate,const char *reason,bool early=false) {
    Fake f; mutate(f);
    check(!f.derive(&r,&why) && why==reason && !r.global && (!early || !f.storage_reads),name);
  };
  refuses("slot outside readonly image",[](Fake &f){f.regions[0].start=0x1008;},"derive-create-slot",true);
  refuses("code points into data",[](Fake &f){f.put<std::uint64_t>(0x1000,0x3000);},"derive-create-code",true);
  refuses("truncated create body",[](Fake &f){f.regions[1].end=0x201c;},"derive-create-code",true);
  refuses("unaligned global",[](Fake &f){f.put<std::int32_t>(0x2014,0x3001-0x2018);},"derive-global-range",true);
  refuses("global points into code",[](Fake &f){f.put<std::int32_t>(0x2014,0x2100-0x2018);},"derive-global-range",true);
  refuses("unmapped global",[](Fake &f){f.put<std::int32_t>(0x2014,0x6000-0x2018);},"derive-global-range",true);
  refuses("signed displacement underflow",[](Fake &f){f.put<std::int32_t>(0x2014,INT32_MIN);},"derive-global-overflow",true);
  refuses("unmapped storage safely refused",[](Fake &f){f.put<std::uint64_t>(0x3000,0x6000);},"derive-storage-unreadable");
  refuses("unaligned storage",[](Fake &f){f.put<std::uint64_t>(0x3000,0x4001);},"derive-storage-unreadable",true);
  refuses("zero storage vptr",[](Fake &f){f.put<std::uint64_t>(0x4000,0);},"derive-storage-rtti");
  refuses("vptr outside readonly image",[](Fake &f){f.put<std::uint64_t>(0x4000,0x4000);},"derive-storage-rtti");
  refuses("secondary vtable",[](Fake &f){f.put<std::uint64_t>(0x11f0,8);},"derive-storage-rtti");
  refuses("unreadable typeinfo",[](Fake &f){f.put<std::uint64_t>(0x11f8,UINT64_MAX);},"derive-storage-rtti");
  refuses("wrong backend type",[](Fake &f){f.memory[0x1400]='X';},"derive-storage-type");
  refuses("unterminated type name",[](Fake &f){f.memory[0x141d]='X';},"derive-storage-type");
  refuses("setter outside executable image",[](Fake &f){f.put<std::uint64_t>(0x1228,0x4000);},"derive-layout-pattern");
  for (auto platform:{"windows-x86_64","macos-x86_64","macos-arm64"}) {
    Fake f;
    check(!derive_canvas_texture_record(f,platform,"Godot Engine v4.5.1.stable.official",0x1000,&r,&why)
          && why=="platform-unrecorded" && f.copies==0 && f.storage_reads==0,"unsupported platform zero reads");
  }
  { Fake f;
    check(!derive_canvas_texture_record(f,"linux-x86_64","Godot Engine v4.5.2.stable",0x1000,&r,&why)
          && why=="derive-engine-version" && f.copies==0,"other engine version zero reads"); }
  { Fake f;
    check(derive_canvas_texture_record(f,"linux-x86_64","SlayTheSpire2 MegaDot v4.5.1.m.14.mono.custom_build",
                                       0x1000,&r,&why),"MegaDot 4.5.1 still requires entire instruction proof"); }
  std::printf("%d passed, 0 failed, 0 skipped\n",checks);
}
