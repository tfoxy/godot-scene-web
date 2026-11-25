#include "grc_fmod.h"
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <map>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <dlfcn.h>
namespace {
thread_local bool callback_phase = false;
std::atomic<unsigned> callback_allocations{0};
std::atomic<unsigned> logs{0};
std::atomic<bool> wrong_thread{false};
std::thread::id caller;
std::string source_mode;
std::atomic<unsigned> source_calls{0}, source_closes{0};
struct Cursor { bool used = false; unsigned pos = 0; } cursors[32];
void source_thread() {
  ++source_calls;
  if (std::this_thread::get_id() == caller) wrong_thread = true;
}
uint32_t source_count(void *) { source_thread(); return 2; }
int source_info(void *, uint32_t i, const char **path, size_t *len, uint8_t md5[16], uint64_t *bytes) {
  source_thread();
  if (source_mode == "source-info") return 0;
  *path = i ? "res://audio/Master.bank" : "res://audio/Master.strings.bank";
  *len = std::strlen(*path); *bytes = 8;
  for (unsigned n = 0; n < 16; ++n) md5[n] = n;
  return 1;
}
int source_open(void *, uint32_t, void **file) {
  source_thread();
  if (source_mode == "source-open") return 0;
  for (auto &cursor : cursors) if (!cursor.used) {
    cursor = {true, 0}; *file = &cursor; return 1;
  }
  return 0;
}
int source_read(void *, void *file, void *buf, uint32_t n, uint32_t *got) {
  source_thread();
  if (source_mode == "source-read") return 0;
  auto &cursor = *static_cast<Cursor *>(file);
  *got = std::min(n, 8 - cursor.pos);
  std::memcpy(buf, "abcdefgh" + cursor.pos, *got); cursor.pos += *got;
  if (source_mode == "source-overread") *got = n + 1;
  return 1;
}
int source_seek(void *, void *file, uint64_t pos) {
  source_thread();
  if (source_mode == "source-seek") return 0;
  static_cast<Cursor *>(file)->pos = static_cast<unsigned>(pos); return 1;
}
void source_close(void *, void *file) {
  source_thread(); ++source_closes;
  static_cast<Cursor *>(file)->used = false;
}
std::map<std::string, std::string> config_values;
void check(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
void *load(const char *path, int flags = RTLD_NOW | RTLD_LOCAL) {
  auto *lib = dlopen(path, flags);
  if (!lib) throw std::runtime_error(dlerror());
  return lib;
}
template<class T> T symbol(void *lib, const char *name) {
  auto out = reinterpret_cast<T>(dlsym(lib, name));
  check(out != nullptr, "missing test symbol"); return out;
}
const char *config(void *, const char *key) {
  if (std::this_thread::get_id() == caller) wrong_thread = true;
  auto found = config_values.find(key);
  return found == config_values.end() ? nullptr : found->second.c_str();
}
void log(void *, int, const char *message, size_t n) {
  if (std::this_thread::get_id() == caller) wrong_thread = true;
  ++logs;
  std::cerr.write(message, n); std::cerr << '\n';
}
}
extern "C" void grc_test_callback_phase(int enabled) { callback_phase = enabled != 0; }
void *operator new(std::size_t n) {
  if (callback_phase) ++callback_allocations;
  if (auto *p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void *p) noexcept { std::free(p); }
void operator delete(void *p, std::size_t) noexcept { std::free(p); }
void *operator new[](std::size_t n) { return ::operator new(n); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete[](void *p, std::size_t) noexcept { std::free(p); }
int main(int argc, char **argv) {
  try {
    check(argc >= 3, "native test arguments");
    caller = std::this_thread::get_id();
    const std::string mode(argv[2]);
    bool install = mode == "install";
    std::string expected, core, studio, pck;
    void *fake = nullptr;
    if (install) {
      const char *dir = std::getenv("GRC_FMOD_TEST_GAME_DIR");
      const char *reference = std::getenv("GRC_FMOD_TEST_REFERENCE");
      if (!dir || !*dir || !reference || !*reference) {
        std::cout << "SKIP native install: set GRC_FMOD_TEST_GAME_DIR and GRC_FMOD_TEST_REFERENCE\n";
        return 0;
      }
      check(std::filesystem::is_regular_file(std::filesystem::path(reference) / "manifest.json"), "missing reference manifest");
      core = (std::filesystem::path(dir) / "libfmod.so.14").string();
      studio = (std::filesystem::path(dir) / "libfmodstudio.so.14").string();
      for (const auto &entry : std::filesystem::directory_iterator(dir)) {
        if (entry.path().extension() == ".pck") {
          check(pck.empty(), "multiple PCK files: native test needs an unambiguous install");
          pck = entry.path().string();
        }
      }
      check(!pck.empty(), "install has no PCK");
      load(core.c_str(), RTLD_NOW | RTLD_GLOBAL);
      load(studio.c_str());
    } else {
      check(argc == 7, "fake test arguments");
      core = argv[3]; studio = argv[4]; pck = argv[5]; expected = argv[6];
      if (mode != "not-loaded") fake = load(core.c_str());
    }
    config_values = {{"core_lib", core}, {"studio_lib", studio}, {"pck_path", pck}};
    // The module is deliberately loaded only AFTER the simulated game's libraries.
    auto *module = load(argv[1]);
    auto get = symbol<int (*)(grc_fmod_v1 *)>(module, "grc_fmod_get_v1");
    check(get(nullptr) == 0, "null ABI output");
    grc_fmod_v1 api{};
    check(get(&api) == 1 && api.abi_version == 1 && api.size == sizeof(api) && api.self, "v1 table");
    grc_fmod_host_v1 host{1, sizeof(host), nullptr, config, nullptr, log};
    grc_fmod_bank_source_v1 source{1, sizeof(source), nullptr, source_count, source_info,
      source_open, source_read, source_seek, source_close};
    const bool supplied = mode.starts_with("source-");
    source_mode = mode;
    char error[128]{};
    const int result = api.start(api.self, &host, supplied ? &source : nullptr, error, sizeof(error));
    check(result == (expected.empty() ? 1 : 0), "unexpected start result");
    check(error == expected, "unexpected start reason");
    char reason[128]{};
    check(api.state(api.self, reason, sizeof(reason)) == result && reason == expected, "state differs from start");
    check(api.start(api.self, &host, supplied ? &source : nullptr, error, sizeof(error)) == result, "session latch");
    check(logs == (result ? 0u : 1u), "failure must log once");
    check(!wrong_thread, "host callback ran on product thread");
    check(callback_allocations == 0, "FMOD callback allocated");
    if (supplied) check(source_calls > 0, "source not called");
    if (supplied && result) check(source_closes == 34, "source closes missing");
    if (fake) {
      const auto count = symbol<unsigned (*)()>(fake, "fake_creates")();
      if (mode == "patch" || mode == "retry") check(count == 2, "version gate must retry Studio exactly once");
      if (mode == "outside") check(count == 1, "outside 2.03 reached Studio retry");
      if (result) check(symbol<unsigned (*)()>(fake, "fake_bank_loads")() == 2, "banks not loaded");
    }
    if (mode == "source-late") {
      source_mode = "source-read";
      std::thread([&] { symbol<void (*)()>(fake, "fake_late_read")(); }).join();
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      while (!logs.load() && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
      while (api.state(api.self, reason, sizeof(reason)) && std::chrono::steady_clock::now() < deadline)
        std::this_thread::yield();
      check(api.state(api.self, reason, sizeof(reason)) == 0 && std::string(reason) == "bank-load", "late callback did not latch off");
      check(logs == 1 && !wrong_thread, "late failure callback");
    }
    grc_fmod_buf index{};
    if (result && mode != "source-late") {
      check(api.take_index(api.self, &index) == 1 && index.owner && index.len, "index buffer");
      check(std::string(reinterpret_cast<const char *>(index.data), index.len).find("bankset") != std::string::npos, "index schema");
      uint8_t unknown_hash[32]{}; grc_fmod_buf missing{};
      check(api.take_get(api.self, unknown_hash, &missing) == 0 && !missing.owner, "unknown take");
    }
    api.stop(api.self);
    if (index.owner) {
      check(index.data[0] == '{', "stop invalidated buffer");
      std::thread([&] {api.release(api.self, index.owner); api.release(api.self, index.owner);}).join();
    }
    check(api.state(api.self, reason, sizeof(reason)) == 0, "stop must turn off immediately");
    check(api.start(api.self, &host, supplied ? &source : nullptr, error, sizeof(error)) == 0, "stop must latch");
    // No dlclose: this mirrors the host contract. The OS reclaims the worker.
    std::cout << "PASS native " << mode << ": start/state/stop, latch, callback thread and allocation guard\n";
  } catch (const std::exception &e) { std::cerr << "FAIL " << e.what() << '\n'; return 1; }
}
