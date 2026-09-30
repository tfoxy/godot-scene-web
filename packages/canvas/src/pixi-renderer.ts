import {
  Application,
  Assets,
  CanvasSource,
  CanvasTextMetrics,
  Container,
  Graphics,
  Matrix,
  Mesh,
  MeshGeometry,
  NineSliceSprite,
  Rectangle,
  RenderContainer,
  Sprite,
  Text,
  TextStyle,
  Texture,
  TexturePool,
  ExtensionType,
  extensions,
  type Renderer,
  type TextStyleOptions,
} from "pixi.js";

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  DRAW_TEXTURED_MESH,
  createClipRectView,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTexturedMeshView,
  type DrawList,
} from "./draw-list";
import { createGlyphsView } from "./draw-list";
import type { GlyphPass } from "./glyph-pass";
import type { StageProjection } from "./present";
import { MatrixSprite, MatrixNineSliceSprite, matrixBatchExtensions } from "./pixi-color-batch";
import { createPixiDiagnostics, type PixiDiagnostics } from "./pixi-diagnostics";
export type { PixiBatchRecord, PixiCommandFrame, PixiGpuElapsed, PixiCpuFrame, PixiCpuOperation, PixiDiagnostics } from "./pixi-diagnostics";

export type PixiTextMode = "native" | "slug" | "slug-cached";

/** Owned copy of the shaper's borrowed block; all arrays must outlive the scene. */
export interface PixiGlyphBlock {
  readonly runCount: number;
  readonly origins: Float32Array;
  readonly spans: Int32Array;
  readonly colors: Float32Array;
  readonly spreads: Float32Array;
  readonly slots: Int32Array;
  readonly positions: Float32Array;
  readonly pixelsPerEm: number;
  readonly blockScale: number;
}

export interface PixiGlyphRecord {
  readonly block: PixiGlyphBlock;
  readonly box: { readonly width: number; readonly height: number };
  readonly inkBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly contentKey: string;
  readonly cacheEligible?: boolean;
}

export interface PixiGlyphProvider {
  readonly pass: GlyphPass;
  invalidate(): void;
  restore(): boolean;
  dispose(): void;
  stats?(): unknown;
}

export interface PixiTextOutcomes {
  readonly requested: PixiTextMode;
  readonly actual: "native" | "slug" | "slug-cached" | "mixed";
  readonly native: number;
  readonly slug: number;
  readonly slugCached: number;
  readonly reasons: Readonly<Record<string, number>>;
}

export interface PixiTextRun {
  readonly text: string;
  readonly color?: string;
}

/** Semantic text inserted at an exact draw-list painter boundary. */
export interface PixiTextRecord {
  readonly key: string;
  readonly labelId?: string;
  readonly insertionIndex: number;
  readonly text: string;
  readonly runs?: readonly PixiTextRun[];
  readonly transform: readonly number[];
  readonly style: TextStyleOptions;
  /** Consumer revision for font readiness, locale, scale and context inputs. */
  readonly contentKey?: string | number;
  readonly resourceRevision?: string | number;
  readonly alpha?: number;
  readonly tint?: number;
  readonly blend?: number;
  /** Optional retained scene parent; the transform is local to that group. */
  readonly parentId?: string;
  readonly localTransform?: readonly number[];
  readonly glyph?: PixiGlyphRecord;
  readonly fallbackReason?: string;
  /** Rich native records replacing this carrier at the same painter slot. */
  readonly nativeFallback?: readonly PixiTextRecord[];
}

export interface PixiScenePrimitive {
  readonly id: string;
  readonly index: number;
  readonly parentId?: string;
  readonly localTransform?: readonly number[];
}

export interface PixiSceneGroup {
  readonly id: string;
  readonly parentId?: string;
  /** Half-open interval in draw-list command order. Nested groups must be contiguous. */
  readonly firstIndex: number;
  readonly endIndex: number;
  readonly transform: readonly number[];
  readonly alpha?: number;
  readonly renderGroup?: boolean;
  readonly cacheAsTexture?: boolean;
}

export interface PixiScenePlan {
  readonly primitives: readonly PixiScenePrimitive[];
  readonly groups?: readonly PixiSceneGroup[];
}

export interface PixiSceneSource<TTexture> {
  readonly texture: TTexture | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PixiSceneChange<TTexture> {
  readonly id: string;
  readonly transform?: readonly number[];
  readonly alpha?: number;
  readonly tint?: number;
  readonly source?: PixiSceneSource<TTexture>;
}

export interface PixiScenePatch<TTexture> {
  readonly groups?: readonly Omit<PixiSceneChange<TTexture>, "source" | "tint">[];
  readonly primitives?: readonly PixiSceneChange<TTexture>[];
}

export interface PixiSceneResult { readonly presented: boolean; readonly reason?: string }

export interface PixiDrawListRendererStats {
  frames: number;
  completedFrames: number;
  objects: number;
  created: number;
  updated: number;
  destroyed: number;
  textures: number;
  frameTextures: number;
  gpuTextures: number;
  /** Native texture-registry slots, including Pixi GC tombstones. */
  gpuTextureSlots: number;
  textureLoads: number;
  textureFailures: number;
  resourcePending: number;
  textRasterizations: number;
  textInvalidations: number;
  refusedEffects: number;
  refusedGlyphs: number;
  blockedPendingFrames: number;
  blockedRefusedFrames: number;
  sceneAdmissions: number;
  scenePatches: number;
  sceneChangedObjects: number;
  scenePreflightFailures: number;
  scenePresentationFailures: number;
  contextReady: boolean;
  presentationValid: boolean;
  /** Attribution-only clip omission: number of clips bypassed by the last GL submission. */
  omittedClipMasksLastSubmission: number;
  omittedClipMasksTotalSubmissions: number;
  /** Attribution-only GL submissions intentionally skipped; these are not completed draws. */
  skippedGlSubmissions: number;
  /** Attribution-only completed submissions of a changing single quad. */
  diagnosticQuadSubmissions: number;
}

export interface PixiDrawListRendererOptions<TTexture> {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly resolution?: number;
  readonly antialias?: boolean;
  readonly designWidth?: number;
  readonly designHeight?: number;
  readonly textureUrl: (texture: TTexture) => string | null;
  readonly identityAt?: (index: number, kind: number) => string;
  readonly onInvalidate?: (reason?: "resource" | "present") => void;
  readonly textMode?: PixiTextMode;
  readonly createGlyphProvider?: (gl: WebGL2RenderingContext) => PixiGlyphProvider | null;
  /** Explicit diagnostic mode; CPU, command interception and GPU timing are separate runs. */
  readonly diagnostics?: PixiDiagnostics;
  /** Attribution control that deliberately changes output; never use for parity or product rendering. */
  readonly diagnosticClipMode?: "omit";
  /** Attribution controls that replace normal output; never use for parity or product rendering. */
  readonly diagnosticSubmitMode?: "skip-gl" | "single-quad";
}

export interface PixiDrawListRenderer<TTexture> {
  readonly app: Application<Renderer<HTMLCanvasElement>>;
  readonly stats: PixiDrawListRendererStats;
  resize(width: number, height: number, resolution?: number, designWidth?: number, designHeight?: number): void;
  render(list: DrawList<TTexture>, text?: readonly PixiTextRecord[]): boolean;
  admitScene(list: DrawList<TTexture>, text: readonly PixiTextRecord[], plan: PixiScenePlan): PixiSceneResult;
  patchScene(patch: PixiScenePatch<TTexture>): PixiSceneResult;
  presentScene(): PixiSceneResult;
  prefetch(texture: TTexture): void;
  bindPixelTexture(texture: TTexture, source: HTMLCanvasElement, revision: number): void;
  textureSize(texture: TTexture): { width: number; height: number } | null;
  textureFailureDetails(): readonly string[];
  textOutcomes(): PixiTextOutcomes;
  /** Arm fixed-frame attribution only after the caller's own readiness gate passes. */
  armDiagnosticSkipGl(): boolean;
  armDiagnosticSingleQuad(): boolean;
  /** Drain completed asynchronous GPU timer queries after the last submission. */
  pollDiagnostics(): void;
  dispose(): void;
}

type Retained = { readonly kind: string; readonly display: Container; digest: string; resourceRevision?: string | number };

const rgba = (r: number, g: number, b: number) =>
  ((Math.round(Math.min(1, r) * 255) << 16) | (Math.round(Math.min(1, g) * 255) << 8) | Math.round(Math.min(1, b) * 255));

function setMatrix(display: Container, m: ArrayLike<number>): void {
  display.setFromMatrix(new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
}

function quadMatrix(m: ArrayLike<number>, w: number, h: number, sw: number, sh: number, flipH: boolean, flipV: boolean): number[] {
  const sx = w / Math.max(1, sw) * (flipH ? -1 : 1);
  const sy = h / Math.max(1, sh) * (flipV ? -1 : 1);
  return [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy,
    m[4] + (flipH ? m[0] * w : 0) + (flipV ? m[2] * h : 0),
    m[5] + (flipH ? m[1] * w : 0) + (flipV ? m[3] * h : 0)];
}

function nineMatrix(m: ArrayLike<number>, w: number, h: number, flipH: boolean, flipV: boolean): number[] {
  const sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
  return [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy,
    m[4] + (flipH ? m[0] * w : 0) + (flipV ? m[2] * h : 0),
    m[5] + (flipH ? m[1] * w : 0) + (flipV ? m[3] * h : 0)];
}

const validMatrix = (m: readonly number[]) => m.length === 6 && m.every(Number.isFinite);
const sameMatrix = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sameSource = <TTexture>(a: PixiSceneSource<TTexture> | undefined, b: PixiSceneSource<TTexture>) =>
  !!a && a.texture === b.texture && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const MAX_CACHE_PIXELS = 6 * 1024 * 1024; // 24 MiB at RGBA8.
const MAX_CACHE_SIDE = 1024;
const MAX_CACHE_ENTRIES = 512;
const MAX_BAKES_PER_PRESENT = 4;
const MAX_BAKE_PIXELS_PER_PRESENT = 1024 * 1024; // 4 MiB at RGBA8.

function blendOf(value: number): "normal" | "add" | "multiply" | "subtract" {
  if (value === BLEND_ADD) return "add";
  if (value === BLEND_MUL) return "multiply";
  if (value === BLEND_SUB) return "subtract";
  return "normal";
}

/** The instruction boundary is Pixi's, so masks and render groups stay in painter order. */
class PixiGlyphPipe {
  static extension = { type: ExtensionType.WebGLPipes, name: "retainedGlyph" };
  constructor(private readonly renderer: Renderer) {}
  updateRenderable(): void {}
  destroyRenderable(): void {}
  validateRenderable(): boolean { return false; }
  addRenderable(display: GlyphContainer, instructions: { add(instruction: GlyphContainer): void }): void {
    this.renderer.renderPipes.batch.break(instructions as never);
    instructions.add(display);
  }
  execute(display: GlyphContainer): void { if (display.isRenderable) display.render(this.renderer); }
  destroy(): void {}
}

class GlyphContainer extends RenderContainer {
  override readonly renderPipeId = "retainedGlyph";
}

let glyphPipeRegistered = false;
let matrixBatchRegistered = false;
function registerMatrixBatch(): void {
  if (matrixBatchRegistered) return;
  extensions.add(...matrixBatchExtensions);
  matrixBatchRegistered = true;
}
function registerGlyphPipe(): void {
  if (glyphPipeRegistered) return;
  extensions.add(PixiGlyphPipe);
  glyphPipeRegistered = true;
}

function drawableGlyphCounts(record: PixiGlyphRecord): Int32Array | null {
  const { block, box, inkBounds } = record;
  if (!Number.isInteger(block.runCount) || block.runCount < 0 ||
      block.origins.length < block.runCount * 2 || block.spans.length < block.runCount * 2 ||
      block.colors.length < block.runCount * 4 || block.spreads.length < block.runCount ||
      ![block.pixelsPerEm, block.blockScale, box.width, box.height,
        inkBounds.x, inkBounds.y, inkBounds.width, inkBounds.height].every(Number.isFinite) ||
      block.pixelsPerEm <= 0 || block.blockScale <= 0 ||
      box.width < 0 || box.height < 0 || inkBounds.width < 0 || inkBounds.height < 0) return null;
  const counts = new Int32Array(block.runCount);
  for (let i = 0; i < block.runCount; i++) {
    const start = block.spans[i * 2], count = block.spans[i * 2 + 1];
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 ||
        start + count > block.slots.length ||
        (start + count) * 2 > block.positions.length) return null;
    if (!Number.isFinite(block.origins[i * 2]) || !Number.isFinite(block.origins[i * 2 + 1]) ||
        !Number.isFinite(block.spreads[i]) || block.spreads[i] < 0) return null;
    for (let c = 0; c < 4; c++) if (!Number.isFinite(block.colors[i * 4 + c]) ||
      block.colors[i * 4 + c] < 0 || block.colors[i * 4 + c] > 1) return null;
    for (let glyph = start; glyph < start + count; glyph++) {
      if (block.slots[glyph] < -1 || !Number.isFinite(block.positions[glyph * 2]) ||
          !Number.isFinite(block.positions[glyph * 2 + 1])) return null;
      if (block.slots[glyph] !== -1) counts[i]++;
    }
  }
  return counts;
}

function mulAffine(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function inverseAffine(m: ArrayLike<number>): number[] | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
  inv[4] = -(inv[0] * m[4] + inv[2] * m[5]);
  inv[5] = -(inv[1] * m[4] + inv[3] * m[5]);
  return inv;
}

function singularScale(m: ArrayLike<number>): number {
  const aa = m[0] * m[0] + m[1] * m[1];
  const bb = m[2] * m[2] + m[3] * m[3];
  const ab = m[0] * m[2] + m[1] * m[3];
  return Math.sqrt((aa + bb + Math.sqrt((aa - bb) ** 2 + 4 * ab * ab)) / 2);
}

function cachePixelSize(bounds: PixiGlyphRecord["inkBounds"], resolution: number): { width: number; height: number; pixels: number } {
  const left = Math.floor(bounds.x * resolution - 2);
  const top = Math.floor(bounds.y * resolution - 2);
  const right = Math.ceil((bounds.x + bounds.width) * resolution + 2);
  const bottom = Math.ceil((bounds.y + bounds.height) * resolution + 2);
  return { width: right - left, height: bottom - top, pixels: (right - left) * (bottom - top) };
}

type CacheLease = { rollback(): void; commit(): void };

/** Render analytically during a transaction while retaining the last cache texture. */
function suspendCommittedCache(display: Container): CacheLease | null {
  const group = display.renderGroup;
  if (!group?.isCachedAsTexture) return null;
  const texture = group.texture;
  const needsUpdate = group.textureNeedsUpdate;
  const options = group.textureOptions;
  const bounds = group._textureBounds?.clone();
  const parent = group.renderGroupParent;
  // Pixi's cacheAsTexture(false) and its RenderGroupSystem both return texture
  // to TexturePool immediately. Detach it before the speculative render.
  group.texture = undefined;
  group.isCachedAsTexture = false;
  group.structureDidChange = true;
  if (parent) parent.structureDidChange = true;
  return {
    rollback() {
      if (group.texture && group.texture !== texture) TexturePool.returnTexture(group.texture);
      group.texture = texture;
      group.isCachedAsTexture = true;
      group.textureNeedsUpdate = needsUpdate;
      group.textureOptions = options;
      if (bounds && group._textureBounds) group._textureBounds.copyFrom(bounds);
      group.structureDidChange = true;
      group.invalidateMatrices();
      if (parent) parent.structureDidChange = true;
      if (group.renderGroupParent) group.renderGroupParent.structureDidChange = true;
    },
    commit() { if (texture) TexturePool.returnTexture(texture); },
  };
}

function paintedInkBounds(record: PixiGlyphRecord): PixiGlyphRecord["inkBounds"] {
  const s = record.block.blockScale, cx = record.box.width / 2, cy = record.box.height / 2;
  const b = record.inkBounds;
  return { x: cx + s * (b.x - cx), y: cy + s * (b.y - cy),
    width: s * b.width, height: s * b.height };
}

/**
 * Experimental retained Pixi executor for the canvas package's semantic draw list.
 * It deliberately owns Pixi display objects and URL texture loading; no GSW GL
 * handles or executor are accepted by this boundary.
 */
export async function createPixiDrawListRenderer<TTexture>(
  options: PixiDrawListRendererOptions<TTexture>,
): Promise<PixiDrawListRenderer<TTexture>> {
  registerGlyphPipe();
  registerMatrixBatch();
  const app = new Application<Renderer<HTMLCanvasElement>>();
  try { await app.init({
    canvas: options.canvas,
    width: options.width,
    height: options.height,
    resolution: options.resolution ?? 1,
    preference: "webgl",
    antialias: options.antialias ?? false,
    backgroundAlpha: 0,
    autoStart: false,
    sharedTicker: false,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  }); } catch (error) { app.destroy(false, { children: true, texture: false, textureSource: false }); throw error; }
  app.stop();
  // Input belongs to the consumer. Detaching through EventSystem also removes
  // Pixi's owned DOM listeners and idle interaction ticker callback.
  app.renderer.events.setTargetElement(null!);
  const textMode = options.textMode ?? "native";
  const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
  const diagnostics = createPixiDiagnostics(gl, options.diagnostics, app.renderer);
  const webGL2 = (app.renderer as unknown as { context?: { webGLVersion?: number } }).context?.webGLVersion === 2;
  let glyphProvider: PixiGlyphProvider | null = null;
  let glyphProviderReason = !webGL2 ? "WebGL2 unavailable" : "glyph provider unavailable";
  if (textMode !== "native" && gl && webGL2 && options.createGlyphProvider) {
    try { glyphProvider = options.createGlyphProvider(gl); }
    catch (error) { glyphProviderReason = error instanceof Error ? error.message : String(error); }
  }
  let glyphReady = glyphProvider !== null;
  let committedTextOutcomes: PixiTextOutcomes = { requested: textMode, actual: "native",
    native: 0, slug: 0, slugCached: 0, reasons: {} };
  let candidateTextOutcomes = committedTextOutcomes;
  const glyphRecords = new WeakMap<GlyphContainer, PixiGlyphRecord>();
  const glyphDrawableCounts = new WeakMap<GlyphContainer, Int32Array>();
  const glyphBoundsResolution = new WeakMap<GlyphContainer, number>();
  const glyphViews = createGlyphsView();
  function retryGlyphProvider(): void {
    if (glyphReady || !glyphProvider) return;
    try { glyphReady = glyphProvider.restore(); }
    catch (error) { glyphProviderReason = error instanceof Error ? error.message : String(error); }
  }
  const glyphProjection: StageProjection = { designWidth: 1, designHeight: 1,
    toClip: new Float32Array(4), toFramebuffer: new Float32Array(6), framebufferWidth: 1, framebufferHeight: 1 };
  function drawGlyph(display: GlyphContainer, renderer: Renderer): void {
    const record = glyphRecords.get(display);
    const drawableCounts = glyphDrawableCounts.get(display);
    if (!record || !glyphProvider || !drawableCounts) throw new Error("glyph provider unavailable");
    const internal = renderer as unknown as { globalUniforms: { globalUniformData: {
      projectionMatrix: Matrix; worldTransformMatrix: Matrix; worldColor: number; offset: { x: number; y: number } } };
      renderTarget: { viewport: Rectangle; renderTarget: unknown;
        getGpuRenderTarget(target: unknown): { stencilMode: number; stencilReference: number } };
      shader: { resetState(): void }; geometry: { resetState(): void };
      texture: { resetState(): void };
      state: { stateId: number; blendMode: string; _blendEq: boolean;
        setBlend(enabled: boolean): void; setBlendMode(mode: string): void } };
    const global = internal.globalUniforms.globalUniformData;
    const p = global.projectionMatrix, vp = internal.renderTarget.viewport;
    if (Math.abs(p.b) > 1e-7 || Math.abs(p.c) > 1e-7) throw new Error("unsupported glyph projection");
    const gm = global.worldTransformMatrix, dm = display.groupTransform;
    const base = mulAffine([gm.a, gm.b, gm.c, gm.d, gm.tx - global.offset.x, gm.ty - global.offset.y],
      [dm.a, dm.b, dm.c, dm.d, dm.tx, dm.ty]);
    const clip = glyphProjection.toClip;
    clip[0] = p.a; clip[1] = p.d; clip[2] = p.tx; clip[3] = p.ty;
    const fb = glyphProjection.toFramebuffer;
    fb[0] = p.a * vp.width / 2; fb[1] = 0; fb[2] = 0; fb[3] = -p.d * vp.height / 2;
    fb[4] = (p.tx + 1) * vp.width / 2; fb[5] = (1 - p.ty) * vp.height / 2;
    (glyphProjection as { framebufferWidth: number; framebufferHeight: number }).framebufferWidth = vp.width;
    (glyphProjection as { framebufferWidth: number; framebufferHeight: number }).framebufferHeight = vp.height;
    const localColor = display.groupColorAlpha, parentColor = global.worldColor;
    const alpha = ((localColor >>> 24) & 255) / 255 * ((parentColor >>> 24) & 255) / 255;
    const red = (localColor & 255) / 255 * (parentColor & 255) / 255;
    const green = ((localColor >>> 8) & 255) / 255 * ((parentColor >>> 8) & 255) / 255;
    const blue = ((localColor >>> 16) & 255) / 255 * ((parentColor >>> 16) & 255) / 255;
    // Pixi owns the context and tracks blend state. The glyph pass changes blend
    // but explicitly leaves scissor, viewport, stencil and target untouched.
    // Reading GL state here stalls the driver once per retained label.
    const state = internal.state;
    const wasBlend = (state.stateId & 1) !== 0;
    const blendMode = state.blendMode;
    try {
      const block = record.block, cx = record.box.width / 2, cy = record.box.height / 2;
      const s = block.blockScale;
      for (let i = 0; i < block.runCount; i++) {
        const start = block.spans[i * 2], count = block.spans[i * 2 + 1];
        if (!count) continue;
        const model = mulAffine(base, [s, 0, 0, s,
          cx * (1 - s) + s * block.origins[i * 2], cy * (1 - s) + s * block.origins[i * 2 + 1]]);
        glyphViews.m.set(model); glyphViews.pixelsPerEm = block.pixelsPerEm;
        glyphViews.slots = block.slots.subarray(start, start + count);
        glyphViews.positions = block.positions.subarray(start * 2, (start + count) * 2);
        glyphViews.glyphCount = count; glyphViews.spreadPx = block.spreads[i];
        glyphViews.localInkX = record.inkBounds.x; glyphViews.localInkY = record.inkBounds.y;
        glyphViews.localInkWidth = record.inkBounds.width; glyphViews.localInkHeight = record.inkBounds.height;
        const a = alpha * block.colors[i * 4 + 3];
        glyphViews.a = a; glyphViews.r = block.colors[i * 4] * red * a;
        glyphViews.g = block.colors[i * 4 + 1] * green * a;
        glyphViews.b = block.colors[i * 4 + 2] * blue * a;
        const submitted = glyphProvider.pass.drawRun(glyphViews, glyphProjection);
        if (submitted.glyphs !== drawableCounts[i]) throw new Error("glyph pass dropped retained glyphs");
      }
    } finally {
      // The pass leaves scissor/stencil/target alone. Restore its blend changes
      // from Pixi's tracked state, forcing the blend equation and factors because
      // hb-gpu set them outside GlStateSystem. Do not reset unrelated GL state.
      state.blendMode = "";
      state._blendEq = true;
      state.setBlendMode(blendMode);
      state.setBlend(wasBlend);
      internal.shader.resetState(); internal.geometry.resetState();
      internal.texture.resetState();
    }
  }
  let root: Container = app.stage;
  let omittedClipMasksInScene = 0;
  let skipGlArmed = false;
  let diagnosticQuadArmed = false;
  const diagnosticQuadRoot = options.diagnosticSubmitMode === "single-quad" ? new Container() : null;
  const diagnosticQuad = diagnosticQuadRoot ? new Graphics() : null;
  if (diagnosticQuadRoot && diagnosticQuad) {
    diagnosticQuadRoot.eventMode = "none";
    diagnosticQuadRoot.addChild(diagnosticQuad);
  }
  let diagnosticQuadPhase = 0;
  function submitPixi(cacheBakeCandidates: readonly string[] = []): boolean {
    // Only a completed, resource-ready draw can establish the fixed frame.
    if (options.diagnosticSubmitMode === "skip-gl" && skipGlArmed &&
        pendingTextures.size === 0 && failedTextures.size === 0) {
      stats.omittedClipMasksLastSubmission = 0;
      stats.skippedGlSubmissions++;
      stats.presentationValid = false;
      return false;
    }
    stats.omittedClipMasksLastSubmission = options.diagnosticClipMode === "omit" ? omittedClipMasksInScene : 0;
    stats.omittedClipMasksTotalSubmissions += stats.omittedClipMasksLastSubmission;
    const nodeIds = options.diagnostics?.mode === "commands" ? new WeakMap<object, string>() : null;
    if (nodeIds) for (const [id, item] of retained) nodeIds.set(item.display, id);
    const diagnosticNodeId = (renderable: object) => nodeIds?.get(renderable) ?? null;
    if (diagnosticQuadArmed && diagnosticQuad && diagnosticQuadRoot) {
      // A full-canvas opaque quad changes color on every completed submission.
      // The real retained scene and input geometry are still prepared above.
      diagnosticQuad.clear().rect(0, 0, viewWidth, viewHeight)
        .fill(diagnosticQuadPhase++ % 2 === 0 ? 0xe03060 : 0x30c0e0);
      if (diagnostics) diagnostics.render(() => app.renderer.render(diagnosticQuadRoot), cacheBakeCandidates, diagnosticNodeId);
      else app.renderer.render(diagnosticQuadRoot);
      stats.diagnosticQuadSubmissions++;
    } else if (diagnostics) diagnostics.render(() => app.renderer.render(root), cacheBakeCandidates, diagnosticNodeId);
    else app.renderer.render(root);
    return true;
  }
  root.sortableChildren = false;
  root.eventMode = "none";
  let viewWidth = options.width, viewHeight = options.height;
  let designWidth = options.designWidth ?? options.width, designHeight = options.designHeight ?? options.height;
  let viewResolution = options.resolution ?? 1;
  root.scale.set(viewWidth / Math.max(1, designWidth), viewHeight / Math.max(1, designHeight));
  let retained = new Map<string, Retained>();
  const textureCache = new Map<string, Texture>();
  const pixelTextures = new Map<string, { texture: Texture; revision: number }>();
  // The committed retained tree may still sample an older CanvasSource while
  // its replacement awaits a successful presentation.
  const committedPixelTextures = new Map<string, Texture>();
  const pendingTextures = new Map<string, Promise<void>>();
  const failedTextures = new Set<string>();
  const textureFailureReasons = new Map<string, string>();
  let frameTextures = new Map<string, Texture>();
  const stats: PixiDrawListRendererStats = {
    frames: 0, completedFrames: 0, objects: 0, created: 0, updated: 0, destroyed: 0,
    textures: 0, frameTextures: 0, gpuTextures: 0, gpuTextureSlots: 0, textureLoads: 0, textureFailures: 0, resourcePending: 0, textRasterizations: 0,
    textInvalidations: 0, refusedEffects: 0, refusedGlyphs: 0, blockedPendingFrames: 0, blockedRefusedFrames: 0,
    sceneAdmissions: 0, scenePatches: 0, sceneChangedObjects: 0,
    scenePreflightFailures: 0, scenePresentationFailures: 0, contextReady: true, presentationValid: false,
    omittedClipMasksLastSubmission: 0, omittedClipMasksTotalSubmissions: 0, skippedGlSubmissions: 0,
    diagnosticQuadSubmissions: 0,
  };
  function markDraw(drew: boolean): void {
    if (drew) stats.completedFrames++;
    stats.presentationValid = drew;
  }
  type SceneObject = {
    display: Container; kind: number | "text"; parentId?: string;
    transform: readonly number[]; alpha: number; tint: number;
    source?: PixiSceneSource<TTexture>;
    width?: number; height?: number; flipH?: boolean; flipV?: boolean;
  };
  let sceneObjects: Map<string, SceneObject> | null = null;
  let sceneGroups: Map<string, Container> | null = null;
  let sceneGroupStates: Map<string, { transform: readonly number[]; alpha: number }> | null = null;
  let sceneCachedGroups: Set<string> | null = null;
  let sceneGroupParents: Map<string, string | undefined> | null = null;
  let sceneCacheDependents: Map<string, string[]> | null = null;
  type CacheInfo = { resolution: number; desiredResolution: number;
    width: number; height: number; pixels: number; active: boolean };
  let sceneCacheInfo: Map<string, CacheInfo> | null = null;
  let sceneCachedPixels = 0;
  let sceneCachePending: string[] = [];
  let sceneCacheQueued = new Set<string>();
  let sceneCacheCursor = 0;
  let sceneTextureDemand = new Set<string>();
  let sceneTextureRefs = new Map<string, number>();
  let sceneFrameRefs = new Map<string, number>();
  const staleFrameKeys = new Set<string>();
  let borrowSource: Map<string, Retained> | null = null;
  const borrowedGlyphCacheRestore = new Map<GlyphContainer, { active: boolean; resolution: number;
    boundsResolution: number; record: PixiGlyphRecord | undefined;
    counts: Int32Array | undefined; lease: CacheLease | null; created: boolean }>();
  let admissionCachedGroups: Set<string> | null = null;
  let admissionCacheInfo: Map<string, CacheInfo> | null = null;
  type GlyphCacheInfo = { child: GlyphContainer; labelId: string; parentId?: string; ownAlpha: number;
    bounds: PixiGlyphRecord["inkBounds"]; eligible: boolean; active: boolean; resolution: number;
    localScale: number; pixels: number; contextGeneration: number };
  let candidateGlyphCaches = new Map<string, GlyphCacheInfo>();
  let sceneGlyphCaches = new Map<string, GlyphCacheInfo>();
  let sceneGlyphCachedPixels = 0, sceneGlyphCachedEntries = 0;
  let cacheBakesThisPresent = 0, cacheBakePixelsThisPresent = 0;
  let sceneGlyphDependents = new Map<string, string[]>();
  let sceneGlyphPending: string[] = [], sceneGlyphQueued = new Set<string>(), sceneGlyphCursor = 0;
  let sceneLabelOutcomes = new Map<string, { mode: "native" | "slug" | "slug-cached"; reason?: string }>();
  let glyphCachePixels = 0, glyphCacheEntries = 0, glyphCacheBakes = 0;
  let glyphCacheBakePixels = 0;
  let candidateLabels = new Map<string, { mode: "native" | "slug" | "slug-cached"; reason?: string }>();
  let contextLost = false;
  let contextGeneration = 0;
  const glContext = (app.renderer as unknown as { context?: { gl?: { isContextLost?: () => boolean } } }).context;
  const contextReady = () => {
    const ready = !contextLost && !glContext?.gl?.isContextLost?.();
    if (!ready && stats.contextReady) contextGeneration++;
    stats.contextReady = ready;
    if (!stats.contextReady) stats.presentationValid = false;
    return stats.contextReady;
  };
  const onContextLost = (event: Event) => {
    event.preventDefault(); contextLost = true; sceneObjects = null;
    skipGlArmed = false;
    diagnosticQuadArmed = false;
    if (stats.contextReady) contextGeneration++;
    stats.contextReady = false; stats.presentationValid = false;
    glyphReady = false; glyphProvider?.invalidate(); options.onInvalidate?.();
  };
  const onContextRestored = () => {
    contextLost = false; sceneObjects = null;
    skipGlArmed = false;
    diagnosticQuadArmed = false;
    stats.contextReady = true; stats.presentationValid = false;
    try { glyphReady = glyphProvider?.restore() ?? false; }
    catch (error) { glyphReady = false; glyphProviderReason = error instanceof Error ? error.message : String(error); }
    options.onInvalidate?.();
  };
  options.canvas.addEventListener("webglcontextlost", onContextLost);
  options.canvas.addEventListener("webglcontextrestored", onContextRestored);
  const borrowed = new Map<string, { display: Container; parent: Container | null; index: number; matrix: Matrix;
    alpha: number; tint: number; blendMode: Container["blendMode"]; mask: Container | null }>();
  let disposed = false;
  let usedFrameTextures = new Set<string>();
  const canvasText = (app.renderer as unknown as { canvasText?: { getTexture?: (...args: unknown[]) => unknown } }).canvasText;
  if (canvasText?.getTexture) {
    const original = canvasText.getTexture.bind(canvasText);
    canvasText.getTexture = (...args: unknown[]) => { stats.textRasterizations++; return original(...args); };
  }

  function textureFor(handle: TTexture | null): Texture {
    if (handle === null) return Texture.WHITE;
    const url = options.textureUrl(handle);
    if (!url) return Texture.WHITE;
    const pixel = pixelTextures.get(url);
    if (pixel) return pixel.texture;
    const ready = textureCache.get(url);
    if (ready) return ready;
    if (failedTextures.has(url)) return Texture.WHITE;
    if (!pendingTextures.has(url)) {
      skipGlArmed = false;
      diagnosticQuadArmed = false;
      stats.textureLoads++;
      const pending = Assets.load<Texture>({ src: url, parser: "loadTextures" }).then((texture) => {
        if (!(texture instanceof Texture)) throw new Error(`Pixi texture parser returned no Texture for ${url}`);
        if (!disposed) {
          textureCache.set(url, texture);
          stats.textures = textureCache.size;
          options.onInvalidate?.();
        } else { void Assets.unload(url); }
      }).catch((error: unknown) => { failedTextures.add(url); textureFailureReasons.set(url, error instanceof Error ? error.message : String(error)); stats.textureFailures++; }).finally(() => { pendingTextures.delete(url); stats.resourcePending = pendingTextures.size; });
      pendingTextures.set(url, pending);
      stats.resourcePending = pendingTextures.size;
    }
    return Texture.WHITE;
  }

  function cropped(handle: TTexture | null, x: number, y: number, w: number, h: number): Texture {
    const base = textureFor(handle);
    if (base === Texture.WHITE) return base;
    const url = handle === null ? "" : options.textureUrl(handle) ?? "";
    const key = `${url}|${x},${y},${w},${h}`;
    let texture = frameTextures.get(key);
    if (!texture || (staleFrameKeys.has(key) && !usedFrameTextures.has(key))) {
      texture = new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) }); frameTextures.set(key, texture);
    }
    usedFrameTextures.add(key);
    return texture;
  }

  function reconcile(key: string, kind: string, digest: string, make: () => Container): { display: Container; changed: boolean } {
    const old = retained.get(key);
    if (old?.kind === kind) {
      const changed = old.digest !== digest;
      if (changed) { old.digest = digest; stats.updated++; }
      return { display: old.display, changed };
    }
    if (old) { old.display.destroy({ children: old.kind === "glyph" }); retained.delete(key); stats.destroyed++; }
    const reusable = kind === "text" || kind === "glyph" || kind === "fallback" ? borrowSource?.get(key) : undefined;
    if (reusable?.kind === kind && reusable.digest === digest) {
      const display = reusable.display;
      const parent = display.parent;
      borrowed.set(key, { display, parent, index: parent ? parent.getChildIndex(display) : -1,
        matrix: display.localTransform.clone(), alpha: display.alpha, tint: display.tint as number,
        blendMode: display.blendMode, mask: display.mask as Container | null });
      retained.set(key, reusable);
      return { display, changed: false };
    }
    const display = make();
    display.eventMode = "none";
    retained.set(key, { kind, display, digest });
    stats.created++;
    return { display, changed: true };
  }

  const quad = createQuadView();
  const nine = createNinePatchView();
  const line = createPolylineView();
  const mesh = createTexturedMeshView();
  const clip = createClipRectView();

  let appendParent: Container = root;
  let orderCursors = new Map<Container, number>();
  function place(parent: Container, display: Container): void {
    const at = orderCursors.get(parent) ?? 0;
    if (display.parent !== parent || parent.getChildAt(at) !== display) parent.addChildAt(display, Math.min(at, parent.children.length));
    orderCursors.set(parent, at + 1);
  }
  function append(display: Container, mask: Graphics | null): void {
    display.mask = mask;
    place(appendParent, display);
  }

  function emitNativeText(record: PixiTextRecord, seen: Set<string>, mask: Graphics | null,
    localTransform: readonly number[] = record.localTransform ?? record.transform,
    inheritedBlend = false): void {
    const key = `text:${record.key}`;
    seen.add(key);
    if (record.runs?.some((run) => run.color !== undefined)) throw new Error("Pixi text color runs require ordered native Text children");
    const digest = JSON.stringify([record.text, record.runs, record.style, record.contentKey, record.resourceRevision]);
    const previousRevision = retained.get(key)?.resourceRevision ?? borrowSource?.get(key)?.resourceRevision;
    const result = reconcile(key, "text", digest, () => new Text({ text: record.text, style: record.style }));
    const text = result.display as Text;
    if (result.changed) {
      if (previousRevision !== record.resourceRevision && record.resourceRevision !== undefined)
        CanvasTextMetrics.clearMetrics();
      text.text = record.runs?.map((run) => run.text).join("") ?? record.text;
      text.style = new TextStyle(record.style);
      stats.textInvalidations++;
    }
    retained.get(key)!.resourceRevision = record.resourceRevision;
    setMatrix(text, localTransform);
    text.alpha = record.alpha ?? 1;
    text.tint = record.tint ?? 0xffffff;
    text.blendMode = inheritedBlend ? "inherit" : blendOf(record.blend ?? BLEND_MIX);
    append(text, mask);
  }

  function emitText(record: PixiTextRecord, seen: Set<string>, mask: Graphics | null, plan?: PixiScenePlan): void {
    const labelId = record.labelId ?? record.key;
    const requestedGlyph = textMode !== "native" && (record.glyph !== undefined || record.nativeFallback !== undefined);
    const glyph = requestedGlyph ? record.glyph : undefined;
    const inkCounts = glyph ? drawableGlyphCounts(glyph) : null;
    const canGlyph = !!glyph && glyphReady && !!glyphProvider && !!gl && !!inkCounts &&
      (record.blend === undefined || record.blend === BLEND_MIX);
    if (!requestedGlyph) {
      emitNativeText(record, seen, mask);
      candidateLabels.set(labelId, { mode: "native" });
      return;
    }
    const kind = canGlyph ? "glyph" : "fallback";
    const digest = canGlyph ? `glyph:${glyph!.contentKey}` : `fallback:${record.resourceRevision ?? ""}`;
    const key = `text:${record.key}`;
    seen.add(key);
    const outer = reconcile(key, kind, digest, () => new Container()).display;
    outer.eventMode = "none";
    setMatrix(outer, record.localTransform ?? record.transform);
    outer.alpha = record.alpha ?? 1;
    outer.tint = record.tint ?? 0xffffff;
    outer.blendMode = blendOf(record.blend ?? BLEND_MIX);
    append(outer, mask);
    if (!canGlyph) {
      const previousParent = appendParent;
      appendParent = outer; orderCursors.set(outer, 0);
      const inv = inverseAffine(record.localTransform ?? record.transform);
      if (!inv) throw new Error("non-invertible native fallback transform");
      const parts = record.nativeFallback ?? [{ ...record, key: `${record.key}:native`, glyph: undefined,
        nativeFallback: undefined }];
      for (const part of parts)
        emitNativeText(part, seen, null, mulAffine(inv, part.transform), true);
      appendParent = previousParent;
      candidateLabels.set(labelId, { mode: "native", reason: record.fallbackReason ??
        (!glyph ? "glyph unavailable" : !glyphReady ? glyphProviderReason :
          record.blend !== undefined && record.blend !== BLEND_MIX ? "unsupported glyph blend" :
            "invalid glyph block") });
      return;
    }
    let child = outer.children[0] as GlyphContainer | undefined;
    if (!(child instanceof GlyphContainer)) {
      outer.removeChildren().forEach((part) => part.destroy({ children: false }));
      child = new GlyphContainer({ render: (renderer) => drawGlyph(child!, renderer),
        addBounds: (bounds) => {
          const record = glyphRecords.get(child!);
          if (record) {
            const b = paintedInkBounds(record);
            const resolution = glyphBoundsResolution.get(child!) ?? 1;
            bounds.minX = Math.min(bounds.minX, Math.floor(b.x * resolution - 2) / resolution);
            bounds.minY = Math.min(bounds.minY, Math.floor(b.y * resolution - 2) / resolution);
            bounds.maxX = Math.max(bounds.maxX,
              Math.ceil((b.x + b.width) * resolution + 2) / resolution);
            bounds.maxY = Math.max(bounds.maxY,
              Math.ceil((b.y + b.height) * resolution + 2) / resolution);
          }
        } });
      child.eventMode = "none";
      outer.addChild(child);
    }
    const previousGlyph = glyphRecords.get(child);
    const previousInkCounts = glyphDrawableCounts.get(child);
    const previousCache = sceneGlyphCaches.get(key);
    if (borrowSource && previousCache?.child === child && !borrowedGlyphCacheRestore.has(child))
      borrowedGlyphCacheRestore.set(child, { active: previousCache.active, resolution: previousCache.resolution,
        boundsResolution: glyphBoundsResolution.get(child) ?? 1, record: previousGlyph,
        counts: previousInkCounts, lease: null, created: false });
    glyphRecords.set(child, glyph!);
    glyphDrawableCounts.set(child, inkCounts!);
    const carrierMatrix = record.localTransform ?? record.transform;
    const localScale = singularScale(carrierMatrix);
    let ancestorScale = 1;
    if (record.parentId) {
      const byGroup = new Map((plan?.groups ?? []).map((group) => [group.id, group]));
      let id: string | undefined = record.parentId;
      while (id) {
        const group = byGroup.get(id);
        if (group) ancestorScale *= singularScale(group.transform);
        id = group?.parentId;
      }
    }
    const desiredResolution = Math.ceil(Math.max(viewWidth / Math.max(1, designWidth),
      viewHeight / Math.max(1, designHeight)) * viewResolution * localScale * ancestorScale * 256) / 256;
    const b = paintedInkBounds(glyph!);
    const { width, height, pixels } = cachePixelSize(b, desiredResolution);
    let inheritedAlpha = record.alpha ?? 1;
    if (record.parentId) {
      const byGroup = new Map((plan?.groups ?? []).map((group) => [group.id, group]));
      let id: string | undefined = record.parentId;
      while (id) { const group = byGroup.get(id); inheritedAlpha *= group?.alpha ?? 1; id = group?.parentId; }
    }
    const previous = sceneGlyphCaches.get(key);
    const reuse = previous?.child === child && previous.active &&
      previous.contextGeneration === contextGeneration &&
      desiredResolution / previous.resolution >= 0.75 && desiredResolution / previous.resolution <= 1.25 &&
      previous.bounds.x === b.x && previous.bounds.y === b.y &&
      previous.bounds.width === b.width && previous.bounds.height === b.height;
    const allocationPixels = reuse ? previous.pixels : pixels;
    const needsBake = !reuse;
    const cache = !!plan && textMode === "slug-cached" && glyph!.cacheEligible !== false &&
      inheritedAlpha === 1 && Number.isFinite(desiredResolution) && desiredResolution > 0 &&
      (!previous?.active || previous.contextGeneration !== contextGeneration || reuse) &&
      width > 0 && height > 0 && width <= MAX_CACHE_SIDE && height <= MAX_CACHE_SIDE &&
      allocationPixels <= MAX_BAKE_PIXELS_PER_PRESENT && glyphCachePixels + allocationPixels <= MAX_CACHE_PIXELS &&
      glyphCacheEntries < MAX_CACHE_ENTRIES && (!needsBake || (glyphCacheBakes < MAX_BAKES_PER_PRESENT &&
      glyphCacheBakePixels + allocationPixels <= MAX_BAKE_PIXELS_PER_PRESENT));
    if (cache) {
      glyphBoundsResolution.set(child, reuse ? previous.resolution : desiredResolution);
      if (needsBake) {
        const journal = borrowedGlyphCacheRestore.get(child);
        if (journal) {
          journal.lease = suspendCommittedCache(child);
          if (!journal.lease) journal.created = true;
        }
        child.cacheAsTexture({ resolution: desiredResolution });
      }
      glyphCachePixels += allocationPixels; glyphCacheEntries++;
      if (needsBake) { glyphCacheBakes++; glyphCacheBakePixels += allocationPixels; }
    } else if (child.renderGroup?.isCachedAsTexture) {
      const lease = suspendCommittedCache(child);
      const journal = borrowedGlyphCacheRestore.get(child);
      if (journal) journal.lease = lease;
      else throw new Error("unowned glyph cache suspension");
    }
    if (!cache) glyphBoundsResolution.set(child, 1);
    candidateGlyphCaches.set(key, { child, labelId, parentId: record.parentId, ownAlpha: record.alpha ?? 1,
      bounds: b, eligible: textMode === "slug-cached" && glyph!.cacheEligible !== false, active: cache,
      resolution: cache && reuse ? previous.resolution : desiredResolution, localScale,
      pixels: cache ? allocationPixels : 0, contextGeneration });
    candidateLabels.set(labelId, { mode: cache ? "slug-cached" : "slug",
      reason: textMode === "slug-cached" && !cache ? "cache ineligible or budget" : undefined });
  }

  function render(list: DrawList<TTexture>, texts: readonly PixiTextRecord[] = [], plan?: PixiScenePlan): boolean {
    if (disposed || !contextReady()) return false;
    retryGlyphProvider();
    stats.frames++;
    omittedClipMasksInScene = 0;
    candidateLabels = new Map();
    candidateGlyphCaches = new Map();
    glyphCachePixels = glyphCacheEntries = glyphCacheBakes = glyphCacheBakePixels = 0;
    usedFrameTextures = new Set();
    const seen = new Set<string>();
    orderCursors = new Map([[root, 0]]);
    const textAt = new Map<number, PixiTextRecord[]>();
    for (const record of texts) {
      const bucket = textAt.get(record.insertionIndex);
      if (bucket) bucket.push(record); else textAt.set(record.insertionIndex, [record]);
    }
    const masks: (Graphics | null)[] = [];
    const parentStack: Container[] = [];
    const byIndex = plan ? new Map(plan.primitives.map((entry) => [entry.index, entry])) : null;
    const openGroups = new Map<number, PixiSceneGroup[]>();
    const closeGroups = new Map<number, PixiSceneGroup[]>();
    if (plan?.groups) for (const group of plan.groups) {
      const opens = openGroups.get(group.firstIndex) ?? []; opens.push(group); openGroups.set(group.firstIndex, opens);
      const closes = closeGroups.get(group.endIndex) ?? []; closes.push(group); closeGroups.set(group.endIndex, closes);
    }
    for (const groups of openGroups.values()) groups.sort((a, b) => b.endIndex - a.endIndex);
    for (const groups of closeGroups.values()) groups.sort((a, b) => b.firstIndex - a.firstIndex);
    const groupParents: Container[] = [];
    appendParent = root;
    let refused = false;
    const currentMask = () => masks[masks.length - 1] ?? null;
    for (let i = 0; i <= list.count; i++) {
      for (const _group of closeGroups.get(i) ?? []) appendParent = groupParents.pop() ?? root;
      for (const group of openGroups.get(i) ?? []) {
        const key = `group:${group.id}`; seen.add(key);
        const container = reconcile(key, "group", "", () => new Container()).display;
        container.eventMode = "none";
        container.isRenderGroup = group.renderGroup ?? false;
        setMatrix(container, group.transform);
        container.alpha = group.alpha ?? 1;
        place(appendParent, container); orderCursors.set(container, 0);
        groupParents.push(appendParent); appendParent = container;
      }
      for (const record of textAt.get(i) ?? []) emitText(record, seen, currentMask(), plan);
      if (i === list.count) break;
      const kind = list.kindAt(i);
      const key = byIndex?.get(i)?.id ?? options.identityAt?.(i, kind) ?? `${kind}:${i}`;
      if (kind === DRAW_CLIP_PUSH) {
        if (options.diagnosticClipMode === "omit") {
          // Retain clip grouping and painter order, but do not create a mask
          // object or submit its stencil geometry. Output is intentionally unclipped.
          const groupKey = `clip-group:${key}`; seen.add(groupKey);
          const group = reconcile(groupKey, "clip-group", "", () => new Container()).display;
          group.mask = null;
          place(appendParent, group); orderCursors.set(group, 0);
          parentStack.push(appendParent); appendParent = group; masks.push(null);
          omittedClipMasksInScene++;
          continue;
        }
        list.readClipRect(i, clip);
        const bound = { x: clip.x - clip.outsetX, y: clip.y, w: clip.w + 2 * clip.outsetX, h: clip.h };
        const maskKey = `clip:${key}`; seen.add(maskKey);
        const groupKey = `clip-group:${key}`; seen.add(groupKey);
        const digest = `${bound.x},${bound.y},${bound.w},${bound.h},${clip.cornerRadius},${clip.outsetX}`;
        const result = reconcile(maskKey, "clip", digest, () => new Graphics());
        const g = result.display as Graphics;
        if (result.changed) {
          g.clear();
          if (clip.cornerRadius > 0) g.roundRect(bound.x, bound.y, bound.w, bound.h, clip.cornerRadius).fill(0xffffff);
          else g.rect(bound.x, bound.y, bound.w, bound.h).fill(0xffffff);
        }
        const group = reconcile(groupKey, "clip-group", "", () => new Container()).display;
        place(appendParent, g); place(appendParent, group); orderCursors.set(group, 0); group.mask = g;
        parentStack.push(appendParent); appendParent = group; masks.push(g); continue;
      }
      if (kind === DRAW_CLIP_POP) { masks.pop(); appendParent = parentStack.pop() ?? root; continue; }
      if (kind === DRAW_GLYPHS) { stats.refusedGlyphs++; refused = true; continue; }
      if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH && kind !== DRAW_POLYLINE && kind !== DRAW_TEXTURED_MESH) {
        stats.refusedEffects++; refused = true; continue;
      }
      seen.add(key);
      if (kind === DRAW_QUAD) {
        list.readQuad(i, quad);
        const digest = JSON.stringify([list.textureAt(i), quad.m, quad.w, quad.h, quad.srcX, quad.srcY, quad.srcW, quad.srcH, quad.r, quad.g, quad.b, quad.a, quad.blend, quad.flipH, quad.flipV, quad.hasColorMatrix, quad.colorMatrix]);
        const result = reconcile(key, "quad", digest, () => new MatrixSprite());
        const sprite = result.display as MatrixSprite;
        sprite.texture = cropped(list.textureAt(i), quad.srcX, quad.srcY, quad.srcW, quad.srcH);
        const local = byIndex?.get(i)?.localTransform;
        setMatrix(sprite, quadMatrix(local ?? quad.m, quad.w, quad.h, quad.srcW, quad.srcH, quad.flipH, quad.flipV));
        sprite.tint = rgba(quad.r / (quad.a || 1), quad.g / (quad.a || 1), quad.b / (quad.a || 1));
        sprite.alpha = quad.a; sprite.blendMode = blendOf(quad.blend);
        if (result.changed) sprite.setInlineMatrix(quad.hasColorMatrix, quad.colorMatrix);
        append(sprite, currentMask());
      } else if (kind === DRAW_NINE_PATCH) {
        list.readNinePatch(i, nine);
        const digest = JSON.stringify([list.textureAt(i), nine.m, nine.w, nine.h, nine.srcX, nine.srcY, nine.srcW, nine.srcH, nine.marginLeft, nine.marginTop, nine.marginRight, nine.marginBottom, nine.r, nine.g, nine.b, nine.a, nine.blend, nine.hasColorMatrix, nine.colorMatrix]);
        const result = reconcile(key, "nine", digest, () => new MatrixNineSliceSprite({ texture: Texture.WHITE }));
        const sprite = result.display as MatrixNineSliceSprite;
        sprite.texture = cropped(list.textureAt(i), nine.srcX, nine.srcY, nine.srcW, nine.srcH);
        sprite.leftWidth = nine.marginLeft; sprite.topHeight = nine.marginTop;
        sprite.rightWidth = nine.marginRight; sprite.bottomHeight = nine.marginBottom;
        sprite.width = nine.w; sprite.height = nine.h;
        setMatrix(sprite, nineMatrix(byIndex?.get(i)?.localTransform ?? nine.m, nine.w, nine.h, nine.flipH, nine.flipV));
        sprite.tint = rgba(nine.r / (nine.a || 1), nine.g / (nine.a || 1), nine.b / (nine.a || 1));
        sprite.alpha = nine.a; sprite.blendMode = blendOf(nine.blend); append(sprite, currentMask());
        if (result.changed) sprite.setInlineMatrix(nine.hasColorMatrix, nine.colorMatrix);
      } else if (kind === DRAW_POLYLINE) {
        list.readPolyline(i, line);
        const digest = JSON.stringify([line.points.slice(0, line.pointCount * 2), line.width, line.r, line.g, line.b, line.a]);
        const result = reconcile(key, "line", digest, () => new Graphics());
        const g = result.display as Graphics;
        if (result.changed) {
          g.clear(); if (line.pointCount > 0) g.moveTo(line.points[0], line.points[1]);
          for (let p = 1; p < line.pointCount; p++) g.lineTo(line.points[p * 2], line.points[p * 2 + 1]);
          g.stroke({ width: line.width, color: rgba(line.r / (line.a || 1), line.g / (line.a || 1), line.b / (line.a || 1)), alpha: line.a });
        }
        if (byIndex?.get(i)?.localTransform) setMatrix(g, byIndex.get(i)!.localTransform!);
        append(g, currentMask());
      } else {
        list.readTexturedMesh(i, mesh);
        const digest = JSON.stringify([list.textureAt(i), mesh.m, mesh.positions.slice(0, mesh.vertexCount * 2), mesh.uvs.slice(0, mesh.vertexCount * 2), mesh.indices.slice(0, mesh.indexCount), mesh.r, mesh.g, mesh.b, mesh.a, mesh.blend]);
        const result = reconcile(key, "mesh", digest, () => new Mesh({ geometry: new MeshGeometry({}), texture: Texture.WHITE }));
        const display = result.display as Mesh<MeshGeometry>;
        if (result.changed) {
          display.geometry.positions = mesh.positions.slice(0, mesh.vertexCount * 2);
          display.geometry.uvs = mesh.uvs.slice(0, mesh.vertexCount * 2);
          display.geometry.indices = mesh.indices.slice(0, mesh.indexCount);
        }
        display.texture = textureFor(list.textureAt(i)); setMatrix(display, byIndex?.get(i)?.localTransform ?? mesh.m);
        display.tint = rgba(mesh.r / (mesh.a || 1), mesh.g / (mesh.a || 1), mesh.b / (mesh.a || 1));
        display.alpha = mesh.a; display.blendMode = blendOf(mesh.blend); append(display, currentMask());
      }
    }
    for (const [key, value] of retained) if (!seen.has(key)) {
      value.display.destroy({ children: value.kind === "glyph" }); retained.delete(key); stats.destroyed++;
    }
    if (!plan) for (const [key, texture] of frameTextures) if (!usedFrameTextures.has(key)) {
      texture.destroy(false); frameTextures.delete(key);
    }
    stats.objects = retained.size;
    const completed = !refused && pendingTextures.size === 0 && stats.textureFailures === 0;
    if (refused) stats.blockedRefusedFrames++;
    if (pendingTextures.size > 0) stats.blockedPendingFrames++;
    if (completed) {
      if (plan?.groups) {
        const groupsById = new Map(plan.groups.map((group) => [group.id, group]));
        const fractionalGlyphAncestors = new Set<string>();
        for (const info of candidateGlyphCaches.values()) {
          let alpha = info.ownAlpha, id = info.parentId;
          while (id) { alpha *= groupsById.get(id)?.alpha ?? 1; id = groupsById.get(id)?.parentId; }
          if (alpha === 1) continue;
          id = info.parentId;
          while (id) { fractionalGlyphAncestors.add(id); id = groupsById.get(id)?.parentId; }
        }
        let cachedPixels = glyphCachePixels;
        let cachedEntries = glyphCacheEntries, bakes = glyphCacheBakes, bakePixels = glyphCacheBakePixels;
        const cacheResolution = Math.max(viewWidth / Math.max(1, designWidth),
          viewHeight / Math.max(1, designHeight)) * viewResolution;
        for (const group of plan.groups) if (group.cacheAsTexture) {
          const display = retained.get(`group:${group.id}`)?.display;
          if (!display) continue;
          const bounds = display.getLocalBounds();
          const pixelWidth = Math.ceil(bounds.width * cacheResolution);
          const pixelHeight = Math.ceil(bounds.height * cacheResolution);
          const pixels = pixelWidth * pixelHeight;
          if (display.children.length > 1 && pixels > 0) {
            const active = (group.alpha ?? 1) === 1 && !fractionalGlyphAncestors.has(group.id) &&
              pixelWidth <= MAX_CACHE_SIDE && pixelHeight <= MAX_CACHE_SIDE &&
              pixels <= MAX_BAKE_PIXELS_PER_PRESENT && cachedPixels + pixels <= MAX_CACHE_PIXELS &&
              cachedEntries < MAX_CACHE_ENTRIES && bakes < MAX_BAKES_PER_PRESENT &&
              bakePixels + pixels <= MAX_BAKE_PIXELS_PER_PRESENT;
            admissionCacheInfo?.set(group.id, { resolution: cacheResolution, desiredResolution: cacheResolution,
              width: bounds.width,
              height: bounds.height, pixels: active ? pixels : 0, active });
            if (active) {
              display.cacheAsTexture({ resolution: cacheResolution }); cachedPixels += pixels;
              cachedEntries++; bakes++; bakePixels += pixels;
              admissionCachedGroups?.add(group.id);
            }
          }
        }
      }
      // A provider may have uploaded atlas pages while Couch prepared this
      // admission. Pixi has not begun its render pass yet, so full reset is safe.
      (app.renderer as unknown as { resetState?: () => void }).resetState?.();
      const drew = submitPixi(options.diagnostics?.mode === "commands"
        ? [...(admissionCachedGroups ?? []),
          ...[...candidateGlyphCaches].filter(([, info]) => info.active).map(([id]) => id)] : []);
      if (!contextReady()) return false;
      const counts = { native: 0, slug: 0, slugCached: 0 };
      const reasons: Record<string, number> = {};
      for (const outcome of candidateLabels.values()) {
        if (outcome.mode === "slug-cached") counts.slugCached++;
        else counts[outcome.mode]++;
        if (outcome.reason) reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
      }
      const kinds = Number(counts.native > 0) + Number(counts.slug > 0) + Number(counts.slugCached > 0);
      candidateTextOutcomes = { requested: textMode,
        actual: kinds > 1 ? "mixed" : counts.slugCached ? "slug-cached" : counts.slug ? "slug" : "native",
        ...counts, reasons };
      committedTextOutcomes = candidateTextOutcomes;
      markDraw(drew);
      if (!plan) for (const key of usedFrameTextures) staleFrameKeys.delete(key);
      if (plan) for (const [key, texture] of frameTextures) if (!usedFrameTextures.has(key)) {
        texture.destroy(false); frameTextures.delete(key);
      }
      stats.frameTextures = frameTextures.size;
      const managed = (app.renderer as unknown as { texture?: { managedTextures?: Iterable<unknown> | ArrayLike<unknown> } }).texture?.managedTextures;
      const entries = managed ? Array.from(managed as Iterable<unknown> | ArrayLike<unknown>) : [];
      stats.gpuTextureSlots = entries.length;
      stats.gpuTextures = entries.filter((entry) => entry != null).length;
    }
    return completed;
  }

  function fail(reason: string): PixiSceneResult {
    stats.scenePreflightFailures++;
    return { presented: false, reason };
  }

  function queueGlyphCache(key: string): void {
    if (sceneGlyphQueued.has(key)) return;
    sceneGlyphQueued.add(key); sceneGlyphPending.push(key);
  }

  function glyphCacheResolution(info: GlyphCacheInfo): number {
    let resolution = Math.max(viewWidth / Math.max(1, designWidth),
      viewHeight / Math.max(1, designHeight)) * viewResolution * info.localScale;
    let id = info.parentId;
    while (id) {
      const state = sceneGroupStates?.get(id), parent = sceneGroupParents?.get(id);
      if (state) resolution *= singularScale(state.transform);
      id = parent;
    }
    return resolution;
  }

  function glyphCacheAlpha(info: GlyphCacheInfo): number {
    let alpha = info.ownAlpha, id = info.parentId;
    while (id) { alpha *= sceneGroupStates?.get(id)?.alpha ?? 1; id = sceneGroupParents?.get(id); }
    return alpha;
  }

  function staticCacheEligible(id: string): boolean {
    for (const key of sceneGlyphDependents.get(id) ?? []) {
      const info = sceneGlyphCaches.get(key);
      if (info && glyphCacheAlpha(info) !== 1) return false;
    }
    return true;
  }

  function transitionGlyphOutcome(info: GlyphCacheInfo, cached: boolean): void {
    const previous = sceneLabelOutcomes.get(info.labelId);
    if (!previous || previous.mode === "native") return;
    const nextMode = cached ? "slug-cached" : "slug";
    if (previous.mode === nextMode) return;
    const counts = { native: committedTextOutcomes.native, slug: committedTextOutcomes.slug,
      slugCached: committedTextOutcomes.slugCached };
    const oldKey = previous.mode === "slug-cached" ? "slugCached" : previous.mode;
    const nextKey = nextMode === "slug-cached" ? "slugCached" : nextMode;
    counts[oldKey]--; counts[nextKey]++;
    const reasons = { ...committedTextOutcomes.reasons };
    if (previous.reason) {
      reasons[previous.reason]--;
      if (!reasons[previous.reason]) delete reasons[previous.reason];
    }
    const nextReason = cached ? undefined : "cache ineligible or budget";
    if (nextReason) reasons[nextReason] = (reasons[nextReason] ?? 0) + 1;
    sceneLabelOutcomes.set(info.labelId, { mode: nextMode, reason: nextReason });
    const kinds = Number(counts.native > 0) + Number(counts.slug > 0) + Number(counts.slugCached > 0);
    committedTextOutcomes = { requested: textMode,
      actual: kinds > 1 ? "mixed" : counts.slugCached ? "slug-cached" : counts.slug ? "slug" : "native",
      ...counts, reasons };
  }

  function prepareDeferredGlyphCaches(skip: ReadonlySet<string> = new Set(), motion = false): { rollback(): void; commit(): void } {
    if (sceneGlyphPending.length === 0) return { rollback() {}, commit() {} };
    const changed: { key: string; old: GlyphCacheInfo }[] = [];
    const oldGlyphPixels = sceneGlyphCachedPixels, oldGlyphEntries = sceneGlyphCachedEntries;
    const oldBakes = cacheBakesThisPresent, oldBakePixels = cacheBakePixelsThisPresent;
    let totalPixels = sceneCachedPixels + sceneGlyphCachedPixels;
    let totalEntries = (sceneCachedGroups?.size ?? 0) + sceneGlyphCachedEntries;
    let checked = 0;
    try { while (cacheBakesThisPresent < MAX_BAKES_PER_PRESENT && checked < sceneGlyphPending.length) {
      const key = sceneGlyphPending[sceneGlyphCursor++ % sceneGlyphPending.length]; checked++;
      const info = sceneGlyphCaches.get(key);
      if (!info || skip.has(key) || info.active || !info.eligible || glyphCacheAlpha(info) !== 1) continue;
      const bins = motion ? 32 : 256;
      const resolution = Math.ceil(glyphCacheResolution(info) * bins) / bins;
      const { width, height, pixels } = cachePixelSize(info.bounds, resolution);
      if (!Number.isFinite(resolution) || resolution <= 0 || !Number.isFinite(pixels) ||
          width < 1 || height < 1 || width > MAX_CACHE_SIDE || height > MAX_CACHE_SIDE ||
          totalPixels + pixels > MAX_CACHE_PIXELS || totalEntries >= MAX_CACHE_ENTRIES ||
          pixels > MAX_BAKE_PIXELS_PER_PRESENT || cacheBakePixelsThisPresent + pixels > MAX_BAKE_PIXELS_PER_PRESENT) continue;
      glyphBoundsResolution.set(info.child, resolution);
      info.child.cacheAsTexture({ resolution });
      changed.push({ key, old: { ...info } });
      info.active = true; info.resolution = resolution; info.pixels = pixels;
      totalPixels += pixels; totalEntries++; cacheBakesThisPresent++; cacheBakePixelsThisPresent += pixels;
    } } catch (error) {
      for (const { key, old } of changed) {
        const current = sceneGlyphCaches.get(key);
        current?.child.cacheAsTexture(false);
        if (current) glyphBoundsResolution.set(current.child, old.active ? old.resolution : 1);
        sceneGlyphCaches.set(key, old);
      }
      sceneGlyphCachedPixels = oldGlyphPixels; sceneGlyphCachedEntries = oldGlyphEntries;
      cacheBakesThisPresent = oldBakes; cacheBakePixelsThisPresent = oldBakePixels;
      throw error;
    }
    sceneGlyphCachedPixels = totalPixels - sceneCachedPixels;
    sceneGlyphCachedEntries = totalEntries - (sceneCachedGroups?.size ?? 0);
    return {
      rollback() {
        for (const { key, old } of changed) {
          const current = sceneGlyphCaches.get(key);
          current?.child.cacheAsTexture(false);
          if (current) glyphBoundsResolution.set(current.child, old.active ? old.resolution : 1);
          sceneGlyphCaches.set(key, old);
        }
        sceneGlyphCachedPixels = oldGlyphPixels;
        sceneGlyphCachedEntries = oldGlyphEntries;
        cacheBakesThisPresent = oldBakes; cacheBakePixelsThisPresent = oldBakePixels;
      },
      commit() {
        for (const { key } of changed) {
          const info = sceneGlyphCaches.get(key);
          if (info) transitionGlyphOutcome(info, true);
          sceneGlyphQueued.delete(key);
        }
        if (changed.length) sceneGlyphPending = sceneGlyphPending.filter((key) => sceneGlyphQueued.has(key));
        if (sceneGlyphCursor >= sceneGlyphPending.length) sceneGlyphCursor = 0;
      },
    };
  }

  function wakeGlyphRefinement(): void {
    if (sceneGlyphPending.length === 0 && sceneCachePending.length === 0) return;
    const pixels = sceneCachedPixels + sceneGlyphCachedPixels;
    const entries = (sceneCachedGroups?.size ?? 0) + sceneGlyphCachedEntries;
    const glyphReadyToBake = sceneGlyphPending.some((key) => {
      const info = sceneGlyphCaches.get(key);
      if (!info || info.active || !info.eligible || glyphCacheAlpha(info) !== 1 || entries >= MAX_CACHE_ENTRIES)
        return false;
      const resolution = Math.ceil(glyphCacheResolution(info) * 256) / 256;
      const { width, height, pixels: needed } = cachePixelSize(info.bounds, resolution);
      return Number.isFinite(resolution) && resolution > 0 &&
        width > 0 && height > 0 && width <= MAX_CACHE_SIDE && height <= MAX_CACHE_SIDE &&
        needed <= MAX_BAKE_PIXELS_PER_PRESENT && pixels + needed <= MAX_CACHE_PIXELS;
    });
    const groupReadyToBake = sceneCachePending.some((id) => {
      const info = sceneCacheInfo?.get(id);
      if (!info || info.active || !staticCacheEligible(id) || entries >= MAX_CACHE_ENTRIES) return false;
      const width = Math.ceil(info.width * info.resolution), height = Math.ceil(info.height * info.resolution);
      const needed = width * height;
      return width > 0 && height > 0 && width <= MAX_CACHE_SIDE && height <= MAX_CACHE_SIDE &&
        needed <= MAX_BAKE_PIXELS_PER_PRESENT && pixels + needed <= MAX_CACHE_PIXELS;
    });
    if (glyphReadyToBake || groupReadyToBake) options.onInvalidate?.("present");
  }

  function queueCache(id: string): void {
    if (sceneCacheQueued.has(id)) return;
    sceneCacheQueued.add(id); sceneCachePending.push(id);
  }

  /** Try a bounded amount of deferred cache work without traversing the scene. */
  function prepareDeferredCaches(skip: ReadonlySet<string> = new Set()): () => void {
    if (!sceneCacheInfo || !sceneGroups || !sceneCachedGroups || sceneCachePending.length === 0) return () => {};
    const oldPixels = sceneCachedPixels;
    const oldBakes = cacheBakesThisPresent, oldBakePixels = cacheBakePixelsThisPresent;
    const activated: { id: string; old: CacheInfo }[] = [];
    const rollback = () => {
      for (const { id, old } of activated) {
        sceneGroups!.get(id)!.cacheAsTexture(false);
        sceneCacheInfo!.set(id, old); sceneCachedGroups!.delete(id);
      }
      sceneCachedPixels = oldPixels;
      cacheBakesThisPresent = oldBakes; cacheBakePixelsThisPresent = oldBakePixels;
    };
    try {
      for (let attempt = 0; cacheBakesThisPresent < MAX_BAKES_PER_PRESENT &&
        attempt < sceneCachePending.length; attempt++) {
        const id = sceneCachePending[sceneCacheCursor++ % sceneCachePending.length];
        const old = sceneCacheInfo.get(id);
        if (!old || old.active || skip.has(id) || !staticCacheEligible(id)) continue;
        const width = Math.ceil(old.width * old.resolution), height = Math.ceil(old.height * old.resolution);
        const pixels = width * height;
        if (width <= 0 || height <= 0 || width > MAX_CACHE_SIDE || height > MAX_CACHE_SIDE ||
            pixels > MAX_BAKE_PIXELS_PER_PRESENT || cacheBakePixelsThisPresent + pixels > MAX_BAKE_PIXELS_PER_PRESENT ||
            sceneCachedPixels + sceneGlyphCachedPixels + pixels > MAX_CACHE_PIXELS ||
            sceneCachedGroups.size + sceneGlyphCachedEntries >= MAX_CACHE_ENTRIES) continue;
        sceneGroups.get(id)!.cacheAsTexture({ resolution: old.resolution });
        sceneCacheInfo.set(id, { ...old, pixels, active: true });
        sceneCachedGroups.add(id); sceneCachedPixels += pixels;
        cacheBakesThisPresent++; cacheBakePixelsThisPresent += pixels;
        activated.push({ id, old });
      }
    } catch (error) { rollback(); throw error; }
    return rollback;
  }

  function presentScene(): PixiSceneResult {
    if (disposed || !sceneObjects) return fail("retained scene unavailable");
    if (!contextReady()) return fail("WebGL context lost");
    if (pendingTextures.size || failedTextures.size) return fail("texture unavailable");
    stats.frames++;
    cacheBakesThisPresent = cacheBakePixelsThisPresent = 0;
    const cacheBakeCandidates = options.diagnostics?.mode === "commands"
      ? [...sceneCachePending, ...sceneGlyphPending] : [];
    let rollbackCaches: () => void = () => {};
    let deferredGlyphs: { rollback(): void; commit(): void } = { rollback() {}, commit() {} };
    try {
      rollbackCaches = prepareDeferredCaches();
      deferredGlyphs = prepareDeferredGlyphCaches();
      const drew = submitPixi(cacheBakeCandidates);
      if (!contextReady()) throw new Error("WebGL context lost");
      deferredGlyphs.commit();
      markDraw(drew);
      wakeGlyphRefinement();
      return { presented: true };
    } catch (error) {
      deferredGlyphs.rollback();
      rollbackCaches();
      stats.scenePresentationFailures++;
      stats.presentationValid = false;
      return { presented: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function admitScene(list: DrawList<TTexture>, texts: readonly PixiTextRecord[], plan: PixiScenePlan): PixiSceneResult {
    if (disposed) return fail("renderer disposed");
    if (!contextReady()) return fail("WebGL context lost");
    const byIndex = new Map<number, PixiScenePrimitive>();
    const ids = new Set<string>();
    for (const item of plan.primitives) {
      if (!item.id || ids.has(item.id) || byIndex.has(item.index) || item.index < 0 || item.index >= list.count ||
          (item.localTransform && !validMatrix(item.localTransform))) return fail("invalid primitive identity or transform");
      ids.add(item.id); byIndex.set(item.index, item);
    }
    const groups = [...(plan.groups ?? [])].sort((a, b) => a.firstIndex - b.firstIndex || b.endIndex - a.endIndex);
    const groupById = new Map<string, PixiSceneGroup>();
    const stack: PixiSceneGroup[] = [];
    for (const group of groups) {
      while (stack.length && group.firstIndex >= stack[stack.length - 1].endIndex) stack.pop();
      const parent = stack[stack.length - 1];
      if (!group.id || ids.has(group.id) || groupById.has(group.id) || !validMatrix(group.transform) ||
          !Number.isFinite(group.alpha ?? 1) || (group.alpha ?? 1) < 0 || (group.alpha ?? 1) > 1 ||
          group.firstIndex < 0 || group.endIndex > list.count || group.firstIndex >= group.endIndex ||
          (parent && (group.endIndex > parent.endIndex || group.parentId !== parent.id)) ||
          (!parent && group.parentId)) return fail("invalid group interval or parent");
      groupById.set(group.id, group); stack.push(group);
    }
    const textureDemand = new Set<string>();
    let resourcePending = false;
    let clipDepth = 0;
    for (let i = 0; i < list.count; i++) {
      const kind = list.kindAt(i);
      if (kind === DRAW_CLIP_PUSH || kind === DRAW_CLIP_POP) {
        for (const group of groups) if (group.firstIndex <= i && i < group.endIndex) return fail("group contains a clip boundary");
        clipDepth += kind === DRAW_CLIP_PUSH ? 1 : -1;
        if (clipDepth < 0) return fail("unbalanced clip commands");
        continue;
      }
      if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH && kind !== DRAW_POLYLINE && kind !== DRAW_TEXTURED_MESH)
        return fail("unsupported draw command");
      const descriptor = byIndex.get(i);
      if (!descriptor) return fail("drawable missing stable identity");
      let parent: PixiSceneGroup | undefined;
      for (const group of groups) if (group.firstIndex <= i && i < group.endIndex) parent = group;
      if (descriptor.parentId !== parent?.id) return fail("primitive parent does not match painter interval");
      if (kind !== DRAW_POLYLINE) {
        const handle = list.textureAt(i);
        if (handle !== null) {
          const url = options.textureUrl(handle);
          if (!url) return fail("texture lacks stable URL");
          textureDemand.add(url);
          const base = textureFor(handle);
          if (base === Texture.WHITE) resourcePending = true;
          else if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
            if (kind === DRAW_QUAD) list.readQuad(i, quad); else list.readNinePatch(i, nine);
            const rect = kind === DRAW_QUAD ? quad : nine;
            if (rect.srcX < 0 || rect.srcY < 0 || rect.srcW <= 0 || rect.srcH <= 0 ||
                rect.srcX + rect.srcW > base.source.width || rect.srcY + rect.srcH > base.source.height)
              return fail("source rectangle outside texture");
          }
        }
      }
    }
    if (resourcePending) return fail("texture pending or failed");
    if (clipDepth !== 0 || byIndex.size !== plan.primitives.length) return fail("invalid scene structure");
    for (const record of texts) {
      const id = `text:${record.key}`;
      if (ids.has(id) || !validMatrix(record.localTransform ?? record.transform) ||
          (record.parentId && !groupById.has(record.parentId))) return fail("invalid text identity or transform");
      ids.add(id);
    }
    // Build into an independent tree. The last presented tree, crops and resources stay
    // live until the replacement has been rendered successfully.
    const oldRoot = root, oldRetained = retained, oldFrames = frameTextures;
    const nextRoot = new Container();
    nextRoot.eventMode = "none";
    nextRoot.scale.set(viewWidth / Math.max(1, designWidth), viewHeight / Math.max(1, designHeight));
    root = nextRoot; retained = new Map(); frameTextures = new Map(oldFrames);
    borrowSource = oldRetained; borrowed.clear(); borrowedGlyphCacheRestore.clear();
    admissionCachedGroups = new Set();
    admissionCacheInfo = new Map();
    let completed = false;
    let reason = "presentation failed";
    try { completed = render(list, texts, plan); }
    catch (error) { reason = error instanceof Error ? error.message : String(error); }
    borrowSource = null;
    if (!completed) {
      for (const [child, old] of borrowedGlyphCacheRestore) {
        if (old.lease) old.lease.rollback();
        else if (old.created) child.cacheAsTexture(false);
        glyphBoundsResolution.set(child, old.boundsResolution);
        if (old.record) glyphRecords.set(child, old.record);
        if (old.counts) glyphDrawableCounts.set(child, old.counts);
      }
      borrowedGlyphCacheRestore.clear();
      for (const [key, item] of retained) if (!borrowed.has(key)) item.display.destroy({ children: item.kind === "glyph" });
      for (const state of borrowed.values()) {
        state.display.setFromMatrix(state.matrix);
        state.display.alpha = state.alpha; state.display.tint = state.tint;
        state.display.blendMode = state.blendMode; state.display.mask = state.mask;
        if (state.parent) state.parent.addChildAt(state.display, Math.min(state.index, state.parent.children.length));
        else state.display.parent?.removeChild(state.display);
      }
      for (const [key, texture] of frameTextures) if (!oldFrames.has(key)) texture.destroy(false);
      nextRoot.destroy({ children: false });
      borrowed.clear();
      admissionCachedGroups = null;
      admissionCacheInfo = null;
      root = oldRoot; retained = oldRetained; frameTextures = oldFrames;
      stats.objects = retained.size; stats.scenePresentationFailures++;
      stats.presentationValid = false;
      return { presented: false, reason };
    }
    const objects = new Map<string, SceneObject>();
    for (const state of borrowedGlyphCacheRestore.values()) state.lease?.commit();
    borrowedGlyphCacheRestore.clear();
    for (const item of plan.primitives) {
      const kind = list.kindAt(item.index);
      const display = retained.get(item.id)?.display;
      if (!display) continue;
      let transform: readonly number[] = item.localTransform ?? [1, 0, 0, 1, 0, 0];
      let source: PixiSceneSource<TTexture> | undefined;
      let width: number | undefined, height: number | undefined, flipH: boolean | undefined, flipV: boolean | undefined;
      if (kind === DRAW_QUAD) {
        list.readQuad(item.index, quad); transform = item.localTransform ?? Array.from(quad.m);
        source = { texture: list.textureAt(item.index), x: quad.srcX, y: quad.srcY, w: quad.srcW, h: quad.srcH };
        width = quad.w; height = quad.h; flipH = quad.flipH; flipV = quad.flipV;
      } else if (kind === DRAW_NINE_PATCH) {
        list.readNinePatch(item.index, nine); transform = item.localTransform ?? Array.from(nine.m);
        source = { texture: list.textureAt(item.index), x: nine.srcX, y: nine.srcY, w: nine.srcW, h: nine.srcH };
        width = nine.w; height = nine.h; flipH = nine.flipH; flipV = nine.flipV;
      } else if (kind === DRAW_TEXTURED_MESH) {
        list.readTexturedMesh(item.index, mesh); transform = item.localTransform ?? Array.from(mesh.m);
        source = { texture: list.textureAt(item.index), x: 0, y: 0, w: 0, h: 0 };
      }
      objects.set(item.id, { display, kind, parentId: item.parentId, transform, alpha: display.alpha,
        tint: display.tint as number, source, width, height, flipH, flipV });
    }
    for (const record of texts) {
      const id = `text:${record.key}`, display = retained.get(id)?.display;
      if (display) objects.set(id, { display, kind: "text", parentId: record.parentId,
        transform: record.localTransform ?? record.transform, alpha: display.alpha, tint: display.tint as number });
    }
    sceneObjects = objects;
    sceneGroups = new Map(groups.map((group) => [group.id, retained.get(`group:${group.id}`)!.display]));
    sceneGroupStates = new Map(groups.map((group) => [group.id, { transform: group.transform, alpha: group.alpha ?? 1 }]));
    sceneCachedGroups = admissionCachedGroups;
    admissionCachedGroups = null;
    sceneCacheInfo = admissionCacheInfo;
    admissionCacheInfo = null;
    sceneCachedPixels = 0;
    for (const info of sceneCacheInfo?.values() ?? []) sceneCachedPixels += info.pixels;
    sceneCachePending = [];
    sceneCacheQueued = new Set(); sceneCacheCursor = 0;
    for (const [id, info] of sceneCacheInfo ?? []) if (!info.active) queueCache(id);
    sceneGroupParents = new Map(groups.map((group) => [group.id, group.parentId]));
    sceneLabelOutcomes = candidateLabels;
    sceneGlyphCaches = candidateGlyphCaches;
    sceneGlyphCachedPixels = glyphCachePixels;
    sceneGlyphCachedEntries = glyphCacheEntries;
    sceneGlyphDependents = new Map();
    sceneGlyphPending = []; sceneGlyphQueued = new Set(); sceneGlyphCursor = 0;
    for (const [key, info] of sceneGlyphCaches) {
      let parentId = info.parentId;
      while (parentId) {
        const dependents = sceneGlyphDependents.get(parentId) ?? [];
        dependents.push(key); sceneGlyphDependents.set(parentId, dependents);
        parentId = sceneGroupParents.get(parentId);
      }
      if (!info.active && info.eligible) { sceneGlyphQueued.add(key); sceneGlyphPending.push(key); }
    }
    sceneCacheDependents = new Map();
    for (const cachedId of sceneCacheInfo?.keys() ?? []) {
      let parentId: string | undefined = cachedId;
      while (parentId) {
        const dependents = sceneCacheDependents.get(parentId) ?? [];
        dependents.push(cachedId); sceneCacheDependents.set(parentId, dependents);
        parentId = sceneGroupParents.get(parentId);
      }
    }
    const previousDemand = sceneTextureDemand;
    sceneTextureDemand = textureDemand;
    sceneTextureRefs = new Map(); sceneFrameRefs = new Map();
    for (const entry of objects.values()) if (entry.source?.texture !== null && entry.source?.texture !== undefined) {
      const url = options.textureUrl(entry.source.texture);
      if (!url) continue;
      sceneTextureRefs.set(url, (sceneTextureRefs.get(url) ?? 0) + 1);
      if (entry.kind === DRAW_QUAD || entry.kind === DRAW_NINE_PATCH) {
        const key = `${url}|${entry.source.x},${entry.source.y},${entry.source.w},${entry.source.h}`;
        sceneFrameRefs.set(key, (sceneFrameRefs.get(key) ?? 0) + 1);
      }
    }
    for (const [key, item] of oldRetained) if (!borrowed.has(key)) item.display.destroy({ children: item.kind === "glyph" });
    borrowed.clear();
    for (const [key, texture] of oldFrames) if (frameTextures.get(key) !== texture) texture.destroy(false);
    for (const texture of committedPixelTextures.values()) texture.destroy(true);
    committedPixelTextures.clear();
    if (oldRoot !== app.stage) oldRoot.destroy({ children: false });
    for (const url of previousDemand) if (!textureDemand.has(url) && textureCache.has(url)) {
      textureCache.delete(url); void Assets.unload(url);
    }
    stats.sceneAdmissions++; stats.objects = retained.size;
    for (const key of usedFrameTextures) staleFrameKeys.delete(key);
    wakeGlyphRefinement();
    return { presented: true };
  }

  function patchScene(patch: PixiScenePatch<TTexture>): PixiSceneResult {
    if (!sceneObjects || !sceneGroups || !sceneGroupStates || !sceneCachedGroups || !sceneGroupParents || !sceneCacheInfo)
      return fail("retained scene unavailable");
    if (!contextReady()) return fail("WebGL context lost");
    const requestedGroups = patch.groups ?? [], requestedPrimitives = patch.primitives ?? [];
    const groupChanges: typeof requestedGroups[number][] = [];
    const primitiveChanges: typeof requestedPrimitives[number][] = [];
    const changed = new Set<string>();
    const cacheFactors = new Map<string, number>();
    const dirtyCaches = new Set<string>();
    const dirtyGlyphCaches = new Set<string>();
    const maybeStaticCaches = new Set<string>();
    const markStaticAncestors = (start: string | undefined) => {
      let id = start;
      while (id) {
        if (sceneCacheInfo!.has(id)) maybeStaticCaches.add(id);
        id = sceneGroupParents!.get(id);
      }
    };
    const dirtyAncestors = (parentId: string | undefined) => {
      while (parentId) {
        if (sceneCachedGroups!.has(parentId)) dirtyCaches.add(parentId);
        parentId = sceneGroupParents!.get(parentId);
      }
    };
    for (const update of requestedGroups) {
      if (changed.has(update.id) || !sceneGroups.has(update.id) ||
          (update.transform && !validMatrix(update.transform)) ||
          (update.alpha !== undefined && (!Number.isFinite(update.alpha) || update.alpha < 0 || update.alpha > 1)))
        return fail("invalid group patch");
      changed.add(update.id);
      const oldGroup = sceneGroupStates.get(update.id)!;
      const effectiveTransform = update.transform && !sameMatrix(update.transform, oldGroup.transform)
        ? update.transform : undefined;
      const effectiveAlpha = update.alpha !== undefined && update.alpha !== oldGroup.alpha
        ? update.alpha : undefined;
      if (!effectiveTransform && effectiveAlpha === undefined) continue;
      const effective = { id: update.id, transform: effectiveTransform, alpha: effectiveAlpha };
      groupChanges.push(effective);
      if (effectiveAlpha !== undefined) markStaticAncestors(update.id);
      const oldLinear = oldGroup.transform, nextLinear = effectiveTransform;
      if (effectiveAlpha !== undefined ||
          (nextLinear && singularScale(oldLinear) !== singularScale(nextLinear)))
        for (const key of sceneGlyphDependents.get(update.id) ?? []) dirtyGlyphCaches.add(key);
      if (effectiveTransform && sceneCacheDependents?.has(update.id)) {
        const before = sceneGroupStates.get(update.id)!.transform;
        const oldScale = singularScale(before);
        const newScale = singularScale(effectiveTransform);
        if (oldScale === 0 || !Number.isFinite(newScale)) return fail("invalid cached group scale");
        if (Math.abs(newScale / oldScale - 1) > 0.000001) {
          for (const id of sceneCacheDependents.get(update.id) ?? [])
            cacheFactors.set(id, (cacheFactors.get(id) ?? 1) * newScale / oldScale);
        }
      }
      dirtyAncestors(sceneGroupParents.get(update.id));
    }
    for (const update of requestedPrimitives) {
      const entry = sceneObjects.get(update.id);
      if (changed.has(update.id) || !entry ||
          (update.transform && !validMatrix(update.transform)) ||
          (update.alpha !== undefined && (!Number.isFinite(update.alpha) || update.alpha < 0 || update.alpha > 1)) ||
          (update.tint !== undefined && (!Number.isInteger(update.tint) || update.tint < 0 || update.tint > 0xffffff)))
        return fail("invalid primitive patch");
      if (update.source && entry.kind !== DRAW_QUAD && entry.kind !== DRAW_NINE_PATCH &&
          entry.kind !== DRAW_TEXTURED_MESH)
        return fail("source patch on unsupported primitive");
      if (update.source &&
          (![update.source.x, update.source.y, update.source.w, update.source.h].every(Number.isFinite) ||
            update.source.x < 0 || update.source.y < 0 || update.source.w < 0 || update.source.h < 0 ||
            (entry.kind !== DRAW_TEXTURED_MESH && (update.source.w === 0 || update.source.h === 0))))
        return fail("invalid source rectangle");
      changed.add(update.id);
      const effectiveTransform = update.transform && !sameMatrix(update.transform, entry.transform)
        ? update.transform : undefined;
      const effectiveAlpha = update.alpha !== undefined && update.alpha !== entry.alpha
        ? update.alpha : undefined;
      const effectiveTint = update.tint !== undefined && update.tint !== entry.tint
        ? update.tint : undefined;
      const effectiveSource = update.source && !sameSource(entry.source, update.source)
        ? update.source : undefined;
      if (!effectiveTransform && effectiveAlpha === undefined && effectiveTint === undefined && !effectiveSource) continue;
      primitiveChanges.push({ id: update.id, transform: effectiveTransform, alpha: effectiveAlpha,
        tint: effectiveTint, source: effectiveSource });
      if (effectiveAlpha !== undefined && sceneGlyphCaches.has(update.id))
        markStaticAncestors(entry.parentId);
      if (sceneGlyphCaches.has(update.id) &&
          (effectiveAlpha !== undefined ||
            (effectiveTransform && singularScale(effectiveTransform) !== singularScale(entry.transform))))
        dirtyGlyphCaches.add(update.id);
      dirtyAncestors(entry.parentId);
      if (effectiveSource) {
        const source = effectiveSource;
        if (source.texture !== null) {
          const url = options.textureUrl(source.texture);
          if (!url || textureFor(source.texture) === Texture.WHITE) return fail("source texture pending or failed");
          const base = textureFor(source.texture);
          if (entry.kind !== DRAW_TEXTURED_MESH &&
              (source.x + source.w > base.source.width || source.y + source.h > base.source.height))
            return fail("source rectangle outside texture");
        }
      }
    }
    const cachePlans = new Map<string, { old: CacheInfo; next: CacheInfo }>();
    const oldCachedPixels = sceneCachedPixels;
    let projectedPixels = sceneCachedPixels;
    for (const id of cacheFactors.keys()) {
      const old = sceneCacheInfo.get(id);
      projectedPixels -= old?.pixels ?? 0;
    }
    for (const [id, factor] of cacheFactors) {
      const old = sceneCacheInfo.get(id)!;
      const resolution = old.desiredResolution * factor;
      const ratio = resolution / old.resolution;
      // Keep a cached texture only inside the reuse band. A larger scale
      // change presents analytically first, then refines from the retained tree.
      const active = old.active && Number.isFinite(resolution) && resolution > 0 &&
        ratio >= 0.75 && ratio <= 1.25;
      const next = { ...old, desiredResolution: resolution, resolution: active ? old.resolution : resolution,
        pixels: active ? old.pixels : 0, active };
      projectedPixels += next.pixels;
      cachePlans.set(id, { old, next });
    }
    const undo: (() => void)[] = [];
    const oldGlyphPixels = sceneGlyphCachedPixels, oldGlyphEntries = sceneGlyphCachedEntries;
    const cacheLeases: CacheLease[] = [];
    const glyphDisabled = new Set<string>();
    const staticDisabled = new Set<string>();
    let rollbackDeferred: () => void = () => {};
    let deferredGlyphs: { rollback(): void; commit(): void } = { rollback() {}, commit() {} };
    const oldSources = new Map<string, PixiSceneSource<TTexture> | undefined>();
    const newFrameKeys: string[] = [];
    try {
      cacheBakesThisPresent = cacheBakePixelsThisPresent = 0;
      for (const update of groupChanges) {
        const display = sceneGroups.get(update.id)!;
        const old = sceneGroupStates.get(update.id)!;
        const next = { transform: update.transform ?? old.transform, alpha: update.alpha ?? old.alpha };
        if (next.transform !== old.transform) setMatrix(display, next.transform);
        if (next.alpha !== old.alpha) display.alpha = next.alpha;
        sceneGroupStates.set(update.id, next);
        undo.push(() => { setMatrix(display, old.transform); display.alpha = old.alpha; sceneGroupStates!.set(update.id, old); });
      }
      for (const update of primitiveChanges) {
        const entry = sceneObjects.get(update.id)!;
        const old = { transform: entry.transform, alpha: entry.alpha, tint: entry.tint, source: entry.source };
        if (update.source) oldSources.set(update.id, old.source);
        const source = update.source ?? entry.source;
        const transform = update.transform ?? entry.transform;
        if (update.source && source) {
          const url = source.texture === null ? null : options.textureUrl(source.texture);
          if (url && entry.kind !== DRAW_TEXTURED_MESH) newFrameKeys.push(`${url}|${source.x},${source.y},${source.w},${source.h}`);
          const texture = entry.kind === DRAW_TEXTURED_MESH
            ? textureFor(source.texture)
            : cropped(source.texture, source.x, source.y, source.w, source.h);
          (entry.display as Sprite | NineSliceSprite | Mesh<MeshGeometry>).texture = texture;
          entry.source = source;
        }
        if (transform !== old.transform || update.source) {
          if (entry.kind === DRAW_QUAD && source)
            setMatrix(entry.display, quadMatrix(transform, entry.width!, entry.height!, source.w, source.h, entry.flipH!, entry.flipV!));
          else if (entry.kind === DRAW_NINE_PATCH)
            setMatrix(entry.display, nineMatrix(transform, entry.width!, entry.height!, entry.flipH!, entry.flipV!));
          else setMatrix(entry.display, transform);
          entry.transform = transform;
        }
        if (update.alpha !== undefined && update.alpha !== old.alpha) entry.display.alpha = entry.alpha = update.alpha;
        if (update.tint !== undefined && update.tint !== old.tint) entry.display.tint = entry.tint = update.tint;
        undo.push(() => {
          entry.transform = old.transform; entry.alpha = old.alpha; entry.tint = old.tint; entry.source = old.source;
          if (old.source) (entry.display as Sprite | NineSliceSprite | Mesh<MeshGeometry>).texture =
            entry.kind === DRAW_TEXTURED_MESH ? textureFor(old.source.texture) :
              cropped(old.source.texture, old.source.x, old.source.y, old.source.w, old.source.h);
          if (entry.kind === DRAW_QUAD && old.source)
            setMatrix(entry.display, quadMatrix(old.transform, entry.width!, entry.height!, old.source.w, old.source.h, entry.flipH!, entry.flipV!));
          else if (entry.kind === DRAW_NINE_PATCH)
            setMatrix(entry.display, nineMatrix(old.transform, entry.width!, entry.height!, entry.flipH!, entry.flipV!));
          else setMatrix(entry.display, old.transform);
          entry.display.alpha = old.alpha; entry.display.tint = old.tint;
        });
      }
      for (const [id, plan] of cachePlans) {
        const display = sceneGroups.get(id)!;
        const lease = plan.old.active && !plan.next.active ? suspendCommittedCache(display) : null;
        if (lease) cacheLeases.push(lease);
        sceneCacheInfo.set(id, plan.next);
        if (plan.next.active) sceneCachedGroups.add(id); else sceneCachedGroups.delete(id);
        undo.push(() => {
          lease?.rollback();
          sceneCacheInfo!.set(id, plan.old);
          if (plan.old.active) sceneCachedGroups!.add(id); else sceneCachedGroups!.delete(id);
        });
      }
      for (const key of dirtyGlyphCaches) {
        const info = sceneGlyphCaches.get(key);
        if (!info) continue;
        const old = { ...info };
        const entry = sceneObjects.get(key);
        if (entry) {
          info.ownAlpha = entry.alpha;
          info.localScale = singularScale(entry.transform);
        }
        const desired = glyphCacheResolution(info);
        const ratio = desired / old.resolution;
        if (info.active && (glyphCacheAlpha(info) !== 1 || ratio < 0.75 || ratio > 1.25)) {
          const lease = suspendCommittedCache(info.child);
          if (lease) cacheLeases.push(lease);
          glyphBoundsResolution.set(info.child, 1);
          info.active = false; info.pixels = 0;
          sceneGlyphCachedPixels -= old.pixels; sceneGlyphCachedEntries--;
          glyphDisabled.add(key);
          undo.push(() => { lease?.rollback(); glyphBoundsResolution.set(info.child, old.resolution);
            Object.assign(info, old); });
        } else {
          undo.push(() => Object.assign(info, old));
        }
      }
      for (const id of new Set([...maybeStaticCaches, ...dirtyCaches])) {
        const old = sceneCacheInfo.get(id);
        if (!old?.active || (!dirtyCaches.has(id) && staticCacheEligible(id))) continue;
        const lease = suspendCommittedCache(sceneGroups.get(id)!);
        if (lease) cacheLeases.push(lease);
        sceneCacheInfo.set(id, { ...old, active: false, pixels: 0 });
        sceneCachedGroups.delete(id);
        projectedPixels -= old.pixels;
        staticDisabled.add(id);
        undo.push(() => {
          lease?.rollback();
          sceneCacheInfo!.set(id, old); sceneCachedGroups!.add(id);
        });
      }
      sceneCachedPixels = projectedPixels;
      rollbackDeferred = prepareDeferredCaches(new Set([...dirtyCaches, ...cachePlans.keys(), ...staticDisabled]));
      deferredGlyphs = prepareDeferredGlyphCaches(dirtyGlyphCaches, true);
      const drew = submitPixi(options.diagnostics?.mode === "commands"
        ? [...dirtyCaches, ...dirtyGlyphCaches] : []);
      if (!contextReady()) throw new Error("WebGL context lost");
      for (const key of glyphDisabled) {
        const info = sceneGlyphCaches.get(key);
        if (info) { transitionGlyphOutcome(info, false); if (info.eligible) queueGlyphCache(key); }
      }
      for (const id of staticDisabled) queueCache(id);
      stats.frames++; markDraw(drew); stats.scenePatches++;
      stats.sceneChangedObjects += groupChanges.length + primitiveChanges.length;
      for (const [id, plan] of cachePlans) if (!plan.next.active) queueCache(id);
      for (const update of primitiveChanges) if (update.source) {
        const entry = sceneObjects.get(update.id)!;
        const oldSource = oldSources.get(update.id);
        const newSource = entry.source;
        const oldUrl = oldSource?.texture == null ? null : options.textureUrl(oldSource.texture);
        const newUrl = newSource?.texture == null ? null : options.textureUrl(newSource.texture);
        if (oldUrl !== newUrl) {
          if (newUrl) { sceneTextureRefs.set(newUrl, (sceneTextureRefs.get(newUrl) ?? 0) + 1); sceneTextureDemand.add(newUrl); }
          if (oldUrl) {
            const remaining = (sceneTextureRefs.get(oldUrl) ?? 1) - 1;
            if (remaining > 0) sceneTextureRefs.set(oldUrl, remaining);
            else {
              sceneTextureRefs.delete(oldUrl); sceneTextureDemand.delete(oldUrl);
              if (textureCache.delete(oldUrl)) void Assets.unload(oldUrl);
            }
          }
        }
        if (entry.kind === DRAW_QUAD || entry.kind === DRAW_NINE_PATCH) {
          const oldKey = oldUrl && oldSource ? `${oldUrl}|${oldSource.x},${oldSource.y},${oldSource.w},${oldSource.h}` : null;
          const newKey = newUrl && newSource ? `${newUrl}|${newSource.x},${newSource.y},${newSource.w},${newSource.h}` : null;
          if (oldKey !== newKey) {
            if (newKey) sceneFrameRefs.set(newKey, (sceneFrameRefs.get(newKey) ?? 0) + 1);
            if (oldKey) {
              const remaining = (sceneFrameRefs.get(oldKey) ?? 1) - 1;
              if (remaining > 0) sceneFrameRefs.set(oldKey, remaining);
              else {
                sceneFrameRefs.delete(oldKey);
                frameTextures.get(oldKey)?.destroy(false); frameTextures.delete(oldKey);
              }
            }
          }
        }
      }
      stats.frameTextures = frameTextures.size;
      stats.textures = textureCache.size + pixelTextures.size;
      deferredGlyphs.commit();
      for (const lease of cacheLeases) lease.commit();
      try { wakeGlyphRefinement(); } catch { /* wake is advisory after committed presentation */ }
      return { presented: true };
    } catch (error) {
      deferredGlyphs.rollback();
      rollbackDeferred();
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
      sceneCachedPixels = oldCachedPixels;
      sceneGlyphCachedPixels = oldGlyphPixels; sceneGlyphCachedEntries = oldGlyphEntries;
      cacheBakesThisPresent = cacheBakePixelsThisPresent = 0;
      for (const key of newFrameKeys) if (!sceneFrameRefs.has(key)) {
        frameTextures.get(key)?.destroy(false); frameTextures.delete(key);
      }
      stats.scenePresentationFailures++;
      stats.presentationValid = false;
      try { submitPixi(); } catch { /* the last valid scene stays retained for retry */ }
      return { presented: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    app, stats,
    prefetch(texture) { textureFor(texture); },
    bindPixelTexture(texture, source, revision) {
      const key = options.textureUrl(texture);
      if (!key) throw new Error("Pixel texture requires a stable texture key");
      const old = pixelTextures.get(key);
      if (old?.revision === revision) return;
      skipGlArmed = false;
      diagnosticQuadArmed = false;
      if (old) {
        if (sceneTextureDemand.has(key)) {
          // Keep the source used by the last presented frame intact. A later
          // failed admission must still be able to replay exactly that frame.
          if (committedPixelTextures.has(key)) old.texture.destroy(true);
          else committedPixelTextures.set(key, old.texture);
          pixelTextures.set(key, { texture: new Texture({ source: new CanvasSource({ resource: source }) }), revision });
        } else {
          old.texture.source.resource = source;
          old.texture.source.update();
          old.revision = revision;
        }
      } else {
        pixelTextures.set(key, { texture: new Texture({ source: new CanvasSource({ resource: source }) }), revision });
      }
      if (sceneTextureDemand.has(key)) {
        sceneObjects = null;
        for (const frameKey of frameTextures.keys()) if (frameKey.startsWith(`${key}|`)) staleFrameKeys.add(frameKey);
      }
      else for (const [frameKey, frame] of frameTextures) if (frameKey.startsWith(`${key}|`)) {
        frame.destroy(false); frameTextures.delete(frameKey);
      }
      stats.textures = textureCache.size + pixelTextures.size;
    },
    textureSize(texture) {
      const url = options.textureUrl(texture); if (!url) return null;
      const source = pixelTextures.get(url)?.texture.source ?? textureCache.get(url)?.source;
      return source ? { width: source.width, height: source.height } : null;
    },
    textureFailureDetails() { return [...textureFailureReasons].map(([url, reason]) => `${url}: ${reason}`); },
    textOutcomes() { return committedTextOutcomes; },
    armDiagnosticSkipGl() {
      if (options.diagnosticSubmitMode !== "skip-gl" || !stats.presentationValid ||
          stats.completedFrames === 0 || !contextReady() || pendingTextures.size !== 0 ||
          failedTextures.size !== 0) return false;
      skipGlArmed = true;
      return true;
    },
    armDiagnosticSingleQuad() {
      if (options.diagnosticSubmitMode !== "single-quad" || !stats.presentationValid ||
          stats.completedFrames === 0 || !contextReady() || pendingTextures.size !== 0 ||
          failedTextures.size !== 0) return false;
      diagnosticQuadArmed = true;
      return true;
    },
    pollDiagnostics() { diagnostics?.poll(); },
    resize(width, height, resolution = options.resolution ?? 1, nextDesignWidth = width, nextDesignHeight = height) {
      skipGlArmed = false;
      diagnosticQuadArmed = false;
      viewWidth = width; viewHeight = height; viewResolution = resolution;
      stats.presentationValid = false;
      designWidth = nextDesignWidth; designHeight = nextDesignHeight;
      // A resize changes projected cache resolution; the next retained update
      // must admit a fresh tree before it can publish another scene frame.
      sceneObjects = null;
      app.renderer.resolution = resolution; app.renderer.resize(width, height);
      root.scale.set(width / Math.max(1, designWidth), height / Math.max(1, designHeight));
    },
    render(list, text) {
      sceneObjects = null; sceneGroups = null; sceneGroupStates = null;
      sceneCachedGroups = null; sceneGroupParents = null; sceneCacheDependents = null;
      sceneTextureDemand.clear(); sceneTextureRefs.clear(); sceneFrameRefs.clear();
      sceneGlyphCaches.clear(); sceneGlyphDependents.clear(); sceneGlyphPending = []; sceneGlyphQueued.clear();
      sceneGlyphCachedPixels = sceneGlyphCachedEntries = 0;
      const completed = render(list, text);
      if (completed) {
        for (const texture of committedPixelTextures.values()) texture.destroy(true);
        committedPixelTextures.clear();
      }
      return completed;
    },
    admitScene,
    patchScene,
    presentScene,
    dispose() {
      if (disposed) return; disposed = true;
      diagnostics?.dispose();
      glyphProvider?.dispose();
      options.canvas.removeEventListener("webglcontextlost", onContextLost);
      options.canvas.removeEventListener("webglcontextrestored", onContextRestored);
      for (const value of retained.values()) value.display.destroy({ children: value.kind === "glyph" });
      retained.clear(); for (const texture of frameTextures.values()) texture.destroy(false); frameTextures.clear();
      for (const value of pixelTextures.values()) value.texture.destroy(true); pixelTextures.clear();
      for (const texture of committedPixelTextures.values()) texture.destroy(true); committedPixelTextures.clear();
      void Assets.unload([...textureCache.keys()]); textureCache.clear();
      if (root !== app.stage) root.destroy({ children: false });
      diagnosticQuadRoot?.destroy({ children: true });
      app.destroy(false, { children: true, texture: false, textureSource: false });
    },
  };
}
