#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for P3-GX's `linkTo` (lib/browser-harness.ts): a browser receiver leg serves the
// bundle it was given, even from a static root an earlier leg already linked a bundle into.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-bundle-link.ts
//
// Every case links fake bundles (a build.json each) into a private static root and GETs
// `/gsw-bundle/build.json` through a real `HarnessServer`, so it checks the bytes a page loads:
//
// 1. A fresh root serves bundle A.
// 2. The same root, linked to bundle B, serves B, and `linkTo` returns A. The rule before P3-GX
//    (keep any link that exists) still serves A here: the negative control, which is how every GSW
//    replay of C3's `p3st-a8-1` loaded a pre-P3-CT bundle whatever `--bundle` said.
// 3. Linking B again changes nothing.
// 4. A dangling link (its bundle deleted) is replaced.
// 5. A real directory where the link goes is refused and left untouched.
// 6. A relative target is stored resolved.
//
// Exits non-zero if any assertion fails.

import { existsSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { HarnessServer, linkTo } from "../lib/browser-harness";

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

/** The rule every bundle link used before P3-GX. */
function legacyEnsureLink(target: string, link: string): void {
  if (existsSync(link)) return;
  symlinkSync(target, link);
}

async function fakeBundle(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "build.json"), `{"bundle":"${name}"}\n`);
  return dir;
}

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "rs-bundle-link-"));
  try {
    const a = await fakeBundle(join(base, "bundles", "a"), "a");
    const b = await fakeBundle(join(base, "bundles", "b"), "b");
    const c = await fakeBundle(join(base, "bundles", "c"), "c");
    const root = join(base, "static");
    await mkdir(root, { recursive: true });
    const link = join(root, "gsw-bundle");
    const server = new HarnessServer({
      staticRoot: root,
      evidenceRoot: join(root, ".evidence"),
      allowedLegNonces: [],
    });
    const { origin } = await server.start(0);
    const served = async (): Promise<string | null> => {
      const r = await fetch(`${origin}/gsw-bundle/build.json`);
      if (!r.ok) return null;
      return (JSON.parse(await r.text()) as { bundle: string }).bundle;
    };
    try {
      // 1. Fresh root.
      assert(linkTo(a, link) === null, "1: a fresh link replaces nothing");
      assert((await served()) === "a", "1: a fresh root serves bundle a");

      // 2. Reused root: the negative control first, on a copy of the same state.
      const legacyRoot = join(base, "legacy");
      await mkdir(legacyRoot, { recursive: true });
      const legacyLink = join(legacyRoot, "gsw-bundle");
      legacyEnsureLink(a, legacyLink);
      legacyEnsureLink(b, legacyLink);
      assert(
        realpathSync(legacyLink) === realpathSync(a),
        "2: control: the pre-P3-GX rule keeps bundle a when asked for b",
      );
      const old = linkTo(b, link);
      assert(
        old === realpathSync(a),
        `2: linkTo returns the replaced target (got ${old})`,
      );
      assert((await served()) === "b", "2: the reused root serves bundle b");

      // 3. Idempotent.
      assert(linkTo(b, link) === null, "3: linking b again replaces nothing");
      assert((await served()) === "b", "3: still bundle b");

      // 4. Dangling link.
      linkTo(c, link);
      await rm(c, { recursive: true });
      assert((await served()) === null, "4: a dangling link serves nothing");
      const was = linkTo(b, link);
      assert(was !== null, "4: a dangling link is replaced");
      assert((await served()) === "b", "4: bundle b after the dangling link");

      // 5. A real directory is refused and untouched.
      const realRoot = join(base, "real");
      await fakeBundle(join(realRoot, "gsw-bundle"), "real");
      let threw = false;
      try {
        linkTo(b, join(realRoot, "gsw-bundle"));
      } catch {
        threw = true;
      }
      assert(threw, "5: a real directory at the link is refused");
      assert(
        (await readFile(join(realRoot, "gsw-bundle", "build.json"), "utf8")) ===
          '{"bundle":"real"}\n',
        "5: the real directory is untouched",
      );

      // 6. A relative target is stored resolved.
      const relRoot = join(base, "rel");
      await mkdir(relRoot, { recursive: true });
      linkTo(relative(process.cwd(), a), join(relRoot, "gsw-bundle"));
      assert(
        readlinkSync(join(relRoot, "gsw-bundle")) === realpathSync(a),
        "6: the link stores the resolved target",
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  console.log(
    `self-test-bundle-link: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exit(1);
}

await main();
