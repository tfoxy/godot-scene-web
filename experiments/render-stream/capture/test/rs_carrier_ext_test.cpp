// the consumer-carrier registry
// (rs_carrier_ext.h), grc_carrier_register as the real capture library exports it, and the owner
// ledger that turns a double release into the fault `release-unknown` instead of a double free.
//
// argv[1]: the capture library (librender_stream_capture.so), loaded with dlopen as Godot loads
// it (RTLD_NOW, no RTLD_GLOBAL).
#include <dlfcn.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "grc_carrier.h"
#include "rs_carrier_ext.h"
#include "rs_carrier_set.h"

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const std::string &what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::printf("FAIL %s\n", what.c_str());
  }
}

// --- a minimal C carrier -------------------------------------------------------------------------

struct Fake {
  const grc_carrier_host_v1 *host = nullptr;
  int destroys = 0;
  bool release_twice = false;
  std::vector<grc_buf> held;
};

int f_start(void *self, const grc_carrier_host_v1 *host, char *, size_t) {
  static_cast<Fake *>(self)->host = host;
  return 1;
}
void f_stop(void *self) {
  Fake *f = static_cast<Fake *>(self);
  for (const grc_buf &b : f->held) f->host->release(f->host->host, b.owner);
  f->held.clear();
}
int f_send(void *self, uint32_t, grc_buf m) {
  Fake *f = static_cast<Fake *>(self);
  f->host->release(f->host->host, m.owner);
  if (f->release_twice) f->host->release(f->host->host, m.owner);  // the sabotage
  return 1;
}
void f_close(void *, uint32_t, uint16_t, const char *, size_t) {}
uint64_t f_queued(void *, uint32_t) { return 0; }
void f_destroy(void *self) { ++static_cast<Fake *>(self)->destroys; }

grc_carrier_v1 fake(Fake *f, const char *name) {
  grc_carrier_v1 vt;
  std::memset(&vt, 0, sizeof(vt));
  vt.abi_version = GRC_CARRIER_ABI_VERSION;
  vt.size = sizeof(vt);
  vt.name = name;
  vt.self = f;
  vt.start = &f_start;
  vt.stop = &f_stop;
  vt.send_binary = &f_send;
  vt.send_text = &f_send;
  vt.close = &f_close;
  vt.queued_bytes = &f_queued;
  vt.max_queued_bytes = &f_queued;
  vt.destroy = &f_destroy;
  return vt;
}

void registry_rules() {
  grc::live::CarrierRegistry r;
  Fake a;
  Fake b;
  std::string why;
  grc_carrier_v1 va = fake(&a, "mine");
  check(r.add(&va, &why) == 2, "registry: the first consumer carrier is index 2");
  grc_carrier_v1 vb = fake(&b, "other-1");
  check(r.add(&vb, &why) == 3, "registry: the next is index 3 (registration order)");
  check(r.has("mine") && r.has("other-1") && !r.has("nope"), "registry: has() by name");
  grc_carrier_v1 dup = fake(&a, "mine");
  check(r.add(&dup, &why) == -1 && why.rfind("carrier-taken", 0) == 0, "registry: a taken name");
  const auto refused = [&](grc_carrier_v1 vt, const char *code, const char *what) {
    std::string w;
    const int rc = r.add(&vt, &w);
    check(rc == -1 && w.rfind(code, 0) == 0, std::string("registry: ") + what + " (" + w + ")");
  };
  grc_carrier_v1 v = fake(&a, "x");
  v.abi_version = 2;
  refused(v, "carrier-abi", "abi_version 2");
  v = fake(&a, "x");
  v.size = sizeof(grc_carrier_v1) - 1;
  refused(v, "carrier-abi", "a size below sizeof(grc_carrier_v1)");
  v = fake(&a, "x");
  v.size = sizeof(grc_carrier_v1) + 64;  // a v1 struct that grew at its end: accepted
  check(r.add(&v, &why) == 4, "registry: a larger v1 struct is accepted");
  v = fake(&a, "y");
  v.destroy = nullptr;
  refused(v, "carrier-abi", "a null entry point");
  refused(fake(&a, "ws"), "carrier-reserved", "ws is reserved");
  refused(fake(&a, "wt"), "carrier-reserved", "wt is reserved");
  refused(fake(&a, "Upper"), "carrier-name", "an upper-case name");
  refused(fake(&a, "abcdefghijklmnopq"), "carrier-name", "a 17-character name");
  refused(fake(&a, ""), "carrier-name", "an empty name");
  check(r.add(nullptr, &why) == -1 && why.rfind("carrier-abi", 0) == 0, "registry: a null struct");
  check(r.refusals().size() == 10, "registry: every refusal recorded");
  // The capture copies the struct: a later change to the caller's copy changes nothing.
  va.name = "changed";
  std::vector<grc::live::RegisteredCarrier> got = r.close();
  check(got.size() == 3 && got[0].name == "mine" && got[0].index == 2 && got[1].index == 3 &&
            got[2].index == 4 && got[0].vtable.self == &a && got[2].vtable.size == sizeof(grc_carrier_v1),
        "registry: close hands over every registration in index order, copied");
  check(r.closed() && !r.has("mine"), "registry: closed");
  grc_carrier_v1 late = fake(&b, "late");
  check(r.add(&late, &why) == -1 && why.rfind("carrier-late", 0) == 0, "registry: carrier-late after close");
  check(r.close().empty(), "registry: a second close returns nothing");
  check(a.destroys == 0 && b.destroys == 0, "registry: neither a refusal nor the close destroys");
}

void registry_full() {
  grc::live::CarrierRegistry r;
  Fake f;
  std::vector<std::string> names;
  names.reserve(260);
  int last = 0;
  for (int i = 0; i < 254; ++i) {
    names.push_back("c" + std::to_string(i));
    grc_carrier_v1 vt = fake(&f, names.back().c_str());
    last = r.add(&vt, nullptr);
  }
  check(last == 255, "registry: the 254th consumer carrier is index 255");
  std::string why;
  grc_carrier_v1 vt = fake(&f, "one-more");
  check(r.add(&vt, &why) == -1 && why.rfind("carrier-full", 0) == 0, "registry: carrier-full");
}

void exported(const char *library) {
  void *handle = dlopen(library, RTLD_NOW);  // Godot's flags (drivers/unix/os_unix.cpp)
  check(handle != nullptr, std::string("export: dlopen the capture: ") + (handle ? "" : dlerror()));
  if (handle == nullptr) return;
  check(dlsym(RTLD_DEFAULT, "grc_carrier_register") == nullptr,
        "export: RTLD_DEFAULT does not see a library opened without RTLD_GLOBAL");
  void *again = dlopen(library, RTLD_NOW | RTLD_NOLOAD);
  check(again == handle, "export: dlopen(RTLD_NOLOAD) returns the loaded library's handle");
  auto fn = reinterpret_cast<grc_carrier_register_fn>(dlsym(again, "grc_carrier_register"));
  check(fn != nullptr, "export: grc_carrier_register is exported");
  check(dlsym(handle, "grc_library_init") != nullptr, "export: grc_library_init is exported");
  check(dlsym(handle, "_ZN3grc4live16carrier_registryEv") == nullptr,
        "export: the registry itself stays hidden");
  if (fn != nullptr) {
    Fake f;
    grc_carrier_v1 vt = fake(&f, "dl-mine");
    vt.abi_version = 7;
    check(fn(&vt) == -1, "export: a bad abi_version is refused");
    vt = fake(&f, "dl-mine");
    vt.size = 8;
    check(fn(&vt) == -1, "export: a bad size is refused");
    vt = fake(&f, "ws");
    check(fn(&vt) == -1, "export: ws is refused");
    vt = fake(&f, "dl-mine");
    check(fn(&vt) == 2, "export: a valid carrier is index 2 in the library's own registry");
    check(fn(&vt) == -1, "export: and the name is then taken");
  }
  dlclose(again);
  // The library stays loaded (a registered carrier holds pointers into this process); no dlclose.
}

// The owner ledger (AbiCarrier): a second release of one buffer is `release-unknown`, freed once.
void ledger(bool twice) {
  Fake f;
  f.release_twice = twice;
  grc_carrier_v1 vt = fake(&f, "ledger");
  std::string error;
  std::unique_ptr<grc::live::AbiCarrier> c = grc::live::AbiCarrier::adopt(&vt, &error);
  grc::live::AbiCarrier *raw = c.get();
  grc::live::CarrierSet set(4, grc::live::CarrierServices());
  check(set.add(2, std::move(c), &error), "ledger: add");
  check(set.start(&error), "ledger: start");
  const std::uint32_t conn = grc::live::carrier_conn(2, 1);
  check(f.host->admit(f.host->host, 1) == 1, "ledger: admit");
  f.host->opened(f.host->host, 1, "render-stream.7", 15, nullptr, 0);
  set.take_events();
  for (int i = 0; i < 3; ++i) set.send_binary(conn, std::vector<std::uint8_t>(100, 7));
  set.send_text(conn, "x");
  const std::uint64_t unknown = set.faults(2, "release-unknown");
  if (twice) {
    check(unknown == 4, "ledger sabotage: every second release is release-unknown (" +
                            std::to_string(unknown) + ")");
  } else {
    check(unknown == 0, "ledger: honest releases raise no fault");
    // A value the host never handed out frees nothing either.
    f.host->release(f.host->host, reinterpret_cast<void *>(static_cast<std::uintptr_t>(0xdead)));
    check(set.faults(2, "release-unknown") == 1, "ledger: a foreign owner is release-unknown");
  }
  check(raw->outstanding_buffers() == 0, "ledger: nothing outstanding");
  set.stop();
}

}  // namespace

int main(int argc, char **argv) {
  registry_rules();
  registry_full();
  if (argc > 1) {
    exported(argv[1]);
  } else {
    check(false, "export: no capture library given");
  }
  ledger(false);
  ledger(true);
  std::printf("rs_carrier_ext_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
