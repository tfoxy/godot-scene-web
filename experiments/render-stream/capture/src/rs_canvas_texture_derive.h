// Bounded Linux/GCC instruction proof for a calibrated RenderingServer slot.
#pragma once
#include "rs_canvas_texture_resolver.h"

namespace grc::rs {
enum class CanvasTextureImageRange { code, readonly, writable };
class CanvasTextureDeriveReader {
 public:
  virtual ~CanvasTextureDeriveReader() = default;
  // Validate the entire extent in the main image before copying. No direct dereferences.
  virtual bool image(std::uint64_t, void *, std::size_t, CanvasTextureImageRange) = 0;
  // Only a storage object's vptr may be copied from the heap during derivation.
  virtual bool storage_vptr(std::uint64_t, std::uint64_t *) = 0;
};
// Validate a shipped PE record before engine calls or sentinel allocation.
bool validate_canvas_texture_record(CanvasTextureDeriveReader &, const CanvasTextureRecord &,
                                    std::string *why);
bool derive_canvas_texture_record(CanvasTextureDeriveReader &, const std::string &platform,
                                  const std::string &version, std::uint64_t create_slot,
                                  CanvasTextureRecord *, std::string *why);
}  // namespace grc::rs
