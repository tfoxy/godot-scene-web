import { describe, expect, it } from "vitest";
import { MsdfGenerator } from "../src/msdf-generator";
import type {
  MsdfGenerateRequest,
  MsdfWorkerReply,
} from "../src/msdf-generator-protocol";

class FakeWorker {
  onmessage: ((event: MessageEvent<MsdfWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: MsdfGenerateRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  postMessage(request: MsdfGenerateRequest, transfers: Transferable[]): void {
    this.requests.push(request);
    this.transfers.push(transfers);
  }
  emit(reply: MsdfWorkerReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<MsdfWorkerReply>);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe("MTSDF generator worker client", () => {
  it("creates one worker lazily and holds credit until the result is released", async () => {
    const worker = new FakeWorker();
    let created = 0;
    const generator = new MsdfGenerator({
      wasmModuleUrl: "/msdf_generator.js",
      createWorker: () => {
        created++;
        return worker as unknown as Worker;
      },
    });
    expect(created).toBe(0);
    const firstFont = new ArrayBuffer(4);
    const secondFont = new ArrayBuffer(8);
    const first = generator.generate(firstFont, [4], 8);
    await expect(generator.generate(secondFont, [5], 16)).rejects.toThrow(
      "credit in use",
    );
    expect(secondFont.byteLength).toBe(8);
    expect(created).toBe(1);
    expect(worker.transfers).toEqual([[firstFont]]);
    worker.emit({
      kind: "generated",
      id: worker.requests[0].id,
      generationMs: 1,
      wasmMemoryBytes: 65536,
      tiles: [],
    });
    const firstResult = await first;
    await expect(generator.generate(secondFont, [5], 16)).rejects.toThrow(
      "credit in use",
    );
    firstResult.release();
    firstResult.release();
    const second = generator.generate(secondFont, [5], 16);
    expect(worker.transfers).toEqual([[firstFont], [secondFont]]);
    worker.emit({
      kind: "generated",
      id: worker.requests[1].id,
      generationMs: 2,
      wasmMemoryBytes: 65536,
      tiles: [],
    });
    (await second).release();
    generator.dispose();
    expect(worker.terminated).toBe(true);
    await expect(generator.generate(new ArrayBuffer(0), [], 8)).rejects.toThrow(
      "disposed",
    );
  });

  it("rejects pending work and future requests after a worker failure", async () => {
    const worker = new FakeWorker();
    const generator = new MsdfGenerator({
      wasmModuleUrl: "/msdf_generator.js",
      createWorker: () => worker as unknown as Worker,
    });
    const pending = generator.generate(new ArrayBuffer(2), [1], 8);
    worker.onerror?.({ message: "WASM load failed" } as ErrorEvent);
    await expect(pending).rejects.toThrow("WASM load failed");
    await expect(
      generator.generate(new ArrayBuffer(2), [1], 8),
    ).rejects.toThrow("WASM load failed");
    expect(worker.terminated).toBe(true);
  });

  it("rejects an individual glyph failure without failing the worker", async () => {
    const worker = new FakeWorker();
    const generator = new MsdfGenerator({
      wasmModuleUrl: "/msdf_generator.js",
      createWorker: () => worker as unknown as Worker,
    });
    const failed = generator.generate(new ArrayBuffer(2), [1], 8);
    worker.emit({
      kind: "failed",
      id: worker.requests[0].id,
      error: "missing glyph",
    });
    await expect(failed).rejects.toThrow("missing glyph");
    const next = generator.generate(new ArrayBuffer(2), [2], 8);
    worker.emit({
      kind: "generated",
      id: worker.requests[1].id,
      generationMs: 3,
      wasmMemoryBytes: 65536,
      tiles: [],
    });
    (await next).release();
    generator.dispose();
  });

  it("releases credit on disposal and rejects pending work", async () => {
    const worker = new FakeWorker();
    const generator = new MsdfGenerator({
      wasmModuleUrl: "/msdf_generator.js",
      createWorker: () => worker as unknown as Worker,
    });
    const pending = generator.generate(new ArrayBuffer(2), [1], 8);
    generator.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await expect(
      generator.generate(new ArrayBuffer(2), [1], 8),
    ).rejects.toThrow("disposed");
    expect(worker.terminated).toBe(true);
  });
});
