#include "calib.h"
#include "iface.h"

#include <elf.h>
#include <link.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

namespace {
int total = 0, failed = 0, version_calls = 0;
bool fail_exe_path = false, fail_headers = false, fail_maps = false, fail_sha = false;
void check(bool ok, const char *name) {
  ++total;
  if (!ok) {
    ++failed;
    std::fprintf(stderr, "FAIL %s\n", name);
  }
}
void version(GDExtensionGodotVersion2 *out) {
  ++version_calls;
  out->string = "test-engine-version";
}
}  // namespace

extern "C" ssize_t __real_readlink(const char *, char *, size_t);
extern "C" ssize_t __wrap_readlink(const char *path, char *buffer, size_t size) {
  if (fail_exe_path && std::strcmp(path, "/proc/self/exe") == 0) {
    errno = ENOENT;
    return -1;
  }
  return __real_readlink(path, buffer, size);
}
extern "C" int __real_dl_iterate_phdr(int (*)(dl_phdr_info *, size_t, void *), void *);
extern "C" int __wrap_dl_iterate_phdr(int (*callback)(dl_phdr_info *, size_t, void *), void *data) {
  return fail_headers ? 0 : __real_dl_iterate_phdr(callback, data);
}
extern "C" FILE *__real_fopen(const char *, const char *);
extern "C" FILE *__wrap_fopen(const char *path, const char *mode) {
  if ((fail_maps && std::strcmp(path, "/proc/self/maps") == 0) ||
      (fail_sha && std::strcmp(path, "/proc/self/exe") == 0)) {
    errno = EACCES;
    return nullptr;
  }
  return __real_fopen(path, mode);
}

int main() {
  using namespace grc;
  g_iface.get_godot_version2 = version;
  ProcessFingerprint fp;
  fp.exe_maps.push_back("stale mapping");
  fp.exec_ranges.emplace_back(0, 1);
  fp.version_string = "stale version";
  std::string error;
  const bool collected = collect_engine_fingerprint(&fp, &error);
  check(collected && error.empty(), "collect OS fingerprint");
  if (!collected) return 1;
  check(version_calls == 0 && fp.version_string.empty(), "OS collection does not call engine interface");
  char exe[4096] = {};
  const auto length = ::readlink("/proc/self/exe", exe, sizeof(exe) - 1);
  check(length > 0 && fp.exe_path == std::string(exe, length > 0 ? length : 0), "executable path");
  check(fp.pid == ::getpid(), "process id");
  check(fp.exe_sha256.size() == 64 && fp.exe_sha256 == sha256_file("/proc/self/exe"), "whole executable SHA-256");
  check(sha256_file("/proc/self/no-such-grc-file").empty(), "missing file hash stays empty");
  Elf64_Ehdr header{};
  std::ifstream binary("/proc/self/exe", std::ios::binary);
  binary.read(reinterpret_cast<char *>(&header), sizeof(header));
  check(binary.good() && fp.pie == (header.e_type == ET_DYN), "PIE agrees with executable header");
  check(fp.pie || fp.load_bias == 0, "non-PIE has no load bias");
  check(fp.in_exec_range(reinterpret_cast<uint64_t>(&main)), "main belongs to executable ranges");
  check(!fp.in_exec_range(0), "stale ranges were cleared");
  std::ifstream maps("/proc/self/maps");
  std::vector<std::string> expected_maps;
  std::string line;
  while (std::getline(maps, line)) {
    if (line.find(fp.exe_path) != std::string::npos) expected_maps.push_back(line);
  }
  check(!expected_maps.empty() && fp.exe_maps == expected_maps, "raw main-executable mappings");
  for (const auto &range : fp.exec_ranges) {
    check(fp.in_exec_range(range.first) && fp.in_exec_range(range.second - 1) &&
              !fp.in_exec_range(range.second), "executable range is half-open");
  }
  ProcessFingerprint combined;
  check(collect_fingerprint(&combined, &error), "collect complete fingerprint");
  check(version_calls == 1 && combined.version_string == "test-engine-version", "wrapper calls engine version once");
  check(combined.exe_path == fp.exe_path && combined.exe_sha256 == fp.exe_sha256 &&
            combined.build_id == fp.build_id && combined.pid == fp.pid &&
            combined.pie == fp.pie && combined.load_bias == fp.load_bias &&
            combined.exec_ranges == fp.exec_ranges && combined.exe_maps == fp.exe_maps,
        "wrapper preserves every OS fact");
  Calibration calib;
  calib.sha256 = combined.exe_sha256;
  calib.version_string = combined.version_string;
  calib.build_id = combined.build_id;
  calib.build_id_present = !combined.build_id.empty();
  calib.pie = combined.pie;
  calib.platform = "linux-x86_64";
  std::vector<CheckResult> checks;
  check(check_fingerprint(calib, combined, &checks) && checks.size() == 5, "matching calibration passes all checks");
  calib.sha256 = "wrong";
  checks.clear();
  check(!check_fingerprint(calib, combined, &checks) && checks.size() == 5 &&
            checks[0].name == "exe_sha256" && !checks[0].ok &&
            checks[0].detail == "live " + combined.exe_sha256 + " record wrong",
        "fingerprint refusal detail stays exact");
  fail_exe_path = true;
  error.clear();
  check(!collect_fingerprint(&combined, &error) && error == "cannot read /proc/self/exe" &&
            combined.exe_path.empty() && combined.exe_maps.empty() && version_calls == 1,
        "unreadable executable refuses before engine call and clears old facts");
  fail_exe_path = false;
  fail_headers = true;
  error.clear();
  check(!collect_fingerprint(&combined, &error) &&
            error == "cannot locate the main program's program headers" && version_calls == 1,
        "missing program headers refusal stays exact");
  fail_headers = false;
  fail_maps = true;
  error.clear();
  check(collect_engine_fingerprint(&combined, &error) && error.empty() &&
            combined.exec_ranges.empty() && combined.exe_maps.empty(),
        "unreadable maps still collect identity without ranges");
  fail_maps = false;
  fail_sha = true;
  error.clear();
  check(collect_engine_fingerprint(&combined, &error) && error.empty() && combined.exe_sha256.empty(),
        "unreadable executable hash remains a calibration check failure");
  checks.clear();
  check(!check_fingerprint(calib, combined, &checks) && !checks[0].ok &&
            checks[0].detail == "live  record wrong", "empty hash refusal detail stays exact");
  fail_sha = false;
  std::printf("calib_fingerprint: %d/%d passed, %d failed\n", total - failed, total, failed);
  return failed ? 1 : 0;
}
