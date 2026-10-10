// Fabricated gate 2 evidence trees for self-test-gate2.ts (groups g2a and g2b, G2b2's layout:
// lib/gate2-checks.ts and lib/gate2b-checks.ts headers).
//
// One model of the fixture's texture calls (fixtures/gate2/gate2.gd, expected.json) drives every
// leg: buildModel() writes the hook log (render-stream-resource-log/1, the publisher's store /
// inline lines and the sabotages' own lines included) and the fixture's texture log, then derives
// each frame's texture table by replaying that hook log with gate2b-checks.ts' rules (a freed
// texture stays as a tombstone only while a command still names it), so texture-versions-current
// holds by construction. Texture contents are real render-stream-texture/1 payloads (arbitrary but
// correctly sized data), so every hash is the payload's SHA-256 and stores, caches and inline
// resource records verify. Wire ids follow the real run: A=1 Atwin=2 B=3 M=4 P1=5 P2=6, the
// engine's hue strip 7, set_image's temporaries 8 and 9, C=10 D=11 E=12 (the unsupported variant
// inserts U1 at 7 and shifts the rest); items are expected.json items_at_ready (1..11) plus RAW1
// and RAW2 (12, 13), and the variant's U1 / PRE draws (14, 15).
//
// Receivers are simulated over a recording's transactions (simulateReceiver: fetch or cache hit
// or inline record per new hash, create / update / replace / placeholder uploads of the textures
// commands name, frees of those they stop naming), which reproduces expected.json
// receiver_resources exactly. Shots are synthesizeGate2 PNGs. The live host runs the fixture's
// default frames (S=1, N=10, quit 112) rather than the real S=300, N=60, which no check reads.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  FILE_RESOURCES,
  GATE0_HOOKS,
  summarizeRecording,
} from "../lib/gate0-checks";
import { RESOURCE_LINE_KEYS, type ResourceLine } from "../lib/gate2-checks";
import {
  type Gate2Expected,
  gate2Regions,
  stepFrames2,
  synthesizeGate2,
} from "../lib/gate2-expected";
import { expectedDataBytes } from "../lib/render-stream-2";
import {
  encodeRs2Recording,
  HUE_STRIP_HASH,
  HUE_STRIP_PAYLOAD,
  type RecordingEncodeOptions,
  registerPayload,
  sha256Hex,
  type TCommand,
  type TFilter,
  type TItem,
  type TRepeat,
  type TState,
  type TTexture,
  texturePayload,
} from "./rs2-test-encoder";

// RenderingServer.CanvasItemTextureFilter / CanvasItemTextureRepeat order (render-stream-2.md,
// servers/rendering_server.h:925-942), used to decode a canvas_texture_set_* hook line's `value`.
const FILTER_NAMES: readonly TFilter[] = [
  "default",
  "nearest",
  "linear",
  "nearest_mipmaps",
  "linear_mipmaps",
  "nearest_mipmaps_anisotropic",
  "linear_mipmaps_anisotropic",
];
const REPEAT_NAMES: readonly TRepeat[] = [
  "default",
  "disabled",
  "enabled",
  "mirror",
];

// ---------------------------------------------------------------------------------------------
// Texture contents: real payloads
// ---------------------------------------------------------------------------------------------

export interface Content {
  name: string;
  format: string;
  width: number;
  height: number;
  mipmaps: boolean;
  data_bytes: number;
  payload: Buffer;
  hash: string;
}

const SHAPES: Record<string, [string, number, number, boolean]> = {
  A0: ["RGBA8", 16, 16, false],
  A1: ["RGBA8", 16, 16, false],
  A2: ["RGBA8", 32, 32, false],
  B0: ["LA8", 4, 4, false],
  B1: ["RGBA8", 4, 4, false],
  M: ["RGBA8", 64, 64, true],
  C: ["RGBA8", 16, 16, false],
  D: ["RGBA8", 16, 16, false],
  E: ["RGBA8", 4, 4, false],
  // G2c2: the animate variant's six ANIM contents (k = frame mod 6).
  ANIM0: ["RGBA8", 8, 8, false],
  ANIM1: ["RGBA8", 8, 8, false],
  ANIM2: ["RGBA8", 8, 8, false],
  ANIM3: ["RGBA8", 8, 8, false],
  ANIM4: ["RGBA8", 8, 8, false],
  ANIM5: ["RGBA8", 8, 8, false],
};

function makeContent(name: string, salt: number): Content {
  const [format, width, height, mipmaps] = SHAPES[name];
  const data_bytes = expectedDataBytes(format, width, height, mipmaps);
  const data = new Uint8Array(data_bytes);
  for (let j = 0; j < data_bytes; j++) data[j] = (j * 7 + salt * 41 + 3) & 0xff;
  const payload = texturePayload(format, width, height, mipmaps, data);
  return {
    name,
    format,
    width,
    height,
    mipmaps,
    data_bytes,
    payload,
    hash: registerPayload(payload),
  };
}

export const CONTENT: Record<string, Content> = {
  ...Object.fromEntries(
    Object.keys(SHAPES).map((name, i) => [name, makeContent(name, i + 1)]),
  ),
  HUE: {
    name: "HUE",
    format: "RGBA8",
    width: 800,
    height: 6,
    mipmaps: false,
    data_bytes: 800 * 6 * 4,
    payload: HUE_STRIP_PAYLOAD,
    hash: HUE_STRIP_HASH,
  },
};

const CONTENT_BY_HASH = new Map(Object.values(CONTENT).map((c) => [c.hash, c]));

export function contentOf(hash: string): Content {
  const c = CONTENT_BY_HASH.get(hash);
  if (!c) throw new Error(`gate2b-fixture: no content ${hash}`);
  return c;
}

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

export type Sabotage =
  | "omit-update"
  | "omit-replace"
  | "stale-texture"
  | "wrong-hash"
  | "spurious-update";

export interface ModelOptions {
  quit: number;
  /** unsupported: U1 and PRE; animate (G2c2): ANIM, update()d every frame */
  variant?: "unsupported" | "animate";
  sabotage?: Sabotage;
  /** TR, RAW1 and RAW2 draw with add_texture_rect_region: no add_texture_rect anywhere */
  noTextureRect?: boolean;
  /** the publisher's lines: "store" (out-of-band capture) or "inline" */
  publisher?: "store" | "inline";
  /** G2d, the `canvas` variant: step 11's SC draws through a CanvasTexture CT. "host": a rendered
   * host allocates it (a canvas table entry, SC's command names it); "headless": the dummy
   * storage's canvas_texture_allocate returns RID() (servers/rendering/dummy/storage/
   * texture_storage.h:54), so every canvas_texture_* hook line is a typed refusal with no id and
   * SC's draw an unsupported canvas-texture-headless command. Unset: the main fixture (SC draws A,
   * nearest/enabled on the item). */
  canvas?: "host" | "headless";
}

/** One line of the fixture's RS_FIXTURE_TEXTURE_LOG. */
export interface FixtureLine {
  step: number;
  frame: number;
  op: string;
  name: string;
  thread: "main" | "other";
  format: string | null;
  width: number | null;
  height: number | null;
  mipmaps: boolean | null;
  data_bytes: number | null;
  payload_sha256: string | null;
}

export interface Model {
  options: ModelOptions;
  hook: ResourceLine[];
  fixture: FixtureLine[];
  /** one state per frame 1..quit */
  states: TState[];
  /** fixture texture names (and the temporaries tA, tB) to wire ids */
  ids: Record<string, number>;
  /** texture RIDs each texture-rect op drew (counters.json) */
  drawn: { rect: string[]; region: string[] };
  /** every ok payload a texture table names, in first-use order */
  stores: Array<Content & { first_frame: number }>;
}

export const ITEM = {
  G: 1,
  S1: 2,
  S2: 3,
  TR: 4,
  DR: 5,
  S3: 6,
  BG: 7,
  SB: 8,
  SD: 9,
  MM: 10,
  SC: 11,
  Marker: 12,
  RAW1: 13,
  RAW2: 14,
  U1: 15,
  PRE: 16,
  /** the animate variant's sprite (G2c2) */
  ANIM: 15,
} as const;

export const texRid = (id: number): string => String(1000 + id);
export const itemRid = (id: number): string => String(2000 + id);
export const PRE_RID = "999";
const VIEWPORT_RID = "3000";

/** A render-stream-resource-log/1 line: every key in order, nulls where not given. */
export function line(
  partial: Partial<ResourceLine> & Pick<ResourceLine, "frame" | "op">,
): ResourceLine {
  const base = Object.fromEntries(
    RESOURCE_LINE_KEYS.map((k) => [k, null]),
  ) as unknown as ResourceLine;
  return { ...base, t_us: partial.frame * 1000, thread: "main", ...partial };
}

interface TexState {
  kind: TTexture["kind"];
  status: TTexture["status"];
  reason: TTexture["reason"];
  version: number;
  hash: string | null;
  format: string | null;
  width: number;
  height: number;
  mipmaps: boolean;
  payload_bytes: number;
  /** kind canvas only (G2d). */
  canvas?: { diffuse: number | null; filter: TFilter; repeat: TRepeat };
}

function texEntry(id: number, t: TexState): TTexture {
  if (t.status === "freed" || t.kind === "placeholder")
    return {
      id,
      origin: "created",
      kind: t.kind,
      status: t.status,
      reason: t.status === "freed" ? null : t.reason,
      version: t.version,
      hash: null,
      format: null,
      width: 0,
      height: 0,
      mipmaps: false,
      payload_bytes: 0,
      canvas: null,
    };
  if (t.kind === "canvas")
    return {
      id,
      origin: "created",
      kind: "canvas",
      status: t.status,
      reason: t.reason,
      version: t.version,
      hash: null,
      format: null,
      width: 0,
      height: 0,
      mipmaps: false,
      payload_bytes: 0,
      canvas: t.canvas ?? {
        diffuse: null,
        filter: "default",
        repeat: "default",
      },
    };
  return {
    id,
    origin: "created",
    kind: t.kind,
    status: t.status,
    reason: t.reason,
    version: t.version,
    hash: t.hash,
    format: t.format,
    width: t.width,
    height: t.height,
    mipmaps: t.mipmaps,
    payload_bytes: t.payload_bytes,
    canvas: null,
  };
}

export function stepAt(e: Gate2Expected, frame: number): number {
  let s = 0;
  for (let k = 1; k <= e.last_step; k++)
    if (frame >= stepFrames2(e, k).applied) s = k;
  return s;
}

export function buildModel(e: Gate2Expected, o: ModelOptions): Model {
  const f = (k: number) => (k === 0 ? 1 : stepFrames2(e, k).applied);
  const hook: ResourceLine[] = [];
  const fixture: FixtureLine[] = [];
  const ids: Record<string, number> = {};
  const live = new Map<number, { version: number; kind: TTexture["kind"] }>();
  let next = 1;
  const payload = (c: Content) => ({
    format: c.format,
    width: c.width,
    height: c.height,
    mipmaps: c.mipmaps,
    data_bytes: c.data_bytes,
    payload_bytes: c.payload.length,
    hash: c.hash,
    copy_ns: 500,
    hash_ns: 4000,
  });
  const fix = (
    step: number,
    op: string,
    name: string,
    c: Content | null,
    thread: "main" | "other" = "main",
  ) =>
    fixture.push({
      step,
      frame: f(step),
      op,
      name,
      thread,
      format: c?.format ?? null,
      width: c?.width ?? null,
      height: c?.height ?? null,
      mipmaps: c?.mipmaps ?? null,
      data_bytes: c?.data_bytes ?? null,
      payload_sha256: c?.hash ?? null,
    });
  const create = (
    frame: number,
    c: Content,
    thread: "main" | "other" = "main",
  ) => {
    const id = next++;
    live.set(id, { version: 1, kind: "image" });
    hook.push(
      line({
        frame,
        thread,
        op: "texture_2d_create",
        id,
        rid: texRid(id),
        version: 1,
        kind: "image",
        status: "ok",
        ...payload(c),
      }),
    );
    return id;
  };
  const placeholder = (frame: number) => {
    const id = next++;
    live.set(id, { version: 1, kind: "placeholder" });
    hook.push(
      line({
        frame,
        op: "texture_2d_placeholder_create",
        id,
        rid: texRid(id),
        version: 1,
        kind: "placeholder",
        status: "ok",
      }),
    );
    return id;
  };
  const update = (
    frame: number,
    id: number,
    c: Content,
    mark: { sabotage?: true; omitted?: true } = {},
  ) => {
    const t = live.get(id) as { version: number };
    if (!mark.omitted) t.version++;
    hook.push(
      line({
        frame,
        op: "texture_2d_update",
        id,
        rid: texRid(id),
        version: t.version,
        kind: "image",
        status: "ok",
        ...payload(c),
        layer: 0,
        ...mark,
      }),
    );
  };
  const replace = (frame: number, id: number, by: number, c: Content) => {
    const t = live.get(id) as { version: number; kind: TTexture["kind"] };
    const omitted = o.sabotage === "omit-replace";
    if (!omitted) {
      t.version++;
      t.kind = "image";
      live.delete(by);
    }
    hook.push(
      line({
        frame,
        op: "texture_replace",
        id,
        by_id: by,
        rid: texRid(id),
        version: t.version,
        kind: t.kind,
        status: "ok",
        ...(omitted ? {} : payload(c)),
        target: texRid(by),
        ref_id: by,
        ...(omitted ? { sabotage: true, omitted: true } : {}),
      }),
    );
  };
  const free = (frame: number, id: number) => {
    const t = live.get(id) as { version: number; kind: TTexture["kind"] };
    hook.push(
      line({
        frame,
        op: "free",
        id,
        rid: texRid(id),
        version: t.version,
        kind: t.kind,
        status: "freed",
      }),
    );
    live.delete(id);
  };
  const itemCall = (frame: number, op: string, item: number, value: number) =>
    hook.push(line({ frame, op, target: itemRid(item), value }));
  const C = CONTENT;

  // Frame 1 (_ready): the fixture's objects, the items' filter/repeat on tree entry, the engine's
  // hue strip.
  ids.A = create(1, C.A0);
  fix(0, "texture_2d_create", "A", C.A0);
  ids.Atwin = create(1, C.A0);
  fix(0, "texture_2d_create", "Atwin", C.A0);
  ids.B = create(1, C.B0);
  fix(0, "texture_2d_create", "B", C.B0);
  ids.M = create(1, C.M);
  fix(0, "texture_2d_create", "M", C.M);
  ids.P1 = placeholder(1);
  fix(0, "texture_2d_placeholder_create", "P1", null);
  ids.P2 = placeholder(1);
  fix(0, "texture_2d_placeholder_create", "P2", null);
  if (o.variant === "animate") {
    ids.ANIM = create(1, C.ANIM1);
    fix(0, "texture_2d_create", "ANIM", C.ANIM1);
  }
  if (o.variant === "unsupported") {
    ids.U1 = next++;
    live.set(ids.U1, { version: 1, kind: "image" });
    hook.push(
      line({
        frame: 1,
        op: "texture_2d_create",
        id: ids.U1,
        rid: texRid(ids.U1),
        version: 1,
        kind: "image",
        status: "unsupported",
        reason: "unsupported-format",
        format: "RGBAF",
        width: 4,
        height: 4,
        mipmaps: false,
        data_bytes: 256,
        payload_bytes: 0,
      }),
    );
    fixture.push({
      step: 0,
      frame: 1,
      op: "texture_2d_create",
      name: "U1",
      thread: "main",
      format: "RGBAF",
      width: 4,
      height: 4,
      mipmaps: false,
      data_bytes: 256,
      payload_sha256: null,
    });
  }
  const items = [
    ...e.items_at_ready.map((_, i) => i + 1),
    ...(o.variant === "unsupported" ? [ITEM.U1, ITEM.PRE] : []),
    ...(o.variant === "animate" ? [ITEM.ANIM] : []),
  ];
  for (const item of items) {
    itemCall(1, "canvas_item_set_default_texture_filter", item, 0);
    itemCall(1, "canvas_item_set_default_texture_repeat", item, 0);
  }
  ids.HUE = create(1, C.HUE);

  if (o.sabotage === "spurious-update")
    update(f(2), ids.A, C.A0, { sabotage: true });
  itemCall(f(3), "canvas_item_set_default_texture_filter", ITEM.S2, 2);
  hook.push(
    line({
      frame: f(4),
      op: "viewport_set_default_canvas_item_texture_filter",
      target: VIEWPORT_RID,
      value: 2,
      root_viewport: true,
    }),
    line({
      frame: f(5),
      op: "viewport_set_default_canvas_item_texture_filter",
      target: VIEWPORT_RID,
      value: 1,
      root_viewport: true,
    }),
  );
  itemCall(f(5), "canvas_item_set_default_texture_repeat", ITEM.DR, 3);
  update(
    f(6),
    ids.A,
    C.A1,
    o.sabotage === "omit-update" ? { sabotage: true, omitted: true } : {},
  );
  fix(6, "texture_2d_update", "A", C.A1);
  ids.tA = create(f(7), C.A2);
  fix(7, "texture_2d_create", "A", C.A2);
  replace(f(7), ids.A, ids.tA, C.A2);
  fix(7, "texture_replace", "A", null);
  ids.tB = create(f(7), C.B1);
  fix(7, "texture_2d_create", "B", C.B1);
  replace(f(7), ids.B, ids.tB, C.B1);
  fix(7, "texture_replace", "B", null);
  ids.C = create(f(8), C.C);
  fix(8, "texture_2d_create", "C", C.C);
  free(f(8), ids.Atwin);
  fix(8, "free", "Atwin", null);
  ids.D = create(f(8), C.D, "other");
  fix(8, "texture_2d_create", "D", C.D, "other");
  free(f(8), ids.P1);
  fix(8, "free", "P1", null);
  ids.E = create(f(9), C.E);
  fix(9, "texture_2d_create", "E", C.E);
  replace(f(9), ids.P2, ids.E, C.E);
  fix(9, "texture_replace", "P2", null);
  itemCall(f(9), "canvas_item_set_default_texture_filter", ITEM.MM, 4);

  // Step 11: SC. The main fixture sets nearest (1) / enabled (2) on the item. The canvas variant
  // (G2d) sets linear (2) / disabled (1) on the item and nearest/enabled on a CanvasTexture CT
  // (diffuse A): a rendered host allocates CT (an id, versions 1..4); a headless host refuses
  // every call typed, with no id (rs_resource_log.cpp null_canvas_texture).
  if (o.canvas) {
    const host = o.canvas === "host";
    if (host) {
      ids.CT = next++;
      live.set(ids.CT, { version: 1, kind: "canvas" });
    }
    const ct = (version: number) =>
      host
        ? {
            id: ids.CT,
            rid: texRid(ids.CT),
            version,
            kind: "canvas",
            status: "ok",
          }
        : {
            kind: "canvas",
            status: "unsupported",
            reason: "canvas-texture-headless",
          };
    hook.push(
      line({ frame: f(11), op: "canvas_texture_create", ...ct(1) }),
      line({
        frame: f(11),
        op: "canvas_texture_set_channel",
        ...ct(2),
        target: texRid(ids.A),
        ref_id: ids.A,
        value: 0,
      }),
      line({
        frame: f(11),
        op: "canvas_texture_set_texture_filter",
        ...ct(3),
        value: 1,
      }),
      line({
        frame: f(11),
        op: "canvas_texture_set_texture_repeat",
        ...ct(4),
        value: 2,
      }),
    );
    fix(11, "canvas_texture_create", "CT", null);
  }
  itemCall(
    f(11),
    "canvas_item_set_default_texture_filter",
    ITEM.SC,
    o.canvas ? 2 : 1,
  );
  itemCall(
    f(11),
    "canvas_item_set_default_texture_repeat",
    ITEM.SC,
    o.canvas ? 1 : 2,
  );

  // Scene teardown after the quit frame.
  if (o.variant === "animate")
    for (let frame = 1; frame <= o.quit; frame++) {
      const c = C[`ANIM${frame % 6}`];
      update(frame, ids.ANIM, c);
      fixture.push({
        step: stepAt(e, frame),
        frame,
        op: "texture_2d_update",
        name: "ANIM",
        thread: "main",
        format: c.format,
        width: c.width,
        height: c.height,
        mipmaps: c.mipmaps,
        data_bytes: c.data_bytes,
        payload_sha256: c.hash,
      });
    }
  for (const name of [
    "A",
    "B",
    "M",
    "C",
    "D",
    ...(o.variant === "unsupported" ? ["U1"] : []),
    ...(o.variant === "animate" ? ["ANIM"] : []),
  ])
    free(o.quit + 1, ids[name]);

  // The texture tables: the hook log replayed frame by frame.
  const byFrame = new Map<number, ResourceLine[]>();
  for (const l of hook)
    byFrame.set(l.frame, [...(byFrame.get(l.frame) ?? []), l]);
  const tex = new Map<number, TexState>();
  const states: TState[] = [];
  const drawnRect = new Set<string>();
  const drawnRegion = new Set<string>(
    o.variant === "unsupported" ? [PRE_RID] : [],
  );
  const stores: Model["stores"] = [];
  const stored = new Set<string>();
  const publisherLines: ResourceLine[] = [];
  let staleA: TTexture | undefined;
  for (let frame = 1; frame <= o.quit; frame++) {
    for (const l of byFrame.get(frame) ?? []) {
      if (l.omitted === true || l.id === null) continue;
      const set = () =>
        tex.set(l.id as number, {
          kind: l.kind as TTexture["kind"],
          status: l.status as TTexture["status"],
          reason: l.reason as TTexture["reason"],
          version: l.version as number,
          hash: l.hash,
          // A texture line's format is always a name string (gate5-design.md Q3d: a mesh line's
          // raw ArrayFormat number never shares this column with a texture's name).
          format: l.format as string | null,
          width: l.width ?? 0,
          height: l.height ?? 0,
          mipmaps: l.mipmaps ?? false,
          payload_bytes: l.payload_bytes ?? 0,
        });
      if (
        l.op === "texture_2d_create" ||
        l.op === "texture_2d_placeholder_create" ||
        l.op === "texture_2d_update"
      )
        set();
      else if (l.op === "texture_replace") {
        set();
        if (l.by_id !== null) tex.delete(l.by_id);
      } else if (l.op === "free") {
        const t = tex.get(l.id);
        if (t) tex.set(l.id, { ...t, status: "freed" });
      } else if (l.op === "canvas_texture_create") {
        // Mirror::canvas_texture_create's rid==0 guard (gate2-design.md G2d): a headless
        // (dummy-renderer) capture's hook log still fires with rid null, but never reaches the
        // texture table.
        if (l.rid !== null)
          tex.set(l.id as number, {
            kind: "canvas",
            status: "ok",
            reason: null,
            version: l.version as number,
            hash: null,
            format: null,
            width: 0,
            height: 0,
            mipmaps: false,
            payload_bytes: 0,
            canvas: { diffuse: null, filter: "default", repeat: "default" },
          });
      } else if (
        l.op === "canvas_texture_set_channel" ||
        l.op === "canvas_texture_set_texture_filter" ||
        l.op === "canvas_texture_set_texture_repeat"
      ) {
        if (l.rid === null) continue;
        const t = tex.get(l.id as number);
        if (t?.kind !== "canvas") continue;
        const canvas = {
          ...(t.canvas ?? {
            diffuse: null,
            filter: "default" as TFilter,
            repeat: "default" as TRepeat,
          }),
        };
        if (l.op === "canvas_texture_set_channel" && l.value === 0)
          canvas.diffuse = l.ref_id;
        else if (l.op === "canvas_texture_set_texture_filter")
          canvas.filter = FILTER_NAMES[l.value as number];
        else if (l.op === "canvas_texture_set_texture_repeat")
          canvas.repeat = REPEAT_NAMES[l.value as number];
        tex.set(l.id as number, { ...t, version: l.version as number, canvas });
      }
    }
    const s = stepAt(e, frame);
    const commands = itemsAt(e, o, ids, s);
    const named = new Set<number>();
    for (const it of commands)
      for (const c of it.commands)
        if (c.op === "add_texture_rect" || c.op === "add_texture_rect_region") {
          if (c.tex === null) continue;
          named.add(c.tex);
          (c.op === "add_texture_rect" ? drawnRect : drawnRegion).add(
            texRid(c.tex),
          );
        }
    let textures = [...tex.entries()]
      .filter(([id, t]) => t.status !== "freed" || named.has(id))
      .sort(([a], [b]) => a - b)
      .map(([id, t]) => texEntry(id, t));
    if (o.sabotage === "stale-texture") {
      if (frame === f(6) - 1) staleA = textures.find((t) => t.id === ids.A);
      if (frame >= f(6) && frame < f(7) && staleA) {
        const stale = staleA;
        textures = textures.map((t) => (t.id === ids.A ? stale : t));
      }
    }
    for (const t of textures)
      if (
        t.kind === "image" &&
        t.status === "ok" &&
        t.hash &&
        !stored.has(t.hash)
      ) {
        stored.add(t.hash);
        stores.push({ ...contentOf(t.hash), first_frame: frame });
        publisherLines.push(
          line({
            frame,
            op: o.publisher ?? "store",
            status: "ok",
            payload_bytes: t.payload_bytes,
            hash: t.hash,
          }),
        );
      }
    const unsupported = [
      ...(o.canvas === "headless" && s >= 11
        ? [
            {
              op: "canvas_item_add_texture_rect_region",
              item: ITEM.SC,
              reason: "canvas-texture-headless",
            },
          ]
        : []),
      ...(o.variant === "unsupported"
        ? [
            {
              op: "canvas_item_add_texture_rect_region",
              item: ITEM.U1,
              reason: "unsupported-texture",
            },
            {
              op: "canvas_item_add_texture_rect_region",
              item: ITEM.PRE,
              reason: "unknown-texture",
            },
          ]
        : []),
    ];
    states.push({
      frame,
      failures: [],
      unsupported,
      default_texture_filter: s === 4 ? "linear" : "nearest",
      default_texture_repeat: "disabled",
      canvases: [
        {
          id: 1,
          items: commands.map((it) => it.id),
          xform: [1, 0, 0, 1, 0, 0],
        },
      ],
      items: commands,
      textures,
    });
  }
  const all = [...hook, ...publisherLines].sort((a, b) => a.frame - b.frame);
  return {
    options: o,
    hook: all,
    fixture,
    states,
    ids,
    drawn: { rect: [...drawnRect].sort(), region: [...drawnRegion].sort() },
    stores,
  };
}

/** The items at step `s`: flat on the root canvas, distinct draw indices. */
function itemsAt(
  e: Gate2Expected,
  o: ModelOptions,
  ids: Record<string, number>,
  s: number,
): TItem[] {
  const region = (tex: number): TCommand => ({
    op: "add_texture_rect_region",
    tex,
    rect: [0, 0, 16, 16],
    src: [0, 0, 16, 16],
    modulate: [1, 1, 1, 1],
  });
  const rect = (tex: number): TCommand =>
    o.noTextureRect
      ? region(tex)
      : {
          op: "add_texture_rect",
          tex,
          rect: [0, 0, 32, 32],
          modulate: [1, 1, 1, 1],
        };
  const item = (
    id: number,
    commands: TCommand[],
    extra: Partial<TItem> = {},
  ): TItem => ({
    id,
    parent: { kind: "canvas", id: 1 },
    children: [],
    visible: true,
    draw_index: id >= ITEM.RAW1 && id <= ITEM.RAW2 ? 988 + id : id,
    z_index: 0,
    visibility_layer: 1,
    content_version: 1,
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    commands,
    ...extra,
  });
  const marker = e.steps[s].marker_rgba8.map((v) => v / 255);
  return [
    item(ITEM.G, []),
    item(ITEM.S1, [region(ids.A)]),
    item(ITEM.S2, [region(ids.A)], {
      texture_filter: s >= 3 ? "linear" : "default",
    }),
    item(ITEM.TR, [rect(ids.A)]),
    item(ITEM.DR, [region(ids.A)], {
      texture_repeat: s >= 5 ? "mirror" : "default",
    }),
    item(ITEM.S3, [region(s >= 8 ? ids.C : ids.Atwin)], {
      content_version: s >= 8 ? 2 : 1,
    }),
    item(ITEM.BG, []),
    item(ITEM.SB, [region(ids.B)]),
    item(ITEM.SD, s >= 8 ? [region(ids.D)] : [], {
      content_version: s >= 8 ? 2 : 1,
    }),
    item(ITEM.MM, s >= 9 ? [region(ids.M)] : [], {
      content_version: s >= 9 ? 2 : 1,
      texture_filter: s >= 9 ? "linear_mipmaps" : "default",
    }),
    item(
      ITEM.SC,
      s < 11
        ? []
        : o.canvas === "headless"
          ? [
              {
                op: "unsupported",
                name: "canvas_item_add_texture_rect_region",
                reason: "canvas-texture-headless",
              },
            ]
          : [
              {
                op: "add_texture_rect_region",
                tex: o.canvas === "host" ? ids.CT : ids.A,
                rect: [0, 0, 64, 64],
                src: [0, 0, 64, 64],
                modulate: [1, 1, 1, 1],
              },
            ],
      {
        content_version: s >= 11 ? 2 : 1,
        texture_filter: s < 11 ? "default" : o.canvas ? "linear" : "nearest",
        texture_repeat: s < 11 ? "default" : o.canvas ? "disabled" : "enabled",
      },
    ),
    item(
      ITEM.Marker,
      [{ op: "add_rect", rect: [0, 0, 32, 32], color: marker }],
      {
        content_version: 1 + s,
      },
    ),
    item(ITEM.RAW1, [rect(ids.P1)]),
    item(ITEM.RAW2, [rect(ids.P2)]),
    ...(o.variant === "animate" ? [item(ITEM.ANIM, [region(ids.ANIM)])] : []),
    ...(o.variant === "unsupported"
      ? [
          item(ITEM.U1, [region(ids.U1)]),
          item(ITEM.PRE, [
            {
              op: "unsupported",
              name: "canvas_item_add_texture_rect_region",
              reason: "unknown-texture",
            },
          ]),
        ]
      : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------------

/** The session `resources` of capture-inline: everything in band, no store. */
export const INLINE_RESOURCES = {
  ...FILE_RESOURCES,
  delivery: "inline",
  inline_max_bytes: 16777216,
  max_payload_bytes: 16777216,
  fetch: "none",
};

export function encodeSink(
  states: readonly TState[],
  encoding: "full" | "patch",
  extra: Partial<RecordingEncodeOptions> = {},
): Buffer {
  return encodeRs2Recording(states, {
    encoding,
    hooksPlanned: [...GATE0_HOOKS],
    ...extra,
  });
}

export interface Tx {
  seq: number;
  frame: number;
  encoding: string;
  sha256: string;
}

export function transactionsOf(bytes: Uint8Array): Tx[] {
  return summarizeRecording("", bytes).transactions.map((t) => ({
    seq: t.meta.seq,
    frame: t.meta.frame,
    encoding: t.meta.encoding,
    sha256: t.sha256,
  }));
}

// ---------------------------------------------------------------------------------------------
// Receivers
// ---------------------------------------------------------------------------------------------

export interface Upload {
  id: number;
  hash: string | null;
  op: string;
  data_bytes: number;
  stream: number;
  seq: number;
}

export interface Fetch {
  stream: number;
  seq: number;
  hash: string;
  source: string;
  status: null;
  bytes: number;
  start_us: number;
  end_us: number;
  verified: boolean;
}

export interface Simulation {
  /** applied.json /3 per-transaction resource counters, by seq */
  resources: Map<number, Record<string, number>>;
  fetches: Fetch[];
  uploads: Upload[];
  /** hashes fetched or hit, in order */
  acquired: string[];
}

/** A receiver over `txs` of `model` (the state of each transaction is the model's at its frame):
 * the textures commands name are created, updated or replaced as their table entries change
 * (the hook log's op at that frame tells update from replace), a payload is fetched from the
 * store directory once per process (or hit in a warm cache, or counted as an inline record when
 * the stream first carries it), and a texture no command names any more is freed. */
export function simulateReceiver(
  model: Model,
  txs: readonly Tx[],
  source: "directory" | "inline",
  warm: ReadonlySet<string> = new Set(),
): Simulation {
  const resources = new Map<number, Record<string, number>>();
  const fetches: Fetch[] = [];
  const uploads: Upload[] = [];
  const acquired: string[] = [];
  const memory = new Set<string>();
  const carried = new Set<string>();
  const have = new Map<number, { version: number; hash: string | null }>();
  for (const tx of txs) {
    const state = model.states[tx.frame - 1];
    const r: Record<string, number> = {
      fetched: 0,
      fetched_bytes: 0,
      cache_hits: 0,
      inline_received: 0,
      created: 0,
      updated: 0,
      replaced: 0,
      freed: 0,
      upload_bytes: 0,
      fetch_us: 0,
      skipped_commands: 0,
    };
    const table = new Map((state.textures ?? []).map((t) => [t.id, t]));
    if (source === "inline")
      for (const t of table.values())
        if (
          t.kind === "image" &&
          t.status === "ok" &&
          t.hash &&
          !carried.has(t.hash)
        ) {
          carried.add(t.hash);
          memory.add(t.hash);
          r.inline_received++;
        }
    const acquire = (hash: string) => {
      if (memory.has(hash)) return;
      memory.add(hash);
      acquired.push(hash);
      if (warm.has(hash)) {
        r.cache_hits++;
        return;
      }
      const bytes = contentOf(hash).payload.length;
      r.fetched++;
      r.fetched_bytes += bytes;
      r.fetch_us += 40;
      fetches.push({
        stream: 1,
        seq: tx.seq,
        hash,
        source: "directory",
        status: null,
        bytes,
        start_us: 1000 * tx.seq,
        end_us: 1000 * tx.seq + 40,
        verified: true,
      });
    };
    const named = new Set<number>();
    for (const it of state.items)
      for (const c of it.commands)
        if (
          (c.op === "add_texture_rect" || c.op === "add_texture_rect_region") &&
          c.tex !== null
        )
          named.add(c.tex);
    const upload = (id: number, hash: string | null, op: string) => {
      const data_bytes = hash ? contentOf(hash).data_bytes : 0;
      uploads.push({ id, hash, op, data_bytes, stream: 1, seq: tx.seq });
      r.upload_bytes += data_bytes;
    };
    for (const id of [...named].sort((a, b) => a - b)) {
      const e = table.get(id);
      if (e?.status !== "ok") {
        if (e?.status === "unsupported" && tx.seq === 1) r.skipped_commands++;
        continue;
      }
      const prev = have.get(id);
      if (!prev) {
        if (e.kind === "placeholder" || e.kind === "canvas")
          upload(id, null, e.kind === "placeholder" ? "placeholder" : "canvas");
        else {
          acquire(e.hash as string);
          upload(id, e.hash, "create");
        }
        r.created++;
      } else if (prev.version !== e.version && prev.hash !== e.hash) {
        const replaced = model.hook.some(
          (l) =>
            l.op === "texture_replace" &&
            l.id === id &&
            l.frame === tx.frame &&
            l.omitted !== true,
        );
        acquire(e.hash as string);
        upload(id, e.hash, replaced ? "replace" : "update");
        if (replaced) r.replaced++;
        else r.updated++;
      }
      have.set(id, { version: e.version, hash: e.hash });
    }
    for (const id of [...have.keys()])
      if (!named.has(id) || table.get(id)?.status === "freed") {
        have.delete(id);
        r.freed++;
      }
    if (model.options.variant === "unsupported" && tx.seq === 1)
      r.skipped_commands++;
    resources.set(tx.seq, r);
  }
  return { resources, fetches, uploads, acquired };
}

export interface ReceiverSpec {
  /** the recording bytes the receiver read (written as its own copy, or received.rs2 live) */
  recording: Buffer;
  txs: Tx[];
  sim: Simulation;
  mode?: "file" | "live";
  cache: { dir: string; mode: "fresh" | "warm"; entries_before: number };
  /** seq -> PNG */
  shots?: Map<number, Buffer>;
  /** seq -> state dump */
  states?: Map<number, string>;
  unsupported?: Array<{
    seq: number;
    item: number;
    name: string;
    reason: string;
  }>;
  /** applied transactions stop before this seq, with this failure */
  failure?: { seq: number; reason: string; detail: string };
  /** write the fetched payloads into cache/ */
  writeCache?: boolean;
  headless?: boolean;
}

export async function writeReceiver(
  dir: string,
  spec: ReceiverSpec,
): Promise<void> {
  const live = spec.mode === "live";
  const recPath = join(dir, live ? "received.rs2" : "recording.rs2");
  await mkdir(dir, { recursive: true });
  await writeFile(recPath, spec.recording);
  await writeProcess(dir, {
    argv: `/tpl/linux_release.x86_64\n${spec.headless || live ? "--headless\n" : ""}--path\n/repo/experiments/render-stream/receiver\n`,
    stdout: "[receiver] end seen\n",
    exit: spec.failure ? 1 : 0,
  });
  // A failing receiver applied every transaction before the failing one; its fetches run up to
  // the failing one.
  const last = spec.failure ? spec.failure.seq : Number.POSITIVE_INFINITY;
  const txs = spec.txs.filter((t) => t.seq < last);
  const fetches = spec.sim.fetches.filter((x) => x.seq <= last);
  const fetchedHashes = [...new Set(fetches.map((x) => x.hash))];
  const sizeOf = (hashes: readonly string[]) =>
    hashes.reduce((n, h) => n + contentOf(h).payload.length, 0);
  const verified = [
    ...new Set(fetches.filter((x) => x.verified).map((x) => x.hash)),
  ];
  const cached = spec.cache.mode === "fresh" ? verified : spec.sim.acquired;
  if (spec.writeCache)
    for (const h of verified)
      await writeBytes(
        join(spec.cache.dir, "sha256", `${h}.grt`),
        contentOf(h).payload,
      );
  const uploads = spec.sim.uploads.filter((u) => u.seq < last);
  const shots = [...(spec.shots?.keys() ?? [])];
  for (const [seq, png] of spec.shots ?? [])
    await writeBytes(join(dir, "shots", `seq-${seq}.png`), png);
  for (const [seq, json] of spec.states ?? [])
    await writeText(join(dir, "state", `seq-${seq}.json`), json);
  await writeJson(join(dir, "applied.json"), {
    schema: "render-stream-receiver-applied/3",
    mode: live ? "live" : "file",
    recording: {
      path: recPath,
      sha256: sha256Hex(spec.recording),
      bytes: spec.recording.length,
    },
    session_id: "0123456789abcdef0123456789abcdef",
    status: spec.failure ? "replay-failure" : "ok",
    failure: spec.failure ?? null,
    end_seen: !spec.failure,
    viewport: {
      display_server: spec.headless || live ? "headless" : "X11",
      size: spec.headless || live ? [64, 64] : [640, 360],
      size_check: spec.headless || live ? "skipped-headless" : "ok",
      logical_size: [640, 360],
    },
    transactions: txs.map((t) => ({
      stream: 1,
      seq: t.seq,
      frame: t.frame,
      encoding: t.encoding,
      record_sha256: t.sha256,
      rs_calls: 150 + (t.frame % 7),
      resources: spec.sim.resources.get(t.seq) ?? null,
    })),
    shots: shots.map((seq) => ({
      stream: 1,
      seq,
      step: null,
      path: join(dir, "shots", `seq-${seq}.png`),
      state_path: spec.states ? join(dir, "state", `seq-${seq}.json`) : null,
      applied_through: seq,
    })),
    unsupported: spec.unsupported ?? [],
    cache: {
      dir: spec.cache.dir,
      mode: spec.cache.mode,
      entries_before: spec.cache.entries_before,
      entries_after: Math.max(spec.cache.entries_before, cached.length),
      bytes_after: sizeOf(cached),
    },
    fetches,
    uploads,
    resources_summary: {
      distinct_fetched: fetchedHashes.length,
      fetched_bytes: sizeOf(fetchedHashes),
      cache_hits: txs.reduce(
        (n, t) => n + (spec.sim.resources.get(t.seq)?.cache_hits ?? 0),
        0,
      ),
      uploads: uploads.filter((u) => u.op !== "placeholder").length,
      upload_bytes: uploads.reduce((n, u) => n + u.data_bytes, 0),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const jsonl = (rows: readonly object[]): string =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
export async function writeBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeProcess(
  dir: string,
  p: { argv?: string; stdout?: string; exit?: number } = {},
): Promise<void> {
  await writeText(
    join(dir, "argv.txt"),
    p.argv ?? "/tpl/linux_release.x86_64\n",
  );
  await writeText(join(dir, "env.txt"), "GRC_MODE=arm\n");
  await writeText(
    join(dir, "stdout.log"),
    p.stdout ?? "[fixture] gate2 ready\n",
  );
  await writeText(join(dir, "exit-code.txt"), `${p.exit ?? 0}\n`);
}

export function stepLog(e: Gate2Expected): string {
  return jsonl(
    e.steps.map((s) => {
      const f = stepFrames2(e, s.step);
      return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
    }),
  );
}

/** evidence/: result.json, counters.json (the texture RIDs drawn), root.json, the hook log. */
export async function writeEvidence(
  dir: string,
  model: Model,
  drawn: Model["drawn"] = model.drawn,
): Promise<void> {
  await writeJson(join(dir, "evidence", "result.json"), {
    schema: "render-stream-capture-result/1",
    status: "armed",
    reason: null,
    vptr_written: true,
    disarmed: true,
    display_server: "headless",
    stream: {
      path: join(dir, "recording.rs2"),
      patch_path: join(dir, "recording-patch.rs2"),
      status: "closed",
      reason: null,
      transactions: model.options.quit,
    },
  });
  await writeCounters(dir, model.options.quit, drawn);
  await writeJson(join(dir, "evidence", "root.json"), {
    schema: "render-stream-root-geometry/1",
    texture_defaults: { filter: 0, repeat: 0 },
  });
  await writeText(join(dir, "evidence", "armed.marker"), "");
  await writeText(join(dir, "evidence", "resources.jsonl"), jsonl(model.hook));
}

export async function writeCounters(
  dir: string,
  quit: number,
  drawn: Model["drawn"],
): Promise<void> {
  await writeJson(join(dir, "evidence", "counters.json"), {
    schema: "render-stream-gate-minus1-counters/1",
    frames_total: quit,
    hooks_planned: [...GATE0_HOOKS],
    hooks_omitted: [],
    captured: {
      canvas_item_add_texture_rect: drawn.rect.map((texture) => ({
        item: "7",
        texture,
      })),
      canvas_item_add_texture_rect_region: drawn.region.map((texture) => ({
        item: "8",
        texture,
      })),
    },
    captured_dropped: {
      canvas_item_add_texture_rect: 0,
      canvas_item_add_texture_rect_region: 0,
    },
  });
}

export interface CaptureFiles {
  full: Buffer;
  patch: Buffer;
  fullTx: Tx[];
  patchTx: Tx[];
}

/** A capture host directory: both sinks, evidence, the fixture's logs and (out of band) the
 * store with its index. */
export async function writeCapture(
  dir: string,
  e: Gate2Expected,
  model: Model,
  opts: { inline?: boolean; sessionId?: string; rendered?: boolean } = {},
): Promise<CaptureFiles> {
  const extra: Partial<RecordingEncodeOptions> = {
    sessionId: opts.sessionId,
    rendered: opts.rendered,
    ...(opts.inline ? { resources: INLINE_RESOURCES } : {}),
  };
  const full = encodeSink(model.states, "full", extra);
  const patch = encodeSink(model.states, "patch", extra);
  await writeProcess(dir, {
    stdout: `[fixture] gate2 ready\nstream: store ${model.stores.length} payloads retained_bytes_max=${model.stores.reduce((n, c) => n + c.payload.length, 0)}\n`,
  });
  await writeBytes(join(dir, "recording.rs2"), full);
  await writeBytes(join(dir, "recording-patch.rs2"), patch);
  await writeEvidence(dir, model);
  await writeText(join(dir, "textures.jsonl"), jsonl(model.fixture));
  await writeText(join(dir, "steps.jsonl"), stepLog(e));
  if (!opts.inline) await writeStore(join(dir, "store"), model.stores);
  return {
    full,
    patch,
    fullTx: transactionsOf(full),
    patchTx: transactionsOf(patch),
  };
}

export async function writeStore(
  dir: string,
  stores: Model["stores"],
): Promise<void> {
  for (const c of stores)
    await writeBytes(join(dir, "sha256", `${c.hash}.grt`), c.payload);
  await writeText(
    join(dir, "index.jsonl"),
    jsonl(
      stores.map((c) => ({
        hash: c.hash,
        bytes: c.payload.length,
        format: c.format,
        width: c.width,
        height: c.height,
        mipmaps: c.mipmaps,
        first_frame: c.first_frame,
      })),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

const PNGS = new Map<string, Promise<Buffer>>();

/** A shot of step `step`: synthesizeGate2 (the unsupported variant's on request), optionally with
 * the variant's U1 / U2 draws skipped (clear colour) and one pixel flipped. */
export function shotPng(
  e: Gate2Expected,
  step: number,
  o: {
    variant?: "unsupported" | "animate";
    /** the frame a shot shows (the animate variant's ANIM content) */
    frame?: number;
    skipUnsupported?: boolean;
    perturb?: [number, number];
    /** G2d: blanks this named region (expected.json regions) to the clear colour, simulating a
     * skipped (D10) draw -- canvas-normal's SC from step 11 on. */
    blankRegion?: string;
  } = {},
): Promise<Buffer> {
  const key = JSON.stringify([step, o]);
  let png = PNGS.get(key);
  if (!png) {
    const { width, height, rgba } = synthesizeGate2(e, step, {
      variant: o.variant,
      frame: o.frame,
    });
    const buf = Buffer.from(rgba);
    if (o.skipUnsupported) {
      const draws =
        e.variants.unsupported.steps.find((s) => s.step === step)?.draws ?? [];
      for (const d of draws) {
        const [x0, y0, w, h] = d.rect_px;
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++)
            buf.set(e.clear_rgba8, (y * width + x) * 4);
      }
    }
    if (o.blankRegion) {
      const r = gate2Regions(e, step)[o.blankRegion];
      if (r) {
        const [x0, y0, w, h] = r;
        for (let y = y0; y < y0 + h; y++)
          for (let x = x0; x < x0 + w; x++)
            buf.set(e.clear_rgba8, (y * width + x) * 4);
      }
    }
    if (o.perturb) buf[(o.perturb[1] * width + o.perturb[0]) * 4] ^= 0x10;
    png = sharp(buf, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    PNGS.set(key, png);
  }
  return png;
}

export function settleSeqs(e: Gate2Expected): number[] {
  return e.steps.map((s) => stepFrames2(e, s.step).settle);
}

async function shotsOf(
  e: Gate2Expected,
  shot: (step: number) => Promise<Buffer>,
): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>();
  for (const s of e.steps)
    out.set(stepFrames2(e, s.step).settle, await shot(s.step));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The whole tree
// ---------------------------------------------------------------------------------------------

export interface TreeOptions {
  /** the main capture's model draws no add_texture_rect (leg-class-capture fails) */
  noTextureRect?: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const CAPTURE_QUIT = 400;

export async function buildTree(
  out: string,
  e: Gate2Expected,
  opts: TreeOptions = {},
): Promise<void> {
  const quit = e.quit_frame_default;
  await writeJson(join(out, "legs.json"), {
    groups_run: ["g2a", "g2b", "g2c", "g2d", "g2e"],
    groups_landed: ["g2a", "g2b", "g2c", "g2d", "g2e"],
  });
  await writeJson(join(out, "binary.json"), {
    path: "/tpl/linux_release.x86_64",
    sha256: "54cc",
  });
  await writeProcess(join(out, "import", "fixture"));
  await writeProcess(join(out, "import", "receiver"));

  // g2a: the capture, the references, the unsupported variant.
  const main = buildModel(e, {
    quit: CAPTURE_QUIT,
    noTextureRect: opts.noTextureRect,
  });
  const capDir = join(out, "capture");
  const cap = await writeCapture(capDir, e, main);
  await writeText(
    join(capDir, "strace.txt"),
    [
      '42 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
      `42 10:00:00.200000 openat(AT_FDCWD, "${join(capDir, "evidence", "armed.marker")}", O_WRONLY|O_CREAT, 0666) = 7`,
      "",
    ].join("\n"),
  );
  await writeText(
    join(capDir, "maps.txt"),
    "55d000000000-55d000001000 r-xp 00000000 103:09 1 /tpl/linux_release.x86_64\n",
  );
  await writeText(
    join(capDir, "fd.txt"),
    "lrwx------ 1 u u 64 Oct  9 10:00 0 -> /dev/null\n",
  );

  const variant = buildModel(e, { quit, variant: "unsupported" });
  const unsupported = await writeCapture(
    join(out, "capture-unsupported"),
    e,
    variant,
    { sessionId: "0123456789abcdef0123456789abc0f0" },
  );

  const armed = buildModel(e, { quit, noTextureRect: opts.noTextureRect });
  for (const leg of ["reference", "reference-repeat", "reference-armed"]) {
    const dir = join(out, leg);
    await writeProcess(dir);
    await writeText(join(dir, "steps.jsonl"), stepLog(e));
    await writeText(join(dir, "textures.jsonl"), jsonl(armed.fixture));
    for (const s of e.steps)
      await writeBytes(
        join(dir, "shots", `step-${s.step}.png`),
        await shotPng(e, s.step),
      );
  }
  await writeEvidence(join(out, "reference-armed"), armed);
  await writeBytes(
    join(out, "reference-armed", "recording.rs2"),
    encodeSink(armed.states, "full", {
      sessionId: "0123456789abcdef0123456789abcafe",
    }),
  );

  // G2d: the `canvas` variant. canvas-headless: a headless capture host refuses the CanvasTexture
  // typed (canvas-texture-headless), and its headless receiver skips and reports SC's draw.
  const headlessCanvas = buildModel(e, { quit, canvas: "headless" });
  const headlessCanvasCap = await writeCapture(
    join(out, "canvas-headless", "capture"),
    e,
    headlessCanvas,
    { sessionId: "0123456789abcdef0123456789abcd0e" },
  );
  await writeReceiver(join(out, "canvas-headless", "receiver"), {
    recording: headlessCanvasCap.full,
    txs: headlessCanvasCap.fullTx,
    sim: simulateReceiver(
      headlessCanvas,
      headlessCanvasCap.fullTx,
      "directory",
    ),
    cache: {
      dir: join(out, "canvas-headless", "receiver", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
    unsupported: [
      {
        seq: stepFrames2(e, 11).applied,
        item: ITEM.SC,
        name: "canvas_item_add_texture_rect_region",
        reason: "canvas-texture-headless",
      },
    ],
    headless: true,
  });
  // canvas-host, canvas-normal and sabotage-omit-canvas-filter: rendered capture hosts
  // (host-renderer evidence), each derived from the host model from frame 111 (step 11, CT's
  // creation) on. classifyG2bLeg's texture-log-divergence runs over every leg, so canvas-normal's
  // hook log must also show CT going unsupported, not just its recording.
  const host = buildModel(e, { quit, canvas: "host" });
  const ctId = host.ids.CT;
  const patchedHost = (
    patch: (t: TTexture) => void,
    extraUnsupported?: { op: string; item: number | null; reason: string },
    extraHook?: ResourceLine[],
  ): Model => ({
    ...host,
    // host.hook runs frame-ascending (step 11's CT lines, then the post-quit teardown frees);
    // extraHook must land among step 11's own lines, or replayLog's frame order breaks.
    hook: extraHook
      ? ((): ResourceLine[] => {
          const h = [...host.hook];
          const at = extraHook[0].frame;
          const idx = h.findIndex((l) => l.frame > at);
          h.splice(idx === -1 ? h.length : idx, 0, ...extraHook);
          return h;
        })()
      : host.hook,
    states: host.states.map((s) => {
      if (s.frame < stepFrames2(e, 11).applied) return s;
      const textures = (s.textures ?? []).map((t) =>
        t.id === ctId
          ? ((): TTexture => {
              const copy = clone(t);
              patch(copy);
              return copy;
            })()
          : t,
      );
      const unsupported = extraUnsupported
        ? [...(s.unsupported ?? []), extraUnsupported]
        : s.unsupported;
      return { ...s, textures, unsupported };
    }),
  });
  const rendered = async (
    leg: string,
    model: Model,
    shot: (k: number) => Promise<Buffer>,
  ) => {
    const cap = await writeCapture(join(out, leg, "capture"), e, model, {
      rendered: true,
    });
    for (const s of e.steps)
      await writeBytes(
        join(out, leg, "capture", "shots", `step-${s.step}.png`),
        await shotPng(e, s.step),
      );
    await writeReceiver(join(out, leg, "receiver"), {
      recording: cap.full,
      txs: cap.fullTx,
      sim: simulateReceiver(model, cap.fullTx, "directory"),
      cache: {
        dir: join(out, leg, "receiver", "cache"),
        mode: "fresh",
        entries_before: 0,
      },
      shots: await shotsOf(e, shot),
    });
  };
  await rendered("canvas-host", host, (k) => shotPng(e, k));
  // The real fixture (gate2.gd) sets CT.normal_texture = B only after create/diffuse/filter/
  // repeat (all still "ok"), so the hook log picks up the channel-1 (normal) call as its own
  // extra line at v5/unsupported -- matching rs_resource_log.cpp recomputing status per op.
  const ctFrame = stepFrames2(e, 11).applied;
  await rendered(
    "canvas-normal",
    patchedHost(
      (t) => {
        t.status = "unsupported";
        t.reason = "canvas-texture-channel";
        t.version = 5;
      },
      {
        op: "canvas_item_add_texture_rect_region",
        item: ITEM.SC,
        reason: "unsupported-texture",
      },
      [
        line({
          frame: ctFrame,
          op: "canvas_texture_set_channel",
          id: ctId,
          rid: texRid(ctId),
          version: 5,
          kind: "canvas",
          status: "unsupported",
          reason: "canvas-texture-channel",
          target: texRid(host.ids.B),
          ref_id: host.ids.B,
          value: 1,
        }),
      ],
    ),
    (k) => shotPng(e, k, k >= 11 ? { blankRegion: "sc" } : {}),
  );
  await rendered(
    "sabotage-omit-canvas-filter",
    patchedHost((t) => {
      if (t.canvas) t.canvas.filter = "default";
    }),
    (k) => shotPng(e, k, k === 11 ? { perturb: [210, 130] } : {}),
  );

  const refU = join(out, "reference-unsupported");
  await writeProcess(refU);
  await writeText(join(refU, "steps.jsonl"), stepLog(e));
  await writeText(join(refU, "textures.jsonl"), jsonl(variant.fixture));
  for (const s of e.steps)
    await writeBytes(
      join(refU, "shots", `step-${s.step}.png`),
      await shotPng(e, s.step, { variant: "unsupported" }),
    );

  // g2b: capture-inline, the receivers on the capture.
  const inlineModel = buildModel(e, {
    quit: CAPTURE_QUIT,
    noTextureRect: opts.noTextureRect,
    publisher: "inline",
  });
  const inline = await writeCapture(
    join(out, "capture-inline"),
    e,
    inlineModel,
    {
      inline: true,
      sessionId: "0123456789abcdef0123456789abc1c1",
    },
  );

  const good = await shotsOf(e, (k) => shotPng(e, k));
  const dumps = new Map(
    settleSeqs(e).map((seq) => [seq, JSON.stringify(main.states[seq - 1])]),
  );
  const coldSim = simulateReceiver(main, cap.fullTx, "directory");
  const coldCache = join(out, "receiver-cold", "cache");
  await writeReceiver(join(out, "receiver-cold"), {
    recording: cap.full,
    txs: cap.fullTx,
    sim: coldSim,
    cache: { dir: coldCache, mode: "fresh", entries_before: 0 },
    shots: good,
    states: dumps,
    writeCache: true,
  });
  const coldHashes = new Set(coldSim.fetches.map((x) => x.hash));
  await writeReceiver(join(out, "receiver-warm"), {
    recording: cap.full,
    txs: cap.fullTx,
    sim: simulateReceiver(main, cap.fullTx, "directory", coldHashes),
    cache: { dir: coldCache, mode: "warm", entries_before: coldHashes.size },
    shots: good,
    states: dumps,
  });
  await writeReceiver(join(out, "receiver-patch"), {
    recording: cap.patch,
    txs: cap.patchTx,
    sim: simulateReceiver(main, cap.patchTx, "directory"),
    cache: {
      dir: join(out, "receiver-patch", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
    shots: good,
    writeCache: true,
  });
  await writeReceiver(join(out, "receiver-inline"), {
    recording: inline.full,
    txs: inline.fullTx,
    sim: simulateReceiver(inlineModel, inline.fullTx, "inline"),
    cache: {
      dir: join(out, "receiver-inline", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
    shots: good,
  });
  const traceDir = join(out, "receiver-headless-trace");
  const traceSim = simulateReceiver(main, cap.fullTx, "directory");
  await writeReceiver(traceDir, {
    recording: cap.full,
    txs: cap.fullTx,
    sim: traceSim,
    cache: { dir: join(traceDir, "cache"), mode: "fresh", entries_before: 0 },
    headless: true,
  });
  await writeText(
    join(traceDir, "strace.txt"),
    [
      '7 10:00:00.000000 openat(AT_FDCWD, "/usr/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3',
      '7 10:00:00.000100 openat(AT_FDCWD, "/repo/experiments/render-stream/receiver/project.godot", O_RDONLY) = 4',
      '7 10:00:00.000200 openat(AT_FDCWD, "/repo/experiments/render-stream/receiver/missing.gd", O_RDONLY) = -1 ENOENT (No such file or directory)',
      `7 10:00:00.100000 openat(AT_FDCWD, "${join(traceDir, "recording.rs2")}", O_RDONLY) = 7`,
      ...traceSim.fetches.map(
        (x, i) =>
          `7 10:00:00.2${String(i).padStart(5, "0")} openat(AT_FDCWD, "${join(capDir, "store", "sha256", `${x.hash}.grt`)}", O_RDONLY) = 7`,
      ),
      "",
    ].join("\n"),
  );

  // Receiver-only sabotages on the capture: re-upload every frame, ignore a warm cache.
  const reupload = simulateReceiver(main, cap.fullTx, "directory");
  const firstUploads = reupload.uploads.filter(
    (u) => u.seq === 1 && u.op === "create",
  );
  for (const tx of cap.fullTx.slice(1, 40)) {
    const r = reupload.resources.get(tx.seq) as Record<string, number>;
    for (const u of firstUploads) {
      reupload.uploads.push({ ...u, op: "update", seq: tx.seq });
      r.updated++;
      r.upload_bytes += u.data_bytes;
    }
  }
  reupload.uploads.sort((a, b) => a.seq - b.seq);
  await writeReceiver(join(out, "sabotage-receiver-reupload", "receiver"), {
    recording: cap.full,
    txs: cap.fullTx,
    sim: reupload,
    cache: {
      dir: join(out, "sabotage-receiver-reupload", "receiver", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
    headless: true,
  });
  const ignoreDir = join(out, "sabotage-receiver-ignore-cache", "receiver");
  const warmCache = join(ignoreDir, "warm-cache");
  for (const h of coldHashes)
    await writeBytes(
      join(warmCache, "sha256", `${h}.grt`),
      contentOf(h).payload,
    );
  await writeReceiver(ignoreDir, {
    recording: cap.full,
    txs: cap.fullTx,
    sim: simulateReceiver(main, cap.fullTx, "directory"),
    cache: { dir: warmCache, mode: "warm", entries_before: coldHashes.size },
    headless: true,
  });

  // unsupported-textures: the receiver on the variant skips U1 and PRE.
  await writeReceiver(join(out, "unsupported-textures", "receiver"), {
    recording: unsupported.full,
    txs: unsupported.fullTx,
    sim: simulateReceiver(variant, unsupported.fullTx, "directory"),
    cache: {
      dir: join(out, "unsupported-textures", "receiver", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
    shots: await shotsOf(e, (k) =>
      shotPng(e, k, { variant: "unsupported", skipUnsupported: true }),
    ),
    unsupported: [
      {
        seq: 1,
        item: ITEM.U1,
        name: "canvas_item_add_texture_rect_region",
        reason: "unsupported-texture",
      },
      {
        seq: 1,
        item: ITEM.PRE,
        name: "canvas_item_add_texture_rect_region",
        reason: "unknown-texture",
      },
    ],
  });

  // The capture sabotages, each with its receiver.
  const mismatch = (steps: number[]) =>
    shotsOf(e, (k) =>
      shotPng(e, k, steps.includes(k) ? { perturb: [600, 300] } : {}),
    );
  for (const sabotage of [
    "omit-update",
    "omit-replace",
    "stale-texture",
    "wrong-hash",
    "spurious-update",
  ] as const) {
    const model = buildModel(e, { quit, sabotage });
    const dir = join(out, `sabotage-${sabotage}`);
    const files = await writeCapture(join(dir, "capture"), e, model, {
      sessionId: `0123456789abcdef0123456789ab${String(sabotage.length).padStart(4, "0")}`,
    });
    const sim = simulateReceiver(model, files.fullTx, "directory");
    const rx = join(dir, "receiver");
    const a1 = join(
      dir,
      "capture",
      "store",
      "sha256",
      `${CONTENT.A1.hash}.grt`,
    );
    if (sabotage === "wrong-hash") {
      const bad = Buffer.from(CONTENT.A1.payload);
      bad[bad.length - 1] ^= 0xff;
      await writeBytes(a1, bad);
      for (const x of sim.fetches)
        if (x.hash === CONTENT.A1.hash) x.verified = false;
    }
    await writeReceiver(rx, {
      recording: files.full,
      txs: files.fullTx,
      sim,
      cache: { dir: join(rx, "cache"), mode: "fresh", entries_before: 0 },
      shots:
        sabotage === "omit-update"
          ? await mismatch([6])
          : sabotage === "omit-replace"
            ? await mismatch([7, 8, 9, 10, 11])
            : undefined,
      headless: sabotage !== "omit-update" && sabotage !== "omit-replace",
      failure:
        sabotage === "wrong-hash"
          ? {
              seq: stepFrames2(e, 6).applied,
              reason: "resource-hash-mismatch",
              detail: `${a1} (${CONTENT.A1.payload.length} bytes) does not hash to its name`,
            }
          : undefined,
    });
  }

  // live-inline: the host (the fixture's frames through the default quit) and a headless live
  // receiver connected from frame 19.
  const hostDir = join(out, "live-inline", "host");
  await writeCapture(hostDir, e, armed, {
    sessionId: "0123456789abcdef0123456789abc11e",
  });
  const stream = encodeSink(armed.states.slice(18), "patch", {
    sessionId: "0123456789abcdef0123456789abc11e",
    streamId: "9f47f7b4bb35b5041092d2ca7f248535",
    transport: "websocket",
    connection: 1,
  });
  await writeBytes(join(hostDir, "tap", "stream-1.rs2"), stream);
  const streamTx = transactionsOf(stream);
  // Every payload the host's tables name reaches the stream as one resource record.
  const records = armed.stores;
  await writeJson(join(hostDir, "evidence", "live-summary.json"), {
    schema: "render-stream-live-summary/1",
    connections: [
      {
        connection: 1,
        stream_id: "9f47f7b4bb35b5041092d2ca7f248535",
        transactions: streamTx.length,
        sent: streamTx.length,
        resource_records: records.length,
        resource_bytes: records.reduce((n, c) => n + c.payload.length, 0),
      },
    ],
  });
  await writeReceiver(join(out, "live-inline", "receiver"), {
    recording: stream,
    txs: streamTx,
    sim: simulateReceiver(armed, streamTx, "inline"),
    mode: "live",
    cache: {
      dir: join(out, "live-inline", "receiver", "cache"),
      mode: "fresh",
      entries_before: 0,
    },
  });
}
