#include "audio_driver_probe.h"
#include "audio_driver_log.h"
#include "iface.h"
#include "report.h"
#include "rs_file.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#if defined(__linux__)
#include <link.h>
#endif

namespace grc::audio {
namespace {
#if defined(__linux__)
// Intersect PT_LOAD memory extents (including anonymous BSS) with readable process mappings.
class Live final : public CalibMemoryReader {
 public:
  struct Range { uint64_t lo, hi; bool write, exec; };
  std::vector<Range> ranges;
  Live() {
    std::vector<Range> loads;
    dl_iterate_phdr([](dl_phdr_info *i, size_t, void *p) {
      if (i->dlpi_name && *i->dlpi_name) return 0;
      auto &v=*static_cast<std::vector<Range> *>(p);
      for (size_t j=0;j<i->dlpi_phnum;++j) {
        const auto &h=i->dlpi_phdr[j];
        if (h.p_type==PT_LOAD && (h.p_flags&PF_R))
          v.push_back({i->dlpi_addr+h.p_vaddr,i->dlpi_addr+h.p_vaddr+h.p_memsz,
                       bool(h.p_flags&PF_W),bool(h.p_flags&PF_X)});
      }
      return 1;
    },&loads);
    rs::File maps(rs::open_file("/proc/self/maps","r")); std::string line;
    while (rs::file_getline(maps.get(),&line)) {
      unsigned long long lo=0,hi=0; char perms[5]={};
      if (std::sscanf(line.c_str(),"%llx-%llx %4s",&lo,&hi,perms)!=3 || perms[0]!='r') continue;
      for (const auto &r:loads) {
        auto a=std::max(uint64_t(lo),r.lo), b=std::min(uint64_t(hi),r.hi);
        if (a<b) ranges.push_back({a,b,r.write && perms[1]=='w',r.exec && perms[2]=='x'});
      }
    }
  }
  CalibWord read_u64(uint64_t a) const override {
    for (const auto &r:ranges) if (a>=r.lo && a<r.hi && r.hi-a>=8) {
      uint64_t v=0; std::memcpy(&v,reinterpret_cast<const void *>(a),8); return {CalibWord::value,v};
    }
    return {};
  }
  bool is_exec(uint64_t a) const override {
    for (const auto &r:ranges) if (r.exec && a>=r.lo && a<r.hi) return true;
    return false;
  }
  std::vector<std::pair<uint64_t,uint64_t>> readonly_ranges() const override {
    std::vector<std::pair<uint64_t,uint64_t>> v;
    for (const auto &r:ranges) if (!r.write && !r.exec) v.emplace_back(r.lo,r.hi);
    return v;
  }
  uint64_t load_bias() const override { return 0; }
  std::vector<std::pair<uint64_t,uint64_t>> writable() const {
    std::vector<std::pair<uint64_t,uint64_t>> v;
    for (const auto &r:ranges) if (r.write && !r.exec) v.emplace_back(r.lo,r.hi);
    return v;
  }
};
#endif
}  // namespace
void initialize(const std::string &evidence_dir) {
  const char *mode=rs::env("GRC_AUDIO");
  if (!mode || !*mode) return;
  const char *path=rs::env("GRC_AUDIO_ABI_TABLE");
  Probe probe; Abi abi; std::string error, bound;
  bool ok=false;
  if (std::string(mode)!="probe" && std::string(mode)!="log") error="unsupported GRC_AUDIO mode";
  else if (!path || !*path) error="GRC_AUDIO_ABI_TABLE is required";
#if defined(__linux__) && defined(__x86_64__)
  else if (!dummy_name(bound=singleton_string("AudioServer","AudioServer","get_driver_name",201670096),&error)) {}
  else {
    ProcessFingerprint fp;
    if (collect_fingerprint(&fp,&error) && fp.version_string=="Godot Engine v4.5.1.stable.official") {
      rs::File f(rs::open_file(path,"rb")); std::string text;
      if (!rs::file_read_all(f.get(),&text)) error="cannot read audio ABI table";
      else if (parse_abi(text,&abi,&error)) {
        Live m;
        if (derive(m,m.writable(),abi,&probe,&error)) {
          auto fn=m.read_u64(probe.vptr);
          using GetName=const char *(*)(const void *);
          const char *name=reinterpret_cast<GetName>(fn.bits)(reinterpret_cast<void *>(probe.object));
          // Read only within the main image before interpreting the behavioural result.
          uint64_t chars=0;
          if (!name || m.read_u64(reinterpret_cast<uint64_t>(name)).kind!=CalibWord::value) error="get_name returned an unreadable name";
          else {
            std::memcpy(&chars,name,6);
            ok=chars==0x796d6d7544ULL;
            if (!ok) error="get_name slot did not return Dummy";
          }
        }
      }
    } else if (error.empty()) error="unsupported engine version: "+fp.version_string;
  }
#else
  else error="audio seam supports Linux x86-64 only";
#endif
  if (ok && std::string(mode)=="log") ok=start_log(probe,abi,evidence_dir,&error);
  JsonWriter j; j.object_begin().field("mode",std::string(mode)).field("status",std::string(ok?"found":"refused"))
    .field("reason",error).field("bound_driver",bound).field_hex("object",probe.object)
    .field_hex("vptr",probe.vptr).field("object_matches",int64_t(probe.object_matches)).key("slots").object_begin();
  for (size_t i=0;i<abi.slots.size();++i) j.field(abi.slots[i].name,int64_t(i));
  j.object_end().object_end();
  const auto report=j.take();
  if (!evidence_dir.empty()) write_file(path_join(evidence_dir,"audio-probe.json"),report);
  std::fprintf(stdout,"[grc-audio] %s",report.c_str()); std::fflush(stdout);
}
void shutdown() { stop_log(); }
}  // namespace grc::audio
