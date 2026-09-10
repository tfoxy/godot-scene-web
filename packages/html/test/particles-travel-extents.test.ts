// jsdom (gsw default env).
//
// THE SIZING LAW — `src/particles/extents.ts`, i.e. how big a particle system's overlay canvas has
// to be. A `GPUParticles2D` node is a POINT: its box is zero-size and the whole spray happens
// outside it, so the canvas is the box grown by a MARGIN, and the margin is the entire subject.
//
// THE BUG THIS PINS. That margin used to be ONE symmetric number — how big a sprite is plus how far
// apart the particles are BORN — and it modelled no MOVEMENT at all. Velocity, spread, gravity,
// acceleration, damping, orbit and lifetime were all in the same config and none of them were read.
// So every system got a SQUARE canvas centred on its node origin and anything that travelled was
// cut off at the square's edge, hard: the canvas backing store IS the clip, there is no CSS
// overflow to relax. The worked example throughout this file is the treasure chest's coin burst,
// which got a 710x710 square over coins that fly ~1264px sideways and fall 2500px.
//
// TWO PROPERTIES MAKE THE REPLACEMENT SAFE TO DEFAULT ON, and both get their own section below:
//   * it can only ever GROW a canvas (the directional result is FLOORED at the symmetric pad), so
//     the failure mode of a wrong number here is wasted pixels and never cropped ones;
//   * it is CAPPED by what can be seen (the host's `data-godot-particle-visible-rect`, and
//     `PAD_CAP` when there is none), so unbounded ballistics cannot allocate an unbounded canvas.
//
// The pure law is exercised directly. The last section drives the real runtime instead, because the
// kill switch and the attribute plumbing are claims about the RUNTIME, not about the arithmetic.

import type { ParticleSpecConfig } from "@godot-scene-web/html/runtime";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  emissionExtentPad,
  emissionExtents,
  PAD_CAP,
  type ParticleExtents,
  parseLocalVisibleRect,
  particleCanvasExtents,
  spriteExtentPad,
  symmetricCanvasExtents,
  travelExtents,
  visibleAllowance,
} from "../src/particles/extents";
import { createParticleRuntime } from "../src/particles/runtime";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { __resetSharedForTest } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

function cfg(over: Partial<ParticleSpecConfig> = {}): ParticleSpecConfig {
  return normalizeParticleConfig(over);
}

/** Canvas size (css px) the four margins imply for a node box — `measureCanvasGeometry`'s own sum. */
function canvasSize(
  pad: ParticleExtents,
  boxW = 0,
  boxH = 0,
): { cssW: number; cssH: number } {
  return {
    cssW: boxW + pad.left + pad.right,
    cssH: boxH + pad.top + pad.bottom,
  };
}

// ---- the worked example ------------------------------------------------------------------------

// The treasure chest's coin burst, reduced to the fields the sizing law actually reads: coin sprites
// off a 4x3 sheet of a 256x192 texture (so a 64x64 frame, drawn at up to 1.2x), born anywhere on a
// disk of radius 150 stretched 2x wide, fired UP in a 40-degree cone at up to 600 px/s, and falling
// under gravity 800 for a 2.5-second life. No damping, no acceleration, no orbit — the travel is
// pure ballistics, which is what makes it a clean arithmetic fixture.
const GOLD_BURST: Partial<ParticleSpecConfig> = {
  lifetime: 2.5,
  emissionShape: 1, // disk
  emissionScale: [2, 1],
  emissionSphereRadius: 150,
  direction: [0, -1],
  spread: 40,
  initialVelocityMin: 150,
  initialVelocityMax: 600,
  gravity: [0, 800],
  scaleMin: 0.8,
  scaleMax: 1.2,
  textureWidth: 256,
  textureHeight: 192,
  hframes: 4,
  vframes: 3,
};

// A mirrored particle layer's box. It is 0x0 and that is not a measurement failure: the mirror
// renders a Godot `Node2D`, which has no rect at all, so the canvas is ALL margin. It is the reason
// the visible-rect clamp has to exist — with no box to bound it, nothing else would.
const POINT_BOX = { width: 0, height: 0, offsetX: 0, offsetY: 0 };

// What the burst can see: the 1920x1080 design stage, from a node sitting at design (937, 512).
// Expressed in the NODE'S OWN local space, so the stage's top-left corner is up and to the left of
// the node origin by exactly the node's position — which is what makes it a pure-math stamp for the
// host (no layout read) and what the host in `sts2-couch-coop` computes per node.
const STAGE_RECT = { x: -937, y: -512, width: 1920, height: 1080 };

const SPRITE_PAD = 55; // ceil(1.2 * hypot(64, 64) / 2)
const EMISSION_PAD = 300; // the disk's 150 radius, stretched 2x on x
const OLD_PAD = SPRITE_PAD + EMISSION_PAD; // 355 — the symmetric margin this law replaced

describe("the chest's gold burst: the crop this law was written for", () => {
  const gold = cfg(GOLD_BURST);

  it("the symmetric pad sizes it 710x710 — a square over a burst that is not square", () => {
    expect(spriteExtentPad(gold, null)).toBe(SPRITE_PAD);
    expect(emissionExtentPad(gold)).toBe(EMISSION_PAD);
    const pad = symmetricCanvasExtents(gold, null);
    expect(pad).toEqual({
      left: OLD_PAD,
      right: OLD_PAD,
      top: OLD_PAD,
      bottom: OLD_PAD,
    });
    expect(canvasSize(pad)).toEqual({ cssW: 710, cssH: 710 });
  });

  it("reads the travel the old margin never did: ~964 sideways, 1500 up, 2500 down", () => {
    // The three terms, separable because there is no damping or acceleration here:
    //   sideways — the fastest particle's 600 px/s over 2.5s (1500px), projected onto x by the
    //              widest angle the 40-degree cone reaches, i.e. sin(40 deg);
    //   up       — the same 1500px, undiminished: straight up is INSIDE the cone;
    //   down     — 0.5 * 800 * 2.5^2, all of it on the one side gravity points at.
    const travel = travelExtents(gold);
    const sideways = 1500 * Math.sin((40 * Math.PI) / 180);
    expect(travel.left).toBeCloseTo(sideways, 6);
    expect(travel.right).toBeCloseTo(sideways, 6);
    expect(sideways).toBeCloseTo(964.18, 2);
    expect(travel.top).toBeCloseTo(1500, 6);
    expect(travel.bottom).toBeCloseTo(2500, 6);
    // The DIRECTIONAL claim in one line: a burst thrown up and pulled down needs 1.7x the room
    // below it that it needs above, and the symmetric pad had no way to say so.
    expect(travel.bottom / travel.top).toBeCloseTo(5 / 3, 6);
  });

  it("the emission disk is stretched 2x wide, so its own reach is directional too", () => {
    expect(emissionExtents(gold)).toEqual({
      left: 300,
      right: 300,
      top: 150,
      bottom: 150,
    });
    // …and the symmetric pad had to round that up to the LARGER axis on all four sides.
    expect(emissionExtentPad(gold)).toBe(300);
  });

  it("clamped to the design stage, the canvas is exactly the visible 1920x1080", () => {
    const allowance = visibleAllowance(STAGE_RECT, POINT_BOX);
    expect(allowance).toEqual({
      left: 937,
      right: 983,
      top: 512,
      bottom: 568,
    });
    const pad = particleCanvasExtents(gold, null, allowance);
    expect(pad).toEqual({ left: 937, right: 983, top: 512, bottom: 568 });
    expect(canvasSize(pad)).toEqual({ cssW: 1920, cssH: 1080 });
  });

  it("…and the clamp BINDS on all four sides — the burst leaves the screen on every one", () => {
    // What each side would have taken if nothing had stopped it (emission + travel + sprite),
    // every one of them past its allowance above.
    const wanted = {
      left: EMISSION_PAD + 964.18 + SPRITE_PAD, // ~1319 vs 937 allowed
      right: EMISSION_PAD + 964.18 + SPRITE_PAD, // ~1319 vs 983
      top: 150 + 1500 + SPRITE_PAD, // 1705 vs 512
      bottom: 150 + 2500 + SPRITE_PAD, // 2705 vs 568
    };
    const clamped = particleCanvasExtents(gold, null, {
      left: 937,
      right: 983,
      top: 512,
      bottom: 568,
    });
    expect(wanted.left).toBeGreaterThan(clamped.left);
    expect(wanted.right).toBeGreaterThan(clamped.right);
    expect(wanted.top).toBeGreaterThan(clamped.top);
    expect(wanted.bottom).toBeGreaterThan(clamped.bottom);
  });

  it("UNCLAMPED it wants PAD_CAP on every side — which is why the rect exists", () => {
    // No host rect: the only ceiling is `PAD_CAP`, and this burst reaches it in all four
    // directions. 2048x2048 is 8x the pixels of the clamped 1920x1080 canvas, for a burst that is
    // mostly off-screen — the cost the visible rect buys back.
    const pad = particleCanvasExtents(gold, null, null);
    expect(pad).toEqual({
      left: PAD_CAP,
      right: PAD_CAP,
      top: PAD_CAP,
      bottom: PAD_CAP,
    });
    expect(canvasSize(pad)).toEqual({ cssW: 2048, cssH: 2048 });
  });

  it("a node near the stage's edge gets an ASYMMETRIC canvas, not a re-centred square", () => {
    // The same burst in the bottom-right corner of the stage: almost nothing of it is visible to
    // the right or below, and the margin says so rather than spending those pixels anyway.
    const pad = particleCanvasExtents(
      gold,
      null,
      visibleAllowance(
        { x: -1800, y: -1000, width: 1920, height: 1080 },
        POINT_BOX,
      ),
    );
    expect(pad.left).toBe(1024); // PAD_CAP: 1800px of stage to the left is more than it can reach
    expect(pad.right).toBe(OLD_PAD); // only 120px visible → the FLOOR takes over
    expect(pad.top).toBe(1000);
    expect(pad.bottom).toBe(OLD_PAD); // only 80px visible → floor again
  });
});

// ---- the systems that must not move --------------------------------------------------------------

describe("point emission with no travel is byte-identical to the old margin", () => {
  // The common ambient case — a dot that sits still. It has no emission shape, no velocity and no
  // gravity, so the travel term is zero and the whole law collapses to the sprite pad it always
  // was. If this ever drifts, every static ambient system in a scene re-keys its frozen frame.
  const still = cfg({
    lifetime: 1.5,
    emissionShape: 0, // point
    initialVelocityMin: 0,
    initialVelocityMax: 0,
    gravity: [0, 0],
    textureWidth: 32,
    textureHeight: 32,
  });

  it("has no travel at all", () => {
    expect(travelExtents(still)).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    expect(emissionExtents(still)).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
  });

  it("gets exactly the canvas it got before this law existed", () => {
    const old = symmetricCanvasExtents(still, null);
    expect(particleCanvasExtents(still, null, null)).toEqual(old);
    expect(old.left).toBe(spriteExtentPad(still, null)); // 23 = ceil(hypot(32,32)/2)
  });

  it("…and a visible rect cannot take those pixels away", () => {
    // The floor, applied to the case that would otherwise be its most tempting victim: a still
    // system whose node has drifted almost entirely off the stage.
    const old = symmetricCanvasExtents(still, null);
    for (const rect of [
      STAGE_RECT,
      { x: -2, y: -2, width: 4, height: 4 },
      { x: 500, y: 500, width: 10, height: 10 }, // the node is not even inside it
    ]) {
      const pad = particleCanvasExtents(
        still,
        null,
        visibleAllowance(rect, POINT_BOX),
      );
      expect(pad).toEqual(old);
    }
  });

  it("a point emitter that DOES move grows only on the sides it moves toward", () => {
    // The other half of the same claim: "unchanged" is a property of standing still, not of being
    // a point emitter. A downward drip is asymmetric, and before this law it was not.
    const drip = cfg({
      lifetime: 1,
      emissionShape: 0,
      direction: [0, 1],
      spread: 0,
      initialVelocityMin: 200,
      initialVelocityMax: 200,
      gravity: [0, 0],
      textureWidth: 16,
      textureHeight: 16,
    });
    const pad = particleCanvasExtents(drip, null, null);
    const sprite = spriteExtentPad(drip, null);
    expect(pad.bottom).toBe(200 + sprite);
    // The three sides it never moves toward stay at the floor — EXACTLY, with no stray pixel. That
    // is `AXIS_EPSILON`'s job: `cos(PI/2)` is 6.1e-17 rather than 0, so without it the two
    // perpendicular sides would each pick up ~1e-14px of "travel" and `ceil` would bill a whole
    // pixel for it, on the commonest emitter shape there is.
    expect(pad.top).toBe(sprite);
    expect(pad.left).toBe(sprite);
    expect(pad.right).toBe(sprite);
    // …and with padX === padY, an axis-aligned system still gets ONE frozen-frame key, not two.
    expect(pad.left).toBe(pad.right);
  });
});

// ---- the floor -----------------------------------------------------------------------------------

describe("the floor: this law can only ever GROW a canvas", () => {
  // Six systems spanning the shapes the runtime actually meets, each crossed with every allowance a
  // host can hand over — including the two adversarial ones (nothing visible, and a rect the node
  // is not inside). The property under test is the safety guarantee the default-on rests on: no
  // system, under any allowance, ends up with LESS margin than the symmetric pad gave it.
  const systems: Array<[string, Partial<ParticleSpecConfig>]> = [
    ["the gold burst", GOLD_BURST],
    ["a still point dot", { emissionShape: 0, gravity: [0, 0] }],
    [
      "a card-sparkle box emitter",
      {
        emissionShape: 3,
        emissionBoxExtents: [120, 170],
        lifetime: 0.8,
        initialVelocityMin: 20,
        initialVelocityMax: 40,
        gravity: [0, 0],
      },
    ],
    [
      "an orbiting swirl",
      {
        emissionShape: 1,
        emissionSphereRadius: 40,
        orbitVelocityMin: 1,
        orbitVelocityMax: 1,
        lifetime: 2,
        initialVelocityMin: 90,
        initialVelocityMax: 90,
      },
    ],
    [
      "a heavily damped puff",
      {
        lifetime: 3,
        spread: 180,
        initialVelocityMin: 400,
        initialVelocityMax: 400,
        dampingMin: 300,
        dampingMax: 300,
        gravity: [0, 0],
      },
    ],
    [
      "a big-sprite ring with radial accel",
      {
        emissionShape: 6,
        emissionRingRadius: 60,
        radialAccelMin: -200,
        radialAccelMax: 400,
        tangentialAccelMin: 0,
        tangentialAccelMax: 150,
        scaleMax: 3,
        textureWidth: 128,
        textureHeight: 128,
        lifetime: 1.2,
      },
    ],
  ];
  const allowances: Array<[string, ParticleExtents | null]> = [
    ["no rect at all", null],
    ["the design stage", visibleAllowance(STAGE_RECT, POINT_BOX)],
    ["a one-pixel sliver", { left: 1, right: 1, top: 1, bottom: 1 }],
    ["nothing visible", { left: 0, right: 0, top: 0, bottom: 0 }],
    [
      "a rect the node is not inside",
      visibleAllowance({ x: 900, y: 900, width: 100, height: 100 }, POINT_BOX),
    ],
  ];

  for (const [systemName, over] of systems) {
    const config = cfg(over);
    const floor = symmetricCanvasExtents(config, null).left;
    for (const [allowanceName, allowance] of allowances) {
      it(`${systemName} under ${allowanceName} never drops below its old ${floor}px pad`, () => {
        const pad = particleCanvasExtents(config, null, allowance);
        expect(pad.left).toBeGreaterThanOrEqual(floor);
        expect(pad.right).toBeGreaterThanOrEqual(floor);
        expect(pad.top).toBeGreaterThanOrEqual(floor);
        expect(pad.bottom).toBeGreaterThanOrEqual(floor);
      });
    }
    it(`${systemName} is never capped above PAD_CAP either`, () => {
      for (const [, allowance] of allowances) {
        const pad = particleCanvasExtents(config, null, allowance);
        // The floor wins over `PAD_CAP` only where the two collide, and `symmetricCanvasExtents`
        // is itself capped — so this holds unconditionally.
        expect(
          Math.max(pad.left, pad.right, pad.top, pad.bottom),
        ).toBeLessThanOrEqual(PAD_CAP);
      }
    });
  }

  it("an allowance of zero still yields the whole old canvas, not a 1x1 one", () => {
    // The single most dangerous rounding of the clamp: a host that stamps a degenerate rect (a node
    // parked off-screen, a stage measured mid-transition) must not be able to shrink a working
    // canvas to nothing. It gets the pre-existing square back, unchanged.
    const gold = cfg(GOLD_BURST);
    const pad = particleCanvasExtents(gold, null, {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    expect(pad).toEqual(symmetricCanvasExtents(gold, null));
    expect(canvasSize(pad)).toEqual({ cssW: 710, cssH: 710 });
  });
});

// ---- visibleAllowance / parseLocalVisibleRect ----------------------------------------------------

describe("visibleAllowance", () => {
  it("measures each side from the node BOX's corresponding edge", () => {
    // A 40x20 box whose top-left sits 100,50 into a 500x300 visible rect.
    expect(
      visibleAllowance(
        { x: -100, y: -50, width: 500, height: 300 },
        { width: 40, height: 20, offsetX: 0, offsetY: 0 },
      ),
    ).toEqual({ left: 100, right: 360, top: 50, bottom: 230 });
  });

  it("accounts for the spec's boxOffset, which moves the whole canvas", () => {
    // `boxOffset` shifts the canvas (and with it the emission origin) inside the self-layer, so a
    // rect measured from the layer origin has to be read against the SHIFTED box. Same rect, box
    // slid 60px right: 60 more px of room on the left and 60 fewer on the right.
    expect(
      visibleAllowance(
        { x: -100, y: -50, width: 500, height: 300 },
        { width: 0, height: 0, offsetX: 60, offsetY: -10 },
      ),
    ).toEqual({ left: 160, right: 340, top: 40, bottom: 260 });
  });

  it("clamps to 0 rather than going negative when the box is off the rect entirely", () => {
    expect(
      visibleAllowance(
        { x: 500, y: 500, width: 100, height: 100 },
        { width: 0, height: 0, offsetX: 0, offsetY: 0 },
      ),
    ).toEqual({ left: 0, right: 600, top: 0, bottom: 600 });
  });
});

describe("parseLocalVisibleRect", () => {
  it("parses four comma-separated numbers", () => {
    expect(parseLocalVisibleRect("-937,-512,1920,1080")).toEqual({
      x: -937,
      y: -512,
      width: 1920,
      height: 1080,
    });
    expect(parseLocalVisibleRect("-937.5,-512.25,1920,1080")?.x).toBe(-937.5);
  });

  const rejected: Array<[string, string | null]> = [
    ["absent", null],
    ["empty", ""],
    ["too few fields", "0,0,1920"],
    ["too many fields", "0,0,1920,1080,3"],
    ["non-numeric", "a,b,c,d"],
    ["non-finite origin", "NaN,0,10,10"],
    ["zero width", "0,0,0,1080"],
    ["negative height", "0,0,1920,-5"],
  ];
  for (const [name, attr] of rejected) {
    it(`treats ${name} as "the host said nothing" (null, not a zero budget)`, () => {
      // The distinction matters: null keeps the `PAD_CAP` path, whereas a zero-size rect read as a
      // budget would clamp every side to the floor and quietly re-introduce the crop.
      expect(parseLocalVisibleRect(attr)).toBeNull();
    });
  }
});

// ---- the runtime: the attribute and the kill switch ----------------------------------------------

function fakeGl(): unknown {
  const overrides: Record<string, () => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getActiveUniform: () => null,
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

let rafQueue: FrameRequestCallback[] = [];
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  rafQueue = [];
  // Delivers a 0x0 contentRect for every observed layer — a mirrored `Node2D`'s real box.
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** The gold burst as the host serializes it: one opted-in node + its self-layer. */
function goldNode(visibleRect: string | null): {
  node: HTMLElement;
  self: HTMLElement;
} {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute(
    "data-godot-particle-specs",
    JSON.stringify({
      kind: "GPUParticles2D",
      amount: 64,
      emitting: true,
      blendMode: 0,
      ...GOLD_BURST,
    }),
  );
  if (visibleRect !== null) {
    node.setAttribute("data-godot-particle-visible-rect", visibleRect);
  }
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  node.appendChild(self);
  return { node, self };
}

function canvasIn(self: HTMLElement): HTMLCanvasElement {
  const canvas = self.querySelector<HTMLCanvasElement>(
    "[data-godot-particle-canvas]",
  );
  if (!canvas) throw new Error("no particle canvas mounted");
  return canvas;
}

/** The canvas's css box, as `writeCanvasBox` wrote it. */
function boxOf(canvas: HTMLCanvasElement): {
  width: string;
  height: string;
  left: string;
  top: string;
} {
  return {
    width: canvas.style.width,
    height: canvas.style.height,
    left: canvas.style.left,
    top: canvas.style.top,
  };
}

describe("the runtime reads the host's visible rect", () => {
  const options = { enableParticles: true } as never;

  it("sizes the gold burst's canvas to the visible stage", () => {
    const root = document.createElement("div");
    const gold = goldNode("-937,-512,1920,1080");
    root.appendChild(gold.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    // The canvas spans [-937, +983] x [-512, +568] around the node origin: the whole stage, and
    // exactly the stage.
    expect(boxOf(canvasIn(gold.self))).toEqual({
      width: "1920px",
      height: "1080px",
      left: "-937px",
      top: "-512px",
    });
    rt.dispose();
  });

  it("without the attribute it falls back to PAD_CAP (a much bigger canvas, not a crop)", () => {
    const root = document.createElement("div");
    const gold = goldNode(null);
    root.appendChild(gold.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    expect(boxOf(canvasIn(gold.self))).toEqual({
      width: "2048px",
      height: "2048px",
      left: "-1024px",
      top: "-1024px",
    });
    rt.dispose();
  });

  it("a MOVED emitter re-sizes its canvas in place — the binding is never re-created", () => {
    // The reason the rect is a DOM attribute and not a spec field. The spec JSON is the reconcile
    // key, so a rect that tracks where the node currently is would re-create the binding — and
    // restart the simulation — every time the emitter moved. Proven here by the canvas OBJECT
    // IDENTITY surviving a rect change that visibly re-sizes it.
    const root = document.createElement("div");
    const gold = goldNode("-937,-512,1920,1080");
    root.appendChild(gold.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    const first = canvasIn(gold.self);
    expect(boxOf(first).width).toBe("1920px");

    // The emitter slides right across the stage: only 500px of stage remains to its left, and the
    // 1420px now to its right is more than the burst can reach, so that side takes `PAD_CAP`.
    gold.node.setAttribute(
      "data-godot-particle-visible-rect",
      "-500,-512,1920,1080",
    );
    rt.reconcile();
    const second = canvasIn(gold.self);
    expect(second).toBe(first); // SAME canvas element — re-sized, not rebuilt
    expect(boxOf(second)).toEqual({
      width: `${500 + PAD_CAP}px`,
      height: "1080px",
      left: "-500px",
      top: "-512px",
    });
    rt.dispose();
  });

  it("a MALFORMED rect is ignored rather than obeyed", () => {
    const root = document.createElement("div");
    const gold = goldNode("not,a,rect,at-all");
    root.appendChild(gold.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, options);
    rt.reconcile();
    expect(boxOf(canvasIn(gold.self)).width).toBe("2048px"); // the no-rect path
    rt.dispose();
  });
});

describe("the kill switch: particleTravelExtents: false", () => {
  it("restores the 710x710 square, attribute or no attribute", () => {
    // Byte-identical to the pre-directional geometry — which is the whole promise of the switch:
    // a host that hits an unforeseen regression can turn the law off and get the old canvas back,
    // including its crop.
    const options = {
      enableParticles: true,
      particleTravelExtents: false,
    } as never;
    for (const rect of ["-937,-512,1920,1080", null]) {
      const root = document.createElement("div");
      const gold = goldNode(rect);
      root.appendChild(gold.node);
      document.body.appendChild(root);

      const rt = createParticleRuntime(root, options);
      rt.reconcile();
      expect(boxOf(canvasIn(gold.self))).toEqual({
        width: "710px",
        height: "710px",
        left: "-355px",
        top: "-355px",
      });
      rt.dispose();
      root.remove();
    }
  });
});
