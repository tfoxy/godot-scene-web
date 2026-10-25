#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8c checks (lib/gate8-ct-checks.ts, P3-CT) on the committed
// fixtures/gate8-ct/expected.json and on synthetic recordings, images and upload lists, each with a
// passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-ct.ts
//
// 1. expected.json is self-consistent (every drawn and refused cell has a region; the counts match).
// 2. premiseProblems: the fixture's shape passes; a command naming a diffuse directly, a missing
//    swap and an `ok` normal-mapped canvas texture each fail.
// 3. regionProblems: a patterned cell is textured, a white or clear one is not; a clear cell is
//    clear, a drawn one is not.
// 4. uploadProblems: every diffuse created passes; a diffuse never uploaded fails.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type G8cExpected,
  premiseProblems,
  regionProblems,
  uploadProblems,
} from "../lib/gate8-ct-checks";
import type { ResolvedRecording } from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

interface Tex {
  id: number;
  kind: "image" | "canvas";
  status: "ok" | "unsupported";
  reason: string | null;
  version: number;
  canvas: { diffuse: number | null; filter: string; repeat: string } | null;
}

const img = (id: number, version = 1): Tex => ({
  id,
  kind: "image",
  status: "ok",
  reason: null,
  version,
  canvas: null,
});
const ct = (id: number, diffuse: number, refused = false): Tex => ({
  id,
  kind: "canvas",
  status: refused ? "unsupported" : "ok",
  reason: refused ? "canvas-texture-channel" : null,
  version: 2,
  canvas: { diffuse, filter: "default", repeat: "default" },
});

/** The fixture's shape: six ok canvas textures (one created before its diffuse), two refused;
 * at frame 10 canvas 9 gets diffuse 20 and diffuse 12 is updated. */
function recording(
  mutate?: (
    frame: number,
    textures: Tex[],
    items: { id: number; commands: { op: string; tex: number }[] }[],
  ) => void,
): ResolvedRecording {
  const frames = [1, 4, 10, 17];
  const transactions = frames.map((frame, i) => {
    const late = frame >= 10;
    const textures: Tex[] = [
      img(1),
      ct(2, 1),
      ct(3, 4),
      img(4),
      ct(5, 6),
      img(6),
      ct(7, 8),
      img(8),
      ct(9, late ? 20 : 10),
      img(10),
      ct(11, 12),
      img(12, late ? 2 : 1),
      ct(13, 14, true),
      img(14),
      img(15),
      ct(16, 17, true),
      img(17),
      img(18),
      img(19),
      ...(late ? [img(20)] : []),
    ];
    const items = [2, 3, 5, 7, 9, 11, 13, 16].map((t, k) => ({
      id: k + 2,
      commands: [{ op: "add_texture_rect", tex: t }],
    }));
    mutate?.(frame, textures, items);
    return {
      seq: i + 1,
      frame,
      encoding: "full",
      state: { textures, items, unsupported: [], failures: [] },
    };
  });
  return { transactions } as unknown as ResolvedRecording;
}

function image(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate8-ct", "expected.json"),
      "utf8",
    ),
  ) as G8cExpected;

  // 1. expected.json
  assert(
    expected.schema === "render-stream-gate8-ct-expected/1",
    "expected.json schema",
  );
  for (const r of [...expected.drawn, ...expected.refused])
    assert(Array.isArray(expected.regions[r]), `region ${r} declared`);
  assert(
    expected.drawn.length === expected.canvas_ok,
    "one drawn cell per ok canvas texture",
  );
  assert(
    expected.refused.length === expected.canvas_refused,
    "one refused cell per refused canvas texture",
  );

  // 2. premiseProblems
  const ok = premiseProblems(recording(), expected);
  assert(
    ok.problems.length === 0,
    `fixture shape passes (${ok.problems.join("; ")})`,
  );
  assert(
    ok.diffuses.length === 6 && ok.diffuses.includes(20),
    "diffuses at the last checkpoint include the swapped one",
  );
  const direct = premiseProblems(
    recording((f, _t, items) => {
      if (f === 4) items[0].commands.push({ op: "add_texture_rect", tex: 1 });
    }),
    expected,
  );
  assert(
    direct.problems.some((p) => p.includes("names diffuse 1 directly")),
    "a command naming a diffuse fails",
  );
  const noSwap = premiseProblems(
    recording((f, t) => {
      if (f >= 10) {
        const c = t.find((x) => x.id === 9);
        if (c?.canvas) c.canvas.diffuse = 10;
      }
    }),
    expected,
  );
  assert(
    noSwap.problems.some((p) => p.includes("new diffuse")),
    "no swap fails",
  );
  const okNormal = premiseProblems(
    recording((_f, t) => {
      const c = t.find((x) => x.id === 13);
      if (c) Object.assign(c, { status: "ok", reason: null });
    }),
    expected,
  );
  assert(
    okNormal.problems.some((p) => p.includes("ok canvas textures")),
    "a normal-mapped canvas texture typed ok fails",
  );

  // 3. regionProblems
  const clear = expected.clear_color;
  const patterned = image(64, 64, (x, y) => [
    10 + 40 * (x >> 4),
    60 + 45 * (y >> 4),
    120,
  ]);
  assert(
    regionProblems(patterned, [0, 0, 63, 63], "textured", clear).length === 0,
    "a patterned cell is textured",
  );
  const white = image(64, 64, () => [255, 255, 255]);
  assert(
    regionProblems(white, [0, 0, 63, 63], "textured", clear).length > 0,
    "a white cell is not textured",
  );
  const empty = image(64, 64, () => clear);
  assert(
    regionProblems(empty, [0, 0, 63, 63], "textured", clear).length > 0,
    "a clear cell is not textured",
  );
  assert(
    regionProblems(empty, [0, 0, 63, 63], "clear", clear).length === 0,
    "a clear cell is clear",
  );
  assert(
    regionProblems(patterned, [0, 0, 63, 63], "clear", clear).length > 0,
    "a drawn cell is not clear",
  );

  // 4. uploadProblems
  const uploads = [1, 4, 6, 8, 10, 12, 20].map((id) => ({ id, op: "create" }));
  assert(
    uploadProblems(uploads, ok.diffuses).length === 0,
    "every diffuse created passes",
  );
  assert(
    uploadProblems(
      uploads.filter((u) => u.id !== 20),
      ok.diffuses,
    ).length === 1,
    "a diffuse never uploaded fails",
  );
  assert(
    uploadProblems(undefined, ok.diffuses).length === 1,
    "no uploads[] fails",
  );

  console.log(
    `\nself-test-gate8-ct: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
