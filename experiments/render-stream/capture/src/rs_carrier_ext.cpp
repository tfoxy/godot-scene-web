#define GRC_CARRIER_BUILD
#include "rs_platform.h"
// rs_carrier_ext: see rs_carrier_ext.h (CAR6).
#include "rs_carrier_ext.h"

#include <cstring>
#include <utility>

#include "rs_carrier_set.h"

namespace grc {
namespace live {

int CarrierRegistry::add(const grc_carrier_v1 *carrier, std::string *why) {
  std::string name;
  std::string reason;
  int index = -1;
  std::lock_guard<std::mutex> lock(mu_);
  if (carrier == nullptr) {
    reason = "carrier-abi: null carrier";
  } else if (carrier->abi_version != GRC_CARRIER_ABI_VERSION ||
             carrier->size < sizeof(grc_carrier_v1)) {
    // Nothing past abi_version and size is read from a struct whose size is not accepted.
    reason = "carrier-abi: abi_version " + std::to_string(carrier->abi_version) + " size " +
             std::to_string(carrier->size) + " (want version " +
             std::to_string(GRC_CARRIER_ABI_VERSION) + ", size >= " +
             std::to_string(sizeof(grc_carrier_v1)) + ")";
  } else {
    if (carrier->name != nullptr) {
      // Bounded: a name longer than 16 bytes is malformed whatever follows it.
      const std::size_t n = strnlen(carrier->name, 17);
      name.assign(carrier->name, n);
    }
    if (carrier->name == nullptr || !carrier_name_ok(name)) {
      reason = "carrier-name: not [a-z0-9-]{1,16}";
    } else if (name == "ws" || name == "wt") {
      reason = "carrier-reserved: " + name + " is a built-in carrier";
    } else if (carrier->start == nullptr || carrier->stop == nullptr ||
               carrier->send_binary == nullptr || carrier->send_text == nullptr ||
               carrier->close == nullptr || carrier->queued_bytes == nullptr ||
               carrier->max_queued_bytes == nullptr || carrier->destroy == nullptr) {
      reason = "carrier-abi: a null entry point";
    } else if (closed_) {
      reason = "carrier-late: live has started; register before the capture arms";
    } else {
      for (const RegisteredCarrier &c : carriers_) {
        if (c.name == name) reason = "carrier-taken: " + name + " is registered already";
      }
      if (reason.empty() && next_index_ > 255) reason = "carrier-full: indexes 2..255 are used";
    }
  }
  if (reason.empty()) {
    RegisteredCarrier r;
    r.index = static_cast<std::uint8_t>(next_index_++);
    r.name = name;
    std::memcpy(&r.vtable, carrier, sizeof(grc_carrier_v1));
    r.vtable.size = sizeof(grc_carrier_v1);  // only v1's fields were copied
    index = r.index;
    carriers_.push_back(std::move(r));
    if (log_) log_("carrier-register: " + name + " -> index " + std::to_string(index));
  } else {
    refusals_.push_back((name.empty() ? std::string("<unnamed>") : name) + ": " + reason);
    if (log_) log_("carrier-register: refused " + refusals_.back());
  }
  if (why != nullptr) *why = reason;
  return index;
}

std::vector<RegisteredCarrier> CarrierRegistry::close() {
  std::lock_guard<std::mutex> lock(mu_);
  closed_ = true;
  std::vector<RegisteredCarrier> out;
  out.swap(carriers_);
  return out;
}

bool CarrierRegistry::closed() const {
  std::lock_guard<std::mutex> lock(mu_);
  return closed_;
}

bool CarrierRegistry::has(const std::string &name) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (closed_) return false;
  for (const RegisteredCarrier &c : carriers_) {
    if (c.name == name) return true;
  }
  return false;
}

std::vector<std::string> CarrierRegistry::refusals() const {
  std::lock_guard<std::mutex> lock(mu_);
  return refusals_;
}

void CarrierRegistry::set_log(std::function<void(const std::string &)> log) {
  std::lock_guard<std::mutex> lock(mu_);
  log_ = std::move(log);
}

void CarrierRegistry::reopen() {
  std::vector<RegisteredCarrier> dropped;
  std::function<void(const std::string &)> log;
  {
    std::lock_guard<std::mutex> lock(mu_);
    dropped.swap(carriers_);
    closed_ = false;
    next_index_ = 2;
    refusals_.clear();
    log = log_;
  }
  for (auto &carrier : dropped) {
    carrier.vtable.destroy(carrier.vtable.self);
    if (log) log("carrier-register: dropped at reopen: " + carrier.name);
  }
}

void CarrierRegistry::reset_for_test() {
  std::lock_guard<std::mutex> lock(mu_);
  closed_ = false;
  next_index_ = 2;
  carriers_.clear();
  refusals_.clear();
}

CarrierRegistry &carrier_registry() {
  static CarrierRegistry registry;
  return registry;
}

}  // namespace live
}  // namespace grc

// The public entry point (grc_carrier.h). The capture's only exported symbols are this and
// grc_library_init; consumers find it with dlsym on the capture library's handle.
extern "C" GRC_EXPORT int grc_carrier_register(
    const grc_carrier_v1 *carrier) {
  return grc::live::carrier_registry().add(carrier, nullptr);
}
