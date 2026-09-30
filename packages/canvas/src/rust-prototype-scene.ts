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

export interface RustProfileScope {
  collector: { span<T>(identity: unknown, kind: string, action: () => T): T };
  identity: unknown;
}

export interface RustResource {
  key: string;
  width: number;
  height: number;
}
export interface RustTextCarrier {
  resource: RustResource;
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Local to the record parent, with raster padding already applied. */
  transform: readonly number[];
  alpha?: number;
}
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
  groups: Map<string, { parentId?: string; transform: readonly number[] }>;
  owners: Map<
    string,
    {
      parentId?: string;
      local: readonly number[];
      sourceLocal: readonly number[];
    }
  >;
  clipParents: readonly (string | undefined)[];
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
const identity = [1, 0, 0, 1, 0, 0] as const;
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

function quadFields(q: QuadView, resource: string | null) {
  return {
    resource,
    m: Array.from(q.m),
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
/** A full command batch. Unknown commands survive encoding and are refused by Rust admission. */
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
}: RustSceneInput<T>): RustEncodedScene {
  const resources = new Map<string, RustResource>();
  const commands: Record<string, unknown>[] = [];
  let unsupportedCommands = 0;
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
  const clipParents: (string | undefined)[] = [];
  const worldCache = new Map<string, number[]>();
  function world(id: string | undefined, seen = new Set<string>()): number[] {
    if (!id) return [...identity];
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
  const openGroups = new Map<number, string[]>();
  for (const group of plan?.groups ?? []) {
    const a = openGroups.get(group.firstIndex) ?? [];
    a.push(group.id);
    openGroups.set(group.firstIndex, a);
  }
  const groupAt = (i: number) =>
    [...(plan?.groups ?? [])]
      .filter((g) => g.firstIndex <= i && i < g.endIndex)
      .sort(
        (a, b) => a.endIndex - a.firstIndex - (b.endIndex - b.firstIndex),
      )[0];
  const q = createQuadView(),
    n = createNinePatchView(),
    clip = createClipRectView();
  for (let i = 0; i <= drawList.count; i++) {
    for (const record of textAt.get(i) ?? []) {
      const carrier = resolveText?.(record);
      const id = `t${record.key}`;
      if (!carrier) {
        commands.push({ id, kind: "unresolvedText" });
        unsupportedCommands++;
        continue;
      }
      resources.set(carrier.resource.key, carrier.resource);
      textUploads.push({
        key: carrier.resource.key,
        width: carrier.resource.width,
        height: carrier.resource.height,
        pixels: carrier.pixels,
      });
      const alpha = carrier.alpha ?? record.alpha ?? 1;
      commands.push({
        id,
        kind: "rasterText",
        resource: carrier.resource.key,
        m: mul(world(record.parentId), carrier.transform),
        w: carrier.width,
        h: carrier.height,
        src: [0, 0, carrier.resource.width, carrier.resource.height],
        color: [alpha, alpha, alpha, alpha],
        blend: "mix",
        flipH: false,
        flipV: false,
        colorMatrix: null,
      });
      owners.set(id, {
        parentId: record.parentId,
        local: carrier.transform,
        sourceLocal: record.localTransform ?? record.transform,
      });
    }
    if (i === drawList.count) break;
    for (const id of openGroups.get(i) ?? []) {
      if ((groups.get(id)?.alpha ?? 1) !== 1) {
        commands.push({
          id: `group-alpha:${id}`,
          kind: "unsupportedGroupAlpha",
        });
        unsupportedCommands++;
      }
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
        commands.push({ id, kind: "unresolvedResource" });
        unsupportedCommands++;
        continue;
      }
      if (resolved) resources.set(resolved.key, resolved);
      const payload = {
        id,
        kind: kind === DRAW_QUAD ? "quad" : "ninePatch",
        ...quadFields(view, resolved?.key ?? null),
        m: mul(world(parent), primitive?.localTransform ?? view.m),
      };
      owners.set(id, {
        parentId: parent,
        local: primitive?.localTransform ?? Array.from(view.m),
        sourceLocal: primitive?.localTransform ?? Array.from(view.m),
      });
      if (view.blend !== 0 && view.blend !== BLEND_ADD) unsupportedCommands++;
      if (kind === DRAW_NINE_PATCH)
        commands.push({
          ...payload,
          margins: [n.marginLeft, n.marginTop, n.marginRight, n.marginBottom],
        });
      else commands.push(payload);
    } else if (kind === DRAW_CLIP_PUSH) {
      clipParents.push(parent);
      drawList.readClipRect(i, clip);
      const m = world(parent);
      if (
        m[0] <= 0 ||
        m[3] <= 0 ||
        Math.abs(m[1]) > 1e-5 ||
        Math.abs(m[2]) > 1e-5 ||
        Math.abs(Math.abs(m[0]) - Math.abs(m[3])) > 1e-5
      ) {
        commands.push({ id, kind: "unsupportedTransformedClip" });
        unsupportedCommands++;
        continue;
      }
      const p = mul(m, [1, 0, 0, 1, clip.x, clip.y]);
      commands.push({
        id,
        kind: "clipPush",
        rect: [p[4], p[5], clip.w * m[0], clip.h * m[3]],
        radius: clip.cornerRadius * Math.abs(m[0]),
        outset: clip.outsetX * Math.abs(m[0]),
      });
    } else if (kind === DRAW_CLIP_POP) commands.push({ id, kind: "clipPop" });
    else {
      commands.push({ id, kind: drawList.kindNameAt(i) });
      unsupportedCommands++;
    }
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
    groups: new Map(
      [...groups].map(([id, group]) => [
        id,
        { parentId: group.parentId, transform: group.transform },
      ]),
    ),
    owners,
    clipParents,
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

/** Encode one atomic same-shape patch; return null when the caller must admit a full scene. */
export function encodeRustPatch(
  a: RustSceneSnapshot,
  b: RustSceneSnapshot,
  profile?: RustProfileScope,
): Uint8Array | null {
  return profile
    ? profile.collector.span(profile.identity, "canvas.serialize", () =>
        encodeRustPatchImpl(a, b),
      )
    : encodeRustPatchImpl(a, b);
}
function encodeRustPatchImpl(
  a: RustSceneSnapshot,
  b: RustSceneSnapshot,
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
    if (old !== command && JSON.stringify(old) !== JSON.stringify(command))
      updates.push({ id: command.id, command });
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

/** Encode changed commands directly from a retained scene, without a draw-list or scene diff. */
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
): ReturnType<typeof encodeRustRetainedPatchImpl> {
  return profile
    ? profile.collector.span(profile.identity, "canvas.serialize", () =>
        encodeRustRetainedPatchImpl(base, revision, updates, groupTransforms),
      )
    : encodeRustRetainedPatchImpl(base, revision, updates, groupTransforms);
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
): {
  bytes: Uint8Array;
  scene: RustSceneSnapshot;
  /** Commands replaced by this patch, in patch update order. */
  changedIndexes: readonly number[];
} | null {
  if (
    base.version !== 2 ||
    !Number.isSafeInteger(base.revision) ||
    !Number.isSafeInteger(revision) ||
    revision <= base.revision
  )
    return null;
  const indexes = indexCommands(base);
  const resources = new Set(base.resources.map((resource) => resource.key));
  const seen = new Set<string>();
  const nextCommands = base.commands.slice();
  const meta = retainedMeta.get(base);
  if (groupTransforms.length && !meta) return null;
  const groups = meta
    ? new Map(meta.groups)
    : new Map<string, { parentId?: string; transform: readonly number[] }>();
  const owners = meta
    ? new Map(meta.owners)
    : new Map<
        string,
        {
          parentId?: string;
          local: readonly number[];
          sourceLocal: readonly number[];
        }
      >();
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
    source: Map<string, { parentId?: string; transform: readonly number[] }>,
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
  if (meta?.clipParents.some((parent) => affected(parent, changed)))
    return null;
  for (const { id, command, localTransform } of updates) {
    if (seen.has(id)) return null;
    seen.add(id);
    const index = indexes.get(id);
    if (index === undefined) return null;
    const previous = base.commands[index];
    if (
      command.id !== id ||
      command.kind !== previous.kind ||
      command.resource !== previous.resource ||
      command.blend !== previous.blend ||
      command.kind === "clipPush" ||
      command.kind === "clipPop" ||
      !["quad", "ninePatch", "rasterText", "stillImage"].includes(
        String(command.kind),
      ) ||
      (command.resource !== null &&
        (typeof command.resource !== "string" ||
          !resources.has(command.resource)))
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
  if (groupTransforms.length && meta) {
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
  const changedIndexes: number[] = [];
  for (const [id, command] of staged) {
    const index = indexes.get(id)!;
    nextCommands[index] = command;
    changedIndexes.push(index);
  }
  const scene: RustSceneSnapshot = {
    ...base,
    revision,
    commands: nextCommands,
  };
  commandIndexes.set(scene, indexes);
  if (meta)
    retainedMeta.set(scene, { groups, owners, clipParents: meta.clipParents });
  return {
    bytes: encoder.encode(
      JSON.stringify({
        version: 1,
        baseRevision: base.revision,
        revision,
        updates: [...staged].map(([id, command]) => ({ id, command })),
      }),
    ),
    scene,
    changedIndexes,
  };
}
