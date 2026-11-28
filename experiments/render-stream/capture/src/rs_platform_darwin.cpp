// Darwin implementations use native process facts; no procfs or glibc allocator fields.
#if !defined(__APPLE__)
#error "the Darwin platform layer requires macOS"
#endif
#include "rs_platform.h"

#include <algorithm>
#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <mach-o/dyld.h>
#include <malloc/malloc.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <pthread/qos.h>
#include <sys/proc_info.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace grc::rs {
bool safe_read_self(std::uint64_t, void *, std::size_t) { return false; }

namespace {
bool close_on_exec(int fd) {
  const int flags = ::fcntl(fd, F_GETFD);
  return flags >= 0 && ::fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}
bool prepare_socket(int fd) {
#if defined(GRC_TEST_NO_NOSIGPIPE)
  // Compiled only into the peer-reset sabotage executable, never the capture library.
  return close_on_exec(fd);
#else
  const int one = 1;
  return close_on_exec(fd) &&
         ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) == 0;
#endif
}
void close_preserving_error(int fd) {
  const int error = errno;
  ::close(fd);
  errno = error;
}
void fail(std::string *error, const char *op) {
  if (error)
    *error = std::string(op) + ": " + std::strerror(errno);
}
sockaddr_storage socket_address(const IpAddress &ip, std::uint16_t port, socklen_t *size) {
  sockaddr_storage storage{};
  if (ip.family == AddrFamily::IPv4) {
    auto *a = reinterpret_cast<sockaddr_in *>(&storage);
    a->sin_len = sizeof(*a);
    a->sin_family = AF_INET;
    a->sin_port = htons(port);
    std::memcpy(&a->sin_addr, ip.bytes, 4);
    *size = sizeof(*a);
  } else {
    auto *a = reinterpret_cast<sockaddr_in6 *>(&storage);
    a->sin6_len = sizeof(*a);
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
  if (!prepare_socket(fd)) {
    fail(error, "socket options");
    close_preserving_error(fd);
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
  if (!set_nonblocking(fd)) {
    fail(error, "fcntl nonblocking");
    close_preserving_error(fd);
    return false;
  }
  sockaddr_storage bound{};
  socklen_t blen = sizeof(bound);
  if (::getsockname(fd, reinterpret_cast<sockaddr *>(&bound), &blen) != 0) {
    fail(error, "getsockname");
    close_preserving_error(fd);
    return false;
  }
  *bound_port = family == AF_INET ? ntohs(reinterpret_cast<sockaddr_in *>(&bound)->sin_port)
                                  : ntohs(reinterpret_cast<sockaddr_in6 *>(&bound)->sin6_port);
  *out = fd;
  return true;
}
SocketHandle tcp_accept(SocketHandle listener, IpAddress *peer) {
  sockaddr_storage address{};
  socklen_t len = sizeof(address);
  const auto fd = ::accept(listener, reinterpret_cast<sockaddr *>(&address), &len);
  if (fd != kInvalidSocket && !prepare_socket(fd)) {
    close_preserving_error(fd);
    return kInvalidSocket;
  }
  if (fd != kInvalidSocket && peer) {
    peer->family = address.ss_family == AF_INET ? AddrFamily::IPv4 : AddrFamily::IPv6;
    if (peer->family == AddrFamily::IPv4)
      std::memcpy(peer->bytes, &reinterpret_cast<sockaddr_in *>(&address)->sin_addr, 4);
    else
      std::memcpy(peer->bytes, &reinterpret_cast<sockaddr_in6 *>(&address)->sin6_addr, 16);
  }
  return fd;
}
SocketHandle tcp_connect(const IpAddress &addr, std::uint16_t port, std::string *error) {
  socklen_t size;
  auto address = socket_address(addr, port, &size);
  const int fd = ::socket(addr.family == AddrFamily::IPv4 ? AF_INET : AF_INET6,
                          SOCK_STREAM, 0);
  if (fd < 0) {
    fail(error, "socket");
    return kInvalidSocket;
  }
  if (!prepare_socket(fd)) {
    fail(error, "socket options");
    close_preserving_error(fd);
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
  return ::send(s, data, size, 0);
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
  if (!close_on_exec(fds[0]) || !close_on_exec(fds[1]) ||
      !set_nonblocking(fds[0]) || !set_nonblocking(fds[1])) {
    fail(error, "pipe flags");
    const int saved = errno;
    ::close(fds[0]);
    ::close(fds[1]);
    errno = saved;
    return false;
  }
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
  auto *bytes = static_cast<unsigned char *>(buf);
  while (n) {
    const auto chunk = std::min(n, std::size_t{256});
    if (::getentropy(bytes, chunk) != 0) {
      if (errno == EINTR) continue;
      return false;
    }
    bytes += chunk;
    n -= chunk;
  }
  return true;
}
std::int64_t wall_clock_s() {
  struct timespec ts{};
  ::clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<std::int64_t>(ts.tv_sec);
}
std::string library_file_name(const std::string &stem) { return "lib" + stem + ".dylib"; }
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
  std::uint32_t size = 0;
  ::_NSGetExecutablePath(nullptr, &size);
  if (!size) return {};
  std::vector<char> path(size);
  if (::_NSGetExecutablePath(path.data(), &size) != 0) return {};
  char *resolved = ::realpath(path.data(), nullptr);
  if (!resolved) return {};
  std::string result(resolved);
  std::free(resolved);
  return result;
}
void set_current_thread_name(const char *name) {
  ::pthread_setname_np(std::string(name).substr(0, 63).c_str());
}
void lower_current_thread_priority() {
  (void)::pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
}
std::FILE *open_file(const std::string &path, const char *mode) {
  if (!mode || !*mode) { errno = EINVAL; return nullptr; }
  int flags;
  switch (*mode) {
    case 'r': flags = O_RDONLY; break;
    case 'w': flags = O_WRONLY | O_CREAT | O_TRUNC; break;
    case 'a': flags = O_WRONLY | O_CREAT | O_APPEND; break;
    default: errno = EINVAL; return nullptr;
  }
  bool update = false;
  for (const char *p = mode + 1; *p; ++p) {
    if (*p == '+') update = true;
    else if (*p == 'x' && *mode == 'w') flags |= O_EXCL;
    else if (*p != 'b' && *p != 'e') { errno = EINVAL; return nullptr; }
  }
  if (update) flags = (flags & ~O_ACCMODE) | O_RDWR;
  const int fd = ::open(path.c_str(), flags | O_CLOEXEC, 0666);
  if (fd < 0) return nullptr;
  const char normalized[] = {*mode, update ? '+' : '\0', '\0'};
  std::FILE *file = ::fdopen(fd, normalized);
  if (!file) close_preserving_error(fd);
  return file;
}
std::filesystem::path fs_path(const std::string &utf8) { return std::filesystem::path(utf8); }
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
bool env_utf8(const char *name, std::string *out) {
  const char *value = std::getenv(name);
  if (!value)
    return false;
  *out = value;
  return true;
}
std::optional<ThreadCensus> thread_census() {
  thread_act_array_t threads = nullptr;
  mach_msg_type_number_t count = 0;
  if (::task_threads(::mach_task_self(), &threads, &count) != KERN_SUCCESS) return std::nullopt;
  ThreadCensus result;
  result.total = count;
  result.named.emplace();
  for (mach_msg_type_number_t i = 0; i < count; ++i) {
    const pthread_t thread = ::pthread_from_mach_thread_np(threads[i]);
    char name[64]{};
    if (thread && ::pthread_getname_np(thread, name, sizeof(name)) == 0) {
      const std::string key = std::string(name).substr(0, 15);
      if (key.rfind("grc-", 0) == 0 || key.rfind("rs-ws", 0) == 0) ++(*result.named)[key];
    }
    ::mach_port_deallocate(::mach_task_self(), threads[i]);
  }
  ::vm_deallocate(::mach_task_self(), reinterpret_cast<vm_address_t>(threads),
                  static_cast<vm_size_t>(count) * sizeof(thread_t));
  return result;
}
std::optional<FdCensus> fd_census(void *context, FdCensusVisitor visitor) {
  const int pid = ::getpid();
  const int size = ::proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
  if (size <= 0) return std::nullopt;
  std::vector<proc_fdinfo> descriptors(static_cast<std::size_t>(size) / sizeof(proc_fdinfo) + 16);
  for (int attempt = 0; attempt < 4; ++attempt) {
    const auto bytes = descriptors.size() * sizeof(proc_fdinfo);
    if (bytes > static_cast<std::size_t>(std::numeric_limits<int>::max())) return std::nullopt;
    const int got = ::proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors.data(), static_cast<int>(bytes));
    if (got <= 0 || got % sizeof(proc_fdinfo)) return std::nullopt;
    if (static_cast<std::size_t>(got) == bytes) {
      descriptors.resize(descriptors.size() * 2);
      continue;
    }
    FdCensus result;
    result.fds = got / sizeof(proc_fdinfo);
    result.sockets = result.inet_sockets = 0;
    bool inet_available = true;
    for (std::int64_t i = 0; i < result.fds; ++i) {
      const auto &fd = descriptors[static_cast<std::size_t>(i)];
      if (fd.proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      ++result.sockets;
      socket_fdinfo socket{};
      const int n = ::proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket));
      if (n != static_cast<int>(sizeof(socket))) { inet_available = false; continue; }
      if (socket.psi.soi_family == AF_INET || socket.psi.soi_family == AF_INET6) ++result.inet_sockets;
    }
    if (!inet_available) result.inet_sockets = -1;
    if (visitor) visitor(context, result);
    return result;
  }
  return std::nullopt;
}
namespace {
std::optional<task_vm_info_data_t> memory_info() {
  task_vm_info_data_t info{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (::task_info(::mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) !=
      KERN_SUCCESS || count < TASK_VM_INFO_REV1_COUNT) return std::nullopt;
  return info;
}
} // namespace
std::uint64_t rss_bytes() {
  const auto info = memory_info();
  return info ? info->resident_size : 0;
}
// The footprint includes dirty anonymous and compressed pages, unlike resident_size.
std::optional<std::uint64_t> private_bytes() {
  const auto info = memory_info();
  return info ? std::optional<std::uint64_t>(info->phys_footprint) : std::nullopt;
}
void rss_split(void *, RssSplitVisitor) {}
std::optional<std::int64_t> rss_anon_bytes() { return std::nullopt; }
std::optional<HeapStats> heap_stats() { return std::nullopt; }
std::optional<ProcessHeap> process_heap() {
  malloc_statistics_t heap{};
  ::malloc_zone_statistics(nullptr, &heap);
  return ProcessHeap{heap.size_in_use, heap.size_allocated};
}
std::optional<TscInfo> tsc_info() { return std::nullopt; }
AnonReading anon_reading() {
  const auto bytes = private_bytes();
  return {"private_bytes", bytes ? static_cast<std::int64_t>(*bytes) : -1};
}
bool heap_trim() {
  return ::malloc_zone_pressure_relief(nullptr, 0) != 0;
}
bool dump_memory_info(const std::string &) { return false; }

} // namespace grc::rs
