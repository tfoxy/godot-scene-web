/** Scene/2 serializer for the Rust WebGL renderer. Pixel uploads remain caller-owned. */

import {
  BLEND_ADD,
  createClipRectView,
  createNinePatchView,
  createQuadView,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_NINE_PATCH,
  DRAW_QUAD,
  type DrawList,
  type QuadView,
} from "./draw-list";

/** Structural records supplied by a scene planner; no Pixi runtime is required. */
export interface PixiTextRecord {
  readonly key: string;
  readonly insertionIndex: number;
  readonly transform: readonly number[];
  readonly alpha?: number;
  readonly parentId?: string;
  readonly localTransform?: readonly number[];
}
export interface PixiScenePlan {
  readonly primitives: readonly {
    readonly id: string;
    readonly index: number;
    readonly parentId?: string;
    readonly localTransform?: readonly number[];
  }[];
  readonly groups?: readonly {
    readonly id: string;
    readonly parentId?: string;
    readonly firstIndex: number;
    readonly endIndex: number;
    readonly transform: readonly number[];
    readonly alpha?: number;
  }[];
}
type PlanGroup = NonNullable<PixiScenePlan["groups"]>[number];

export interface RustProfileScope {
  collector: { span<T>(identity: unknown, kind: string, action: () => T): T };
  identity: unknown;
}

export interface RustResource {
  key: string;
  width: number;
  height: number;
}
export interface RustBitmapTextCarrier {
  /** Optional discriminator keeps legacy Bitmap carriers and their emitted bytes unchanged. */
  kind?: "bitmap";
  resource: RustResource;
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Local to the record parent, with raster padding already applied. */
  transform: readonly number[];
  alpha?: number;
}
export interface RustGlyphTextCarrier {
  kind: "glyphs";
  /** Slug has a distinct blob resource and pipeline; only atlas methods use this carrier. */
  method: "msdf" | "sdf";
  atlas: RustResource;
  glyphs: readonly {
    src: readonly [number, number, number, number];
    dst: readonly [number, number, number, number];
  }[];
  transform: readonly number[];
  fill: readonly [number, number, number, number];
  outline?: { color: readonly [number, number, number, number]; width: number };
  shadow?: {
    color: readonly [number, number, number, number];
    offset: readonly [number, number];
  };
  pxRange: number;
  alpha?: number;
}
export type RustTextCarrier = RustBitmapTextCarrier | RustGlyphTextCarrier;
export interface RustSceneInput<T> {
  profile?: RustProfileScope;
  drawList: DrawList<T>;
  revision: number;
  /** Backing surface width/height in physical pixels. */
  width: number;
  height: number;
  /** DrawList/text/clip coordinate space. */
  designWidth: number;
  designHeight: number;
  resolveTexture(texture: T): RustResource | null;
  texts?: readonly PixiTextRecord[];
  resolveText?(record: PixiTextRecord): RustTextCarrier | null;
  plan?: PixiScenePlan;
  /**
   * Opt into the allocation-reduced encode paths (shared identity, a
   * precomputed group-at-index table, one `Array.from` per primitive instead
   * of several). Byte-identical output to the default path; see
   * `rust-prototype-scene.test.ts` for the parity proof. Off by default so
   * existing callers keep today's exact code path.
   */
  fast?: boolean;
}
export interface RustEncodedScene {
  bytes: Uint8Array;
  /** Typed form retained by the adapter so patches do not parse scene/2 JSON back into objects. */
  scene: RustSceneSnapshot;
  resources: RustResource[];
  textUploads: readonly {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }[];
  unsupportedCommands: number;
  /** Drawings omitted from this scene, grouped by the reason they could not be represented. */
  omittedKinds: Record<string, number>;
}
export interface RustSceneSnapshot {
  version: 2;
  revision: number;
  width: number;
  height: number;
  designWidth: number;
  designHeight: number;
  resources: RustResource[];
  commands: Record<string, unknown>[];
}
const encoder = new TextEncoder();
interface RetainedMeta {
  groups: OverlayMap<string, { parentId?: string; transform: readonly number[] }>;
  owners: OverlayMap<
    string,
    {
      parentId?: string;
      local: readonly number[];
      sourceLocal: readonly number[];
    }
  >;
  /** Every emitted clip push, the group its rect was placed through, and its reference placement. */
  clips: readonly RetainedClip[];
}
/**
 * A clip's reference placement: its design-space `rect` while its parent group's world was `world`. Admitted clips
 * also keep their draw-list `local` rect `[x, y, w, h]`, and a group move re-places them exactly as admission does
 * (the current world times the local rect), so the result is the full scene's by construction. A clip placed by an
 * explicit update has no local rect: a group move places it at `rect` plus the change in the world's translation.
 * Either way the placement is recomputed from the reference, never accumulated per patch.
 */
interface RetainedClip {
  id: string;
  parentId?: string;
  rect: readonly number[];
  world: readonly number[];
  local?: readonly number[];
}
const retainedMeta = new WeakMap<RustSceneSnapshot, RetainedMeta>();
const commandIndexes = new WeakMap<RustSceneSnapshot, Map<string, number>>();
function indexCommands(scene: RustSceneSnapshot): Map<string, number> {
  let indexes = commandIndexes.get(scene);
  if (!indexes) {
    indexes = new Map(
      scene.commands.map((command, index) => [String(command.id), index]),
    );
    commandIndexes.set(scene, indexes);
  }
  return indexes;
}
/** The same cached per-scene id -> command-index table `encodeRustRetainedPatch` uses internally. */
export function rustSceneCommandIndex(
  scene: RustSceneSnapshot,
): ReadonlyMap<string, number> {
  return indexCommands(scene);
}

/**
 * Copy-on-write map used by `encodeRustRetainedPatchImpl` for `groups`/`owners`, which a full-scene
 * build sizes to the whole scene (one entry per renderable). `root` is that full map, shared by every
 * patch descending from the scene that built it; `own` holds only the entries this lineage of patches
 * has actually written. Deriving the next generation (`OverlayMap.from`) copies `own` — bounded by the
 * number of distinct keys ever touched since the last full-scene build or compaction, not by the
 * scene's size.
 *
 * That bound only holds if something resets it: a long chain that keeps moving the same handful of
 * groups never grows `own` past that handful, but a chain that touches a new key on every step would
 * otherwise make `own` itself drift towards the root's size, and copying a drifting `own` is back to
 * O(root size) per patch. So once `own.size` passes 1/8 of `root.size`, the next derive compacts
 * instead: it flattens the current view into a fresh, small root (one `Map` built from `entries()`,
 * the same amortized-doubling trick a growable array uses) and starts `own` over empty, keeping the
 * amortized cost per patch at O(patch size) over the whole chain.
 *
 * There is no `delete`: nothing here ever removes a group or an owner, only replaces one (`set`) or
 * adds one that was not there before (a full-scene build, never a patch). Before adding one, note that
 * `Map` moves a key to the end on delete-then-re-add, which `entries()` below does not account for;
 * get that case right (a tombstone set, the way an earlier revision of this file did, is one way) and
 * the doc comment stays true, rather than leaving code that never deletes in to invite later writes
 * through this type to drift from it.
 */
class OverlayMap<K, V> {
  private readonly root: ReadonlyMap<K, V>;
  private readonly own: Map<K, V>;
  private constructor(root: ReadonlyMap<K, V>, own: Iterable<readonly [K, V]>) {
    this.root = root;
    this.own = new Map(own);
  }
  static from<K, V>(
    source: ReadonlyMap<K, V> | OverlayMap<K, V> | undefined,
  ): OverlayMap<K, V> {
    if (source instanceof OverlayMap) {
      if (source.own.size > 0 && source.own.size * 8 > source.root.size)
        return new OverlayMap<K, V>(new Map(source.entries()), []);
      return new OverlayMap<K, V>(source.root, source.own);
    }
    return new OverlayMap<K, V>(source ?? new Map<K, V>(), []);
  }
  get(key: K): V | undefined {
    return this.own.has(key) ? this.own.get(key) : this.root.get(key);
  }
  has(key: K): boolean {
    return this.own.has(key) || this.root.has(key);
  }
  set(key: K, value: V): void {
    this.own.set(key, value);
  }
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
  /**
   * `Map` iteration order exactly: `root`'s own order, with any overridden value swapped in in place
   * (a `set` on a key `root` already has never moves it, matching `Map`), then `own`'s keys that
   * `root` does not have — genuinely new ones — in the order they were added.
   */
  *entries(): IterableIterator<[K, V]> {
    for (const [key, value] of this.root) {
      yield [key, this.own.has(key) ? this.own.get(key)! : value];
    }
    for (const [key, value] of this.own) {
      if (this.root.has(key)) continue;
      yield [key, value];
    }
  }
}

/** `base.resources` is carried by reference through a patch chain (only a text change replaces it), so its
 * key set is computed once per list and reused by every descendant patch that keeps it. */
const resourceKeySets = new WeakMap<RustResource[], ReadonlySet<string>>();
function resourceKeySet(resources: RustResource[]): ReadonlySet<string> {
  let keys = resourceKeySets.get(resources);
  if (!keys) {
    keys = new Set(resources.map((resource) => resource.key));
    resourceKeySets.set(resources, keys);
  }
  return keys;
}

/** The resource a command names (an atlas for a glyph run), or undefined. */
function commandResource(command: Record<string, unknown>): string | undefined {
  const key = command.kind === "glyphRun" ? command.atlas : command.resource;
  return typeof key === "string" ? key : undefined;
}
/**
 * Per scene: how many commands name each resource. Computed on the first text change of a lineage and carried
 * (shared, or copied and adjusted on a key swap) to every descendant patch, so a text tick need not rescan the
 * command list to know whether a replaced key is still drawn.
 */
const resourceUses = new WeakMap<RustSceneSnapshot, ReadonlyMap<string, number>>();
function usesOf(scene: RustSceneSnapshot): ReadonlyMap<string, number> {
  let uses = resourceUses.get(scene);
  if (!uses) {
    const counted = new Map<string, number>();
    for (const command of scene.commands) {
      const key = commandResource(command);
      if (key !== undefined) counted.set(key, (counted.get(key) ?? 0) + 1);
    }
    uses = counted;
    resourceUses.set(scene, uses);
  }
  return uses;
}

const identity = [1, 0, 0, 1, 0, 0] as const;
/**
 * Shared, frozen stand-in for a fresh `[...identity]` copy. Safe only because
 * every reader (`mul`/`inverse`) treats its matrix arguments as read-only and
 * returns a new array; nothing in this module ever writes through a `world()`
 * result. Used by the `fast` encode path only — the default path keeps
 * allocating its own copy per call, unchanged.
 */
const frozenIdentity: number[] = Object.freeze([
  1, 0, 0, 1, 0, 0,
]) as unknown as number[];
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function inverse(m: ArrayLike<number>): number[] | null {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10)
    return null;
  const a = m[3] / determinant,
    b = -m[1] / determinant;
  const c = -m[2] / determinant,
    d = m[0] / determinant;
  return [a, b, c, d, -a * m[4] - c * m[5], -b * m[4] - d * m[5]];
}

/**
 * Precomputes, for every draw-list index, the same winner the default
 * `groupAt(i)` picks via `filter(covers).sort(bySizeAsc)[0]` — smallest
 * range, ties broken by original `plan.groups` order. A stable ascending
 * sort by size keeps tied groups in original order; visiting that order
 * back-to-front and overwriting each covered index means the smallest
 * (earliest, on a tie) group is always the last write, matching
 * `filter().sort()[0]` exactly without re-filtering/re-sorting per index.
 */
function buildGroupIndex(
  groupsList: PixiScenePlan["groups"],
  count: number,
): readonly (PlanGroup | undefined)[] {
  const result: (PlanGroup | undefined)[] = new Array(count);
  if (!groupsList || groupsList.length === 0) return result;
  const sorted = groupsList
    .slice()
    .sort((a, b) => a.endIndex - a.firstIndex - (b.endIndex - b.firstIndex));
  for (let k = sorted.length - 1; k >= 0; k--) {
    const g = sorted[k];
    const start = Math.max(g.firstIndex, 0);
    const end = Math.min(g.endIndex, count);
    for (let i = start; i < end; i++) result[i] = g;
  }
  return result;
}
/**
 * The one caller always overwrites `m`, so `fast=true` skips the copy but keeps the key in place:
 * scene/2 bytes keep the same key order on both paths.
 */
function quadFields(q: QuadView, resource: string | null, fast: boolean) {
  return {
    resource,
    m: fast ? undefined : Array.from(q.m),
    w: q.w,
    h: q.h,
    src: [q.srcX, q.srcY, q.srcW, q.srcH],
    color: [q.r, q.g, q.b, q.a],
    blend:
      q.blend === BLEND_ADD ? "add" : q.blend === 0 ? "mix" : "unsupported",
    flipH: q.flipH,
    flipV: q.flipV,
    colorMatrix: q.hasColorMatrix ? Array.from(q.colorMatrix) : null,
  };
}
function validGlyphRun(carrier: RustGlyphTextCarrier): boolean {
  return carrier.glyphs.length > 0 && carrier.glyphs.length <= 4096;
}
/**
 * One text record's scene/2 command, placed through its parent group's `world`. Shared by full admission and
 * the retained text patch, so a patched label is the command a full build would emit for it, byte for byte.
 */
function textCommand(
  id: string,
  record: PixiTextRecord,
  carrier: RustTextCarrier,
  world: ArrayLike<number>,
): {
  command: Record<string, unknown>;
  resource: RustResource;
  upload?: { key: string; width: number; height: number; pixels: Uint8Array };
} {
  if (carrier.kind === "glyphs")
    return {
      resource: carrier.atlas,
      command: {
        id,
        kind: "glyphRun",
        atlas: carrier.atlas.key,
        m: mul(world, carrier.transform),
        glyphs: carrier.glyphs.map(({ src, dst }) => ({ src, dst })),
        method: carrier.method,
        fill: carrier.fill,
        outline: carrier.outline ?? null,
        shadow: carrier.shadow ?? null,
        pxRange: carrier.pxRange,
        alpha: carrier.alpha ?? record.alpha ?? 1,
      },
    };
  const alpha = carrier.alpha ?? record.alpha ?? 1;
  return {
    resource: carrier.resource,
    upload: {
      key: carrier.resource.key,
      width: carrier.resource.width,
      height: carrier.resource.height,
      pixels: carrier.pixels,
    },
    command: {
      id,
      kind: "rasterText",
      resource: carrier.resource.key,
      m: mul(world, carrier.transform),
      w: carrier.width,
      h: carrier.height,
      src: [0, 0, carrier.resource.width, carrier.resource.height],
      color: [alpha, alpha, alpha, alpha],
      blend: "mix",
      flipH: false,
      flipV: false,
      colorMatrix: null,
    },
  };
}
/** A full command batch. Unsupported drawings are omitted; Rust still validates the resulting scene. */
export function encodeRustScene<T>(input: RustSceneInput<T>): RustEncodedScene {
  return input.profile
    ? input.profile.collector.span(
        input.profile.identity,
        "canvas.serialize",
        () => encodeRustSceneImpl(input),
      )
    : encodeRustSceneImpl(input);
}
function encodeRustSceneImpl<T>({
  profile,
  drawList,
  revision,
  width,
  height,
  designWidth,
  designHeight,
  resolveTexture,
  texts = [],
  resolveText,
  plan,
  fast = false,
}: RustSceneInput<T>): RustEncodedScene {
  const resources = new Map<string, RustResource>();
  const commands: Record<string, unknown>[] = [];
  let unsupportedCommands = 0;
  const omittedKinds: Record<string, number> = {};
  const omit = (kind: string) => {
    unsupportedCommands++;
    omittedKinds[kind] = (omittedKinds[kind] ?? 0) + 1;
  };
  const textUploads: {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }[] = [];
  const textAt = new Map<number, PixiTextRecord[]>();
  for (const text of texts) {
    const row = textAt.get(text.insertionIndex) ?? [];
    row.push(text);
    textAt.set(text.insertionIndex, row);
  }
  const primitives = new Map(plan?.primitives.map((p) => [p.index, p]) ?? []);
  const groups = new Map(plan?.groups?.map((g) => [g.id, g]) ?? []);
  const owners = new Map<
    string,
    {
      parentId?: string;
      local: readonly number[];
      sourceLocal: readonly number[];
    }
  >();
  const clips: RetainedClip[] = [];
  const worldCache = new Map<string, number[]>();
  function world(id: string | undefined, seen = new Set<string>()): number[] {
    if (!id) return fast ? frozenIdentity : [...identity];
    const cached = worldCache.get(id);
    if (cached) return cached;
    if (seen.has(id)) throw new Error(`cyclic group ${id}`);
    const g = groups.get(id);
    if (!g) throw new Error(`missing group ${id}`);
    seen.add(id);
    const m = mul(world(g.parentId, seen), g.transform);
    worldCache.set(id, m);
    seen.delete(id);
    return m;
  }
  const groupIndex = fast
    ? buildGroupIndex(plan?.groups, drawList.count)
    : null;
  const groupAt = fast
    ? (i: number) => groupIndex![i]
    : (i: number) =>
        [...(plan?.groups ?? [])]
          .filter((g) => g.firstIndex <= i && i < g.endIndex)
          .sort(
            (a, b) => a.endIndex - a.firstIndex - (b.endIndex - b.firstIndex),
          )[0];
  const q = createQuadView(),
    n = createNinePatchView(),
    clip = createClipRectView();
  // Mark whole subtrees before emitting anything. A missing clip push with a surviving pop is invalid,
  // and drawing its children without the clip would expose pixels outside the intended region.
  const omitted = new Array<string | null>(drawList.count).fill(null);
  const clipPairs: { push: number; pop: number }[] = [];
  const clipStack: number[] = [];
  for (let i = 0; i < drawList.count; i++) {
    const kind = drawList.kindAt(i);
    if (kind === DRAW_CLIP_PUSH) clipStack.push(i);
    else if (kind === DRAW_CLIP_POP) {
      const push = clipStack.pop();
      if (push !== undefined) clipPairs.push({ push, pop: i });
      else omitted[i] = "unbalancedClip";
    }
  }
  for (const push of clipStack) omitted[push] = "unbalancedClip";
  const markRange = (start: number, end: number, reason: string) => {
    for (let i = start; i <= end; i++) omitted[i] ??= reason;
  };
  const omittedGroups = (plan?.groups ?? []).filter(
    (group) => (group.alpha ?? 1) !== 1,
  );
  const hiddenByGroup = (id: string | undefined): boolean => {
    while (id) {
      if ((groups.get(id)?.alpha ?? 1) !== 1) return true;
      id = groups.get(id)?.parentId;
    }
    return false;
  };
  for (const group of omittedGroups) {
    markRange(group.firstIndex, group.endIndex - 1, "unsupportedGroupAlpha");
  }
  for (const { push, pop } of clipPairs) {
    const primitive = primitives.get(push);
    const parent = primitive?.parentId ?? groupAt(push)?.id;
    drawList.readClipRect(push, clip);
    const m = world(parent);
    if (
      m[0] <= 0 ||
      m[3] <= 0 ||
      Math.abs(m[1]) > 1e-5 ||
      Math.abs(m[2]) > 1e-5 ||
      Math.abs(Math.abs(m[0]) - Math.abs(m[3])) > 1e-5
    ) {
      markRange(push, pop, "unsupportedTransformedClip");
    }
  }
  // The Rust contract admits at most three nested clips. Omitting a deeper clip also omits its
  // children; clips that straddle an omitted interval must be omitted as a unit.
  let sourceDepth = 0;
  for (let i = 0; i < drawList.count; i++) {
    if (drawList.kindAt(i) === DRAW_CLIP_PUSH && ++sourceDepth > 3) {
      const pair = clipPairs.find((candidate) => candidate.push === i);
      if (pair) markRange(i, pair.pop, "clipDepth");
    } else if (drawList.kindAt(i) === DRAW_CLIP_POP) sourceDepth--;
  }
  let expanded: boolean;
  do {
    expanded = false;
    for (const { push, pop } of clipPairs) {
      if (!omitted[push] && !omitted[pop]) continue;
      for (let i = push; i <= pop; i++) {
        if (omitted[i] === null) {
          omitted[i] = "omittedClipContent";
          expanded = true;
        }
      }
    }
  } while (expanded);
  for (let i = 0; i <= drawList.count; i++) {
    for (const record of textAt.get(i) ?? []) {
      const hiddenAtIndex = omittedGroups.some(
        (group) => group.firstIndex <= i && i < group.endIndex,
      );
      if (
        (i < drawList.count && omitted[i]) ||
        hiddenAtIndex ||
        hiddenByGroup(record.parentId)
      ) {
        omit((i < drawList.count && omitted[i]) || "unsupportedGroupAlpha");
        continue;
      }
      const carrier = resolveText?.(record);
      const id = `t${record.key}`;
      if (!carrier) {
        omit("unresolvedText");
        continue;
      }
      if (carrier.kind === "glyphs" && !validGlyphRun(carrier)) {
        omit("invalidGlyphRun");
        continue;
      }
      const text = textCommand(id, record, carrier, world(record.parentId));
      resources.set(text.resource.key, text.resource);
      if (text.upload) textUploads.push(text.upload);
      commands.push(text.command);
      owners.set(id, {
        parentId: record.parentId,
        local: carrier.transform,
        sourceLocal: record.localTransform ?? record.transform,
      });
    }
    if (i === drawList.count) break;
    const omittedReason = omitted[i];
    if (omittedReason) {
      omit(omittedReason);
      continue;
    }
    const kind = drawList.kindAt(i);
    const primitive = primitives.get(i);
    const id = primitive?.id ?? `c${i}`;
    const parent = primitive?.parentId ?? groupAt(i)?.id;
    if (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) {
      const view =
        kind === DRAW_QUAD
          ? drawList.readQuad(i, q)
          : drawList.readNinePatch(i, n);
      const texture = drawList.textureAt(i);
      const resolved = texture === null ? null : resolveTexture(texture);
      if (texture !== null && resolved === null) {
        omit("unresolvedResource");
        continue;
      }
      if (view.blend !== 0 && view.blend !== BLEND_ADD) {
        omit("unsupportedBlend");
        continue;
      }
      if (resolved) resources.set(resolved.key, resolved);
      // The fast path computes the one `Array.from(view.m)` fallback copy
      // once and reuses it for `m`, `local` and `sourceLocal` instead of the
      // default path's three independent computations (one of them —
      // quadFields' own `m` — thrown away the instant it's overwritten
      // below). Byte-identical output either way: `view.m` and an
      // `Array.from` copy of it read the same float64 values through `mul`.
      let payload: Record<string, unknown>;
      if (fast) {
        const localSource = primitive?.localTransform ?? Array.from(view.m);
        payload = {
          id,
          kind: kind === DRAW_QUAD ? "quad" : "ninePatch",
          ...quadFields(view, resolved?.key ?? null, true),
          m: mul(world(parent), localSource),
        };
        owners.set(id, {
          parentId: parent,
          local: localSource,
          sourceLocal: localSource,
        });
      } else {
        payload = {
          id,
          kind: kind === DRAW_QUAD ? "quad" : "ninePatch",
          ...quadFields(view, resolved?.key ?? null, false),
          m: mul(world(parent), primitive?.localTransform ?? view.m),
        };
        owners.set(id, {
          parentId: parent,
          local: primitive?.localTransform ?? Array.from(view.m),
          sourceLocal: primitive?.localTransform ?? Array.from(view.m),
        });
      }
      if (kind === DRAW_NINE_PATCH)
        commands.push({
          ...payload,
          margins: [n.marginLeft, n.marginTop, n.marginRight, n.marginBottom],
        });
      else commands.push(payload);
    } else if (kind === DRAW_CLIP_PUSH) {
      drawList.readClipRect(i, clip);
      const m = world(parent);
      const p = mul(m, [1, 0, 0, 1, clip.x, clip.y]);
      const rect = [p[4], p[5], clip.w * m[0], clip.h * m[3]];
      clips.push({ id, parentId: parent, rect, world: m, local: [clip.x, clip.y, clip.w, clip.h] });
      commands.push({
        id,
        kind: "clipPush",
        rect: [...rect],
        radius: clip.cornerRadius * Math.abs(m[0]),
        outset: clip.outsetX * Math.abs(m[0]),
      });
    } else if (kind === DRAW_CLIP_POP) commands.push({ id, kind: "clipPop" });
    else omit(drawList.kindNameAt(i));
  }
  const scene: RustSceneSnapshot = {
    version: 2,
    revision,
    width,
    height,
    designWidth,
    designHeight,
    resources: [...resources.values()],
    commands,
  };
  retainedMeta.set(scene, {
    groups: OverlayMap.from(
      new Map(
        [...groups].map(([id, group]) => [
          id,
          { parentId: group.parentId, transform: group.transform },
        ]),
      ),
    ),
    owners: OverlayMap.from(owners),
    clips,
  });
  indexCommands(scene);
  let serialized: Uint8Array | undefined;
  return {
    // Most revisions are admitted as patch/1. Delay full scene/2 JSON serialization until admission
    // actually falls back (or the caller asks for a fixture byte snapshot).
    get bytes() {
      serialized ??= profile
        ? profile.collector.span(profile.identity, "canvas.serialize", () =>
            encoder.encode(JSON.stringify(scene)),
          )
        : encoder.encode(JSON.stringify(scene));
      return serialized;
    },
    scene,
    resources: [...resources.values()],
    textUploads,
    unsupportedCommands,
    omittedKinds,
  };
}
/** Pack multiple RGBA8 images into one resource upload call. */
export function encodeRustResources(
  items: readonly {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }[],
  profile?: RustProfileScope,
): Uint8Array {
  return profile
    ? profile.collector.span(profile.identity, "canvas.serialize", () =>
        encodeRustResourcesImpl(items),
      )
    : encodeRustResourcesImpl(items);
}
function encodeRustResourcesImpl(
  items: readonly {
    key: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }[],
): Uint8Array {
  const keys = items.map((i) => encoder.encode(i.key));
  const total =
    8 +
    items.reduce(
      (n, i, index) => n + 16 + keys[index].length + i.pixels.length,
      0,
    );
  const bytes = new Uint8Array(total);
  const data = new DataView(bytes.buffer);
  bytes.set([82, 83, 82, 49]);
  data.setUint32(4, items.length, true);
  let cursor = 8;
  items.forEach((item, index) => {
    if (item.pixels.length !== item.width * item.height * 4)
      throw new Error(`invalid RGBA8 resource ${item.key}`);
    data.setUint32(cursor, keys[index].length, true);
    data.setUint32(cursor + 4, item.width, true);
    data.setUint32(cursor + 8, item.height, true);
    data.setUint32(cursor + 12, item.pixels.length, true);
    cursor += 16;
    bytes.set(keys[index], cursor);
    cursor += keys[index].length;
    bytes.set(item.pixels, cursor);
    cursor += item.pixels.length;
  });
  return bytes;
}

/** RSR2 is for atlas residency: explicit format, subrect write, and release. RSR1 remains byte-identical. */
export type RustResourceUpdate =
  | {
      operation: "allocate";
      key: string;
      width: number;
      height: number;
      format: "srgb" | "linear";
    }
  | {
      operation: "replace";
      key: string;
      width: number;
      height: number;
      format: "srgb" | "linear";
      pixels: Uint8Array;
    }
  | {
      operation: "subrect";
      key: string;
      width: number;
      height: number;
      format: "srgb" | "linear";
      x: number;
      y: number;
      regionWidth: number;
      regionHeight: number;
      pixels: Uint8Array;
    }
  | { operation: "release"; key: string };

export function encodeRustResourceUpdates(
  items: readonly RustResourceUpdate[],
): Uint8Array {
  if (items.length > 4096) throw new Error("too many resource updates");
  const keys = items.map((item) => encoder.encode(item.key));
  const total =
    8 +
    items.reduce(
      (size, item, index) =>
        size +
        36 +
        keys[index].length +
        (item.operation === "release" || item.operation === "allocate"
          ? 0
          : item.pixels.length),
      0,
    );
  const bytes = new Uint8Array(total);
  const data = new DataView(bytes.buffer);
  bytes.set([82, 83, 82, 50]); // RSR2
  data.setUint32(4, items.length, true);
  let cursor = 8;
  items.forEach((item, index) => {
    if (!item.key || keys[index].length > 4096)
      throw new Error("invalid resource key");
    const replace = item.operation === "replace";
    const subrect = item.operation === "subrect";
    const allocate = item.operation === "allocate";
    const width = item.operation === "release" ? 0 : item.width;
    const height = item.operation === "release" ? 0 : item.height;
    const x = subrect ? item.x : 0;
    const y = subrect ? item.y : 0;
    const regionWidth = replace ? width : subrect ? item.regionWidth : 0;
    const regionHeight = replace ? height : subrect ? item.regionHeight : 0;
    const pixels =
      item.operation === "release" || allocate ? undefined : item.pixels;
    if (
      allocate &&
      (!Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1)
    )
      throw new Error(`invalid resource allocation ${item.key}`);
    if (
      item.operation !== "release" &&
      !allocate &&
      (!Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        !Number.isSafeInteger(x) ||
        !Number.isSafeInteger(y) ||
        x < 0 ||
        y < 0 ||
        !Number.isSafeInteger(regionWidth) ||
        !Number.isSafeInteger(regionHeight) ||
        regionWidth < 1 ||
        regionHeight < 1 ||
        x + regionWidth > width ||
        y + regionHeight > height ||
        pixels!.length !== regionWidth * regionHeight * 4)
    )
      throw new Error(`invalid resource region ${item.key}`);
    bytes[cursor] = replace ? 0 : subrect ? 1 : allocate ? 3 : 2;
    bytes[cursor + 1] =
      item.operation === "release" ? 0 : item.format === "linear" ? 1 : 0;
    cursor += 4; // two reserved bytes remain zero
    for (const value of [
      keys[index].length,
      width,
      height,
      x,
      y,
      regionWidth,
      regionHeight,
      pixels?.length ?? 0,
    ]) {
      data.setUint32(cursor, value, true);
      cursor += 4;
    }
    bytes.set(keys[index], cursor);
    cursor += keys[index].length;
    if (pixels) {
      bytes.set(pixels, cursor);
      cursor += pixels.length;
    }
  });
  return bytes;
}

function isJsonSkippedValue(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}
function jsonArrayEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // An array element that would be skipped at object-property position
    // instead serializes as `null` (JSON.stringify never omits an array slot).
    const va = isJsonSkippedValue(a[i]) ? null : a[i];
    const vb = isJsonSkippedValue(b[i]) ? null : b[i];
    if (!jsonValueEqual(va, vb)) return false;
  }
  return true;
}
function jsonObjectEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // Object.keys() already walks own enumerable string keys in the exact
  // order JSON.stringify emits them (integer-like keys ascending first, then
  // insertion order) — filter out keys JSON.stringify would drop, then
  // compare the two key sequences positionally, since reordered keys change
  // the stringified output even when the value set is identical.
  const keysA = Object.keys(a).filter((k) => !isJsonSkippedValue(a[k]));
  const keysB = Object.keys(b).filter((k) => !isJsonSkippedValue(b[k]));
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!jsonValueEqual(a[keysA[i]], b[keysA[i]])) return false;
  }
  return true;
}
function jsonValueEqual(a: unknown, b: unknown): boolean {
  // JSON.stringify collapses NaN/+-Infinity to the literal `null` wherever a
  // number appears — the SAME output a genuine `null` produces — so this
  // normalizes both before comparing rather than only comparing NaN-ness
  // between two numbers (which would miss e.g. NaN vs null: both "null").
  const na = typeof a === "number" && !Number.isFinite(a) ? null : a;
  const nb = typeof b === "number" && !Number.isFinite(b) ? null : b;
  if (na === nb) return true; // covers equal primitives, incl. -0 === 0, null === null, matching references
  if (Array.isArray(na) && Array.isArray(nb)) return jsonArrayEqual(na, nb);
  if (
    na !== null &&
    nb !== null &&
    typeof na === "object" &&
    typeof nb === "object" &&
    !Array.isArray(na) &&
    !Array.isArray(nb)
  )
    return jsonObjectEqual(
      na as Record<string, unknown>,
      nb as Record<string, unknown>,
    );
  return false;
}
/**
 * `jsonEqual(a, b) === (JSON.stringify(a) === JSON.stringify(b))` for every
 * shape this module's encoders emit: plain objects and arrays nesting only
 * numbers, strings, booleans, null, undefined, and other such objects/arrays.
 * It does not call `toJSON` — no command this module ever produces defines
 * one (no `Date`, `Map`, `Set`, or typed array ever lands in a `commands`
 * entry) — so a `toJSON`-bearing value is an unsupported, documented
 * divergence, asserted in `rust-prototype-scene.test.ts` rather than handled
 * here; adding it would reintroduce the `JSON.stringify` cost this exists to
 * avoid.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  const skipA = isJsonSkippedValue(a);
  const skipB = isJsonSkippedValue(b);
  if (skipA || skipB) return skipA && skipB;
  return jsonValueEqual(a, b);
}

/** Encode one atomic same-shape patch; return null when the caller must admit a full scene. */
export function encodeRustPatch(
  a: RustSceneSnapshot,
  b: RustSceneSnapshot,
  profile?: RustProfileScope,
  options?: { fast?: boolean },
): Uint8Array | null {
  return profile
    ? profile.collector.span(profile.identity, "canvas.serialize", () =>
        encodeRustPatchImpl(a, b, options),
      )
    : encodeRustPatchImpl(a, b, options);
}
function encodeRustPatchImpl(
  a: RustSceneSnapshot,
  b: RustSceneSnapshot,
  options?: { fast?: boolean },
): Uint8Array | null {
  if (
    a.version !== 2 ||
    b.version !== 2 ||
    !Number.isSafeInteger(a.revision) ||
    !Number.isSafeInteger(b.revision) ||
    b.revision <= a.revision ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.designWidth !== b.designWidth ||
    a.designHeight !== b.designHeight ||
    a.resources.length !== b.resources.length ||
    a.resources.some((resource, index) => {
      const nextResource = b.resources[index];
      return (
        resource.key !== nextResource.key ||
        resource.width !== nextResource.width ||
        resource.height !== nextResource.height
      );
    }) ||
    a.commands.length !== b.commands.length
  )
    return null;
  const updates = [];
  for (let i = 0; i < a.commands.length; i++) {
    const old = a.commands[i],
      command = b.commands[i];
    if (old.id !== command.id || old.kind !== command.kind) return null;
    const changed =
      old !== command &&
      (options?.fast
        ? !jsonEqual(old, command)
        : JSON.stringify(old) !== JSON.stringify(command));
    if (changed) updates.push({ id: command.id, command });
  }
  return encoder.encode(
    JSON.stringify({
      version: 1,
      baseRevision: a.revision,
      revision: b.revision,
      updates,
    }),
  );
}

/**
 * The rect of a `clipPush` replacement that only translates `previous`, or null. Width, height, radius and
 * outset must be unchanged and the new origin finite.
 */
function translatedClipRect(
  previous: Record<string, unknown>,
  command: Record<string, unknown>,
): number[] | null {
  const before = previous.rect,
    after = command.rect;
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.length !== 4 ||
    after.length !== 4 ||
    after[2] !== before[2] ||
    after[3] !== before[3] ||
    command.radius !== previous.radius ||
    command.outset !== previous.outset ||
    !Number.isFinite(after[0]) ||
    !Number.isFinite(after[1])
  )
    return null;
  return [after[0], after[1], before[2], before[3]];
}

/** `encodeRustRetainedPatch` accepts `options.texts` (a retained text change); a caller can probe this. */
export const RUST_RETAINED_TEXT_PATCH = true;

/** A text record whose label changed, with the carrier the caller prepared for it (the full build's resolver). */
export interface RustRetainedTextChange {
  record: PixiTextRecord;
  carrier: RustTextCarrier;
}

/**
 * Encode changed commands directly from a retained scene, without a draw-list or scene diff.
 *
 * `options.texts` replaces text commands with the command a full build emits for each record and carrier, placed
 * through the record's (possibly just moved) parent group. The record must name the text command's id, its parent
 * group and its kind (raster or glyph run) as admitted. A raster change may name a new resource: the patch then
 * carries the scene's next resource list, in full-build order, and `textUploads` lists the pixels the caller must
 * upload before applying it. Only a renderer that accepts patch resources (`patch_resources`) may be sent one.
 *
 * A clip moves by translation only. An update may replace a `clipPush` whose rect keeps its size, radius and
 * outset (its origin moves), and a group transform change carries every clip placed through that group along
 * when the group's world moved by a pure translation. Any other clip change returns null, as before.
 */
export function encodeRustRetainedPatch(
  base: RustSceneSnapshot,
  revision: number,
  updates: readonly {
    id: string;
    command: Record<string, unknown>;
    localTransform?: readonly number[];
  }[],
  groupTransforms: readonly { id: string; transform: readonly number[] }[] = [],
  profile?: RustProfileScope,
  options?: { texts?: readonly RustRetainedTextChange[] },
): ReturnType<typeof encodeRustRetainedPatchImpl> {
  return profile
    ? profile.collector.span(profile.identity, "canvas.serialize", () =>
        encodeRustRetainedPatchImpl(base, revision, updates, groupTransforms, options),
      )
    : encodeRustRetainedPatchImpl(base, revision, updates, groupTransforms, options);
}
function encodeRustRetainedPatchImpl(
  base: RustSceneSnapshot,
  revision: number,
  updates: readonly {
    id: string;
    command: Record<string, unknown>;
    localTransform?: readonly number[];
  }[],
  groupTransforms: readonly { id: string; transform: readonly number[] }[] = [],
  options?: { texts?: readonly RustRetainedTextChange[] },
): {
  bytes: Uint8Array;
  scene: RustSceneSnapshot;
  /** Commands replaced by this patch, in patch update order. */
  changedIndexes: readonly number[];
  /** Raster pixels the patched texts draw; the caller uploads the ones not yet resident before applying. */
  textUploads: readonly { key: string; width: number; height: number; pixels: Uint8Array }[];
  /** Whether the patch carries a new resource list (only a text change can). */
  resourcesChanged: boolean;
} | null {
  if (
    base.version !== 2 ||
    !Number.isSafeInteger(base.revision) ||
    !Number.isSafeInteger(revision) ||
    revision <= base.revision
  )
    return null;
  const indexes = indexCommands(base);
  const resources = resourceKeySet(base.resources);
  const seen = new Set<string>();
  const meta = retainedMeta.get(base);
  if (groupTransforms.length && !meta) return null;
  const groups = OverlayMap.from(meta?.groups);
  const owners = OverlayMap.from(meta?.owners);
  for (const change of groupTransforms) {
    const group = groups.get(change.id);
    if (
      !group ||
      change.transform.length !== 6 ||
      !change.transform.every(Number.isFinite)
    )
      return null;
    groups.set(change.id, { ...group, transform: change.transform });
  }
  const staged = new Map<string, Record<string, unknown>>();
  function groupWorld(
    id: string | undefined,
    source: OverlayMap<string, { parentId?: string; transform: readonly number[] }>,
  ): number[] {
    if (!id) return [...identity];
    const group = source.get(id);
    if (!group) throw new Error(`missing group ${id}`);
    return mul(groupWorld(group.parentId, source), group.transform);
  }
  function affected(id: string | undefined, changed: Set<string>): boolean {
    while (id) {
      if (changed.has(id)) return true;
      id = groups.get(id)?.parentId;
    }
    return false;
  }
  const changed = new Set(groupTransforms.map((change) => change.id));
  // Clip references this patch replaces with an explicit update; such a clip ignores its group's move.
  const clipReferences = meta ? new Map(meta.clips.map((clip) => [clip.id, clip])) : null;
  const explicitClips = new Set<string>();
  for (const { id, command, localTransform } of updates) {
    if (seen.has(id)) return null;
    seen.add(id);
    const index = indexes.get(id);
    if (index === undefined) return null;
    const previous = base.commands[index];
    if (command.kind === "clipPush" && previous.kind === "clipPush") {
      // A clip moves only by translation: its size, radius and outset are the clip's own.
      const rect = translatedClipRect(previous, command);
      if (command.id !== id || localTransform !== undefined || !rect)
        return null;
      staged.set(id, { ...previous, rect });
      explicitClips.add(id);
      const reference = clipReferences?.get(id);
      if (reference)
        clipReferences!.set(id, {
          id,
          parentId: reference.parentId,
          rect,
          world: groupWorld(reference.parentId, groups),
        });
      continue;
    }
    const resource =
      command.kind === "glyphRun" ? command.atlas : command.resource;
    const previousResource =
      previous.kind === "glyphRun" ? previous.atlas : previous.resource;
    if (
      command.id !== id ||
      command.kind !== previous.kind ||
      resource !== previousResource ||
      command.blend !== previous.blend ||
      command.kind === "clipPush" ||
      command.kind === "clipPop" ||
      !["quad", "ninePatch", "rasterText", "glyphRun", "stillImage"].includes(
        String(command.kind),
      ) ||
      (resource !== null &&
        (typeof resource !== "string" || !resources.has(resource)))
    )
      return null;
    const owner = owners.get(id);
    if (localTransform !== undefined) {
      if (
        !owner ||
        localTransform.length !== 6 ||
        !localTransform.every(Number.isFinite)
      )
        return null;
      const undoSource = inverse(owner.sourceLocal);
      if (!undoSource) return null;
      const carrierInset = mul(undoSource, owner.local);
      const nextLocal = mul(localTransform, carrierInset);
      owners.set(id, {
        ...owner,
        local: nextLocal,
        sourceLocal: localTransform,
      });
      staged.set(id, {
        ...command,
        m: mul(groupWorld(owner.parentId, groups), nextLocal),
      });
    } else {
      staged.set(id, command);
    }
    if (
      localTransform === undefined &&
      owner &&
      Array.isArray(command.m) &&
      command.m.length === 6
    ) {
      const oldWorld = groupWorld(owner.parentId, meta!.groups);
      const undo = inverse(oldWorld);
      if (!undo) return null;
      owners.set(id, { ...owner, local: mul(undo, command.m as number[]) });
    }
  }
  const texts = options?.texts ?? [];
  if (texts.length && !meta) return null;
  const textUploads: { key: string; width: number; height: number; pixels: Uint8Array }[] = [];
  const textResources = new Map<string, RustResource>();
  for (const { record, carrier } of texts) {
    const id = `t${record.key}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const index = indexes.get(id);
    const owner = owners.get(id);
    if (index === undefined || !owner || owner.parentId !== record.parentId) return null;
    const previous = base.commands[index];
    if (previous.kind !== (carrier.kind === "glyphs" ? "glyphRun" : "rasterText")) return null;
    if (carrier.kind === "glyphs" && !validGlyphRun(carrier)) return null;
    const text = textCommand(id, record, carrier, groupWorld(record.parentId, groups));
    const known = textResources.get(text.resource.key);
    if (known && (known.width !== text.resource.width || known.height !== text.resource.height)) return null;
    textResources.set(text.resource.key, text.resource);
    if (text.upload) textUploads.push(text.upload);
    staged.set(id, text.command);
    owners.set(id, {
      parentId: record.parentId,
      local: carrier.transform,
      sourceLocal: record.localTransform ?? record.transform,
    });
  }
  if (groupTransforms.length && meta) {
    // A clip under a moved group follows it only when the group's world moved by a pure translation; any
    // change to the linear part would rescale or rotate the clip, which a full admission must judge.
    // The linear check covers every clip under a moved group, an explicitly updated one included: its group
    // would otherwise scale or rotate the clipped content but not the clip. An explicit update then wins over the
    // group's translation.
    for (const clip of meta.clips) {
      if (!affected(clip.parentId, changed)) continue;
      const after = groupWorld(clip.parentId, groups);
      if (
        clip.world[0] !== after[0] ||
        clip.world[1] !== after[1] ||
        clip.world[2] !== after[2] ||
        clip.world[3] !== after[3]
      )
        return null;
      if (explicitClips.has(clip.id)) continue;
      let next: number[];
      if (clip.local) {
        const p = mul(after, [1, 0, 0, 1, clip.local[0], clip.local[1]]);
        next = [p[4], p[5], clip.local[2] * after[0], clip.local[3] * after[3]];
      } else {
        next = [
          clip.rect[0] + (after[4] - clip.world[4]),
          clip.rect[1] + (after[5] - clip.world[5]),
          clip.rect[2],
          clip.rect[3],
        ];
      }
      if (!next.every(Number.isFinite)) return null;
      const index = indexes.get(clip.id);
      if (index === undefined) return null;
      const command = base.commands[index];
      const rect = command.rect;
      if (command.kind !== "clipPush" || !Array.isArray(rect) || rect.length !== 4)
        return null;
      if (rect.every((value, i) => value === next[i])) continue;
      staged.set(clip.id, { ...command, rect: next });
    }
    for (const [id, owner] of owners) {
      if (!affected(owner.parentId, changed)) continue;
      const index = indexes.get(id);
      if (index === undefined) return null;
      const command = staged.get(id) ?? base.commands[index];
      staged.set(id, {
        ...command,
        m: mul(groupWorld(owner.parentId, groups), owner.local),
      });
    }
  }
  // A per-patch `Proxy` overlay was tried here and reverted: its `get` trap (a regex plus a `Map`
  // lookup per property access, `.length` included) is cheap next to the `slice()` it replaces
  // (~2.5us at 3,000 commands) but expensive next to what consumers actually do with the result —
  // iterating or filtering the whole `commands` array, which every `get` now routes through the trap.
  // A plain sliced array is the right tradeoff: the real per-patch cost was the `groups`/`owners`
  // map copies above, which `OverlayMap` fixes without changing what `commands` is.
  const nextCommands = base.commands.slice();
  const changedIndexes: number[] = [];
  for (const [id, command] of staged) {
    const index = indexes.get(id)!;
    nextCommands[index] = command;
    changedIndexes.push(index);
  }
  // A text change can name a resource the base does not list (and stop naming one it does): the next list is the
  // one a full build makes, every named resource in first-use order. The common tick swaps a key only that label
  // draws for one no command draws yet, which a full build places where the old key was: replaced in place, with
  // the per-key use counts telling whether that holds. Anything else recomputes the order from the commands.
  let nextResources = base.resources;
  let nextUses: ReadonlyMap<string, number> | undefined = resourceUses.get(base);
  if (textResources.size) {
    const listed = new Map(base.resources.map((resource, index) => [resource.key, index]));
    for (const [key, resource] of textResources) {
      const at = listed.get(key);
      const known = at === undefined ? undefined : base.resources[at];
      if (known && (known.width !== resource.width || known.height !== resource.height)) return null;
    }
    const swaps: [string, string][] = [];
    for (const [id, command] of staged) {
      const before = commandResource(base.commands[indexes.get(id)!]), after = commandResource(command);
      if (before !== after) {
        if (before === undefined || after === undefined) return null;
        swaps.push([before, after]);
      }
    }
    if (swaps.length) {
      const uses = new Map(usesOf(base));
      let inPlace = true;
      const next = base.resources.slice();
      for (const [before, after] of swaps) {
        const at = listed.get(before);
        if (uses.get(before) !== 1 || (uses.get(after) ?? 0) !== 0 || listed.has(after) || at === undefined)
          inPlace = false;
        else {
          next[at] = textResources.get(after)!;
          listed.delete(before);
          listed.set(after, at);
        }
        uses.set(before, (uses.get(before) ?? 1) - 1);
        if (!uses.get(before)) uses.delete(before);
        uses.set(after, (uses.get(after) ?? 0) + 1);
      }
      nextUses = uses;
      if (inPlace) nextResources = next;
      else {
        const sizes = new Map(base.resources.map((resource) => [resource.key, resource]));
        for (const [key, resource] of textResources) if (!sizes.has(key)) sizes.set(key, resource);
        const ordered = new Map<string, RustResource>();
        for (const command of nextCommands) {
          const key = commandResource(command);
          if (key === undefined || ordered.has(key)) continue;
          const resource = sizes.get(key);
          if (!resource) return null;
          ordered.set(key, resource);
        }
        const next = [...ordered.values()];
        const same = next.length === base.resources.length && next.every((resource, i) =>
          resource.key === base.resources[i].key && resource.width === base.resources[i].width &&
          resource.height === base.resources[i].height);
        if (!same) nextResources = next;
      }
    }
  }
  const resourcesChanged = nextResources !== base.resources;
  const scene: RustSceneSnapshot = {
    ...base,
    revision,
    commands: nextCommands,
    resources: nextResources,
  };
  commandIndexes.set(scene, indexes);
  if (nextUses) resourceUses.set(scene, nextUses);
  if (meta)
    retainedMeta.set(scene, {
      groups,
      owners,
      clips: explicitClips.size ? [...clipReferences!.values()] : meta.clips,
    });
  return {
    bytes: encoder.encode(
      JSON.stringify({
        version: 1,
        baseRevision: base.revision,
        revision,
        updates: [...staged].map(([id, command]) => ({ id, command })),
        ...(resourcesChanged ? { resources: nextResources } : {}),
      }),
    ),
    scene,
    changedIndexes,
    textUploads,
    resourcesChanged,
  };
}

/**
 * `RIA1` idle animations (see the crate's `idle.rs`): a caller that re-poses a few retained subtrees with periodic
 * loops installs one descriptor set per committed scene revision (`set_idle_anims`) and presents each idle frame
 * with `present_idle(t)`, instead of a patch per frame. `RUST_IDLE_ANIMS` advertises this module.
 */
export const RUST_IDLE_ANIMS = true;

/** A root's loop curve. `rest` composes the committed pose (a root with no loop running). */
export type RustIdleCurve = "rest" | "rotate" | "rock" | "bob" | "pivotPulse" | "pulseScale";
const IDLE_CURVES: Record<RustIdleCurve, number> = { rest: 0, rotate: 1, rock: 2, bob: 3, pivotPulse: 4, pulseScale: 5 };

export interface RustIdleRoot {
  curve: RustIdleCurve;
  amplitudeRad: number;
  amplitudePx: number;
  baselineUpPx: number;
  scaleFrom: number;
  scaleTo: number;
  pivotX: number;
  pivotY: number;
  /** Phase origin (ms on the caller's clock), per-node phase offset and period. */
  originMs: number;
  phaseMs: number;
  periodMs: number;
  /** The parent's rendered global, the node's own local (null when it has none), the shared left-multiplier,
   * the root's spread shift, and the inverse of the pose the committed list holds. */
  base: readonly number[];
  wire: readonly number[] | null;
  outer: readonly number[];
  spreadDx: number;
  inverse: readonly number[];
}

/**
 * One command a root chain re-poses. `group`: a member of the root's group, `m = (parentWorld·delta)·local`.
 * `primitive`: `m = C·reference` with `C` the chain's composed delta. `text`: a text carrier placed with a local
 * transform, `m = parentWorld·((C·reference)·inset)`.
 */
export interface RustIdleTarget {
  commandIndex: number;
  mode: "group" | "primitive" | "text";
  /** Roots outermost first, each with this command's spread offset from it (ignored for `group`). */
  chain: readonly { root: number; offset: number }[];
  parentWorld?: readonly number[];
  reference: readonly number[];
  inset?: readonly number[];
}

export interface RustIdleSet {
  baseRevision: number;
  roots: readonly RustIdleRoot[];
  targets: readonly RustIdleTarget[];
}

/** Encode an idle set as `RIA1` bytes. Null when a value is not finite or an index is out of range. */
export function encodeRustIdleAnims(set: RustIdleSet): Uint8Array | null {
  if (!Number.isSafeInteger(set.baseRevision) || set.baseRevision < 0) return null;
  let size = 24 + set.roots.length * 304;
  for (const target of set.targets) size += 12 + target.chain.length * 16 + 144;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  let finite = true;
  const u32 = (value: number) => { view.setUint32(at, value, true); at += 4; };
  const f64 = (value: number) => { if (!Number.isFinite(value)) finite = false; view.setFloat64(at, value, true); at += 8; };
  const affine = (m: readonly number[] | undefined) => {
    const value = m ?? identity;
    if (value.length !== 6) finite = false;
    for (let i = 0; i < 6; i++) f64(value[i]);
  };
  bytes.set([0x52, 0x49, 0x41, 0x31], 0);
  at = 4;
  u32(1);
  u32(set.baseRevision % 0x1_0000_0000);
  u32(Math.floor(set.baseRevision / 0x1_0000_0000));
  u32(set.roots.length);
  u32(set.targets.length);
  for (const root of set.roots) {
    u32(IDLE_CURVES[root.curve]);
    u32(root.wire ? 1 : 0);
    for (const value of [root.amplitudeRad, root.amplitudePx, root.baselineUpPx, root.scaleFrom, root.scaleTo, 1, 1,
      root.pivotX, root.pivotY, root.originMs, root.phaseMs, root.periodMs]) f64(value);
    affine(root.base);
    affine(root.wire ?? undefined);
    affine(root.outer);
    f64(root.spreadDx);
    affine(root.inverse);
  }
  for (const target of set.targets) {
    if (!Number.isInteger(target.commandIndex) || target.commandIndex < 0 || target.chain.length === 0 ||
      target.chain.some(({ root }) => !Number.isInteger(root) || root < 0 || root >= set.roots.length)) return null;
    u32(target.commandIndex);
    u32(target.mode === "group" ? 0 : target.mode === "primitive" ? 1 : 2);
    u32(target.chain.length);
    for (const { root, offset } of target.chain) { u32(root); u32(0); f64(offset); }
    affine(target.parentWorld);
    affine(target.reference);
    affine(target.inset);
  }
  return finite && at === size ? bytes : null;
}

/**
 * The commands a retained patch re-places when `groupId`'s transform changes, as this scene holds them: each one's
 * index and group-local placement, plus the world of the group's own parent chain. Null when the scene has no
 * retained metadata or the group, or when a command sits in a group nested under it (its world would compose more
 * than one moving transform).
 */
export function rustRetainedGroupMembers(
  scene: RustSceneSnapshot,
  groupId: string,
): { parentWorld: number[]; members: { id: string; index: number; local: number[] }[] } | null {
  const meta = retainedMeta.get(scene);
  const group = meta?.groups.get(groupId);
  if (!meta || !group) return null;
  const indexes = indexCommands(scene);
  const members: { id: string; index: number; local: number[] }[] = [];
  for (const [id, owner] of meta.owners) {
    let parent = owner.parentId;
    let nested = false;
    while (parent && parent !== groupId) { nested = true; parent = meta.groups.get(parent)?.parentId; }
    if (parent !== groupId) continue;
    const index = indexes.get(id);
    if (nested || index === undefined) return null;
    members.push({ id, index, local: [...owner.local] });
  }
  for (const clip of meta.clips) {
    for (let parent = clip.parentId; parent; parent = meta.groups.get(parent)?.parentId)
      if (parent === groupId) return null;
  }
  let world: number[] = [...identity];
  const chain: string[] = [];
  for (let parent = group.parentId; parent; parent = meta.groups.get(parent)?.parentId) chain.push(parent);
  for (let i = chain.length - 1; i >= 0; i--) {
    const parent = meta.groups.get(chain[i]);
    if (!parent) return null;
    world = mul(world, parent.transform);
  }
  return { parentWorld: world, members };
}

/**
 * Where a retained text command (`t<key>`) lands for a `localTransform` update, as this scene holds it: its parent
 * group's world and the carrier inset `inverse(sourceLocal)·local` the update composes with. Null when it has no
 * retained placement or its source transform is singular.
 */
export function rustRetainedTextPlacement(
  scene: RustSceneSnapshot,
  id: string,
): { index: number; parentWorld: number[]; inset: number[] } | null {
  const meta = retainedMeta.get(scene);
  const owner = meta?.owners.get(id);
  const index = indexCommands(scene).get(id);
  if (!meta || !owner || index === undefined) return null;
  const undoSource = inverse(owner.sourceLocal);
  if (!undoSource) return null;
  let world: number[];
  try {
    const groupWorld = (groupId: string | undefined): number[] => {
      if (!groupId) return [...identity];
      const group = meta.groups.get(groupId);
      if (!group) throw new Error(`missing group ${groupId}`);
      return mul(groupWorld(group.parentId), group.transform);
    };
    world = groupWorld(owner.parentId);
  } catch {
    return null;
  }
  return { index, parentWorld: world, inset: mul(undoSource, owner.local) };
}
