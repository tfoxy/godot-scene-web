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
import { canonicalEqual } from "../lib/gate1-checks";
import { pckContentDigest } from "../lib/godot-pck";
import {
  BUILD_CONTENT_PREFIX,
  buildContentMap,
  canonicalForm,
  compareRuns,
  digestRun,
  mask,
  maskDump,
} from "../lib/remote-determinism";

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
  /** R3: a web receiver's build_sha256 (applied.json receiver block) */
  build?: string;
  /** R3: a source run this repeat made (absent when it hit the source cache) */
  sourcesMade?: { poke?: number; gl?: string };
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
        ...(s.build
          ? { receiver: { kind: "web-export", build_sha256: s.build } }
          : {}),
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
  if (s.sourcesMade) {
    const src = join(dir, "sources-made/gate1");
    await put(
      join(src, "receiver/shots/seq-3.png"),
      await png({ x: 1, y: 1, rgba: [s.sourcesMade.poke ?? 0, 0, 0, 255] }),
    );
    await put(
      join(src, "receiver/applied.json"),
      JSON.stringify({ items: [{ x: s.sourcesMade.poke ?? 0 }] }),
    );
    await put(
      join(src, "reference/stdout.log"),
      `${s.sourcesMade.gl ?? "OpenGL API 4.6 NVIDIA"}\n`,
    );
  }
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

  // Live legs: the wire seq a settle shot lands at follows the credit loop's timing, so the file
  // names differ per run; the content set (and the masked state set) must agree, and the leg's
  // applied.json (it has a `live` object) is not compared.
  async function liveScenario(
    runs: Array<{
      seqs: number[];
      pokeLast?: boolean;
      txs?: number;
      /** R3 animated leg: image k shows animation frame frames[k] and its state says so */
      frames?: number[];
      /** R3: the last image renders differently with the SAME state */
      pokeLastSameState?: boolean;
    }>,
  ) {
    const dirs: string[] = [];
    for (const [i, r] of runs.entries()) {
      const d = join(tmp, `live${n}`, `r${i + 1}`);
      await makeRun(d, { session: `s${i}`, root: `/runner/v${i}` });
      for (const [k, seq] of r.seqs.entries()) {
        const last = k === r.seqs.length - 1;
        const bad = (r.pokeLast || r.pokeLastSameState) && last;
        const frame = r.frames?.[k] ?? k;
        // image k is the same in every run (distinct per k), only its seq name moves
        const px = Buffer.alloc(W * H * 4);
        for (let q = 0; q < W * H; q++)
          px.set([frame * 20, bad ? 99 : 80, 120, 255], q * 4);
        await put(
          join(d, `live/receiver/shots/seq-${seq}.png`),
          await sharp(px, { raw: { width: W, height: H, channels: 4 } })
            .png()
            .toBuffer(),
        );
        await put(
          join(d, `live/receiver/state/seq-${seq}.json`),
          JSON.stringify({
            step: k,
            session_id: `s${i}`,
            ...(r.frames ? { frame } : {}),
          }),
        );
      }
      await put(
        join(d, "live/receiver/applied.json"),
        JSON.stringify({
          live: { acks: r.seqs.length },
          transactions: Array.from({ length: r.txs ?? 1 }, (_, t) => ({ t })),
        }),
      );
      dirs.push(d);
    }
    n++;
    return compareRuns(dirs);
  }
  const live = await liveScenario([
    { seqs: [10, 20, 30], txs: 3 },
    { seqs: [11, 19, 33], txs: 4 },
    { seqs: [12, 21, 30], txs: 2 },
  ]);
  expect(
    live.ok &&
      live.live_sets.length === 2 &&
      live.live_sets.every((x) => x.agree && x.distinct.join() === "3,3,3") &&
      live.live_timed.includes("live/receiver/applied.json"),
    "live legs: the same images at different wire seqs agree as a content set; the live applied.json is listed, not compared",
  );
  const liveBad = await liveScenario([
    { seqs: [10, 20, 30] },
    { seqs: [11, 19, 33], pokeLast: true },
  ]);
  expect(
    !liveBad.ok && liveBad.live_sets.some((x) => !x.agree),
    "live legs: a different image in one run disagrees",
  );
  const liveFewer = await liveScenario([
    { seqs: [10, 20, 30] },
    { seqs: [11, 19] },
  ]);
  expect(!liveFewer.ok, "live legs: a missing image disagrees");
  // R3: an animated live leg catches a different animation frame per settle per run: the images and
  // the states differ together. Compared as state -> image: a state applied in two runs renders the
  // same.
  const animated = await liveScenario([
    { seqs: [10, 20, 30], frames: [0, 4, 9] },
    { seqs: [11, 21, 31], frames: [0, 5, 9] },
    { seqs: [12, 19, 30], frames: [1, 4, 8] },
  ]);
  const anim = animated.live_sets.find((x) => x.kind === "state-image");
  expect(
    animated.ok &&
      anim?.agree === true &&
      anim.shared_states === 3 &&
      !animated.live_sets.some((x) => x.kind === "states"),
    "animated live legs: different frames per run with their states agree as a state -> image function",
  );
  const animBad = await liveScenario([
    { seqs: [10, 20, 30], frames: [0, 4, 9] },
    { seqs: [11, 21, 31], frames: [0, 5, 9], pokeLastSameState: true },
  ]);
  expect(
    !animBad.ok &&
      animBad.live_sets.some(
        (x) =>
          x.kind === "state-image" &&
          !x.agree &&
          (x.inconsistent?.length ?? 0) === 1,
      ),
    "animated live legs: one state rendering two ways disagrees (render nondeterminism)",
  );
  const animDisjoint = await liveScenario([
    { seqs: [10, 20, 30], frames: [0, 4, 9] },
    { seqs: [11, 21, 31], frames: [1, 5, 8] },
  ]);
  expect(
    animDisjoint.ok &&
      animDisjoint.live_sets.length === 0 &&
      animDisjoint.live_timed.includes("live/receiver/shots/"),
    "animated live legs: no state applied in two runs is listed live-timed, not called agreeing",
  );
  const animFewer = await liveScenario([
    { seqs: [10, 20, 30], frames: [0, 4, 9] },
    { seqs: [11, 21], frames: [0, 4] },
  ]);
  expect(
    !animFewer.ok,
    "animated live legs: a run with fewer distinct images still disagrees",
  );
  const embedded = mask({ failure: { detail: "/x/_temp/v2/native/run/a" } });
  expect(
    JSON.stringify(embedded) ===
      JSON.stringify({ failure: { detail: "/x/_temp/v/native/run/a" } }),
    "an evidence path embedded in a string is normalised across the repeat dirs",
  );

  const one = await scenario([{}]);
  expect(!one.ok, "a single run proves nothing");

  // R3: digests. canonicalForm is gate1-checks' canonical (canonicalEqual compares its JSON).
  const samples: Array<[unknown, unknown]> = [
    [
      { b: 1, a: [0.1, 2] },
      { a: [0.1, 2], b: 1 },
    ],
    [{ x: 0.30000001192092896 }, { x: 0.3 }],
    [{ x: 0.3 }, { x: 0.31 }],
    [
      [1, "a", null],
      [1, "a", null],
    ],
    [{ a: { c: 1, b: 2 } }, { a: { b: 2, c: 2 } }],
  ];
  expect(
    samples.every(
      ([a, b]) =>
        canonicalEqual(a, b) ===
        (JSON.stringify(canonicalForm(a)) === JSON.stringify(canonicalForm(b))),
    ),
    "digests: canonicalForm decides exactly what canonicalEqual decides",
  );
  async function digested(specs: Partial<RunSpec>[], builds = {}) {
    const files: string[] = [];
    for (const [i, sp] of specs.entries()) {
      const d = join(tmp, `s${n}`, `r${i + 1}`);
      await makeRun(d, { session: `sess${i}`, root: `/runner/v${i}`, ...sp });
      const f = join(tmp, `s${n}`, `r${i + 1}.digest.json`);
      await writeFile(f, JSON.stringify(await digestRun(d, builds)));
      files.push(f);
    }
    n++;
    return compareRuns(files);
  }
  const dg = await digested([{}, { float: Math.fround(0.1) }, {}]);
  expect(
    dg.ok && dg.shots.total === 2 && dg.dumps.total > 0,
    "digests: identical runs agree from their digests alone",
  );
  const dgPoke = await digested([
    {},
    { poke: { x: 3, y: 2, rgba: [41, 80, 120, 255] } },
  ]);
  expect(
    !dgPoke.ok &&
      dgPoke.shots.disagree.includes("receiver/shots/seq-8.png") &&
      dgPoke.shot_rows.every((r) => r.diff === undefined),
    "digests: a changed pixel disagrees (no pixel report without the images)",
  );
  const dgDump = await digested([{}, { itemX: 13 }]);
  expect(
    !dgDump.ok && dgDump.dumps.disagree.length > 0,
    "digests: a changed dump value disagrees",
  );
  const dgRow = dgDump.dump_rows.find(
    (r) => r.path === "receiver/applied.json",
  );
  expect(
    dgRow?.fields_differing === 1 &&
      dgRow.fields?.[0]?.path === "items[0].x" &&
      JSON.stringify(dgRow.fields[0].values) === JSON.stringify(["12", "13"]),
    "digests: a disagreeing applied.json names the differing field and each run's value",
  );
  // R3: sources-made/ is an input (a source-cache miss makes it, a hit does not): never compared,
  // never a provenance source, whatever it holds
  const srcOnce = await scenario([
    { sourcesMade: { poke: 9, gl: "OpenGL API 4.6 NVIDIA 580" } },
    {},
    { sourcesMade: { poke: 200 } },
  ]);
  expect(
    srcOnce.ok &&
      srcOnce.provenance_agree &&
      [...srcOnce.shot_rows, ...srcOnce.dump_rows].every(
        (r) => !r.path.startsWith("sources-made/"),
      ),
    "sources-made/ present in some repeats only (and differing) is excluded: the runs agree",
  );
  const dgSrc = await digested([{ sourcesMade: { poke: 9 } }, {}]);
  expect(
    dgSrc.ok && dgSrc.shots.total === 2,
    "digests: sources-made/ is not digested",
  );
  const dgSrcOut = await digested([
    { sourcesMade: { poke: 9 } },
    { itemX: 14 },
  ]);
  expect(
    !dgSrcOut.ok && dgSrcOut.dumps.disagree.includes("receiver/applied.json"),
    "digests: excluding sources-made/ still compares the run's own outputs",
  );
  const dgGl = await digested([{}, { gl: "OpenGL API 4.6 NVIDIA 580" }]);
  expect(
    !dgGl.ok && !dgGl.provenance_agree,
    "digests: a different rasterizer disagrees",
  );
  const dgMiss = await digested([{}, { dropShot: true }]);
  expect(!dgMiss.ok, "digests: a missing shot disagrees");

  // R3: a web-export receiver's process_frame is load timing; a native receiver's stays compared
  const webA = {
    receiver: { kind: "web-export" },
    transactions: [{ seq: 1, process_frame: 9 }],
  };
  const webB = {
    receiver: { kind: "web-export" },
    transactions: [{ seq: 1, process_frame: 10 }],
  };
  const natB = {
    receiver: { kind: "native" },
    transactions: [{ seq: 1, process_frame: 10 }],
  };
  const natA = {
    receiver: { kind: "native" },
    transactions: [{ seq: 1, process_frame: 9 }],
  };
  expect(
    canonicalEqual(maskDump(webA), maskDump(webB)) &&
      !canonicalEqual(maskDump(natA), maskDump(natB)) &&
      !canonicalEqual(
        maskDump(webA),
        maskDump({ ...webB, transactions: [{ seq: 2, process_frame: 10 }] }),
      ),
    "maskDump: a web-export receiver's process_frame is masked, a native one's and every other field compared",
  );

  // R3: a web pck's build_sha256 is compared by CONTENT (Godot 4.5.1's export order varies across
  // machines; the entries do not). Records with the same entries in another data order agree.
  const entries = [
    { path: "res://rs_wire.gdc", size: 900, md5: "aa" },
    { path: "res://rs_rust_applier.gdc", size: 700, md5: "bb" },
    { path: "res://ext/rs_core.gdextension", size: 300, md5: "cc" },
  ];
  const record = (sha256: string, files: typeof entries, content?: string) => ({
    schema: "render-stream-web-build/1",
    pck: { sha256, ...(content ? { content_sha256: content } : {}), files },
  });
  const reordered = [entries[2], entries[0], entries[1]];
  expect(
    pckContentDigest(entries) === pckContentDigest(reordered) &&
      pckContentDigest(entries) !==
        pckContentDigest([
          { ...entries[0], md5: "ab" },
          entries[1],
          entries[2],
        ]) &&
      pckContentDigest(entries) !==
        pckContentDigest([
          { ...entries[0], size: 901 },
          entries[1],
          entries[2],
        ]) &&
      pckContentDigest(entries) !== pckContentDigest(entries.slice(1)),
    "pckContentDigest: entry order does not matter; a changed md5, size or a missing entry does",
  );
  const sameContent = buildContentMap([
    record("pck-raw-a", entries, pckContentDigest(entries)),
    record("pck-raw-b", reordered), // a record from before content_sha256: recomputed
  ]);
  const drift = await digested(
    [{ build: "pck-raw-a" }, { build: "pck-raw-b" }],
    sameContent,
  );
  expect(
    drift.ok &&
      drift.build_identity?.raw_drift === true &&
      drift.build_identity.content_agree &&
      JSON.stringify(drift.build_identity.raw) ===
        JSON.stringify([["pck-raw-a"], ["pck-raw-b"]]),
    "build identity: two raw pck digests with one content agree; the raw drift is reported as info",
  );
  const unmapped = await digested([
    { build: "pck-raw-a" },
    { build: "pck-raw-b" },
  ]);
  expect(
    !unmapped.ok &&
      unmapped.dump_rows.find((r) => r.path === "receiver/applied.json")
        ?.fields?.[0]?.path === "receiver.build_sha256",
    "build identity: without build records build_sha256 is compared raw (never masked)",
  );
  const otherContent = buildContentMap([
    record("pck-raw-a", entries),
    record("pck-raw-c", [{ ...entries[0], md5: "ff" }, entries[1], entries[2]]),
  ]);
  const real = await digested(
    [{ build: "pck-raw-a" }, { build: "pck-raw-c" }],
    otherContent,
  );
  const realRow = real.dump_rows.find(
    (r) => r.path === "receiver/applied.json",
  );
  expect(
    !real.ok &&
      real.build_identity?.content_agree === false &&
      realRow?.fields?.[0]?.path === "receiver.build_sha256" &&
      realRow.fields[0].values.every((v) =>
        v.startsWith(`"${BUILD_CONTENT_PREFIX}`),
      ),
    "build identity: two builds whose pck contents differ disagree, named by content digest",
  );
  let threw = false;
  try {
    buildContentMap([record("pck-raw-a", entries, "0".repeat(64))]);
  } catch {
    threw = true;
  }
  expect(
    threw,
    "build identity: a record whose content_sha256 is not its entry list's is refused",
  );

  // R3: a stall leg's shot set follows when credit resumes: listed live-timed, not compared
  const stallDirs: string[] = [];
  for (const [i, seqs] of [
    [10, 20],
    [11, 23],
  ].entries()) {
    const d = join(tmp, `stall${i}`);
    await makeRun(d, { session: `s${i}`, root: `/runner/v${i}` });
    for (const [k, seq] of seqs.entries()) {
      const px = Buffer.alloc(W * H * 4);
      for (let q = 0; q < W * H; q++)
        px.set([k * 20 + i * 7, 80, 120, 255], q * 4);
      await put(
        join(d, `mesh/live-mesh-stall/receiver/shots/seq-${seq}.png`),
        await sharp(px, { raw: { width: W, height: H, channels: 4 } })
          .png()
          .toBuffer(),
      );
    }
    stallDirs.push(d);
  }
  const stall = await compareRuns(stallDirs);
  expect(
    stall.ok &&
      stall.live_sets.length === 0 &&
      stall.live_timed.includes("mesh/live-mesh-stall/receiver/shots/"),
    "live legs: a stall leg's differing shot set is listed live-timed, not compared",
  );

  // GRT6: a replay whose recording follows wall-clock timing on the capturing machine (pending
  // worker jobs, the live host's lazy variants) is listed live-timed, not compared; the same
  // difference in a leg that replays a deterministic capture still disagrees.
  for (const [leg, timed] of [
    ["g8ku/pending", true],
    ["g8ku-web/web-pending", true],
    ["g8l/basis/replay", true],
    ["g8ku/receiver", false],
  ] as const) {
    const dirs: string[] = [];
    for (const i of [0, 1]) {
      const d = join(tmp, `timed-${leg.replace(/\W/g, "_")}${i}`);
      await makeRun(d, { session: `t${i}`, root: `/runner/v${i}` }); // the plain root files agree
      await makeRun(join(d, leg), {
        session: `t${i}`,
        root: `/runner/v${i}`,
        record: `r${i}`,
        poke: i ? { x: 3, y: 3, rgba: [250, 0, 0, 255] } : undefined,
      });
      dirs.push(d);
    }
    const r = await compareRuns(dirs);
    const timedShots = leg !== "g8l/basis/replay";
    expect(
      timed
        ? r.live_timed.includes(`${leg}/receiver/applied.json`) &&
            r.live_timed.includes(`${leg}/receiver/shots/seq-8.png`) ===
              timedShots &&
            // the replay's own shot stays compared outside the pending legs
            (timedShots || !r.ok)
        : !r.ok && r.live_timed.length === 0,
      `GRT6: ${leg} ${timed ? "applied.json is live-timed" + (timedShots ? " with its shots" : ", its shots still compared") : "still disagrees on a deterministic replay"}`,
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`self-test-remote-determinism: ${failures} FAILED`);
  process.exit(1);
}
console.log("self-test-remote-determinism: all passed");
