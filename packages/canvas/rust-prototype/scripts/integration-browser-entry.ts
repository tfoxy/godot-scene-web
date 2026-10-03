import { createClipRectView, createDrawList, createNinePatchView, createQuadView } from '../../src/draw-list';
import { encodeRustResources, encodeRustResourceUpdates, encodeRustRetainedPatch, encodeRustScene, type RustSceneSnapshot } from '../../src/rust-prototype-scene';
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
// GSW_RUST_DAMAGE_PRESENT=1 runs the main Rust steps (and the fault leg) with the damage present on.
if (new URLSearchParams(location.search).get('damage') === '1') rust.set_damage_present(true);
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
// Damage present exactness: two renderers receive the same randomized scene,
// patch and upload sequence; one redraws only the damage, one redraws whole.
// 349x209 over a 100x60 design: the phone's 3.49 device scale, so bounds round on fractional pixels.
const DAMAGE_W = 349, DAMAGE_H = 209, DAMAGE_DESIGN_W = 100, DAMAGE_DESIGN_H = 60;
const damageOnCanvas = document.querySelector<HTMLCanvasElement>('#damageOn')!;
const damageOffCanvas = document.querySelector<HTMLCanvasElement>('#damageOff')!;
const damageOn = await wasm.RustRenderer.create(damageOnCanvas);
const damageOff = await wasm.RustRenderer.create(damageOffCanvas);
damageOn.set_damage_present(true);
damageOn.set_damage_verify(true);
const damageRenderers = [damageOn, damageOff];
let rngState = 0x5eed1234;
function rng() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(items: readonly T[]) => items[Math.floor(rng() * items.length)];
const damageKeys = Array.from({ length: 10 }, (_, i) => `damage-${i}`);
function damagePixels(): Uint8Array {
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = 64 + Math.floor(rng() * 192);
    pixels.set([Math.floor(rng() * a), Math.floor(rng() * a), Math.floor(rng() * a), a], i);
  }
  return pixels;
}
type DamageCommand = Record<string, unknown> & { id: string; kind: string };
let damageRevision = 0;
let damageCommands: DamageCommand[] = [];
function damageQuad(id: string): DamageCommand {
  const resource = rng() < 0.6 ? pick(damageKeys) : null;
  const angle = rng() < 0.4 ? rng() * Math.PI * 2 : 0;
  const scale = 0.5 + rng();
  const a = rng() * 0.9 + 0.1;
  return { id, kind: 'quad', resource,
    m: [Math.cos(angle) * scale, Math.sin(angle) * scale, -Math.sin(angle) * scale, Math.cos(angle) * scale,
      rng() * 110 - 10, rng() * 70 - 10],
    w: 2 + rng() * 25, h: 2 + rng() * 18,
    src: resource ? [rng(), rng(), 1 + rng() * 3, 1 + rng() * 3] : [0, 0, 1, 1],
    color: [rng() * a, rng() * a, rng() * a, a], blend: rng() < 0.2 ? 'add' : 'mix',
    flipH: rng() < 0.2, flipV: false, colorMatrix: null };
}
// A linear 32x32 glyph atlas (MSDF method): smooth channels so fwidth-based coverage varies across a glyph.
const GLYPH_ATLAS = 'damage-glyphs';
const STAMP = 'damage-stamp';
function glyphAtlasPixels(): Uint8Array {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const cx = (x % 16) - 7.5, cy = (y % 16) - 7.5, d = 128 + (5 - Math.hypot(cx, cy)) * 24;
    const v = Math.max(0, Math.min(255, Math.round(d)));
    pixels.set([v, Math.max(0, Math.min(255, v + ((x * 7) % 21) - 10)), v, 255], (y * 32 + x) * 4);
  }
  return pixels;
}
function damageGlyphRun(id: string, x: number, y: number): DamageCommand {
  const glyphs = Array.from({ length: 5 }, (_, i) => ({ src: [(i % 2) * 16, 0, 16, 16], dst: [i * 9, 0, 10, 10] }));
  return { id, kind: 'glyphRun', atlas: GLYPH_ATLAS, m: [1.4, 0.1, -0.1, 1.4, x, y], glyphs, method: 'msdf',
    fill: [0.9, 0.85, 0.3, 1], outline: { color: [0, 0, 0, 1], width: 1.5 }, shadow: { color: [0, 0, 0, 0.5], offset: [0.6, 0.8] },
    pxRange: 4, alpha: 0.9 };
}
function damageSceneBytes() {
  return enc.encode(JSON.stringify({ version: 2, revision: damageRevision, width: DAMAGE_W, height: DAMAGE_H,
    designWidth: DAMAGE_DESIGN_W, designHeight: DAMAGE_DESIGN_H,
    resources: [...[...damageKeys, STAMP].map((key) => ({ key, width: 4, height: 4 })), { key: GLYPH_ATLAS, width: 32, height: 32 }],
    commands: damageCommands }));
}
const quadIds = () => damageCommands.filter((c) => c.kind === 'quad').map((c) => c.id);
const clipIds = () => damageCommands.filter((c) => c.kind === 'clipPush').map((c) => c.id);
const commandById = (id: string) => damageCommands.find((c) => c.id === id)!;
function moved(command: DamageCommand, reach: number): DamageCommand {
  const m = [...command.m as number[]];
  const turn = rng() < 0.3 ? (rng() - 0.5) * 0.6 : 0;
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  [m[0], m[1], m[2], m[3]] = [m[0] * c - m[1] * s, m[0] * s + m[1] * c, m[2] * c - m[3] * s, m[2] * s + m[3] * c];
  m[4] += (rng() - 0.5) * reach; m[5] += (rng() - 0.5) * reach;
  return { ...command, m };
}
async function damageAll(run: (renderer: typeof damageOn) => unknown) {
  const results = [];
  for (const renderer of damageRenderers) {
    const admission = run(renderer);
    results.push({ admission: typeof admission === 'string' ? parse(admission) : admission,
      result: parse(await renderer.present()) });
  }
  return results;
}
function patchBytes(updates: { id: string; command: DamageCommand }[]) {
  const base = damageRevision;
  damageRevision++;
  for (const update of updates) damageCommands[damageCommands.findIndex((c) => c.id === update.id)] = update.command;
  return enc.encode(JSON.stringify({ version: 1, baseRevision: base, revision: damageRevision, updates }));
}
const damageSteps: Record<string, () => Promise<unknown>> = {
  async initial() {
    const textures = encodeRustResources([...damageKeys, STAMP].map((key) => ({ key, width: 4, height: 4, pixels: damagePixels() })));
    damageCommands = [{ ...damageQuad('bg'), resource: null, m: [1, 0, 0, 1, 0, 0], w: 100, h: 60,
      src: [0, 0, 1, 1], color: [0.05, 0.1, 0.15, 1], blend: 'mix' }];
    for (let group = 0; group < 6; group++) {
      const clipped = group % 2 === 1;
      if (clipped) damageCommands.push({ id: `clip${group}`, kind: 'clipPush',
        rect: [rng() * 40, rng() * 20, 30 + rng() * 50, 20 + rng() * 30], radius: rng() < 0.5 ? rng() * 6 : 0,
        outset: rng() < 0.3 ? 1 : 0 });
      for (let i = 0; i < 8; i++) damageCommands.push(damageQuad(`q${group}-${i}`));
      if (clipped) damageCommands.push({ id: `pop${group}`, kind: 'clipPop' });
    }
    // Glyph runs wider than the small probe quad drawn over them: moving the probe puts a scissor edge
    // through the middle of their glyph instances.
    damageCommands.push(damageGlyphRun('glyphs-a', 8, 40), damageGlyphRun('glyphs-b', 50, 12),
      { ...damageQuad('probe'), resource: null, m: [1, 0, 0, 1, 20, 41], w: 3, h: 3, color: [0.2, 0.6, 0.9, 0.8], blend: 'mix' },
      // The only draw sampling STAMP (its own additive batch), so a rewrite of STAMP's pixels damages just it.
      { ...damageQuad('stamp'), resource: STAMP, m: [0.9, 0.3, -0.3, 0.9, 80, 44], w: 8, h: 6, src: [0, 0, 4, 4],
        color: [0.7, 0.7, 0.7, 0.7], blend: 'add' });
    const atlas = encodeRustResourceUpdates([{ operation: 'replace', key: GLYPH_ATLAS, width: 32, height: 32,
      format: 'linear', pixels: glyphAtlasPixels() }]);
    damageRevision = 1;
    return damageAll((renderer) => { renderer.upload_rgba_batch(textures); renderer.upload_rgba_batch(atlas);
      return renderer.admit_scene(damageSceneBytes()); });
  },
  async probe() {
    const command = commandById('probe');
    const m = [...command.m as number[]];
    m[4] = 14 + rng() * 40; m[5] = 38 + rng() * 6;
    const bytes = patchBytes([{ id: 'probe', command: { ...command, m } }]);
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async glyphMove() {
    // A glyph run is not a quad, so this takes the general patch path (a rebuilt, same-shape draw table).
    const id = pick(['glyphs-a', 'glyphs-b']);
    const command = commandById(id);
    const m = [...command.m as number[]];
    m[4] += (rng() - 0.5) * 3; m[5] += (rng() - 0.5) * 2;
    const bytes = patchBytes([{ id, command: { ...command, m, alpha: 0.5 + rng() * 0.5 } }]);
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async subrect() {
    // A subrect rewrites pixels under draws whose instances do not change; a patch elsewhere presents it.
    const pixels = damagePixels().slice(0, 2 * 2 * 4);
    const upload = encodeRustResourceUpdates([{ operation: 'subrect', key: rng() < 0.75 ? STAMP : pick(damageKeys), width: 4, height: 4,
      format: 'srgb', x: 1, y: 1, regionWidth: 2, regionHeight: 2, pixels }]);
    const bytes = patchBytes([{ id: 'probe', command: moved(commandById('probe'), 2) }]);
    return damageAll((renderer) => { renderer.upload_rgba_batch(upload); return renderer.apply_patch(bytes); });
  },
  async uploadOnly() {
    // An upload with no patch, then an empty present: both renderers keep showing the pre-upload frame.
    // The next step's patch must then bring the uploaded pixels in.
    const upload = encodeRustResourceUpdates([{ operation: 'subrect', key: rng() < 0.75 ? STAMP : pick(damageKeys), width: 4, height: 4,
      format: 'srgb', x: 0, y: 0, regionWidth: 4, regionHeight: 4, pixels: damagePixels() }]);
    return damageAll((renderer) => { renderer.upload_rgba_batch(upload); return { accepted: true }; });
  },
  async move() {
    const ids = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(quadIds()));
    const bytes = patchBytes([...new Set(ids)].map((id) => ({ id, command: moved(commandById(id), 8) })));
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async color() {
    const id = pick(quadIds());
    const command = commandById(id);
    const a = rng();
    const bytes = patchBytes([{ id, command: { ...command, color: [rng() * a, rng() * a, rng() * a, a] } }]);
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async clip() {
    const id = pick(clipIds());
    const command = commandById(id);
    const rect = [...command.rect as number[]];
    rect[0] += (rng() - 0.5) * 12; rect[1] += (rng() - 0.5) * 8;
    const bytes = patchBytes([{ id, command: { ...command, rect } }]);
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async many() {
    const ids = quadIds().filter(() => rng() < 0.7);
    const bytes = patchBytes(ids.map((id) => ({ id, command: moved(commandById(id), 80) })));
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async readmit() {
    for (const id of [pick(quadIds()), pick(quadIds())]) {
      const index = damageCommands.findIndex((c) => c.id === id);
      damageCommands[index] = moved(damageCommands[index], 6);
    }
    damageRevision++;
    const bytes = damageSceneBytes();
    return damageAll((renderer) => renderer.admit_scene(bytes));
  },
  async swap() {
    const id = pick(quadIds().filter((q) => commandById(q).resource !== null));
    const index = damageCommands.findIndex((c) => c.id === id);
    damageCommands[index] = { ...damageCommands[index], resource: pick(damageKeys) };
    damageRevision++;
    const bytes = damageSceneBytes();
    return damageAll((renderer) => renderer.admit_scene(bytes));
  },
  async retexture() {
    const textures = encodeRustResources([{ key: pick(damageKeys), width: 4, height: 4, pixels: damagePixels() }]);
    const id = pick(quadIds());
    const bytes = patchBytes([{ id, command: moved(commandById(id), 2) }]);
    return damageAll((renderer) => { renderer.upload_rgba_batch(textures); return renderer.apply_patch(bytes); });
  },
  async same() {
    const id = pick(quadIds());
    const bytes = patchBytes([{ id, command: { ...commandById(id) } }]);
    return damageAll((renderer) => renderer.apply_patch(bytes));
  },
  async noop() {
    return damageAll(() => ({ accepted: true }));
  },
};
function damageStep(name: string) { return damageSteps[name](); }
function damagePlan(count: number) {
  const weighted = ['move', 'move', 'move', 'move', 'color', 'color', 'clip', 'many', 'readmit', 'swap',
    'retexture', 'same', 'noop', 'probe', 'probe', 'glyphMove', 'subrect', 'uploadOnly'];
  // A fixed tail, so these paths run regardless of the seed: upload with no patch, empty present, then patch.
  return [...Array.from({ length: count }, () => pick(weighted)), 'uploadOnly', 'noop', 'probe', 'subrect', 'glyphMove', 'probe'];
}

root.proof = { rustSteps, retainedStep, pixiStep, damageStep, damagePlan };
