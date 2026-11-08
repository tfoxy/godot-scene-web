#if !defined(_WIN32)
#error "the Win32 platform layer requires Windows"
#endif
#include "rs_platform.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <psapi.h>
#include <aclapi.h>
#include <sddl.h>
#include <intrin.h>
#include <mswsock.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <system_error>

namespace grc::rs {
namespace {
bool widen(const std::string &text, std::wstring *out) {
  if (text.empty()) {
    out->clear();
    return true;
  }
  if (text.size() > INT_MAX) {
    ::SetLastError(ERROR_NO_UNICODE_TRANSLATION);
    return false;
  }
  const int n = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                      static_cast<int>(text.size()), nullptr, 0);
  if (!n)
    return false;
  out->resize(n);
  return ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                               static_cast<int>(text.size()), out->data(), n) == n;
}
std::string narrow(const std::wstring &text) {
  if (text.empty() || text.size() > INT_MAX)
    return {};
  const int n = ::WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                                      static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!n)
    return {};
  std::string out(n, '\0');
  if (!::WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                             static_cast<int>(text.size()), out.data(), n, nullptr, nullptr))
    return {};
  return out;
}
std::string error_text(DWORD code) {
  wchar_t *buffer = nullptr;
  constexpr DWORD flags =
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
  DWORD n = ::FormatMessageW(flags, nullptr, code, MAKELANGID(LANG_ENGLISH, SUBLANG_ENGLISH_US),
                             reinterpret_cast<wchar_t *>(&buffer), 0, nullptr);
  if (!n)
    n = ::FormatMessageW(flags, nullptr, code, 0, reinterpret_cast<wchar_t *>(&buffer), 0, nullptr);
  std::string msg = n ? narrow(std::wstring(buffer, n)) : "Unknown error";
  if (buffer)
    ::LocalFree(buffer);
  while (!msg.empty() && (msg.back() == '\r' || msg.back() == '\n' || msg.back() == '.'))
    msg.pop_back();
  return msg + " (error " + std::to_string(code) + ")";
}
void fail(std::string *error, const char *op, DWORD code) {
  if (error)
    *error = std::string(op) + ": " + error_text(code);
}
sockaddr_storage socket_address(const IpAddress &ip, std::uint16_t port, int *size) {
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
std::string module_path(HMODULE module) {
  std::wstring path(256, L'\0');
  for (;;) {
    const DWORD n = ::GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
    if (!n)
      return {};
    if (n < path.size()) {
      path.resize(n);
      auto utf8 = narrow(path);
      std::replace(utf8.begin(), utf8.end(), '\\', '/');
      return utf8;
    }
    if (path.size() >= 32768)
      return {};
    path.resize(path.size() * 2);
  }
}
bool owner_dacl(PSECURITY_DESCRIPTOR *sd, PACL *dacl) {
  if (!::ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;FA;;;OW)", SDDL_REVISION_1,
                                                              sd, nullptr))
    return false;
  BOOL present = FALSE, defaulted = FALSE;
  if (!::GetSecurityDescriptorDacl(*sd, &present, dacl, &defaulted) || !present) {
    ::LocalFree(*sd);
    *sd = nullptr;
    return false;
  }
  return true;
}
} // namespace
SocketError last_socket_error() {
  const int code = ::WSAGetLastError();
  return {code == 0                ? SockErr::None
          : code == WSAEWOULDBLOCK ? SockErr::WouldBlock
          : code == WSAEINTR       ? SockErr::Interrupted
                                   : SockErr::Other,
          code};
}
std::string socket_error_text(int code) { return error_text(static_cast<DWORD>(code)); }
bool net_init(std::string *error) {
  WSADATA data{};
  const int rc = ::WSAStartup(MAKEWORD(2, 2), &data);
  if (!rc)
    return true;
  fail(error, "WSAStartup", rc);
  return false;
}
void net_release() { ::WSACleanup(); }
bool parse_ip_literal(const std::string &text, AddrFamily family, IpAddress *out) {
  std::wstring wide;
  if (!widen(text, &wide))
    return false;
  IpAddress addr;
  addr.family = family;
  if (::InetPtonW(family == AddrFamily::IPv4 ? AF_INET : AF_INET6, wide.c_str(), addr.bytes) != 1)
    return false;
  *out = addr;
  return true;
}
IpAddress loopback_address(AddrFamily family) {
  IpAddress addr;
  addr.family = family;
  if (family == AddrFamily::IPv4) {
    addr.bytes[0] = 127;
    addr.bytes[3] = 1;
  } else
    addr.bytes[15] = 1;
  return addr;
}
bool tcp_listen(const IpAddress &addr, std::uint16_t port, int backlog, WinBind win_bind,
                SocketHandle *out, std::uint16_t *bound_port, std::string *error) {
  int size;
  auto address = socket_address(addr, port, &size);
  const int family = addr.family == AddrFamily::IPv4 ? AF_INET : AF_INET6;
  const auto fd = ::socket(family, SOCK_STREAM, 0);
  if (fd == INVALID_SOCKET) {
    fail(error, "socket", ::WSAGetLastError());
    return false;
  }
  const int one = 1, zero = 0;
  if (win_bind != WinBind::NoOption) {
    const int option = win_bind == WinBind::ExclusiveAddrUse ? SO_EXCLUSIVEADDRUSE : SO_REUSEADDR;
    if (::setsockopt(fd, SOL_SOCKET, option, reinterpret_cast<const char *>(&one), sizeof(one)) !=
        0) {
      fail(error, "setsockopt", ::WSAGetLastError());
      ::closesocket(fd);
      return false;
    }
  }
  if (family == AF_INET6 &&
      ::setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, reinterpret_cast<const char *>(&zero),
                   sizeof(zero)) != 0) {
    fail(error, "setsockopt", ::WSAGetLastError());
    ::closesocket(fd);
    return false;
  }
  if (::bind(fd, reinterpret_cast<sockaddr *>(&address), size) != 0) {
    fail(error, "bind", ::WSAGetLastError());
    ::closesocket(fd);
    return false;
  }
  if (::listen(fd, backlog) != 0) {
    fail(error, "listen", ::WSAGetLastError());
    ::closesocket(fd);
    return false;
  }
  if (!set_nonblocking(fd)) {
    fail(error, "ioctlsocket", ::WSAGetLastError());
    ::closesocket(fd);
    return false;
  }
  sockaddr_storage bound{};
  int blen = sizeof(bound);
  ::getsockname(fd, reinterpret_cast<sockaddr *>(&bound), &blen);
  *bound_port = family == AF_INET ? ntohs(reinterpret_cast<sockaddr_in *>(&bound)->sin_port)
                                  : ntohs(reinterpret_cast<sockaddr_in6 *>(&bound)->sin6_port);
  *out = fd;
  return true;
}
SocketHandle tcp_accept(SocketHandle listener) {
  sockaddr_storage address{};
  int len = sizeof(address);
  return ::accept(listener, reinterpret_cast<sockaddr *>(&address), &len);
}
SocketHandle tcp_connect(const IpAddress &addr, std::uint16_t port, std::string *error) {
  int size;
  auto address = socket_address(addr, port, &size);
  const auto fd = ::socket(addr.family == AddrFamily::IPv4 ? AF_INET : AF_INET6, SOCK_STREAM, 0);
  if (fd == INVALID_SOCKET) {
    fail(error, "socket", ::WSAGetLastError());
    return kInvalidSocket;
  }
  if (::connect(fd, reinterpret_cast<sockaddr *>(&address), size) != 0) {
    fail(error, "connect", ::WSAGetLastError());
    ::closesocket(fd);
    return kInvalidSocket;
  }
  return fd;
}
bool set_nonblocking(SocketHandle s) {
  u_long one = 1;
  return ::ioctlsocket(s, FIONBIO, &one) == 0;
}
void set_tcp_nodelay(SocketHandle s) {
  const int one = 1;
  ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char *>(&one), sizeof(one));
}
std::ptrdiff_t socket_send(SocketHandle s, const void *data, std::size_t size) {
  return ::send(s, static_cast<const char *>(data),
                static_cast<int>(std::min(size, static_cast<std::size_t>(INT_MAX))), 0);
}
std::ptrdiff_t socket_recv(SocketHandle s, void *data, std::size_t size) {
  return ::recv(s, static_cast<char *>(data),
                static_cast<int>(std::min(size, static_cast<std::size_t>(INT_MAX))), 0);
}
void socket_shutdown(SocketHandle s, ShutdownHow how) {
  ::shutdown(s, how == ShutdownHow::Write ? SD_SEND : SD_BOTH);
}
void socket_close(SocketHandle s) { ::closesocket(s); }
static_assert(sizeof(PollEntry) == sizeof(WSAPOLLFD) && alignof(PollEntry) == alignof(WSAPOLLFD));
static_assert(offsetof(PollEntry, fd) == offsetof(WSAPOLLFD, fd) &&
              offsetof(PollEntry, events) == offsetof(WSAPOLLFD, events) &&
              offsetof(PollEntry, revents) == offsetof(WSAPOLLFD, revents));
static_assert(kPollIn == POLLIN && kPollOut == POLLOUT && kPollErr == POLLERR &&
              kPollHup == POLLHUP && kPollNval == POLLNVAL);
int poll_sockets(PollEntry *entries, std::size_t count, int timeout_ms) {
  if (!count) {
    ::Sleep(timeout_ms < 0 ? INFINITE : static_cast<DWORD>(timeout_ms));
    return 0;
  }
  return ::WSAPoll(reinterpret_cast<WSAPOLLFD *>(entries), static_cast<ULONG>(count), timeout_ms);
}
bool wake_open(Wake *out, std::string *error) {
  const auto fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd == INVALID_SOCKET) {
    fail(error, "socket", ::WSAGetLastError());
    return false;
  }
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int len = sizeof(addr);
  const char *op = "bind";
  bool ok = ::bind(fd, reinterpret_cast<sockaddr *>(&addr), len) == 0;
  if (ok) {
    op = "getsockname";
    ok = ::getsockname(fd, reinterpret_cast<sockaddr *>(&addr), &len) == 0;
  }
  if (ok) {
    op = "connect";
    ok = ::connect(fd, reinterpret_cast<sockaddr *>(&addr), len) == 0;
  }
  if (ok) {
    op = "ioctlsocket";
    ok = set_nonblocking(fd);
  }
  if (ok) {
    op = "WSAIoctl";
    BOOL off = FALSE;
    DWORD bytes = 0;
    ok = ::WSAIoctl(fd, SIO_UDP_CONNRESET, &off, sizeof(off), nullptr, 0, &bytes, nullptr,
                    nullptr) == 0;
  }
  if (!ok) {
    fail(error, op, ::WSAGetLastError());
    ::closesocket(fd);
    return false;
  }
  *out = {fd, fd};
  return true;
}
void wake_signal(const Wake &w) { (void)::send(w.write_handle, "\0", 1, 0); }
void wake_drain(const Wake &w) {
  char drain[256];
  while (::recv(w.poll_handle, drain, sizeof(drain), 0) > 0) {
  }
}
void wake_close(Wake *w) {
  if (w->poll_handle != kInvalidSocket)
    ::closesocket(w->poll_handle);
  *w = {};
}
bool fill_random(void *buf, std::size_t n) {
  auto *bytes = static_cast<unsigned char *>(buf);
  while (n) {
    const auto chunk = static_cast<ULONG>(std::min(n, static_cast<std::size_t>(ULONG_MAX)));
    if (::BCryptGenRandom(nullptr, bytes, chunk, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
      std::memset(bytes, 0, chunk);
      return false;
    }
    bytes += chunk;
    n -= chunk;
  }
  return true;
}
std::uint64_t rss_bytes() {
  PROCESS_MEMORY_COUNTERS_EX info{};
  return ::K32GetProcessMemoryInfo(::GetCurrentProcess(),
                                   reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&info), sizeof(info))
             ? info.WorkingSetSize
             : 0;
}
std::optional<std::uint64_t> private_bytes() {
  PROCESS_MEMORY_COUNTERS_EX info{};
  if (!::K32GetProcessMemoryInfo(::GetCurrentProcess(),
                                 reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&info), sizeof(info)))
    return std::nullopt;
  return info.PrivateUsage;
}
bool ThreadCpuClock::arm() {
  LARGE_INTEGER now{};
  armed_ = ::QueryPerformanceCounter(&now) != 0;
  qpc0_ = now.QuadPart;
  tsc0_ = __rdtsc();
  return armed_;
}
std::int64_t ThreadCpuClock::now_ns() const {
  if (!armed_)
    return -1;
  ULONG64 cycles = 0;
  LARGE_INTEGER now{}, freq{};
  if (!::QueryThreadCycleTime(::GetCurrentThread(), &cycles) || !::QueryPerformanceCounter(&now) ||
      !::QueryPerformanceFrequency(&freq) || freq.QuadPart <= 0)
    return -1;
  const auto tsc = __rdtsc() - tsc0_;
  const auto elapsed = now.QuadPart - qpc0_;
  if (elapsed < freq.QuadPart / 1000 || tsc == 0)
    return -1;
  return static_cast<std::int64_t>(static_cast<long double>(cycles) * elapsed * 1000000000.0L /
                                   (static_cast<long double>(tsc) * freq.QuadPart));
}
std::int64_t wall_clock_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}
void *library_open(const std::string &path, std::string *error) {
  std::wstring wide;
  if (!widen(path, &wide)) {
    fail(error, "LoadLibraryExW", ::GetLastError());
    return nullptr;
  }
  DWORD n = ::GetFullPathNameW(wide.c_str(), 0, nullptr, nullptr);
  if (!n) {
    fail(error, "GetFullPathNameW", ::GetLastError());
    return nullptr;
  }
  std::wstring absolute(n, L'\0');
  const DWORD written = ::GetFullPathNameW(wide.c_str(), n, absolute.data(), nullptr);
  if (!written || written >= n) {
    fail(error, "GetFullPathNameW", written >= n ? ERROR_INSUFFICIENT_BUFFER : ::GetLastError());
    return nullptr;
  }
  auto handle =
      ::LoadLibraryExW(absolute.c_str(), nullptr,
                       LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!handle)
    fail(error, "LoadLibraryExW", ::GetLastError());
  return reinterpret_cast<void *>(handle);
}
void *library_symbol(void *library, const char *name) {
  return reinterpret_cast<void *>(::GetProcAddress(static_cast<HMODULE>(library), name));
}
void *library_loaded(const std::string &name) {
  std::wstring wide;
  return widen(name, &wide) ? reinterpret_cast<void *>(::GetModuleHandleW(wide.c_str())) : nullptr;
}
std::string module_path_of(const void *address) {
  HMODULE module = nullptr;
  if (!::GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(address), &module))
    return {};
  return module_path(module);
}
std::string executable_path() { return module_path(nullptr); }
void set_current_thread_name(const char *name) {
  using SetDescription = HRESULT(WINAPI *)(HANDLE, PCWSTR);
  static const auto set = reinterpret_cast<SetDescription>(
      ::GetProcAddress(::GetModuleHandleW(L"kernel32.dll"), "SetThreadDescription"));
  std::wstring wide;
  if (set && widen(name, &wide))
    (void)set(::GetCurrentThread(), wide.c_str());
}
void lower_current_thread_priority() {
  ::SetThreadPriority(::GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
}
std::filesystem::path fs_path(const std::string &utf8) {
  std::wstring wide;
  if (!widen(utf8, &wide)) {
    errno = EINVAL;
    return {};
  }
  return std::filesystem::path(
      std::u8string(reinterpret_cast<const char8_t *>(utf8.data()), utf8.size()));
}
std::FILE *open_file(const std::string &path, const char *mode) {
  std::wstring wide, wmode;
  if (!widen(path, &wide) || !widen(mode, &wmode)) {
    errno = EINVAL;
    return nullptr;
  }
  return ::_wfopen(wide.c_str(), wmode.c_str());
}
bool make_directories(const std::string &path) {
  if (path.empty())
    return false;
  const auto p = fs_path(path);
  if (p.empty())
    return false;
  std::error_code ec;
  std::filesystem::create_directories(p, ec);
  return !ec && std::filesystem::is_directory(p, ec);
}
bool is_directory(const std::string &path) {
  const auto p = fs_path(path);
  std::error_code ec;
  return !p.empty() && std::filesystem::is_directory(p, ec);
}
bool remove_file(const std::string &path, std::string *error) {
  std::wstring wide;
  if (widen(path, &wide) && ::DeleteFileW(wide.c_str()))
    return true;
  fail(error, "DeleteFileW", ::GetLastError());
  return false;
}
bool replace_file(const std::string &from, const std::string &to, std::string *error) {
  std::wstring a, b;
  if (widen(from, &a) && widen(to, &b) &&
      ::MoveFileExW(a.c_str(), b.c_str(), MOVEFILE_REPLACE_EXISTING))
    return true;
  fail(error, "MoveFileExW", ::GetLastError());
  return false;
}
bool write_private_file(const std::string &path, const std::string &bytes) {
  std::wstring wide;
  if (!widen(path, &wide))
    return false;
  PSECURITY_DESCRIPTOR sd = nullptr;
  PACL dacl = nullptr;
  if (!owner_dacl(&sd, &dacl))
    return false;
  SECURITY_ATTRIBUTES sa{sizeof(sa), sd, FALSE};
  const auto handle = ::CreateFileW(wide.c_str(), GENERIC_WRITE | WRITE_DAC, 0, &sa, CREATE_ALWAYS,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    ::LocalFree(sd);
    return false;
  }
  // CREATE_ALWAYS preserves an existing file's DACL, so apply it through the open handle too.
  bool ok = ::SetSecurityInfo(handle, SE_FILE_OBJECT,
                              DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                              nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS;
  std::size_t offset = 0;
  while (ok && offset < bytes.size()) {
    DWORD written = 0;
    const auto n =
        static_cast<DWORD>(std::min(bytes.size() - offset, static_cast<std::size_t>(MAXDWORD)));
    ok = ::WriteFile(handle, bytes.data() + offset, n, &written, nullptr) && written > 0;
    offset += written;
  }
  ok = ::CloseHandle(handle) && ok;
  ::LocalFree(sd);
  return ok;
}
bool restrict_to_owner(const std::string &path) {
  std::wstring wide;
  if (!widen(path, &wide))
    return false;
  PSECURITY_DESCRIPTOR sd = nullptr;
  PACL dacl = nullptr;
  if (!owner_dacl(&sd, &dacl))
    return false;
  const bool ok =
      ::SetNamedSecurityInfoW(wide.data(), SE_FILE_OBJECT,
                              DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                              nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS;
  ::LocalFree(sd);
  return ok;
}
bool env_utf8(const char *name, std::string *out) {
  std::wstring wide;
  if (!widen(name, &wide))
    return false;
  const auto *value = ::_wgetenv(wide.c_str());
  if (!value)
    return false;
  *out = narrow(value);
  return true;
}
std::uint32_t process_id() { return ::GetCurrentProcessId(); }
} // namespace grc::rs
