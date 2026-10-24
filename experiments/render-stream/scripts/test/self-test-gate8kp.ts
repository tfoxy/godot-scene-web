#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8kp checks (lib/gate8-delivery-checks.ts, G8kp) and the GSW receiver's
// /9 hello keys (web/gsw-receiver/hello.ts), each with a passing and a failing case:
//
// 1. predictD3 (texture-delivery-design.md D3): block only for a stated family, `decoded` last
//    whatever the list says, a non-ok entry has no choice.
// 2. deliverySelectProblems: a receiver uploading D3's choice passes; one that uploads `block`
//    while stating no family (the ignore-format-mask sabotage), one that names a masked family,
//    and one that never uploads a variant-offering texture each fail.
// 3. gswBlockAgainstHw: decided pixels only; delta 1 is counted apart from beyond.
// 4. hello.ts: gpu_formats from an extension list (order, mask, `none`) and the /9 hello's keys.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8kp.ts
//
// Exits non-zero if any assertion fails.

import { gpuFormatsOf, helloV9 } from "../../web/gsw-receiver/hello";
import {
  type DeliveryEntry,
  deliverySelectProblems,
  gswBlockAgainstHw,
  predictD3,
  type UploadRow,
} from "../lib/gate8-delivery-checks";
import type { ResolvedRecording } from "../lib/render-stream-2";

let failures = 0;
function expect(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const H = (c: string) => c.repeat(64);
const entry = (
  id: number,
  variants: DeliveryEntry["variants"],
  status = "ok",
): DeliveryEntry => ({
  id,
  kind: "image",
  status,
  hash: status === "ok" ? H(String(id)) : null,
  format: "RGBA8",
  variants,
});
const block = (format: string, c: string) => ({
  encoding: "block" as const,
  hash: H(c),
  payload_bytes: 100,
  format,
  params: null,
});

// 1. predictD3
{
  const dxt = entry(1, [block("DXT5", "a")]);
  expect(
    predictD3(dxt, ["block", "decoded"], ["s3tc"])?.encoding === "block",
    "DXT5 with s3tc picks block",
  );
  expect(
    predictD3(dxt, ["block", "decoded"], ["s3tc"])?.hash === H("a"),
    "block picks the variant's hash",
  );
  expect(
    predictD3(dxt, ["block", "decoded"], ["bptc"])?.encoding === "decoded",
    "DXT5 without s3tc is decoded",
  );
  expect(
    predictD3(dxt, ["decoded", "block"], ["s3tc"])?.encoding === "decoded",
    "decoded first wins",
  );
  expect(
    predictD3(dxt, ["block"], [])?.hash === H("1"),
    "decoded is always the fallback",
  );
  expect(
    predictD3(
      entry(2, [block("ETC2_RGBA8", "b")]),
      ["block", "decoded"],
      ["s3tc", "bptc", "rgtc"],
    )?.encoding === "decoded",
    "ETC2 needs etc2",
  );
  expect(
    predictD3(
      entry(3, [block("ASTC_4x4", "c")]),
      ["block", "decoded"],
      ["astc"],
    )?.encoding === "block",
    "ASTC with astc picks block",
  );
  expect(
    predictD3(entry(4, [], "unsupported"), ["block"], ["s3tc"]) === null,
    "a refused entry has no choice",
  );
}

// 2. deliverySelectProblems
{
  const e1 = entry(1, [block("DXT1", "a")]);
  const e2 = entry(2, []);
  const rec = {
    transactions: [{ seq: 1, frame: 1, state: { textures: [e1, e2] } }],
  } as unknown as ResolvedRecording;
  const stated = {
    texture_encodings: "block,decoded",
    gpu_formats: "s3tc,bptc,rgtc",
  };
  const good: UploadRow[] = [
    {
      id: 1,
      hash: H("a"),
      op: "create",
      data_bytes: 2048,
      encoding: "block",
      seq: 1,
    },
    {
      id: 2,
      hash: H("2"),
      op: "create",
      data_bytes: 4096,
      encoding: "decoded",
      seq: 1,
    },
  ];
  const ok = deliverySelectProblems("leg", stated, good, rec, []);
  expect(
    ok.problems.length === 0 && ok.block === 1 && ok.decoded === 1,
    `D3's choices pass (${ok.problems.join("; ")})`,
  );
  const maskedStated = {
    texture_encodings: "block,decoded",
    gpu_formats: "none",
  };
  const sabotage = deliverySelectProblems("leg", maskedStated, good, rec, [
    "s3tc",
    "bptc",
    "rgtc",
  ]);
  expect(
    sabotage.problems.length === 2 && sabotage.block === 1,
    "block under a stated `none` fails (ignore-format-mask)",
  );
  const masked = deliverySelectProblems(
    "leg",
    stated,
    [{ ...good[0], hash: H("1"), encoding: "decoded" }, good[1]],
    rec,
    ["s3tc"],
  );
  expect(
    masked.problems.some((p) => p.includes("with s3tc masked")),
    "stating a masked family fails",
  );
  const bcMasked = deliverySelectProblems("leg", stated, good, rec, ["s3tc"]);
  expect(
    bcMasked.problems.some((p) => p.includes("DXT1 block with s3tc masked")) &&
      bcMasked.blockFamilies.s3tc === 1,
    "a block of a masked family fails, and families are counted",
  );
  const missing = deliverySelectProblems("leg", stated, [good[1]], rec, []);
  expect(
    missing.problems.some((p) => p.includes("never uploaded")),
    "a variant-offering texture never uploaded fails",
  );
  expect(
    deliverySelectProblems("leg", undefined, good, rec, []).problems.length ===
      1,
    "no stated delivery fails",
  );
}

// 3. gswBlockAgainstHw
{
  const img = (px: number[][]) => ({
    width: px.length,
    height: 1,
    data: new Uint8Array(px.flat()),
  });
  const gd = img([
    [1, 1, 1, 255],
    [9, 9, 9, 255],
    [1, 1, 1, 255],
  ]);
  const ref = img([
    [1, 1, 1, 255],
    [2, 2, 2, 255],
    [1, 1, 1, 255],
  ]);
  const hw = img([
    [5, 5, 5, 255],
    [5, 5, 5, 255],
    [5, 5, 5, 255],
  ]);
  const gb = img([
    [5, 5, 5, 255],
    [200, 0, 0, 255],
    [6, 5, 5, 255],
  ]);
  const r = gswBlockAgainstHw(gb, gd, ref, hw);
  expect(
    r.decided === 2 && r.exact === 1 && r.delta1 === 1 && r.beyond === 0,
    `only decided pixels count (${JSON.stringify(r)})`,
  );
  const bad = gswBlockAgainstHw(
    img([
      [9, 5, 5, 255],
      [0, 0, 0, 255],
      [5, 5, 5, 255],
    ]),
    gd,
    ref,
    hw,
  );
  expect(
    bad.beyond === 1 && bad.max === 4,
    "a decided pixel off by more than 1 is beyond",
  );
}

// 4. hello.ts
{
  const all = [
    "EXT_texture_compression_rgtc",
    "WEBGL_compressed_texture_s3tc",
    "OES_x",
    "EXT_texture_compression_bptc",
  ];
  expect(
    gpuFormatsOf(all, null) === "s3tc,bptc,rgtc",
    "families in hello order",
  );
  expect(
    gpuFormatsOf(all, "s3tc,rgtc") === "bptc",
    "the mask removes families",
  );
  expect(
    gpuFormatsOf(all, "s3tc,bptc,rgtc") === "none",
    "everything masked is none",
  );
  expect(
    gpuFormatsOf(
      ["WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_astc"],
      null,
    ) === "etc2,astc",
    "the g31's set",
  );
  const h = helloV9(
    {
      type: "hello",
      protocol: "render-stream/7",
      receiver: "r",
      dpr_milli: 1000,
    },
    "block,decoded",
    "none",
  );
  expect(
    JSON.stringify(h) ===
      '{"type":"hello","protocol":"render-stream/9","receiver":"r","dpr_milli":1000,"texture_encodings":"block,decoded","gpu_formats":"none"}',
    `the /9 hello keeps /7's order and appends the two keys (${JSON.stringify(h)})`,
  );
}

if (failures > 0) {
  console.error(`self-test-gate8kp: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate8kp: ok");
