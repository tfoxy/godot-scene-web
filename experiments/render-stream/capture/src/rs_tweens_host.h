#pragma once
#include "rs_tweens.h"
namespace grc::rs::tweens {
// Godot main thread only; uses existing GDExtension method binds, never RS vtable slots.
std::uint64_t ticks_usec();
std::string resolve_node(std::uint64_t object, Pose *out);
}
