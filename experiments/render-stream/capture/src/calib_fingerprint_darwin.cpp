#include "calib_fingerprint_darwin.h"

#include <chrono>
#include <cstdio>
#include "macho_image.h"

#if defined(__APPLE__)
#include <cstdlib>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#endif

namespace grc {
bool collect_macho_fingerprint(const std::string &path, const uint8_t *header,
                               size_t header_bytes, uint64_t slide, uint64_t pure_virtual,
                               int pid, ProcessFingerprint *out, std::string *error) {
  *out = {};
  error->clear();
  MachoHeaders memory, file;
  if (!macho_parse_headers(header, header_bytes, 0, &memory, error, true)) return false;
  ProcessFingerprint fp;
  fp.platform = memory.cputype == macho_arm64 ? "macos-arm64" : "macos-x86_64";
  fp.exe_path = path;
  fp.pid = pid;
  const auto start = std::chrono::steady_clock::now();
  const bool hashed = macho_file_identity(path, memory.cputype, &file, &fp.exe_sha256, error);
  std::printf("[grc] fingerprint: slice hash %.3f ms over %llu bytes\n",
              std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count(),
              static_cast<unsigned long long>(file.slice_size));
  std::fflush(stdout);
  if (!hashed) return false;
  if (file.uuid != memory.uuid || file.cputype != memory.cputype ||
      file.cpusubtype != memory.cpusubtype || file.pie != memory.pie) {
    *error = "Mach-O file identity differs from running slice"; return false;
  }
  if (!pure_virtual) { *error = "cannot resolve __cxa_pure_virtual"; return false; }
  if (memory.image_base + slide != reinterpret_cast<uint64_t>(header)) {
    *error = "Mach-O main-image address differs from dyld slide"; return false;
  }
  fp.uuid = memory.uuid;
  fp.cputype = memory.cputype; fp.cpusubtype = memory.cpusubtype;
  fp.slice_offset = file.slice_offset; fp.slice_size = file.slice_size;
  fp.pie = memory.pie;
  fp.load_bias = slide;
  fp.bind_pure_virtual = pure_virtual;
  for (const auto &s : memory.segments) {
    if (!s.size || !s.protection) continue;  // __PAGEZERO is not mapped.
    const uint64_t begin = s.addr + slide;
    if (begin > UINT64_MAX - s.size) { *error = "Mach-O mapped segment overflow"; return false; }
    if (s.protection & 4) fp.exec_ranges.emplace_back(begin, begin + s.size);
    char line[160];
    std::snprintf(line, sizeof(line), "%s 0x%llx 0x%llx 0x%x", s.name.c_str(),
                  static_cast<unsigned long long>(begin),
                  static_cast<unsigned long long>(s.size), s.protection);
    fp.exe_maps.emplace_back(line);
  }
  if (fp.exec_ranges.empty()) { *error = "no Mach-O executable mappings"; return false; }
  *out = std::move(fp);
  return true;
}

#if defined(__APPLE__)
bool collect_engine_fingerprint(ProcessFingerprint *out, std::string *error) {
  *out = {};
  error->clear();
  const auto *header = reinterpret_cast<const mach_header_64 *>(_dyld_get_image_header(0));
  if (!header || header->magic != MH_MAGIC_64) {
    *error = "cannot locate 64-bit Mach-O main image"; return false;
  }
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::vector<char> path(size);
  if (!size || _NSGetExecutablePath(path.data(), &size)) {
    *error = "cannot locate executable path"; return false;
  }
  char *resolved = realpath(path.data(), nullptr);
  if (!resolved) { *error = "cannot resolve executable path"; return false; }
  const std::string executable(resolved);
  std::free(resolved);
  return collect_macho_fingerprint(executable, reinterpret_cast<const uint8_t *>(header),
      sizeof(*header) + size_t(header->sizeofcmds),
      static_cast<uint64_t>(_dyld_get_image_vmaddr_slide(0)),
      reinterpret_cast<uint64_t>(dlsym(RTLD_DEFAULT, "__cxa_pure_virtual")),
      static_cast<int>(getpid()), out, error);
}
#endif
}  // namespace grc
