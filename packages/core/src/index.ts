export type GodotDocumentKind = "scene" | "resource";

/** Renderer-neutral 3×3 linear RGB transform. */
export type ColorMatrix = {
  rows: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
};

export interface GodotParseDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface GodotResource {
  type?: string;
  header: GodotSectionHeader | null;
  extResources: GodotExtResource[];
  subResources: GodotSubResource[];
  properties: Record<string, GodotVariant>;
  diagnostics: GodotParseDiagnostic[];
}

export interface GodotSceneState {
  kind: "scene";
  nodes: GodotSceneStateNode[];
  connections: GodotSceneStateConnection[];
  extResources: GodotExtResource[];
  subResources: GodotSubResource[];
  editableInstances: string[];
  basePath?: string;
  diagnostics: GodotParseDiagnostic[];
}

export interface GodotSceneStateNode {
  index: number;
  siblingIndex?: number;
  name: string;
  type?: string;
  parent?: string;
  owner?: string;
  instance?: GodotResourceRefValue;
  instancePlaceholder?: string;
  groups: string[];
  properties: GodotOrderedProperty[];
}

export interface GodotOrderedProperty {
  name: string;
  value: GodotVariant;
}

export interface GodotSceneStateConnection {
  signal?: string;
  from?: string;
  to?: string;
  method?: string;
  flags?: number;
  binds?: GodotVariant[];
  unbinds?: number;
}

export interface GodotSectionHeader {
  section: string;
  attributes: Record<string, GodotVariant>;
}

export interface GodotExtResource {
  id: string;
  type?: string;
  path?: string;
  uid?: string;
  attributes: Record<string, GodotVariant>;
  properties: Record<string, GodotVariant>;
}

export interface GodotSubResource {
  id: string;
  type?: string;
  attributes: Record<string, GodotVariant>;
  properties: Record<string, GodotVariant>;
}

export interface GodotNode {
  name: string;
  type?: string;
  parent?: string;
  instance?: GodotResourceRefValue;
  attributes: Record<string, GodotVariant>;
  properties: Record<string, GodotVariant>;
  propertyEntries?: GodotOrderedProperty[];
}

export interface GodotConnection {
  signal?: string;
  from?: string;
  to?: string;
  method?: string;
  attributes: Record<string, GodotVariant>;
}

export interface GodotEditable {
  path?: string;
  attributes: Record<string, GodotVariant>;
}

// Canonical Variant value contract — what every consumer (the `layout`/`html`
// interpreters and the `as*` accessors below) reads, and what the text parser's
// `callValue` emits:
//   - scalars are raw JS primitives: `null`, `boolean`, `number`, `string`;
//   - engine math types use `{ type, args }`, where `type` is the Godot
//     constructor name (`Vector2`, `Color`, `Rect2`, `Transform2D`, …) and
//     `args` are its positional components;
//   - resource refs use `{ type:"ExtResource"|"SubResource", id|path }`.
// A live producer may instead emit Godot's `JSON.from_native` output, which
// tags basic scalars as strings (`i:`/`f:`/`s:`/`sn:`/`np:`). That tagged shape
// is decoded back to this canonical contract at the JSON-ingest boundary when
// the document opts in with `valueEncoding:"from_native"` — see
// `decodeFromNativeValue`. The accessors themselves stay raw-only: they are
// shared with the text path, where a literal string like `"f:stop"` is real.
export type GodotVariant =
  | null
  | boolean
  | number
  | string
  | GodotStringNameVariant
  | GodotVectorVariant
  | GodotColorVariant
  | GodotRectVariant
  | GodotNodePathVariant
  | GodotResourceRefValue
  | GodotCallVariant
  | GodotVariant[]
  | { [key: string]: GodotVariant };

export interface GodotVectorVariant {
  type:
    | "Vector2"
    | "Vector2i"
    | "Vector3"
    | "Vector3i"
    | "Vector4"
    | "Vector4i";
  args: number[];
}

export interface GodotColorVariant {
  type: "Color";
  args: number[];
}

export interface GodotStringNameVariant {
  type: "StringName";
  args: string[];
}

export interface GodotRectVariant {
  type: "Rect2" | "Rect2i";
  args: number[];
}

export interface GodotNodePathVariant {
  type: "NodePath";
  args: string[];
}

// A reference into a scene's ext/sub resource table. This is gsw's own
// scene-file concept (not a Godot Variant), so it stays path/id-keyed rather
// than `args`-based. Text producers emit a scene-local `id`; runtime producers
// (which hold loaded `Resource` objects) emit a `res://` `path`. Resolution is
// path-first, id-fallback — both are first-class.
export interface GodotResourceRefValue {
  type: "ExtResource" | "SubResource";
  id?: string;
  path?: string;
}

// Any other constructor-style Variant (`Type(args...)`), e.g. PackedVector2Array
// or Transform2D. The former `Call` kind folded into this uniform shape: the
// constructor name lives in `type`.
export interface GodotCallVariant {
  type: string;
  args: GodotVariant[];
}

export interface GodotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isColorValue(
  value: GodotVariant | undefined,
): value is GodotColorVariant {
  return isObject(value) && value.type === "Color" && Array.isArray(value.args);
}

export function isRectValue(
  value: GodotVariant | undefined,
): value is GodotRectVariant {
  return (
    isObject(value) &&
    (value.type === "Rect2" || value.type === "Rect2i") &&
    Array.isArray(value.args)
  );
}

export function asNumber(value: GodotVariant | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function asBoolean(
  value: GodotVariant | undefined,
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asString(value: GodotVariant | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asVector2(
  value: GodotVariant | undefined,
): { x: number; y: number } | undefined {
  if (
    !isObject(value) ||
    (value.type !== "Vector2" && value.type !== "Vector2i") ||
    !Array.isArray(value.args)
  ) {
    return undefined;
  }
  const [x, y] = value.args as unknown[];
  return typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y)
    ? { x, y }
    : undefined;
}

export function asRect2(
  value: GodotVariant | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!isRectValue(value)) {
    return undefined;
  }
  const [x, y, width, height] = value.args as unknown[];
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height)
    ? { x, y, width, height }
    : undefined;
}

export function asResourceRef(
  value: GodotVariant | undefined,
): GodotResourceRefValue | undefined {
  if (
    !isObject(value) ||
    (value.type !== "ExtResource" && value.type !== "SubResource")
  ) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  if (id === undefined && path === undefined) {
    return undefined;
  }
  return {
    type: value.type,
    ...(id !== undefined ? { id } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

// Decode a value produced by Godot's `JSON.from_native` into gsw's canonical
// Variant contract (see the `GodotVariant` note above). `from_native` tags basic
// scalars as strings — `i:`/`f:` (int/float), `s:`/`sn:` (String/StringName),
// `np:` (NodePath) — and passes `null`/`bool` through; math types already arrive
// as `{ type, args }`. This inverts the scalar tags, recursing through untyped
// arrays and `Array`/`Dictionary` wrappers (whose elements `from_native` also
// tags) while leaving every other `{ type, args }` wrapper — math types, packed
// arrays (raw `args`), resource refs — and untagged strings untouched. Intended
// only for the JSON-ingest boundary on `valueEncoding:"from_native"` documents;
// never run it on text-parsed values, where a literal `"i:3"` is a real string.
export function decodeFromNativeValue(value: GodotVariant): GodotVariant {
  if (typeof value === "string") {
    return decodeFromNativeScalar(value);
  }
  if (Array.isArray(value)) {
    // Untyped `from_native` arrays arrive as bare JSON arrays of tagged elements.
    return value.map(decodeFromNativeValue);
  }
  if (isObject(value)) {
    const type = typeof value.type === "string" ? value.type : undefined;
    // Only `Array`/`Dictionary` wrappers tag their `args`; every other wrapper
    // (`Vector*`, `Color`, packed arrays, resource refs, …) carries canonical or
    // deliberately-raw `args` that must not be re-decoded.
    if (type === "Array" || type === "Dictionary") {
      return Array.isArray(value.args)
        ? { ...value, args: value.args.map(decodeFromNativeValue) }
        : (value as GodotVariant);
    }
    if (type !== undefined) {
      return value as GodotVariant;
    }
    // A bare object/dictionary map (no recognized variant `type`): decode each
    // value position.
    const decoded: Record<string, GodotVariant> = {};
    for (const [key, entry] of Object.entries(value)) {
      decoded[key] = decodeFromNativeValue(entry as GodotVariant);
    }
    return decoded;
  }
  return value;
}

function decodeFromNativeScalar(value: string): GodotVariant {
  if (value.startsWith("i:")) {
    const parsed = Number.parseInt(value.slice(2), 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (value.startsWith("f:")) {
    const parsed = decodeFromNativeFloat(value.slice(2));
    return parsed === undefined ? value : parsed;
  }
  if (value.startsWith("s:")) {
    return value.slice(2);
  }
  if (value.startsWith("sn:")) {
    return value.slice(3);
  }
  if (value.startsWith("np:")) {
    return { type: "NodePath", args: [value.slice(3)] };
  }
  return value;
}

function decodeFromNativeFloat(text: string): number | undefined {
  // `from_native` prints floats via Godot's `String(float)`: finite values, plus
  // `inf` / `-inf` / `nan` for the non-finite ones. `undefined` signals an
  // unparseable tag so the caller can keep the original string verbatim.
  switch (text) {
    case "inf":
      return Infinity;
    case "-inf":
      return -Infinity;
    case "nan":
      return Number.NaN;
    default: {
      const parsed = Number.parseFloat(text);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
  }
}

export function isGodotSceneState(value: unknown): value is GodotSceneState {
  if (!isObject(value) || value.kind !== "scene") {
    return false;
  }
  return (
    Array.isArray(value.nodes) &&
    value.nodes.every(isGodotSceneStateNode) &&
    Array.isArray(value.connections) &&
    Array.isArray(value.extResources) &&
    Array.isArray(value.subResources) &&
    Array.isArray(value.diagnostics)
  );
}

export function godotNodePath(node: GodotNode): string {
  if (!node.parent || node.parent === ".") {
    return node.name;
  }
  return `${node.parent}/${node.name}`;
}

export function godotParentPath(node: GodotNode): string | null {
  return node.parent ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGodotSceneStateNode(value: unknown): value is GodotSceneStateNode {
  return (
    isObject(value) &&
    typeof value.index === "number" &&
    (value.siblingIndex === undefined ||
      typeof value.siblingIndex === "number") &&
    typeof value.name === "string" &&
    Array.isArray(value.groups) &&
    Array.isArray(value.properties)
  );
}
