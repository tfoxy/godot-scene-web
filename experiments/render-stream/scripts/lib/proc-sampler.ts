// Runner-side /proc sampler (G6t, Q3d/Q7e/Q5 of ../../protocol/gate6-design.md): reads
// `/proc/<pid>/status` (VmRSS, VmHWM, VmSize, Threads) and `/proc/<pid>/task/*/stat` (per-thread
// utime/stime) for a process this runner already owns (the host or the receiver), at 1 Hz.
//
// This is deliberately engine-free: it never asks Godot for anything (D9 -- engine allocation
// counters are unavailable in release templates, so memory growth is measured as process RSS from
// /proc instead). `sampleOnce()` is pure file I/O over a given pid, synchronous because the
// 1-second cadence it is meant to run at has no need for an async read, and because a sampler used
// from inside a tight setInterval callback should never leave more than one read in flight.
//
// USER_HZ (the clock-tick rate /proc/<pid>/task/*/stat's utime/stime are counted in) is assumed to
// be 100, which is universal on x86_64 Linux and every kernel this experiment runs on (there is no
// portable way to read it from Node without shelling out to `getconf CLK_TCK`; a host where that
// assumption is wrong would show CPU-second figures off by a constant factor, never a sign error).

import { readdirSync, readFileSync } from "node:fs";

const USER_HZ = 100;

export interface ProcStatusSample {
  pid: number;
  vmRssBytes: number;
  vmHwmBytes: number;
  vmSizeBytes: number;
  threads: number;
}

export interface ThreadCpuSample {
  tid: number;
  comm: string;
  utimeTicks: number;
  stimeTicks: number;
  cpuSeconds: number;
}

export interface ProcSample {
  tsMs: number;
  status: ProcStatusSample;
  threadCpu: ThreadCpuSample[];
}

function kbLineToBytes(text: string, key: string): number | undefined {
  const m = text.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB$`, "m"));
  return m ? Number(m[1]) * 1024 : undefined;
}

/** Reads `/proc/<pid>/status`. Throws ENOENT if the process is gone -- callers sampling a child
 * they are about to reap should expect that and stop sampling, not treat it as a bad read. */
export function readProcStatus(pid: number): ProcStatusSample {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const threadsMatch = text.match(/^Threads:\s*(\d+)$/m);
  return {
    pid,
    vmRssBytes: kbLineToBytes(text, "VmRSS") ?? 0,
    vmHwmBytes: kbLineToBytes(text, "VmHWM") ?? 0,
    vmSizeBytes: kbLineToBytes(text, "VmSize") ?? 0,
    threads: threadsMatch ? Number(threadsMatch[1]) : 0,
  };
}

/** Parses one `/proc/<pid>/task/<tid>/stat` line. `comm` can itself contain spaces and
 * parentheses, so this finds the LAST `)` to end the comm field (the kernel's own convention,
 * man proc(5)) rather than splitting naively on the first one. Field numbering is 1-based per
 * proc(5); after removing fields 1 (pid) and 2 (comm), state is field 3 at array index 0, so
 * utime (field 14) is index 11 and stime (field 15) is index 12. */
function parseStatLine(raw: string): {
  tid: number;
  comm: string;
  utimeTicks: number;
  stimeTicks: number;
} {
  const openParen = raw.indexOf("(");
  const closeParen = raw.lastIndexOf(")");
  const tid = Number(raw.slice(0, openParen).trim());
  const comm = raw.slice(openParen + 1, closeParen);
  const rest = raw
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const utimeTicks = Number(rest[11]);
  const stimeTicks = Number(rest[12]);
  return { tid, comm, utimeTicks, stimeTicks };
}

/** Reads every thread's cpu time for `pid` from `/proc/<pid>/task/*\/stat`. A task that exits
 * between the `readdirSync` and its own `stat` read is skipped (it raced teardown, not a
 * malformed sample), everything else propagates. */
export function readTaskStats(pid: number): ThreadCpuSample[] {
  const taskDir = `/proc/${pid}/task`;
  const tids = readdirSync(taskDir);
  const out: ThreadCpuSample[] = [];
  for (const tid of tids) {
    let raw: string;
    try {
      raw = readFileSync(`${taskDir}/${tid}/stat`, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const parsed = parseStatLine(raw);
    out.push({
      tid: parsed.tid,
      comm: parsed.comm,
      utimeTicks: parsed.utimeTicks,
      stimeTicks: parsed.stimeTicks,
      cpuSeconds: (parsed.utimeTicks + parsed.stimeTicks) / USER_HZ,
    });
  }
  return out;
}

/** One status + per-thread-cpu sample, timestamped with `Date.now()` (wall clock, matching the
 * 1-line-per-second `perf-timeline.jsonl` convention of Q3d; the host/receiver's own clocks are
 * recorded separately in `provenance.timing`). */
export function sampleOnce(pid: number): ProcSample {
  return {
    tsMs: Date.now(),
    status: readProcStatus(pid),
    threadCpu: readTaskStats(pid),
  };
}

export type StopSampling = () => ProcSample[];

/** Starts sampling `pid` once a second (first sample immediate, matching the perf-timeline
 * convention of one line per elapsed second from the start of the window). Returns a `stop()`
 * that clears the interval and returns every sample collected. A read failure (e.g. the process
 * exited) stops the interval and is recorded as a final partial sample is not fabricated -- the
 * samples array simply ends at the last successful read, and the caller's own process-exit
 * handling is the source of truth for when the process died. */
export function startSampling(pid: number, intervalMs = 1000): StopSampling {
  const samples: ProcSample[] = [];
  const tick = () => {
    try {
      samples.push(sampleOnce(pid));
    } catch {
      clearInterval(timer);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
    return samples;
  };
}
