#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for GRT's pinned-Chromium resolution (lib/browser-harness.ts resolvePinnedChromium):
// never launches a browser and never downloads one. Each case runs the resolver in a child process
// (Playwright reads PLAYWRIGHT_BROWSERS_PATH when it loads) against a scratch private directory.
//
//  1. Neither copy matches the pin (a fake shared cache): it throws, naming both paths.
//  2. The shared cache matches (this box's real one): the private copy is seeded from it (a copy,
//     sha-checked), and a second process launches the private copy without touching the shared one.
//  3. A damaged private copy is replaced by a fresh seed.
//  4. The private copy alone suffices once the shared cache is gone (a fake, empty shared root).
// Cases 2-4 need this box's shared cache to hold the pinned build; without it they are reported
// SKIP (case 1 still runs).

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--child") {
  const { resolvePinnedChromium } = await import("../lib/browser-harness");
  try {
    console.log(JSON.stringify(resolvePinnedChromium()));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
  }
  process.exit(0);
}

let passes = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) passes++;
  else failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`,
  );
};
const root = mkdtempSync(join(tmpdir(), "self-test-pinned-chromium-"));
const child = (env: Record<string, string>) => {
  const r = spawnSync(
    process.execPath,
    [...process.execArgv, self, "--child"],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as {
      error?: string;
      source?: string;
      executablePath?: string;
      privatePath?: string;
    };
  } catch {
    return { error: `child said: ${r.stdout} ${r.stderr}` };
  }
};

// 1. neither matches
{
  const shared = join(root, "fake-shared");
  const bin = join(shared, "chromium-1223", "chrome-linux64", "chrome");
  mkdirSync(join(shared, "chromium-1223", "chrome-linux64"), {
    recursive: true,
  });
  writeFileSync(bin, "not chrome");
  const r = child({
    PLAYWRIGHT_BROWSERS_PATH: shared,
    RS_PRIVATE_BROWSERS_DIR: join(root, "private-1"),
  });
  check(
    "neither copy matches: it refuses, naming both paths",
    !!r.error &&
      r.error.includes(join(root, "private-1")) &&
      r.error.includes(bin),
    r.error ?? JSON.stringify(r),
  );
}

// 2-4. the real shared cache
const probe = child({ RS_PRIVATE_BROWSERS_DIR: join(root, "private-2") });
if (probe.error) {
  console.log(
    `SKIP cases 2-4: this box's shared cache does not hold the pinned build (${probe.error.slice(0, 120)})`,
  );
} else {
  check(
    `a fresh private dir is seeded from the shared cache (${probe.source})`,
    probe.source === "seeded",
  );
  const again = child({ RS_PRIVATE_BROWSERS_DIR: join(root, "private-2") });
  check(
    `a second process launches the private copy (${again.source}: ${again.executablePath?.replace(root, "<tmp>")})`,
    again.source === "private" && again.executablePath === probe.privatePath,
  );
  if (again.executablePath && existsSync(again.executablePath)) {
    chmodSync(again.executablePath, 0o755);
    truncateSync(again.executablePath, 1024);
  }
  const reseeded = child({ RS_PRIVATE_BROWSERS_DIR: join(root, "private-2") });
  check(
    `a damaged private copy is re-seeded (${reseeded.source})`,
    reseeded.source === "seeded",
  );
  const alone = child({
    RS_PRIVATE_BROWSERS_DIR: join(root, "private-2"),
    PLAYWRIGHT_BROWSERS_PATH: join(root, "empty-shared"),
  });
  check(
    `with the shared cache gone, the private copy alone launches (${alone.source})`,
    alone.source === "private",
    alone.error ?? "",
  );
}
rmSync(root, { recursive: true, force: true });
console.log(`self-test-pinned-chromium: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
