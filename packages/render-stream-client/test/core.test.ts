import { describe, expect, it, vi } from "vitest";
import type { GswRs, GswRsModule } from "../src/abi";
import { WasmStreamCore } from "../src/core";

describe("WasmStreamCore session protocol", () => {
  it("passes the offered /14 version into session validation, including on reconnect", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const session = { protocol: "render-stream/14", session_id: "v2" };
    const liveSession = vi.fn((_len: number, protocol: number) =>
      protocol === 14 ? 0 : -1,
    );
    const g = {
      rx: () => 0,
      live_session: liveSession,
      session_meta: () => JSON.stringify(session),
      error: () => "session: expected protocol 14",
    } as unknown as GswRs;
    const core = new WasmStreamCore(
      {} as GswRsModule,
      memory,
      g,
      13,
      "",
      16777216,
    );
    core.beginConnection(14);
    const bytes = new TextEncoder().encode(JSON.stringify(session));
    expect(core.receive(bytes.buffer as ArrayBuffer, false)).toEqual({
      kind: "session",
      meta: session,
    });
    expect(liveSession).toHaveBeenCalledWith(bytes.byteLength, 14);
  });
});
