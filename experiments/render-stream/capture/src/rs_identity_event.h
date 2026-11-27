#pragma once

#include "iface.h"
#include "rs_identity_digest.h"

#include <functional>
#include <memory>

namespace grc {
// The Callable and StringName are constructed on main, retained through the worker join,
// and released before SCENE deinit. Godot flushes queued callbacks after on_shutdown;
// the digest's terminal latch makes that flush inert.
class IdentityEvent {
 public:
  bool prepare(IdentityDigest &digest, std::function<void()> callback) {
    if (!g_iface.get_proc_address || !g_iface.callable_custom_create2 ||
        !g_iface.get_variant_from_type_constructor || !g_iface.variant_get_ptr_destructor ||
        !g_iface.variant_destroy || !g_iface.classdb_construct_object2 ||
        !g_iface.object_get_instance_id || !g_iface.object_destroy) return false;
    call_ = reinterpret_cast<GDExtensionInterfaceVariantCall>(g_iface.get_proc_address("variant_call"));
    if (!call_) return false;
    digest_ = &digest;
    callback_ = std::move(callback);
    StringName object_class("Object");
    owner_ = g_iface.classdb_construct_object2(object_class.ptr());
    if (!owner_) return false;
    name_ = std::make_unique<StringName>("call_deferred");
    alignas(8) unsigned char callable[16] = {};
    GDExtensionCallableCustomInfo2 info{};
    info.callable_userdata = this;
    info.token = g_iface.library;
    // MessageQueue checks this ObjectID before invoking a custom Callable. Destroying
    // the owner at SCENE deinit also makes an unflushed event safe after module unload.
    info.object_id = g_iface.object_get_instance_id(owner_);
    info.call_func = invoke;
    g_iface.callable_custom_create2(callable, &info);
    g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)(variant_, callable);
    g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)(callable);
    ready_ = true;
    return true;
  }
  void post() {
    alignas(8) unsigned char ret[24] = {};
    GDExtensionCallError error{};
    call_(variant_, name_->ptr(), nullptr, 0, ret, &error);
    g_iface.variant_destroy(ret);
  }
  void clear() {
    if (owner_) g_iface.object_destroy(owner_);
    owner_ = nullptr;
    if (ready_) g_iface.variant_destroy(variant_);
    ready_ = false;
    name_.reset();
    callback_ = {};
  }
 private:
  static void invoke(void *data, const GDExtensionConstVariantPtr *, GDExtensionInt,
                     GDExtensionVariantPtr, GDExtensionCallError *error) {
    if (error) error->error = GDEXTENSION_CALL_OK;
    auto &self = *static_cast<IdentityEvent *>(data);
    if (!self.digest_->stopped() && self.callback_) self.callback_();
  }
  GDExtensionObjectPtr owner_ = nullptr;
  IdentityDigest *digest_ = nullptr;
  std::function<void()> callback_;
  std::unique_ptr<StringName> name_;
  GDExtensionInterfaceVariantCall call_ = nullptr;
  alignas(8) unsigned char variant_[24] = {};
  bool ready_ = false;
};
}  // namespace grc
