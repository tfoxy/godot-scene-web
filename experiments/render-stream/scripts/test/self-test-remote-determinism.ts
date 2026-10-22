#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for lib/remote-determinism.ts (docs/remote-compute.md R1): fabricated run directories
// prove that identical runs agree (volatile ids, paths and timestamps masked; a float spelled two
// ways is one value), and that each kind of disagreement is caught and reported: one changed pixel
// (count, bbox, channel delta), a missing shot, a changed dump value, a missing dump, and runs on
// different rasterizers.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-remote-determinism.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { compareRuns, mask } from "../lib/remote-determinism";

let failures = 0;
function expect(cond: boolean, what: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL  ${what}`);
  } else console.log(`ok    ${what}`);
}

const W = 16;
const H = 8;
async function png(poke?: {
  x: number;
  y: number;
  rgba: number[];
}): Promise<Buffer> {
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([40, 80, 120, 255], i * 4);
  if (poke) px.set(poke.rgba, (poke.y * W + poke.x) * 4);
  return sharp(px, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
}

interface RunSpec {
  session: string;
  root: string;
  poke?: { x: number; y: number; rgba: number[] };
  dropShot?: boolean;
  dropDump?: boolean;
  itemX?: number;
  gl?: string;
  float?: number;
  record?: string;
}

async function put(path: string, data: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function makeRun(dir: string, s: RunSpec) {
  await put(join(dir, "reference/shots/step-0.png"), await png());
  if (!s.dropShot)
    await put(join(dir, "receiver/shots/seq-8.png"), await png(s.poke));
  await put(
    join(dir, "reference/stdout.log"),
    `Godot Engine v4.5.1\n${s.gl ?? "OpenGL API 4.5 (Core Profile) Mesa 25.0.7 - Compatibility - Using Device: Mesa - llvmpipe (LLVM 19.1.1, 256 bits)"}\n`,
  );
  await put(
    join(dir, "gamescope/gamescope.json"),
    JSON.stringify({
      vulkanDevice: "llvmpipe (LLVM 19.1.1, 256 bits)",
      pid: Math.floor(Math.random() * 1e6),
    }),
  );
  if (!s.dropDump)
    await put(
      join(dir, "receiver/applied.json"),
      JSON.stringify({
        session_id: s.session,
        recording: {
          path: `${s.root}/receiver/recording.rs2`,
          sha256: s.session.repeat(2),
          bytes: 100 + s.session.length,
        },
        streams: [
          {
            stream_id: `${s.session}s`,
            received_bytes: Math.floor(Math.random() * 9),
            end_seen: true,
          },
        ],
        transactions: [
          {
            seq: 1,
            record_sha256: s.record ?? "ab12",
            received_us: Math.random() * 1e6,
            rs_calls: 30,
          },
        ],
        items: [{ x: s.itemX ?? 12, scale: s.float ?? 0.1 }],
      }),
    );
  await put(
    join(dir, "reference/steps.jsonl"),
    `{"step":0,"frame":11}\n{"step":1,"frame":21}\n`,
  );
}

const tmp = await mkdtemp(join(tmpdir(), "rs-determinism-"));
try {
  let n = 0;
  async function scenario(specs: Partial<RunSpec>[]) {
    const dirs: string[] = [];
    for (const [i, sp] of specs.entries()) {
      const d = join(tmp, `s${n}`, `r${i + 1}`);
      await makeRun(d, { session: `sess${i}`, root: `/runner/v${i}`, ...sp });
      dirs.push(d);
    }
    n++;
    return compareRuns(dirs);
  }

  // masking is structural
  const m = mask({
    session_id: "x",
    a: { path: "/p", fetch_us: 3, v: 1 },
  }) as Record<string, unknown>;
  expect(
    JSON.stringify(m) ===
      JSON.stringify({
        session_id: "<volatile>",
        a: { path: "<volatile>", fetch_us: "<volatile>", v: 1 },
      }),
    "mask replaces volatile keys at any depth and keeps the rest",
  );

  const same = await scenario([{}, { float: Math.fround(0.1) }, {}, {}]);
  expect(
    same.ok,
    "four identical runs agree (ids, paths, timestamps masked; 0.1 == fround(0.1))",
  );
  expect(
    same.shots.total === 2 && same.shots.agree === 2,
    "both shots counted and agreeing",
  );
  expect(
    same.dumps.total === 2 && same.dumps.agree === 2,
    "applied.json and steps.jsonl counted and agreeing",
  );
  expect(
    same.provenance_agree &&
      /llvmpipe/.test(same.provenance[0].gl_renderer ?? ""),
    "provenance read from stdout.log",
  );

  const pixel = await scenario([
    {},
    {},
    { poke: { x: 5, y: 3, rgba: [41, 80, 117, 255] } },
    {},
  ]);
  const row = pixel.shot_rows.find(
    (r) => r.path === "receiver/shots/seq-8.png",
  );
  expect(
    !pixel.ok && pixel.shots.disagree.length === 1,
    "one changed pixel in run 3 disagrees",
  );
  const d = row?.diff?.[0];
  expect(
    d?.mismatched_pixels === 1 &&
      JSON.stringify(d.bbox) === "[5,3,5,3]" &&
      d.max_channel_delta.join() === "1,0,3,0" &&
      d.delta_histogram["3"] === 1 &&
      d.first[0]?.x === 5,
    "pixel report: count 1, bbox, per-channel max delta 1/0/3/0, histogram, location",
  );

  const lost = await scenario([{}, { dropShot: true }]);
  expect(
    !lost.ok &&
      lost.shot_rows.find((r) => r.path.endsWith("seq-8.png"))?.sha256[1] ===
        null,
    "a missing shot disagrees",
  );

  const val = await scenario([{}, {}, { itemX: 13 }]);
  expect(
    !val.ok &&
      JSON.stringify(
        val.dump_rows.find((r) => r.path.endsWith("applied.json"))
          ?.differs_from_run1,
      ) === "[3]",
    "a changed non-volatile dump value disagrees and names run 3",
  );

  const rec = await scenario([{}, { record: "ab13" }]);
  expect(
    !rec.ok && rec.dumps.disagree.includes("receiver/applied.json"),
    "a changed per-transaction record digest disagrees",
  );

  const nodump = await scenario([{}, { dropDump: true }]);
  expect(
    !nodump.ok && nodump.dumps.disagree.includes("receiver/applied.json"),
    "a missing dump disagrees",
  );

  const raster = await scenario([
    {},
    {
      gl: "OpenGL API 3.3.0 NVIDIA 595.71.05 - Compatibility - Using Device: NVIDIA - NVIDIA GeForce RTX 2060",
    },
  ]);
  expect(
    !raster.ok && !raster.provenance_agree,
    "runs on different rasterizers are not a determinism sample",
  );

  const one = await scenario([{}]);
  expect(!one.ok, "a single run proves nothing");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`self-test-remote-determinism: ${failures} FAILED`);
  process.exit(1);
}
console.log("self-test-remote-determinism: all passed");
