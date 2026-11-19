// Header-derived ABI facts and read-only Itanium RenderingServer derivation.
#pragma once

#include <map>
#include <set>

#include "calib.h"
#include "macho_image.h"

namespace grc {

struct AbiVirtual {
  std::string name;
  bool pure = false;
};
struct AbiTable {
  std::string version_name, header_sha256;
  std::vector<AbiVirtual> new_virtuals;
  std::vector<std::pair<std::string, int64_t>> wanted_slots;
};
bool load_abi_table(const std::string &path, AbiTable *out, std::string *error);

// Unresolved ELF relocations are placeholders, distinct from unreadable memory.
struct CalibWord {
  enum Kind { unmapped, unresolved, value } kind = unmapped;
  uint64_t bits = 0;
};
class CalibMemoryReader {
 public:
  virtual ~CalibMemoryReader() = default;
  virtual CalibWord read_u64(uint64_t address) const = 0;
  virtual bool is_exec(uint64_t address) const = 0;
  virtual std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const = 0;
  virtual uint64_t load_bias() const = 0;
  virtual bool uses_bind_placeholder() const { return false; }
  virtual bool is_pure_bind(uint64_t /*address*/) const { return false; }
  // PE slot words must carry DIR64 relocations. Other readers need no extra check.
  virtual bool is_pointer_word(uint64_t /*address*/, uint64_t /*bits*/) const { return true; }
};

// Concrete address point comes from the singleton (or file bootstrap in tests).
// On success fills topology only, preserving the caller's engine identity. On failure
// clears the output, and never writes through the reader. Check names are also used live.
bool derive_calibration(const CalibMemoryReader &memory, uint64_t concrete_vptr,
                        const AbiTable &table, Calibration *out,
                        std::vector<CheckResult> *checks, std::string *error);

// File-backed addresses are preferred virtual addresses; no file is executed.
class CalibFileReader final : public CalibMemoryReader {
 public:
  bool open(const std::string &path, std::string *error, uint32_t cputype = 0);
  CalibWord read_u64(uint64_t address) const override;
  bool is_exec(uint64_t address) const override;
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override;
  uint64_t load_bias() const override { return 0; }
  bool is_pointer_word(uint64_t address, uint64_t bits) const override;
  bool uses_bind_placeholder() const override { return macho_; }
  bool is_pure_bind(uint64_t address) const override;
  bool concrete_vptr(uint64_t *out, std::string *error) const;
  bool engine_identity(const std::string &version_name, const std::string &flavor,
                       Calibration *out, std::string *error) const;

 private:
  struct Section { uint64_t addr, offset, size; bool exec, readonly; };
  std::string path_;
  std::vector<uint8_t> bytes_;
  std::vector<Section> sections_;
  std::map<uint64_t, CalibWord> relocations_;
  std::set<uint64_t> dir64_;
  bool pe_ = false, pie_ = false, macho_ = false;
  MachoHeaders macho_headers_;
  std::map<uint64_t, MachoFixup> macho_fixups_;
  std::string build_id_;
};

// Same indentation, key order and trailing newline as calibrate.py. Engine identity
// must be supplied independently; this does not infer call-census results.
std::string serialize_derived_calibration(const Calibration &calib, const AbiTable &table);

}  // namespace grc
