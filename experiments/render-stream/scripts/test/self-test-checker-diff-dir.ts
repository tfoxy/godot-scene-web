// GRT4a: a checker judging a gate 7 view never writes into the source the view links to
// (lib/gate0-checks.ts checkerDiffDir). G7q's g7-web-gdscript run failed with EACCES when the
// gate 1 checker wrote native-view/<leg>/receiver/diff/step-0.png through the view's symlink into a
// read-only source-cache entry. Synthetic: a read-only "cache entry" with a receiver leg, a view
// linking that leg, and a native run's own leg; the diff is written the way computeCheckpoints
// writes it (mkdir + compareRgbaBuffers' diffPath).
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-checker-diff-dir.ts

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";
import { checkerDiffDir } from "../lib/gate0-checks";

let fails = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fails++;
};

const tmp = mkdtempSync(join(tmpdir(), "rs-diff-dir-"));
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const treeSum = (d: string): string =>
  createHash("sha256")
    .update(
      walk(d)
        .sort()
        .map((p) => `${relative(d, p)}:${readFileSync(p).toString("hex")}`)
        .join("\n"),
    )
    .digest("hex");
const setMode = (d: string, mode: number, dirMode: number): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) setMode(p, mode, dirMode);
    else chmodSync(p, mode);
  }
  chmodSync(d, dirMode);
};

try {
  // A source-cache entry: a leg with an existing diff from the maker's own checker, read-only.
  const entry = join(tmp, "cache", "key", "gate1--all");
  mkdirSync(join(entry, "receiver-patch", "receiver", "diff"), {
    recursive: true,
  });
  writeFileSync(
    join(entry, "receiver-patch", "receiver", "diff", "step-0.png"),
    "maker",
  );
  writeFileSync(
    join(entry, "receiver-patch", "receiver", "applied.json"),
    "{}",
  );
  const before = treeSum(entry);
  setMode(entry, 0o444, 0o555);

  // The view: <run>/gate1/native-view/<leg> -> the entry's leg.
  const view = join(tmp, "run", "gate1", "native-view");
  mkdirSync(view, { recursive: true });
  symlinkSync(join(entry, "receiver-patch"), join(view, "receiver-patch"));
  const viewReceiver = join(view, "receiver-patch", "receiver");
  const viewDiff = checkerDiffDir(view, viewReceiver);
  check(
    "a view leg linked to a source writes its diffs under <view>/view-diff/",
    viewDiff === join(view, "view-diff", "receiver-patch", "receiver", "diff"),
  );

  // The checker's own write path: mkdir, then compareRgbaBuffers writes diffPath.
  const px = (v: number) => new Uint8Array([v, v, v, 255, v, v, v, 255]);
  await mkdir(viewDiff, { recursive: true });
  const verdict = await compareRgbaBuffers(px(10), px(20), {
    width: 2,
    height: 1,
    threshold: 0,
    maxDiffRatio: 0,
    maxChannelDelta: 0,
    diffPath: join(viewDiff, "step-0.png"),
  });
  check(
    "the diff image lands in the view (a real file in the run's own out dir)",
    !verdict.ok && existsSync(join(viewDiff, "step-0.png")),
  );
  setMode(entry, 0o644, 0o755);
  check(
    "the read-only source entry is byte-for-byte unmodified",
    treeSum(entry) === before,
  );
  setMode(entry, 0o444, 0o555);

  // Before GRT4a, the path was <view leg>/receiver/diff: through the link, into the entry.
  let refused = false;
  try {
    writeFileSync(join(viewReceiver, "diff", "step-0.png"), "x");
  } catch {
    refused = true;
  }
  check(
    "the old path writes through the link into the entry (refused when read-only)",
    refused,
  );

  // A native run's own leg keeps <receiver>/diff, unchanged.
  const native = join(tmp, "native-run");
  mkdirSync(join(native, "live", "receiver"), { recursive: true });
  check(
    "a native run's own leg keeps <receiver>/diff",
    checkerDiffDir(native, join(native, "live", "receiver")) ===
      join(native, "live", "receiver", "diff"),
  );
  // ...even when the run directory itself is reached through a symlink.
  symlinkSync(native, join(tmp, "native-link"));
  const viaLink = join(tmp, "native-link");
  check(
    "a run reached through a symlinked --out still writes its own legs' diffs in place",
    checkerDiffDir(viaLink, join(viaLink, "live", "receiver")) ===
      join(viaLink, "live", "receiver", "diff"),
  );
  // A leg that does not exist yet (no receiver dir) resolves through its deepest ancestor.
  check(
    "a not-yet-created leg in the run's own dir keeps <receiver>/diff",
    checkerDiffDir(native, join(native, "new-leg", "receiver")) ===
      join(native, "new-leg", "receiver", "diff"),
  );
} finally {
  try {
    setMode(join(tmp, "cache"), 0o644, 0o755);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  fails === 0
    ? "self-test-checker-diff-dir: PASS"
    : `self-test-checker-diff-dir: FAIL (${fails})`,
);
process.exit(fails === 0 ? 0 : 1);
