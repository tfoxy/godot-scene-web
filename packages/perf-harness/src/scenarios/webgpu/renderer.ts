// The WebGPU half of S7 `effects-webgpu`: device acquisition, the two pipelines, and the per-frame
// encode. Every WebGPU object in this scenario is created here; `wgsl.ts` and `pack.ts` stay
// importable in plain node precisely so this file can be the only thing that needs a browser.
//
// WHAT THE ENCODE SHAPE IS MEASURING. The shipped WebGL architecture is ONE offscreen canvas, one
// draw per node into a viewport sub-rect of it, and then a `ctx2d.drawImage` blit of that sub-rect
// onto each node's own 2D canvas, which the compositor then composites N of. S6 measured the phone
// spending ~0.9 of a core inside the GPU PROCESS on that, identically for particles and shaders,
// and dragging whole-page activations from 89 Hz to 47. Two different things could be responsible —
// the API's submit cost, or the blit — so this file offers exactly two encode shapes and the
// scenario runs both:
//
//   DIRECT  N render passes, one per node's OWN `GPUCanvasContext`, ONE `queue.submit`. No blit
//           exists at all: the pixels are produced where the compositor already reads them.
//   BLIT    ONE render pass into ONE shared canvas with N `setViewport` sub-rects, ONE
//           `queue.submit`, then the same N `drawImage` blits the shipped path does. This is the
//           shipped ARCHITECTURE with only the API swapped.
//
// `blit − direct` is therefore the blit's price and `blit − webgl` is the API's, measured in the
// same session on the same pixels. One submit per frame in both shapes is deliberate: a per-pass
// submit would make "WebGPU" mean "N submits" and the comparison would be about batching.
//
// COUNTERS, not beliefs. `passes`, `submits`, `draws` and `blits` are counted where they happen, so
// a table reader can check that the direct arm really did N passes and one submit rather than take
// the arm's name for it. `adapterFallback`, `gpuErrors` and `deviceLosses` are the VALIDITY rows: a
// fallback adapter is a CPU implementation wearing the API's name and voids the arm outright.

import {
  INSTANCE_STRIDE,
  type InstanceBuffer,
} from "@godot-scene-web/effects/particles";
import { packedBytes } from "./pack";
import {
  PARTICLE_FS_ENTRY,
  PARTICLE_VERTEX_BUFFERS,
  PARTICLE_VS_ENTRY,
  PARTICLE_WGSL,
  PREMULTIPLIED_BLEND,
  SHADER_FS_ENTRY,
  SHADER_VS_ENTRY,
  SHADER_WGSL,
} from "./wgsl";

/** How long `acquireGpu` waits for an adapter/device before calling the arm unmeasurable. */
const ACQUIRE_TIMEOUT_MS = 8000;

/**
 * Bytes per per-cell uniform slot. 256 is the maximum `minUniformBufferOffsetAlignment` any WebGPU
 * implementation may report, so a buffer laid out at this pitch is bindable with a dynamic offset
 * everywhere; the real limit is read off the device and only ever ROUNDS DOWN from here.
 */
const UNIFORM_SLOT_BYTES = 256;

/**
 * WebGPU's usage / visibility BIT FLAGS, spelled out from the spec.
 *
 * TypeScript 6.0.3's `lib.dom.d.ts` ships every WebGPU *interface* but NOT the three flag namespace
 * objects (`GPUBufferUsage`, `GPUShaderStage`, `GPUTextureUsage`) — only their `…Flags = number`
 * aliases. Reading the real globals instead is not an option: this module is reachable from the node
 * CLI, which imports `scenarios/index.ts` for the declared parameter defaults, and a module-scope
 * `GPUBufferUsage.VERTEX` would throw on import under node and take EVERY scenario down with it. The
 * values are normative constants in the WebGPU specification, so stating them is safe in a way that
 * copying an implementation detail would not be.
 */
const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
} as const;
const SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;

export interface GpuCounters {
  /** `uncapturederror` events. Any non-zero value means a frame was silently wrong. */
  gpuErrors: number;
  /** Resolutions of `device.lost`. A lost device stops producing frames; the arm is over. */
  deviceLosses: number;
}

export interface GpuHandle {
  device: GPUDevice;
  format: GPUTextureFormat;
  /**
   * `GPUAdapterInfo.isFallbackAdapter` — TRUE means the "GPU" is a software implementation, so
   * every number the arm produces is about a CPU rasteriser and none of them answer the question.
   * Captured rather than refused: the arm should REPORT that it is void, not vanish.
   */
  adapterFallback: boolean;
  counters: GpuCounters;
  destroy(): void;
}

/** One render target: a node's own canvas (direct) or a sub-rect of the shared one (blit). */
export interface CellTarget {
  /** Where this cell's pixels land, in backing-store px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameCounts {
  passes: number;
  submits: number;
  draws: number;
}

/**
 * Acquire a device, front-loading the actionable fix in every failure.
 *
 * `ready()` is the only awaited scenario hook and a throw from it ABORTS THE WHOLE RUN, surfacing
 * as `Runtime.evaluate threw: <the first 800 characters>`. So every message here starts with what to
 * do, not with what went wrong: an operator reading a truncated stack has to be able to act on the
 * first line.
 */
export async function acquireGpu(): Promise<GpuHandle> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    throw new Error(
      "effects-webgpu: run the WebGL arms instead (--mechanism particles-webgl,shaders-webgl), or launch Chrome with --enable-unsafe-webgpu (desktop: --chrome-arg=--enable-unsafe-webgpu). navigator.gpu is undefined. The page origin is not the problem — 127.0.0.1 is a secure context on desktop and through `adb reverse` on the phone — so a missing navigator.gpu here means WebGPU is off in this build/flag set, not that the harness served the page wrongly.",
    );
  }
  const adapter = await withDeadline(
    gpu.requestAdapter(),
    "requestAdapter() did not resolve",
  );
  if (!adapter) {
    throw new Error(
      "effects-webgpu: this Chrome exposes navigator.gpu but requestAdapter() returned null — there is no usable adapter. On desktop add --chrome-arg=--enable-unsafe-webgpu (and on Linux --chrome-arg=--enable-features=Vulkan); on the phone check chrome://gpu for a blocklisted driver. Measuring the WebGL arms alone (--mechanism particles-webgl,shaders-webgl) still produces a valid table; this arm cannot.",
    );
  }
  // `info` is a live accessor on modern Chrome; the optional chain is for a build where it is not.
  const adapterFallback = Boolean(adapter.info?.isFallbackAdapter);
  const device = await withDeadline(
    adapter.requestDevice(),
    "requestDevice() did not resolve",
  );
  const counters: GpuCounters = { gpuErrors: 0, deviceLosses: 0 };
  // A lost device does not throw anywhere — it just stops working. Counting it is the only way the
  // report can say "this arm's frames stopped being real" instead of quietly reading a frozen page.
  void device.lost.then(() => {
    counters.deviceLosses += 1;
  });
  device.addEventListener("uncapturederror", () => {
    counters.gpuErrors += 1;
  });
  return {
    device,
    format: gpu.getPreferredCanvasFormat(),
    adapterFallback,
    counters,
    destroy: () => device.destroy(),
  };
}

async function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `effects-webgpu: give up on this arm and measure the WebGL ones (--mechanism particles-webgl,shaders-webgl) — WebGPU ${what} within ${ACQUIRE_TIMEOUT_MS} ms. A hung adapter request is a driver/flag problem on the host, not something the scenario can wait out.`,
        ),
      );
    }, ACQUIRE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Compile a WGSL module and FAIL LOUDLY on a shader error.
 *
 * WebGPU's default behaviour for a bad shader is to produce a module that fails at pipeline
 * creation with a message the console eats — the page then renders nothing at a wonderful frame
 * rate, which is the exact failure S6's `mount()` note exists to prevent on the GL side. So the
 * compilation info is read back and any `error` message is put at the FRONT of a thrown error,
 * where a truncated `Runtime.evaluate threw:` can still show it.
 */
async function compileModule(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `effects-webgpu: fix the ${label} WGSL — ${first.message} (line ${first.lineNum}, col ${first.linePos}). ${errors.length} error(s) total. The source lives in packages/perf-harness/src/scenarios/webgpu/wgsl.ts; nothing in packages/html compiles it.`,
    );
  }
  return module;
}

/**
 * Create a render pipeline inside a validation error scope, so a layout/blend mismatch is reported
 * as a message rather than as an arm that draws nothing.
 */
async function createPipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  label: string,
): Promise<GPURenderPipeline> {
  device.pushErrorScope("validation");
  const pipeline = device.createRenderPipeline(descriptor);
  const error = await device.popErrorScope();
  if (error) {
    throw new Error(
      `effects-webgpu: the ${label} pipeline failed WebGPU validation — ${error.message}. This is a descriptor bug in webgpu/renderer.ts (vertex layout, bind-group layout or blend state), not a device problem.`,
    );
  }
  return pipeline;
}

/** The per-cell uniform ring both renderers bind through, at the device's own alignment. */
interface UniformRing {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  /** Slot pitch in bytes: `UNIFORM_SLOT_BYTES` rounded UP to the device's dynamic-offset alignment. */
  pitch: number;
  staging: Float32Array;
}

function createUniformRing(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  cells: number,
  label: string,
): UniformRing {
  // The device's alignment is the FLOOR of what a dynamic offset may be; 256 already satisfies every
  // conformant implementation, but read it back rather than assume, and round up if a future device
  // ever reports more.
  const alignment = Math.max(
    UNIFORM_SLOT_BYTES,
    device.limits.minUniformBufferOffsetAlignment || UNIFORM_SLOT_BYTES,
  );
  const pitch = Math.ceil(alignment / UNIFORM_SLOT_BYTES) * UNIFORM_SLOT_BYTES;
  const buffer = device.createBuffer({
    label,
    size: pitch * Math.max(1, cells),
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    label,
    layout,
    // `size` is the SLOT, not the buffer: a dynamic offset addresses one slot, and binding the whole
    // buffer would make every cell read cell 0.
    entries: [{ binding: 0, resource: { buffer, offset: 0, size: 16 } }],
  });
  return {
    buffer,
    bindGroup,
    pitch,
    staging: new Float32Array((pitch / 4) * Math.max(1, cells)),
  };
}

function uniformBindGroupLayout(
  device: GPUDevice,
  label: string,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: [
      {
        binding: 0,
        visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
      },
    ],
  });
}

/**
 * How a frame reaches the screen. `direct` needs one `GPUCanvasContext` per cell; `blit` needs the
 * single shared one, and the scenario does the `drawImage` half itself (so it can time it).
 */
export type PresentMode = "direct" | "blit";

export interface EffectRenderer {
  /** Encode + submit ONE frame for every cell. `counts[i]` is cell i's instance count (particles). */
  encodeFrame(counts: number[], timeSeconds: number): FrameCounts;
  /** Upload one cell's packed instances (particles only; a no-op on the shader renderer). */
  writeInstances(cell: number, buffer: InstanceBuffer, count: number): void;
  /** The shared canvas the blit arm reads its sub-rects out of, or null in `direct` mode. */
  sharedCanvas: HTMLCanvasElement | null;
  destroy(): void;
}

interface RendererDeps {
  device: GPUDevice;
  format: GPUTextureFormat;
  cells: CellTarget[];
  mode: PresentMode;
  /** The per-cell canvas contexts (`direct`), or a one-element array holding the shared one. */
  contexts: GPUCanvasContext[];
  sharedCanvas: HTMLCanvasElement | null;
}

/**
 * The pass loop both renderers share, so "one submit per frame" is stated ONCE and cannot drift
 * between the particle and shader arms.
 *
 * DIRECT: one pass per canvas, each with its own `loadOp: "clear"` — a cell with nothing to draw is
 * still CLEARED, mirroring the GL path's clear-only branch (`drawBinding` returns after
 * `clearRect` when the instance count is 0), so a dead cell costs a pass in both worlds.
 * BLIT: one pass over the shared canvas, N `setViewport` sub-rects inside it. WebGPU framebuffer
 * coordinates are Y-DOWN, exactly like `drawImage`'s source rect, so a viewport at (x, y) is read
 * back at (x, y) with no flip arithmetic anywhere.
 */
function encodePasses(
  deps: RendererDeps,
  drawCell: (pass: GPURenderPassEncoder, cell: number) => boolean,
): FrameCounts {
  const { device, cells, mode, contexts } = deps;
  const encoder = device.createCommandEncoder();
  let passes = 0;
  let draws = 0;
  if (mode === "direct") {
    for (let index = 0; index < cells.length; index++) {
      const view = contexts[index].getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      passes += 1;
      if (drawCell(pass, index)) draws += 1;
      pass.end();
    }
  } else {
    const view = contexts[0].getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    passes += 1;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      pass.setViewport(cell.x, cell.y, cell.w, cell.h, 0, 1);
      pass.setScissorRect(cell.x, cell.y, cell.w, cell.h);
      if (drawCell(pass, index)) draws += 1;
    }
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  return { passes, submits: 1, draws };
}

/**
 * The instanced-particle renderer: the WGSL port of the shipped GL draw, fed the shipped packed
 * bytes.
 *
 * One `GPUBuffer` per cell, sized once from the declared particle count and grown only if the count
 * ever exceeds it — the same "allocate nothing in the hot path" policy `InstanceBuffer` has on the
 * CPU side, and the reason `submitMs` is a measurement of submitting rather than of allocating.
 */
export async function createParticleRenderer(
  deps: RendererDeps,
  maxInstancesPerCell: number,
): Promise<EffectRenderer> {
  const { device, format, cells } = deps;
  const module = await compileModule(device, PARTICLE_WGSL, "particle");
  const bindGroupLayout = uniformBindGroupLayout(device, "particle-viewport");
  const pipeline = await createPipeline(
    device,
    {
      label: "particle",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: PARTICLE_VS_ENTRY,
        buffers: PARTICLE_VERTEX_BUFFERS,
      },
      fragment: {
        module,
        entryPoint: PARTICLE_FS_ENTRY,
        targets: [{ format, blend: PREMULTIPLIED_BLEND }],
      },
      primitive: { topology: "triangle-strip" },
    },
    "particle",
  );

  // The static unit quad, [-0.5, 0.5] as a TRIANGLE_STRIP — `render-webgl.ts`'s `cornerBuffer`.
  const corners = device.createBuffer({
    label: "particle-corners",
    size: 32,
    usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
  });
  device.queue.writeBuffer(
    corners,
    0,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
  );

  const ring = createUniformRing(
    device,
    bindGroupLayout,
    cells.length,
    "particle-viewport",
  );
  // Viewport dims are written ONCE: a cell's box is fixed for the life of the run (the scenario
  // sizes every canvas in `mount()` and never resizes one), so re-uploading them each frame would
  // put a per-frame cost into `submitMs` that the shipped path does not have either.
  for (let index = 0; index < cells.length; index++) {
    const base = index * (ring.pitch / 4);
    ring.staging[base] = cells[index].w;
    ring.staging[base + 1] = cells[index].h;
  }
  device.queue.writeBuffer(ring.buffer, 0, ring.staging);

  const capacity = Math.max(1, Math.round(maxInstancesPerCell));
  const instanceBuffers = cells.map((_cell, index) =>
    device.createBuffer({
      label: `particle-instances-${index}`,
      size: Math.max(INSTANCE_STRIDE * 4, packedBytes(capacity)),
      usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
    }),
  );
  return {
    sharedCanvas: deps.sharedCanvas,
    writeInstances(cell, buffer, count) {
      if (count <= 0) return;
      const bytes = packedBytes(count);
      if (bytes > instanceBuffers[cell].size) {
        // Only reachable if a system exceeded its declared `amount`, which this scenario's specs
        // cannot do — kept so a future param change degrades into a slow frame, not a crash.
        instanceBuffers[cell].destroy();
        instanceBuffers[cell] = device.createBuffer({
          label: `particle-instances-${cell}`,
          size: bytes,
          usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
        });
      }
      device.queue.writeBuffer(
        instanceBuffers[cell],
        0,
        buffer.data.buffer,
        buffer.data.byteOffset,
        bytes,
      );
    },
    encodeFrame(counts) {
      return encodePasses(deps, (pass, index) => {
        const count = counts[index] ?? 0;
        // A cell with no live particles still got its pass and its clear above — that IS the frame
        // the GL path draws for an empty system. It just does not get a draw call.
        if (count <= 0) return false;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, ring.bindGroup, [index * ring.pitch]);
        pass.setVertexBuffer(0, corners);
        pass.setVertexBuffer(1, instanceBuffers[index]);
        pass.draw(4, count);
        return true;
      });
    },
    destroy() {
      for (const buffer of instanceBuffers) buffer.destroy();
      corners.destroy();
      ring.buffer.destroy();
    },
  };
}

/**
 * The shader renderer: S6's Godot fragment, ported to WGSL, over a full-cell strip.
 *
 * TIME-DRIVEN EVERY FRAME, for S6's reason: the shipped shader runtime only re-renders a binding
 * whose program reads `TIME`, so a static shader would render once, park, and re-measure the frozen
 * arm instead of the shader arm.
 */
export async function createShaderRenderer(
  deps: RendererDeps,
): Promise<EffectRenderer> {
  const { device, format, cells } = deps;
  const module = await compileModule(device, SHADER_WGSL, "shader");
  const bindGroupLayout = uniformBindGroupLayout(device, "shader-time");
  const pipeline = await createPipeline(
    device,
    {
      label: "shader",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: { module, entryPoint: SHADER_VS_ENTRY },
      fragment: {
        module,
        entryPoint: SHADER_FS_ENTRY,
        targets: [{ format, blend: PREMULTIPLIED_BLEND }],
      },
      primitive: { topology: "triangle-strip" },
    },
    "shader",
  );
  const ring = createUniformRing(
    device,
    bindGroupLayout,
    cells.length,
    "shader-time",
  );

  return {
    sharedCanvas: deps.sharedCanvas,
    writeInstances() {
      // The shader arm has no instances — it draws one strip per cell from `vertex_index`.
    },
    encodeFrame(_counts, timeSeconds) {
      // Every cell reads the same TIME, but the slots are written as a block in ONE `writeBuffer`
      // rather than N: the dynamic-offset layout is kept identical to the particle renderer's so
      // the two arms' `submitMs` differ by what they DRAW, not by how they bind.
      const stride = ring.pitch / 4;
      for (let index = 0; index < cells.length; index++) {
        ring.staging[index * stride] = timeSeconds;
      }
      device.queue.writeBuffer(ring.buffer, 0, ring.staging);
      return encodePasses(deps, (pass, index) => {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, ring.bindGroup, [index * ring.pitch]);
        pass.draw(4, 1);
        return true;
      });
    },
    destroy() {
      ring.buffer.destroy();
    },
  };
}

/**
 * `canvas.getContext("webgpu")` — THE ONE CAST IN THIS SCENARIO.
 *
 * `lib.dom.d.ts` ships every WebGPU interface but gives `getContext` no `"webgpu"` overload, so the
 * call lands on the `(contextId: string) => RenderingContext | null` signature. Narrowing it here,
 * once, with the reason attached, is preferable to sprinkling casts at three call sites or adding a
 * `@webgpu/types` dependency the type system does not actually need.
 */
export function webgpuContext(canvas: HTMLCanvasElement): GPUCanvasContext {
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) {
    throw new Error(
      "effects-webgpu: use the WebGL arms here (--mechanism particles-webgl,shaders-webgl) — canvas.getContext('webgpu') returned null even though navigator.gpu exists. That combination means the canvas already has a context of another type, or this build refuses webgpu contexts; either way no pixels can be produced.",
    );
  }
  return context;
}

/** Configure one canvas to present premultiplied frames from `device`. See `wgsl.ts`'s note. */
export function configureCanvas(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  format: GPUTextureFormat,
): GPUCanvasContext {
  const context = webgpuContext(canvas);
  context.configure({
    device,
    format,
    // "opaque" would flatten the effect onto black and stop it compositing over the page at all;
    // "premultiplied" is the only alpha mode a WebGPU canvas offers that composites, and it is what
    // both fragments are written to return.
    alphaMode: "premultiplied",
  });
  return context;
}

export type { RendererDeps };
export { UNIFORM_SLOT_BYTES };
