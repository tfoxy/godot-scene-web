#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8hint checks (lib/gate8-hint-checks.ts): the recording reader on
// golden-15/hints.rs15; the file-leg predicates on a fabricated honest leg (all pass) and on one
// mutation per fault (an unknown hash, an early unhint, an edited texture's path, a missing unhint,
// a counter that disagrees, a hint shape that differs from its entry, a live GET missed while
// hinted), each failing its own predicate only where the sabotage legs need it; the edge diff on
// fabricated shots; and the group on an empty tree (every check fails, nothing throws).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-hint.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  edgeDiff,
  type FileLeg,
  type G8hintExpected,
  type HintsResult,
  type ProbeLine,
  predCounters,
  predMeta,
  predPath,
  predPrecedes,
  predServable,
  predUnhint,
  type RecordingFacts,
  readRecordingFacts,
  runG8hint,
} from "../lib/gate8-hint-checks";
import type { ResolvedTexture, ResourceHintMeta } from "../lib/render-stream-2";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = join(SCRIPT_DIR, "..", "..");

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const ex = JSON.parse(
  readFileSync(
    join(EXPERIMENT_DIR, "fixtures/hint-scene/expected.json"),
    "utf8",
  ),
) as G8hintExpected;

const hex = (n: number) => n.toString(16).padStart(64, "0");

interface Tex {
  name: string;
  hash: string;
  cause: "warm" | "create";
  path: string | null;
  size: [number, number];
}
function fixtureTextures(): Tex[] {
  const out: Tex[] = [];
  let n = 1;
  for (const name of [...ex.warm, ...ex.create]) {
    const want = ex.paths[name];
    const edge = ex.edges.find((e) => e.name === name);
    out.push({
      name,
      hash: hex(n++),
      cause: ex.warm.includes(name) ? "warm" : "create",
      path:
        want === undefined
          ? null
          : want.startsWith("prefix:")
            ? `${want.slice(7)}0123.s3tc.ctex`
            : want,
      size: edge ? edge.stored : ex.fixture_size,
    });
  }
  return out;
}

function hintMeta(t: Tex, priority: number): ResourceHintMeta {
  return {
    type: "resource_hint",
    hash: t.hash,
    kind: "texture",
    format: "RGBA8",
    source_format: null,
    width: t.size[0],
    height: t.size[1],
    mipmaps: false,
    payload_bytes: 112 + t.size[0] * t.size[1] * 4,
    variants: [],
    path: t.path,
    cause: t.cause,
    priority,
    blocks: [],
  };
}

function entryOf(h: ResourceHintMeta): ResolvedTexture {
  return {
    id: 1,
    origin: "created",
    kind: "image",
    status: "ok",
    reason: null,
    version: 1,
    hash: h.hash,
    format: h.format,
    source_format: h.source_format,
    width: h.width,
    height: h.height,
    mipmaps: h.mipmaps,
    payload_bytes: h.payload_bytes,
    variants: [],
    canvas: null,
  } as unknown as ResolvedTexture;
}

/** An honest leg: every fixture texture hinted (records 2..), the freed and changed ones unhinted at
 * step 2, the step-1 textures first drawn at frame 25 while hinted, every hash stored. */
function honestLeg(): FileLeg {
  const texs = fixtureTextures();
  const facts: RecordingFacts = {
    version: 15,
    errors: [],
    hints: [],
    unhints: [],
    first_draws: [],
    entries: new Map(),
    in_state: new Set(),
    transactions: 66,
  };
  texs.forEach((t, i) => {
    facts.hints.push({
      meta: hintMeta(t, i),
      record: 2 + i,
      unhinted_at: null,
    });
  });
  let record = 40;
  for (const name of [...ex.freed, ...ex.changed]) {
    const h = facts.hints.find(
      (x) => x.meta.hash === texs.find((t) => t.name === name)?.hash,
    );
    if (h) {
      h.unhinted_at = record;
      facts.unhints.push({ hash: h.meta.hash, record: record++ });
    }
  }
  for (const name of ex.step1_drawn) {
    const h = facts.hints.find(
      (x) => x.meta.hash === texs.find((t) => t.name === name)?.hash,
    );
    if (!h) continue;
    const entry = entryOf(h.meta);
    facts.entries.set(h.meta.hash, entry);
    facts.in_state.add(h.meta.hash);
    facts.first_draws.push({
      hash: h.meta.hash,
      seq: 16,
      frame: 25,
      record: 30,
      hinted_now: true,
      ever_hinted: true,
      entry,
    });
  }
  const result: HintsResult = {
    on: true,
    budget_bytes: 268435456,
    sabotage: "none",
    sources_create: ex.create.length,
    sources_warm: ex.warm.length,
    skipped_inline: 0,
    added: texs.length,
    removed_freed: ex.freed.length,
    removed_changed: ex.changed.length,
    budget_drops: 0,
    table_peak: texs.length,
    admitted_bytes_max: 1,
    pinned_max: 0,
    live_hints: 0,
    live_unhints: 0,
    file_hints: texs.length,
    file_unhints: facts.unhints.length,
    store_writes: texs.length,
    store_failures: 0,
    sibling_at_hint: 0,
  };
  return {
    dir: "/nonexistent",
    facts,
    patch_facts: facts,
    hints_log: [
      ...facts.hints.map((h) => ({
        frame: h.meta.cause === "warm" ? 10 : 15,
        sink: "file",
        op: "hint" as const,
        hash: h.meta.hash,
        cause: h.meta.cause,
        priority: h.meta.priority,
      })),
      ...facts.unhints.map((u) => ({
        frame: 40,
        sink: "file",
        op: "unhint" as const,
        hash: u.hash,
      })),
    ],
    result,
    store: new Map(texs.map((t) => [t.hash, t.hash])),
    store_first_frame: new Map(
      texs.map((t) => [t.hash, t.cause === "warm" ? 10 : 15]),
    ),
    steps: [
      { step: 0, applied_frame: 1, settle_frame: 12 },
      { step: 1, applied_frame: 25, settle_frame: 32 },
      { step: 2, applied_frame: 40, settle_frame: 47 },
      { step: 3, applied_frame: 55, settle_frame: 62 },
    ],
  };
}

function all(leg: FileLeg, sabotage = "none") {
  return {
    precedes: predPrecedes(leg, ex),
    servable: predServable(leg),
    meta: predMeta(leg),
    path: predPath(leg, ex),
    unhint: predUnhint(leg, ex),
    counters: predCounters(leg, ex, sabotage),
  };
}
const passing = (p: Record<string, string[]>) =>
  Object.entries(p)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}: ${v[0]}`);

// --- the reader on the golden vector --------------------------------------------------------------
{
  const facts = readRecordingFacts(
    new Uint8Array(
      readFileSync(join(EXPERIMENT_DIR, "protocol/golden-15/hints.rs15")),
    ),
  );
  expect(facts.version === 15, `golden hints.rs15 read as /${facts.version}`);
  expect(
    facts.errors.length === 0,
    `golden hints.rs15 errors: ${facts.errors[0]}`,
  );
  expect(facts.hints.length > 0, "golden hints.rs15: no hints read");
  expect(facts.unhints.length > 0, "golden hints.rs15: no unhint read");
  expect(
    facts.hints.some((h) => h.unhinted_at !== null),
    "golden hints.rs15: no hint matched to its unhint",
  );
  expect(
    [...facts.entries.values()].some((t) => t.size_override !== undefined),
    "golden hints.rs15: no entry with a size_override",
  );
}

// --- honest ---------------------------------------------------------------------------------------
{
  const p = passing(all(honestLeg()));
  expect(p.length === 0, `honest leg fails: ${p.join("; ")}`);
}

// --- hint-unknown-hash: fails servable only --------------------------------------------------------
{
  const leg = honestLeg();
  const first = leg.facts!.hints[0].meta;
  const fake: ResourceHintMeta = {
    ...first,
    hash: hex(0xdead),
    path: null,
    priority: 1,
  };
  leg.facts!.hints.splice(1, 0, { meta: fake, record: 3, unhinted_at: null });
  leg.facts!.hints.forEach((h, i) => {
    h.meta = { ...h.meta, priority: i };
  });
  leg.hints_log.splice(1, 0, {
    frame: 10,
    sink: "file",
    op: "hint",
    hash: fake.hash,
  });
  leg.result!.file_hints += 1;
  leg.result!.sabotage = "hint-unknown-hash";
  const p = all(leg, "hint-unknown-hash");
  expect(p.servable.length > 0, "unknown hash: servable passed");
  expect(
    passing(p).every((s) => s.startsWith("servable")),
    `unknown hash: other predicates failed: ${passing(p).join("; ")}`,
  );
}

// --- hint-early-unhint: fails precedes only ---------------------------------------------------------
{
  const leg = honestLeg();
  for (const d of leg.facts!.first_draws) d.hinted_now = false;
  const p = all(leg);
  expect(p.precedes.length > 0, "early unhint: precedes passed");
  expect(
    passing(p).every((s) => s.startsWith("precedes")),
    `early unhint: other predicates failed: ${passing(p).join("; ")}`,
  );
}

// --- a drawn texture never hinted ----------------------------------------------------------------------
{
  const leg = honestLeg();
  leg.facts!.first_draws[0].ever_hinted = false;
  leg.facts!.first_draws[0].hinted_now = false;
  expect(
    predPrecedes(leg, ex).some((s) => s.includes("never hinted")),
    "never hinted: not reported",
  );
}

// --- hint-edited-path: fails path only ---------------------------------------------------------------
{
  const leg = honestLeg();
  const p2 = leg.facts!.hints.find(
    (h) => h.meta.path === null && h.meta.cause === "warm",
  )!;
  p2.meta = { ...p2.meta, path: ex.edited_path };
  const p = all(leg);
  expect(p.path.length > 0, "edited path: path passed");
  expect(
    passing(p).every((s) => s.startsWith("path")),
    `edited path: other predicates failed: ${passing(p).join("; ")}`,
  );
}

// --- an engine texture's null-path hint is not the fixture's -------------------------------------------
{
  const leg = honestLeg();
  const engine: ResourceHintMeta = {
    ...leg.facts!.hints[0].meta,
    hash: hex(0xe0),
    width: 800,
    height: 6,
    path: null,
  };
  leg.facts!.hints.push({ meta: engine, record: 99, unhinted_at: null });
  leg.store.set(engine.hash, engine.hash);
  expect(
    predPath(leg, ex).length === 0,
    `engine texture: path failed: ${predPath(leg, ex)[0]}`,
  );
}

// --- a missing unhint, a counter, a hint shape, a store file ----------------------------------------------
{
  const leg = honestLeg();
  const freed = leg.facts!.hints.find(
    (h) => h.meta.path === ex.paths[ex.freed[0]],
  )!;
  freed.unhinted_at = null;
  expect(predUnhint(leg, ex).length > 0, "missing unhint: unhint passed");
}
{
  const leg = honestLeg();
  leg.result!.file_unhints += 1;
  expect(
    predCounters(leg, ex, "none").length > 0,
    "file_unhints off by one: counters passed",
  );
  const leg2 = honestLeg();
  leg2.result!.budget_drops = 1;
  expect(
    predCounters(leg2, ex, "none").length > 0,
    "budget drop: counters passed",
  );
}
{
  const leg = honestLeg();
  const e = leg.facts!.entries.values().next().value!;
  e.payload_bytes += 1;
  expect(predMeta(leg).length > 0, "hint shape: meta passed");
}
{
  const leg = honestLeg();
  const h = leg.facts!.hints[0].meta.hash;
  leg.store.set(h, hex(7));
  expect(
    predServable(leg).some((s) => s.includes("hashes to")),
    "corrupt store file: not reported",
  );
  const leg2 = honestLeg();
  leg2.store_first_frame.set(leg2.facts!.hints[0].meta.hash, 30);
  expect(
    predServable(leg2).some((s) => s.includes("after its hint")),
    "late store: not reported",
  );
}

// --- live GETs ----------------------------------------------------------------------------------------------
{
  const leg = honestLeg();
  const hashes = leg.facts!.hints.map((h) => h.meta.hash);
  const lines = hashes.map((hash) => ({
    frame: 10,
    sink: "live:1",
    op: "hint" as const,
    hash,
  }));
  const ok: ProbeLine[] = hashes.map((hash) => ({
    hash,
    status: 200,
    sha256: hash,
    unhinted_before: false,
  }));
  expect(
    predServable(leg, { lines, probe: ok }).length === 0,
    "live: honest GETs fail",
  );
  const miss = ok.map((l, i) =>
    i === 0 ? { ...l, status: 404, sha256: "" } : l,
  );
  expect(
    predServable(leg, { lines, probe: miss }).length > 0,
    "live: a 404 while hinted passed",
  );
  const late = miss.map((l, i) =>
    i === 0 ? { ...l, unhinted_before: true } : l,
  );
  expect(
    predServable(leg, { lines, probe: late }).length === 0,
    "live: a 404 after the unhint failed",
  );
  const wrong = ok.map((l, i) => (i === 0 ? { ...l, sha256: hex(9) } : l));
  expect(
    predServable(leg, { lines, probe: wrong }).length > 0,
    "live: wrong bytes passed",
  );
  expect(
    predServable(leg, null).length > 0,
    "live: missing live evidence passed",
  );
}

// --- edge diff and the empty tree ----------------------------------------------------------------------
const root = makeSelfTestTempDir(join(tmpdir(), "self-test-gate8-hint-"));
try {
  const png = async (path: string, mark: [number, number] | null) => {
    const w = 64;
    const h = 32;
    const data = Buffer.alloc(w * h * 4, 0);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    if (mark) data[(mark[1] * w + mark[0]) * 4] = 200;
    mkdirSync(dirname(path), { recursive: true });
    await sharp(data, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toFile(path);
  };
  await png(join(root, "ref/shots/step-1.png"), null);
  await png(join(root, "same/shots/seq-16.png"), null);
  writeFileSync(join(root, "same/shot-seqs.txt"), "11,16,31,46\n");
  await png(join(root, "inside/shots/seq-16.png"), [5, 5]);
  writeFileSync(join(root, "inside/shot-seqs.txt"), "11,16,31,46\n");
  await png(join(root, "outside/shots/seq-16.png"), [50, 20]);
  writeFileSync(join(root, "outside/shot-seqs.txt"), "11,16,31,46\n");
  const rect: [number, number, number, number][] = [[0, 0, 16, 16]];
  const same = await edgeDiff(join(root, "ref"), join(root, "same"), 1, rect);
  expect(
    same.present && same.differing === 0 && same.differing_frame === 0,
    "edge diff: identical shots differ",
  );
  const inside = await edgeDiff(
    join(root, "ref"),
    join(root, "inside"),
    1,
    rect,
  );
  expect(
    inside.differing === 1 && inside.max_delta === 200,
    "edge diff: a pixel inside the rect not counted",
  );
  const outside = await edgeDiff(
    join(root, "ref"),
    join(root, "outside"),
    1,
    rect,
  );
  expect(
    outside.differing === 0 && outside.differing_frame === 1,
    "edge diff: a pixel outside the rect miscounted",
  );
  const missing = await edgeDiff(
    join(root, "ref"),
    join(root, "nowhere"),
    1,
    rect,
  );
  expect(!missing.present, "edge diff: a missing shot is present");

  mkdirSync(join(root, "tree/g8hint"), { recursive: true });
  const { checks } = await runG8hint(join(root, "tree"), ex);
  expect(checks.length === 13, `empty tree: ${checks.length} checks, want 13`);
  expect(
    checks.every((c) => !c.passed),
    "empty tree: a check passed",
  );
} finally {
  removeSelfTestTempDir(root);
}

if (failures > 0) {
  console.error(
    `self-test-gate8-hint: ${failures} of ${assertions} assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `self-test-gate8-hint: ${assertions}/${assertions} assertions passed`,
  );
}
