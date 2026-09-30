import { describe, expect, it } from "vitest";
import {
  CanvasProfileCollector,
  type CanvasProfileReceipt,
  validateCanvasProfile,
} from "../src/profile";

const id = {
  runId: "r",
  rendererInstanceId: "mount",
  operationId: 1,
  kind: "full-build" as const,
};
const hash = () => ({ before: "a".repeat(64), after: "a".repeat(64) });
const receipt = (): CanvasProfileReceipt => ({
  schema: "canvas-profile/1",
  runId: "r",
  rendererInstanceId: "mount",
  command: "fixture",
  profiler: {},
  hashes: {
    source: hash(),
    wasm: hash(),
    glue: hash(),
    input: hash(),
    resources: hash(),
  },
  effective: {},
  browser: {},
  gpu: {},
  processes: [
    {
      pid: 1,
      tid: 2,
      startIdentity: "start",
      threadStartBefore: "start",
      threadStartAfter: "start",
      processStartBefore: "start",
      processStartAfter: "start",
      role: "renderer",
    },
  ],
  clocks: [
    {
      from: "performance.timeOrigin+now",
      to: "trace",
      offsetUs: 0,
      uncertaintyUs: 10,
    },
  ],
  markers: {
    begin: 1,
    end: 2,
    rust: {
      count: 8,
      unjoined: 0,
      unbalanced: 0,
      phases: ["admit", "upload", "encode-submit", "resume"],
    },
  },
  workload: { valid: true },
  output: { valid: true },
  symbols: {},
  losses: {
    trace: 0,
    collector: 0,
    profiler: null,
    profilerReason: "not collected",
  },
  presentations: { source: "test compositor", count: 1, ids: ["frame1"] },
  metrics: {
    gpuNs: {
      value: null,
      unit: "ns",
      method: "timer query",
      coverage: null,
      reason: "unsupported",
    },
  },
  artifacts: [],
});

describe("canvas-profile/1", () => {
  it("enforces allocation and balances synchronous spans on exceptions", () => {
    const c = new CanvasProfileCollector(4, () => 100);
    c.begin(id);
    expect(() =>
      c.span(id, "canvas.serialize", () => {
        throw Error("failed");
      }),
    ).toThrow();
    expect(c.snapshot().openSpans).toEqual([]);
    expect(() => c.begin(id)).toThrow(/strictly increasing/);
    expect(() =>
      c.emit(id, { eventType: "outcome", outcome: "displayed" }),
    ).toThrow(/displayed/);
    expect(validateCanvasProfile(receipt(), c.events)).toEqual([]);
  });
  it("accounts for bounded loss and rejects identity, clock, hash and display gaps", () => {
    const c = new CanvasProfileCollector(1, () => 100);
    c.begin(id);
    c.emit(id, { eventType: "outcome", outcome: "accepted" });
    c.emit(id, { eventType: "outcome", outcome: "completed" });
    expect(c.snapshot().droppedEvents).toBe(1);
    const bad = receipt();
    bad.losses.collector = 1;
    bad.hashes.wasm.after = "b".repeat(64);
    bad.clocks[0].uncertaintyUs = -1;
    bad.processes[0].startIdentity = "";
    bad.processes[0].processStartAfter = "changed";
    bad.symbols.invalidSampleDeltas = 1;
    bad.gpu.disjoint = true;
    bad.markers.end = 0;
    bad.output.valid = false;
    bad.presentations = {
      source: null,
      count: null,
      reason: "no display trace",
    };
    const errors = validateCanvasProfile(bad, [
      { ...c.events[0], outcome: "displayed" },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        "lost profiling events",
        "wasm hash drift",
        "missing or invalid clock mapping",
        "missing PID/TID start identity",
        "stale process identity",
        "displayed without presentation evidence",
        "actual presentations unavailable",
        "nonpositive profiler sample deltas",
        "disjoint GPU query",
        "missing or invalid trace markers",
        "output mismatch or unverified",
      ]),
    );
  });
  it("permits late asynchronous results for an older operation", () => {
    const c = new CanvasProfileCollector();
    c.begin(id);
    c.begin({ ...id, operationId: 2, kind: "present-only" });
    c.emit(id, {
      eventType: "gpu-result",
      gpuElapsedNs: null,
      gpuReason: "timer unavailable",
    });
    expect(validateCanvasProfile(receipt(), c.events)).toEqual([]);
  });
  it("rejects reversed and crossed synchronous phase edges", () => {
    const c = new CanvasProfileCollector(20, () => 100);
    c.begin(id);
    c.emit(id, { eventType: "phase-edge", phase: "rust.admit", edge: "start" });
    c.emit(id, { eventType: "phase-edge", phase: "rust.upload", edge: "start" });
    c.emit(id, { eventType: "phase-edge", phase: "rust.admit", edge: "end" });
    c.emit(id, { eventType: "phase-edge", phase: "rust.upload", edge: "end" });
    expect(validateCanvasProfile(receipt(), c.events)).toContain(
      "phase order mismatch r:mount:1:rust.admit");
    const reversed = c.events.map(event => ({ ...event }));
    reversed[1].timestampUs = "101";
    reversed[2].timestampUs = "100";
    expect(validateCanvasProfile(receipt(), reversed)).toContain(
      "phase order mismatch r:mount:1:rust.admit");
  });
  it("rejects phantom, retyped, cross-mount and overflowing operation IDs", () => {
    const c = new CanvasProfileCollector();
    c.begin(id);
    expect(() =>
      c.emit(
        { ...id, operationId: 2 },
        { eventType: "outcome", outcome: "built" },
      ),
    ).toThrow(/begin matching/);
    expect(() =>
      c.emit(
        { ...id, kind: "present-only" },
        { eventType: "outcome", outcome: "built" },
      ),
    ).toThrow(/begin matching/);
    expect(() =>
      c.begin({ ...id, rendererInstanceId: "other", operationId: 2 }),
    ).toThrow(/one run/);
    expect(() => c.begin({ ...id, operationId: 0x100000000 })).toThrow(
      /uint32/,
    );
  });
  it("reports open spans and dropped records at capacity", () => {
    const c = new CanvasProfileCollector(1, () => 100);
    c.begin(id);
    c.emit(id, {
      eventType: "phase-edge",
      phase: "canvas.serialize",
      edge: "start",
    });
    c.emit(id, { eventType: "counter", counters: { bytes: 4 } });
    expect(c.snapshot().openSpans).toEqual([
      { key: "1:canvas.serialize", count: 1 },
    ]);
    expect(c.snapshot().droppedEvents).toBe(1);
    expect(validateCanvasProfile(receipt(), c.events)).toContain(
      "open phase spans",
    );
  });
  it("rejects imported allocation reversal, identity drift and invalid GPU data", () => {
    const c = new CanvasProfileCollector(10, () => 100);
    c.begin(id);
    c.emit(id, { eventType: "outcome", outcome: "built" });
    const next = { ...id, operationId: 2, kind: "present-only" as const };
    c.begin(next);
    c.emit(next, {
      eventType: "gpu-result",
      gpuElapsedNs: null,
      gpuReason: "query unsupported",
    });
    const imported = c.events.map((event) => ({ ...event }));
    imported[1].timestampUs = "99";
    imported[1].gpuReason = undefined;
    expect(validateCanvasProfile(receipt(), imported)).toEqual(
      expect.arrayContaining([
        "operation allocation order mismatch",
        "invalid or disjoint GPU result",
      ]),
    );
    imported.push({
      ...imported[1],
      kind: "retained-patch",
      gpuReason: "query unsupported",
    });
    expect(validateCanvasProfile(receipt(), imported)).toContain(
      "operation identity changed",
    );
  });
  it("accepts displayed only with a receipt-backed presentation identity", () => {
    const c = new CanvasProfileCollector(10, () => 100);
    c.begin(id);
    expect(() =>
      c.emit(id, { eventType: "outcome", outcome: "displayed" }),
    ).toThrow(/external presentation/);
    c.emit(id, {
      eventType: "outcome",
      outcome: "displayed",
      presentationSource: "test compositor",
      presentationId: "frame1",
    });
    expect(validateCanvasProfile(receipt(), c.events)).toEqual([]);
    const wrong = c.events.map((event) => ({
      ...event,
      presentationId: "other",
    }));
    expect(validateCanvasProfile(receipt(), wrong)).toContain(
      "displayed event lacks matching presentation identity",
    );
  });
  it("rejects an empty event stream for delivered work", () => {
    const delivered = receipt();
    delivered.workload.delivered = 1;
    expect(validateCanvasProfile(delivered, [])).toContain(
      "missing operation events for delivered workload",
    );
  });
});
