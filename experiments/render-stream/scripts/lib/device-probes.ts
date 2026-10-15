// Gate 7 device probes, adb side (G7d implements and dry-runs them against a fake adb; G7m runs
// them on each phone; protocol/gate7-design.md Q13a "*(device probe)*" items and Q13b). The page
// side (WebGL facts, timer queries, RGB10_A2, rAF T_p, the landscape viewport, adb-reverse RTT and
// throughput, the 60 Hz hold drift) lives in web/bench/bench.ts `?mode=probe`. Every probe is
// read-only: dumpsys, getprop-free `settings get`, `cat` of sysfs/procfs nodes. Nothing here
// writes to the phone. A probe that cannot read its source records why, never a guess.
//
// Not probed here, by design: the trace event names. Q13b says to run perf-harness's own
// `--dump-trace-names` first on each phone and each new Chrome version; `TRACE_NAMES_COMMAND`
// is that command, recorded with the probes so G7m runs exactly it.

import {
  type Adb,
  type DeviceConditions,
  parseGpuMemoryBytes,
  sampleConditions,
} from "../../../../packages/perf-harness/src/device";
import type { DeviceTableEntry } from "./browser-harness";
import {
  type CpuFreqSample,
  type MeminfoSample,
  parseMeminfoPss,
  readCpuFreqs,
} from "./device-sampler";

export const TRACE_NAMES_COMMAND = (serial: string) =>
  `mise exec -- pnpm perf -- --env device --device-serial ${serial} --dump-trace-names`;

export interface DisplayModes {
  modes: { id: number; width: number; height: number; fps: number }[];
  active_mode_id: number | null;
  default_mode_id: number | null;
  active_fps: number | null;
}

/** `dumpsys display`: `supportedModes [{id=1, width=1080, height=2400, fps=60.0, …}]`,
 * `modeId N` in the DisplayDeviceInfo line, `mActiveModeId=` / `mDefaultModeId=`. */
export function parseDisplayModes(text: string): DisplayModes {
  const modes: DisplayModes["modes"] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(
    /\{id=(\d+), width=(\d+), height=(\d+), fps=([\d.]+)/g,
  )) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    modes.push({
      id,
      width: Number(m[2]),
      height: Number(m[3]),
      fps: Number(m[4]),
    });
  }
  const active =
    /mActiveModeId=(\d+)/.exec(text)?.[1] ?? /\bmodeId (\d+)/.exec(text)?.[1];
  const def =
    /mDefaultModeId=(\d+)/.exec(text)?.[1] ??
    /defaultModeId (\d+)/.exec(text)?.[1];
  const activeId = active === undefined ? null : Number(active);
  return {
    modes,
    active_mode_id: activeId,
    default_mode_id: def === undefined ? null : Number(def),
    active_fps: modes.find((m) => m.id === activeId)?.fps ?? null,
  };
}

/** `dumpsys SurfaceFlinger`: the `GLES:` line and `refresh-rate : 60.00fps`. */
export function parseSurfaceFlinger(text: string): {
  gles: string | null;
  refresh_hz: number | null;
} {
  const gles = /^GLES:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const rate = /refresh-rate\s*:\s*([\d.]+)\s*fps/.exec(text)?.[1];
  return { gles, refresh_hz: rate === undefined ? null : Number(rate) };
}

/** `wm size` / `wm density`. */
export function parseWm(text: string): {
  physical: [number, number] | null;
  density: number | null;
} {
  const size = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  const density = /Physical density:\s*(\d+)/.exec(text);
  return {
    physical: size ? [Number(size[1]), Number(size[2])] : null,
    density: density ? Number(density[1]) : null,
  };
}

/** Q13a "unavailable unrooted" candidates on MediaTek Mali phones (the g86's list, re-probed). */
export const GPU_COUNTER_NODES = [
  "/sys/kernel/ged/hal/gpu_utilization",
  "/sys/class/misc/mali0/device/utilization",
  "/proc/gpufreq/gpufreq_var_dump",
  "/sys/kernel/ged/hal/current_freqency",
] as const;

export interface NodeRead {
  path: string;
  readable: boolean;
  value: string | null;
  error: string | null;
}

/** One `cat` per node, framed by markers so one shell call reads them all. */
export function parseNodeReads(
  text: string,
  paths: readonly string[],
): NodeRead[] {
  return paths.map((path) => {
    const m = new RegExp(
      `^<<${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}>>(\\d+)\\n([\\s\\S]*?)^<<end>>$`,
      "m",
    ).exec(text);
    if (!m) return { path, readable: false, value: null, error: "no output" };
    const status = Number(m[1]);
    const body = m[2].trim();
    return status === 0
      ? { path, readable: true, value: body.slice(0, 400), error: null }
      : { path, readable: false, value: null, error: body.slice(0, 200) };
  });
}

export function nodeReadCommand(paths: readonly string[]): string {
  return paths
    .map(
      (p) =>
        `echo "<<${p}>>$(cat ${p} >/dev/null 2>&1; echo $?)"; cat ${p} 2>&1 | head -3; echo "<<end>>"`,
    )
    .join("; ");
}

export interface DeviceAdbProbes {
  schema: "render-stream-gate7-device-adb-probes/1";
  device: string;
  serial: string;
  at: string;
  display: DisplayModes;
  surfaceflinger: { gles: string | null; refresh_hz: number | null };
  /** T_p's adb-side prediction: 1000 / the active mode's rate. The page measures the real one. */
  panel_tp_ms: number | null;
  wm: { physical: [number, number] | null; density: number | null };
  cpu_freq: CpuFreqSample[] | null;
  cpu_freq_readable: boolean | null;
  devfreq: { nodes: string[]; reads: NodeRead[] };
  gpu_counters: NodeRead[];
  chrome_pid: number | null;
  meminfo: MeminfoSample | null;
  meminfo_readable: boolean;
  gfxinfo_gpu_memory_bytes: number | null;
  conditions: DeviceConditions;
  settings: Record<string, string>;
  trace_names: { delegated_to: string };
}

/** Every Q13a/Q13b adb-side probe, for one phone. */
export async function probeDeviceAdb(
  adb: Adb,
  id: string,
  entry: DeviceTableEntry,
): Promise<DeviceAdbProbes> {
  const sh = (cmd: string) => adb.shell(cmd).catch((e: Error) => e.message);
  const display = parseDisplayModes(await sh("dumpsys display"));
  const surfaceflinger = parseSurfaceFlinger(
    await sh("dumpsys SurfaceFlinger"),
  );
  const wm = parseWm(await sh("wm size; wm density"));
  const cpu = entry.cpu_clusters
    ? await readCpuFreqs(adb, entry.cpu_clusters)
    : null;
  const devfreqNodes = (await sh("ls /sys/class/devfreq/ 2>&1"))
    .split(/\s+/)
    .filter((n) => n && !n.includes(":") && !n.startsWith("ls"));
  const devfreqPaths = devfreqNodes.flatMap((n) => [
    `/sys/class/devfreq/${n}/max_freq`,
    `/sys/class/devfreq/${n}/cur_freq`,
  ]);
  const devfreqReads =
    devfreqPaths.length > 0
      ? parseNodeReads(await sh(nodeReadCommand(devfreqPaths)), devfreqPaths)
      : [];
  const gpuCounters = parseNodeReads(
    await sh(nodeReadCommand(GPU_COUNTER_NODES)),
    GPU_COUNTER_NODES,
  );
  const pidText = (await sh(`pidof ${entry.chrome_package}`)).trim();
  const chromePid = /^\d+$/.test(pidText.split(/\s+/)[0] ?? "")
    ? Number(pidText.split(/\s+/)[0])
    : null;
  const meminfo =
    chromePid === null
      ? null
      : parseMeminfoPss(await sh(`dumpsys meminfo ${chromePid}`), chromePid);
  const gpuMemory = parseGpuMemoryBytes(
    await sh(`dumpsys gfxinfo ${entry.chrome_package}`),
  );
  const settings: Record<string, string> = {};
  for (const [ns, key] of [
    ["global", "stay_on_while_plugged_in"],
    ["system", "accelerometer_rotation"],
    ["system", "user_rotation"],
    ["system", "screen_off_timeout"],
  ] as const)
    settings[`${ns}/${key}`] = (await sh(`settings get ${ns} ${key}`)).trim();
  return {
    schema: "render-stream-gate7-device-adb-probes/1",
    device: id,
    serial: entry.serial,
    at: new Date().toISOString(),
    display,
    surfaceflinger,
    panel_tp_ms: display.active_fps ? 1000 / display.active_fps : null,
    wm,
    cpu_freq: cpu,
    cpu_freq_readable: cpu ? cpu.every((c) => c.errors.length === 0) : null,
    devfreq: { nodes: devfreqNodes, reads: devfreqReads },
    gpu_counters: gpuCounters,
    chrome_pid: chromePid,
    meminfo,
    meminfo_readable: meminfo?.pss_kb !== null && meminfo !== null,
    gfxinfo_gpu_memory_bytes: gpuMemory,
    conditions: await sampleConditions(adb),
    settings,
    trace_names: { delegated_to: TRACE_NAMES_COMMAND(entry.serial) },
  };
}
