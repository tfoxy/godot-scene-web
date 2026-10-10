#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5e: the g5e evaluators of lib/gate5e-checks.ts (and clip-derive's add_mesh
// rect, G5e) on the committed fixtures/gate5-mesh/expected.json and on synthetic hook logs,
// recordings and applied.json values, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate5e.ts
//
// 1. replayMeshLog / meshLogDivergence (D15) and classifyMeshLeg: a log and a wire that agree; a
//    version off, a live mesh missing, a hash off (only with hashes), an omitted line ignored.
// 2. evaluateWireHashParity, evaluateWireMeshCensus and evaluateWireFreshWithoutRedraw on a wire
//    synthesized from expected.json (steps[].meshes, predictions[mesh-lifetimes], the census), then
//    with one hash, a tombstone, a removed id or RM's content_version off.
// 3. evaluateReceiverMeshUploads and evaluateMeshResourceQuiet on an applied.json synthesized from
//    predictions[receiver-mesh-uploads], then with a row dropped, a buffer added, a fetch repeated
//    or off its census frame.
// 4. evaluateSabotageLogSignature (perturb-vertex) on a synthetic log and wire.
// 5. clip-derive's meshRects / itemRect for add_mesh: a custom AABB wins, the merge of surface
//    AABBs, a tombstone is a zero rect, an unknown id or a missing surface AABB is unknown, and the
//    draw transform applies (the command's own transform does not).
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { itemRect, meshRects } from "../lib/clip-derive";
import type { RecordingSummary } from "../lib/gate0-checks";
import type { ResourceLine } from "../lib/gate2-checks";
import type { Gate5MeshExpected } from "../lib/gate5c-checks";
import {
  type AppliedJson5e,
  classifyMeshLeg,
  evaluateMeshResourceQuiet,
  evaluateReceiverMeshUploads,
  evaluateSabotageLogSignature,
  evaluateWireFreshWithoutRedraw,
  evaluateWireHashParity,
  evaluateWireMeshCensus,
  meshLogDivergence,
} from "../lib/gate5e-checks";

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

function line(
  frame: number,
  id: number,
  op: string,
  version: number,
  extra: Partial<ResourceLine> = {},
): ResourceLine {
  return {
    frame,
    t_us: 0,
    thread: "main",
    op,
    id,
    by_id: null,
    rid: "1",
    version,
    kind: "mesh",
    status: op === "free" ? "freed" : "ok",
    reason: null,
    format: null,
    width: null,
    height: null,
    mipmaps: null,
    data_bytes: null,
    payload_bytes: null,
    hash: null,
    copy_ns: null,
    hash_ns: null,
    conn: null,
    http_status: null,
    target: null,
    ref_id: null,
    value: null,
    layer: null,
    root_viewport: null,
    surface: null,
    buffer: null,
    offset: null,
    bytes: null,
    primitive: null,
    vertex_count: null,
    index_count: null,
    outcome: op === "free" ? null : "applied",
    ...extra,
  } as unknown as ResourceLine;
}

interface WireMesh {
  id: number;
  status: string;
  version: number;
  surfaces: { hash: string; payload_bytes: number }[];
}

function recording(
  frames: {
    frame: number;
    meshes: WireMesh[];
    items?: unknown[];
    removed?: number[];
  }[],
): RecordingSummary {
  return {
    path: "synthetic",
    present: true,
    sha256: null,
    bytes: 0,
    errors: [],
    transactions: frames.map((f, k) => ({
      meta: {
        type: "transaction",
        seq: k + 1,
        frame: f.frame,
        items: f.items ?? [],
        meshes: f.meshes,
      },
      wire: { removed_meshes: f.removed ?? [] },
      sha256: "",
    })),
  } as unknown as RecordingSummary;
}

const H = (c: string) => c.repeat(64);

// ---------------------------------------------------------------------------------------------
// 1. The hook log against the wire
// ---------------------------------------------------------------------------------------------

function logCases(): void {
  const lines = [
    line(1, 1, "mesh_create", 1),
    line(1, 1, "mesh_add_surface", 2, { surface: 0, hash: H("a") }),
    line(2, 1, "mesh_surface_update_vertex_region", 3, {
      surface: 0,
      hash: H("b"),
    }),
    line(2, 1, "mesh_set_custom_aabb", 4),
    line(3, 1, "mesh_surface_update_vertex_region", 4, {
      surface: 0,
      hash: H("c"),
      omitted: true,
    }),
    line(4, 1, "free", 4),
  ];
  const s = (hash: string) => [{ hash, payload_bytes: 60 }];
  const good = recording([
    {
      frame: 1,
      meshes: [{ id: 1, status: "ok", version: 2, surfaces: s(H("a")) }],
    },
    {
      frame: 2,
      meshes: [{ id: 1, status: "ok", version: 4, surfaces: s(H("b")) }],
    },
    {
      frame: 3,
      meshes: [{ id: 1, status: "ok", version: 4, surfaces: s(H("b")) }],
    },
    {
      frame: 4,
      meshes: [{ id: 1, status: "freed", version: 4, surfaces: [] }],
    },
    { frame: 5, meshes: [] },
  ]);
  passes(
    "mesh-log-divergence (one wire version per frame, omitted line ignored)",
    meshLogDivergence(lines, good, { hashes: true }),
  );
  const version = clone(good);
  (version.transactions[1].meta.meshes ?? [])[0].version = 3;
  fails(
    "mesh-log-divergence (a version behind)",
    meshLogDivergence(lines, version, { hashes: false }),
    "v3",
  );
  const missing = clone(good);
  missing.transactions[1].meta.meshes = [];
  fails(
    "mesh-log-divergence (a live mesh missing)",
    meshLogDivergence(lines, missing, { hashes: false }),
    "not on the wire",
  );
  const hash = clone(good);
  (hash.transactions[1].meta.meshes ?? [])[0].surfaces[0].hash = H("c");
  passes(
    "mesh-log-divergence without hashes (a hash off)",
    meshLogDivergence(lines, hash, { hashes: false }),
  );
  fails(
    "mesh-log-divergence with hashes (a hash off)",
    meshLogDivergence(lines, hash, { hashes: true }),
    "surfaces",
  );
  const cls = classifyMeshLeg(
    {
      result_class: "success",
      reasons: [],
      mismatching_steps: [],
      harmless_ties: [],
    },
    meshLogDivergence(lines, version, { hashes: false }),
  );
  assert(
    "classifyMeshLeg makes a divergence capture-failure",
    cls.result_class === "capture-failure" &&
      cls.reasons[0].includes("mesh-log-divergence"),
  );

  // perturb-vertex's signature: from frame 2 on the payloads taken are re-hashed on the wire.
  const perturbed = clone(good);
  (perturbed.transactions[1].meta.meshes ?? [])[0].surfaces[0].hash = H("e");
  (perturbed.transactions[2].meta.meshes ?? [])[0].surfaces[0].hash = H("e");
  passes(
    "sabotage-mesh-log-signature (perturb-vertex)",
    evaluateSabotageLogSignature("perturb-vertex", 2, lines, perturbed)
      .problems,
  );
  fails(
    "sabotage-mesh-log-signature (perturb-vertex, a late payload unperturbed)",
    evaluateSabotageLogSignature("perturb-vertex", 2, lines, good).problems,
    "equals",
  );
  fails(
    "sabotage-mesh-log-signature (perturb-vertex, an early payload perturbed)",
    evaluateSabotageLogSignature("perturb-vertex", 3, lines, perturbed)
      .problems,
    "differs",
  );
}

// ---------------------------------------------------------------------------------------------
// 2. The wire against expected.json
// ---------------------------------------------------------------------------------------------

const IDS = new Map(
  ["AM1", "RMS", "M2", "DF", "P2", "LD", "FM", "DF2"].map((n, k) => [n, k + 1]),
);

/** A wire every frame 1..quit from the lifetimes, settle frames carrying the oracle's hashes. */
function syntheticWire(
  expected: Gate5MeshExpected,
  quit: number,
): RecordingSummary {
  const life = expected.predictions["mesh-lifetimes"] as Record<
    string,
    [number, number | null, number | null]
  >;
  const frames = [];
  for (let f = 1; f <= quit; f++) {
    const step = expected.steps.find((s) => s.settle_frame === f);
    const meshes: WireMesh[] = [];
    const removed: number[] = [];
    for (const name of expected.mesh_order) {
      const l = life[name];
      const id = IDS.get(name) ?? 0;
      const leaves = l[2] !== null ? l[2] + 1 : l[1] !== null ? l[1] + 1 : null;
      if (f === leaves) removed.push(id);
      if (f < l[0]) continue;
      const view = step?.meshes.find((m) => m.name === name);
      if (l[1] === null || f <= l[1])
        meshes.push({
          id,
          status: "ok",
          version: 2,
          surfaces: (view?.surfaces ?? [{ sha256: H("0") }]).map((x) => ({
            hash: x.sha256,
            payload_bytes: 60,
          })),
        });
      else if (l[2] !== null && f <= l[2])
        meshes.push({ id, status: "freed", version: 2, surfaces: [] });
    }
    const rmsVersion = 2 + [21, 31, 41].filter((x) => x <= f).length;
    const rms = meshes.find((m) => m.id === IDS.get("RMS"));
    if (rms) {
      rms.version = rmsVersion;
      if (!step)
        rms.surfaces = [{ hash: H(String(rmsVersion)), payload_bytes: 60 }];
    }
    frames.push({
      frame: f,
      meshes,
      removed,
      items: expected.creation_order.map((_, k) => ({
        id: k + 1,
        content_version: 2,
      })),
    });
  }
  return recording(frames);
}

function wireCases(expected: Gate5MeshExpected): void {
  const wire = syntheticWire(expected, 102);
  passes(
    "mesh-hash-parity",
    evaluateWireHashParity(expected, IDS, [{ label: "full", recording: wire }])
      .problems,
  );
  const off = clone(wire);
  const settle = off.transactions.find(
    (t) => t.meta.frame === expected.steps[3].settle_frame,
  );
  const rms = (settle?.meta.meshes ?? []).find((m) => m.id === IDS.get("RMS"));
  if (rms) rms.surfaces[0].hash = H("f");
  fails(
    "mesh-hash-parity (one surface hash off)",
    evaluateWireHashParity(expected, IDS, [{ label: "full", recording: off }])
      .problems,
    "step 3 RMS",
  );

  passes(
    "mesh-census-wire",
    evaluateWireMeshCensus(expected, IDS, wire, wire).problems,
  );
  const tomb = clone(wire);
  const t75 = tomb.transactions.find((t) => t.meta.frame === 75);
  if (t75)
    t75.meta.meshes = (t75.meta.meshes ?? []).filter(
      (m) => m.id !== IDS.get("FM"),
    );
  fails(
    "mesh-census-wire (FM's tombstone gone early)",
    evaluateWireMeshCensus(expected, IDS, tomb, wire).problems,
    "frame 75",
  );
  const removed = clone(wire);
  const t51 = removed.transactions.find((t) => t.meta.frame === 51);
  if (t51?.wire) t51.wire.removed_meshes = [];
  fails(
    "mesh-census-wire (the patch does not remove DF)",
    evaluateWireMeshCensus(expected, IDS, wire, removed).problems,
    "patch frame 51",
  );

  passes(
    "fresh-without-redraw-wire",
    evaluateWireFreshWithoutRedraw(expected, IDS, wire, 102).problems,
  );
  const redraw = clone(wire);
  const rmItem =
    redraw.transactions[40].meta.items[expected.creation_order.indexOf("RM")];
  rmItem.content_version = 3;
  fails(
    "fresh-without-redraw-wire (RM redrawn)",
    evaluateWireFreshWithoutRedraw(expected, IDS, redraw, 102).problems,
    "content_version",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. The receiver's uploads and fetches
// ---------------------------------------------------------------------------------------------

function appliedFrom(expected: Gate5MeshExpected, quit: number): AppliedJson5e {
  const predicted = expected.predictions["receiver-mesh-uploads"] as Record<
    string,
    [string, string, number[], string[], number][]
  >;
  const rows = [];
  for (let f = 1; f <= quit; f++)
    for (const [name, op, surfaces, buffers, bytes] of predicted[String(f)] ??
      [])
      rows.push({
        seq: f,
        id: IDS.get(name) ?? -1,
        op,
        surfaces,
        buffers,
        bytes,
      });
  return {
    transactions: Array.from({ length: quit }, (_, k) => ({
      seq: k + 1,
      frame: k + 1,
    })),
    mesh_uploads: rows,
    fetches: [],
  } as unknown as AppliedJson5e;
}

function receiverCases(expected: Gate5MeshExpected): void {
  const applied = appliedFrom(expected, 400);
  passes(
    "receiver-mesh-uploads",
    evaluateReceiverMeshUploads(expected, IDS, applied, 400).problems,
  );
  const dropped = clone(applied);
  dropped.mesh_uploads = (dropped.mesh_uploads ?? []).filter(
    (r) => !(r.seq === 41 && r.id === IDS.get("RMS")),
  );
  fails(
    "receiver-mesh-uploads (RMS's index update missing)",
    evaluateReceiverMeshUploads(expected, IDS, dropped, 400).problems,
    "frame 41",
  );
  const extra = clone(applied);
  const am1 = (extra.mesh_uploads ?? []).find(
    (r) => r.seq === 11 && r.id === IDS.get("AM1"),
  );
  if (am1) am1.buffers = ["vertex", "attribute"];
  fails(
    "receiver-mesh-uploads (an unchanged buffer re-uploaded)",
    evaluateReceiverMeshUploads(expected, IDS, extra, 400).problems,
    "frame 11",
  );
  const rebuild = clone(applied);
  const p2 = (rebuild.mesh_uploads ?? []).find(
    (r) => r.seq === 71 && r.id === IDS.get("P2"),
  );
  if (p2) p2.op = "update";
  fails(
    "receiver-mesh-uploads (P2's layout change not rebuilt)",
    evaluateReceiverMeshUploads(expected, IDS, rebuild, 400).problems,
    "frame 71",
  );

  const names = new Map([...IDS].map(([n, id]) => [id, n]));
  const wire = recording([
    {
      frame: 1,
      meshes: [
        {
          id: 6,
          status: "ok",
          version: 1,
          surfaces: [{ hash: H("1"), payload_bytes: 60 }],
        },
        {
          id: 4,
          status: "ok",
          version: 2,
          surfaces: [{ hash: H("4"), payload_bytes: 60 }],
        },
      ],
    },
    {
      frame: 2,
      meshes: [
        {
          id: 6,
          status: "ok",
          version: 1,
          surfaces: [{ hash: H("1"), payload_bytes: 60 }],
        },
        {
          id: 4,
          status: "ok",
          version: 5,
          surfaces: [{ hash: H("5"), payload_bytes: 60 }],
        },
      ],
    },
    {
      frame: 3,
      meshes: [
        {
          id: 6,
          status: "ok",
          version: 2,
          surfaces: [{ hash: H("2"), payload_bytes: 60 }],
        },
        {
          id: 4,
          status: "ok",
          version: 8,
          surfaces: [{ hash: H("6"), payload_bytes: 60 }],
        },
      ],
    },
  ]);
  const fetched = (list: { seq: number; hash: string }[]) =>
    ({
      transactions: [1, 2, 3].map((s) => ({ seq: s, frame: s })),
      fetches: list.map((x) => ({ ...x, kind: "mesh", bytes: 60 })),
    }) as unknown as AppliedJson5e;
  passes(
    "resource-quiet-mesh",
    evaluateMeshResourceQuiet(
      expected,
      names,
      wire,
      fetched([
        { seq: 1, hash: H("1") },
        { seq: 1, hash: H("4") },
        { seq: 2, hash: H("5") },
        { seq: 3, hash: H("6") },
      ]),
      102,
    ).problems,
  );
  fails(
    "resource-quiet-mesh (a hash fetched twice)",
    evaluateMeshResourceQuiet(
      expected,
      names,
      wire,
      fetched([
        { seq: 1, hash: H("1") },
        { seq: 2, hash: H("1") },
      ]),
      102,
    ).problems,
    "twice",
  );
  fails(
    "resource-quiet-mesh (LD changes off its census)",
    evaluateMeshResourceQuiet(
      expected,
      names,
      wire,
      fetched([{ seq: 3, hash: H("2") }]),
      102,
    ).problems,
    "census has no LD",
  );
}

// ---------------------------------------------------------------------------------------------
// 5. clip-derive: add_mesh rects (G5e)
// ---------------------------------------------------------------------------------------------

function clipCases(): void {
  const meshes = [
    {
      id: 1,
      status: "ok" as const,
      custom_aabb: [0, -2, 0, 128, 68, 0] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      surfaces: [{ hash: H("a") }],
    },
    {
      id: 2,
      status: "ok" as const,
      custom_aabb: [0, 0, 0, 0, 0, 0] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      surfaces: [{ hash: H("a") }, { hash: H("b") }],
    },
    {
      id: 3,
      status: "freed" as const,
      custom_aabb: [0, 0, 0, 0, 0, 0] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      surfaces: [],
    },
    {
      id: 4,
      status: "ok" as const,
      custom_aabb: [0, 0, 0, 0, 0, 0] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      surfaces: [{ hash: H("c") }],
    },
  ];
  const aabbs = new Map([
    [H("a"), [0, 0, 0, 64, 47, 0]],
    [H("b"), [10, 50, 0, 20, 10, 0]],
  ]);
  const rect = meshRects(meshes, aabbs);
  assert(
    "meshRects: a non-zero custom AABB wins",
    JSON.stringify(rect(1)) === JSON.stringify([0, -2, 128, 68]),
    JSON.stringify(rect(1)),
  );
  assert(
    "meshRects: the merge of the surfaces' AABBs",
    JSON.stringify(rect(2)) === JSON.stringify([0, 0, 64, 60]),
    JSON.stringify(rect(2)),
  );
  assert(
    "meshRects: a tombstone is AABB() at the origin",
    JSON.stringify(rect(3)) === JSON.stringify([0, 0, 0, 0]),
  );
  assert(
    "meshRects: a surface AABB the payloads did not supply is unknown",
    rect(4) === null,
  );
  assert("meshRects: an id absent from the table is unknown", rect(9) === null);
  const item = {
    id: 1,
    children: [],
    visible: true,
    visibility_layer: 1,
    clip: true,
    custom_rect: false,
    custom_rect_rect: [0, 0, 0, 0],
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    commands: [
      { op: "add_set_transform", transform: [2, 0, 0, 2, 5, 0] },
      {
        op: "add_mesh",
        mesh: 2,
        tex: null,
        transform: [1, 0, 0, 1, 100, 100],
        modulate: [1, 1, 1, 1],
      },
    ],
  } as unknown as Parameters<typeof itemRect>[0];
  assert(
    "itemRect: add_mesh through the draw transform, not its own",
    JSON.stringify(itemRect(item, rect)) === JSON.stringify([5, 0, 128, 120]),
    JSON.stringify(itemRect(item, rect)),
  );
  assert(
    "itemRect: add_mesh without a mesh resolver is unknown",
    itemRect(item) === null,
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate5-mesh", "expected.json"),
      "utf8",
    ),
  ) as Gate5MeshExpected;
  logCases();
  wireCases(expected);
  receiverCases(expected);
  clipCases();
  console.log(
    `\nself-test-gate5e: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
