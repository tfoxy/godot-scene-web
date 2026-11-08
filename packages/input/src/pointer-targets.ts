// Pointer targets for the pointer capture (docs/input.md "Pointer targets"): the opt-in half that
// asks a caller-supplied resolver which node the user pointed at, interns node identities into
// handles 1..1023, declares each handle once (and again after every `heldState()`, which runs
// after each hello: handles do not survive an epoch) and stamps `target` / `local` / `frame` on
// the record. With `targets: "off"` the capture never builds this table, so the pure path runs no
// resolver and sends no target bytes.
//
// DEPENDS ON NO RENDERER. Resolvers live in their owning packages (render-stream-client
// `pointerTargetResolver`, html `htmlPointerTargetResolver`) and return a structural
// `PointerTargetHit`; nothing here imports them, and they import nothing from this package.

import type { TargetDeclarationRecord } from "./format";
import { isInstanceId } from "./instance-id";
import type { PointerPoint } from "./pointer-map";

/**
 * Which node a hit names. `path` is a Godot NodePath (relative to the instance of `scene` when
 * `scene` is present, else absolute or relative to the host's target root); `item` is an opaque
 * renderer id (render-stream item). A hit needs `path` or `item`; invalid fields are dropped.
 */
export interface PointerTargetIdentity {
  path?: string;
  scene?: string;
  class?: string;
  item?: number;
  /** The Godot ObjectID as nonzero unsigned 64-bit decimal text. */
  instanceId?: string;
}

/** What a resolver returns for a point over a node. */
export interface PointerTargetHit {
  /**
   * Interning key, compared with SameValueZero (a `Map` key): the same node must give the same
   * key while it lives. A render-stream item id, a DOM element, a path string.
   */
  key: unknown;
  identity: PointerTargetIdentity;
  /** The point in the node's own coordinates, measured against the transform the user saw. */
  local: PointerPoint;
  /** The renderer's id of the picture on screen (render-stream: the drawn transaction). */
  frame?: number;
}

/**
 * `(clientX, clientY, point) -> hit | null`: `point` is the capture's mapped host point (the
 * `map` result); `null` means over no node.
 */
export type PointerTargetResolver = (
  clientX: number,
  clientY: number,
  point: PointerPoint,
) => PointerTargetHit | null;

/** `target` (a declared handle), `local` and optional `frame`, ready to assign onto a record. */
export interface PointerTargetStamp {
  target: number;
  local: [number, number];
  frame?: number;
}

/** Largest handle (docs/input.md: 1..1023). */
const MAX_HANDLE = 1023;
const COORD_LIMIT = 1_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const CLASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the codec's own C0/DEL rule
const CONTROL = /[\u0000-\u001f\u007f]/;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const text = (value: unknown, maxBytes: number): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  !CONTROL.test(value) &&
  utf8Length(value) <= maxBytes
    ? value
    : undefined;

const q2 = (v: number) =>
  Math.round(Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) * 100) / 100 || 0;

/** The identity's codec-valid fields, or null when neither `path` nor `item` survives. */
function cleanIdentity(
  identity: PointerTargetIdentity,
): Omit<TargetDeclarationRecord, "event" | "handle"> | null {
  const out: Omit<TargetDeclarationRecord, "event" | "handle"> = {};
  const path = text(identity.path, 1024);
  if (path !== undefined) {
    out.path = path;
    const scene = text(identity.scene, 512);
    if (scene !== undefined) out.scene = scene;
  }
  if (typeof identity.class === "string" && CLASS_PATTERN.test(identity.class))
    out.class = identity.class;
  if (isInstanceId(identity.instanceId)) out.instance_id = identity.instanceId;
  const item = identity.item;
  if (
    Number.isInteger(item) &&
    (item as number) >= 0 &&
    (item as number) <= MAX_SAFE
  )
    out.item = item as number;
  return out.path === undefined && out.item === undefined ? null : out;
}

function sameIdentity(
  a: Omit<TargetDeclarationRecord, "event" | "handle">,
  b: Omit<TargetDeclarationRecord, "event" | "handle">,
): boolean {
  return (
    a.path === b.path &&
    a.scene === b.scene &&
    a.class === b.class &&
    a.item === b.item &&
    a.instance_id === b.instance_id
  );
}

interface Entry {
  handle: number;
  /** The resolver's identity as last given, compared field by field before any re-check. */
  raw: PointerTargetIdentity;
  identity: Omit<TargetDeclarationRecord, "event" | "handle">;
  /** Declared to the host in the current epoch. */
  declared: boolean;
}

export interface PointerTargetTableStats {
  /** Resolver calls. */
  resolves: number;
  /** `target` declarations pushed (heldState's included). */
  declarations: number;
}

/**
 * The capture's interning table. `resolve` calls the resolver once and returns the stamp for the
 * record about to go out, pushing a declaration first when the handle is new to this epoch.
 */
export interface PointerTargetTable {
  resolve(
    clientX: number,
    clientY: number,
    point: readonly [number, number],
  ): PointerTargetStamp | null;
  /**
   * The epoch may have changed (a `heldState()` call): forget every declaration, and return the
   * declarations of `handles` (the ones the held state references), now marked declared.
   */
  redeclare(handles: Iterable<number>): TargetDeclarationRecord[];
  readonly stats: PointerTargetTableStats;
}

/**
 * Build the table. `push` sends a declaration record ahead of the stamped one; `pinned(handle)`
 * says a handle is still referenced by held state, so least-recently-used recycling skips it.
 */
export function createPointerTargetTable(
  resolver: PointerTargetResolver,
  push: (record: TargetDeclarationRecord) => void,
  pinned: (handle: number) => boolean = () => false,
): PointerTargetTable {
  /** key -> entry; Map order is least recently used first. */
  const byKey = new Map<unknown, Entry>();
  const byHandle = new Map<number, unknown>();
  let nextHandle = 1;
  const stats: PointerTargetTableStats = { resolves: 0, declarations: 0 };

  const declaration = (entry: Entry): TargetDeclarationRecord => ({
    event: "target",
    handle: entry.handle,
    ...entry.identity,
  });

  function allocate(): number {
    if (nextHandle <= MAX_HANDLE) return nextHandle++;
    // Recycle the least recently used handle no held state references.
    for (const [key, entry] of byKey) {
      if (pinned(entry.handle)) continue;
      byKey.delete(key);
      byHandle.delete(entry.handle);
      return entry.handle;
    }
    return 0;
  }

  return {
    stats,
    resolve(clientX, clientY, point) {
      stats.resolves++;
      let hit: PointerTargetHit | null;
      try {
        hit = resolver(clientX, clientY, { x: point[0], y: point[1] });
      } catch {
        // A resolver's error is not the input's: the record goes by its coordinate.
        return null;
      }
      if (!hit?.local) return null;
      const lx = hit.local.x;
      const ly = hit.local.y;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) return null;
      const given = hit.identity ?? {};
      let entry = byKey.get(hit.key);
      if (entry) {
        // Most recently used goes last; an identity that changed (a grant arriving late) is
        // re-declared under the same handle.
        byKey.delete(hit.key);
        byKey.set(hit.key, entry);
        const raw = entry.raw;
        if (
          given.path !== raw.path ||
          given.scene !== raw.scene ||
          given.class !== raw.class ||
          given.item !== raw.item ||
          given.instanceId !== raw.instanceId
        ) {
          const fresh = cleanIdentity(given);
          if (!fresh) return null;
          entry.raw = { ...given };
          if (!sameIdentity(fresh, entry.identity)) {
            entry.identity = fresh;
            entry.declared = false;
          }
        }
      } else {
        const identity = cleanIdentity(given);
        if (!identity) return null;
        const handle = allocate();
        if (handle === 0) return null;
        entry = { handle, raw: { ...given }, identity, declared: false };
        byKey.set(hit.key, entry);
        byHandle.set(handle, hit.key);
      }
      if (!entry.declared) {
        entry.declared = true;
        stats.declarations++;
        push(declaration(entry));
      }
      const stamp: PointerTargetStamp = {
        target: entry.handle,
        local: [q2(lx), q2(ly)],
      };
      const frame = hit.frame;
      if (
        Number.isInteger(frame) &&
        (frame as number) >= 0 &&
        (frame as number) <= MAX_SAFE
      )
        stamp.frame = frame as number;
      return stamp;
    },
    redeclare(handles) {
      for (const entry of byKey.values()) entry.declared = false;
      const out: TargetDeclarationRecord[] = [];
      for (const handle of handles) {
        const key = byHandle.get(handle);
        const entry = key === undefined ? undefined : byKey.get(key);
        if (!entry || entry.declared) continue;
        entry.declared = true;
        stats.declarations++;
        out.push(declaration(entry));
      }
      return out;
    },
  };
}
