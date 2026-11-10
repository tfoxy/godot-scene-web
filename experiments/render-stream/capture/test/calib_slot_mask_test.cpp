#include "calib.h"
#include "iface.h"
#include "rs_platform.h"
#include <array>
#include <cstdio>
#include <cstring>
#include <fstream>

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
  for (bool is_code : {false, true}) {
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
    c.placeholder_kind = is_code ? "code" : "null";
    c.pure_placeholder = reinterpret_cast<uint64_t>(&pure) - fp.load_bias;
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
    check(check_slot_mask(c, fp, &facts, &checks), is_code ? "code placeholder passes" : "null placeholder passes");
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
      ++c.pure_placeholder;
      facts = {}; checks.clear();
      check(!check_slot_mask(c, fp, &facts, &checks) &&
            !find(checks, "hooked_slots_pure_in_abstract").ok, "placeholder must equal recorded value plus bias");
    }
  }
  std::printf("calib_slot_mask: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
