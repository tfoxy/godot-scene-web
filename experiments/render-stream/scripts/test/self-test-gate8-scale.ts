import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tagBurstProblems } from "../lib/gate8-id14-checks";
import {
  captureMirrorProblems,
  runScaleMirrorChecks,
  scaleMirrorFileProblems,
  scaleMirrorProblems,
} from "../lib/gate8-scale-checks";
import { MAGIC_V13 } from "../lib/render-stream-2";

function stream(reason?: string): Uint8Array {
  const meta = Buffer.from(
    JSON.stringify({
      type: "transaction",
      frame: 1,
      failures: reason ? [{ reason, detail: "full" }] : [],
    }),
  );
  const rec = Buffer.alloc(8 + meta.length);
  rec.writeUInt32LE(4 + meta.length, 0);
  rec.writeUInt32LE(meta.length, 4);
  meta.copy(rec, 8);
  return Buffer.concat([MAGIC_V13, rec]);
}
assert.deepEqual(scaleMirrorProblems(stream()), []);
assert.match(
  scaleMirrorProblems(stream("mirror-capacity"))[0],
  /mirror-capacity/,
);
assert.deepEqual(scaleMirrorProblems(stream("pre-existing-object")), []);
assert.ok(scaleMirrorProblems(MAGIC_V13).length > 0);
const burst = Array.from({ length: 1700 }, (_, i) => ({
  slot: String(2000 + i),
  stamps: [502],
}));
assert.deepEqual(tagBurstProblems(burst), []);
assert.ok(tagBurstProblems(burst.slice(1)).length > 0);
assert.ok(
  tagBurstProblems(burst.map((r) => ({ ...r, stamps: [621] }))).length > 0,
);
assert.ok(
  tagBurstProblems(burst.map((r) => ({ ...r, stamps: [499] }))).length > 0,
);
assert.deepEqual(
  tagBurstProblems(burst.map((r) => ({ ...r, stamps: [620] }))),
  [],
);
assert.ok(
  tagBurstProblems(burst.map((r) => ({ ...r, stamps: [] }))).length > 0,
);
assert.ok(
  tagBurstProblems(burst.map((r) => ({ ...r, slot: "2000" }))).length > 0,
);
const root = mkdtempSync(join(tmpdir(), "scale-selftest-"));
try {
  // Keep the old in-memory scanner as the oracle, including truncated framing.
  const samples = [
    stream(),
    stream("mirror-capacity"),
    stream("pre-existing-object"),
    MAGIC_V13,
    Buffer.from("bad magic"),
    new Uint8Array(),
    Buffer.concat([stream("mirror-capacity"), Buffer.from([1, 2, 3])]),
    Buffer.concat([MAGIC_V13, Buffer.from([100, 0, 0, 0])]),
  ];
  // Resource payloads are skipped; metadata and prefixes straddle tiny reads.
  const payload = Buffer.alloc(257, 0xff);
  const withPayload = Buffer.concat([
    stream("mirror-capacity"),
    payload,
    stream().subarray(8),
  ]);
  withPayload.writeUInt32LE(withPayload.readUInt32LE(8) + payload.length, 8);
  samples.push(withPayload);
  for (const [i, data] of samples.entries()) {
    const path = join(root, `sample-${i}.rs13`);
    writeFileSync(path, data);
    for (const requireTransactions of [true, false]) {
      const old = scaleMirrorProblems(data);
      const expected = requireTransactions
        ? old
        : old.filter((p) => p !== "no transactions");
      for (const bufferSize of [1, 3, 7, 65536])
        assert.deepEqual(
          scaleMirrorFileProblems(path, requireTransactions, bufferSize),
          expected,
        );
    }
  }
  for (const name of ["full", "patch", "inline", "off"]) {
    const path = fileURLToPath(
      new URL(`../../protocol/golden-8/${name}.rs8`, import.meta.url),
    );
    for (const bufferSize of [3, 65536])
      assert.deepEqual(
        scaleMirrorFileProblems(path, true, bufferSize),
        scaleMirrorProblems(readFileSync(path)),
      );
  }
  // A sparse resource record proves that payload size never becomes a read/allocation size.
  const sparse = join(root, "large.rs13");
  const fd = openSync(sparse, "w");
  try {
    const meta = Buffer.from(JSON.stringify({ type: "resource" }));
    const header = Buffer.alloc(16 + meta.length);
    header.set(MAGIC_V13);
    header.writeUInt32LE(0x80000000, 8);
    header.writeUInt32LE(meta.length, 12);
    header.set(meta, 16);
    writeSync(fd, header);
    const end = 8 + 4 + 0x80000000;
    ftruncateSync(fd, end);
    writeSync(fd, stream().subarray(8), 0, stream().length - 8, end);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(scaleMirrorFileProblems(sparse), []);
  const arms = join(root, "arms");
  mkdirSync(arms);
  writeFileSync(join(arms, "recording.rs8"), stream());
  writeFileSync(join(arms, "recording.rs8.arm-2"), stream("mirror-capacity"));
  writeFileSync(join(arms, "recording.rs8.arm-3"), stream("mirror-capacity"));
  assert.deepEqual(captureMirrorProblems(arms), [
    "recording.rs8.arm-2: frame 1: mirror-capacity: full",
    "recording.rs8.arm-3: frame 1: mirror-capacity: full",
  ]);
  rmSync(arms, { recursive: true });
  const host = join(root, "g8id14", "tag-burst", "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(
    join(host, "argv.txt"),
    "/binary\n--path\n/w/fixtures/capture-scale\n",
  );
  writeFileSync(join(host, "recording.rs13"), stream());
  assert.equal(runScaleMirrorChecks(root)[0].passed, true);
  writeFileSync(join(host, "recording.rs13"), stream("mirror-capacity"));
  assert.equal(runScaleMirrorChecks(root)[0].passed, false);
  rmSync(join(host, "recording.rs13"));
  assert.equal(runScaleMirrorChecks(root)[0].passed, false);
  writeFileSync(join(host, "recording.rs13"), stream());
  const tap = join(host, "tap");
  mkdirSync(tap);
  writeFileSync(join(tap, "stream-1.rs2"), "");
  assert.equal(runScaleMirrorChecks(root)[0].passed, true);
  writeFileSync(join(tap, "stream-2.rs2"), MAGIC_V13);
  assert.equal(runScaleMirrorChecks(root)[0].passed, true);
  writeFileSync(join(tap, "stream-3.rs2"), "bad magic");
  const badMagic = runScaleMirrorChecks(root)[0];
  assert.equal(badMagic.passed, false);
  assert.match(badMagic.detail, /stream-3\.rs2: bad-magic/);
  rmSync(join(tap, "stream-3.rs2"));
  rmSync(join(tap, "stream-2.rs2"));
  rmSync(join(host, "recording.rs13"));
  assert.equal(runScaleMirrorChecks(root)[0].passed, false);
  writeFileSync(join(tap, "stream-1.rs2"), stream());
  assert.equal(runScaleMirrorChecks(root)[0].passed, true);
  writeFileSync(join(tap, "stream-1.rs2"), stream("mirror-capacity"));
  assert.equal(runScaleMirrorChecks(root)[0].passed, false);
  rmSync(join(root, "g8id14"), { recursive: true });

  const idle = join(root, "idle");
  mkdirSync(idle);
  writeFileSync(
    join(idle, "argv.txt"),
    "/binary\n--path\n/w/fixtures/capture-scale\n",
  );
  const listenerEnv = "GRC_MODE=arm\nGRC_LIVE_LISTEN=127.0.0.1:12345\n";
  writeFileSync(join(idle, "env.txt"), listenerEnv);
  assert.equal(runScaleMirrorChecks(root)[0].passed, true);
  mkdirSync(join(idle, "tap"));
  writeFileSync(join(idle, "env.txt"), `${listenerEnv}GRC_LIVE_TAP_DIR=\n`);
  assert.equal(runScaleMirrorChecks(root)[0].passed, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("self-test-gate8-scale: 105 passed, 0 failed");
