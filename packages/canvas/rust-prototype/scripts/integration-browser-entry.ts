import { createClipRectView, createDrawList, createNinePatchView, createQuadView } from '../../src/draw-list';
import { encodeRustResources, encodeRustRetainedPatch, encodeRustScene, type RustSceneSnapshot } from '../../src/rust-prototype-scene';
import { createCanvasStage } from '../../src/present';
import { createCanvasExecutor } from '../../src/executor-webgl';
import { createRetainedRangeCache } from '../../src/retained-range-cache';
import { createTextureCache } from '../../src/textures';
import { createPixiDrawListRenderer } from '../../src/pixi-renderer';

const root = window as unknown as { proof?: Record<string, unknown> };
const rustCanvas = document.querySelector<HTMLCanvasElement>('#rust')!;
const retainedCanvas = document.querySelector<HTMLCanvasElement>('#retained')!;
const pixiCanvas = document.querySelector<HTMLCanvasElement>('#pixi')!;
const enc = new TextEncoder();
const wasm = await import('/rust_prototype.js');
await wasm.default();
const rust = await wasm.RustRenderer.create(rustCanvas);
let committed: RustSceneSnapshot | null = null;
let failedPatchBytes: Uint8Array | null = null;
const parse = (value: string) => JSON.parse(value);
function quad(color: [number, number, number, number], width = 64, height = 64) {
  const list = createDrawList<string>();
  const view = createQuadView();
  view.w = width; view.h = height;
  [view.r, view.g, view.b, view.a] = color;
  list.pushQuad(view);
  return list;
}
function scene(list: ReturnType<typeof createDrawList<string>>, revision: number, width = 64, height = 64, extras: Record<string, unknown> = {}) {
  return encodeRustScene({ drawList: list, revision, width, height, designWidth: 64, designHeight: 64,
    resolveTexture: (key) => ({ key, width: key === 'nine' ? 3 : 20, height: key === 'nine' ? 3 : 20 }),
    ...extras });
}
async function full(encoded: ReturnType<typeof encodeRustScene>) {
  const admission = parse(rust.admit_scene(encoded.bytes));
  const result = parse(await rust.present());
  if (admission.accepted && result.presented) committed = encoded.scene;
  return { admission, result };
}
const rustSteps: Record<string, () => Promise<unknown>> = {
  async initial() { return full(scene(quad([1, 0, 0, 1]), 1)); },
  async retainedPatch() {
    const old = committed!;
    const changed = { ...old.commands[0], color: [0, 1, 0, 1] };
    const patch = encodeRustRetainedPatch(old, 2, [{ id: String(old.commands[0].id), command: changed }])!;
    const admission = parse(rust.apply_patch(patch.bytes));
    const result = parse(await rust.present());
    if (admission.accepted && result.presented) committed = patch.scene;
    return { admission, result, changedIndexes: patch.changedIndexes };
  },
  async resize() {
    rustCanvas.width = 128; rustCanvas.height = 64;
    rust.resize(128, 64);
    return full(scene(quad([0, 0, 1, 1]), 3, 128, 64));
  },
  async text() {
    const raster = document.createElement('canvas'); raster.width = 20; raster.height = 20;
    const ctx = raster.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.fillText('A', 2, 18);
    const pixels = new Uint8Array(ctx.getImageData(0, 0, 20, 20).data);
    rust.upload_rgba_batch(encodeRustResources([{ key: 'letter', width: 20, height: 20, pixels }]));
    return full(scene(createDrawList<string>(), 4, 128, 64, {
      texts: [{ key: 'letter', insertionIndex: 0, transform: [1, 0, 0, 1, 16, 16] }],
      resolveText: () => ({ resource: { key: 'letter', width: 20, height: 20 }, pixels,
        width: 20, height: 20, transform: [1, 0, 0, 1, 16, 16] }),
    }));
  },
  async clipNinePatch() {
    const pixels = new Uint8Array(3 * 3 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 255, 0, 255], i);
    rust.upload_rgba_batch(encodeRustResources([{ key: 'nine', width: 3, height: 3, pixels }]));
    const list = createDrawList<string>();
    const clip = createClipRectView(); clip.w = 32; clip.h = 64; list.pushClipRect(clip);
    const nine = createNinePatchView(); nine.w = 64; nine.h = 64;
    nine.srcW = 3; nine.srcH = 3;
    nine.marginLeft = nine.marginRight = nine.marginTop = nine.marginBottom = 1;
    list.pushNinePatch(nine, 'nine'); list.popClip();
    return full(scene(list, 5, 128, 64));
  },
  async rollback() {
    const invalid = { ...committed!, revision: 6,
      commands: committed!.commands.map((c) => c.kind === 'ninePatch' ? { ...c, src: [0, 0, -1, 3] } : c) };
    const admission = parse(rust.admit_scene(enc.encode(JSON.stringify(invalid))));
    const result = parse(await rust.present());
    return { admission, result };
  },
  async clipTranslate() {
    // Moves the clip half a design width right: the nine-patch under it now shows on the right instead.
    const old = committed!;
    const clip = old.commands.find((command) => command.kind === 'clipPush')!;
    const rect = clip.rect as number[];
    const patch = encodeRustRetainedPatch(old, old.revision + 1,
      [{ id: String(clip.id), command: { ...clip, rect: [rect[0] + 32, rect[1], rect[2], rect[3]] } }])!;
    const admission = parse(rust.apply_patch(patch.bytes));
    const result = parse(await rust.present());
    if (admission.accepted && result.presented) committed = patch.scene;
    return { admission, result, changedIndexes: patch.changedIndexes };
  },
  async faultRollback() {
    if (typeof rust.debugValidationFailureOnce !== 'function')
      throw new Error('fault-injection Wasm feature is required');
    const nine = committed!.commands.find((command) => command.kind === 'ninePatch')!;
    const patch = { version: 1, baseRevision: committed!.revision, revision: committed!.revision + 1,
      updates: [{ id: nine.id, command: { ...nine, color: [0, 1, 1, 1] } }] };
    failedPatchBytes = enc.encode(JSON.stringify(patch));
    const admission = parse(rust.apply_patch(failedPatchBytes));
    rust.debugValidationFailureOnce();
    const result = parse(await rust.present());
    return { admission, result };
  },
  async faultRecovery() {
    if (!failedPatchBytes) throw new Error('fault rollback must run first');
    const admission = parse(rust.apply_patch(failedPatchBytes));
    const result = parse(await rust.present());
    return { admission, result };
  },
};

const stage = createCanvasStage({ canvas: retainedCanvas, designWidth: 64, designHeight: 64 })!;
stage.setStageSize(64, 64);
const textures = createTextureCache(stage.gl);
const texture = textures.acquireBytes('stream', new Uint8Array([255, 0, 0, 255]), 1, 1, { premultiplied: true });
const retainedList = createDrawList<typeof texture>();
const retainedQuad = createQuadView(); retainedQuad.w = 64; retainedQuad.h = 64;
retainedQuad.srcW = 1; retainedQuad.srcH = 1;
retainedList.pushQuad(retainedQuad, texture);
const executor = createCanvasExecutor({ gl: stage.gl, white: textures.white() });
const cache = createRetainedRangeCache(stage.gl, { maxEntryStageAreaRatio: 1, maxCompositeStageAreaRatio: 1, gutterPixels: 0 });
const candidate = [{ key: 'stream', start: 0, end: 1,
  bounds: { x: 0, y: 0, width: 64, height: 64 }, pixelRevision: 1 }];
function retainedStep(change: boolean) {
  if (change) {
    const source = document.createElement('canvas'); source.width = source.height = 1;
    source.getContext('2d')!.fillStyle = '#0000ff'; source.getContext('2d')!.fillRect(0, 0, 1, 1);
    textures.update('stream', source);
  }
  const plan = cache.prepare(retainedList, stage.projection(), candidate);
  const ok = executor.execute(retainedList, stage.projection(), { substitutions: plan });
  const pixel = new Uint8Array(4);
  stage.gl.readPixels(32, 32, 1, 1, stage.gl.RGBA, stage.gl.UNSIGNED_BYTE, pixel);
  return { ok, pixel: [...pixel], stats: { ...executor.stats }, cache: { ...cache.stats }, textureRevision: texture.revision };
}

const pixi = await createPixiDrawListRenderer({ canvas: pixiCanvas, width: 64, height: 64,
  designWidth: 64, designHeight: 64, textureUrl: () => null });
const pixiRenderer = pixi.app.renderer as any;
const originalPixiRender = pixiRenderer.render.bind(pixiRenderer);
let lastPixiRoot: any;
pixiRenderer.render = (container: any, ...rest: unknown[]) => {
  lastPixiRoot = container;
  return originalPixiRender(container, ...rest);
};
const pixiList = createDrawList<string>();
const left = createQuadView(); left.w = 32; left.h = 64; left.r = 1; left.g = left.b = 0;
const right = createQuadView(); right.w = 32; right.h = 64; right.m[4] = 32;
right.r = right.b = 0; right.g = 1;
pixiList.pushQuad(left); pixiList.pushQuad(right);
const pixiPlan = { primitives: [{ id: 'left', index: 0, parentId: 'group' }, { id: 'right', index: 1, parentId: 'group' }],
  groups: [{ id: 'group', firstIndex: 0, endIndex: 2, transform: [1, 0, 0, 1, 0, 0], cacheAsTexture: true }] };
function pixiStep(kind: string) {
  const result = kind === 'initial' ? pixi.admitScene(pixiList, [], pixiPlan)
    : kind === 'warm' ? pixi.presentScene()
    : pixi.patchScene({ primitives: [{ id: 'left', tint: 0x0000ff }] });
  const group = lastPixiRoot?.children?.[0];
  return { result, stats: { ...pixi.stats }, cached: !!group?.renderGroup?.isCachedAsTexture };
}
root.proof = { rustSteps, retainedStep, pixiStep };
