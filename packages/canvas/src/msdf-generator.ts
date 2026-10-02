import type {
  MsdfGenerateRequest,
  MsdfGlyphTile,
  MsdfWorkerReply,
} from "./msdf-generator-protocol";

export type { MsdfGlyphTile } from "./msdf-generator-protocol";

export interface MsdfGeneratorOptions {
  /** URL of the separately built wasm-bindgen JavaScript glue. */
  wasmModuleUrl: string;
  /** Override for hosts that resolve the worker through their own bundler. */
  createWorker?: () => Worker;
}
export interface MsdfGeneration {
  tiles: readonly MsdfGlyphTile[];
  generationMs: number;
  wasmMemoryBytes: number;
  /** Return the one outstanding result credit after uploading or discarding the tiles. */
  release(): void;
}

/** Owns one lazy worker. The caller shapes text on the main thread and sends glyph IDs only. */
export class MsdfGenerator {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: MsdfGeneration): void; reject(error: Error): void }
  >();
  private failure: Error | undefined;
  private disposed = false;
  private busy = false;
  constructor(private readonly options: MsdfGeneratorOptions) {
    if (!options.wasmModuleUrl)
      throw new Error("missing MTSDF WASM module URL");
  }
  private failAll(error: Error): void {
    this.failure = error;
    this.busy = false;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = undefined;
  }
  private getWorker(): Worker {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error("MTSDF generator disposed");
    if (!this.worker) {
      const worker =
        this.options.createWorker?.() ??
        new Worker(new URL("./msdf-generator-worker.js", import.meta.url), {
          type: "module",
        });
      worker.onmessage = (event: MessageEvent<MsdfWorkerReply>) => {
        const reply = event.data;
        const entry = this.pending.get(reply.id);
        if (!entry) return;
        this.pending.delete(reply.id);
        if (reply.kind === "generated") {
          let released = false;
          entry.resolve({
            tiles: reply.tiles,
            generationMs: reply.generationMs,
            wasmMemoryBytes: reply.wasmMemoryBytes,
            release: () => {
              if (released) return;
              released = true;
              this.busy = false;
            },
          });
        } else {
          this.busy = false;
          entry.reject(new Error(reply.error));
        }
      };
      worker.onerror = (event) =>
        this.failAll(new Error(event.message || "MTSDF worker failed"));
      worker.onmessageerror = () =>
        this.failAll(new Error("MTSDF worker message failed"));
      this.worker = worker;
    }
    return this.worker;
  }
  /** Transfers the supplied buffer; callers retaining a font must pass a copy. */
  generate(
    fontBytes: ArrayBuffer,
    glyphIds: readonly number[],
    fullRange: 8 | 16 | 32,
  ): Promise<MsdfGeneration> {
    if (this.disposed)
      return Promise.reject(new Error("MTSDF generator disposed"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.busy)
      return Promise.reject(new Error("MTSDF result credit in use"));
    if (!glyphIds.length)
      return Promise.resolve({
        tiles: [],
        generationMs: 0,
        wasmMemoryBytes: 0,
        release: () => {},
      });
    if (
      !glyphIds.every(
        (id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffff,
      )
    )
      return Promise.reject(new Error("invalid glyph IDs"));
    if (![8, 16, 32].includes(fullRange))
      return Promise.reject(new Error("invalid distance range"));
    this.busy = true;
    try {
      const worker = this.getWorker();
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const request: MsdfGenerateRequest = {
          kind: "generate",
          id,
          wasmModuleUrl: this.options.wasmModuleUrl,
          fontBytes,
          glyphIds: [...glyphIds],
          fullRange,
        };
        try {
          worker.postMessage(request, [fontBytes]);
        } catch (error) {
          this.pending.delete(id);
          this.busy = false;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      this.busy = false;
      return Promise.reject(error);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("MTSDF generator disposed"));
  }
}
