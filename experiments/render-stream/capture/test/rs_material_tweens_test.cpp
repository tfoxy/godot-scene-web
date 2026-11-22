// Material announcements use the same delivery path as node announcements.
#include "rs_tweens.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <limits>
using namespace grc::rs::tweens;
namespace {
int checks = 0, failures = 0;
void check(bool ok, const char *message) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr,"FAIL material: %s\n",message); }
}
Value::Object step(std::string property = "shader_parameter/threshold", Value to = 0.0) {
  return {{"property",property},{"to",to},{"start_ms",0},{"duration_ms",2000},{"trans",0},{"ease",0}};
}
Value::Object begin(int id = 1, Value::Array steps = {step()}, int object = 42) {
  return {{"tween_id",id},{"object_id",object},{"started_usec",1000},{"steps",steps}};
}
std::uint64_t drop(const Host &h, const char *reason) {
  const auto it = h.stats().drops_by_reason.find(reason);
  return it == h.stats().drops_by_reason.end() ? 0 : it->second;
}
std::int64_t stat(const Host &h, const char *key) {
  return std::get<std::int64_t>(h.state().at(key).data);
}
std::string meta(const std::vector<std::uint8_t> &b) {
  std::uint32_t n = 0;
  for(int i=0;i<4;++i)n |= std::uint32_t(b[4+i]) << (8*i);
  return {b.begin()+8,b.begin()+8+n};
}
struct Fixture {
  Host h;
  Material material;
  int reads = 0;
  std::string reason;
  Resolve node = [](std::uint64_t, Pose *p) { p->item = 7; return std::string(); };
  ResolveMaterial resolve = [&](std::uint64_t object, Material *out, bool allowed) {
    if (object == 7) return std::string("node");
    if (!allowed) return std::string("material-version");
    ++reads;
    *out = material;
    if (object == 43) out->id = 8;
    return reason;
  };
  Fixture() {
    material.id = 7; material.shader = 3; material.shader_version = 1; material.supported = true;
    grc::rs2::Param p; p.name="threshold"; p.type=grc::rs2::VariantType::Float; p.floats={1};
    material.params[p.name] = p;
    h.grant(1,grc::rs2::ProtocolVersion::V19);
  }
  void start(Value v = begin()) { h.begin(v,1000,node,resolve); }
  Frame frame(std::uint64_t t = 2000) { return h.snapshot(t,node,resolve); }
  Record take(std::uint64_t t = 2000) { return h.take(1,frame(t)); }
};
void run() {
  using grc::rs2::ProtocolVersion;
  using grc::rs2::VariantType;
  // Two viewers can select different saved pictures after a replacement's parameter vanishes.
  {
    Fixture race; race.h.grant(2,ProtocolVersion::V19);
    const auto p=race.material.params.at("threshold"); auto q=p; q.name="other"; race.material.params[q.name]=q;
    race.start(begin(1,{step(),step("shader_parameter/other")}));
    const auto initial=race.frame(2000); race.h.take(1,initial); race.h.take(2,initial);
    race.h.begin(begin(2),3000,race.node,race.resolve);
    const auto f1=race.frame(3500);
    race.material.params.erase("threshold"); const auto f2=race.frame(4000);
    race.material.params["threshold"]=p;
    const auto delivered=race.h.take(1,f1);
    check(delivered.events.size()==1 && delivered.events[0].id==2 && !delivered.events[0].cancel,
      "sibling race viewer one receives replacement from saved picture");
    const auto lagged=race.h.take(2,f2);
    check(lagged.events.size()==1 && lagged.events[0].cancel && lagged.events[0].id==1,
      "lagged viewer suppresses pruned replacement and its undelivered cancel");
    const auto retired=race.h.take(1,race.frame(5000));
    check(std::any_of(retired.events.begin(),retired.events.end(),[](const Event &e) { return e.cancel && e.id==2; }),
      "cross-viewer pruning cancels a replacement already delivered to another viewer");
    check(stat(race.h,"live_material_tweens")==0 && stat(race.h,"owned_material_components")==0,
      "cross-viewer pruning releases all host ownership");
    check(race.h.take(1,race.frame(6000)).events.empty() && race.h.take(2,race.frame(6000)).events.empty(),
      "cross-viewer prune emits no repeated cancels");
  }
  Fixture f;
  f.start(); auto r=f.take();
  check(r.events.size()==1 && r.events[0].material==7 && r.poses.empty(),"resource begin has no material pose");
  check(r.events.size()==1 && r.events[0].steps[0].param=="threshold", "bare exact param name");
  auto m=meta(encode(r,1,1,2000));
  check(m.find("\"material\":7,\"order\":1,\"begin_us\":1000,\"end_us\":2001000")!=std::string::npos,
    "ordered material begin keys");
  check(m.find("\"param\":\"threshold\",\"type\":\"float\",\"component\":null,\"start_us\":0,\"duration_us\":2000000,\"trans\":0,\"ease\":0,\"from\":null,\"to\":0")!=std::string::npos,
    "ordered material step keys and offsets");
  check(stat(f.h,"material_begins_accepted")==1 && stat(f.h,"material_steps_accepted")==1 &&
    stat(f.h,"live_material_tweens")==1 && stat(f.h,"owned_material_components")==1,"material counters");
  f.material.params["threshold"].floats={0.6};
  check(f.take(3000).empty() && stat(f.h,"live_material_tweens")==1,"host motion adds no tween pose or forced upsert");
  f.h.cancel(1,4000); r=f.take(5000);
  check(r.events.size()==1 && r.events[0].cancel && r.poses.empty(),"material cancel needs no floats or poses");
  check(meta(encode(r,2,2,5000)).find("\"poses\":[],\"blocks\":[]")!=std::string::npos,"cancel-only empty blocks");
  // Every supported type, whole values and every allowed component, with strict Variant endpoints.
  struct Type { VariantType type; const char *name, *suffixes; Value value; std::vector<double> baseline; };
  const Type types[] = {
    {VariantType::Float,"float","",2.0,{1}},
    {VariantType::Vector2,"vector2","xy",Vector2{1,2},{3,4}},
    {VariantType::Vector3,"vector3","xyz",Vector3{1,2,3},{4,5,6}},
    {VariantType::Vector4,"vector4","xyzw",Vector4{1,2,3,4},{5,6,7,8}},
    {VariantType::Color,"color","rgba",Color{1,0.5,2,-1},{0,1,0,1}}
  };
  for (const auto &type : types) {
    Fixture t;
    auto &p=t.material.params["threshold"]; p.type=type.type; p.floats=type.baseline;
    auto s=step("shader_parameter/threshold",type.value); s["from"]=type.value;
    t.start(begin(1,{s})); auto record=t.take();
    check(record.events.size()==1 && record.events[0].steps[0].to.size()==type.baseline.size(),"whole Variant type/arity");
    for (std::size_t c=0;c<std::strlen(type.suffixes);++c) {
      auto component=step(std::string("shader_parameter/threshold:")+type.suffixes[c],1.5);
      t.start(begin(static_cast<int>(2+c),{component})); record=t.take(3000+c);
      const bool retires_whole=c+1==type.baseline.size();
      check(record.events.size()==(retires_whole ? 2u : 1u) &&
        (!retires_whole || (record.events[0].cancel && record.events[0].id==1)) &&
        !record.events.back().cancel && record.events.back().steps[0].component==static_cast<int>(c),
        "component normalizes to index and final replacement retires whole tween");
    }
    auto bad=step("shader_parameter/threshold",Value::Array{1,2,3,4});
    t.start(begin(20,{bad})); check(drop(t.h,"invalid-value")==1,"arrays never coerce to endpoints");
    bad=step("shader_parameter/threshold",type.type==VariantType::Float ? Value(2) : Value(2.0));
    t.start(begin(21,{bad})); check(drop(t.h,"invalid-value")==2,"endpoint must match Variant exactly");
  }
  // First-failure ordering; malformed names do not reach param lookup or timing.
  for (const char *name : {"threshold","shader_parameter/","shader_parameter/9x","shader_parameter/a/b",
      "shader_parameter/a[0]","shader_parameter/threshold:q","shader_parameter/threshold:xx",
      "material:shader_parameter/threshold","instance_shader_parameters/threshold","global_shader_parameter/threshold"}) {
    Fixture t; t.start(begin(1,{step(name,false)}));
    check(drop(t.h,"unsupported-property")==1 && drop(t.h,"empty-steps")==1,"unsupported paths and suffix spelling first");
  }
  for (const char *name : {"shader_parameter/Threshold","shader_parameter/missing"}) {
    Fixture t; t.start(begin(1,{step(name,false)})); check(drop(t.h,"missing-material-param")==1,"exact name/default-only rejected before values");
  }
  for (VariantType type : {VariantType::Int,VariantType::Vector2i,VariantType::Vector3i,VariantType::Vector4i,
      VariantType::Bool,VariantType::Rid,VariantType::PackedFloat32Array,VariantType::Transform2D}) {
    Fixture t; t.material.params["threshold"].type=type;
    t.start(begin(1,{step("shader_parameter/threshold:x",false)}));
    check(drop(t.h,"material-param-type")==1,"unsupported baseline Variant precedes suffix/value errors");
  }
  for (const char *suffix : {"x","r"}) {
    Fixture t; t.start(begin(1,{step(std::string("shader_parameter/threshold:")+suffix,false)}));
    check(drop(t.h,"material-param-mismatch")==1,"any float suffix mismatches before endpoint check");
  }
  for (const auto &type : types) if (type.type != VariantType::Float) {
    Fixture t; auto &p=t.material.params["threshold"]; p.type=type.type; p.floats=type.baseline;
    t.start(begin(1,{step(type.type==VariantType::Color ? "shader_parameter/threshold:x" : "shader_parameter/threshold:a",false)}));
    check(drop(t.h,"material-param-mismatch")==1,"wrong component family mismatches");
  }
  for (double value : {std::numeric_limits<double>::infinity(),std::numeric_limits<double>::max()}) {
    Fixture t; t.start(begin(1,{step("shader_parameter/threshold",value)}));
    check(drop(t.h,"invalid-value")==1,"nonfinite and f32 overflow endpoints rejected");
    Fixture b; b.material.params["threshold"].floats={value}; b.start();
    check(drop(b.h,"invalid-value")==1,"nonfinite and f32 overflow baseline rejected");
  }
  for (const char *reason : {"unresolved-object","unsupported-target","unpublished-material","unsupported-material"}) {
    Fixture t; t.reason=reason; t.start(); check(drop(t.h,reason)==1,"target resolution failure");
  }
  { Fixture t; auto s=step(); s["extra"]=1; t.start(begin(1,{s})); check(drop(t.h,"invalid-step")==1,"invalid-step first"); }
  { Fixture t; auto s=step(); s["duration_ms"]=-1; s["ease"]=-1; t.start(begin(1,{s})); check(drop(t.h,"invalid-timing")==1,"timing before easing"); }
  { Fixture t; auto s=step(); s["trans"]=-1; t.start(begin(1,{s})); check(drop(t.h,"invalid-easing")==1,"invalid easing"); }
  // Partition node floats -> poses -> material floats, despite interleaved event order.
  { Fixture t; auto s=step(); s["from"]=1.0; t.start(begin(1,{s}));
    t.start(begin(2,{step("position",Vector2{100,200})},7)); auto mixed=t.take();
    auto metadata=meta(encode(mixed,1,1,2000));
    check(metadata.find("\"from\":0,\"to\":1")==std::string::npos &&
      metadata.find("\"from\":18,\"to\":19")!=std::string::npos &&
      metadata.find("\"kind\":\"node2d\",\"f\":2")!=std::string::npos,"mixed three-phase float offsets");
    check(stat(t.h,"owned_components")==3 && stat(t.h,"owned_material_components")==1,"node/material claims independent at equal IDs");
  }
  // Shared resource claims: partial replacement, other params and local_to_scene clones are independent.
  { Fixture t; auto &p=t.material.params["threshold"]; p.type=VariantType::Vector2; p.floats={0,0};
    t.start(begin(1,{step("shader_parameter/threshold",Vector2{1,1})})); t.take();
    t.start(begin(2,{step("shader_parameter/threshold:x",2.0)})); t.take(3000);
    check(stat(t.h,"live_material_tweens")==2 && stat(t.h,"owned_material_components")==2 &&
      t.h.stats().claims_replaced==1,"partial material replacement retains y claim without resurrection");
    t.start(begin(2)); check(drop(t.h,"duplicate-id")==1,"shared ID namespace rejects live duplicate");
    t.start(begin(3,{step("shader_parameter/threshold",Vector2{2,2})},43)); t.take(4000);
    check(stat(t.h,"owned_material_components")==4,"distinct material clones own independent components");
  }
  // A replacement can lose its baseline before association. Delivered owners must still
  // retire before their ID is reused, including viewers coalesced across the invalidation.
  { Fixture t; t.h.grant(2,ProtocolVersion::V19); t.h.grant(3,ProtocolVersion::V19);
    const auto original=t.material;
    auto announce=[&](int id, std::int64_t now) {
      auto s=step(); s["duration_ms"]=20000;
      auto b=begin(id,{s}); b["started_usec"]=now;
      t.h.begin(b,static_cast<std::uint64_t>(now),t.node,t.resolve);
    };
    announce(1,1000); auto first=t.frame(2000);
    auto a=t.h.take(1,first), b=t.h.take(2,first);
    check(a.events.size()==1 && b.events.size()==1 && !a.events[0].cancel &&
      a.events[0].id==1 && b.events[0].id==1,"original material begin delivered to both active viewers");
    // Viewer 3 has not received A; viewer 2 receives A but coalesces the next picture.
    announce(2,3000); t.material.params.clear(); auto invalid=t.frame(4000);
    auto retired=t.h.take(1,invalid);
    check(retired.events.size()==1 && retired.events[0].cancel && retired.events[0].id==1 &&
      retired.events[0].order==1,"pruned replacement still retires delivered original material tween");
    check(t.h.take(3,invalid).empty(),"unsent original and pruned replacement suppress their own cancels");
    check(stat(t.h,"live_material_tweens")==0 && drop(t.h,"material-baseline-changed")==2,
      "both unsent generations pruned once without live host ownership");
    t.material=original; announce(1,5000); auto restored=t.frame(6000);
    auto active=t.h.take(1,restored), coalesced=t.h.take(2,restored), unsent=t.h.take(3,restored);
    check(active.events.size()==1 && !active.events[0].cancel && active.events[0].id==1 &&
      active.events[0].order==3,"delivered original ID can begin again after retirement");
    check(coalesced.events.size()==2 && coalesced.events[0].cancel && coalesced.events[0].id==1 &&
      coalesced.events[0].order==1 && !coalesced.events[1].cancel && coalesced.events[1].id==1 &&
      coalesced.events[1].order==3,"coalesced viewer retires original before reused ID begin");
    check(unsent.events.size()==1 && !unsent.events[0].cancel && unsent.events[0].order==3,
      "unsent viewer receives only the restored generation");
    check(t.h.stats().begins_accepted==3 && drop(t.h,"duplicate-id")==0 &&
      stat(t.h,"live_material_tweens")==1 && t.take(7000).empty(),
      "reused ID accepted once and no obsolete tween or cancel resurfaces");
  }
  // A partially superseded owner must retire if its replacement loses transferred claims.
  for (bool partial : {false,true}) for (int invalidation=0;invalidation<3;++invalidation)
    for (bool unsent_first : {false,true}) {
    Fixture t; t.h.grant(2,ProtocolVersion::V19); t.h.grant(3,ProtocolVersion::V19);
    for (const char *name : {"p","q","r"}) {
      auto p=t.material.params.at("threshold"); p.name=name; t.material.params[name]=p;
    }
    const auto original=t.material;
    const int a=partial ? 20 : 1, b=a+1;
    const std::string label=partial ? "partly pruned replacement: " : "fully pruned replacement: ";
    auto expect=[&](bool ok,const char *message) { check(ok,(label+message).c_str()); };
    auto announce=[&](int id,std::initializer_list<const char *> names,std::int64_t now) {
      Value::Array steps;
      for (auto name : names) { auto s=step(std::string("shader_parameter/")+name); s["duration_ms"]=20000; steps.emplace_back(s); }
      auto value=begin(id,steps); value["started_usec"]=now;
      t.h.begin(value,static_cast<std::uint64_t>(now),t.node,t.resolve);
    };
    if (partial) announce(a,{"p","q","r"},1000); else announce(a,{"p","q"},1000);
    auto first=t.frame(2000);
    for (auto viewer : {1u,2u}) {
      auto record=t.h.take(viewer,first);
      expect(record.events.size()==1 && !record.events[0].cancel && record.events[0].id==a,
        "A delivered to active and coalesced viewers");
    }
    // Viewer 3 still has an unsent A; viewer 4 joined after A and must never replay it.
    t.h.grant(4,ProtocolVersion::V19);
    if (partial) announce(b,{"p","q"},3000); else announce(b,{"p"},3000);
    const char *lost=partial ? "q" : "p";
    if (invalidation==0) t.material.params.erase(lost);
    if (invalidation==1) t.material.params[lost].type=VariantType::Int;
    if (invalidation==2) t.material.params[lost].floats={std::numeric_limits<double>::infinity()};
    auto invalid=t.frame(4000);
    Record unsent;
    if (unsent_first) unsent=t.h.take(3,invalid);
    auto active=t.h.take(1,invalid);
    if (!unsent_first) unsent=t.h.take(3,invalid);
    expect(!active.events.empty() && std::any_of(active.events.begin(),active.events.end(),[&](const Event &e) {
      return e.cancel && e.id==a && e.order==1;
    }),"active viewer receives ordinary cancel(A) with the associated picture");
    auto replacement=[&](const Record &record) {
      return record.events.size()==(partial ? 1u : 0u) && (!partial ||
        (!record.events[0].cancel && record.events[0].id==b && record.events[0].steps.size()==1 &&
         record.events[0].steps[0].param=="p"));
    };
    expect(replacement(unsent),"unsent A and its cancel suppressed; only valid B steps delivered");
    expect(replacement(t.h.take(4,invalid)),"late viewer receives no A begin or unknown cancel");
    t.material=original; auto restored=t.frame(5000);
    expect(t.h.take(1,restored).empty(),"restoring the param cannot resurrect old ownership");
    auto coalesced=t.h.take(2,restored);
    expect(coalesced.events.size()==(partial ? 2u : 1u) &&
      std::any_of(coalesced.events.begin(),coalesced.events.end(),[&](const Event &e) { return e.cancel && e.id==a; }),
      "coalesced viewer receives cancel(A) with any surviving B begin");
    expect(stat(t.h,"live_material_tweens")== (partial ? 1 : 0) &&
      stat(t.h,"owned_material_components")== (partial ? 1 : 0),"host ownership matches delivered events after restoration");
    expect(stat(t.h,"material_tweens_retired")==1 && drop(t.h,"material-target-changed")==1,
      "old owner retirement counted once globally with the existing reason");
    announce(a,{partial ? "r" : "q"},6000); auto reused=t.frame(7000);
    for (auto viewer : {1u,2u,3u,4u}) {
      auto record=t.h.take(viewer,reused);
      expect(record.events.size()==1 && !record.events[0].cancel && record.events[0].id==a && record.events[0].order==3,
        "retired A ID begins again without an obsolete event");
    }
    expect(drop(t.h,"duplicate-id")==0 && stat(t.h,"live_material_tweens")== (partial ? 2 : 1) &&
      stat(t.h,"owned_material_components")== (partial ? 2 : 1),"reused ID accepted with only the sent claims");
  }
  // Transfer history must outlive an unsent replacement, and a delivered successor
  // must complete the transfer instead of cancelling the intact partial owner.
  for (int scenario=0;scenario<4;++scenario) for (bool unsent_first : {false,true}) {
    Fixture t; t.h.grant(2,ProtocolVersion::V19); t.h.grant(3,ProtocolVersion::V19);
    for (const char *name : {"p","q"}) {
      auto p=t.material.params.at("threshold"); p.name=name; t.material.params[name]=p;
    }
    const auto original=t.material;
    const bool delivered=scenario>=2;
    const std::string label=std::string("retired replacement scenario ")+std::to_string(scenario)+": ";
    auto expect=[&](bool ok,const char *message) { check(ok,(label+message).c_str()); };
    auto announce=[&](int id,Value::Array steps,std::int64_t now) {
      auto value=begin(id,steps); value["started_usec"]=now;
      t.h.begin(value,static_cast<std::uint64_t>(now),t.node,t.resolve);
    };
    // Replay exactly the material events a viewer receives, including generation reuse.
    struct Client { std::map<std::int64_t,Claims> held; } clients[4];
    auto apply=[&](unsigned viewer,const Record &record) {
      for (const auto &e : record.events) {
        if (e.cancel) { expect(clients[viewer-1].held.erase(e.id)==1,"cancel references a delivered live ID"); continue; }
        Claims held;
        for (const auto &s : e.steps) held[s.param]|=s.claims;
        for (auto it=clients[viewer-1].held.begin();it!=clients[viewer-1].held.end();) {
          for (const auto &claim : held) {
            auto old=it->second.find(claim.first);
            if (old!=it->second.end()) {
              old->second &= ~claim.second;
              if (!old->second) it->second.erase(old);
            }
          }
          if (it->second.empty()) it=clients[viewer-1].held.erase(it); else ++it;
        }
        expect(!clients[viewer-1].held.count(e.id),"begin never duplicates a delivered live ID");
        clients[viewer-1].held[e.id]=held;
      }
    };
    announce(1,{step("shader_parameter/p"),step("shader_parameter/q")},1000);
    auto first=t.frame(2000);
    for (auto viewer : {1u,2u}) apply(viewer,t.h.take(viewer,first));
    t.h.grant(4,ProtocolVersion::V19);
    announce(2,{step("shader_parameter/p")},3000);
    if (scenario==0) t.h.cancel(2,3100);
    else {
      if (scenario==2) {
        // B's scalar step is pruned, but C's delivered vector begin moves p off A.
        t.material.params["p"].type=VariantType::Vector2;
        t.material.params["p"].floats={0,0};
      }
      announce(3,{step("shader_parameter/p",scenario==2 ? Value(Vector2{1,1}) : Value(0.0))},3200);
    }
    if (!delivered) t.material.params.erase("p");
    auto picture=t.frame(4000);
    for (auto viewer : (unsent_first ? std::vector<unsigned>{3,1,4} : std::vector<unsigned>{1,3,4})) {
      auto record=t.h.take(viewer,picture);
      if (viewer==1) expect(std::any_of(record.events.begin(),record.events.end(),[](const Event &e) {
        return e.cancel && e.id==1;
      })==!delivered,"A cancels only when no delivered begin carries its lost claims");
      apply(viewer,record);
    }
    // Do not mutate the valid C type while checking its delivered-chain control.
    if (!delivered) t.material=original;
    auto restored=t.frame(5000);
    expect(t.h.take(1,restored).empty(),"restoration cannot revive a stale animation");
    apply(2,t.h.take(2,restored));
    const auto expected_live=delivered ? 2 : 0;
    const auto expected_components=delivered ? (scenario==2 ? 3 : 2) : 0;
    expect(stat(t.h,"live_material_tweens")==expected_live &&
      stat(t.h,"owned_material_components")==expected_components,"host counters match the delivered claims after restore");
    for (unsigned viewer=1;viewer<=4;++viewer) {
      auto &held=clients[viewer-1].held;
      // Viewer 4 joined after A: it can receive C, but cannot inherit A's q.
      expect(held.size()==static_cast<unsigned>(delivered ? (viewer==4 ? 1 : 2) : 0),
        "active, coalesced, unsent and late viewers keep only their delivered IDs");
      if (delivered) {
        expect(held.at(3).at("p")==static_cast<unsigned>(scenario==2 ? 3 : 1),"C owns exactly its sent p components");
        if (viewer!=4) expect(held.at(1).size()==1 && held.at(1).at("q")==1,"A keeps q without cancellation");
      }
    }
    if (delivered) t.h.cancel(1,5500);
    announce(1,{step("shader_parameter/q")},6000); auto reused=t.frame(7000);
    for (unsigned viewer=1;viewer<=4;++viewer) apply(viewer,t.h.take(viewer,reused));
    expect(drop(t.h,"duplicate-id")==0 && stat(t.h,"live_material_tweens")== (delivered ? 2 : 1) &&
      stat(t.h,"owned_material_components")== (delivered ? expected_components : 1),"reused A ID has no stale ownership or duplicate-id");
  }
  // Delivery state is per viewer: the active viewer received B's transfer, but
  // the coalesced viewer still requires cancel(A) if B is later suppressed.
  { Fixture t; t.h.grant(2,ProtocolVersion::V19);
    auto q=t.material.params.at("threshold"); q.name="q"; t.material.params["q"]=q;
    t.start(begin(1,{step(),step("shader_parameter/q")})); auto first=t.frame();
    for (auto viewer : {1u,2u}) t.h.take(viewer,first);
    t.h.begin(begin(2),3000,t.node,t.resolve);
    auto active=t.h.take(1,t.frame(3500));
    check(active.events.size()==1 && !active.events[0].cancel && active.events[0].id==2,
      "active viewer receives B while coalesced viewer retains its unsent history");
    t.h.cancel(2,3600); t.material.params.erase("threshold"); auto picture=t.frame(4000);
    active=t.h.take(1,picture);
    check(active.events.size()==1 && active.events[0].cancel && active.events[0].id==2 &&
      stat(t.h,"live_material_tweens")==1,"delivered B's cancel releases its claim without cancelling A prematurely");
    auto coalesced=t.h.take(2,picture);
    check(coalesced.events.size()==1 && coalesced.events[0].cancel && coalesced.events[0].id==1,
      "coalesced viewer cancels A when its B begin cannot be delivered");
    t.material.params["threshold"]=q; t.material.params["threshold"].name="threshold";
    active=t.h.take(1,t.frame(5000));
    check(active.events.size()==1 && active.events[0].cancel && active.events[0].id==1 &&
      stat(t.h,"live_material_tweens")==0 && stat(t.h,"owned_material_components")==0,
      "global authority retires A for every viewer after the coalesced suppression");
  }
  // A saved picture may be encoded after a future announcement was queued. Its
  // authoritative retirement must precede that future begin in the pending queue.
  { Fixture t;
    for (const char *name : {"q","r"}) {
      auto p=t.material.params.at("threshold"); p.name=name; t.material.params[name]=p;
    }
    const auto original=t.material;
    t.start(begin(1,{step(),step("shader_parameter/q")})); t.take();
    t.h.begin(begin(2),3000,t.node,t.resolve); t.h.cancel(2,3100);
    t.material.params.erase("threshold"); auto saved=t.frame(4000);
    t.material=original;
    t.h.begin(begin(3,{step("shader_parameter/r")}),4500,t.node,t.resolve);
    auto record=t.h.take(1,saved);
    check(record.events.size()==1 && record.events[0].cancel && record.events[0].id==1,
      "saved picture delivers cancel(A) before a future pending begin");
    record=t.take(5000);
    check(record.events.size()==1 && !record.events[0].cancel && record.events[0].id==3 &&
      stat(t.h,"live_material_tweens")==1 && stat(t.h,"owned_material_components")==1,
      "future begin stays queued while the saved picture retires stale ownership");
  }
  // Timing suppression also keeps the unsent begin's transfer history. A surviving
  // sibling step does not carry the claim that overflow removed.
  for (bool partial : {false,true}) {
    Fixture t; t.h.grant(2,ProtocolVersion::V19);
    for (const char *name : {"p","q","r"}) {
      auto p=t.material.params.at("threshold"); p.name=name; t.material.params[name]=p;
    }
    t.start(begin(1,{step("shader_parameter/p"),step("shader_parameter/q")}));
    auto first=t.frame(2000);
    for (auto viewer : {1u,2u}) t.h.take(viewer,first);
    auto overflow=step("shader_parameter/p"); overflow["duration_ms"]=9007199254730.0;
    Value::Array steps={overflow};
    if (partial) steps.emplace_back(step("shader_parameter/r"));
    auto value=begin(2,steps); value.erase("started_usec");
    t.h.begin(value,3000,t.node,t.resolve);
    auto picture=t.frame(20000);
    for (auto viewer : {1u,2u}) {
      const auto record=t.h.take(viewer,picture);
      check(record.events.size()==(partial ? 2u : 1u) &&
        std::any_of(record.events.begin(),record.events.end(),[](const Event &e) { return e.cancel && e.id==1; }),
        "timing-suppressed transfer cancels A for active and coalesced viewers");
    }
    check(stat(t.h,"live_material_tweens")== (partial ? 1 : 0) &&
      stat(t.h,"owned_material_components")== (partial ? 1 : 0) && drop(t.h,"invalid-timing")==1,
      "overflow leaves only the delivered sibling claims and counts once");
  }
  // A valid B begin followed by its ordinary cancel still carries A's claim move,
  // even if C is pruned. Do not suppress B just because it has already retired.
  { Fixture t;
    auto q=t.material.params.at("threshold"); q.name="q"; t.material.params["q"]=q;
    t.start(begin(1,{step(),step("shader_parameter/q")})); t.take();
    t.h.begin(begin(2),3000,t.node,t.resolve);
    t.material.params["threshold"].type=VariantType::Vector2;
    t.material.params["threshold"].floats={0,0};
    t.h.begin(begin(3,{step("shader_parameter/threshold",Vector2{1,1})}),3200,t.node,t.resolve);
    t.material.params["threshold"].type=VariantType::Float;
    t.material.params["threshold"].floats={1};
    auto record=t.take(4000);
    check(record.events.size()==2 && !record.events[0].cancel && record.events[0].id==2 &&
      record.events[1].cancel && record.events[1].id==2 && stat(t.h,"live_material_tweens")==1 &&
      stat(t.h,"owned_material_components")==1,"delivered B then cancel releases p while A keeps q");
  }
  // Reuse a replacement ID repeatedly before take: ancestry is keyed by generation.
  { Fixture t; t.h.grant(2,ProtocolVersion::V19);
    auto q=t.material.params.at("threshold"); q.name="q"; t.material.params["q"]=q;
    t.start(begin(1,{step(),step("shader_parameter/q")})); auto first=t.frame();
    for (auto viewer : {1u,2u}) t.h.take(viewer,first);
    for (auto now : {3000u,3200u}) { t.h.begin(begin(2),now,t.node,t.resolve); t.h.cancel(2,now+100); }
    t.material.params.erase("threshold"); auto picture=t.frame(4000);
    for (auto viewer : {1u,2u}) {
      auto record=t.h.take(viewer,picture);
      check(record.events.size()==1 && record.events[0].cancel && record.events[0].id==1,
        "reused unsent replacement generations still retire their delivered ancestor");
    }
    check(drop(t.h,"duplicate-id")==0 && stat(t.h,"live_material_tweens")==0 &&
      stat(t.h,"owned_material_components")==0,"reused unsent generations leave no host claims");
  }
  // Pending baseline recheck uses the saved picture, prunes once globally and suppresses unsent cancels.
  { Fixture t; t.h.grant(2,ProtocolVersion::V19); t.start();
    auto saved=t.frame(); t.material.params.clear();
    auto r1=t.h.take(1,saved);
    check(r1.events.size()==1,"encoder uses immutable snapshot rather than changed live params");
    t.h.observe_materials(3000,t.resolve); auto r2=t.h.take(1,t.frame(4000));
    check(r2.events.size()==1 && r2.events[0].cancel,"host changed target sends cancel to delivered viewer");
  }
  { Fixture t; t.h.grant(2,ProtocolVersion::V19); t.start(); t.material.params.clear(); auto frame=t.frame();
    check(t.h.take(1,frame).empty() && t.h.take(2,frame).empty() &&
      drop(t.h,"material-baseline-changed")==1 && stat(t.h,"live_material_tweens")==0,"pending invalidation counted once, no orphan cancel");
  }
  { Fixture t; auto p=t.material.params["threshold"]; p.name="other"; t.material.params["other"]=p;
    t.start(begin(1,{step(),step("shader_parameter/other",2.0)})); t.material.params.erase("threshold"); auto record=t.take();
    check(record.events.size()==1 && record.events[0].steps.size()==1 && record.events[0].steps[0].param=="other" &&
      stat(t.h,"owned_material_components")==1,"pending partial invalidation recomputes steps and claims");
  }
  // Observe every host frame, even if a viewer is coalesced and misses a brief type change.
  for (int change=0;change<8;++change) {
    Fixture t; t.start(); t.take(); auto original=t.material;
    if(change==0)t.material.params.clear();
    if(change==1)t.material.params["threshold"].type=VariantType::Int;
    if(change==2)t.material.params["threshold"].floats={std::numeric_limits<double>::infinity()};
    if(change==3)t.material.shader++;
    if(change==4)t.material.shader_version++;
    if(change==5)t.material.supported=false;
    if(change==6)t.reason="unresolved-object";
    if(change==7)t.material.id++;
    t.h.observe_materials(3000,t.resolve); t.material=original; t.reason.clear();
    t.start(begin(1)); auto record=t.take(4000);
    check(record.events.size()==2 && record.events[0].cancel && record.events[1].id==1 &&
      !record.events[1].cancel && drop(t.h,"material-target-changed")==1 && stat(t.h,"material_tweens_retired")==1,
      "transient invalidation queues cancel before reused ID begin");
  }
  { Fixture t; t.start(); t.take(); t.h.grant(2,ProtocolVersion::V19); t.h.resync(1);
    check(t.take(3000).empty() && t.h.take(2,t.frame(3000)).empty(),"late join and resync never replay material begins");
    t.h.cancel(1,4000); auto frame=t.frame(5000);
    check(t.h.take(1,frame).empty() && t.h.take(2,frame).empty(),"late/resynced viewers receive no unknown cancel");
    t.h.leave(1);t.h.leave(2); auto before=t.reads;t.start();t.frame();
    check(t.reads==before,"no grants avoids all material work");
  }
  { Fixture t; t.start(); t.take(); check(t.take(2001000).empty() && stat(t.h,"live_material_tweens")==0,"natural completion releases material claims"); }
  // Only viewers that still know an announcement justify per-frame material observation.
  for (bool resync : {false,true}) {
    Fixture t; t.h.grant(2,ProtocolVersion::V18); t.start(); t.take();
    if (resync) t.h.resync(1); else t.h.leave(1);
    const auto reads=t.reads;
    t.h.observe_materials(3000,t.resolve); auto frame=t.frame(4000);
    check(t.reads==reads && stat(t.h,"live_material_tweens")==0 &&
      stat(t.h,"owned_material_components")==0,"last material observer leave/resync releases claims and reads");
    check(t.h.take(1,frame).empty() && t.h.take(2,frame).empty(),"cleanup never queues unknown cancels");
    t.h.grant(1,ProtocolVersion::V19); t.start();
    check(drop(t.h,"duplicate-id")==0 && t.take(5000).events.size()==1,"cleanup releases tween ID for reuse");
  }
  { Fixture t; t.h.grant(2,ProtocolVersion::V19); t.start(); t.take(); t.h.resync(1);
    t.h.observe_materials(3000,t.resolve);
    check(stat(t.h,"live_material_tweens")==1,"pending material viewer retains observer after another resyncs");
    t.material.params.clear(); t.h.observe_materials(4000,t.resolve); t.material.params["threshold"]={};
    auto record=t.h.take(2,t.frame(5000));
    check(record.empty(),"invalid unsent begin and its cancel suppressed for remaining viewer");
  }
  // A pruned pending generation must neither erase a reused ID nor leak its cancel.
  { Fixture t; t.h.grant(2,ProtocolVersion::V19); t.start(); t.h.cancel(1,1500);
    t.material.params["threshold"].type=VariantType::Vector2;
    t.material.params["threshold"].floats={1,2};
    t.h.begin(begin(1,{step("shader_parameter/threshold",Vector2{3,4})}),2000,t.node,t.resolve);
    auto frame=t.frame(2000); auto a=t.h.take(1,frame), b=t.h.take(2,frame);
    check(a.events.size()==1 && b.events.size()==1 && a.events[0].order==2 &&
      a.events[0].steps[0].type==VariantType::Vector2 && !a.events[0].cancel,
      "pending invalid generation suppresses only its own cancel before reused ID");
    check(drop(t.h,"material-baseline-changed")==1 && stat(t.h,"live_material_tweens")==1,
      "pending generation invalidation counted once without retiring newer ID");
  }
  // Version filtering happens at announcement, before any queue/encoding or parameter reads for old-only grants.
  { Fixture t; t.h.grant(2,ProtocolVersion::V18); t.h.grant(3,ProtocolVersion::V17); t.h.grant(4,ProtocolVersion::V16);
    t.start(); auto frame=t.frame();
    check(t.h.take(2,frame).empty() && t.h.take(3,frame).empty() && t.h.take(4,frame).empty(),"material events absent from older queues");
    t.h.cancel(1,3000);frame=t.frame(4000);
    check(t.h.take(2,frame).empty() && t.h.take(3,frame).empty(),"older viewers have no unknown material cancels");
    const auto state=t.h.state(); const auto &counts=std::get<grc::rs::capture::Value::Object>(state.at("material_events_filtered_by_version").data);
    check(std::get<std::int64_t>(counts.at("render-stream/18").data)==2 &&
      std::get<std::int64_t>(counts.at("render-stream/17").data)==2 && counts.size()==2,"exact filtering counts exclude ungranted /16");
  }
  { Fixture t; t.h.leave(1);t.h.grant(2,ProtocolVersion::V18);t.start();
    check(t.reads==0 && drop(t.h,"material-version")==1 && stat(t.h,"live_tweens")==0,"old-only grant rejects before param reads or live claims");
    t.h.cancel(1,3000);check(drop(t.h,"unknown-cancel")==1,"rejected material never owns an ID");
  }
}
}
int material_tween_tests() {
  run(); std::printf("rs_material_tweens: %d checks, %d failures\n",checks,failures); return failures;
}
