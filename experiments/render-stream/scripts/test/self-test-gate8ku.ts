#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8ku checks (lib/gate8-basis-checks.ts, G8ku) and predictD3's uastc rule
// (lib/gate8-delivery-checks.ts), each with a passing and a failing case:
//
// 1. predictD3 (texture-delivery-design.md D3, G8ku): `uastc` wins when the receiver lists it and
//    the entry offers it, after `block` with a stated family, and never when the receiver does
//    not list it.
// 2. psnrRgba: identical buffers are 99 dB; a one-level error on every channel is 48.13 dB.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8ku.ts
//
// Exits non-zero if any assertion fails.

import { psnrRgba } from "../lib/gate8-basis-checks";
import { type DeliveryEntry, predictD3 } from "../lib/gate8-delivery-checks";

let failures = 0;
function expect(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const H = (c: string) => c.repeat(64);
const entry: DeliveryEntry = {
  id: 1,
  kind: "image",
  status: "ok",
  hash: H("a"),
  format: "RGBA8",
  source_format: "DXT1",
  variants: [
    {
      encoding: "block",
      hash: H("b"),
      payload_bytes: 8,
      format: "DXT1",
      params: null,
    },
    {
      encoding: "uastc",
      hash: H("c"),
      payload_bytes: 9,
      format: null,
      params: "basisu-1.60/uastc-l1/zstd6/linear",
    },
  ],
};

// 1. predictD3 with uastc.
const order = ["block", "uastc", "decoded"];
expect(
  predictD3(entry, order, ["s3tc"])?.encoding === "block",
  "block first with its family",
);
expect(
  predictD3(entry, order, [])?.hash === H("c"),
  "uastc when block's family is missing",
);
expect(
  predictD3(entry, ["block", "decoded"], [])?.encoding === "decoded",
  "no uastc unless listed",
);
expect(
  predictD3({ ...entry, variants: [] }, order, [])?.encoding === "decoded",
  "decoded when nothing else is offered",
);
expect(
  predictD3(entry, ["decoded", "uastc"], [])?.encoding === "decoded",
  "decoded stops the list",
);

// 2. psnrRgba.
const a = new Uint8Array(64).fill(100);
const b = new Uint8Array(64).fill(101);
expect(psnrRgba(a, a) === 99, "identical buffers are 99 dB");
expect(
  Math.abs(psnrRgba(a, b) - 48.13) < 0.01,
  "a one-level error is 48.13 dB",
);
expect(
  psnrRgba(a, new Uint8Array(64).fill(0)) < 30,
  "a large error is below the floor",
);

if (failures > 0) {
  console.error(`self-test-gate8ku: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate8ku: ok");
