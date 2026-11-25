#include "rs_page_allocator.h"
#include <cstdio>
#include <cstring>
#include <limits>
#if !defined(_WIN32)
#include <cerrno>
#include <unistd.h>
#endif
#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_vm.h>
#endif

#if !defined(_WIN32)
#if defined(__APPLE__)
using Residency = char;
#else
using Residency = unsigned char;
#endif
// Query an address after release without accessing an object through a dangling C++ pointer.
__attribute__((noinline)) bool unmapped(std::uintptr_t address) {
#if defined(__APPLE__)
  // Darwin mincore can succeed with a zero residency byte for a hole. Query the
  // VM map instead: mach_vm_region returns the next region at or after address.
  mach_vm_address_t start = address;
  mach_vm_size_t size = 0;
  vm_region_basic_info_data_64_t info{};
  mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
  mach_port_t object = MACH_PORT_NULL;
  const auto result = mach_vm_region(mach_task_self(), &start, &size,
      VM_REGION_BASIC_INFO_64, reinterpret_cast<vm_region_info_t>(&info), &count, &object);
  if (object != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), object);
  return result == KERN_INVALID_ADDRESS || (result == KERN_SUCCESS && start > address);
#else
  Residency resident = 0;
  errno = 0;
  return mincore(reinterpret_cast<void *>(address), 1, &resident) == -1 && errno == ENOMEM;
#endif
}
#endif

int main() {
  using namespace grc::rs;
  int failures = 0;
  int checks = 0;
#define CHECK(x) do { ++checks; if (!(x)) { std::fprintf(stderr, "FAIL: %s\n", #x); ++failures; } } while (0)
  PageAllocator<std::uint8_t> a;
  CHECK(!a.mapped(kPageAllocationThreshold - 1));
  CHECK(a.mapped(kPageAllocationThreshold));
  auto *small = a.allocate(kPageAllocationThreshold - 1);
  std::memset(small, 0xa5, kPageAllocationThreshold - 1);
  a.deallocate(small, kPageAllocationThreshold - 1);
  for (std::size_t n : {kPageAllocationThreshold, 16 * kPageAllocationThreshold}) {
    auto *p = a.allocate(n);
    std::memset(p, 0x5a, n);  // Commit every page, then verify that free removes the mapping.
#if defined(_WIN32)
    MEMORY_BASIC_INFORMATION info{};
    CHECK(VirtualQuery(p, &info, sizeof(info)) == sizeof(info));
    CHECK(info.Type == MEM_PRIVATE && info.AllocationBase == p);
#else
    Residency resident = 0;
    CHECK(mincore(p, 1, &resident) == 0 && (resident & 1));
#endif
#if !defined(_WIN32)
    const auto address = reinterpret_cast<std::uintptr_t>(p);
#endif
    a.deallocate(p, n);
#if defined(_WIN32)
    CHECK(VirtualQuery(p, &info, sizeof(info)) == sizeof(info));
    CHECK(info.State == MEM_FREE);
#else
    CHECK(unmapped(address));
    CHECK(unmapped(address + n - static_cast<std::size_t>(sysconf(_SC_PAGESIZE))));
#endif
  }
  {
    PageBytes bytes(kPageAllocationThreshold, 0x42);
    auto *p = bytes.data();
    PageBytes moved(std::move(bytes));
    CHECK(moved.data() == p && moved.back() == 0x42);
    moved.resize(2 * kPageAllocationThreshold);
    CHECK(moved.front() == 0x42 && moved.back() == 0);
    PageBytes{}.swap(moved);
    CHECK(moved.capacity() == 0);
  }
  bool overflow = false;
  try { auto *p = PageAllocator<std::uint64_t>{}.allocate(std::numeric_limits<std::size_t>::max());
    PageAllocator<std::uint64_t>{}.deallocate(p, std::numeric_limits<std::size_t>::max()); }
  catch (const std::bad_array_new_length &) { overflow = true; }
  CHECK(overflow);
  std::printf("page allocator: %d passed, %d failed\n", checks - failures, failures);
  return failures ? 1 : 0;
}
