// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type AckStage, AckWriter } from "../src/ack";
import { validateEndpoint, webSocketUrl } from "../src/endpoint";
import { type ClientHelloFacts, clientHello } from "../src/hello";
import { StreamLoop } from "../src/loop";

interface Vector {
  name: string;
  op: string;
  category?: "strict";
  input: string;
  output?: string;
  error?: string;
}
const vectors = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "experiments/render-stream/rs-core/src/client/vectors.json",
    ),
    "utf8",
  ),
) as Vector[];

function run(v: Vector): string {
  if (v.op === "parse_host_error") {
    const expected = JSON.parse(v.output ?? "{}");
    // Exercise the existing private parser, including its unexpected-text handling.
    const parser = StreamLoop.prototype as unknown as {
      onHostText(
        this: { lastAppliedSeq: number },
        conn: { sessionSeen: boolean },
        text: string,
      ): never;
    };
    try {
      parser.onHostText.call(
        { lastAppliedSeq: 0 },
        { sessionSeen: true },
        v.input,
      );
      throw new Error("host text was accepted");
    } catch (e) {
      expect((e as Error).message).toBe(
        expected.ok
          ? `${expected.reason}: ${expected.detail}`
          : `unexpected text message ${JSON.stringify(v.input)}`,
      );
    }
    return JSON.stringify(expected);
  }
  const p = JSON.parse(v.input);
  switch (v.op) {
    case "client_hello":
      return JSON.stringify(clientHello(p as ClientHelloFacts));
    case "subprotocol":
      return `render-stream.${p}`;
    case "resolve_descriptor": {
      const e = validateEndpoint(p.descriptor);
      return JSON.stringify({
        url: webSocketUrl(e.url, p.origin),
        resourceBase:
          e.resourceBase === ""
            ? new URL(p.origin).origin
            : new URL(e.resourceBase, p.origin).href.replace(/\/$/, ""),
        token: e.token,
        protocol: e.protocol,
        ...(e.presentation ? { presentation: e.presentation } : {}),
        ...(e.webTransport ? { webTransport: e.webTransport } : {}),
      });
    }
    case "encode_ack":
      return new AckWriter().write(
        p.stream_id,
        p.seq ?? Number.NaN,
        p.stage as AckStage,
        p.t_us ?? Number.NaN,
      );
    default:
      throw new Error(`unknown vector operation ${v.op}`);
  }
}

describe("shared Rust/browser client protocol vectors", () => {
  // The browser currently uses URL; strict refusal vectors apply when it adopts the shared resolver.
  for (const v of vectors.filter((v) => v.category !== "strict")) {
    it(v.name, () => {
      if (v.error !== undefined) expect(() => run(v)).toThrow(v.error);
      else expect(run(v)).toBe(v.output);
    });
  }
});
