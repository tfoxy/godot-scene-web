// Reading WebGPU pixels back to the CPU.
//
// THE ONLY SANCTIONED WAY. The obvious alternatives do not work: `ctx2d.drawImage(webgpuCanvas)`
// is blank under SwiftShader and pathologically slow on Android Chrome (S7 measured the blit-shaped
// WebGPU arm at 23 Hz against 87 for direct presentation), and `toDataURL`/`toBlob` on a WebGPU
// canvas reads the same presentation path. Headless Chrome never composites a WebGPU canvas at all,
// so a canvas-sourced read there returns nothing regardless of the API used. Copying the TEXTURE —
// `copyTextureToBuffer` + `mapAsync` — is the one path verified to work fully headless, and it is
// what the WebGL↔WebGPU image-parity harness and any future surface-image-swap must use.

const BUFFER_USAGE = { MAP_READ: 0x0001, COPY_DST: 0x0008 } as const;
const MAP_MODE = { READ: 0x1 } as const;

export interface WebgpuReadbackDevice {
  readonly device: GPUDevice;
}

/** `copyTextureToBuffer` requires every row to start on a 256-byte boundary, which is why the read
 *  is padded and then re-packed rather than mapped straight into the caller's hands. */
const BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * Read `width`×`height` RGBA bytes out of `texture`, tightly packed (`width * 4` bytes per row,
 * top-down, PREMULTIPLIED alpha as stored — every fragment on this backend emits `vec4f(rgb*a, a)`
 * under `PREMULTIPLIED_BLEND`, so the bytes in the texture are already multiplied through. A
 * consumer that needs straight alpha (an encode into a 2D canvas) converts: see
 * `./still-capture`).
 *
 * `texture` must have been created with COPY_SRC usage — a texture that will be read back has to
 * declare it at creation, and there is no way to add it afterwards.
 */
export async function readTexturePixels(
  shared: WebgpuReadbackDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const { device } = shared;
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const bytesPerRow =
    Math.ceil((w * 4) / BYTES_PER_ROW_ALIGNMENT) * BYTES_PER_ROW_ALIGNMENT;
  const buffer = device.createBuffer({
    label: "gsw-readback",
    size: bytesPerRow * h,
    usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: "gsw-readback" });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow, rowsPerImage: h },
      [w, h, 1],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_MODE.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const packed = new Uint8Array(w * h * 4);
    // Strip the row padding. The copy is per-row because only the first `w * 4` bytes of each
    // `bytesPerRow` stride hold pixels; the rest is whatever the alignment left behind.
    for (let row = 0; row < h; row++) {
      packed.set(
        padded.subarray(row * bytesPerRow, row * bytesPerRow + w * 4),
        row * w * 4,
      );
    }
    buffer.unmap();
    return packed;
  } finally {
    // The mapped range is invalidated by `destroy()`, so this runs only after `packed` is copied.
    buffer.destroy();
  }
}
