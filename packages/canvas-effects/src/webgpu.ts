/**
 * Explicit WebGPU execution entry point.
 *
 * Callers supply their device and presentation surface; this
 * package never creates a canvas, queries the DOM, fetches images, or schedules
 * animation frames.
 */
/** Configure a caller-supplied WebGPU presentation context for premultiplied output. */
export function configureWebgpuSurface(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
): void {
  context.configure({ device, format, alphaMode: "premultiplied" });
}

export * from "./particles-webgpu";
export * from "./shader-webgpu";
export * from "./webgpu-pack-uniforms";
export * from "./webgpu-pipeline";
export * from "./webgpu-readback";
export * from "./webgpu-textures";
