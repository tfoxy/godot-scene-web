/** Opt-in, bounded canvas-profile/1 event transport. Timestamps use performance.timeOrigin + now in microseconds; receipts must map that clock to trace and OS clocks. */
export type CanvasProfileKind =
  | "full-build"
  | "retained-patch"
  | "present-only";
export type CanvasProfileOutcome =
  | "built"
  | "accepted"
  | "submitted"
  | "completed"
  | "displayed"
  | "refused"
  | "superseded"
  | "failed";
export interface CanvasProfileIdentity {
  runId: string;
  rendererInstanceId: string;
  operationId: number;
  kind: CanvasProfileKind;
  buildId?: number;
  sceneRevision?: number;
}
export interface CanvasProfileEvent extends CanvasProfileIdentity {
  schema: "canvas-profile/1";
  eventType: "phase-edge" | "outcome" | "counter" | "gpu-result";
  clockDomain: "performance.timeOrigin+now";
  timestampUs: string;
  phase?: string;
  edge?: "start" | "end";
  outcome?: CanvasProfileOutcome;
  reason?: string;
  counters?: Record<string, number>;
  gpuElapsedNs?: number | null;
  gpuDisjoint?: boolean | null;
  gpuReason?: string;
  presentationSource?: string;
  presentationId?: string;
}

export interface CanvasProfileMetric {
  value: number | string | null;
  unit: string;
  method: string;
  coverage: number | null;
  reason?: string;
}
export interface CanvasProfileReceipt {
  schema: "canvas-profile/1";
  runId: string;
  rendererInstanceId: string;
  command: string;
  profiler: Record<string, unknown>;
  hashes: Record<
    "source" | "wasm" | "glue" | "input" | "resources",
    { before: string | null; after: string | null; reason?: string }
  >;
  effective: Record<string, unknown>;
  browser: Record<string, unknown>;
  gpu: Record<string, unknown>;
  processes: {
    pid: number;
    tid: number;
    startIdentity: string;
    threadStartBefore: string;
    threadStartAfter: string;
    processStartBefore: string;
    processStartAfter: string;
    role: string;
  }[];
  clocks: {
    from: string;
    to: string;
    offsetUs: number;
    uncertaintyUs: number;
  }[];
  markers: Record<string, unknown>;
  workload: Record<string, unknown>;
  output: Record<string, unknown>;
  symbols: Record<string, unknown>;
  losses: {
    trace: number;
    collector: number;
    profiler: number | null;
    profilerReason?: string;
  };
  presentations: {
    source: string | null;
    count: number | null;
    ids?: string[];
    reason?: string;
  };
  metrics: Record<string, CanvasProfileMetric>;
  artifacts: { path: string; sha256: string }[];
}

export function validateCanvasProfile(
  receipt: CanvasProfileReceipt,
  events: readonly CanvasProfileEvent[],
): string[] {
  const errors: string[] = [];
  if (receipt.schema !== "canvas-profile/1")
    errors.push("wrong receipt schema");
  if (!receipt.runId || !receipt.rendererInstanceId)
    errors.push("missing run identity");
  for (const [name, hash] of Object.entries(receipt.hashes ?? {})) {
    if (!hash.before || !hash.after)
      errors.push(`${name} hash unavailable: ${hash.reason ?? "no reason"}`);
    else if (
      !/^[a-f0-9]{64}$/.test(hash.before) ||
      !/^[a-f0-9]{64}$/.test(hash.after)
    )
      errors.push(`${name} invalid SHA-256`);
    else if (hash.before !== hash.after) errors.push(`${name} hash drift`);
  }
  for (const name of ["source", "wasm", "glue", "input", "resources"])
    if (!receipt.hashes?.[name as keyof CanvasProfileReceipt["hashes"]])
      errors.push(`missing ${name} hash`);
  if (
    (receipt.losses?.trace ?? 0) > 0 ||
    (receipt.losses?.collector ?? 0) > 0 ||
    (receipt.losses?.profiler ?? 0) > 0
  )
    errors.push("lost profiling events");
  if (receipt.losses?.profiler === null && !receipt.losses.profilerReason)
    errors.push("missing profiler loss reason");
  if (
    !receipt.processes?.length ||
    receipt.processes.some(
      (p) =>
        !p.pid ||
        !p.tid ||
        !p.startIdentity ||
        !p.threadStartBefore ||
        !p.threadStartAfter ||
        !p.processStartBefore ||
        !p.processStartAfter,
    )
  )
    errors.push("missing PID/TID start identity");
  if (
    receipt.processes?.some(
      (p) =>
        (p.processStartBefore &&
          p.processStartAfter &&
          p.processStartBefore !== p.processStartAfter) ||
        (p.threadStartBefore &&
          p.threadStartAfter &&
          p.threadStartBefore !== p.threadStartAfter),
    )
  )
    errors.push("stale process identity");
  if (
    !receipt.clocks?.length ||
    receipt.clocks.some(
      (c) =>
        !Number.isFinite(c.offsetUs) ||
        !Number.isFinite(c.uncertaintyUs) ||
        c.uncertaintyUs < 0,
    )
  )
    errors.push("missing or invalid clock mapping");
  if (
    receipt.clocks?.some(
      (c) =>
        c.uncertaintyUs >
        (typeof receipt.profiler?.maxClockUncertaintyUs === "number"
          ? receipt.profiler.maxClockUncertaintyUs
          : 1000),
    )
  )
    errors.push("clock uncertainty exceeds limit");
  if (
    typeof receipt.markers?.begin !== "number" ||
    typeof receipt.markers?.end !== "number" ||
    receipt.markers.end <= receipt.markers.begin
  )
    errors.push("missing or invalid trace markers");
  const rust = receipt.markers?.rust as
    | {
        count?: number;
        unjoined?: number;
        unbalanced?: number;
        phases?: string[];
      }
    | undefined;
  const expectedRustPhases = Array.isArray(receipt.workload?.expectedRustPhases)
    ? (receipt.workload.expectedRustPhases as string[])
    : ["admit", "encode-submit", "resume"];
  if (
    !rust?.count ||
    rust.unjoined ||
    rust.unbalanced ||
    !expectedRustPhases.every((phase) => rust.phases?.includes(phase))
  )
    errors.push("missing, unjoined or unbalanced Rust marks");
  if (receipt.workload?.valid !== true)
    errors.push("workload delivery mismatch");
  if (
    typeof receipt.workload?.delivered === "number" &&
    receipt.workload.delivered > 0 &&
    new Set(events.map((event) => event.operationId)).size <
      receipt.workload.delivered
  )
    errors.push("missing operation events for delivered workload");
  if (receipt.output?.valid !== true)
    errors.push("output mismatch or unverified");
  if (
    typeof receipt.symbols?.invalidSampleDeltas === "number" &&
    receipt.symbols.invalidSampleDeltas > 0
  )
    errors.push("nonpositive profiler sample deltas");
  if (receipt.gpu?.disjoint === true) errors.push("disjoint GPU query");
  if (receipt.presentations?.count == null) {
    errors.push("actual presentations unavailable");
    if (!receipt.presentations?.reason)
      errors.push("missing presentation reason");
  } else if (!receipt.presentations.source)
    errors.push("missing presentation source");
  for (const [name, metric] of Object.entries(receipt.metrics ?? {})) {
    if (metric.value === null && !metric.reason)
      errors.push(`${name} unavailable without reason`);
    if (
      metric.coverage !== null &&
      (metric.coverage < 0 || metric.coverage > 1)
    )
      errors.push(`${name} invalid coverage`);
  }
  const open = new Map<string, number>();
  const phaseStacks = new Map<string, Array<{ phase: string; startUs: bigint }>>();
  const presentationIds = new Set<string>();
  const identities = new Map<
    number,
    {
      kind: CanvasProfileKind;
      buildId?: number;
      sceneRevision?: number;
      firstUs: bigint;
    }
  >();
  for (const event of events) {
    if (
      event.schema !== "canvas-profile/1" ||
      event.runId !== receipt.runId ||
      event.rendererInstanceId !== receipt.rendererInstanceId
    )
      errors.push("event identity mismatch");
    if (!/^(0|[1-9][0-9]*)$/.test(event.timestampUs))
      errors.push("invalid decimal timestamp");
    if (event.clockDomain !== "performance.timeOrigin+now")
      errors.push("event clock domain mismatch");
    if (!["full-build", "retained-patch", "present-only"].includes(event.kind))
      errors.push("invalid operation kind");
    if (
      !["phase-edge", "outcome", "counter", "gpu-result"].includes(
        event.eventType,
      )
    )
      errors.push("invalid event type");
    if (
      !Number.isInteger(event.operationId) ||
      event.operationId < 1 ||
      event.operationId > 0xffffffff
    )
      errors.push("invalid operation ID");
    // Async GPU results can arrive after a newer operation; allocation order is
    // enforced by begin(), not inferred from arrival order in the event stream.
    const op = `${event.runId}:${event.rendererInstanceId}:${event.operationId}`;
    const eventTime = /^(0|[1-9][0-9]*)$/.test(event.timestampUs)
      ? BigInt(event.timestampUs) : null;
    if (eventTime !== null) {
      const time = eventTime;
      const previous = identities.get(event.operationId);
      if (!previous)
        identities.set(event.operationId, {
          kind: event.kind,
          buildId: event.buildId,
          sceneRevision: event.sceneRevision,
          firstUs: time,
        });
      else if (
        previous.kind !== event.kind ||
        previous.buildId !== event.buildId ||
        previous.sceneRevision !== event.sceneRevision
      )
        errors.push("operation identity changed");
    }
    if (event.eventType === "phase-edge") {
      if (
        !event.phase ||
        !/^(canvas|rust|couch)\.[a-z0-9.-]+$/.test(event.phase)
      )
        errors.push("invalid phase name");
      const key = `${op}:${event.phase}`;
      const stack = phaseStacks.get(op) ?? [];
      if (event.edge === "start") {
        open.set(key, (open.get(key) ?? 0) + 1);
        if (eventTime !== null) { stack.push({ phase: event.phase!, startUs: eventTime }); phaseStacks.set(op, stack); }
      }
      else if (event.edge === "end") {
        const count = open.get(key) ?? 0;
        if (!count) errors.push(`unbalanced ${key}`);
        else if (count === 1) open.delete(key);
        else open.set(key, count - 1);
        if (stack.at(-1)?.phase !== event.phase) errors.push(`phase order mismatch ${key}`);
        else if (eventTime !== null) {
          if (eventTime < stack.at(-1)!.startUs) errors.push(`phase time reversed ${key}`);
          stack.pop();
          if (!stack.length) phaseStacks.delete(op);
        }
      } else errors.push("invalid phase edge");
    }
    if (event.eventType === "outcome") {
      if (
        !event.outcome ||
        ![
          "built",
          "accepted",
          "submitted",
          "completed",
          "displayed",
          "refused",
          "superseded",
          "failed",
        ].includes(event.outcome)
      )
        errors.push("invalid outcome");
      if (
        ["refused", "superseded", "failed"].includes(event.outcome ?? "") &&
        !event.reason
      )
        errors.push("terminal outcome lacks reason");
    }
    if (
      event.eventType === "counter" &&
      (!event.counters ||
        Object.values(event.counters).some(
          (value) => !Number.isFinite(value) || value < 0,
        ))
    )
      errors.push("invalid counter");
    if (
      event.eventType === "gpu-result" &&
      ((event.gpuElapsedNs == null && !event.gpuReason) ||
        (event.gpuElapsedNs != null &&
          (!Number.isFinite(event.gpuElapsedNs) ||
            event.gpuElapsedNs < 0 ||
            event.gpuDisjoint === true)))
    )
      errors.push("invalid or disjoint GPU result");
    if (
      event.outcome === "displayed" &&
      (receipt.presentations.count == null || receipt.presentations.count < 1)
    )
      errors.push("displayed without presentation evidence");
    if (event.outcome === "displayed") {
      if (
        !event.presentationSource ||
        !event.presentationId ||
        event.presentationSource !== receipt.presentations.source ||
        !receipt.presentations.ids?.includes(event.presentationId)
      )
        errors.push("displayed event lacks matching presentation identity");
      if (event.presentationId) {
        if (presentationIds.has(event.presentationId))
          errors.push("duplicate presentation identity");
        else presentationIds.add(event.presentationId);
      }
    }
  }
  const allocations = [...identities].sort(([a], [b]) => a - b);
  for (let i = 1; i < allocations.length; i++)
    if (allocations[i][1].firstUs < allocations[i - 1][1].firstUs)
      errors.push("operation allocation order mismatch");
  if (open.size) errors.push("open phase spans");
  return errors;
}

/** A collector belongs to one renderer mount. The consumer owns monotonic IDs. */
export class CanvasProfileCollector {
  readonly events: CanvasProfileEvent[] = [];
  droppedEvents = 0;
  private readonly open = new Map<string, number>();
  private readonly begun = new Map<number, CanvasProfileIdentity>();
  private mount: string | undefined;
  private lastId = 0;

  constructor(
    readonly capacity = 50_000,
    private readonly now = () =>
      performance.timeOrigin * 1000 + performance.now() * 1000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("profile capacity must be positive");
  }

  begin(identity: CanvasProfileIdentity): void {
    const mount = `${identity.runId}:${identity.rendererInstanceId}`;
    if (
      !identity.runId ||
      !identity.rendererInstanceId ||
      (this.mount && mount !== this.mount)
    )
      throw new Error("collector belongs to one run and renderer mount");
    if (
      !Number.isInteger(identity.operationId) ||
      identity.operationId < 1 ||
      identity.operationId > 0xffffffff ||
      identity.operationId <= this.lastId
    )
      throw new Error(
        "operation IDs must be positive, uint32 and strictly increasing",
      );
    this.mount = mount;
    this.lastId = identity.operationId;
    this.begun.set(identity.operationId, { ...identity });
    if (this.begun.size > this.capacity) {
      this.begun.delete(this.begun.keys().next().value!);
      this.droppedEvents++;
    }
  }

  emit(
    identity: CanvasProfileIdentity,
    data: Pick<
      CanvasProfileEvent,
      | "eventType"
      | "phase"
      | "edge"
      | "outcome"
      | "reason"
      | "counters"
      | "gpuElapsedNs"
      | "gpuDisjoint"
      | "gpuReason"
      | "presentationSource"
      | "presentationId"
    >,
  ): void {
    const begun = this.begun.get(identity.operationId);
    if (
      !begun ||
      begun.runId !== identity.runId ||
      begun.rendererInstanceId !== identity.rendererInstanceId ||
      begun.kind !== identity.kind ||
      begun.buildId !== identity.buildId ||
      begun.sceneRevision !== identity.sceneRevision
    )
      throw new Error("begin matching operation before emitting");
    if (
      data.outcome === "displayed" &&
      (!data.presentationSource || !data.presentationId)
    )
      throw new Error("displayed requires external presentation evidence");
    const event: CanvasProfileEvent = {
      schema: "canvas-profile/1",
      ...identity,
      ...data,
      clockDomain: "performance.timeOrigin+now",
      timestampUs: Math.round(this.now()).toString(),
    };
    if (data.eventType === "phase-edge") {
      if (!data.phase || !data.edge)
        throw new Error("phase edge needs name and edge");
      const key = `${identity.operationId}:${data.phase}`;
      if (data.edge === "start") {
        if (!this.open.has(key) && this.open.size >= this.capacity)
          this.droppedEvents++;
        else this.open.set(key, (this.open.get(key) ?? 0) + 1);
      } else {
        const count = this.open.get(key) ?? 0;
        if (!count) throw new Error(`unbalanced phase ${key}`);
        if (count === 1) this.open.delete(key);
        else this.open.set(key, count - 1);
      }
    }
    if (this.events.length < this.capacity) this.events.push(event);
    else this.droppedEvents++;
  }

  span<T>(identity: CanvasProfileIdentity, phase: string, action: () => T): T {
    this.emit(identity, { eventType: "phase-edge", phase, edge: "start" });
    try {
      return action();
    } finally {
      this.emit(identity, { eventType: "phase-edge", phase, edge: "end" });
    }
  }

  snapshot() {
    return {
      schema: "canvas-profile/1" as const,
      events: [...this.events],
      droppedEvents: this.droppedEvents,
      openSpans: [...this.open].map(([key, count]) => ({ key, count })),
    };
  }
}
