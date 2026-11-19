#include "calib_fingerprint.h"

namespace grc {
bool collect_engine_fingerprint(ProcessFingerprint *out, std::string *error) {
  *out = {};
#if defined(__aarch64__)
  out->platform = "macos-arm64";
#else
  out->platform = "macos-x86_64";
#endif
  // Mach-O process fingerprinting is deferred; never arm without a verified image identity.
  *error = "darwin-fingerprint-unsupported: Mach-O process identity is unavailable";
  return false;
}
} // namespace grc
