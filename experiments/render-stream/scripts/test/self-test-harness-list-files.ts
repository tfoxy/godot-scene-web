#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for WX's `listFiles` (lib/browser-harness.ts), the static server's `GET <dir>/?list`
// that the web export's staged store reads (RS_RECEIVER_WEB_STORE=staged):
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-harness-list-files.ts [--files N]
//
// 1. A store-shaped tree (one `sha256/` directory of N empty `<hash>.grt` files, default 260000,
//    plus a few nested and symlinked directories) lists every file, sorted, through `listFiles`.
// 2. The same tree's `GET /store/?list` through a real `HarnessServer` answers 200 with that list.
// 3. The negative control: the pre-WX rule (`out.push(...listFiles(sub))`) on the same tree
//    throws RangeError, as CG4's 288k-file store did (between 120k and 200k entries).
//
// Exits non-zero if any assertion fails.

import { readdirSync, statSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessServer, listFiles } from "../lib/browser-harness";

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

/** The pre-WX listFiles, verbatim but for the name: the negative control. */
function legacyListFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && statSync(join(root, rel)).isDirectory());
    if (isDir) out.push(...legacyListFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--files");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 260000;
  if (!Number.isInteger(n) || n < 250000)
    throw new Error(`--files must be an integer >= 250000 (got ${n})`);
  const base = await mkdtemp(join(tmpdir(), "rs-list-files-"));
  try {
    const store = join(base, "static", "store");
    const flat = join(store, "sha256");
    await mkdir(flat, { recursive: true });
    const expected: string[] = [];
    // Hex names, as a store's: `<64 hex>.grt`, in a deliberately unsorted creation order.
    for (let k = 0; k < n; k++) {
      const name = `${((k * 2654435761) >>> 0).toString(16).padStart(8, "0")}${k.toString(16).padStart(56, "0")}.grt`;
      await writeFile(join(flat, name), "");
      expected.push(`sha256/${name}`);
    }
    await mkdir(join(store, "a", "b"), { recursive: true });
    await writeFile(join(store, "a", "b", "deep.grp"), "");
    await writeFile(join(store, "a", "top.grm"), "");
    await mkdir(join(base, "elsewhere"), { recursive: true });
    await writeFile(join(base, "elsewhere", "linked.ktx2"), "");
    symlinkSync(join(base, "elsewhere"), join(store, "z-link"));
    expected.push("a/b/deep.grp", "a/top.grm", "z-link/linked.ktx2");
    expected.sort();

    // 1. listFiles itself.
    let listed: string[] = [];
    try {
      listed = listFiles(store);
    } catch (e) {
      assert(false, `1: listFiles threw ${String(e)}`);
    }
    assert(
      listed.length === expected.length,
      `1: ${listed.length} files listed, ${expected.length} expected`,
    );
    assert(
      listed.every((p, k) => p === expected[k]),
      "1: the list is every file, sorted, relative to the root",
    );

    // 2. Through the static server.
    const server = new HarnessServer({
      staticRoot: join(base, "static"),
      evidenceRoot: join(base, ".evidence"),
      allowedLegNonces: [],
    });
    const { origin } = await server.start(0);
    try {
      const r = await fetch(`${origin}/store/?list`);
      assert(r.status === 200, `2: GET /store/?list answered ${r.status}`);
      if (r.status === 200) {
        const body = (await r.json()) as string[];
        assert(
          body.length === expected.length &&
            body.every((p, k) => p === expected[k]),
          `2: the served list matches (${body.length} entries)`,
        );
      }
    } finally {
      await server.stop();
    }

    // 3. Negative control: the spread overflows the stack on the same tree.
    let threw = "";
    try {
      legacyListFiles(store);
    } catch (e) {
      threw = e instanceof RangeError ? "RangeError" : String(e);
    }
    assert(
      threw === "RangeError",
      `3: control: the pre-WX spread throws RangeError at ${n} entries (got ${threw || "no error"})`,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  console.log(
    `self-test-harness-list-files: ${assertions - failures}/${assertions} assertions passed (${n} files)`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
