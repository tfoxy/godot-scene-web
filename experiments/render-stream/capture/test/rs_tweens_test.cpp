#include "rs_tweens.h"
#include "rs2_codec.h"
#include <cstdio>
#include <fstream>
#include <limits>
#include <iterator>

using namespace grc::rs::tweens;
namespace {
int failures = 0, checks = 0;
void check(bool ok, const char *what) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr,"FAIL: %s\n",what); }
}
Value::Object step(std::string property = "position", Value to = Vector2{100,200}) {
  return {{"property",property},{"to",to},{"start_ms",0},{"duration_ms",1000},
    {"trans","TRANS_LINEAR"},{"ease","EASE_IN_OUT"}};
}
Value::Object begin(std::int64_t id = 1, Value::Array steps = {step()}) {
  return {{"tween_id",id},{"object_id",42},{"steps",std::move(steps)}};
}
std::string meta(const std::vector<std::uint8_t> &bytes) {
  std::uint32_t n = 0;
  for (int i=0;i<4;++i) n |= static_cast<std::uint32_t>(bytes[4+i]) << (8*i);
  return std::string(bytes.begin()+8,bytes.begin()+8+n);
}
std::int64_t stat(const Host &host, const char *key) {
  return std::get<std::int64_t>(host.state().at(key).data);
}
std::uint64_t drop(const Host &h, const char *reason) {
  auto it = h.stats().drops_by_reason.find(reason);
  return it == h.stats().drops_by_reason.end() ? 0 : it->second;
}
void run() {
  using namespace grc::rs2;
  const auto magic17 = magic(static_cast<ProtocolVersion>(15));
  check(magic17[3] == 'H',"/17 has GRSH magic");
  Pose pose; pose.item = 7;
  int lookups = 0;
  std::string resolution;
  Resolve resolve = [&](std::uint64_t object, Pose *p) {
    ++lookups; check(object==42,"ObjectID reaches resolver intact"); *p=pose; return resolution;
  };
  Host h;
  h.begin(begin(),1000,resolve); h.cancel(1,1000); h.snapshot(1000,resolve);
  check(lookups==0 && h.stats().begins_accepted==0,"off does no lookup or counting");
  h.grant(1);
  auto delayed = begin(std::numeric_limits<std::int64_t>::min()); delayed["started_usec"]=1000;
  h.begin(delayed,101000,resolve);
  check(h.stats().begins_accepted==1,"accept delayed begin");
  auto frame = h.snapshot(102000,resolve);
  auto record = h.take(1,frame);
  check(record.events.size()==1 && record.events[0].begin_us==1000 &&
    record.events[0].end_us==1001000,"delayed announcement preserves creation time");
  const auto wire=encode(record,1,10,frame.t_us);
  check(meta(wire).find("\"tween_id\":\"-9223372036854775808\"")!=std::string::npos,"full signed ID string");
  check(meta(wire).find("\"from\":null,\"to\":0")!=std::string::npos,"implicit from offset");
  check(meta(wire).find("\"kind\":\"node2d\",\"f\":2")!=std::string::npos,"pose follows endpoints");
  h.grant(2); check(h.take(2,frame).empty(),"late join has no old begin or pose");
  pose.f[3]=-2; pose.f[4]=0; pose.f[5]=0.25f;
  frame=h.snapshot(200000,resolve); record=h.take(1,frame);
  check(record.events.empty() && record.poses.size()==1 && record.poses[0].f[3]==-2 &&
    record.poses[0].f[4]==0,"resample unowned components including negative/singular scale");
  h.cancel(std::numeric_limits<std::int64_t>::min(),210000);
  frame=h.snapshot(220000,resolve); record=h.take(1,frame);
  check(record.events.size()==1 && record.events[0].cancel && record.poses.size()==1,"cancel final host pose");
  check(h.take(2,frame).empty(),"late join has no old cancel");
  frame=h.snapshot(230000,resolve); check(h.take(1,frame).empty(),"no poses after cancel handover");
  h.begin(begin(),240000,resolve); h.cancel(1,240100);
  frame=h.snapshot(250000,resolve); record=h.take(1,frame);
  check(record.events.size()==2 && !record.events[0].cancel && record.events[1].cancel,"coalesced begin/cancel call order");
  check(record.events[0].begin_us==250000,"omitted start uses snapshot time");
  frame=h.snapshot(260000,resolve); check(h.take(1,frame).empty(),"coalesced cancel does not retain poses");
  // Credit and throttling are modeled by not taking any intermediate snapshots.
  h.begin(begin(2),300000,resolve); frame=h.snapshot(310000,resolve);
  h.begin(begin(3,{step("rotation",2.5)}),320000,resolve);
  frame=h.snapshot(400000,resolve); record=h.take(1,frame);
  check(record.events.size()==2 && record.events[0].begin_us==310000 &&
    record.events[1].begin_us==400000,"credit stalls retain original announcement frames");
  check(record.events[0].order<record.events[1].order,"host precedence retained");
  h.begin(begin(4,{step("position:x",20)}),410000,resolve);
  check(h.stats().claims_replaced==1,"component replacement counted once across viewers");
  h.begin(begin(4),410000,resolve); check(drop(h,"duplicate-id")==1,"duplicate live id rejected");
  h.resync(1); frame=h.snapshot(420000,resolve); check(h.take(1,frame).empty(),"resync clears playback without replay");
  h.leave(1); h.leave(2); int previous=lookups;
  h.snapshot(430000,resolve); h.begin(begin(),430000,resolve);
  check(lookups==previous && stat(h,"live_tweens")==0,"last viewer discards work");
  h.reset(); h.grant(1);
  const char *trans[]={"Linear","Sine","Quint","Quart","Quad","Expo","Elastic","Cubic","Circ","Bounce","Back","Spring"};
  const char *ease[]={"In","Out","In_Out","Out_In"};
  for (int t=0;t<12;++t) for(int e=0;e<4;++e) {
    auto s=step(); s["trans"]=trans[t]; s["ease"]=ease[e];
    auto b=begin(1,{s}); h.begin(b,500000,resolve);
    record=h.take(1,h.snapshot(500000,resolve));
    check(record.events.size()==1 && record.events[0].steps[0].trans==t &&
      record.events[0].steps[0].ease==e,"every enum name pair");
    h.cancel(1,500001); h.take(1,h.snapshot(500002,resolve));
    s["trans"]=t; s["ease"]=e; h.begin(begin(1,{s}),500003,resolve);
    record=h.take(1,h.snapshot(500003,resolve));
    check(record.events.size()==1 && record.events[0].steps[0].trans==t &&
      record.events[0].steps[0].ease==e,"every enum integer pair");
    h.cancel(1,500004); h.take(1,h.snapshot(500005,resolve));
  }
  for (Kind kind : {Kind::Node2D,Kind::Control}) {
    pose.kind=kind;
    const char *names[]={"position","position:x","position:y","rotation","scale","scale:x","scale:y","skew",
      "modulate","modulate:r","modulate:g","modulate:b","modulate:a",
      "self_modulate","self_modulate:r","self_modulate:g","self_modulate:b","self_modulate:a"};
    for (const char *name : names) {
      const std::string n=name;
      Value to=1.5;
      if (n=="position"||n=="scale") to=Vector2{1,2};
      if (n=="modulate"||n=="self_modulate") to=Color{1,0.5,2,-1};
      auto s=step(n,to); s["from"]=to;
      const auto accepted=h.stats().begins_accepted;
      h.begin(begin(1,{s}),600000,resolve);
      const bool supported=kind!=Kind::Control||n!="skew";
      check(h.stats().begins_accepted==accepted+(supported?1:0),"property support on each node kind");
      if(supported) { record=h.take(1,h.snapshot(600000,resolve));
        check(record.events[0].steps[0].from.has_value(),"explicit from preserved");
        h.cancel(1,600001); h.take(1,h.snapshot(600002,resolve)); }
    }
  }
  h.reset(); h.grant(1); pose.kind=Kind::Node2D;
  auto bad=step(); bad["property"]="position:a"; bad["to"]=false; bad["trans"]=-1;
  h.begin(begin(1,{bad,step()}),700000,resolve);
  check(drop(h,"unsupported-property")==1 && h.stats().steps_accepted==1,"first drop reason and partial acceptance");
  h.cancel(1,700001); h.take(1,h.snapshot(700002,resolve));
  const char *reasons[]={"invalid-step","unsupported-property","invalid-value","invalid-timing","invalid-easing"};
  for(int i=0;i<5;++i) {
    auto s=step();
    if(i==0)s["extra"]=1;
    if(i==1)s["property"]="rotation_degrees";
    if(i==2)s["to"]=Value::Array{1,2};
    if(i==3)s["duration_ms"]=-1;
    if(i==4)s["ease"]="unknown";
    auto before=drop(h,reasons[i]); h.begin(begin(1,{s}),710000,resolve);
    check(drop(h,reasons[i])==before+1,"each step drop reason");
  }
  auto s=step("rotation",std::numeric_limits<double>::infinity());
  h.begin(begin(1,{s}),720000,resolve); check(drop(h,"invalid-value")==2,"nonfinite endpoint rejected");
  s=step("rotation",std::numeric_limits<double>::max());
  h.begin(begin(1,{s}),720000,resolve); check(drop(h,"invalid-value")==3,"f32 overflow rejected");
  s=step(); s["start_ms"]=0.0005; s["duration_ms"]=0;
  h.begin(begin(1,{s}),730000,resolve); record=h.take(1,h.snapshot(730000,resolve));
  check(record.events[0].steps[0].start_us==1 && record.events[0].steps[0].duration_us==0,"microsecond rounding ties upward and zero duration");
  h.begin(begin(1),730002,resolve); check(h.stats().begins_accepted==3,"reuse after end");
  h.cancel(1,730003); h.take(1,h.snapshot(730004,resolve));
  for(const char *reason : {"unresolved-object","non-canvas","unsupported-node","unpublished-item"}) {
    resolution=reason; h.begin(begin(),740000,resolve); check(drop(h,reason)==1,"resolution failure counted");
  }
  resolution.clear(); h.begin(begin(),750000,resolve); resolution="unresolved-object";
  record=h.take(1,h.snapshot(760000,resolve));
  check(record.empty() && drop(h,"target-gone")==1,"freed target retires pending begin without pose");
  resolution.clear(); h.cancel(1,760001); check(drop(h,"unknown-cancel")==1,"unknown cancel counted");
  h.reset(); check(h.stats().begins_accepted==0 && !h.on(),"armed session reset");
  h.grant(1); h.begin(begin(),770000,resolve);
  const auto reads=lookups;
  h.announce_frame(780000); h.announce_frame(790000);
  check(lookups==reads,"skipped capture frames finalize starts without getter reads");
  record=h.take(1,h.snapshot(795000,resolve));
  check(record.events.size()==1 && record.events[0].begin_us==780000,
    "credit/rate gating does not move the original announcing timestamp");
  h.reset();
  // A held old snapshot must still carry its begin's pose after that ID was reused.
  h.grant(1); pose.kind=Kind::Control; pose.f[6]=17; pose.f[7]=23;
  auto first=begin(9); first["started_usec"]=800000;
  h.begin(first,800000,resolve);
  const auto stale=h.snapshot(810000,resolve);
  h.cancel(9,820000);
  auto reused=begin(9); reused["started_usec"]=830000;
  h.begin(reused,830000,resolve);
  const auto latest=h.snapshot(840000,resolve);
  record=h.take(1,stale);
  check(record.events.size()==1 && record.events[0].begin_us==800000 &&
    record.poses.size()==1,"stale begin retains pose across ID reuse");
  record=h.take(1,latest);
  check(record.events.size()==2 && record.events[0].cancel &&
    record.events[1].begin_us==830000,"new events wait for their announcing snapshot");
  check(record.poses.size()==1 && record.poses[0].f[6]==17 && record.poses[0].f[7]==23,
    "Control pivot components survive snapshot");
  h.reset();
  // Reject malformed producer input before touching engine objects or accepting any step.
  h.grant(1);
  const auto invalid_record = [&](Value value) {
    const auto before = drop(h,"invalid-record");
    const auto reads = lookups;
    h.begin(value,900000,resolve);
    check(drop(h,"invalid-record")==before+1 && lookups==reads,
      "invalid outer record rejected before ObjectID lookup");
  };
  invalid_record(Value{});
  auto invalid = begin(); invalid["extra"]=1; invalid_record(invalid);
  invalid=begin(); invalid.erase("steps"); invalid_record(invalid);
  invalid=begin(); invalid["steps"]=false; invalid_record(invalid);
  invalid=begin(); invalid["tween_id"]=1.0; invalid_record(invalid);
  invalid=begin(); invalid["object_id"]=0; invalid_record(invalid);
  invalid=begin(); invalid["started_usec"]=-1; invalid_record(invalid);
  invalid=begin(); invalid["started_usec"]=900001; invalid_record(invalid);
  invalid=begin(); invalid["started_usec"]=900000.0; invalid_record(invalid);
  auto overflow=step(); overflow["start_ms"]=9007199254740.0; overflow["duration_ms"]=1000;
  const auto timing_before=drop(h,"invalid-timing");
  h.begin(begin(1,{overflow}),900000,resolve);
  check(drop(h,"invalid-timing")==timing_before+1,"timing sums cannot overflow exact JSON integers");
  auto empty_before=drop(h,"empty-steps");
  h.begin(begin(1,{}),900000,resolve);
  check(drop(h,"empty-steps")==empty_before+1,"empty producer schedule rejected");
  const auto cancel_before=drop(h,"unknown-cancel");
  h.cancel(true,900000); h.cancel(1.0,900000);
  check(drop(h,"unknown-cancel")==cancel_before+2,"malformed cancel IDs counted");
  pose=Pose(); pose.item=7;
  const auto max_id=std::numeric_limits<std::int64_t>::max();
  auto short_step=step("rotation",1.0); short_step["duration_ms"]=1;
  h.begin(begin(max_id,{short_step}),900000,resolve);
  record=h.take(1,h.snapshot(900000,resolve));
  check(meta(encode(record,1,1,900000)).find("\"tween_id\":\"9223372036854775807\"")!=std::string::npos,
    "positive signed ID beyond JS precision preserved");
  pose.f[2]=3.5f;
  record=h.take(1,h.snapshot(901000,resolve));
  check(record.events.empty() && record.poses.size()==1 && record.poses[0].f[2]==3.5f &&
    stat(h,"live_tweens")==0,"natural end sends final host baseline and expires announcement");
  const auto final_reads=lookups;
  record=h.take(1,h.snapshot(902000,resolve));
  check(record.empty() && lookups==final_reads,"natural end leaves no per-item getter work");
  h.reset();
  // A delayed begin must survive publication of a saved pre-announcement picture.
  h.grant(1); pose=Pose(); pose.item=7;
  const auto pre_announcement=h.snapshot(300000,resolve);
  auto expired_begin=begin(1,{step("rotation",1.0)});
  expired_begin["started_usec"]=100000;
  auto &expired_steps=std::get<Value::Array>(expired_begin["steps"].data);
  std::get<Value::Object>(expired_steps[0].data)["duration_ms"]=100;
  h.begin(expired_begin,500000,resolve);
  record=h.take(1,pre_announcement);
  check(record.empty(),"F2 old picture leaves later expired begin pending");
  record=h.take(1,h.snapshot(600000,resolve));
  check(record.events.size()==1 && record.poses.size()==1,
    "F2 queued expired begin retains its mandatory same-record pose");
  check(h.take(1,h.snapshot(700000,resolve)).empty(),"F2 tracking retires after begin and pose delivery");
  h.reset(); h.grant(1); h.grant(2);
  auto near_limit=step("rotation",1.0); near_limit["duration_ms"]=9007199254740.0;
  h.begin(begin(1,{near_limit}),1,resolve);
  h.announce_frame(2000);
  record=h.take(1,h.snapshot(2000,resolve));
  check(record.empty(),"F3 implicit-start overflow emits no malformed begin or pose");
  check(h.take(2,h.snapshot(2000,resolve)).empty(),"F3 overflow removed from every viewer queue");
  check(stat(h,"live_tweens")==0 && stat(h,"owned_components")==0,
    "F3 overflow removed from live and claims");
  check(drop(h,"invalid-timing")==1 && drop(h,"empty-steps")==1,
    "F3 overflow counted once independent of viewer count");
  h.begin(begin(1,{near_limit,step("position:x",2.0)}),1,resolve);
  h.announce_frame(2000);
  record=h.take(1,h.snapshot(2000,resolve));
  check(record.events.size()==1 && record.events[0].steps.size()==1 &&
    record.events[0].steps[0].property=="position:x" && record.events[0].end_us==1002000,
    "F3 finalization retains valid steps and recomputes end");
  check(stat(h,"owned_components")==1,"F3 dropped step does not retain rotation claim");
  h.reset();
  // Independent Python golden bytes pin canonical metadata, offsets and LE f32 framing.
#ifdef GRC_GOLDEN17_DIR
  h.grant(1); pose=Pose(); pose.item=7;
  auto b=begin(std::numeric_limits<std::int64_t>::min(),{step("position",Vector2{100,200})});
  b["started_usec"]=1000;
  h.begin(b,101000,resolve); record=h.take(1,h.snapshot(102000,resolve));
  std::ifstream file(std::string(GRC_GOLDEN17_DIR)+"/begin.record",std::ios::binary);
  std::vector<std::uint8_t> golden((std::istreambuf_iterator<char>(file)),{});
  check(encode(record,1,10,102000)==golden,"begin golden byte identity");
  Record poses; poses.poses=record.poses;
  std::ifstream poses_file(std::string(GRC_GOLDEN17_DIR)+"/poses.record",std::ios::binary);
  golden.assign(std::istreambuf_iterator<char>(poses_file),{});
  check(encode(poses,2,11,103000)==golden,"pose-only golden byte identity");
  Record cancel; Event cancelled; cancelled.cancel=true;
  cancelled.id=std::numeric_limits<std::int64_t>::min(); cancel.events.push_back(cancelled);
  std::ifstream cancel_file(std::string(GRC_GOLDEN17_DIR)+"/cancel-removed.record",std::ios::binary);
  golden.assign(std::istreambuf_iterator<char>(cancel_file),{});
  check(encode(cancel,2,11,103000)==golden,"cancel-only golden byte identity");
#endif
}
}
int tween_host_tests();
int main() { failures += tween_host_tests(); run(); std::printf("rs_tweens: %d checks, %d failures\n",checks,failures); return failures?1:0; }
