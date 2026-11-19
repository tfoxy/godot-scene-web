// Native self-test: dyld main image versus independently generated bundle identity.
#include "calib_live.h"
#include "iface.h"
#include "rs_json_lite.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <mach-o/dyld.h>
#include <unistd.h>

extern "C" void __cxa_pure_virtual();
namespace {
int total = 0, failed = 0, version_calls = 0;
void check(bool ok, const char *name) {
  ++total;
  if (!ok) { ++failed; std::fprintf(stderr, "FAIL %s\n", name); }
}
void version(GDExtensionGodotVersion2 *v) { ++version_calls; v->string = "Mach-O self-test"; }
void *object = nullptr;
GDExtensionObjectPtr singleton(GDExtensionConstStringNamePtr) { return object; }
volatile int marker = 0;
void code() { marker = 1; }
void implementation() { marker = 2; }
struct Typeinfo { void (*abi)(); const char *name; const Typeinfo *base; };
const Typeinfo abstract_type = {code, "15RenderingServer", nullptr};
const Typeinfo concrete_type = {code, "22RenderingServerDefault", &abstract_type};
struct Vtable { intptr_t top; const Typeinfo *type; void (*slots[4])(); intptr_t end; };
const Vtable abstract_table = {0, &abstract_type, {code, code, __cxa_pure_virtual, code}, 1};
const Vtable concrete_table = {0, &concrete_type, {code, code, implementation, code}, 1};
void live_derive(const grc::ProcessFingerprint &fp) {
  using namespace grc;
  CalibLiveReader reader(fp);
  check(reader.error().empty(), "native Mach-O live reader");
  check(reader.read_u64(reinterpret_cast<uint64_t>(&abstract_table.slots[2])).kind == CalibWord::unresolved,
        "native dyld-resolved pure bind");
  AbiTable table;
  table.header_sha256 = std::string(64, 'b');
  table.new_virtuals = {{"anchor_a", false}, {"hook", true}, {"anchor_b", false}};
  table.wanted_slots = {{"hook", 1}};
  const void *vptr = concrete_table.slots; object = &vptr;
  g_iface.global_get_singleton = singleton;
  Calibration c; std::vector<CheckResult> checks; std::string error;
  check(derive_live_calibration(table, fp, &c, &checks, &error), "Darwin live singleton derives");
  if (c.slots.empty()) { std::fprintf(stderr, "derive detail: %s\n", error.c_str()); return; }
  check(c.platform == fp.platform && c.sha256 == fp.exe_sha256 && c.uuid == fp.uuid &&
        c.cputype == fp.cputype && c.cpusubtype == fp.cpusubtype && c.pie == fp.pie &&
        c.slice_offset == fp.slice_offset && c.slice_size == fp.slice_size, "derived slice identity");
  check(c.placeholder_kind == "bind" && c.pure_placeholder_symbol == "___cxa_pure_virtual" &&
        c.abstract_vtable_vaddr + fp.load_bias == reinterpret_cast<uint64_t>(&abstract_table) &&
        c.concrete_vtable_vaddr + fp.load_bias == reinterpret_cast<uint64_t>(&concrete_table),
        "derived topology and dyld slide");
  check(check_fingerprint(c, fp, &checks), "derived record passes fingerprint");
  LiveVtableFacts facts;
  check(check_slot_mask(c, fp, &facts, &checks), "native bind mask accepts derived layout");
  for (auto &slot : c.slots) ++slot.second;
  for (auto &anchor : c.anchors) ++anchor.second;
  check(!check_slot_mask(c, fp, &facts, &checks), "native slot-shifted record refuses");
  check(vptr == concrete_table.slots, "live derive and checks preserve singleton vptr");
  object = nullptr;
  check(!derive_live_calibration(table, fp, &c, &checks, &error) && c.slots.empty(),
        "missing singleton refuses");
  auto bad = fp; ++bad.load_bias;
  check(!derive_live_calibration(table, bad, &c, &checks, &error) && c.slots.empty() &&
        error == "live reader: mapped Mach-O load bias differs from process fingerprint",
        "native reader failure reaches caller");
}
}
int main(int argc, char **argv) {
  using namespace grc;
  if (argc < 2 || argc > 3) return 2;
  const bool sabotage = argc == 3 && std::string(argv[2]) == "--expect-identity-mismatch";
  std::ifstream input(argv[1]);
  const std::string json((std::istreambuf_iterator<char>(input)), {});
  rs::json_lite::JValue identity;
  if (!rs::json_lite::Reader(json).parse(&identity)) return 2;
  const auto text = [&](const char *name) {
    const auto *v = identity.get(name); return v ? v->text : std::string();
  };
  const auto number = [&](const char *name) { return std::strtoull(text(name).c_str(), nullptr, 10); };
  Calibration c;
  c.platform = text("platform"); c.uuid = text("uuid"); c.sha256 = text("sha256");
  c.cputype = number("cputype"); c.cpusubtype = number("cpusubtype");
  c.slice_offset = number("slice_offset"); c.slice_size = number("slice_size");
  c.pie = identity.get("pie") && identity.get("pie")->b;
  c.version_string = "Mach-O self-test";
  check(c.sha256.size() == 64 && c.uuid.size() == 32 && c.slice_size && c.pie,
        "bundle identity complete");
  g_iface.get_godot_version2 = version;
  ProcessFingerprint fp;
  fp.exe_sha256 = "stale"; fp.exec_ranges.emplace_back(0, UINT64_MAX);
  std::string error = "stale";
  const bool collected = collect_fingerprint(&fp, &error);
  check(collected, error.empty() ? "collect native main-image fingerprint" : error.c_str());
  if (!collected) return 1;
  check(version_calls == 1 && fp.version_string == c.version_string && error.empty(), "engine version collected");
  std::vector<CheckResult> checks;
  const bool ok = check_fingerprint(c, fp, &checks);
  check(ok == !sabotage && checks.size() == 7, "fingerprint group result");
  for (size_t i = 0; i < checks.size(); ++i) {
    const auto &r = checks[i];
    std::printf("check %s %s %s\n", r.name.c_str(), r.ok ? "ok" : "FAIL", r.detail.c_str());
    check(r.ok == !(sabotage && i == 0), r.name.c_str());
  }
  if (!ok) std::puts("refused: fingerprint-mismatch");
  check(fp.in_exec_range(reinterpret_cast<uint64_t>(&main)), "main in executable mappings");
  check(fp.load_bias == static_cast<uint64_t>(_dyld_get_image_vmaddr_slide(0)), "bias is dyld slide");
  check(fp.pid == static_cast<int>(getpid()) && !fp.exe_maps.empty() && fp.exe_path.starts_with("/"),
        "real executable path, pid and maps");
  check(fp.bind_pure_virtual == reinterpret_cast<uint64_t>(&__cxa_pure_virtual), "dlsym C-name placeholder");
  auto wrong_cpu = c; wrong_cpu.cputype = fp.cputype == macho_arm64 ? macho_x86_64 : macho_arm64;
  check(!check_fingerprint(wrong_cpu, fp, &checks), "other slice CPU refuses");
  if (!sabotage) live_derive(fp);
  g_iface = {};
  std::printf("calib_macho_self_test: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
