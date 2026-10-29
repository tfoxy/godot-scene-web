// SWO (results/p3/swo.md): typed known flakes of gate 7's web checks.
//
// One today: on GitHub-hosted runners, where the browser renders through the CI lavapipe allowance
// (ANGLE's Vulkan backend on Mesa's llvmpipe, lib/browser-renderer.ts), the Godot web export
// intermittently draws gate8-mm's CPUParticles2D instances (C_FLIP, D_GLOBAL; D_GLOBAL's particles
// land in G_HIDDEN's cell on the ignore-identity-transform sabotage) as opaque black quads, or
// with a stale flipbook frame. The receiver's input is identical in the good and the bad run
// (applied.json equal but for wall-clock fields, the same RS calls); NVIDIA never did it (SWO: 0
// of 330 g8mm web shots over 10 runs, against 4 to 5 runs of 10 on local lavapipe). It fails
// mm-reference@web, mm-reference-catches-*@web and web-repeat-identical@web on most hosted runs.
//
// Such a row is typed `known-flake` (lib/tier-verdict.py lists it, never fails or passes the run
// on it) only when ALL of these hold, so a real web regression stays loud:
//   - the checker runs under the CI lavapipe allowance (never locally: a local run is NVIDIA);
//   - every shot that differs between the same build's two web runs (web/ and web-repeat/) is a
//     g8mm shot whose differing pixels all lie in the particle cells, and at least one of them has
//     opaque-black pixels there in one of its two images (the signature: the fixture draws
//     nothing black); a single other repeat difference types nothing;
//   - each problem of the row is a pixel difference confined to the particle cells, on a leg whose
//     two web runs disagree there (a deterministic regression repeats identically, so its leg has
//     no such evidence and the row stays FAIL); anything else in the row (a missing shot or
//     applied.json, an uncaught sabotage, the native view failing too) types nothing.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { RendererAllowance } from "./browser-renderer";
import { decodePngRgba } from "./gate-minus1-checks";
import type { Gate7Check } from "./gate7-adapters";

export type Region = readonly [number, number, number, number];

/** One g8mm shot whose two web runs differ, with where. */
export interface RepeatDiff {
  leg: string;
  shot: string;
  /** differing pixels inside the particle cells */
  inside: number;
  /** differing pixels anywhere else */
  outside: number;
  /** opaque-black pixels inside the particle cells, the larger of the two images' counts */
  black: number;
}

export interface ParticleFlakeEvidence {
  /** every shot that differs between web/ and web-repeat/ (any leg of the gate) */
  diffs: RepeatDiff[];
}

export const PARTICLE_FLAKE_DOC = "results/p3/swo.md";

const inRegions = (x: number, y: number, regions: readonly Region[]) =>
  regions.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

/** The particle cells of fixtures/gate8-mm/expected.json: C_FLIP, D_GLOBAL and the identity
 * transform's spill cells (where ignore-identity-transform draws D_GLOBAL's particles). */
export function particleCells(pixels: {
  regions?: Record<string, Region>;
  identity_transform?: { spill?: string[] };
}): Record<string, Region> {
  const names = [
    "C_FLIP",
    "D_GLOBAL",
    ...(pixels.identity_transform?.spill ?? []),
  ];
  const out: Record<string, Region> = {};
  for (const n of names) {
    const r = pixels.regions?.[n];
    if (r) out[n] = r;
  }
  return out;
}

/** Pure: where two RGBA frames differ, against the particle cells, and their black signature. */
export function repeatDiff(
  leg: string,
  shot: string,
  a: { width: number; height: number; data: Uint8Array },
  b: { width: number; height: number; data: Uint8Array },
  cells: readonly Region[],
): RepeatDiff | null {
  if (a.width !== b.width || a.height !== b.height)
    return { leg, shot, inside: 0, outside: a.width * a.height || 1, black: 0 };
  let inside = 0;
  let outside = 0;
  let blackA = 0;
  let blackB = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const cell = inRegions(x, y, cells);
      const isBlack = (d: Uint8Array) =>
        d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 255;
      if (cell && isBlack(a.data)) blackA++;
      if (cell && isBlack(b.data)) blackB++;
      if (
        a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] ||
        a.data[i + 3] !== b.data[i + 3]
      ) {
        if (cell) inside++;
        else outside++;
      }
    }
  if (inside + outside === 0) return null;
  return { leg, shot, inside, outside, black: Math.max(blackA, blackB) };
}

function shotFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".png") && d.endsWith(`${"/"}shots`))
        out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Every shot under `repeatRoot` (web-repeat/) that differs from the same path under `webRoot`
 * (web/), judged against the particle cells. */
export async function particleFlakeEvidence(
  webRoot: string,
  repeatRoot: string,
  cells: readonly Region[],
): Promise<ParticleFlakeEvidence> {
  const diffs: RepeatDiff[] = [];
  for (const again of shotFiles(repeatRoot)) {
    const rel = relative(repeatRoot, again);
    const at = rel.lastIndexOf("/shots/");
    const leg = rel.slice(0, at);
    const shot = rel.slice(at + "/shots/".length);
    const a = await decodePngRgba(join(webRoot, rel));
    const b = await decodePngRgba(again);
    if (!a || !b) {
      diffs.push({ leg, shot, inside: 0, outside: 1, black: 0 });
      continue;
    }
    const d = repeatDiff(leg, shot, a, b, cells);
    if (d) diffs.push(d);
  }
  return { diffs };
}

const FLAKE_ROW =
  /^(mm-reference(-catches-[a-z-]+)?|web-repeat-identical)@web$/;
const REPEAT_PROBLEM =
  /^(g8mm\/.+)\/shots\/([^/ ]+\.png) differs between the two web runs$/;
// gate8-mm-checks.ts's pixel problems: `<leg> <label>: N px differ (CELL n, ...)` for
// mm-reference, `<label> (before the sabotage): ...` and `step k: outside the identity cells: ...`
// for the catches rows.
const PIXEL_PROBLEM =
  /^(?:(receiver(?:-patch|-v10)?) )?(step \d+(?:-prev)?)(?: \(before the sabotage\))?:(?: outside the identity cells:)? \d+ px differ \(([^()]*)\)$/;

/** The web legs a failing mm row's problem is about. */
function legsOf(
  rowId: string,
  role: string | undefined,
): (leg: string) => boolean {
  const base = rowId.replace(/@web$/, "");
  const kind = base.startsWith("mm-reference-catches-")
    ? base.slice("mm-reference-catches-".length)
    : null;
  if (kind) return (leg) => leg.startsWith(`g8mm/sabotage-${kind}/`);
  return (leg) => leg === `g8mm/${role ?? ""}`;
}

/**
 * Pure. Returns `checks` with each failing g7-8 web row that matches the lavapipe particle flake
 * typed `status: "known-flake"` (still `passed: false`, its evidence appended to the detail); every
 * other row unchanged. Nothing is typed without the CI lavapipe allowance or when any repeat
 * difference falls outside the signature.
 */
export function typeLavapipeParticleFlake(
  checks: readonly Gate7Check[],
  ev: ParticleFlakeEvidence,
  allowance: RendererAllowance | null,
  cellNames: readonly string[],
): (Gate7Check & { status?: string })[] {
  if (allowance?.renderer !== "lavapipe") return [...checks];
  // A run's flake may also move a live particle's flipbook frame without any black pixel in that
  // shot (SWO staged-3: 102 px, the hosted runs' "C_FLIP 102"); the black signature is per run.
  const inCells = (d: RepeatDiff) =>
    d.leg.startsWith("g8mm/") && d.outside === 0 && d.inside > 0;
  if (
    ev.diffs.length === 0 ||
    !ev.diffs.every(inCells) ||
    !ev.diffs.some((d) => d.black > 0)
  )
    return [...checks];
  const flakyShots = new Set(ev.diffs.map((d) => `${d.leg}/${d.shot}`));
  const flakyLegs = [...new Set(ev.diffs.map((d) => d.leg))];
  const allowed = new Set(cellNames);
  const typed = (c: Gate7Check): boolean => {
    if (c.passed || !FLAKE_ROW.test(c.id)) return false;
    if (c.id === "web-repeat-identical@web") {
      const ps = c.detail.split("; ");
      return ps.every((p) => {
        const m = REPEAT_PROBLEM.exec(p);
        return m !== null && flakyShots.has(`${m[1]}/${m[2]}`);
      });
    }
    const body = c.detail.replace(/^\d+ problem\(s\): /, "");
    if (body === c.detail) return false;
    const ps = body.split("; ");
    return ps.every((p) => {
      const m = PIXEL_PROBLEM.exec(p);
      if (!m) return false;
      const cells = m[3].split(", ").map((e) => e.replace(/ \d+$/, ""));
      if (!cells.every((x) => allowed.has(x))) return false;
      return flakyLegs.some(legsOf(c.id, m[1]));
    });
  };
  const note = `known-flake (SWO, ${PARTICLE_FLAKE_DOC}): CI lavapipe draws gate8-mm's CPUParticles2D instances black or a frame stale at random; the same build's two web runs disagree only there (${ev.diffs
    .slice(0, 4)
    .map((d) => `${d.leg}/${d.shot} ${d.inside} px, ${d.black} black`)
    .join(
      "; ",
    )}${ev.diffs.length > 4 ? `; ${ev.diffs.length - 4} more` : ""}); NVIDIA never does`;
  return checks.map((c) =>
    typed(c)
      ? { ...c, status: "known-flake", detail: `${c.detail} [${note}]` }
      : c,
  );
}
