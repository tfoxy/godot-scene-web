#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5c: the g5c checks of lib/gate5c-checks.ts on the committed
// fixtures/gate5-mesh/expected.json and on synthetic hook logs, oracle logs, counters and
// recordings, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate5c.ts
//
// 1. checkMeshExpectedSelfConsistent on the committed expected.json and on broken copies.
// 2. The census: expandCensus's per-frame shape, and evaluateMeshCensus on a hook log synthesized
//    from the census itself (passes) and on logs with a line missing, a version off, an extra
//    mesh, or a line off the main thread (each fails).
// 3. replayHookHashes on a hand sequence (add, update, remove, clear, free, create_from_surfaces).
// 4. evaluateOracleAgrees and evaluateHashParity on oracle lines made from expected.json and hook
//    lines carrying its model hashes, then with one field, one hash, the RID check or one leg off.
// 5. evaluateDrawCensus and evaluateMeshCaptureTyped on synthetic counters and recordings.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingSummary } from "../lib/gate0-checks";
import type { ResourceLine } from "../lib/gate2-checks";
import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import {
  type CensusLine,
  checkMeshExpectedSelfConsistent,
  evaluateDrawCensus,
  evaluateHashParity,
  evaluateMeshCaptureTyped,
  evaluateMeshCensus,
  evaluateOracleAgrees,
  expandCensus,
  type Gate5MeshExpected,
  meshRasters,
  type OracleLine,
  type OracleLog,
  replayHookHashes,
} from "../lib/gate5c-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const passes = (name: string, problems: string[]) =>
  assert(
    `${name} passes`,
    problems.length === 0,
    problems.slice(0, 3).join(" | "),
  );
const fails = (name: string, problems: string[], needle?: string) =>
  assert(
    `${name} fails`,
    problems.length > 0 &&
      (!needle || problems.some((p) => p.includes(needle))),
    problems.length === 0
      ? "no problem reported"
      : problems.slice(0, 2).join(" | "),
  );

/** A resources.jsonl mesh line with only the fields the g5c checks read. */
function meshLine(
  frame: number,
  id: number,
  op: string,
  version: number,
  extra: Partial<ResourceLine> = {},
): ResourceLine {
  return {
    frame,
    thread: "main",
    op,
    id,
    version,
    kind: "mesh",
    status: op === "free" ? "freed" : "ok",
    outcome: op === "free" ? null : "applied",
    surface: null,
    buffer: null,
    hash: null,
    copy_ns: null,
    hash_ns: null,
    ...extra,
  } as unknown as ResourceLine;
}

// ---------------------------------------------------------------------------------------------
// 1. expected-self-consistent
// ---------------------------------------------------------------------------------------------

function selfConsistentCases(expected: Gate5MeshExpected): void {
  const rasters = meshRasters(expected);
  passes(
    "mesh-expected-self-consistent (committed)",
    problemsOf(checkMeshExpectedSelfConsistent(expected, rasters)),
  );
  const fresh = clone(expected);
  fresh.steps[2].fresh.RM = false;
  fails(
    "mesh-expected-self-consistent (RM not fresh at 2)",
    problemsOf(checkMeshExpectedSelfConsistent(fresh, rasters)),
    "RM fresh=false",
  );
  const count = clone(expected);
  count.steps[0].meshes[2].surface_count = 1;
  fails(
    "mesh-expected-self-consistent (M2 surface count)",
    problemsOf(checkMeshExpectedSelfConsistent(count, rasters)),
    "surface_count",
  );
  const version = clone(expected);
  version.census.frames["11"][0][2] = 4;
  fails(
    "mesh-expected-self-consistent (a census version skips)",
    problemsOf(checkMeshExpectedSelfConsistent(version, rasters)),
    "AM1 mesh_surface_update_vertex_region v4",
  );
}

function problemsOf(c: { passed: boolean; detail: string }): string[] {
  return c.passed ? [] : [c.detail];
}

// ---------------------------------------------------------------------------------------------
// 2. The census
// ---------------------------------------------------------------------------------------------

/** A hook log that is the census itself, ids by mesh_order. */
function logFromCensus(
  expected: Gate5MeshExpected,
  quit: number,
): ResourceLine[] {
  const out: ResourceLine[] = [];
  const id = (name: string) => expected.mesh_order.indexOf(name) + 1;
  for (const [f, lines] of [...expandCensus(expected, quit)].sort(
    (a, b) => a[0] - b[0],
  ))
    for (const [name, op, version, surface, buffer] of lines)
      out.push(
        meshLine(f, id(name), op, version, {
          surface,
          buffer: buffer as ResourceLine["buffer"],
        }),
      );
  return out;
}

function censusCases(expected: Gate5MeshExpected): void {
  const full = expandCensus(expected, 400);
  const dfFrames = [...full.entries()].filter(([f]) => f >= 2);
  assert(
    "expandCensus: three DF lines on every frame 2..400 (the rebuild frame's free, create, add)",
    dfFrames.length === 399 &&
      dfFrames.every(
        ([, l]) =>
          l.filter((x) => x[0] === "DF" || x[0] === "DF2").length === 3,
      ),
  );
  const last: CensusLine | undefined = full.get(400)?.at(-1);
  assert(
    "expandCensus: DF2's version at frame 400 is 2 + 3 * 349",
    last?.[0] === "DF2" && last[2] === 2 + 3 * 349,
    JSON.stringify(last),
  );
  assert(
    "expandCensus: bounded at the quit frame",
    Math.max(...expandCensus(expected, 102).keys()) === 102,
  );
  const good = logFromCensus(expected, 400);
  passes(
    "mesh-census (the census as a log)",
    evaluateMeshCensus(expected, good, 400).problems,
  );
  const teardown = [...good, meshLine(401, 2, "free", 5)];
  const r = evaluateMeshCensus(expected, teardown, 400);
  passes("mesh-census (a teardown free after quit)", r.problems);
  assert("mesh-census reports the teardown line", r.after_quit === 1);
  const missing = good.filter((l) => !(l.frame === 41));
  fails(
    "mesh-census (step 4's index update missing)",
    evaluateMeshCensus(expected, missing, 400).problems,
    "frame 41",
  );
  const off = clone(good);
  const k = off.findIndex((l) => l.frame === 61);
  off[k].version = 9;
  fails(
    "mesh-census (M2's remove at the wrong version)",
    evaluateMeshCensus(expected, off, 400).problems,
    "frame 61",
  );
  const extra = [...good, meshLine(90, 9, "mesh_create", 1)];
  fails(
    "mesh-census (an extra mesh)",
    evaluateMeshCensus(expected, extra, 400).problems,
    "9 meshes created",
  );
  const thread = clone(good);
  thread[3].thread = "other";
  fails(
    "mesh-census (a line off the main thread)",
    evaluateMeshCensus(expected, thread, 400).problems,
    "main thread",
  );
  const rejected = clone(good);
  const r2 = rejected.findIndex((l) => l.frame === 21);
  rejected[r2].outcome = "rejected";
  fails(
    "mesh-census (a rejected update)",
    evaluateMeshCensus(expected, rejected, 400).problems,
    "outcome rejected",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Hook hash replay
// ---------------------------------------------------------------------------------------------

function replayCases(): void {
  const lines = [
    meshLine(1, 1, "mesh_create", 1),
    meshLine(1, 1, "mesh_add_surface", 2, { surface: 0, hash: "a" }),
    meshLine(1, 1, "mesh_add_surface", 3, { surface: 1, hash: "b" }),
    meshLine(1, 2, "mesh_create_from_surfaces", 1, { surface: 0, hash: "x" }),
    meshLine(2, 1, "mesh_surface_update_vertex_region", 4, {
      surface: 1,
      hash: "c",
      buffer: "vertex",
    }),
    meshLine(3, 1, "mesh_surface_remove", 5, { surface: 0 }),
    meshLine(4, 1, "mesh_clear", 6),
    meshLine(4, 1, "mesh_add_surface", 7, { surface: 0, hash: "d" }),
    meshLine(5, 2, "free", 1),
  ];
  const at = replayHookHashes(lines, ["A", "B"], [1, 2, 3, 4, 5]);
  const show = (f: number) =>
    JSON.stringify(Object.fromEntries(at.get(f) ?? []));
  assert(
    "replay frame 1: two adds and a single-surface create",
    show(1) === '{"A":["a","b"],"B":["x"]}',
    show(1),
  );
  assert(
    "replay frame 2: a region update replaces its surface",
    show(2) === '{"A":["a","c"],"B":["x"]}',
    show(2),
  );
  assert(
    "replay frame 3: a remove renumbers",
    show(3) === '{"A":["c"],"B":["x"]}',
    show(3),
  );
  assert(
    "replay frame 4: a clear then an add",
    show(4) === '{"A":["d"],"B":["x"]}',
    show(4),
  );
  assert(
    "replay frame 5: a free leaves null",
    show(5) === '{"A":["d"],"B":null}',
    show(5),
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Oracle and parity
// ---------------------------------------------------------------------------------------------

function oracleOf(expected: Gate5MeshExpected, leg: string): OracleLog {
  const lines: OracleLine[] = expected.steps.map((s) => ({
    schema: "render-stream-gate5-meshes/1",
    step: s.step,
    frame: s.settle_frame,
    p2_rid_verified: true,
    meshes: clone(s.meshes),
  }));
  return {
    leg,
    path: leg,
    text: lines.map((l) => JSON.stringify(l)).join("\n"),
    lines,
    problem: null,
  };
}

/** A hook log whose hashes are the model's: at each settle frame every live surface is re-stated
 * by region updates carrying the expected hash (versions are irrelevant to parity). */
function hashedLog(expected: Gate5MeshExpected): ResourceLine[] {
  const out: ResourceLine[] = [];
  const id = (name: string) => expected.mesh_order.indexOf(name) + 1;
  const created = new Set<string>();
  for (const s of expected.steps)
    for (const m of s.meshes) {
      const f = s.settle_frame;
      if (m.status === "absent") continue;
      if (!created.has(m.name)) {
        created.add(m.name);
        out.push(meshLine(f, id(m.name), "mesh_create", 1));
      }
      if (m.status === "freed") {
        if (!out.some((l) => l.op === "free" && l.id === id(m.name)))
          out.push(meshLine(f, id(m.name), "free", 1));
        continue;
      }
      out.push(meshLine(f, id(m.name), "mesh_clear", 1));
      for (const [k, x] of (m.surfaces ?? []).entries())
        out.push(
          meshLine(f, id(m.name), "mesh_add_surface", 1, {
            surface: k,
            hash: x.sha256,
          }),
        );
    }
  return out.sort((a, b) => a.frame - b.frame);
}

function oracleCases(expected: Gate5MeshExpected): void {
  const a = oracleOf(expected, "reference");
  const b = oracleOf(expected, "reference-repeat");
  passes("oracle-agrees", evaluateOracleAgrees(expected, [a, b]).problems);
  const count = clone(a);
  count.lines[6].meshes[2].surface_count = 2;
  fails(
    "oracle-agrees (M2 still two surfaces at 6)",
    evaluateOracleAgrees(expected, [count]).problems,
    "step 6 M2",
  );
  const aabb = clone(a);
  aabb.lines[3].meshes[3].custom_aabb = [0, -2, 0, 128, 67, 0];
  fails(
    "oracle-agrees (DF's custom AABB off)",
    evaluateOracleAgrees(expected, [aabb]).problems,
    "custom AABB",
  );
  const rid = clone(a);
  rid.lines[0].p2_rid_verified = false;
  fails(
    "oracle-agrees (Polygon2D RID not verified)",
    evaluateOracleAgrees(expected, [rid]).problems,
    "Polygon2D",
  );
  const differ = clone(b);
  differ.text = `${differ.text} `;
  fails(
    "oracle-agrees (the two legs differ)",
    evaluateOracleAgrees(expected, [a, differ]).problems,
    "differ",
  );
  const status = clone(a);
  status.lines[7].meshes[6].status = "live";
  fails(
    "oracle-agrees (FM not freed at 7)",
    evaluateOracleAgrees(expected, [status]).problems,
    "step 7 FM",
  );

  const hosts = [{ leg: "capture", lines: hashedLog(expected) }];
  passes(
    "mesh-hook-hash-parity",
    evaluateHashParity(expected, a, hosts).problems,
  );
  const oracleHash = clone(a);
  oracleHash.lines[4].meshes[1].surfaces![0].sha256 = "0".repeat(64);
  fails(
    "mesh-hook-hash-parity (an oracle hash off)",
    evaluateHashParity(expected, oracleHash, hosts).problems,
    "step 4 RMS: oracle",
  );
  const hook = clone(hosts[0].lines);
  const last = hook.filter((l) => l.id === 2 && l.frame <= 48).at(-1);
  if (last) last.hash = "f".repeat(64);
  fails(
    "mesh-hook-hash-parity (a hook hash off)",
    evaluateHashParity(expected, a, [{ leg: "capture", lines: hook }]).problems,
    "step 4 RMS: capture hook",
  );
  const notFreed = hosts[0].lines.filter(
    (l) => !(l.op === "free" && l.id === 7),
  );
  fails(
    "mesh-hook-hash-parity (FM never freed in the log)",
    evaluateHashParity(expected, a, [{ leg: "capture", lines: notFreed }])
      .problems,
    "FM",
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Counters and the capture
// ---------------------------------------------------------------------------------------------

function syntheticCapture(
  expected: Gate5MeshExpected,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const transactions = expected.steps.map((s, k) => {
    const items = expected.creation_order.map((name, j) => ({
      id: j + 2,
      content_version: name === "DF" ? s.settle_frame : 2,
      commands: s.commands[name].map((c) =>
        c.op === "canvas_item_add_rect"
          ? {
              op: "add_rect",
              rect: (c.rect as number[]).map(Math.fround),
              color: (c.color as number[]).map(Math.fround),
              aa: c.antialiased,
            }
          : { op: "unsupported", name: c.op },
      ),
    }));
    return {
      meta: {
        seq: k + 1,
        frame: s.settle_frame,
        items,
        unsupported: [
          { op: "canvas_item_add_mesh", item: 2, reason: "unsupported-op" },
        ],
      },
      sha256: "",
    };
  });
  return {
    result_class: "unsupported",
    reasons: [],
    full: {
      path: "synthetic",
      present: true,
      sha256: null,
      bytes: 0,
      errors: [],
      transactions,
    } as unknown as RecordingSummary,
  };
}

function captureCases(expected: Gate5MeshExpected): void {
  passes(
    "mesh-draw-census",
    evaluateDrawCensus(expected, {
      ...expected.draw_census.counts,
      canvas_item_add_circle: 0,
    }).problems,
  );
  fails(
    "mesh-draw-census (DF short by one frame)",
    evaluateDrawCensus(expected, {
      ...expected.draw_census.counts,
      canvas_item_add_mesh: 408,
    }).problems,
    "canvas_item_add_mesh",
  );
  fails(
    "mesh-draw-census (an unexpected op)",
    evaluateDrawCensus(expected, {
      ...expected.draw_census.counts,
      canvas_item_add_polygon: 1,
    }).problems,
    "canvas_item_add_polygon",
  );
  const good = syntheticCapture(expected);
  passes(
    "leg-class-capture-mesh",
    evaluateMeshCaptureTyped(expected, good).problems,
  );
  fails(
    "leg-class-capture-mesh (class success)",
    evaluateMeshCaptureTyped(expected, { ...good, result_class: "success" })
      .problems,
    "class success",
  );
  const fr = clone(good);
  fr.full.transactions[8].meta.items[
    expected.creation_order.indexOf("FR")
  ].commands.push({ op: "unsupported", name: "canvas_item_add_mesh" } as never);
  fails(
    "leg-class-capture-mesh (FR not cleared at 8)",
    evaluateMeshCaptureTyped(expected, fr).problems,
    "step 8 FR",
  );
  const rm = clone(good);
  rm.full.transactions[3].meta.items[
    expected.creation_order.indexOf("RM")
  ].content_version = 3;
  fails(
    "leg-class-capture-mesh (RM redrawn)",
    evaluateMeshCaptureTyped(expected, rm).problems,
    "RM's content_version",
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate5-mesh", "expected.json"),
      "utf8",
    ),
  ) as Gate5MeshExpected;
  selfConsistentCases(expected);
  censusCases(expected);
  replayCases();
  oracleCases(expected);
  captureCases(expected);
  console.log(
    `\nself-test-gate5c: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
