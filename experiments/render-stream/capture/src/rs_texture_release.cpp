// HTR: the pure half of the opt-in headless texture release (rs_texture_release.h).
#include "rs_texture_release.h"

#include <cstring>

namespace grc {
namespace rs {

void texture_release_set_placeholder(void *object) {
  detail::g_release_hot.placeholder.store(object, std::memory_order_release);
}

namespace {

std::atomic<std::int64_t> g_released{0};
std::atomic<std::int64_t> g_released_bytes{0};
std::atomic<std::int64_t> g_released_then_unheld{0};
std::atomic<std::int64_t> g_kept_adopted{0};
std::atomic<std::int64_t> g_kept_adopted_bytes{0};
std::atomic<std::int64_t> g_skipped_inactive{0};
std::atomic<std::int64_t> g_skipped_refused{0};
std::atomic<std::int64_t> g_skipped_format{0};
std::atomic<std::int64_t> g_skipped_omitted{0};
std::atomic<std::int64_t> g_release_ns_total{0};
std::atomic<std::int64_t> g_release_ns_max{0};
std::atomic<std::int64_t> g_timed_creates{0};
std::atomic<std::int64_t> g_hook_ns_total{0};
std::atomic<std::int64_t> g_hook_ns_max{0};
std::atomic<std::int64_t> g_forward_ns_total{0};

void store_max(std::atomic<std::int64_t> *slot, std::int64_t value) {
  std::int64_t seen = slot->load(std::memory_order_relaxed);
  while (value > seen && !slot->compare_exchange_weak(seen, value, std::memory_order_relaxed)) {
  }
}

bool is(const char *value, const char *word) { return std::strcmp(value, word) == 0; }

}  // namespace

bool parse_texture_release(const char *value, TextureReleaseMode *out, std::string *why) {
  if (value == nullptr || is(value, "") || is(value, "off") || is(value, "0")) {
    *out = TextureReleaseMode::Off;
    return true;
  }
  if (is(value, "on") || is(value, "1")) {
    *out = TextureReleaseMode::On;
    return true;
  }
  if (why != nullptr) {
    *why = std::string("invalid GRC_HEADLESS_TEXTURE_RELEASE=") + value + " (expected off or on)";
  }
  return false;
}

bool parse_texture_release_fault(const char *value, TextureReleaseFault *out, std::string *why) {
  if (value == nullptr || is(value, "")) {
    *out = TextureReleaseFault::None;
    return true;
  }
  if (is(value, "ignore-predicate")) {
    *out = TextureReleaseFault::IgnorePredicate;
    return true;
  }
  if (why != nullptr) {
    *why = std::string("invalid GRC_HEADLESS_TEXTURE_RELEASE_FAULT=") + value +
           " (expected ignore-predicate)";
  }
  return false;
}

const char *texture_release_fault_name(TextureReleaseFault fault) {
  return fault == TextureReleaseFault::IgnorePredicate ? "ignore-predicate" : "none";
}

TextureReleaseDecision resolve_texture_release(TextureReleaseMode mode,
                                               const std::string &display_server) {
  TextureReleaseDecision d;
  if (mode == TextureReleaseMode::Off) {
    return d;
  }
  if (display_server != "headless") {
    d.state = "ignored";
    d.reason = "not-headless";
    return d;
  }
  d.state = "active";
  return d;
}

void texture_release_configure(std::uint32_t flags) {
  for (std::atomic<std::int64_t> *c :
       {&g_released, &g_released_bytes, &g_released_then_unheld, &g_kept_adopted,
        &g_kept_adopted_bytes, &g_skipped_inactive, &g_skipped_refused, &g_skipped_format,
        &g_skipped_omitted, &g_release_ns_total, &g_release_ns_max, &g_timed_creates,
        &g_hook_ns_total, &g_hook_ns_max, &g_forward_ns_total}) {
    c->store(0, std::memory_order_relaxed);
  }
  detail::g_release_hot.flags.store(flags, std::memory_order_release);
}

void note_release_decision(ReleaseSkip skip, std::int64_t data_bytes, std::int64_t release_ns,
                           bool unheld) {
  switch (skip) {
    case ReleaseSkip::None:
      g_released.fetch_add(1, std::memory_order_relaxed);
      g_released_bytes.fetch_add(data_bytes > 0 ? data_bytes : 0, std::memory_order_relaxed);
      if (unheld) {
        g_released_then_unheld.fetch_add(1, std::memory_order_relaxed);
      }
      break;
    case ReleaseSkip::Inactive:
      g_skipped_inactive.fetch_add(1, std::memory_order_relaxed);
      break;
    case ReleaseSkip::Omitted:
      g_skipped_omitted.fetch_add(1, std::memory_order_relaxed);
      break;
    case ReleaseSkip::Format:
      g_skipped_format.fetch_add(1, std::memory_order_relaxed);
      break;
    case ReleaseSkip::Refused:
      g_skipped_refused.fetch_add(1, std::memory_order_relaxed);
      break;
  }
  if (release_ns >= 0) {
    g_release_ns_total.fetch_add(release_ns, std::memory_order_relaxed);
    store_max(&g_release_ns_max, release_ns);
  }
}

void note_kept_adopted(std::int64_t data_bytes) {
  g_kept_adopted.fetch_add(1, std::memory_order_relaxed);
  g_kept_adopted_bytes.fetch_add(data_bytes > 0 ? data_bytes : 0, std::memory_order_relaxed);
}

void note_release_timing(std::int64_t hook_ns, std::int64_t forward_ns) {
  g_timed_creates.fetch_add(1, std::memory_order_relaxed);
  g_hook_ns_total.fetch_add(hook_ns, std::memory_order_relaxed);
  store_max(&g_hook_ns_max, hook_ns);
  g_forward_ns_total.fetch_add(forward_ns, std::memory_order_relaxed);
}

ReleaseStats texture_release_stats() {
  ReleaseStats s;
  s.released = g_released.load(std::memory_order_relaxed);
  s.released_bytes = g_released_bytes.load(std::memory_order_relaxed);
  s.released_then_unheld = g_released_then_unheld.load(std::memory_order_relaxed);
  s.kept_adopted = g_kept_adopted.load(std::memory_order_relaxed);
  s.kept_adopted_bytes = g_kept_adopted_bytes.load(std::memory_order_relaxed);
  s.skipped_inactive = g_skipped_inactive.load(std::memory_order_relaxed);
  s.skipped_refused = g_skipped_refused.load(std::memory_order_relaxed);
  s.skipped_format = g_skipped_format.load(std::memory_order_relaxed);
  s.skipped_omitted = g_skipped_omitted.load(std::memory_order_relaxed);
  s.release_ns_total = g_release_ns_total.load(std::memory_order_relaxed);
  s.release_ns_max = g_release_ns_max.load(std::memory_order_relaxed);
  s.timed_creates = g_timed_creates.load(std::memory_order_relaxed);
  s.hook_ns_total = g_hook_ns_total.load(std::memory_order_relaxed);
  s.hook_ns_max = g_hook_ns_max.load(std::memory_order_relaxed);
  s.forward_ns_total = g_forward_ns_total.load(std::memory_order_relaxed);
  return s;
}

}  // namespace rs
}  // namespace grc
