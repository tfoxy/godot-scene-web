#include "calib_derive.h"
#include "rs_json_lite.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <map>

namespace {
int passed = 0, failed = 0;
void expect(bool ok, const std::string &label) {
  if (ok) ++passed;
  else { ++failed; std::fprintf(stderr, "FAIL: %s\n", label.c_str()); }
}

class Memory final : public grc::CalibMemoryReader {
 public:
  std::map<uint64_t, uint64_t> words;
  uint64_t bias = 0;
  Memory() {
    // Distinct RTTI, names, two primary tables, four slots plus sentinels.
    text(0x1100, "15RenderingServer"); text(0x1140, "22RenderingServerDefault");
    words[0x1200] = 0x9000; words[0x1208] = 0x1100;
    words[0x1240] = 0x9000; words[0x1248] = 0x1140; words[0x1250] = 0x1200;
    words[0x1300] = 0; words[0x1308] = 0x1200;
    words[0x1400] = 0; words[0x1408] = 0x1240;
    for (size_t i = 0; i < 4; ++i) {
      words[0x1310 + i * 8] = i == 2 ? 0 : 0x9000 + i * 16;
      words[0x1410 + i * 8] = 0x9000 + i * 16;
    }
    words[0x1330] = words[0x1430] = 0xdeadbeef;
  }
  void text(uint64_t addr, const std::string &s) {
    for (size_t i = 0; i <= s.size(); ++i) {
      auto &w = words[(addr + i) & ~uint64_t(7)];
      const unsigned shift = 8 * ((addr + i) & 7);
      w = (w & ~(uint64_t(255) << shift)) | (uint64_t(i == s.size() ? 0 : s[i]) << shift);
    }
  }
  grc::CalibWord read_u64(uint64_t address) const override {
    auto it = words.find(address);
    if (it == words.end()) return {};
    return {grc::CalibWord::value, it->second};
  }
  bool is_exec(uint64_t address) const override { return address >= 0x9000 && address < 0xa000; }
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override { return {{0x1000, 0x1500}}; }
  uint64_t load_bias() const override { return bias; }
};
grc::AbiTable table() {
  grc::AbiTable t;
  t.new_virtuals = {{"anchor_a", false}, {"hook", true}, {"anchor_b", false}};
  t.wanted_slots = {{"hook", 1}};
  return t;
}
void synthetic() {
  auto run = [](Memory m, const grc::AbiTable &t, bool ok, const char *detail) {
    grc::Calibration c;
    c.version_string = "supplied identity";
    std::vector<grc::CheckResult> checks;
    std::string error;
    bool result = grc::derive_calibration(m, 0x1410, t, &c, &checks, &error);
    expect(result == ok, std::string(detail) + ": " + error);
    if (ok) {
      expect(c.object_prefix == 1 && c.slot_count == 4 && c.anchors_total == 2 &&
             c.slots == std::vector<std::pair<std::string, int64_t>>{{"hook", 2}} &&
             c.anchors == std::vector<std::pair<std::string, int64_t>>{{"anchor_a", 1}, {"anchor_b", 3}} &&
             c.abstract_vtable_vaddr == 0x1300 - m.bias && c.concrete_vtable_vaddr == 0x1400 - m.bias &&
             c.version_string == "supplied identity", "complete derived layout and identity preservation");
      expect(checks.size() == 3 && checks[0].ok && checks[1].ok && checks[2].ok &&
             checks[2].detail == "3/3 matched", "derive checks with complete matched count");
    } else {
      expect(c.schema.empty() && c.slots.empty() && c.concrete_vtable_vaddr == 0 &&
             !checks.empty() && !checks.back().ok && error.find(detail) != std::string::npos,
             std::string("fail-closed output and reason: ") + detail + ": " + error);
    }
  };
  run(Memory{}, table(), true, "happy path");
  Memory duplicate; duplicate.words[0x1480] = 0; duplicate.words[0x1488] = 0x1200;
  run(duplicate, table(), false, "primary abstract vtables: 2");
  Memory wrong; wrong.text(0x1140, "22RenderingServerInvalid");
  run(wrong, table(), false, "typeinfo");
  Memory wrong_base; wrong_base.text(0x1100, "15RenderingWrong_");
  run(wrong_base, table(), false, "typeinfo");
  Memory flip; flip.words[0x1320] = 0x9090;
  // Retain a placeholder in the inherited prefix, so this tests the full pattern match.
  flip.words[0x1310] = 0;
  run(flip, table(), false, "header/binary mask mismatch");
  Memory msvc; msvc.words[0x1408] = 0x1260; msvc.words[0x1268] = 0x1140;
  msvc.text(0x1140, ".?AVRenderingServerDefault@@");
  run(msvc, table(), false, "typeinfo");
  Memory concrete_pure; concrete_pure.words[0x1420] = 0;
  run(concrete_pure, table(), false, "concrete vtable contains a non-code slot");
  Memory extra; extra.words[0x1430] = 0x9090; extra.words[0x1438] = 0xdeadbeef;
  run(extra, table(), false, "slot counts differ");
  Memory code; code.words[0x1320] = 0x9f00;
  run(code, table(), true, "code placeholder");
  Memory shifted; shifted.bias = 0x1000;
  run(shifted, table(), true, "load bias");
  auto bad_table = table(); bad_table.wanted_slots = {{"hook", 0}};
  run(Memory{}, bad_table, false, "wanted slot");
  // A second full mask at prefix zero makes the derivation ambiguous.
  auto ambiguous = table(); ambiguous.new_virtuals = {{"hook", true}}; ambiguous.wanted_slots = {{"hook", 0}};
  Memory repeats; repeats.words[0x1310] = repeats.words[0x1328] = 0;
  run(repeats, ambiguous, false, "prefix is ambiguous");
}

void phase_times() {
  // Compare successful derivation and refusals in each phase, including their check order.
  for (int phase = 0; phase < 5; ++phase) {
    Memory memory;
    auto abi = table();
    if (phase == 1) memory.words[0x1408] = 0;
    if (phase == 2) { memory.words[0x1480] = 0; memory.words[0x1488] = 0x1200; }
    if (phase == 3) memory.words[0x1420] = 0;
    if (phase == 4) abi.wanted_slots = {{"hook", 0}};
    grc::Calibration plain, timed;
    plain.version_string = timed.version_string = "supplied identity";
    std::vector<grc::CheckResult> plain_checks, timed_checks;
    std::string plain_error, timed_error;
    grc::DerivePhaseTimes times;
    const bool plain_ok = grc::derive_calibration(memory, 0x1410, abi, &plain, &plain_checks, &plain_error);
    const bool timed_ok = grc::derive_calibration(memory, 0x1410, abi, &timed, &timed_checks, &timed_error, &times);
    expect(plain_ok == (phase == 0) && timed_ok == plain_ok && timed_error == plain_error,
           "timing preserves derivation result and error");
    bool same_checks = plain_checks.size() == timed_checks.size();
    for (size_t i = 0; same_checks && i < plain_checks.size(); ++i)
      same_checks = plain_checks[i].name == timed_checks[i].name &&
                    plain_checks[i].ok == timed_checks[i].ok &&
                    plain_checks[i].detail == timed_checks[i].detail;
    expect(same_checks, "timing preserves check names, details and order");
    expect(grc::serialize_derived_calibration(plain, abi) == grc::serialize_derived_calibration(timed, abi),
           "timing preserves serialized record bytes");
    expect(times.typeinfo_ns > 0 && (times.abstract_ns > 0) == (phase != 1) &&
           (times.slots_ns > 0) == (phase == 0 || phase >= 3) &&
           (times.anchors_ns > 0) == (phase == 0 || phase == 4),
           "timing records reached phases on success and refusal");
  }
}

bool file_record(const std::string &abi, const std::string &binary, const std::string &brand,
                 const std::string &flavor, std::string *record, std::string *error, uint32_t cpu = 0) {
  grc::AbiTable t;
  grc::CalibFileReader reader;
  grc::Calibration c;
  uint64_t cv = 0;
  std::vector<grc::CheckResult> checks;
  if (!grc::load_abi_table(abi, &t, error) || !reader.open(binary, error, cpu) ||
      !reader.concrete_vptr(&cv, error) || !reader.engine_identity(brand, flavor, &c, error) ||
      !grc::derive_calibration(reader, cv, t, &c, &checks, error)) return false;
  *record = grc::serialize_derived_calibration(c, t);
  return true;
}
void parity(const char *abi) {
  const char *env = std::getenv("GRC_PARITY_BINARIES");
  if (!env || !*env) { std::puts("SKIP: GRC_PARITY_BINARIES unset"); return; }
  std::string pairs(env);
  size_t start = 0, matched = 0, skipped = 0;
  do {
    const size_t end = pairs.find(';', start);
    const std::string pair = pairs.substr(start, end - start);
    const size_t eq = pair.find('=');
    if (eq == std::string::npos) { expect(false, "malformed parity pair"); return; }
    std::string binary = pair.substr(0, eq), path = pair.substr(eq + 1);
    std::ifstream bin(binary, std::ios::binary), rec(path, std::ios::binary);
    if (!bin || !rec) {
      ++skipped; std::printf("SKIP: binary or record absent: %s\n", pair.c_str());
    } else {
      const std::string expected((std::istreambuf_iterator<char>(rec)), {});
      grc::rs::json_lite::JValue root;
      if (!grc::rs::json_lite::Reader(expected).parse(&root)) { expect(false, "invalid record JSON"); return; }
      auto engine = root.get("engine");
      if (!engine || !engine->get("version_string") || !engine->get("flavor")) {
        expect(false, "record missing engine identity"); return;
      }
      std::string brand = engine->get("version_string")->text;
      const size_t separator = brand.find(" v");
      if (separator == std::string::npos) { expect(false, "record version has no brand separator"); return; }
      brand.resize(separator);
      std::string actual, error;
      bool ok = file_record(abi, binary, brand, engine->get("flavor")->text, &actual, &error);
      if (ok && actual != expected) {
        size_t i = 0;
        while (i < actual.size() && i < expected.size() && actual[i] == expected[i]) ++i;
        const size_t line = 1 + std::count(expected.begin(), expected.begin() + std::min(i, expected.size()), '\n');
        error = "first differing byte " + std::to_string(i) + ", line " + std::to_string(line) +
                ": expected " + expected.substr(i, 100) + "; actual " + actual.substr(i, 100);
        ok = false;
      }
      expect(ok, pair + ": " + error);
      if (!ok) return;
      ++matched; std::printf("parity matched: %s\n", pair.c_str()); std::fflush(stdout);
    }
    if (end == std::string::npos) break;
    start = end + 1;
  } while (start < pairs.size());
  std::printf("parity: %zu matched, %zu skipped\n", matched, skipped);
}
}  // namespace

int main(int argc, char **argv) {
  if ((argc == 7 || argc == 8) && std::string(argv[1]) == "--file") {
    std::string record, error;
    if (!file_record(argv[2], argv[3], argv[4], argv[5], &record, &error, argc == 8 ? std::strtoul(argv[7], nullptr, 0) : 0)) {
      std::fprintf(stderr, "derive: %s\n", error.c_str()); return 2;
    }
    // argv[6] keeps the invocation explicit about record output versus test mode.
    if (std::string(argv[6]) != "--record") return 2;
    std::fwrite(record.data(), 1, record.size(), stdout); return 0;
  }
  synthetic();
  phase_times();
  if (argc == 2) parity(argv[1]);
  std::printf("calib_derive: %d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
