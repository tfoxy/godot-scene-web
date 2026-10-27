#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8w11 checks (lib/gate8-w11-checks.ts, W11b) on golden payloads and
// synthetic recordings, each helper with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-w11.ts
//
// 1. rebuildGrm1: every golden-4 GRM1 payload's body, rebuilt, is the payload byte for byte.
// 2. carriedEqualsNamesProblems: records equal to inline(T) \ inline(B) pass; a missing, an extra
//    and a re-ordered record each fail; an out-of-band hash is never expected.
// 3. resendOnReturn: a hash that leaves and returns, carried twice, passes; carried once (the
//    keep-carried shape) fails; a stream where nothing returns fails (it proves nothing).
// 4. dynClassifyProblems: a mesh changed at frames 10 and 12 must be first dynamic at 12 (K = 4);
//    dynamic at 11, at 13, never, or changed 5 frames apart and dynamic all fail; under `off` any
//    dynamic mesh fails; a demotion fails.
// 5. dynWireProblems: bodies equal to the hook log's hashes pass, a stale one fails.
//
// Exits non-zero if any assertion fails.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResourceLine } from "../lib/gate2-checks";
import {
  carriedEqualsNamesProblems,
  type DynamicTrace,
  dynClassifyProblems,
  dynWireProblems,
  rebuildGrm1,
  resendOnReturn,
} from "../lib/gate8-w11-checks";
import type { ResolvedRecording } from "../lib/render-stream-2";
import { decodeMeshPayload } from "../lib/render-stream-mesh";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = resolve(HERE, "..", "..", "protocol");

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}`);
  }
}

const h = (c: string) => c.repeat(64);

// A resolved recording over `states`: each a list of [hash, payload_bytes] texture names; the
// records before each seq are `records[i]`.
function recording(
  states: [string, number][][],
  records: string[][],
): ResolvedRecording {
  return {
    schema: "render-stream-11-resolved/1",
    session_id: "s",
    stream_id: "t",
    transactions: states.map((names, i) => ({
      seq: i + 1,
      frame: i + 1,
      encoding: "patch",
      state: {
        textures: names.map(([hash, bytes], k) => ({
          id: k + 1,
          kind: "image",
          status: "ok",
          hash,
          payload_bytes: bytes,
        })),
        meshes: [],
        shaders: [],
      },
    })),
    resources: records.flatMap((list, i) =>
      list.map((hash) => ({
        hash,
        bytes: 1,
        record_index: 0,
        before_seq: i + 1,
      })),
    ),
  } as unknown as ResolvedRecording;
}

function meshLine(
  frame: number,
  op: string,
  id: number,
  hash: string | null,
  surface = 0,
): ResourceLine {
  return {
    frame,
    kind: "mesh",
    op,
    id,
    version: 1,
    status: "ok",
    hash,
    surface,
    outcome: "applied",
    omitted: false,
  } as unknown as ResourceLine;
}

function trace(
  frames: number[],
  dynamicAt: (frame: number) => boolean,
  hashOf = (f: number) => h("a"),
): DynamicTrace {
  return {
    txs: frames.map((f) => ({
      seq: f,
      frame: f,
      full: false,
      dynamic: dynamicAt(f) ? new Map([[1, [hashOf(f)]]]) : new Map(),
    })),
    bodies_sent: 0,
    body_bytes: 0,
    items_patched: [],
  };
}

async function main(): Promise<void> {
  // 1. rebuildGrm1
  const dir = join(PROTOCOL, "golden-4", "payloads");
  let rebuilt = 0;
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".grm"))) {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    const d = decodeMeshPayload(bytes);
    const metaLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
      8,
      true,
    );
    const body = bytes.subarray(12 + metaLen);
    const again = rebuildGrm1(
      {
        primitive: d.primitive,
        format: d.format,
        vertex_count: d.vertex_count,
        index_count: d.index_count,
      },
      body,
    );
    expect(
      again.length === bytes.length && again.every((b, i) => b === bytes[i]),
      `rebuildGrm1 ${name}`,
    );
    rebuilt++;
  }
  expect(rebuilt > 0, "golden-4 has GRM1 payloads");

  // 2. carriedEqualsNamesProblems
  const states: [string, number][][] = [
    [
      [h("a"), 10],
      [h("b"), 10],
      [h("f"), 9000],
    ],
    [
      [h("b"), 10],
      [h("c"), 10],
    ],
    [
      [h("a"), 10],
      [h("c"), 10],
    ],
  ];
  expect(
    carriedEqualsNamesProblems(
      recording(states, [[h("a"), h("b")], [h("c")], [h("a")]]),
      4096,
    ).length === 0,
    "L2 records pass",
  );
  expect(
    carriedEqualsNamesProblems(
      recording(states, [[h("a"), h("b")], [h("c")], []]),
      4096,
    ).length > 0,
    "a missing re-carry fails",
  );
  expect(
    carriedEqualsNamesProblems(
      recording(states, [[h("a"), h("b")], [h("c"), h("b")], [h("a")]]),
      4096,
    ).length > 0,
    "an extra record fails",
  );
  expect(
    carriedEqualsNamesProblems(
      recording(states, [[h("b"), h("a")], [h("c")], [h("a")]]),
      4096,
    ).length > 0,
    "table order is required",
  );

  // 3. resendOnReturn
  expect(
    resendOnReturn(
      recording(states, [[h("a"), h("b")], [h("c")], [h("a")]]),
      4096,
    ).problems.length === 0,
    "a returning hash carried again passes",
  );
  expect(
    resendOnReturn(recording(states, [[h("a"), h("b")], [h("c")], []]), 4096)
      .problems.length > 0,
    "keep-carried's single carry fails",
  );
  expect(
    resendOnReturn(
      recording([[[h("a"), 10]], [[h("a"), 10]]], [[h("a")], []]),
      4096,
    ).problems.length > 0,
    "nothing returning proves nothing",
  );

  // 4. dynClassifyProblems: mesh 1 built at 1, changed at 10 and 12
  const lines = [
    meshLine(1, "mesh_create_from_surfaces", 1, h("0")),
    meshLine(10, "mesh_surface_update_vertex_region", 1, h("1")),
    meshLine(12, "mesh_surface_update_vertex_region", 1, h("2")),
    meshLine(20, "mesh_surface_update_vertex_region", 1, h("3")),
  ];
  const frames = Array.from({ length: 20 }, (_, i) => i + 1);
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 12),
      lines,
      "auto",
      4,
    ).length === 0,
    "dynamic at the second change passes",
  );
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 11),
      lines,
      "auto",
      4,
    ).length > 0,
    "dynamic early fails",
  );
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 13),
      lines,
      "auto",
      4,
    ).length > 0,
    "dynamic late fails",
  );
  expect(
    dynClassifyProblems(
      trace(frames, () => false),
      lines,
      "auto",
      4,
    ).length > 0,
    "never dynamic fails",
  );
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 12 && f < 16),
      lines,
      "auto",
      4,
    ).length > 0,
    "a demotion fails",
  );
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 12),
      lines,
      "auto",
      1,
    ).length > 0,
    "two frames apart is not within K = 1",
  );
  expect(
    dynClassifyProblems(
      trace(frames, (f) => f >= 12),
      lines,
      "off",
      4,
    ).length > 0,
    "off: any dynamic mesh fails",
  );

  // 5. dynWireProblems
  const hashAt = (f: number) =>
    f >= 20 ? h("3") : f >= 12 ? h("2") : f >= 10 ? h("1") : h("0");
  expect(
    dynWireProblems(
      trace(frames, () => true, hashAt),
      lines,
    ).length === 0,
    "bodies equal to the hook log pass",
  );
  expect(
    dynWireProblems(
      trace(
        frames,
        () => true,
        (f) => (f >= 20 ? h("2") : hashAt(f)),
      ),
      lines,
    ).length > 0,
    "a stale body fails",
  );

  console.log(
    `\nself-test-gate8-w11: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
