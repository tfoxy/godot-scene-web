#include "calib.h"
#include "abi.h"
#include "calib_live.h"
#include "iface.h"
#include "rs_platform.h"
#include <array>
#include <cstdio>
#include <cstring>
#include <fstream>
#if !defined(_WIN32)
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace {
int total = 0, failed = 0;
void *object = nullptr;
GDExtensionObjectPtr singleton(GDExtensionConstStringNamePtr) { return object; }
volatile int marker = 0;
void code() { marker = 1; }
void pure() { marker = 2; }
void check(bool ok, const char *name) {
  ++total;
  if (!ok) { ++failed; std::fprintf(stderr, "FAIL %s\n", name); }
}
const grc::CheckResult &find(const std::vector<grc::CheckResult> &checks, const char *name) {
  for (const auto &r : checks) if (r.name == name) return r;
  static const grc::CheckResult missing{};
  return missing;
}
#if !defined(_WIN32)
grc::Color clear_color(void *) { return {0.25f, 0.5f, 0.75f, 1.0f}; }
bool wrong_color = false;
GDExtensionMethodBindPtr color_bind(GDExtensionConstStringNamePtr,
                                   GDExtensionConstStringNamePtr, GDExtensionInt) {
  return reinterpret_cast<GDExtensionMethodBindPtr>(1);
}
void color_ptrcall(GDExtensionMethodBindPtr, GDExtensionObjectPtr,
                  const GDExtensionConstTypePtr *, GDExtensionTypePtr out) {
  auto color = clear_color(nullptr);
  if (wrong_color) color.r = 1.0f;
  std::memcpy(out, &color, sizeof(color));
}
void live_derive() {
  using namespace grc;
  const size_t size = static_cast<size_t>(::sysconf(_SC_PAGESIZE));
  auto *page = static_cast<uint64_t *>(::mmap(nullptr, size, PROT_READ | PROT_WRITE,
                                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  check(page != MAP_FAILED, "allocate live read-only image fixture");
  if (page == MAP_FAILED) return;
  const auto addr = [&](size_t word) { return reinterpret_cast<uint64_t>(page + word); };
  std::memcpy(page + 8, "15RenderingServer", 18);
  std::memcpy(page + 16, "22RenderingServerDefault", 25);
  page[32] = page[40] = reinterpret_cast<uint64_t>(&code);
  page[33] = addr(8); page[41] = addr(16); page[42] = addr(32);
  page[65] = addr(32); page[81] = addr(40);
  for (int i = 0; i < 4; ++i) {
    page[66 + i] = i == 2 ? 0 : reinterpret_cast<uint64_t>(&code);
    page[82 + i] = reinterpret_cast<uint64_t>(&code);
  }
  page[84] = reinterpret_cast<uint64_t>(&clear_color);
  page[70] = page[86] = 1;  // Non-code sentinels terminate both tables.
  check(::mprotect(page, size, PROT_READ) == 0, "protect live fixture read-only");
  ProcessFingerprint fp;
  fp.exe_sha256 = std::string(64, 'a'); fp.version_string = "fixture release";
  fp.build_id = "fixture"; fp.exe_path = "/fixture/linux_release";
  fp.load_bias = addr(0) - 0x1000; fp.pie = true;
  fp.exec_ranges = {{reinterpret_cast<uint64_t>(&code), reinterpret_cast<uint64_t>(&code) + 1},
                    {reinterpret_cast<uint64_t>(&clear_color), reinterpret_cast<uint64_t>(&clear_color) + 1}};
  char map[160];
  std::snprintf(map, sizeof(map), "%llx-%llx r--p 00000000 00:00 0 /fixture/linux_release",
                static_cast<unsigned long long>(addr(0)), static_cast<unsigned long long>(addr(0) + size));
  fp.exe_maps = {map};
  AbiTable table;
  table.header_sha256 = std::string(64, 'b');
  table.new_virtuals = {{"anchor_a", false}, {"hook", true}, {"anchor_b", false}};
  table.wanted_slots = {{"hook", 1}, {"get_default_clear_color", 1}};
  void *vptr = page + 82; object = &vptr;
  Calibration c; std::vector<CheckResult> checks; std::string error;
  check(derive_live_calibration(table, fp, &c, &checks, &error), "derive live singleton via fake iface");
  check(find(checks, "derive_census").ok && find(checks, "derive_census").detail == "not-run",
        "derive census is informational not-run");
  check(find(checks, "derive_typeinfo").ok && find(checks, "derive_abstract_vtable_unique").ok &&
        find(checks, "derive_slot_pattern").detail == "3/3 matched", "all derive checks reported");
  check(c.sha256 == fp.exe_sha256 && c.version_string == fp.version_string && c.pie &&
        c.build_id_present && c.build_id == fp.build_id && c.flavor == "template_release" &&
        c.concrete_vtable_vaddr == 0x1280, "derived identity and load bias");
  LiveVtableFacts facts;
  check(check_slot_mask(c, fp, &facts, &checks), "unchanged slot mask accepts derived record");
  g_iface.classdb_get_method_bind = color_bind;
  g_iface.object_method_bind_ptrcall = color_ptrcall;
  check(check_behaviour(c, facts, &checks), "unchanged behaviour accepts derived record");
  check(find(checks, "behaviour_probe").detail.starts_with("bind ("), "derived behaviour actually calls both getters");
  wrong_color = true; checks.clear();
  check(!check_behaviour(c, facts, &checks), "unchanged behaviour rejects mismatched derived probe");
  wrong_color = false;
  g_iface.classdb_get_method_bind = nullptr;
  g_iface.object_method_bind_ptrcall = nullptr;
  check(vptr == page + 82 && page[65] == addr(32), "derivation and checks never write engine memory");
  const auto record = serialize_derived_calibration(c, table);
  check(record.find("devirtualized_slots") == std::string::npos &&
        record.find("dropped_families") == std::string::npos, "derived Linux record omits census fields");
  CalibLiveReader reader(fp);
  check(reader.read_u64(0).kind == CalibWord::unmapped &&
        reader.read_u64(UINT64_MAX - 3).kind == CalibWord::unmapped &&
        reader.read_u64(addr(0) + size - 7).kind == CalibWord::unmapped &&
        reader.read_u64(addr(0) + size - 8).kind == CalibWord::value,
        "live reader refuses unmapped and crossing words");
  auto invalid = fp;
  invalid.exe_maps.clear(); checks.clear();
  check(!derive_live_calibration(table, invalid, &c, &checks, &error) && c.slots.empty(),
        "missing main-image maps refuses and clears output");
  invalid.exe_maps = {std::string(map).replace(std::string(map).find("r--p"), 4, "rw-p")};
  check(CalibLiveReader(invalid).readonly_ranges().empty(), "writable mappings excluded from scan");
  invalid = fp; invalid.platform = "windows-x86_64";
  check(!derive_live_calibration(table, invalid, &c, &checks, &error), "PE live derivation refuses pending reader");
  object = nullptr;
  check(!derive_live_calibration(table, fp, &c, &checks, &error), "missing singleton refuses");
  object = &vptr;
  check(::mprotect(page, size, PROT_READ | PROT_WRITE) == 0, "unprotect fixture for refusal injection");
  page[66 + 2] = reinterpret_cast<uint64_t>(&code);
  check(::mprotect(page, size, PROT_READ) == 0, "reprotect mutated fixture");
  checks.clear();
  check(!derive_live_calibration(table, fp, &c, &checks, &error) &&
        !find(checks, "derive_slot_pattern").ok && c.slots.empty() && vptr == page + 82,
        "live slot-pattern mismatch refuses without writing vptr");
  ::munmap(page, size);
}
#endif

}
int main(int argc, char **argv) {
  using namespace grc;
  for (int i = 1; i < argc; ++i) {
    Calibration c; std::string error;
    check(load_calibration(argv[i], &c, &error), argv[i]);
    if (c.platform == "windows-x86_64") {
      check(c.image_sha256.size() == 64 && c.image_base != 0 && c.dynamic_base &&
            c.size_of_image > 0 && c.time_date_stamp > 0 && !c.codeview_id_present,
            "committed PE identity fields");
    } else if (c.platform == "macos-arm64" || c.platform == "macos-x86_64") {
      check(c.uuid.size() == 32 && c.sha256.size() == 64 && c.file_sha256.size() == 64 &&
            c.cputype == (c.platform == "macos-arm64" ? 0x0100000cu : 0x01000007u) &&
            c.cpusubtype == (c.platform == "macos-arm64" ? 0u : 3u) &&
            c.slice_size > 0 && c.slice_offset > 0 && c.pie &&
            c.placeholder_kind == "bind" && c.pure_placeholder == 0 &&
            c.pure_placeholder_symbol == "___cxa_pure_virtual", "committed Mach-O identity fields");
    } else check(c.placeholder_kind == "null" && c.devirtualized_slots.empty(), "ELF optional defaults");
  }
  const std::string path = "calib-slot-mask-" + std::to_string(rs::process_id()) + ".json";
  {
    std::ofstream file(rs::fs_path(path));
    file << R"({"schema":"render-stream-calibration/1",
      "engine":{"image_sha256":"digest","codeview_id":"000102030405060708090a0b0c0d0e0f:3",
        "time_date_stamp":1592590337,"size_of_image":32768,"image_base":"0x140000000","dynamic_base":true},
      "rendering_server":{"abstract_vtable_vaddr":"0x140004180","concrete_vtable_vaddr":"0x1400045f0",
        "slot_count":140,"placeholder_kind":"code","pure_placeholder":"0x140001ff0"},
      "slots":{"hook":35},"anchors":{"anchor":0},
      "dropped_families":["mesh","texture"],
      "devirtualized_slots":[{"key":"mesh_create","slot":11,"family":"mesh","direct_calls":2,"sites":["0x140001234"]}]})";
  }
  Calibration parsed; std::string error;
  check(load_calibration(path, &parsed, &error), "parse extended calibration");
  check(parsed.image_sha256 == "digest" && parsed.image_base == 0x140000000 && parsed.dynamic_base &&
        parsed.time_date_stamp == 1592590337 && parsed.size_of_image == 32768 &&
        parsed.codeview_id_present && parsed.codeview_id == "000102030405060708090a0b0c0d0e0f:3",
        "parse every PE identity field");
  check(parsed.placeholder_kind == "code" && parsed.pure_placeholder == 0x140001ff0 &&
        parsed.dropped_families == std::vector<std::string>{"mesh", "texture"} &&
        parsed.devirtualized_slots == std::vector<std::string>{"mesh_create"}, "parse placeholder and dropped keys");
  rs::remove_file(path);
  g_iface.global_get_singleton = singleton;
  for (const std::string kind : {"null", "code", "bind"}) {
    const bool is_code = kind != "null";
    std::array<void *, 42> abstract{}, concrete{};
    concrete.fill(reinterpret_cast<void *>(&code));
    abstract.fill(is_code ? reinterpret_cast<void *>(&pure) : nullptr);
    Calibration c;
    c.slot_count = concrete.size(); c.object_prefix = 1; c.anchors_total = 17;
    // Exercise a nonzero load bias, including the recorded placeholder address.
    ProcessFingerprint fp;
    fp.load_bias = 0x1000;
    fp.exec_ranges = {{reinterpret_cast<uint64_t>(&code), reinterpret_cast<uint64_t>(&code) + 1},
                      {reinterpret_cast<uint64_t>(&pure), reinterpret_cast<uint64_t>(&pure) + 1}};
    c.placeholder_kind = kind;
    c.pure_placeholder = reinterpret_cast<uint64_t>(&pure) - fp.load_bias;
    if (kind == "bind") {
      c.pure_placeholder = 0;
      c.pure_placeholder_symbol = "___cxa_pure_virtual";
      fp.bind_pure_virtual = reinterpret_cast<uint64_t>(&pure);
    }
    for (int i = 0; i < 17; ++i) {
      abstract[i * 2] = reinterpret_cast<void *>(&code);
      if (i >= 6) abstract[i * 2 + 1] = reinterpret_cast<void *>(&code);
      c.anchors.emplace_back("anchor" + std::to_string(i), i * 2);
    }
    c.slots = {{"hook", 35}};
    c.abstract_vtable_vaddr = reinterpret_cast<uint64_t>(abstract.data()) - 16 - fp.load_bias;
    c.concrete_vtable_vaddr = reinterpret_cast<uint64_t>(concrete.data()) - 16 - fp.load_bias;
    void *vptr = concrete.data(); object = &vptr;
    LiveVtableFacts facts;
    std::vector<CheckResult> checks;
    check(check_slot_mask(c, fp, &facts, &checks), (kind + " placeholder passes").c_str());
    if (!is_code) {
      for (const auto &r : checks) std::printf("null %s %d %s\n", r.name.c_str(), r.ok, r.detail.c_str());
    }
    Calibration shifted = c;
    for (auto &a : shifted.anchors) ++a.second;
    for (auto &s : shifted.slots) ++s.second;
    ++shifted.object_prefix;
    facts = {}; checks.clear();
    check(!check_slot_mask(shifted, fp, &facts, &checks), "shifted record refuses");
    const auto &anchors = find(checks, "anchors_implemented");
    check(!anchors.ok && anchors.detail.starts_with("11/17 first mismatch"), "shifted anchors are 11/17");
    if (is_code) {
      concrete[40] = reinterpret_cast<void *>(&pure);
      facts = {}; checks.clear();
      check(!check_slot_mask(c, fp, &facts, &checks) &&
            !find(checks, "hooked_slots_pure_in_abstract").ok, "placeholder excluded from every concrete slot");
      concrete[40] = reinterpret_cast<void *>(&code);
      if (kind == "bind") ++fp.bind_pure_virtual;
      else ++c.pure_placeholder;
      facts = {}; checks.clear();
      check(!check_slot_mask(c, fp, &facts, &checks) &&
            !find(checks, "hooked_slots_pure_in_abstract").ok, "placeholder must equal recorded or resolved value");
    }
  }
#if !defined(_WIN32)
  live_derive();
#endif
  std::printf("calib_slot_mask: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
