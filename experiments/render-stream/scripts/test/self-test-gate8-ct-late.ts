#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8ctl checks (lib/gate8-ct-late-checks.ts): the pure judgements over
// resolved data (the test encoder cannot emit /8 adopted canvas-texture entries, so the recordings
// here are synthetic ResolvedRecordings) and the filesystem-level behaviour of runG8ctl on a
// fabricated tree (exit codes, applied.json, PNG shots; no recordings, so the recording-dependent
// checks must fail rather than pass vacuously).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-ct-late.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";

import {
  adoptedDiffuses,
  adoptNamedProblems,
  adoptProblems,
  diffuseUploadProblems,
  faultProblems,
  freeProblems,
  type G8ctlExpected,
  referenceProblems,
  registrySourceProblems,
  releaseProblems,
  residualProblems,
  runG8ctl,
} from "../lib/gate8-ct-late-checks";
import type { ResolvedRecording } from "../lib/render-stream-2";

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const EXPECTED: G8ctlExpected = {
  schema: "render-stream-gate8-ct-late-expected/1",
  arm_frame: 12,
  quit_frame: 30,
  canvas_count: 3,
  regions: { A: [0, 0, 7, 7], B: [8, 0, 15, 7], C: [0, 8, 7, 15] },
  cells: ["A", "B", "C"],
  clear_color: [51, 51, 102],
  free_frame: 22,
  freed_canvas_count: 1,
  checkpoints: [
    { step: 0, settle: 17 },
    { step: 1, settle: 26, blank: ["A"] },
  ],
};

// ---- synthetic recordings --------------------------------------------------------------------
type Tex = Record<string, unknown>;
const image = (id: number, status = "ok"): Tex => ({
  id,
  kind: "image",
  origin: "adopted",
  status,
  canvas: null,
});
const canvas = (
  id: number,
  diffuse: number | null,
  o: Partial<Tex> = {},
): Tex => ({
  id,
  kind: "canvas",
  origin: "adopted",
  status: "ok",
  canvas: { diffuse },
  ...o,
});
function recording(
  txs: { frame: number; textures: Tex[]; unknown?: number }[],
): ResolvedRecording {
  return {
    transactions: txs.map((t, i) => ({
      seq: i + 1,
      frame: t.frame,
      state: {
        textures: t.textures,
        items: [
          {
            commands: Array.from({ length: t.unknown ?? 0 }, () => ({
              op: "unsupported",
              reason: "unknown-texture",
            })),
          },
        ],
      },
    })),
  } as unknown as ResolvedRecording;
}
// canvases 10, 11, 12 with diffuses 1, 2, 3
const ALL = [
  image(1),
  image(2),
  image(3),
  canvas(10, 1),
  canvas(11, 2),
  canvas(12, 3),
];
// after the free of canvas 10: its entry and diffuse 1 are gone
const AFTER = [image(2), image(3), canvas(11, 2), canvas(12, 3)];
const GOOD = recording([
  { frame: 13, textures: ALL },
  { frame: 20, textures: ALL },
  { frame: 28, textures: AFTER },
]);
const RES = { textures_canvas: 3, textures_refused: 0 };
const OKREC = { rec: GOOD };

// ---- adoptProblems ----------------------------------------------------------------------------
expect(
  adoptProblems(RES, OKREC, EXPECTED, []).length === 0,
  "adopt: the honest capture passes",
);
expect(
  adoptProblems(undefined, OKREC, EXPECTED, []).length > 0,
  "adopt: missing result counters fail",
);
expect(
  adoptProblems({ ...RES, textures_canvas: 2 }, OKREC, EXPECTED, []).length > 0,
  "adopt: a wrong adopted count fails",
);
expect(
  adoptProblems({ ...RES, textures_refused: 1 }, OKREC, EXPECTED, []).length >
    0,
  "adopt: a refused texture fails",
);
expect(
  adoptProblems(RES, { error: "x missing" }, EXPECTED, []).length > 0,
  "adopt: no recording fails",
);
expect(
  adoptProblems(RES, { rec: recording([]) }, EXPECTED, []).length > 0,
  "adopt: an empty recording fails",
);
expect(
  adoptProblems(RES, OKREC, EXPECTED, ["recording.rs8: missing"]).length > 0,
  "adopt: a sink problem fails",
);
expect(
  adoptProblems(
    RES,
    {
      rec: recording([
        {
          frame: 13,
          textures: [
            image(1),
            image(2),
            image(3),
            canvas(10, 1, { origin: "created" }),
            canvas(11, 2),
            canvas(12, 3),
          ],
        },
        { frame: 28, textures: AFTER },
      ]),
    },
    EXPECTED,
    [],
  ).length > 0,
  "adopt: a non-adopted origin fails",
);
expect(
  adoptProblems(
    RES,
    {
      rec: recording([
        {
          frame: 13,
          textures: [
            image(1),
            image(2),
            image(3),
            canvas(10, 1),
            canvas(11, 2),
            canvas(12, 3, { status: "unsupported" }),
          ],
        },
        { frame: 28, textures: AFTER },
      ]),
    },
    EXPECTED,
    [],
  ).length > 0,
  "adopt: a non-ok canvas fails",
);
expect(
  adoptProblems(
    RES,
    {
      rec: recording([
        {
          frame: 13,
          textures: [
            image(1, "freed"),
            image(2),
            image(3),
            canvas(10, 1),
            canvas(11, 2),
            canvas(12, 3),
          ],
        },
        { frame: 28, textures: AFTER },
      ]),
    },
    EXPECTED,
    [],
  ).length > 0,
  "adopt: a diffuse that is not an ok image fails",
);
expect(
  adoptProblems(
    RES,
    {
      rec: recording([
        { frame: 13, textures: ALL, unknown: 1 },
        { frame: 28, textures: AFTER },
      ]),
    },
    EXPECTED,
    [],
  ).length > 0,
  "adopt: an unknown-texture command fails",
);
expect(
  adoptProblems(
    RES,
    {
      rec: recording([
        { frame: 13, textures: ALL },
        { frame: 28, textures: ALL },
      ]),
    },
    EXPECTED,
    [],
  ).length > 0,
  "adopt: nothing freed by the last state fails when a free is expected",
);
expect(
  adoptProblems(RES, OKREC, { ...EXPECTED, canvas_count: 0 }, []).length > 0,
  "adopt: a zero expected count fails",
);

// ---- LAR1: registrySourceProblems -------------------------------------------------------------
{
  const res = {
    textures_canvas: 3,
    canvas_registry: 3,
    canvas_residual: 0,
    textures_refused: 0,
  };
  const reg = {
    enabled: true,
    fault: "none",
    families: { canvas_texture: { creates: 3 } },
  };
  expect(
    registrySourceProblems(res, reg, 3).length === 0,
    "source: every canvas texture from the registry passes",
  );
  expect(
    registrySourceProblems({ ...res, canvas_registry: 2, canvas_residual: 1 }, reg, 3)
      .length > 0,
    "source: one through the residual path fails",
  );
  expect(
    registrySourceProblems(
      { textures_canvas: 3, textures_refused: 0 },
      reg,
      3,
    ).length > 0,
    "source: a pre-LAR1 capture (no canvas_registry) fails",
  );
  expect(
    registrySourceProblems({ ...res, textures_refused: 1 }, reg, 3).length > 0,
    "source: a refusal fails",
  );
  expect(
    registrySourceProblems(res, { ...reg, enabled: false }, 3).length > 0,
    "source: a registry that was not recording fails",
  );
  expect(
    registrySourceProblems(
      res,
      { ...reg, families: { canvas_texture: { creates: 2 } } },
      3,
    ).length > 0,
    "source: fewer recorded creates than adoptions fails",
  );
  expect(
    registrySourceProblems(res, undefined, 3).length > 0,
    "source: no registry.json fails",
  );
  // registry-off on deferred: the runtime ones refused, the cached one residual
  expect(
    registrySourceProblems(
      {
        textures_canvas: 1,
        canvas_registry: 0,
        canvas_residual: 1,
        textures_refused: 2,
      },
      { enabled: false, fault: "registry-off", families: {} },
      3,
    ).length > 0,
    "source: the registry-off sabotage fails",
  );
}

// ---- LAR1: adoptNamedProblems -----------------------------------------------------------------
{
  const named = (
    txs: { textures: Tex[]; tex: (number | null)[] }[],
  ): ResolvedRecording =>
    ({
      transactions: txs.map((t, i) => ({
        seq: i + 1,
        frame: 12 + i,
        state: {
          textures: t.textures,
          items: [
            {
              commands: t.tex.map((x) => ({ op: "add_texture_rect", tex: x })),
            },
          ],
        },
      })),
    }) as unknown as ResolvedRecording;
  const ok = named([
    { textures: [image(1), canvas(10, 1)], tex: [10] },
    { textures: [image(1), canvas(10, 1), image(2), canvas(11, 2)], tex: [11] },
  ]);
  const r = adoptNamedProblems(ok, 2);
  expect(
    r.problems.length === 0 && r.adopted === 2,
    "named: each adopted canvas named in its first transaction passes (later ones need not repeat)",
  );
  expect(
    adoptNamedProblems(
      named([{ textures: [image(1), canvas(10, 1)], tex: [1] }]),
      1,
    ).problems.length > 0,
    "named: only the diffuse named (the GAP2-RX shape) fails",
  );
  expect(
    adoptNamedProblems(
      named([
        { textures: [image(1), canvas(10, 1)], tex: [null] },
        { textures: [image(1), canvas(10, 1)], tex: [10] },
      ]),
      1,
    ).problems.length > 0,
    "named: named only in a later transaction fails",
  );
  expect(
    adoptNamedProblems(
      named([
        {
          textures: [image(1), canvas(10, 1, { origin: "created" })],
          tex: [],
        },
      ]),
      0,
    ).problems.length === 0,
    "named: a created (not adopted) canvas texture is not judged",
  );
  expect(
    adoptNamedProblems(ok, 3).problems.length > 0,
    "named: fewer adopted than the minimum fails",
  );
  expect(
    adoptNamedProblems(undefined, 1).problems.length > 0,
    "named: no recording fails",
  );
}

// ---- LAR1: residualProblems (the late leg under F1) -------------------------------------------
{
  const LATE = { canvas_residual: 1, refused_no_image: 3 };
  const res = {
    textures_canvas: 1,
    canvas_registry: 0,
    canvas_residual: 1,
    textures_refused: 3,
    refused_no_image: 3,
    refused_canvas_empty: 0,
  };
  const late = recording([
    { frame: 13, textures: [image(4), canvas(13, 4)], unknown: 3 },
    { frame: 28, textures: [image(4), canvas(13, 4)], unknown: 3 },
  ]);
  expect(
    residualProblems(res, { rec: late }, LATE).length === 0,
    "residual: PM9 adopted, runtime refused typed, unknown-texture draws passes",
  );
  expect(
    residualProblems({ ...res, refused_no_image: 2 }, { rec: late }, LATE)
      .length > 0,
    "residual: an untyped refusal fails",
  );
  expect(
    residualProblems(
      { ...res, textures_canvas: 4, canvas_residual: 4, textures_refused: 0, refused_no_image: 0 },
      { rec: late },
      LATE,
    ).length > 0,
    "residual: the runtime ones adopted (RT-CTX's node read) fails",
  );
  expect(
    residualProblems(
      { ...res, canvas_registry: 1, canvas_residual: 0 },
      { rec: late },
      LATE,
    ).length > 0,
    "residual: an adoption from the registry on late fails",
  );
  expect(
    residualProblems(
      res,
      {
        rec: recording([
          { frame: 13, textures: [image(4), canvas(13, 4)], unknown: 0 },
        ]),
      },
      LATE,
    ).length > 0,
    "residual: no unknown-texture draw for the refused ones fails",
  );
  expect(
    residualProblems(res, { rec: late }, undefined).length > 0,
    "residual: no expected.late fails",
  );
  expect(
    residualProblems(res, { error: "missing" }, LATE).length > 0,
    "residual: no recording fails",
  );
}

// ---- faultProblems ----------------------------------------------------------------------------
const FAULT = recording([{ frame: 13, textures: [], unknown: 3 }]);
expect(
  faultProblems({ textures_canvas: 0 }, { rec: FAULT }, []).length === 0,
  "fault: the honest fault capture passes",
);
expect(
  faultProblems({ textures_canvas: 1 }, { rec: FAULT }, []).length > 0,
  "fault: an adoption under the fault fails",
);
expect(
  faultProblems(undefined, { rec: FAULT }, []).length > 0,
  "fault: missing counters fail",
);
expect(
  faultProblems(
    { textures_canvas: 0 },
    { rec: recording([{ frame: 13, textures: [] }]) },
    [],
  ).length > 0,
  "fault: no unknown-texture command fails",
);
expect(
  faultProblems(
    { textures_canvas: 0 },
    { rec: recording([{ frame: 13, textures: [canvas(10, 1)], unknown: 1 }]) },
    [],
  ).length > 0,
  "fault: a canvas entry fails",
);
expect(
  faultProblems({ textures_canvas: 0 }, { rec: recording([]) }, []).length > 0,
  "fault: an empty recording fails",
);
expect(
  faultProblems({ textures_canvas: 0 }, { error: "missing" }, []).length > 0,
  "fault: no recording fails",
);

// ---- freeProblems -----------------------------------------------------------------------------
expect(
  freeProblems(GOOD, EXPECTED).length === 0,
  "free: the honest capture passes",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 28, textures: ALL },
    ]),
    EXPECTED,
  ).length > 0,
  "free: nothing dropped fails",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 28, textures: [image(1), ...AFTER] },
    ]),
    EXPECTED,
  ).length > 0,
  "free: a surviving diffuse fails",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 28, textures: [image(1, "freed"), ...AFTER] },
    ]),
    EXPECTED,
  ).length === 0,
  "free: a freed tombstone counts as released",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 20, textures: ALL },
    ]),
    EXPECTED,
  ).length > 0,
  "free: a recording that ends before the free fails",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 28, textures: [image(3), canvas(12, 3)] },
    ]),
    EXPECTED,
  ).length > 0,
  "free: too many dropped fails",
);
expect(
  freeProblems(
    recording([
      { frame: 13, textures: ALL },
      { frame: 20, textures: AFTER },
    ]),
    EXPECTED,
  ).length > 0,
  "free: a drop recorded at or before the free frame fails",
);
expect(
  freeProblems(undefined, EXPECTED).length > 0,
  "free: no recording fails",
);
expect(
  freeProblems(recording([]), EXPECTED).length > 0,
  "free: an empty recording fails",
);
expect(
  freeProblems(GOOD, { ...EXPECTED, freed_canvas_count: undefined }).length > 0,
  "free: a missing expected count fails",
);

// ---- diffuses, uploads, release ---------------------------------------------------------------
expect(
  adoptedDiffuses(GOOD).join() === "1,2,3",
  "adoptedDiffuses reads the adoption peak, not the last state",
);
expect(
  adoptedDiffuses(recording([])).length === 0,
  "adoptedDiffuses of an empty recording is empty",
);
const up = (...ids: number[]) => ids.map((id) => ({ id, op: "create" }));
expect(
  diffuseUploadProblems([1, 2, 3], 3, { a: up(1, 2, 3), b: up(1, 2, 3) })
    .length === 0,
  "uploads: all uploaded passes",
);
expect(
  diffuseUploadProblems([1, 2, 3], 3, { a: up(1, 2, 3), b: up(1, 2) }).length >
    0,
  "uploads: a missing upload fails",
);
expect(
  diffuseUploadProblems([1, 2, 3], 3, { a: up(1, 2, 3), b: undefined }).length >
    0,
  "uploads: absent uploads[] fails",
);
expect(
  diffuseUploadProblems([], 3, { a: [], b: [] }).length > 0,
  "uploads: zero diffuses fails (not vacuous)",
);
expect(
  diffuseUploadProblems([1, 2], 3, { a: up(1, 2) }).length > 0,
  "uploads: fewer diffuses than canvas_count fails",
);
expect(
  diffuseUploadProblems([1, 2, 3], 3, {}).length > 0,
  "uploads: no receiver leg fails",
);
expect(
  diffuseUploadProblems([1], 1, { a: [{ id: 1, op: "update" }] }).length > 0,
  "uploads: an update op is not residency",
);
expect(
  releaseProblems(
    [
      { frame: 10, resources: { freed: 0 } },
      { frame: 24, resources: { freed: 2 } },
    ],
    20,
    1,
  ).length === 0,
  "release: a release after the free passes",
);
expect(
  releaseProblems(
    [
      { frame: 10, resources: { freed: 5 } },
      { frame: 24, resources: { freed: 0 } },
    ],
    20,
    1,
  ).length > 0,
  "release: a release only before the free fails",
);
expect(
  releaseProblems([{ frame: 10, resources: { freed: 5 } }], 20, 1).length > 0,
  "release: no transaction after the free fails",
);
expect(
  releaseProblems(undefined, 20, 1).length > 0,
  "release: absent transactions fail",
);
expect(
  releaseProblems([], 20, 1).length > 0,
  "release: empty transactions fail",
);
expect(
  releaseProblems([{ frame: 24, resources: null }], 20, 1).length > 0,
  "release: null resources fail",
);
expect(
  releaseProblems([{ frame: 24, resources: { freed: 1 } }], undefined, 1)
    .length > 0,
  "release: a missing free_frame fails",
);

// ---- filesystem: runG8ctl ---------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "self-test-ct-late-"));
function put(out: string, rel: string, content: string | Buffer): void {
  const p = join(out, "g8ctl", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
async function png(
  out: string,
  leg: string,
  step: number,
  painter: (x: number, y: number) => number[],
): Promise<void> {
  const w = 16;
  const h = 16;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      Buffer.from([...painter(x, y), 255]).copy(buf, (y * w + x) * 4);
  const p = join(out, "g8ctl", leg, "shots", `step-${step}.png`);
  mkdirSync(dirname(p), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(p);
}
const LEGS = [
  "import/fixture",
  "import/receiver",
  "reference",
  "deferred/capture",
  "late/capture",
  "fault-no-resources/capture",
  "sabotage-registry-off/capture",
  "deferred/receiver",
  "deferred/receiver-patch",
];
const RX = ["deferred/receiver", "deferred/receiver-patch"];
const CLEAR = [51, 51, 102];
const INK = [200, 80, 30];
const inA = (x: number, y: number) => x <= 7 && y <= 7;
const ink = (blankA: boolean) => (x: number, y: number) =>
  blankA && inA(x, y)
    ? CLEAR
    : x <= 15 && y <= 15 && (x <= 7 || y <= 7 || x >= 8) && !(x >= 8 && y >= 8)
      ? INK
      : CLEAR;
async function tree(
  name: string,
  o: { exit?: Record<string, string>; skip?: string[] } = {},
): Promise<string> {
  const out = join(root, name);
  for (const l of LEGS) {
    if (o.skip?.includes(l)) put(out, `${l}/skipped-by-tier.txt`, "tier\n");
    else put(out, `${l}/exit-code.txt`, `${o.exit?.[l] ?? "0"}\n`);
  }
  for (const l of ["reference", ...RX]) {
    await png(out, l, 0, ink(false));
    await png(out, l, 1, ink(true));
  }
  for (const l of RX)
    put(
      out,
      `${l}/applied.json`,
      JSON.stringify({
        uploads: [{ id: 1, op: "create" }],
        transactions: [{ frame: 25, resources: { freed: 2 } }],
      }),
    );
  return out;
}
const byId = (cs: { id: string; passed: boolean }[], id: string) =>
  cs.find((c) => c.id === id);

{
  const out = await tree("good");
  const { checks } = await runG8ctl(out, EXPECTED);
  expect(
    byId(checks, "ctl-legs")?.passed === true,
    "fs: ctl-legs passes on exit 0",
  );
  expect(
    byId(checks, "ct-late-reference")?.passed === true,
    "fs: ct-late-reference passes on identical inked shots",
  );
  // no recordings: the recording-dependent checks must fail, not pass vacuously
  for (const id of [
    "ct-late-adopt",
    "ctl-registry-source",
    "ct-adopt-named",
    "ct-late-residual",
    "ct-late-fault",
    "sabotage-registry-off",
    "ct-late-diffuse-uploaded",
    "ct-late-free",
  ])
    expect(
      byId(checks, id)?.passed === false,
      `fs: ${id} fails without recordings`,
    );
}
{
  const out = await tree("exit", { exit: { "late/capture": "1" } });
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ctl-legs")?.passed === false,
    "fs: a non-zero exit fails ctl-legs",
  );
}
{
  const out = await tree("allskip", { skip: LEGS });
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ctl-legs")?.passed === false,
    "fs: all legs skipped is not a pass",
  );
}
{
  // a skipped leg is named in the failing check's detail (lib/tier-verdict.py excuses it)
  const out = await tree("skipdeferred", {
    skip: ["deferred/capture", "sabotage-registry-off/capture"],
  });
  const { checks } = await runG8ctl(out, EXPECTED);
  for (const id of ["ct-late-adopt", "ctl-registry-source"])
    expect(
      /deferred\/capture did not run/.test(
        (checks.find((c) => c.id === id) as { detail?: string })?.detail ?? "",
      ),
      `fs: ${id} names the skipped deferred leg`,
    );
}
{
  const out = join(root, "empty");
  mkdirSync(join(out, "g8ctl"), { recursive: true });
  const { checks } = await runG8ctl(out, EXPECTED);
  expect(
    checks.every((c) => !c.passed),
    "fs: an empty evidence tree fails every check",
  );
}
{
  const out = await tree("blank");
  for (const l of ["reference", ...RX]) await png(out, l, 0, () => CLEAR);
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: identical but blank shots fail (cells hold no ink)",
  );
}
{
  const out = await tree("differ");
  await png(out, "deferred/receiver-patch", 0, (x, y) =>
    x === 15 && y === 15 ? [0, 0, 0] : ink(false)(x, y),
  );
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: a differing pixel fails ct-late-reference",
  );
}
{
  const out = await tree("notblank");
  for (const l of ["reference", ...RX]) await png(out, l, 1, ink(false));
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: a freed cell that still holds ink fails",
  );
}
{
  const out = await tree("noshot");
  rmSync(join(out, "g8ctl", "deferred/receiver", "shots", "step-1.png"));
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: a missing shot fails",
  );
}
{
  const out = await tree("nocheckpoints");
  const r = await runG8ctl(out, { ...EXPECTED, checkpoints: [] });
  expect(
    byId(r.checks, "ct-late-reference")?.passed === false,
    "fs: empty checkpoints fail ct-late-reference",
  );
}
{
  const out = await tree("nocells");
  const r = await runG8ctl(out, { ...EXPECTED, cells: [] });
  expect(
    byId(r.checks, "ct-late-reference")?.passed === false,
    "fs: empty cells fail ct-late-reference",
  );
}
expect(
  (
    await referenceProblems(
      join(root, "good", "g8ctl"),
      ["deferred/receiver"],
      EXPECTED,
    )
  ).length === 0,
  "referenceProblems passes on the good tree",
);

rmSync(root, { recursive: true, force: true });
console.log(
  `\nself-test-gate8-ct-late: ${assertions - failures}/${assertions} assertions passed`,
);
process.exit(failures === 0 ? 0 : 1);
