#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 8's g8vl checks (lib/gate8-vl-checks.ts, VS4: render-stream/16 live to a
// browser receiver, the client's `viewports` option) on synthetic evidence: the run, surface-counter
// and shot judgements of vp-live and vp-client-off (each passes on honest evidence and fails on every
// sabotage it names: a leg that did not run, the wrong protocol, a missing end record, a client that
// ignored the option, an on leg that skipped a surface, a final shot that differs from the reference
// in an exact region or in size, an off leg that still drew a surface or changed content no surface
// feeds), the committed expected.json's client_off block against its reference regions, and the group
// on an empty tree and on a written one (PNG shots, applied.json, exit codes), where nothing throws.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-vl.ts

import "../lib/node-hash";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  clientOffShotProblems,
  liveSurfaceProblems,
  offSurfaceProblems,
  referenceShotProblems,
  runG8vl,
  runProblems,
  type VlExpected,
} from "../lib/gate8-vl-checks";

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
const some = (ps: string[], re: RegExp) => ps.some((p) => re.test(p));

const ex = JSON.parse(
  readFileSync(
    join(EXPERIMENT_DIR, "fixtures", "viewport-scene", "expected.json"),
    "utf8",
  ),
) as VlExpected;
const ref = ex.reference;
const off = ex.client_off;
if (!ref || !off)
  throw new Error("expected.json lacks reference or client_off");

// --- the committed client_off block ----------------------------------------------------------------
{
  const names = new Set(ref.regions.map((r) => r.name).concat("rest"));
  expect(
    [...off.differs, ...off.same].every((n) => names.has(n)),
    "client_off names only reference regions (or rest)",
  );
  expect(
    off.differs.every(
      (n) => ref.regions.find((r) => r.name === n)?.class === "exact",
    ),
    "every differs region is exact in the reference (a banded or excluded one proves nothing)",
  );
  expect(
    off.differs.every((n) => !off.same.includes(n)),
    "no region is both differs and same",
  );
}

// --- runProblems ----------------------------------------------------------------------------------
const goodApplied = {
  status: "ok",
  receiver: { protocol: "render-stream/16" },
  end_seen: true,
};
expect(
  runProblems("on", "0", "0", true, goodApplied).length === 0,
  "runProblems: an honest leg has no problem",
);
expect(
  some(runProblems("on", "1", "0", true, goodApplied), /host: exit 1/),
  "runProblems: a host that failed",
);
expect(
  some(
    runProblems("on", "0", undefined, true, goodApplied),
    /receiver: exit missing/,
  ),
  "runProblems: a receiver that left no exit code",
);
expect(
  some(runProblems("on", "0", "0", false, goodApplied), /page-config/),
  "runProblems: a native (not browser) receiver",
);
expect(
  some(
    runProblems("on", "0", "0", true, {
      ...goodApplied,
      receiver: { protocol: "render-stream/13" },
    }),
    /not render-stream\/16/,
  ),
  "runProblems: the wrong protocol",
);
expect(
  some(
    runProblems("on", "0", "0", true, { ...goodApplied, end_seen: false }),
    /no end record/,
  ),
  "runProblems: no end record",
);
expect(
  some(runProblems("on", "0", "0", true, null), /no applied\.json/),
  "runProblems: no applied.json",
);

// --- surface counters -----------------------------------------------------------------------------
const onS = {
  viewports: true,
  surfaces_rendered: 5,
  surfaces_skipped: 0,
  surfaces_unchanged: 3,
  surfaces_allocated: 6,
  surface_pixels: 100000,
};
const offS = {
  viewports: false,
  surfaces_rendered: 0,
  surfaces_skipped: 9,
  surfaces_unchanged: 0,
  surfaces_allocated: 0,
  surface_pixels: 0,
};
expect(liveSurfaceProblems(onS).length === 0, "live counters: honest on leg");
expect(
  some(liveSurfaceProblems(offS), /expected on/) &&
    some(liveSurfaceProblems(offS), /surfaces_rendered 0/),
  "live counters: an off-built core on the on leg fails",
);
expect(
  some(
    liveSurfaceProblems({ ...onS, surfaces_skipped: 1 }),
    /surfaces_skipped 1/,
  ),
  "live counters: a skipped surface with viewports on",
);
expect(
  some(liveSurfaceProblems(undefined), /no live\.gsw\.surfaces/),
  "live counters: no block",
);
expect(offSurfaceProblems(offS).length === 0, "off counters: honest off leg");
expect(
  some(offSurfaceProblems(onS), /expected off/) &&
    some(offSurfaceProblems(onS), /surfaces_rendered 5/),
  "off counters: a client that ignored the option fails",
);
expect(
  some(
    offSurfaceProblems({ ...offS, surfaces_skipped: 0 }),
    /did not reach the core/,
  ),
  "off counters: nothing skipped means the option never reached the core",
);
expect(
  some(
    offSurfaceProblems({ ...offS, surfaces_allocated: 2 }),
    /surfaces_allocated 2/,
  ),
  "off counters: an allocated target with viewports off",
);

// --- shots ----------------------------------------------------------------------------------------
const W = 640;
const H = 360;
function shot(paint: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { data, width: W, height: H };
}
const region = (name: string) => {
  const r = ref.regions.find((q) => q.name === name);
  if (!r) throw new Error(`no region ${name}`);
  return r.rect;
};
const inside = (rect: number[], x: number, y: number) =>
  x >= rect[0] &&
  y >= rect[1] &&
  x < rect[0] + rect[2] &&
  y < rect[1] + rect[3];
const BG: [number, number, number] = [10, 20, 30];
const FILL: [number, number, number] = [200, 100, 50];
// The picture a surface-drawing client shows: every `differs` region filled; `anim` red.
const drawn = (x: number, y: number): [number, number, number] => {
  for (const n of off.differs) if (inside(region(n), x, y)) return FILL;
  if (inside(region("anim"), x, y)) return [230, 50, 50];
  return BG;
};
// The picture with viewports off: the surface regions show what is behind them.
const bare = (x: number, y: number): [number, number, number] =>
  inside(region("anim"), x, y) ? [230, 50, 50] : BG;
const onShot = shot(drawn);
const offShot = shot(bare);
{
  const r = referenceShotProblems("on", shot(drawn), shot(drawn), ref);
  expect(r.problems.length === 0, "reference: identical shots pass");
  const broken = shot((x, y) =>
    inside(region("draw"), x, y) && x < 20 ? [0, 0, 0] : drawn(x, y),
  );
  const bad = referenceShotProblems("on", broken, shot(drawn), ref);
  expect(
    some(bad.problems, /draw: \d+ px over 1/),
    "reference: an exact region off by a lot fails",
  );
  const accum = region("accum");
  const inBand = shot((x, y) =>
    inside(accum, x, y) ? [255, 255, 255] : drawn(x, y),
  );
  expect(
    referenceShotProblems("on", inBand, shot(drawn), ref).problems.length === 0,
    "reference: a banded region's difference is reported, not failed",
  );
  const small = { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 };
  expect(
    some(
      referenceShotProblems("on", small, shot(drawn), ref).problems,
      /4x4 against/,
    ),
    "reference: a shot of another size fails",
  );
}
{
  expect(
    clientOffShotProblems(offShot, onShot, ref, off).problems.length === 0,
    "client-off: surfaces gone, the rest unchanged passes",
  );
  const stillDrawn = clientOffShotProblems(onShot, onShot, ref, off);
  expect(
    some(stillDrawn.problems, /draw: only 0 px differ/),
    "client-off: a surface still drawn fails",
  );
  const disturbed = shot((x, y) =>
    inside(region("anim"), x, y) ? [0, 0, 255] : bare(x, y),
  );
  expect(
    some(
      clientOffShotProblems(disturbed, onShot, ref, off).problems,
      /anim: \d+ px differ/,
    ),
    "client-off: content no surface feeds changed fails",
  );
  const noise = shot((x, y) =>
    x === 639 && y === 359 ? [255, 255, 255] : bare(x, y),
  );
  expect(
    some(
      clientOffShotProblems(noise, onShot, ref, off).problems,
      /rest: 1 px differ/,
    ),
    "client-off: one pixel of the rest changing fails",
  );
}

// --- the group, on an empty and a written tree -----------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "self-test-gate8-vl-"));
async function png(
  path: string,
  s: { data: Uint8Array; width: number; height: number },
) {
  mkdirSync(dirname(path), { recursive: true });
  await sharp(Buffer.from(s.data), {
    raw: { width: s.width, height: s.height, channels: 4 },
  })
    .png()
    .toFile(path);
}
async function writeLeg(
  g: string,
  name: string,
  s: { data: Uint8Array; width: number; height: number },
  surfaces: unknown,
  extra: { recvExit?: string; protocol?: string } = {},
) {
  const d = join(g, name);
  mkdirSync(join(d, "host"), { recursive: true });
  mkdirSync(join(d, "receiver"), { recursive: true });
  writeFileSync(join(d, "host", "exit-code.txt"), "0\n");
  writeFileSync(
    join(d, "receiver", "exit-code.txt"),
    `${extra.recvExit ?? "0"}\n`,
  );
  writeFileSync(join(d, "receiver", "page-config.json"), "{}\n");
  writeFileSync(
    join(d, "receiver", "applied.json"),
    JSON.stringify({
      status: "ok",
      receiver: { protocol: extra.protocol ?? "render-stream/16" },
      end_seen: true,
      live: { gsw: { surfaces } },
    }),
  );
  await png(join(d, "receiver", "shots", "final.png"), s);
}
try {
  const empty = await runG8vl(tmp, ex);
  expect(
    empty.checks.map((c) => c.id).join() === "vp-live,vp-client-off" &&
      empty.checks.every((c) => !c.passed),
    "empty tree: both checks fail (evidence missing), nothing throws",
  );
  const g = join(tmp, "g8vl");
  mkdirSync(join(g, "reference", "capture", "shots"), { recursive: true });
  writeFileSync(
    join(g, "reference", "capture", "steps.jsonl"),
    '{"step":0}\n{"step":1}\n{"step":2}\n{"step":3}\n',
  );
  await png(join(g, "reference", "capture", "shots", "step-3.png"), onShot);
  await writeLeg(g, "on", onShot, onS);
  await writeLeg(g, "client-off", offShot, offS);
  const ok = await runG8vl(tmp, ex);
  expect(
    ok.checks.every((c) => c.passed),
    `written tree: honest evidence passes (${ok.checks.map((c) => `${c.id}:${c.status}`).join(", ")})`,
  );
  // sabotage: the off leg is built with viewports on and draws everything
  await writeLeg(g, "client-off", onShot, onS);
  const bad = await runG8vl(tmp, ex);
  const byId = new Map(bad.checks.map((c) => [c.id, c]));
  expect(
    byId.get("vp-live")?.passed === true &&
      byId.get("vp-client-off")?.passed === false,
    "an off leg that ignored the option fails vp-client-off only",
  );
  // sabotage: the on leg spoke /13
  await writeLeg(g, "client-off", offShot, offS);
  await writeLeg(g, "on", onShot, onS, { protocol: "render-stream/13" });
  const wrong = await runG8vl(tmp, ex);
  expect(
    wrong.checks.find((c) => c.id === "vp-live")?.passed === false,
    "an on leg that spoke /13 fails vp-live",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(
    `self-test-gate8-vl: ${failures} of ${assertions} assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log(`self-test-gate8-vl: ${assertions} assertions passed`);
}
