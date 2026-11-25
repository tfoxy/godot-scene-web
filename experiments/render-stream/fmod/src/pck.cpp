#include "banks.hpp"
#include "rs_sha256.h"
#include <algorithm>
#include <cerrno>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>
#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
namespace grc::fmod {
namespace {
[[noreturn]] void invalid(const char *reason = "bank-load") { throw std::runtime_error(reason); }
std::string canonical(std::string path) {
  if (!path.starts_with("res://")) path = "res://" + path;
  if (path.find('\0') != std::string::npos || path.find("..") != std::string::npos || path.size() > 4096)
    invalid();
  return path;
}
std::set<std::string> selection(const std::string &list) {
  std::set<std::string> out;
  for (std::size_t pos = 0; pos < list.size();) {
    const auto end = list.find(',', pos);
    auto name = list.substr(pos, end == std::string::npos ? end : end - pos);
    if (name.empty() || !out.insert(canonical(name)).second) invalid();
    if (end == std::string::npos) break;
    pos = end + 1;
    if (pos == list.size()) invalid();
  }
  return out;
}
bool bank_path(const std::string &path) {
  if (path.size() < 5) return false;
  auto ext = path.substr(path.size() - 5);
  for (auto &c : ext) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  return ext == ".bank";
}
}
struct Pck::File {
#if defined(_WIN32)
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int handle = -1;
#endif
  std::uint64_t size = 0;
  explicit File(const std::string &path) {
#if defined(_WIN32)
    const auto n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, nullptr, 0);
    if (n <= 0) invalid();
    std::vector<wchar_t> wide(n);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.c_str(), -1, wide.data(), n);
    handle = CreateFileW(wide.data(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
    LARGE_INTEGER length;
    if (handle == INVALID_HANDLE_VALUE) invalid();
    if (!GetFileSizeEx(handle, &length)) { CloseHandle(handle); invalid(); }
    size = length.QuadPart;
#else
    handle = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (handle < 0) invalid();
    struct stat st{};
    if (fstat(handle, &st) || !S_ISREG(st.st_mode) || st.st_size < 0) { ::close(handle); invalid(); }
    size = static_cast<std::uint64_t>(st.st_size);
#endif
  }
  ~File() {
#if defined(_WIN32)
    CloseHandle(handle);
#else
    ::close(handle);
#endif
  }
  bool read(std::uint64_t pos, void *dst, unsigned n, unsigned &got) const noexcept {
    got = 0;
    if (pos > size || n > size - pos) return false;
    while (got < n) {
#if defined(_WIN32)
      OVERLAPPED at{};
      const auto offset = pos + got;
      at.Offset = static_cast<DWORD>(offset);
      at.OffsetHigh = static_cast<DWORD>(offset >> 32);
      DWORD count = 0;
      if (!ReadFile(handle, static_cast<char *>(dst) + got, n - got, &count, &at)) return false;
#else
      const auto count = pread(handle, static_cast<char *>(dst) + got, n - got,
                               static_cast<off_t>(pos + got));
      if (count < 0 && errno == EINTR) continue;
      if (count < 0) return false;
#endif
      if (count == 0) return false;
      got += static_cast<unsigned>(count);
    }
    return true;
  }
};
Pck::~Pck() = default;
Pck::Pck(const std::string &path, const std::string &selected) : file_(std::make_unique<File>(path)) {
  std::uint64_t cursor = 0;
  auto bytes = [&](void *dst, unsigned n) {
    unsigned got = 0;
    if (!file_->read(cursor, dst, n, got)) invalid();
    cursor += n;
  };
  auto number = [&](unsigned width) {
    std::uint8_t b[8]{};
    bytes(b, width);
    std::uint64_t value = 0;
    for (unsigned i = 0; i < width; ++i) value |= std::uint64_t(b[i]) << (8 * i);
    return value;
  };
  const auto magic = number(4);
  if (magic == 0x504d4347) invalid("bank-compressed"); // Godot compressed file wrapper.
  if (magic != 0x43504447) invalid();
  const auto format = number(4);
  if (format != 2 && format != 3) invalid();
  cursor = 20;
  const auto flags = number(4);
  if (flags & 1) invalid("bank-encrypted");
  // Sparse, compressed and unknown pack forms must never become raw bank reads.
  if (flags & ~std::uint64_t(3)) invalid("bank-compressed");
  const auto base = number(8);
  cursor = format == 3 ? number(8) : 96;
  const auto count = number(4);
  if (count > 1000000) invalid();
  auto wanted = selection(selected);
  const bool all = wanted.empty();
  std::set<std::string> seen;
  for (std::uint64_t i = 0; i < count; ++i) {
    const auto length = number(4);
    if (!length || length > 4096) invalid();
    std::string name(static_cast<std::size_t>(length), '\0');
    bytes(name.data(), static_cast<unsigned>(length));
    while (!name.empty() && name.back() == '\0') name.pop_back();
    Entry entry;
    entry.offset = number(8);
    entry.bytes = number(8);
    bytes(entry.md5.data(), 16);
    const auto entry_flags = number(4);
    if (!bank_path(name)) continue;
    // Refuse flagged banks even if they were not selected, rather than silently
    // accepting a partially encrypted or unsupported package.
    if (entry_flags & 1) invalid("bank-encrypted");
    if (entry_flags) invalid("bank-compressed");
    entry.path = canonical(std::move(name));
    if (!seen.insert(entry.path).second) invalid();
    if (entry.bytes > std::numeric_limits<unsigned>::max() || base > file_->size ||
        entry.offset > file_->size - base || entry.bytes > file_->size - base - entry.offset)
      invalid();
    entry.offset += base;
    if (all || wanted.erase(entry.path)) entries_.push_back(std::move(entry));
  }
  if (!wanted.empty() || entries_.empty()) invalid();
}
bool Pck::read(const Entry &entry, std::uint64_t pos, void *buf, unsigned n, unsigned &got) const noexcept {
  got = 0;
  if (pos > entry.bytes) return false;
  const auto wanted = static_cast<unsigned>(std::min<std::uint64_t>(n, entry.bytes - pos));
  return file_->read(entry.offset + pos, buf, wanted, got);
}
std::string bankset_hash(std::vector<Entry> entries) {
  std::sort(entries.begin(), entries.end(), [](const auto &a, const auto &b) { return a.path < b.path; });
  grc::Sha256 digest;
  constexpr char domain[] = "grc-bankset-1";
  digest.update(domain, sizeof(domain));
  for (const auto &entry : entries) {
    digest.update(entry.path.data(), entry.path.size());
    const char zero = 0;
    digest.update(&zero, 1);
    digest.update(entry.md5.data(), entry.md5.size());
  }
  return grc::sha256_hex(digest.finish()).substr(0, 32);
}
}
