#include "calib_fingerprint.h"

#include <elf.h>
#include <link.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

#include "rs_platform.h"

namespace grc {
namespace {

bool read_file(const std::string &path, std::string *out) {
  FILE *handle = std::fopen(path.c_str(), "rb");
  if (handle == nullptr) {
    return false;
  }
  char buffer[8192];
  size_t got = 0;
  while ((got = std::fread(buffer, 1, sizeof(buffer), handle)) > 0) {
    out->append(buffer, got);
    if (out->size() > (4u << 20)) {
      break;
    }
  }
  std::fclose(handle);
  return true;
}

struct MainObject {
  uint64_t bias = 0;
  bool found = false;
  bool pie = false;
  std::string build_id;
};

int phdr_callback(struct dl_phdr_info *info, size_t /*size*/, void *data) {
  auto *out = static_cast<MainObject *>(data);
  if (out->found) {
    return 0;
  }
  // The first object dl_iterate_phdr reports is the main program.
  if (info->dlpi_name != nullptr && info->dlpi_name[0] != '\0') {
    return 0;
  }
  out->found = true;
  out->bias = static_cast<uint64_t>(info->dlpi_addr);
  for (int i = 0; i < info->dlpi_phnum; ++i) {
    const ElfW(Phdr) &phdr = info->dlpi_phdr[i];
    if (phdr.p_type == PT_NOTE) {
      const auto *cursor = reinterpret_cast<const uint8_t *>(info->dlpi_addr + phdr.p_vaddr);
      const uint8_t *end = cursor + phdr.p_memsz;
      while (cursor + sizeof(ElfW(Nhdr)) <= end) {
        const auto *note = reinterpret_cast<const ElfW(Nhdr) *>(cursor);
        const uint8_t *name = cursor + sizeof(ElfW(Nhdr));
        const uint8_t *desc = name + ((note->n_namesz + 3) & ~3u);
        if (note->n_type == NT_GNU_BUILD_ID && note->n_namesz == 4 &&
            std::memcmp(name, "GNU", 4) == 0 && desc + note->n_descsz <= end) {
          char hex[3];
          for (uint32_t b = 0; b < note->n_descsz; ++b) {
            std::snprintf(hex, sizeof(hex), "%02x", desc[b]);
            out->build_id += hex;
          }
        }
        cursor = desc + ((note->n_descsz + 3) & ~3u);
      }
    }
  }
  // ET_DYN main programs are relocated; ET_EXEC ones are not. The ELF header is
  // at the start of the PT_LOAD segment that maps file offset 0.
  out->pie = (out->bias != 0);
  for (int i = 0; i < info->dlpi_phnum; ++i) {
    const ElfW(Phdr) &phdr = info->dlpi_phdr[i];
    if (phdr.p_type != PT_LOAD || phdr.p_offset != 0) {
      continue;
    }
    const auto *header =
        reinterpret_cast<const ElfW(Ehdr) *>(info->dlpi_addr + phdr.p_vaddr);
    if (std::memcmp(header->e_ident, ELFMAG, SELFMAG) == 0) {
      out->pie = (header->e_type == ET_DYN);
    }
    break;
  }
  return 1;
}

}  // namespace

bool collect_engine_fingerprint(ProcessFingerprint *out, std::string *error) {
  // Start empty for the same reason: the maps scan appends.
  *out = ProcessFingerprint{};
  out->exe_path = rs::executable_path();
  if (out->exe_path.empty()) {
    *error = "cannot read /proc/self/exe";
    return false;
  }
  out->pid = static_cast<int>(::getpid());
  out->exe_sha256 = sha256_file("/proc/self/exe");

  MainObject main_object;
  ::dl_iterate_phdr(phdr_callback, &main_object);
  if (!main_object.found) {
    *error = "cannot locate the main program's program headers";
    return false;
  }
  out->load_bias = main_object.bias;
  out->pie = main_object.pie;
  out->build_id = main_object.build_id;

  std::string maps;
  if (read_file("/proc/self/maps", &maps)) {
    size_t start = 0;
    while (start < maps.size()) {
      size_t end = maps.find('\n', start);
      if (end == std::string::npos) {
        end = maps.size();
      }
      const std::string line = maps.substr(start, end - start);
      start = end + 1;
      if (line.find(out->exe_path) == std::string::npos) {
        continue;
      }
      out->exe_maps.push_back(line);
      uint64_t begin = 0;
      uint64_t finish = 0;
      char perms[8] = {};
      if (std::sscanf(line.c_str(), "%llx-%llx %7s", reinterpret_cast<unsigned long long *>(&begin),
                      reinterpret_cast<unsigned long long *>(&finish), perms) == 3 &&
          std::strchr(perms, 'x') != nullptr) {
        out->exec_ranges.emplace_back(begin, finish);
      }
    }
  }

  return true;
}

}  // namespace grc
