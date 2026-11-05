// rs_net_module: the capture's side of the net module, librender_stream_net (protocol/
// carrier-design.md D8, D13, D17, Q4; CAR3).
//
// The module is loaded only when GRC_LIVE_CARRIERS lists `wt` or (CAR4) GRC_LIVE_TLS_CERT is set: dlopen(RTLD_NOW | RTLD_LOCAL) of
// GRC_LIVE_NET_MODULE, else of librender_stream_net.so beside the binary this code is linked
// into (dladdr: the capture's .so, or a test host's executable). It is never dlclose()d. Its
// entry is grc_net_module_v1() (grc_net_module.h); a module without it, or with another ABI
// version, is refused as `net-module-abi`; a module that cannot be loaded as `net-module-missing`.
//
// The `wt` carrier it makes is a grc_carrier_v1 like any consumer's, adopted by AbiCarrier;
// NetWtCarrier adds what only the module knows to evidence/live-carriers.json (the bound UDP
// address, the certificate's SHA-256, the module version) and turns a module fault into the
// carrier's `carrier-fault` (and an expired certificate into `cert-expired`).
//
// CAR4 (D11, D12): the module's second entry, grc_net_tls_v1, is the sans-IO TLS server session
// the built-in `ws` carrier runs a TLS connection through. NetTlsContext adapts it to rs_ws.h's
// TlsContext / TlsSession; a module without that entry is `net-module-abi` when a pair is set.
#ifndef GRC_RS_NET_MODULE_H
#define GRC_RS_NET_MODULE_H

#include <memory>
#include <string>

#include "grc_net_module.h"
#include "rs_carrier_set.h"

namespace grc {
namespace live {

// The loaded module (cached: later calls return the first result), or null with *error set to
// "net-module-missing: ..." or "net-module-abi: ...". `explicit_path` is GRC_LIVE_NET_MODULE
// (null or empty: beside this binary). *path_out (optional) is the path tried.
const grc_net_module_table_v1 *load_net_module(const char *explicit_path, std::string *error,
                                         std::string *path_out = nullptr);

// One uncached load of `path` (tests; load_net_module is this, once per process). *handle_out
// (optional) is the dlopen handle, set whenever the library loaded, even if refused.
const grc_net_module_table_v1 *load_net_module_at(const std::string &path, std::string *error,
                                            void **handle_out = nullptr);

// CAR4: the TLS table of the module load_net_module loads (loading it first; cached), or null
// with *error "net-module-missing: ..." or "net-module-abi: ...".
const grc_net_tls_table_v1 *load_net_tls(const char *explicit_path, std::string *error);

// CAR4: the TLS table behind a dlopen handle, checked (version, size, every entry), or null with
// *error "net-module-abi: ...". `path` names the library in the error.
const grc_net_tls_table_v1 *net_tls_table(void *handle, const std::string &path, std::string *error);

// CAR4: the consumer's pair as rs_ws's TlsContext (ServerConfig::tls), over grc_net_tls_v1.
class NetTlsContext final : public TlsContext {
 public:
  // Null with *error ("tls-config-invalid: ...") when the module refuses the pair.
  static std::unique_ptr<NetTlsContext> create(const grc_net_tls_table_v1 *table, const std::string &cert_path,
                                               const std::string &key_path, std::string *error);
  ~NetTlsContext() override;
  NetTlsContext(const NetTlsContext &) = delete;
  NetTlsContext &operator=(const NetTlsContext &) = delete;
  std::unique_ptr<TlsSession> new_session(std::string *error) override;
  std::string cert_sha256() const override { return sha256_; }

 private:
  NetTlsContext(const grc_net_tls_table_v1 *table, grc_net_tls_config *config, std::string sha256)
      : table_(table), config_(config), sha256_(std::move(sha256)) {}
  const grc_net_tls_table_v1 *table_;
  grc_net_tls_config *config_;
  std::string sha256_;
};

// The default module path: librender_stream_net.so in this binary's directory.
std::string default_net_module_path();

class NetWtCarrier final : public Carrier {
 public:
  // Null (with *error) when the module cannot make one.
  static std::unique_ptr<NetWtCarrier> create(const grc_net_module_table_v1 *module, std::string *error);
  std::string name() const override { return abi_->name(); }
  bool start(CarrierContext &ctx, std::string *error) override;
  void stop() override { abi_->stop(); }
  std::vector<Event> take_events() override;
  bool send_binary(std::uint32_t local, std::vector<std::uint8_t> message) override {
    return abi_->send_binary(local, std::move(message));
  }
  bool send_text(std::uint32_t local, std::string message) override {
    return abi_->send_text(local, std::move(message));
  }
  void close(std::uint32_t local, std::uint16_t code, std::string reason) override {
    abi_->close(local, code, std::move(reason));
  }
  std::uint64_t queued_bytes(std::uint32_t local) const override { return abi_->queued_bytes(local); }
  std::uint64_t max_queued_bytes(std::uint32_t local) const override {
    return abi_->max_queued_bytes(local);
  }
  CarrierInfo info() const override;
  // The module's view (zeroed when the module would not answer).
  grc_net_wt_info_v1 module_info() const;
  const AbiCarrier &abi() const { return *abi_; }

 private:
  NetWtCarrier(const grc_net_module_table_v1 *module, std::unique_ptr<AbiCarrier> abi, void *self)
      : module_(module), abi_(std::move(abi)), self_(self) {}
  const grc_net_module_table_v1 *module_;
  std::unique_ptr<AbiCarrier> abi_;
  void *self_;
  CarrierContext *ctx_ = nullptr;
  bool fault_noted_ = false;
  bool expiry_noted_ = false;
};

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_NET_MODULE_H
