#include "rs_capture_api.h"
#include "rs_detach_release.h"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

using namespace grc::rs::capture;
namespace {
int checks = 0, failures = 0;
void check(bool ok, const char *what) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
}
void lifecycle(bool arm_already_released) {
  Api api;
  api.loaded(State::Standby);
  std::vector<std::string> events;
  int releases = 0;
  auto cleanup = [&] {
    if (!arm_already_released) events.emplace_back("arm");
    events.emplace_back("carrier");
    events.emplace_back("registry");
    events.emplace_back("hook-log");
    events.emplace_back("callbacks");
    return true;
  };
  auto release = [&] {
    ++releases;
    check(events.size() == (arm_already_released ? 4u : 5u) &&
          events.back() == "callbacks", "release follows every final attachment free");
    check(api.attachment() == Attachment::Detaching, "release runs before detached completion");
  };
  auto detach = [&] { return detach_release(cleanup, release); };
  check(api.detach({}, detach) == 0 && releases == 1, "detach releases exactly once");
  check(api.detach({}, detach) == 0 && releases == 1, "idempotent detach does not release again");
  check(api.shutdown(detach) && releases == 1, "detached shutdown does not release again");
}
void refused() {
  int releases = 0;
  check(!detach_release([] { return false; }, [&] { ++releases; }) && releases == 0,
        "failed cleanup does not release");
}
// Pin the production wiring as well as exercising its injected hook above.
void wiring(const char *path) {
  std::ifstream file(path);
  const std::string source((std::istreambuf_iterator<char>(file)), {});
  check(file.good() || file.eof(), "read entry source");
  const auto start = source.find("bool attachment_detach() {");
  check(start != std::string::npos, "production detach exists");
  if (start == std::string::npos) return;
  const auto end = source.find("\n}", start);
  const auto body = source.substr(start, end - start);
  check(body.find("cap::detach_release(attachment_detach_free,") != std::string::npos &&
        body.find("rs::heap_trim()") != std::string::npos,
        "production detach wraps final frees with allocator release");
  const auto free_start = source.find("bool attachment_detach_free() {");
  check(free_start != std::string::npos, "production final cleanup exists");
  if (free_start == std::string::npos) return;
  const auto free_end = source.find("\n}", free_start);
  const auto frees = source.substr(free_start, free_end - free_start);
  check(frees.find("carrier_registry().close()") != std::string::npos &&
        frees.find("registry_names_release()") != std::string::npos &&
        frees.find("hooks_attachment_release()") != std::string::npos &&
        frees.find("attachment_callbacks(false)") != std::string::npos,
        "final cleanup includes carrier, registry, hook logs and callback removal");
}
}  // namespace
int main(int argc, char **argv) {
  lifecycle(false);
  lifecycle(true);  // arm_release's release_recorded early return must not skip the final release.
  refused();
  if (argc > 1) wiring(argv[1]);
  std::printf("rs_detach_release: %d/%d passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
