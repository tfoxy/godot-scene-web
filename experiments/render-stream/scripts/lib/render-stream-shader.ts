// render-stream-shader/1 (GRP1) payload decode and verification (render-stream-5.md "Shader
// payload"). Pure: a Uint8Array in, a decoded shape or a thrown "<code>: <detail>" out. This is
// the read side only -- a payload is built elsewhere (the capture, G55a); the golden-5 vectors
// build theirs directly in Python (protocol/golden-5/make_golden.py).
//
// Parallel to render-stream-mesh.ts's decodeMeshPayload() for render-stream-mesh/1 (GRM1): same
// framing style (magic, u32 meta_len, canonical JSON meta), but GRP1's "data" section is just the
// shader's code as UTF-8 -- no 40-byte geometry block (GRM1 has one), no separate data_len
// (GRT1 has one): the payload simply ends where meta.code_bytes says it does.
//
// scripts/lib/render-stream-2.ts imports this module for the resource-record and
// resource-payload checks once a stream is decoded at version 5 (a resource record's payload may
// be a GRT1 texture, a GRM1 mesh surface or a GRP1 shader code; render-stream-2.ts tells them
// apart by the 8-byte magic before choosing which decoder to call).

import { createHash } from "node:crypto";

export const GRP1_MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x50, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface DecodedShaderPayload {
  code_bytes: number;
  code: string;
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

const META_KEYS = ["type", "code_bytes"] as const;

export function shaderPayloadSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// render-stream-5.md "Shader payload render-stream-shader/1": GRP1 magic, u32 meta_len,
// canonical JSON meta ({"type":"shader-code","code_bytes":<int>}), then the code as UTF-8,
// exactly the string the RenderingServer received. Throws "<code>: <detail>" on any decode
// failure (payload-magic, payload-meta, payload-length, payload-utf8).
export function decodeShaderPayload(bytes: Uint8Array): DecodedShaderPayload {
  if (bytes.length < 8 || !bytesEqual(bytes.subarray(0, 8), GRP1_MAGIC)) {
    throw new Error("payload-magic: the first 8 bytes are not the GRP1 magic");
  }
  if (bytes.length < 12) {
    throw new Error(
      "payload-length: the payload ends inside the meta_len prefix",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(8, true);
  if (12 + metaLen > bytes.length) {
    throw new Error(
      "payload-length: meta_len runs past the end of the payload",
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
    meta.type !== "shader-code" ||
    !isInt(meta.code_bytes) ||
    meta.code_bytes < 0
  ) {
    throw new Error(
      "payload-meta: meta has the wrong keys or an invalid field",
    );
  }
  if (JSON.stringify(meta) !== metaText) {
    throw new Error("payload-meta: meta is not canonical JSON");
  }

  const dataOffset = 12 + metaLen;
  if (dataOffset + meta.code_bytes !== bytes.length) {
    throw new Error(
      "payload-length: the trailing bytes do not equal meta.code_bytes",
    );
  }
  const data = bytes.subarray(dataOffset, dataOffset + meta.code_bytes);
  let code: string;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("payload-utf8: the code bytes are not valid UTF-8");
  }
  return { code_bytes: meta.code_bytes, code };
}
