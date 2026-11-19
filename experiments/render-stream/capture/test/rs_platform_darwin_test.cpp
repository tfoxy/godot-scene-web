#include "rs_platform.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <mach/mach.h>
#include <malloc/malloc.h>
#include <pthread.h>
#include <pthread/qos.h>
#include <sys/socket.h>
#include <thread>

namespace rs = grc::rs;
namespace {
int checks = 0, failures = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL Darwin platform: %s\n", name); }
}
bool cloexec(int fd) {
  const int flags = ::fcntl(fd, F_GETFD);
  return flags >= 0 && (flags & FD_CLOEXEC);
}
bool no_sigpipe(int fd) {
  int value = 0;
  socklen_t size = sizeof(value);
  return ::getsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &value, &size) == 0 && value == 1;
}
void socket_cases() {
  std::string error;
  for (const auto family : {rs::AddrFamily::IPv4, rs::AddrFamily::IPv6}) {
    rs::SocketHandle listener = rs::kInvalidSocket;
    std::uint16_t port = 0;
    const auto loopback = rs::loopback_address(family);
    const bool listening = rs::tcp_listen(loopback, 0, 4, rs::kListenerWinBind, &listener, &port, &error);
    check(listening && port, "listen IPv4/IPv6");
    if (!listening) continue;
    check(cloexec(listener) && no_sigpipe(listener), "listener flags");
    const auto before = rs::fd_census();
    check(before && before->fds >= 0 && before->sockets >= 1 && before->inet_sockets >= 1,
          "libproc listener census");
    const auto client = rs::tcp_connect(loopback, port, &error);
    check(client != rs::kInvalidSocket, "connect IPv4/IPv6");
    if (client == rs::kInvalidSocket) { rs::socket_close(listener); continue; }
    check(cloexec(client) && no_sigpipe(client), "connected socket flags");
    rs::PollEntry ready{listener, rs::kPollIn, 0};
    check(rs::poll_sockets(&ready, 1, 1000) == 1 && (ready.revents & rs::kPollIn), "listener readable");
    const auto peer = rs::tcp_accept(listener);
    check(peer != rs::kInvalidSocket, "accept IPv4/IPv6");
    if (peer != rs::kInvalidSocket) {
      check(cloexec(peer) && no_sigpipe(peer), "accepted socket flags");
      check(rs::socket_send(client, "hello", 5) == 5, "socket send");
      ready = {peer, rs::kPollIn, 0};
      const bool readable = rs::poll_sockets(&ready, 1, 1000) == 1 && (ready.revents & rs::kPollIn);
      check(readable, "peer readable");
      if (readable) {
        char bytes[5]{};
        check(rs::socket_recv(peer, bytes, sizeof(bytes)) == 5 && std::memcmp(bytes, "hello", 5) == 0,
              "socket receive");
      }
      rs::socket_close(peer);
    }
    rs::socket_close(client);
    rs::socket_close(listener);
  }
  rs::Wake wake;
  check(rs::wake_open(&wake, &error), "wake open");
  if (wake.poll_handle != rs::kInvalidSocket) {
    check(cloexec(wake.poll_handle) && cloexec(wake.write_handle), "wake close-on-exec");
    rs::wake_signal(wake);
    rs::PollEntry ready{wake.poll_handle, rs::kPollIn, 0};
    check(rs::poll_sockets(&ready, 1, 1000) == 1, "wake readable");
    rs::wake_drain(wake);
    check(rs::poll_sockets(&ready, 1, 0) == 0, "wake drained");
    rs::wake_close(&wake);
  }
}
void file_cases() {
  const std::string root = GRC_TEST_TMP_DIR;
  check(rs::make_directories(root), "temporary directory");
  const auto path = root + "/évidence.txt";
  check(rs::write_private_file(path, "before"), "private file");
  for (const char *mode : {"r", "rb", "r+", "r+b", "rb+", "w", "wb", "w+", "a", "ab", "a+", "re"}) {
    auto *file = rs::open_file(path, mode);
    check(file != nullptr, "open file mode");
    if (file) {
      check(cloexec(::fileno(file)), "file close-on-exec");
      std::fclose(file);
    }
  }
  check(!rs::open_file(path, "wx") && errno == EEXIST, "exclusive create refuses existing file");
  check(!rs::open_file(path, "invalid") && errno == EINVAL, "invalid mode");
  check(rs::remove_file(path), "remove file");
  std::filesystem::remove_all(root);
}
void thread_cases() {
  const auto before = rs::thread_census();
  check(before && before->total > 0 && before->named, "Mach thread census");
  std::atomic<bool> ready = false, stop = false;
  std::thread worker([&] {
    rs::set_current_thread_name("grc-darwin-test-with-a-long-name");
    char name[64]{};
    check(::pthread_getname_np(::pthread_self(), name, sizeof(name)) == 0 &&
          std::string(name) == "grc-darwin-test-with-a-long-name", "Darwin thread name");
    rs::lower_current_thread_priority();
    check(::qos_class_self() == QOS_CLASS_UTILITY, "utility QoS");
    ready.store(true, std::memory_order_release);
    while (!stop.load(std::memory_order_acquire)) std::this_thread::yield();
  });
  while (!ready.load(std::memory_order_acquire)) std::this_thread::yield();
  const auto live = rs::thread_census();
  check(before && live && live->total >= before->total + 1, "live thread counted");
  check(live && live->named && live->named->count("grc-darwin-test") == 1,
        "census keeps 15-byte name key");
  stop.store(true, std::memory_order_release);
  worker.join();
  const auto self = ::pthread_mach_thread_np(::pthread_self());
  mach_port_urefs_t refs_before = 0, refs_after = 0;
  check(::mach_port_get_refs(::mach_task_self(), self, MACH_PORT_RIGHT_SEND, &refs_before) == KERN_SUCCESS,
        "thread send-right reference count");
  for (int i = 0; i < 100; ++i) {
    const auto census = rs::thread_census();
    check(census && census->named && census->named->count("grc-darwin-test") == 0,
          "joined thread absent from census");
  }
  check(::mach_port_get_refs(::mach_task_self(), self, MACH_PORT_RIGHT_SEND, &refs_after) == KERN_SUCCESS &&
        refs_after == refs_before, "thread census releases Mach send rights");
  rs::ThreadCpuClock clock;
  check(clock.elapsed_us() == -1 && clock.arm(), "thread CPU clock arm");
  const auto start = clock.mark();
  volatile std::uint64_t sum = 0;
  for (std::uint64_t i = 0; i < 100000; ++i) sum = sum + i;
  check(sum > 0 && start >= 0 && clock.ns_since(start) > 0 && clock.now_ns() > 0,
        "thread CPU clock advances");
  check(clock.ns_since(-1) == -1, "invalid CPU clock mark");
}
void memory_cases() {
  task_vm_info_data_t before{}, after{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  const auto first = ::task_info(::mach_task_self(), TASK_VM_INFO,
                                 reinterpret_cast<task_info_t>(&before), &count);
  const auto rss = rs::rss_bytes();
  count = TASK_VM_INFO_COUNT;
  const auto second = ::task_info(::mach_task_self(), TASK_VM_INFO,
                                  reinterpret_cast<task_info_t>(&after), &count);
  check(first == KERN_SUCCESS && second == KERN_SUCCESS && rss > 0 &&
            rss >= std::min(before.resident_size, after.resident_size) &&
            rss <= std::max(before.resident_size, after.resident_size), "RSS uses resident_size");
  malloc_statistics_t native{};
  ::malloc_zone_statistics(nullptr, &native);
  const auto heap = rs::process_heap();
  check(heap && heap->allocated > 0 && heap->allocated == native.size_in_use &&
            heap->committed == native.size_allocated, "process heap uses existing byte fields");
  check(!rs::private_bytes() && !rs::rss_anon_bytes() && !rs::heap_stats() && !rs::tsc_info(),
        "unavailable metrics stay absent");
  int visits = 0;
  rs::rss_split(&visits, [](void *value, const char *, std::int64_t) { ++*static_cast<int *>(value); });
  check(visits == 0, "no Linux RSS split");
  const auto anon = rs::anon_reading();
  check(std::strcmp(anon.name, "private_bytes") == 0 && anon.bytes == -1,
        "unavailable anonymous reading");
  check(!rs::dump_memory_info("unused"), "no Linux allocator dump");
}
} // namespace

int main() {
  check(rs::library_file_name("render_stream_net") == "librender_stream_net.dylib", "dylib name");
  const auto path = rs::executable_path();
  check(!path.empty() && path[0] == '/' && path.ends_with("rs_platform_darwin_test"), "executable path");
  const auto module = rs::module_path_of(reinterpret_cast<const void *>(&std::printf));
  std::string error;
  void *library = rs::library_open(module, &error);
  check(library && rs::library_symbol(library, "printf") && rs::library_loaded(module), "dyld loading");
  std::array<std::uint8_t, 1025> a{}, b{};
  check(rs::fill_random(nullptr, 0), "empty entropy request");
  check(rs::fill_random(a.data(), a.size()) && rs::fill_random(b.data(), b.size()) && a != b,
        "entropy request spans 256-byte chunks");
  check(std::any_of(a.begin(), a.end(), [](auto value) { return value != 0; }), "entropy nonzero");
  memory_cases();
  thread_cases();
  file_cases();
  socket_cases();
  std::printf("rs_platform_darwin_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
