// Loaded-PE ranges and derivation are engine-free; no binary fixtures are committed.
#include "abi.h"
#include "calib_live.h"
#include "iface.h"
#include <cstdio>
#include <cstring>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <sys/mman.h>
#endif

namespace {
int total = 0, failed = 0;
void check(bool ok, const char *name) {
  ++total;
  if (!ok) { ++failed; std::fprintf(stderr, "FAIL %s\n", name); }
}
void put(uint8_t *image, size_t offset, uint64_t value, size_t bytes) {
  for (size_t i = 0; i < bytes; ++i) image[offset + i] = static_cast<uint8_t>(value >> (8 * i));
}
grc::AbiTable table() {
  grc::AbiTable t;
  t.header_sha256 = std::string(64, 'b');
  t.new_virtuals = {{"anchor_a", false}, {"hook", true}, {"anchor_b", false}};
  t.wanted_slots = {{"hook", 1}, {"get_default_clear_color", 1}};
  return t;
}
void mapped_pe() {
  using namespace grc;
  constexpr size_t size = 0x4000;
#if defined(_WIN32)
  auto *image = static_cast<uint8_t *>(VirtualAlloc(nullptr, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
#else
  auto *image = static_cast<uint8_t *>(mmap(nullptr, size, PROT_READ | PROT_WRITE,
                                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  if (image == MAP_FAILED) image = nullptr;
#endif
  check(image != nullptr, "allocate mapped PE fixture");
  if (!image) return;
  const auto base = reinterpret_cast<uint64_t>(image);
  constexpr uint64_t preferred = 0x140000000;
  std::memcpy(image, "MZ", 2); put(image, 0x3c, 0x80, 4);
  std::memcpy(image + 0x80, "PE\0\0", 4);
  put(image, 0x84, 0x8664, 2); put(image, 0x86, 3, 2); put(image, 0x88, 1234, 4);
  put(image, 0x94, 240, 2);
  constexpr size_t opt = 0x98, sections = opt + 240;
  put(image, opt, 0x20b, 2); put(image, opt + 24, preferred, 8);
  put(image, opt + 56, size, 4); put(image, opt + 60, 0x1000, 4);
  put(image, opt + 70, 0x40, 2); put(image, opt + 108, 16, 4);
  const uint32_t flags[] = {0x40000040, 0x60000020, 0xc0000040};
  const char *names[] = {".rdata", ".text", ".data"};
  for (size_t i = 0; i < 3; ++i) {
    const size_t s = sections + 40 * i;
    std::memcpy(image + s, names[i], std::strlen(names[i]));
    put(image, s + 8, 0x1000, 4); put(image, s + 12, (i + 1) * 0x1000, 4);
    // Deliberately unrelated raw offsets: live ranges must use RVAs.
    put(image, s + 16, 0x800, 4); put(image, s + 20, 0x5000 + i * 0x800, 4);
    put(image, s + 36, flags[i], 4);
  }
  std::memcpy(image + 0x1040, "15RenderingServer", 18);
  std::memcpy(image + 0x1080, "22RenderingServerDefault", 25);
  const auto word = [&](size_t off, uint64_t value) { put(image, off, value, 8); };
  word(0x1100, base + 0x2000); word(0x1108, base + 0x1040);
  word(0x1140, base + 0x2000); word(0x1148, base + 0x1080); word(0x1150, base + 0x1100);
  word(0x1208, base + 0x1100); word(0x1288, base + 0x1140);
  for (size_t i = 0; i < 4; ++i) {
    word(0x1210 + i * 8, base + (i == 2 ? 0x2010 : 0x2000));
    word(0x1290 + i * 8, base + (i == 2 ? 0x2020 : 0x2000));
  }
  word(0x1230, 1); word(0x12b0, 1);
  ProcessFingerprint fp;
  fp.platform = "windows-x86_64"; fp.image_base = preferred;
  fp.load_bias = base - preferred; fp.size_of_image = size;
  fp.time_date_stamp = 1234; fp.dynamic_base = true;
#if defined(_WIN32)
  DWORD old = 0;
  check(VirtualProtect(image + 0x1000, 0x1000, PAGE_READONLY, &old), "protect PE rdata");
  check(VirtualProtect(image + 0x2000, 0x1000, PAGE_EXECUTE_READ, &old), "protect PE text");
#endif
  CalibLiveReader reader(fp, image, 0x1000);
  check(reader.error().empty(), "preferred PE header has no reader error");
  check(reader.readonly_ranges().size() == 2, "scan read-only PE sections including text");
  check(reader.read_u64(base + 0x1108).bits == base + 0x1040, "mapped PE reads relocated pointer");
  check(reader.is_exec(base + 0x2000) && !reader.is_exec(base + 0x3000) &&
        reader.is_exec(base + 0x2fff), "PE executable section bounds");
  check(reader.read_u64(base + size - 8).kind == CalibWord::value &&
        reader.read_u64(base + size - 7).kind == CalibWord::unmapped &&
        reader.read_u64(UINT64_MAX - 3).kind == CalibWord::unmapped &&
        reader.read_u64(base + 0xff8).kind == CalibWord::unmapped, "PE read bounds exclude headers and crossing words");
  Calibration c; c.platform = fp.platform;
  std::vector<CheckResult> checks; std::string error;
  check(derive_calibration(reader, base + 0x1290, table(), &c, &checks, &error), "derive from loaded PE ranges");
  if (!error.empty()) std::fprintf(stderr, "derive detail: %s\n", error.c_str());
  check(c.abstract_vtable_vaddr == preferred + 0x1200 && c.concrete_vtable_vaddr == preferred + 0x1280 &&
        c.placeholder_kind == "code" && c.pure_placeholder == preferred + 0x2010,
        "ASLR removed from PE vtables and code placeholder");
  // The loader may rewrite OptionalHeader.ImageBase to the actual mapping address.
  put(image, opt + 24, base, 8);
  CalibLiveReader relocated(fp, image, 0x1000);
  check(relocated.error().empty(), "relocated PE header has no reader error");
  check(relocated.readonly_ranges().size() == 2, "relocated PE header exposes read-only ranges");
  check(relocated.load_bias() == fp.load_bias, "relocated PE header preserves file-based load bias");
  Calibration relocated_calib; relocated_calib.platform = fp.platform;
  checks.clear(); error.clear();
  check(derive_calibration(relocated, base + 0x1290, table(), &relocated_calib, &checks, &error),
        "derive from relocated PE header");
  if (!error.empty()) std::fprintf(stderr, "relocated derive detail: %s\n", error.c_str());
  check(serialize_derived_calibration(relocated_calib, table()) == serialize_derived_calibration(c, table()),
        "relocated PE header derives identical calibration record");
  auto invalid = fp; ++invalid.load_bias;
  CalibLiveReader bad_relocated_bias(invalid, image, 0x1000);
  check(bad_relocated_bias.readonly_ranges().empty() &&
        bad_relocated_bias.error() == "mapped PE load bias differs from process fingerprint",
        "relocated PE header still refuses incorrect file-based bias with detail");
  put(image, opt + 24, base + 1, 8);
  CalibLiveReader bad_header_base(fp, image, 0x1000);
  check(bad_header_base.readonly_ranges().empty() &&
        bad_header_base.error() == "mapped PE ImageBase is neither preferred nor loaded base",
        "PE header with unrelated ImageBase refuses with detail");
  put(image, opt + 24, preferred, 8);
  CalibLiveReader bad_bias(invalid, image, 0x1000);
  check(bad_bias.readonly_ranges().empty() && !bad_bias.error().empty(), "PE mismatched load bias refuses with detail");
  invalid = fp; ++invalid.image_base;
  CalibLiveReader bad_identity(invalid, image, 0x1000);
  check(bad_identity.readonly_ranges().empty() && !bad_identity.error().empty(), "PE mismatched image identity refuses with detail");
  invalid = fp; ++invalid.time_date_stamp;
  CalibLiveReader bad_timestamp(invalid, image, 0x1000);
  check(bad_timestamp.readonly_ranges().empty() &&
        bad_timestamp.error() == "mapped PE image identity differs from process fingerprint",
        "PE mismatched timestamp refuses with detail");
  CalibLiveReader truncated(fp, image, 0x100);
  check(truncated.readonly_ranges().empty() && truncated.error().find("invalid mapped PE headers:") == 0,
        "truncated PE headers refuse with parser detail");
  put(image, sections + 40 + 12, size, 4);
  CalibLiveReader out_of_image(fp, image, 0x1000);
  check(out_of_image.readonly_ranges().empty() && out_of_image.error() == "mapped PE section extends outside image",
        "out-of-image PE section refuses all ranges with detail");
  put(image, sections + 40 + 12, 0x1000, 4);
  CalibLiveReader overlapping(fp, image, 0x1000);
  check(overlapping.readonly_ranges().empty() && overlapping.error() == "mapped PE sections overlap",
        "overlapping PE sections refuse with detail");
  put(image, sections + 40 + 12, 0x2000, 4);
  put(image, sections + 36, 0xc0000040, 4);
  check(CalibLiveReader(fp, image, 0x1000).readonly_ranges().size() == 1, "writable PE section excluded from scan");
#if defined(_WIN32)
  put(image, sections + 36, flags[0], 4);
  check(VirtualProtect(image + 0x1000, 0x1000, PAGE_READWRITE, &old), "make rdata writable");
  check(CalibLiveReader(fp, image, 0x1000).readonly_ranges().size() == 1, "actual writable protection excluded");
  check(VirtualProtect(image + 0x1000, 0x1000, PAGE_NOACCESS, &old), "make rdata inaccessible");
  check(CalibLiveReader(fp, image, 0x1000).read_u64(base + 0x1100).kind == CalibWord::unmapped,
        "actual inaccessible protection excluded");
  VirtualFree(image, 0, MEM_RELEASE);
#else
  munmap(image, size);
#endif
}

#if defined(_WIN32)
void *object = nullptr;
GDExtensionObjectPtr singleton(GDExtensionConstStringNamePtr) { return object; }
volatile int marker = 0;
void code() { marker = 1; }
void pure() { marker = 2; }
grc::Color clear_color(void *) { return {0.25f, 0.5f, 0.75f, 1.0f}; }
struct Typeinfo { void (*abi)(); const char *name; const Typeinfo *base; };
const Typeinfo abstract_type = {code, "15RenderingServer", nullptr};
const Typeinfo concrete_type = {code, "22RenderingServerDefault", &abstract_type};
struct Vtable { intptr_t top; const Typeinfo *type; void (*slots[4])(); intptr_t end; };
const Vtable abstract_table = {0, &abstract_type, {code, code, pure, code}, 1};
const Vtable concrete_table = {0, &concrete_type, {code, code, reinterpret_cast<void (*)()>(clear_color), code}, 1};
bool wrong_color = false;
GDExtensionMethodBindPtr bind(GDExtensionConstStringNamePtr, GDExtensionConstStringNamePtr, GDExtensionInt) {
  return reinterpret_cast<GDExtensionMethodBindPtr>(1);
}
void ptrcall(GDExtensionMethodBindPtr, GDExtensionObjectPtr, const GDExtensionConstTypePtr *, GDExtensionTypePtr out) {
  auto color = clear_color(nullptr);
  if (wrong_color) color.r = 1;
  std::memcpy(out, &color, sizeof(color));
}
void main_module() {
  using namespace grc;
  ProcessFingerprint fp; std::string error;
  check(collect_engine_fingerprint(&fp, &error), "collect Windows main module fingerprint");
  fp.version_string = "fixture release";
  g_iface.global_get_singleton = singleton;
  const void *vptr = concrete_table.slots; object = &vptr;
  Calibration c; std::vector<CheckResult> checks;
  check(derive_live_calibration(table(), fp, &c, &checks, &error), "Windows live singleton derives via fake iface");
  if (c.slots.empty()) { std::fprintf(stderr, "derive detail: %s\n", error.c_str()); return; }
  check(c.platform == fp.platform && c.image_sha256 == fp.image_sha256 &&
        c.sha256 == sha256_file(fp.exe_path) && c.image_base == fp.image_base &&
        c.time_date_stamp == fp.time_date_stamp && c.size_of_image == fp.size_of_image &&
        c.codeview_id == fp.codeview_id && c.codeview_id_present == !fp.codeview_id.empty() &&
        c.dynamic_base == fp.dynamic_base, "all Windows derived record identities");
  check(c.abstract_vtable_vaddr + fp.load_bias == reinterpret_cast<uint64_t>(&abstract_table),
        "Windows main module ASLR bias");
  LiveVtableFacts facts;
  check(check_slot_mask(c, fp, &facts, &checks), "Windows unchanged slot mask accepts derived record");
  g_iface.classdb_get_method_bind = bind; g_iface.object_method_bind_ptrcall = ptrcall;
  check(check_behaviour(c, facts, &checks), "Windows unchanged behaviour accepts derived record");
  wrong_color = true;
  check(!check_behaviour(c, facts, &checks), "Windows unchanged behaviour rejects mismatch");
  check(vptr == concrete_table.slots, "Windows derive and checks preserve singleton vptr");
  object = nullptr;
  check(!derive_live_calibration(table(), fp, &c, &checks, &error) && c.slots.empty(), "Windows missing singleton refuses");
  ++fp.load_bias;
  check(!derive_live_calibration(table(), fp, &c, &checks, &error) && c.slots.empty() &&
        error == "live reader: mapped PE load bias differs from process fingerprint" &&
        !checks.back().ok && checks.back().detail == error,
        "Windows live derivation reports reader refusal detail");
  g_iface = {};
}
#endif
}  // namespace
int main() {
  mapped_pe();
#if defined(_WIN32)
  main_module();
#else
  grc::ProcessFingerprint fp;
  fp.platform = "linux-x86_64"; fp.exe_sha256 = std::string(64, 'b'); fp.version_string = "fixture release";
  grc::Calibration c; std::vector<grc::CheckResult> checks; std::string error;
  check(!grc::derive_live_calibration(table(), fp, &c, &checks, &error) && c.slots.empty() &&
        error == "live reader: no read-only main-image mappings in process fingerprint" &&
        !checks.back().ok && checks.back().detail == error,
        "live derivation reports reader refusal detail");
#endif
  std::printf("calib_live_pe: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
