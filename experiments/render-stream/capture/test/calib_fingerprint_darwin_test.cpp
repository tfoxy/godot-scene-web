// Simulated dyld memory on Linux: apply the fixture's rebases and binds, never execute it.
#include "calib_fingerprint_darwin.h"
#include "calib_live.h"
#include "iface.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>

namespace {
int total = 0, failed = 0;
void check(bool ok, const char *name) {
  ++total;
  if (!ok) { ++failed; std::fprintf(stderr, "FAIL %s\n", name); }
}
void *object = nullptr;
GDExtensionObjectPtr singleton(GDExtensionConstStringNamePtr) { return object; }
}
int main(int argc, char **argv) {
  using namespace grc;
  if (argc != 5) return 2;
  const uint32_t cpu = std::strtoul(argv[2], nullptr, 0);
  std::ifstream input(argv[1], std::ios::binary);
  std::vector<uint8_t> file((std::istreambuf_iterator<char>(input)), {});
  MachoHeaders h;
  std::map<uint64_t, MachoFixup> fixups;
  AbiTable table;
  Calibration expected;
  std::string error;
  if (!macho_parse_headers(file.data(), file.size(), cpu, &h, &error) ||
      !macho_read_fixups(file.data() + h.slice_offset, h.slice_size, h, &fixups, &error) ||
      !load_abi_table(argv[3], &table, &error) || !load_calibration(argv[4], &expected, &error)) {
    std::fprintf(stderr, "%s\n", error.c_str()); return 2;
  }
  uint64_t size = 0;
  for (const auto &s : h.segments) if (s.protection)
    size = std::max(size, s.addr + s.size - h.image_base);
  std::vector<uint64_t> storage((size + 7) / 8);
  auto *image = reinterpret_cast<uint8_t *>(storage.data());
  const auto address = reinterpret_cast<uint64_t>(image), bias = address - h.image_base;
  for (const auto &s : h.segments) if (s.file_size && s.protection)
    std::memcpy(image + s.addr - h.image_base, file.data() + h.slice_offset + s.offset, s.file_size);
  const uint64_t pure = address + size + 0x100; // external libSystem address
  for (const auto &[addr, f] : fixups) {
    const uint64_t value = f.symbol.empty() ? f.value + bias : pure;
    std::memcpy(image + addr - h.image_base, &value, 8);
  }
  const auto before = storage;
  ProcessFingerprint fp;
  check(collect_macho_fingerprint(argv[1], image, 4096, bias, pure, 123, &fp, &error),
        "collect fingerprint from simulated running slice");
  if (fp.exe_sha256.empty()) { std::fprintf(stderr, "%s\n", error.c_str()); return 1; }
  fp.version_string = expected.version_string;
  check(fp.platform == expected.platform && fp.cputype == cpu && fp.pid == 123 &&
        fp.exe_path == argv[1] && fp.bind_pure_virtual == pure, "platform, path, pid and resolved bind");
  std::vector<CheckResult> checks;
  check(check_fingerprint(expected, fp, &checks), "running slice agrees with offline record");
  auto wrong = expected; wrong.cputype = cpu == macho_arm64 ? macho_x86_64 : macho_arm64;
  check(!check_fingerprint(wrong, fp, &checks), "wrong CPU record refuses");
  CalibLiveReader reader(fp, image, 4096);
  check(reader.error().empty(), "mapped Mach-O reader accepts running slice");
  if (!reader.error().empty()) { std::fprintf(stderr, "%s\n", reader.error().c_str()); return 1; }
  check(reader.uses_bind_placeholder() && reader.load_bias() == bias, "bind kind and dyld slide");
  check(reader.is_exec(address + 0x1000) && !reader.is_exec(address + 0x4000), "executable ranges");
  check(reader.read_u64(address + size - 7).kind == CalibWord::unmapped &&
        reader.read_u64(address - 8).kind == CalibWord::unmapped, "read bounds");
  const uint64_t ap = expected.abstract_vtable_vaddr + bias + 16;
  const uint64_t cv = expected.concrete_vtable_vaddr + bias + 16;
  const uint64_t hook = ap + expected.slots.front().second * 8;
  check(reader.read_u64(hook).kind == CalibWord::unresolved && reader.is_pure_bind(hook),
        "dyld-resolved pure slot becomes bind placeholder");
  Calibration actual = expected;
  check(derive_calibration(reader, cv, table, &actual, &checks, &error), "live Mach-O RTTI derives");
  check(serialize_derived_calibration(actual, table) == serialize_derived_calibration(expected, table),
        "live topology equals offline record byte for byte");
  g_iface.global_get_singleton = singleton;
  object = const_cast<uint64_t *>(&cv);
  LiveVtableFacts facts;
  check(check_slot_mask(actual, fp, &facts, &checks), "bind mask accepts derived layout");
  ++actual.concrete_vtable_vaddr;
  check(!check_slot_mask(actual, fp, &facts, &checks), "wrong vptr refuses before dereference");
  actual = expected;
  for (auto &slot : actual.slots) ++slot.second;
  for (auto &anchor : actual.anchors) ++anchor.second;
  check(!check_slot_mask(actual, fp, &facts, &checks), "slot-shifted record refuses");
  auto bad = fp; ++bad.cpusubtype;
  check(!CalibLiveReader(bad, image, 4096).error().empty(), "reader rejects wrong mapped subtype");
  bad = fp; bad.uuid[0] ^= 1;
  check(!CalibLiveReader(bad, image, 4096).error().empty(), "reader rejects wrong UUID");
  bad = fp; ++bad.load_bias;
  check(!CalibLiveReader(bad, image, 4096).error().empty(), "reader rejects wrong slide");
  bad = fp; bad.bind_pure_virtual = 0;
  check(!CalibLiveReader(bad, image, 4096).error().empty(), "reader rejects missing bind");
  check(!CalibLiveReader(fp, image, 32).error().empty(), "reader bounds mapped headers");
  // A mixed pure slot cannot be mistaken for a valid bind pattern.
  const uint64_t zero = 0;
  std::memcpy(reinterpret_cast<void *>(hook), &zero, 8);
  actual = expected;
  check(!derive_calibration(reader, cv, table, &actual, &checks, &error), "mixed null/bind slots refuse");
  std::memcpy(reinterpret_cast<void *>(hook), &pure, 8);
  auto *uuid = image + 32;
  for (uint32_t i = 0; i < 5; ++i) {
    uint32_t cmd = 0, length = 0;
    std::memcpy(&cmd, uuid, 4); std::memcpy(&length, uuid + 4, 4);
    if (cmd == 0x1b) break;
    uuid += length;
  }
  uuid[8] ^= 1;
  bad = fp;
  check(!collect_macho_fingerprint(argv[1], image, 4096, bias, pure, 123, &bad, &error) &&
        bad.exe_sha256.empty() && bad.exec_ranges.empty(), "file/memory UUID mismatch clears stale output");
  uuid[8] ^= 1;
  check(storage == before, "collection, derivation and checks never write mapped image");
  g_iface = {};
  std::printf("calib_fingerprint_darwin: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
