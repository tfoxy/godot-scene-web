// Gate 7 G7d checks (protocol/gate7-design.md "G7d" Checks): groups g7-dev and g7-bench of
// check-gate7.ts. Every check reads evidence run-gate7.sh wrote; none launches anything.
//
// g7-dev (desktop): the plan selects only `ctl-` arms; the pace fixture's native legs: the capture
//   (both sinks validate, 400 transactions at frames 1..400, every transaction after the first one
//   transform patch whose translation is the model's x(f)), expected.json re-derived from its own
//   model, the rendered reference's 8 shots and both rendered receivers' shots exact (0 px) against
//   the model's synthesized frames and against each other, the receivers' applied.json `ok` with no
//   typed unsupported entry.
// g7-dev (device): that device's plan; the device session: device-provenance, the D28 session
//   settings restored, the adb and page probes written.
// g7-bench: the inputs; bench-matches-g6c (native, scene-full: decode and apply means within
//   +-15 % of G6c's unloaded replay means); each arm (native, gsw and, since G7e/G7m, web) complete
//   for every input with five valid repeats; desktop browser-provenance (gsw and web) and a
//   cross-origin-isolated timer (gsw); on a device, device-provenance and the watchdog. Q13e's
//   decision per receiver and input is recorded (a `device-decode-over-budget` is a finding, not a
//   failure).

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  decodeRecording,
  resolveRecording,
  type TransactionMeta,
  validateRecording,
} from "./render-stream-2";

export interface Gate7Check {
  id: string;
  ok: boolean;
  detail: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------ pace

export interface PaceExpected {
  schema: string;
  model: {
    root_size: [number, number];
    clear_rgba8: number[];
    square: {
      size: number;
      y: number;
      x0: number;
      span: number;
      quadrants_rgba8: Record<"tl" | "tr" | "bl" | "br", number[]>;
    };
    transactions: number;
    first_frame: number;
  };
  steps: {
    step: number;
    frame: number;
    x: number;
    y: number;
    markers: { name: string; xy: [number, number]; rgba: number[] }[];
  }[];
}

export const PACE_EXPECTED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "gate7-pace",
  "expected.json",
);

export function paceX(e: PaceExpected, frame: number): number {
  return (frame + e.model.square.x0) % e.model.square.span;
}

/** The model's exact frame at host frame `frame`: the clear colour, and the square's quadrants. */
export function synthesizePaceFrame(
  e: PaceExpected,
  frame: number,
): Uint8Array {
  const [w, h] = e.model.root_size;
  const out = new Uint8Array(w * h * 4);
  const { size, y, quadrants_rgba8: q } = e.model.square;
  const x = paceX(e, frame);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      let c = e.model.clear_rgba8;
      if (px >= x && px < x + size && py >= y && py < y + size) {
        const right = px - x >= size / 2;
        const bottom = py - y >= size / 2;
        c = bottom ? (right ? q.br : q.bl) : right ? q.tr : q.tl;
      }
      out.set(c, (py * w + px) * 4);
    }
  return out;
}

/** expected.json's per-step fields re-derived from its own model (a hand edit cannot drift). */
export function checkPaceExpectedConsistent(e: PaceExpected): string[] {
  const problems: string[] = [];
  for (const s of e.steps) {
    if (s.x !== paceX(e, s.frame))
      problems.push(
        `step ${s.step}: x ${s.x} != x(${s.frame}) ${paceX(e, s.frame)}`,
      );
    if (s.y !== e.model.square.y) problems.push(`step ${s.step}: y ${s.y}`);
    const frame = synthesizePaceFrame(e, s.frame);
    const w = e.model.root_size[0];
    for (const m of s.markers) {
      const i = (m.xy[1] * w + m.xy[0]) * 4;
      const got = Array.from(frame.subarray(i, i + 4));
      if (got.join() !== m.rgba.join())
        problems.push(
          `step ${s.step} marker ${m.name}: model ${got} != ${m.rgba}`,
        );
    }
  }
  return problems;
}

function diffCount(
  a: Uint8Array,
  b: Uint8Array,
): { pixels: number; maxDelta: number } {
  let pixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (d > 0) pixels++;
    maxDelta = Math.max(maxDelta, d);
  }
  return { pixels: pixels + Math.abs(a.length - b.length) / 4, maxDelta };
}

/** The pace capture's patch rule: transaction 1 is full; every later one is a patch naming exactly
 * one item with unchanged commands, no canvases, textures or removals; its resolved translation is
 * (x(f), y). */
export function checkPacePatchRule(
  e: PaceExpected,
  patch: Uint8Array,
): string[] {
  const problems: string[] = [];
  const decoded = decodeRecording(patch);
  const resolved = resolveRecording(patch);
  const txs = decoded.records
    .map((r) => r.meta)
    .filter((m): m is TransactionMeta => m.type === "transaction");
  if (txs.length !== e.model.transactions)
    problems.push(
      `${txs.length} transactions, expected ${e.model.transactions}`,
    );
  txs.forEach((m, k) => {
    if (m.frame !== k + e.model.first_frame)
      problems.push(`seq ${m.seq} at frame ${m.frame}, expected ${k + 1}`);
    if (k === 0) {
      if (m.encoding !== "full") problems.push("transaction 1 is not full");
      return;
    }
    const removed = [
      ...m.removed_canvases,
      ...m.removed_items,
      ...m.removed_textures,
      ...(m.removed_meshes ?? []),
      ...(m.removed_shaders ?? []),
      ...(m.removed_materials ?? []),
    ];
    if (
      m.encoding !== "patch" ||
      m.items.length !== 1 ||
      m.items[0].commands !== null ||
      m.canvases.length !== 0 ||
      m.textures.length !== 0 ||
      (m.meshes ?? []).length !== 0 ||
      (m.materials ?? []).length !== 0 ||
      removed.length !== 0
    )
      problems.push(
        `seq ${m.seq}: not one transform patch (encoding ${m.encoding}, ${m.items.length} items, commands ${m.items[0]?.commands === null ? "unchanged" : "changed"}, ${m.canvases.length} canvases, ${m.textures.length} textures, ${removed.length} removals)`,
      );
  });
  for (const t of resolved.transactions) {
    const sprite = t.state.items.find((it) => it.commands.length > 0);
    const x = paceX(e, t.frame);
    if (
      !sprite ||
      sprite.xform[4] !== x ||
      sprite.xform[5] !== e.model.square.y
    )
      problems.push(
        `seq ${t.seq} frame ${t.frame}: translation ${sprite ? `${sprite.xform[4]},${sprite.xform[5]}` : "no sprite"}, expected ${x},${e.model.square.y}`,
      );
  }
  return problems.slice(0, 12);
}

async function exitCode(dir: string): Promise<string | null> {
  return (await readText(join(dir, "exit-code.txt")))?.trim() ?? null;
}

export async function shotChecks(
  e: PaceExpected,
  label: string,
  shots: { step: number; frame: number; path: string }[],
  reference: Map<number, Uint8Array> | null,
): Promise<Gate7Check[]> {
  const mismatches: string[] = [];
  const vsRef: string[] = [];
  let compared = 0;
  for (const s of shots) {
    const png = await decodePngRgba(s.path);
    if (!png) {
      mismatches.push(`step ${s.step}: no shot at ${s.path}`);
      continue;
    }
    compared++;
    const d = diffCount(png.data, synthesizePaceFrame(e, s.frame));
    if (d.pixels > 0)
      mismatches.push(
        `step ${s.step} (frame ${s.frame}): ${d.pixels} px differ from the model (max delta ${d.maxDelta})`,
      );
    const ref = reference?.get(s.step);
    if (reference) {
      if (!ref) vsRef.push(`step ${s.step}: no reference shot`);
      else {
        const r = diffCount(png.data, ref);
        if (r.pixels > 0)
          vsRef.push(
            `step ${s.step}: ${r.pixels} px differ from the reference`,
          );
      }
    }
  }
  const out: Gate7Check[] = [
    {
      id: `${label}-exact-vs-model`,
      ok: mismatches.length === 0 && compared === e.steps.length,
      detail: mismatches.length
        ? mismatches.slice(0, 4).join("; ")
        : `${compared}/${e.steps.length} shots, 0 px from the synthesized model frames (presence and freshness markers hold)`,
    },
  ];
  if (reference)
    out.push({
      id: `${label}-vs-reference`,
      ok: vsRef.length === 0 && compared === e.steps.length,
      detail: vsRef.length
        ? vsRef.slice(0, 4).join("; ")
        : `${compared} shots, 0 px from the rendered reference`,
    });
  return out;
}

export async function runGate7DevChecks(
  out: string,
  device: string | null,
): Promise<Gate7Check[]> {
  const checks: Gate7Check[] = [];
  const G = join(out, "g7-dev");
  const plan = await readJson<{
    legs: { name: string; arm: string; device: string | null }[];
  }>(join(G, "plan.json"));
  if (device === null) {
    checks.push({
      id: "g7-dev-plan-ctl-only",
      ok:
        !!plan &&
        plan.legs.length > 0 &&
        plan.legs.every((l) => l.arm === "ctl" && l.name.startsWith("ctl-")),
      detail: plan
        ? `${plan.legs.length} legs, all ctl- (no --env device)`
        : "no plan.json",
    });
  } else {
    const dev = plan?.legs.filter((l) => l.arm === "dev") ?? [];
    checks.push({
      id: "g7-dev-plan-device",
      ok: dev.length > 0 && dev.every((l) => l.device === device),
      detail: `${dev.length} dev- legs for ${device}, ${(plan?.legs.length ?? 0) - dev.length} ctl- arms`,
    });
    const D = join(G, `dev-session-${device}`);
    const arm = await readJson<{
      status: string;
      reason?: string;
      detail?: string;
    }>(join(D, `gsw-device-${device}.json`));
    const prov = await readJson<{
      ok: boolean;
      reasons: string[];
      notes: string[];
      renderer: string | null;
    }>(join(D, `device-provenance-${device}.json`));
    const settings = await readJson<{
      changes: unknown[];
      restored_at: string | null;
      restore_errors: string[];
    } | null>(join(D, `session-settings-${device}.json`));
    checks.push({
      id: "device-session",
      ok: arm?.status === "success",
      detail: arm
        ? `${arm.status}${arm.reason ? ` (${arm.reason}: ${arm.detail})` : ""}`
        : "no arm record",
    });
    checks.push({
      id: "device-provenance",
      ok: prov?.ok === true,
      detail: prov
        ? `${prov.renderer}; ${[...prov.reasons, ...prov.notes].join("; ")}`
        : "no device-provenance record",
    });
    checks.push({
      id: "device-session-settings-restored",
      ok:
        settings === null
          ? true
          : !!settings &&
            settings.restored_at !== null &&
            settings.restore_errors.length === 0,
      detail: settings
        ? `${settings.changes.length} change(s) restored at ${settings.restored_at}`
        : "no session settings for this device",
    });
    checks.push({
      id: "device-probes-written",
      ok:
        existsSync(join(D, `device-adb-probes-${device}.json`)) &&
        existsSync(join(D, "evidence")),
      detail: "adb and page probes",
    });
    return checks;
  }

  const e = await readJson<PaceExpected>(PACE_EXPECTED_PATH);
  if (!e)
    return [
      ...checks,
      { id: "pace-expected", ok: false, detail: `no ${PACE_EXPECTED_PATH}` },
    ];
  const consistency = checkPaceExpectedConsistent(e);
  checks.push({
    id: "pace-expected-consistent",
    ok: consistency.length === 0,
    detail: consistency.length
      ? consistency.slice(0, 3).join("; ")
      : `${e.steps.length} steps re-derived from the model`,
  });
  const P = join(G, "pace");
  const full = existsSync(join(P, "capture", "recording.rs2"))
    ? new Uint8Array(await readFile(join(P, "capture", "recording.rs2")))
    : null;
  const patch = existsSync(join(P, "capture", "recording-patch.rs2"))
    ? new Uint8Array(await readFile(join(P, "capture", "recording-patch.rs2")))
    : null;
  const fullErrors = full ? validateRecording(full) : ["missing"];
  const patchErrors = patch ? validateRecording(patch) : ["missing"];
  checks.push({
    id: "pace-capture-success",
    ok:
      (await exitCode(join(P, "capture"))) === "0" &&
      fullErrors.length === 0 &&
      patchErrors.length === 0,
    detail: `exit ${await exitCode(join(P, "capture"))}; full ${fullErrors[0] ?? "valid"}; patch ${patchErrors[0] ?? "valid"}${full ? `; ${full.length} / ${patch?.length ?? 0} bytes` : ""}`,
  });
  if (patch && patchErrors.length === 0) {
    const rule = checkPacePatchRule(e, patch);
    checks.push({
      id: "pace-one-transform-patch",
      ok: rule.length === 0,
      detail: rule.length
        ? rule.join("; ")
        : `${e.model.transactions} transactions: one full, then ${e.model.transactions - 1} single-item transform patches at x(f)`,
    });
  }
  const refShots = new Map<number, Uint8Array>();
  for (const s of e.steps) {
    const png = await decodePngRgba(
      join(P, "reference", "shots", `step-${s.step}.png`),
    );
    if (png) refShots.set(s.step, png.data);
  }
  checks.push({
    id: "pace-reference-exit",
    ok: (await exitCode(join(P, "reference"))) === "0",
    detail: `exit ${await exitCode(join(P, "reference"))}`,
  });
  checks.push(
    ...(await shotChecks(
      e,
      "pace-reference",
      e.steps.map((s) => ({
        step: s.step,
        frame: s.frame,
        path: join(P, "reference", "shots", `step-${s.step}.png`),
      })),
      null,
    )),
  );
  for (const leg of ["receiver", "receiver-patch"]) {
    const dir = join(P, leg);
    const applied = await readJson<{
      status: string;
      unsupported?: unknown[];
      shots?: { seq: number }[];
    }>(join(dir, "applied.json"));
    const seqs = ((await readText(join(dir, "shot-seqs.txt"))) ?? "")
      .trim()
      .split(",")
      .filter(Boolean)
      .map(Number);
    checks.push({
      id: `pace-${leg}-applied-ok`,
      ok:
        (await exitCode(dir)) === "0" &&
        applied?.status === "ok" &&
        (applied.unsupported ?? []).length === 0,
      detail: `exit ${await exitCode(dir)}, status ${applied?.status ?? "missing"}, ${(applied?.unsupported ?? []).length} unsupported`,
    });
    const shots = e.steps.map((s, k) => ({
      step: s.step,
      frame: s.frame,
      path: join(dir, "shots", `seq-${seqs[k] ?? -1}.png`),
    }));
    checks.push(...(await shotChecks(e, `pace-${leg}`, shots, refShots)));
  }
  return checks;
}

// ------------------------------------------------------------------------------------------ bench

/** G6c README "Gate 6c result", "Receiver cost unchanged": the four unloaded 400-transaction replay
 * means (main and branch, two rounds against 02e6f4dc). */
export const G6C_REPLAY = {
  decode_means_us: [6193, 6479, 6247, 6212],
  apply_means_us: [885, 898, 897, 878],
};

/** Since G7xd the native arm runs the Rust core (G7gd removed the GDScript one), so G6c's GDScript
 * means can no longer be matched: `bench-matches-g6c` bounds the Rust core's scene-full means at a
 * tenth (decode) and a quarter (apply) of them instead. G7xn measured 40x and 11x at p95, so this
 * holds at twice that cost and fails a bench that lost the Rust core or its transactions. */
export const G6C_RUST_MAX_FRACTION = { decode: 0.1, apply: 0.25 };

/** The leg directories gate7-bench.ts writes for one planned arm-leg (gate7-dev-legs.ts names the
 * plan): the planned name, then the arm renames since G7d planned them. G7a named the TypeScript arm
 * `-gsw-ts`; G7xd's Rust default names native legs `native-rs-bench-*` and web legs `-web-rs`. */
export function benchLegNames(planned: string): string[] {
  return [
    planned,
    planned.replace(/^native-bench-/, "native-rs-bench-"),
    planned.replace(/-gsw(-|$)/, "-gsw-ts$1"),
    planned.replace(/-web(-|$)/, "-web-rs$1"),
  ];
}

export interface BenchLegJson {
  leg: string;
  status: string;
  reason?: string;
  detail?: string;
  summary?: {
    input: string;
    transactions: number;
    repeats: {
      valid: boolean;
      watchdog_reasons: string[];
      error: string | null;
    }[];
    phases: Record<
      string,
      {
        mean_us: number;
        p50_us: number;
        p95_us: number;
        max_us: number;
        count: number;
      }
    >;
    total_p95_us: number | null;
    tp_ms: number | null;
    notes: string[];
  };
  decision?: { verdict: string; detail: string };
  provenance?: {
    kind: string;
    ok: boolean;
    reasons: string[];
    renderer: string | null;
  };
}

export interface BenchTableRow {
  leg: string;
  receiver: string;
  input: string;
  phases: Record<string, { p50_us: number; p95_us: number; mean_us: number }>;
  total_p95_us: number | null;
  verdict: string | null;
}

export async function loadBenchLegs(out: string): Promise<BenchLegJson[]> {
  const B = join(out, "g7-bench");
  if (!existsSync(B)) return [];
  const legs: BenchLegJson[] = [];
  for (const name of (await readdir(B)).sort()) {
    if (!/^(native|native-rs|ctl|dev)-bench-/.test(name)) continue;
    const json = await readJson<BenchLegJson>(join(B, name, "summary.json"));
    if (json) legs.push(json);
  }
  return legs;
}

export async function runGate7BenchChecks(
  out: string,
  device: string | null,
  receiver: string | null,
): Promise<{ checks: Gate7Check[]; table: BenchTableRow[] }> {
  const checks: Gate7Check[] = [];
  const B = join(out, "g7-bench");
  const plan = await readJson<{
    legs: { name: string; arm: string; kind: string }[];
  }>(join(B, "plan.json"));
  const legs = await loadBenchLegs(out);
  const byName = new Map(legs.map((l) => [l.leg, l]));
  const wanted = (plan?.legs ?? []).filter(
    (l) => !receiver || l.kind === receiver,
  );
  checks.push({
    id: "bench-plan",
    ok:
      wanted.length > 0 &&
      (device === null
        ? wanted.every((l) => l.arm !== "dev")
        : wanted.every((l) => l.arm === "dev")),
    detail: `${wanted.length} arm-legs planned${device ? ` on ${device}` : " (desktop)"}${receiver ? ` for ${receiver}` : ""}`,
  });
  const lookup = (planned: string) =>
    benchLegNames(planned)
      .map((n) => byName.get(n))
      .find((l) => l !== undefined);
  for (const p of wanted) {
    const leg = lookup(p.name);
    const s = leg?.summary;
    const valid = s?.repeats.filter((r) => r.valid).length ?? 0;
    checks.push({
      id: `${p.name}-complete`,
      ok:
        leg?.status === "success" && valid === 5 && (s?.transactions ?? 0) > 0,
      detail: s
        ? `${valid}/5 valid repeats, ${s.transactions} transactions; ${leg?.decision?.verdict}: ${leg?.decision?.detail}${s.notes.length ? `; ${s.notes.join("; ")}` : ""}`
        : `no summary (${leg?.status ?? "missing"})`,
    });
  }
  const native = lookup("native-bench-scene-full");
  if (device === null && (!receiver || receiver === "native")) {
    const ph = native?.summary?.phases;
    const ref = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const dRef = ref(G6C_REPLAY.decode_means_us);
    const aRef = ref(G6C_REPLAY.apply_means_us);
    const dMax = G6C_RUST_MAX_FRACTION.decode * dRef;
    const aMax = G6C_RUST_MAX_FRACTION.apply * aRef;
    const under = (v: number | undefined, max: number) =>
      v !== undefined && v > 0 && v <= max;
    checks.push({
      id: "bench-matches-g6c",
      ok: under(ph?.decode?.mean_us, dMax) && under(ph?.apply?.mean_us, aMax),
      detail: ph
        ? `rust scene-full decode mean ${ph.decode?.mean_us.toFixed(0)} us (<= ${dMax.toFixed(0)}: G6c's GDScript ${dRef.toFixed(0)} / 10), apply mean ${ph.apply?.mean_us.toFixed(0)} us (<= ${aMax.toFixed(0)}: G6c ${aRef.toFixed(0)} / 4)`
        : "no native scene-full summary",
    });
  }
  if (!receiver || receiver === "gsw") {
    const gsw = legs.filter(
      (l) => /-gsw/.test(l.leg) && l.status === "success",
    );
    const prov = gsw[0]?.provenance;
    checks.push({
      id:
        device === null
          ? "bench-gsw-browser-provenance"
          : "bench-gsw-device-provenance",
      ok: gsw.length > 0 && gsw.every((l) => l.provenance?.ok === true),
      detail: prov ? `${prov.kind}: ${prov.renderer}` : "no gsw leg",
    });
    checks.push({
      id: "bench-gsw-timer-isolated",
      ok:
        gsw.length > 0 &&
        gsw.every(
          (l) =>
            !(l.summary?.notes ?? []).some((n) =>
              /crossOriginIsolated/.test(n),
            ),
        ),
      detail: "every gsw page crossOriginIsolated (5-us performance.now)",
    });
  }
  if (!receiver || receiver === "web") {
    const web = legs.filter(
      (l) => /-web/.test(l.leg) && l.status === "success",
    );
    const prov = web[0]?.provenance;
    checks.push({
      id:
        device === null
          ? "bench-web-browser-provenance"
          : "bench-web-device-provenance",
      ok: web.length > 0 && web.every((l) => l.provenance?.ok === true),
      detail: prov ? `${prov.kind}: ${prov.renderer}` : "no web leg",
    });
  }
  const table: BenchTableRow[] = legs
    .filter((l) => l.summary)
    .map((l) => ({
      leg: l.leg,
      receiver: l.leg.startsWith("native")
        ? "native"
        : /-gsw/.test(l.leg)
          ? "gsw"
          : "web",
      input: l.summary?.input ?? "",
      phases: Object.fromEntries(
        Object.entries(l.summary?.phases ?? {}).map(([k, v]) => [
          k,
          { p50_us: v.p50_us, p95_us: v.p95_us, mean_us: v.mean_us },
        ]),
      ),
      total_p95_us: l.summary?.total_p95_us ?? null,
      verdict: l.decision?.verdict ?? null,
    }));
  return { checks, table };
}
