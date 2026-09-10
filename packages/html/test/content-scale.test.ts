import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  contentScaleStageStyle,
  type GodotContentScale,
  type GodotHtmlModel,
  mountHtmlScene,
  renderGodotSceneHtml,
  renderSceneToHtmlModel,
  resolveContentScale,
  rewritePxLengths,
} from "../src/index";

const BASE = { width: 1000, height: 500 };

// A small fixture whose geometry divides cleanly against the 1000x500 base, so the
// container-query rewrite produces exact, readable cq values.
function model(contentScale?: GodotContentScale): GodotHtmlModel {
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
theme_override_font_sizes/font_size = 24
text = "Hello"
`);
  const tree = resolveGodotSceneTree(scene, { viewport: BASE });
  return renderSceneToHtmlModel(tree, { contentScale });
}

function node(m: GodotHtmlModel, path: string) {
  const found = m.nodes.find((candidate) => candidate.path === path);
  if (!found) {
    throw new Error(`node not found: ${path}`);
  }
  return found;
}

describe("rewritePxLengths", () => {
  it("rewrites a positive px length to a min() of cq units", () => {
    expect(rewritePxLengths("10px", BASE)).toBe("min(1cqw, 2cqh)");
    expect(rewritePxLengths("24px", BASE)).toBe("min(2.4cqw, 4.8cqh)");
  });

  it("uses max() for negative lengths so the sign survives the uniform scale", () => {
    expect(rewritePxLengths("-8px", BASE)).toBe("max(-0.8cqw, -1.6cqh)");
  });

  it("collapses zero and rewrites px inside calc()", () => {
    expect(rewritePxLengths("0px", BASE)).toBe("0");
    expect(rewritePxLengths("calc(100% - 16px)", BASE)).toBe(
      "calc(100% - min(1.6cqw, 3.2cqh))",
    );
  });

  it("does not touch px embedded in identifiers / filenames", () => {
    expect(rewritePxLengths('url("icon20px.png")', BASE)).toBe(
      'url("icon20px.png")',
    );
  });
});

describe("contentScaleStageStyle", () => {
  it("fits the base box in cq units for the container technique", () => {
    expect(
      contentScaleStageStyle({
        aspect: "keep",
        technique: "container",
        base: BASE,
      }),
    ).toEqual({
      width: "min(100cqw, 200cqh)",
      height: "min(50cqw, 100cqh)",
    });
  });

  it("keeps px and adds a scale var for the transform technique", () => {
    expect(
      contentScaleStageStyle({
        aspect: "keep",
        technique: "transform",
        base: BASE,
      }),
    ).toEqual({
      width: "1000px",
      height: "500px",
      transform: "scale(var(--godot-scale, 1))",
    });
  });
});

describe("resolveContentScale", () => {
  it("defaults to the container technique and the viewport base", () => {
    expect(resolveContentScale({ aspect: "keep" }, BASE)).toEqual({
      aspect: "keep",
      technique: "container",
      base: BASE,
    });
  });

  it("returns null when absent or for unmodeled aspects", () => {
    expect(resolveContentScale(undefined, BASE)).toBeNull();
    expect(resolveContentScale({ aspect: "expand" }, BASE)).toBeNull();
  });
});

describe("renderSceneToHtmlModel content scale", () => {
  it("leaves geometry as px and reports no framing by default", () => {
    const m = model();
    expect(m.contentScale).toBeNull();
    expect(node(m, "Child").style.left).toBe("10px");
    expect(m.css).not.toContain("cqw");
  });

  it("rewrites the subtree to cq units for the container technique", () => {
    const m = model({ aspect: "keep" });
    expect(m.contentScale).toEqual({
      aspect: "keep",
      technique: "container",
      base: BASE,
    });
    const child = node(m, "Child");
    expect(child.style.left).toBe("min(1cqw, 2cqh)");
    expect(child.style.top).toBe("min(2cqw, 4cqh)");
    expect(child.style.width).toBe("min(10cqw, 20cqh)");
    expect(child.selfStyle["font-size"]).toBe("min(2.4cqw, 4.8cqh)");
    // The base CSS is rewritten too and now carries the frame rule.
    expect(m.css).toContain("cqw");
    expect(m.css).toContain(".godot-scene-frame");
  });

  it("keeps geometry as px for the transform technique", () => {
    const m = model({ aspect: "keep", technique: "transform" });
    expect(m.contentScale?.technique).toBe("transform");
    expect(node(m, "Child").style.left).toBe("10px");
    expect(m.css).not.toContain("cqw");
  });
});

describe("renderGodotSceneHtml content scale", () => {
  const options = { viewport: BASE };

  it("emits no frame wrapper by default", () => {
    const html = renderGodotSceneHtml(model(), options);
    // The `.godot-scene-frame` CSS rule always ships in the base CSS; what must be
    // absent by default is the wrapper element itself.
    expect(html).not.toContain('class="godot-scene-frame"');
  });

  it("wraps the stage in a frame for the container technique (no script)", () => {
    const html = renderGodotSceneHtml(model({ aspect: "keep" }), options);
    expect(html).toContain('class="godot-scene-frame"');
    expect(html).toContain('data-godot-stage="true"');
    expect(html).toContain("min(100cqw, 200cqh)");
    expect(html).not.toContain("<script>");
  });

  it("adds the resize script for the transform technique", () => {
    const html = renderGodotSceneHtml(
      model({ aspect: "keep", technique: "transform" }),
      options,
    );
    expect(html).toContain('class="godot-scene-frame"');
    expect(html).toContain("scale(var(--godot-scale, 1))");
    expect(html).toContain("--godot-scale");
    expect(html).toContain("<script>");
  });
});

describe("mountHtmlScene content scale", () => {
  it("wraps the stage in a frame element", () => {
    const container = document.createElement("div");
    mountHtmlScene(container, model({ aspect: "keep" }));
    const frame = container.firstElementChild as HTMLElement;
    expect(frame?.className).toBe("godot-scene-frame");
    const stage = frame.firstElementChild as HTMLElement;
    expect(stage?.dataset.godotStage).toBe("true");
    // (cq/min() values are exercised in the model + HTML-string tests; jsdom's
    // CSSOM rejects them, so the live element's computed style is unreliable.)
  });

  it("mounts the stage directly when content scale is off", () => {
    const container = document.createElement("div");
    mountHtmlScene(container, model());
    const stage = container.firstElementChild as HTMLElement;
    expect(stage?.dataset.godotStage).toBe("true");
  });
});
