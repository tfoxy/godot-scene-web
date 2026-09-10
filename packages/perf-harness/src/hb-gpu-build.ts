// Is hb-gpu's wasm built, and what does the harness do when it is not.
//
// ABSENT MEANS NOT MEASURED, NEVER ZERO. That is the one bug this harness must not have, and a
// blank page produces excellent numbers — no glyphs is no raster, no upload and no draw — so an arm
// that quietly failed to load would be reported as the fastest and crispest thing on the page.
//
// THE WASM IS NOW COMMITTED, at `packages/hb-gpu/vendor/` (see `vendor/VENDOR.md`), so on a normal
// checkout this check passes and the arm is swept. It is kept, and still names `build.sh`, because
// the file can still be absent — a partial clone, a sparse checkout, or a `build.sh` interrupted
// between writing the glue and finishing the binary.
//
// AND A `ready()` THROW ABORTS THE WHOLE RUN. That is S7's trap, recorded in
// `docs/perf-harness.md`, and it is why this check is node-side rather than in the scenario: if the
// page were left to discover the missing wasm, the DEFAULT five-arm invocation would fail outright
// instead of printing a four-arm table. So the sweep drops the arm before a browser is launched,
// and `runComparison` reports it as NOT MEASURED, naming the command that produces it.
//
// EXPLICIT IS DIFFERENT FROM DEFAULT. `--mechanism hb-gpu` with no build is not an absence to work
// around — it is a request that cannot be honoured, and it fails loudly with the same message. The
// two behaviours share one reason string so they cannot drift apart.

import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/hb-gpu/vendor` — where `build.sh` writes, and what the repo COMMITS. (`dist/` next to
 *  it is the tsdown TypeScript build and stays gitignored.) */
export const HB_GPU_VENDOR_DIR = resolve(here, "..", "..", "hb-gpu", "vendor");

/**
 * Both halves of the build, and both are checked.
 *
 * The glue without the wasm is the more interesting failure: `vendor/hb-gpu.mjs` is written by
 * emscripten before the binary is finished, so an interrupted build can leave exactly that state,
 * and a check that looked only at the glue would sweep the arm and then 404 in the page.
 */
export const HB_GPU_GLUE_FILE = join(HB_GPU_VENDOR_DIR, "hb-gpu.mjs");
export const HB_GPU_WASM_FILE = join(HB_GPU_VENDOR_DIR, "hb-gpu.wasm");

/** The command that produces them. Quoted verbatim wherever an absence is reported. */
export const HB_GPU_BUILD_COMMAND = "bash packages/hb-gpu/build.sh";

/**
 * One sentence saying what is missing and why it cannot be substituted.
 *
 * Shared by the skip notice and the explicit-request failure so a reader sees the same words in
 * both places, and shaped like the rest of the harness's absences: `what` is the evidence that is
 * absent, `command` is the copy-pasteable line that produces it. See `text-report.ts`'s `missing`.
 */
export const HB_GPU_NOT_BUILT: { what: string; command: string } = {
  what: "hb-gpu's wasm (packages/hb-gpu/vendor/hb-gpu.mjs is absent — it is committed, so this checkout is incomplete)",
  command: HB_GPU_BUILD_COMMAND,
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether both build outputs are on disk. */
export async function hbGpuIsBuilt(
  files: { glue: string; wasm: string } = {
    glue: HB_GPU_GLUE_FILE,
    wasm: HB_GPU_WASM_FILE,
  },
): Promise<boolean> {
  const [glue, wasm] = await Promise.all([
    exists(files.glue),
    exists(files.wasm),
  ]);
  return glue && wasm;
}

/** A mechanism this run cannot measure, and the command that would make it measurable. */
export interface UnavailableMechanism {
  mechanism: string;
  what: string;
  command: string;
}

/**
 * Which of `mechanisms` cannot be measured on this checkout.
 *
 * Scenario-scoped rather than global: `hb-gpu` is a mechanism name only inside `text-render`, and a
 * future scenario is free to use the same word for something that needs no build. Everything else
 * returns nothing, so this is one `if` away from being a no-op for the other eight scenarios.
 *
 * NOT A SECOND MECHANISM. There is no `hb-gpu-unavailable` arm and no zero-filled row — the arm is
 * simply not swept, and the run reports the absence beside the table.
 */
export async function unavailableMechanisms(
  scenarioName: string,
  mechanisms: readonly string[],
  options: { files?: { glue: string; wasm: string } } = {},
): Promise<UnavailableMechanism[]> {
  if (scenarioName !== "text-render" || !mechanisms.includes("hb-gpu")) {
    return [];
  }
  if (await hbGpuIsBuilt(options.files)) {
    return [];
  }
  return [{ mechanism: "hb-gpu", ...HB_GPU_NOT_BUILT }];
}

/** The message an EXPLICIT request for an unbuildable mechanism fails with. */
export function unavailableMechanismError(
  entries: readonly UnavailableMechanism[],
): string {
  return entries
    .map(
      (entry) =>
        `mechanism "${entry.mechanism}" cannot be measured: ${entry.what}.\n  Run: ${entry.command}\n  (asked for explicitly, so it is a failure rather than a skipped arm — a default run drops it from the sweep and reports it as NOT MEASURED.)`,
    )
    .join("\n");
}
