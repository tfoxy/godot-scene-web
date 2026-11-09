// rs_carrier_ext: consumer carriers registered through grc_carrier_register (CAR6,
//
// A consumer (a game, a mod, a native library, or a script through the RenderStreamCarrier
// class) registers a grc_carrier_v1 before live starts. The capture copies the struct, gives it
// the next free index in 2..255 (registration order, D5), and keeps it until live starts. At live
// start entry.cpp closes the registry: every registered carrier that GRC_LIVE_CARRIERS lists goes
// into the CarrierSet at its index (through AbiCarrier); every one it does not list is destroyed
// there and then, unstarted. After the close, grc_carrier_register returns -1 (`carrier-late`).
//
// Registration timing: live starts
// when the capture arms. A capture loaded at engine startup (the project's extension list) arms in
// its startup callback, after every autoload's _init(); a capture loaded at run time with
// GDExtensionManager.load_extension arms inside that call unless GRC_ARM_DEFER_FRAMES defers the
// arm to a later frame callback. A capture that never arms closes the registry at deinitialize.
//
// Ownership: a refused registration (-1) leaves the carrier with its caller; nothing is copied or
// called. An accepted one belongs to the capture, which calls its destroy() exactly once: after
// stop() for a started carrier, at the close for one never started, or at the reopen of an arm
// that failed before start.
//
// Threading: grc_carrier_register may be called from any thread; the registry is mutex-guarded.
// close() runs on the main thread.
#ifndef GRC_RS_CARRIER_EXT_H
#define GRC_RS_CARRIER_EXT_H

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "grc_carrier.h"

namespace grc {
namespace live {

// One accepted registration.
struct RegisteredCarrier {
  std::uint8_t index = 0;  // 2..255
  std::string name;
  grc_carrier_v1 vtable{};  // the v1 fields, copied; size is sizeof(grc_carrier_v1)
};

class CarrierRegistry {
 public:
  // grc_carrier_register's body: the carrier's index (2..255), or -1 with *why set to a typed
  // reason: `carrier-abi` (null struct, wrong abi_version, size below sizeof(grc_carrier_v1), or
  // a null entry point), `carrier-name` (not [a-z0-9-]{1,16}), `carrier-reserved` ("ws", "wt"),
  // `carrier-taken` (registered already), `carrier-full` (every index in 2..255 used) or
  // `carrier-late` (live already started).
  int add(const grc_carrier_v1 *carrier, std::string *why);

  // Closes registration (idempotent) and hands every registration over, in index order. The
  // caller owns what it gets: it adopts the carriers it starts and calls destroy() on the rest.
  // A second close returns nothing.
  std::vector<RegisteredCarrier> close();

  bool closed() const;
  // True when `name` is registered and the registry is still open. entry.cpp reads it while it
  // checks GRC_LIVE_CARRIERS, before close().
  bool has(const std::string &name) const;
  // Every refused registration since the start, as "<name>: <reason>" (for the live log).
  std::vector<std::string> refusals() const;

  // One log line per registration or refusal; set by entry.cpp (and the test host). May be
  // called from any thread, under the registry's lock.
  void set_log(std::function<void(const std::string &)> log);

  // LS3: a disarm reopens registration (the v1 carriers it held were destroyed after their stop,
  // as grc_carrier.h promises); indexes start again at 2.
  void reopen();
  // Tests only: forget everything (registrations are dropped without destroy()).
  void reset_for_test();

 private:
  mutable std::mutex mu_;
  bool closed_ = false;
  std::uint32_t next_index_ = 2;
  std::vector<RegisteredCarrier> carriers_;
  std::vector<std::string> refusals_;
  std::function<void(const std::string &)> log_;
};

// The process-wide registry grc_carrier_register writes to.
CarrierRegistry &carrier_registry();

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_CARRIER_EXT_H
