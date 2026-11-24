// Read-only Itanium AudioDriver calibration. No engine writes or speculative calls.
#pragma once
#include "calib_derive.h"

namespace grc::audio {
struct Slot { std::string name; bool pure = false, override = false, abstract_placeholder = false; };
struct Abi { std::string version, header_sha256; std::vector<Slot> slots; };
struct Probe {
  uint64_t base = 0, vptr = 0, object = 0;
  size_t object_matches = 0;
};
bool parse_abi(const std::string &json, Abi *out, std::string *error);
bool dummy_name(const std::string &name, std::string *error);
bool derive(const CalibMemoryReader &memory,
            const std::vector<std::pair<uint64_t, uint64_t>> &writable,
            const Abi &abi, Probe *out, std::string *error);
void initialize(const std::string &evidence_dir);
void shutdown();
}  // namespace grc::audio
