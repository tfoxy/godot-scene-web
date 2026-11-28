#include "calib_live.h"

#include <cstdio>
#include <cstring>
#include <algorithm>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "iface.h"
#include "pe_image.h"

namespace grc {
CalibLiveReader::CalibLiveReader(const ProcessFingerprint &fp) : bias_(fp.load_bias) {
#if defined(__APPLE__)
  const auto *h = reinterpret_cast<const mach_header_64 *>(_dyld_get_image_header(0));
  if (!h || h->magic != MH_MAGIC_64) { error_ = "cannot locate Mach-O main image"; return; }
  init_macho(fp, reinterpret_cast<const uint8_t *>(h), sizeof(*h) + size_t(h->sizeofcmds));
#elif !defined(_WIN32)
  if (fp.platform != "linux-x86_64") { error_ = "unsupported live reader platform"; return; }
  for (const auto &line : fp.exe_maps) {
    unsigned long long begin = 0, end = 0;
    char perms[5] = {};
    if (std::sscanf(line.c_str(), "%llx-%llx %4s", &begin, &end, perms) != 3 ||
        begin >= end || perms[0] != 'r') continue;
    readable_.emplace_back(begin, end);
    if (perms[1] == '-') readonly_.emplace_back(begin, end);
  }
  executable_ = fp.exec_ranges;
  if (readonly_.empty()) error_ = "no read-only main-image mappings in process fingerprint";
#else
  const auto *base = reinterpret_cast<const uint8_t *>(GetModuleHandleW(nullptr));
  MEMORY_BASIC_INFORMATION region{};
  if (!base) { error_ = "cannot locate main module"; return; }
  if (!VirtualQuery(base, &region, sizeof(region))) {
    error_ = "cannot query main-module header mapping"; return;
  }
  if (region.State != MEM_COMMIT || region.Protect & (PAGE_GUARD | PAGE_NOACCESS)) {
    error_ = "main-module header mapping is inaccessible"; return;
  }
  *this = CalibLiveReader(fp, base, region.RegionSize);
#endif
}
CalibLiveReader::CalibLiveReader(const ProcessFingerprint &fp, const uint8_t *base, size_t header_bytes)
    : bias_(fp.load_bias) {
  if (fp.platform == "macos-arm64" || fp.platform == "macos-x86_64") {
    init_macho(fp, base, header_bytes); return;
  }
  if (fp.platform != "windows-x86_64") { error_ = "unsupported PE live reader platform"; return; }
  if (!base) { error_ = "null PE main-image mapping"; return; }
  PeHeaders h; std::string error;
  const auto address = reinterpret_cast<uint64_t>(base);
  if (!pe_parse_headers(base, header_bytes, &h, &error)) {
    error_ = "invalid mapped PE headers: " + error; return;
  }
  if (!h.size_of_image || !h.size_of_headers || h.size_of_headers > h.size_of_image ||
      h.size_of_headers > header_bytes || address > UINT64_MAX - h.size_of_image) {
    error_ = "invalid mapped PE image/header extent"; return;
  }
  // The loader can rewrite ImageBase in memory. Address normalization must
  // still use the preferred base from the file fingerprint, in either case.
  if (h.image_base != fp.image_base && h.image_base != address) {
    error_ = "mapped PE ImageBase is neither preferred nor loaded base"; return;
  }
  if (h.size_of_image != fp.size_of_image || h.time_date_stamp != fp.time_date_stamp ||
      bool(h.dll_characteristics & 0x40) != fp.dynamic_base) {
    error_ = "mapped PE image identity differs from process fingerprint"; return;
  }
  if (address - fp.image_base != bias_) {
    error_ = "mapped PE load bias differs from process fingerprint"; return;
  }
  // Validate all section extents before exposing any range. Raw file offsets do
  // not describe the loaded image; only RVA and VirtualSize apply here.
  for (const auto &s : h.sections) {
    if (s.va > h.size_of_image || s.vsize > h.size_of_image - s.va) {
      error_ = "mapped PE section extends outside image"; return;
    }
    for (const auto &other : h.sections) {
      if (&s != &other && s.vsize && other.vsize &&
          uint64_t(s.va) < uint64_t(other.va) + other.vsize &&
          uint64_t(other.va) < uint64_t(s.va) + s.vsize) {
        error_ = "mapped PE sections overlap"; return;
      }
    }
  }
  for (const auto &s : h.sections) {
    if (!(s.characteristics & 0x40000000) || !s.vsize) continue;
    const uint64_t end = address + s.va + s.vsize;
    for (uint64_t cursor = address + s.va; cursor < end;) {
      uint64_t next = end;
      bool readable = true, writable = s.characteristics & 0x80000000;
      bool executable = s.characteristics & 0x20000000;
#if defined(_WIN32)
      MEMORY_BASIC_INFORMATION region{};
      if (!VirtualQuery(reinterpret_cast<const void *>(cursor), &region, sizeof(region)) ||
          reinterpret_cast<uint64_t>(region.AllocationBase) != address ||
          region.RegionSize > UINT64_MAX - reinterpret_cast<uint64_t>(region.BaseAddress)) break;
      next = std::min(end, reinterpret_cast<uint64_t>(region.BaseAddress) + region.RegionSize);
      if (next <= cursor) break;
      const DWORD protection = region.Protect & 0xff;
      readable = region.State == MEM_COMMIT && !(region.Protect & PAGE_GUARD) &&
          (protection == PAGE_READONLY || protection == PAGE_READWRITE ||
           protection == PAGE_WRITECOPY || protection == PAGE_EXECUTE_READ ||
           protection == PAGE_EXECUTE_READWRITE || protection == PAGE_EXECUTE_WRITECOPY);
      writable |= protection == PAGE_READWRITE || protection == PAGE_WRITECOPY ||
                  protection == PAGE_EXECUTE_READWRITE || protection == PAGE_EXECUTE_WRITECOPY;
      executable &= protection == PAGE_EXECUTE_READ || protection == PAGE_EXECUTE_READWRITE ||
                    protection == PAGE_EXECUTE_WRITECOPY;
#endif
      if (readable) {
        readable_.emplace_back(cursor, next);
        if (!writable) readonly_.emplace_back(cursor, next);
        if (executable) executable_.emplace_back(cursor, next);
      }
      cursor = next;
    }
  }
  if (readonly_.empty()) error_ = "no readable read-only PE main-image sections";
}
void CalibLiveReader::init_macho(const ProcessFingerprint &fp, const uint8_t *base, size_t header_bytes) {
  MachoHeaders h;
  if (!macho_parse_headers(base, header_bytes, fp.cputype, &h, &error_, true)) return;
  if (h.uuid != fp.uuid || h.cputype != fp.cputype || h.cpusubtype != fp.cpusubtype || h.pie != fp.pie ||
      fp.platform != (h.cputype == macho_arm64 ? "macos-arm64" : "macos-x86_64")) {
    error_ = "mapped Mach-O identity differs from process fingerprint"; return;
  }
  if (h.image_base + bias_ != reinterpret_cast<uint64_t>(base)) {
    error_ = "mapped Mach-O load bias differs from process fingerprint"; return;
  }
  if (!fp.bind_pure_virtual) { error_ = "missing Mach-O pure-virtual bind address"; return; }
  // Validate every range before exposing it. The dyld slide is signed; unsigned
  // addition also handles a negative slide, but a segment must never wrap.
  for (const auto &s : h.segments) {
    if (!s.size || !(s.protection & 1)) continue;
    const uint64_t lo = s.addr + bias_;
    if (lo > UINT64_MAX - s.size) { error_ = "mapped Mach-O segment overflow"; return; }
    for (const auto &other : h.segments) {
      if (&s != &other && other.size && (other.protection & 1) &&
          s.addr < other.addr + other.size && other.addr < s.addr + s.size) {
        error_ = "mapped Mach-O segments overlap"; return;
      }
    }
  }
  for (const auto &s : h.segments) {
    if (!s.size || !(s.protection & 1)) continue;
    const uint64_t lo = s.addr + bias_;
    readable_.emplace_back(lo, lo + s.size);
    if (s.protection & 4) executable_.emplace_back(lo, lo + s.size);
    for (const auto &section : h.sections) {
      if (section.addr < s.addr || section.addr - s.addr > s.size ||
          section.size > s.size - (section.addr - s.addr) || (section.flags & 0x80000400)) continue;
      // __DATA,__const carries x86_64 RTTI despite its writable parent segment.
      // These are scan ranges only: this reader never changes memory or protection.
      if (!(s.protection & 2) || s.name == "__DATA_CONST" || s.name == "__AUTH_CONST" ||
          section.name == "__DATA,__const")
        readonly_.emplace_back(section.addr + bias_, section.addr + bias_ + section.size);
    }
  }
  macho_ = true;
  pure_virtual_ = fp.bind_pure_virtual;
  if (readonly_.empty()) error_ = "no Mach-O constant sections to scan";
}
CalibWord CalibLiveReader::read_u64(uint64_t address) const {
  for (auto [lo, hi] : readable_) {
    if (address >= lo && address <= hi && hi - address >= sizeof(uint64_t)) {
      uint64_t bits = 0;
      std::memcpy(&bits, reinterpret_cast<const void *>(address), sizeof(bits));
      if (macho_ && bits == pure_virtual_) return {CalibWord::unresolved, 0};
      return {CalibWord::value, bits};
    }
  }
  return {};
}
bool CalibLiveReader::is_pure_bind(uint64_t address) const {
  return macho_ && read_u64(address).kind == CalibWord::unresolved;
}
bool CalibLiveReader::is_exec(uint64_t address) const {
  for (auto [lo, hi] : executable_) if (address >= lo && address < hi) return true;
  return false;
}
bool derive_live_calibration(const AbiTable &table, const ProcessFingerprint &fp,
                             Calibration *out, std::vector<CheckResult> *checks,
                             std::string *error, bool require_exe_sha256) {
  *out = {};
  checks->push_back({"derive_census", true, "not-run"});
  const auto fail = [&](const std::string &detail) {
    checks->push_back({"derive_typeinfo", false, detail});
    *error = detail;
    return false;
  };
  const bool pe = fp.platform == "windows-x86_64";
  const bool macho = fp.platform == "macos-arm64" || fp.platform == "macos-x86_64";
#if !defined(_WIN32)
  if (pe) return fail("PE live derivation requires Windows main-image mappings");
#endif
#if !defined(__APPLE__)
  if (macho) return fail("Mach-O live derivation requires Darwin main-image mappings");
#endif
  if (fp.platform != "linux-x86_64" && !pe && !macho) return fail("unsupported live engine platform");
  if ((pe ? fp.image_sha256.empty() : fp.exe_sha256.empty()) || fp.version_string.empty())
    return fail("incomplete live engine identity");
  if (pe && require_exe_sha256 && fp.exe_sha256.empty())
    return fail("whole-file PE digest unavailable after identity worker");
  CalibLiveReader reader(fp);
  if (!reader.error().empty()) return fail("live reader: " + reader.error());
  if (reader.readonly_ranges().empty()) return fail("no read-only main-image mappings");
  void *singleton = singleton_object("RenderingServer");
  if (!singleton) return fail("RenderingServer singleton unavailable");
  uint64_t vptr = 0;
  std::memcpy(&vptr, singleton, sizeof(vptr));
  Calibration identity;
  identity.version_string = fp.version_string;
  identity.sha256 = fp.exe_sha256;
  if (macho) {
    identity.uuid = fp.uuid;
    identity.cputype = fp.cputype; identity.cpusubtype = fp.cpusubtype;
    identity.slice_offset = fp.slice_offset; identity.slice_size = fp.slice_size;
  }
  if (pe) {
    // Detached derivation consumes the worker's whole-file digest. Startup-loaded modes
    // retain the synchronous fallback when only the image identity was collected.
    if (identity.sha256.empty()) identity.sha256 = sha256_file(fp.exe_path);
    if (identity.sha256.empty()) return fail("cannot hash PE executable for derived record");
    identity.image_sha256 = fp.image_sha256;
    identity.codeview_id = fp.codeview_id;
    identity.codeview_id_present = !fp.codeview_id.empty();
    identity.time_date_stamp = fp.time_date_stamp;
    identity.size_of_image = fp.size_of_image;
    identity.image_base = fp.image_base;
    identity.dynamic_base = fp.dynamic_base;
  }
  identity.build_id = fp.build_id;
  identity.build_id_present = !fp.build_id.empty();
  identity.platform = fp.platform;
  identity.pie = fp.pie;
  const auto name = fp.exe_path.substr(fp.exe_path.find_last_of("/\\") + 1);
  identity.flavor = name.find("debug") != std::string::npos ? "template_debug" : "template_release";
  if (!derive_calibration(reader, vptr, table, &identity, checks, error)) return false;
  *out = std::move(identity);
  return true;
}
}  // namespace grc
