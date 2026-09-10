# Vue Usage

`@godot-scene-web/vue` renders a parsed scene or a prebuilt HTML model. For scenes loaded from a Godot project root, pass the resolver scene options so `.tres`, image/font resources, and `PackedScene` instances resolve the same way during HTML rendering. In a Node host, use the explicit `/node` subpath.

```ts
import { createGodotProjectResolver } from "@godot-scene-web/project/node";

const resolver = createGodotProjectResolver({
  projectRoot: "/path/to/godot-project",
  assetBaseUrl: "/godot-assets",
});
const scene = resolver.loadScene("res://ui/panel.tscn");
```

In a browser, the package root selects the fetch-backed resolver. A source-based Vite app should set
`resolve.conditions` to `browser` and `development`, and its TypeScript config should include both `development` and
`browser` in `customConditions`.

```ts
import { createGodotFetchProjectResolver } from "@godot-scene-web/project";

const resolver = createGodotFetchProjectResolver({
  assetBaseUrl: "/godot-assets",
});
const scene = await resolver.loadScene("res://ui/panel.tscn");
```

```ts
import { defineComponent, h } from "vue";
import { GodotSceneView } from "@godot-scene-web/vue";

export const PanelScene = defineComponent({
  props: {
    title: String,
    actionLabel: String,
    showIcon: Boolean,
  },
  setup(props) {
    return () =>
      h(
        GodotSceneView,
        {
          scene,
          options: resolver.sceneOptions(scene),
          nodeOverrides: {
            "Panel/Title": { text: props.title ?? "" },
            "Panel/Icon": { visible: Boolean(props.showIcon) },
          },
          nodeNameOverrides: {
            DebugLabel: { visible: false },
          },
        },
        {
          node: ({ node, children }) =>
            node.path === "Panel/Action"
              ? h(
                  "button",
                  { type: "button", class: "action-button" },
                  props.actionLabel ?? "",
                )
              : children,
        },
      );
  },
});
```

`nodeOverrides` are keyed by Godot scene path. `nodeNameOverrides` apply to every node with that Godot name. Slots receive the rendered HTML node and its already-rendered children, which lets a consumer replace individual nodes while leaving the toolkit model generic.

Runtime state, script behavior, and named scene wrappers belong in the consuming app. Keep this toolkit focused on Godot text resources, layout interpretation, DOM/CSS rendering, and generic Vue components.

The playground includes `apps/playground/src/recovered-demo.ts` as a Node-side consumer example for recovered project scenes. It uses the explicit `createGodotProjectResolver` Node import, path and name overrides, and the `#node` slot to replace runtime/custom mount points without adding project-specific DTOs to parser, layout, HTML, or Vue packages.
