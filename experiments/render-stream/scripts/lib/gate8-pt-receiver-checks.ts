// Gate 8 g8pt receiver checks (PM6a, protocol/render-stream-12.md "As built (PM6a)"): the native
// receiver (and, through g7-8's web half, the web export) re-issues every /12 emitter on its own
// RenderingServer and its own GPU simulates them. Particle pixels are declared approximate
// (particles-multimesh-design.md "What exact means here"), so these checks are structural and
// banded; only the space outside every emitter's region is judged exactly.
//
//   pt-premise              the unarmed reference: every emitting cell inks its region at every
//                           shot, D_ONESHOT is dark before its first restart and one lifetime after
//                           its last, nothing is drawn outside the regions; reference-repeat equals
//                           it outside the regions (and is reported per cell)
//   pt-lifecycle            each receiver leg lights exactly the cells the reference lights, at
//                           every shot (D_ONESHOT: dark at 3 and 4, lit after each restart, still
//                           lit at 95, dark again at 110)
//   pt-coverage             (banded) each lit cell's ink is within expected.json's band of the
//                           reference's, at every shot
//   pt-outside-exact        outside every region each receiver leg equals the reference exactly
//   pt-replay               the receiver made one emitter per drawn cell (and H_CHILD), set every
//                           seed (the probed particles_set_seed slot), restarted each emitter as
//                           often as the wire's `restarts`, replayed every wire emit and dropped
//                           none, and left no add_particles undrawn
//   pt-lockstep             (informational) per cell and shot, the receiver's pixels against the
//                           reference's exactly, with the receiver's frame offset at each shot
//   pt-lifecycle-catches-drop-restart  the receiver on PM5's drop-restart patch sink fails
//                           pt-lifecycle (D_ONESHOT's second burst never starts)
//   pt-lifecycle-catches-undrawn-particles  the pre-PM6 planner fails pt-lifecycle in every
//                           emitting cell
//   pt-replay-catches-ignore-particle-emits  a receiver that ignores particle_emits fails
//                           pt-replay (GLES3's particles_emit is a no-op, so no pixel can)
//
// Shot names: the reference's fixture shots are step-<k>-prev.png, step-<k>.png and tail-<f>.png;
// a receiver's are seq-<n>.png at its RS_RECEIVER_SHOT_SEQS, which run-gate8.sh sets to the
// frames' published seqs, so in ascending seq order they are the same shots in frame order.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck, readText, skipped } from "./gate8-adopt-checks";
import { mmCellDiff, type Rgba } from "./gate8-mm-checks";

export interface PtPixels {
  /** Each cell's emitter region, inclusive [x0, y0, x1, y1]: where its particles may be. */
  regions: Record<string, [number, number, number, number]>;
  /** A pixel nothing ever draws (the background colour). */
  background: [number, number];
  /** The shots after the last step (fixture frames). */
  tail_frames: number[];
  /** Per cell, the shot labels at which it is dark (no ink); every other shot it is lit. */
  dark: Record<string, string[]>;
  /** pt-coverage: a lit cell's ink is within [ref / band, ref * band]. */
  coverage_band: number;
}

export interface PtShot {
  label: string;
  frame: number;
}

/** The shots in frame order: each checkpoint's previous frame and settle frame, then the tails. */
export function ptShots(checkpoints: readonly { step: number; settle: number }[], tails: readonly number[]): PtShot[] {
  const out: PtShot[] = [];
  for (const c of checkpoints) {
    out.push({ label: `step-${c.step}-prev`, frame: c.settle - 1 });
    out.push({ label: `step-${c.step}`, frame: c.settle });
  }
  for (const f of tails) out.push({ label: `tail-${f}`, frame: f });
  return out.sort((a, b) => a.frame - b.frame);
}

/** Ink per region (pixels differing from the background colour) and outside every region. */
export function ptInk(img: Rgba, px: PtPixels): { cells: Record<string, number>; outside: number } {
  const at = (px.background[1] * img.width + px.background[0]) * 4;
  const bg = Array.from(img.data.subarray(at, at + 4));
  const flat: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) };
  for (let i = 0; i < flat.data.length; i += 4) flat.data.set(bg, i);
  return mmCellDiff(img, flat, px.regions) ?? { cells: {}, outside: 0 };
}

/** pt-premise's per-shot verdict on the reference's ink. */
export function ptPremiseProblems(ink: { cells: Record<string, number>; outside: number }, px: PtPixels, label: string): string[] {
  const problems: string[] = [];
  for (const cell of Object.keys(px.regions)) {
    const n = ink.cells[cell] ?? 0;
    const dark = (px.dark[cell] ?? []).includes(label);
    if (dark && n > 0) problems.push(`${cell}: ${n} px inked (expected dark)`);
    if (!dark && n === 0) problems.push(`${cell} is dark (expected lit)`);
  }
  if (ink.outside > 0) problems.push(`${ink.outside} px inked outside every region`);
  return problems;
}

/** pt-lifecycle: a receiver lights exactly the cells the reference lights. */
export function ptLifecycleProblems(
  leg: { cells: Record<string, number> },
  ref: { cells: Record<string, number> },
): string[] {
  const problems: string[] = [];
  for (const [cell, r] of Object.entries(ref.cells)) {
    const n = leg.cells[cell] ?? 0;
    if (r > 0 && n === 0) problems.push(`${cell} is dark (reference ${r} px)`);
    if (r === 0 && n > 0) problems.push(`${cell}: ${n} px inked (reference dark)`);
  }
  return problems;
}

/** pt-coverage: each cell lit in both is within the band of the reference's ink. */
export function ptCoverageProblems(
  leg: { cells: Record<string, number> },
  ref: { cells: Record<string, number> },
  band: number,
): string[] {
  const problems: string[] = [];
  for (const [cell, r] of Object.entries(ref.cells)) {
    const n = leg.cells[cell] ?? 0;
    if (r === 0 || n === 0) continue;
    if (n < r / band || n > r * band) problems.push(`${cell}: ${n} px against the reference's ${r} (band x${band})`);
  }
  return problems;
}

/** The w11.particles totals of a receiver's applied.json (render-stream-12.md "As built (PM6a)"). */
export function particlesTotals(applied: Record<string, unknown> | null): Record<string, number> | null {
  const w11 = (applied?.w11 ?? (applied?.report as Record<string, unknown> | undefined)?.w11) as Record<string, unknown> | undefined;
  const p = w11?.particles;
  if (!p || typeof p !== "object") return null;
  return Object.fromEntries(Object.entries(p as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number>;
}

/** What pt-replay expects of a receiver that replayed a whole /12 recording from its first
 * transaction: one emitter per resolved emitter drawn, the summed final `restarts` of those, the
 * wire's emits on them. */
export interface PtWireTotals {
  emitters: number;
  restarts: number;
  emits: number;
  seeds: number;
}

export function ptReplayProblems(t: Record<string, number> | null, want: PtWireTotals, undrawn: number): string[] {
  if (!t) return ["no w11.particles in applied.json (no emitter made)"];
  const problems: string[] = [];
  const v = (k: string) => t[k] ?? 0;
  if (v("particles_created") !== want.emitters) problems.push(`${v("particles_created")} emitters made, ${want.emitters} on the wire`);
  if (v("restarts") !== want.restarts) problems.push(`${v("restarts")} particles_restart, the wire's restarts sum to ${want.restarts}`);
  if (v("emits") !== want.emits) problems.push(`${v("emits")} particles_emit, ${want.emits} wire emits`);
  if (v("emits_dropped") !== 0) problems.push(`${v("emits_dropped")} emits dropped`);
  if (v("seed_sets") < want.seeds) problems.push(`${v("seed_sets")} seed sets, at least ${want.seeds} wanted`);
  if (v("skipped_particles_commands") !== 0) problems.push(`${v("skipped_particles_commands")} add_particles skipped`);
  if (undrawn !== 0) problems.push(`${undrawn} add_particles undrawn`);
  return problems;
}

const RECEIVERS = ["receiver", "receiver-patch"];

export async function runG8ptReceivers(
  g: string,
  checkpoints: readonly { step: number; settle: number }[],
  px: PtPixels,
  wire: PtWireTotals | null,
  checks: G8aCheck[],
  report: Record<string, unknown>,
): Promise<void> {
  const shots = ptShots(checkpoints, px.tail_frames);
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => !skipped(dir(leg)) && (readdirSafe(dir(leg)).includes("exit-code.txt"));
  const refShot = (leg: string, label: string) => decodePngRgba(join(dir(leg), "shots", `${label}.png`));
  /** A receiver leg's shots by label: its seq-<n>.png in ascending seq order are the shots in
   * frame order (run-gate8.sh shoots one published seq per shot frame). */
  const legShots = async (leg: string): Promise<Map<string, Rgba | undefined> | string> => {
    const seqs = readdirSafe(join(dir(leg), "shots"))
      .map((n) => /^seq-(\d+)\.png$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    if (seqs.length !== shots.length) return `${seqs.length} shots, ${shots.length} wanted`;
    const out = new Map<string, Rgba | undefined>();
    for (let i = 0; i < shots.length; i++) out.set(shots[i].label, await decodePngRgba(join(dir(leg), "shots", `seq-${seqs[i]}.png`)));
    return out;
  };
  const appliedOf = async (leg: string) => {
    try {
      return JSON.parse((await readText(join(dir(leg), "applied.json"))) ?? "null") as Record<string, unknown> | null;
    } catch {
      return null;
    }
  };
  const pixels: Record<string, unknown> = {};
  report.pixels = pixels;

  // The reference's ink per shot.
  const refInk = new Map<string, { cells: Record<string, number>; outside: number }>();
  const refImg = new Map<string, Rgba>();
  if (ran("reference"))
    for (const s of shots) {
      const img = await refShot("reference", s.label);
      if (img) {
        refImg.set(s.label, img);
        refInk.set(s.label, ptInk(img, px));
      }
    }
  pixels.reference_ink = Object.fromEntries(refInk);

  // --- pt-premise -----------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran("reference")) {
      problems = [];
      for (const s of shots) {
        const ink = refInk.get(s.label);
        if (!ink) problems.push(`reference ${s.label}: no shot`);
        else for (const p of ptPremiseProblems(ink, px, s.label)) problems.push(`reference ${s.label}: ${p}`);
      }
      if (ran("reference-repeat")) {
        const repeat: Record<string, unknown> = {};
        let exact = 0;
        for (const s of shots) {
          const a = await refShot("reference-repeat", s.label);
          const b = refImg.get(s.label);
          const d = a && b ? mmCellDiff(a, b, px.regions) : null;
          if (!d) {
            problems.push(`reference-repeat ${s.label}: shot missing`);
            continue;
          }
          repeat[s.label] = d;
          if (d.outside > 0) problems.push(`reference-repeat ${s.label}: ${d.outside} px differ outside every region`);
          if (Object.values(d.cells).every((n) => n === 0)) exact++;
        }
        pixels.reference_repeat = repeat;
        detail = `reference-repeat equals the reference exactly at ${exact} of ${shots.length} shots`;
      } else problems.push("reference-repeat did not run");
    }
    checks.push(
      check(
        "pt-premise",
        "PM6a: the unarmed reference inks every emitting cell at every shot, D_ONESHOT dark before its first restart and one lifetime after its last, nothing outside the regions; reference-repeat equals it outside them",
        problems,
        detail,
      ),
    );
  }

  /** A receiver leg's per-shot ink and exact diff against the reference. */
  const judge = async (leg: string) => {
    const got = await legShots(leg);
    if (typeof got === "string") return got;
    const rows: { label: string; ink: { cells: Record<string, number>; outside: number }; diff: ReturnType<typeof mmCellDiff> }[] = [];
    for (const s of shots) {
      const img = got.get(s.label);
      const ref = refImg.get(s.label);
      if (!img || !ref) return `${s.label}: shot missing`;
      rows.push({ label: s.label, ink: ptInk(img, px), diff: mmCellDiff(img, ref, px.regions) });
    }
    pixels[leg] = rows;
    return rows;
  };

  const lifecycle = async (leg: string) => {
    const rows = await judge(leg);
    if (typeof rows === "string") return { problems: [`${leg}: ${rows}`], rows: null };
    const problems: string[] = [];
    for (const r of rows) {
      const ref = refInk.get(r.label);
      if (!ref) continue;
      for (const p of ptLifecycleProblems(r.ink, ref)) problems.push(`${leg} ${r.label}: ${p}`);
    }
    return { problems, rows };
  };

  // --- pt-lifecycle, pt-coverage, pt-outside-exact, pt-lockstep -------------------------------
  {
    const lc: string[] = [];
    const cov: string[] = [];
    const out: string[] = [];
    const lock: Record<string, unknown> = {};
    let any = false;
    let ratios: number[] = [];
    for (const leg of RECEIVERS) {
      if (!ran(leg) || !ran("reference")) continue;
      any = true;
      const { problems, rows } = await lifecycle(leg);
      lc.push(...problems);
      if (!rows) continue;
      let exactCells = 0;
      let cells = 0;
      for (const r of rows) {
        const ref = refInk.get(r.label);
        if (!ref) continue;
        for (const p of ptCoverageProblems(r.ink, ref, px.coverage_band)) cov.push(`${leg} ${r.label}: ${p}`);
        for (const [cell, n] of Object.entries(ref.cells)) if (n > 0 && (r.ink.cells[cell] ?? 0) > 0) ratios.push((r.ink.cells[cell] ?? 0) / n);
        if (!r.diff) out.push(`${leg} ${r.label}: size differs`);
        else {
          if (r.diff.outside > 0) out.push(`${leg} ${r.label}: ${r.diff.outside} px differ outside every region`);
          for (const n of Object.values(r.diff.cells)) {
            cells++;
            if (n === 0) exactCells++;
          }
        }
      }
      lock[leg] = { exact_cells: exactCells, cells, per_shot: rows.map((r) => ({ shot: r.label, ...(r.diff ?? {}) })) };
    }
    ratios = ratios.sort((a, b) => a - b);
    const ratioNote =
      ratios.length > 0 ? `ink ratio to the reference: min ${ratios[0].toFixed(2)}, median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}, max ${ratios.at(-1)?.toFixed(2)}` : undefined;
    checks.push(
      check(
        "pt-lifecycle",
        "PM6a: every receiver leg lights exactly the cells the reference lights at every shot (D_ONESHOT dark before its first restart, lit after each, still lit at 95, dark one lifetime after its last restart)",
        any ? lc : null,
      ),
    );
    checks.push(
      check(
        "pt-coverage",
        `PM6a (banded): each cell lit in both has ink within x${px.coverage_band} of the reference's at every shot`,
        any ? cov : null,
        ratioNote,
      ),
    );
    checks.push(check("pt-outside-exact", "PM6a: outside every emitter region each receiver leg equals the reference exactly at every shot", any ? out : null));
    const lockDetail = Object.entries(lock)
      .map(([leg, v]) => `${leg}: ${(v as { exact_cells: number }).exact_cells} of ${(v as { cells: number }).cells} cell-shots exact`)
      .join("; ");
    report.lockstep = lock;
    checks.push({
      id: "pt-lockstep",
      criterion: "PM6a (informational): the receivers' particle pixels against the reference's, exactly, per cell and shot (both run --fixed-fps 60, one transaction a frame)",
      passed: true,
      status: any ? "pass" : "not-run",
      detail: any ? `measured: ${lockDetail}` : "no receiver leg ran",
      gating: false,
    });
  }

  // --- pt-replay --------------------------------------------------------------------------------
  const replayOf = async (leg: string) => {
    const applied = await appliedOf(leg);
    const stdout = ((await readText(join(dir(leg), "stdout.log"))) ?? "") + ((await readText(join(dir(leg), "stderr.log"))) ?? "");
    const problems: string[] = [];
    if (!applied) return { problems: ["no applied.json"], totals: null };
    if (applied.status !== "ok") problems.push(`applied.json status ${String(applied.status)}`);
    const totals = particlesTotals(applied);
    const w11 = (applied.w11 ?? {}) as Record<string, unknown>;
    const undrawn = typeof w11.particles_undrawn === "number" ? w11.particles_undrawn : 0;
    if (wire) problems.push(...ptReplayProblems(totals, wire, undrawn));
    else problems.push("no /12 capture to count against");
    if (stdout.includes("particles_set_seed probe failed")) problems.push("the particles_set_seed probe failed (seeds unset)");
    return { problems, totals };
  };
  {
    const problems: string[] = [];
    let any = false;
    const totals: Record<string, unknown> = {};
    for (const leg of RECEIVERS) {
      if (!ran(leg)) continue;
      any = true;
      const r = await replayOf(leg);
      totals[leg] = r.totals;
      for (const p of r.problems) problems.push(`${leg}: ${p}`);
    }
    report.replay = totals;
    checks.push(
      check(
        "pt-replay",
        "PM6a: each receiver made one emitter per emitter the items draw, set every seed (the probed particles_set_seed slot), restarted each as often as the wire's restarts, replayed every wire emit, dropped none and left no add_particles undrawn",
        any ? problems : null,
        wire ? `wire: ${wire.emitters} emitters, ${wire.restarts} restarts, ${wire.emits} emits` : undefined,
      ),
    );
  }

  // --- the sabotages --------------------------------------------------------------------------
  const catches = async (id: string, leg: string, criterion: string, judgeLeg: () => Promise<string[]>) => {
    if (skipped(dir(leg))) {
      checks.push({ id, criterion, passed: true, status: "not-run", detail: `skipped: ${leg}`, gating: false });
      return;
    }
    if (!ran(leg) || !ran("reference")) {
      checks.push(check(id, criterion, null));
      return;
    }
    const problems = await judgeLeg();
    checks.push(check(id, criterion, problems.length > 0 ? [] : [`${leg} passed: the sabotage went unseen`], problems[0]));
  };
  await catches(
    "pt-lifecycle-catches-drop-restart",
    "sabotage-drop-restart/receiver-patch",
    "PM6a: the receiver on PM5's drop-restart patch sink (D_ONESHOT's restart at 40 not on the wire) fails pt-lifecycle",
    async () => (await lifecycle("sabotage-drop-restart/receiver-patch")).problems,
  );
  await catches(
    "pt-lifecycle-catches-undrawn-particles",
    "sabotage-undrawn-particles/receiver",
    "PM6a: the pre-PM6 planner (receiver sabotage undrawn-particles) fails pt-lifecycle",
    async () => (await lifecycle("sabotage-undrawn-particles/receiver")).problems,
  );
  await catches(
    "pt-replay-catches-ignore-particle-emits",
    "sabotage-ignore-particle-emits/receiver",
    "PM6a: a receiver that ignores particle_emits (receiver sabotage ignore-particle-emits) fails pt-replay",
    async () => (await replayOf("sabotage-ignore-particle-emits/receiver")).problems,
  );
}

/** The two burst cells FRZ-P freezes (results/p3/frz-p.md): A_BOX (looping) and D_ONESHOT (one-shot). */
const FRZP_CELLS = ["A_BOX", "D_ONESHOT"];

/** FRZ-P: a frozen seat's one-shot and looping bursts must replay shot-equal to the reference (the
 * wire still carries the emitter config + restart/emit events, and the nudge ends the one-shot).
 * `frzp/receiver` (native, and g7-8's GSW half replays the same leg) is judged against the
 * reference; `sabotage-freeze-drop-events/receiver` (the events dropped) must differ. */
export async function runG8ptFrzp(
  g: string,
  checkpoints: readonly { step: number; settle: number }[],
  px: PtPixels,
  checks: G8aCheck[],
  report: Record<string, unknown>,
): Promise<void> {
  const shots = ptShots(checkpoints, px.tail_frames);
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => !skipped(dir(leg)) && readdirSafe(dir(leg)).includes("exit-code.txt");

  const legShots = async (leg: string): Promise<Map<string, Rgba | undefined> | string> => {
    const seqs = readdirSafe(join(dir(leg), "shots"))
      .map((n) => /^seq-(\d+)\.png$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    if (seqs.length !== shots.length) return `${seqs.length} shots, ${shots.length} wanted`;
    const out = new Map<string, Rgba | undefined>();
    for (let i = 0; i < shots.length; i++) out.set(shots[i].label, await decodePngRgba(join(dir(leg), "shots", `seq-${seqs[i]}.png`)));
    return out;
  };

  /** The frozen cells' ink per shot, compared to the reference's (lit/dark and band). */
  const frozenCells = (img: Rgba): Record<string, number> => {
    const ink = ptInk(img, px);
    const cells: Record<string, number> = {};
    for (const c of FRZP_CELLS) cells[c] = ink.cells[c] ?? 0;
    return cells;
  };

  const refCells = new Map<string, Record<string, number>>();
  if (ran("reference")) {
    for (const s of shots) {
      const img = await decodePngRgba(join(dir("reference"), "shots", `${s.label}.png`));
      if (img) refCells.set(s.label, frozenCells(img));
    }
  }

  const judge = async (leg: string): Promise<{ problems: string[]; rows: Record<string, unknown> | null }> => {
    const got = await legShots(leg);
    if (typeof got === "string") return { problems: [`${leg}: ${got}`], rows: null };
    const problems: string[] = [];
    const rows: Record<string, unknown> = {};
    for (const s of shots) {
      const ref = refCells.get(s.label);
      const img = got.get(s.label);
      if (!ref || !img) {
        problems.push(`${leg} ${s.label}: shot missing`);
        continue;
      }
      const cells = frozenCells(img);
      rows[s.label] = cells;
      // lit/dark, then the band on cells lit in both.
      for (const c of FRZP_CELLS) {
        const r = ref[c] ?? 0;
        const n = cells[c] ?? 0;
        if (r > 0 && n === 0) problems.push(`${leg} ${s.label}: ${c} dark (reference ${r} px)`);
        if (r === 0 && n > 0) problems.push(`${leg} ${s.label}: ${c} ${n} px inked (reference dark)`);
        if (r > 0 && n > 0 && (n < r / px.coverage_band || n > r * px.coverage_band)) {
          problems.push(`${leg} ${s.label}: ${c} ${n} px against the reference's ${r} (band x${px.coverage_band})`);
        }
      }
    }
    return { problems, rows };
  };

  {
    let problems: string[] | null = null;
    if (ran("frzp/receiver")) {
      const r = await judge("frzp/receiver");
      report.receiver = r.rows;
      problems = r.problems;
    }
    checks.push(
      check(
        "frzp-frozen-burst",
        "FRZ-P: a frozen seat's A_BOX (looping) and D_ONESHOT (one-shot) bursts replay shot-equal to the reference (lit/dark and the coverage band), so the freeze costs the stream nothing",
        ran("frzp/receiver") ? problems : null,
        ran("frzp/receiver") && problems && problems.length === 0 ? "A_BOX and D_ONESHOT equal the reference at every shot" : undefined,
      ),
    );
  }

  // freeze-drop-events: the events dropped, so the burst cannot replay.
  {
    const leg = "sabotage-freeze-drop-events/receiver";
    if (skipped(dir(leg))) {
      checks.push({ id: "frzp-catches-freeze-drop-events", criterion: "FRZ-P: the frozen seat's dropped restart/emit events fail the burst", passed: true, status: "not-run", detail: `skipped: ${leg}`, gating: false });
    } else if (!ran(leg) || !ran("reference")) {
      checks.push(check("frzp-catches-freeze-drop-events", "FRZ-P: the frozen seat's dropped restart/emit events fail the burst", null));
    } else {
      const r = await judge(leg);
      report.drop_events = r.rows;
      const caught = r.problems;
      checks.push(check("frzp-catches-freeze-drop-events", "FRZ-P: the frozen seat's dropped restart/emit events fail the burst", caught.length > 0 ? [] : [`${leg} passed: the sabotage went unseen`], caught[0]));
    }
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
