#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8ctsp checks (lib/gate8-ct-spine-checks.ts) on a fabricated evidence tree.
// The adopt / fault / upload judgements are the shared pure functions that
// test/self-test-gate8-ct-late.ts drives; here the g8ctsp wiring is exercised: ctsp-legs, the
// reference pixel compare with the expected.json cells/regions, and that missing recordings or
// receivers fail rather than pass vacuously.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-ct-spine.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";

import { type G8ctspExpected, runG8ctsp } from "../lib/gate8-ct-spine-checks";

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${what}`);
  }
}

const EXPECTED: G8ctspExpected = {
  schema: "render-stream-gate8-ct-spine-expected/1",
  arm_frame: 14,
  quit_frame: 30,
  canvas_count: 1,
  regions: { MESH: [4, 4, 11, 11] },
  cells: ["MESH"],
  clear_color: [51, 51, 102],
  checkpoints: [{ step: 0, settle: 17 }],
};
const LEGS = [
  "import/fixture",
  "import/receiver",
  "reference",
  "late/capture",
  "fault-no-resources/capture",
  "late/receiver",
  "late/receiver-patch",
];
const SHOT_LEGS = ["reference", "late/receiver", "late/receiver-patch"];
const CLEAR = [51, 51, 102];
const INK = [200, 80, 30];
const root = mkdtempSync(join(tmpdir(), "self-test-ct-spine-"));

function put(out: string, rel: string, content: string): void {
  const p = join(out, "g8ctsp", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
async function png(
  out: string,
  leg: string,
  painter: (x: number, y: number) => number[],
): Promise<void> {
  const buf = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      Buffer.from([...painter(x, y), 255]).copy(buf, (y * 16 + x) * 4);
  const p = join(out, "g8ctsp", leg, "shots", "step-0.png");
  mkdirSync(dirname(p), { recursive: true });
  await sharp(buf, { raw: { width: 16, height: 16, channels: 4 } })
    .png()
    .toFile(p);
}
const mesh = (x: number, y: number) =>
  x >= 4 && x <= 11 && y >= 4 && y <= 11 ? INK : CLEAR;
async function tree(
  name: string,
  skip: string[] = [],
  exit: Record<string, string> = {},
): Promise<string> {
  const out = join(root, name);
  for (const l of LEGS)
    if (skip.includes(l)) put(out, `${l}/skipped-by-tier.txt`, "tier\n");
    else put(out, `${l}/exit-code.txt`, `${exit[l] ?? "0"}\n`);
  for (const l of SHOT_LEGS) await png(out, l, mesh);
  return out;
}
const pass = (cs: { id: string; passed: boolean }[], id: string) =>
  cs.find((c) => c.id === id)?.passed;

{
  const { checks } = await runG8ctsp(await tree("good"), EXPECTED);
  expect(pass(checks, "ctsp-legs") === true, "ctsp-legs passes on exit 0");
  expect(
    pass(checks, "ct-spine-reference") === true,
    "ct-spine-reference passes on identical inked shots",
  );
  for (const id of [
    "ct-spine-adopt",
    "ct-spine-fault",
    "ct-spine-diffuse-uploaded",
  ])
    expect(pass(checks, id) === false, `${id} fails without recordings`);
}
expect(
  pass(
    (await runG8ctsp(await tree("exit", [], { "late/capture": "3" }), EXPECTED))
      .checks,
    "ctsp-legs",
  ) === false,
  "a non-zero exit fails ctsp-legs",
);
expect(
  pass(
    (await runG8ctsp(await tree("skipall", LEGS), EXPECTED)).checks,
    "ctsp-legs",
  ) === false,
  "all legs skipped is not a pass",
);
{
  const out = join(root, "empty");
  mkdirSync(join(out, "g8ctsp"), { recursive: true });
  expect(
    (await runG8ctsp(out, EXPECTED)).checks.every((c) => !c.passed),
    "an empty tree fails every check",
  );
}
{
  const out = await tree("norecv", ["late/receiver", "late/receiver-patch"]);
  // skipped (not run) receivers: no exit-code.txt, so the reference compare has no evidence
  expect(
    pass((await runG8ctsp(out, EXPECTED)).checks, "ct-spine-reference") ===
      false,
    "no receiver evidence fails ct-spine-reference",
  );
}
{
  const out = await tree("blank");
  for (const l of SHOT_LEGS) await png(out, l, () => CLEAR);
  expect(
    pass((await runG8ctsp(out, EXPECTED)).checks, "ct-spine-reference") ===
      false,
    "identical blank shots fail (the MESH region has no ink)",
  );
}
{
  const out = await tree("differ");
  await png(out, "late/receiver", (x, y) =>
    x === 0 && y === 0 ? [0, 0, 0] : mesh(x, y),
  );
  expect(
    pass((await runG8ctsp(out, EXPECTED)).checks, "ct-spine-reference") ===
      false,
    "a differing pixel outside the region fails",
  );
}
{
  const out = await tree("white");
  await png(out, "late/receiver-patch", (x, y) =>
    x >= 4 && x <= 11 && y >= 4 && y <= 11 ? [255, 255, 255] : CLEAR,
  );
  expect(
    pass((await runG8ctsp(out, EXPECTED)).checks, "ct-spine-reference") ===
      false,
    "a white-default cell differs from the reference",
  );
}
{
  const out = await tree("noshot");
  rmSync(join(out, "g8ctsp", "late/receiver-patch", "shots", "step-0.png"));
  expect(
    pass((await runG8ctsp(out, EXPECTED)).checks, "ct-spine-reference") ===
      false,
    "a missing shot fails",
  );
}
expect(
  pass(
    (await runG8ctsp(await tree("nocp"), { ...EXPECTED, checkpoints: [] }))
      .checks,
    "ct-spine-reference",
  ) === false,
  "empty checkpoints fail",
);
expect(
  pass(
    (await runG8ctsp(await tree("nocells"), { ...EXPECTED, cells: [] })).checks,
    "ct-spine-reference",
  ) === false,
  "empty cells fail",
);
expect(
  pass(
    (await runG8ctsp(await tree("noregion"), { ...EXPECTED, regions: {} }))
      .checks,
    "ct-spine-reference",
  ) === false,
  "a cell without a region fails",
);

rmSync(root, { recursive: true, force: true });
console.log(
  `\nself-test-gate8-ct-spine: ${assertions - failures}/${assertions} assertions passed`,
);
process.exit(failures === 0 ? 0 : 1);
