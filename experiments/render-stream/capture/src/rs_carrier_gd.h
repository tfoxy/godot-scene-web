// rs_carrier_gd: the RenderStreamCarrier engine class (CAR6, protocol/carrier-design.md "Writing a
// carrier", "The RenderStreamCarrier class").
//
// A thin RefCounted class, registered with ClassDB by the capture, that turns a script (GDScript,
// C#, any engine language) into a grc_carrier_v1 consumer carrier. Script code pushes events in
// with methods that mirror the host callbacks (opened, text, closed) and receives the hub's calls
// as signals (send_binary, send_text, close, plus started and stopped).
//
// The hub's contract is kept: its hot calls (send_*, close) only queue, on the main thread, and
// return at once; nothing reaches script code from inside a hub call. The queue is delivered as
// signals by gd_carriers_flush(), which entry.cpp calls at the end of every frame callback and in
// every turn of the live linger (and the carrier's stop() delivers what is left). Each binary
// message costs one copy, into the PackedByteArray the signal carries; the hub's buffer is
// released right after.
//
// Lifetime: the carrier's state outlives the object. When the object is freed (its last reference
// dropped, or the scene tree torn down at engine shutdown, which comes before the capture's own
// shutdown callback), queued messages are released undelivered and every open connection is
// reported closed 1001 at the next flush; the carrier then serves nothing until live stops.
#ifndef GRC_RS_CARRIER_GD_H
#define GRC_RS_CARRIER_GD_H

#include <string>

namespace grc {
namespace live {

// Registers RenderStreamCarrier with ClassDB. Call once, at SCENE initialization, after
// iface_load. Returns false (with *why) when the engine lacks an interface function the class
// needs; the class is then absent and nothing else changes.
bool gd_carrier_class_register(std::string *why);

// Unregisters the class (deinitialize). A no-op when it was never registered.
void gd_carrier_class_unregister();

// Delivers every RenderStreamCarrier's queued hub calls as signals, in order. Main thread only.
// One relaxed atomic load when no carrier object was ever registered.
void gd_carriers_flush();

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_CARRIER_GD_H
