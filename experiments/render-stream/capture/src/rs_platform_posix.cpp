#if defined(_WIN32)
#error "the POSIX platform layer cannot be built for Windows"
#endif
#include "rs_platform.h"

#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fstream>

namespace grc::rs {
namespace {
void fail(std::string *error, const char *op) {
  if (error)
    *error = std::string(op) + ": " + std::strerror(errno);
}
sockaddr_storage socket_address(const IpAddress &ip, std::uint16_t port, socklen_t *size) {
  sockaddr_storage storage{};
  if (ip.family == AddrFamily::IPv4) {
    auto *a = reinterpret_cast<sockaddr_in *>(&storage);
    a->sin_family = AF_INET;
    a->sin_port = htons(port);
    std::memcpy(&a->sin_addr, ip.bytes, 4);
    *size = sizeof(*a);
  } else {
    auto *a = reinterpret_cast<sockaddr_in6 *>(&storage);
    a->sin6_family = AF_INET6;
    a->sin6_port = htons(port);
    std::memcpy(&a->sin6_addr, ip.bytes, 16);
    *size = sizeof(*a);
  }
  return storage;
}
} // namespace
SocketError last_socket_error() {
  const int code = errno;
  return {code == 0                                 ? SockErr::None
          : (code == EAGAIN || code == EWOULDBLOCK) ? SockErr::WouldBlock
          : code == EINTR                           ? SockErr::Interrupted
                                                    : SockErr::Other,
          code};
}
std::string socket_error_text(int code) { return std::strerror(code); }
bool net_init(std::string *) { return true; }
void net_release() {}
bool parse_ip_literal(const std::string &text, AddrFamily family, IpAddress *out) {
  IpAddress addr;
  addr.family = family;
  if (::inet_pton(family == AddrFamily::IPv4 ? AF_INET : AF_INET6, text.c_str(), addr.bytes) != 1)
    return false;
  *out = addr;
  return true;
}
IpAddress loopback_address(AddrFamily family) {
  IpAddress addr;
  addr.family = family;
  if (family == AddrFamily::IPv4) {
    const auto loopback = htonl(INADDR_LOOPBACK);
    std::memcpy(addr.bytes, &loopback, 4);
  } else
    std::memcpy(addr.bytes, &in6addr_loopback, 16);
  return addr;
}
bool tcp_listen(const IpAddress &addr, std::uint16_t port, int backlog, WinBind, SocketHandle *out,
                std::uint16_t *bound_port, std::string *error) {
  socklen_t size;
  auto address = socket_address(addr, port, &size);
  const int family = addr.family == AddrFamily::IPv4 ? AF_INET : AF_INET6;
  const int fd = ::socket(family, SOCK_STREAM, 0);
  if (fd < 0) {
    fail(error, "socket");
    return false;
  }
  const int one = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  if (::bind(fd, reinterpret_cast<sockaddr *>(&address), size) != 0) {
    fail(error, "bind");
    ::close(fd);
    return false;
  }
  if (::listen(fd, backlog) != 0) {
    fail(error, "listen");
    ::close(fd);
    return false;
  }
  set_nonblocking(fd);
  sockaddr_storage bound{};
  socklen_t blen = sizeof(bound);
  ::getsockname(fd, reinterpret_cast<sockaddr *>(&bound), &blen);
  *bound_port = family == AF_INET ? ntohs(reinterpret_cast<sockaddr_in *>(&bound)->sin_port)
                                  : ntohs(reinterpret_cast<sockaddr_in6 *>(&bound)->sin6_port);
  *out = fd;
  return true;
}
SocketHandle tcp_accept(SocketHandle listener) {
  sockaddr_storage address{};
  socklen_t len = sizeof(address);
  return ::accept(listener, reinterpret_cast<sockaddr *>(&address), &len);
}
SocketHandle tcp_connect(const IpAddress &addr, std::uint16_t port, std::string *error) {
  socklen_t size;
  auto address = socket_address(addr, port, &size);
  const int fd = ::socket(addr.family == AddrFamily::IPv4 ? AF_INET : AF_INET6, SOCK_STREAM, 0);
  if (fd < 0) {
    fail(error, "socket");
    return kInvalidSocket;
  }
  if (::connect(fd, reinterpret_cast<sockaddr *>(&address), size) != 0) {
    fail(error, "connect");
    ::close(fd);
    return kInvalidSocket;
  }
  return fd;
}
bool set_nonblocking(SocketHandle s) {
  const int flags = ::fcntl(s, F_GETFL, 0);
  return flags >= 0 && ::fcntl(s, F_SETFL, flags | O_NONBLOCK) == 0;
}
void set_tcp_nodelay(SocketHandle s) {
  const int one = 1;
  ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
}
std::ptrdiff_t socket_send(SocketHandle s, const void *data, std::size_t size) {
  return ::send(s, data, size, MSG_NOSIGNAL);
}
std::ptrdiff_t socket_recv(SocketHandle s, void *data, std::size_t size) {
  return ::recv(s, data, size, 0);
}
void socket_shutdown(SocketHandle s, ShutdownHow how) {
  ::shutdown(s, how == ShutdownHow::Write ? SHUT_WR : SHUT_RDWR);
}
void socket_close(SocketHandle s) { ::close(s); }
static_assert(sizeof(PollEntry) == sizeof(pollfd) && alignof(PollEntry) == alignof(pollfd));
static_assert(offsetof(PollEntry, fd) == offsetof(pollfd, fd) &&
              offsetof(PollEntry, events) == offsetof(pollfd, events) &&
              offsetof(PollEntry, revents) == offsetof(pollfd, revents));
static_assert(kPollIn == POLLIN && kPollOut == POLLOUT && kPollErr == POLLERR &&
              kPollHup == POLLHUP && kPollNval == POLLNVAL);
int poll_sockets(PollEntry *entries, std::size_t count, int timeout_ms) {
  return ::poll(reinterpret_cast<pollfd *>(entries), count, timeout_ms);
}
bool wake_open(Wake *out, std::string *error) {
  int fds[2];
  if (::pipe(fds) != 0) {
    fail(error, "pipe");
    return false;
  }
  set_nonblocking(fds[0]);
  set_nonblocking(fds[1]);
  *out = {fds[0], fds[1]};
  return true;
}
void wake_signal(const Wake &w) {
  if (::write(w.write_handle, "\0", 1) < 0) { /* best effort */
  }
}
void wake_drain(const Wake &w) {
  std::uint8_t drain[256];
  while (::read(w.poll_handle, drain, sizeof(drain)) > 0) {
  }
}
void wake_close(Wake *w) {
  if (w->poll_handle != kInvalidSocket)
    ::close(w->poll_handle);
  if (w->write_handle != kInvalidSocket)
    ::close(w->write_handle);
  *w = {};
}
bool fill_random(void *buf, std::size_t n) {
  std::size_t got = 0;
  while (got < n) {
    const ssize_t count = ::getrandom(static_cast<unsigned char *>(buf) + got, n - got, 0);
    if (count < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    got += static_cast<std::size_t>(count);
  }
  return true;
}
std::uint64_t rss_bytes() {
  std::ifstream in("/proc/self/statm");
  if (!in)
    return 0;
  std::uint64_t pages = 0, resident_pages = 0;
  in >> pages >> resident_pages;
  if (!in)
    return 0;
  const long page_size = sysconf(_SC_PAGESIZE);
  return page_size > 0 ? resident_pages * static_cast<std::uint64_t>(page_size) : 0;
}
std::optional<std::uint64_t> private_bytes() { return std::nullopt; }
bool ThreadCpuClock::arm() { return true; }
std::int64_t ThreadCpuClock::now_ns() const {
  struct timespec ts{};
  if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0)
    return -1;
  return static_cast<std::int64_t>(ts.tv_sec) * 1000000000 + ts.tv_nsec;
}
std::int64_t wall_clock_s() {
  struct timespec ts{};
  ::clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<std::int64_t>(ts.tv_sec);
}
std::string library_file_name(const std::string &stem) { return "lib" + stem + ".so"; }
void *library_open(const std::string &path, std::string *error) {
  void *handle = ::dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!handle && error) {
    const char *e = ::dlerror();
    *error = e ? e : "dlopen failed";
  }
  return handle;
}
void *library_symbol(void *library, const char *name) {
  ::dlerror();
  return ::dlsym(library, name);
}
void *library_loaded(const std::string &name) {
  return ::dlopen(name.c_str(), RTLD_NOW | RTLD_NOLOAD);
}
std::string module_path_of(const void *address) {
  Dl_info info{};
  return ::dladdr(address, &info) && info.dli_fname && info.dli_fname[0] ? info.dli_fname : "";
}
std::string executable_path() {
  char path[4096] = {};
  const ssize_t n = ::readlink("/proc/self/exe", path, sizeof(path) - 1);
  return n > 0 ? std::string(path, static_cast<std::size_t>(n)) : "";
}
void set_current_thread_name(const char *name) {
  ::pthread_setname_np(::pthread_self(), std::string(name).substr(0, 15).c_str());
}
void lower_current_thread_priority() {
  (void)::setpriority(PRIO_PROCESS, static_cast<id_t>(::syscall(SYS_gettid)), 10);
}
std::filesystem::path fs_path(const std::string &utf8) { return std::filesystem::path(utf8); }
std::FILE *open_file(const std::string &path, const char *mode) {
  return std::fopen(path.c_str(), mode);
}
bool make_directories(const std::string &path) {
  if (path.empty()) {
    return false;
  }
  std::string partial;
  size_t index = 0;
  if (path[0] == '/') {
    partial = "/";
    index = 1;
  }
  while (index <= path.size()) {
    const size_t next = path.find('/', index);
    const std::string component =
        path.substr(index, next == std::string::npos ? next : next - index);
    if (!component.empty()) {
      if (partial.size() > 1 || (partial.size() == 1 && partial[0] != '/')) {
        partial += "/";
      }
      partial += component;
      if (::mkdir(partial.c_str(), 0775) != 0 && errno != EEXIST) {
        return false;
      }
    }
    if (next == std::string::npos) {
      break;
    }
    index = next + 1;
  }
  struct stat info = {};
  return ::stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}
bool is_directory(const std::string &path) {
  struct stat info{};
  return ::stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}
bool remove_file(const std::string &path, std::string *error) {
  if (::unlink(path.c_str()) == 0)
    return true;
  fail(error, "unlink");
  return false;
}
bool replace_file(const std::string &from, const std::string &to, std::string *error) {
  if (std::rename(from.c_str(), to.c_str()) == 0)
    return true;
  fail(error, "rename");
  return false;
}
bool write_private_file(const std::string &path, const std::string &text) {
  const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0)
    return false;
  bool ok = ::fchmod(fd, 0600) == 0;
  std::size_t off = 0;
  while (ok && off < text.size()) {
    const ssize_t n = ::write(fd, text.data() + off, text.size() - off);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      ok = false;
      break;
    }
    off += static_cast<std::size_t>(n);
  }
  ok = ::close(fd) == 0 && ok;
  return ok;
}
bool restrict_to_owner(const std::string &path) { return ::chmod(path.c_str(), 0600) == 0; }
bool env_utf8(const char *name, std::string *out) {
  const char *value = std::getenv(name);
  if (!value)
    return false;
  *out = value;
  return true;
}
std::uint32_t process_id() { return static_cast<std::uint32_t>(::getpid()); }
} // namespace grc::rs
