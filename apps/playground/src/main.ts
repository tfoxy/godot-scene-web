import {
  godotSceneBaseCss,
  renderSceneToHtmlModel,
} from "@godot-scene-web/html";
import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { GodotSceneView } from "@godot-scene-web/vue";
import { createApp, defineComponent, h, ref } from "vue";

const defaultScene = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Control"]
offset_right = 1280.0
offset_bottom = 720.0

[node name="Panel" type="ColorRect" parent="."]
offset_left = 40.0
offset_top = 40.0
offset_right = 360.0
offset_bottom = 180.0
color = Color(0.1, 0.45, 0.9, 1)

[node name="Label" type="Label" parent="Panel"]
offset_left = 20.0
offset_top = 20.0
offset_right = 280.0
offset_bottom = 80.0
horizontal_alignment = 1
text = "Godot Scene Web"
`;

const App = defineComponent({
  setup() {
    const source = ref(defaultScene);
    const debug = ref(true);
    return () => {
      const scene = parseGodotTextScene(source.value);
      const model = renderSceneToHtmlModel(
        resolveGodotSceneTree(deriveSceneGraph(scene)),
      );
      return h("main", { class: "app-shell" }, [
        h("style", baseCss),
        h("section", { class: "editor" }, [
          h("textarea", {
            spellcheck: "false",
            value: source.value,
            onInput: (event: Event) => {
              source.value = (event.target as HTMLTextAreaElement).value;
            },
          }),
          h("label", [
            h("input", {
              type: "checkbox",
              checked: debug.value,
              onChange: (event: Event) => {
                debug.value = (event.target as HTMLInputElement).checked;
              },
            }),
            " Debug outlines",
          ]),
          h(
            "pre",
            JSON.stringify(
              { diagnostics: [...scene.diagnostics, ...model.diagnostics] },
              null,
              2,
            ),
          ),
        ]),
        h("section", { class: "stage-wrap" }, [
          h(GodotSceneView, { scene, debug: debug.value }),
        ]),
      ]);
    };
  },
});

const baseCss = `
${godotSceneBaseCss}
* { box-sizing: border-box; }
body { margin: 0; background: #111; color: #eee; font-family: system-ui, sans-serif; }
.app-shell { display: grid; grid-template-columns: 480px 1fr; height: 100vh; }
.editor { display: grid; grid-template-rows: 1fr auto 180px; gap: 12px; padding: 16px; min-width: 0; }
textarea { width: 100%; height: 100%; resize: none; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { overflow: auto; margin: 0; background: #000; padding: 12px; }
.stage-wrap { display: grid; place-items: center; overflow: auto; background: #050505; }
`;

createApp(App).mount("#app");
