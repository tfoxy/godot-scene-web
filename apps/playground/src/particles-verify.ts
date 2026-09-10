// Manual/automated visual harness for the live 2D particle runtime. Loads a scene
// from the recovered-project (served same-origin under /recovered) via the fetch
// resolver, renders it with the particle + shader runtimes enabled, and centers the
// Node2D-rooted orb so the emitter sits in view.
//
// Pick a scene with ?scene=res://… (defaults to frost_orb). For headless screenshots
// we force WebGL on software GL via the __gswForceWebglShaders escape hatch.
import type {
  GodotNode,
  GodotSceneState,
  GodotVariant,
} from "@godot-scene-web/core";
import { godotSceneBaseCss } from "@godot-scene-web/html";
import { createGodotFetchProjectResolver } from "@godot-scene-web/project/fetch";
import { GodotSceneView } from "@godot-scene-web/vue";
import { createApp, defineComponent, h, ref, shallowRef } from "vue";

// Run shaders + particles even on a software GL renderer (headless chromium uses
// SwiftShader, which the runtime declines by default).
(globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

const VIEWPORT = 640;
const resolver = createGodotFetchProjectResolver({
  assetBaseUrl: "/recovered/",
});

const params = new URLSearchParams(location.search);
const scenePath =
  params.get("scene") ?? "res://scenes/orbs/orb_visuals/frost_orb.tscn";
document.title = scenePath;

// Scene origin (0,0) is the emitter; place + magnify it so it's eyeball-able.
const SCALE = 4;
// Force-emit so a one-shot/idle emitter (test_burst is `emitting=false`) shows a
// steady stream to eyeball. Toggle off with ?emit=0 to observe true idle behavior.
const forceEmit = params.get("emit") !== "0";

function overrideNodeProps(
  node: GodotNode,
): Record<string, GodotVariant> | undefined {
  if (
    forceEmit &&
    (node.type === "GPUParticles2D" || node.type === "CPUParticles2D")
  ) {
    return {
      emitting: true as unknown as GodotVariant,
      one_shot: false as unknown as GodotVariant,
    };
  }
  return undefined;
}

const App = defineComponent({
  setup() {
    const scene = shallowRef<GodotSceneState | null>(null);
    const error = ref("");
    const settle = ref(0);
    resolver.subscribe(() => {
      settle.value += 1;
    });
    resolver
      .loadScene(scenePath)
      .then((loaded) => {
        scene.value = loaded;
      })
      .catch((e) => {
        error.value = String(e);
      });

    return () => {
      settle.value; // re-render as external resources settle
      const current = scene.value;
      return h(
        "div",
        {
          id: "stage-root",
          style:
            `position: relative; width: ${VIEWPORT}px; height: ${VIEWPORT}px;` +
            " margin: 0 auto; background: #0a0a0a; overflow: hidden;",
        },
        [
          h("style", godotSceneBaseCss),
          error.value ? h("pre", { style: "color:#f66" }, error.value) : null,
          current
            ? h(
                "div",
                {
                  style:
                    `position: absolute; left: ${VIEWPORT / 2}px; top: ${VIEWPORT / 2}px;` +
                    ` transform: scale(${SCALE}); transform-origin: 0 0;`,
                },
                [
                  h(GodotSceneView, {
                    scene: current,
                    resourceSource: resolver,
                    overrideNodeProps,
                    options: {
                      ...resolver.sceneOptions(current),
                      layoutMode: "computed",
                      viewport: { width: VIEWPORT, height: VIEWPORT },
                      enableParticles: true,
                      particleIds: ["*"],
                      enableWebglShaders: true,
                      webglShaderIds: ["*"],
                    },
                  }),
                ],
              )
            : h("div", { style: "color:#888" }, "loading…"),
        ],
      );
    };
  },
});

createApp(App).mount("#app");
