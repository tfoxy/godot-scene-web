#include "rs_platform.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iterator>
#include <thread>

#ifndef _WIN32
#include <netinet/in.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#else
#include <process.h>
#endif

using namespace grc::rs;
namespace {
int total = 0, passed = 0;
void check(bool ok, const char *name) {
  ++total;
  if (ok)
    ++passed;
  else
    std::fprintf(stderr, "FAIL %s\n", name);
}
std::string read(const std::string &path) {
  std::ifstream in(fs_path(path), std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
void spin(std::chrono::milliseconds duration) {
  const auto end = std::chrono::steady_clock::now() + duration;
  while (std::chrono::steady_clock::now() < end) {
  }
}
void set_env(const char *name, const char *value) {
#ifndef _WIN32
  if (value)
    ::setenv(name, value, 1);
  else
    ::unsetenv(name);
#else
  (void)name;
  _wputenv_s(L"GRC_PLATFORM_TEST_ENV", value ? (value[0] ? L"value" : L"") : L"");
#endif
}
} // namespace

int main() {
  std::array<unsigned char, 32> a{}, b{};
  check(fill_random(a.data(), a.size()) && fill_random(b.data(), b.size()), "fill_random");
  check(std::any_of(a.begin(), a.end(), [](auto v) { return v != 0; }), "random nonzero");
  check(a != b, "random distinct");
  check(rss_bytes() > 0, "rss_bytes");
#ifndef _WIN32
  check(!private_bytes(), "private_bytes unavailable on POSIX");
#else
  check(private_bytes().value_or(0) > 0, "private_bytes");
#endif
  ThreadCpuClock clock;
  check(clock.arm(), "cpu clock arm");
  spin(std::chrono::milliseconds(2));
  const auto start = clock.now_ns();
  spin(std::chrono::milliseconds(20));
  check(start >= 0 && clock.now_ns() - start >= 1000000, "cpu clock grows at least 1 ms");
  check(std::abs(wall_clock_s() - static_cast<std::int64_t>(std::time(nullptr))) <= 2,
        "wall_clock_s");
#ifdef _WIN32
  check(executable_path().ends_with("rs_platform_test.exe"), "executable_path");
#else
  check(executable_path().ends_with("rs_platform_test"), "executable_path");
  check(module_path_of(reinterpret_cast<const void *>(&std::printf)).find("libc.so") !=
            std::string::npos,
        "module_path_of");
#endif
  std::string error;
  check(!library_open("grc-no-such-library", &error) && !error.empty(), "library_open missing");
#ifdef _WIN32
  auto *loaded = library_loaded("kernel32.dll");
  const auto dll_path = module_path_of(library_symbol(loaded, "GetCurrentProcessId"));
  auto *lib = library_open(dll_path, &error);
  check(lib && library_symbol(lib, "GetCurrentProcessId"), "library_open and symbol");
  check(library_loaded("kernel32.dll"), "library_loaded");
  check(module_path_of(library_symbol(lib, "GetCurrentProcessId")).find('/') != std::string::npos,
        "module_path_of");
#else
  auto *lib = library_open("libc.so.6", &error);
  check(lib && library_symbol(lib, "getpid"), "library_open and symbol");
  check(library_loaded("libc.so.6"), "library_loaded");
#endif
  std::thread named([] {
    set_current_thread_name("platform-test");
#ifndef _WIN32
    const auto path = "/proc/self/task/" + std::to_string(::syscall(SYS_gettid)) + "/comm";
    check(read(path) == "platform-test\n", "thread name");
#endif
    set_current_thread_name("12345678901234567890");
#ifndef _WIN32
    check(read(path) == "123456789012345\n", "thread name truncated");
#endif
    lower_current_thread_priority();
#ifndef _WIN32
    check(::getpriority(PRIO_PROCESS, 0) >= 10, "thread priority");
#endif
  });
  named.join();

  const std::string root = GRC_TEST_TMP_DIR;
  std::filesystem::remove_all(fs_path(root));
  const auto nested = root + "/évidence-á/nested";
#ifndef _WIN32
  const auto mask = ::umask(0);
  ::umask(mask);
#endif
  check(make_directories(nested) && make_directories(nested),
        "make_directories nested and idempotent");
  check(is_directory(nested) && !make_directories(""), "is_directory and empty path");
#ifndef _WIN32
  struct stat st{};
  check(::stat(nested.c_str(), &st) == 0 && (st.st_mode & 0777) == (0775 & ~mask),
        "directory mode");
#endif
  const auto file = root + "/évidence-á/ñ.json";
  auto *out = open_file(file, "wb");
  check(out != nullptr, "open_file UTF-8");
  if (out) {
    check(std::fwrite("before", 1, 6, out) == 6, "write UTF-8 path");
    std::fclose(out);
  }
  check(read(file) == "before", "UTF-8 path round trip");
  check(!make_directories(file + "/child") && !is_directory(file),
        "directory through regular file fails");
  const auto source = root + "/source";
  check(write_private_file(source, "replacement"), "write_private_file");
  check(replace_file(source, file, &error) && read(file) == "replacement", "replace existing file");
  error.clear();
  check(!replace_file(source, file, &error) && !error.empty(), "replace missing source error");
#ifndef _WIN32
  ::chmod(file.c_str(), 0644);
#endif
  check(write_private_file(file, "private bytes") && read(file) == "private bytes",
        "private overwrite exact bytes");
#ifndef _WIN32
  check(::stat(file.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600, "private overwrite mode");
  ::chmod(file.c_str(), 0644);
#endif
  check(restrict_to_owner(file), "restrict_to_owner");
#ifndef _WIN32
  check(::stat(file.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600, "restrict mode");
#endif
  check(remove_file(file, &error), "remove_file");
  error.clear();
  check(!remove_file(file, &error) && !error.empty(), "remove missing error");

  std::string value;
  set_env("GRC_PLATFORM_TEST_ENV", nullptr);
  check(!env_utf8("GRC_PLATFORM_TEST_ENV", &value), "env unset");
  set_env("GRC_PLATFORM_TEST_ENV", "");
#ifndef _WIN32
  check(env_utf8("GRC_PLATFORM_TEST_ENV", &value) && value.empty(), "env empty");
#else
  // The Windows CRT removes variables assigned an empty string via _wputenv_s.
  check(!env_utf8("GRC_PLATFORM_TEST_ENV", &value), "env empty assignment unsets");
#endif
  set_env("GRC_PLATFORM_TEST_ENV", "value");
  check(env_utf8("GRC_PLATFORM_TEST_ENV", &value) && value == "value", "env set");
#ifdef _WIN32
  _wputenv_s(L"GRC_PLATFORM_TEST_ENV", L"évidence-á");
#else
  set_env("GRC_PLATFORM_TEST_ENV", "évidence-á");
#endif
  check(env_utf8("GRC_PLATFORM_TEST_ENV", &value) && value == "évidence-á", "env UTF-8");
  set_env("GRC_PLATFORM_TEST_ENV", nullptr);
#ifdef _WIN32
  check(process_id() == static_cast<std::uint32_t>(::_getpid()), "process_id");
  check(!open_file(std::string("\xff"), "rb"), "invalid UTF-8 path");
#else
  check(process_id() == static_cast<std::uint32_t>(::getpid()), "process_id");
  check(socket_error_text(ECONNREFUSED) == std::strerror(ECONNREFUSED), "socket_error_text");
#endif
  IpAddress ip{};
  check(parse_ip_literal("127.0.0.1", AddrFamily::IPv4, &ip), "parse IPv4");
  check(parse_ip_literal("::1", AddrFamily::IPv6, &ip), "parse IPv6");
  check(parse_ip_literal("0.0.0.0", AddrFamily::IPv4, &ip), "parse wildcard");
  check(!parse_ip_literal("localhost", AddrFamily::IPv4, &ip), "reject hostname");
  if (net_init(&error)) {
    SocketHandle listener = kInvalidSocket;
    std::uint16_t port = 0;
    const auto loopback = loopback_address(AddrFamily::IPv4);
    const bool listening =
        tcp_listen(loopback, 0, 16, WinBind::ExclusiveAddrUse, &listener, &port, &error);
    check(listening && port != 0, "tcp_listen ephemeral port");
    if (listening) {
#ifndef _WIN32
      int reuse = 0;
      socklen_t length = sizeof(reuse);
      check(::getsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, &length) == 0 && reuse == 1,
            "SO_REUSEADDR");
#endif
      const auto client = tcp_connect(loopback, port, &error);
      check(client != kInvalidSocket, "tcp_connect");
      PollEntry p{listener, kPollIn, 0};
      const bool ready = poll_sockets(&p, 1, 1000) == 1 && (p.revents & kPollIn);
      check(ready, "listener readable");
      const auto peer = ready ? tcp_accept(listener) : kInvalidSocket;
      check(peer != kInvalidSocket, "tcp_accept");
      if (client != kInvalidSocket && peer != kInvalidSocket) {
        check(set_nonblocking(peer), "set_nonblocking");
        set_tcp_nodelay(peer);
        check(socket_send(client, "hello", 5) == 5, "socket_send");
        p = {peer, kPollIn, 0};
        check(poll_sockets(&p, 1, 1000) == 1 && (p.revents & kPollIn), "peer readable");
        char buf[32]{};
        check(socket_recv(peer, buf, sizeof(buf)) == 5 && std::string(buf, 5) == "hello",
              "socket_recv");
        const auto n = socket_recv(peer, buf, sizeof(buf));
        const auto e = last_socket_error();
        check(n == -1 && e.kind == SockErr::WouldBlock, "nonblocking WouldBlock");
        socket_shutdown(client, ShutdownHow::Write);
        socket_shutdown(peer, ShutdownHow::Both);
      }
      socket_close(peer);
      socket_close(client);
      socket_close(listener);
    }
    Wake wake;
    const bool opened = wake_open(&wake, &error);
    check(opened, "wake_open");
    if (opened) {
      wake_signal(wake);
      PollEntry p{wake.poll_handle, kPollIn, 0};
      check(poll_sockets(&p, 1, 1000) == 1 && (p.revents & kPollIn), "wake readable");
      wake_drain(wake);
      p.revents = 0;
      check(poll_sockets(&p, 1, 0) == 0, "wake drained");
      wake_close(&wake);
      check(wake.poll_handle == kInvalidSocket && wake.write_handle == kInvalidSocket,
            "wake closed");
    }
    net_release();
  } else
    check(false, "net_init");
  std::filesystem::remove_all(fs_path(root));
  std::printf("rs_platform_test: %d/%d ok\n", passed, total);
  return passed == total ? 0 : 1;
}
