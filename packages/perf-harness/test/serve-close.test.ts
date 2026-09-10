// @vitest-environment node
//
// `close()` must return even when a client is holding a keep-alive connection open.
//
// This is not hypothetical: on a device run the phone reaches the harness server through
// `adb reverse`, and Chrome parks the HTTP connection in its socket pool. The harness closes the
// TAB, never the browser, so nothing on either side ends that socket — and `server.close()` waits
// for every open connection before it calls back. Two device runs wrote their trace and screenshot
// and then hung here, which is indistinguishable from a stalled capture.

import { Agent, get } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { ensureAtlasFixture } from "../src/fixtures/atlas";
import { startPerfServer } from "../src/serve";

describe("startPerfServer close", () => {
  it("returns while a keep-alive connection is still open", async () => {
    const atlas = await ensureAtlasFixture("artifacts/perf", {
      pageSize: 256,
      regionCount: 4,
      regionInset: true,
    });
    const server = await startPerfServer({
      atlasPngPath: atlas.pngPath,
      atlasJsonPath: atlas.jsonPath,
    });

    // A real HTTP client that KEEPS its socket — what Chrome does.
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((res, rej) => {
      const request = get(
        `${server.origin}/fixture/atlas.json`,
        { agent },
        (response) => {
          response.resume();
          response.on("end", () => res());
        },
      );
      request.on("error", rej);
    });

    // …and a socket that has CONNECTED but sent no request. Node closes idle keep-alive connections
    // on `close()`, but a connection it has never seen a request on is not "idle" to it, and that is
    // the shape that actually wedged the device runs.
    const raw = connect(server.port, "127.0.0.1");
    await new Promise<void>((res, rej) => {
      raw.once("connect", () => res());
      raw.once("error", rej);
    });

    await expect(
      Promise.race([
        server.close().then(() => "closed" as const),
        new Promise<"HUNG">((res) => {
          setTimeout(() => res("HUNG"), 5000);
        }),
      ]),
    ).resolves.toBe("closed");
    agent.destroy();
    raw.destroy();
  }, 20_000);
});
