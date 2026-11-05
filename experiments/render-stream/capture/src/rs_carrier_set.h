// rs_carrier_set: the live hub's transport as a set of carriers (protocol/carrier-design.md Q2;
// D3-D7, D13; CAR1).
//
// A carrier moves the hub's messages over one transport: the built-in `ws` (rs_ws's
// live::Server, index 0), the built-in `wt` (the net module, index 1, CAR3) or a consumer's own
// (indexes 2..255, CAR6), the last two through the public C ABI in grc_carrier.h. The CarrierSet
// implements rs2::LiveTransport, the hub's unchanged seam (D3), and merges every carrier's events
// into the live::Event vector entry.cpp's live_drain consumes.
//
// Connection ids (D5): the hub sees `index << 24 | local`, `local` being the carrier's own id in
// 1..2^24-1. `ws` is index 0, so its ids -- and every log line and tap named after them -- are
// what they were before carriers existed. A hub call on `conn` goes to carrier `conn >> 24` with
// `local = conn & 0xffffff`; an unknown index is a programming error (the call returns false or
// 0 and is logged once). A local id of 0 or at or above 2^24 is a carrier fault
// (`conn-id-overflow`): the connection is refused or closed with 1011 and never reaches the hub.
//
// Admission (D6): GRC_LIVE_MAX_CONNECTIONS is a total across every carrier, held by one atomic
// counter here. A carrier takes a slot before it reports a connection open (ws: before its 101)
// and returns it when the connection closes. The hub never sees an over-limit connection.
//
// Merging: each carrier keeps its own event queue (ws: live::Server's; a C ABI carrier: a
// mutex-guarded vector its host callbacks append to). take_events() drains them in index order.
// Per-connection order holds; there is no cross-carrier order, and the hub needs none.
//
// Threading: add(), start(), stop(), take_events() and every LiveTransport call run on the main
// thread. C ABI host callbacks run on any thread and touch only their own carrier's queue and
// fault counters, under that carrier's mutex; no lock is held across a call into a carrier.
#ifndef GRC_RS_CARRIER_SET_H
#define GRC_RS_CARRIER_SET_H

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "grc_carrier.h"
#include "rs_live.h"
#include "rs_ws.h"

namespace grc {
namespace live {

inline constexpr std::uint32_t kCarrierLocalBits = 24;
inline constexpr std::uint32_t kCarrierLocalMax = GRC_CARRIER_LOCAL_MAX;
inline constexpr std::uint8_t kCarrierWs = 0;            // the built-in WebSocket carrier
inline constexpr std::uint8_t kCarrierWt = 1;            // the built-in WebTransport carrier (CAR3)
inline constexpr std::uint8_t kCarrierFirstRegistered = 2;  // consumer carriers (CAR6)

inline std::uint32_t carrier_conn(std::uint8_t index, std::uint32_t local) {
  return (static_cast<std::uint32_t>(index) << kCarrierLocalBits) | (local & kCarrierLocalMax);
}
inline std::uint8_t carrier_index(std::uint32_t conn) {
  return static_cast<std::uint8_t>(conn >> kCarrierLocalBits);
}
inline std::uint32_t carrier_local(std::uint32_t conn) { return conn & kCarrierLocalMax; }

// GRC_LIVE_CARRIERS (D7, Q3): a comma list of carrier names, default (unset) `ws`. Fills *out with
// the names in order and returns true, or returns false with *error = "carriers-invalid: ..." for
// an empty list or entry, a duplicate, or a name outside [a-z0-9-]{1,16}. Whether a name is
// startable is the caller's question (`carrier-unregistered`, `net-module-missing`).
bool parse_carrier_list(const char *text, std::vector<std::string> *out, std::string *error);

// True iff `name` is [a-z0-9-]{1,16}.
bool carrier_name_ok(const std::string &name);

// The D6 counter: at most `cap` slots held at once. Thread-safe, lock-free.
class SharedAdmission final : public Admission {
 public:
  explicit SharedAdmission(std::size_t cap) : cap_(cap) {}
  bool admit() override;
  void release() override;
  std::size_t held() const { return held_.load(std::memory_order_acquire); }
  std::size_t held_max() const { return held_max_.load(std::memory_order_acquire); }
  std::size_t cap() const { return cap_; }

 private:
  std::size_t cap_;
  std::atomic<std::size_t> held_{0};
  std::atomic<std::size_t> held_max_{0};
};

// What a carrier may ask of the capture: the services half of grc_carrier_host_v1.
struct CarrierServices {
  // grc_carrier_host_v1.config: key -> value; absent keys are NULL to the carrier.
  std::map<std::string, std::string> config;
  std::string auth_token;  // empty: auth is off (token_ok is always 1)
  std::vector<std::string> allowed_origins;
  bool enforce_origins = true;  // false: the accept-any-origin sabotage
  ResourceSource *resources = nullptr;  // never owned; null: every lookup misses
  // One log line (GRC_LOG_* level); may be called from any thread. Null: dropped.
  std::function<void(int level, const std::string &line)> log;
};

// What one carrier is, for evidence/live-carriers.json (D13).
struct CarrierInfo {
  std::string address;           // the bound host, "" when not listening
  std::int64_t port = -1;        // the bound port, -1 when not listening
  std::string transport = "tcp";  // tcp | udp | "" (null: a consumer carrier, CAR6)
  std::string tls = "none";       // none | consumer | self-signed
  std::string cert_sha256;        // "" -> null
  // D12: ws's ServerConfig::lan_plaintext (GRC_LIVE_LAN_PLAINTEXT=allow); null for other carriers.
  std::optional<bool> lan_plaintext;
  std::uint32_t abi_version = 0;  // 0 -> null: built in, not behind the C ABI
  std::string module_version;     // "" -> null
};

// Handed to a carrier at start(); valid until its stop() returns.
class CarrierContext {
 public:
  virtual ~CarrierContext() = default;
  virtual Admission &admission() = 0;
  virtual const CarrierServices &services() const = 0;
  // Records one carrier fault by its typed code (`conn-id-overflow`, ...). Thread-safe.
  virtual void fault(const std::string &code) = 0;
};

// The C++ face of a carrier: ws implements it directly, C ABI carriers through AbiCarrier.
// Ids are the carrier's local ids. Event::conn is local on the way out of take_events().
class Carrier {
 public:
  virtual ~Carrier() = default;
  virtual std::string name() const = 0;
  virtual bool start(CarrierContext &ctx, std::string *error) = 0;
  virtual void stop() = 0;
  virtual std::vector<Event> take_events() = 0;
  virtual bool send_binary(std::uint32_t local, std::vector<std::uint8_t> message) = 0;
  virtual bool send_text(std::uint32_t local, std::string message) = 0;
  virtual void close(std::uint32_t local, std::uint16_t code, std::string reason) = 0;
  virtual std::uint64_t queued_bytes(std::uint32_t local) const = 0;
  virtual std::uint64_t max_queued_bytes(std::uint32_t local) const = 0;
  virtual CarrierInfo info() const = 0;
};

// The built-in `ws` carrier: rs_ws's live::Server, whose ServerConfig::admission becomes the
// set's counter at start(). Its own event queue is the Server's.
class WsCarrier final : public Carrier {
 public:
  WsCarrier(ServerConfig config, ResourceSource *source, int stop_flush_ms);
  ~WsCarrier() override;
  std::string name() const override { return "ws"; }
  bool start(CarrierContext &ctx, std::string *error) override;
  void stop() override;
  std::vector<Event> take_events() override;
  bool send_binary(std::uint32_t local, std::vector<std::uint8_t> message) override;
  bool send_text(std::uint32_t local, std::string message) override;
  void close(std::uint32_t local, std::uint16_t code, std::string reason) override;
  std::uint64_t queued_bytes(std::uint32_t local) const override;
  std::uint64_t max_queued_bytes(std::uint32_t local) const override;
  CarrierInfo info() const override;
  std::uint16_t port() const;  // the bound port once started
  Server::TlsStats tls_stats() const { return server_.tls_stats(); }  // CAR4

 private:
  ServerConfig config_;
  ResourceSource *source_;
  int stop_flush_ms_;
  Server server_;
  CarrierContext *ctx_ = nullptr;
  bool started_ = false;
  bool stopped_ = false;
  std::vector<std::uint32_t> overflowed_;  // locals closed for conn-id-overflow, until Closed
};

// A grc_carrier_v1 behind the Carrier interface: the host callbacks (any thread) append to a
// mutex-guarded queue; messages cross by ownership transfer (the hub's vector, no copy).
class AbiCarrier final : public Carrier {
 public:
  // Accepts `vtable` when its abi_version is 1, its size at least sizeof(grc_carrier_v1), its
  // name carrier_name_ok() and every function pointer non-null; else returns null with *error.
  // The struct is copied.
  static std::unique_ptr<AbiCarrier> adopt(const grc_carrier_v1 *vtable, std::string *error);
  ~AbiCarrier() override;  // destroy(self), once
  std::string name() const override { return name_; }
  bool start(CarrierContext &ctx, std::string *error) override;
  void stop() override;
  std::vector<Event> take_events() override;
  bool send_binary(std::uint32_t local, std::vector<std::uint8_t> message) override;
  bool send_text(std::uint32_t local, std::string message) override;
  void close(std::uint32_t local, std::uint16_t code, std::string reason) override;
  std::uint64_t queued_bytes(std::uint32_t local) const override;
  std::uint64_t max_queued_bytes(std::uint32_t local) const override;
  CarrierInfo info() const override;
  // Host grc_bufs handed out and not yet released (sends and lookups): the owner ledger's size.
  std::int64_t outstanding_buffers() const;
  // Callbacks that arrived after stop() returned (ignored; each is also a `callback-after-stop`
  // fault).
  std::uint64_t late_callbacks() const { return late_.load(std::memory_order_acquire); }

  struct Thunks;  // the C callbacks (rs_carrier_set.cpp)

 private:
  explicit AbiCarrier(const grc_carrier_v1 &vtable);
  struct Local {
    bool admitted = false;
    bool opened = false;
    bool doomed = false;  // refused by the host (fault); closed()/rejected() just forget it
  };
  // Every helper below assumes mu_ is held.
  void push_locked(Event e);
  void forget_locked(std::uint32_t local);
  void doom_locked(std::uint32_t local, const char *fault);

  grc_carrier_v1 vt_{};
  std::string name_;
  grc_carrier_host_v1 host_{};
  CarrierContext *ctx_ = nullptr;
  bool started_ = false;
  bool destroyed_ = false;
  mutable std::mutex mu_;
  bool stopped_ = false;  // under mu_
  std::map<std::uint32_t, Local> locals_;
  std::vector<Event> events_;
  // Doomed locals the main thread closes (1011, the fault code as the reason).
  std::vector<std::pair<std::uint32_t, std::string>> pending_close_;
  // CAR6: the owner ledger. Every grc_buf the host hands out (a send's message, a lookup's body)
  // carries a fresh id as its `owner`, never a pointer; release() frees the buffer whose id it is
  // given. An id that is not outstanding -- a second release, or a value the host never handed
  // out -- is the fault `release-unknown` and frees nothing, so a carrier that releases twice
  // cannot double-free the hub's buffer. Thread-safe (release() comes from any thread).
  void *ledger_add(void *buffer);
  void *ledger_take(void *owner);
  mutable std::mutex ledger_mu_;
  std::uint64_t ledger_next_ = 1;
  std::map<std::uint64_t, void *> ledger_;
  std::atomic<std::uint64_t> late_{0};
};

class CarrierSet final : public rs2::LiveTransport {
 public:
  // Test-only sabotages (carrier-design.md CAR1 "Sabotages"): each must fail rs_carrier_set_test.
  enum class Sabotage {
    None,
    RouteByLocal,         // routes on `local` alone (the index dropped): every call goes to 0
    PerCarrierAdmission,  // a counter per carrier, each with the whole cap, instead of the total
  };

  CarrierSet(std::size_t max_connections, CarrierServices services);
  ~CarrierSet() override;  // destroys every carrier; one still running stops without a flush
  CarrierSet(const CarrierSet &) = delete;
  CarrierSet &operator=(const CarrierSet &) = delete;

  // Adds a carrier at `index` (0 ws, 1 wt, 2..255 registered) before start(). False (with
  // *error) when the index or the name is taken, or after start().
  bool add(std::uint8_t index, std::unique_ptr<Carrier> carrier, std::string *error);

  // Starts every carrier in index order. A carrier whose start fails is recorded (live-carriers
  // .json) and the others still start; returns false, with *error the first failure's text, only
  // when none started (or none was added).
  bool start(std::string *error);

  // Stops every started carrier, in index order. Idempotent.
  void stop();

  // Every carrier's events since the last call, carrier by carrier in index order, with `conn`
  // namespaced (D5) and `carrier` set to the carrier's name.
  std::vector<Event> take_events();

  // rs2::LiveTransport (D3), routed by `conn >> 24`.
  bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) override;
  bool send_text(std::uint32_t conn, std::string message) override;
  void close(std::uint32_t conn, std::uint16_t code, std::string reason) override;
  std::uint64_t queued_bytes(std::uint32_t conn) const override;
  std::uint64_t max_queued_bytes(std::uint32_t conn) const override;

  Carrier *carrier(std::uint8_t index) const;  // null when absent
  bool started(std::uint8_t index) const;      // added and started successfully
  std::size_t admitted() const;                // slots held right now (the D6 total)
  std::size_t admitted_max() const;            // the most ever held at once
  std::uint64_t faults(std::uint8_t index, const std::string &code) const;

  // evidence/live-carriers.json (D13), schema render-stream-live-carriers/1.
  std::string carriers_json() const;

  void set_sabotage_for_test(Sabotage sabotage) { sabotage_ = sabotage; }

 private:
  struct Slot;
  Slot *route(std::uint32_t conn) const;

  std::size_t max_connections_;
  CarrierServices services_;
  SharedAdmission admission_;
  std::array<std::unique_ptr<Slot>, 256> slots_;
  bool start_called_ = false;
  bool stopped_ = false;
  Sabotage sabotage_ = Sabotage::None;
  mutable bool unknown_logged_ = false;
};

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_CARRIER_SET_H
