import type { GodotResource } from "@godot-scene-web/core";
import type { GodotResourceLoadStatus } from "@godot-scene-web/scene-graph";

/** A platform-neutral description of an asset resolved from a Godot resource reference. */
export interface GodotProjectResolvedResource {
  status?: GodotResourceLoadStatus;
  type?: string;
  path?: string;
  url?: string;
  document?: GodotResource;
  atlas?: GodotProjectResolvedResource;
  shader?: GodotProjectResolvedResource;
  region?: { x: number; y: number; width: number; height: number };
  size?: { width: number; height: number };
  fontUrl?: string;
  fontFamily?: string;
  fontStyle?: "normal" | "italic";
  fontWeight?: number | string;
  glyphSpacing?: number;
  fontMsdf?: boolean;
  message?: string;
}
