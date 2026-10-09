// Calibration record loading, process fingerprinting and the live checks that
// must all pass before anything is written into the engine's memory.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace grc {

struct Calibration {
  std::string schema;

  std::string version_string;
  std::string build_id;  // empty when the record says null
  bool build_id_present = false;
  std::string sha256;
  std::string platform;
  std::string flavor;
  bool pie = false;

  uint64_t abstract_vtable_vaddr = 0;
  uint64_t concrete_vtable_vaddr = 0;
  std::string concrete_class;
  int64_t object_prefix = 0;
  int64_t slot_count = 0;
  int64_t anchors_total = 0;
  int64_t anchors_matched = 0;

  // calibrator.version, as written (a decimal string); empty when absent.
  std::string calibrator_version;

  std::vector<std::pair<std::string, int64_t>> slots;
  std::vector<std::pair<std::string, int64_t>> anchors;

  // -1 when the record does not name the slot.
  int64_t slot(const std::string &name) const;
};

// Parses a calibration record. On failure `error` explains why and the record
// is left unusable.
bool load_calibration(const std::string &path, Calibration *out, std::string *error);

struct ProcessFingerprint {
  std::string exe_path;
  std::string exe_sha256;
  std::string build_id;  // empty when the running binary has no GNU build-id
  std::string version_string;
  bool pie = false;
  uint64_t load_bias = 0;
  int pid = 0;
  // Executable mappings of the main binary, as [begin, end) pairs.
  std::vector<std::pair<uint64_t, uint64_t>> exec_ranges;
  // Raw /proc/self/maps lines that belong to the main binary.
  std::vector<std::string> exe_maps;

  bool in_exec_range(uint64_t address) const;
};

// Fills `out` from /proc/self and the GDExtension version call. Returns false
// only when the process cannot be identified at all.
bool collect_fingerprint(ProcessFingerprint *out, std::string *error);

struct CheckResult {
  std::string name;
  bool ok = false;
  std::string detail;
};

struct LiveVtableFacts {
  void *singleton = nullptr;
  uint64_t live_vptr = 0;
  uint64_t expected_vptr = 0;
  uint64_t abstract_address_point = 0;
  uint64_t pure_placeholder = 0;
  bool pure_placeholder_known = false;
};

// 1. Fingerprint: sha256 of /proc/self/exe, GNU build-id and the engine version
//    string must agree with the record.
bool check_fingerprint(const Calibration &calib, const ProcessFingerprint &fp,
                       std::vector<CheckResult> *checks);

// 3. Live layout: the singleton's vptr must be exactly the recorded concrete
//    vtable address point, the recorded anchors must hold code addresses inside
//    the main binary, and every slot to be hooked must still be pure-virtual in
//    the abstract vtable. Reads only; calls nothing.
bool check_slot_mask(const Calibration &calib, const ProcessFingerprint &fp,
                     LiveVtableFacts *facts, std::vector<CheckResult> *checks);

// 4. Behavioural cross-check: a read-only virtual named by the record, called
//    both through its vtable slot and through its ClassDB method bind, must
//    return the same bytes. Skipped (reported, not failed) when the method bind
//    is unavailable.
bool check_behaviour(const Calibration &calib, const LiveVtableFacts &facts,
                     std::vector<CheckResult> *checks);

// sha256 of a file's contents, lowercase hex. Empty string on failure.
std::string sha256_file(const std::string &path);

}  // namespace grc
