#include "rs_platform.h"

#include <cstdio>
#include <cstring>

int main() {
  namespace rs = grc::rs;
  int checks = 0, failures = 0;
  auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) {
      ++failures;
      std::fprintf(stderr, "FAIL %s\n", what);
    }
  };
  rs::set_current_thread_name("grc-proc-test");
  const auto threads = rs::thread_census();
  check(threads && threads->total >= 1, "thread count");
  check(rs::rss_bytes() > 0, "working set");
  const auto fds = rs::fd_census();
  const auto anon = rs::rss_anon_bytes();
  const auto heap = rs::heap_stats();
  struct Split {
    int fields = 0;
    bool valid = true;
  } split;
  rs::rss_split(&split, [](void *context, const char *name, std::int64_t bytes) {
    auto &out = *static_cast<Split *>(context);
    constexpr const char *names[] = {"rss_anon_bytes", "rss_file_bytes", "rss_shmem_bytes"};
    out.valid = out.valid && out.fields < 3 &&
                std::strcmp(name, names[out.fields]) == 0 && bytes >= 0;
    ++out.fields;
  });
#if defined(_WIN32)
  check(threads && !threads->named && threads->ids.size() == std::size_t(threads->total),
        "snapshot ids; names unavailable");
  check(rs::private_bytes().value_or(0) > 0, "private bytes");
  check(!fds, "fd and socket census unavailable");
  check(!anon && split.fields == 0, "Linux RSS split unavailable");
  check(!heap && !rs::heap_trim(), "glibc heap unavailable");
  check(!rs::dump_memory_info("rs_process_test"), "smaps and malloc info unavailable");
#else
  check(threads && threads->named && threads->named->count("grc-proc-test") == 1 &&
            threads->named->at("grc-proc-test") == 1,
        "capture thread name and count");
  check(!rs::private_bytes(), "private bytes unavailable");
  check(fds && fds->fds >= 1 && fds->sockets >= 0 && fds->inet_sockets >= 0,
        "fd and socket census");
  int visited = 0;
  rs::fd_census(&visited, [](void *context, const rs::FdCensus &value) {
    if (value.fds >= 1 && value.sockets >= 0 && value.inet_sockets >= 0)
      ++*static_cast<int *>(context);
  });
  check(visited == 1, "fd census visitor");
  check(anon && *anon > 0 && split.valid && split.fields == 3, "RSS split");
  check(heap && heap->uordblks > 0 && heap->arena > 0, "heap stats");
  (void)rs::heap_trim();
  check(rs::dump_memory_info("rs_process_test"), "memory info dump");
  const auto nonempty = [](const char *path) {
    auto *file = rs::open_file(path, "r");
    const bool result = file && std::fgetc(file) != EOF;
    if (file) std::fclose(file);
    rs::remove_file(path);
    return result;
  };
  check(nonempty("rs_process_test.smaps"), "smaps contents");
  check(nonempty("rs_process_test.malloc.xml"), "malloc info contents");
#endif
  std::printf("rs_process_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
