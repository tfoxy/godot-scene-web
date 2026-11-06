// rs_tracks_gd: the RenderStreamTrack engine class (TRK2, protocol/tracks-design.md Q6, "As built
// (TRK2)").
//
// A thin RefCounted class, registered with ClassDB by the capture beside RenderStreamCarrier, that
// makes a script (GDScript, C#, any engine language) the receiver of one track kind: it binds the
// kind, and the hub's opened/message/closed calls reach script code as signals of the same names.
// Script code reaches it with ClassDB.instantiate("RenderStreamTrack") and call(), since the class
// exists only once the capture is loaded.
//
// A registry outlives the hub: bind() may run before the arm (an autoload's _ready usually does,
// and GRC_ARM_DEFER_FRAMES moves the arm later). gd_tracks_attach() binds every registered
// receiver to the hub once live listens, gd_tracks_detach() lets go of it at stop.
//
// The hub's contract is kept: its calls into a receiver only queue, on the main thread, and return
// at once. gd_tracks_flush() delivers the queue as signals, which entry.cpp calls at the end of
// every frame callback (after gd_carriers_flush) and in every turn of the live linger; never from
// inside live_drain, so a handler may call send() and close() without re-entering the hub.
//
// Latency: the hub drains in the capture's frame callback, which Godot runs after
// RenderingServer::draw in Main::iteration, and the flush runs at the end of that callback. An
// input receiver's Input.parse_input_event() there is applied at the next iteration's
// flush_buffered_events(), before its physics and process steps: a payload that arrives during
// iteration N reaches game code in iteration N+1 (one frame plus the transport, at most).
//
// Lifetime: the receiver's state outlives the object. When the object is freed, its sources close
// `track-receiver-gone` at the next flush and no signal is emitted.
//
// Threading: every method, the attach/detach calls and the flush belong to the main thread (the
// thread that registered the class). A call from another thread is refused (`track-wrong-thread`).
#ifndef GRC_RS_TRACKS_GD_H
#define GRC_RS_TRACKS_GD_H

#include <string>

namespace grc {
namespace rs {
namespace tracks {
class TrackHub;
}  // namespace tracks
}  // namespace rs

namespace live {

// Registers RenderStreamTrack with ClassDB. Call once, at SCENE initialization, after iface_load.
// Returns false (with *why) when the engine lacks an interface function the class needs; the
// class is then absent and nothing else changes.
bool gd_track_class_register(std::string *why);

// Unregisters the class (deinitialize). A no-op when it was never registered.
void gd_track_class_unregister();

// Live is listening. `hub` is the TrackHub, or null with tracks off (GRC_LIVE_TRACKS unset). Binds
// every registered receiver whose kind the hub grants (status `serving`); the others report
// `not-granted`. A receiver bound later binds at once.
void gd_tracks_attach(rs::tracks::TrackHub *hub);

// Live stopped (after the hub's close_all): the hub is never called again, every receiver reports
// `stopped`, and the closed() calls already queued are still delivered by the next flush.
void gd_tracks_detach();

// Delivers every receiver's queued calls as signals, in order, and ends the sources of receivers
// whose object was freed. Main thread only. One relaxed atomic load when nothing was ever bound.
void gd_tracks_flush();

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_TRACKS_GD_H
