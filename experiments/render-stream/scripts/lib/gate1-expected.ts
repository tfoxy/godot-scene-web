// Pure synthesis of the gate 1 fixture's expected per-step frame, straight from
// fixtures/gate1/expected.json (render-stream-gate1-expected/1) -- no file or network I/O, no
// Godot, no capture evidence. See ../../protocol/gate1-design.md "Q6. Fixture (G1a)" for the
// schema and the checks (`expected-image-reference`, `expected-image-receiver`) that compare real
// screenshots with this synthesized image.

export type Rect4 = [number, number, number, number];
export type Rgba8 = [number, number, number, number];

/** One painted rect, in paint order: its final axis-aligned rect in root-canvas pixels (every
 * transform applied, step 10's canvas shift included) and its final 8-bit colour (modulate
 * applied). */
export interface Gate1Draw {
  name: string;
  rect_px: Rect4;
  rgba8: Rgba8;
}

/** A parent reference by name: the root canvas by wire id, an item by fixture name, or none. */
export type Gate1ParentRef = { canvas: number } | { item: string } | null;

/** One retained-state assertion on the step's settle transaction (gate1-design.md Q6
 * "invariants"). Item names map to wire ids through `creation_order` + `created_later`. */
export type Gate1Invariant =
  | {
      kind: "field";
      item: string;
      field:
        | "parent"
        | "children"
        | "visible"
        | "draw_index"
        | "z_index"
        | "visibility_layer"
        | "command_count"
        | "modulate"
        | "self_modulate"
        | "xform";
      value: unknown;
    }
  | { kind: "version"; items: string[]; cmp: "eq" | "gt"; step: number }
  | { kind: "version_all"; except: string[]; cmp: "eq"; step: number }
  | {
      kind: "changed";
      items: string[];
      field: "xform" | "modulate" | "self_modulate";
      step: number;
    }
  | {
      kind: "swapped";
      items: [string, string];
      field: "draw_index" | "z_index";
      step: number;
    }
  | { kind: "absent"; items: string[] }
  | { kind: "present"; items: string[] }
  | { kind: "new_ids"; items: string[]; step: number }
  | { kind: "canvas_xform"; canvas: number; value: number[] };

export interface Gate1ExpectedStep {
  step: number;
  /** paint order: z ascending, then tree order (children after their parent, by draw index) */
  draws: Gate1Draw[];
  marker_rgba8: Rgba8;
  /** the root canvas transform at this step: x.x, x.y, y.x, y.y, origin.x, origin.y */
  canvas_transform: number[];
  invariants: Gate1Invariant[];
}

export interface Gate1Expected {
  schema: "render-stream-gate1-expected/1";
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  regions: Record<string, Rect4>;
  /** item names in canvas_item_create order: wire ids 1, 2, ... */
  creation_order: string[];
  /** items created later, in creation order, with the step that creates them */
  created_later: { name: string; step: number }[];
  steps: Gate1ExpectedStep[];
}

export interface SynthesizedFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Step k's applied frame (step 0 is the `_ready` state, frame 1) and settle frame. */
export function stepFrames(
  expected: Gate1Expected,
  step: number,
  start = expected.start_frame_default,
  span = expected.step_frames_default,
): { applied: number; settle: number } {
  return {
    applied: step === 0 ? 1 : start + span * step,
    settle: start + span * step + expected.settle_offset,
  };
}

/** Every name in wire-id order (`creation_order`, then `created_later`). */
export function gate1Names(expected: Gate1Expected): string[] {
  return [
    ...expected.creation_order,
    ...expected.created_later.map((c) => c.name),
  ];
}

/**
 * The expected 640x360 RGBA frame for one step: the clear colour, then every draw in paint order,
 * each clipped to the viewport and painted opaque.
 */
export function synthesizeGate1(
  expected: Gate1Expected,
  step: number,
): SynthesizedFrame {
  const [width, height] = expected.viewport;
  const found = expected.steps.find((entry) => entry.step === step);
  if (!found) {
    throw new Error(`gate1-expected: no step ${step} in expected.json`);
  }
  const rgba = new Uint8Array(width * height * 4);
  paintRect(rgba, width, height, [0, 0, width, height], expected.clear_rgba8);
  for (const draw of found.draws) {
    paintRect(rgba, width, height, draw.rect_px, draw.rgba8);
  }
  return { width, height, rgba };
}

export function paintRect(
  rgba: Uint8Array,
  width: number,
  height: number,
  rect: readonly number[],
  color: readonly number[],
): void {
  const [x, y, w, h] = rect;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const index = (py * width + px) * 4;
      rgba[index] = color[0];
      rgba[index + 1] = color[1];
      rgba[index + 2] = color[2];
      rgba[index + 3] = color[3];
    }
  }
}
