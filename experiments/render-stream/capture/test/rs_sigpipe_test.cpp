// A consumed TCP reset leaves the next send at EPIPE. The production socket option must
// suppress SIGPIPE; the test-only build without it must die from SIGPIPE (shell status 141).
#include "rs_platform.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

namespace rs = grc::rs;
namespace {
int fail(const char *step) {
  std::fprintf(stderr, "peer-reset setup failed: %s (errno %d: %s)\n",
               step, errno, std::strerror(errno));
  return 2;
}
int reset_peer(rs::AddrFamily family, bool send_from_accepted) {
  // Do not let an inherited ignored or blocked signal hide the missing socket option.
  if (::signal(SIGPIPE, SIG_DFL) == SIG_ERR) return fail("reset SIGPIPE disposition");
  sigset_t signals;
  sigemptyset(&signals);  // a macro in Apple's signal.h, so never ::-qualified
  sigaddset(&signals, SIGPIPE);
  if (::sigprocmask(SIG_UNBLOCK, &signals, nullptr) != 0) return fail("unblock SIGPIPE");

  rs::SocketHandle listener = rs::kInvalidSocket;
  std::uint16_t port = 0;
  std::string error;
  const auto loopback = rs::loopback_address(family);
  if (!rs::tcp_listen(loopback, 0, 1, rs::kListenerWinBind, &listener, &port, &error)) return fail("listen");
  const auto connected = rs::tcp_connect(loopback, port, &error);
  if (connected == rs::kInvalidSocket) return fail("connect");
  rs::PollEntry ready{listener, rs::kPollIn, 0};
  if (rs::poll_sockets(&ready, 1, 5000) != 1 || !(ready.revents & rs::kPollIn)) return fail("accept readiness");
  const auto accepted = rs::tcp_accept(listener);
  if (accepted == rs::kInvalidSocket) return fail("accept");
  rs::socket_close(listener);
  const auto sender = send_from_accepted ? accepted : connected;
  const auto peer = send_from_accepted ? connected : accepted;
#ifdef __APPLE__
  int option = -1;
  socklen_t option_size = sizeof(option);
  if (::getsockopt(sender, SOL_SOCKET, SO_NOSIGPIPE, &option, &option_size) != 0) return fail("read SO_NOSIGPIPE");
  std::printf("SO_NOSIGPIPE=%d\n", option);
  std::fflush(stdout);
#endif
  const linger reset{1, 0};
  if (::setsockopt(peer, SOL_SOCKET, SO_LINGER, &reset, sizeof(reset)) != 0) return fail("set reset linger");
  rs::socket_close(peer);
  ready = {sender, rs::kPollIn, 0};
  if (rs::poll_sockets(&ready, 1, 5000) != 1) return fail("reset readiness");
  char byte = 0;
  if (rs::socket_recv(sender, &byte, 1) != -1 || errno != ECONNRESET) return fail("consume ECONNRESET");
  const auto result = rs::socket_send(sender, &byte, 1);
  const int error_code = errno;
  rs::socket_close(sender);
  if (result != -1 || error_code != EPIPE) return fail("send EPIPE");
  return 0;
}
} // namespace

int main(int argc, char **argv) {
  const bool expect_sigpipe = argc == 2 && std::strcmp(argv[1], "--expect-sigpipe") == 0;
  if (argc != 1 && !expect_sigpipe) return 2;
  int checks = 0, failures = 0;
  for (const auto family : {rs::AddrFamily::IPv4, rs::AddrFamily::IPv6}) {
    for (const bool accepted : {false, true}) {
      std::fflush(nullptr);
      const pid_t child = ::fork();
      if (child == -1) return fail("fork");
      if (child == 0) ::_exit(reset_peer(family, accepted));
      int status = 0;
      pid_t waited;
      do { waited = ::waitpid(child, &status, 0); } while (waited == -1 && errno == EINTR);
      if (waited != child) return fail("waitpid");
      const bool sigpipe = WIFSIGNALED(status) && WTERMSIG(status) == SIGPIPE;
      const bool clean = WIFEXITED(status) && WEXITSTATUS(status) == 0;
      const bool ok = expect_sigpipe ? sigpipe : clean;
      const int shell_status = WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status);
      ++checks;
      failures += !ok;
      std::printf("%s IPv%d %s reset: child status %d, expected %d\n", ok ? "ok" : "FAIL",
                  family == rs::AddrFamily::IPv4 ? 4 : 6, accepted ? "accepted" : "connected",
                  shell_status, expect_sigpipe ? 141 : 0);
    }
  }
  std::printf("rs_sigpipe_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
