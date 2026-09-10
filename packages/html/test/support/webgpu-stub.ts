// A recording `navigator.gpu` for the jsdom suites (jsdom ships no WebGPU at all), in the style of
// `particles-coverage.test.ts`'s `recordingGl`: every call the module under test makes is pushed to
// one ordered `calls` array, and the few objects that must answer with something real (compilation
// info, error scopes, mapped buffers) are configurable per test.
//
// The load-bearing parts are the FAILURE shapes. `acquireWebgpuDevice`'s whole job is to classify
// why WebGPU is unavailable, and each classification has a distinct cause a stub must be able to
// produce on demand: no adapter (`adapter: "null"`), a software adapter (`"fallback"`), a request
// that never settles (`"hang"` — drive it with fake timers), and a device that dies after a
// successful acquire (`handle.loseDevice()`).
//
// ONE deliberate infidelity: `queue.submit` executes the recorded `copyTextureToBuffer` operations
// SYNCHRONOUSLY, filling the destination buffer from the source texture's `pixels`. A real
// implementation does that on the GPU timeline, observable only after `mapAsync`. Modelling it as
// immediate keeps the readback padding math testable without a browser, which is the only reason a
// stub exists here at all.

export interface StubCall {
  name: string;
  args: unknown[];
}

export interface StubCompilationMessage {
  type: "error" | "warning" | "info";
  message: string;
  lineNum: number;
  linePos: number;
}

export interface StubTexture {
  label: string | undefined;
  size: [number, number, number];
  format: string | undefined;
  usage: number | undefined;
  /** Tightly packed RGBA source bytes for `copyTextureToBuffer`; tests set this. */
  pixels: Uint8Array | null;
  destroyed: boolean;
  createView(): unknown;
  destroy(): void;
}

export interface StubBuffer {
  label: string | undefined;
  size: number;
  usage: number;
  /** The buffer's bytes; also what `getMappedRange()` exposes. */
  contents: Uint8Array;
  destroyed: boolean;
}

export interface StubCanvasContext {
  canvas: HTMLCanvasElement;
  configured: GPUCanvasConfiguration | null;
  calls: StubCall[];
}

export type AdapterMode = "ok" | "null" | "fallback" | "hang" | "throw";
export type DeviceMode = "ok" | "hang" | "throw";

export interface WebgpuStubOptions {
  /** How `requestAdapter()` behaves. Default "ok". */
  adapter?: AdapterMode;
  /** How `requestDevice()` behaves. Default "ok". */
  device?: DeviceMode;
  /** What `getPreferredCanvasFormat()` returns. Default "bgra8unorm". */
  format?: GPUTextureFormat;
  /** Merged over the default device limits. */
  limits?: Record<string, number>;
  /** `canvas.getContext("webgpu")` returns null — a canvas that already holds another context type. */
  contextRefused?: boolean;
  /** Patch `HTMLCanvasElement.prototype.getContext` for "webgpu". Default true. */
  canvasContext?: boolean;
  /** WHAT A RENDER PASS LEAVES IN ITS COLOUR ATTACHMENT — one repeated PREMULTIPLIED RGBA pixel,
   *  written when the pass BEGINS into any attachment texture a test has not pre-filled itself
   *  (`StubTexture.pixels`). Default `DEFAULT_RENDERED_PIXEL`: a device whose draws actually land,
   *  which is what the readback-driven surface image swap needs in order to encode anything at all.
   *
   *  `null` models the OTHER device this project has measured (docs/perf-harness.md, S8): one whose
   *  readback completes, reports nothing wrong, and hands back an ENTIRELY TRANSPARENT frame. That
   *  is the case `../../src/webgpu/still-capture`'s blank guard exists for, and this is how a jsdom
   *  suite stands it up. */
  renderedPixel?: [number, number, number, number] | null;
}

export interface WebgpuStubHandle {
  /** Every recorded call, in order, across adapter + device + queue + encoders. */
  calls: StubCall[];
  requestAdapterCalls: number;
  requestDeviceCalls: number;
  /** The device handed to `requestDevice`'s caller, or null until one is requested. */
  device: GPUDevice | null;
  textures: StubTexture[];
  buffers: StubBuffer[];
  contexts: StubCanvasContext[];
  /** Resolve `device.lost`, exactly as a driver reset does. */
  loseDevice(reason?: string): void;
  /** Dispatch an `uncapturederror` event at the device. */
  emitUncapturedError(): void;
  /** What the next `getCompilationInfo()` reports. */
  setCompilationMessages(messages: StubCompilationMessage[]): void;
  /** What the next `popErrorScope()` reports (null = no error). */
  setPipelineError(message: string | null): void;
  uninstall(): void;
}

interface PendingCopy {
  texture: StubTexture;
  buffer: StubBuffer;
  bytesPerRow: number;
  width: number;
  height: number;
}

/** The premultiplied pixel a stub render pass paints its attachment with (see
 *  `WebgpuStubOptions.renderedPixel`). Valid premultiplied bytes — every channel at or under its own
 *  alpha — so unpremultiplying it needs no clamp. */
export const DEFAULT_RENDERED_PIXEL: [number, number, number, number] = [
  64, 32, 16, 128,
];

const DEFAULT_LIMITS: Record<string, number> = {
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxTextureDimension2D: 8192,
  maxUniformBufferBindingSize: 65536,
};

export function installWebgpuStub(
  options: WebgpuStubOptions = {},
): WebgpuStubHandle {
  const calls: StubCall[] = [];
  const textures: StubTexture[] = [];
  const buffers: StubBuffer[] = [];
  const contexts: StubCanvasContext[] = [];
  const errorListeners = new Set<(event: unknown) => void>();
  let compilationMessages: StubCompilationMessage[] = [];
  let pipelineError: string | null = null;
  let deviceHandle: GPUDevice | null = null;
  let loseDeviceNow: (reason: string) => void = () => {};

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };

  const makeTexture = (descriptor: GPUTextureDescriptor): StubTexture => {
    const size = normalizeSize(descriptor.size);
    const texture: StubTexture = {
      label: descriptor.label,
      size,
      format: descriptor.format,
      usage: descriptor.usage,
      pixels: null,
      destroyed: false,
      createView() {
        record("texture.createView", texture.label);
        return { __view: texture };
      },
      destroy() {
        texture.destroyed = true;
        record("texture.destroy", texture.label);
      },
    };
    textures.push(texture);
    return texture;
  };

  const makeBuffer = (descriptor: GPUBufferDescriptor): StubBuffer => {
    const buffer: StubBuffer = {
      label: descriptor.label,
      size: descriptor.size,
      usage: descriptor.usage,
      contents: new Uint8Array(descriptor.size),
      destroyed: false,
    };
    buffers.push(buffer);
    return buffer;
  };

  const bufferApi = (buffer: StubBuffer): unknown => ({
    label: buffer.label,
    size: buffer.size,
    usage: buffer.usage,
    mapAsync: async (mode: number) => {
      record("buffer.mapAsync", buffer.label, mode);
    },
    getMappedRange: () => {
      record("buffer.getMappedRange", buffer.label);
      return buffer.contents.buffer;
    },
    unmap: () => {
      record("buffer.unmap", buffer.label);
    },
    destroy: () => {
      buffer.destroyed = true;
      record("buffer.destroy", buffer.label);
    },
    __stub: buffer,
  });

  /** A render pass writes to its colour attachments. Modelled at BEGIN (the stub has no draw
   *  timeline) and only into a texture the test left alone, so an explicitly seeded `pixels` — what
   *  `webgpu-readback.test.ts` uses to pin the row-padding math — still wins. */
  const paintAttachments = (desc: unknown): void => {
    const fill =
      options.renderedPixel === undefined
        ? DEFAULT_RENDERED_PIXEL
        : options.renderedPixel;
    if (!fill) return;
    const attachments = (
      desc as { colorAttachments?: Array<{ view?: { __view?: StubTexture } }> }
    ).colorAttachments;
    if (!attachments) return;
    for (const attachment of attachments) {
      const texture = attachment?.view?.__view;
      if (!texture || texture.pixels) continue;
      const [w, h] = texture.size;
      const pixels = new Uint8Array(Math.max(0, w * h * 4));
      for (let index = 0; index + 3 < pixels.length; index += 4) {
        pixels[index] = fill[0];
        pixels[index + 1] = fill[1];
        pixels[index + 2] = fill[2];
        pixels[index + 3] = fill[3];
      }
      texture.pixels = pixels;
    }
  };

  const makeRenderPass = (): unknown => {
    const pass = {
      setPipeline: (...args: unknown[]) => record("pass.setPipeline", ...args),
      setBindGroup: (...args: unknown[]) =>
        record("pass.setBindGroup", ...args),
      setVertexBuffer: (...args: unknown[]) =>
        record("pass.setVertexBuffer", ...args),
      setViewport: (...args: unknown[]) => record("pass.setViewport", ...args),
      setScissorRect: (...args: unknown[]) =>
        record("pass.setScissorRect", ...args),
      draw: (...args: unknown[]) => record("pass.draw", ...args),
      end: () => record("pass.end"),
    };
    return pass;
  };

  const makeEncoder = (descriptor?: GPUCommandEncoderDescriptor): unknown => {
    const copies: PendingCopy[] = [];
    return {
      label: descriptor?.label,
      beginRenderPass: (desc: unknown) => {
        record("encoder.beginRenderPass", desc);
        paintAttachments(desc);
        return makeRenderPass();
      },
      copyTextureToBuffer: (
        source: { texture: unknown },
        destination: { buffer: unknown; bytesPerRow: number },
        size: number[],
      ) => {
        record("encoder.copyTextureToBuffer", source, destination, size);
        const texture = source.texture as StubTexture;
        const buffer = (destination.buffer as { __stub: StubBuffer }).__stub;
        copies.push({
          texture,
          buffer,
          bytesPerRow: destination.bytesPerRow,
          width: size[0] ?? texture.size[0],
          height: size[1] ?? texture.size[1],
        });
      },
      finish: () => {
        record("encoder.finish", descriptor?.label);
        return { __copies: copies };
      },
    };
  };

  const queue = {
    writeBuffer: (...args: unknown[]) => record("queue.writeBuffer", ...args),
    writeTexture: (...args: unknown[]) => record("queue.writeTexture", ...args),
    copyExternalImageToTexture: (...args: unknown[]) =>
      record("queue.copyExternalImageToTexture", ...args),
    submit: (commandBuffers: unknown[]) => {
      record("queue.submit", commandBuffers.length);
      for (const commandBuffer of commandBuffers) {
        const copies = (commandBuffer as { __copies?: PendingCopy[] }).__copies;
        if (!copies) continue;
        for (const copy of copies) executeCopy(copy);
      }
    },
  };

  const device = {
    limits: { ...DEFAULT_LIMITS, ...(options.limits ?? {}) },
    features: new Set<string>(),
    queue,
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      loseDeviceNow = (reason: string) => {
        resolve({ reason, message: reason } as unknown as GPUDeviceLostInfo);
      };
    }),
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => {
      record("createShaderModule", descriptor.label, descriptor.code);
      return {
        label: descriptor.label,
        getCompilationInfo: async () => ({ messages: compilationMessages }),
      };
    },
    createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
      record("createRenderPipeline", descriptor.label, descriptor);
      return { label: descriptor.label, __pipeline: true };
    },
    createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => {
      record("createPipelineLayout", descriptor.label);
      return { label: descriptor.label, __pipelineLayout: true };
    },
    createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => {
      record("createBindGroupLayout", descriptor.label, descriptor.entries);
      return { label: descriptor.label, __bindGroupLayout: true };
    },
    createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
      record("createBindGroup", descriptor.label, descriptor.entries);
      return { label: descriptor.label, __bindGroup: true };
    },
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      record(
        "createBuffer",
        descriptor.label,
        descriptor.size,
        descriptor.usage,
      );
      return bufferApi(makeBuffer(descriptor));
    },
    createTexture: (descriptor: GPUTextureDescriptor) => {
      record(
        "createTexture",
        descriptor.label,
        normalizeSize(descriptor.size),
        descriptor.format,
        descriptor.usage,
      );
      return makeTexture(descriptor);
    },
    createSampler: (descriptor: GPUSamplerDescriptor) => {
      record("createSampler", descriptor);
      return { label: descriptor.label, __sampler: descriptor };
    },
    createCommandEncoder: (descriptor?: GPUCommandEncoderDescriptor) => {
      record("createCommandEncoder", descriptor?.label);
      return makeEncoder(descriptor);
    },
    pushErrorScope: (filter: string) => record("pushErrorScope", filter),
    popErrorScope: async () => {
      record("popErrorScope");
      return pipelineError === null ? null : { message: pipelineError };
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      record("addEventListener", type);
      if (type === "uncapturederror") errorListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      record("removeEventListener", type);
      errorListeners.delete(listener);
    },
    destroy: () => record("device.destroy"),
  };
  deviceHandle = device as unknown as GPUDevice;

  const adapter = {
    info: { isFallbackAdapter: options.adapter === "fallback", vendor: "stub" },
    features: new Set<string>(),
    limits: device.limits,
    requestDevice: (...args: unknown[]) => {
      record("requestDevice", ...args);
      handle.requestDeviceCalls += 1;
      const mode = options.device ?? "ok";
      if (mode === "hang") return new Promise<never>(() => {});
      if (mode === "throw") {
        return Promise.reject(new Error("stub: requestDevice refused"));
      }
      return Promise.resolve(deviceHandle);
    },
  };

  const gpu = {
    requestAdapter: (...args: unknown[]) => {
      record("requestAdapter", ...args);
      handle.requestAdapterCalls += 1;
      const mode = options.adapter ?? "ok";
      if (mode === "null") return Promise.resolve(null);
      if (mode === "hang") return new Promise<never>(() => {});
      if (mode === "throw") {
        return Promise.reject(new Error("stub: requestAdapter refused"));
      }
      return Promise.resolve(adapter);
    },
    getPreferredCanvasFormat: () => {
      record("getPreferredCanvasFormat");
      return options.format ?? "bgra8unorm";
    },
  };

  const navigatorTarget = globalThis.navigator as unknown as Record<
    string,
    unknown
  >;
  const hadGpu = "gpu" in navigatorTarget;
  const priorGpu = navigatorTarget.gpu;
  Object.defineProperty(navigatorTarget, "gpu", {
    value: gpu,
    configurable: true,
    writable: true,
  });

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const patchCanvas = options.canvasContext !== false;
  if (patchCanvas) {
    const perCanvas = new WeakMap<HTMLCanvasElement, unknown>();
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind !== "webgpu") {
        return (
          originalGetContext as unknown as (
            this: HTMLCanvasElement,
            ...args: unknown[]
          ) => unknown
        ).call(this, kind, ...rest);
      }
      record("canvas.getContext", kind);
      if (options.contextRefused) return null;
      const existing = perCanvas.get(this);
      if (existing) return existing;
      const state: StubCanvasContext = {
        canvas: this,
        configured: null,
        calls: [],
      };
      contexts.push(state);
      const context = {
        canvas: this,
        configure: (configuration: GPUCanvasConfiguration) => {
          state.configured = configuration;
          state.calls.push({ name: "configure", args: [configuration] });
          record("context.configure", configuration);
        },
        unconfigure: () => {
          state.configured = null;
          state.calls.push({ name: "unconfigure", args: [] });
          record("context.unconfigure");
        },
        getCurrentTexture: () => {
          record("context.getCurrentTexture");
          return makeTexture({
            label: "canvas",
            size: [this.width || 1, this.height || 1],
            format: options.format ?? "bgra8unorm",
            usage: 0x10,
          });
        },
      };
      perCanvas.set(this, context);
      return context;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }

  const handle: WebgpuStubHandle = {
    calls,
    requestAdapterCalls: 0,
    requestDeviceCalls: 0,
    device: deviceHandle,
    textures,
    buffers,
    contexts,
    loseDevice(reason = "destroyed") {
      loseDeviceNow(reason);
    },
    emitUncapturedError() {
      for (const listener of [...errorListeners]) {
        listener({ type: "uncapturederror", error: new Error("stub error") });
      }
    },
    setCompilationMessages(messages) {
      compilationMessages = messages;
    },
    setPipelineError(message) {
      pipelineError = message;
    },
    uninstall() {
      if (hadGpu) {
        Object.defineProperty(navigatorTarget, "gpu", {
          value: priorGpu,
          configurable: true,
          writable: true,
        });
      } else {
        delete navigatorTarget.gpu;
      }
      if (patchCanvas) {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
      }
    },
  };
  return handle;
}

function executeCopy(copy: PendingCopy): void {
  const source = copy.texture.pixels;
  if (!source) return;
  const rowBytes = copy.width * 4;
  for (let row = 0; row < copy.height; row++) {
    copy.buffer.contents.set(
      source.subarray(row * rowBytes, row * rowBytes + rowBytes),
      row * copy.bytesPerRow,
    );
  }
}

function normalizeSize(size: unknown): [number, number, number] {
  if (Array.isArray(size)) {
    return [Number(size[0] ?? 1), Number(size[1] ?? 1), Number(size[2] ?? 1)];
  }
  const dict = size as {
    width?: number;
    height?: number;
    depthOrArrayLayers?: number;
  };
  return [
    Number(dict?.width ?? 1),
    Number(dict?.height ?? 1),
    Number(dict?.depthOrArrayLayers ?? 1),
  ];
}
