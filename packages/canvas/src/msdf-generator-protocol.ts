/** Worker wire messages. Font bytes are transferred in; each tile buffer is transferred out. */
export interface MsdfGlyphTile {
  glyphId: number;
  width: number;
  height: number;
  /** Pixel position of tile top-left relative to the glyph's baseline origin. */
  left: number;
  top: number;
  advance: number;
  pixels: Uint8Array;
}
export interface MsdfGenerateRequest {
  kind: "generate";
  id: number;
  wasmModuleUrl: string;
  fontBytes: ArrayBuffer;
  glyphIds: number[];
  fullRange: 8 | 16 | 32;
}
export type MsdfWorkerReply =
  | {
      kind: "generated";
      id: number;
      tiles: MsdfGlyphTile[];
      generationMs: number;
      wasmMemoryBytes: number;
    }
  | { kind: "failed"; id: number; error: string };
