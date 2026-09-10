import { createGodotProjectResolver } from "@godot-scene-web/project/node";
import {
  type GodotNodePropertyOverrideMap,
  GodotSceneView,
} from "@godot-scene-web/vue";
import { computed, defineComponent, h, type VNodeChild } from "vue";

export interface RecoveredSceneDemoOptions {
  projectRoot: string;
  assetBaseUrl?: string | ((resourcePath: string) => string);
  initialScenePath: string;
}

export function createRecoveredSceneDemo(options: RecoveredSceneDemoOptions) {
  const resolver = createGodotProjectResolver({
    projectRoot: options.projectRoot,
    assetBaseUrl: options.assetBaseUrl,
  });

  return defineComponent({
    name: "RecoveredSceneDemo",
    props: {
      scenePath: {
        type: String,
        default: options.initialScenePath,
      },
      title: {
        type: String,
        default: "",
      },
      counter: {
        type: Number,
        default: 0,
      },
      showDebug: {
        type: Boolean,
        default: false,
      },
    },
    setup(props) {
      const scene = computed(() => resolver.loadScene(props.scenePath));
      const nodeOverrides = computed<GodotNodePropertyOverrideMap>(() => ({
        "HUD/Title": { text: props.title },
        "HUD/Counter": { text: String(props.counter) },
      }));
      const nodeNameOverrides = computed<GodotNodePropertyOverrideMap>(() => ({
        DebugLabel: { visible: props.showDebug },
        EditorOnly: { visible: false },
      }));

      return () =>
        h(
          GodotSceneView,
          {
            scene: scene.value,
            options: resolver.sceneOptions(scene.value),
            nodeOverrides: nodeOverrides.value,
            nodeNameOverrides: nodeNameOverrides.value,
          },
          {
            node: ({
              node,
              children,
            }: {
              node: { name: string };
              children: VNodeChild[];
            }) => {
              if (node.name === "RuntimeState") {
                return h(
                  "div",
                  { class: "runtime-state" },
                  String(props.counter),
                );
              }
              if (node.name === "CustomNodeMount") {
                return h("div", { class: "custom-node-replacement" }, children);
              }
              return children;
            },
          },
        );
    },
  });
}
