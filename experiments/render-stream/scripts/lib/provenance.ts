// Provenance helpers for `render-stream-report/1`'s `provenance` block (D10, Q7f of
// ../../protocol/gate6-design.md). This module owns only what a runner on THIS machine can read
// without Godot: host facts (`/proc/cpuinfo`, `os`), the display compositor's own version string,
// and sha256 digests of files the runner already has paths to (the extension, the receiver
// project, the engine binary). It never launches Godot and never reads engine or capture state --
// `report-gate6.ts build` is the one that has those paths and merges them with the capture's own
// provenance (engine version string, calibrator version, hooks planned, receiver rendering method
// and adapter) read from evidence a capture/receiver run already wrote.
//
// Every probe here is best-effort: a field this process cannot read (a missing /sys file, no
// `gamescope` on PATH) comes back `null` rather than throwing, because a report missing one
// optional host fact is still useful and `validate()` does not require most of `host`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";

export interface ProbedHostProvenance {
  cpu_model: string | null;
  logical_cpus: number;
  ram_bytes: number;
  kernel: string;
  cpu_governor: string | null;
}

/** Reads what Node and `/proc/cpuinfo` can tell us about the host this process runs on. Never
 * throws: a field whose source is absent is `null` (cpu_model, cpu_governor), never a guess. */
export function probeHostProvenance(): ProbedHostProvenance {
  let cpuModel: string | null = null;
  try {
    const text = readFileSync("/proc/cpuinfo", "utf8");
    const m = text.match(/^model name\s*:\s*(.+)$/m);
    if (m) cpuModel = m[1].trim();
  } catch {
    // /proc/cpuinfo is Linux-only; cpus()[0].model is the fallback below.
  }
  const list = cpus();
  if (!cpuModel && list.length > 0) cpuModel = list[0].model;

  let cpuGovernor: string | null = null;
  try {
    cpuGovernor = readFileSync(
      "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
      "utf8",
    ).trim();
  } catch {
    // Not every host exposes cpufreq (containers, some VMs); null is the honest answer.
  }

  return {
    cpu_model: cpuModel,
    logical_cpus: list.length,
    ram_bytes: totalmem(),
    kernel: release(),
    cpu_governor: cpuGovernor,
  };
}

/** `gamescope --version`'s first line, or null when it is not on PATH or refuses to run. Never
 * throws; a missing compositor version is reported, not fatal, since a report built from a
 * non-gamescope dev run (loopback-only legs, say) still wants the rest of its fields. */
export function probeGamescopeVersion(): string | null {
  try {
    const result = spawnSync("gamescope", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    const line = (result.stdout || result.stderr || "").split("\n")[0].trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** Lowercase hex sha256 of a file's bytes, read synchronously. The one disk read a provenance
 * block needs per named artifact (the extension `.so`, the receiver project zip or directory
 * tarball, the engine binary) -- callers that already have the bytes in memory should hash them
 * directly with `node:crypto` instead of writing a temp file just to call this. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
