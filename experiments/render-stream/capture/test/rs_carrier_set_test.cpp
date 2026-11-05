// rs_carrier_set_test: the CarrierSet (rs_carrier_set.h) and the grc_carrier_v1 adapter
// (grc_carrier.h), protocol/carrier-design.md Q1, Q2, D5, D6 and the CAR1 row: id namespacing,
// routing, close, queued bytes, per-connection order, the admission total across carriers
// (including the real rs_ws server as `ws`), conn-id-overflow, no callback after stop, the owner
// ledger, resource events and services, GRC_LIVE_CARRIERS parsing and live-carriers.json.
//
// The CAR1 sabotages are test-only: CarrierSet::Sabotage::RouteByLocal must fail the routing
// check and PerCarrierAdmission the admission check; main() runs both checks under each and
// fails if a sabotage goes unnoticed.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#include "grc_carrier.h"
#include "rs_carrier_set.h"
#include "rs_ws.h"

using grc::live::AbiCarrier;
using grc::live::CarrierServices;
using grc::live::CarrierSet;
using grc::live::Event;

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const std::string &what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
  }
}

// ------------------------------------------------------------------- a fake C ABI carrier

struct Fake {
  explicit Fake(std::string n) : name(std::move(n)) {
    vt.abi_version = GRC_CARRIER_ABI_VERSION;
    vt.size = sizeof(grc_carrier_v1);
    vt.name = name.c_str();
    vt.self = this;
    vt.start = &Fake::start;
    vt.stop = &Fake::stop;
    vt.send_binary = &Fake::send_binary;
    vt.send_text = &Fake::send_text;
    vt.close = &Fake::close;
    vt.queued_bytes = &Fake::queued_bytes;
    vt.max_queued_bytes = &Fake::max_queued_bytes;
    vt.destroy = &Fake::destroy;
  }

  std::string name;
  grc_carrier_v1 vt{};
  const grc_carrier_host_v1 *host = nullptr;
  bool fail_start = false;
  bool started = false;
  bool stopped = false;
  int destroyed = 0;
  bool hold = false;  // keep sent buffers (queued) until flush()
  std::set<std::uint32_t> open;
  std::map<std::uint32_t, std::vector<std::string>> received;  // "b:<bytes>" / "t:<text>"
  std::vector<std::tuple<std::uint32_t, std::uint16_t, std::string>> closes;
  std::map<std::uint32_t, std::uint64_t> queued;
  std::map<std::uint32_t, std::uint64_t> maxq;
  std::vector<std::pair<std::uint32_t, void *>> held;  // (local, owner)
  std::vector<std::pair<std::uint32_t, std::size_t>> held_len;

  static Fake *me(void *self) { return static_cast<Fake *>(self); }
  static int start(void *self, const grc_carrier_host_v1 *host, char *error, std::size_t cap) {
    Fake *f = me(self);
    if (f->fail_start) {
      std::snprintf(error, cap, "bind failed");
      return 0;
    }
    f->host = host;
    f->started = true;
    return 1;
  }
  static void stop(void *self) {
    Fake *f = me(self);
    f->flush();
    f->stopped = true;
  }
  static int send(Fake *f, std::uint32_t local, grc_buf m, const char *tag) {
    if (f->open.count(local) == 0) {
      f->host->release(f->host->host, m.owner);
      return 0;
    }
    f->received[local].push_back(std::string(tag) +
                                 std::string(reinterpret_cast<const char *>(m.data), m.len));
    f->queued[local] += m.len;
    f->maxq[local] = std::max(f->maxq[local], f->queued[local]);
    if (f->hold) {
      f->held.emplace_back(local, m.owner);
      f->held_len.emplace_back(local, m.len);
    } else {
      f->queued[local] -= m.len;
      f->host->release(f->host->host, m.owner);
    }
    return 1;
  }
  static int send_binary(void *self, std::uint32_t local, grc_buf m) { return send(me(self), local, m, "b:"); }
  static int send_text(void *self, std::uint32_t local, grc_buf m) { return send(me(self), local, m, "t:"); }
  static void close(void *self, std::uint32_t local, std::uint16_t code, const char *reason, std::size_t len) {
    me(self)->closes.emplace_back(local, code, std::string(reason, len));
  }
  static std::uint64_t queued_bytes(void *self, std::uint32_t local) {
    auto it = me(self)->queued.find(local);
    return it == me(self)->queued.end() ? 0 : it->second;
  }
  static std::uint64_t max_queued_bytes(void *self, std::uint32_t local) {
    auto it = me(self)->maxq.find(local);
    return it == me(self)->maxq.end() ? 0 : it->second;
  }
  static void destroy(void *self) { ++me(self)->destroyed; }

  void flush() {
    for (std::size_t i = 0; i < held.size(); ++i) {
      queued[held_len[i].first] -= held_len[i].second;
      host->release(host->host, held[i].second);
    }
    held.clear();
    held_len.clear();
  }

  // Carrier-side helpers: what a real carrier's I/O would report.
  int admit(std::uint32_t local) { return host->admit(host->host, local); }
  void opened(std::uint32_t local, const std::string &sp = "render-stream.13",
              const std::string &origin = "") {
    open.insert(local);
    host->opened(host->host, local, sp.data(), sp.size(), origin.data(), origin.size());
  }
  bool connect(std::uint32_t local) {
    if (admit(local) != 1) return false;
    opened(local);
    return true;
  }
  void text(std::uint32_t local, const std::string &t) { host->text(host->host, local, t.data(), t.size()); }
  void closed(std::uint32_t local, std::uint16_t code = 1000, const std::string &reason = "") {
    open.erase(local);
    host->closed(host->host, local, code, reason.data(), reason.size());
  }
};

std::unique_ptr<AbiCarrier> adopt(Fake &f) {
  std::string error;
  auto c = AbiCarrier::adopt(&f.vt, &error);
  check(c != nullptr, "adopt " + f.name + ": " + error);
  return c;
}

struct Pair {
  Fake a{"fa"};
  Fake b{"fb"};
  std::unique_ptr<CarrierSet> set;
};

// Fake `fa` at index 0 and `fb` at index 2 (the sabotage RouteByLocal sends both to 0).
std::unique_ptr<Pair> make_fakes(std::size_t cap, CarrierSet::Sabotage sabotage,
                                CarrierServices services = CarrierServices()) {
  auto p = std::make_unique<Pair>();
  p->set = std::make_unique<CarrierSet>(cap, std::move(services));
  p->set->set_sabotage_for_test(sabotage);
  std::string error;
  check(p->set->add(0, adopt(p->a), &error), "add fa: " + error);
  check(p->set->add(2, adopt(p->b), &error), "add fb: " + error);
  check(p->set->start(&error), "start: " + error);
  return p;
}

const std::uint32_t kB = 2u << 24;

// ------------------------------------------------------------------- the checks

// D5 routing: one local id on two carriers is two hub connections, and every hub call reaches the
// carrier the id names. Returns false on any miss (RouteByLocal must make it false).
bool routing_holds(CarrierSet::Sabotage sabotage) {
  auto p = make_fakes(4, sabotage);
  bool ok = true;
  ok &= p->a.connect(1);
  ok &= p->b.connect(1);
  const std::vector<Event> ev = p->set->take_events();
  ok &= ev.size() == 2 && ev[0].kind == Event::Opened && ev[0].conn == 1 && ev[0].carrier == "fa" &&
        ev[1].kind == Event::Opened && ev[1].conn == (kB | 1) && ev[1].carrier == "fb";
  ok &= p->set->send_binary(kB | 1, {1, 2, 3});
  ok &= p->set->send_text(kB | 1, "hello");
  ok &= p->set->send_binary(1, {9});
  ok &= p->b.received[1].size() == 2 && p->b.received[1][0] == std::string("b:\x01\x02\x03", 5) &&
        p->b.received[1][1] == "t:hello";
  ok &= p->a.received[1].size() == 1 && p->a.received[1][0] == "b:\x09";
  p->b.hold = true;
  ok &= p->set->send_binary(kB | 1, std::vector<std::uint8_t>(100, 7));
  ok &= p->set->queued_bytes(kB | 1) == 100 && p->set->queued_bytes(1) == 0;
  ok &= p->set->max_queued_bytes(kB | 1) == 100;
  p->b.flush();
  ok &= p->set->queued_bytes(kB | 1) == 0 && p->set->max_queued_bytes(kB | 1) == 100;
  p->set->close(kB | 1, 4000, "bye");
  ok &= p->b.closes.size() == 1 && std::get<0>(p->b.closes[0]) == 1 &&
        std::get<1>(p->b.closes[0]) == 4000 && std::get<2>(p->b.closes[0]) == "bye";
  ok &= p->a.closes.empty();
  p->set->stop();
  return ok;
}

// D6: GRC_LIVE_MAX_CONNECTIONS is one total across carriers. Returns false when a carrier can go
// past the total (PerCarrierAdmission must make it false).
bool admission_total_holds(CarrierSet::Sabotage sabotage) {
  auto p = make_fakes(2, sabotage);
  bool ok = true;
  ok &= p->a.connect(1);
  ok &= p->b.connect(1);
  ok &= p->set->admitted() == 2;
  ok &= p->a.admit(2) == 0;  // the third connection, on either carrier, is refused
  ok &= p->b.admit(2) == 0;
  p->b.closed(1);  // the slot returns at closed
  ok &= p->set->admitted() == 1;
  ok &= p->a.connect(2);
  ok &= p->set->admitted() == 2;
  ok &= p->b.admit(3) == 0;
  // A slot granted to a connection that never opens returns at rejected().
  p->a.closed(2);
  ok &= p->b.admit(3) == 1;
  p->b.host->rejected(p->b.host->host, 3, GRC_REJECT_CAPACITY, "", 0);
  ok &= p->set->admitted() == 1;
  ok &= p->set->admitted_max() == 2;
  p->set->stop();
  return ok;
}

void test_routing_and_sabotage() {
  check(routing_holds(CarrierSet::Sabotage::None), "routing: namespaced ids reach their carrier");
  check(!routing_holds(CarrierSet::Sabotage::RouteByLocal),
        "sabotage route-by-local: the routing check must fail");
}

void test_admission_and_sabotage() {
  check(admission_total_holds(CarrierSet::Sabotage::None), "admission: a total across carriers");
  check(!admission_total_holds(CarrierSet::Sabotage::PerCarrierAdmission),
        "sabotage per-carrier admission: the admission check must fail");
}

void test_unknown_index() {
  std::vector<std::string> logs;
  CarrierServices s;
  s.log = [&logs](int, const std::string &line) { logs.push_back(line); };
  auto p = make_fakes(4, CarrierSet::Sabotage::None, s);
  const std::uint32_t conn = (5u << 24) | 1;
  check(!p->set->send_binary(conn, {1}), "unknown index: send_binary returns false");
  check(!p->set->send_text(conn, "x"), "unknown index: send_text returns false");
  check(p->set->queued_bytes(conn) == 0 && p->set->max_queued_bytes(conn) == 0,
        "unknown index: queued bytes 0");
  p->set->close(conn, 1000, "");
  check(logs.size() == 1, "unknown index: logged once (got " + std::to_string(logs.size()) + ")");
  check(p->a.received.empty() && p->b.received.empty(), "unknown index: nothing delivered");
}

void test_event_order() {
  auto p = make_fakes(4, CarrierSet::Sabotage::None);
  // Interleaved callbacks across carriers and connections.
  p->b.connect(1);
  p->a.connect(7);
  p->b.text(1, "b1");
  p->a.text(7, "a1");
  p->b.text(1, "b2");
  p->a.text(7, "a2");
  p->b.closed(1, 1001, "gone");
  p->a.text(7, "a3");
  const std::vector<Event> ev = p->set->take_events();
  std::vector<std::string> a_seq;
  std::vector<std::string> b_seq;
  std::size_t last_a = 0;
  std::size_t first_b = ev.size();
  for (std::size_t i = 0; i < ev.size(); ++i) {
    const Event &e = ev[i];
    const std::string tag = e.kind == Event::Opened ? "open"
                            : e.kind == Event::Text ? "text:" + e.text
                            : e.kind == Event::Closed ? "closed:" + std::to_string(e.code) + ":" + e.reason
                                                      : "other";
    if (e.conn == 7) {
      a_seq.push_back(tag);
      last_a = i;
    } else if (e.conn == (kB | 1)) {
      b_seq.push_back(tag);
      if (first_b == ev.size()) first_b = i;
    }
    check(e.t_ns != 0, "event order: t_ns set");
  }
  check(a_seq == std::vector<std::string>{"open", "text:a1", "text:a2", "text:a3"},
        "event order: carrier fa's connection in callback order");
  check(b_seq == std::vector<std::string>{"open", "text:b1", "text:b2", "closed:1001:gone"},
        "event order: carrier fb's connection in callback order");
  check(last_a < first_b, "event order: carriers drained in index order");
  // A text before opened or after closed is a fault and never an event.
  p->b.text(1, "late");
  p->a.host->text(p->a.host->host, 9, "x", 1);
  check(p->set->take_events().empty(), "event order: text outside open..closed dropped");
  check(p->set->faults(2, "event-order") == 1 && p->set->faults(0, "event-order") == 1,
        "event order: each counted as an event-order fault");
}

void test_conn_id_overflow() {
  auto p = make_fakes(4, CarrierSet::Sabotage::None);
  const std::uint32_t big = GRC_CARRIER_LOCAL_MAX + 1;
  check(p->a.admit(big) == 0, "overflow: admit of 2^24 refused");
  check(p->a.admit(0) == 0, "overflow: admit of 0 refused");
  check(p->set->faults(0, "conn-id-overflow") == 2, "overflow: two conn-id-overflow faults");
  check(p->set->admitted() == 0, "overflow: no slot held");
  // A carrier that opens it anyway is closed (1011) from the main thread, never reported.
  p->a.opened(big);
  const std::vector<Event> ev = p->set->take_events();
  check(ev.empty(), "overflow: no Opened event reaches the hub");
  check(p->a.closes.size() == 1 && std::get<0>(p->a.closes[0]) == big &&
            std::get<1>(p->a.closes[0]) == 1011 && std::get<2>(p->a.closes[0]) == "conn-id-overflow",
        "overflow: the connection is closed 1011 conn-id-overflow");
  p->a.closed(big, 1011, "conn-id-overflow");
  check(p->set->take_events().empty(), "overflow: its closed() is absorbed");
  check(p->set->faults(0, "conn-id-overflow") == 3, "overflow: counted");
  check(p->set->faults(0, "event-order") == 0, "overflow: no event-order fault for the absorbed close");
  // The largest valid local works and namespaces without touching the index bits.
  check(p->b.connect(GRC_CARRIER_LOCAL_MAX), "overflow: local 2^24-1 admitted");
  const std::vector<Event> ok = p->set->take_events();
  check(ok.size() == 1 && ok[0].conn == (kB | GRC_CARRIER_LOCAL_MAX), "overflow: 2^24-1 namespaced");
  // Opened without a granted admit is the same kind of refusal.
  p->a.opened(5);
  check(p->set->take_events().empty() && p->set->faults(0, "opened-without-admit") == 1,
        "opened without admit: refused and counted");
}

void test_stop_and_ledger() {
  auto p = make_fakes(4, CarrierSet::Sabotage::None);
  auto *fa = static_cast<AbiCarrier *>(p->set->carrier(0));
  p->a.connect(1);
  p->a.hold = true;
  p->set->take_events();
  check(p->set->send_binary(1, {1, 2, 3, 4}), "ledger: send accepted");
  check(p->set->send_text(1, "held"), "ledger: text accepted");
  check(fa->outstanding_buffers() == 2, "ledger: two buffers held by the carrier");
  check(!p->set->send_binary(99, {1}), "ledger: send to an unknown local fails");
  check(fa->outstanding_buffers() == 2, "ledger: ...and its buffer is released");
  p->a.closed(1);
  check(p->set->take_events().size() == 1, "stop: the Closed before stop is drained");
  p->set->stop();
  check(p->a.stopped, "stop: carrier stopped");
  check(fa->outstanding_buffers() == 0, "ledger: every buffer released by stop");
  check(p->set->faults(0, "buffer-held-after-stop") == 0, "ledger: no buffer-held-after-stop fault");
  // No callback after stop: everything is ignored and counted.
  p->a.opened(3);
  p->a.text(3, "x");
  check(fa->late_callbacks() == 2, "stop: late callbacks counted");
  check(fa->take_events().empty(), "stop: late callbacks queue nothing");
  check(p->set->take_events().empty(), "stop: the set reports nothing after stop");
  check(p->set->faults(0, "callback-after-stop") == 2, "stop: callback-after-stop faults");
  check(!p->set->send_binary(1, {1}), "stop: sends refused after stop");
  check(p->set->admitted() == 0, "stop: no slot left held");
  p->set.reset();
  check(p->a.destroyed == 1 && p->b.destroyed == 1, "destroy: each carrier destroyed once");
}

struct MapSource final : grc::live::ResourceSource {
  std::map<std::string, std::shared_ptr<const std::vector<std::uint8_t>>> bodies;
  std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) override {
    auto it = bodies.find(std::string(hash));
    return it == bodies.end() ? nullptr : it->second;
  }
};

void test_resources_and_services() {
  MapSource source;
  const std::string h(64, 'a');
  source.bodies[h] = std::make_shared<const std::vector<std::uint8_t>>(std::vector<std::uint8_t>{5, 6, 7});
  CarrierServices s;
  s.resources = &source;
  s.auth_token = "secret";
  // CAR8: a portless entry parses and is matched exactly -- the same check rs-net's wt calls.
  std::string origin_error;
  check(grc::live::parse_allowed_origins("http://127.0.0.1:8080,https://example.com", &s.allowed_origins, &origin_error),
        "portless origin parses");
  s.config["listen"] = "127.0.0.1:0";
  auto p = make_fakes(4, CarrierSet::Sabotage::None, s);
  const grc_carrier_host_v1 *host = p->b.host;
  auto *fb = static_cast<AbiCarrier *>(p->set->carrier(2));
  check(host->abi_version == GRC_CARRIER_ABI_VERSION && host->size == sizeof(grc_carrier_host_v1),
        "host: version and size");
  check(host->config(host->host, "listen") != nullptr &&
            std::string(host->config(host->host, "listen")) == "127.0.0.1:0",
        "host: config value");
  check(host->config(host->host, "tls_cert") == nullptr, "host: unset config is NULL");
  check(host->token_ok(host->host, "secret", 6) == 1, "host: right token");
  check(host->token_ok(host->host, "secreT", 6) == 0, "host: wrong token");
  check(host->origin_ok(host->host, "", 0) == 1, "host: no origin");
  check(host->origin_ok(host->host, "http://127.0.0.1:8080", 21) == 1, "host: allowed origin");
  check(host->origin_ok(host->host, "http://evil:1", 13) == 0, "host: foreign origin");
  check(host->origin_ok(host->host, "https://example.com", 19) == 1, "host: portless allowed origin");
  check(host->origin_ok(host->host, "https://example.com:443", 23) == 0, "host: portless entry is exact");
  grc_buf buf{};
  check(host->lookup(host->host, h.data(), GRC_CODING_IDENTITY, &buf) == 1 && buf.len == 3 &&
            buf.data[0] == 5,
        "host: lookup found");
  grc_buf coded{};
  check(host->lookup(host->host, h.data(), GRC_CODING_GZIP, &coded) == 0,
        "host: a coding the source does not hold misses (serve identity)");
  check(fb->outstanding_buffers() == 1, "host: lookup buffer counted");
  host->release(host->host, buf.owner);
  check(fb->outstanding_buffers() == 0, "host: lookup buffer released");
  const std::string miss(64, 'b');
  check(host->lookup(host->host, miss.data(), GRC_CODING_IDENTITY, &buf) == 0, "host: lookup miss");
  host->resource_served(host->host, 4, h.data(), 200, GRC_CODING_GZIP, 3, 2);
  host->rejected(host->host, 5, GRC_REJECT_AUTH, "", 0);
  host->rejected(host->host, 6, GRC_REJECT_ORIGIN, "http://evil:1", 13);
  const std::vector<Event> ev = p->set->take_events();
  check(ev.size() == 3, "resources: three events");
  if (ev.size() == 3) {
    check(ev[0].kind == Event::HttpGet && ev[0].method == "GET" && ev[0].route == "resource" &&
              ev[0].hash == h && ev[0].http_status == 200 && ev[0].bytes == 3 &&
              ev[0].coding == "gzip" && ev[0].coded_bytes == 2 && ev[0].carrier == "fb",
          "resources: resource_served is an HttpGet event");
    check(ev[1].kind == Event::AuthRejected && ev[1].http_status == 401, "rejected auth: 401");
    check(ev[2].kind == Event::OriginRejected && ev[2].http_status == 403 &&
              ev[2].origin == "http://evil:1" && ev[2].route == "upgrade",
          "rejected origin: 403 with the origin");
  }
  const std::string json = p->set->carriers_json();
  check(json.find("\"schema\":\"render-stream-live-carriers/1\"") != std::string::npos &&
            json.find("\"name\":\"fb\",\"index\":2,\"status\":\"listening\"") != std::string::npos &&
            json.find("\"resource_gets\":1") != std::string::npos &&
            json.find("\"abi_version\":1,\"module_version\":null") != std::string::npos,
        "live-carriers.json: " + json);
}

void test_start_failure() {
  Fake a("fa");
  Fake b("fb");
  b.fail_start = true;
  CarrierSet set(1, CarrierServices());
  std::string error;
  check(set.add(0, adopt(a), &error), "add");
  check(set.add(2, adopt(b), &error), "add");
  check(!set.add(2, adopt(b), &error), "add: a taken index refused");
  check(set.start(&error), "start: one failed carrier does not stop the others");
  check(set.started(0) && !set.started(2), "start: per-carrier state");
  check(set.carriers_json().find("\"status\":\"failed\",\"error\":\"bind failed\"") != std::string::npos,
        "start: the failure is recorded");
  Fake c("fc");
  check(!set.add(3, adopt(c), &error) && error == "carrier-late", "add after start: carrier-late");

  Fake only("fo");
  only.fail_start = true;
  CarrierSet lone(1, CarrierServices());
  check(lone.add(0, adopt(only), &error), "add");
  check(!lone.start(&error) && error == "bind failed", "start: the only carrier failing fails");

  Fake bad("bad");
  bad.vt.abi_version = 2;
  check(AbiCarrier::adopt(&bad.vt, &error) == nullptr, "adopt: abi_version 2 refused");
  Fake small("small");
  small.vt.size = sizeof(grc_carrier_v1) - 8;
  check(AbiCarrier::adopt(&small.vt, &error) == nullptr, "adopt: short struct refused");
  Fake upper("Upper");
  check(AbiCarrier::adopt(&upper.vt, &error) == nullptr, "adopt: malformed name refused");
  Fake hole("hole");
  hole.vt.close = nullptr;
  check(AbiCarrier::adopt(&hole.vt, &error) == nullptr, "adopt: null entry point refused");
  Fake big("big");
  big.vt.size = sizeof(grc_carrier_v1) + 16;  // a later v1 that grew: accepted
  auto adopted = AbiCarrier::adopt(&big.vt, &error);
  check(adopted != nullptr, "adopt: a grown v1 struct accepted");
}

void test_carrier_list() {
  std::vector<std::string> names;
  std::string error;
  check(grc::live::parse_carrier_list(nullptr, &names, &error) && names == std::vector<std::string>{"ws"},
        "carriers: unset is ws");
  check(grc::live::parse_carrier_list("ws", &names, &error) && names == std::vector<std::string>{"ws"},
        "carriers: ws");
  check(grc::live::parse_carrier_list(" ws , wt,my-carrier1", &names, &error) &&
            names == std::vector<std::string>{"ws", "wt", "my-carrier1"},
        "carriers: list with spaces");
  for (const char *bad : {"", ",", "ws,", "ws,ws", "WS", "ws;wt", "abcdefghijklmnopq", "w s"}) {
    error.clear();
    check(!grc::live::parse_carrier_list(bad, &names, &error) && error.rfind("carriers-invalid", 0) == 0,
          std::string("carriers: refused \"") + bad + "\" (" + error + ")");
  }
}

// ------------------------------------------------------------------- ws: the real rs_ws server

int connect_upgrade(std::uint16_t port, int *status) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  ::inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
    ::close(fd);
    *status = -1;
    return -1;
  }
  const std::string req =
      "GET /render-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
      "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: render-stream.1\r\n\r\n";
  if (::send(fd, req.data(), req.size(), 0) != static_cast<ssize_t>(req.size())) {
    *status = -1;
  }
  std::string head;
  char ch;
  while (head.find("\r\n\r\n") == std::string::npos && ::recv(fd, &ch, 1, 0) == 1) head.push_back(ch);
  *status = head.size() > 12 ? std::atoi(head.substr(9, 3).c_str()) : -1;
  return fd;
}

std::vector<Event> wait_events(CarrierSet &set, std::size_t n, int timeout_ms) {
  std::vector<Event> out;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (out.size() < n && std::chrono::steady_clock::now() < deadline) {
    for (Event &e : set.take_events()) out.push_back(std::move(e));
    if (out.size() < n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return out;
}

void test_ws_shares_admission() {
  Fake b("fb");
  CarrierSet set(1, CarrierServices());
  grc::live::ServerConfig config;
  config.max_clients = 4;  // ignored: the set's total (1) decides
  auto ws = std::make_unique<grc::live::WsCarrier>(config, nullptr, 500);
  grc::live::WsCarrier *wsp = ws.get();
  std::string error;
  check(set.add(grc::live::kCarrierWs, std::move(ws), &error), "ws: add");
  check(set.add(2, adopt(b), &error), "ws: add fb");
  check(set.start(&error), "ws: start " + error);
  check(b.connect(1), "ws: fb takes the one slot");
  int status = 0;
  int fd = connect_upgrade(wsp->port(), &status);
  check(status == 503, "ws: upgrade refused 503 while fb holds the slot (got " + std::to_string(status) + ")");
  if (fd >= 0) ::close(fd);
  b.closed(1);
  set.take_events();
  fd = connect_upgrade(wsp->port(), &status);
  check(status == 101, "ws: upgrade accepted once the slot returned (got " + std::to_string(status) + ")");
  std::vector<Event> ev = wait_events(set, 1, 2000);
  check(ev.size() == 1 && ev[0].kind == Event::Opened && ev[0].carrier == "ws" &&
            (ev[0].conn >> 24) == 0 && ev[0].conn != 0,
        "ws: Opened with an index-0 id and carrier ws");
  const std::uint32_t conn = ev.empty() ? 0 : ev[0].conn;
  check(b.admit(2) == 0, "ws: fb refused while ws holds the slot");
  check(set.send_text(conn, "hi"), "ws: send through the set");
  ::close(fd);
  ev = wait_events(set, 1, 2000);
  check(ev.size() == 1 && ev[0].kind == Event::Closed && ev[0].conn == conn, "ws: Closed");
  check(set.admitted() == 0, "ws: the slot returned at Closed");
  check(set.carriers_json().find("\"name\":\"ws\",\"index\":0,\"status\":\"listening\",\"error\":null,"
                                 "\"address\":\"127.0.0.1\",\"port\":" +
                                 std::to_string(wsp->port()) +
                                 ",\"transport\":\"tcp\",\"tls\":\"none\",\"cert_sha256\":null,"
                                 "\"abi_version\":null") != std::string::npos,
        "ws: live-carriers.json entry");
  set.stop();
}

}  // namespace

int main() {
  test_routing_and_sabotage();
  test_admission_and_sabotage();
  test_unknown_index();
  test_event_order();
  test_conn_id_overflow();
  test_stop_and_ledger();
  test_resources_and_services();
  test_start_failure();
  test_carrier_list();
  test_ws_shares_admission();
  std::printf("rs_carrier_set_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
