// @godot-scene-web/render-stream-client: a lean live render-stream client (mirror-client-design.md).
// Private until the wire freezes; consumers alias this source.

export {
  createRenderStreamClient,
  type GamePoint,
  type RenderStreamClient,
  type RenderStreamClientOptions,
} from "./client";
export {
  type RenderStreamEndpoint,
  RenderStreamEndpointError,
  type RenderStreamProtocol,
  validateEndpoint,
} from "./endpoint";
export {
  type Affine2D,
  type ExtensionFrame,
  type ExtensionSession,
  type ItemMeta,
  type ItemMetaBatch,
  type ItemMetaField,
  type ItemMetaGrant,
  type ItemQuery,
  invertAffine,
  mulAffine,
  type OverrideTable,
  type OverrideValues,
  type Point,
  type Rect,
  type RenderStreamExtension,
  type RGBA,
} from "./extensions";
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
