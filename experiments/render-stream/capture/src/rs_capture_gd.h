#pragma once
#include <functional>
#include <string>
#include "rs_capture_api.h"

namespace grc::rs::capture {
using Invoke = std::function<Value(const std::string &, const Value::Object &)>;
// SCENE init, after iface_load. The Object class exists in every capture mode; the singleton
// is owned here only in standby and arm modes. All lifecycle and signal calls are main-only.
bool gd_capture_register(Invoke invoke, bool singleton, std::string *why);
void gd_capture_unregister();
void gd_capture_emit(const Signal &signal);
}
