// rs_net_module.cpp -- see rs_net_module.h (carrier-design.md D8, CAR3).
#include "rs_net_module.h"

#include <dlfcn.h>

#include <cstddef>
#include <cstring>
#include <mutex>

namespace grc {
namespace live {

namespace {

constexpr const char *kModuleFile = "librender_stream_net.so";

std::string dir_of(const std::string &path) {
  const std::size_t slash = path.rfind('/');
  return slash == std::string::npos ? std::string(".") : path.substr(0, slash);
}

struct Loaded {
  bool tried = false;
  const grc_net_module_table_v1 *module = nullptr;
  std::string error;
  std::string path;
};

Loaded &loaded() {
  static Loaded l;
  return l;
}

std::mutex &load_mu() {
  static std::mutex mu;
  return mu;
}

}  // namespace

std::string default_net_module_path() {
  Dl_info info{};
  if (dladdr(reinterpret_cast<void *>(&default_net_module_path), &info) == 0 ||
      info.dli_fname == nullptr || info.dli_fname[0] == '\0') {
    return kModuleFile;
  }
  return dir_of(info.dli_fname) + "/" + kModuleFile;
}

const grc_net_module_table_v1 *load_net_module_at(const std::string &path, std::string *error) {
  // D8: never dlclose()d, so a carrier thread can never outlive its code.
  void *handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) {
    const char *why = dlerror();
    *error = "net-module-missing: cannot load " + path + " (" +
             (why != nullptr ? why : "dlopen failed") +
             "); build it with scripts/build-rs-net.sh or set GRC_LIVE_NET_MODULE";
    return nullptr;
  }
  dlerror();
  void *entry = dlsym(handle, GRC_NET_MODULE_ENTRY);
  if (entry == nullptr) {
    *error = "net-module-abi: " + path + " has no " + GRC_NET_MODULE_ENTRY;
    return nullptr;
  }
  const grc_net_module_table_v1 *m = reinterpret_cast<grc_net_module_table_v1_fn>(entry)();
  if (m == nullptr || m->abi_version != GRC_NET_MODULE_ABI_VERSION ||
      m->size < sizeof(grc_net_module_table_v1)) {
    *error = "net-module-abi: " + path + "'s module table is not version " +
             std::to_string(GRC_NET_MODULE_ABI_VERSION);
    return nullptr;
  }
  if (m->carrier_abi_version != GRC_CARRIER_ABI_VERSION || m->wt_create == nullptr ||
      m->wt_info == nullptr) {
    *error = "net-module-abi: " + path + " implements carrier ABI " +
             std::to_string(m->carrier_abi_version) + ", not " +
             std::to_string(GRC_CARRIER_ABI_VERSION);
    return nullptr;
  }
  return m;
}

const grc_net_module_table_v1 *load_net_module(const char *explicit_path, std::string *error,
                                         std::string *path_out) {
  std::lock_guard<std::mutex> lock(load_mu());
  Loaded &l = loaded();
  if (!l.tried) {
    l.tried = true;
    l.path = explicit_path != nullptr && explicit_path[0] != '\0' ? std::string(explicit_path)
                                                                  : default_net_module_path();
    l.module = load_net_module_at(l.path, &l.error);
  }
  if (path_out != nullptr) *path_out = l.path;
  if (l.module == nullptr && error != nullptr) *error = l.error;
  return l.module;
}

std::unique_ptr<NetWtCarrier> NetWtCarrier::create(const grc_net_module_table_v1 *module,
                                                   std::string *error) {
  if (module == nullptr) {
    *error = "net-module-missing: no module";
    return nullptr;
  }
  grc_carrier_v1 vt{};
  char why[256] = {0};
  if (module->wt_create(&vt, why, sizeof why) != 1) {
    *error = std::string("carrier-start-failed: wt_create: ") + why;
    return nullptr;
  }
  if (vt.name == nullptr || std::strcmp(vt.name, "wt") != 0) {
    if (vt.destroy != nullptr) vt.destroy(vt.self);
    *error = "net-module-abi: the module's wt carrier is not named wt";
    return nullptr;
  }
  void *self = vt.self;
  std::unique_ptr<AbiCarrier> abi = AbiCarrier::adopt(&vt, error);
  if (abi == nullptr) {
    if (vt.destroy != nullptr) vt.destroy(vt.self);
    *error = "net-module-abi: " + *error;
    return nullptr;
  }
  return std::unique_ptr<NetWtCarrier>(new NetWtCarrier(module, std::move(abi), self));
}

bool NetWtCarrier::start(CarrierContext &ctx, std::string *error) {
  ctx_ = &ctx;
  return abi_->start(ctx, error);
}

grc_net_wt_info_v1 NetWtCarrier::module_info() const {
  grc_net_wt_info_v1 info{};
  info.abi_version = GRC_NET_MODULE_ABI_VERSION;
  info.size = sizeof info;
  info.port = -1;
  if (module_->wt_info(self_, &info) != 1) {
    info = grc_net_wt_info_v1{};
    info.port = -1;
  }
  return info;
}

std::vector<Event> NetWtCarrier::take_events() {
  if (ctx_ != nullptr && (!fault_noted_ || !expiry_noted_)) {
    const grc_net_wt_info_v1 m = module_info();
    if (m.faulted != 0 && !fault_noted_) {
      fault_noted_ = true;
      ctx_->fault("carrier-fault");  // D17: a panic stopped the carrier; its sessions closed 1011
    }
    if (m.cert_expired != 0 && !expiry_noted_) {
      expiry_noted_ = true;
      ctx_->fault("cert-expired");  // Q4.6: new sessions are refused until a restart
    }
  }
  return abi_->take_events();
}

CarrierInfo NetWtCarrier::info() const {
  CarrierInfo info = abi_->info();
  const grc_net_wt_info_v1 m = module_info();
  info.transport = "udp";
  if (m.port >= 0) {
    info.address = std::string(m.address, strnlen(m.address, sizeof m.address));
    info.port = m.port;
    info.tls = std::string(m.tls, strnlen(m.tls, sizeof m.tls));
    info.cert_sha256 = std::string(m.cert_sha256, strnlen(m.cert_sha256, sizeof m.cert_sha256));
  }
  if (module_->module_version != nullptr) info.module_version = module_->module_version;
  return info;
}

}  // namespace live
}  // namespace grc

// The module (rs-net/src/abi.rs, tests/abi_layout.rs) mirrors these layouts field for field.
static_assert(sizeof(grc_buf) == 24, "grc_buf layout");
static_assert(sizeof(grc_carrier_host_v1) == 112, "grc_carrier_host_v1 layout");
static_assert(sizeof(grc_carrier_v1) == 88, "grc_carrier_v1 layout");
static_assert(sizeof(grc_net_wt_info_v1) == 184, "grc_net_wt_info_v1 layout");
static_assert(offsetof(grc_net_wt_info_v1, port) == 72, "grc_net_wt_info_v1 layout");
static_assert(offsetof(grc_net_wt_info_v1, sessions_refused) == 160, "grc_net_wt_info_v1 layout");
static_assert(sizeof(grc_net_module_table_v1) == 40, "grc_net_module_table_v1 layout");
