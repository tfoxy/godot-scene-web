#pragma once
#include "audio_driver_probe.h"
namespace grc::audio {
bool start_log(const Probe &probe, const Abi &abi, const std::string &dir, std::string *error);
void stop_log();
}
