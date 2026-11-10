#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <optional>
#include <string>

#if defined(_MSC_VER)
#error "the MSVC ABI is not supported"
#endif

#if defined(_WIN32)
#define GRC_EXPORT __declspec(dllexport)
#else
#define GRC_EXPORT __attribute__((visibility("default")))
#endif

namespace grc::rs {
// Paths are UTF-8; Windows path results use '/'. Errors, when requested, start with the operation.
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
bool tcp_listen(const IpAddress &addr, std::uint16_t port, int backlog, WinBind win_bind,
                SocketHandle *out, std::uint16_t *bound_port, std::string *error);
SocketHandle tcp_accept(SocketHandle listener);
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
class ThreadCpuClock {
public:
  bool arm();
  std::int64_t now_ns() const;
#if defined(_WIN32)
private:
  std::int64_t qpc0_ = 0;
  std::uint64_t tsc0_ = 0;
  bool armed_ = false;
#endif
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
std::FILE *open_file(const std::string &utf8_path, const char *mode);
bool make_directories(const std::string &utf8_path);
bool is_directory(const std::string &utf8_path);
bool remove_file(const std::string &utf8_path, std::string *error = nullptr);
bool replace_file(const std::string &from, const std::string &to, std::string *error = nullptr);
bool write_private_file(const std::string &utf8_path, const std::string &bytes);
bool restrict_to_owner(const std::string &utf8_path);
bool env_utf8(const char *name, std::string *out);
std::uint32_t process_id();
} // namespace grc::rs
