// The fetch's own signal cancels a body being hashed: a real fetch against a server that sends part of
// the wasm and goes quiet, until the load's deadline.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CoreLoadError, loadCore } from "../src/loader";
import { BUILD } from "./loader-env";

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});

describe("loadCore over a real fetch, without crypto.subtle", () => {
  it("a deadline in the middle of the body closes the connection", async () => {
    const closed = new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        if (req.url?.endsWith("build.json")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ...BUILD, wasm_bytes: 1000 }));
          return;
        }
        res.setHeader("content-type", "application/wasm");
        res.setHeader("content-length", "1000");
        res.write(new Uint8Array(100));
        res.on("close", resolve);
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;

    const failure = await loadCore(
      { glueUrl: `${base}/glue.js`, wasmUrl: `${base}/core.wasm` },
      {
        timeoutMs: 300,
        env: {
          hasSubtle: () => false,
          importGlue: async () => ({
            RENDER_STREAM_CLIENT_GLUE: 1,
            default: () => ({}),
          }),
        },
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(CoreLoadError);
    expect((failure as Error).message).toBe(
      "timeout after 300 ms in wasm fetch",
    );
    // The server saw the client hang up, not just a timer.
    await closed;
  });
});
