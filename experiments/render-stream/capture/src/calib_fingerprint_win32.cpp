#include "calib_fingerprint.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdio>

#include "pe_image.h"
#include "rs_platform.h"

namespace grc {
bool collect_engine_fingerprint(ProcessFingerprint *out, std::string *error) {
  *out = ProcessFingerprint{};
  out->platform = "windows-x86_64";
  out->exe_path = rs::executable_path();
  out->pid = static_cast<int>(rs::process_id());
  if (out->exe_path.empty()) { *error = "cannot locate executable path"; return false; }
  const auto *base = reinterpret_cast<const uint8_t *>(GetModuleHandleW(nullptr));
  if (!base) { *error = "cannot locate main module"; return false; }
  const auto *dos = reinterpret_cast<const IMAGE_DOS_HEADER *>(base);
  const auto *nt = reinterpret_cast<const IMAGE_NT_HEADERS64 *>(base + dos->e_lfanew);
  PeHeaders h;
  if (!pe_parse_headers(base, nt->OptionalHeader.SizeOfHeaders, &h, error)) return false;
  uint64_t bytes = 0;
  if (!pe_image_sha256(out->exe_path, &out->image_sha256, &bytes, &out->image_base, error)) return false;
  out->time_date_stamp = h.time_date_stamp;
  out->size_of_image = h.size_of_image;
  out->dynamic_base = bool(h.dll_characteristics & IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE);
  if (!pe_read_codeview_id(base, h.size_of_image, h, true, &out->codeview_id, error)) return false;
  const uint64_t address = reinterpret_cast<uint64_t>(base);
  out->load_bias = address - out->image_base;
  for (const auto &section : h.sections) {
    if (section.characteristics & IMAGE_SCN_MEM_EXECUTE)
      out->exec_ranges.emplace_back(address + section.va, address + section.va + section.vsize);
    char line[160];
    std::snprintf(line, sizeof(line), "%s 0x%x 0x%x 0x%x", section.name.c_str(), section.va,
                  section.vsize, section.characteristics);
    out->exe_maps.emplace_back(line);
  }
  return true;
}
}  // namespace grc
