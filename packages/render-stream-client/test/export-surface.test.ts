import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as client from "../src/index";
import indexSource from "../src/index.ts?raw";

// Consumers alias this package's source and may mirror these names in ambient declarations, so
// both runtime and erased type exports are pinned (mirror-client-design.md "The package").
const VALUE_EXPORTS = `
createRenderStreamClient RenderStreamEndpointError validateEndpoint clientHello CoreLoadError
RECONNECT_BACKOFF_MS webSocketTransport
`
  .trim()
  .split(/\s+/);

const TYPE_EXPORTS = `
RenderStreamClient RenderStreamClientOptions RenderStreamExtension RenderStreamEndpoint
RenderStreamProtocol ClientHelloFacts CoreBuild RenderStreamCore RenderStreamFailureReason
RenderStreamStats RenderStreamStatus RenderStreamTransport RenderStreamTransportEvents
RenderStreamTransportFactory
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
