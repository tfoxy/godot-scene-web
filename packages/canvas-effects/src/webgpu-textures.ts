/** Device-scoped texture allocation and upload primitives. Hosts own decoding and cache keys. */
export const WEBGPU_UPLOAD_TEXTURE_USAGE = 0x01 | 0x02 | 0x04 | 0x10;

export interface WebgpuTextureUpload {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
}

export function createWebgpuRgbaTexture(
  device: GPUDevice,
  width: number,
  height: number,
  label?: string,
): WebgpuTextureUpload {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return {
    texture: device.createTexture({
      label,
      size: [w, h, 1],
      format: "rgba8unorm",
      usage: WEBGPU_UPLOAD_TEXTURE_USAGE,
    }),
    width: w,
    height: h,
  };
}

export function uploadWebgpuRgba(
  device: GPUDevice,
  target: WebgpuTextureUpload,
  pixels: Uint8Array | Uint8ClampedArray,
): void {
  device.queue.writeTexture(
    { texture: target.texture },
    pixels,
    { bytesPerRow: target.width * 4, rowsPerImage: target.height },
    [target.width, target.height],
  );
}

/** Upload a host-decoded external image. The host decides its source and crop. */
export function uploadWebgpuExternalImage(
  device: GPUDevice,
  target: WebgpuTextureUpload,
  source: GPUCopyExternalImageSourceInfo,
): void {
  device.queue.copyExternalImageToTexture(
    source,
    { texture: target.texture, premultipliedAlpha: false },
    [target.width, target.height],
  );
}

export function createWebgpuSampler(
  device: GPUDevice,
  opts: { readonly nearest: boolean; readonly repeat: boolean },
): GPUSampler {
  const filter: GPUFilterMode = opts.nearest ? "nearest" : "linear";
  const address: GPUAddressMode = opts.repeat ? "repeat" : "clamp-to-edge";
  return device.createSampler({
    magFilter: filter,
    minFilter: filter,
    addressModeU: address,
    addressModeV: address,
  });
}

export function destroyWebgpuTexture(texture: GPUTexture): void {
  try {
    texture.destroy();
  } catch {
    // A lost device may reject destruction; its resources are already dead.
  }
}
