# Client extensions: opt-in flexibility without taxing the pure stream (TAG-D, 2026-10-30)

Status: **design.** TAG-D is docs plus one measurement tool. It designs the identity layer (TAG)
that [mirror-client-design.md](mirror-client-design.md) "Extensions: the attach point" sketched. It
also places every mirror option that couch-coop's new renderer still forces. Base: `main` d80b6164.
The measurements are in [results/p3/tag-d.md](../results/p3/tag-d.md).

The binding constraints (user, 2026-10-27 and 2026-10-29; memories `render-stream-pure-client-first`
and `mirror-new-renderer-option`):

- **The pure stream must not suffer.** A pixel-parity viewer pays nothing for the flexibility given
  to other clients: no host work, no wire bytes and no client work.
- **Customization is opt-in.** It is negotiated in the hello, or arrives on a side channel, and is
  absent from the default wire.
- **No per-frame host work** unless a client asks for it.
- **Shared encodes (P3-SP) keep working.**
- **Static per-item metadata travels once,** when the item is created.
- **No STS2 or product concept in GSW.** STS2's raised cards are a couch-coop module.

## Summary of decisions

Each decision has a one-line reason. The details follow in the sections named.

1. **The host API is Godot itself: groups and metadata, with no GSW API.** A game, or a mod, tags a
   node with `add_to_group("…")` or `set_meta("…", v)`. The capture registers no class. Every Godot
   language can already do both, so this adds no ABI and no new engine surface (§2.2).
2. **The identity is chosen to survive a reparent:** an instance scene plus a path inside it, not
   an absolute node path. That is what couch's tables already key on: (scene file,
   scene-relative path), for example `CardContainer/DescriptionLabel`. The rest of the context
   (for example, "under the hand") comes from the stream's own item tree, which is dynamic and
   exact (§2.3).
3. **Identity travels in its own JSON record, `item_meta`, sent just before the transaction it
   describes, and only on opted-in connections.** The transaction bytes stay shared (raw and
   coded). The record itself is shared between lockstep opted-in viewers, through a memo keyed by
   (B, T, grant) (§2.4).
4. **Two opt-ins are needed: the host operator's grant (`GRC_ITEM_META`) and the viewer's hello
   key (`item_meta`).** Identity can expose more than pixels do (scene and script paths, node names),
   so the host decides what can leave it (§2.1).
5. **When TAG is off, the host's cost is one branch per snapshot, and none per item.** Item ids are
   dense and never reused (render-stream-0 `id-reused`), so a watermark finds the new items. No
   node map is connected and no string is made (§2.5).
6. **Wire removal is session-wide, and hiding is per viewer.** Removing a subtree for one viewer
   would give that viewer its own encodes, so per-viewer removal is a client `visible: false`
   override. A host operator can withhold a group for everyone through unknown-item-skip's
   withholding (OMIT, deferred) (§2.7).
7. **An override is pre-multiplied in presentation space and inherited by the subtree.** It is
   composed in the applier's `cull` and in `move_rec`, after `final_xf`. Children, culling and
   clips follow it, and the overridden subtree is damaged (§3.2).
8. **The widescreen stretch is Godot's own `aspect=expand` re-layout, at the viewer's aspect.** It
   is not a client re-layout. STS2 already runs `canvas_items`/`expand`, and the streaming seat
   is started per viewer (MIR-4). So the seat starts at `GRC_ROOT_SIZE=presentation:<W>x<H>`
   from the viewer's aspect. The result is exact, and costs nothing per frame (§1, PRES-A).
9. **TAG lands at /13, before the freeze.** It adds an optional hello key and a JSON record type,
   and reserves nothing in the transaction syntax. The binary syntax needs nothing from TAG.
   W13z, the freeze, waits for TAG1 and TAG2 (§4).

## 1. Inventory: the forced mirror options

There are 17 forced rows, in couch `frontend/src/mirror/mirrorSettings.ts` `STREAM_RENDER_OVERRIDES`,
at couch b944c52b. How the old mirror implemented each one was surveyed from couch's source.

The classes:
- **(a)** is generic, and GSW (or the capture's existing configuration) owns it;
- **(b)** needs per-item identity (TAG);
- **(c)** is product-only, a couch-coop module on the extension API;
- **(r)** does not apply to a stream: retire the row under the new renderer, keeping its forced
  value.

| Row | Old mirror (couch) | Class | What the client needs | What the host sends | Cost |
| --- | ------------------ | ----- | --------------------- | ------------------- | ---- |
| `stretchEnabled` | `spreadLayout.ts` `computeSpread`: widens the design box to ≤ 2520 and re-lays out anchored Controls, positional claimers and pass-through groups by hand, with scene exceptions. The host stays at 1920×1080 | **(a)** PRES-A | nothing new: D12 already sizes the backing store to the session's `presentation_size`, and the CSS box letterboxes any residue | nothing new. The seat is launched at `presentation:<W>x1080`, with W from the viewer's aspect (capped by the product, e.g. 2520). Godot's `expand` re-lays out the anchors itself | zero per frame. Bytes scale with the wider picture. A phone rotation means a seat restart (PRES-R, deferred) |
| `quality` | GPU tier ladder (`render/quality.ts`): backing scale, effect frame caps, hard-off floor | **(a)** deferred | a `backingScale < 1` client option (not parity) | nothing | zero when 1. Build it only if a phone measurement asks for it |
| `shaderMode` | rate or off for the browser's re-run of game shaders (`effectPolicy.ts`) | **(a)** deferred | a shader-time throttle in the executor (not parity) | nothing | as `quality` |
| `particleMode` | rate or off for the browser's particle simulations | **(a)** deferred | a particle step-rate cap (PM6b's simulator; not parity) | nothing | as `quality` |
| `reproRecorder` | rolling 32 MB node-wire plus input recording (`reproRecorder.ts`) | **(a)** REC1 | a client option that keeps a bounded ring of received messages from the last full transaction, plus the fetched resources, exportable as a recording that `rs-core-check` replays | nothing | zero when off. When on, one copy per message plus a bounded ring |
| `raiseHandCards` | `raise/handRaisePlan.ts` `planHandRaise`: +119 px lift for resting hand cards (`NHandCardHolder` under `CardHolderContainer`), a focus ramp, stand-downs (targeting arrow, choose screens, dimmed hand), and a creature HUD lift (`combat/creature.tscn` `HealthBar` / `Intents`) | **(c)** on (b) | `item_meta` with `scene`, `path` and `script`; the item tree; overrides; `requestRedraw` for the ramp | `item_meta`, once per item | client work only while the module runs; host only while granted |
| `uiScaling` | `viewScale.ts` (scale about an anchor, keyed by (scene file, scene-relative path) or type), HoverTip 1.2×, per-label text scale (`--godot-text-scale` reflows), clip-axis outset | **(c)** on (b) | as above, plus `query.rect`. **Without reflow**: text grows about an anchor. Clip escape is deferred (§3.2) | `item_meta` | as above |
| `raiseHeldCard` | lifts the finger-held card 300/120 px (`raise/heldLift.ts`); needs touch hit-test and drag state | **(c)** on (b) and INP1 | `item_meta`, overrides, INP1's hit-test and inverse mapping, and couch's input channel | `item_meta` | as above. Blocked on interaction (Open 4) |
| `tapToFocus` | two-tap arm then click; hit-tests by Godot type, sends `hover`/`click` | **(c)** on (b) and INP1 | as above | `item_meta` | as above |
| `confirmTap` | a client confirm button on reward screens; re-sends a click | **(c)** on (b) and INP1 | as above, plus a DOM overlay anchored by `query.rect` | `item_meta` | as above |
| `unfocusOnRelease` | after a peek, sends a `hover` at the stage centre | **(c)** on INP1 | INP1 mapping only (the peek gesture needs (b)) | none beyond input | as above |
| `staticBgEnabled` | the host drops the background roots and the client shows a host still | **(r)**, or (c) on (b) with OMIT | — | — | the stream already draws the live background; retire unless a phone GPU measurement says otherwise |
| `backstopOcclusion` | DOM compositing: swaps live canvases under a ≥ 0.70 backstop for an `<img>` | **(r)** | — | — | the executor's retained damage already covers it |
| `tweenReplay` | node-wire tween hints (host setting) | **(r)** | — | — | TW is a no-go for the wire (tween-descriptors-design.md). Client-side motion is an extension (§3.3) |
| `freezeParticles`, `freezeSpines`, `freezeDecor` | host CPU savers (`CouchCoopHeadlessVisualSuspender`) | **(r)** | — | always `false` to a streaming seat | a freeze on the streaming seat freezes the streamed picture |

What this means for the order of work:
- **PRES-A** is configuration plus one proof, and needs no TAG.
- **TAG1 and TAG2** unblock `raiseHandCards` and `uiScaling` (TAG3).
- The four input rows also need **INP1** and couch's input channel. The new renderer is view-only
  today (handoff §3 Q4), and turning on interaction is the product's call (Open 4).

## 2. TAG: the identity layer

### 2.1 Opt-in, on both ends

**Host grant.** A new environment variable, `GRC_ITEM_META`, is a comma list over `class`,
`script`, `scene`, `path`, `groups` and `meta`. It is empty by default, which means no grant. It
is read at arm. It caps what any viewer can receive: a hello that asks for more gets the
intersection.

**Viewer opt-in.** A /13 hello can carry the optional key `item_meta`. It is the second optional
key, after `live_coding`, and goes after it in key order:

```json
"item_meta": {"fields": ["scene", "path", "script"], "groups": ["rs_hand"], "meta_keys": ["rs_tag"]}
```

- `fields` is a subset of `class`, `script`, `scene` and `path`, written in that order with no
  duplicates.
- `groups` holds at most 31 names; `meta_keys` at most 8. Both are printable ASCII, 1 to 64 bytes
  each, with no duplicates.
- At least one of the three arrays is non-empty. A violation is a hello error (`bad-hello` with
  the field named), as for every other hello key.
- An absent key means "not asked". `null` and `{}` are hello errors. So a client with no
  extension sends the same hello it sends today, byte for byte.
- At /2 to /12 the key is a hello error: those versions are frozen, and TAG is /13 and later.

**The grant reaches the viewer** in the first `item_meta` record of each full. A viewer that asked
learns it was refused because its full transaction arrives with no `item_meta` record before it.
The extensions' `onSession` then reports `itemMeta: null`.

### 2.2 How the host learns identities

**There is no GSW host API.** Godot already has two opt-in tagging mechanisms, and TAG reads them:

- **Groups** (`Node.add_to_group`). TAG reports only membership in the groups the hello names,
  as a bitmask, so the names of other groups never leave the host.
- **Metadata** (`Object.set_meta`). TAG reports the values of the keys the hello names, when they
  are a `String`, `StringName` or `int` (an int is sent as its decimal string). Any other type, or
  no value, is `null`.

A game sets them in `_ready` (or earlier). A mod such as couch's C# mod can set them on nodes it
does not own. Neither needs the capture to be loaded, so a game that tags its nodes still runs
without the capture.

**From RID to node.** The capture sees canvas-item RIDs. `CanvasItem::CanvasItem()` creates the
RID in the constructor (`scene/main/canvas_item.cpp:1729`), before the node has a name, a parent or
a path. No `canvas_item_*` call carries an ObjectID; only 3D has `instance_attach_object_instance_id`.

G8m already has the map TAG needs (`capture/src/rs_adopt.cpp`):
- `g_item_nodes` maps a RID to an instance id;
- the arm-time `Walker` fills it;
- a `SceneTree.node_added` callable (`node_added_call`) keeps it current;
- `node_of(rid)` resolves a node through ObjectDB and re-checks the RID;
- `node_map_prune` drops dead entries.

Today it runs only while adoption resources are active. TAG1 makes it reference-counted, with two
users: adoption and TAG.
- **TAG connects** the `node_added` callable when the first granted connection says hello. It
  fills the map with one tree walk, which is the arm walker's existing visit.
- **TAG disconnects** when the last granted connection closes. The map is then cleared unless
  adoption still holds it.

**When an identity is resolved.** On the main thread, in the frame callback, right after the
snapshot is built (TAG1: after, not before, so that an item the snapshot withheld is not stamped
before a snapshot carries it; "As built (TAG1)"). That is after the frame's `_ready` calls, so tags
set in `_ready` are seen. ObjectDB is not safe on
HC5's formation thread, and `run_job` must not touch it.

The capture keeps a `meta_watermark`, the highest item id it has resolved, and a short `pending`
list of items whose node was not in the tree yet. Each snapshot while TAG is wanted:

1. **New ids.** Ids from `meta_watermark + 1` to `next_item_id_ - 1` are new items (ids are dense
   and never reused). Each is resolved, or added to `pending` when `node_of` finds no node in the
   tree yet.
2. **Pending.** Each `pending` item is retried. An item still unresolved 120 frames after its
   creation is resolved as `node: null` and leaves the list.
3. **Budget.** At most `GRC_ITEM_META_BUDGET_US` µs of this per frame (default 2000). The rest
   waits for the next frame. Overrides then reach those items a frame or two late, and only at a
   screen transition (§5 measures the bursts).
4. **Stamp.** Each resolved entry is stamped with the snapshot's frame. A rekey under
   `GRC_UNKNOWN_ITEM=skip` (`Mirror::rekey_subtree`) copies an entry to the item's new id and
   stamps it at the rekey's frame.

Some items have no node: `TileMapLayer` quadrant RIDs, `Viewport` internals and debug gizmos. They
are resolved as `node: null`. The client treats them as untagged, and they still sit in the item
tree under their parent.

### 2.3 What identifies an item

The record carries these fields per item, for the fields granted:

| field | value | why |
| ----- | ----- | --- |
| `class` | the native class (`Object.get_class`): `Control`, `Label`, `Sprite2D` | cheap. For C# and GDScript nodes it is the engine base class, so `script` names the type |
| `script` | the attached script's resource path (`res://…/NHandCardHolder.cs`), or `null` | names a script type in any language, with no `class_name` / `[GlobalClass]` requirement |
| `scene` | the `scene_file_path` of the item's **instance root**: the node itself if it has a `scene_file_path`, else its `owner`. `null` for a node with no owner | stable across a reparent of the whole instance. This is couch's table key |
| `path` | `instance_root.get_path_to(node)` (`.` for the root itself), or `null` | the scene-relative path. A reparent inside the instance is rare, and a moved node keeps its old path (static, §2.6) |
| `groups` | a bitmask over the hello's granted `groups` (bit i is the i-th name) | membership only; foreign group names never leave the host |
| `meta` | one value per granted `meta_keys` entry (string or `null`) | a game-chosen tag value |

**What it deliberately does not carry:**
- **The absolute node path.** It changes with every reparent, and costs O(depth) string building
  per item.
- **Node names,** which `path`'s last segment already gives.
- **Anything dynamic.** Dynamic context is the stream's own. The item tree (`parent`, `children`),
  transforms, visibility and modulate arrive every frame anyway.

So a rule such as "a card holder whose parent is the hand container, unless a targeting arrow is
visible" is evaluated on the client:
- static identity comes from `item_meta`;
- the parent chain, visibility and rects come from the applier (§3.2's `query`).

### 2.4 The `item_meta` record (wire)

It is a /13 record with a canonical JSON meta, like the session, resource and end records
(render-stream-13.md keeps every non-transaction record JSON). It has no blocks. Keys in order:

```json
{"type": "item_meta",
 "form": "full" | "delta",
 "grant": {"fields": [...], "groups": [...], "meta_keys": [...]} | null,
 "strings_from": <uint>,
 "strings": ["res://scenes/cards/card.tscn", "CardContainer/DescriptionLabel", ...],
 "items": [[<id>, <col>...], ...]}
```

**Strings.** One table per session holds every string any entry has used. Indices are assigned on
first use, in resolution order. A record carries the strings it introduces as the contiguous range
`strings_from .. strings_from + len(strings)`. A `full` record has `strings_from` 0 and every
string up to its target.

**Item rows.**
- A row is `[id, ...]`, with one column per granted field in `class, script, scene, path` order
  (a string index, or `null`), then `groups` (an int) when granted, then one column per granted
  `meta_keys` entry (a string index or `null`).
- An item with no node is `[id]`, a row of length 1. A granted row always has at least one column
  after the id, so the two never collide.
- Rows are sorted by id.

**Which records are sent.**
- **`full`** goes before every full transaction on a granted connection: first full, resync,
  reconnect and coding resync. It carries `grant` and a row for every item of the target state
  that has an entry. It replaces the receiver's table.
- **`delta`** goes before a patch transaction with target T. Its `grant` is `null`. It holds the
  rows of T's items whose stamp is in (F, frame(T)], F the frame of the previous transaction formed
  on this connection (TAG1: not the patch's base B, which window 2 shares between two patches;
  "As built (TAG1)"), and the grant's strings the connection does not hold yet.
  **No delta is sent when it would be empty**, so a warm frame carries no `item_meta` bytes at all.

**Order and sharing.**
- In `Hub::run_job` the record goes after the job's resource records, immediately before the
  transaction. It carries no `seq`: it describes "the next transaction on this connection". That
  keeps its bytes independent of each connection's seq restamping.
- It is formed on the encode thread from a meta snapshot the main thread hands over with the job
  inputs: the entries and strings stamped since the last snapshot. Formation never touches ObjectDB.
- The memo key is (B, T, grant). Lockstep opted-in viewers with the same grant share the raw and
  coded bytes. A coded connection codes it with `coded_plain` and the same memo, as resource
  records are coded (W11t: one plain zstd frame, no envelope).
- It is not a transaction, so W11t's base, which is the last *transaction* formed on the
  connection, does not move. **An opted-in viewer's coded transaction bytes therefore equal an
  opted-out lockstep viewer's, and stay shared.**

**File sinks.**
- With `GRC_ITEM_META` set and a file sink open, the recording carries the records in both lanes:
  a `full` before each full record, and deltas in the patch lane. That lets offline tools and
  extension tests replay identities.
- A recording without them is unchanged.
- `rs-core-check` validates them, and `transcode` (/13 → /12) drops them.

**Validator rules (rs-core and TS, golden-13 vectors).**
- `item_meta` on a connection that did not ask: `item-meta-unexpected`.
- A record not followed by a transaction: `item-meta-orphan`.
- A `full` before a patch, or a `delta` before a full: `item-meta-form`.
- A full transaction on a granted connection with no `full` before it: `item-meta-missing`. Only
  after a `full` has granted; a viewer refused at its first full never sees one.
- A row id that is not an item of the following transaction's target state: `item-meta-id`.
- A string index out of range, or `strings_from` not equal to the table length: `item-meta-string`.
- A column count that does not match the grant, or unsorted or duplicate ids: `item-meta-schema`.

**The receiver's table.**
- It is keyed by item id. It is updated **at receipt**, not at apply, so a transaction that window
  2 folds, or that a stale-coalesce supersedes, still leaves its rows.
- Rows for removed items are dropped when the removal is applied.
- Item ids never repeat in a session (`id-reused`), so a stale row can never name a new item.

### 2.5 Cost

**Off** (no grant, or no connection that asked), which is every pure viewer's case:

| | cost |
| - | - |
| host per frame | one branch (`meta_wanted_`) in the frame callback; nothing per item, no `node_added` callable, no strings |
| host per item | none: no list append and no flag in `create_item` (the watermark finds new items) |
| wire | none: hello byte-identical, no records |
| client | no extension: nothing loaded (modules are the product's dynamic imports), one `if (this.ext)` per frame, `overrides.is_empty()` once per draw |

**On:**

| | cost (estimated; TAG1 measures it) |
| - | - |
| host per CanvasItem entering the tree | one map insert (G8m's `node_added_call`) |
| host per new item | `node_of` plus, per granted field, one to three ptrcalls and a string conversion (`get_class`; `get_script` + `get_path`; `get_scene_file_path` / `get_owner`; `get_path_to`; one `is_in_group` per group; one `get_meta` per key). Estimated 2–10 µs. The pm7 bursts (§5) would then cost 3–17 ms once per screen load, which the 2 ms frame budget spreads |
| host per warm frame | the watermark compare: nothing new, nothing done |
| wire | a few KB at a screen load (§5); 0 B on a warm frame |
| client | JSON parse of a burst record (≈ 35–60 KB raw; sub-ms on desktop, a few ms on the g31) at a screen load; the override copy only when the table is dirty |

### 2.6 Identity rules

- **Static.** An item's row is resolved once. A later reparent, a group change or a meta change is
  not re-sent; the dynamic parts are the item tree. If a product needs a dynamic tag, it uses a
  group on a *child* node it creates for the purpose, or a later version adds an explicit re-tag.
  The latter is not designed here, by the user's static-at-creation rule.
- **Late join.** The joiner's first transaction is a full, so its first record is a `full` with
  every live item that has an entry. When TAG has just turned on (the first granted hello), the
  arm walker fills the node map first, and every existing item is resolved in that frame's
  watermark pass (budgeted like a burst).
- **Rekey (skip mode)** gives fresh ids, and the new ids get rows (§2.2).
- **Adopted items** at arm resolve like created ones; adoption's walk has already filled the map.
- **Reconnect** is a fresh session: a fresh table on the receiver, the same host table.

### 2.7 Removing nodes

- **Per viewer:** an override `visible: false` on the subtree root. The bytes are still sent, so
  the shared encodes stay shared.
- **For every viewer: OMIT (deferred).** `GRC_OMIT_GROUP=<name>` withholds every item whose node is
  in that group at resolution, through unknown-item-skip's withholding
  ([unknown-item-skip.md](unknown-item-skip.md) items 3 to 9: rekey, counters, resources carried).
  It needs the resolution pass to run whether or not a viewer asked, so it is the host operator's
  explicit opt-in.
- **Rejected: per-viewer wire removal.** It would give every opted-in viewer its own diff, encode
  and coded bytes: exactly P3-SP's loss.

## 3. The client: extension API and override table (`@godot-scene-web/render-stream-client`)

### 3.1 API

```ts
export type ItemMetaField = "class" | "script" | "scene" | "path";

export interface RenderStreamExtension {
  readonly id: string;
  /** Merged into the hello's item_meta: fields are unioned; groups and meta keys are unioned in
   *  extension order. Absent on every extension means no item_meta key. */
  readonly wants?: {
    fields?: readonly ItemMetaField[];
    groups?: readonly string[];
    metaKeys?: readonly string[];
  };
  onSession?(s: ExtensionSession): void;         // itemMeta: the grant, or null when refused or not asked
  onItemMeta?(batch: ItemMetaBatch): void;       // at receipt, before the transaction it precedes applies
  onItemsRemoved?(ids: Uint32Array): void;       // at apply
  beforeDraw?(frame: ExtensionFrame): void;      // after apply (or for a redraw), before draw
  dispose?(): void;
}

export interface ItemMeta {
  readonly id: number;
  readonly node: boolean;              // false: an item with no node (TileMap quadrant, viewport internal)
  readonly class?: string | null;
  readonly script?: string | null;
  readonly scene?: string | null;
  readonly path?: string | null;
  readonly groups: readonly string[];  // the granted names this item is in (shared frozen arrays)
  readonly meta: Readonly<Record<string, string | null>>;
}

export interface ItemMetaBatch {
  readonly form: "full" | "delta";     // a full replaces the table
  readonly items: readonly ItemMeta[];
}

export interface ExtensionFrame {
  readonly seq: number | null;         // the newest applied transaction; null on an extension redraw
  readonly now: number;                // rAF time
  readonly overrides: OverrideTable;
  readonly query: ItemQuery;
  requestRedraw(): void;               // draw again on the next rAF with the current overrides
}

export interface OverrideTable {       // retained: an override stays until changed or cleared
  set(id: number, o: {
    transform?: Affine2D;              // presentation-space, pre-multiplied
    modulate?: RGBA;                   // multiplied in
    visible?: boolean;                 // false hides the subtree
  }): void;
  translate(id: number, dx: number, dy: number): void;
  scaleAbout(id: number, sx: number, sy: number, px: number, py: number): void;
  setGlobal(id: number, xf: Affine2D): void;   // computes O = xf · resolved⁻¹
  clear(id: number): void;
  clearAll(): void;
}

export interface ItemQuery {           // reads the applier's current resolved state
  parent(id: number): number | null;
  children(id: number): Uint32Array;
  transform(id: number): Affine2D | null;   // resolved draw transform, before any override
  rect(id: number): Rect | null;            // global AABB of the item's own commands, presentation px
  subtreeRect(id: number): Rect | null;
  visible(id: number): boolean;             // effective (ancestors included)
}

// On RenderStreamClient (INP1):
presentationToCss(r: Rect): Rect;           // for DOM overlays anchored to an item
cssToPresentation(clientX: number, clientY: number): Point | null;
toGame(p: Point): { point: Point; item: number | null };  // inverse of the topmost hit override
```

**One extension list, composed in order.** Overrides that several extensions set on one item
compose in the product's array order. A product that enables no module passes `[]`; its hello and
loop are today's.

### 3.2 The override table in the core

- **Transport into the core.** TS keeps the table. When it is dirty, it copies it into wasm once
  per frame, as packed `Uint32Array` ids plus a `Float32Array` of 11 values per item: 6 affine,
  4 modulate, 1 visible. A clean table is not copied.
- **Composition.** The rs-core applier composes in `cull` and in the rows-only fast path's
  `move_rec`, both in `apply/mod.rs`:

  ```
  final_xf' = O · (parent_xf · it.xform)
  ```

  Children start from `final_xf'`, so the whole subtree moves.
  - Composing in `write_row` alone was rejected: children would not inherit, and cull, clip and
    on-screen rects would not follow.
  - The item's own clip (`clip`, `custom_rect`) is computed from `draw_xf`, so it moves with the
    item.
  - Ancestors' clips still apply (v1). A raised card that leaves a clipping ancestor is clipped
    there. couch's `uiScaling` clip outset would need an `unclip` flag later; it is not designed
    here.
- **Modulate and visibility.** A modulate override multiplies into the item's inherited modulate,
  so children inherit it. `visible: false` culls the subtree.
- **Not overridable in v1: z-index and draw order.** STS2's raises keep the game's order.
- **Damage.** Setting, changing or clearing an override marks the subtree changed for the retained
  presenter (memory `exact-retained-damage-regions`).
- **The empty case.** `overrides.is_empty()` is checked once per apply and once per draw, never
  per item.
- **PH3's loop** (a19faccf: apply in `onmessage`, credit at `applied`, draw on rAF) changes
  nothing here. `onItemMeta` runs in the record's own `onmessage`, before its transaction's.
  `beforeDraw` runs in the rAF callback, before the one draw of the newest applied state. Several
  applies may precede it; each composes the table as it stood. When `beforeDraw` leaves the table
  dirty, the core re-culls only the overridden subtrees (`move_subtree`) before that draw, which is
  the redraw path below. So an override never waits for a transaction, and an apply in `onmessage`
  never calls into an extension.
- **Redraw.** `requestRedraw()` makes the loop run, on the next rAF with no new transaction:
  `beforeDraw` → copy the table → re-cull only the overridden subtrees (`move_subtree`) → draw. A
  redraw acks nothing and asks for no credit. It is how a module animates (§3.3).

**Pixel meaning.** An override draws what the game would have drawn had it applied the same
transform, modulate or visibility to the node at the top of the subtree. TAG2's oracle is the game
itself: a fixture variant that makes that change in Godot (§6). Text scaled by an override
resamples the atlas glyphs. MSDF text stays sharp; bitmap glyphs soften as the scale grows.

### 3.3 Examples (generic; the STS2 versions live in couch)

**1. Hide a tagged subtree.**
```ts
const hide: RenderStreamExtension = {
  id: "example.hide", wants: { groups: ["client_hidden"] },
  onItemMeta: (b) => { for (const m of b.items) if (m.groups.length) ids.add(m.id); dirty = true; },
  beforeDraw: (f) => { if (dirty) { for (const id of ids) f.overrides.set(id, { visible: false }); dirty = false; } },
};
```

**2. A conditional transform.** Raise items of scene `S` at path `P` by 119 px while their parent
is the container at `S2:Q` and no item of group `arrow` is visible. It eases over 150 ms, through
`requestRedraw`.
```ts
beforeDraw(f) {
  const blocked = [...arrows].some((id) => f.query.visible(id));
  let moving = false;
  for (const id of holders) {
    const target = !blocked && containers.has(f.query.parent(id) ?? -1) ? -119 : 0;
    const y = ease(lift.get(id) ?? 0, target, f.now);
    lift.set(id, y);
    f.overrides.translate(id, 0, y);
    moving ||= y !== target;
  }
  if (moving) f.requestRedraw();
}
```

**3. A DOM element anchored to a tagged item's rect.** A confirm button below the focused option:
`client.presentationToCss(f.query.rect(id))` positions an absolutely placed element in the
product's overlay layer. There is no GL injection in v1: anything drawn by the client is DOM,
which keeps the executor free of product draws.

**4. Bigger text without reflow.** For a label `[scene, path]`:
`r = f.query.rect(id)`, then `f.overrides.scaleAbout(id, 1.24, 1.24, r.x + r.w / 2, r.y + r.h)`
(bottom-centre anchor).

**5. Client-side motion of something the game animates in `_process`,** for example smoothing a
tagged item between host frames at a low host refresh rate. The module keeps its own history from
`query.transform`, extrapolates, writes `setGlobal`, and requests redraws. This breaks paired-frame
parity by definition, which is why it is a module (TW's "Not this design").

## 4. Wire impact and the /13 freeze

**TAG changes three things, all additive and all outside the transaction record:**
1. an optional hello key, `item_meta`;
2. a JSON record type, `item_meta`, with its seven error codes and golden-13 vectors;
3. one session-wide invariant the wire already has: item ids are dense, monotonic and never reused
   (render-stream-0 `id-reused`; the capture's `next_item_id_`).

**What the deferred binary syntax must reserve for TAG: nothing.**
- Identity never enters the transaction, and the binary syntax is a transaction-only layer:
  session, resource and end records stay JSON (render-stream-13.md "What /13 is").
- The record-type dispatch already distinguishes a binary transaction (`meta_len = 0`) from a JSON
  record.
- The one requirement on the binary increment is negative: **do not make item ids implicit**, for
  example by deriving new ids from position. Rows name ids explicitly, and the binary syntax
  writes `id` explicitly ("Offsets stay explicit" applies to ids too).
- PRES-A needs nothing either: `presentation:<W>x<H>` and the session's `presentation_size`
  exist since /6.

**Recommendation: TAG lands at /13, before the freeze. W13z waits for TAG1 and TAG2.**
- /13 is not offered by default until W13z, so adding a hello key and a record type is a change to
  /13, not a new version ("Staging"). After W13z it would be /14, and every receiver would carry a
  version switch for an optional record.
- The product moves to /13 at W13z anyway. TAG at /12 is impossible, because /12 is frozen.
- The binary syntax and TAG touch disjoint code (the transaction parse/write layer against the
  hello and record dispatch), so neither waits for the other. The user's hold on the binary syntax
  existed so that the wire would be designed knowing the extension's needs. This note is that
  knowledge, and the answer is that the syntax reserves nothing (Open 1).

## 5. Measurement: how many identities a session sends

`scripts/item-census.py` (new, read-only, summary only) walks a kept recording's transaction metas
with `wire-budget.py`'s reader. It counts item ids that first appear after the opening full, and
items removed. On both kept STS2 recordings, 5,000 frames each (menu, map and combat):

| recording | first full | new items after it | per frame (mean) | transactions with any | bursts (frame: new items) | removed | lifetime p50 / ≤ 30 frames |
| --------- | ---------: | -----------------: | ---------------: | --------------------: | ------------------------- | ------: | -------------------------- |
| `pm7-a12-1` (/12) | 1,137 | 7,288 | 1.47 | 13 of 4,954 (0.26 %) | 17: 1,341; 1,499: 1,193; 1,503: 1,689; 2,250: 1,193; 2,252: 1,310; 2,258: 515; then 24 and six of 3–4 | 4,229 | 751 frames / 0 % |
| `pm-a11-1` (/11) | 1,137 | 7,288 | 1.47 | 12 of 4,946 (0.24 %) | the same shape (16, 1,519–1,521, 2,277–2,285, …) | 4,229 | 758 / 0 % |

What this means for TAG:
- **Identities arrive in screen-load bursts, and a warm frame has none.** 99.7 % of transactions
  would carry no `item_meta` record. Of the 7,288 new items, 7,241 come in six burst frames at
  three screen loads.
- **Peak live items: 4,202.** A late joiner's `full` record has at most that many rows.
- **No short-lived churn.** No item lived 30 frames or fewer, so "once at creation" sends nothing
  wasted.
- **Bytes, estimated.** A row is about 21 B raw (`[12345,3,17,5,88,0],`), so the largest burst
  (1,689 items) is about 35 KB of rows plus its new strings, roughly ≤ 60 KB raw. The transaction
  it precedes is 1,065,304 B raw, so the record is ≤ 6 % of it, and before zstd, which compresses
  the repetitive rows well.
- **Cost, estimated.** At 2–10 µs per item, the same burst is 3–17 ms of main-thread work, which
  the 2 ms per-frame budget spreads over 2–9 frames of a screen load.

TAG1 replaces both estimates with measurements (§6).

Neither recording carries node identity, so the strings could not be sized offline. The per-frame
rate assumes a 60 fps host; per frame is the real unit.

## 6. Increments

Each lands as one commit with its result doc. Timing legs stay real time and go to the milestone
sweep.

**The pure-client-unchanged check** is required of every increment. Each run below compares
`main` with the increment, at /13, on `capture-scale` and `gate6-scene`:
- **Host:** frame callback ms, p50 and p95 (`bench-capture-scale.sh`, real time).
- **Wire:** transaction and session bytes, identical under `cmp-rec.ts`, and the hello string
  identical. These follow host-cost-design.md's byte-identity layers 1 to 3.
- **Client:** apply µs and draw µs per transaction (`profile-rs-core-wasm.mjs` on `pm7-a12-1`
  transcoded to /13, plus a g7-5 GSW live leg's perf timeline).

A no-extension client must agree within run-to-run noise. A wire byte must not move.

| Id | Scope | Fixture | Checks | Sabotages |
| -- | ----- | ------- | ------ | --------- |
| **TAG1** host + wire + validators | `GRC_ITEM_META` grant; the hello key in `rs_live.cpp`'s parser and `ConnectionSummary`/`FormState`; the node map reference-counted (adoption + TAG); watermark, pending list, budget and rekey copy; the meta snapshot handed to formation; `item_meta` record formation (memo (B, T, grant), `coded_plain`); file-sink records; rs-core validator, `Accepted::ItemMeta` and an `ACCEPT_*` code; TS decoder (`render-stream-2.ts`); `rs-core-check`; golden-13 vectors (valid: full, delta, refused; invalid: one per error code) | new `fixtures/tag-scene`: instanced sub-scenes (scene and path), a reparented instance, GDScript scripts, groups set in `_ready`, an int and a string meta value, a `TileMapLayer` (no-node items), a node created one frame before it enters the tree, frees and re-adds; plus `capture-scale` and an unknown-item-skip leg (rekey) | the **pure-client-unchanged** check, with the grant set and no viewer asking, and with no grant; `meta-oracle`: the fixture dumps its own table (RID via `get_canvas_item`, class, script, scene, path, group bits, meta), and every row equals it through the hook log's RID-to-id map; `meta-shared`: two lockstep opted-in viewers get byte-identical records (memo hits counted), and an opted-out viewer on the same host gets the same transaction bytes, raw and coded; `late-join-meta`: a joiner at frame N gets a `full` equal to the table a frame-0 viewer accumulated by frame N; resync, reconnect and rekey legs; on-cost: per-item resolve µs and burst ms on `capture-scale` with its churn creating items (real time) | `meta-in-shared` (append the record to the shared transaction bytes) fails `meta-shared`; `meta-before-ready` (resolve in `node_added`, before `_ready`) fails `meta-oracle` on the groups set in `_ready`; `meta-skip-full` fails the validator's `item-meta-missing`; `meta-id-off-by-one` fails `meta-oracle` and `item-meta-id` |
| **TAG2** GSW client | `RenderStreamExtension` as §3.1; hello merge; receipt and table; `onItemsRemoved`; the override table in rs-core's applier (`cull`, `move_rec`, damage, `is_empty`); `query`; `requestRedraw`; export surface pinned | `tag-scene` variants: `moved` (the game translates node N by (0, −119)), `scaled` (label L scaled 1.24 about its bottom-centre), `hidden` (subtree H invisible), `tinted` (modulate on M) | the **pure-client-unchanged** check (client half, with `extensions: []`); `override-oracle`: the base scene plus an extension that applies the same change by tag is shot-equal (GSW band) to the variant's host shot, for each of the four; `identity-override`: an identity override on every tagged item is pixel-identical to none; `override-redraw`: a 20-frame animated `translate` with no transactions redraws 20 times, acks nothing, and matches the variant at the last step; dispose with overrides set leaves RSS within MIR-1's 15 % | `override-no-inherit` (compose in `write_row` only) fails `override-oracle` on `moved`'s children; `override-no-damage` (skip the damage mark) fails `override-redraw` on the retained presenter; `override-fast-path-miss` (skip `move_rec`) fails `override-oracle` on transform-only frames |
| **INP1** GSW pointer mapping | `cssToPresentation`, `presentationToCss`, `toGame` (hit test in draw order over `rect`, inverse of the hit item's effective override), `query.hitTest(x, y)` | `tag-scene` `moved` | a tap at a raised item's drawn centre maps to its game centre, a tap on a non-overridden item maps to itself, and a letterboxed point maps to `null`; the pure-client-unchanged check (client) | `inverse-skip` (return the point unmapped) fails the raised-item case |
| **PRES-A** viewer-aspect presentation | proves non-16:9 `presentation:<W>x<H>` under `canvas_items` / `expand` end to end; documents the product recipe (launch the seat at the viewer's aspect, cap W) | `gate6-scene` with `aspect=expand` at 2340×1080 and 1920×1080 | GSW and native shots equal their reference at 2340×1080 (gate 6's checks at the new size); the session's `presentation_size` and the stretch keys match; 1920×1080 byte-identical to today | the existing `sabotage-receiver-ignore-presentation` fails at 2340×1080 too |
| **TAG3** couch modules (couch-coop, not GSW) | `stream-ext/raisedHand.ts` (holders, focus ramp, stand-downs, creature HUD), `stream-ext/viewScale.ts` (`uiScaling`'s table as `scaleAbout`, no reflow); the mod tags with groups where scene and path are not enough; `STREAM_RENDER_OVERRIDES` loses each row as its module lands; with `stretchEnabled`, PRES-A's seat launch | couch's own specs, plus one live seat | each module's plan against a recorded `item_meta` and state replay (from TAG1's file-sink records); the module off means an empty extension list and an identical hello; on-cost on the g31 (apply and draw µs with the module on, against off) | a module that writes overrides with nothing changed fails its "dirty only" spec |
| **REC1** client recorder (optional) | a bounded ring of received messages since the last full, plus fetched resources, exported as a recording | g7-5 GSW live leg | the export replays through `rs-core-check` equal to the host's tap from that full; off is zero copies | — |
| **OMIT1** session-wide withhold (deferred) | `GRC_OMIT_GROUP` through unknown-item-skip's withholding | `tag-scene` | the omitted subtree is absent on every viewer and counted; other items byte-identical | — |
| **PRES-Q** client quality levers (deferred) | `backingScale`, shader-time throttle, particle rate cap | — | only when a phone measurement asks for it | — |

**Order:**
- TAG1, then TAG2, then INP1.
- PRES-A is independent and can go first.
- W13z (the freeze) waits for TAG1 and TAG2. The binary syntax is independent of all of them.
- TAG3 follows TAG2 in couch.

## Open for the user

1. **Lift the hold on the binary /13 syntax now?** TAG reserves nothing in the transaction syntax
   (§4), so the binary increment can be scheduled on its own merit. The freeze (W13z) still waits
   for TAG1 and TAG2.
2. **Is widescreen as Godot's own `expand` re-layout acceptable?** The seat would start at the
   viewer's aspect. It replaces the old mirror's hand-written spread rules, and is exact by
   construction, but STS2 decides how its own UI uses the extra width. Is that acceptable, and
   at what cap? Direct view, the host's real game, stays letterboxed.
3. **Is "Enlarge small UI" acceptable without text reflow?** Labels would grow about an anchor and
   could overlap their neighbours, as the user's brief anticipates. The alternative is to keep
   that part of the row off.
4. **Does interaction (input to the game) come before release?** The four input rows need it,
   plus INP1. Today the new renderer is view-only.
5. **Who gets identities?** `GRC_ITEM_META` grants them to every authenticated viewer of a seat.
   In couch every viewer is a player of the same run, so granting all of them looks right, but
   scene, script and node paths can reveal more than the picture does.
6. **Retire the rows that never apply to a stream** (`backstopOcclusion`, `tweenReplay`, the three
   freezes, `staticBgEnabled`)? They would show their forced value permanently under the new
   renderer, and leave `STREAM_RENDER_OVERRIDES` for a separate "not applicable" list.

### Answers (user, 2026-10-30)

1. **The hold is lifted.** The binary syntax is judged on its own long-term merit before the freeze
   (BIN-D).
2. **Yes, `expand` at the viewer's aspect,** kept generic, with per-client tweaks as modules (STS2
   combat rooms likely need one or two), and performance and latency first. The user reviews the
   result. Cap: the product default is 2520 (21:9 at 1080, the old mirror's cap). The game-side
   route (the seat at the viewer's aspect) is to be measured against a client-side spread on TAG2
   overrides (PRES-C). The STS2 host's headed instance cannot change its aspect, so a viewer of it
   needs the client-side route even if the game-side route wins for headless seats.
3. **Yes, no reflow for now.** Reflow, if ever, is an opt-in module, never paid by every client.
4. **Yes, interaction comes before release** (INP1 plus couch's input channel).
5. **Grant minimal fields:** the couch seat grants `scene`, `path`, `script` and the mod's own
   `groups`. A viewer receives them only when a module on its page asks.
6. **Do not retire the rows.** They stay visible and disabled, as levers to measure later:
   - `tweenReplay` is for smooth motion through an intermittent connection, not only bytes;
   - `backstopOcclusion` and `staticBgEnabled` are worth it if they help a GPU-bound phone (the
     g31). The static background was a large client win in the old mirror;
   - the three freezes save **host** cost. A weak host running four instances lags every client,
     and a frozen effect beats that. Freezing with client-side continuation (Spine poses sent once
     and played by the client, tweens through `tweenReplay`) is to be designed (FRZ-D).
7. (PH3) **No playout buffer.** The lowest latency stays the default; a buffer may later be an
   option.

## As built (TAG1)

TAG1 landed the host, the wire record and the validators
([results/p3/tag1.md](../results/p3/tag1.md)). Receivers do not opt in yet (TAG2). Where the
design text above met the code and moved, the text was
corrected in place and the reason is here.

**Opt-in and configuration.**
- `GRC_ITEM_META` is read at arm (a bad name refuses the listener). `GRC_ITEM_META_BUDGET_US`
  (default 2000) is the per-frame budget.
- The /13 hello key is an object with exactly `fields`, `groups` and `meta_keys`, each an array of
  strings. The capture's control parser accepts that one nested value and nothing else. Below /13
  the key is unknown, so it is a hello error as before.
- The grant is the request's fields that `GRC_ITEM_META` names, plus the request's groups and meta
  keys whole when it names `groups` and `meta`. An empty grant is a refusal: no record. The hello's
  live-log line gains `item_meta` and `item_meta_grant` only when the hello asked.
- **Decided: file sinks need their own request.** A recording carries records only under
  `GRC_ITEM_META_FILE` (fields, a comma list), with `GRC_ITEM_META_FILE_GROUPS` and
  `GRC_ITEM_META_FILE_KEYS`, capped by the grant, at /13. A grant alone changes no recording. That
  is what "the grant set and no viewer asking is byte-identical" needs, and a file sink has no hello
  to name groups.

**Resolution (main thread, `rs_item_meta_host.cpp`, identities in `rs_adopt.cpp`).**
- **Off, the frame callback costs one branch:** `g_meta.grant != 0`. With a grant and nobody
  asking, it adds one counter compare (the hub's union version). No node map, no strings, nothing
  per item.
- **The node map is reference-counted.** G8m's `node_added` callable records nodes while adoption
  or TAG holds the map. The first granted hello connects it (unless adoption already has) and fills
  it with one tree walk. Releasing it disconnects and clears it unless adoption still holds it.
- **The resolution order changed.** Resolution runs after the snapshot is built. An id above the
  watermark is resolved only once the mirror has published it (`Item::published`). An item the
  snapshot withheld (`GRC_UNKNOWN_ITEM=skip`) waits, so its stamp is never older than the first
  snapshot that carries it. Before the snapshot, a withheld item's row could be stamped in a range
  its connection had already passed.
- **Pending items back off.** An item with no node in the map is retried at +1, +2, +4 … frames,
  not every frame, until 120 frames after its creation. Then it gets `node: null`. Without backoff,
  capture-scale's 600 RenderingServer-only items cost a retry each per frame for 120 frames.
- **The union of requests.** The host resolves the union of what the granted connections (and the
  file request) ask. When the union grows, every live item is resolved again, which is a reset
  budgeted like a burst. The union only shrinks to nothing, when the last asker leaves.
- **A rekey copies the entry.** The host keeps the last entry per RID. A fresh id whose RID already
  has an entry under another id is a re-key (ids never repeat), so the entry is copied and
  re-stamped, not read again.
- **Identity fields.**
  - `class` is `get_class`.
  - `script` is the script's `resource_path`. An empty path is `null`.
  - `scene` is the instance root's `scene_file_path`. The instance root is the node when that is
    non-empty, else its owner.
  - `path` is `instance_root.get_path_to(node)`, `.` for the root.
  - Group bits come from `is_in_group`.
  - Meta values come from `has_meta`, then `get_meta`: a String or StringName as itself, an int in
    decimal.
  - Strings are interned in their wire spelling (render-stream-0's printable ASCII, `?` elsewhere).

**Formation (encode thread, `rs_item_meta.cpp`; `rs_live.cpp` `Hub::form_item_meta`).**
- **Batches move the main thread's entries.** Each frame's new strings, names and entries are one
  `Batch`, handed to the callback's first job and applied to the hub's `Store` before any record.
  The file publisher has its own `Store`, applied by the publication's first lane job.
- **One string table per grant**, not per host. Every connection with the same grant uses its
  indices, so lockstep viewers of one grant form equal bytes. A grant never receives a string that
  only another grant's columns name.
- **The delta range is per connection.** A connection keeps the stamp it has received up to
  (`meta_stamp`) and its table length (`meta_strings`) in `FormState`. A full resets both.
  - A delta holds the target's entries stamped in (meta_stamp, frame(T)], and the grant's strings
    from `meta_strings` on.
  - The design's (frame(B), frame(T)] was wrong at window 2: two patches can share one base, and
    the second would re-send the first's rows and strings with a `strings_from` the receiver
    already passed.
  - The memo key is (grant table, form, meta_stamp, meta_strings, target). It is the design's
    (B, T, grant) with "what the receiver holds" in place of B.
- **A dropped transaction** (`drop-message`) gets no record, and its connection's range does not
  move.
- **Record framing.** The record is the end record's framing: canonical JSON with `"blocks":[]`
  last, and no block. Keys in order are `type, form, grant, strings_from, strings, items, blocks`.
  The design's key list omitted `blocks`, which every record meta carries. The record counts in
  the end record's `bytes_total` and `max_record_bytes`.
- **Coded records.** On a coded connection the record is coded as a resource record is (one plain
  zstd frame) and kept in the memo with the raw bytes.

**Validators** (rs-core `item_meta.rs` and `validate.rs`; TS `render-stream-2.ts`; seven codes,
golden-13 `item-meta.rs13` and `invalid/item-meta-*.rs13`).
- **Three asks.** The option is Unknown (a recording; the default for every receiver), NotAsked
  (`item-meta-unexpected`), or Asked(request) (the grant must be a subset of the request).
- **Where errors are reported.** `item-meta-form`, `item-meta-missing` and `item-meta-id` are
  reported at the transaction. `item-meta-id` is judged on the applied target and rolled back with
  it.
- **Error order.** The ask and orphan checks read the record's canonical prefix before decoding.
  A full's string errors come before the Asked subset check.
- **An empty delta is valid on the wire.** The host never forms one.
- **Accept codes.** rs-core returns `Accepted::ItemMeta`. GSW's wasm ABI calls it
  `ACCEPT_ITEM_META` = 5. The capi calls it `KIND_ITEM_META` = 6, because 5 is already its
  `KIND_HELD`.
- **Receivers skip it.** GSW (`main.ts`, `live.ts`, the client package's `core.ts`/`loop.ts`) and
  the native receiver (`receiver.gd`) skip the record: nothing to apply, no ack. A held /13 patch
  discards its pending record.
- **Transcode and tools.** `predict::to12` (/13 → /12) drops the records and fixes the end stats.
  `rs-core-check validate` takes `--item-meta-asked <request>|none` and `--item-meta-dump <path>`
  (the final table, plus every id's last row, strings resolved).

**Evidence and test knobs.**
- **Live summary.** `live-summary.json` gives an asking connection `item_meta_request`,
  `item_meta_grant` (null when refused) and `item_meta` {full, delta, bytes, rows, shared}.
- **Host evidence.** `evidence/item-meta.json` (written once TAG ever turned on) holds the host's
  resolution counters and cost: resolved, no_node, rekey_copies, waits, budget stops, resolve and
  pass ns, and bursts.
- **`GRC_ITEM_META_LOG`** writes one line per entry (id, RID, stamp): the RID-to-id map the oracle
  check joins through.
- **`GRC_LIVE_AWAIT_HELLOS=N`** (beside GRT3's `GRC_LIVE_AWAIT_HELLO_MS`) holds the frame until N
  hellos arrived, so viewers started together number their transactions alike.
- **Sabotages** are `GRC_ITEM_META_SABOTAGE` = `in-shared` (the record inside the transaction's
  message), `before-ready` (identities read in `node_added`), `skip-full` (no full record after a
  connection's first) and `id-off-by-one`.

**Fixture and checks.**
- `fixtures/tag-scene` holds instanced `card.tscn` (script, groups and meta set in `_ready`), a
  reparented instance, a TileMapLayer (its quadrant has no node), a node created a frame before it
  enters the tree, a freed and a re-added node, and a node moved through a SubViewport. That move
  re-keys it under a late arm with skip.
- `run-gate8.sh` group `g8tag`, judged by `lib/gate8-tag-checks.ts`, checks:
  - `tag-validate`, `tag-meta-oracle` and `tag-meta-file-oracle`;
  - `tag-meta-shared`, `tag-late-join` and `tag-reconnect`;
  - `tag-rekey`, `tag-resync`, `tag-refused` and `tag-off`;
  - each sabotage `-caught`.
- `fixtures/capture-scale` gains `RS_SCALE_NODES`, `RS_SCALE_NODE_BURST` and `RS_SCALE_NODE_CHURN`
  (default 0) for the on-cost.

## As built (TAG2)

TAG2 landed the GSW client's half ([results/p3/tag2.md](../results/p3/tag2.md)): the extension API
in `@godot-scene-web/render-stream-client` (`src/extensions.ts`) and the override table in rs-core's
applier (`apply/overrides.rs`, composed in `apply/mod.rs`). Where the code moved from §3, it is
here.

**API (§3.1).**
- `Affine2D` is Godot's `Transform2D` in column order, `[x.x, x.y, y.x, y.y, origin.x, origin.y]`,
  the core's own `Xform`. `Rect` is `{x, y, w, h}`; `ItemMetaGrant` spells the meta keys `metaKeys`.
  `mulAffine` and `invertAffine` are exported for modules (and INP1).
- **Added: `ExtensionSession.requestRedraw()`.** Nothing draws while the host sends nothing, so a
  module reacting to something outside the stream (a timer, an input) had no way to reach
  `beforeDraw`. `ExtensionFrame.requestRedraw` only works from inside a frame.
- **`onSession` is announced at the session's first `full` record (its grant), or at its first
  transaction when none came (`itemMeta: null`).** The session record does not carry the grant.
- **Added to `OverrideTable`:** `get(id)`, `size`, and `effective(id)`, the composed override of the
  item and its ancestors (`E`, below). Writing the values an item already has leaves the table
  clean, so a module may rewrite every override every frame and the core sees only changes.
  Non-finite values throw to the module (its error, not the stream's).
- **Added to `ItemQuery`: `meta(id)`**, the item's `ItemMeta`.
- **The queries read the game's state, never an override:** `transform` is the item's draw
  transform from the newest accepted state, `rect` its own lowered commands' AABB under it, `visible`
  the item, its ancestors and its canvas. While a transaction waits for payloads that state is one
  ahead of the picture.
- Every callback runs in a `try`; a module's error is counted and logged once, and the stream goes
  on. An extension list needs unique ids. A `wants` below /13 is a `TypeError` (the key is a hello
  error there).
- **No extension, no work.** `createRenderStreamClient` builds no `ExtensionHost` for `[]`; the
  loop's hooks are each one `if (this.ext)` (receipt of a record or a transaction, apply, draw).
  An extension list that `wants` nothing sends the pure hello. The core's start options are the
  pure client's in every case, so its validator keeps `ItemMetaAsk::Unknown`.

**The table in the core (§3.2).**
- **Composition.** An override is a left factor in presentation space, so an item draws at
  `E · F`: `F` the game's transform, `E = O_n · … · O_1` its own and its ancestors' overrides,
  nearest first. INP1's inverse is `E⁻¹`, which `effective` gives.
- `cull` takes an `ov` flag, read once per walk from `overrides.is_empty()`, and looks the item up
  only when it is set. `move_rec` is generic over the table (`move_rec::<false>` is the code before
  TAG2), picked once per moved root. `cull` was first generic too; the second instance cost
  6.4 KB of wasm (2,505,405 against 2,499,040 bytes) for a test of a bool argument per walked item.
- A modulate override multiplies into the inherited modulate; `visible: false` culls the subtree.
- **Transport.** TS copies the whole table when it is dirty (one `Uint32Array` of ids, one
  `Float32Array` of 11 values each), before the draw. The core records which ids changed:
  - At the next apply, they join the rows-only path's moved roots.
  - Outside an apply (`refresh_overrides`, the redraw path), they are composed at once with
    `move_subtree`, or deferred to the pending apply while a transaction is accepted and not
    applied (its state is ahead of the applier's records).
  - A visibility change, a clip in a moved subtree or a canvas group walks
    (`Why::OVERRIDE`, a new reason bit).
- **Damage is the row upload.** GSW's canvas-items executor redraws the list every draw and
  uploads only the dirty ranges, so the rows it holds are the retained state. Setting, changing
  or clearing an override rewrites the subtree's rows and marks them dirty (`list.dirty.items`).
- **Removed items** leave the core's table at the apply that removes them. Their ids are logged
  for `onItemsRemoved` only while an extension has that callback (`set_log_removed`).
- A coding resync's rebuilt applier inherits the table and the log (`inherit_overrides`).
- **Sabotages:** `override-no-inherit` composes into the item's own row only. `override-no-damage`
  restores the dirty rows after the redraw path's rewrite. `override-fast-path-miss` makes the
  rows-only path of an apply ignore the table; the redraw path still composes it.

**Ready for the next consumers (not built).**
- **INP1** needs no new core state. `toGame` is `invertAffine(overrides.effective(hit))` on the
  point. `presentationToCss` and `cssToPresentation` are the canvas's backing/CSS ratio and the
  session's presentation size. The hit test needs the drawn order and rects. The applier's last
  walk already holds both: `attach` is in draw order, and each entry's `global_rect` is composed
  with the overrides. A `query_hit(x, y)` export can walk it backwards, at no cost to a client that
  never calls it.
- **Client-side freeze-subtree (the static-background lever).** The hook is one more value per
  table entry, `frozen`, with no pure cost:
  - `apply` would test `frozen.is_empty()` once. Only when it is set, it skips the upserts and
    removals of items whose nearest frozen ancestor is in the table, keeping their records (rows,
    lowering, attach entries).
  - The retention sweep already keeps every payload a record still references.
  - Unfreezing marks the subtree changed, and the next apply re-reads it from the state, which the
    validator keeps current regardless.
  - The item map needs no parent links: `state.items` has them.
