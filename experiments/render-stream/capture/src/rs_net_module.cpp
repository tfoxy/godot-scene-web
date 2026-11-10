// rs_net_module.cpp -- see rs_net_module.h.
#include "rs_net_module.h"

#include "rs_platform.h"

#include <cstddef>
#include <cstring>
#include <mutex>

namespace grc {
namespace live {

namespace {

std::string dir_of(const std::string &path) {
  const std::size_t slash = path.rfind('/');
  return slash == std::string::npos ? std::string(".") : path.substr(0, slash);
}

struct Loaded {
  bool tried = false;
  void *handle = nullptr;
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
  const std::string module_file = rs::library_file_name("render_stream_net");
  const std::string path = rs::module_path_of(reinterpret_cast<void *>(&default_net_module_path));
  if (path.empty()) {
    return module_file;
  }
  return dir_of(path) + "/" + module_file;
}

const grc_net_module_table_v1 *load_net_module_at(const std::string &path, std::string *error,
                                            void **handle_out) {
  // Never unloaded, so a carrier thread can never outlive its code.
  std::string why;
  void *handle = rs::library_open(path, &why);
  if (handle_out != nullptr) *handle_out = handle;
  if (handle == nullptr) {
    *error = "net-module-missing: cannot load " + path + " (" +
             why +
             "); build it with scripts/build-rs-net.sh or set GRC_LIVE_NET_MODULE";
    return nullptr;
  }
  void *entry = rs::library_symbol(handle, GRC_NET_MODULE_ENTRY);
  if (entry == nullptr) {
    *error = "net-module-abi: " + path + " has no " + GRC_NET_MODULE_ENTRY;
    return nullptr;
  }
  const grc_net_module_table_v1 *m = reinterpret_cast<grc_net_module_table_v1_fn>(entry)();
  if (m == nullptr || m->abi_version != GRC_NET_MODULE_ABI_VERSION ||
      m->size < offsetof(grc_net_module_table_v1, features)) {
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

bool net_module_serves_tracks(const grc_net_module_table_v1 *m) {
  if (m == nullptr || m->size < offsetof(grc_net_module_table_v1, features) + sizeof(std::uint32_t)) {
    return false;
  }
  return (m->features & GRC_NET_FEATURE_TRACKS) != 0;
}

const grc_net_module_table_v1 *load_net_module(const char *explicit_path, std::string *error,
                                         std::string *path_out) {
  std::lock_guard<std::mutex> lock(load_mu());
  Loaded &l = loaded();
  if (!l.tried) {
    l.tried = true;
    l.path = explicit_path != nullptr && explicit_path[0] != '\0' ? std::string(explicit_path)
                                                                  : default_net_module_path();
    l.module = load_net_module_at(l.path, &l.error, &l.handle);
  }
  if (path_out != nullptr) *path_out = l.path;
  if (l.module == nullptr && error != nullptr) *error = l.error;
  return l.module;
}

const grc_net_tls_table_v1 *net_tls_table(void *handle, const std::string &path, std::string *error) {
  if (handle == nullptr) {
    *error = "net-module-missing: " + path + " is not loaded";
    return nullptr;
  }
  void *entry = rs::library_symbol(handle, GRC_NET_TLS_ENTRY);
  if (entry == nullptr) {
    *error = "net-module-abi: " + path + " has no " + GRC_NET_TLS_ENTRY + " (wss needs a CAR4 module)";
    return nullptr;
  }
  const grc_net_tls_table_v1 *t = reinterpret_cast<grc_net_tls_table_v1_fn>(entry)();
  if (t == nullptr || t->abi_version != GRC_NET_TLS_ABI_VERSION || t->size < sizeof(grc_net_tls_table_v1) ||
      t->config_create == nullptr || t->config_cert_sha256 == nullptr || t->config_destroy == nullptr ||
      t->session_create == nullptr || t->session_destroy == nullptr || t->feed == nullptr ||
      t->read == nullptr || t->write == nullptr || t->take == nullptr || t->state == nullptr ||
      t->error == nullptr || t->close_notify == nullptr) {
    *error = "net-module-abi: " + path + "'s TLS table is not version " + std::to_string(GRC_NET_TLS_ABI_VERSION);
    return nullptr;
  }
  return t;
}

const grc_net_tls_table_v1 *load_net_tls(const char *explicit_path, std::string *error) {
  std::string path;
  if (load_net_module(explicit_path, error, &path) == nullptr) return nullptr;
  void *handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(load_mu());
    handle = loaded().handle;
  }
  return net_tls_table(handle, path, error);
}

namespace {

class NetTlsSession final : public TlsSession {
 public:
  NetTlsSession(const grc_net_tls_table_v1 *t, grc_net_tls_session *s) : t_(t), s_(s) {}
  ~NetTlsSession() override { t_->session_destroy(s_); }
  NetTlsSession(const NetTlsSession &) = delete;
  NetTlsSession &operator=(const NetTlsSession &) = delete;
  std::int64_t feed(const std::uint8_t *data, std::size_t len) override { return t_->feed(s_, data, len); }
  std::int64_t read(std::uint8_t *out, std::size_t cap) override { return t_->read(s_, out, cap); }
  std::int64_t write(const std::uint8_t *data, std::size_t len) override { return t_->write(s_, data, len); }
  std::int64_t take(std::uint8_t *out, std::size_t cap) override { return t_->take(s_, out, cap); }
  std::uint32_t state() const override { return t_->state(s_); }
  std::string error() const override {
    char buf[256] = {0};
    t_->error(s_, buf, sizeof buf);
    return std::string(buf, strnlen(buf, sizeof buf));
  }
  void close_notify() override { t_->close_notify(s_); }

 private:
  const grc_net_tls_table_v1 *t_;
  grc_net_tls_session *s_;
};

static_assert(TlsSession::Handshaking == GRC_TLS_HANDSHAKING && TlsSession::WantsWrite == GRC_TLS_WANTS_WRITE &&
                  TlsSession::PeerClosed == GRC_TLS_PEER_CLOSED && TlsSession::Failed == GRC_TLS_FAILED,
              "rs_ws.h TlsSession::State mirrors grc_net_module.h GRC_TLS_*");

}  // namespace

std::unique_ptr<NetTlsContext> NetTlsContext::create(const grc_net_tls_table_v1 *table, const std::string &cert_path,
                                                     const std::string &key_path, std::string *error) {
  if (table == nullptr) {
    *error = "net-module-missing: no TLS table";
    return nullptr;
  }
  char why[512] = {0};
  grc_net_tls_config *config = table->config_create(cert_path.c_str(), key_path.c_str(), why, sizeof why);
  if (config == nullptr) {
    *error = why[0] != '\0' ? std::string(why) : std::string("tls-config-invalid: the module refused the pair");
    return nullptr;
  }
  char sha[65] = {0};
  if (table->config_cert_sha256(config, sha, sizeof sha) != 1) sha[0] = '\0';
  return std::unique_ptr<NetTlsContext>(new NetTlsContext(table, config, std::string(sha, strnlen(sha, sizeof sha))));
}

NetTlsContext::~NetTlsContext() { table_->config_destroy(config_); }

std::unique_ptr<TlsSession> NetTlsContext::new_session(std::string *error) {
  char why[256] = {0};
  grc_net_tls_session *s = table_->session_create(config_, why, sizeof why);
  if (s == nullptr) {
    *error = why;
    return nullptr;
  }
  return std::make_unique<NetTlsSession>(table_, s);
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
// TRK1 appended admit_subprotocol (abi_version stays 1, the size rule): the module's mirror still
// ends at `log` (112 bytes) until TRK3 grows it, and accepts the larger struct by its size rule.
static_assert(sizeof(grc_carrier_host_v1) == 120, "grc_carrier_host_v1 layout");
static_assert(offsetof(grc_carrier_host_v1, admit_subprotocol) == 112, "grc_carrier_host_v1 layout");
static_assert(sizeof(grc_carrier_v1) == 88, "grc_carrier_v1 layout");
static_assert(sizeof(grc_net_wt_info_v1) == 184, "grc_net_wt_info_v1 layout");
static_assert(offsetof(grc_net_wt_info_v1, port) == 72, "grc_net_wt_info_v1 layout");
static_assert(offsetof(grc_net_wt_info_v1, sessions_refused) == 160, "grc_net_wt_info_v1 layout");
static_assert(sizeof(grc_net_module_table_v1) == 48, "grc_net_module_table_v1 layout");
static_assert(offsetof(grc_net_module_table_v1, features) == 40, "grc_net_module_table_v1 layout");
static_assert(sizeof(grc_net_tls_table_v1) == 112, "grc_net_tls_table_v1 layout");
static_assert(offsetof(grc_net_tls_table_v1, feed) == 56, "grc_net_tls_table_v1 layout");
static_assert(offsetof(grc_net_tls_table_v1, close_notify) == 104, "grc_net_tls_table_v1 layout");
