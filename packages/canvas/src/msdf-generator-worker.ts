import type {
  MsdfGenerateRequest,
  MsdfGlyphTile,
  MsdfWorkerReply,
} from "./msdf-generator-protocol";

interface WasmGenerator {
  default(source?: string): Promise<unknown>;
  generate_mtsdf_tiles(
    fontBytes: Uint8Array,
    glyphIds: Uint32Array,
    fullRange: number,
  ): MsdfGlyphTile[];
  wasm_memory_bytes(): number;
}
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MsdfGenerateRequest>) => void) | null;
  postMessage(message: MsdfWorkerReply, transfer?: Transferable[]): void;
};
let modulePromise: Promise<WasmGenerator> | undefined;
let loadedUrl: string | undefined;
async function loadWasm(url: string): Promise<WasmGenerator> {
  if (loadedUrl && loadedUrl !== url)
    throw new Error("worker already initialized with another WASM module");
  if (!modulePromise) {
    loadedUrl = url;
    modulePromise = import(/* @vite-ignore */ url).then(async (module) => {
      const generator = module as WasmGenerator;
      await generator.default();
      return generator;
    });
  }
  return modulePromise;
}
scope.onmessage = (event) => {
  const request = event.data;
  if (request?.kind !== "generate") return;
  void (async () => {
    try {
      const generator = await loadWasm(request.wasmModuleUrl);
      const start = performance.now();
      const tiles = generator.generate_mtsdf_tiles(
        new Uint8Array(request.fontBytes),
        Uint32Array.from(request.glyphIds),
        request.fullRange,
      );
      const generationMs = performance.now() - start;
      scope.postMessage(
        {
          kind: "generated",
          id: request.id,
          tiles,
          generationMs,
          wasmMemoryBytes: generator.wasm_memory_bytes(),
        },
        tiles.map((tile) => tile.pixels.buffer as ArrayBuffer),
      );
    } catch (error) {
      scope.postMessage({
        kind: "failed",
        id: request.id,
        error: String(error),
      });
    }
  })();
};
