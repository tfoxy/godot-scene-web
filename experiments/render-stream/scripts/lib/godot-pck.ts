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
  u64(); // file base
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
  return { formatVersion, engine, packFlags, files };
}
