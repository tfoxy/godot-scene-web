/** Adapter-neutral WebGPU command executor for canvas shaders. Hosts own DOM, texture resolution and bind groups. */
const TEXTURE_USAGE = { COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x10 } as const;
const TRANSPARENT: GPUColor = { r: 0, g: 0, b: 0, a: 0 };

export function createWebgpuShaderBindGroupLayout(
  device: GPUDevice,
  label: string,
  entries: Iterable<GPUBindGroupLayoutEntry>,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({ label, entries: Array.from(entries) });
}

export function createWebgpuShaderUniformBuffer(
  device: GPUDevice,
  label: string,
  size: number,
): GPUBuffer {
  return device.createBuffer({ label, size, usage: 0x0040 | 0x0008 });
}

export function createWebgpuShaderBindGroup(
  device: GPUDevice,
  label: string,
  layout: GPUBindGroupLayout,
  entries: Iterable<GPUBindGroupEntry>,
): GPUBindGroup {
  return device.createBindGroup({
    label,
    layout,
    entries: Array.from(entries),
  });
}

export interface WebgpuShaderDraw {
  context?: GPUCanvasContext;
  target?: GPUTextureView;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  uniformBytes: ArrayBuffer | ArrayBufferView;
  width: number;
  height: number;
}

/** Owns one command encoder per host frame. It never creates contexts or texture handles. */
export class WebgpuShaderExecutor {
  private encoder: GPUCommandEncoder | null = null;
  private recorded = false;
  private implicit = false;
  private submitCount = 0;
  constructor(private readonly device: GPUDevice) {}
  beginFrame(): void {
    if (this.encoder) return;
    this.encoder = this.device.createCommandEncoder({ label: "gsw-shaders" });
    this.recorded = false;
    this.implicit = false;
  }
  endFrame(): void {
    this.flush();
  }
  submits(): number {
    return this.submitCount;
  }
  draw(draw: WebgpuShaderDraw): boolean {
    const target = draw.target ?? this.currentView(draw.context);
    if (!target) return false;
    const encoder = this.ensureEncoder();
    this.device.queue.writeBuffer(
      draw.uniformBuffer,
      0,
      draw.uniformBytes,
      0,
      draw.uniformBytes.byteLength,
    );
    const pass = encoder.beginRenderPass({
      label: "gsw-shader-draw",
      colorAttachments: [
        {
          view: target,
          clearValue: TRANSPARENT,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setViewport(0, 0, draw.width, draw.height, 0, 1);
    pass.setPipeline(draw.pipeline);
    pass.setBindGroup(0, draw.bindGroup);
    pass.draw(4, 1);
    pass.end();
    this.recorded = true;
    if (this.implicit) this.flush();
    return true;
  }
  async capture(
    draw: Omit<WebgpuShaderDraw, "context" | "target" | "width" | "height"> & {
      width: number;
      height: number;
      read: (
        texture: GPUTexture,
        width: number,
        height: number,
      ) => Promise<Uint8Array>;
    },
  ): Promise<Uint8Array | null> {
    const target = this.device.createTexture({
      label: "gsw-shader-capture",
      size: [draw.width, draw.height, 1],
      format: "rgba8unorm",
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
    });
    try {
      const encoder = this.device.createCommandEncoder({
        label: "gsw-shader-capture",
      });
      this.device.queue.writeBuffer(
        draw.uniformBuffer,
        0,
        draw.uniformBytes,
        0,
        draw.uniformBytes.byteLength,
      );
      const pass = encoder.beginRenderPass({
        label: "gsw-shader-draw",
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: TRANSPARENT,
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setViewport(0, 0, draw.width, draw.height, 0, 1);
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(0, draw.bindGroup);
      pass.draw(4, 1);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      return await draw.read(target, draw.width, draw.height);
    } catch {
      return null;
    } finally {
      target.destroy();
    }
  }
  private ensureEncoder(): GPUCommandEncoder {
    if (!this.encoder) {
      this.encoder = this.device.createCommandEncoder({ label: "gsw-shaders" });
      this.implicit = true;
    }
    return this.encoder;
  }
  private currentView(
    context: GPUCanvasContext | undefined,
  ): GPUTextureView | null {
    try {
      return context?.getCurrentTexture().createView() ?? null;
    } catch {
      return null;
    }
  }
  private flush(): void {
    if (this.encoder && this.recorded) {
      this.device.queue.submit([this.encoder.finish()]);
      this.submitCount++;
    }
    this.encoder = null;
    this.recorded = false;
    this.implicit = false;
  }
}
