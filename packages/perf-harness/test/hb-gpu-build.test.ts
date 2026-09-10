// @vitest-environment node
//
// THE NOT-BUILT GATE. "Absent means NOT MEASURED, never zero" is the one bug this harness must not
// have. A blank page has no glyphs to raster, no texture to upload and no draw call to make, so an
// arm that quietly failed to load would be reported as the fastest and crispest thing on the page.
//
// The wasm is now COMMITTED at `packages/hb-gpu/vendor/`, so the absent case is rarer than it was
// — but it is still reachable (sparse checkout, interrupted `build.sh`) and the gate is still the
// difference between a named absence and a flattering lie.
//
// Three behaviours, and they are three different things:
//
//   built            sweep it, report nothing
//   absent, default  DROP it from the sweep and name it, with the command that produces it
//   absent, explicit FAIL, loudly, with the same words — a `--mechanism hb-gpu` that printed an
//                    empty table and exited 0 is the same lie in a quieter voice
//
// The paths are injected so the absent case is a real absence rather than a mock: this box HAS run
// `build.sh`, and a test that only ever saw the built state would pass on the machine where the gate
// does not matter and fail nowhere.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HB_GPU_BUILD_COMMAND,
  HB_GPU_GLUE_FILE,
  HB_GPU_WASM_FILE,
  hbGpuIsBuilt,
  unavailableMechanismError,
  unavailableMechanisms,
} from "../src/hb-gpu-build";
import { TEXT_MECHANISMS } from "../src/scenarios";

/** A directory with whichever of the two build outputs the case is about, and nothing else. */
async function buildDir(files: {
  glue?: boolean;
  wasm?: boolean;
}): Promise<{ glue: string; wasm: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gsw-hb-gpu-"));
  const paths = {
    glue: join(dir, "hb-gpu.mjs"),
    wasm: join(dir, "hb-gpu.wasm"),
  };
  if (files.glue) await writeFile(paths.glue, "export default () => {};");
  if (files.wasm) await writeFile(paths.wasm, Buffer.from([0, 97, 115, 109]));
  return paths;
}

describe("hb-gpu build gate", () => {
  it("points at the real build outputs and names the command that makes them", () => {
    // The paths are what `serve.ts` reads and what the skip message describes, so a typo here is a
    // permanently skipped arm that reports a plausible reason.
    expect(HB_GPU_GLUE_FILE.endsWith("packages/hb-gpu/vendor/hb-gpu.mjs")).toBe(
      true,
    );
    expect(
      HB_GPU_WASM_FILE.endsWith("packages/hb-gpu/vendor/hb-gpu.wasm"),
    ).toBe(true);
    // `vendor/`, NOT `dist/`. `dist/` is the tsdown TypeScript build and is gitignored; pointing
    // the harness back at it would make the arm unmeasurable on every fresh checkout again.
    expect(HB_GPU_GLUE_FILE).not.toContain("/dist/");
    expect(HB_GPU_BUILD_COMMAND).toBe("bash packages/hb-gpu/build.sh");
  });

  it("needs BOTH halves, because an interrupted build leaves only the glue", async () => {
    // emscripten writes the `.mjs` before the binary is finished. A check that looked only at the
    // glue would sweep the arm and then 404 inside `WebAssembly.instantiate`, which fails with a
    // magic-number complaint that says nothing about `build.sh`.
    expect(await hbGpuIsBuilt(await buildDir({ glue: true }))).toBe(false);
    expect(await hbGpuIsBuilt(await buildDir({ wasm: true }))).toBe(false);
    expect(await hbGpuIsBuilt(await buildDir({}))).toBe(false);
    expect(await hbGpuIsBuilt(await buildDir({ glue: true, wasm: true }))).toBe(
      true,
    );
  });

  it("drops hb-gpu from the sweep when it is not built, and says what is missing", async () => {
    const files = await buildDir({});
    const missing = await unavailableMechanisms(
      "text-render",
      [...TEXT_MECHANISMS],
      { files },
    );
    expect(missing.map((entry) => entry.mechanism)).toEqual(["hb-gpu"]);
    // The command is the whole value of the notice: a reader who sees "not measured" and no way to
    // change that learns nothing they could act on.
    expect(missing[0].command).toBe(HB_GPU_BUILD_COMMAND);
    expect(missing[0].what).toContain("packages/hb-gpu/vendor/hb-gpu.mjs");

    // And the other four arms are untouched — a missing build costs exactly one arm.
    const swept = [...TEXT_MECHANISMS].filter(
      (mechanism) => !missing.some((entry) => entry.mechanism === mechanism),
    );
    expect(swept).toEqual(["dom", "canvas2d", "hb-atlas", "hb-run"]);
  });

  it("reports nothing when the build is present", async () => {
    const files = await buildDir({ glue: true, wasm: true });
    expect(
      await unavailableMechanisms("text-render", [...TEXT_MECHANISMS], {
        files,
      }),
    ).toEqual([]);
  });

  it("is silent for a sweep that never asked for hb-gpu", async () => {
    const files = await buildDir({});
    // The four-arm sweep of an operator who passed `--mechanism dom,canvas2d` has nothing missing,
    // whatever the state of `vendor/`.
    expect(
      await unavailableMechanisms("text-render", ["dom", "canvas2d"], {
        files,
      }),
    ).toEqual([]);
    // And no other scenario knows the word "hb-gpu" at all.
    expect(
      await unavailableMechanisms("atlas-sprites", ["hb-gpu"], { files }),
    ).toEqual([]);
  });

  it("fails an EXPLICIT request loudly, in the same words", async () => {
    const files = await buildDir({});
    const missing = await unavailableMechanisms("text-render", ["hb-gpu"], {
      files,
    });
    const message = unavailableMechanismError(missing);
    expect(message).toContain('mechanism "hb-gpu" cannot be measured');
    expect(message).toContain(HB_GPU_BUILD_COMMAND);
    // Says out loud that this is the explicit path, so a reader is not left wondering why the same
    // situation skipped an arm five minutes ago and failed the run now.
    expect(message).toContain("asked for explicitly");
  });
});
