// @vitest-environment node
//
// NODE, because every assertion here is about bytes on disk.
//
// THE VENDORED BINARY IS WHAT `vendor/VENDOR.md` SAYS IT IS.
//
// `vendor/` is committed — a third-party artifact, not a build output — precisely so a fresh
// checkout can use this package without docker and emscripten. The cost of committing it is that
// the digests in `VENDOR.md` are now a claim someone has to keep true, and a claim nobody checks
// rots. So this file reads the digests OUT OF the prose and asserts them against the files, which
// makes the two ways of getting it wrong both loud:
//
//   rebuilt binary, stale doc   the sha256 rows stop matching
//   edited doc, same binary     likewise, in the other direction
//
// It also re-states the two pins from `build.sh` — the tarball checksum and the emsdk image digest
// — so that bumping one and forgetting the other cannot pass.
//
// DOES NOT IMPORT THE GLUE, AND NO LONGER BECAUSE IT CANNOT. `hb-gpu.mjs` is compiled with
// `-sENVIRONMENT=web,worker`, so a node import that lets it go looking for the `.wasm` itself
// aborts with "both async and sync fetching of the wasm failed" — but `-sINCOMING_MODULE_JS_API=
// wasmBinary` means a caller that hands over the bytes never reaches that path, and `shape.test.ts`
// runs the glue under node on exactly that basis. What is asserted HERE is about the file on disk,
// which does not need a runtime at all; loading one would only add a way for these assertions to
// fail for an unrelated reason.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const vendorDir = join(pkgDir, "vendor");

const read = (name: string) => readFile(join(vendorDir, name));
const text = (name: string) => readFile(join(vendorDir, name), "utf8");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** One row of `VENDOR.md`'s "What is here" table, as `{ bytes, sha256 }`. Sizes are written with
 *  thin spaces for readability (`227 049`), so the separators come back out here rather than being
 *  something the doc has to give up. */
async function recordedFor(
  file: string,
): Promise<{ bytes: number; sha256: string }> {
  const doc = await text("VENDOR.md");
  const row = doc.split("\n").find((line) => line.startsWith(`| \`${file}\``));
  expect(row, `VENDOR.md has no table row for \`${file}\``).toBeDefined();
  const cells = (row as string).split("|").map((cell) => cell.trim());
  const bytes = Number(cells[2].replace(/[\s,]/g, ""));
  const digest = cells[3].replace(/`/g, "");
  expect(
    digest,
    `VENDOR.md's sha256 cell for \`${file}\` is not a hex digest`,
  ).toMatch(/^[0-9a-f]{64}$/);
  return { bytes, sha256: digest };
}

describe("hb-gpu vendored artifacts", () => {
  it("ships a real WebAssembly binary, not a git-lfs pointer or an empty file", async () => {
    const wasm = await read("hb-gpu.wasm");
    // `\0asm` and version 1, the whole of the wasm preamble. A checkout that resolved the file to
    // an LFS stub, a truncated download or a text-mode mangling all die here rather than three
    // layers into a browser.
    expect(Array.from(wasm.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(new DataView(wasm.buffer, wasm.byteOffset).getUint32(4, true)).toBe(
      1,
    );
  });

  it("compiles as a module and exports the memory the glue reads heaps off", async () => {
    const wasm = await read("hb-gpu.wasm");
    // Compilation validates every section, which magic bytes alone do not. Not INSTANTIATION: the
    // module imports emscripten's runtime callbacks, and standing those up in node would be
    // reimplementing the glue that is deliberately not loaded here.
    const module = await WebAssembly.compile(
      wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    );
    const exports = WebAssembly.Module.exports(module);
    expect(exports.some((entry) => entry.kind === "memory")).toBe(true);
    // `hb-gpu.symbols` names 39 functions; emscripten adds its own `__wasm_call_ctors` and the
    // timeout callback and minifies the lot, so the count is asserted as a floor rather than an
    // equality — a link that dropped the encoder would come back far under it.
    //
    // THE FLOOR MOVED FROM 25 TO 41 WITH THE SHAPER, and moving it was the point. The old floor
    // would have passed a binary with `hb_shape` and every `hb_buffer_*` gone: 25 symbols still
    // link, and the failure would show up as this package silently having no `shape` at all.
    const functions = exports.filter((entry) => entry.kind === "function");
    expect(functions.length).toBeGreaterThanOrEqual(41);
  });

  it("matches the size and sha256 VENDOR.md records for hb-gpu.wasm", async () => {
    const wasm = await read("hb-gpu.wasm");
    const recorded = await recordedFor("hb-gpu.wasm");
    expect(wasm.byteLength).toBe(recorded.bytes);
    expect(
      sha256(wasm),
      "hb-gpu.wasm and VENDOR.md disagree — a rebuild must update the digest table in the same commit",
    ).toBe(recorded.sha256);
  });

  it("matches the size and sha256 VENDOR.md records for hb-gpu.mjs", async () => {
    const glue = await read("hb-gpu.mjs");
    const recorded = await recordedFor("hb-gpu.mjs");
    expect(glue.byteLength).toBe(recorded.bytes);
    expect(
      sha256(glue),
      "hb-gpu.mjs and VENDOR.md disagree — a rebuild must update the digest table in the same commit",
    ).toBe(recorded.sha256);
  });

  it("pins the same harfbuzz tarball and emsdk image that build.sh does", async () => {
    const script = await readFile(join(pkgDir, "build.sh"), "utf8");
    const doc = await text("VENDOR.md");

    const tarball = script.match(/^HB_SHA256="([0-9a-f]{64})"$/m)?.[1];
    expect(tarball, "build.sh no longer pins HB_SHA256").toBeDefined();
    expect(
      doc.includes(tarball as string),
      "VENDOR.md does not quote build.sh's HB_SHA256 — one of the two was bumped alone",
    ).toBe(true);

    // THE PIN THAT USED TO BE MISSING. `build.sh` ran `emscripten/emsdk:latest` while the source
    // was checksummed, so the binary was reproducible on one side only.
    const image = script.match(/^IMAGE="([^"]+)"$/m)?.[1];
    expect(image, "build.sh no longer sets IMAGE").toBeDefined();
    expect(
      image as string,
      "build.sh is back on a floating tag — pin the emsdk image by digest",
    ).toMatch(/^emscripten\/emsdk@sha256:[0-9a-f]{64}$/);
    expect(
      doc.includes((image as string).split("@")[1]),
      "VENDOR.md does not quote build.sh's emsdk digest — one of the two was bumped alone",
    ).toBe(true);
  });

  it("carries the license texts the binaries oblige it to carry", async () => {
    const harfbuzz = await text("LICENSE-harfbuzz");
    // Old MIT: the copyright notice plus the two disclaimer paragraphs, which is the whole of what
    // HarfBuzz asks for in exchange for shipping its compiled bytes.
    expect(harfbuzz).toContain('so-called "Old MIT" license');
    expect(harfbuzz).toContain(
      "above copyright notice and the following two paragraphs",
    );
    expect(harfbuzz).toContain("Behdad Esfahbod");

    const emscripten = await text("LICENSE-emscripten");
    expect(emscripten).toContain(
      "University of Illinois/NCSA Open Source License",
    );
    expect(emscripten).toContain("Emscripten authors");
  });

  it("exposes every vendored artifact as a package subpath that resolves", async () => {
    const manifest = JSON.parse(
      await readFile(join(pkgDir, "package.json"), "utf8"),
    ) as {
      files: string[];
      exports: Record<string, string | Record<string, string>>;
    };
    // `files` is what `npm pack` puts in the tarball. Exporting a subpath that publishing drops is
    // the failure mode where it works in the monorepo and 404s for a consumer.
    expect(manifest.files).toContain("vendor");

    const subpaths = ["./vendor/hb-gpu.wasm", "./vendor/hb-gpu.mjs"];
    for (const subpath of subpaths) {
      const entry = manifest.exports[subpath];
      expect(entry, `package.json does not export ${subpath}`).toBeDefined();
      const target =
        typeof entry === "string"
          ? entry
          : (entry as Record<string, string>).default;
      expect(target, `${subpath} has no resolvable target`).toBeDefined();
      // Resolves to a file that is actually there, from the package root.
      await expect(readFile(join(pkgDir, target))).resolves.toBeDefined();
    }
  });
});
