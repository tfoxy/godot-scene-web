// @godot-scene-web/render-stream-client: a lean live render-stream client (mirror-client-design.md).
// Private until the wire freezes; consumers alias this source.

export {
  createRenderStreamClient,
  type RenderStreamClient,
  type RenderStreamClientOptions,
  type RenderStreamExtension,
} from "./client";
export {
  type RenderStreamEndpoint,
  RenderStreamEndpointError,
  type RenderStreamProtocol,
  validateEndpoint,
} from "./endpoint";
export { type ClientHelloFacts, clientHello } from "./hello";
export { type CoreBuild, CoreLoadError, type RenderStreamCore } from "./loader";
export {
  type ApplyOn,
  type CreditStage,
  RECONNECT_BACKOFF_MS,
  type RenderStreamFailureReason,
  type RenderStreamStats,
  type RenderStreamStatus,
} from "./loop";
export {
  type RenderStreamTransport,
  type RenderStreamTransportEvents,
  type RenderStreamTransportFactory,
  webSocketTransport,
} from "./transport";
