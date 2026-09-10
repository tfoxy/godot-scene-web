import {
  normalizeParticleRenderConfig,
  type ParticleRenderConfig,
} from "@godot-scene-web/effects/particles";

/** HTML attribute transport: portable parameters plus DOM placement and resource URLs. */
export interface ParticleSpecConfig extends ParticleRenderConfig {
  originX: number;
  originY: number;
  boxOffsetX: number;
  boxOffsetY: number;
  textureUrl: string | null;
  maskUrl?: string | null;
}

export function normalizeParticleSpecConfig(
  raw: Partial<ParticleSpecConfig> | null | undefined,
): ParticleSpecConfig {
  const value = raw ?? {};
  return {
    ...normalizeParticleRenderConfig(value),
    originX: finite(value.originX),
    originY: finite(value.originY),
    boxOffsetX: finite(value.boxOffsetX),
    boxOffsetY: finite(value.boxOffsetY),
    textureUrl: typeof value.textureUrl === "string" ? value.textureUrl : null,
    maskUrl:
      typeof value.maskUrl === "string" && value.maskUrl ? value.maskUrl : null,
  };
}

/** Decode the DOM attribute without putting its transport contract in the simulator. */
export function parseParticleSpecConfig(
  json: string | null | undefined,
): ParticleSpecConfig | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<ParticleSpecConfig>;
    return raw && typeof raw === "object"
      ? normalizeParticleSpecConfig(raw)
      : null;
  } catch {
    return null;
  }
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
