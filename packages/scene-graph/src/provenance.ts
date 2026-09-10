import type { GodotSceneState } from "@godot-scene-web/core";

export const SOURCE_SCENE_PATH_ATTRIBUTE =
  "metadata/godot_scene_web/source_scene_path";
export const MOUNTED_INNER_SCENE_PATH_ATTRIBUTE =
  "metadata/godot_scene_web/mounted_inner_scene_path";
/** Stamp parser output before publishing it to graph derivation caches. */
export function tagSceneNodes(
  scene: GodotSceneState,
  resourcePath: string,
): void {
  for (const node of scene.nodes) {
    const property = node.properties.find(
      (entry) => entry.name === SOURCE_SCENE_PATH_ATTRIBUTE,
    );
    if (property) property.value = resourcePath;
    else
      node.properties.push({
        name: SOURCE_SCENE_PATH_ATTRIBUTE,
        value: resourcePath,
      });
  }
}
