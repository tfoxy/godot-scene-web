// Driver-attributed GPU memory for a DESKTOP run on an NVIDIA box: `nvidia-smi -q -x`, attributed to
// the GPU process of the Chrome THIS harness launched.
//
// WHY IT EXISTS. Every other GPU-memory figure this harness publishes is SELF-COUNTED — the texture
// cache's own byte total, Godot's `RENDER_TEXTURE_MEM_USED`, and (with `--memory-dump`) Chrome's own
// memory-infra allocators. All of those are a program adding up what it believes it uploaded. This
// one is the DRIVER's number for the process, so a claim like "hb-atlas costs 1.45 MiB of atlas" can
// be checked against what the GPU is actually holding.
//
// THE TRAP THIS FILE EXISTS TO AVOID: `<fb_memory_usage><used>` is the BOX-WIDE total (measured on
// this box: 981 MiB, carrying gnome-shell, VS Code, sunshine, nautilus and the developer's own
// Chromium). It is never read here. The only number that leaves this module comes from a
// `<process_info>` whose pid is a DESCENDANT of the Chrome this run spawned and whose command line
// carries `--type=gpu-process`. Anything else would publish other people's textures as ours.
//
// SHAPE, matching device.ts: the parsing is PURE FUNCTIONS over text (fixture-tested), and the parts
// that shell out — `nvidia-smi`, `/proc` — are thin readers that are deliberately left as UNTESTED
// SURFACE. A test of `execFile` tests node, not this harness.

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Chrome's own spelling for the GPU process, and the only thing that identifies it in a cmdline. */
export const GPU_PROCESS_FLAG = "--type=gpu-process";

/** One `<process_info>` node under `<gpu><processes>`. */
export interface NvidiaProcess {
  pid: number;
  /** `G` (graphics), `C` (compute) or `C+G`. Chrome's GPU process shows up as `C+G` on this box. */
  type: string;
  /**
   * `<process_name>`. For a Chrome child this is the WHOLE command line, `--type=gpu-process`
   * included — but it is kept as evidence only. Attribution is by pid: another Chromium's GPU process
   * carries exactly the same flag, and matching on it would report the developer's browser as ours.
   */
  name: string;
  /** `null` when the driver said `N/A` — NOT MEASURED, never 0. */
  usedMemoryBytes: number | null;
}

/**
 * `nvidia-smi -q -x` -> the `<process_info>` nodes, in document order.
 *
 * Regex over the text rather than an XML parser, exactly like `parseGfxInfo`: this reads three
 * scalar fields out of one repeated node type, and adding a parser dependency to read them would be
 * the larger change. `<fb_memory_usage>` and `<bar1_memory_usage>` are outside `<processes>` and are
 * never matched by construction — the block is sliced out first.
 */
export function parseNvidiaProcesses(xml: string): NvidiaProcess[] {
  const processes: NvidiaProcess[] = [];
  // Per `<gpu>`, so a multi-GPU box cannot merge two cards' process lists by accident. The DTD nests
  // `<processes>` inside `<gpu>` and this harness measures one card, but the slice costs nothing.
  for (const block of matchAll(xml, /<processes>([\s\S]*?)<\/processes>/g)) {
    for (const node of matchAll(
      block,
      /<process_info>([\s\S]*?)<\/process_info>/g,
    )) {
      const pid = Number(tag(node, "pid"));
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      processes.push({
        pid,
        type: tag(node, "type") ?? "",
        name: tag(node, "process_name") ?? "",
        usedMemoryBytes: parseNvidiaMemoryBytes(tag(node, "used_memory")),
      });
    }
  }
  return processes;
}

/**
 * `"235 MiB"` -> `246415360`. `"N/A"`, an empty node and a missing node are all `null`.
 *
 * MEASURED RESOLUTION, and it matters: the driver reports this field in whole MiB. A delta smaller
 * than 1 MiB is BELOW THE INSTRUMENT — it is not a small allocation, it is an unmeasurable one, and
 * the table says so rather than printing 0.00.
 */
export function parseNvidiaMemoryBytes(text: string | null): number | null {
  if (text === null) {
    return null;
  }
  const match = /^\s*([\d.]+)\s*(B|KiB|MiB|GiB)?\s*$/.exec(text);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[
    match[2] ?? "B"
  ];
  return unit === undefined ? null : Math.round(value * unit);
}

/** One row of a process table: enough to walk parents and to recognise a Chrome child. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** `/proc/<pid>/cmdline` with its NULs turned into spaces. */
  cmdline: string;
}

/**
 * `/proc/<pid>/stat` -> `{ pid, ppid }`.
 *
 * THE TRAP: field 2 is `comm` IN PARENTHESES and may itself contain spaces and parentheses
 * (`(Chrome_ChildIOT)`, `(foo bar)`). Splitting the line on whitespace therefore shifts every later
 * field, and field 4 stops being the ppid — a bug that reads as "this process has no parent" rather
 * than as a parse error. So the scan starts after the LAST `)`, which is what `procfs(5)` documents.
 */
export function parseProcStat(
  text: string,
): { pid: number; ppid: number } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const pid = Number(text.slice(0, text.indexOf(" ")));
  // After `comm`: state, ppid, pgrp, ...
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
    return null;
  }
  return { pid, ppid };
}

/**
 * Every `--type=gpu-process` DESCENDANT of `rootPid`, lowest pid first. `rootPid` itself is included
 * in the walk for completeness; a browser process never carries the flag.
 *
 * TRANSITIVE, not "children of the browser", and that is not defensive coding: on Linux Chrome forks
 * its sandboxed children from a ZYGOTE, so the GPU process's ppid is the zygote's and the browser is
 * its GRANDPARENT. (With `--no-sandbox` — which this harness passes — the browser usually is the
 * direct parent, so a one-level walk would pass here and then silently return null the day someone
 * drops that flag.)
 *
 * Returns a LIST because a GPU process that crashed and was relaunched leaves two matching pids in a
 * `/proc` snapshot; summing what the driver attributes to each is the only answer that neither
 * double-counts nor silently drops half the memory.
 */
export function findDescendantGpuPids(
  table: readonly ProcessEntry[],
  rootPid: number,
): number[] {
  const children = new Map<number, number[]>();
  const byPid = new Map<number, ProcessEntry>();
  for (const entry of table) {
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings) {
      siblings.push(entry.pid);
    } else {
      children.set(entry.ppid, [entry.pid]);
    }
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const found: number[] = [];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    const entry = byPid.get(pid);
    if (entry?.cmdline.includes(GPU_PROCESS_FLAG)) {
      found.push(pid);
    }
    for (const child of children.get(pid) ?? []) {
      // `seen` is not paranoia: pid 0/1 are their own ancestors in a synthetic table, and a wrapped
      // pid can make the parent map cyclic. A cycle here would hang a measurement.
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return found.sort((a, b) => a - b);
}

/** What one bracket sample saw, and what it was attributed to. */
export interface ChromeVramSample {
  /** GPU-process pids found under the launched Chrome. Empty = nothing to attribute to. */
  gpuPids: number[];
  /**
   * Driver-attributed bytes, summed over `gpuPids`.
   *
   * `null` is NOT MEASURED and covers every failure: no `nvidia-smi`, no descendant GPU process, or a
   * GPU process the driver does not list (which happens when it has no GPU context at all — a
   * software fallback). Reporting 0 there would read as "our GPU work is free", which is the single
   * most dangerous shape a perf number can take.
   */
  usedBytes: number | null;
  /** One line naming exactly what the bytes were attributed to, for the log and the report. */
  attribution: string;
}

/** The `null` sample, with the reason a reader will need. */
function notMeasured(reason: string): ChromeVramSample {
  return {
    gpuPids: [],
    usedBytes: null,
    attribution: `NOT MEASURED: ${reason}`,
  };
}

/**
 * Read `/proc` into a process table. UNTESTED SURFACE BY DESIGN — it is a directory listing and two
 * file reads; the logic worth testing is `parseProcStat` and `findDescendantGpuPids` above.
 *
 * A process that exits mid-scan makes its files vanish; that is normal and is skipped, not an error.
 */
export async function readProcessTable(): Promise<ProcessEntry[]> {
  const entries: ProcessEntry[] = [];
  const names = await readdir("/proc");
  for (const name of names) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
      if (!stat) {
        continue;
      }
      const cmdline = await readFile(`/proc/${name}/cmdline`, "utf8");
      entries.push({ ...stat, cmdline: cmdline.replace(/\0/g, " ") });
    } catch {
      // raced with the process exiting
    }
  }
  return entries;
}

/**
 * Shell out to `nvidia-smi -q -x`. UNTESTED SURFACE BY DESIGN (see the header): the parsing above is
 * where the behaviour lives.
 *
 * `null` distinguishes "no nvidia-smi / it failed" from "it ran and listed no processes", because
 * those two are a missing instrument and a measured empty list.
 */
export async function readNvidiaProcesses(
  bin = process.env.GSW_PERF_NVIDIA_SMI ?? "nvidia-smi",
): Promise<NvidiaProcess[] | null> {
  try {
    const { stdout } = await exec(bin, ["-q", "-x"], {
      timeout: 15_000,
      maxBuffer: 16 << 20,
    });
    return parseNvidiaProcesses(stdout);
  } catch {
    return null;
  }
}

/**
 * One bracket sample: walk `/proc` for the GPU process under `chromePid`, then ask the driver what
 * that pid holds.
 *
 * Composition only, so it is untested surface like its two readers. Best-effort throughout — this is
 * called from `CaptureOptions.window`, where a failure must never fail a measurement.
 */
export async function sampleChromeVram(
  chromePid: number,
): Promise<ChromeVramSample> {
  let gpuPids: number[];
  try {
    gpuPids = findDescendantGpuPids(await readProcessTable(), chromePid);
  } catch (error) {
    return notMeasured(`could not read /proc (${String(error)})`);
  }
  if (gpuPids.length === 0) {
    return notMeasured(
      `no ${GPU_PROCESS_FLAG} process under the launched chrome (pid ${chromePid})`,
    );
  }
  const processes = await readNvidiaProcesses();
  if (processes === null) {
    return notMeasured("nvidia-smi -q -x did not run");
  }
  const mine = processes.filter((entry) => gpuPids.includes(entry.pid));
  const counted = mine.filter((entry) => entry.usedMemoryBytes !== null);
  if (counted.length === 0) {
    return {
      gpuPids,
      usedBytes: null,
      attribution: `NOT MEASURED: the driver lists no memory for pid ${gpuPids.join("+")} (chrome pid ${chromePid}); it lists ${processes.length} other process(es)`,
    };
  }
  return {
    gpuPids,
    usedBytes: counted.reduce(
      (total, entry) => total + (entry.usedMemoryBytes ?? 0),
      0,
    ),
    // The pid and the TYPE go in the line on purpose: this is the evidence that the figure is one
    // process's and not `<fb_memory_usage><used>`, which is the whole box.
    attribution: `nvidia-smi per-process, pid ${counted.map((entry) => `${entry.pid} (${entry.type})`).join(" + ")} under chrome pid ${chromePid}`,
  };
}

/**
 * Is this environment an NVIDIA GPU at all?
 *
 * The gate on the whole feature. A headless SwiftShader run has no business shelling out to
 * `nvidia-smi`: there is no GPU context, the driver would list no Chrome process, and the harness
 * would pay a subprocess per bracket to learn nothing. Fed from `describeGpuHardware` (browser.ts),
 * i.e. the renderer string Chrome itself reports, so the gate closes automatically the moment a run
 * falls back to software — which is exactly when a VRAM number would be a lie.
 */
export function isNvidiaGpu(gpu: {
  hardware: string;
  hardwareDetail: string;
}): boolean {
  const text = `${gpu.hardware} ${gpu.hardwareDetail}`;
  if (/swiftshader|llvmpipe|softwarerasterizer/i.test(text)) {
    return false;
  }
  return /nvidia|geforce|quadro|rtx |gtx /i.test(text);
}

function tag(node: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(node);
  return match ? match[1].trim() : null;
}

function matchAll(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    out.push(match[1]);
  }
  return out;
}
