#pragma once
#include "audio_driver_probe.h"
namespace grc::audio {
bool sample_preflight(std::string *error);
bool sample_default();
bool start_sample(const Probe &, const Abi &, std::string *error);
void stop_sample();
void sample_frame();
void sample_bench_configure();
}
