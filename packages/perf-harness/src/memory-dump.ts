// Chrome's own accounting of its GPU memory: `Tracing.requestMemoryDump` (memory-infra), read at the
// SAME bracket as the driver number in nvidia.ts.
//
// OFF BY DEFAULT (`--memory-dump`), and a CROSS-CHECK, never the answer. This is the SELF-COUNTED
// rung: it is Chrome adding up what it believes it allocated. `nvidia.ts` is the driver saying what
// the card is holding for that process. WHERE THE TWO DISAGREE, THE DRIVER NUMBER IS THE TRUTH — the
// gap is real (driver-side alignment, mip padding, the compositor's own framebuffers, allocations
// Chrome does not attribute to a dump provider), and it is the reason this flag exists at all rather
// than the reason to distrust the driver.
//
// THE TRAP THIS FLAG EXISTS TO AVOID FALLING INTO: read `size`, NOT `effective_size`.
// `effective_size` DEDUPLICATES an allocation across the processes that share it — so a texture the
// renderer owns and shares into the GPU process is charged to exactly one of them, and reading it
// from the GPU process's dump reports 0 for memory that is unmistakably on the card. `size` is the
// allocator's own total and is what corresponds to a driver figure.

import type { TraceEvent } from "./trace";

/** The three GPU-side allocator families worth reading. Everything else in a dump is CPU memory. */
export interface MemoryDumpTotals {
  /** `gpu/gl/textures` — GL texture objects. */
  glTextures: number | null;
  /** `gpu/shared_images` — the SharedImage backings the compositor and canvas paths use. */
  sharedImages: number | null;
  /** `skia/gpu_resources/*` summed over its direct children (one per GrContext). */
  skiaGpuResources: number | null;
}

export interface MemoryDumpSample {
  pid: number;
  ts: number;
  totals: MemoryDumpTotals;
}

export interface MemoryDumpCrossCheck {
  /** The last dump in the capture, i.e. the state the measured window ended in. */
  after: MemoryDumpTotals;
  /** Last minus first: what the window itself added. `null` per field when either end is missing. */
  delta: MemoryDumpTotals;
}

const SKIA_PREFIX = "skia/gpu_resources/";

/**
 * Every memory-infra dump in a capture, one entry per (process, dump), in trace order.
 *
 * Matched on `ph: "v"` (the memory-dump phase) rather than on the event NAME: an explicitly requested
 * dump and a periodic one carry different names (`explicitly_triggered`, `periodic_interval`) and
 * this harness must not care which mechanism produced it.
 */
export function parseMemoryDumps(
  events: Iterable<TraceEvent>,
): MemoryDumpSample[] {
  const samples: MemoryDumpSample[] = [];
  for (const event of events) {
    if (event.ph !== "v") {
      continue;
    }
    const dumps = (event.args as { dumps?: unknown } | undefined)?.dumps as
      | { allocators?: Record<string, unknown> }
      | undefined;
    const allocators = dumps?.allocators;
    if (!allocators) {
      continue;
    }
    let skia: number | null = null;
    for (const [name, node] of Object.entries(allocators)) {
      // DIRECT children only. Allocator dumps nest, and a parent's size already includes its
      // children's — summing every node under the prefix would double-count the whole tree.
      if (
        !name.startsWith(SKIA_PREFIX) ||
        name.slice(SKIA_PREFIX.length).includes("/")
      ) {
        continue;
      }
      const size = allocatorSize(node);
      if (size !== null) {
        skia = (skia ?? 0) + size;
      }
    }
    samples.push({
      pid: event.pid,
      ts: event.ts,
      totals: {
        glTextures: allocatorSize(allocators["gpu/gl/textures"]),
        sharedImages: allocatorSize(allocators["gpu/shared_images"]),
        skiaGpuResources: skia,
      },
    });
  }
  return samples;
}

/**
 * First-vs-last dump for one process.
 *
 * `null` when that process produced fewer than two dumps: a single dump has no window to difference,
 * and inventing a zero delta from one reading would be a measurement the run never took.
 */
export function memoryDumpCrossCheck(
  samples: readonly MemoryDumpSample[],
  pid: number,
): MemoryDumpCrossCheck | null {
  const mine = samples
    .filter((sample) => sample.pid === pid)
    .sort((a, b) => a.ts - b.ts);
  if (mine.length < 2) {
    return null;
  }
  const first = mine[0].totals;
  const last = mine[mine.length - 1].totals;
  const diff = (key: keyof MemoryDumpTotals): number | null =>
    first[key] === null || last[key] === null
      ? null
      : (last[key] as number) - (first[key] as number);
  return {
    after: last,
    delta: {
      glTextures: diff("glTextures"),
      sharedImages: diff("sharedImages"),
      skiaGpuResources: diff("skiaGpuResources"),
    },
  };
}

/**
 * `attrs.size.value` off one allocator dump.
 *
 * DELIBERATELY NOT `effective_size` — see the header. The value is a HEX STRING in the trace format
 * (`"1a2b3c"`, no `0x`), which parses as a plausible-looking decimal if read with `Number()`: 16
 * times too small at the low end and NaN as soon as a hex digit above 9 appears. A number is accepted
 * too, for a future trace format that writes one.
 */
function allocatorSize(node: unknown): number | null {
  const size = (node as { attrs?: { size?: { value?: unknown } } } | undefined)
    ?.attrs?.size?.value;
  if (typeof size === "number") {
    return Number.isFinite(size) ? size : null;
  }
  if (typeof size !== "string") {
    return null;
  }
  const parsed = Number.parseInt(size, 16);
  return Number.isFinite(parsed) ? parsed : null;
}
