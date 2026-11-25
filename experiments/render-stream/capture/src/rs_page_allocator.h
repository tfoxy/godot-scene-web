// Capture-owned large buffers bypass malloc arenas and return pages on destruction.
#ifndef GRC_RS_PAGE_ALLOCATOR_H
#define GRC_RS_PAGE_ALLOCATOR_H

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <vector>
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/mman.h>
#endif

namespace grc::rs {
inline constexpr std::size_t kPageAllocationThreshold = 256u << 10;

// Stateless: allocation and deallocation route by the same capacity, including after moves.
// The standard allocator remains responsible for small allocations and their alignment.
template <typename T>
class PageAllocator {
 public:
  using value_type = T;
  using is_always_equal = std::true_type;
  PageAllocator() noexcept = default;
  template <typename U>
  PageAllocator(const PageAllocator<U> &) noexcept {}
  static constexpr bool mapped(std::size_t n) noexcept {
    return n >= (kPageAllocationThreshold + sizeof(T) - 1) / sizeof(T);
  }
  [[nodiscard]] T *allocate(std::size_t n) {
    if (n > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
      throw std::bad_array_new_length();
    }
    if (!mapped(n)) return std::allocator<T>{}.allocate(n);
    static_assert(alignof(T) <= alignof(std::max_align_t));
#if defined(_WIN32)
    void *p = VirtualAlloc(nullptr, n * sizeof(T), MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (p == nullptr) throw std::bad_alloc();
#else
    void *p = mmap(nullptr, n * sizeof(T), PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) throw std::bad_alloc();
#endif
    return static_cast<T *>(p);
  }
  void deallocate(T *p, std::size_t n) noexcept {
    if (!mapped(n)) {
      std::allocator<T>{}.deallocate(p, n);
      return;
    }
#if defined(_WIN32)
    VirtualFree(p, 0, MEM_RELEASE);
#else
    munmap(p, n * sizeof(T));
#endif
  }
  template <typename U>
  bool operator==(const PageAllocator<U> &) const noexcept { return true; }
};
class PageBytes : public std::vector<std::uint8_t, PageAllocator<std::uint8_t>> {
 public:
  using Base = std::vector<std::uint8_t, PageAllocator<std::uint8_t>>;
  using Base::Base;
  PageBytes() = default;
  // Legacy producers may still hand over a small wire record or a cache buffer.
  PageBytes(const std::vector<std::uint8_t> &bytes) : Base(bytes.begin(), bytes.end()) {}
};
inline bool operator==(const PageBytes &a, const PageBytes &b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
}
inline bool operator==(const PageBytes &a, const std::vector<std::uint8_t> &b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
}
inline bool operator==(const std::vector<std::uint8_t> &a, const PageBytes &b) { return b == a; }
}  // namespace grc::rs
#endif  // GRC_RS_PAGE_ALLOCATOR_H
