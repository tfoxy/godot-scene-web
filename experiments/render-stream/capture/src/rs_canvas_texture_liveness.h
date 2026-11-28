#pragma once

#include <cstdint>

#include "gdextension_interface.h"

namespace grc::rs {
struct CanvasTextureLiveBindings {
  GDExtensionInterfaceObjectMethodBindPtrcall ptrcall;
  void *server, *device;
  GDExtensionMethodBindPtr native, format, rd_texture, rd_valid;
};
struct CanvasTextureLiveCounts {
  std::uint64_t native = 0, rd = 0;
};

// Use safe engine getters only; a native handle is not available on every RD driver.
inline bool canvas_texture_is_live(const CanvasTextureLiveBindings &b, std::uint64_t rid,
                                   CanvasTextureLiveCounts &counts) {
  const std::uint8_t srgb = 0;
  const GDExtensionConstTypePtr args[] = {&rid, &srgb};
  std::uint64_t native = 0;
  b.ptrcall(b.native, b.server, args, &native);
  if (!native) {
    if (!b.device || !b.rd_texture || !b.rd_valid) return false;
    std::uint64_t rd_rid = 0;
    b.ptrcall(b.rd_texture, b.server, args, &rd_rid);
    if (!rd_rid) return false;
    const GDExtensionConstTypePtr rd_args[] = {&rd_rid};
    std::uint8_t valid = 0;
    b.ptrcall(b.rd_valid, b.device, rd_args, &valid);
    if (!valid) return false;
  }
  std::int64_t format = -1;
  b.ptrcall(b.format, b.server, args, &format);
  // Image::FORMAT_MAX is 39 in the calibrated 4.5.1 ABI. Resolution separately proves type.
  if (format < 0 || format >= 39) return false;
  if (native) ++counts.native;
  else ++counts.rd;
  return true;
}
}  // namespace grc::rs
