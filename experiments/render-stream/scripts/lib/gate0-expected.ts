// Pure synthesis of the gate 0 fixture's expected per-step frame, straight from
// fixtures/gate0/expected.json -- no file or network I/O, no Godot, no capture evidence. See
// ../../protocol/gate0-design.md "Q2. Fixture" for the schema this reads and the checks
// (`expected-image-reference`, `expected-image-receiver`) that compare a real screenshot against
// this synthesized image.

export interface GateZeroExpectedRegion {
  /** [x, y, w, h] in viewport pixels: the node's position plus its local draw rect. */
  rect_px: [number, number, number, number];
  /** Godot float color, each component in {0, .2, .4, .6, .8, 1}. */
  color: [number, number, number, number];
  /** The exact byte form of `color` (0, 51, 102, 153, 204, 255). */
  rgba8: [number, number, number, number];
}

export interface GateZeroExpectedStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  subject: GateZeroExpectedRegion;
  marker: GateZeroExpectedRegion;
}

export interface GateZeroExpected {
  schema: "render-stream-gate0-expected/1";
  viewport: [number, number];
  clear_rgba8: [number, number, number, number];
  quit_frame_default: number;
  steps: GateZeroExpectedStep[];
  unsupported_variant: { from_step: number; op: string };
}

export interface SynthesizedFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * The expected 640x360 RGBA frame for one step: the clear colour, then the Subject rect, then
 * the Marker rect, each painted opaque (alpha 255) over the whole buffer -- same paint order the
 * fixture draws in (gate0.gd: Subject added before Marker).
 */
export function synthesizeExpected(
  expected: GateZeroExpected,
  step: number,
): SynthesizedFrame {
  const [width, height] = expected.viewport;
  const found = expected.steps.find((entry) => entry.step === step);
  if (!found) {
    throw new Error(`gate0-expected: no step ${step} in expected.json`);
  }

  const rgba = new Uint8Array(width * height * 4);
  paintRect(rgba, width, height, [0, 0, width, height], expected.clear_rgba8);
  paintRect(rgba, width, height, found.subject.rect_px, found.subject.rgba8);
  paintRect(rgba, width, height, found.marker.rect_px, found.marker.rgba8);
  return { width, height, rgba };
}

function paintRect(
  rgba: Uint8Array,
  width: number,
  height: number,
  rect: [number, number, number, number],
  color: [number, number, number, number],
): void {
  const [x, y, w, h] = rect;
  const [r, g, b, a] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const index = (py * width + px) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = a;
    }
  }
}
