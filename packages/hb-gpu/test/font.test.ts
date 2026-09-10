// @vitest-environment node
//
// `createFont` when the wasm says no: what it returns, and what it frees on the way out.
//
// THESE ARE ALL SILENT FAILURES IN THE ORIGINAL. `_malloc` returning 0 was unchecked, so an
// out-of-memory heap took the whole face written over address 0 — the null page — and corrupted
// itself somewhere the symptom never points back to. And the one failure that WAS checked threw,
// after allocating the face copy and creating a blob, a face and a font, all four of which were
// then unreachable for the life of the module: a leak per corrupt face, in a package whose entire
// premise is that its memory cost is measurable.
//
// A FAKE WASM AND NOT THE REAL ONE, deliberately. `dist/hb-gpu.wasm` is a docker + emscripten build
// output that `dist/` gitignores, so a fresh checkout has never built it — and none of the
// properties below are about HarfBuzz. They are about whether this file's bookkeeping balances,
// which a heap you can count is a far better witness for than a heap you cannot.

import { describe, expect, it } from "vitest";
import {
  createHbGpu,
  type HbGpuFailure,
  type HbGpuWasmExports,
} from "../src/index";

interface FakeWasm {
  exports: HbGpuWasmExports;
  /** Pointers handed out by `_malloc` and not yet freed. A non-empty set at the end is a leak. */
  live: Set<number>;
  /** Live HarfBuzz objects, by kind. Same test: everything created must be destroyed. */
  objects: Map<string, Set<number>>;
}

/**
 * A bump allocator and a handle table, which is all this file's bookkeeping can be checked against.
 *
 * `mallocFails` counts DOWN: `mallocFails: 2` lets the first allocation through and fails the
 * second, which is how the extents scratch is reached without the face copy failing first.
 */
function fakeWasm(
  options: {
    upem?: number;
    mallocFailsOn?: number;
    drawFails?: boolean;
    blobLengthOverride?: number;
    faceFails?: boolean;
    /** The buffer comes back un-`successful`, i.e. `hb_buffer_create` gave back the nil one. */
    bufferFails?: boolean;
    /** `hb_buffer_allocation_successful` flips to false once shaping has been attempted. */
    shapeExhaustsHeap?: boolean;
    /** `hb_feature_from_string` refuses everything. */
    featureFails?: boolean;
  } = {},
): FakeWasm {
  const heap = new Uint8Array(1 << 20);
  let next = 8;
  const live = new Set<number>();
  const objects = new Map<string, Set<number>>();
  const blobLengths = new Map<number, number>();
  let mallocs = 0;
  let handle = 0x1000;
  let shaped = false;

  const create = (kind: string): number => {
    handle += 8;
    const set = objects.get(kind) ?? new Set<number>();
    set.add(handle);
    objects.set(kind, set);
    return handle;
  };
  const destroy = (kind: string, pointer: number): void => {
    objects.get(kind)?.delete(pointer);
  };

  const exports: HbGpuWasmExports = {
    HEAPU8: heap,
    HEAP32: new Int32Array(heap.buffer),
    HEAPU16: new Uint16Array(heap.buffer),
    UTF8ToString: () => "",
    _malloc(bytes) {
      mallocs += 1;
      if (options.mallocFailsOn === mallocs) return 0;
      const pointer = next;
      next += Math.max(8, bytes + (8 - (bytes % 8)));
      live.add(pointer);
      return pointer;
    },
    _free(pointer) {
      live.delete(pointer);
    },
    _hb_blob_create(data, length) {
      const blob = create("blob");
      blobLengths.set(blob, options.blobLengthOverride ?? length);
      // `data` is retained by the blob in the real thing; here it only has to be plausible.
      void data;
      return blob;
    },
    _hb_blob_get_data: () => 0,
    _hb_blob_get_length: (blob) => blobLengths.get(blob) ?? 0,
    _hb_blob_destroy: (blob) => destroy("blob", blob),
    _hb_face_create: () => (options.faceFails ? 0 : create("face")),
    _hb_face_destroy: (face) => destroy("face", face),
    _hb_face_get_upem: () => options.upem ?? 1000,
    _hb_font_create: () => create("font"),
    _hb_font_destroy: (font) => destroy("font", font),
    _hb_font_set_scale: () => {},
    _hb_font_get_nominal_glyph: () => 0,
    _hb_shape: () => {
      shaped = true;
    },
    _hb_buffer_create: () => create("buffer"),
    _hb_buffer_destroy: (buffer) => destroy("buffer", buffer),
    // The nil buffer's distinguishing property, and the only one: `hb_buffer_create` hands it back
    // instead of null, so `successful` is what a caller has to read.
    _hb_buffer_allocation_successful: () =>
      options.bufferFails || (options.shapeExhaustsHeap && shaped) ? 0 : 1,
    _hb_buffer_clear_contents: () => {},
    _hb_buffer_add_utf16: () => {},
    _hb_buffer_guess_segment_properties: () => {},
    _hb_buffer_set_direction: () => {},
    _hb_buffer_set_script: () => {},
    _hb_buffer_set_language: () => {},
    _hb_language_from_string: () => 1,
    _hb_script_from_string: () => 1,
    _hb_feature_from_string: () => (options.featureFails ? 0 : 1),
    _hb_buffer_get_length: () => 0,
    _hb_buffer_get_glyph_infos: () => 0,
    _hb_buffer_get_glyph_positions: () => 0,
    _hb_gpu_draw_create_or_fail: () => (options.drawFails ? 0 : create("draw")),
    _hb_gpu_draw_destroy: (draw) => destroy("draw", draw),
    _hb_gpu_draw_set_scale: () => {},
    _hb_gpu_draw_glyph_or_fail: () => 0,
    _hb_gpu_draw_encode: () => 0,
    _hb_gpu_draw_clear: () => {},
    _hb_gpu_draw_reset: () => {},
    _hb_gpu_draw_recycle_blob: () => {},
    _hb_gpu_shader_source: () => 0,
    _hb_gpu_draw_shader_source: () => 0,
  };
  return { exports, live, objects };
}

async function moduleOver(wasm: FakeWasm) {
  const failures: HbGpuFailure[] = [];
  const module = await createHbGpu(
    async () => wasm.exports,
    new ArrayBuffer(0),
    {
      onError: (failure) => failures.push(failure),
    },
  );
  return { module, failures };
}

/** Every HarfBuzz object of every kind that is still alive. */
const leaked = (wasm: FakeWasm): number =>
  [...wasm.objects.values()].reduce((total, set) => total + set.size, 0);

const reasons = (failures: HbGpuFailure[]) => failures.map((f) => f.reason);

describe("createFont", () => {
  it("builds a font on a healthy module", async () => {
    const wasm = fakeWasm({ upem: 2048 });
    const { module, failures } = await moduleOver(wasm);
    const font = module.createFont(new Uint8Array(64));
    expect(font?.upem).toBe(2048);
    expect(failures).toEqual([]);
    font?.destroy();
    // `destroy` frees the face copy and the extents scratch, and destroys all four objects.
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("refuses zero face bytes before touching the heap", async () => {
    // The shape a TRANSFERRED ArrayBuffer takes. `text-render.ts` hands each face to two wasm
    // modules and slices for exactly this reason; a face that arrives empty encodes every glyph to
    // nothing and renders as a blank page.
    const wasm = fakeWasm();
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(0))).toBeNull();
    expect(reasons(failures)).toEqual(["empty-face"]);
    expect(wasm.live.size).toBe(0);
  });

  it("survives _malloc returning 0 for the face copy", async () => {
    // UNCHECKED BEFORE: `HEAPU8.set(bytes, 0)` wrote the entire face over the null page.
    const wasm = fakeWasm({ mallocFailsOn: 1 });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["out-of-memory"]);
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("survives _malloc returning 0 for the extents scratch, and unwinds everything above it", async () => {
    // The second allocation, made after the blob, the face, the font and the encoder exist. A
    // scratch of 0 would make `glyphFor` read a glyph id out of address 0.
    const wasm = fakeWasm({ mallocFailsOn: 2 });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["out-of-memory"]);
    expect(wasm.live.size, "the face copy was leaked").toBe(0);
    expect(leaked(wasm), "HarfBuzz objects were leaked").toBe(0);
  });

  it("returns null instead of throwing when the encoder cannot be created", async () => {
    // THE LEAK THIS REPLACES. The old code threw here, having already allocated the face copy and
    // created a blob, a face and a font — four things unreachable for the life of the module.
    const wasm = fakeWasm({ drawFails: true });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["encoder-unavailable"]);
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("rejects a face whose upem would scale every glyph to Infinity", async () => {
    // `webgl.ts` divides `pixelsPerEm` by this. A zero makes every instance record NaN and the draw
    // a silent no-op — a blank page with no error anywhere.
    for (const upem of [0, -1000, Number.NaN, 1e9]) {
      const wasm = fakeWasm({ upem });
      const { module, failures } = await moduleOver(wasm);
      expect(module.createFont(new Uint8Array(64)), `upem ${upem}`).toBeNull();
      expect(reasons(failures)).toEqual(["face-rejected"]);
      expect(wasm.live.size).toBe(0);
      expect(leaked(wasm)).toBe(0);
    }
  });

  it("rejects a blob HarfBuzz would not take", async () => {
    // `hb_blob_create` never returns null — it hands back the immortal EMPTY blob — so the length
    // round trip is the only way to tell a refusal from a success.
    const wasm = fakeWasm({ blobLengthOverride: 0 });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["face-rejected"]);
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("rejects a face HarfBuzz would not create", async () => {
    const wasm = fakeWasm({ faceFails: true });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["face-rejected"]);
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("refuses the immortal empty buffer, and unwinds the encoder above it", async () => {
    // `hb_buffer_create` NEVER returns null — the same trap `hb_blob_create` sets — so a module
    // that only null-checked would shape every run into a buffer that produces no glyphs, for the
    // life of the font, and report nothing.
    const wasm = fakeWasm({ bufferFails: true });
    const { module, failures } = await moduleOver(wasm);
    expect(module.createFont(new Uint8Array(64))).toBeNull();
    expect(reasons(failures)).toEqual(["out-of-memory"]);
    expect(failures[0].message).toMatch(/immortal empty buffer/);
    expect(wasm.live.size).toBe(0);
    expect(leaked(wasm)).toBe(0);
  });

  it("names the failure mode, not just the failure", async () => {
    // A reason a caller can act on is the whole justification for returning `null` at all: a
    // component that declined silently reports as a cheap one.
    const wasm = fakeWasm({ drawFails: true });
    const { module, failures } = await moduleOver(wasm);
    module.createFont(new Uint8Array(64));
    expect(failures[0].message).toMatch(/^hb-gpu: /);
    expect(failures[0].message).toMatch(/missing from the frame/);
  });
});

// -----------------------------------------------------------------------------------------------
// shape
// -----------------------------------------------------------------------------------------------
//
// THE BOOKKEEPING, NOT THE SHAPING. What HarfBuzz makes of a run is asserted in `shape.test.ts`,
// against a completely different HarfBuzz build, on real fonts. What is checked here is the part a
// fake heap is the better witness for: that a call which cannot proceed frees its one allocation,
// says which failure it was, and never comes back as an empty run — because "no glyphs" and "the
// shaper gave up" render identically and only one of them is a bug.

describe("shape", () => {
  const fontOn = async (wasm: FakeWasm) => {
    const { module, failures } = await moduleOver(wasm);
    const font = module.createFont(new Uint8Array(64));
    expect(font).not.toBeNull();
    return { font: font as NonNullable<typeof font>, failures, wasm };
  };

  it("answers empty text with an empty run, and allocates nothing to do it", async () => {
    const wasm = fakeWasm();
    const { font, failures } = await fontOn(wasm);
    const before = wasm.live.size;
    expect(font.shape("")).toEqual([]);
    // `[]` and `null` are different answers: an empty run is legal, a refusal is not.
    expect(failures).toEqual([]);
    expect(wasm.live.size).toBe(before);
  });

  it("returns null, not an empty run, when the scratch _malloc returns 0", async () => {
    // The third allocation: the face copy and the extents scratch come first. At 0, `HEAPU16.set`
    // would write the run over the null page and HarfBuzz would read it back as text.
    const wasm = fakeWasm({ mallocFailsOn: 3 });
    const { font, failures } = await fontOn(wasm);
    expect(font.shape("hello")).toBeNull();
    expect(reasons(failures)).toEqual(["out-of-memory"]);
    expect(failures[0].message).toMatch(/null page/);
  });

  it("refuses a feature string HarfBuzz will not parse, and frees the block", async () => {
    // NOT SKIPPED: `hb_feature_from_string` zeroes the struct on refusal, so shaping on would lay
    // the run out without the feature that was asked for and say nothing about it.
    const wasm = fakeWasm({ featureFails: true });
    const { font, failures } = await fontOn(wasm);
    const before = wasm.live.size;
    expect(font.shape("hello", { features: ["-lgia"] })).toBeNull();
    expect(reasons(failures)).toEqual(["feature-malformed"]);
    expect(failures[0].message).toMatch(/-lgia/);
    expect(wasm.live.size, "the shaping scratch was leaked").toBe(before);
  });

  it("returns null when shaping exhausted the heap mid-run", async () => {
    // The buffer comes back un-`successful` and EMPTY, which at the call site is indistinguishable
    // from a run that legitimately had no glyphs — i.e. from text that silently did not render.
    const wasm = fakeWasm({ shapeExhaustsHeap: true });
    const { font, failures } = await fontOn(wasm);
    const before = wasm.live.size;
    expect(font.shape("hello")).toBeNull();
    expect(reasons(failures)).toEqual(["out-of-memory"]);
    expect(failures[0].message).toMatch(/missing text/);
    expect(wasm.live.size, "the shaping scratch was leaked").toBe(before);
  });

  it("frees its one allocation on the way out of a successful run too", async () => {
    const wasm = fakeWasm();
    const { font, failures } = await fontOn(wasm);
    const before = wasm.live.size;
    // The fake buffer reports length 0, so the run is empty — the allocation is the assertion.
    expect(
      font.shape("hello", {
        direction: "ltr",
        script: "Latn",
        language: "en",
        features: ["kern", "-liga"],
      }),
    ).toEqual([]);
    expect(failures).toEqual([]);
    expect(wasm.live.size).toBe(before);
  });

  it("destroys the shaping buffer with the font", async () => {
    const wasm = fakeWasm();
    const { font } = await fontOn(wasm);
    expect(wasm.objects.get("buffer")?.size).toBe(1);
    font.destroy();
    expect(leaked(wasm)).toBe(0);
    expect(wasm.live.size).toBe(0);
  });
});
