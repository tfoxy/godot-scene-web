#include "rs_platform.h"

#include <cstdio>
#include <cstring>
#include <set>
#include <string>

#if defined(_WIN32)
#include <winsock2.h>
#endif

int main(int argc, char **argv) {
  namespace rs = grc::rs;
  std::set<std::string> expected, failed;
#if defined(_WIN32)
  const bool sabotage = argc >= 2 && std::strcmp(argv[1], "--sabotage-wsastartup") == 0;
  if (sabotage && argc == 4 && std::strcmp(argv[2], "--expect-fail") == 0 &&
      std::strcmp(argv[3], "winsock-uninitialized") == 0) {
    expected.insert("winsock-uninitialized");
  } else if (argc != 1 && !(sabotage && argc == 2)) {
    std::fprintf(stderr, "usage: rs_capture_load_test [--sabotage-wsastartup "
                         "[--expect-fail winsock-uninitialized]]\n");
    return 2;
  }
  if (sabotage) {
    WSADATA data{};
    const int result = ::WSAStartup(MAKEWORD(2, 2), &data);
    std::printf("sabotage WSAStartup: result=%d\n", result);
    if (result != 0) return 1;  // A setup error cannot count as the expected failure.
  }
#else
  if (argc != 1) {
    std::fprintf(stderr, "usage: %s\n", argv[0]);
    return 2;
  }
#endif
  int checks = 0;
  auto check = [&](bool ok, const char *name) {
    ++checks;
    std::printf("%s %s\n", ok ? "ok" : "FAIL", name);
    if (!ok) failed.insert(name);
  };
  const auto executable = rs::executable_path();
  const auto separator = executable.find_last_of("/\\");
  if (separator == std::string::npos) {
    std::fprintf(stderr, "FAIL executable directory unavailable\n");
    return 1;
  }
  const auto path = executable.substr(0, separator + 1) +
                    rs::library_file_name("render_stream_capture");
  const auto threads_before = rs::thread_census();
#if !defined(_WIN32)
  const auto sockets_before = rs::fd_census();
#endif
  std::string error;
  void *library = rs::library_open(path, &error);
  if (!library) {
    std::fprintf(stderr, "FAIL library_open %s: %s\n", path.c_str(), error.c_str());
    return 1;
  }
  std::printf("loaded %s\n", path.c_str());
  // Resolve only. Calling either entry point would require a Godot host.
  check(rs::library_symbol(library, "grc_library_init") != nullptr, "grc_library_init");
  check(rs::library_symbol(library, "grc_carrier_register") != nullptr, "grc_carrier_register");
  const auto threads_after = rs::thread_census();
  const bool threads_available = threads_before && threads_after &&
                                 threads_before->total > 0 && threads_after->total > 0;
#if defined(_WIN32)
  check(threads_available, "census-available");
#else
  const auto sockets_after = rs::fd_census();
  check(threads_available && sockets_before && sockets_after &&
            sockets_before->fds > 0 && sockets_after->fds > 0,
        "census-available");
#endif
  std::printf("threads: before=%lld after=%lld\n",
              static_cast<long long>(threads_before ? threads_before->total : -1),
              static_cast<long long>(threads_after ? threads_after->total : -1));
  const bool threads_unchanged = threads_before && threads_after &&
                                 threads_before->total == threads_after->total;
  check(threads_unchanged, "threads-unchanged");
  if (!threads_available || !threads_unchanged) {
    const auto print_threads = [](const char *when, const auto &snapshot) {
      std::printf("thread ids %s:", when);
      if (!snapshot) {
        std::printf(" census unavailable");
      } else if (snapshot->ids.empty()) {
        std::printf(" ids not reported by platform census");
      } else {
        for (const auto id : snapshot->ids) std::printf(" %llu", static_cast<unsigned long long>(id));
      }
      std::printf("\n");
    };
    print_threads("before", threads_before);
    print_threads("after", threads_after);
  }
#if defined(_WIN32)
  const int result = ::WSACleanup();
  const int wsa_error = result == SOCKET_ERROR ? ::WSAGetLastError() : 0;
  std::printf("WSACleanup: result=%d error=%d (expected %d, %d)\n",
              result, wsa_error, SOCKET_ERROR, WSANOTINITIALISED);
  check(result == SOCKET_ERROR && wsa_error == WSANOTINITIALISED, "winsock-uninitialized");
#else
  std::printf("sockets: before=%lld after=%lld\n",
              static_cast<long long>(sockets_before ? sockets_before->sockets : -1),
              static_cast<long long>(sockets_after ? sockets_after->sockets : -1));
  check(sockets_before && sockets_after && sockets_before->sockets == sockets_after->sockets,
        "sockets-unchanged");
#endif
  std::printf("rs_capture_load_test: %d checks, %zu failures, %zu expected failures\n",
              checks, failed.size(), expected.size());
  if (failed != expected) {
    std::fprintf(stderr, "FAIL observed failures do not match expected failures\n");
    return 1;
  }
  return 0;
}
