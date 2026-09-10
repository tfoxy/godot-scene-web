// The `--memory-dump` cross-check: Chrome's own GPU allocator totals, out of the trace.
//
// The fixture is the memory-infra event shape: `ph: "v"`, allocator dumps under
// `args.dumps.allocators`, and sizes as HEX STRINGS. The numbers are invented; the shape is not.

import { describe, expect, it } from "vitest";
import { memoryDumpCrossCheck, parseMemoryDumps } from "../src/memory-dump";
import type { TraceEvent } from "../src/trace";

const hex = (bytes: number) => bytes.toString(16);

function dump(
  pid: number,
  ts: number,
  allocators: Record<string, { size: number; effectiveSize?: number }>,
): TraceEvent {
  return {
    name: "explicitly_triggered",
    cat: "disabled-by-default-memory-infra",
    ph: "v",
    ts,
    pid,
    tid: 1,
    args: {
      dumps: {
        level_of_detail: "detailed",
        allocators: Object.fromEntries(
          Object.entries(allocators).map(([name, value]) => [
            name,
            {
              guid: "1",
              attrs: {
                size: {
                  type: "scalar",
                  units: "bytes",
                  value: hex(value.size),
                },
                effective_size: {
                  type: "scalar",
                  units: "bytes",
                  value: hex(value.effectiveSize ?? value.size),
                },
              },
            },
          ]),
        ),
      },
    },
  };
}

const GPU_PID = 42;

const EVENTS: TraceEvent[] = [
  { name: "RunTask", ph: "X", ts: 0, dur: 1, pid: GPU_PID, tid: 1 },
  dump(GPU_PID, 100, {
    "gpu/gl/textures": { size: 8_000_000 },
    "gpu/shared_images": { size: 2_000_000 },
    "skia/gpu_resources/gr_context_0x1": { size: 1_000_000 },
    "skia/gpu_resources/gr_context_0x2": { size: 500_000 },
  }),
  // Another process dumped in the same pass. It must not leak into the GPU process's totals.
  dump(7, 100, { "gpu/gl/textures": { size: 999_000_000 } }),
  dump(GPU_PID, 900, {
    "gpu/gl/textures": {
      size: 9_500_000,
      // THE TRAP: a texture the renderer owns and shares into the GPU process is charged to exactly
      // one of them by `effective_size`. Reading that field here would report 1.5 MB of the 9.5 MB
      // as belonging to nobody — memory that is unmistakably on the card.
      effectiveSize: 8_000_000,
    },
    "gpu/shared_images": { size: 2_400_000 },
    "skia/gpu_resources/gr_context_0x1": { size: 1_200_000 },
    "skia/gpu_resources/gr_context_0x2": { size: 500_000 },
  }),
];

describe("memory-infra dumps", () => {
  it("reads `size`, NEVER `effective_size`", () => {
    const samples = parseMemoryDumps(EVENTS);
    expect(samples).toHaveLength(3);
    expect(samples[2].totals.glTextures).toBe(9_500_000);
  });

  it("sums skia/gpu_resources/* over its DIRECT children only", () => {
    // Allocator dumps nest and a parent's size already includes its children's, so a prefix sum over
    // the whole subtree would double-count the tree.
    const nested = [
      dump(GPU_PID, 1, {
        "skia/gpu_resources/gr_context_0x1": { size: 1_000_000 },
        "skia/gpu_resources/gr_context_0x1/textures": { size: 900_000 },
      }),
    ];
    expect(parseMemoryDumps(nested)[0].totals.skiaGpuResources).toBe(1_000_000);
  });

  it("reports an allocator the dump did not carry as null, not 0", () => {
    const sparse = [dump(GPU_PID, 1, { "gpu/gl/textures": { size: 10 } })];
    expect(parseMemoryDumps(sparse)[0].totals).toEqual({
      glTextures: 10,
      sharedImages: null,
      skiaGpuResources: null,
    });
  });

  it("parses the size as HEX, which decimal parsing gets wrong by 16x", () => {
    // `"a00000"` is 10485760, not 1000000. A `Number()` here would be plausible and wrong.
    const event = dump(GPU_PID, 1, { "gpu/gl/textures": { size: 0xa00000 } });
    expect(parseMemoryDumps([event])[0].totals.glTextures).toBe(10_485_760);
  });
});

describe("the cross-check across the bracket", () => {
  it("differences the LAST dump against the FIRST, per allocator, for one process", () => {
    const crossCheck = memoryDumpCrossCheck(parseMemoryDumps(EVENTS), GPU_PID);
    expect(crossCheck).toEqual({
      after: {
        glTextures: 9_500_000,
        sharedImages: 2_400_000,
        skiaGpuResources: 1_700_000,
      },
      delta: {
        glTextures: 1_500_000,
        sharedImages: 400_000,
        skiaGpuResources: 200_000,
      },
    });
  });

  it("is null when the process produced fewer than two dumps", () => {
    // One reading has no window to difference. A zero delta invented from it would be a measurement
    // the run never took.
    expect(memoryDumpCrossCheck(parseMemoryDumps(EVENTS), 7)).toBeNull();
    expect(memoryDumpCrossCheck([], GPU_PID)).toBeNull();
  });

  it("leaves a delta null when either end of the bracket lacks the allocator", () => {
    const events = [
      dump(GPU_PID, 1, { "gpu/gl/textures": { size: 10 } }),
      dump(GPU_PID, 2, {
        "gpu/gl/textures": { size: 30 },
        "gpu/shared_images": { size: 50 },
      }),
    ];
    const crossCheck = memoryDumpCrossCheck(parseMemoryDumps(events), GPU_PID);
    expect(crossCheck?.delta).toEqual({
      glTextures: 20,
      // Present after, absent before: the growth is UNKNOWN, not 50.
      sharedImages: null,
      skiaGpuResources: null,
    });
    expect(crossCheck?.after.sharedImages).toBe(50);
  });
});
