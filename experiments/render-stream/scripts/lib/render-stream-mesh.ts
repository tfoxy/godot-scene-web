// render-stream-mesh/1 (GRM1) payload decode and verification (render-stream-4.md "Mesh
// payload"). Pure: a Uint8Array in, a decoded shape or a thrown "<code>: <detail>" out. This is
// the read side only -- a payload is built elsewhere (the capture, G5a/G5e); the golden-4
// vectors build theirs directly in Python (protocol/golden-4/make_golden.py).
//
// Parallel to render-stream-2.ts's decodeTexturePayload()/payloadSha256()/expectedDataBytes()
// for render-stream-texture/1 (GRT1): same framing style (magic, u32 meta_len, canonical JSON
// meta), but the mesh payload's "data" section is four concatenated buffers (vertex, attribute,
// skin, index) whose lengths come from the meta fields themselves, plus a fixed 40-byte geometry
// block (AABB + uv_scale) between meta and data that GRT1 does not have.
//
// scripts/lib/render-stream-2.ts imports this module for the resource-record and
// resource-payload checks once a stream is decoded at version 4 (a resource record's payload may
// be a GRT1 texture or a GRM1 mesh surface; render-stream-2.ts tells them apart by the 8-byte
// magic before choosing which decoder to call).

import { createHash } from "node:crypto";

export const GRM1_MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x4d, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type Primitive =
  | "points"
  | "lines"
  | "line_strip"
  | "triangles"
  | "triangle_strip";

// gate5-design.md Q1e / render-stream-4.md "Mesh payload": the ARRAY_FORMAT_*/ARRAY_FLAG_* bits
// this module needs to compute a surface's expected buffer sizes. Carried as plain numbers,
// never as a Mesh.ArrayFormat enum -- `format` on the wire is an uninterpreted integer.
export const ARRAY_FORMAT_COLOR = 1 << 3;
export const ARRAY_FORMAT_TEX_UV = 1 << 4;
export const ARRAY_FORMAT_BONES = 1 << 10;
export const ARRAY_FORMAT_WEIGHTS = 1 << 11;
export const ARRAY_FORMAT_INDEX = 1 << 12;
export const ARRAY_FLAG_USE_8_BONE_WEIGHTS = 1 << 27;

export interface DecodedMeshPayload {
  primitive: Primitive;
  format: number;
  vertex_count: number;
  index_count: number;
  vertex_bytes: number;
  attribute_bytes: number;
  skin_bytes: number;
  index_bytes: number;
  aabb: [number, number, number, number, number, number];
  uv_scale: [number, number, number, number];
  vertex_data: Uint8Array;
  attribute_data: Uint8Array;
  skin_data: Uint8Array;
  index_data: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToAscii(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function hasExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(obj);
  if (actual.length !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) if (actual[i] !== keys[i]) return false;
  return true;
}

const META_KEYS = [
  "type",
  "primitive",
  "format",
  "vertex_count",
  "index_count",
  "vertex_bytes",
  "attribute_bytes",
  "skin_bytes",
  "index_bytes",
] as const;

const PRIMITIVES = [
  "points",
  "lines",
  "line_strip",
  "triangles",
  "triangle_strip",
] as const;

/** render-stream-4.md "Mesh payload": the expected buffer lengths for a shape, from D7/Q1e's
 * rules. `n` is vertex_count. */
export function expectedMeshBufferBytes(
  format: number,
  vertexCount: number,
  indexCount: number,
): {
  vertex_bytes: number;
  attribute_bytes: number;
  skin_bytes: number;
  index_bytes: number;
} {
  const n = vertexCount;
  const vertex_bytes = 8 * n;
  const attribute_bytes =
    n *
    ((format & ARRAY_FORMAT_COLOR ? 4 : 0) +
      (format & ARRAY_FORMAT_TEX_UV ? 8 : 0));
  const hasSkin =
    (format & ARRAY_FORMAT_BONES) !== 0 &&
    (format & ARRAY_FORMAT_WEIGHTS) !== 0;
  const skin_bytes = hasSkin
    ? n * (format & ARRAY_FLAG_USE_8_BONE_WEIGHTS ? 32 : 16)
    : 0;
  const index_bytes = indexCount === 0 ? 0 : indexCount * (n <= 65536 ? 2 : 4);
  return { vertex_bytes, attribute_bytes, skin_bytes, index_bytes };
}

export function meshPayloadSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// render-stream-4.md "Mesh payload": GRM1 magic, u32 meta_len, canonical JSON meta, 40-byte
// geometry (AABB + uv_scale), then the four buffers concatenated. Throws "<code>: <detail>" on
// any decode failure (payload-magic, payload-meta, payload-length, payload-size).
export function decodeMeshPayload(bytes: Uint8Array): DecodedMeshPayload {
  if (bytes.length < 8 || !bytesEqual(bytes.subarray(0, 8), GRM1_MAGIC)) {
    throw new Error("payload-magic: the first 8 bytes are not the GRM1 magic");
  }
  if (bytes.length < 12) {
    throw new Error(
      "payload-length: the payload ends inside the meta_len prefix",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(8, true);
  if (12 + metaLen + 40 > bytes.length) {
    throw new Error(
      "payload-length: meta_len and the geometry block run past the end of the payload",
    );
  }
  const metaBytes = bytes.subarray(12, 12 + metaLen);
  const metaText = bytesToAscii(metaBytes);
  if (metaText === null) {
    throw new Error("payload-meta: meta contains a non-printable-ASCII byte");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    throw new Error("payload-meta: meta is not valid JSON");
  }
  if (
    !isPlainObject(meta) ||
    !hasExactKeys(meta, META_KEYS) ||
    meta.type !== "mesh-surface" ||
    !PRIMITIVES.includes(meta.primitive as Primitive) ||
    !isInt(meta.format) ||
    !isInt(meta.vertex_count) ||
    meta.vertex_count < 0 ||
    !isInt(meta.index_count) ||
    meta.index_count < 0 ||
    !isInt(meta.vertex_bytes) ||
    meta.vertex_bytes < 0 ||
    !isInt(meta.attribute_bytes) ||
    meta.attribute_bytes < 0 ||
    !isInt(meta.skin_bytes) ||
    meta.skin_bytes < 0 ||
    !isInt(meta.index_bytes) ||
    meta.index_bytes < 0
  ) {
    throw new Error(
      "payload-meta: meta has the wrong keys or an invalid field",
    );
  }
  if (JSON.stringify(meta) !== metaText) {
    throw new Error("payload-meta: meta is not canonical JSON");
  }

  const geometryOffset = 12 + metaLen;
  const aabb: [number, number, number, number, number, number] = [
    view.getFloat32(geometryOffset, true),
    view.getFloat32(geometryOffset + 4, true),
    view.getFloat32(geometryOffset + 8, true),
    view.getFloat32(geometryOffset + 12, true),
    view.getFloat32(geometryOffset + 16, true),
    view.getFloat32(geometryOffset + 20, true),
  ];
  const uv_scale: [number, number, number, number] = [
    view.getFloat32(geometryOffset + 24, true),
    view.getFloat32(geometryOffset + 28, true),
    view.getFloat32(geometryOffset + 32, true),
    view.getFloat32(geometryOffset + 36, true),
  ];

  const dataOffset = geometryOffset + 40;
  const declaredDataLen =
    meta.vertex_bytes +
    meta.attribute_bytes +
    meta.skin_bytes +
    meta.index_bytes;
  if (dataOffset + declaredDataLen !== bytes.length) {
    throw new Error(
      "payload-length: the trailing bytes do not equal vertex_bytes+attribute_bytes+skin_bytes+index_bytes",
    );
  }

  const expected = expectedMeshBufferBytes(
    meta.format,
    meta.vertex_count,
    meta.index_count,
  );
  if (
    expected.vertex_bytes !== meta.vertex_bytes ||
    expected.attribute_bytes !== meta.attribute_bytes ||
    expected.skin_bytes !== meta.skin_bytes ||
    expected.index_bytes !== meta.index_bytes
  ) {
    throw new Error(
      `payload-size: buffer lengths (${meta.vertex_bytes}, ${meta.attribute_bytes}, ${meta.skin_bytes}, ${meta.index_bytes}) disagree with the shape computed from format/vertex_count/index_count (${expected.vertex_bytes}, ${expected.attribute_bytes}, ${expected.skin_bytes}, ${expected.index_bytes})`,
    );
  }

  let p = dataOffset;
  const vertex_data = bytes.subarray(p, p + meta.vertex_bytes);
  p += meta.vertex_bytes;
  const attribute_data = bytes.subarray(p, p + meta.attribute_bytes);
  p += meta.attribute_bytes;
  const skin_data = bytes.subarray(p, p + meta.skin_bytes);
  p += meta.skin_bytes;
  const index_data = bytes.subarray(p, p + meta.index_bytes);

  return {
    primitive: meta.primitive as Primitive,
    format: meta.format,
    vertex_count: meta.vertex_count,
    index_count: meta.index_count,
    vertex_bytes: meta.vertex_bytes,
    attribute_bytes: meta.attribute_bytes,
    skin_bytes: meta.skin_bytes,
    index_bytes: meta.index_bytes,
    aabb,
    uv_scale,
    vertex_data,
    attribute_data,
    skin_data,
    index_data,
  };
}
