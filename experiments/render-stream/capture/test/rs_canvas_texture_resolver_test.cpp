#include "rs_canvas_texture_resolver.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <set>

using namespace grc::rs;
namespace {
int checks = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}
struct Fake : CanvasTextureReader {
  unsigned char memory[32768] = {};
  std::set<std::uint64_t> live{101, 102, 103};
  int reads = 0, type_checks = 0;
  std::map<std::uint64_t, std::int64_t> types{{101,1},{102,1},{103,1}};
  bool copy(std::uint64_t a, void *p, std::size_t n) override {
    ++reads;
    if (a > sizeof(memory) || n > sizeof(memory) - a) return false;
    std::memcpy(p, memory + a, n); return true;
  }
  bool live_texture(std::uint64_t rid) override { return live.contains(rid); }
  std::int64_t texture_type(std::uint64_t rid) override {
    ++type_checks;
    const auto i = types.find(rid); return i == types.end() ? -1 : i->second;
  }
  template<class T> void put(std::uint64_t a, T v) { std::memcpy(memory + a, &v, sizeof(v)); }
  CanvasTextureRecord record{0x1000, {0x5000,128,64,56,0,8,16,44,48},
                                    {0x6000,128,64,56,0,8,16,44,48}};
  const std::uint64_t rid = (std::uint64_t(7) << 32) | 1;
  CanvasTextureChannels channels{101,102,103,2,1};
  Fake() {
    put<std::uint64_t>(0x1000,0x2000); put<std::uint64_t>(0x2000,0x5000);
    put<std::uint64_t>(0x2088,0x3000); put<std::uint32_t>(0x2098,4);
    put<std::uint32_t>(0x209c,4); put<std::uint32_t>(0x20a4,1);
    put<std::uint64_t>(0x3000,0x4000);
    put<std::uint64_t>(0x4040,101); put<std::uint64_t>(0x4048,102);
    put<std::uint64_t>(0x4050,103); put<std::int32_t>(0x406c,2);
    put<std::int32_t>(0x4070,1); put<std::uint32_t>(0x4078,7);
  }
  bool start(CanvasTextureResolver &r) {
    r.attach(true,&record,""); return r.selfcheck(*this,{{rid,channels}});
  }
};
}
int main() {
  Fake f; CanvasTextureChannels out; CanvasTextureResolver r;
  check(f.start(r),"sentinel check passes");
  check(!r.selfcheck(f,{{f.rid,f.channels}}),"self-check only once");
  check(r.resolve(f,f.rid,&out) && out == f.channels,"RD channel layout");
  check(f.type_checks == 3,"each resolved RD channel proves 2D type");
  const int reads=f.reads;
  f.put<std::uint64_t>(0x4040,0);
  check(r.resolve(f,f.rid,&out) && out == f.channels && reads == f.reads,"cached within arm");
  r.elapsed(2500); r.elapsed(1500);
  check(r.json().find("\"resolve_total_us\": 4") != std::string::npos,"total resolve microseconds");
  check(r.json().find("\"resolve_max_us\": 2.5") != std::string::npos,"max resolve microseconds");
  r.detach(); bool cached=false;
  check(!r.cached(f.rid,&out,&cached),"detach drops cache");
  { Fake g; CanvasTextureResolver a;
    check(g.start(a) && a.resolve(g,g.rid,&out),"prepare pending mutation");
    const auto before=g.reads;
    g.put<std::uint64_t>(0x4040,102); g.put<std::int32_t>(0x406c,1);
    a.forget(g.rid);
    check(a.resolve(g,g.rid,&out) && out.diffuse==102 && out.filter==1 && g.reads>before,
          "forget re-reads pending channel and sampling mutation");
    check(a.json().find("\"canvas_textures_resolved\": 1") != std::string::npos &&
          a.json().find("\"canvas_texture_rereads\": 1") != std::string::npos &&
          a.json().find("\"runs\": 1") != std::string::npos,
          "retry counts a reread without another wrapper or self-check");
    const auto snapshot=a.json();
    check(a.resolve(g,g.rid,&out) && a.json()==snapshot,
          "cached retry changes neither counter");
    a.arm_begin();
    check(a.resolve(g,g.rid,&out) &&
          a.json().find("\"canvas_textures_resolved\": 2") != std::string::npos &&
          a.json().find("\"canvas_texture_rereads\": 1") != std::string::npos,
          "same RID counts a first success in a new arm with cumulative rereads");
    a.detach();
    check(a.json().find("\"canvas_textures_resolved\": 0") != std::string::npos &&
          a.json().find("\"canvas_texture_rereads\": 0") != std::string::npos,
          "detach resets both counters");
    g.put<std::uint64_t>(0x4040,101); g.put<std::int32_t>(0x406c,2);
    check(g.start(a) && a.resolve(g,g.rid,&out) &&
          a.json().find("\"canvas_textures_resolved\": 1") != std::string::npos &&
          a.json().find("\"canvas_texture_rereads\": 0") != std::string::npos,
          "detach clears first-success tracking");
  }
  { Fake g; CanvasTextureResolver a;
    const auto second=(std::uint64_t(8)<<32)|2;
    std::memcpy(g.memory+0x4080,g.memory+0x4040,64);
    g.put<std::uint32_t>(0x40b8,8);
    check(g.start(a) && a.resolve(g,g.rid,&out) && a.resolve(g,second,&out),
          "resolve two distinct wrappers");
    check(a.json().find("\"canvas_textures_resolved\": 2") != std::string::npos &&
          a.json().find("\"canvas_texture_rereads\": 0") != std::string::npos,
          "distinct wrappers count first successes only");
  }
  { Fake g; CanvasTextureResolver a;
    check(g.start(a),"prepare forget refusal");
    g.put<std::uint64_t>(0x4040,0);
    check(!a.resolve(g,g.rid,&out),"cache refusal before forget");
    const auto before=g.reads; const auto snapshot=a.json();
    g.put<std::uint64_t>(0x4040,102); a.forget(g.rid);
    check(!a.resolve(g,g.rid,&out) && g.reads==before && a.json()==snapshot,
          "forget preserves cached refusal and counters without reads");
  }
  { Fake g; CanvasTextureResolver a; a.attach(false,nullptr,"");
    check(!a.resolve(g,g.rid,&out),"prepare disabled forget");
    const auto snapshot=a.json(); a.forget(g.rid);
    check(!a.resolve(g,g.rid,&out) && g.reads==0 && a.json()==snapshot,
          "disabled forget preserves reason and counters without reads");
  }
  { Fake g; CanvasTextureResolver a; a.attach(true,&g.record,""); auto wrong=g.channels; ++wrong.filter;
    check(!a.selfcheck(g,{{g.rid,wrong}}),"prepare forget after self-check failure");
    const auto before=g.reads; const auto reason=a.reason(); a.forget(g.rid);
    a.detach(); a.attach(true,&g.record,""); a.forget(g.rid);
    check(!a.selfcheck(g,{{g.rid,g.channels}}) && a.reason()==reason && g.reads==before,
          "forget preserves process failure latch without reads");
  }
  { Fake g; CanvasTextureResolver a;
    check(g.start(a) && a.resolve(g,g.rid,&out),"prepare rearm mutation");
    const auto before=g.reads;
    g.put<std::uint64_t>(0x4040,102); g.put<std::int32_t>(0x406c,1);
    check(a.resolve(g,g.rid,&out) && out == g.channels && g.reads == before,
          "mutation remains cached within arm");
    a.elapsed(2500);
    a.arm_begin();
    check(a.json().find("\"resolve_total_us\": 2.5") != std::string::npos &&
          a.json().find("\"arm_resolve_total_us\": 0") != std::string::npos &&
          a.json().find("\"arm_resolve_max_us\": 0") != std::string::npos,
          "arm begin retains attachment timing and resets arm timing");
    check(a.resolve(g,g.rid,&out) && out.diffuse == 102 && out.filter == 1 && g.reads > before,
          "arm begin re-reads changed channels");
    a.elapsed(1500);
    check(a.json().find("\"resolve_total_us\": 4") != std::string::npos &&
          a.json().find("\"arm_resolve_total_us\": 1.5") != std::string::npos &&
          a.json().find("\"arm_resolve_max_us\": 1.5") != std::string::npos,
          "arm timing excludes earlier arms");
    check(a.json().find("\"canvas_textures_resolved\": 2") != std::string::npos &&
          a.json().find("\"runs\": 1") != std::string::npos,"rearm retains attachment counters and self-check");
    a.arm_begin(); g.put<std::uint64_t>(0x4040,0);
    check(!a.resolve(g,g.rid,&out),"prepare cached invalid diffuse");
    const auto refused=g.reads; g.put<std::uint64_t>(0x4040,101);
    check(!a.resolve(g,g.rid,&out) && g.reads == refused,"repair remains refused within arm");
    a.arm_begin();
    check(a.resolve(g,g.rid,&out) && out.diffuse == 101 && g.reads > refused,
          "arm begin clears repaired refusal");
  }
  { Fake g; CanvasTextureResolver a; a.attach(true,&g.record,""); auto wrong=g.channels; ++wrong.filter;
    check(!a.selfcheck(g,{{g.rid,wrong}}),"prepare failed sentinel before arm");
    const auto before=g.reads; const auto reason=a.reason(); a.arm_begin();
    check(!a.ready() && a.reason()==reason && !a.resolve(g,g.rid,&out) && g.reads==before,
          "arm begin preserves self-check failure without reads");
    a.detach(); a.attach(true,&g.record,""); a.arm_begin();
    check(!a.selfcheck(g,{{g.rid,g.channels}}) && a.reason()==reason && g.reads==before,
          "arm begin preserves permanent failure across attach");
  }
  { Fake g; CanvasTextureResolver a; g.put<std::uint64_t>(0x2000,0x6000);
    check(g.start(a),"GLES3 sentinel layout remains checked");
    const auto before=g.reads;
    check(!a.resolve(g,g.rid,&out) && g.type_checks==0 && g.reads==before+2 &&
          a.json().find("canvas-texture-unresolved:gles-untyped")!=std::string::npos,
          "GLES3 refuses before channel owner or type reads"); }
  for (std::int64_t type : {-1,0,2,3,4,5,6,7}) {
    for (const auto channel : {101,102,103}) {
      Fake g; CanvasTextureResolver a; check(g.start(a),"type refusal sentinel");
      g.types[channel]=type;
      const char *reason=type<0 || type>=7 ? "type-unknown" : "not-2d";
      check(!a.resolve(g,g.rid,&out) &&
            a.json().find(std::string("canvas-texture-unresolved:")+reason)!=std::string::npos,
            "non-2D or unavailable diffuse/normal/specular type refuses");
      const auto before=g.type_checks;
      check(!a.resolve(g,g.rid,&out) && g.type_checks==before,"type refusal cached");
    }
  }
  { Fake g; CanvasTextureResolver a; g.types.erase(101);
    check(g.start(a) && !a.resolve(g,g.rid,&out) &&
          a.json().find("type-unknown")!=std::string::npos,"missing type getter fails closed"); }
  { Fake g; CanvasTextureResolver a;
    g.record.rd = {0x5000,176,144,136,0,8,16,44,48};
    g.put<std::uint64_t>(0x20b8,0x3000); g.put<std::uint32_t>(0x20c8,4);
    g.put<std::uint32_t>(0x20cc,4); g.put<std::uint32_t>(0x20d4,1);
    g.put<std::uint64_t>(0x4090,101); g.put<std::uint64_t>(0x4098,102);
    g.put<std::uint64_t>(0x40a0,103); g.put<std::int32_t>(0x40bc,2);
    g.put<std::int32_t>(0x40c0,1); g.put<std::uint32_t>(0x4118,7);
    check(g.start(a) && a.resolve(g,g.rid,&out) && out == g.channels,"RD 144-byte entry stride");
  }
  { Fake g; CanvasTextureResolver a; check(g.start(a),"first attachment sentinel");
    check(a.resolve(g,g.rid,&out),"first attachment resolve"); a.detach();
    check(g.start(a) && a.resolve(g,g.rid,&out),"new attachment self-check and resolve");
    check(a.json().find("\"canvas_textures_resolved\": 1") != std::string::npos,"new attachment counters reset");
  }
  { Fake g; CanvasTextureResolver a; a.attach(true,nullptr,"no-record");
    check(!a.resolve(g,g.rid,&out) && g.reads==0 &&
      a.json().find("canvas-texture-unresolved:no-record") != std::string::npos,"unrecorded build fails closed");
  }
  { Fake g; CanvasTextureResolver a; g.record.gles3.vptr=0;
    check(g.start(a),"derived record accepts proven backend only");
    g.put<std::uint64_t>(0x2000,0);
    check(!a.resolve(g,g.rid,&out) && a.json().find("backend-mismatch")!=std::string::npos,
          "zero vptr cannot select inactive derived backend");
  }
  auto refuse=[&](const char *name,const std::function<void(Fake &)> &change,const char *reason) {
    Fake g; CanvasTextureResolver a; check(g.start(a),"prepare refusal sentinel"); change(g);
    check(!a.resolve(g,g.rid,&out) && a.json().find(reason)!=std::string::npos,name);
    const auto before=g.reads; a.resolve(g,g.rid,&out);
    check(before==g.reads,"refusal cached");
  };
  refuse("wrong backend",[](Fake &g){g.put<std::uint64_t>(0x2000,0x7000);},"backend-mismatch");
  refuse("stale RID",[](Fake &g){g.put<std::uint32_t>(0x4078,8);},"rid-owner-mismatch");
  refuse("uninitialized slot",[](Fake &g){g.put<std::uint32_t>(0x4078,0x80000007);},"rid-owner-mismatch");
  refuse("bounds",[](Fake &g){g.put<std::uint32_t>(0x209c,0);},"owner-bounds");
  refuse("null chunk",[](Fake &g){g.put<std::uint64_t>(0x3000,0);},"chunk-unreadable");
  refuse("unreadable chunk",[](Fake &g){g.put<std::uint64_t>(0x3000,UINT64_MAX-16);},"chunk-unreadable");
  refuse("dead diffuse",[](Fake &g){g.live.erase(101);},"invalid-diffuse");
  refuse("empty diffuse",[](Fake &g){g.put<std::uint64_t>(0x4040,0);},"invalid-diffuse");
  refuse("dead normal",[](Fake &g){g.live.erase(102);},"invalid-channel");
  refuse("bad sampling",[](Fake &g){g.put<std::int32_t>(0x406c,7);},"invalid-sampling");
  { Fake g; CanvasTextureResolver a; a.attach(true,&g.record,"");
    check(!a.resolve(g,g.rid,&out) && g.reads==0,"no reads before self-check"); }
  { Fake g; CanvasTextureResolver a; a.attach(true,&g.record,"");
    check(!a.selfcheck(g,{}),"empty sentinel set fails"); a.detach(); a.attach(true,&g.record,"");
    check(!a.selfcheck(g,{{g.rid,g.channels}}) && g.reads==0,"failure latches across attachments"); }
  { Fake g; CanvasTextureResolver a; a.attach(true,&g.record,""); auto wrong=g.channels; ++wrong.diffuse;
    check(!a.selfcheck(g,{{g.rid,wrong}}) && !a.ready(),"mismatch disables resolver"); }
  { Fake g; CanvasTextureResolver a; a.attach(false,nullptr,"");
    check(!a.selfcheck(g,{{g.rid,g.channels}}) && g.reads==0,"flag off zero reads"); }
  using Fields=std::vector<std::pair<std::string,std::int64_t>>;
  Fields fields{{"version",1},{"global",0x1000}};
  for(auto prefix:{"rd_","gles3_"}) {
    for(auto [key,value]:Fields{{"vptr",prefix==std::string("rd_")?0x5000:0x6000},
       {"owner",128},{"stride",64},{"validator",56},{"diffuse",0},{"normal",8},
       {"specular",16},{"filter",44},{"repeat",48}}) fields.emplace_back(prefix+key,value);
  }
  CanvasTextureRecord parsed; std::string why;
  check(CanvasTextureRecord::parse(fields,0x100000,&parsed,&why) && parsed.global==0x101000 &&
        parsed.rd.vptr==0x105000 && parsed.rd.owner==128,"record relocates addresses only");
  auto invalid=[&](Fields v,const char *name){check(!CanvasTextureRecord::parse(v,0,&parsed,&why),name);};
  auto v=fields; v.pop_back(); invalid(v,"missing layout field");
  v=fields; v.push_back(fields[0]); invalid(v,"duplicate record field");
  v=fields; v.emplace_back("unknown",1); invalid(v,"unknown record field");
  v=fields; v[8].second=8; invalid(v,"overlapping channels");
  v=fields; v[0].second=2; invalid(v,"unrecognized record version");
  v=fields; v[1].second=-1; invalid(v,"negative address");
  check(!CanvasTextureRecord::parse(fields,UINT64_MAX-0xfff,&parsed,&why),"address overflow");
  std::printf("%d passed, 0 failed\n",checks);
}
