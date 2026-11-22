// Test the production ObjectID-to-published-item resolver and typed getter calls.
#include "rs_tweens_host.h"
#include "rs_mirror.h"
#include "abi.h"
#include "iface.h"
#include <cstdio>
#include <cstring>
#include <limits>

namespace {
struct Node {
  bool canvas = true, control = false, node2d = true;
  std::uint64_t rid = 100;
  grc::Vector2 position{3,4}, scale{-2,0}, pivot{17,23};
  double rotation = 0.5, skew = 0.25;
  grc::Color modulate{1,0.5f,0.25f,0.75f}, self{0.25f,0.5f,1,1};
} node;
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
  else if (!std::strcmp(method,"get_canvas_item")) expected=2944877500LL;
  else if (!std::strcmp(method,"get_modulate") || !std::strcmp(method,"get_self_modulate")) expected=3444240500LL;
  else if (!std::strcmp(method,"get_ticks_usec")) expected=3905245786LL;
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
    ++lookups; return alive && id==42 ? &node : nullptr;
  };
  g_iface.classdb_get_class_tag=[](GDExtensionConstStringNamePtr cls)->void * {
    return const_cast<char *>(name(cls));
  };
  g_iface.object_cast_to=[](GDExtensionConstObjectPtr,void *tag)->GDExtensionObjectPtr {
    const auto cls=static_cast<const char *>(tag);
    const bool yes=(!std::strcmp(cls,"CanvasItem") && node.canvas) ||
      (!std::strcmp(cls,"Control") && node.control) ||
      (!std::strcmp(cls,"Node2D") && node.node2d);
    return yes ? &node : nullptr;
  };
  g_iface.object_method_bind_ptrcall=[](GDExtensionMethodBindPtr bind,GDExtensionObjectPtr,
      const GDExtensionConstTypePtr *,GDExtensionTypePtr out) {
    const auto method=static_cast<const char *>(bind);
    if (!std::strcmp(method,"get_canvas_item")) *static_cast<std::uint64_t *>(out)=node.rid;
    else if (!std::strcmp(method,"get_ticks_usec")) *static_cast<std::int64_t *>(out)=123456;
    else if (!std::strcmp(method,"get_position")) *static_cast<grc::Vector2 *>(out)=node.position;
    else if (!std::strcmp(method,"get_scale")) *static_cast<grc::Vector2 *>(out)=node.scale;
    else if (!std::strcmp(method,"get_pivot_offset")) *static_cast<grc::Vector2 *>(out)=node.pivot;
    else if (!std::strcmp(method,"get_rotation")) *static_cast<double *>(out)=node.rotation;
    else if (!std::strcmp(method,"get_skew")) *static_cast<double *>(out)=node.skew;
    else if (!std::strcmp(method,"get_modulate")) *static_cast<grc::Color *>(out)=node.modulate;
    else if (!std::strcmp(method,"get_self_modulate")) *static_cast<grc::Color *>(out)=node.self;
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
  check(hash_errors==0,"Godot 4.5.1 getter hashes");
  std::printf("rs_tweens_host: %d checks, %d failures\n",checks,failed);
  return failed;
}
