// Capture-scale must publish the whole mirror, including on live-only legs.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, type G8aCheck } from "./gate8-adopt-checks";
import { splitRecords, wireVersionOf } from "./render-stream-2";

export function scaleMirrorProblems(data: Uint8Array): string[] {
  return mirrorProblems(data, true);
}

function mirrorProblems(
  data: Uint8Array,
  requireTransactions: boolean,
): string[] {
  const split = splitRecords(data, wireVersionOf(data));
  const problems = [...split.errors];
  let transactions = 0;
  for (const raw of split.records) {
    // Only metadata is needed: do not decode/hash the resource payload blocks.
    const b = Buffer.from(
      raw.bytes.buffer,
      raw.bytes.byteOffset,
      raw.bytes.byteLength,
    );
    const meta = JSON.parse(
      b.subarray(8, 8 + b.readUInt32LE(4)).toString("utf8"),
    );
    if (meta.type !== "transaction") continue;
    transactions++;
    for (const f of meta.failures ?? []) {
      if (f.reason === "mirror-capacity")
        problems.push(`frame ${meta.frame}: mirror-capacity: ${f.detail}`);
    }
  }
  if (requireTransactions && transactions === 0)
    problems.push("no transactions");
  return problems;
}

export function captureMirrorProblems(dir: string): string[] {
  const saved = join(dir, "scale-mirror.json");
  if (existsSync(saved))
    return JSON.parse(readFileSync(saved, "utf8")) as string[];
  const files = readdirSync(dir)
    .filter((f) => /^recording.*\.rs\d+$/.test(f))
    .map((f) => join(dir, f));
  const tap = join(dir, "tap");
  if (existsSync(tap))
    files.push(
      ...readdirSync(tap)
        .filter((f) => /^stream-.*\.rs\d+$/.test(f))
        .map((f) => join(tap, f)),
    );
  if (files.length === 0) {
    const env = existsSync(join(dir, "env.txt"))
      ? readFileSync(join(dir, "env.txt"), "utf8")
      : "";
    if (
      /^GRC_MODE=(validate|standby)$/m.test(env) ||
      /^GRC_ARM_DEFER_FRAMES=/m.test(env) ||
      /^GRC_EXTENSION=$/m.test(env) ||
      (/^GRC_LIVE_LISTEN=/m.test(env) &&
        !/^GRC_(STREAM_OUT|STREAM_PATCH_OUT|LIVE_TAP_DIR)=/m.test(env))
    )
      return [];
    return ["no scale stream"];
  }
  let nonEmptyStreams = 0;
  const problems = files.flatMap((f) => {
    try {
      const data = readFileSync(f);
      const isTap = dirname(f) === tap;
      // A connection can close before publishing its first transaction.
      if (isTap && data.length === 0) return [];
      if (data.length > 0) nonEmptyStreams++;
      return mirrorProblems(data, !isTap).map(
        (p) => `${relative(dir, f)}: ${p}`,
      );
    } catch (e) {
      return [`${relative(dir, f)}: ${String(e)}`];
    }
  });
  if (nonEmptyStreams === 0) problems.push("no scale stream");
  return problems;
}

export function runScaleMirrorChecks(root: string): G8aCheck[] {
  const problems: string[] = [];
  let legs = 0;
  function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || /sabotage|store|node_modules/.test(e.name))
        continue;
      const child = join(dir, e.name);
      const argv = join(child, "argv.txt");
      if (
        existsSync(argv) &&
        /\/fixtures\/capture-scale(?:\n|$)/.test(readFileSync(argv, "utf8")) &&
        !readFileSync(argv, "utf8").includes("--import")
      ) {
        legs++;
        problems.push(
          ...captureMirrorProblems(child).map(
            (p) => `${relative(root, child)}: ${p}`,
          ),
        );
      } else walk(child);
    }
  }
  walk(root);
  return legs === 0
    ? []
    : [
        check(
          "scale-mirror-whole",
          "every capture-scale stream has no mirror-capacity failure",
          problems,
          `${legs} scale legs`,
        ),
      ];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--capture"
) {
  const dir = resolve(process.argv[3]);
  writeFileSync(
    join(dir, "scale-mirror.json"),
    JSON.stringify(captureMirrorProblems(dir)),
  );
}
