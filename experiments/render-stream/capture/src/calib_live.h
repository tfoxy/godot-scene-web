// Read-only main-image process view used before any vtable publication.
#pragma once

#include <atomic>

#include "calib_derive.h"

namespace grc {
class CalibLiveReader final : public CalibMemoryReader {
 public:
  explicit CalibLiveReader(const ProcessFingerprint &fp);
  // A mapped PE or Mach-O image at its loaded address (not a raw file). The caller owns
  // the mapping; header_bytes bounds the accessible header prefix.
  CalibLiveReader(const ProcessFingerprint &fp, const uint8_t *mapped_pe, size_t header_bytes);
  CalibWord read_u64(uint64_t address) const override;
  bool is_exec(uint64_t address) const override;
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override { return readonly_; }
  uint64_t load_bias() const override { return bias_; }
  bool uses_bind_placeholder() const override { return macho_; }
  bool is_pure_bind(uint64_t address) const override;
  const std::string &error() const { return error_; }
  size_t readable_range_count() const { return readable_.size(); }
 private:
  uint64_t bias_ = 0;
  uint64_t pure_virtual_ = 0;
  bool macho_ = false;
  void init_macho(const ProcessFingerprint &fp, const uint8_t *base, size_t header_bytes);
  std::string error_;
  std::vector<std::pair<uint64_t, uint64_t>> readable_, readonly_, executable_;
};

// Borrowed read-only image view. Shutdown makes reads unmapped and ends range scans.
class StoppableCalibReader final : public CalibMemoryReader {
 public:
  StoppableCalibReader(const CalibMemoryReader &reader, const std::atomic<bool> &stop)
      : reader_(reader), stop_(stop) {}
  bool stopped() const override { return stop_.load(std::memory_order_relaxed); }
  CalibWord read_u64(uint64_t address) const override {
    return stopped() ? CalibWord{} : reader_.read_u64(address);
  }
  bool is_exec(uint64_t address) const override { return !stopped() && reader_.is_exec(address); }
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override {
    return stopped() ? std::vector<std::pair<uint64_t, uint64_t>>{} : reader_.readonly_ranges();
  }
  uint64_t load_bias() const override { return reader_.load_bias(); }
  bool uses_bind_placeholder() const override { return reader_.uses_bind_placeholder(); }
  bool is_pure_bind(uint64_t address) const override {
    return !stopped() && reader_.is_pure_bind(address);
  }
  bool is_pointer_word(uint64_t address, uint64_t bits) const override {
    return !stopped() && reader_.is_pointer_word(address, bits);
  }
 private:
  const CalibMemoryReader &reader_;
  const std::atomic<bool> &stop_;
};

struct LiveDeriveScan {
  bool attempted = false, ok = false;
  Calibration calib;
  std::vector<CheckResult> checks;
  std::string error;
  DerivePhaseTimes times;
};

bool derive_live_identity(const ProcessFingerprint &fp, bool require_exe_sha256,
                          Calibration *identity, std::vector<CheckResult> *checks,
                          std::string *error);
void derive_live_scan(const CalibMemoryReader &reader, uint64_t vptr, const AbiTable &table,
                      Calibration identity, LiveDeriveScan *out);

// The caller waits for singleton registration before invoking this. Identity comes
// from the current process; census needs offline disassembly and is never inferred.
// Async Windows callers require the worker's whole-file digest; no file-hash fallback is allowed.
bool derive_live_calibration(const AbiTable &table, const ProcessFingerprint &fp,
                             Calibration *out, std::vector<CheckResult> *checks,
                             std::string *error, bool require_exe_sha256 = false,
                             DerivePhaseTimes *times = nullptr);
}  // namespace grc
