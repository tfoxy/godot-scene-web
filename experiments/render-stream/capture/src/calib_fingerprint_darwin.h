// Portable collection core; the native entry point supplies dyld's main image and slide.
#pragma once
#include "calib_fingerprint.h"
#include <cstddef>

namespace grc {
bool collect_macho_fingerprint(const std::string &path, const uint8_t *header,
                               size_t header_bytes, uint64_t slide, uint64_t pure_virtual,
                               int pid, ProcessFingerprint *out, std::string *error);
}  // namespace grc
