// Read-only main-image process view used before any vtable publication.
#pragma once

#include "calib_derive.h"

namespace grc {
class CalibLiveReader final : public CalibMemoryReader {
 public:
  explicit CalibLiveReader(const ProcessFingerprint &fp);
  // A mapped PE image at its loaded address (not a raw file). The caller owns
  // the mapping; header_bytes bounds the accessible header prefix.
  CalibLiveReader(const ProcessFingerprint &fp, const uint8_t *mapped_pe, size_t header_bytes);
  CalibWord read_u64(uint64_t address) const override;
  bool is_exec(uint64_t address) const override;
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override { return readonly_; }
  uint64_t load_bias() const override { return bias_; }
  const std::string &error() const { return error_; }
 private:
  uint64_t bias_ = 0;
  std::string error_;
  std::vector<std::pair<uint64_t, uint64_t>> readable_, readonly_, executable_;
};

// The caller waits for singleton registration before invoking this. Identity comes
// from the current process; census needs offline disassembly and is never inferred.
bool derive_live_calibration(const AbiTable &table, const ProcessFingerprint &fp,
                             Calibration *out, std::vector<CheckResult> *checks,
                             std::string *error);
}  // namespace grc
