// @godot-scene-web/render-stream-client/tracks: the client end of `render-stream-track/1`
// (protocol/tracks-design.md Q10). A separate subpath so the main entry, the pure client, imports
// and bundles none of it.

export {
  type OpenTrackOptions,
  openTrack,
  RenderStreamTrackError,
  TRACK_PROTOCOL,
  TRACK_SUBPROTOCOL,
  type TrackClock,
  type TrackCloseInfo,
  type TrackDisposition,
  type TrackEndpoint,
  type TrackErrorCode,
  type TrackReady,
  type TrackSink,
  type TrackState,
  type TrackStats,
  trackDisposition,
} from "./track";
