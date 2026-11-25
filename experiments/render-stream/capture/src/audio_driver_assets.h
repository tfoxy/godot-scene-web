#pragma once
#include <cstdint>
namespace grc::audio {
void sample_assets_begin();
void sample_assets_registered(uint32_t id, uint64_t stream);
void sample_assets_end();
bool sample_bus_restricted(const void *name);
}
