// G7p: the g31's device rows (gate7-design.md Q12 "Device rows", Q13), read from G7v's run
// directories (`run-gate7.sh --live --legs g7-dev --env device --device g31`, each holding
// `g7v-summary.json` and the legs under `gate6/<run>/rates/dev-<base>-r<N>/receiver/`). Pure over
// those files: nothing is launched and nothing under a G7v directory is written.
//
// What a row is: one phone, one receiver kind, one credit window, one workload, its repeats in
// Q12's stage names, the phone's `env.device` block (perf-report/1's shape, docs/perf-report-
// contract.md, assembled from the legs' own provenance.json and device.json), the bundle sha the
// legs ran (`RS_RECEIVER_BUILD_SHA256` in the page config), and its desktop control row (the
// `ctl:` rows of G7v's control run, same receiver and window).
//
// D28: a row whose bundle is not the report's is not shown as current. `loadDeviceRows` returns
// it in `omitted`, with both shas, and the report names it.
//
// The Q13b watchdog: a repeat with hidden time, a rAF gap over 250 ms, or a thermal status other
// than `none` before or after is `invalid`, with the reason, and never averaged into the row's
// summary.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type DeviceRow,
  type DeviceRowRepeat,
  deviceRowSummary,
  type OmittedDeviceRow,
  type ReportEnv,
} from "./render-stream-report";

export const WATCHDOG_RAF_GAP_MS = 250;

/** One row of g7v-summary.json `device_rows` (lib/gate7v-checks.ts on the G7v branch). */
export interface SummaryRow {
  provenance_env: {
    kind: "device" | "desktop";
    device_id: string | null;
    panel: ReportEnv["panel"];
  };
  receiver_kind: "web-export" | "gsw-canvas";
  credit_window: 1 | 2;
  leg: string;
  run: number;
  stages: Record<string, unknown>;
  phase_class: string | null;
  device: Record<string, unknown>;
  startup: Record<string, unknown> | null;
}

export interface DeviceEvidenceSummary {
  schema: string;
  device_rows: SummaryRow[];
}

export type Workload = string;

/** Workloads that become device rows. Startup legs become startup summaries; soak and sabotage
 * legs are G7v's own and are not matrix rows. */
export function rowWorkload(
  leg: string,
): { workload: Workload; control: boolean } | null {
  const [prefix, base] = leg.split(":");
  if (!base) return null;
  if (
    base.startsWith("startup-") ||
    base.startsWith("soak-") ||
    base.startsWith("sabotage-")
  )
    return null;
  return { workload: base, control: prefix === "ctl" };
}

/** Q13b's watchdog over one summary row's `device` block. */
export function watchdogReason(
  device: Record<string, unknown>,
  isDevice: boolean,
): string | null {
  const why: string[] = [];
  const hidden = device.hidden_ms;
  if (typeof hidden === "number" && hidden > 0) why.push(`hidden ${hidden} ms`);
  const gap = device.max_raf_gap_ms;
  if (typeof gap === "number" && gap > WATCHDOG_RAF_GAP_MS)
    why.push(`rAF gap ${gap.toFixed(0)} ms > ${WATCHDOG_RAF_GAP_MS} ms`);
  if (isDevice) {
    for (const k of ["thermal_before", "thermal_after"] as const) {
      const v = device[k];
      if (typeof v === "string" && v !== "none") why.push(`${k} ${v}`);
    }
  }
  return why.length > 0 ? why.join(", ") : null;
}

export function toRepeat(row: SummaryRow, isDevice: boolean): DeviceRowRepeat {
  const reason = watchdogReason(row.device, isDevice);
  const rep: DeviceRowRepeat = {
    run: row.run,
    stages: row.stages,
    phase_class: row.phase_class,
    device: row.device,
    startup: row.startup,
  };
  if (reason) rep.invalid = { reason };
  return rep;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The leg directory of summary row (`dev-<base>-r<run>`), under any of the run's
 * `gate6/<name>/rates/` directories. */
export function findLegDir(
  runDir: string,
  base: string,
  run: number,
  window: number,
): string | undefined {
  const gate6 = join(runDir, "gate6");
  if (!existsSync(gate6)) return undefined;
  const found: string[] = [];
  for (const e of readdirSync(gate6, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = join(gate6, e.name, "rates", `dev-${base}-r${run}`);
    if (existsSync(join(d, "receiver"))) found.push(d);
  }
  // A run directory normally holds one window; if it holds several, the name carries it (-wN).
  return found.find((d) => d.includes(`-w${window}/`)) ?? found[0];
}

export interface LegFacts {
  build_sha256: string | null;
  provenance: Record<string, unknown> | undefined;
  device_json: Record<string, unknown> | undefined;
  credit_window: number | null;
}

export async function legFacts(legDir: string): Promise<LegFacts> {
  const rdir = join(legDir, "receiver");
  const cfg = await readJson<{ url?: string }>(join(rdir, "page-config.json"));
  let build: string | null = null;
  let window: number | null = null;
  const m = cfg?.url?.match(/[?&]env=([^&]+)/);
  if (m) {
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const env = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
        .env as Record<string, string>;
      build = env.RS_RECEIVER_BUILD_SHA256 ?? null;
      window = env.RS_RECEIVER_CREDIT_WINDOW
        ? Number(env.RS_RECEIVER_CREDIT_WINDOW)
        : 1;
    } catch {
      /* unreadable page config: the facts stay null */
    }
  }
  return {
    build_sha256: build,
    provenance: await readJson<Record<string, unknown>>(
      join(rdir, "provenance.json"),
    ),
    device_json: await readJson<Record<string, unknown>>(
      join(rdir, "device.json"),
    ),
    credit_window: window,
  };
}

/** perf-report/1's `env.device` block (docs/perf-report-contract.md) from a leg's facts. */
export function envDeviceBlock(
  f: LegFacts,
  rows: readonly DeviceRowRepeat[],
): Record<string, unknown> | null {
  const facts = (f.provenance?.facts ?? {}) as Record<string, unknown>;
  const dj = f.device_json ?? {};
  const before = (dj.conditions_before ?? facts.conditions ?? {}) as Record<
    string,
    unknown
  >;
  const after = (dj.conditions_after ?? {}) as Record<string, unknown>;
  const model = (facts.model ?? dj.model) as string | undefined;
  const chrome = (facts.chromeVersion ?? dj.chrome) as string | undefined;
  const release = facts.androidRelease as string | undefined;
  if (!model || !chrome || !release) return null;
  const page = (facts.page ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  for (const r of rows)
    if (r.invalid) warnings.push(`r${r.run} invalid: ${r.invalid.reason}`);
  if (
    before.thermalStatus !== undefined &&
    after.thermalStatus !== undefined &&
    before.thermalStatus !== after.thermalStatus
  )
    warnings.push(
      `thermal status changed during the run (${before.thermalStatus} -> ${after.thermalStatus})`,
    );
  return {
    model,
    androidRelease: release,
    chrome,
    batteryPct: before.batteryPct ?? null,
    batteryTemperatureC: before.batteryTemperatureC ?? null,
    thermalStatus: before.thermalStatus ?? null,
    thermalStatusCode: before.thermalStatusCode ?? null,
    thermalMaxTempC: before.thermalMaxTempC ?? null,
    after,
    warnings,
    serial: facts.serial ?? dj.serial,
    manufacturer: facts.manufacturer,
    isolation: dj.isolation,
    viewport:
      page.innerWidth !== undefined
        ? `${page.innerWidth}x${page.innerHeight}@${page.devicePixelRatio}`
        : undefined,
  };
}

export interface LoadedDeviceEvidence {
  rows: DeviceRow[];
  omitted: OmittedDeviceRow[];
  /** startup summaries: first `submitted` after navigation per repeat, by temperature */
  startup: {
    device_id: string;
    receiver_kind: string;
    credit_window: number;
    temperature: "cold" | "warm";
    first_submitted_ms: (number | null)[];
  }[];
  sources: string[];
}

/** Rows from G7v run directories. A later directory replaces an earlier one's rows for the same
 * (receiver kind, window, workload) -- G7v's gsw window 2 run supersedes whatever the window-1 run
 * carried for it. `dirs` may include the desktop control run; its `ctl:` rows become `control`.
 * `reportBundle(kind)` is the report's bundle sha for that receiver kind (null: not known, no
 * comparison), `device` the phone to take (only `g31` has rows: the g86 is descoped). */
export async function loadDeviceRows(
  dirs: readonly string[],
  reportBundle: (kind: "web-export" | "gsw-canvas") => string | null,
  device = "g31",
  onlyKind?: "web-export" | "gsw-canvas",
): Promise<LoadedDeviceEvidence> {
  type Key = string;
  const groups = new Map<
    Key,
    {
      key: {
        kind: "web-export" | "gsw-canvas";
        window: 1 | 2;
        workload: string;
      };
      dir: string;
      rows: SummaryRow[];
    }
  >();
  const controls = new Map<Key, { dir: string; rows: SummaryRow[] }>();
  const startupRows = new Map<
    Key,
    {
      dir: string;
      rows: SummaryRow[];
      temperature: "cold" | "warm";
      kind: string;
      window: number;
    }
  >();
  const sources: string[] = [];
  for (const dir of dirs) {
    const summary = await readJson<DeviceEvidenceSummary>(
      join(dir, "g7v-summary.json"),
    );
    if (!summary || !Array.isArray(summary.device_rows)) continue;
    sources.push(dir);
    const local = new Map<Key, SummaryRow[]>();
    const localCtl = new Map<Key, SummaryRow[]>();
    const localStartup = new Map<Key, SummaryRow[]>();
    for (const r of summary.device_rows) {
      if (onlyKind && r.receiver_kind !== onlyKind) continue;
      const isCtl = r.leg.startsWith("ctl:");
      const base = r.leg.split(":")[1] ?? "";
      if (base.startsWith("startup-")) {
        if (r.provenance_env.device_id !== device) continue;
        const k = `${r.receiver_kind}|${r.credit_window}|${base}`;
        localStartup.set(k, [...(localStartup.get(k) ?? []), r]);
        continue;
      }
      const w = rowWorkload(r.leg);
      if (!w) continue;
      if (!isCtl && r.provenance_env.device_id !== device) continue;
      const k = `${r.receiver_kind}|${r.credit_window}|${w.workload}`;
      const into = isCtl ? localCtl : local;
      into.set(k, [...(into.get(k) ?? []), r]);
    }
    for (const [k, rows] of local) {
      const [kind, window, workload] = k.split("|");
      groups.set(k, {
        key: {
          kind: kind as "web-export",
          window: Number(window) as 1,
          workload,
        },
        dir,
        rows,
      });
    }
    for (const [k, rows] of localCtl) controls.set(k, { dir, rows });
    for (const [k, rows] of localStartup) {
      const [kind, window, base] = k.split("|");
      startupRows.set(k, {
        dir,
        rows,
        temperature: base.endsWith("cold") ? "cold" : "warm",
        kind,
        window: Number(window),
      });
    }
  }

  const out: LoadedDeviceEvidence = {
    rows: [],
    omitted: [],
    startup: [],
    sources,
  };
  for (const [k, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = [...g.rows].sort((a, b) => a.run - b.run);
    const legDir = findLegDir(g.dir, g.key.workload, rows[0].run, g.key.window);
    const facts = legDir ? await legFacts(legDir) : undefined;
    const repeats = rows.map((r) => toRepeat(r, true));
    const want = reportBundle(g.key.kind);
    const have = facts?.build_sha256 ?? null;
    if (have === null || (want !== null && have !== want)) {
      out.omitted.push({
        device_id: device as "g31",
        receiver_kind: g.key.kind,
        credit_window: g.key.window,
        workload: g.key.workload,
        build_sha256: have,
        reason:
          have === null
            ? `no build sha recorded for the legs under ${g.dir}`
            : `ran bundle ${have.slice(0, 12)}, the report's is ${want?.slice(0, 12)} (D28: an older build's row is omitted, not shown as current)`,
      });
      continue;
    }
    const deviceBlock = facts ? envDeviceBlock(facts, repeats) : null;
    const env: ReportEnv = {
      kind: "device",
      device_id: device as "g31",
      device: deviceBlock,
      panel: rows[0].provenance_env.panel,
    };
    const ctl = controls.get(k);
    let control: DeviceRow["control"] = null;
    if (ctl) {
      const crepeats = [...ctl.rows]
        .sort((a, b) => a.run - b.run)
        .map((r) => toRepeat(r, false));
      control = {
        env: {
          kind: "desktop",
          device_id: null,
          device: null,
          panel: ctl.rows[0].provenance_env.panel,
        },
        repeats: crepeats,
      };
    }
    out.rows.push({
      device_id: device as "g31",
      receiver_kind: g.key.kind,
      credit_window: g.key.window,
      workload: g.key.workload,
      env,
      build: { bundle_sha256: have, source: g.dir },
      repeats,
      summary: deviceRowSummary(repeats),
      control,
    });
  }
  for (const s of startupRows.values()) {
    out.startup.push({
      device_id: device,
      receiver_kind: s.kind,
      credit_window: s.window,
      temperature: s.temperature,
      first_submitted_ms: [...s.rows]
        .sort((a, b) => a.run - b.run)
        .map((r) => {
          const v = r.startup?.first_submitted_ms;
          return typeof v === "number" ? v : null;
        }),
    });
  }
  return out;
}
