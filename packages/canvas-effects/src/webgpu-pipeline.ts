// Shader-module compilation, pipeline creation and the per-cell uniform ring, ported from the S7
// probe (`packages/perf-harness/src/scenarios/webgpu/renderer.ts`). The probe THREW on a bad
// shader or a failed validation because an arm that renders nothing at a wonderful frame rate is a
// lie in a perf table; the product instead returns `null`, latches `pipeline-error` and lets the
// caller fall back to WebGL — but it keeps the probe's diagnostics, because WebGPU's own default
// for a bad shader is a module that fails later with a message the console eats.

/** Normative WebGPU flags, stated locally so this module needs no browser host. */
export const BUFFER_USAGE = { COPY_DST: 0x0008, UNIFORM: 0x0040 } as const;
export const SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;

/**
 * Bytes per per-cell uniform slot. 256 is the maximum `minUniformBufferOffsetAlignment` any WebGPU
 * implementation may report, so a buffer laid out at this pitch is bindable with a dynamic offset
 * everywhere; the real limit is read off the device and only ever rounds DOWN from here.
 */
export const UNIFORM_SLOT_BYTES = 256;

let lastError: string | null = null;

/** The first error message from the most recent failed compile/validation (with WGSL line/col when
 *  the failure was a shader), for diagnostics. Null until something fails. */
export function lastPipelineError(): string | null {
  return lastError;
}

function fail(message: string, onError?: () => void): null {
  onError?.();
  lastError = message;
  // Surfaced once, like `compileProgram`'s link/compile warnings: the node then renders on WebGL,
  // and without this the only symptom is a binding that quietly took the fallback.
  console.warn("[gsw webgpu]", message);
  return null;
}

/**
 * Compile a WGSL module, returning null when the source has an error-severity message.
 *
 * Reading `getCompilationInfo()` rather than waiting for pipeline creation is what makes the
 * message available at all: a module built from bad WGSL is a valid object that only fails later,
 * inside `createRenderPipeline`, with a generic validation error.
 */
export async function compileModule(
  device: GPUDevice,
  code: string,
  label: string,
  onError?: () => void,
): Promise<GPUShaderModule | null> {
  let module: GPUShaderModule;
  try {
    module = device.createShaderModule({ code, label });
  } catch (error) {
    return fail(
      `${label} WGSL module creation failed — ${describe(error)}`,
      onError,
    );
  }
  try {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      const first = errors[0];
      return fail(
        `${label} WGSL failed to compile — ${first.message} (line ${first.lineNum}, col ${first.linePos}); ${errors.length} error(s) total`,
        onError,
      );
    }
  } catch (error) {
    return fail(
      `${label} WGSL compilation info failed — ${describe(error)}`,
      onError,
    );
  }
  return module;
}

/**
 * Create a render pipeline inside a validation error scope, so a layout/blend/vertex-buffer
 * mismatch comes back as a message and a null instead of as a surface that draws nothing.
 */
export async function createPipeline(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  label: string,
  onError?: () => void,
): Promise<GPURenderPipeline | null> {
  try {
    device.pushErrorScope("validation");
    const pipeline = device.createRenderPipeline(descriptor);
    const error = await device.popErrorScope();
    if (error) {
      return fail(
        `${label} pipeline failed WebGPU validation — ${error.message}`,
        onError,
      );
    }
    return pipeline;
  } catch (error) {
    return fail(
      `${label} pipeline creation threw — ${describe(error)}`,
      onError,
    );
  }
}

/** A uniform bind-group layout with binding 0 as a DYNAMIC-offset uniform buffer — the shape every
 *  ring in this package binds through. `minBindingSize` must not exceed the size the bind group
 *  actually binds (the slot, not the buffer), so callers that build their own bind group pass the
 *  same number to both. */
export function uniformBindGroupLayout(
  device: GPUDevice,
  visibility: number = SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
  minBindingSize?: number,
  label = "gsw-uniform",
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: [
      {
        binding: 0,
        visibility,
        buffer:
          minBindingSize === undefined
            ? { type: "uniform", hasDynamicOffset: true }
            : { type: "uniform", hasDynamicOffset: true, minBindingSize },
      },
    ],
  });
}

/** The per-cell uniform ring: one buffer holding N slots addressed by dynamic offset, so N cells
 *  cost ONE buffer and one `writeBuffer` per frame instead of N of each. */
export interface UniformRing {
  buffer: GPUBuffer;
  layout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  /** Slot pitch in BYTES: the dynamic offset for cell i is `i * pitch`. */
  pitch: number;
  /** Slot size in BYTES — what the bind group binds, always ≤ `pitch`. */
  slotBytes: number;
  /** Slot pitch in FLOATS (`pitch / 4`): cell i's staging window starts at `i * stride`. */
  stride: number;
  /** CPU-side mirror of the whole ring, uploaded in one `writeBuffer`. */
  staging: Float32Array;
  destroy(): void;
}

export interface UniformRingOptions {
  label?: string;
  /** Reuse a caller-owned layout (e.g. one shared with a pipeline layout) instead of making one. */
  layout?: GPUBindGroupLayout;
  visibility?: number;
}

export function createUniformRing(
  device: GPUDevice,
  cells: number,
  slotFloats: number = UNIFORM_SLOT_BYTES / 4,
  options: UniformRingOptions = {},
): UniformRing {
  const label = options.label ?? "gsw-uniform-ring";
  const count = Math.max(1, Math.floor(cells) || 0);
  const slotBytes = Math.max(4, Math.ceil(slotFloats) * 4);
  // The device's alignment is the FLOOR of what a dynamic offset may be; 256 already satisfies
  // every conformant implementation, but read it back rather than assume, and round up if a future
  // device ever reports more. A slot larger than the alignment widens the pitch too — the offset
  // must be aligned AND the slot must fit inside its own cell.
  const alignment = Math.max(
    UNIFORM_SLOT_BYTES,
    device.limits.minUniformBufferOffsetAlignment || UNIFORM_SLOT_BYTES,
    slotBytes,
  );
  const pitch = Math.ceil(alignment / UNIFORM_SLOT_BYTES) * UNIFORM_SLOT_BYTES;
  const buffer = device.createBuffer({
    label,
    size: pitch * count,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  });
  const layout =
    options.layout ??
    uniformBindGroupLayout(device, options.visibility, slotBytes, label);
  const bindGroup = device.createBindGroup({
    label,
    layout,
    // `size` is the SLOT, not the buffer: a dynamic offset addresses one slot, and binding the
    // whole buffer would make every cell read cell 0.
    entries: [{ binding: 0, resource: { buffer, offset: 0, size: slotBytes } }],
  });
  return {
    buffer,
    layout,
    bindGroup,
    pitch,
    slotBytes,
    stride: pitch / 4,
    staging: new Float32Array((pitch / 4) * count),
    destroy() {
      buffer.destroy();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** TEST-ONLY: clear the last recorded pipeline/shader error. */
export function __resetPipelineErrorForTest(): void {
  lastError = null;
}
