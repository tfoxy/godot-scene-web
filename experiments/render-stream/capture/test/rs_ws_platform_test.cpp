#include "rs_platform.h"
#include "rs_ws.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <set>
#include <string>
#include <thread>

// Only the adversarial client uses native sockets, independently of tcp_listen.
#ifdef _WIN32
#include <winsock2.h>
#else
#include <netinet/in.h>
#include <sys/socket.h>
#endif

using namespace grc::rs;
using Clock = std::chrono::steady_clock;
namespace {
// A setup error must not masquerade as a refused bind.
bool client_bind_refused(std::uint16_t port) {
  const auto fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd == kInvalidSocket) return false;
  const int one = 1;
#ifdef _WIN32
  const int option = ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR,
                                 reinterpret_cast<const char *>(&one), sizeof(one));
  std::printf("port-steal client: Windows SO_REUSEADDR bind must fail\n");
#else
  const int option = ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  std::printf("port-steal client: Linux retains SO_REUSEADDR=1; second bind must fail\n");
#endif
  if (option != 0) {
    socket_close(fd);
    return false;
  }
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(port);
  const bool refused = ::bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0;
  const auto error = last_socket_error();
  std::printf("port-steal client: bind %s (%s)\n", refused ? "refused" : "succeeded",
              refused ? socket_error_text(error.code).c_str() : "port stolen");
  socket_close(fd);
  return refused;
}
const char *bind_name(WinBind candidate) {
  return candidate == WinBind::ExclusiveAddrUse ? "ExclusiveAddrUse" : "NoOption";
}
std::unique_ptr<grc::live::Server> make_server(WinBind candidate) {
  // Judge the production constructor; only the informational candidate overrides its policy.
  if (candidate == kListenerWinBind) return std::make_unique<grc::live::Server>();
  return std::make_unique<grc::live::Server>(candidate);
}
bool port_steal(WinBind candidate) {
  auto server = make_server(candidate);
  std::string error;
  if (!server->start({}, nullptr, &error)) {
    std::fprintf(stderr, "port-steal listener: %s\n", error.c_str());
    return false;
  }
  return client_bind_refused(server->port());
}
bool wake_latency() {
  Wake wake;
  std::string error;
  if (!wake_open(&wake, &error)) {
    std::fprintf(stderr, "wake-latency: %s\n", error.c_str());
    return false;
  }
  std::array<double, 20> elapsed{};
  int readable = 0;
  for (auto &ms : elapsed) {
    std::atomic<bool> ready{false};
    Clock::time_point answered;
    int result = -1;
    short events = 0;
    std::thread io([&] {
      PollEntry entry{wake.poll_handle, kPollIn, 0};
      ready.store(true, std::memory_order_release);
      // The idle listener's poll bound and drain-before-rearm order.
      result = poll_sockets(&entry, 1, 50);
      answered = Clock::now();
      events = entry.revents;
      if (events & kPollIn) wake_drain(wake);
    });
    while (!ready.load(std::memory_order_acquire)) std::this_thread::yield();
    // Exclude thread startup and let the idle loop enter poll.
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto signalled = Clock::now();
    wake_signal(wake);
    io.join();
    ms = std::chrono::duration<double, std::milli>(answered - signalled).count();
    if (result == 1 && (events & kPollIn) && ms >= 0) {
      ++readable;
    } else {
      // A timeout/error is a missed wake, never a fast answer. Score it at the poll bound.
      // Judge only the median so an individual scheduler stall cannot flake this case.
      ms = std::max(ms, 50.0);
    }
    wake_drain(wake); // Also remove a signal delivered after a poll timeout.
  }
  wake_close(&wake);
  std::sort(elapsed.begin(), elapsed.end());
  const double median = (elapsed[9] + elapsed[10]) / 2;
  std::printf("wake-latency: median %.6f ms (%d/20 readable; bound < 5 ms)\n", median,
              readable);
  return median < 5;
}
bool send_request(SocketHandle fd) {
  const std::string request =
      "GET /render-stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
      "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "Sec-WebSocket-Protocol: render-stream.1\r\n\r\n";
  std::size_t offset = 0;
  while (offset < request.size()) {
    const auto n = socket_send(fd, request.data() + offset, request.size() - offset);
    if (n <= 0) return false;
    offset += static_cast<std::size_t>(n);
  }
  return true;
}
bool rearm_rebind(WinBind candidate) {
  grc::live::ServerConfig config;
  config.max_clients = 2;
  std::array<SocketHandle, 2> clients{kInvalidSocket, kInvalidSocket};
  auto server = make_server(candidate);
  std::string error;
  if (!server->start(config, nullptr, &error)) {
    std::fprintf(stderr, "rearm-rebind listener: %s\n", error.c_str());
    return false;
  }
  const auto port = server->port();
  bool ok = true;
  for (auto &fd : clients) {
    fd = tcp_connect(loopback_address(AddrFamily::IPv4), port, &error);
    if (fd == kInvalidSocket || !send_request(fd)) ok = false;
  }
  int opened = 0;
  const auto deadline = Clock::now() + std::chrono::seconds(1);
  while (ok && opened < 2 && Clock::now() < deadline) {
    for (const auto &e : server->take_events())
      if (e.kind == grc::live::Event::Opened) ++opened;
    if (opened < 2) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ok &= opened == 2;
  std::printf("rearm-rebind: %d/2 live WebSockets before stop(2000) + destruction\n", opened);
  // Match the built-in carrier's disarm flush budget. Rebind is timed after stop returns.
  server->stop(2000);
  const auto start = Clock::now();
  server.reset(); // Release the listening socket through the product's destruction path.
  config.port = port;
  auto next = make_server(candidate);
  bool rebound = false;
  while (Clock::now() - start < std::chrono::seconds(1)) {
    if (next->start(config, nullptr, &error)) {
      rebound = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
  std::printf("rearm-rebind: %s in %.3f ms (bound < 1000 ms)%s%s\n",
              rebound ? "rebound" : "failed", ms, rebound ? "" : ": ",
              rebound ? "" : error.c_str());
  next->stop(0);
  for (auto fd : clients)
    if (fd != kInvalidSocket) socket_close(fd);
  return ok && rebound && ms < 1000;
}
} // namespace
int main(int argc, char **argv) {
  std::set<std::string> expected, failed;
  if (argc != 1) {
    if (argc != 3 || std::strcmp(argv[1], "--expect-fail") != 0 ||
        (std::strcmp(argv[2], "port-steal") != 0 &&
         std::strcmp(argv[2], "wake-latency") != 0)) {
      std::fprintf(stderr, "usage: rs_ws_platform_test [--expect-fail port-steal|wake-latency]\n");
      return 2;
    }
    expected.insert(argv[2]);
  }
  std::string error;
  if (!net_init(&error)) {
    std::fprintf(stderr, "%s\n", error.c_str());
    return 1;
  }
  auto check = [&](bool ok, const char *name) {
    std::printf("%s %s\n", ok ? "ok" : "FAIL", name);
    if (!ok) failed.insert(name);
  };
  const auto alternate = kListenerWinBind == WinBind::ExclusiveAddrUse
                             ? WinBind::NoOption : WinBind::ExclusiveAddrUse;
  std::printf("selected bind: %s; POSIX always retains SO_REUSEADDR=1\n",
              bind_name(kListenerWinBind));
  check(port_steal(kListenerWinBind), "port-steal");
  check(rearm_rebind(kListenerWinBind), "rearm-rebind");
  const bool alternate_steal = port_steal(alternate);
  const bool alternate_rearm = rearm_rebind(alternate);
  std::printf("info alternate %s: port-steal=%s rearm-rebind=%s (not judged)\n",
              bind_name(alternate), alternate_steal ? "pass" : "fail",
              alternate_rearm ? "pass" : "fail");
  check(wake_latency(), "wake-latency");
  net_release();
  std::printf("rs_ws_platform_test: %zu/3 passed, %zu expected failures\n",
              3 - failed.size(), expected.size());
  if (failed != expected) {
    std::fprintf(stderr, "FAIL observed failures do not match --expect-fail\n");
    return 1;
  }
  return 0;
}
