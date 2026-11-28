// Validated, read-only CanvasTexture lookup. No engine pointers are dereferenced directly.
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace grc {
struct Calibration;
struct ProcessFingerprint;
namespace rs {

struct CanvasTextureChannels {
  std::uint64_t diffuse = 0, normal = 0, specular = 0;
  std::int32_t filter = 0, repeat = 0;
  bool operator==(const CanvasTextureChannels &) const = default;
};

struct CanvasTextureLayout {
  std::uint64_t vptr = 0, owner = 0, stride = 0, validator = 0;
  std::uint64_t diffuse = 0, normal = 0, specular = 0, filter = 0, repeat = 0;
};

struct CanvasTextureRecord {
  std::uint64_t global = 0;
  CanvasTextureLayout rd, gles3;
  static bool parse(const std::vector<std::pair<std::string, std::int64_t>> &fields,
                    std::uint64_t bias, CanvasTextureRecord *out, std::string *why);
};

// Probe-only fault injection returns a local record copy; engine memory is never changed.
CanvasTextureRecord canvas_texture_record_probe_copy(const CanvasTextureRecord &, const char *fault);

class CanvasTextureReader {
 public:
  virtual ~CanvasTextureReader() = default;
  virtual bool copy(std::uint64_t address, void *out, std::size_t bytes) = 0;
  // Must use safe engine getters, never a function pointer read from a speculative object.
  virtual bool live_texture(std::uint64_t rid) = 0;
  // RenderingDevice::TextureType (4.5.1); -1 when no safe type getter is available.
  virtual std::int64_t texture_type(std::uint64_t rid) = 0;
};

class CanvasTextureResolver {
 public:
  void attach(bool enabled, const CanvasTextureRecord *record, const std::string &reason);
  void detach();
  void arm_begin();
  void forget(std::uint64_t rid);
  bool selfcheck(CanvasTextureReader &reader,
                 const std::vector<std::pair<std::uint64_t, CanvasTextureChannels>> &known);
  bool cached(std::uint64_t rid, CanvasTextureChannels *out, bool *ok) const;
  bool resolve(CanvasTextureReader &reader, std::uint64_t rid, CanvasTextureChannels *out);
  void elapsed(std::uint64_t ns);
  std::string json() const;
  bool ready() const { return enabled_ && checked_ && reason_.empty(); }
  bool enabled() const { return enabled_; }
  const std::string &reason() const { return reason_; }
  const std::string &permanent_failure() const { return permanent_failure_; }

 private:
  bool read(CanvasTextureReader &, std::uint64_t, CanvasTextureChannels *, std::string *,
            bool require_2d);
  struct Cached { CanvasTextureChannels channels; bool ok = false; };
  CanvasTextureRecord record_;
  std::map<std::uint64_t, Cached> cache_;
  std::set<std::uint64_t> resolved_this_arm_;
  std::map<std::string, std::uint64_t> unresolved_;
  bool enabled_ = false, checked_ = false;
  std::string reason_, permanent_failure_;
  std::uint64_t resolved_ = 0, rereads_ = 0, selfchecks_ = 0, selfcheck_samples_ = 0;
  std::uint64_t total_ns_ = 0, max_ns_ = 0;
  std::uint64_t arm_total_ns_ = 0, arm_max_ns_ = 0;
};

// Call attach only after capture calibration, slot-mask and behaviour checks pass.
// Main-thread attachment and materialize seams. Feature-off never binds or calls the engine.
// Attach is idempotent per attachment: it returns true only on the call that attached, so callers
// on a per-frame path (a deferred arm retries attempt() every frame) emit its evidence once.
bool canvas_texture_resolver_attach(const Calibration &, const ProcessFingerprint &);
void canvas_texture_resolver_detach();
// Shared with the resolver's live type reader. Cached once per attachment, never per RID.
// Call only on a rendered host; the dummy also has no RenderingDevice.
bool canvas_texture_readback_requires_2d();
void canvas_texture_resolver_arm_begin();
void canvas_texture_resolver_forget(std::uint64_t rid);
bool canvas_texture_resolve(std::uint64_t rid, CanvasTextureChannels *out);
std::string canvas_texture_resolver_json();

}  // namespace rs
}  // namespace grc
