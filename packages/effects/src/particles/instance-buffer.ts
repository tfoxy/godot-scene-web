/** Floats per particle render instance: center.xy, scale.xy, rotation, color.rgba, frame. */
export const INSTANCE_STRIDE = 10;

/**
 * CPU-owned packed particle instances. This class deliberately knows nothing about
 * WebGL, WebGPU, a canvas, or a device lifecycle; render adapters own residency.
 */
export class InstanceBuffer {
  data: Float32Array;
  /** Number of instances written since the last reset. */
  count = 0;
  private capacity: number;

  constructor(initialCapacity = 256) {
    this.capacity = Math.max(1, initialCapacity);
    this.data = new Float32Array(this.capacity * INSTANCE_STRIDE);
  }

  reset(): void {
    this.count = 0;
  }

  push(
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    rotation: number,
    r: number,
    g: number,
    b: number,
    a: number,
    frame: number,
  ): void {
    this.ensureCapacity(this.count + 1);
    const offset = this.count * INSTANCE_STRIDE;
    const data = this.data;
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = scaleX;
    data[offset + 3] = scaleY;
    data[offset + 4] = rotation;
    data[offset + 5] = r;
    data[offset + 6] = g;
    data[offset + 7] = b;
    data[offset + 8] = a;
    data[offset + 9] = frame;
    this.count += 1;
  }

  ensureCapacity(instances: number): void {
    if (instances <= this.capacity) return;
    let next = this.capacity;
    while (next < instances) next *= 2;
    const grown = new Float32Array(next * INSTANCE_STRIDE);
    grown.set(this.data);
    this.data = grown;
    this.capacity = next;
  }
}
