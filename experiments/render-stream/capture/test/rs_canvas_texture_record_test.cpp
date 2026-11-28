#include "rs_canvas_texture_derive.h"
#include "calib_fingerprint.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>

using namespace grc;
using namespace grc::rs;
namespace {
int checks = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}
struct Fake : CanvasTextureDeriveReader {
  unsigned char memory[0x9000] = {};
  ProcessFingerprint fp;
  CanvasTextureRecord record{0x8000, {0x4100,256,80,72,8,16,24,40,44},
                                    {0x4200,320,80,72,8,16,24,40,44}};
  int heap_reads = 0;
  template<class T> void put(std::size_t offset, T value) {
    std::memcpy(memory + offset, &value, sizeof(value));
  }
  Fake() {
    fp.main_image_ranges = {{0x1000,0x2000,MainImageKind::code},
        {0x4000,0x5000,MainImageKind::readonly},{0x8000,0x9000,MainImageKind::writable}};
    put<std::uint64_t>(0x8000,0x6000);
    put<std::uint64_t>(0x6000,0x4100);
    put<std::uint64_t>(0x40f8,0x4300); put<std::uint64_t>(0x4308,0x4400);
    put<std::uint64_t>(0x41f8,0x4320); put<std::uint64_t>(0x4328,0x4440);
    std::memcpy(memory + 0x4400,"N10RendererRD14TextureStorageE",30);
    std::memcpy(memory + 0x4440,"N5GLES314TextureStorageE",24);
  }
  bool image(std::uint64_t a, void *out, std::size_t bytes, CanvasTextureImageRange range) override {
    auto kind = range == CanvasTextureImageRange::code ? MainImageKind::code :
                range == CanvasTextureImageRange::readonly ? MainImageKind::readonly :
                                                            MainImageKind::writable;
    if (!fp.main_image_contains(a,bytes,kind)) return false;
    std::memcpy(out,memory+a,bytes); return true;
  }
  bool storage_vptr(std::uint64_t a,std::uint64_t *out) override {
    ++heap_reads;
    if (a != 0x6000) return false;
    std::memcpy(out,memory+a,8); return true;
  }
};
}
int main() {
  std::string why;
  Fake good;
  check(validate_canvas_texture_record(good,good.record,&why),"RD record accepted");
  good.put<std::uint64_t>(0x6000,0x4200);
  check(validate_canvas_texture_record(good,good.record,&why),"GLES3 record accepted");
  auto refusal = [&](const char *reason,const std::function<void(Fake &)> &change) {
    Fake f; change(f);
    check(!validate_canvas_texture_record(f,f.record,&why) && why==reason,reason);
  };
  refusal("storage-vptr-mismatch",[](Fake &f){f.put<std::uint64_t>(0x6000,0x4600);});
  refusal("storage-unreadable",[](Fake &f){f.put<std::uint64_t>(0x8000,0x7000);});
  refusal("storage-unreadable",[](Fake &f){f.put<std::uint64_t>(0x8000,0);});
  refusal("storage-rtti",[](Fake &f){f.memory[0x4400]='X';});
  refusal("storage-rtti",[](Fake &f){f.put<std::uint64_t>(0x4308,0x6000);});
  refusal("storage-rtti",[](Fake &f){f.put<std::uint64_t>(0x40f0,8);});
  refusal("storage-rtti",[](Fake &f){f.put<std::uint64_t>(0x40f8,UINT64_MAX-7);});
  refusal("storage-rtti",[](Fake &f){f.put<std::uint64_t>(0x4308,0x4fff);});
  refusal("storage-rtti",[](Fake &f){f.put<std::uint64_t>(0x6000,0x4200);f.memory[0x4440]='X';});
  refusal("record-outside-image",[](Fake &f){f.record.global=0x4000;});
  refusal("record-outside-image",[](Fake &f){f.record.rd.vptr=0x8000;});
  Fake outside; outside.record.rd.vptr=0x8000;
  check(!validate_canvas_texture_record(outside,outside.record,&why) && outside.heap_reads==0,
        "range refusal precedes heap reads");

  // A synthetic PE section table proves mapped extents and protection classes.
  unsigned char header[512] = {};
  auto put = [&]<class T>(std::size_t off,T v){std::memcpy(header+off,&v,sizeof(v));};
  std::memcpy(header,"MZ",2); put(60,std::uint32_t(64)); std::memcpy(header+64,"PE\0\0",4);
  put(68,std::uint16_t(0x8664)); put(70,std::uint16_t(4)); put(84,std::uint16_t(168));
  put(88,std::uint16_t(0x20b)); put(88+56,std::uint32_t(0x9000));
  put(88+108,std::uint32_t(7));
  for (std::size_t i=0;i<4;++i) {
    const std::size_t s=256+i*40;
    put(s+8,std::uint32_t(0x1000)); put(s+12,std::uint32_t(0x1000+i*0x2000));
    put(s+16,std::uint32_t(i==2?0:0x200));
    put(s+36,std::uint32_t(i==0?0x60000020:i==1?0x40000040:i==2?0xc0000080:0x20000020));
  }
  PeHeaders h;
  check(pe_parse_headers(header,sizeof(header),&h,&why),"synthetic PE headers parse");
  ProcessFingerprint fp;
  constexpr std::uint64_t slide=0x700000000000;
  fp.set_pe_image_ranges(h,slide);
  check(fp.main_image_ranges.size()==3,"non-readable section excluded");
  check(fp.main_image_contains(slide+0x1000,8,MainImageKind::code),"ASLR code section");
  check(fp.main_image_contains(slide+0x3000,8,MainImageKind::readonly),"readonly section");
  check(fp.main_image_contains(slide+0x5ff8,8,MainImageKind::writable),"BSS virtual tail");
  check(!fp.main_image_contains(slide+0x5ff8,9,MainImageKind::writable),"extent crossing section");
  check(!fp.main_image_contains(slide+0x1000,8,MainImageKind::readonly),"code is not readonly data");
  check(!fp.main_image_contains(UINT64_MAX-3,8,MainImageKind::code),"extent overflow");
  check(!fp.main_image_contains(slide+0x6000,1,MainImageKind::writable),"exclusive end");
  fp.set_pe_image_ranges(h,UINT64_MAX-0x1000);
  check(fp.main_image_ranges.empty(),"mapped section overflow");
  std::printf("%d passed, 0 failed\n",checks);
}
