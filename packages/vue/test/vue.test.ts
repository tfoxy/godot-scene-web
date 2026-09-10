import {
  mountHtmlScene,
  renderSceneToHtmlModel,
  STAGE_CLASS,
} from "@godot-scene-web/html";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import {
  GodotSceneView,
  mergeGodotNodePropOverrides,
  overrideGodotNodePropsByName,
  overrideGodotNodePropsByPath,
  useGodotSceneModel,
} from "../src/index";

// Compare the structural contract shared by every renderer. Inline `style` strings
// are ignored (jsdom normalizes them; they do not affect structure); only element
// children are walked, so whitespace text nodes from joins are irrelevant.
function expectSameStructure(
  actual: Element,
  expected: Element,
  path: string,
): void {
  expect(actual.tagName, `${path} tagName`).toBe(expected.tagName);
  expect(actual.className, `${path} className`).toBe(expected.className);
  expect(attributeMap(actual), `${path} attributes`).toEqual(
    attributeMap(expected),
  );
  const actualChildren = [...actual.children];
  const expectedChildren = [...expected.children];
  expect(actualChildren.length, `${path} child count`).toBe(
    expectedChildren.length,
  );
  if (expectedChildren.length === 0) {
    expect(actual.textContent, `${path} text`).toBe(expected.textContent);
    return;
  }
  expectedChildren.forEach((expectedChild, index) => {
    expectSameStructure(
      actualChildren[index] as Element,
      expectedChild,
      `${path} > ${expectedChild.tagName.toLowerCase()}[${index}]`,
    );
  });
}

function attributeMap(element: Element): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (attribute.name !== "style") {
      map[attribute.name] = attribute.value;
    }
  }
  return map;
}

describe("GodotSceneView", () => {
  it("renders scene nodes with stable Godot attributes", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Child" type="Label" parent="."]
offset_left = 10
offset_top = 20
offset_right = 110
offset_bottom = 60
text = "Hello"
`);
    const wrapper = mount(GodotSceneView, { props: { scene } });
    expect(wrapper.find('[data-godot-stage="true"]').exists()).toBe(true);
    expect(wrapper.find('[data-godot-path="Child"]').text()).toBe("Hello");
  });

  it("accepts resolver and override props directly", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("1")
[node name="Label" type="RichTextLabel" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
bbcode_enabled = true
text = "[b]Base[/b]"
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        resolveResource: () => ({ path: "res://icon.png", url: "/icon.png" }),
        overrideNodeProps: (_node, path) =>
          path === "Label" ? { text: "[i]Override[/i]" } : undefined,
      },
    });
    expect(
      wrapper
        .find('[data-godot-path="Icon"]')
        .attributes("data-godot-resource-path"),
    ).toBe("res://icon.png");
    expect(wrapper.find('[data-godot-path="Label"] em').text()).toBe(
      "Override",
    );
  });

  it("passes resolveResourcePath through to a RichTextLabel [img] tag", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Label" type="RichTextLabel" parent="."]
offset_right = 100
offset_bottom = 60
bbcode_enabled = true
text = "icon [img]res://icon.png[/img]"
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        resolveResourcePath: (path: string) => ({ path, url: "/icon.png" }),
      },
    });
    const img = wrapper.find('[data-godot-path="Label"] img.godot-rich-img');
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("/icon.png");
  });

  it("rerenders when a lazy external scene resource source notifies", async () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="child"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("child")]
`);
    const child = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Child" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Loaded"
`);
    let ready = false;
    const listeners = new Set<() => void>();
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        resourceSource: {
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        options: {
          resolveExternalScene: () =>
            ready
              ? { status: "ready", scene: child, path: "res://child.tscn" }
              : { status: "pending", path: "res://child.tscn" },
        },
      },
    });

    expect(wrapper.find('[data-godot-path="Host/Label"]').exists()).toBe(false);

    ready = true;
    for (const listener of listeners) {
      listener();
    }
    await nextTick();

    expect(wrapper.find('[data-godot-path="Host/Label"]').text()).toBe(
      "Loaded",
    );
  });

  it("exposes pending and failed resources from useGodotSceneModel", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=3 format=3]
[ext_resource type="PackedScene" path="res://pending.tscn" id="pending"]
[ext_resource type="PackedScene" path="res://failed.tscn" id="failed"]
[node name="Root" type="Control"]
[node name="Pending" parent="." instance=ExtResource("pending")]
[node name="Failed" parent="." instance=ExtResource("failed")]
`);
    const Probe = defineComponent({
      setup() {
        const sceneModel = useGodotSceneModel({
          scene,
          options: {
            resolveExternalScene: ({ ref }) =>
              ref.id === "failed"
                ? {
                    status: "error",
                    path: "res://failed.tscn",
                    message: "failed",
                  }
                : { status: "pending", path: "res://pending.tscn" },
          },
        });
        return () =>
          h("div", {
            "data-pending": String(sceneModel.pendingResources.value.length),
            "data-failed": String(sceneModel.failedResources.value.length),
          });
      },
    });

    const wrapper = mount(Probe);

    expect(wrapper.attributes("data-pending")).toBe("1");
    expect(wrapper.attributes("data-failed")).toBe("1");
  });

  it("supports path and name override maps with helper composition", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Title" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "Base"
[node name="Other" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "Other"
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        nodeNameOverrides: { Other: { visible: false } },
        nodeOverrides: { Title: { text: "Mapped" } },
      },
    });
    expect(wrapper.find('[data-godot-path="Title"]').text()).toBe("Mapped");
    // The hidden node is pruned to a v-if-style comment placeholder.
    expect(wrapper.find('[data-godot-path="Other"]').exists()).toBe(false);
    expect(wrapper.html()).toContain("<!--godot:hidden Other (Label)-->");

    const resolver = mergeGodotNodePropOverrides(
      overrideGodotNodePropsByName({ Title: { text: "Name" } }),
      overrideGodotNodePropsByPath({ Title: { text: "Path" } }),
    );
    expect(resolver(scene.nodes[1]!, "Title")?.text).toBe("Path");
  });

  it("updates through the incremental vnode cache across generations", async () => {
    // Each model rebuild hands the view all-new objects; the stabilized vnode
    // cache must keep the unchanged sibling in place (same DOM element) while
    // applying every generation's change — and never serve a stale subtree.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Title" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "gen0"
[node name="Other" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "stable"
`);
    const wrapper = mount(GodotSceneView, { props: { scene } });
    const otherElement = wrapper.find('[data-godot-path="Other"]').element;
    for (const generation of [1, 2, 3]) {
      await wrapper.setProps({
        nodeOverrides: { Title: { text: `gen${generation}` } },
      });
      expect(wrapper.find('[data-godot-path="Title"]').text()).toBe(
        `gen${generation}`,
      );
      expect(wrapper.find('[data-godot-path="Other"]').text()).toBe("stable");
      expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
        otherElement,
      );
    }
  });

  it("toggles visibility element -> comment -> element through the vnode cache", async () => {
    // The v-if pattern: a hidden node renders as a comment placeholder, and a
    // toggle back re-creates the element — while the unchanged sibling keeps its
    // DOM element identity through the stabilized vnode cache.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Toggle" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "toggle"
[node name="Other" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "stable"
`);
    const wrapper = mount(GodotSceneView, { props: { scene } });
    const otherElement = wrapper.find('[data-godot-path="Other"]').element;
    expect(wrapper.find('[data-godot-path="Toggle"]').exists()).toBe(true);

    await wrapper.setProps({ nodeOverrides: { Toggle: { visible: false } } });
    expect(wrapper.find('[data-godot-path="Toggle"]').exists()).toBe(false);
    expect(wrapper.html()).toContain("<!--godot:hidden Toggle (Label)-->");
    expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
      otherElement,
    );

    await wrapper.setProps({ nodeOverrides: { Toggle: { visible: true } } });
    expect(wrapper.find('[data-godot-path="Toggle"]').text()).toBe("toggle");
    expect(wrapper.html()).not.toContain("godot:hidden");
    expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
      otherElement,
    );
  });

  it("skips scene-graph derivation on resource-only settle notifications", async () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="child"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("child")]
`);
    const child = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Child" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Loaded"
`);
    let mountCalls = 0;
    let generations = { scenes: 1, resources: 0 };
    const listeners = new Set<() => void>();
    const notifyAll = async () => {
      for (const listener of listeners) {
        listener();
      }
      await nextTick();
    };
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        mountExternalScene: () => {
          mountCalls += 1;
          return child;
        },
        resourceSource: {
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          generations: () => ({ ...generations }),
        },
      },
    });
    expect(wrapper.find('[data-godot-path="Host/Label"]').exists()).toBe(true);
    const initialMounts = mountCalls;
    expect(initialMounts).toBeGreaterThan(0);

    // Resource-only settle (a texture/.tres landed): the derive memo holds — the
    // HTML model rebuilds, but the structural graph (mount expansion) does not.
    generations = { scenes: 1, resources: 1 };
    await notifyAll();
    expect(wrapper.find('[data-godot-path="Host/Label"]').exists()).toBe(true);
    expect(mountCalls).toBe(initialMounts);

    // A SCENE settle invalidates the memo: derivation runs again.
    generations = { scenes: 2, resources: 1 };
    await notifyAll();
    expect(mountCalls).toBeGreaterThan(initialMounts);
  });

  it("renders recursive container children in scene order", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="HBoxContainer"]
offset_right = 120
offset_bottom = 40
[node name="First" type="Label" parent="."]
custom_minimum_size = Vector2(40, 20)
text = "One"
[node name="Second" type="Label" parent="."]
custom_minimum_size = Vector2(40, 20)
text = "Two"
`);
    const wrapper = mount(GodotSceneView, { props: { scene } });
    const root = wrapper.find('[data-godot-path="."]');
    expect(root.attributes("style")).toContain("display: flex");
    expect(
      [...root.element.children].map((child) =>
        child.getAttribute("data-godot-self-layer") === "true"
          ? "self"
          : child.getAttribute("data-godot-path"),
      ),
    ).toEqual(["self", "First", "Second"]);
  });

  it("places show_behind_parent children before the self layer", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://parent.png" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Parent" type="TextureRect" parent="."]
offset_right = 40
offset_bottom = 40
texture = ExtResource("1")
[node name="Outline" type="ColorRect" parent="Parent"]
offset_right = 40
offset_bottom = 40
show_behind_parent = true
[node name="Normal" type="ColorRect" parent="Parent"]
offset_left = 4
offset_top = 4
offset_right = 20
offset_bottom = 20
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        resolveResource: () => ({
          path: "res://parent.png",
          url: "/parent.png",
        }),
      },
    });
    const parent = wrapper.find('[data-godot-path="Parent"]');
    expect(
      [...parent.element.children].map((child) =>
        child.getAttribute("data-godot-self-layer") === "true"
          ? "self"
          : child.getAttribute("data-godot-path"),
      ),
    ).toEqual(["Parent/Outline", "self", "Parent/Normal"]);
  });

  it("passes HTML positioning and container layout metadata through node slots", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="AspectRatioContainer"]
offset_right = 160
offset_bottom = 100
ratio = 2.0
[node name="Child" type="Label" parent="."]
text = "Label"
`);
    const wrapper = mount(GodotSceneView, {
      props: { scene },
      slots: {
        node: ({ node, children }) =>
          h("span", { "data-slot-path": node.path }, [
            `${node.positioning}:${node.containerLayout ?? "none"}`,
            ...children,
          ]),
      },
    });
    expect(
      wrapper.find('[data-godot-path="."] [data-slot-path="."]').text(),
    ).toContain("root:aspect-ratio");
    expect(
      wrapper.find('[data-godot-path="Child"] [data-slot-path="Child"]').text(),
    ).toContain("container-managed:none");
  });

  it("wraps the stage in a content-scale frame with cq styles (container)", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Child" type="Label" parent="."]
offset_left = 10
offset_right = 110
offset_bottom = 40
text = "Hello"
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        options: {
          viewport: { width: 1000, height: 500 },
          contentScale: { aspect: "keep" },
        },
      },
    });
    // The cq/min() style values themselves are verified in the html package's
    // model + string tests; jsdom drops them, so here we assert the structure.
    const frame = wrapper.find(".godot-scene-frame");
    expect(frame.exists()).toBe(true);
    expect(frame.find('[data-godot-stage="true"]').exists()).toBe(true);
    expect(wrapper.find('[data-godot-path="Child"]').exists()).toBe(true);
  });

  it("wraps the stage in a frame for the transform technique", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        options: {
          viewport: { width: 1000, height: 500 },
          contentScale: { aspect: "keep", technique: "transform" },
        },
      },
    });
    // Exercises the ResizeObserver lifecycle without throwing; structure only.
    const frame = wrapper.find(".godot-scene-frame");
    expect(frame.exists()).toBe(true);
    expect(frame.find('[data-godot-stage="true"]').exists()).toBe(true);
  });

  // An external texture with a non-white modulate tints via `filter: url(#id)`,
  // whose `<filter>` def must be emitted INTO the live view (the static renderers
  // emit it; the live view historically did not, so the reference dangled — or, in
  // a multi-view document, bound to another view's same-named filter).
  const tintedTextureScene = (): ReturnType<typeof parseGodotTextScene> =>
    parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("1")
modulate = Color(0.945, 0.216, 0.243, 1)
`);
  const resolveIcon = () => ({ path: "res://icon.png", url: "/icon.png" });

  it("emits the tint-filter defs the texture references", () => {
    const wrapper = mount(GodotSceneView, {
      props: { scene: tintedTextureScene(), resolveResource: resolveIcon },
    });
    const html = wrapper.html();
    // The def is present...
    expect(html).toContain("<feColorMatrix");
    const defId = html.match(/<filter id="([^"]+)"/)?.[1];
    expect(defId).toBeDefined();
    // ...and the texture's self-layer references that exact id (not a dangling one).
    // jsdom serializes the CSS url quoted (`url("#id")`); match the `#id` reference.
    expect(html).toContain(`#${defId}`);
  });

  it("gives each mounted view a distinct tint-filter id prefix", () => {
    const first = mount(GodotSceneView, {
      props: { scene: tintedTextureScene(), resolveResource: resolveIcon },
    });
    const second = mount(GodotSceneView, {
      props: { scene: tintedTextureScene(), resolveResource: resolveIcon },
    });
    const idOf = (w: typeof first): string | undefined =>
      w.html().match(/<filter id="([^"]+)"/)?.[1];
    const a = idOf(first);
    const b = idOf(second);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Two views sharing a document must not collide on `#godot-tint-N`.
    expect(a).not.toBe(b);
  });

  it("honors a caller-supplied tintFilterIdPrefix", () => {
    const wrapper = mount(GodotSceneView, {
      props: {
        scene: tintedTextureScene(),
        resolveResource: resolveIcon,
        options: { tintFilterIdPrefix: "custom-tint-" },
      },
    });
    const defId = wrapper.html().match(/<filter id="([^"]+)"/)?.[1];
    expect(defId).toBe("custom-tint-0");
  });

  it("renders the stage subtree structurally identical to the DOM renderer", () => {
    // The Vue view and the DOM renderer are both thin emitters over the shared
    // structural tree; their stage subtrees must agree node-for-node (the parity
    // that catches a renderer drifting — the original tint/rich-text bugs).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 160
[node name="Back" type="ColorRect" parent="."]
offset_right = 200
offset_bottom = 160
show_behind_parent = true
[node name="Label" type="Label" parent="."]
offset_right = 120
offset_bottom = 30
text = "Hello world"
[node name="Rich" type="RichTextLabel" parent="."]
offset_top = 40
offset_right = 120
offset_bottom = 90
bbcode_enabled = true
text = "a [b]bold[/b] and [i]italic[/i] run"
[node name="Group" type="Control" parent="."]
offset_top = 100
offset_right = 120
offset_bottom = 160
[node name="GroupChild" type="ColorRect" parent="Group"]
offset_right = 60
offset_bottom = 40
`);
    const model = renderSceneToHtmlModel(resolveGodotSceneTree(scene));

    const host = document.createElement("div");
    mountHtmlScene(host, model);
    const domStage = host.querySelector(`.${STAGE_CLASS}`);

    // `attachTo` so the multi-root component's siblings are all queryable.
    const vueHost = document.createElement("div");
    document.body.appendChild(vueHost);
    const wrapper = mount(GodotSceneView, {
      props: { scene },
      attachTo: vueHost,
    });
    const vueStage = vueHost.querySelector(`.${STAGE_CLASS}`);

    expect(domStage, "DOM stage").not.toBeNull();
    expect(vueStage, "Vue stage").not.toBeNull();
    expectSameStructure(vueStage as Element, domStage as Element, STAGE_CLASS);
    wrapper.unmount();
    vueHost.remove();
  });

  it("injects rich text as the self-layer's direct innerHTML (no wrapping span)", () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Body" type="RichTextLabel" parent="."]
offset_right = 200
offset_bottom = 100
bbcode_enabled = true
text = "[center]Hello[/center]"
`);
    const wrapper = mount(GodotSceneView, { props: { scene } });
    const selfLayer = wrapper.find(
      '[data-godot-path="Body"] .godot-scene-self-layer',
    );
    expect(selfLayer.exists()).toBe(true);
    // The DOM and HTML-string renderers inject `node.html` as the self-layer's
    // innerHTML, so the rich-text `.godot-rich-stack` is a DIRECT child of the
    // self-layer. The live view must match — NOT nest it under an extra `<span>`
    // (which would collapse the `[center]`/shadow `display:block` stack).
    expect(
      selfLayer.element.querySelector(":scope > .godot-rich-stack"),
    ).not.toBeNull();
  });
});

// Stage A of the component-tree rewrite: `componentTree: true` renders each node as
// its own `GodotNodeView` component. Its DOM must be STRUCTURALLY IDENTICAL to the
// flat fragment path (same tags/classes/attributes/children/text; inline style is
// ignored by `expectSameStructure`). This is the gate that lets the existing html /
// screenshot goldens transitively cover the component renderer.
describe("GodotSceneView componentTree mode (structural parity)", () => {
  function expectComponentTreeMatchesFragment(
    scene: ReturnType<typeof parseGodotTextScene>,
    extraProps: Record<string, unknown> = {},
  ): void {
    const fragHost = document.createElement("div");
    document.body.appendChild(fragHost);
    const frag = mount(GodotSceneView, {
      props: { scene, ...extraProps },
      attachTo: fragHost,
    });
    const compHost = document.createElement("div");
    document.body.appendChild(compHost);
    const comp = mount(GodotSceneView, {
      props: { scene, ...extraProps, componentTree: true },
      attachTo: compHost,
    });
    const fragStage = fragHost.querySelector(`.${STAGE_CLASS}`);
    const compStage = compHost.querySelector(`.${STAGE_CLASS}`);
    expect(fragStage, "fragment stage").not.toBeNull();
    expect(compStage, "componentTree stage").not.toBeNull();
    expectSameStructure(
      compStage as Element,
      fragStage as Element,
      STAGE_CLASS,
    );
    frag.unmount();
    fragHost.remove();
    comp.unmount();
    compHost.remove();
  }

  it("matches the fragment renderer on behind-parent, rich text, and nested groups", () => {
    expectComponentTreeMatchesFragment(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 160
[node name="Back" type="ColorRect" parent="."]
offset_right = 200
offset_bottom = 160
show_behind_parent = true
[node name="Label" type="Label" parent="."]
offset_right = 120
offset_bottom = 30
text = "Hello world"
[node name="Rich" type="RichTextLabel" parent="."]
offset_top = 40
offset_right = 120
offset_bottom = 90
bbcode_enabled = true
text = "a [b]bold[/b] and [i]italic[/i] run"
[node name="Group" type="Control" parent="."]
offset_top = 100
offset_right = 120
offset_bottom = 160
[node name="GroupChild" type="ColorRect" parent="Group"]
offset_right = 60
offset_bottom = 40
`),
    );
  });

  it("matches the fragment renderer on auto-layout containers", () => {
    expectComponentTreeMatchesFragment(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 400
offset_bottom = 300
[node name="HBox" type="HBoxContainer" parent="."]
offset_right = 400
offset_bottom = 80
[node name="A" type="Label" parent="HBox"]
text = "a"
size_flags_horizontal = 3
[node name="B" type="Label" parent="HBox"]
text = "b"
[node name="VBox" type="VBoxContainer" parent="."]
offset_top = 90
offset_right = 200
offset_bottom = 220
[node name="Row" type="Label" parent="VBox"]
text = "row"
[node name="Center" type="CenterContainer" parent="."]
offset_top = 230
offset_right = 200
offset_bottom = 300
[node name="Centered" type="ColorRect" parent="Center"]
custom_minimum_size = Vector2(40, 40)
`),
    );
  });

  it("matches the fragment renderer on mounted sub-scenes and a hidden override", () => {
    const host = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://button.tscn" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="ButtonA" parent="." instance=ExtResource("1")]
[node name="Hidden" type="Control" parent="."]
offset_right = 50
offset_bottom = 50
[node name="HiddenChild" type="ColorRect" parent="Hidden"]
offset_right = 50
offset_bottom = 50
`);
    const mounted = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="ButtonScene" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Base"
`);
    expectComponentTreeMatchesFragment(host, {
      mountExternalScene: (ref: { id?: string }) =>
        ref.id === "1" ? mounted : undefined,
      overrideNodeProps: (_node: unknown, path: string) =>
        path === "Hidden" ? { visible: false } : undefined,
    });
  });

  it("keeps unchanged-sibling DOM identity across an override change (Vue keyed reconcile)", async () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Title" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "base"
[node name="Other" type="Label" parent="."]
offset_top = 40
offset_right = 100
offset_bottom = 70
text = "stable"
`);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        componentTree: true,
        nodeOverrides: { Title: { text: "gen1" } },
      },
      attachTo: host,
    });
    const otherEl = host.querySelector('[data-godot-path="Other"]');
    expect(
      host.querySelector('[data-godot-path="Title"]')?.textContent,
    ).toContain("gen1");

    await wrapper.setProps({ nodeOverrides: { Title: { text: "gen2" } } });
    await nextTick();
    expect(
      host.querySelector('[data-godot-path="Title"]')?.textContent,
    ).toContain("gen2");
    // The unchanged sibling keeps its DOM element — Vue patches the keyed component
    // in place rather than recreating it (the incremental property, here for free).
    expect(host.querySelector('[data-godot-path="Other"]')).toBe(otherEl);

    wrapper.unmount();
    host.remove();
  });

  it("matches the fragment renderer on a content-scaled (container) rich-text scene", () => {
    // Per-node container-technique px rewrite (style + rich-text `html`) must match;
    // the rich-text rewrite is visible in the compared stage subtree.
    expectComponentTreeMatchesFragment(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 120
[node name="Rich" type="RichTextLabel" parent="."]
offset_right = 180
offset_bottom = 60
bbcode_enabled = true
text = "scaled [b]bold[/b] [font_size=24]big[/font_size]"
[node name="Plain" type="Label" parent="."]
offset_top = 70
offset_right = 120
offset_bottom = 100
text = "plain"
`),
      {
        options: {
          viewport: { width: 1000, height: 500 },
          contentScale: { aspect: "keep" },
        },
      },
    );
  });

  it("matches the fragment renderer when a non-renderable node flattens its children", () => {
    // A `Timer` (not a renderable type) is skipped; its `Label` child re-parents to
    // the nearest renderable ancestor (Root) — buildSceneStructure must flatten it
    // exactly as renderSceneGraphToHtmlModel's nearest-renderable-parent does.
    expectComponentTreeMatchesFragment(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 120
[node name="Logic" type="Timer" parent="."]
[node name="Deep" type="Label" parent="Logic"]
offset_right = 120
offset_bottom = 30
text = "flattened"
[node name="Sibling" type="ColorRect" parent="."]
offset_top = 40
offset_right = 60
offset_bottom = 80
`),
    );
  });

  it("matches the fragment renderer on deep nested containers with z-order siblings", () => {
    expectComponentTreeMatchesFragment(
      parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 300
offset_bottom = 300
[node name="Outer" type="VBoxContainer" parent="."]
offset_right = 300
offset_bottom = 300
[node name="Inner" type="HBoxContainer" parent="Outer"]
[node name="Cell" type="MarginContainer" parent="Outer/Inner"]
[node name="Leaf" type="Label" parent="Outer/Inner/Cell"]
text = "deep"
[node name="OverA" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
z_index = 5
[node name="OverB" type="ColorRect" parent="."]
offset_right = 50
offset_bottom = 50
z_index = 1
`),
    );
  });

  it("componentTree: updates the changed node while the sibling keeps its DOM element across generations", async () => {
    // Ported from the fragment incremental test — now via native per-node reactivity.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Title" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "gen0"
[node name="Other" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "stable"
`);
    const wrapper = mount(GodotSceneView, {
      props: { scene, componentTree: true },
    });
    const otherElement = wrapper.find('[data-godot-path="Other"]').element;
    for (const generation of [1, 2, 3]) {
      await wrapper.setProps({
        nodeOverrides: { Title: { text: `gen${generation}` } },
      });
      expect(wrapper.find('[data-godot-path="Title"]').text()).toBe(
        `gen${generation}`,
      );
      expect(wrapper.find('[data-godot-path="Other"]').text()).toBe("stable");
      expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
        otherElement,
      );
    }
    wrapper.unmount();
  });

  it("componentTree: toggles visibility element -> comment -> element keeping the sibling", async () => {
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Toggle" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "toggle"
[node name="Other" type="Label" parent="."]
offset_top = 30
offset_right = 100
offset_bottom = 60
text = "stable"
`);
    const wrapper = mount(GodotSceneView, {
      props: { scene, componentTree: true },
    });
    const otherElement = wrapper.find('[data-godot-path="Other"]').element;
    expect(wrapper.find('[data-godot-path="Toggle"]').exists()).toBe(true);

    await wrapper.setProps({ nodeOverrides: { Toggle: { visible: false } } });
    expect(wrapper.find('[data-godot-path="Toggle"]').exists()).toBe(false);
    expect(wrapper.html()).toContain("<!--godot:hidden Toggle (Label)-->");
    expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
      otherElement,
    );

    await wrapper.setProps({ nodeOverrides: { Toggle: { visible: true } } });
    expect(wrapper.find('[data-godot-path="Toggle"]').text()).toBe("toggle");
    expect(wrapper.html()).not.toContain("godot:hidden");
    expect(wrapper.find('[data-godot-path="Other"]').element).toBe(
      otherElement,
    );
    wrapper.unmount();
  });

  it("re-renders ONLY the changed node's component on a leaf override (the Stage-B win)", async () => {
    // The granularity proof: a single leaf override must re-render JUST that leaf's
    // GodotNodeView — its parent, siblings, and the rest of the tree keep their
    // components dormant (each pulls its own node; Vue value-equality skips the
    // unchanged ones). A global mixin counts per-path component updates.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 220
[node name="Title" type="Label" parent="."]
offset_right = 100
offset_bottom = 30
text = "base"
[node name="Other" type="Label" parent="."]
offset_top = 40
offset_right = 100
offset_bottom = 70
text = "stable"
[node name="Group" type="Control" parent="."]
offset_top = 80
offset_right = 100
offset_bottom = 220
[node name="GroupChild" type="Label" parent="Group"]
offset_right = 100
offset_bottom = 30
text = "child"
`);
    const renders = new Map<string, number>();
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        componentTree: true,
        nodeOverrides: { Title: { text: "gen1" } },
      },
      global: {
        mixins: [
          {
            updated(this: { $props?: { path?: unknown } }) {
              const path = this.$props?.path;
              if (typeof path === "string") {
                renders.set(path, (renders.get(path) ?? 0) + 1);
              }
            },
          },
        ],
      },
    });
    renders.clear(); // ignore the initial mount

    await wrapper.setProps({ nodeOverrides: { Title: { text: "gen2" } } });
    await nextTick();

    expect(wrapper.find('[data-godot-path="Title"]').text()).toBe("gen2");
    // ONLY the Title component re-rendered — Root/Other/Group/GroupChild did not.
    expect([...renders.keys()].sort()).toEqual(["Title"]);
    expect(renders.get("Title")).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });

  it("componentTree: emits the tint-filter defs an external texture references", () => {
    // Resource resolution + the tint registry must work in component mode: the
    // texture resolves, its non-white modulate registers a tint, and the shared
    // `<svg><defs>` carries the referenced `<filter>` (matching the fragment path).
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://icon.png" id="1"]
[node name="Root" type="Control"]
offset_right = 100
offset_bottom = 100
[node name="Icon" type="TextureRect" parent="."]
offset_right = 20
offset_bottom = 20
texture = ExtResource("1")
modulate = Color(0.945, 0.216, 0.243, 1)
`);
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        componentTree: true,
        resolveResource: () => ({ path: "res://icon.png", url: "/icon.png" }),
      },
    });
    const defs = wrapper.find("svg defs filter");
    expect(defs.exists()).toBe(true);
    const icon = wrapper.find(
      '[data-godot-path="Icon"] .godot-scene-self-layer',
    );
    // The self-layer references the registered tint filter (jsdom serializes it as
    // `-webkit-filter: url("#godot-tint-…")`) and paints the resolved texture.
    expect(icon.attributes("style") ?? "").toContain("godot-tint-");
    expect(icon.attributes("style") ?? "").toContain("/icon.png");
    wrapper.unmount();
  });

  it("componentTree: sizes a Sprite2D box once its deferred texture size settles", async () => {
    // The deferred-texture-size box path. A Sprite2D has no anchors/offsets: in
    // Godot its rect is TEXTURE size × scale, centered on `position` unless
    // `centered = false`/`offset` shifts it (Sprite2D::get_rect). When the resolver
    // can't size the raster at build time it resolves `status: "pending"` while it
    // measures the image (gsw fetch resolver `imageSizes`); the pending status is
    // what makes the component-mode node cache re-derive the node on the settle
    // notification — WITHOUT it the graph node identity is unchanged (resource-only
    // settles keep the memoized graph) and the 0×0 box would be pinned forever,
    // which is exactly the bug that left the Neow `water effect` SCREEN_TEXTURE
    // shader canvases 0-sized.
    const scene = parseGodotTextScene(`
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://cloud.png" id="1"]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 200
[node name="Fx" type="Sprite2D" parent="."]
position = Vector2(100, 50)
texture = ExtResource("1")
`);
    let resolved: Record<string, unknown> = {
      path: "res://cloud.png",
      url: "/cloud.png",
      status: "pending",
    };
    const listeners = new Set<() => void>();
    const wrapper = mount(GodotSceneView, {
      props: {
        scene,
        componentTree: true,
        resolveResource: () => resolved,
        resourceSource: {
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
    const spriteStyle = (): string =>
      wrapper.find('[data-godot-path="Fx"]').attributes("style") ?? "";
    // Size unknown: the box has no texture-derived width/height yet.
    expect(spriteStyle()).not.toContain("width: 40px");

    // The measure settles: the resolver now returns the intrinsic size and no
    // pending status; the notification must re-derive the sprite node.
    resolved = {
      path: "res://cloud.png",
      url: "/cloud.png",
      size: { width: 40, height: 20 },
    };
    for (const listener of listeners) {
      listener();
    }
    await nextTick();
    // Godot box: texture 40×20 centered on position (100, 50) → left 80, top 40.
    expect(spriteStyle()).toContain("width: 40px");
    expect(spriteStyle()).toContain("height: 20px");
    expect(spriteStyle()).toContain("left: 80px");
    expect(spriteStyle()).toContain("top: 40px");
    wrapper.unmount();
  });
});
