// Test the production ObjectID-to-published-item resolver and typed getter calls.
#include "rs_tweens_host.h"
#include "rs_mirror.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "abi.h"
#include "iface.h"
#include <cstdio>
#include <cstring>
#include <limits>

namespace {
struct Node {
  bool canvas = true, control = false, node2d = true, shader_material = false;
  bool top_level = false;
  Node *parent = nullptr;
  grc::Transform2D global{{{0,2},{-4,0},{10,20}}};
  std::uint64_t rid = 100;
  grc::Vector2 position{3,4}, scale{-2,0}, pivot{17,23};
  double rotation = 0.5, skew = 0.25;
  grc::Color modulate{1,0.5f,0.25f,0.75f}, self{0.25f,0.5f,1,1};
} node;
Node resource, cloned_resource;
int resource_reads = 0;
bool alive = true;
int lookups = 0, hash_errors = 0;
const char *name(GDExtensionConstStringNamePtr p) {
  return *static_cast<const char *const *>(p);
}
}
// Only engine entry points are doubled; the resolver and the mirror are production code.
namespace grc {
Iface g_iface;
bool g_root_finalized = false;
StringName::StringName(const char *text) {
  opaque_ = const_cast<char *>(text);
  valid_ = true;
}
StringName::~StringName() {
  if (valid_) opaque_ = nullptr;
}
GDExtensionMethodBindPtr method_bind(const char *, const char *method, std::int64_t hash) {
  std::int64_t expected = 3341600327LL;
  if (!std::strcmp(method,"get_rotation") || !std::strcmp(method,"get_skew")) expected=1740695150LL;
  else if (!std::strcmp(method,"get_canvas_item") || !std::strcmp(method,"get_rid")) expected=2944877500LL;
  else if (!std::strcmp(method,"get_modulate") || !std::strcmp(method,"get_self_modulate")) expected=3444240500LL;
  else if (!std::strcmp(method,"get_ticks_usec")) expected=3905245786LL;
  else if (!std::strcmp(method,"get_parent")) expected=3160264692LL;
  else if (!std::strcmp(method,"is_set_as_top_level")) expected=36873697LL;
  else if (!std::strcmp(method,"get_global_transform")) expected=3814499831LL;
  if (hash != expected) ++hash_errors;
  return const_cast<char *>(method);
}
void *singleton_object(const char *) { return &node; }
}
int tween_host_tests() {
  using namespace grc;
  using namespace grc::rs;
  int failed=0, checks=0;
  const auto check=[&](bool ok,const char *what) {
    ++checks;
    if (!ok) { ++failed; std::printf("FAIL tween host: %s\n",what); }
  };
  g_iface.object_get_instance_from_id=[](GDObjectInstanceID id)->GDExtensionObjectPtr {
    ++lookups;
    if (!alive) return nullptr;
    return id == 42 ? &node : id == 84 ? &resource : id == 85 ? &cloned_resource : nullptr;
  };
  g_iface.classdb_get_class_tag=[](GDExtensionConstStringNamePtr cls)->void * {
    return const_cast<char *>(name(cls));
  };
  g_iface.object_cast_to=[](GDExtensionConstObjectPtr object,void *tag)->GDExtensionObjectPtr {
    const auto &target=*static_cast<const Node *>(object);
    const auto cls=static_cast<const char *>(tag);
    const bool yes=(!std::strcmp(cls,"CanvasItem") && target.canvas) ||
      (!std::strcmp(cls,"Control") && target.control) ||
      (!std::strcmp(cls,"Node2D") && target.node2d) ||
      (!std::strcmp(cls,"ShaderMaterial") && target.shader_material);
    return yes ? const_cast<Node *>(&target) : nullptr;
  };
  g_iface.object_method_bind_ptrcall=[](GDExtensionMethodBindPtr bind,GDExtensionObjectPtr object,
      const GDExtensionConstTypePtr *,GDExtensionTypePtr out) {
    const auto &target=*static_cast<const Node *>(object);
    const auto method=static_cast<const char *>(bind);
    if (!std::strcmp(method,"get_rid")) { ++resource_reads; *static_cast<std::uint64_t *>(out)=static_cast<Node *>(object)->rid; return; }
    if (!std::strcmp(method,"get_canvas_item")) *static_cast<std::uint64_t *>(out)=target.rid;
    else if (!std::strcmp(method,"get_parent")) *static_cast<void **>(out)=target.parent;
    else if (!std::strcmp(method,"is_set_as_top_level")) *static_cast<bool *>(out)=target.top_level;
    else if (!std::strcmp(method,"get_global_transform")) *static_cast<grc::Transform2D *>(out)=target.global;
    else if (!std::strcmp(method,"get_ticks_usec")) *static_cast<std::int64_t *>(out)=123456;
    else if (!std::strcmp(method,"get_position")) *static_cast<grc::Vector2 *>(out)=target.position;
    else if (!std::strcmp(method,"get_scale")) *static_cast<grc::Vector2 *>(out)=target.scale;
    else if (!std::strcmp(method,"get_pivot_offset")) *static_cast<grc::Vector2 *>(out)=target.pivot;
    else if (!std::strcmp(method,"get_rotation")) *static_cast<double *>(out)=target.rotation;
    else if (!std::strcmp(method,"get_skew")) *static_cast<double *>(out)=target.skew;
    else if (!std::strcmp(method,"get_modulate")) *static_cast<grc::Color *>(out)=target.modulate;
    else if (!std::strcmp(method,"get_self_modulate")) *static_cast<grc::Color *>(out)=target.self;
  };
  auto &mirror=mirror_instance();
  mirror.reset(); mirror.set_root(1,2,grc::rs2::kIdentityXform);
  mirror.canvas_item_create(100,1); mirror.set_parent(100,2,1); mirror.snapshot(1,1);
  tweens::Pose p;
  check(tweens::ticks_usec()==123456,"timestamp uses Time.get_ticks_usec");
  check(tweens::resolve_node(42,&p).empty() && p.item==1,"ObjectID resolves to published mirror item");
  check(p.kind==tweens::Kind::Node2D && p.f[0]==3 && p.f[1]==4 && p.f[2]==0.5f &&
    p.f[3]==-2 && p.f[4]==0 && p.f[5]==0.25f && p.f[6]==0 && p.f[7]==0,
    "Node2D pose preserves rotation, signed/singular scale and skew");
  check(p.f[9]==0.5f && p.f[11]==0.75f && p.f[12]==0.25f,"both colors use node getters");
  node.control=true; node.node2d=false;
  check(tweens::resolve_node(42,&p).empty() && p.kind==tweens::Kind::Control &&
    p.f[5]==0 && p.f[6]==17 && p.f[7]==23,"Control pose carries pivot and zero skew");
  node.position.x=31; node.pivot.x=37;
  check(tweens::resolve_node(42,&p).empty() && p.f[0]==31 && p.f[6]==37,"unowned components resampled");
  node.rotation=0; node.scale={1,1};
  Node parent; node.parent=&parent;
  for(bool control : {false,true}) {
    node.control=control; node.node2d=!control;
    check(tweens::resolve_node(42,&p).empty() && p.global_position_supported &&
      p.parent_global==std::array<double,6>{0,2,-4,0,10,20},
      "parent global transform read for Node2D and Control aliases");
    node.top_level=true;
    check(tweens::resolve_node(42,&p).empty() && p.global_position_supported &&
      p.parent_global==std::array<double,6>{1,0,0,1,0,0},"top-level alias context is identity");
    node.top_level=false; parent.canvas=false;
    check(tweens::resolve_node(42,&p).empty() && p.global_position_supported &&
      p.parent_global==std::array<double,6>{1,0,0,1,0,0},"non-CanvasItem parent is identity");
    parent.canvas=true;
  }
  node.rotation=0.000000000001;
  check(tweens::resolve_node(42,&p).empty() && !p.global_position_supported,
    "Control exact nonzero rotation disables global aliases before float rounding");
  node.rotation=0; node.scale={2,1};
  check(tweens::resolve_node(42,&p).empty() && !p.global_position_supported,
    "Control nonidentity scale disables global aliases");
  node.scale={1,1}; node.parent=nullptr;
  node.rid=101; check(tweens::resolve_node(42,&p)=="unpublished-item","unpublished target refused"); node.rid=100;
  node.canvas=false; check(tweens::resolve_node(42,&p)=="non-canvas","non-canvas target refused"); node.canvas=true;
  node.control=false; check(tweens::resolve_node(42,&p)=="unsupported-node","unsupported CanvasItem refused");
  node.node2d=true; alive=false;
  check(tweens::resolve_node(42,&p)=="unresolved-object","freed target refused"); alive=true;
  g_root_finalized=true; const auto before=lookups;
  check(tweens::resolve_node(42,&p)=="unresolved-object" && lookups==before,"root finalization prevents engine lookup");
  g_root_finalized=false;
  node.rotation=std::numeric_limits<double>::infinity();
  check(tweens::resolve_node(42,&p)=="invalid-record","nonfinite baseline refused");
  node.rotation=0;
  resource.canvas=false; resource.node2d=false; resource.shader_material=true; resource.rid=700;
  cloned_resource=resource; cloned_resource.rid=701;
  tweens::Material material;
  const auto reads=resource_reads;
  check(tweens::resolve_material(84,&material,false)=="material-version" && resource_reads==reads,
    "old-only grants classify resource before RID or param reads");
  check(tweens::resolve_material(42,&material,true)=="node","material classifier preserves CanvasItem resolver chain");
  check(tweens::resolve_material(84,&material,true)=="unpublished-material","unpublished material rejected");
  const auto setup=[&]() {
    mirror.reset(); mirror.set_root(1,2,grc::rs2::kIdentityXform);
    mirror.snapshot(0,0);
    mirror.canvas_item_create(100,1); mirror.set_parent(100,2,1);
    mirror.canvas_item_create(101,1); mirror.set_parent(101,100,1); mirror.set_use_parent_material(101,true,1);
    ShaderCodeInput shader; shader.copy.status="ok"; shader.copy.mode="canvas_item";
    mirror.shader_create_from_code(800,shader,1);
    mirror.material_create_from_shader(700,800,1); mirror.material_create_from_shader(701,800,1);
    DecodedParam param; param.type="float"; param.n=1; param.f={1.0};
    mirror.material_set_param(700,"threshold",param,1); mirror.material_set_param(701,"threshold",param,1);
    mirror.set_material(100,700,1);
  };
  setup();
  check(!mirror.tween_material(700),"RID is not published before scene snapshot");
  mirror.snapshot(1,1);
  const auto before_stats=mirror.stats();
  check(tweens::resolve_material(84,&material,true).empty() && material.id==1 &&
    material.params.at("threshold").type==grc::rs2::VariantType::Float,"direct ShaderMaterial ObjectID RID id and hook params");
  mirror.snapshot(2,2);
  check(mirror.stats().hc_resources_visited==before_stats.hc_resources_visited,
    "param snapshot accessor does not mark mirror dirty");
  tweens::Host host; host.grant(1,grc::rs2::ProtocolVersion::V19);
  const tweens::Value::Object announcement={{"tween_id",1},{"object_id",84},{"started_usec",1000},
    {"steps",tweens::Value::Array{tweens::Value::Object{{"property","shader_parameter/threshold"},{"to",0.0},
      {"start_ms",0},{"duration_ms",2000},{"trans",0},{"ease",0}}}}};
  host.begin(announcement,1000,tweens::resolve_node,tweens::resolve_material);
  auto frame=host.snapshot(2000,tweens::resolve_node,tweens::resolve_material);
  const auto record=host.take(1,frame);
  check(record.events.size()==1 && record.events[0].material==1 && record.poses.empty(),
    "production resource begin addresses shared/inherited users by material alone");
  mirror.set_material(100,701,3); mirror.snapshot(3,3);
  frame=host.snapshot(3000,tweens::resolve_node,tweens::resolve_material);
  check(host.take(1,frame).empty() && host.state().count("live_material_tweens") &&
    std::get<std::int64_t>(host.state().at("live_material_tweens").data)==1,
    "item reassignment does not transfer or retire old resource claims");
  const auto original=mirror.tween_material(700), independent=mirror.tween_material(701);
  check(original && independent && original->id!=independent->id && independent->params.at("threshold").floats[0]==1,
    "distinct local-to-scene resource identities retain independent values");
  mirror.free_rid(700,4);
  host.observe_materials(4000,tweens::resolve_material);
  const auto freed=host.take(1,host.snapshot(4000,tweens::resolve_node,tweens::resolve_material));
  check(freed.events.size()==1 && freed.events[0].cancel,"free retires production resource and queues cancel");
  // Recycled native RIDs acquire a fresh stream ID; no old material ownership transfers.
  const auto old_id=material.id;
  mirror.material_create_from_shader(700,800,5);
  DecodedParam restored; restored.type="float"; restored.n=1; restored.f={0.75};
  mirror.material_set_param(700,"threshold",restored,5); mirror.set_material(100,700,5); mirror.snapshot(5,5);
  check(tweens::resolve_material(84,&material,true).empty() && material.id!=old_id,
    "recycled material RID receives a fresh stream identity");
  check(host.take(1,host.snapshot(5000,tweens::resolve_node,tweens::resolve_material)).empty(),
    "recycled material has no inherited tween ownership");
  // /12+ converts plain numeric Arrays to packed params. Expose that exact table to the host.
  setup(); mirror.snapshot(1,1);
  auto options=mirror.particles_options(); options.param_arrays=true; mirror.set_particles(options);
  DecodedParam array; array.type="array"; array.array_form=true;
  array.array_type="float64"; array.array_n=2; array.array_f={1,2};
  mirror.material_set_param(700,"threshold",array,2); mirror.snapshot(2,2);
  check(tweens::resolve_material(84,&material,true).empty() &&
    material.params.at("threshold").type==grc::rs2::VariantType::PackedFloat64Array,
    "material accessor retains resolved packed form of explicit Array");
  tweens::Host arrays; arrays.grant(1,grc::rs2::ProtocolVersion::V19);
  arrays.begin(announcement,1000,tweens::resolve_node,tweens::resolve_material);
  check(arrays.stats().drops_by_reason.count("material-param-type")==1 &&
    !arrays.stats().drops_by_reason.count("missing-material-param"),"plain Array rejects as param type rather than unset");
  // The complete transaction bytes, including material params and f64 payloads, stay equal.
  const auto capture=[&](bool announced) {
    setup();
    tweens::Host h; h.grant(1,grc::rs2::ProtocolVersion::V19);
    auto base=mirror.snapshot(1,1).state;
    if (announced) h.begin(announcement,1000,tweens::resolve_node,tweens::resolve_material);
    auto initial=h.snapshot(1000,tweens::resolve_node,tweens::resolve_material); h.take(1,initial);
    auto unchanged=mirror.snapshot(2,2).state;
    grc::rs2::TxMeta meta; meta.version=grc::rs2::ProtocolVersion::V19; meta.seq=2;meta.frame=2;meta.base_seq=1;
    check(grc::rs2::make_patch(base,unchanged,meta).materials.empty(),"unchanged baseline omitted from patch");
    std::vector<std::vector<std::uint8_t>> bytes;
    for(int i=3;i<8;++i) {
      DecodedParam param;param.type="float";param.n=1;param.f={1.0-static_cast<double>(i)/10};
      mirror.material_set_param(700,"threshold",param,i);
      auto current=mirror.snapshot(i,i).state;
      auto tween_frame=h.snapshot(i*1000,tweens::resolve_node,tweens::resolve_material); h.take(1,tween_frame);
      meta.seq=i;meta.frame=i;meta.base_seq=i-1;
      auto tx=grc::rs2::make_patch(base,current,meta);
      check(tx.materials.size()==1 && tx.materials[0].params[0].floats[0]==param.f[0],"every host frame still publishes claimed param");
      bytes.push_back(grc::rs2::encode_transaction(tx));base=current;
    }
    return bytes;
  };
  check(capture(false)==capture(true),"announced and ordinary per-frame material transactions byte-identical");
  // Announcements made before the mirror's next publication are bounded to that snapshot.
  const tweens::Value::Object node_announcement={{"tween_id",2},{"object_id",42},{"started_usec",1000},
    {"steps",tweens::Value::Array{tweens::Value::Object{{"property","position:x"},{"to",90.0},
      {"start_ms",0},{"duration_ms",2000},{"trans",0},{"ease",0}}}}};
  setup(); mirror.snapshot(1,1);
  node.rid=102; mirror.canvas_item_create(102,2); mirror.set_parent(102,2,2);
  tweens::Host ordered; ordered.grant(1,grc::rs2::ProtocolVersion::V19);
  ordered.begin(node_announcement,1000,tweens::resolve_node,tweens::resolve_material);
  ordered.begin(announcement,1500,tweens::resolve_node,tweens::resolve_material);
  mirror.snapshot(2,2);
  const auto interleaved=ordered.take(1,ordered.snapshot(2000,tweens::resolve_node,tweens::resolve_material));
  check(interleaved.events.size()==2 && interleaved.events[0].id==2 && interleaved.events[0].order==1 &&
    interleaved.events[1].id==1 && interleaved.events[1].order==2,
    "deferred and published targets retain original API call order");
  node.rid=100;
  for (bool material_target : {false,true}) {
    const auto &value=material_target ? announcement : node_announcement;
    const auto record_for=[&](bool published) {
      setup(); if (published) mirror.snapshot(1,1);
      tweens::Host h; h.grant(1,grc::rs2::ProtocolVersion::V19);
      h.begin(value,1000,tweens::resolve_node,tweens::resolve_material);
      node.position.x=47;
      mirror.snapshot(2,2);
      return h.take(1,h.snapshot(2000,tweens::resolve_node,tweens::resolve_material));
    };
    const auto deferred=record_for(false), ordinary=record_for(true);
    check(deferred.events.size()==1 && deferred.events[0].begin_us==1000 && deferred.events[0].order==1,
      material_target ? "creation-frame material begin reaches next transaction" : "creation-frame node begin reaches next transaction");
    check(tweens::encode(deferred,2,2,2000)==tweens::encode(ordinary,2,2,2000),
      "deferred and published targets produce byte-identical records and snapshot baselines");
    if (!material_target) check(deferred.poses.size()==1 && deferred.poses[0].f[0]==47,
      "creation-frame node baseline sampled at publication snapshot");
    for (bool resync : {false,true}) {
      setup(); tweens::Host h; h.grant(1,grc::rs2::ProtocolVersion::V19);
      h.begin(value,1000,tweens::resolve_node,tweens::resolve_material);
      h.begin(value,1001,tweens::resolve_node,tweens::resolve_material);
      check(h.stats().drops_by_reason.count("duplicate-id")==1,"pending begin reserves its tween ID");
      h.grant(2,grc::rs2::ProtocolVersion::V19);
      if (resync) h.resync(1);
      mirror.snapshot(2,2);
      const auto f=h.snapshot(2000,tweens::resolve_node,tweens::resolve_material);
      check(h.take(2,f).empty(),"late viewer never receives deferred publication begin");
      check(h.take(1,f).events.size()==(resync ? 0u : 1u),"resync clears pending publication eligibility");
    }
    for (int mode=0;mode<3;++mode) {
      setup(); tweens::Host h; h.grant(1,grc::rs2::ProtocolVersion::V19);
      h.begin(value,1000,tweens::resolve_node,tweens::resolve_material);
      if (mode==0) alive=false;
      if (mode==2) h.cancel(material_target ? 1 : 2,1500);
      const auto f=h.snapshot(2000,tweens::resolve_node,tweens::resolve_material);
      alive=true;
      check(h.take(1,f).empty(),"freed, unpublished or cancelled pending begin emits no event");
      const auto &drops=h.stats().drops_by_reason;
      const char *reason=mode==0 ? "target-gone" : material_target ? "unpublished-material" : "unpublished-item";
      check(mode==2 ? h.stats().cancels_accepted==1 && drops.empty() : drops.count(reason)==1,
        "pending begin has one bounded resolution or silent accepted cancellation");
      mirror.snapshot(3,3);
      check(h.take(1,h.snapshot(3000,tweens::resolve_node,tweens::resolve_material)).empty(),
        "pending publication is never polled or retried after one snapshot");
    }
  }
  mirror.reset();
  check(hash_errors==0,"Godot 4.5.1 getter hashes");
  std::printf("rs_tweens_host: %d checks, %d failures\n",checks,failed);
  return failed;
}
