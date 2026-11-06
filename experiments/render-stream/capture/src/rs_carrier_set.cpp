// rs_carrier_set: see rs_carrier_set.h (protocol/carrier-design.md Q2, CAR1).
#include "rs_carrier_set.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string_view>
#include <utility>

namespace grc {
namespace live {

namespace {

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

void json_string(std::string *out, const std::string &value) {
  out->push_back('"');
  for (const char ch : value) {
    const unsigned char c = static_cast<unsigned char>(ch);
    switch (c) {
      case '"':
        out->append("\\\"");
        break;
      case '\\':
        out->append("\\\\");
        break;
      case '\n':
        out->append("\\n");
        break;
      case '\r':
        out->append("\\r");
        break;
      case '\t':
        out->append("\\t");
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out->append(buf);
        } else {
          out->push_back(ch);
        }
    }
  }
  out->push_back('"');
}

void json_string_or_null(std::string *out, const std::string &value) {
  if (value.empty()) {
    out->append("null");
  } else {
    json_string(out, value);
  }
}

// Every host grc_buf's owner: release() deletes it through this base.
struct BufOwner {
  virtual ~BufOwner() = default;
};
struct VectorOwner final : BufOwner {
  explicit VectorOwner(std::vector<std::uint8_t> v) : bytes(std::move(v)) {}
  std::vector<std::uint8_t> bytes;
};
struct StringOwner final : BufOwner {
  explicit StringOwner(std::string s) : text(std::move(s)) {}
  std::string text;
};
struct SharedOwner final : BufOwner {
  explicit SharedOwner(std::shared_ptr<const std::vector<std::uint8_t>> p) : bytes(std::move(p)) {}
  std::shared_ptr<const std::vector<std::uint8_t>> bytes;
};

const char *coding_name(grc_coding coding) {
  switch (coding) {
    case GRC_CODING_GZIP:
      return "gzip";
    case GRC_CODING_ZSTD:
      return "zstd";
    case GRC_CODING_IDENTITY:
      break;
  }
  return "identity";
}

bool local_ok(std::uint32_t local) { return local != 0 && local <= kCarrierLocalMax; }

}  // namespace

// ------------------------------------------------------------------------ names and the list

bool carrier_name_ok(const std::string &name) {
  if (name.empty() || name.size() > 16) return false;
  for (const char c : name) {
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

bool parse_carrier_list(const char *text, std::vector<std::string> *out, std::string *error) {
  out->clear();
  if (text == nullptr) {
    out->push_back("ws");
    return true;
  }
  const std::string value(text);
  std::size_t start = 0;
  while (true) {
    std::size_t comma = value.find(',', start);
    if (comma == std::string::npos) comma = value.size();
    std::string name = value.substr(start, comma - start);
    const std::size_t b = name.find_first_not_of(' ');
    const std::size_t e = name.find_last_not_of(' ');
    name = b == std::string::npos ? std::string() : name.substr(b, e - b + 1);
    if (name.empty()) {
      out->clear();
      *error = "carriers-invalid: GRC_LIVE_CARRIERS has an empty entry (got \"" + value + "\")";
      return false;
    }
    if (!carrier_name_ok(name)) {
      out->clear();
      *error = "carriers-invalid: GRC_LIVE_CARRIERS entry \"" + name +
               "\" is not a carrier name ([a-z0-9-]{1,16})";
      return false;
    }
    if (std::find(out->begin(), out->end(), name) != out->end()) {
      out->clear();
      *error = "carriers-invalid: GRC_LIVE_CARRIERS lists \"" + name + "\" twice";
      return false;
    }
    out->push_back(std::move(name));
    if (comma == value.size()) break;
    start = comma + 1;
  }
  return true;
}

// ------------------------------------------------------------------------ admission

bool SharedAdmission::admit(AdmissionPool which) {
  Pool &pool = at(which);
  std::size_t held = pool.held.load(std::memory_order_acquire);
  while (true) {
    if (held >= pool.cap) return false;
    if (pool.held.compare_exchange_weak(held, held + 1, std::memory_order_acq_rel,
                                        std::memory_order_acquire)) {
      break;
    }
  }
  std::size_t max = pool.held_max.load(std::memory_order_acquire);
  while (held + 1 > max &&
         !pool.held_max.compare_exchange_weak(max, held + 1, std::memory_order_acq_rel,
                                              std::memory_order_acquire)) {
  }
  return true;
}

void SharedAdmission::release(AdmissionPool which) {
  Pool &pool = at(which);
  std::size_t held = pool.held.load(std::memory_order_acquire);
  while (held > 0 && !pool.held.compare_exchange_weak(held, held - 1, std::memory_order_acq_rel,
                                                      std::memory_order_acquire)) {
  }
}

namespace {
bool comma_list_has(const std::map<std::string, std::string> &config, const char *key,
                    const std::string &value) {
  const auto it = config.find(key);
  if (it == config.end() || value.empty()) return false;
  const std::string &list = it->second;
  std::size_t start = 0;
  while (start <= list.size()) {
    std::size_t comma = list.find(',', start);
    if (comma == std::string::npos) comma = list.size();
    if (list.compare(start, comma - start, value) == 0 && comma - start == value.size()) return true;
    start = comma + 1;
  }
  return false;
}
}  // namespace

bool subprotocol_pool(const std::map<std::string, std::string> &config, const std::string &subprotocol,
                      AdmissionPool *pool) {
  if (comma_list_has(config, "subprotocols", subprotocol)) {
    *pool = AdmissionPool::View;
    return true;
  }
  if (comma_list_has(config, "track_subprotocols", subprotocol)) {
    *pool = AdmissionPool::Track;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------------ ws

WsCarrier::WsCarrier(ServerConfig config, ResourceSource *source, int stop_flush_ms)
    : config_(std::move(config)), source_(source), stop_flush_ms_(stop_flush_ms) {}

// Not stop(): a carrier dropped without stop() (process teardown) gets the Server's own
// destructor, stop(0), exactly as the capture's server did before carriers.
WsCarrier::~WsCarrier() = default;

bool WsCarrier::start(CarrierContext &ctx, std::string *error) {
  ctx_ = &ctx;
  config_.admission = &ctx.admission();
  started_ = server_.start(config_, source_, error);
  return started_;
}

void WsCarrier::stop() {
  if (started_ && !stopped_) {
    server_.stop(stop_flush_ms_);
  }
  stopped_ = true;
}

std::vector<Event> WsCarrier::take_events() {
  std::vector<Event> events = server_.take_events();
  if (events.empty()) return events;
  // D5: a WebSocket connection whose id no longer fits 24 bits is closed, never reported. Its
  // admission slot returns when the server finalizes it, as for any connection. Resource GETs
  // and rejections carry no id the hub uses, so they pass whatever their id.
  std::size_t kept = 0;
  for (std::size_t i = 0; i < events.size(); ++i) {
    Event &e = events[i];
    const bool session = e.kind == Event::Opened || e.kind == Event::Text || e.kind == Event::Closed;
    if (session && !local_ok(e.conn)) {
      if (e.kind == Event::Opened) {
        if (ctx_ != nullptr) ctx_->fault("conn-id-overflow");
        overflowed_.push_back(e.conn);
        server_.close(e.conn, 1011, "conn-id-overflow");
      } else if (e.kind == Event::Closed) {
        overflowed_.erase(std::remove(overflowed_.begin(), overflowed_.end(), e.conn),
                          overflowed_.end());
      }
      continue;
    }
    if (kept != i) events[kept] = std::move(e);
    ++kept;
  }
  events.resize(kept);
  return events;
}

bool WsCarrier::send_binary(std::uint32_t local, std::vector<std::uint8_t> message) {
  return server_.send_binary(local, std::move(message));
}
bool WsCarrier::send_text(std::uint32_t local, std::string message) {
  return server_.send_text(local, std::move(message));
}
void WsCarrier::close(std::uint32_t local, std::uint16_t code, std::string reason) {
  server_.close(local, code, std::move(reason));
}
std::uint64_t WsCarrier::queued_bytes(std::uint32_t local) const {
  return server_.stats(local).queued_bytes;
}
std::uint64_t WsCarrier::max_queued_bytes(std::uint32_t local) const {
  return server_.stats(local).max_queued_bytes;
}
std::uint16_t WsCarrier::port() const { return server_.port(); }

CarrierInfo WsCarrier::info() const {
  CarrierInfo info;
  if (started_) {
    info.address = config_.host;
    info.port = server_.port();
  }
  // CAR4 (D12, D13): wss beside ws on the same port, with the consumer's certificate.
  if (config_.tls != nullptr) {
    info.tls = "consumer";
    info.cert_sha256 = config_.tls->cert_sha256();
  }
  info.lan_plaintext = config_.lan_plaintext;  // D12: LAN plaintext served beside wss
  return info;
}

// ------------------------------------------------------------------------ C ABI carriers

struct AbiCarrier::Thunks {
  static AbiCarrier *self(void *host) { return static_cast<AbiCarrier *>(host); }

  // True (and a fault recorded) when the carrier calls back after stop() returned.
  static bool late_locked(AbiCarrier *c) {
    if (!c->stopped_) return false;
    c->late_.fetch_add(1, std::memory_order_acq_rel);
    if (c->ctx_ != nullptr) c->ctx_->fault("callback-after-stop");
    return true;
  }

  static const char *config(void *host, const char *key) {
    AbiCarrier *c = self(host);
    if (c->ctx_ == nullptr || key == nullptr) return nullptr;
    const auto &map = c->ctx_->services().config;
    const auto it = map.find(key);
    return it == map.end() ? nullptr : it->second.c_str();
  }

  static int admit(void *host, std::uint32_t local) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return 0;
    if (!local_ok(local)) {
      c->ctx_->fault("conn-id-overflow");
      return 0;
    }
    if (c->locals_.count(local) != 0) {
      c->ctx_->fault("local-reused");
      return 0;
    }
    if (!c->ctx_->admission().admit(AdmissionPool::View)) return 0;
    c->locals_[local].admitted = true;
    return 1;
  }

  // TRK1 (grc_carrier.h, tracks-design.md Q7): admit() from the pool `sp` belongs to.
  static int admit_subprotocol(void *host, std::uint32_t local, const char *sp, std::size_t sp_len) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return 0;
    if (!local_ok(local)) {
      c->ctx_->fault("conn-id-overflow");
      return 0;
    }
    if (c->locals_.count(local) != 0) {
      c->ctx_->fault("local-reused");
      return 0;
    }
    AdmissionPool pool = AdmissionPool::View;
    const std::string subprotocol(sp != nullptr ? sp : "", sp != nullptr ? sp_len : 0);
    if (!subprotocol_pool(c->ctx_->services().config, subprotocol, &pool)) return 0;
    if (!c->ctx_->admission().admit(pool)) return 0;
    Local &l = c->locals_[local];
    l.admitted = true;
    l.pool = pool;
    return 1;
  }

  static void opened(void *host, std::uint32_t local, const char *sp, std::size_t sp_len,
                     const char *origin, std::size_t origin_len) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return;
    if (!local_ok(local)) {
      c->doom_locked(local, "conn-id-overflow");
      return;
    }
    auto it = c->locals_.find(local);
    if (it == c->locals_.end() || !it->second.admitted || it->second.opened || it->second.doomed) {
      c->doom_locked(local, "opened-without-admit");
      return;
    }
    // TRK1 (Q3): a track subprotocol on a view slot, or a view one on a track slot, is closed
    // 1011. A subprotocol in neither list keeps today's behaviour on a view slot.
    {
      AdmissionPool sp_pool = AdmissionPool::View;
      const std::string subprotocol(sp != nullptr ? sp : "", sp != nullptr ? sp_len : 0);
      if (!subprotocol_pool(c->ctx_->services().config, subprotocol, &sp_pool)) {
        sp_pool = AdmissionPool::View;
      }
      if (sp_pool != it->second.pool) {
        c->doom_locked(local, "admit-pool-mismatch");
        return;
      }
    }
    it->second.opened = true;
    Event e;
    e.kind = Event::Opened;
    e.conn = local;
    e.subprotocol.assign(sp != nullptr ? sp : "", sp != nullptr ? sp_len : 0);
    e.origin.assign(origin != nullptr ? origin : "", origin != nullptr ? origin_len : 0);
    c->push_locked(std::move(e));
  }

  static void text(void *host, std::uint32_t local, const char *data, std::size_t len) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return;
    const auto it = c->locals_.find(local);
    if (it == c->locals_.end() || !it->second.opened || it->second.doomed) {
      if (it == c->locals_.end() || !it->second.doomed) c->ctx_->fault("event-order");
      return;
    }
    Event e;
    e.kind = Event::Text;
    e.conn = local;
    e.text.assign(data != nullptr ? data : "", data != nullptr ? len : 0);
    c->push_locked(std::move(e));
  }

  static void closed(void *host, std::uint32_t local, std::uint16_t code, const char *reason,
                     std::size_t len) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return;
    const auto it = c->locals_.find(local);
    if (it == c->locals_.end() || (!it->second.opened && !it->second.doomed)) {
      c->ctx_->fault("event-order");
      return;
    }
    if (it->second.opened && !it->second.doomed) {
      Event e;
      e.kind = Event::Closed;
      e.conn = local;
      e.code = code;
      e.reason.assign(reason != nullptr ? reason : "", reason != nullptr ? len : 0);
      e.text = e.reason;
      c->push_locked(std::move(e));
    }
    c->forget_locked(local);
  }

  static void rejected(void *host, std::uint32_t local, grc_reject why, const char *detail,
                       std::size_t len) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return;
    const auto it = c->locals_.find(local);
    if (it != c->locals_.end()) {
      if (it->second.opened && !it->second.doomed) {
        c->ctx_->fault("event-order");  // rejected after opened: closed() must end it
        return;
      }
      c->forget_locked(local);
    }
    Event e;
    e.conn = local;
    switch (why) {
      case GRC_REJECT_AUTH:
        e.kind = Event::AuthRejected;
        e.http_status = 401;
        break;
      case GRC_REJECT_ORIGIN:
        e.kind = Event::OriginRejected;
        e.http_status = 403;
        e.origin.assign(detail != nullptr ? detail : "", detail != nullptr ? len : 0);
        e.method = "GET";
        e.route = "upgrade";
        break;
      case GRC_REJECT_CAPACITY:
      default:
        return;  // like rs_ws's 503: counted by the carrier, never an event
    }
    c->push_locked(std::move(e));
  }

  static void resource_served(void *host, std::uint32_t local, const char hash[64],
                              std::uint16_t status, grc_coding coding,
                              std::uint64_t identity_bytes, std::uint64_t wire_bytes) {
    AbiCarrier *c = self(host);
    std::lock_guard<std::mutex> lock(c->mu_);
    if (late_locked(c)) return;
    Event e;
    e.kind = Event::HttpGet;
    e.conn = local & kCarrierLocalMax;
    if (hash != nullptr) e.hash.assign(hash, 64);
    e.http_status = status;
    e.method = "GET";
    e.route = "resource";
    if (status == 200) {
      e.bytes = identity_bytes;
      e.coding = coding_name(coding);
      e.coded_bytes = wire_bytes;
    }
    c->push_locked(std::move(e));
  }

  static int token_ok(void *host, const char *token, std::size_t len) {
    AbiCarrier *c = self(host);
    if (c->ctx_ == nullptr) return 0;
    const std::string &expected = c->ctx_->services().auth_token;
    if (expected.empty()) return 1;
    return constant_time_equals(std::string_view(token != nullptr ? token : "", token != nullptr ? len : 0),
                                expected)
               ? 1
               : 0;
  }

  static int origin_ok(void *host, const char *origin, std::size_t len) {
    AbiCarrier *c = self(host);
    if (origin == nullptr || len == 0) return 1;
    if (c->ctx_ == nullptr) return 0;
    const CarrierServices &s = c->ctx_->services();
    if (!s.enforce_origins) return 1;
    const std::string value(origin, len);
    return std::find(s.allowed_origins.begin(), s.allowed_origins.end(), value) !=
                   s.allowed_origins.end()
               ? 1
               : 0;
  }

  static int lookup(void *host, const char hash[64], grc_coding coding, grc_buf *out) {
    AbiCarrier *c = self(host);
    if (out == nullptr || hash == nullptr || c->ctx_ == nullptr) return 0;
    ResourceSource *source = c->ctx_->services().resources;
    if (source == nullptr) return 0;
    const std::string_view h(hash, 64);
    std::shared_ptr<const std::vector<std::uint8_t>> body;
    if (coding == GRC_CODING_IDENTITY) {
      body = source->lookup(h);
    } else if (coding == GRC_CODING_GZIP) {
      body = source->lookup_coded(h, Coding::Gzip);
    } else if (coding == GRC_CODING_ZSTD) {
      body = source->lookup_coded(h, Coding::Zstd);
    }
    if (body == nullptr) return 0;
    auto *owner = new SharedOwner(body);
    out->data = owner->bytes->data();
    out->len = owner->bytes->size();
    out->owner = c->ledger_add(static_cast<BufOwner *>(owner));
    return 1;
  }

  static void release(void *host, void *owner) {
    AbiCarrier *c = self(host);
    if (owner == nullptr) return;
    void *buffer = c->ledger_take(owner);
    if (buffer == nullptr) {
      // CAR6: a second release (or a value never handed out) frees nothing.
      if (c->ctx_ != nullptr) c->ctx_->fault("release-unknown");
      return;
    }
    delete static_cast<BufOwner *>(buffer);
  }

  static void log(void *host, int level, const char *msg, std::size_t len) {
    AbiCarrier *c = self(host);
    if (c->ctx_ == nullptr || !c->ctx_->services().log || msg == nullptr) return;
    c->ctx_->services().log(level, "carrier " + c->name_ + ": " + std::string(msg, len));
  }
};

std::unique_ptr<AbiCarrier> AbiCarrier::adopt(const grc_carrier_v1 *vt, std::string *error) {
  if (vt == nullptr) {
    *error = "carrier-abi: null carrier";
    return nullptr;
  }
  if (vt->abi_version != GRC_CARRIER_ABI_VERSION || vt->size < sizeof(grc_carrier_v1)) {
    *error = "carrier-abi: abi_version " + std::to_string(vt->abi_version) + " size " +
             std::to_string(vt->size) + " (want version 1, size >= " +
             std::to_string(sizeof(grc_carrier_v1)) + ")";
    return nullptr;
  }
  if (vt->name == nullptr || !carrier_name_ok(vt->name)) {
    *error = "carrier-abi: malformed carrier name";
    return nullptr;
  }
  if (vt->start == nullptr || vt->stop == nullptr || vt->send_binary == nullptr ||
      vt->send_text == nullptr || vt->close == nullptr || vt->queued_bytes == nullptr ||
      vt->max_queued_bytes == nullptr || vt->destroy == nullptr) {
    *error = "carrier-abi: carrier " + std::string(vt->name) + " has a null entry point";
    return nullptr;
  }
  return std::unique_ptr<AbiCarrier>(new AbiCarrier(*vt));
}

AbiCarrier::AbiCarrier(const grc_carrier_v1 &vt) : vt_(vt), name_(vt.name) {
  vt_.size = sizeof(grc_carrier_v1);  // only v1's fields were copied
  host_.abi_version = GRC_CARRIER_ABI_VERSION;
  host_.size = sizeof(grc_carrier_host_v1);
  host_.host = this;
  host_.config = &Thunks::config;
  host_.admit = &Thunks::admit;
  host_.admit_subprotocol = &Thunks::admit_subprotocol;  // TRK1, at the struct's end
  host_.opened = &Thunks::opened;
  host_.text = &Thunks::text;
  host_.closed = &Thunks::closed;
  host_.rejected = &Thunks::rejected;
  host_.resource_served = &Thunks::resource_served;
  host_.token_ok = &Thunks::token_ok;
  host_.origin_ok = &Thunks::origin_ok;
  host_.lookup = &Thunks::lookup;
  host_.release = &Thunks::release;
  host_.log = &Thunks::log;
}

AbiCarrier::~AbiCarrier() {
  stop();
  if (!destroyed_) {
    destroyed_ = true;
    vt_.destroy(vt_.self);
  }
  // A buffer the carrier never released (a fault already counted at stop) dies with the set; the
  // carrier is gone, so nothing can release it later.
  std::lock_guard<std::mutex> lock(ledger_mu_);
  for (auto &entry : ledger_) delete static_cast<BufOwner *>(entry.second);
  ledger_.clear();
}

bool AbiCarrier::start(CarrierContext &ctx, std::string *error) {
  ctx_ = &ctx;
  char buf[256] = {0};
  if (vt_.start(vt_.self, &host_, buf, sizeof(buf)) == 0) {
    buf[sizeof(buf) - 1] = '\0';
    *error = buf[0] != '\0' ? std::string(buf) : "carrier " + name_ + " failed to start";
    std::lock_guard<std::mutex> lock(mu_);
    stopped_ = true;  // never started: every later callback is late
    return false;
  }
  started_ = true;
  return true;
}

void AbiCarrier::stop() {
  if (!started_) return;
  started_ = false;
  vt_.stop(vt_.self);
  std::lock_guard<std::mutex> lock(mu_);
  stopped_ = true;
  // Slots of connections the carrier never closed return now; the set is finishing anyway.
  for (auto &entry : locals_) {
    if (entry.second.admitted) ctx_->admission().release(entry.second.pool);
  }
  locals_.clear();
  pending_close_.clear();
  if (outstanding_buffers() != 0) ctx_->fault("buffer-held-after-stop");
}

void AbiCarrier::push_locked(Event e) {
  e.t_ns = now_ns();
  events_.push_back(std::move(e));
}

void AbiCarrier::forget_locked(std::uint32_t local) {
  const auto it = locals_.find(local);
  if (it == locals_.end()) return;
  if (it->second.admitted) ctx_->admission().release(it->second.pool);
  locals_.erase(it);
}

void AbiCarrier::doom_locked(std::uint32_t local, const char *fault) {
  ctx_->fault(fault);
  Local &l = locals_[local];
  l.doomed = true;
  pending_close_.emplace_back(local, fault);
}

std::vector<Event> AbiCarrier::take_events() {
  std::vector<Event> events;
  std::vector<std::pair<std::uint32_t, std::string>> closes;
  {
    std::lock_guard<std::mutex> lock(mu_);
    events.swap(events_);
    closes.swap(pending_close_);
  }
  // Doomed connections are closed here, on the main thread, never from inside a callback.
  for (const auto &close : closes) {
    vt_.close(vt_.self, close.first, 1011, close.second.data(), close.second.size());
  }
  return events;
}

bool AbiCarrier::send_binary(std::uint32_t local, std::vector<std::uint8_t> message) {
  if (!started_) return false;
  auto *owner = new VectorOwner(std::move(message));
  grc_buf buf{owner->bytes.data(), owner->bytes.size(), ledger_add(static_cast<BufOwner *>(owner))};
  return vt_.send_binary(vt_.self, local, buf) != 0;
}

bool AbiCarrier::send_text(std::uint32_t local, std::string message) {
  if (!started_) return false;
  auto *owner = new StringOwner(std::move(message));
  grc_buf buf{reinterpret_cast<const std::uint8_t *>(owner->text.data()), owner->text.size(),
              ledger_add(static_cast<BufOwner *>(owner))};
  return vt_.send_text(vt_.self, local, buf) != 0;
}

void AbiCarrier::close(std::uint32_t local, std::uint16_t code, std::string reason) {
  if (!started_) return;
  vt_.close(vt_.self, local, code, reason.data(), reason.size());
}

std::uint64_t AbiCarrier::queued_bytes(std::uint32_t local) const {
  return started_ ? vt_.queued_bytes(vt_.self, local) : 0;
}

std::uint64_t AbiCarrier::max_queued_bytes(std::uint32_t local) const {
  return started_ ? vt_.max_queued_bytes(vt_.self, local) : 0;
}

void *AbiCarrier::ledger_add(void *buffer) {
  std::lock_guard<std::mutex> lock(ledger_mu_);
  const std::uint64_t id = ledger_next_++;
  ledger_.emplace(id, buffer);
  return reinterpret_cast<void *>(static_cast<std::uintptr_t>(id));
}

void *AbiCarrier::ledger_take(void *owner) {
  const std::uint64_t id = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(owner));
  std::lock_guard<std::mutex> lock(ledger_mu_);
  const auto it = ledger_.find(id);
  if (it == ledger_.end()) return nullptr;
  void *buffer = it->second;
  ledger_.erase(it);
  return buffer;
}

std::int64_t AbiCarrier::outstanding_buffers() const {
  std::lock_guard<std::mutex> lock(ledger_mu_);
  return static_cast<std::int64_t>(ledger_.size());
}

CarrierInfo AbiCarrier::info() const {
  CarrierInfo info;
  info.abi_version = GRC_CARRIER_ABI_VERSION;
  info.transport.clear();  // unknown behind the ABI (null); NetWtCarrier sets "udp"
  return info;
}

// ------------------------------------------------------------------------ the set

struct CarrierSet::Slot final : CarrierContext {
  Slot(CarrierSet *owner, std::uint8_t i, std::unique_ptr<Carrier> c, std::size_t cap,
       std::size_t track_cap)
      : set(owner), index(i), carrier(std::move(c)), name(carrier->name()), own(cap, track_cap) {}
  // The carrier goes first: its teardown may still call back into this context.
  ~Slot() override { carrier.reset(); }

  Admission &admission() override {
    return set->sabotage_ == Sabotage::PerCarrierAdmission ? static_cast<Admission &>(own)
                                                           : set->admission_;
  }
  const CarrierServices &services() const override { return set->services_; }
  void fault(const std::string &code) override {
    std::lock_guard<std::mutex> lock(fault_mu);
    ++faults[code];
  }

  CarrierSet *set;
  std::uint8_t index;
  std::unique_ptr<Carrier> carrier;
  std::string name;
  SharedAdmission own;  // PerCarrierAdmission sabotage only
  enum class State { Added, Listening, Failed, Stopped } state = State::Added;
  std::string error;
  mutable std::mutex fault_mu;
  std::map<std::string, std::uint64_t> faults;
  // Main thread only.
  std::uint64_t sessions = 0;
  std::uint64_t resource_gets = 0;
  std::uint64_t bytes_sent = 0;
  std::uint64_t messages_sent = 0;
};

CarrierSet::CarrierSet(std::size_t max_connections, CarrierServices services, std::size_t max_tracks)
    : max_connections_(max_connections),
      services_(std::move(services)),
      admission_(max_connections, max_tracks) {}

CarrierSet::~CarrierSet() {
  // No stop() here: each carrier's destructor tears down what is still running without a flush
  // budget (ws: Server::~Server's stop(0); a C ABI carrier: stop(), then destroy()). Reverse
  // index order.
  for (std::size_t i = slots_.size(); i-- > 0;) slots_[i].reset();
}

bool CarrierSet::add(std::uint8_t index, std::unique_ptr<Carrier> carrier, std::string *error) {
  if (start_called_) {
    *error = "carrier-late";
    return false;
  }
  if (carrier == nullptr) {
    *error = "null carrier";
    return false;
  }
  if (slots_[index] != nullptr) {
    *error = "carrier index " + std::to_string(index) + " is taken";
    return false;
  }
  const std::string name = carrier->name();
  for (const auto &slot : slots_) {
    if (slot != nullptr && slot->name == name) {
      *error = "carrier name " + name + " is taken";
      return false;
    }
  }
  slots_[index] = std::make_unique<Slot>(this, index, std::move(carrier), max_connections_,
                                         admission_.cap(AdmissionPool::Track));
  return true;
}

bool CarrierSet::start(std::string *error) {
  start_called_ = true;
  bool any = false;
  std::string first_error;
  for (const auto &slot : slots_) {
    if (slot == nullptr) continue;
    std::string why;
    if (slot->carrier->start(*slot, &why)) {
      slot->state = Slot::State::Listening;
      any = true;
    } else {
      slot->state = Slot::State::Failed;
      slot->error = why;
      if (first_error.empty()) first_error = why.empty() ? slot->name + " failed" : why;
    }
  }
  if (!any) {
    *error = first_error.empty() ? std::string("no carrier") : first_error;
  }
  return any;
}

void CarrierSet::stop() {
  if (stopped_) return;
  stopped_ = true;
  for (const auto &slot : slots_) {
    if (slot == nullptr || slot->state != Slot::State::Listening) continue;
    slot->carrier->stop();
    slot->state = Slot::State::Stopped;
  }
}

std::vector<Event> CarrierSet::take_events() {
  std::vector<Event> out;
  for (const auto &slot : slots_) {
    if (slot == nullptr || slot->state != Slot::State::Listening) continue;
    std::vector<Event> events = slot->carrier->take_events();
    if (events.empty()) continue;
    if (out.empty()) {
      out.reserve(events.size());
    }
    for (Event &e : events) {
      // TRK1 (T19): `sessions` counts view connections only; a track's Opened is not one.
      if (e.kind == Event::Opened) {
        AdmissionPool pool = AdmissionPool::View;
        if (!subprotocol_pool(services_.config, e.subprotocol, &pool) || pool == AdmissionPool::View) {
          ++slot->sessions;
        }
      }
      if (e.kind == Event::HttpGet && e.method == "GET") ++slot->resource_gets;
      e.conn = carrier_conn(slot->index, e.conn);
      e.carrier = slot->name;
      out.push_back(std::move(e));
    }
  }
  return out;
}

CarrierSet::Slot *CarrierSet::route(std::uint32_t conn) const {
  const std::uint8_t index =
      sabotage_ == Sabotage::RouteByLocal ? std::uint8_t{0} : carrier_index(conn);
  Slot *slot = slots_[index].get();
  if (slot == nullptr || slot->state != Slot::State::Listening) {
    if (slot == nullptr && !unknown_logged_) {
      unknown_logged_ = true;
      if (services_.log) {
        services_.log(GRC_LOG_ERROR, "live: carrier index " + std::to_string(index) +
                                         " is unknown (conn " + std::to_string(conn) + ")");
      }
    }
    return nullptr;
  }
  return slot;
}

bool CarrierSet::send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) {
  Slot *slot = route(conn);
  if (slot == nullptr) return false;
  const std::size_t n = message.size();
  const bool ok = slot->carrier->send_binary(carrier_local(conn), std::move(message));
  if (ok) {
    slot->bytes_sent += n;
    ++slot->messages_sent;
  }
  return ok;
}

bool CarrierSet::send_text(std::uint32_t conn, std::string message) {
  Slot *slot = route(conn);
  if (slot == nullptr) return false;
  const std::size_t n = message.size();
  const bool ok = slot->carrier->send_text(carrier_local(conn), std::move(message));
  if (ok) {
    slot->bytes_sent += n;
    ++slot->messages_sent;
  }
  return ok;
}

void CarrierSet::close(std::uint32_t conn, std::uint16_t code, std::string reason) {
  Slot *slot = route(conn);
  if (slot != nullptr) slot->carrier->close(carrier_local(conn), code, std::move(reason));
}

std::uint64_t CarrierSet::queued_bytes(std::uint32_t conn) const {
  const Slot *slot = route(conn);
  return slot != nullptr ? slot->carrier->queued_bytes(carrier_local(conn)) : 0;
}

std::uint64_t CarrierSet::max_queued_bytes(std::uint32_t conn) const {
  const Slot *slot = route(conn);
  return slot != nullptr ? slot->carrier->max_queued_bytes(carrier_local(conn)) : 0;
}

Carrier *CarrierSet::carrier(std::uint8_t index) const {
  return slots_[index] != nullptr ? slots_[index]->carrier.get() : nullptr;
}

bool CarrierSet::started(std::uint8_t index) const {
  return slots_[index] != nullptr && (slots_[index]->state == Slot::State::Listening ||
                                      slots_[index]->state == Slot::State::Stopped);
}

std::size_t CarrierSet::admitted() const { return admission_.held(); }
std::size_t CarrierSet::admitted_max() const { return admission_.held_max(); }
std::size_t CarrierSet::admitted_tracks() const { return admission_.held(AdmissionPool::Track); }
std::size_t CarrierSet::admitted_tracks_max() const {
  return admission_.held_max(AdmissionPool::Track);
}

std::uint64_t CarrierSet::faults(std::uint8_t index, const std::string &code) const {
  const Slot *slot = slots_[index].get();
  if (slot == nullptr) return 0;
  std::lock_guard<std::mutex> lock(slot->fault_mu);
  const auto it = slot->faults.find(code);
  return it == slot->faults.end() ? 0 : it->second;
}

std::string CarrierSet::carriers_json() const {
  std::string out;
  out.append("{\"schema\":\"render-stream-live-carriers/1\",\"abi_version\":");
  out.append(std::to_string(GRC_CARRIER_ABI_VERSION));
  // CAR2 (D10, D13): the exposure the listeners were configured with ("loopback" when unset).
  // live.json never carries it; its shape and its loopback assertion are unchanged.
  const auto expose = services_.config.find("expose");
  out.append(",\"expose\":");
  json_string(&out, expose != services_.config.end() && !expose->second.empty() ? expose->second : "loopback");
  out.append(",\"max_connections\":");
  out.append(std::to_string(max_connections_));
  out.append(",\"admitted_max\":");
  out.append(std::to_string(admission_.held_max()));
  out.append(",\"carriers\":[");
  bool first = true;
  for (const auto &slot : slots_) {
    if (slot == nullptr) continue;
    if (!first) out.push_back(',');
    first = false;
    const CarrierInfo info = slot->carrier->info();
    const char *state = slot->state == Slot::State::Listening ? "listening"
                        : slot->state == Slot::State::Failed  ? "failed"
                        : slot->state == Slot::State::Stopped ? "stopped"
                                                              : "added";
    out.append("{\"name\":");
    json_string(&out, slot->name);
    out.append(",\"index\":" + std::to_string(slot->index) + ",\"status\":");
    json_string(&out, state);
    out.append(",\"error\":");
    json_string_or_null(&out, slot->error);
    out.append(",\"address\":");
    json_string_or_null(&out, info.address);
    out.append(",\"port\":");
    out.append(info.port >= 0 ? std::to_string(info.port) : std::string("null"));
    out.append(",\"transport\":");
    if (info.transport.empty()) {
      out.append("null");  // CAR6: a consumer carrier's transport is its own business
    } else {
      json_string(&out, info.transport);
    }
    out.append(",\"tls\":");
    json_string(&out, info.tls);
    out.append(",\"cert_sha256\":");
    json_string_or_null(&out, info.cert_sha256);
    out.append(",\"lan_plaintext\":");
    out.append(!info.lan_plaintext.has_value() ? "null" : *info.lan_plaintext ? "true" : "false");
    out.append(",\"abi_version\":");
    out.append(info.abi_version != 0 ? std::to_string(info.abi_version) : std::string("null"));
    out.append(",\"module_version\":");
    json_string_or_null(&out, info.module_version);
    out.append(",\"sessions\":" + std::to_string(slot->sessions) +
               ",\"resource_gets\":" + std::to_string(slot->resource_gets) +
               ",\"messages_sent\":" + std::to_string(slot->messages_sent) +
               ",\"bytes_sent\":" + std::to_string(slot->bytes_sent) + ",\"faults\":{");
    {
      std::lock_guard<std::mutex> lock(slot->fault_mu);
      bool ffirst = true;
      for (const auto &f : slot->faults) {
        if (!ffirst) out.push_back(',');
        ffirst = false;
        json_string(&out, f.first);
        out.append(":" + std::to_string(f.second));
      }
    }
    out.append("}}");
  }
  out.append("]}\n");
  return out;
}

}  // namespace live
}  // namespace grc
