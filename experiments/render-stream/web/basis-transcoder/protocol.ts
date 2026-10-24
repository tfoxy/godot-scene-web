// The messages between GSW's main thread and its KTX2 transcoder worker (G8kb, worker.ts).

export interface TranscodeRequest {
  type: "transcode";
  id: number;
  /** The KTX2 file, verified against its hash by rs-core before it is posted (transferred). */
  bytes: ArrayBuffer;
  /** transcoder.cpp's bit set: 1 s3tc, 2 bptc, 4 rgtc, 8 etc2, 16 astc. */
  families: number;
}

export interface TranscodeReply {
  type: "result";
  id: number;
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  levels?: number;
  /** basist::transcoder_texture_format of the output. */
  target?: number;
  components?: number;
  level0Bytes?: number;
  /** Every level's output, level 0 first (transferred). */
  data?: ArrayBuffer;
  /** bt_transcode's own time in the worker (zstd inflate + transcode of every level). */
  ms?: number;
}

/** transcoder.cpp's family bits, from Godot's feature names (texture-delivery-design.md Q3). */
export const FAMILY_BITS: Record<string, number> = { s3tc: 1, bptc: 2, rgtc: 4, etc2: 8, astc: 16 };

/** basist::transcoder_texture_format -> the Image.Format name the GSW upload names it by
 * (CompressedFormat::from_godot, or RGBA8 for the uncompressed fallback). Godot's KTX2 loader
 * names an ASTC 4x4 UNORM transcode FORMAT_ASTC_4x4_HDR (texture_loader_ktx.cpp:437, the same GL
 * internal format); GSW names it ASTC_4x4, the LDR blocks it is. */
export const TARGET_FORMAT: Record<number, string> = {
  0: "ETC2_RGB8", // cTFETC1_RGB: libktx stores it as VK_FORMAT_ETC2_R8G8B8_UNORM_BLOCK
  1: "ETC2_RGBA8", // cTFETC2_RGBA
  2: "DXT1", // cTFBC1_RGB
  3: "DXT5", // cTFBC3_RGBA
  4: "RGTC_R", // cTFBC4_R
  5: "RGTC_RG", // cTFBC5_RG
  6: "BPTC_RGBA", // cTFBC7_RGBA
  10: "ASTC_4x4", // cTFASTC_4x4_RGBA
  13: "RGBA8", // cTFRGBA32
};

export function familyBits(families: readonly string[]): number {
  let bits = 0;
  for (const f of families) bits |= FAMILY_BITS[f] ?? 0;
  return bits;
}
