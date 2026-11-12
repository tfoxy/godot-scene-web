// Exercise the documented consumer lookup against the loaded capture, without an engine.
#include "grc_carrier.h"
#include "rs_platform.h"

#include <cstdio>
#include <filesystem>
#include <string>
#include <system_error>

#if defined(_WIN32)
#include <windows.h>
#endif

namespace {
int start(void *, const grc_carrier_host_v1 *, char *, size_t) { return 1; }
void stop(void *) {}
int send(void *, uint32_t, grc_buf) { return 1; }
void close(void *, uint32_t, uint16_t, const char *, size_t) {}
uint64_t queued(void *, uint32_t) { return 0; }
void destroy(void *) {}

grc_carrier_v1 carrier(const char *name) {
  grc_carrier_v1 vt{};
  vt.abi_version = GRC_CARRIER_ABI_VERSION;
  vt.size = sizeof(vt);
  vt.name = name;
  vt.start = start;
  vt.stop = stop;
  vt.send_binary = send;
  vt.send_text = send;
  vt.close = close;
  vt.queued_bytes = queued;
  vt.max_queued_bytes = queued;
  vt.destroy = destroy;
  return vt;
}

unsigned long lookup_error() {
#if defined(_WIN32)
  return ::GetLastError();
#else
  return 0;
#endif
}
}  // namespace

int main(int argc, char **argv) {
  namespace rs = grc::rs;
  if (argc != 2) {
    std::fprintf(stderr, "usage: rs_carrier_lookup_test <capture-library>\n");
    return 2;
  }
  int checks = 0, failed = 0;
  const std::string path = argv[1];
  auto check = [&](bool ok, const char *name, const std::string &detail = "") {
    ++checks;
    if (!ok) ++failed;
    std::printf("%s %s: %s %s\n", ok ? "ok  " : "FAIL", name, path.c_str(), detail.c_str());
  };
  const auto name = rs::library_file_name("render_stream_capture");
  check(rs::library_loaded(name) == nullptr, "unloaded-before", name);
  std::string error;
  void *opened = rs::library_open(path, &error);
  check(opened != nullptr, "open-capture", error);
  if (!opened) return 1;
  void *loaded = rs::library_loaded(name);
  const auto loaded_error = lookup_error();
  check(loaded != nullptr && loaded == opened, "loaded-handle",
        name + " (error " + std::to_string(loaded_error) + ")");
  if (!loaded) return 1;
  void *symbol = rs::library_symbol(loaded, "grc_carrier_register");
  const auto symbol_error = lookup_error();
  check(symbol != nullptr && symbol == rs::library_symbol(opened, "grc_carrier_register"), "register-symbol",
        "grc_carrier_register (error " + std::to_string(symbol_error) + ")");
  if (!symbol) return 1;
  const auto found = rs::module_path_of(symbol);
  const auto path_error = lookup_error();
  std::error_code ec;
  const bool same = std::filesystem::equivalent(rs::fs_path(found), rs::fs_path(path), ec);
  check(found.ends_with("/" + name) && same && !ec, "symbol-module-path",
        "module_path_of=" + found + " (error " + std::to_string(path_error) + "); equivalent: " +
            ec.message() + " (error " + std::to_string(ec.value()) + ")");
  const auto fn = reinterpret_cast<grc_carrier_register_fn>(symbol);
  auto vt = carrier("lookup-mine");
  vt.abi_version = 7;
  check(fn(&vt) == -1, "bad-abi-refused");
  vt = carrier("lookup-mine");
  vt.size = 8;
  check(fn(&vt) == -1, "bad-size-refused");
  vt = carrier("ws");
  check(fn(&vt) == -1, "ws-refused");
  vt = carrier("lookup-mine");
  check(fn(&vt) == 2, "valid-index-2");
  check(fn(&vt) == -1, "duplicate-name-refused");
  // Keep the capture mapped: its registry now owns pointers into this executable.
  std::printf("rs_carrier_lookup_test: %d/%d passed\n", checks - failed, checks);
  return failed ? 1 : 0;
}
