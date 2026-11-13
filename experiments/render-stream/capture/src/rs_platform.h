#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#if !defined(_WIN32)
#include <cerrno>
#include <cstring>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#endif
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

#if defined(_MSC_VER)
#error "the MSVC ABI is not supported"
#endif

#if defined(_WIN32)
#define GRC_EXPORT __declspec(dllexport)
#else
#define GRC_EXPORT __attribute__((visibility("default")))
#endif

#if defined(__ELF__)
#define GRC_INITIAL_EXEC_TLS __attribute__((tls_model("initial-exec")))
#else
#define GRC_INITIAL_EXEC_TLS
#endif

namespace grc::rs {
// Paths are UTF-8; Windows module/executable path results use '/'.
// Errors, when requested, start with the operation.
// No function takes or returns engine-owned memory.
#if defined(_WIN32)
using SocketHandle = std::uintptr_t;
inline constexpr SocketHandle kInvalidSocket = ~SocketHandle{0};
#else
using SocketHandle = int;
inline constexpr SocketHandle kInvalidSocket = -1;
#endif
enum class SockErr : std::uint8_t { None, WouldBlock, Interrupted, Other };
struct SocketError {
  SockErr kind;
  int code;
};
SocketError last_socket_error();
std::string socket_error_text(int code);
bool net_init(std::string *error);
void net_release();
enum class AddrFamily : std::uint8_t { IPv4, IPv6 };
struct IpAddress {
  AddrFamily family = AddrFamily::IPv4;
  std::uint8_t bytes[16] = {};
};
bool parse_ip_literal(const std::string &text, AddrFamily family, IpAddress *out);
IpAddress loopback_address(AddrFamily family);
enum class WinBind : std::uint8_t { ExclusiveAddrUse, NoOption, ReuseAddr };
inline constexpr WinBind kListenerWinBind = WinBind::ExclusiveAddrUse;
bool tcp_listen(const IpAddress &addr, std::uint16_t port, int backlog, WinBind win_bind,
                SocketHandle *out, std::uint16_t *bound_port, std::string *error);
SocketHandle tcp_accept(SocketHandle listener, IpAddress *peer = nullptr);
SocketHandle tcp_connect(const IpAddress &addr, std::uint16_t port, std::string *error);
bool set_nonblocking(SocketHandle s);
void set_tcp_nodelay(SocketHandle s);
std::ptrdiff_t socket_send(SocketHandle s, const void *data, std::size_t size);
std::ptrdiff_t socket_recv(SocketHandle s, void *data, std::size_t size);
enum class ShutdownHow : std::uint8_t { Write, Both };
void socket_shutdown(SocketHandle s, ShutdownHow how);
void socket_close(SocketHandle s);
struct PollEntry {
  SocketHandle fd;
  short events;
  short revents;
};
#if defined(_WIN32)
inline constexpr short kPollIn = 0x0300, kPollOut = 0x0010, kPollErr = 0x0001, kPollHup = 0x0002,
                       kPollNval = 0x0004;
#else
inline constexpr short kPollIn = 0x001, kPollOut = 0x004, kPollErr = 0x008, kPollHup = 0x010,
                       kPollNval = 0x020;
#endif
int poll_sockets(PollEntry *entries, std::size_t count, int timeout_ms);
struct Wake {
  SocketHandle poll_handle = kInvalidSocket;
  SocketHandle write_handle = kInvalidSocket;
};
bool wake_open(Wake *out, std::string *error);
void wake_signal(const Wake &w);
void wake_drain(const Wake &w);
void wake_close(Wake *w);
bool fill_random(void *buf, std::size_t n);
std::uint64_t rss_bytes();
std::optional<std::uint64_t> private_bytes();
struct ThreadCensus {
  std::int64_t total = 0;
  // Capture threads, filtered by the first 15 UTF-8 bytes of their OS names.
  std::optional<std::map<std::string, std::int64_t>> named;
};
struct FdCensus {
  std::int64_t fds = -1, sockets = -1, inet_sockets = -1, handles = -1;
#if defined(_WIN32)
  std::map<std::string, std::int64_t> inet_tcp_states;
#endif
};
// Process-heap bytes; absent on platforms with no matching allocator summary.
struct ProcessHeap { std::uint64_t allocated, committed; };
struct TscInfo { bool invariant; double hz; };
struct AnonReading { const char *name; std::int64_t bytes; };
#if defined(_WIN32)
std::optional<ProcessHeap> process_heap();
std::optional<TscInfo> tsc_info();
AnonReading anon_reading();
#else
inline std::optional<ProcessHeap> process_heap() { return std::nullopt; }
inline std::optional<TscInfo> tsc_info() { return std::nullopt; }
#endif
struct HeapStats { std::uint64_t uordblks, fordblks, hblkhd, arena, keepcost; };
std::optional<ThreadCensus> thread_census();
using FdCensusVisitor = void (*)(void *, const FdCensus &);
// Visits before releasing temporary inode storage so allocator observations keep their ordering.
std::optional<FdCensus> fd_census(void *context = nullptr, FdCensusVisitor visitor = nullptr);
using RssSplitVisitor = void (*)(void *, const char *, std::int64_t);
// Visits available Linux RSS fields in status-file order; Windows has no equivalent split.
void rss_split(void *context, RssSplitVisitor visitor);
std::optional<std::int64_t> rss_anon_bytes();
#if !defined(_WIN32)
inline AnonReading anon_reading() { return {"rss_anon_bytes", rss_anon_bytes().value_or(-1)}; }
#endif
std::optional<HeapStats> heap_stats();
bool heap_trim();
// Keeps the smaps streams open during the heap dump, preserving allocator evidence lifetimes.
bool dump_memory_info(const std::string &prefix);
class ThreadCpuClock {
public:
  // Marks are opaque thread counters. Convert the delta once with ns_since();
  // either operation returns -1 when its reading or calibration is unavailable.
#if defined(_WIN32)
  bool arm();
  std::int64_t mark() const;
  std::int64_t ns_since(std::int64_t mark) const;
  std::int64_t now_ns() const;
#else
  std::int64_t mark() const {
    const auto us = now_us();
    return us < 0 ? -1 : us * 1000;
  }
  std::int64_t ns_since(std::int64_t mark) const {
    const auto now = this->mark();
    return mark < 0 || now < 0 ? -1 : now - mark;
  }
  bool arm() {
    struct timespec ts{};
    armed_ = ::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) == 0;
    if (armed_) start_us_ = static_cast<std::int64_t>(ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
    return armed_;
  }
  std::int64_t now_ns() const {
    struct timespec ts{};
    if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return -1;
    return static_cast<std::int64_t>(ts.tv_sec) * 1000000000 + ts.tv_nsec;
  }
#endif
  std::int64_t now_us() const {
#if defined(_WIN32)
    const auto ns = now_ns();
    return ns < 0 ? -1 : ns / 1000;
#else
    struct timespec ts{};
    if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return -1;
    return static_cast<std::int64_t>(ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
#endif
  }
  // Uses one calibration for the entire cycle delta on Windows. POSIX truncates each
  // timestamp before subtracting, matching the perf.json microsecond baseline.
  std::int64_t elapsed_us() const {
#if defined(_WIN32)
    if (!armed_) return -1;
    const auto ns = ns_since(cycles0_);
    return ns < 0 ? -1 : ns / 1000;
#else
    if (!armed_) return -1;
    const auto us = now_us();
    return us < 0 ? -1 : us - start_us_;
#endif
  }
private:
#if defined(_WIN32)
  std::int64_t cycles0_ = -1;
#else
  std::int64_t start_us_ = -1;
#endif
  bool armed_ = false;
};
std::int64_t wall_clock_s();
std::string library_file_name(const std::string &stem);
void *library_open(const std::string &utf8_path, std::string *error);
void *library_symbol(void *library, const char *name);
void *library_loaded(const std::string &file_name);
std::string module_path_of(const void *address);
std::string executable_path();
void set_current_thread_name(const char *name);
void lower_current_thread_priority();
std::filesystem::path fs_path(const std::string &utf8);
#if defined(_WIN32)
inline bool is_path_separator(char c) { return c == '/' || c == '\\'; }
bool is_absolute_path(const std::string &path);
std::string parent_path(const std::string &path);
#else
inline bool is_path_separator(char c) { return c == '/'; }
inline bool is_absolute_path(const std::string &path) {
  return !path.empty() && path[0] == '/';
}
inline std::string parent_path(const std::string &path) {
  const std::size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? std::string() : path.substr(0, slash);
}
#endif
#if defined(_WIN32)
std::FILE *open_file(const std::string &utf8_path, const char *mode);
#else
// Keep replaced fopen calls direct, including literal paths that must not allocate a string.
inline std::FILE *open_file(const char *path, const char *mode) { return std::fopen(path, mode); }
inline std::FILE *open_file(const std::string &path, const char *mode) {
  return std::fopen(path.c_str(), mode);
}
#endif
bool make_directories(const std::string &utf8_path);
bool is_directory(const std::string &utf8_path);
#if defined(_WIN32)
bool remove_file(const std::string &utf8_path, std::string *error = nullptr);
bool replace_file(const std::string &from, const std::string &to, std::string *error = nullptr);
#else
inline bool remove_file(const std::string &path, std::string *error = nullptr) {
  if (::unlink(path.c_str()) == 0) return true;
  if (error) *error = std::string("unlink: ") + std::strerror(errno);
  return false;
}
inline bool replace_file(const std::string &from, const std::string &to, std::string *error = nullptr) {
  if (std::rename(from.c_str(), to.c_str()) == 0) return true;
  if (error) *error = std::string("rename: ") + std::strerror(errno);
  return false;
}
#endif
bool write_private_file(const std::string &utf8_path, const std::string &bytes);
#if defined(_WIN32)
bool restrict_to_owner(const std::string &utf8_path);
#else
inline bool restrict_to_owner(const std::string &path) { return ::chmod(path.c_str(), 0600) == 0; }
#endif
bool env_utf8(const char *name, std::string *out);
// Raw environment, independent of per-arm settings. Windows retains every distinct value so
// earlier pointers survive changes; POSIX preserves getenv's exact behavior and call cost.
#if defined(_WIN32)
const char *env(const char *name);
#else
inline const char *env(const char *name) { return std::getenv(name); }
#endif
#if defined(_WIN32)
std::uint32_t process_id();
#else
inline std::uint32_t process_id() { return static_cast<std::uint32_t>(::getpid()); }
#endif
} // namespace grc::rs
