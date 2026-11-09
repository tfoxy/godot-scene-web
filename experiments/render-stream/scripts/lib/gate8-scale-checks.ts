// Capture-scale must publish the whole mirror, including on live-only legs.
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

// The reader buffers a fixed amount of wire data and skips payload blocks by offset.
// Only one record's JSON metadata is retained, even for multi-gigabyte streams.
export function scaleMirrorFileProblems(
  path: string,
  requireTransactions = true,
  bufferSize = 64 * 1024,
): string[] {
  if (!Number.isInteger(bufferSize) || bufferSize < 1)
    throw new RangeError("bufferSize must be a positive integer");
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(bufferSize);
    let bufferedAt = -1;
    let bufferedBytes = 0;
    let pos = 0;
    function read(length: number): Buffer {
      const out = Buffer.alloc(length);
      let copied = 0;
      while (copied < length) {
        if (pos < bufferedAt || pos >= bufferedAt + bufferedBytes) {
          bufferedAt = pos;
          bufferedBytes = readSync(fd, buffer, 0, buffer.length, pos);
          if (bufferedBytes === 0) throw new Error("unexpected end of stream");
        }
        const offset = pos - bufferedAt;
        const n = Math.min(length - copied, bufferedBytes - offset);
        buffer.copy(out, copied, offset, offset + n);
        copied += n;
        pos += n;
      }
      return out;
    }
    const magic = read(Math.min(8, size));
    const header = splitRecords(magic, wireVersionOf(magic));
    if (header.errors.length > 0)
      return [
        ...header.errors,
        ...(requireTransactions ? ["no transactions"] : []),
      ];
    const framing: string[] = [];
    const problems: string[] = [];
    let transactions = 0;
    while (pos < size) {
      const start = pos;
      if (size - start < 4) {
        framing.push(
          `truncated: record_len prefix at offset ${start} runs past the end of the input`,
        );
        break;
      }
      const recordLen = read(4).readUInt32LE(0);
      const byteLength = 4 + recordLen;
      if (start + byteLength > size) {
        framing.push(
          `truncated: record at offset ${start} declares ${byteLength} bytes but only ${size - start} remain`,
        );
        break;
      }
      // Match the in-memory scanner's metadata slice (including malformed short records).
      const metaLen = read(Math.min(4, recordLen)).readUInt32LE(0);
      const meta = JSON.parse(
        read(Math.min(metaLen, recordLen - 4)).toString("utf8"),
      );
      pos = start + byteLength;
      if (meta.type !== "transaction") continue;
      transactions++;
      for (const f of meta.failures ?? []) {
        if (f.reason === "mirror-capacity")
          problems.push(`frame ${meta.frame}: mirror-capacity: ${f.detail}`);
      }
    }
    if (requireTransactions && transactions === 0)
      problems.push("no transactions");
    return [...framing, ...problems];
  } finally {
    closeSync(fd);
  }
}

export function captureMirrorProblems(dir: string): string[] {
  const saved = join(dir, "scale-mirror.json");
  if (existsSync(saved))
    return JSON.parse(readFileSync(saved, "utf8")) as string[];
  const files = readdirSync(dir)
    .filter((f) => /^recording.*\.rs\d+(?:\.arm-\d+)?$/.test(f))
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
      const isTap = dirname(f) === tap;
      // A connection can close before publishing its first transaction.
      const size = statSync(f).size;
      if (isTap && size === 0) return [];
      if (size > 0) nonEmptyStreams++;
      return scaleMirrorFileProblems(f, !isTap).map(
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
