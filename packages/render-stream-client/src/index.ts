// @godot-scene-web/render-stream-client: a lean live render-stream client.
// Private until the wire freezes; consumers alias this source.

export {
  createRenderStreamClient,
  type GamePoint,
  type RenderStreamClient,
  type RenderStreamClientOptions,
} from "./client";
export type { ColdPayload } from "./cold";
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
  ITEM_ROW_STRIDE,
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
  queryEpoch,
  queryItemRows,
  queryVisibleMany,
  type Rect,
  type RenderStreamExtension,
  type RGBA,
} from "./extensions";
export { type ClientHelloFacts, clientHello } from "./hello";
export type {
  HintEntry,
  HintLead,
  HintState,
  ResourceHintRecord,
  ResourceHintVariant,
} from "./hints";
export { type CoreBuild, CoreLoadError, type RenderStreamCore } from "./loader";
export {
  type ApplyOn,
  type CreditStage,
  RECONNECT_BACKOFF_MS,
  RESOURCE_LOG_MAX,
  type RenderStreamFailureReason,
  type RenderStreamStats,
  type RenderStreamStatus,
  type ResourceDiagnostic,
  type ResourceDiagnostics,
  type ResourceUnavailableReason,
} from "./loop";
export {
  type PointerTargetResolverOptions,
  pointerTargetIdentity,
  pointerTargetResolver,
  type RenderStreamPointerTarget,
  type RenderStreamPointerTargetResolver,
} from "./pointer-targets";
export {
  createRecorder,
  type RecorderOptions,
  type Recording,
  type RecordKind,
  type RenderStreamRecorder,
} from "./recorder";
export {
  computeSpreadItem,
  containerHAlignFactor,
  createSpreadExtension,
  fieldDx,
  rootSpreadContext,
  type SpreadBudget,
  type SpreadContext,
  type SpreadDeps,
  type SpreadOptions,
  type SpreadOut,
  type SpreadShape,
  spreadDelta,
} from "./spread";
export {
  isAndroidPage,
  type RenderStreamCarrier,
  type RenderStreamTransport,
  type RenderStreamTransportEvents,
  type RenderStreamTransportFactory,
  webSocketTransport,
  webTransportAvailable,
} from "./transport";
