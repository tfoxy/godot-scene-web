// A Godot 4.5.1 `.pck` directory reader (G7e, gate7-design.md Q4 "Bundle provenance"): the file
// list `build.json` records and `no-source-scene` checks. Read from the pinned engine source,
// `core/io/file_access_pack.cpp` (PackedSourcePCK::try_open_pack) and `file_access_pack.h`:
//
//   u32 magic "GDPC" (0x43504447), u32 format version (2 or 3), u32 major, minor, patch,
//   u32 pack flags (bit 0 encrypted directory, bit 1 relative file base, bit 2 sparse bundle),
//   u64 file base; v3: u64 directory offset (seek there); v2: 16 reserved u32;
//   then u32 file count and per file: u32 path length (padded), path bytes (NUL padded),
//   u64 offset, u64 size, 16 bytes md5, u32 flags (bit 0 encrypted, bit 1 removal).
//
// Only an unencrypted directory at the start of the file is read: the web export writes a
// standalone `<name>.pck`, never an embedded one, and this receiver is never encrypted.

import { createHash } from "node:crypto";

export interface PckEntry {
  path: string;
  offset: number;
  size: number;
  md5: string;
  flags: number;
}

export interface PckListing {
  formatVersion: number;
  engine: string;
  packFlags: number;
  /** absolute offset of the file data (an entry's bytes start at fileBase + offset) */
  fileBase: number;
  files: PckEntry[];
}

const MAGIC = 0x43504447;

export function listPck(bytes: Uint8Array): PckListing {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = (): number => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const u64 = (): number => {
    const v = view.getBigUint64(at, true);
    at += 8;
    return Number(v);
  };
  if (u32() !== MAGIC)
    throw new Error("pck: bad magic (not a standalone GDPC file)");
  const formatVersion = u32();
  if (formatVersion !== 2 && formatVersion !== 3) {
    throw new Error(`pck: unsupported format version ${formatVersion}`);
  }
  const engine = `${u32()}.${u32()}.${u32()}`;
  const packFlags = u32();
  if (packFlags & 1) throw new Error("pck: encrypted directory");
  const fileBase = u64(); // standalone pack: relative-to-pack == absolute
  if (formatVersion === 3) {
    at = u64();
  } else {
    at += 16 * 4;
  }
  const count = u32();
  const files: PckEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const length = u32();
    const raw = bytes.subarray(at, at + length);
    at += length;
    const nul = raw.indexOf(0);
    const path = decoder.decode(nul >= 0 ? raw.subarray(0, nul) : raw);
    const offset = u64();
    const size = u64();
    const md5 = Buffer.from(bytes.subarray(at, at + 16)).toString("hex");
    at += 16;
    const flags = u32();
    files.push({ path, offset, size, md5, flags });
  }
  return { formatVersion, engine, packFlags, fileBase, files };
}

/** The bytes of one entry (an unencrypted standalone pack's data is stored uncompressed). */
export function pckEntryBytes(
  bytes: Uint8Array,
  listing: PckListing,
  entry: PckEntry,
): Uint8Array {
  const start = listing.fileBase + entry.offset;
  if (start + entry.size > bytes.length)
    throw new Error(`pck: ${entry.path} runs past the end of the pack`);
  return bytes.subarray(start, start + entry.size);
}

/** The pack's CONTENT digest (R3): sha256 over its entries sorted by path, one
 * `<path>\t<size>\t<md5>\n` line each (md5 is Godot's own per-entry digest of the entry's bytes,
 * which web-build-json.ts verifies against the data).
 *
 * Why not the pack's own sha256: Godot 4.5.1's web export writes the same entries with the same
 * bytes, but the DATA ORDER of some entries is nondeterministic across machines (measured: four
 * class_name scripts written right after ext/rs_core.gdextension came out in three different orders
 * over 16 remote builds and the local one, from identical inputs; the directory is sorted, the data
 * layout is not). So the raw `.pck` sha256 is build identity that drifts with no content change; the
 * content digest is what two builds must agree on. Order-independent by construction (sorted). */
export function pckContentDigest(
  files: ReadonlyArray<{ path: string; size: number; md5: string }>,
): string {
  const lines = files
    .map((f) => `${f.path}\t${f.size}\t${f.md5}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(lines.join("")).digest("hex");
}
