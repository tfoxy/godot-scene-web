// IN12 (docs/input.md "Pointer targets"): which node the user pointed at, as the stream drew it.
// `pointerTargetResolver(client, {climb})` is the render-stream resolver for
// `@godot-scene-web/input/pointer`'s `resolveTarget`; it returns a structural hit and imports
// nothing from the input package (each stays free of the other).
//
// On demand only: nothing here runs per frame, and a client nobody resolves on pays nothing. A
// resolve is one `hitTest` (the core's pick, overrides included: the topmost drawn item read by
// the session's mouse filters, or Godot's own GUI pick order, which also finds a Control that
// draws nothing), a `parent` climb to the first item with a node identity, and one inverse
// of that item's drawn transform:
// `local = (E · T)⁻¹ · drawn point`, where `T` is the game's transform and `E` the composed
// override, so `local` is measured against what the user saw. Identities need the host's
// `GRC_ITEM_META` grant for the fields asked by an extension (`pointerTargetIdentity()`); without
// it a hit names only its `item`.
//
// A /13 endpoint offers only render-stream.14 when an extension wants `instance_id` or
// `mouse_filter`; TAG1 wants and an empty extension list keep .13. An explicit /14 endpoint
// always offers .14. A host without the v2 grant refuses the handshake through the client's
// existing failure/reconnect path; there is no protocol downgrade. Host-carried filters win
// over consumer `mouseFilter` statements, including null for non-Controls (IGNORE). With a
// `mouse_filter` grant the default order is tree; `pickOrder("drawn")` overrides it. Sessions
// with consumer statements alone keep drawn order unless they opt into tree order.

import type { RenderStreamClient } from "./client";
import {
  type Affine2D,
  type ExtensionCore,
  IDENTITY,
  type ItemMeta,
  type ItemMetaField,
  type ItemQuery,
  invertAffine,
  mulAffine,
  type Point,
  type RenderStreamExtension,
} from "./extensions";

/** What a resolve returns: input's `PointerTargetHit`, structurally. */
export interface RenderStreamPointerTarget {
  /** The target item id (the interning key). */
  readonly key: number;
  readonly identity: {
    readonly item: number;
    readonly path?: string;
    readonly scene?: string;
    readonly class?: string;
    readonly instanceId?: string;
  };
  /** The drawn point in the target's own coordinates. */
  readonly local: Point;
  /** The drawn transaction (the picture the user pointed at); absent before the first draw. */
  readonly frame?: number;
}

export interface PointerTargetResolverOptions {
  /**
   * Picks the target for the topmost drawn item `hit`: an item id (the hit or an ancestor),
   * `null` for "no target", `undefined` for the default (the first of `hit` and its ancestors
   * whose `meta(id).node` is true, else `hit` itself when there is no identity grant).
   */
  climb?: (hit: number, query: ItemQuery) => number | null | undefined;
}

export type RenderStreamPointerTargetResolver = (
  clientX: number,
  clientY: number,
) => RenderStreamPointerTarget | null;

/** What a resolve reads from a client (internal: `Client` provides it through the symbol). */
export interface PointerTargetSource {
  cssToPresentation(clientX: number, clientY: number): Point | null;
  /** The item query, or null before the core is up. */
  query(): ItemQuery | null;
  /** The composed override transform of an item (identity without extensions). */
  effective(id: number): Affine2D;
  /** The last drawn transaction, or null. */
  drawnSeq(): number | null;
}

/** Internal (not in the barrel): the client's `PointerTargetSource`. */
export const POINTER_TARGET_SOURCE: unique symbol = Symbol(
  "render-stream pointer target source",
);
export interface PointerTargetSourceHolder {
  readonly [POINTER_TARGET_SOURCE]?: () => PointerTargetSource;
}

const IDENTITY_FIELDS: readonly ItemMetaField[] = ["class", "scene", "path"];

/**
 * An extension that asks the host for the identity fields a target declaration carries
 * (`class`, `scene`, `path`). Pass it in the client's `extensions` (protocol 13); the host
 * operator's `GRC_ITEM_META` grant decides what arrives.
 */
export function pointerTargetIdentity(): RenderStreamExtension {
  return { id: "pointer-target-identity", wants: { fields: IDENTITY_FIELDS } };
}

/**
 * An item query straight over the core, for a client without extensions (no identities, no
 * overrides): the same `queryItem` layout `ExtensionHost` reads.
 */
export function coreItemQuery(
  core: () => Pick<
    ExtensionCore,
    "queryItem" | "queryChildren" | "querySubtreeRect" | "hitTest"
  > | null,
): ItemQuery {
  const item = (id: number): ArrayLike<number> => core()?.queryItem(id) ?? [];
  return {
    parent: (id) => {
      const f = item(id);
      return f.length > 0 && f[0] >= 0 ? f[0] : null;
    },
    children: (id) => core()?.queryChildren(id) ?? new Uint32Array(0),
    transform: (id) => {
      const f = item(id);
      if (f.length === 0 || f[2] === 0) return null;
      return [f[3], f[4], f[5], f[6], f[7], f[8]];
    },
    rect: (id) => {
      const f = item(id);
      if (f.length === 0 || f[9] === 0) return null;
      return { x: f[10], y: f[11], w: f[12], h: f[13] };
    },
    subtreeRect: (id) => {
      const r = core()?.querySubtreeRect(id);
      return r && r.length === 4
        ? { x: r[0], y: r[1], w: r[2], h: r[3] }
        : null;
    },
    visible: (id) => {
      const f = item(id);
      return f.length > 0 && f[1] !== 0;
    },
    meta: () => null,
    hitTest: (x, y) => core()?.hitTest(x, y) ?? null,
  };
}

/** The default climb: the first item up from `hit` that names a node, else `hit`. */
function defaultClimb(hit: number, query: ItemQuery): number {
  let cur: number | null = hit;
  for (let guard = 0; cur !== null && guard < 1 << 16; guard++) {
    if (query.meta(cur)?.node === true) return cur;
    cur = query.parent(cur);
  }
  return hit;
}

function identityOf(
  item: number,
  meta: ItemMeta | null,
): RenderStreamPointerTarget["identity"] {
  if (!meta?.node) return { item };
  const out: {
    item: number;
    path?: string;
    scene?: string;
    class?: string;
    instanceId?: string;
  } = {
    item,
  };
  if (typeof meta.path === "string") out.path = meta.path;
  if (typeof meta.scene === "string") out.scene = meta.scene;
  if (typeof meta.class === "string") out.class = meta.class;
  if (typeof meta.instanceId === "string") out.instanceId = meta.instanceId;
  return out;
}

/** The resolver over a source (the testable core of `pointerTargetResolver`). */
export function resolverFor(
  source: PointerTargetSource,
  options: PointerTargetResolverOptions = {},
): RenderStreamPointerTargetResolver {
  const climb = options.climb;
  return (clientX, clientY) => {
    const query = source.query();
    if (query === null) return null;
    const drawn = source.cssToPresentation(clientX, clientY);
    if (drawn === null) return null;
    const hit = query.hitTest(drawn.x, drawn.y);
    if (hit === null) return null;
    let target: number | null | undefined = climb?.(hit, query);
    if (target === undefined) target = defaultClimb(hit, query);
    if (target === null) return null;
    const xf = mulAffine(
      source.effective(target),
      query.transform(target) ?? IDENTITY,
    );
    const inv = invertAffine(xf);
    const local = {
      x: inv[0] * drawn.x + inv[2] * drawn.y + inv[4],
      y: inv[1] * drawn.x + inv[3] * drawn.y + inv[5],
    };
    const frame = source.drawnSeq();
    const out: {
      key: number;
      identity: RenderStreamPointerTarget["identity"];
      local: Point;
      frame?: number;
    } = {
      key: target,
      identity: identityOf(target, query.meta(target)),
      local,
    };
    if (frame !== null) out.frame = frame;
    return out;
  };
}

/**
 * The render-stream target resolver for `createPointerCapture({ targets, resolveTarget })`:
 * `(clientX, clientY) -> {key, identity, local, frame} | null`. Reads the client on demand (no
 * per-frame work); null before the core is up, on a letterbox bar, or over bare clear colour.
 */
export function pointerTargetResolver(
  client: RenderStreamClient,
  options: PointerTargetResolverOptions = {},
): RenderStreamPointerTargetResolver {
  const provide = (client as PointerTargetSourceHolder)[POINTER_TARGET_SOURCE];
  if (typeof provide !== "function")
    throw new TypeError(
      "pointerTargetResolver: expected a client from createRenderStreamClient",
    );
  return resolverFor(provide.call(client), options);
}
