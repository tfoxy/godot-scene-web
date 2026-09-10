/** Renderer-neutral ramp and curve values used by particle state and texture bakers. */
export interface ParticleGradientStop {
  offset: number;
  color: [number, number, number, number];
}

export interface ParticleCurvePoint {
  x: number;
  y: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Godot-style endpoint-clamped gradient sampling. */
export function sampleParticleGradient(
  stops: readonly ParticleGradientStop[],
  t: number,
  interpolationMode = 0,
): [number, number, number, number] {
  if (stops.length === 0) return [0, 0, 0, 1];
  if (t <= stops[0].offset) return stops[0].color;
  const last = stops[stops.length - 1];
  if (t >= last.offset) return last.color;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const a = stops[index];
    const b = stops[index + 1];
    if (t >= a.offset && t <= b.offset) {
      if (interpolationMode === 1) return a.color;
      const fraction = (t - a.offset) / (b.offset - a.offset || 1);
      return [
        lerp(a.color[0], b.color[0], fraction),
        lerp(a.color[1], b.color[1], fraction),
        lerp(a.color[2], b.color[2], fraction),
        lerp(a.color[3], b.color[3], fraction),
      ];
    }
  }
  return last.color;
}

/** Allocation-free gradient sampling for simulation hot paths. */
export function sampleParticleGradientInto(
  stops: readonly ParticleGradientStop[],
  t: number,
  out: [number, number, number, number],
  interpolationMode = 0,
): void {
  if (stops.length === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return;
  }
  let a = stops[0];
  if (t <= a.offset) {
    out[0] = a.color[0];
    out[1] = a.color[1];
    out[2] = a.color[2];
    out[3] = a.color[3];
    return;
  }
  const last = stops[stops.length - 1];
  if (t >= last.offset) {
    out[0] = last.color[0];
    out[1] = last.color[1];
    out[2] = last.color[2];
    out[3] = last.color[3];
    return;
  }
  for (let index = 0; index < stops.length - 1; index += 1) {
    a = stops[index];
    const b = stops[index + 1];
    if (t >= a.offset && t <= b.offset) {
      const f =
        interpolationMode === 1
          ? 0
          : (t - a.offset) / (b.offset - a.offset || 1);
      out[0] = lerp(a.color[0], b.color[0], f);
      out[1] = lerp(a.color[1], b.color[1], f);
      out[2] = lerp(a.color[2], b.color[2], f);
      out[3] = lerp(a.color[3], b.color[3], f);
      return;
    }
  }
  out[0] = last.color[0];
  out[1] = last.color[1];
  out[2] = last.color[2];
  out[3] = last.color[3];
}

/** Godot-style endpoint-clamped linear curve sampling. */
export function sampleParticleCurve(
  points: readonly ParticleCurvePoint[],
  t: number,
): number {
  if (points.length === 0) return 0;
  if (t <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (t >= last.x) return last.y;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    if (t >= a.x && t <= b.x)
      return lerp(a.y, b.y, (t - a.x) / (b.x - a.x || 1));
  }
  return last.y;
}

export function normalizeParticleCurve(
  points: readonly ParticleCurvePoint[] | undefined,
): ParticleCurvePoint[] | undefined {
  return points
    ?.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice()
    .sort((a, b) => a.x - b.x);
}
