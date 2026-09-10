// The fidelity probe's `hb-atlas`, `hb-run` and `hb-gpu` arms.
//
// A SEPARATE BUNDLE because the probe's page is hand-written HTML with one inline module and no
// build step — which is the right shape for arms that are ten lines of `fillText` and a CSS
// transform, and the wrong shape for one that needs a 420 KB wasm shaper, a shelf packer and a
// WebGL2 stage. esbuild bundles this file, the probe's own server hands it over at `/hb.js`, and
// the page reaches it with a dynamic `import()` only when an `hb-` arm is asked for.
//
// IT IMPORTS THE SCENARIO'S OWN MODULE. Nothing about the atlas is reimplemented here: the shapers,
// the baker and — above all — the placement arithmetic come from `src/scenarios/text-hb.ts`, so
// what this probe grades for crispness and for ALIGNMENT is the same code S9 times. A probe with
// its own copy of the pen walk would be free to agree with itself while the shipped arm drifted
// half a pixel, and half a pixel is the entire subject of this round.
//
// TWO FACES, ONE ATLAS, exactly as S9 mounts them — which is the configuration where a glyph key
// collision would put Roboto's outline where Noto Sans SC's belongs. If that ever regresses, the
// picture this probe screenshots is where it shows up.
//
// `hb-gpu` IS EXTENDED INTO THIS BUNDLE RATHER THAN GIVEN A SECOND ONE. It shares the shaper and
// `glyphLocal` with the other two, which is the whole reason the alignment guard can attribute a
// difference to the renderer; a separate bundle would be a second place for the probe's idea of
// where a glyph goes to drift from S9's. Its module and wasm are served by the probe's own little
// server, exactly as harfbuzzjs's wasm already is, and the node side does not offer the arm at all
// when the build is absent — never a zero row.

import {
  createHbGpuFonts,
  createHbGpuText,
  type HbGpuTextArm,
  loadHbGpuModule,
  textGpuUnsupportedParam,
} from "../src/scenarios/text-gpu";
import {
  type AtlasRenderer,
  type BakedAtlas,
  bakeAtlas,
  createAtlasRenderer,
  createCanvasShaper,
  createHarfBuzzShaper,
  createShaperSet,
  drawGlyphCells,
  drawRunCell,
  glyphLocal,
  type RunLayout,
  releaseAtlasPages,
  type ShapedGlyph,
  type ShaperSet,
  type TextShaper,
} from "../src/scenarios/text-hb";

/** One run of the probe's spec — the fields this module reads. */
interface HbRun {
  kind: string;
  text: string;
  fontFamily: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The fields of the probe's `FidelitySpec` this module reads. */
interface HbSpec {
  runs: HbRun[];
  fontSize: number;
  rotationDeg: number;
  box: { width: number; height: number };
  dx: number;
  dy: number;
  baseline: number;
  phases?: number;
  bakeRotation?: boolean;
  bakeShaper?: string;
}

interface Prepared {
  key: string;
  renderer: AtlasRenderer;
  atlas: BakedAtlas;
  /** Positioned glyphs, layout and run-cell key, per run of the spec. */
  runs: {
    run: HbRun;
    glyphs: ShapedGlyph[];
    layout: RunLayout;
    runKey: string;
  }[];
}

let prepared: Prepared | null = null;

/** The `hb-gpu` arm, cached on the same terms as {@link prepared} and for the same reason. */
interface PreparedGpu {
  key: string;
  arm: HbGpuTextArm;
  destroy(): void;
  runs: { run: HbRun; glyphs: ShapedGlyph[]; layout: RunLayout }[];
}

let preparedGpu: PreparedGpu | null = null;

function keyOf(arm: string, spec: HbSpec, dpr: number): string {
  // Everything that changes the PIXELS, and nothing that changes only their position: `dx`/`dy` are
  // deliberately absent, because re-baking per offset is exactly what would hide a sub-pixel
  // placement bug — the sweep is supposed to move a FIXED atlas across the grid.
  return [
    arm,
    spec.runs
      .map((run) => `${run.kind}:${run.fontFamily}:${run.width}:${run.text}`)
      .join("|"),
    spec.fontSize,
    spec.rotationDeg,
    spec.baseline,
    spec.box.width,
    spec.box.height,
    spec.phases ?? 4,
    spec.bakeRotation !== false,
    spec.bakeShaper ?? "harfbuzz",
    dpr,
  ].join("|");
}

async function prepare(
  stage: HTMLElement,
  arm: string,
  spec: HbSpec,
  fontBytes: Map<string, ArrayBuffer>,
): Promise<Prepared> {
  const dpr = window.devicePixelRatio || 1;
  const key = keyOf(arm, spec, dpr);
  if (prepared?.key === key) return prepared;
  prepared?.renderer.dispose();
  prepared = null;

  // One shaper per distinct face, behind one key space — see `createShaperSet`. The face id is the
  // run's `kind`, so the keys read the same way they do in S9.
  const shapers: TextShaper[] = [];
  for (const run of spec.runs) {
    if (shapers.some((shaper) => shaper.faceId === run.kind)) continue;
    if (spec.bakeShaper === "fillText") {
      shapers.push(createCanvasShaper(spec.fontSize, run.fontFamily, run.kind));
      continue;
    }
    const bytes = fontBytes.get(run.fontFamily);
    if (!bytes) {
      throw new Error(
        `text-fidelity-hb: no bytes for face ${run.fontFamily}; its run would silently not be drawn`,
      );
    }
    shapers.push(await createHarfBuzzShaper(bytes, spec.fontSize, run.kind));
  }
  const shaper = createShaperSet(shapers);

  const runs = spec.runs.map((run) => {
    const glyphs = shaper.shape(run.kind, run.text);
    const layout: RunLayout = {
      width: run.width,
      height: run.height,
      baselinePx: spec.baseline,
      dpr,
      radians: (spec.rotationDeg * Math.PI) / 180,
      bakeRotation: spec.bakeRotation !== false,
    };
    return { run, glyphs, layout, runKey: `run:${run.kind}:${run.text}` };
  });

  const items =
    arm === "hb-run"
      ? runs.map((entry) => ({
          key: entry.runKey,
          bounds: runBounds(entry.glyphs, shaper, entry.layout),
          draw(ctx: CanvasRenderingContext2D) {
            for (const glyph of entry.glyphs) {
              const local = glyphLocal(glyph.penPx, entry.layout);
              ctx.save();
              ctx.translate(local.x, local.y);
              shaper.draw(ctx, glyph.key);
              ctx.restore();
            }
          },
        }))
      : [...new Set(runs.flatMap((e) => e.glyphs.map((g) => g.key)))].map(
          (glyphKey) => ({
            key: glyphKey,
            bounds: shaper.boundsOf(glyphKey),
            draw: (ctx: CanvasRenderingContext2D) => shaper.draw(ctx, glyphKey),
          }),
        );

  const bakeRotation = spec.bakeRotation !== false;
  const atlas = bakeAtlas(items, {
    dpr,
    radians: bakeRotation ? (spec.rotationDeg * Math.PI) / 180 : 0,
    // Mirrors S9 exactly — see the note on `BakeOptions.snapped`. Only the rotation-baked glyph
    // atlas lands on whole device pixels and may therefore carry a baked sub-pixel offset.
    snapped: bakeRotation && arm !== "hb-run",
    phases: spec.phases ?? 4,
    maxPageSide: 2048,
  });
  const renderer = createAtlasRenderer({
    container: stage,
    cssWidth: spec.box.width,
    cssHeight: spec.box.height,
    dpr,
    pages: atlas.pages,
  });
  releaseAtlasPages(atlas.pages);

  prepared = { key, renderer, atlas, runs };
  return prepared;
}

/**
 * Build the `hb-gpu` arm for this spec: the SAME shapers, the same `RunLayout`, a second HarfBuzz.
 *
 * Everything that decides WHERE a glyph goes is shared with `prepare` above — the shaper set, the
 * layout, and `glyphLocal` inside `createHbGpuText`. What differs is only what turns an outline
 * into pixels. That separation is the reason the alignment guard's verdict on this arm is a
 * statement about Slug rather than about two different pen walks.
 */
async function prepareGpu(
  stage: HTMLElement,
  spec: HbSpec,
  fontBytes: Map<string, ArrayBuffer>,
): Promise<PreparedGpu> {
  const dpr = window.devicePixelRatio || 1;
  const key = keyOf("hb-gpu", spec, dpr);
  if (preparedGpu?.key === key) return preparedGpu;
  preparedGpu?.destroy();
  preparedGpu = null;

  // The same refusal S9's mount applies, from the same function: the probe's `--phases`,
  // `--bake-rotation` and `--bake-shaper` flags describe a bake this arm does not have, and a
  // fidelity row recorded under them would name a configuration that was never rendered.
  const refusal = textGpuUnsupportedParam({
    phases: spec.phases ?? 4,
    bakeRotation: spec.bakeRotation ?? true,
    bakeShaper: spec.bakeShaper ?? "harfbuzz",
  });
  if (refusal) {
    throw new Error(refusal);
  }

  const shapers: TextShaper[] = [];
  const bytesByFace = new Map<string, ArrayBuffer>();
  for (const run of spec.runs) {
    if (shapers.some((shaper) => shaper.faceId === run.kind)) continue;
    const bytes = fontBytes.get(run.fontFamily);
    if (!bytes) {
      throw new Error(
        `text-fidelity-hb: no bytes for face ${run.fontFamily}; its run would silently not be drawn`,
      );
    }
    shapers.push(await createHarfBuzzShaper(bytes, spec.fontSize, run.kind));
    // A copy per consumer — see `mountHbGpu`. Two modules must never share one detachable buffer.
    bytesByFace.set(run.kind, bytes.slice(0));
  }
  const shaper = createShaperSet(shapers);

  const runs = spec.runs.map((run) => ({
    run,
    glyphs: shaper.shape(run.kind, run.text),
    layout: {
      width: run.width,
      height: run.height,
      baselinePx: spec.baseline,
      dpr,
      radians: (spec.rotationDeg * Math.PI) / 180,
      // Unread by this arm — there is no bake — and set to the struct's own default rather than
      // left out, because `RunLayout` is shared with the arms for which it decides everything.
      bakeRotation: true,
    } satisfies RunLayout,
  }));

  const module = await loadHbGpuModule();
  const fonts = createHbGpuFonts(module, bytesByFace);
  const arm = createHbGpuText({
    container: stage,
    cssWidth: spec.box.width,
    cssHeight: spec.box.height,
    dpr,
    fontSize: spec.fontSize,
    radians: (spec.rotationDeg * Math.PI) / 180,
    module,
    fonts,
    keys: new Set(runs.flatMap((e) => e.glyphs.map((g) => g.key))),
  });

  preparedGpu = {
    key,
    arm,
    destroy() {
      arm.dispose();
      module.destroy();
    },
    runs,
  };
  return preparedGpu;
}

/** The union of a run's glyph ink, relative to the run box's centre — `hb-run`'s single cell. */
function runBounds(
  glyphs: readonly ShapedGlyph[],
  shaper: ShaperSet,
  layout: RunLayout,
) {
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const glyph of glyphs) {
    const local = glyphLocal(glyph.penPx, layout);
    const ink = shaper.boundsOf(glyph.key);
    bounds.minX = Math.min(bounds.minX, local.x + ink.minX);
    bounds.maxX = Math.max(bounds.maxX, local.x + ink.maxX);
    bounds.minY = Math.min(bounds.minY, local.y + ink.minY);
    bounds.maxY = Math.max(bounds.maxY, local.y + ink.maxY);
  }
  return bounds;
}

/**
 * Draw one offset of an `hb-` arm into `stage`.
 *
 * The atlas is baked on the first call for a given spec and REUSED across the sweep — see
 * {@link keyOf}. The page's `clear()` empties the stage between offsets, so the renderer's canvas
 * is re-attached rather than recreated; a fresh WebGL2 context per offset would exhaust the
 * browser's ~16-context limit halfway through an eight-offset sweep.
 */
export async function render(
  stage: HTMLElement,
  arm: string,
  spec: HbSpec,
  fontBytes: Map<string, ArrayBuffer>,
): Promise<void> {
  if (arm === "hb-gpu") {
    const gpu = await prepareGpu(stage, spec, fontBytes);
    stage.appendChild(gpu.arm.canvas);
    gpu.arm.begin();
    for (const entry of gpu.runs) {
      gpu.arm.push(
        entry.glyphs,
        entry.run.left + spec.dx + entry.run.width / 2,
        entry.run.top + spec.dy + entry.run.height / 2,
        entry.layout,
      );
    }
    gpu.arm.end();
    return;
  }
  const ready = await prepare(stage, arm, spec, fontBytes);
  stage.appendChild(ready.renderer.canvas);
  ready.renderer.begin();
  for (const entry of ready.runs) {
    const centreX = entry.run.left + spec.dx + entry.run.width / 2;
    const centreY = entry.run.top + spec.dy + entry.run.height / 2;
    if (arm === "hb-run") {
      const cell = ready.atlas.cells.get(entry.runKey)?.[0];
      if (!cell) {
        throw new Error("text-fidelity-hb: a run was never baked");
      }
      drawRunCell(ready.renderer, cell, centreX, centreY, entry.layout);
      continue;
    }
    drawGlyphCells(
      ready.renderer,
      ready.atlas,
      entry.glyphs,
      centreX,
      centreY,
      entry.layout,
    );
  }
  ready.renderer.end();
}
