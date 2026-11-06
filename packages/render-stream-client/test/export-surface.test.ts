import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as client from "../src/index";
import indexSource from "../src/index.ts?raw";

// Consumers alias this package's source and may mirror these names in ambient declarations, so
// both runtime and erased type exports are pinned (mirror-client-design.md "The package").
const VALUE_EXPORTS = `
createRenderStreamClient RenderStreamEndpointError validateEndpoint clientHello CoreLoadError
RECONNECT_BACKOFF_MS webSocketTransport
webTransportAvailable isAndroidPage invertAffine mulAffine createRecorder
computeSpreadItem containerHAlignFactor createSpreadExtension fieldDx rootSpreadContext spreadDelta
pointerTargetIdentity pointerTargetResolver
`
  .trim()
  .split(/\s+/);

const TYPE_EXPORTS = `
RenderStreamClient RenderStreamClientOptions RenderStreamExtension RenderStreamEndpoint
RenderStreamProtocol ClientHelloFacts CoreBuild RenderStreamCore RenderStreamFailureReason
RenderStreamStats RenderStreamStatus RenderStreamTransport RenderStreamTransportEvents
RenderStreamTransportFactory RenderStreamCarrier ApplyOn CreditStage Affine2D ExtensionFrame ExtensionSession ItemMeta
ItemMetaBatch ItemMetaField ItemMetaGrant ItemQuery OverrideTable OverrideValues Point Rect RGBA
GamePoint SpreadBudget SpreadContext SpreadDeps SpreadOptions SpreadOut SpreadShape
Recording RecordKind RecorderOptions RenderStreamRecorder
PointerTargetResolverOptions RenderStreamPointerTarget RenderStreamPointerTargetResolver
`
  .trim()
  .split(/\s+/);

describe("@godot-scene-web/render-stream-client export surface", () => {
  it("exports exactly the checked-in value and type lists", () => {
    expect(Object.keys(client).sort()).toEqual([...VALUE_EXPORTS].sort());
    const parsed = parseBarrelExports(indexSource);
    expect(parsed.values.sort()).toEqual([...VALUE_EXPORTS].sort());
    expect(parsed.types.sort()).toEqual([...TYPE_EXPORTS].sort());
  });
});

describe("RenderStreamStats", () => {
  it("names the connection's carrier (CAR8)", () => {
    const carrier: client.RenderStreamStats["carrier"] = null;
    const named: client.RenderStreamStats["carrier"][] = [
      "websocket",
      "webtransport",
      carrier,
    ];
    expect(named).toHaveLength(3);
  });

  it("lets a consumer build a stats literal without carrier (CAR10: the field is optional)", () => {
    const literal: client.RenderStreamStats = {
      applied: 0,
      appliesPerSec: 0,
      creditRttMsP50: null,
      heapBytes: 0,
    };
    expect(literal.carrier).toBeUndefined();
  });
});
