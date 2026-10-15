// Gate 7 device sampler (G7d; protocol/gate7-design.md Q13b "Samplers"). Everything goes through
// perf-harness's `Adb` (packages/perf-harness/src/device.ts), so a fake `adb` binary drives it in
// self-test-device-harness.ts exactly as the phone does:
//   - `sampleConditions` every 30 s (thermal status and hottest sensor, battery % and temperature);
//   - the CPU frequency caps where readable unrooted (`scaling_max_freq` / `scaling_cur_freq` of
//     each cluster's probe CPU against `cpuinfo_max_freq`): a cap below the hardware maximum is
//     `derated`, report-only (a MediaTek governor can cap clocks while Thermal Status stays 0);
//   - `dumpsys meminfo <pid>` TOTAL PSS of the given processes at 0.2 Hz;
//   - `dumpsys gfxinfo <package>` "Total GPU memory usage" (as `gpu.device.gpuMemoryBytes` is read).

import {
  type Adb,
  type DeviceConditions,
  parseGpuMemoryBytes,
  sampleConditions,
} from "../../../../packages/perf-harness/src/device";

export interface CpuCluster {
  name: string;
  probe_cpu: number;
  cpuinfo_max_khz: number;
}

export interface CpuFreqSample {
  cpu: number;
  cluster: string;
  cpuinfo_max_khz: number | null;
  scaling_max_khz: number | null;
  scaling_cur_khz: number | null;
  /** null when the caps are unreadable. */
  derated: boolean | null;
  errors: string[];
}

/** `key=value` lines of `cpuN/<file>=<value or error>`; values that are not integers are errors. */
export function parseCpuFreqLines(
  text: string,
  clusters: readonly CpuCluster[],
): CpuFreqSample[] {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^cpu(\d+)\/(\w+)=(.*)$/.exec(line.trim());
    if (m) values.set(`${m[1]}/${m[2]}`, m[3].trim());
  }
  return clusters.map((cluster) => {
    const errors: string[] = [];
    const read = (file: string): number | null => {
      const raw = values.get(`${cluster.probe_cpu}/${file}`);
      if (raw === undefined) {
        errors.push(`${file}: no output`);
        return null;
      }
      if (!/^\d+$/.test(raw)) {
        errors.push(`${file}: ${raw}`);
        return null;
      }
      return Number(raw);
    };
    const cpuinfoMax = read("cpuinfo_max_freq");
    const scalingMax = read("scaling_max_freq");
    const scalingCur = read("scaling_cur_freq");
    const hwMax = cpuinfoMax ?? cluster.cpuinfo_max_khz;
    return {
      cpu: cluster.probe_cpu,
      cluster: cluster.name,
      cpuinfo_max_khz: cpuinfoMax,
      scaling_max_khz: scalingMax,
      scaling_cur_khz: scalingCur,
      derated: scalingMax === null ? null : scalingMax < hwMax,
      errors,
    };
  });
}

export function cpuFreqCommand(clusters: readonly CpuCluster[]): string {
  return clusters
    .flatMap((c) =>
      ["cpuinfo_max_freq", "scaling_max_freq", "scaling_cur_freq"].map(
        (f) =>
          `echo "cpu${c.probe_cpu}/${f}=$(cat /sys/devices/system/cpu/cpu${c.probe_cpu}/cpufreq/${f} 2>&1)"`,
      ),
    )
    .join("; ");
}

export async function readCpuFreqs(
  adb: Adb,
  clusters: readonly CpuCluster[],
): Promise<CpuFreqSample[]> {
  const text = await adb.shell(cpuFreqCommand(clusters)).catch(() => "");
  return parseCpuFreqLines(text, clusters);
}

export interface MeminfoSample {
  pid: number;
  process: string | null;
  pss_kb: number | null;
  error: string | null;
}

/** `dumpsys meminfo <pid>`: the `** MEMINFO in pid N [name] **` header and `TOTAL PSS:`. */
export function parseMeminfoPss(text: string, pid: number): MeminfoSample {
  const header = /\*\* MEMINFO in pid (\d+) \[([^\]]*)\]/.exec(text);
  const pss =
    /TOTAL PSS:\s*(\d+)/.exec(text) ?? /^\s*TOTAL\s+(\d+)/m.exec(text);
  if (!header || !pss)
    return {
      pid,
      process: header?.[2] ?? null,
      pss_kb: null,
      error: (text.trim().split("\n")[0] ?? "").slice(0, 200) || "no output",
    };
  return {
    pid: Number(header[1]),
    process: header[2],
    pss_kb: Number(pss[1]),
    error: null,
  };
}

export async function readMeminfoPss(
  adb: Adb,
  pid: number,
): Promise<MeminfoSample> {
  const text = await adb
    .shell(`dumpsys meminfo ${pid}`)
    .catch((e: Error) => e.message);
  return parseMeminfoPss(text, pid);
}

export async function readGpuMemoryBytes(
  adb: Adb,
  pkg: string,
): Promise<number | null> {
  const text = await adb.shell(`dumpsys gfxinfo ${pkg}`).catch(() => "");
  return parseGpuMemoryBytes(text);
}

export interface SamplerTimeline {
  schema: "render-stream-gate7-device-samples/1";
  started_at: string;
  conditions: ({ t_ms: number } & DeviceConditions)[];
  cpu_freq: { t_ms: number; samples: CpuFreqSample[] }[];
  meminfo: { t_ms: number; samples: MeminfoSample[] }[];
  gpu_memory: { t_ms: number; bytes: number | null }[];
  derated: boolean;
}

export interface DeviceSamplerOptions {
  chromePackage: string;
  clusters: readonly CpuCluster[] | null;
  /** The renderer and GPU process PIDs (CDP `SystemInfo.getProcessInfo` where the phone answers it,
   * else `pidof`); re-read each memory sample. */
  pids: () => Promise<number[]> | number[];
  conditionsMs?: number;
  memoryMs?: number;
}

/** Samples on its own timers until `stop()`; one in-flight adb call per stream, never overlapping. */
export class DeviceSampler {
  private readonly timeline: SamplerTimeline = {
    schema: "render-stream-gate7-device-samples/1",
    started_at: new Date().toISOString(),
    conditions: [],
    cpu_freq: [],
    meminfo: [],
    gpu_memory: [],
    derated: false,
  };
  private readonly t0 = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private inflight = new Set<Promise<void>>();

  constructor(
    private readonly adb: Adb,
    private readonly options: DeviceSamplerOptions,
  ) {}

  private track(work: () => Promise<void>): void {
    const p = work()
      .catch(() => {})
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async sampleSlow(): Promise<void> {
    const t = Date.now() - this.t0;
    this.timeline.conditions.push({
      t_ms: t,
      ...(await sampleConditions(this.adb)),
    });
    if (this.options.clusters) {
      const samples = await readCpuFreqs(this.adb, this.options.clusters);
      if (samples.some((s) => s.derated)) this.timeline.derated = true;
      this.timeline.cpu_freq.push({ t_ms: t, samples });
    }
    this.timeline.gpu_memory.push({
      t_ms: t,
      bytes: await readGpuMemoryBytes(this.adb, this.options.chromePackage),
    });
  }

  async sampleMemory(): Promise<void> {
    const t = Date.now() - this.t0;
    const pids = await this.options.pids();
    const samples: MeminfoSample[] = [];
    for (const pid of pids) samples.push(await readMeminfoPss(this.adb, pid));
    this.timeline.meminfo.push({ t_ms: t, samples });
  }

  start(): void {
    this.track(() => this.sampleSlow());
    this.track(() => this.sampleMemory());
    let slowBusy = false;
    let memBusy = false;
    this.timers.push(
      setInterval(() => {
        if (slowBusy) return;
        slowBusy = true;
        this.track(() => this.sampleSlow().finally(() => (slowBusy = false)));
      }, this.options.conditionsMs ?? 30_000),
      setInterval(() => {
        if (memBusy) return;
        memBusy = true;
        this.track(() => this.sampleMemory().finally(() => (memBusy = false)));
      }, this.options.memoryMs ?? 5_000),
    );
  }

  async stop(): Promise<SamplerTimeline> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all([...this.inflight]);
    // One closing sample, so a short repeat still has a before and an after.
    await this.sampleSlow().catch(() => {});
    return this.timeline;
  }
}
