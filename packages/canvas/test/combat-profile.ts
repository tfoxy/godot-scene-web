/**
 * A synthetic draw list shaped like the COMBAT row of the offline batch-run probe
 * (`sts2-couch-coop/docs/agents/canvas-stage-probes-aug26.md`, P4), so the
 * executor's batching can be measured against the number the design was sized on
 * instead of against a list invented to flatter it.
 *
 * The row: 183 painting nodes, 152 naive runs, 65 distinct paint sources, and
 * breaks attributed to source 151, blend 16, clip 26, HSV 30. The builder below
 * reproduces all five, and `combat-profile.test.ts` ASSERTS that it does — a
 * fixture that quietly drifted to 30 textures would make the batch bound
 * meaningless.
 *
 * What is deliberately NOT reproduced: which texture goes where. The probe's real
 * sequence is dominated by a `text -> ui_atlas_0 -> text` alternation, and
 * copying the exact order would tie this test to one recording. A deterministic
 * shuffle over 65 keys with the same run/key statistics is the harder case
 * anyway: real runs cluster, so a random interleave fills a batch's texture table
 * SOONER than the recording would.
 */

import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  type BlendMode,
  createClipRectView,
  createDrawList,
  createQuadView,
  type DrawList,
} from "../src/draw-list";
import type { ExecutorTexture } from "../src/executor-webgl";

/** Painting nodes on the combat screen. */
export const COMBAT_PAINTING_NODES = 183;
/** Distinct paint sources (texture pages, `text`, `spine`, …) on that screen. */
export const COMBAT_DISTINCT_SOURCES = 65;
/** Runs a builder that breaks on ANY key change would issue. */
export const COMBAT_NAIVE_RUNS = 152;
/** Runs broken by a blend change. */
export const COMBAT_BLEND_BREAKS = 16;
/** Runs broken by a clip-scope change. */
export const COMBAT_CLIP_BREAKS = 26;
/** Quads carrying an HSV colour matrix. */
export const COMBAT_HSV_QUADS = 30;
/** Distinct HSV matrices among them — a handful of tints over many cards. */
export const COMBAT_HSV_MATRICES = 8;

export interface CombatProfile {
  list: DrawList<ExecutorTexture | null>;
  textures: ExecutorTexture[];
  /** Quads pushed. */
  quads: number;
  /** Distinct textures actually referenced. */
  distinctTextures: number;
  /** Runs over the probe's own batch key: (texture, blend, clip, has-matrix). */
  naiveRuns: number;
  /** Naive-run breaks attributed to each axis (a break can hit several). */
  breaks: { source: number; blend: number; clip: number; matrix: number };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeTexture(index: number): ExecutorTexture {
  return {
    // A distinct object per page; the executor only ever compares identity and
    // reads the two dimensions.
    texture: { page: index } as unknown as WebGLTexture,
    width: 2048,
    height: 2048,
  };
}

/** The `blend` value each quad draws under, with exactly `COMBAT_BLEND_BREAKS`
 *  transitions spread over the run. */
function blendPlan(runs: number): BlendMode[] {
  const modes: BlendMode[] = [BLEND_MIX, BLEND_ADD, BLEND_MUL];
  const plan: BlendMode[] = new Array(runs).fill(BLEND_MIX);
  let mode = 0;
  for (let change = 1; change <= COMBAT_BLEND_BREAKS; change += 1) {
    const at = Math.round((change * runs) / (COMBAT_BLEND_BREAKS + 1));
    mode = (mode + 1) % modes.length;
    for (let i = at; i < runs; i += 1) plan[i] = modes[mode];
  }
  return plan;
}

export function buildCombatProfile(): CombatProfile {
  const random = mulberry32(0x0c0ffee);
  const textures = Array.from({ length: COMBAT_DISTINCT_SOURCES }, (_, i) =>
    fakeTexture(i),
  );

  // One texture index per RUN. The first 65 runs are a shuffled permutation, so
  // every page is guaranteed to appear; the rest are drawn at random and re-rolled
  // when they would extend the previous run instead of breaking it.
  const order = textures.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const runTextures: number[] = [];
  for (let run = 0; run < COMBAT_NAIVE_RUNS; run += 1) {
    if (run < order.length) {
      runTextures.push(order[run]);
      continue;
    }
    let pick = Math.floor(random() * textures.length);
    while (pick === runTextures[run - 1]) {
      pick = (pick + 1) % textures.length;
    }
    runTextures.push(pick);
  }

  // 183 quads over 152 runs = 31 runs that are two quads long.
  const runLengths: number[] = new Array(COMBAT_NAIVE_RUNS).fill(1);
  const doubles = COMBAT_PAINTING_NODES - COMBAT_NAIVE_RUNS;
  for (let i = 0; i < doubles; i += 1) {
    runLengths[Math.floor(((i + 0.5) * COMBAT_NAIVE_RUNS) / doubles)] = 2;
  }

  const blends = blendPlan(COMBAT_NAIVE_RUNS);
  // 13 push/pop pairs = 26 clip-scope transitions.
  const clipPairs = COMBAT_CLIP_BREAKS / 2;
  const clipOpenAt = new Set<number>();
  const clipCloseAt = new Set<number>();
  for (let pair = 0; pair < clipPairs; pair += 1) {
    const open = Math.floor(((pair + 0.35) * COMBAT_NAIVE_RUNS) / clipPairs);
    clipOpenAt.add(open);
    clipCloseAt.add(open + 3);
  }
  // Which runs carry an HSV matrix, and which of the 8 tints.
  const hsvRuns = new Map<number, number>();
  for (let i = 0; i < COMBAT_HSV_QUADS; i += 1) {
    hsvRuns.set(
      Math.floor(((i + 0.5) * COMBAT_NAIVE_RUNS) / COMBAT_HSV_QUADS),
      i % COMBAT_HSV_MATRICES,
    );
  }
  const matrices = Array.from({ length: COMBAT_HSV_MATRICES }, (_, i) => {
    const k = 0.5 + i / 16;
    return new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1 - k / 4]);
  });

  const list = createDrawList<ExecutorTexture | null>({
    commandCapacity: 256,
  });
  const quad = createQuadView();
  const clipView = createClipRectView();
  const used = new Set<number>();
  let clipDepth = 0;
  let quads = 0;

  // The probe's own key, recomputed here so the fixture can prove its shape.
  let previousKey = "";
  let naiveRuns = 0;
  const breaks = { source: 0, blend: 0, clip: 0, matrix: 0 };
  let previousTexture = -1;
  let previousBlend: BlendMode | -1 = -1;
  let previousClip = -1;
  let previousMatrix = false;
  let clipScope = 0;

  for (let run = 0; run < COMBAT_NAIVE_RUNS; run += 1) {
    if (clipCloseAt.has(run) && clipDepth > 0) {
      list.popClip();
      clipDepth -= 1;
      clipScope += 1;
    }
    if (clipOpenAt.has(run)) {
      clipView.x = 40 + run;
      clipView.y = 30;
      clipView.w = 900;
      clipView.h = 700;
      clipView.cornerRadius = 0;
      clipView.outsetX = 0;
      list.pushClipRect(clipView);
      clipDepth += 1;
      clipScope += 1;
    }

    const textureIndex = runTextures[run];
    used.add(textureIndex);
    const blend = blends[run];
    const matrixIndex = hsvRuns.get(run);
    const hasMatrix = matrixIndex !== undefined;

    const key = `${textureIndex}|${blend}|${clipScope}|${hasMatrix}`;
    if (key !== previousKey) {
      naiveRuns += 1;
      // A BREAK is a transition between two consecutive nodes, so the very first
      // node starts a run without breaking anything — the probe counts it the
      // same way (152 runs, 151 source breaks).
      if (run > 0) {
        if (textureIndex !== previousTexture) breaks.source += 1;
        if (blend !== previousBlend) breaks.blend += 1;
        if (clipScope !== previousClip) breaks.clip += 1;
        if (hasMatrix !== previousMatrix) breaks.matrix += 1;
      }
      previousKey = key;
      previousTexture = textureIndex;
      previousBlend = blend;
      previousClip = clipScope;
      previousMatrix = hasMatrix;
    }

    for (let repeat = 0; repeat < runLengths[run]; repeat += 1) {
      quad.m[0] = 1;
      quad.m[1] = 0;
      quad.m[2] = 0;
      quad.m[3] = 1;
      quad.m[4] = (run * 11) % 1800;
      quad.m[5] = (run * 7 + repeat * 13) % 1000;
      quad.w = 64;
      quad.h = 48;
      quad.srcX = (textureIndex * 37) % 1900;
      quad.srcY = (textureIndex * 53) % 1900;
      quad.srcW = 64;
      quad.srcH = 48;
      quad.r = 1;
      quad.g = 1;
      quad.b = 1;
      quad.a = 1;
      quad.blend = blend;
      quad.flipH = false;
      quad.flipV = false;
      quad.hasColorMatrix = hasMatrix;
      if (matrixIndex !== undefined) {
        quad.colorMatrix.set(matrices[matrixIndex]);
      }
      list.pushQuad(quad, textures[textureIndex]);
      quads += 1;
    }
  }
  while (clipDepth > 0) {
    list.popClip();
    clipDepth -= 1;
  }

  return {
    list,
    textures,
    quads,
    distinctTextures: used.size,
    naiveRuns,
    breaks,
  };
}
