// TAG2 (client-extensions-design.md §3): the client's extension API. A product module asks for
// item identities (Godot's own scene, path, class, script, groups and meta) in the hello, receives
// them as `item_meta` records, reads the resolved state through `ItemQuery`, and changes what is
// drawn through a retained override table that the core composes in presentation space.
//
// Nothing here runs for a client with no extension: `createRenderStreamClient` builds no
// `ExtensionHost`, the hello has no `item_meta` key, and the loop's one `if (this.ext)` per frame
// is false.

/** Godot's `Transform2D` columns: x axis (a, b), y axis (c, d), origin (e, f). A point maps to
 * `(a·x + c·y + e, b·x + d·y + f)`. Presentation pixels, y down. */
export type Affine2D = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];
/** A colour multiplier, 0..1 per channel. */
export type RGBA = readonly [number, number, number, number];
export interface Point {
  readonly x: number;
  readonly y: number;
}
/** Presentation pixels: origin and size. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type ItemMetaField = "class" | "script" | "scene" | "path";
const FIELDS: readonly ItemMetaField[] = ["class", "script", "scene", "path"];

/** A hello request, or the host's grant (the request's subset the host operator allows). */
export interface ItemMetaGrant {
  readonly fields: readonly ItemMetaField[];
  readonly groups: readonly string[];
  readonly metaKeys: readonly string[];
}

export interface ExtensionSession {
  readonly sessionId: string;
  readonly streamId: string;
  /** The grant, or null when the host refused (no record before the first full transaction) or
   * no extension asked. */
  readonly itemMeta: ItemMetaGrant | null;
  /** Draw again on the next frame callback, from outside a frame (an input, a timer): runs
   * `beforeDraw` with seq null, as `ExtensionFrame.requestRedraw` does. */
  requestRedraw(): void;
}

export interface ItemMeta {
  readonly id: number;
  /** false: an item with no node (a TileMap quadrant, a viewport internal). */
  readonly node: boolean;
  readonly class?: string | null;
  readonly script?: string | null;
  readonly scene?: string | null;
  readonly path?: string | null;
  /** The granted group names this item is in (shared frozen arrays). */
  readonly groups: readonly string[];
  readonly meta: Readonly<Record<string, string | null>>;
}

export interface ItemMetaBatch {
  /** A full replaces the table. */
  readonly form: "full" | "delta";
  readonly items: readonly ItemMeta[];
}

export interface OverrideValues {
  /** Presentation space, pre-multiplied: the subtree draws at `transform · (game transform)`. */
  transform?: Affine2D;
  /** Multiplied into the item's inherited modulate (its children inherit it). */
  modulate?: RGBA;
  /** false hides the subtree. */
  visible?: boolean;
}

/** Retained: an override stays until changed or cleared. Overrides of an item and its ancestors
 * compose (nearest first). Writing the values an item already has changes nothing. */
export interface OverrideTable {
  /** Replaces the item's override with these values (absent ones: identity, white, visible). */
  set(id: number, o: OverrideValues): void;
  /** Replaces only the transform. */
  translate(id: number, dx: number, dy: number): void;
  scaleAbout(id: number, sx: number, sy: number, px: number, py: number): void;
  /** The transform that draws the item at the global `xf`: `xf · (E_parent · resolved)⁻¹`. */
  setGlobal(id: number, xf: Affine2D): void;
  /** The item's own override, or null. */
  get(id: number): Readonly<Required<OverrideValues>> | null;
  /** INP1: the composed override transform of the item and its ancestors (`E`, identity when
   * none): the item draws at `E · query.transform(id)`, and `E⁻¹` maps a drawn point back to
   * the game's. */
  effective(id: number): Affine2D;
  clear(id: number): void;
  clearAll(): void;
  /** Items with an override. */
  readonly size: number;
}

/** Reads the game's resolved state (the newest accepted transaction; while a transaction waits
 * for its payloads that is one ahead of the drawn picture). No override is applied. */
export interface ItemQuery {
  parent(id: number): number | null;
  children(id: number): Uint32Array;
  /** The game's draw transform, before any override. */
  transform(id: number): Affine2D | null;
  /** The global AABB of the item's own commands, presentation px (null: it draws nothing). */
  rect(id: number): Rect | null;
  subtreeRect(id: number): Rect | null;
  /** Effective visibility: the item and its ancestors visible, on an attached canvas. */
  visible(id: number): boolean;
  /** The item's identity, or null. */
  meta(id: number): ItemMeta | null;
  /** INP1: the topmost item drawn under the presentation-space point, in the last draw order,
   * as it is drawn (overrides included); null where only the clear colour shows. The hit is the
   * item whose own commands cover the point, so for a card it is one of the card's children:
   * `parent` climbs to the card. Computed on demand, never per frame. */
  hitTest(x: number, y: number): number | null;
}

export interface ExtensionFrame {
  /** The newest applied transaction; null on an extension redraw. */
  readonly seq: number | null;
  /** The frame callback's time (ms). */
  readonly now: number;
  readonly overrides: OverrideTable;
  readonly query: ItemQuery;
  /** Draw again on the next frame callback with the current overrides, with no transaction:
   * acks nothing and asks no credit. */
  requestRedraw(): void;
}

export interface RenderStreamExtension {
  readonly id: string;
  /** Merged into the hello's `item_meta`: fields are unioned; groups and meta keys are unioned
   * in extension order. Absent on every extension: no `item_meta` key (the pure hello). */
  readonly wants?: {
    fields?: readonly ItemMetaField[];
    groups?: readonly string[];
    metaKeys?: readonly string[];
  };
  onSession?(s: ExtensionSession): void;
  /** At receipt, before the transaction it precedes applies. */
  onItemMeta?(batch: ItemMetaBatch): void;
  /** At apply. */
  onItemsRemoved?(ids: Uint32Array): void;
  /** After apply (or for a redraw), before the draw. */
  beforeDraw?(frame: ExtensionFrame): void;
  dispose?(): void;
}

// --------------------------------------------------------------------------- the host side

/** The core calls the extension host makes (core.ts `WasmStreamCore`). */
export interface ExtensionCore {
  /** The `item_meta` record just received: its meta JSON. */
  itemMetaJson(): string;
  setLogRemoved(on: boolean): void;
  takeRemoved(): Uint32Array;
  /** The whole table: ids and 11 floats each (6 affine, 4 modulate, 1 visible). */
  setOverrides(ids: Uint32Array, vals: Float32Array): void;
  /** Compose a changed table now (0 clean, 1 deferred to the pending apply, 2 moved, 3 walked). */
  refreshOverrides(): number;
  /** `[parent, visible, has_xform, xform x6, has_rect, rect x4]`, or empty. */
  queryItem(id: number): ArrayLike<number>;
  querySubtreeRect(id: number): ArrayLike<number>;
  queryChildren(id: number): Uint32Array;
  /** INP1: the topmost drawn item under a presentation-space point, or null. */
  hitTest(x: number, y: number): number | null;
}

/** The hello's `item_meta` value (render-stream-13.md, TAG1's parser: exactly these keys). */
export interface ItemMetaRequestJson {
  fields: ItemMetaField[];
  groups: string[];
  meta_keys: string[];
}

export const IDENTITY: Affine2D = [1, 0, 0, 1, 0, 0];
const WHITE: RGBA = [1, 1, 1, 1];

/** `a · b`. */
export function mulAffine(a: Affine2D, b: Affine2D): Affine2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invertAffine(t: Affine2D): Affine2D {
  const det = t[0] * t[3] - t[1] * t[2];
  const i = det === 0 ? 0 : 1 / det;
  const a = t[3] * i;
  const b = -t[1] * i;
  const c = -t[2] * i;
  const d = t[0] * i;
  return [a, b, c, d, -(a * t[4] + c * t[5]), -(b * t[4] + d * t[5])];
}

/** The union of the extensions' wants, or null when none asks. */
export function mergeWants(
  exts: readonly RenderStreamExtension[],
): ItemMetaRequestJson | null {
  let asked = false;
  const fields = new Set<ItemMetaField>();
  const groups: string[] = [];
  const keys: string[] = [];
  for (const e of exts) {
    const w = e.wants;
    if (!w) continue;
    asked = true;
    for (const f of w.fields ?? []) fields.add(f);
    for (const g of w.groups ?? []) if (!groups.includes(g)) groups.push(g);
    for (const k of w.metaKeys ?? []) if (!keys.includes(k)) keys.push(k);
  }
  if (!asked) return null;
  return {
    fields: FIELDS.filter((f) => fields.has(f)),
    groups,
    meta_keys: keys,
  };
}

interface Entry {
  xform: Affine2D;
  modulate: RGBA;
  visible: boolean;
}

const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

class Table implements OverrideTable {
  readonly entries = new Map<number, Entry>();
  dirty = false;

  constructor(private readonly query: ItemQuery) {}

  get size(): number {
    return this.entries.size;
  }

  private put(id: number, e: Entry): void {
    if (![...e.xform, ...e.modulate].every(Number.isFinite))
      throw new TypeError(
        `render-stream override: item ${id} has a non-finite value`,
      );
    const old = this.entries.get(id);
    if (
      old &&
      old.visible === e.visible &&
      same(old.xform, e.xform) &&
      same(old.modulate, e.modulate)
    )
      return;
    this.entries.set(id, e);
    this.dirty = true;
  }

  set(id: number, o: OverrideValues): void {
    this.put(id, {
      xform: o.transform ? ([...o.transform] as Affine2D) : IDENTITY,
      modulate: o.modulate ? ([...o.modulate] as RGBA) : WHITE,
      visible: o.visible ?? true,
    });
  }

  private setXform(id: number, xform: Affine2D): void {
    const old = this.entries.get(id);
    this.put(id, {
      xform,
      modulate: old?.modulate ?? WHITE,
      visible: old?.visible ?? true,
    });
  }

  translate(id: number, dx: number, dy: number): void {
    this.setXform(id, [1, 0, 0, 1, dx, dy]);
  }

  scaleAbout(id: number, sx: number, sy: number, px: number, py: number): void {
    this.setXform(id, [sx, 0, 0, sy, px - sx * px, py - sy * py]);
  }

  setGlobal(id: number, xf: Affine2D): void {
    const resolved = this.query.transform(id);
    if (resolved === null) return;
    const p = this.query.parent(id);
    const parentE = p === null ? IDENTITY : this.effective(p);
    this.setXform(
      id,
      mulAffine(xf, invertAffine(mulAffine(parentE, resolved))),
    );
  }

  get(id: number): Readonly<Required<OverrideValues>> | null {
    const e = this.entries.get(id);
    return e
      ? { transform: e.xform, modulate: e.modulate, visible: e.visible }
      : null;
  }

  effective(id: number): Affine2D {
    let e: Affine2D = IDENTITY;
    if (this.entries.size === 0) return e;
    let cur: number | null = id;
    for (let guard = 0; cur !== null && guard < 1 << 16; guard++) {
      const o = this.entries.get(cur);
      if (o) e = mulAffine(e, o.xform);
      cur = this.query.parent(cur);
    }
    return e;
  }

  clear(id: number): void {
    if (this.entries.delete(id)) this.dirty = true;
  }

  clearAll(): void {
    if (this.entries.size > 0) this.dirty = true;
    this.entries.clear();
  }

  /** Removed items leave without a copy (the core dropped them at the same apply). */
  drop(ids: Uint32Array): void {
    for (const id of ids) this.entries.delete(id);
  }

  pack(): [Uint32Array, Float32Array] {
    const ids = new Uint32Array(this.entries.size);
    const vals = new Float32Array(this.entries.size * 11);
    let k = 0;
    for (const [id, e] of this.entries) {
      ids[k] = id;
      vals.set(e.xform, k * 11);
      vals.set(e.modulate, k * 11 + 6);
      vals[k * 11 + 10] = e.visible ? 1 : 0;
      k++;
    }
    return [ids, vals];
  }
}

interface RecordJson {
  type: "item_meta";
  form: "full" | "delta";
  grant: {
    fields: ItemMetaField[];
    groups: string[];
    meta_keys: string[];
  } | null;
  strings_from: number;
  strings: string[];
  items: (number | null)[][];
}

/** The extension list's runtime: one per client (TAG2). Every callback's error is caught: a
 * module's error is not the stream's. */
export class ExtensionHost {
  readonly request: ItemMetaRequestJson | null;
  private core: ExtensionCore | null = null;
  private grant: ItemMetaGrant | null = null;
  private strings: string[] = [];
  private readonly metas = new Map<number, ItemMeta>();
  private readonly groupArrays = new Map<number, readonly string[]>();
  private session: { sessionId: string; streamId: string } | null = null;
  private announced = false;
  private redrawWanted = false;
  private readonly table: Table;
  readonly query: ItemQuery;
  private readonly listensRemoved: boolean;
  private readonly drawers: RenderStreamExtension[];
  /** Callback errors caught (evidence; the first is logged). */
  errors = 0;
  /** Redraws drawn (no transaction) and table copies into the core. */
  redraws = 0;
  copies = 0;

  constructor(private readonly exts: readonly RenderStreamExtension[]) {
    this.request = mergeWants(exts);
    this.listensRemoved = exts.some((e) => e.onItemsRemoved !== undefined);
    this.drawers = exts.filter((e) => e.beforeDraw !== undefined);
    this.query = {
      parent: (id) => {
        const f = this.core?.queryItem(id);
        return f && f.length > 0 && f[0] >= 0 ? f[0] : null;
      },
      children: (id) => this.core?.queryChildren(id) ?? new Uint32Array(0),
      transform: (id) => {
        const f = this.core?.queryItem(id);
        if (!f || f.length === 0 || f[2] === 0) return null;
        return [f[3], f[4], f[5], f[6], f[7], f[8]];
      },
      rect: (id) => {
        const f = this.core?.queryItem(id);
        if (!f || f.length === 0 || f[9] === 0) return null;
        return { x: f[10], y: f[11], w: f[12], h: f[13] };
      },
      subtreeRect: (id) => {
        const r = this.core?.querySubtreeRect(id);
        return r && r.length === 4
          ? { x: r[0], y: r[1], w: r[2], h: r[3] }
          : null;
      },
      visible: (id) => {
        const f = this.core?.queryItem(id);
        return !!f && f.length > 0 && f[1] !== 0;
      },
      meta: (id) => this.metas.get(id) ?? null,
      hitTest: (x, y) => this.core?.hitTest(x, y) ?? null,
    };
    this.table = new Table(this.query);
  }

  get overrides(): OverrideTable {
    return this.table;
  }

  /** A fresh core instance (a client's one, after load). */
  bind(core: ExtensionCore): void {
    this.core = core;
    if (this.listensRemoved) core.setLogRemoved(true);
  }

  /** A session record: a fresh table on both sides (ids are per session). */
  beginSession(sessionId: string, streamId: string): void {
    this.session = { sessionId, streamId };
    this.announced = false;
    this.grant = null;
    this.strings = [];
    this.metas.clear();
    this.table.entries.clear();
    this.table.dirty = false;
    this.redrawWanted = false;
  }

  private announce(grant: ItemMetaGrant | null): void {
    if (this.announced) return;
    this.announced = true;
    const s: ExtensionSession = {
      sessionId: this.session?.sessionId ?? "",
      streamId: this.session?.streamId ?? "",
      itemMeta: grant,
      requestRedraw: () => {
        this.redrawWanted = true;
      },
    };
    for (const e of this.exts) this.call(() => e.onSession?.(s));
  }

  /** A transaction arrived (before it applies): a session with no full record was refused. */
  transaction(): void {
    if (!this.announced) this.announce(null);
  }

  /** An `item_meta` record arrived: into the table, then `onItemMeta`. */
  itemMeta(): void {
    const r = JSON.parse(this.core?.itemMetaJson() ?? "{}") as RecordJson;
    if (r.form === "full") {
      const g = r.grant;
      this.grant = g
        ? Object.freeze({
            fields: Object.freeze([...g.fields]),
            groups: Object.freeze([...g.groups]),
            metaKeys: Object.freeze([...g.meta_keys]),
          })
        : null;
      this.strings = [];
      this.metas.clear();
      this.groupArrays.clear();
      this.announce(this.grant);
    }
    this.strings.length = r.strings_from;
    this.strings.push(...r.strings);
    const g = this.grant;
    const items: ItemMeta[] = [];
    if (g !== null) {
      const str = (i: number | null | undefined) =>
        i === null || i === undefined ? null : (this.strings[i] ?? null);
      for (const row of r.items) {
        const id = row[0] as number;
        let m: ItemMeta;
        if (row.length === 1) {
          m = Object.freeze({ id, node: false, groups: [], meta: {} });
        } else {
          const o: Record<string, unknown> = { id, node: true };
          let c = 1;
          for (const f of g.fields) o[f] = str(row[c++]);
          let groups: readonly string[] = [];
          if (g.groups.length > 0) groups = this.groupsOf(row[c++] ?? 0);
          const meta: Record<string, string | null> = {};
          for (const k of g.metaKeys) meta[k] = str(row[c++]);
          o.groups = groups;
          o.meta = Object.freeze(meta);
          m = Object.freeze(o) as unknown as ItemMeta;
        }
        this.metas.set(id, m);
        items.push(m);
      }
    }
    const batch: ItemMetaBatch = Object.freeze({ form: r.form, items });
    for (const e of this.exts) this.call(() => e.onItemMeta?.(batch));
  }

  private groupsOf(mask: number): readonly string[] {
    let a = this.groupArrays.get(mask);
    if (a === undefined) {
      const g = this.grant?.groups ?? [];
      a = Object.freeze(g.filter((_, i) => (mask >>> i) & 1));
      this.groupArrays.set(mask, a);
    }
    return a;
  }

  /** After an apply: removed items leave the tables, then `onItemsRemoved`. */
  applied(): void {
    if (!this.listensRemoved || this.core === null) return;
    const ids = this.core.takeRemoved();
    if (ids.length === 0) return;
    for (const id of ids) this.metas.delete(id);
    this.table.drop(ids);
    for (const e of this.exts) this.call(() => e.onItemsRemoved?.(ids));
  }

  /** The frame callback, before the one draw: `beforeDraw`, then a changed table into the core
   * (composed now unless a transaction waits to apply). */
  beforeDraw(seq: number | null, now: number): void {
    this.redrawWanted = false;
    if (this.drawers.length > 0) {
      const frame: ExtensionFrame = {
        seq,
        now,
        overrides: this.table,
        query: this.query,
        requestRedraw: () => {
          this.redrawWanted = true;
        },
      };
      for (const e of this.drawers) this.call(() => e.beforeDraw?.(frame));
    }
    if (this.table.dirty && this.core !== null) {
      this.table.dirty = false;
      const [ids, vals] = this.table.pack();
      this.core.setOverrides(ids, vals);
      this.core.refreshOverrides();
      this.copies++;
    }
  }

  /** Whether the last `beforeDraw` asked for a redraw. */
  get wantsRedraw(): boolean {
    return this.redrawWanted;
  }

  dispose(): void {
    for (const e of this.exts) this.call(() => e.dispose?.());
    this.core = null;
    this.metas.clear();
    this.table.entries.clear();
  }

  private call(f: () => void): void {
    try {
      f();
    } catch (e) {
      if (this.errors++ === 0)
        console.error("render-stream extension error", e);
    }
  }
}
