#include "rs_tweens_host.h"
#include "abi.h"
#include "iface.h"
#include "rs_mirror.h"
#include <cmath>

namespace grc::rs::tweens {
namespace {
void *cast(void *node, const char *cls) {
  if (!node || !g_iface.classdb_get_class_tag || !g_iface.object_cast_to) return nullptr;
  StringName name(cls);
  void *tag = g_iface.classdb_get_class_tag(name.ptr());
  return tag ? g_iface.object_cast_to(node, tag) : nullptr;
}
template<class T> bool read(void *node, const char *cls, const char *name, std::int64_t hash, T *out) {
  const auto bind = method_bind(cls,name,hash);
  if (!bind || !g_iface.object_method_bind_ptrcall) return false;
  g_iface.object_method_bind_ptrcall(bind,node,nullptr,out);
  return true;
}
}
std::uint64_t ticks_usec() {
  std::int64_t ticks = 0;
  const auto time = singleton_object("Time");
  if (time) read(time,"Time","get_ticks_usec",3905245786LL,&ticks);
  return static_cast<std::uint64_t>(ticks);
}
std::string resolve_material(std::uint64_t object, Material *out, bool allowed) {
  void *resource = !g_root_finalized && g_iface.object_get_instance_from_id
      ? g_iface.object_get_instance_from_id(object) : nullptr;
  if (!resource) return "unresolved-object";
  if (cast(resource,"CanvasItem")) return "node";
  if (!cast(resource,"ShaderMaterial")) return "unsupported-target";
  if (!allowed) return "material-version";
  std::uint64_t rid = 0;
  if (!read(resource,"Resource","get_rid",2944877500LL,&rid)) return "unpublished-material";
  const auto material = mirror_instance().tween_material(rid,true);
  if (!material) return "unpublished-material";
  *out = *material;
  return !out->published ? "pending-material" : out->supported ? "" : "unsupported-material";
}
std::string resolve_node(std::uint64_t object, Pose *out) {
  void *node = !g_root_finalized && g_iface.object_get_instance_from_id
      ? g_iface.object_get_instance_from_id(object) : nullptr;
  if (!node) return "unresolved-object";
  if (!cast(node,"CanvasItem")) return "non-canvas";
  const bool control = cast(node,"Control") != nullptr;
  if (!control && !cast(node,"Node2D")) return "unsupported-node";
  std::uint64_t rid = 0;
  if (!read(node,"CanvasItem","get_canvas_item",2944877500LL,&rid)) return "unpublished-item";
  const auto item = mirror_instance().published_item_id(rid);
  if (!item && !mirror_instance().knows_item(rid)) return "unpublished-item";
  const char *cls = control ? "Control" : "Node2D";
  grc::Vector2 position{},scale{},pivot{};
  double rotation=0,skew=0;
  grc::Color modulate{},self_modulate{};
  bool ok = read(node,cls,"get_position",3341600327LL,&position) &&
      read(node,cls,"get_scale",3341600327LL,&scale) &&
      read(node,cls,"get_rotation",1740695150LL,&rotation) &&
      read(node,"CanvasItem","get_modulate",3444240500LL,&modulate) &&
      read(node,"CanvasItem","get_self_modulate",3444240500LL,&self_modulate);
  if (control) ok = read(node,cls,"get_pivot_offset",3341600327LL,&pivot) && ok;
  else ok = read(node,cls,"get_skew",1740695150LL,&skew) && ok;
  if (!ok) return "unsupported-node";
  // Failure to read alias context disables only global-position aliases.
  // Baseline sampling and canonical announcements retain their existing behavior.
  out->parent_global = {1,0,0,1,0,0};
  bool top_level=false;
  out->global_position_supported = read(node,"CanvasItem","is_set_as_top_level",36873697LL,&top_level);
  if (out->global_position_supported && !top_level) {
    void *parent=nullptr;
    out->global_position_supported = read(node,"Node","get_parent",3160264692LL,&parent);
    if (out->global_position_supported && cast(parent,"CanvasItem")) {
      grc::Transform2D transform{};
      out->global_position_supported = read(parent,"CanvasItem","get_global_transform",3814499831LL,&transform);
      if (out->global_position_supported) {
        const auto *c=transform.columns;
        out->parent_global = {c[0].x,c[0].y,c[1].x,c[1].y,c[2].x,c[2].y};
      }
    }
  }
  if (control && (rotation != 0 || scale.x != 1 || scale.y != 1))
    out->global_position_supported = false;
  out->item = item; out->kind = control ? Kind::Control : Kind::Node2D;
  out->f = {position.x,position.y,static_cast<float>(rotation),scale.x,scale.y,static_cast<float>(skew),
      pivot.x,pivot.y,modulate.r,modulate.g,modulate.b,modulate.a,
      self_modulate.r,self_modulate.g,self_modulate.b,self_modulate.a};
  for(float f : out->f) if (!std::isfinite(f)) return "invalid-record";
  return item ? "" : "pending-item";
}
}
