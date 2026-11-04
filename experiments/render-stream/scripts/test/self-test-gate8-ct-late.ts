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
  adoptProblems,
  diffuseUploadProblems,
  faultProblems,
  freeProblems,
  type G8ctlExpected,
  referenceProblems,
  releaseProblems,
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
  "late/capture",
  "fault-no-resources/capture",
  "late/receiver",
  "late/receiver-patch",
];
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
  for (const l of ["reference", ...["late/receiver", "late/receiver-patch"]]) {
    await png(out, l, 0, ink(false));
    await png(out, l, 1, ink(true));
  }
  for (const l of ["late/receiver", "late/receiver-patch"])
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
    "ct-late-fault",
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
  for (const l of ["reference", "late/receiver", "late/receiver-patch"])
    await png(out, l, 0, () => CLEAR);
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: identical but blank shots fail (cells hold no ink)",
  );
}
{
  const out = await tree("differ");
  await png(out, "late/receiver-patch", 0, (x, y) =>
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
  for (const l of ["reference", "late/receiver", "late/receiver-patch"])
    await png(out, l, 1, ink(false));
  expect(
    byId((await runG8ctl(out, EXPECTED)).checks, "ct-late-reference")
      ?.passed === false,
    "fs: a freed cell that still holds ink fails",
  );
}
{
  const out = await tree("noshot");
  rmSync(join(out, "g8ctl", "late/receiver", "shots", "step-1.png"));
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
      ["late/receiver"],
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
