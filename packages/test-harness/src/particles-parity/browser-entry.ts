// The PAGE half of the Godot↔browser particle-blend image parity fixture.
//
// esbuild bundles this file (`conditions: ["development"]`, so `@godot-scene-web/html` resolves to
// its TypeScript SOURCE rather than a possibly-stale `dist/`) and `parity.ts` injects it with
// `page.addScriptTag` into the page it has ALREADY built from the fixture. It exposes one function
// on `window`, and it runs between the DOM-tree evaluate and the screenshot.
//
// WHY THIS EXISTS AT ALL. The parity harness renders a fixture to HTML and screenshots it; for a
// GPUParticles2D that HTML is a grid of static `<span>` previews (`visual-2d.ts` `particlePreviewHtml`)
// — a layout-accurate stand-in that shares no code with the WebGL particle renderer. Every existing
// particle check therefore compares the browser against the browser: the WebGL↔WebGPU suite, the
// unit tests, the perf probes. This entry mounts the SHIPPED runtime over those same nodes so that
// the screenshot the harness diffs against Godot's is the runtime's real output, canvas compositing
// included. It is the only place the hand-derived additive accumulate/resolve algebra ever meets
// the engine it imitates.
//
// WHAT IT DOES NOT DO. It never builds a node, a spec or a canvas of its own — the nodes are the
// renderer's, carrying the `data-godot-particle-*` attributes the renderer emitted, and the runtime
// is entered through its public factory. And it never disposes: dispose() takes the canvases off
// the page, and the screenshot has not been taken yet.

import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";
import { createParticleRuntime } from "@godot-scene-web/html/runtime";

/**
 * `shared-gl.ts` DECLINES a software renderer and caches that decision module-scoped on the first
 * `getShared()`. Headless Chromium is SwiftShader, so without this every binding is silently a
 * no-op, the runtime never draws, and the screenshot is of the untouched preview spans — which the
 * settle gate below would then (correctly) report as a timeout rather than quietly diffing.
 *
 * Set at module scope. ESM evaluates the import above FIRST, which is fine and is the same order
 * the WebGL↔WebGPU entry relies on: the decline is decided lazily inside `getShared()`, not at
 * module load, so any assignment made before the first binding draws is early enough.
 */
(globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

/** How long every node has to produce its first real draw. */
const RENDER_TIMEOUT_MS = 10000;
/**
 * How long the page must stand STILL before it is called settled.
 *
 * A draw is not blocked on texture decode: the runtime draws with whatever is resolved — a 1x1
 * transparent placeholder for a sprite that has not landed — and redraws when the image arrives. So
 * "every node rendered once" is not "every node rendered the picture", and a screenshot taken on the
 * first signal can be of four invisible systems.
 */
const SETTLE_QUIET_MS = 150;

/**
 * The runtime marker is mirrored onto BOTH the effect node and its self-layer (`model.ts`
 * `mirrorSelfMetadata`), and only the self-layer carries `data-godot-self-layer`. The runtime's own
 * reconcile filters on exactly this attribute (`particles/runtime.ts`), so counting without it would
 * expect twice as many renders as can ever arrive and every run would time out.
 */
const SELF_LAYER_ATTRIBUTE = "data-godot-self-layer";

export interface ParticleParityMountResult {
  /** Effect nodes found in the page — mirrors excluded. */
  expected: number;
  /** Of those, how many produced at least one real draw. Node-side asserts `rendered === expected`. */
  rendered: number;
  /** `stats().renderer` — `"webgl"` here by construction; `"none"` is the no-op handle (no WebGL2,
   *  or the software-renderer decline still in force) and means the screenshot would be of previews. */
  renderer: string;
  /** The runtime's own counters, so a failure can be told apart from a mount that never ran. */
  draws: number;
  cacheHits: number;
}

function effectNodes(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-godot-particle-runtime]"),
  ).filter((node) => !node.hasAttribute(SELF_LAYER_ATTRIBUTE));
}

/** The image URLs a node's spec references. Parsed permissively: a spec this harness cannot read is
 *  the runtime's problem to report (it books a `malformed particle spec` reason and never draws,
 *  which the settle gate surfaces), not a reason to fail before mounting. */
function specImageUrls(node: HTMLElement): string[] {
  const raw = node.getAttribute("data-godot-particle-specs");
  if (!raw) {
    return [];
  }
  try {
    const spec = JSON.parse(raw) as { textureUrl?: unknown; maskUrl?: unknown };
    return [spec.textureUrl, spec.maskUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * Decode the sprites BEFORE the runtime is mounted.
 *
 * The runtime's texture loader is async and its first draw does not wait for it. Warming the
 * browser's image cache first means the runtime's `new Image()` for the same URL resolves almost
 * immediately, so the quiet window has something to settle ON rather than a race between the
 * settle timer and a decode.
 */
async function preloadImages(urls: Iterable<string>): Promise<void> {
  await Promise.all(
    [...new Set(urls)].map(
      (url) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = url;
        }),
    ),
  );
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Mounted runtimes are kept alive here: nothing else references one once `mountAll` returns, and a
 *  disposed — or garbage-collected — runtime takes its canvases off the page before the screenshot. */
const keptAlive: unknown[] = [];

/**
 * Mount the shipped particle runtime over the page's effect nodes and wait for a settled frame.
 *
 * THROWS on every failure, and that is load-bearing: `parity.ts` skips the image diff entirely when
 * the browser screenshot is missing, so a mount that failed softly would leave the fixture PASSING
 * on a comparison it never made. A blank or preview-only screenshot must be a loud error here.
 */
async function mountAll(): Promise<ParticleParityMountResult> {
  const nodes = effectNodes();
  if (nodes.length === 0) {
    throw new Error(
      "particles-parity: no [data-godot-particle-runtime] nodes in the page — the model was rendered without enableParticles/particleIds, so this fixture would screenshot static preview spans and diff them against Godot's real particles",
    );
  }

  await preloadImages(nodes.flatMap(specImageUrls));

  const renders = new Map<HTMLElement, number>();
  let lastRenderAt = 0;
  const onBindingRendered = (node: HTMLElement) => {
    renders.set(node, (renders.get(node) ?? 0) + 1);
    lastRenderAt = performance.now();
  };

  const options: GodotHtmlMountOptions = {
    enableParticles: true,
    particleIds: ["*"],
    // FROZEN: warm each system once from its seed, draw one frame, park. The fixture's frame is
    // time-invariant by construction, but a live loop would still be racing the screenshot.
    staticParticles: true,
    // The surface-image swap replaces a settled canvas with an encoded `<img>`. It would put a
    // second image codec inside a pixel comparison; the screenshot must be of the canvas.
    staticParticleImages: false,
    // LOAD-BEARING. `"auto"` (the shipped default) would let the runtime adopt WebGPU wherever an
    // adapter exists and silently change which blend implementation this fixture proves — the WebGL
    // additive accumulate/resolve is the thing under test.
    effectsRenderer: "webgl",
    // The page is captured at deviceScaleFactor 1; pin the backing store to CSS pixels so the
    // canvas and Godot's viewport agree pixel-for-pixel with no resampling in between.
    renderScale: 1,
    onBindingRendered,
  };

  const runtime = createParticleRuntime(document.body, options);
  keptAlive.push(runtime);
  runtime.reconcile();

  const deadline = performance.now() + RENDER_TIMEOUT_MS;
  while (
    renders.size < nodes.length ||
    performance.now() - lastRenderAt < SETTLE_QUIET_MS
  ) {
    if (performance.now() > deadline) {
      const missing = nodes
        .filter((node) => !renders.has(node))
        .map((node) => node.getAttribute("data-godot-path") ?? "(unnamed)");
      const stats = runtime.stats();
      throw new Error(
        `particles-parity: ${renders.size}/${nodes.length} particle nodes drew within ${RENDER_TIMEOUT_MS} ms (renderer="${stats.renderer}", draws=${stats.draws}, cacheHits=${stats.cacheHits}); never drew: ${missing.join(", ")}. The screenshot would be of static preview spans, so it is not taken.`,
      );
    }
    await nextFrame();
  }

  const stats = runtime.stats();
  return {
    expected: nodes.length,
    rendered: renders.size,
    renderer: stats.renderer,
    draws: stats.draws,
    cacheHits: stats.cacheHits,
  };
}

export interface ParticleParityHook {
  mountAll(): Promise<ParticleParityMountResult>;
}

const hook: ParticleParityHook = { mountAll };
(window as unknown as Record<string, unknown>).__gswParticleParity = hook;
