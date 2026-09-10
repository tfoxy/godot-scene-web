// Deterministic CPU particle simulation — a "visually plausible" port of Godot 4.5
// `CPUParticles2D::_particles_process` (scene/2d/cpu_particles_2d.cpp), with the
// GPU-only shapes/params from particle_process_material.cpp folded into the same
// config (the build-time reader unifies CPU/GPU into one `ParticleSpecConfig`).
//
// Pure + DOM-free + GL-free, so it is unit-testable in plain node. Not frame-exact to
// Godot: one LCG RNG and one seeding scheme; fractional-delta ignored; forward hue
// matrix; ring treated as a flat annulus. The things that DO matter for the look are
// kept faithful: spawn random draw ORDER, explosiveness/randomness birth timing,
// per-particle fixed force seed, the color/scale curve chain, and Godot units
// (spread = half-angle degrees, orbit = rev/s, gravity in px, align_y binds +Y).

import type { ParticleConfig } from "./config";
import { sampleParticleCurve, sampleParticleGradientInto } from "./sampling";
import type { Particle, ParticleSystemState } from "./state";

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Godot's MINSTD (Park–Miller) LCG, returning [0,1] and advancing the seed in place.
// One generator + one seeding scheme for the whole sim (distribution, not exact
// values, is what matters at the "visually plausible" bar).
function randFromSeed(holder: { seed: number }): number {
  let s = holder.seed | 0;
  if (s === 0) s = 305420679;
  const k = Math.trunc(s / 127773);
  s = 16807 * (s - k * 127773) - 2836 * k;
  if (s < 0) s += 2147483647;
  holder.seed = s >>> 0;
  return (holder.seed % 65536) / 65535;
}

const spawnRng = { seed: 1 };
const forceRng = { seed: 1 };
const displayColor: [number, number, number, number] = [1, 1, 1, 1];

function mixSeed(s: number): number {
  return Math.imul((s >>> 0) ^ 0x9e3779b9, 2654435761) >>> 0;
}

// Stable [0,1) hash used for per-slot birth-time jitter (randomness).
function hash01(i: number, seed: number): number {
  let h = Math.imul((i + 1) ^ (seed | 0), 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Forward YIQ-style hue rotation matrix (particle_process_material.cpp form).
function hueRotateInto(
  p: Particle,
  r: number,
  g: number,
  b: number,
  angle: number,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rr =
    r * (0.299 + 0.701 * c + 0.168 * s) +
    g * (0.587 - 0.587 * c + 0.33 * s) +
    b * (0.114 - 0.114 * c - 0.497 * s);
  const gg =
    r * (0.299 - 0.299 * c - 0.328 * s) +
    g * (0.587 + 0.413 * c + 0.035 * s) +
    b * (0.114 - 0.114 * c + 0.292 * s);
  const bb =
    r * (0.299 - 0.3 * c + 1.25 * s) +
    g * (0.587 - 0.588 * c - 1.05 * s) +
    b * (0.114 + 0.886 * c - 0.203 * s);
  p.r = rr;
  p.g = gg;
  p.b = bb;
}

// Emission position in node-local pixels, using `rng()` draws. Sphere/sphere-surface
// are both approximated as a uniform-area disk (the radial distribution difference is
// invisible for a 2D glow); ring is an area-uniform annulus.
function sampleEmissionInto(cfg: ParticleConfig, p: Particle): void {
  let x = 0;
  let y = 0;
  const shape = cfg.emissionShape;
  if (shape === 1 || shape === 2) {
    const a = randFromSeed(spawnRng) * TAU;
    const r = cfg.emissionSphereRadius * Math.sqrt(randFromSeed(spawnRng));
    x = Math.cos(a) * r;
    y = Math.sin(a) * r;
  } else if (shape === 3) {
    x = (randFromSeed(spawnRng) * 2 - 1) * cfg.emissionBoxExtents[0];
    y = (randFromSeed(spawnRng) * 2 - 1) * cfg.emissionBoxExtents[1];
  } else if (shape === 6) {
    const a = randFromSeed(spawnRng) * TAU;
    const outer = Math.max(
      cfg.emissionRingRadius,
      cfg.emissionRingInnerRadius,
      0.0001,
    );
    const inner = Math.max(0, Math.min(cfg.emissionRingInnerRadius, outer));
    const r = Math.sqrt(
      randFromSeed(spawnRng) * (outer * outer - inner * inner) + inner * inner,
    );
    x = Math.cos(a) * r;
    y = Math.sin(a) * r;
  }
  // shape 0 (point) / unsupported -> origin.
  p.x = x * cfg.emissionScale[0] + cfg.emissionOffset[0];
  p.y = y * cfg.emissionScale[1] + cfg.emissionOffset[1];
}

// The base spawn time of slot `i` within a cycle, in [0,1) of lifetime. explosiveness
// compresses all births toward 0 (burst); randomness jitters each slot.
function restartPhase(cfg: ParticleConfig, i: number): number {
  let rp = cfg.amount > 0 ? i / cfg.amount : 0;
  if (cfg.randomness > 0) {
    rp += (cfg.randomness * hash01(i, cfg.seed)) / cfg.amount;
  }
  return rp * (1 - cfg.explosiveness);
}

// Spawn / restart a particle (cpu_particles_2d.cpp:837-937). Spawn randoms are drawn
// in Godot's order — angle, scale, hue, anim-offset, [start color], spread, speed,
// lifetime, then emission position — because reordering visibly changes which
// particles are big/bright/fast together.
function restartParticle(
  state: ParticleSystemState,
  i: number,
  cycle: number,
): void {
  const cfg = state.config;
  const p = state.particles[i];
  const baseSeed = (cfg.seed + i * 2 + cycle) >>> 0;
  p.seed = baseSeed || 1;
  spawnRng.seed = mixSeed(baseSeed) || 1;

  p.angleRand = randFromSeed(spawnRng);
  p.scaleRand = randFromSeed(spawnRng);
  p.hueRand = randFromSeed(spawnRng);
  p.animOffsetRand = randFromSeed(spawnRng);
  if (cfg.colorInitialRamp?.length)
    sampleParticleGradientInto(
      cfg.colorInitialRamp,
      randFromSeed(spawnRng),
      p.startColor,
    );
  else {
    p.startColor[0] = 1;
    p.startColor[1] = 1;
    p.startColor[2] = 1;
    p.startColor[3] = 1;
  }

  const dirAngle = Math.atan2(cfg.direction[1], cfg.direction[0]);
  const angle =
    dirAngle + (randFromSeed(spawnRng) * 2 - 1) * cfg.spread * DEG2RAD;
  const speed = lerp(
    cfg.initialVelocityMin,
    cfg.initialVelocityMax,
    randFromSeed(spawnRng),
  );
  p.vx = Math.cos(angle) * speed;
  p.vy = Math.sin(angle) * speed;

  p.rotation = lerp(cfg.angleMin, cfg.angleMax, p.angleRand) * DEG2RAD;
  if (cfg.alignY) {
    const sp = Math.hypot(p.vx, p.vy);
    // Godot binds the sprite's +Y to the velocity; +PI/2 turns "up" toward travel.
    if (sp > 0) p.rotation = Math.atan2(p.vy, p.vx) + Math.PI / 2;
  }
  p.lifetime = Math.max(
    0.01,
    cfg.lifetime * (1 - randFromSeed(spawnRng) * cfg.lifetimeRandomness),
  );

  sampleEmissionInto(cfg, p);
  p.time = 0;
  p.active = true;
  updateDisplay(cfg, p, 0);
}

// Per-frame display outputs: size from scale curve(s) × random base scale; color from
// color_ramp(tv) × base × hue × start-color; alpha from color × alpha_curve(tv);
// flipbook frame from anim offset + tv × anim speed.
function updateDisplay(cfg: ParticleConfig, p: Particle, tv: number): void {
  let sx = 1;
  let sy = 1;
  const hasSplit =
    (cfg.scaleCurveX && cfg.scaleCurveX.length > 0) ||
    (cfg.scaleCurveY && cfg.scaleCurveY.length > 0);
  if (hasSplit) {
    sx = cfg.scaleCurveX?.length ? sampleParticleCurve(cfg.scaleCurveX, tv) : 1;
    sy = cfg.scaleCurveY?.length ? sampleParticleCurve(cfg.scaleCurveY, tv) : 1;
  } else if (cfg.scaleCurve && cfg.scaleCurve.length > 0) {
    sx = sampleParticleCurve(cfg.scaleCurve, tv);
    sy = sx;
  }
  const base = lerp(cfg.scaleMin, cfg.scaleMax, p.scaleRand);
  p.scaleX = Math.max(1e-5, sx * base);
  p.scaleY = Math.max(1e-5, sy * base);

  if (cfg.colorRamp?.length)
    sampleParticleGradientInto(cfg.colorRamp, tv, displayColor);
  else {
    displayColor[0] = 1;
    displayColor[1] = 1;
    displayColor[2] = 1;
    displayColor[3] = 1;
  }
  let r = displayColor[0];
  let g = displayColor[1];
  let b = displayColor[2];
  let a = displayColor[3];
  // `baseColorRender`, NOT `baseColor` — the base colour as the target Godot backend
  // uploads it (see `godot-renderer.ts`). The multiply order is Godot's, and Godot's is
  // internally inconsistent: `color_value` is linearized on the CPU before the UBO write,
  // while `color_ramp`/`color_initial_ramp` carry no `source_color` hint
  // (`particle_process_material.cpp:313-319`) so they are sampled raw and multiplied in
  // afterwards (`:626-627`, `:595-597`). The two factors are in different colour spaces in
  // the engine, so they must be here too: linearize the base, then multiply the ramp — not
  // the other way round, and never the ramp itself.
  r *= cfg.baseColorRender[0];
  g *= cfg.baseColorRender[1];
  b *= cfg.baseColorRender[2];
  a *= cfg.baseColorRender[3];
  if (cfg.alphaCurve && cfg.alphaCurve.length > 0) {
    a *= sampleParticleCurve(cfg.alphaCurve, tv);
  }
  const hueMag =
    lerp(cfg.hueVariationMin, cfg.hueVariationMax, p.hueRand) *
    (cfg.hueCurve && cfg.hueCurve.length > 0
      ? sampleParticleCurve(cfg.hueCurve, tv)
      : 1);
  if (hueMag !== 0) {
    hueRotateInto(p, r, g, b, hueMag * TAU);
    r = p.r;
    g = p.g;
    b = p.b;
  }
  p.r = r * p.startColor[0];
  p.g = g * p.startColor[1];
  p.b = b * p.startColor[2];
  p.a = a * p.startColor[3];

  // The frame INDEX is chosen over `frameCount` (the authored frame total, which can be fewer
  // than the grid holds) and then WRAPPED into the grid's cells — Godot's
  // `mod(progress, hframes * vframes)`. A fully-packed sheet makes the two equal, i.e. a plain
  // grid index.
  const cells = cfg.hframes * cfg.vframes;
  const total = cfg.frameCount && cfg.frameCount > 0 ? cfg.frameCount : cells;
  if (cells > 1) {
    const animSpeed = lerp(
      cfg.animSpeedMin,
      cfg.animSpeedMax,
      p.animOffsetRand,
    );
    const animOffset = lerp(
      cfg.animOffsetMin,
      cfg.animOffsetMax,
      p.animOffsetRand,
    );
    const phase = animOffset + tv * animSpeed;
    const f = cfg.animLoop ? phase - Math.floor(phase) : clamp01(phase);
    p.frame = Math.min(total - 1, Math.max(0, Math.floor(f * total))) % cells;
  } else {
    p.frame = 0;
  }
}

// Integrate one alive particle by `dt` (cpu_particles_2d.cpp:944-1122). Forces use a
// per-particle seed RE-READ each frame, so each particle's accel/damp/orbit/angular
// magnitudes are fixed-but-distinct across its life (fresh randoms => unnatural jitter).
function integrate(cfg: ParticleConfig, p: Particle, dt: number): void {
  p.time += dt;
  if (p.time >= p.lifetime) {
    p.active = false;
    return;
  }
  const tv = p.time / p.lifetime;
  forceRng.seed = p.seed;

  let fx = cfg.gravity[0];
  let fy = cfg.gravity[1];
  const speed = Math.hypot(p.vx, p.vy);
  const la = lerp(
    cfg.linearAccelMin,
    cfg.linearAccelMax,
    randFromSeed(forceRng),
  );
  if (speed > 0 && la !== 0) {
    fx += (p.vx / speed) * la;
    fy += (p.vy / speed) * la;
  }
  const dlen = Math.hypot(p.x, p.y);
  const ra = lerp(
    cfg.radialAccelMin,
    cfg.radialAccelMax,
    randFromSeed(forceRng),
  );
  if (dlen > 0 && ra !== 0) {
    fx += (p.x / dlen) * ra;
    fy += (p.y / dlen) * ra;
  }
  const ta = lerp(
    cfg.tangentialAccelMin,
    cfg.tangentialAccelMax,
    randFromSeed(forceRng),
  );
  if (dlen > 0 && ta !== 0) {
    fx += (-p.y / dlen) * ta;
    fy += (p.x / dlen) * ta;
  }
  p.vx += fx * dt;
  p.vy += fy * dt;

  const orbit = lerp(
    cfg.orbitVelocityMin,
    cfg.orbitVelocityMax,
    randFromSeed(forceRng),
  );
  if (orbit !== 0) {
    const a = -orbit * dt * TAU;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const nx = p.x * cos - p.y * sin;
    const ny = p.x * sin + p.y * cos;
    p.x = nx;
    p.y = ny;
  }

  const damp = lerp(cfg.dampingMin, cfg.dampingMax, randFromSeed(forceRng));
  if (damp > 0) {
    const cur = Math.hypot(p.vx, p.vy);
    if (cur > 0) {
      const dec = cfg.dampingAsFriction ? cur * damp * 0.05 * dt : damp * dt;
      const v = Math.max(0, cur - dec);
      p.vx = (p.vx / cur) * v;
      p.vy = (p.vy / cur) * v;
    }
  }

  const av = lerp(
    cfg.angularVelocityMin,
    cfg.angularVelocityMax,
    randFromSeed(forceRng),
  );
  p.rotation =
    (lerp(cfg.angleMin, cfg.angleMax, p.angleRand) + p.time * av) * DEG2RAD;

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  if (cfg.alignY) {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0) p.rotation = Math.atan2(p.vy, p.vx) + Math.PI / 2;
  }

  updateDisplay(cfg, p, tv);
}

// One fixed sub-step: advance the per-cycle clock (wrapping + incrementing `cycle`,
// and clearing `emitting` when a one-shot completes its cycle), (re)start any slot
// whose birth phase the clock crossed this step, then integrate all alive particles.
// Crossing detection mirrors cpu_particles_2d.cpp:789-833 (handles the wrap interval).
function step(state: ParticleSystemState, dt: number): void {
  const cfg = state.config;
  const lifetime = cfg.lifetime;
  const prevTime = state.time;
  let time = prevTime + dt;
  if (time >= lifetime) {
    const cycles = Math.floor(time / lifetime);
    state.cycle += cycles;
    time -= cycles * lifetime;
    if (cfg.oneShot) {
      state.emitting = false;
    }
  }
  state.time = time;
  const count = state.count;
  for (let i = 0; i < count; i += 1) {
    const p = state.particles[i];
    if (state.emitting) {
      const restartTime = restartPhase(cfg, i) * lifetime;
      const restart =
        time > prevTime
          ? restartTime >= prevTime && restartTime < time
          : restartTime >= prevTime || restartTime < time;
      if (restart) {
        restartParticle(state, i, state.cycle);
      }
    }
    if (p.active) {
      integrate(cfg, p, dt);
    }
  }
}

/**
 * Advance the system by `dt` seconds (real time), stepping the simulation in fixed
 * `1/fixed_fps` (or 1/30) chunks so the look is frame-rate independent. Mutates
 * `state` in place. `maxSteps` bounds the loop (warm-up / tab-switch spikes).
 *
 * Returns the number of fixed sub-steps it actually executed — the unit of work this function
 * does, and the only honest denominator for its cost: one display frame can run zero steps (a
 * fast display under a 30Hz `fixed_fps`, or `speed_scale: 0`) or many (a long dt, a warm-up), so
 * a profiler that divided wall-clock by FRAMES would be measuring the display, not the sim (see
 * `ParticleProfile.simSteps` in `./runtime`). Purely additive: every caller may ignore it, and
 * this function stays pure of any clock.
 */
export function simulateParticles(
  state: ParticleSystemState,
  dt: number,
  maxSteps = 1000,
): number {
  if (!(dt > 0)) return 0;
  const cfg = state.config;
  const frameTime = cfg.fixedFps > 0 ? 1 / cfg.fixedFps : 1 / 30;
  state.remainder += dt * cfg.speedScale;
  let steps = 0;
  while (state.remainder >= frameTime && steps < maxSteps) {
    step(state, frameTime);
    state.remainder -= frameTime;
    steps += 1;
  }
  return steps;
}

/**
 * Warm-start a freshly created system by its `preprocess` time (Godot pre-simulates
 * that much before first draw, so a long-lived ambient — fog with preprocess=100 —
 * appears mid-drift instead of empty/bursty). A REPEATING system reaches its steady
 * state within two lifetime cycles (a particle's look depends on its age, not absolute
 * time), so simulating `min(preprocess, 2 x lifetime)` is visually identical to the
 * full preprocess at bounded cost; a one-shot's whole life fits in that window too.
 * Steps are sized to cover the window (the default `maxSteps` caps at ~33s), and the
 * sub-step remainder is dropped so the leftover doesn't fast-forward the first live
 * frames at ~1000 steps per tick.
 */
export function preprocessParticles(state: ParticleSystemState): void {
  const cfg = state.config;
  if (cfg.preprocess <= 0) return;
  const warm = Math.min(cfg.preprocess, cfg.lifetime * 2);
  const stepHz = cfg.fixedFps > 0 ? cfg.fixedFps : 30;
  simulateParticles(state, warm, Math.ceil(warm * stepHz) + 2);
  state.remainder = 0;
}

// Fraction of a lifetime a NON-preprocessed system is advanced to for a static/frozen frame, so the frozen
// spray shows particles in flight rather than an empty t≈0 (all slots born but not yet moved). A one-shot burst
// looks best caught mid-flight (before its particles die); a continuous emitter reaches a full spread within one
// lifetime (every slot has emitted once). Cheap to retune.
const STATIC_WARM_ONESHOT_FRACTION = 0.4;
const STATIC_WARM_REPEAT_FRACTION = 1;

/**
 * Warm a system to a representative FROZEN state for the runtime's static/particles mode. Reuses the authored
 * `preprocess` (an ambient emitter with preprocess>0 reaches its steady drift — identical to `preprocessParticles`),
 * and for a system that would otherwise sit at spawn (preprocess<=0, e.g. a one-shot burst or an un-preprocessed
 * emitter) advances a representative slice of a lifetime so the frozen frame is populated. Mutates `state`; the
 * caller draws once and then stops simulating (see the particle runtime's static mode).
 *
 * This warm has no notion of the burst ENDING — it is a single representative frame, so a one-shot warmed here
 * would otherwise be drawn as mid-flight forever. `staticOneShotExpired` is what retires it.
 */
export function warmStaticParticles(state: ParticleSystemState): void {
  const cfg = state.config;
  if (cfg.preprocess > 0) {
    preprocessParticles(state);
    return;
  }
  const warm =
    cfg.lifetime *
    (cfg.oneShot ? STATIC_WARM_ONESHOT_FRACTION : STATIC_WARM_REPEAT_FRACTION);
  const stepHz = cfg.fixedFps > 0 ? cfg.fixedFps : 30;
  simulateParticles(state, warm, Math.ceil(warm * stepHz) + 2);
  // Drop the sub-step remainder so the frozen state is clean (nothing left to fast-forward if sim resumes).
  state.remainder = 0;
}

/**
 * Godot's own ACTIVE WINDOW for one one-shot cycle, in seconds: `lifetime * (2 - explosiveness)`
 * (particles.cpp `active_time`). At explosiveness 1 every particle is born at t=0, so the cycle is one
 * lifetime; at 0 the births are spread over a full lifetime, so the last particle dies at 2x lifetime.
 *
 * This is the SAME law the game-side mod uses to schedule a frozen one-shot's synthesized end-of-burst
 * (`CouchCoopHeadlessVisualSuspender.FinishNudgeDelaySeconds`), deliberately: the two sides have to agree on
 * when a burst is over, or one of them keeps drawing/reporting it after the other has stopped. No clamp and no
 * margin here — the mod's margin exists so its removal delta lands AFTER the client's tail, and this side IS
 * that tail. `normalizeParticleConfig` already guarantees a finite `lifetime >= 0.01` and `explosiveness` in
 * [0,1], so the result is finite and positive.
 *
 * `speedScale` is deliberately NOT folded in, for the same reason: the mod's law does not either, and a
 * disagreement would be worse than the (rare, small) inaccuracy of a re-timed burst.
 */
export function oneShotBurstSeconds(cfg: ParticleConfig): number {
  return cfg.lifetime * (2 - cfg.explosiveness);
}

/**
 * FROZEN-MODE expiry decision: has a one-shot burst the client has been drawing statically outlived its own
 * active window, so the runtime should stop drawing it? Pure (no clock, no DOM) — the caller supplies the
 * seconds elapsed since IT first saw this system emitting.
 *
 * WHY THIS EXISTS. In frozen/static mode a system is warmed to a representative mid-flight frame and that frame
 * is parked forever — which is right for an ambient emitter (it really does emit forever) and wrong for a
 * one-shot (it is a BURST; it ends). Nothing else can retire it: the frozen runtime never simulates, so the
 * sim's own end-of-cycle never runs, and the only other input is the host's `emitting` flag — which a host can
 * get stuck on (the live case: a game-side freeze left `Emitting` latched true on every energy-counter VFX, so
 * the mirror drew a permanent "energy ring" over a counter the game was showing bare).
 *
 * WHY "since FIRST SIGHT". The client cannot know when the game started the burst — it sees only "this spec
 * says emitting". One full active window from first sight is exactly what the burst itself would do, so a
 * legitimate transient (a hit spark, a card-play flourish) still shows for its natural life; only a burst that
 * outlives its own window — i.e. one nothing ever turned off — is dropped.
 */
export function staticOneShotExpired(
  cfg: ParticleConfig,
  secondsSinceFirstEmitting: number,
): boolean {
  if (!cfg.oneShot || !cfg.emitting) return false;
  return secondsSinceFirstEmitting >= oneShotBurstSeconds(cfg);
}

/** Live particle count (for tests / draw). */
export function activeParticleCount(state: ParticleSystemState): number {
  let n = 0;
  for (const p of state.particles) {
    if (p.active) n += 1;
  }
  return n;
}
