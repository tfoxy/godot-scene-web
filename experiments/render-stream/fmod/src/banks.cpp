#include "banks.hpp"
#include <algorithm>
#include <limits>
#include <stdexcept>
#ifdef GRC_FMOD_TEST_CALLBACKS
extern "C" void grc_test_callback_phase(int);
#endif
namespace grc::fmod {
namespace {
#ifdef GRC_FMOD_TEST_CALLBACKS
struct CallbackPhase {
  CallbackPhase() { grc_test_callback_phase(1); }
  ~CallbackPhase() { grc_test_callback_phase(0); }
};
#endif
}
struct Banks::Context {
  struct Slot {
    std::atomic<bool> opened{false};
    std::atomic_flag busy = ATOMIC_FLAG_INIT;
    std::uint64_t cursor = 0;
    void *source_file = nullptr;
  };
  Bank *bank = nullptr;
  Pck *pck = nullptr;
  const grc_fmod_bank_source_v1 *source = nullptr;
  Banks *owner = nullptr;
  Entry entry;
  std::array<Slot, 16> slots{};
  Slot *slot(void *handle) noexcept {
    const auto id = reinterpret_cast<std::uintptr_t>(handle);
    return id && id <= slots.size() ? &slots[id - 1] : nullptr;
  }
};
Banks::Banks(const grc_fmod_bank_source_v1 *source, const std::string &pck, const std::string &selected,
             void (*wake)(void *), void *wake_self) : wake_(wake), wake_self_(wake_self) {
  std::vector<Entry> entries;
  if (source) {
    source_ = *source;
    if (!source_.count || !source_.info || !source_.open || !source_.read || !source_.seek || !source_.close)
      throw std::runtime_error("bank-load");
    const auto count = source_.count(source_.self);
    if (!count || count > 1000000) throw std::runtime_error("bank-load");
    for (std::uint32_t i = 0; i < count; ++i) {
      Entry entry;
      const char *path = nullptr;
      std::size_t length = 0;
      if (source_.info(source_.self, i, &path, &length, entry.md5.data(), &entry.bytes) != 1 ||
          !path || !length || length > 4096 || entry.bytes > std::numeric_limits<unsigned>::max())
        throw std::runtime_error("bank-load");
      entry.path.assign(path, length);
      if (entry.path.find('\0') != std::string::npos) throw std::runtime_error("bank-load");
      entry.source_index = i;
      entries.push_back(std::move(entry));
    }
    auto ordered = entries;
    std::sort(ordered.begin(), ordered.end(), [](const auto &a, const auto &b) { return a.path < b.path; });
    for (std::size_t i = 1; i < ordered.size(); ++i)
      if (ordered[i - 1].path == ordered[i].path) throw std::runtime_error("bank-load");
  } else {
    pck_ = std::make_unique<Pck>(pck, selected);
    entries = pck_->entries();
  }
  hash_ = bankset_hash(entries);
  // Load metadata banks first, independent of the path order used by the digest.
  auto rank = [](const std::string &path) {
    if (path.ends_with("Master.strings.bank")) return 0;
    if (path.ends_with("Master.bank")) return 1;
    return 2;
  };
  std::sort(entries.begin(), entries.end(), [&](const auto &a, const auto &b) {
    const int ar = rank(a.path), br = rank(b.path);
    return ar != br ? ar < br : a.path < b.path;
  });
  for (auto &entry : entries) {
    auto context = std::make_unique<Context>();
    context->pck = pck_.get();
    context->source = source ? &source_ : nullptr;
    context->owner = this;
    context->entry = std::move(entry);
    contexts_.push_back(std::move(context));
  }
}
std::vector<std::string> Banks::paths() const {
  std::vector<std::string> out;
  for (const auto &context : contexts_) out.push_back(context->entry.path);
  return out;
}
Banks::~Banks() {
  for (auto &context : contexts_)
    for (auto &slot : context->slots)
      if (slot.opened.load() && context->source)
        context->source->close(context->source->self, slot.source_file);
}
void Banks::fail() noexcept {
  failed_.store(true, std::memory_order_release);
  if (wake_) wake_(wake_self_);
}
void Banks::load(Api &api, Studio *studio) {
  for (auto &context : contexts_) {
    BankInfo info{};
    info.size = sizeof(info);
    info.userdata = context.get();
    info.opencallback = &open;
    info.closecallback = &close;
    info.readcallback = &read;
    info.seekcallback = &seek;
    if (api.load_bank(studio, &info, 0, &context->bank) != ok) throw std::runtime_error("bank-load");
  }
}
void Banks::load_samples(Api &api, Studio *studio) {
  for (const auto &context : contexts_)
    if (api.load_samples(context->bank) != ok) throw std::runtime_error("bank-load");
  if (api.flush_samples(studio) != ok) throw std::runtime_error("bank-load");
}
Result GRC_NATIVE_CALL Banks::open(const char *, unsigned *size, void **file, void *userdata) noexcept {
#ifdef GRC_FMOD_TEST_CALLBACKS
  const CallbackPhase phase;
#endif
  if (!userdata || !size || !file) return 1;
  auto &context = *static_cast<Context *>(userdata);
  for (std::size_t i = 0; i < context.slots.size(); ++i) {
    auto &slot = context.slots[i];
    bool expected = false;
    if (!slot.opened.compare_exchange_strong(expected, true, std::memory_order_acquire)) continue;
    slot.cursor = 0;
    if (context.source && context.source->open(context.source->self, context.entry.source_index, &slot.source_file) != 1) {
      slot.opened.store(false, std::memory_order_release);
      context.owner->fail();
      return 1;
    }
    *size = static_cast<unsigned>(context.entry.bytes);
    *file = reinterpret_cast<void *>(i + 1);
    return ok;
  }
  return 1;
}
Result GRC_NATIVE_CALL Banks::close(void *file, void *userdata) noexcept {
#ifdef GRC_FMOD_TEST_CALLBACKS
  const CallbackPhase phase;
#endif
  if (!userdata) return 1;
  auto &context = *static_cast<Context *>(userdata);
  auto *slot = context.slot(file);
  if (!slot || slot->busy.test_and_set(std::memory_order_acquire)) return 1;
  const bool was_open = slot->opened.load(std::memory_order_acquire);
  if (was_open && context.source) context.source->close(context.source->self, slot->source_file);
  slot->opened.store(false, std::memory_order_release);
  slot->busy.clear(std::memory_order_release);
  return was_open ? ok : 1;
}
Result GRC_NATIVE_CALL Banks::read(void *file, void *buf, unsigned n, unsigned *got, void *userdata) noexcept {
#ifdef GRC_FMOD_TEST_CALLBACKS
  const CallbackPhase phase;
#endif
  if (got) *got = 0;
  if (!userdata || !got || (!buf && n)) return 1;
  auto &context = *static_cast<Context *>(userdata);
  auto *slot = context.slot(file);
  if (!slot || slot->busy.test_and_set(std::memory_order_acquire)) return 1;
  Result result = 1;
  if (slot->opened.load(std::memory_order_acquire)) {
    const auto wanted = static_cast<unsigned>(std::min<std::uint64_t>(n, context.entry.bytes - slot->cursor));
    const bool success = context.source
      ? context.source->read(context.source->self, slot->source_file, buf, wanted, got) == 1
      : context.pck->read(context.entry, slot->cursor, buf, wanted, *got);
    if (!success || *got > wanted) {
      *got = 0;
      context.owner->fail();
    } else {
      slot->cursor += *got;
      result = *got == n ? ok : file_eof;
    }
  }
  slot->busy.clear(std::memory_order_release);
  return result;
}
Result GRC_NATIVE_CALL Banks::seek(void *file, unsigned pos, void *userdata) noexcept {
#ifdef GRC_FMOD_TEST_CALLBACKS
  const CallbackPhase phase;
#endif
  if (!userdata) return 1;
  auto &context = *static_cast<Context *>(userdata);
  auto *slot = context.slot(file);
  if (!slot || slot->busy.test_and_set(std::memory_order_acquire)) return 1;
  Result result = 1;
  if (slot->opened.load(std::memory_order_acquire) && pos <= context.entry.bytes) {
    if (context.source && context.source->seek(context.source->self, slot->source_file, pos) != 1) {
      context.owner->fail();
    } else {
      slot->cursor = pos;
      result = ok;
    }
  }
  slot->busy.clear(std::memory_order_release);
  return result;
}
}
