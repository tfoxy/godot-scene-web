import type { GodotSceneState } from "@godot-scene-web/core";
import { renderSceneToHtmlModel } from "@godot-scene-web/html";
import { resolveGodotSceneTree as resolveSceneTreeFromGraph } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";

// Test shim: the rect engine now takes a SceneGraph (browser-native split moved
// structural indexing into deriveSceneGraph); keep the scene-taking call shape.
function resolveGodotSceneTree(scene, options) {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

import { describe, expect, it } from "vitest";
import { createGodotFetchProjectResolver } from "../src/fetch";

describe("createGodotFetchProjectResolver", () => {
  it("fetches visible external scenes once and reuses the cache", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="child"]
[node name="Root" type="Control"]
[node name="HostA" parent="." instance=ExtResource("child")]
[node name="HostB" parent="." instance=ExtResource("child")]
`,
      "/child.tscn": `
[gd_scene load_steps=1 format=3]
[node name="Child" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Ready"
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");

    const pending = resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    expect(pending.resourceStatuses).toHaveLength(2);
    expect(fetcher.calls.filter((url) => url === "/child.tscn")).toHaveLength(
      1,
    );

    await resolver.loadScene("res://child.tscn");
    const ready = resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    expect(ready.nodes.some((node) => node.path === "HostA/Label")).toBe(true);
    expect(ready.nodes.some((node) => node.path === "HostB/Label")).toBe(true);
    expect(fetcher.calls.filter((url) => url === "/child.tscn")).toHaveLength(
      1,
    );
  });

  it("does not fetch hidden external scenes", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="child"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("child")]
visible = false
`,
      "/child.tscn": `[gd_scene load_steps=1 format=3]`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");

    resolveGodotSceneTree(scene, resolver.sceneOptions(scene));

    expect(fetcher.calls).toEqual(["/host.tscn"]);
  });

  it("prefetches dependencies transitively when preloadDependencies is set", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=3 format=3]
[ext_resource type="PackedScene" path="res://child.tscn" id="child"]
[ext_resource type="Theme" path="res://theme.tres" id="theme"]
[node name="Root" type="Control"]
theme = ExtResource("theme")
[node name="Host" parent="." instance=ExtResource("child")]
visible = false
`,
      "/child.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://grandchild.tscn" id="grandchild"]
[node name="Child" type="Control"]
[node name="Inner" parent="." instance=ExtResource("grandchild")]
`,
      "/grandchild.tscn": `[gd_scene load_steps=1 format=3]
[node name="Grandchild" type="Control"]
`,
      "/theme.tres": `[gd_resource type="Theme" format=3]
`,
    });
    const resolver = createGodotFetchProjectResolver({
      fetch: fetcher.fetch,
      preloadDependencies: true,
    });
    await resolver.loadScene("res://host.tscn");
    // The fan-out is fire-and-forget, one level per parse — give it a few turns.
    for (let turn = 0; turn < 10; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Even the HIDDEN child prefetches (ext-resource based, visibility-agnostic),
    // and the child's own dependency follows level-parallel.
    expect([...fetcher.calls].sort()).toEqual([
      "/child.tscn",
      "/grandchild.tscn",
      "/host.tscn",
      "/theme.tres",
    ]);
  });

  it("tracks per-cache settle generations", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
`,
      "/theme.tres": `[gd_resource type="Theme" format=3]
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    expect(resolver.generations()).toEqual({
      scenes: 0,
      resources: 0,
      croppedAtlas: 0,
      imageSizes: 0,
    });

    await resolver.loadScene("res://host.tscn");
    expect(resolver.generations()).toEqual({
      scenes: 1,
      resources: 0,
      croppedAtlas: 0,
      imageSizes: 0,
    });

    await resolver.preload("res://theme.tres");
    expect(resolver.generations()).toEqual({
      scenes: 1,
      resources: 1,
      croppedAtlas: 0,
      imageSizes: 0,
    });

    // A failed settle counts too (the cache state changed).
    await resolver.loadScene("res://missing.tscn").catch(() => undefined);
    expect(resolver.generations()).toEqual({
      scenes: 2,
      resources: 1,
      croppedAtlas: 0,
      imageSizes: 0,
    });
  });

  it("crops an external-atlas sprite through the cropAtlasRegion seam", async () => {
    const fetcher = fakeFetch({
      "/sprite.tres": `
[gd_resource type="AtlasTexture" load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://atlas_0.png" id="1"]
[resource]
atlas = ExtResource("1")
region = Rect2(10, 20, 30, 40)
`,
    });
    const cropCalls: Array<{
      atlasUrl: string;
      region: { x: number; y: number; width: number; height: number };
    }> = [];
    const resolver = createGodotFetchProjectResolver({
      fetch: fetcher.fetch,
      // The atlas page resolves to an EXTERNAL url (`/atlas_0.png`, not a data: URL), so
      // the renderer can't embed/slice it — the host crops the region on a canvas.
      cropAtlasRegion: async (atlasUrl, region) => {
        cropCalls.push({ atlasUrl, region });
        return `data:cropped/${region.x},${region.y},${region.width},${region.height}`;
      },
    });
    await resolver.preload("res://sprite.tres");

    // First resolve kicks the async crop → pending, region kept, no sprite url yet.
    const pending = resolver.resolveResourcePath("res://sprite.tres");
    expect(pending?.url).toBeUndefined();
    expect(pending?.region).toEqual({ x: 10, y: 20, width: 30, height: 40 });

    // Once the crop settles, the sprite resolves to the standalone cropped image; the
    // host saw the external atlas-page url ONCE.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ready = resolver.resolveResourcePath("res://sprite.tres");
    expect(ready?.url).toBe("data:cropped/10,20,30,40");
    expect(ready?.region).toBeUndefined();
    expect(cropCalls).toHaveLength(1);
    expect(cropCalls[0].atlasUrl).toBe("/atlas_0.png");
    expect(cropCalls[0].region).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it("reports failed scene fetches", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://missing.tscn" id="missing"]
[node name="Root" type="Control"]
[node name="Host" parent="." instance=ExtResource("missing")]
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");

    resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    await resolver.loadScene("res://missing.tscn").catch(() => undefined);
    const failed = resolveGodotSceneTree(scene, resolver.sceneOptions(scene));

    expect(failed.resourceStatuses).toEqual([
      {
        kind: "external-scene",
        status: "error",
        nodePath: "Host",
        path: "res://missing.tscn",
        ref: { type: "ExtResource", id: "missing" },
        message: "Failed to fetch res://missing.tscn: HTTP 404",
      },
    ]);
  });

  it("returns direct image and font URLs without fetching bytes", () => {
    const fetcher = fakeFetch({});
    const resolver = createGodotFetchProjectResolver({
      fetch: fetcher.fetch,
      assetBaseUrl: "/assets",
    });

    // In a browser-like env (jsdom has `Image`) a host-unsized raster kicks the
    // one-shot intrinsic-size measure, surfaced as `status: "pending"` while in
    // flight; the URL is returned immediately either way and the document `fetch`
    // seam is never used for image bytes.
    expect(resolver.resolveResourcePath("res://icon.png")).toEqual({
      path: "res://icon.png",
      type: undefined,
      url: "/assets/icon.png",
      status: "pending",
    });
    expect(resolver.resolveResourcePath("res://fonts/title.woff2")).toEqual({
      path: "res://fonts/title.woff2",
      type: undefined,
      url: "/assets/fonts/title.woff2",
      fontUrl: "/assets/fonts/title.woff2",
      fontFamily: "title",
      fontStyle: "normal",
      fontWeight: "400",
    });
    expect(fetcher.calls).toEqual([]);
  });

  it("attaches a host-supplied intrinsic size to a direct image (for NinePatch clamping)", () => {
    // The resolver never fetches image bytes, so a NinePatchRect over an
    // oversized-margin texture can't clamp without the host telling it the size.
    const fetcher = fakeFetch({});
    const resolver = createGodotFetchProjectResolver({
      fetch: fetcher.fetch,
      assetBaseUrl: "/assets",
      resourceSize: (path) =>
        path === "res://images/event_button.png"
          ? { width: 284, height: 110 }
          : undefined,
    });

    expect(
      resolver.resolveResourcePath("res://images/event_button.png"),
    ).toEqual({
      path: "res://images/event_button.png",
      type: undefined,
      url: "/assets/images/event_button.png",
      size: { width: 284, height: 110 },
    });
    // No size hook entry → resolves without a size, as before.
    expect(
      resolver.resolveResourcePath("res://images/other.png").size,
    ).toBeUndefined();
    expect(fetcher.calls).toEqual([]);
  });

  it("measures a host-unsized raster's intrinsic size once (deferred Sprite2D box)", async () => {
    // The deferred-texture-size box path: a Sprite2D's rect is its TEXTURE size ×
    // scale (Godot Sprite2D::get_rect), so a raster the host can't size must still
    // get dimensions once the image decodes. jsdom images never load; stub one that
    // "loads" 32×48 asynchronously when `src` is set.
    const constructed: string[] = [];
    class InstantImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 32;
      naturalHeight = 48;
      set src(value: string) {
        constructed.push(value);
        queueMicrotask(() => this.onload?.());
      }
    }
    const OrigImage = globalThis.Image;
    globalThis.Image = InstantImage as unknown as typeof Image;
    try {
      const notifications: number[] = [];
      const resolver = createGodotFetchProjectResolver({
        assetBaseUrl: "/assets",
      });
      resolver.subscribe(() =>
        notifications.push(resolver.generations().imageSizes),
      );

      // First resolve: URL immediately usable, size unknown, measure in flight —
      // the `pending` status is what tells per-node consumer caches to re-derive
      // this node when the settle notification lands (croppedAtlas contract).
      const pending = resolver.resolveResourcePath("res://images/sprite.png");
      expect(pending?.url).toBe("/assets/images/sprite.png");
      expect(pending?.size).toBeUndefined();
      expect(pending?.status).toBe("pending");

      // Settle: one shared deferred emit; the resolved resource now carries the
      // measured size and no status. The image was constructed exactly once even
      // though the path resolved twice.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ready = resolver.resolveResourcePath("res://images/sprite.png");
      expect(ready?.size).toEqual({ width: 32, height: 48 });
      expect(ready?.status).toBeUndefined();
      expect(
        resolver.resolveResourcePath("res://images/sprite.png")?.size,
      ).toEqual({ width: 32, height: 48 });
      expect(constructed).toEqual(["/assets/images/sprite.png"]);
      // The settle notification goes through the shared DEFERRED emitter (one
      // setTimeout turn after the cache flips), carrying the bumped generation.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(notifications).toEqual([1]);
    } finally {
      globalThis.Image = OrigImage;
    }
  });

  it("never measures when the host supplies the size, and settles a failed measure to no size", async () => {
    const constructed: string[] = [];
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      set src(value: string) {
        constructed.push(value);
        queueMicrotask(() => this.onerror?.());
      }
    }
    const OrigImage = globalThis.Image;
    globalThis.Image = FailingImage as unknown as typeof Image;
    try {
      const resolver = createGodotFetchProjectResolver({
        assetBaseUrl: "/assets",
        resourceSize: (path) =>
          path === "res://sized.png" ? { width: 8, height: 8 } : undefined,
      });

      // Host metadata wins: no Image is ever constructed for it.
      expect(resolver.resolveResourcePath("res://sized.png")).toEqual({
        path: "res://sized.png",
        type: undefined,
        url: "/assets/sized.png",
        size: { width: 8, height: 8 },
      });
      expect(constructed).toEqual([]);

      // A failed measure settles to "no size" — the pre-measure behavior — and
      // does not retry (one-shot per path).
      expect(resolver.resolveResourcePath("res://broken.png")?.status).toBe(
        "pending",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const failed = resolver.resolveResourcePath("res://broken.png");
      expect(failed?.size).toBeUndefined();
      expect(failed?.status).toBeUndefined();
      expect(constructed).toEqual(["/assets/broken.png"]);

      // Non-raster paths (fonts, .tscn, .svg) never measure.
      resolver.resolveResourcePath("res://vector.svg");
      expect(constructed).toEqual(["/assets/broken.png"]);
    } finally {
      globalThis.Image = OrigImage;
    }
  });

  it("resolves a path-based ExtResource ref with no ext_resource table entry", () => {
    // The couch-coop-shaped input: a runtime producer reading Godot SceneState
    // emits a resource ref by `res://` path (it holds a loaded Resource, not a
    // scene-local `id`). The ext_resource table is empty, so resolution must
    // take the path-first branch rather than an id lookup.
    const resolver = createGodotFetchProjectResolver({
      assetBaseUrl: "/assets",
    });
    const scene: GodotSceneState = {
      kind: "scene",
      nodes: [],
      connections: [],
      extResources: [],
      subResources: [],
      editableInstances: [],
      diagnostics: [],
    };

    expect(
      resolver.resolveResource(scene, {
        type: "ExtResource",
        path: "res://images/icon.png",
      }),
    ).toEqual({
      path: "res://images/icon.png",
      type: undefined,
      url: "/assets/images/icon.png",
      // jsdom has `Image`, so the host-unsized raster is measuring (see above).
      status: "pending",
    });
  });

  it("resolves text resources for rendered nodes only, honoring visible overrides", async () => {
    // Effectively-hidden nodes are pruned to comment placeholders, so their
    // resources are never resolved or fetched — pruning reads the EFFECTIVE
    // (post-override) visibility from the derived graph, never the source-authored
    // `visible`. A catalog `visible: true` override on an authored-hidden node
    // therefore renders it and resolves its texture (the regression a prior
    // source-authored guard caused).
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=3 format=3]
[ext_resource type="Texture2D" path="res://visible.tres" id="visible"]
[ext_resource type="Texture2D" path="res://hidden.tres" id="hidden"]
[node name="Root" type="Control"]
[node name="Visible" type="TextureRect" parent="."]
texture = ExtResource("visible")
[node name="Hidden" type="TextureRect" parent="."]
visible = false
texture = ExtResource("hidden")
`,
      "/visible.tres": `
[gd_resource type="AtlasTexture" load_steps=1 format=3]
[resource]
region = Rect2(1, 2, 3, 4)
`,
      "/hidden.tres": `
[gd_resource type="AtlasTexture" load_steps=1 format=3]
[resource]
region = Rect2(5, 6, 7, 8)
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    const options = resolver.sceneOptions(scene);

    const pending = renderSceneToHtmlModel(
      resolveGodotSceneTree(scene, options),
      options,
    );

    // Only the visible node's resource resolves through the RENDERER; the
    // hidden node is a comment placeholder, so no resource status is recorded
    // for it. (The computed-mode rect cascade may still resolve a hidden
    // TextureRect's texture for minimum-size — layout is deliberately
    // render-only-pruned.)
    expect(pending.resourceStatuses).toEqual([
      {
        kind: "resource",
        status: "pending",
        nodePath: "Visible",
        path: "res://visible.tres",
        ref: { type: "ExtResource", id: "visible" },
        message: undefined,
      },
    ]);
    expect(fetcher.calls).toContain("/visible.tres");

    // An override that SHOWS the authored-hidden node renders it and resolves
    // its texture.
    const shown = renderSceneToHtmlModel(
      resolveGodotSceneTree(scene, {
        ...options,
        overrideNodeProps: (_node, path) =>
          path === "Hidden" ? { visible: true } : undefined,
      }),
      options,
    );
    expect(shown.resourceStatuses).toEqual([
      expect.objectContaining({ nodePath: "Visible" }),
      expect.objectContaining({
        nodePath: "Hidden",
        path: "res://hidden.tres",
      }),
    ]);
    expect(fetcher.calls).toContain("/hidden.tres");
  });

  it("resolves an instanced sub-scene root's own texture against the inner scene", async () => {
    // The defeat screen's common_banner instance: the sub-scene ROOT is itself a
    // TextureRect whose `texture` ext id is LOCAL to the sub-scene. The merged
    // instance node is stamped with the OUTER scene's source-scene-path, so the
    // outer scene has no such ext id — resolution must fall back to the inner
    // (instanced) scene the node mounts. (Regression: the banner rendered blank.)
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://banner.tscn" id="banner"]
[node name="Root" type="Control"]
[node name="Banner" parent="." instance=ExtResource("banner")]
`,
      "/banner.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://banner.tres" id="tex"]
[node name="Banner" type="TextureRect"]
texture = ExtResource("tex")
`,
      "/banner.tres": `
[gd_resource type="AtlasTexture" load_steps=1 format=3]
[resource]
region = Rect2(1, 2, 3, 4)
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    const options = resolver.sceneOptions(scene);

    // First pass kicks the child-scene fetch; load it, then render the mounted tree.
    renderSceneToHtmlModel(resolveGodotSceneTree(scene, options), options);
    await resolver.loadScene("res://banner.tscn");
    const ready = renderSceneToHtmlModel(
      resolveGodotSceneTree(scene, options),
      options,
    );

    // The instance-root Banner resolves its OWN texture against the inner scene
    // (recorded as pending while the AtlasTexture page settles — proves resolution
    // reached it; without the inner-scene fallback nothing would be recorded).
    expect(ready.resourceStatuses).toContainEqual(
      expect.objectContaining({
        kind: "resource",
        nodePath: "Banner",
        path: "res://banner.tres",
      }),
    );
  });

  it("resolves an OVERRIDDEN mounted child's own texture against the inner scene", async () => {
    // The defeat screen's Continue button: the instanced sub-scene's CHILD is itself a
    // TextureRect with its own `texture` (ext id LOCAL to the inner scene). The outer
    // scene OVERRIDES that child (e.g. to set a material), so the merged child takes the
    // OUTER source-scene-path — yet its texture ext id lives in the inner scene. An
    // overridden child has no `instance` ref, so resolution must use the inner-scene path
    // recorded at merge. (Regression: the button background rendered blank; the
    // instance-root-only fix did not cover overridden children.)
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://button.tscn" id="button"]
[node name="Root" type="Control"]
[node name="Button" parent="." instance=ExtResource("button")]
[node name="Image" parent="Button" index="0"]
modulate = Color(1, 1, 1, 1)
`,
      "/button.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="Texture2D" path="res://button.tres" id="tex"]
[node name="Button" type="Control"]
[node name="Image" type="TextureRect" parent="."]
texture = ExtResource("tex")
`,
      "/button.tres": `
[gd_resource type="AtlasTexture" load_steps=1 format=3]
[resource]
region = Rect2(1, 2, 3, 4)
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    const options = resolver.sceneOptions(scene);

    renderSceneToHtmlModel(resolveGodotSceneTree(scene, options), options);
    await resolver.loadScene("res://button.tscn");
    const ready = renderSceneToHtmlModel(
      resolveGodotSceneTree(scene, options),
      options,
    );

    // The overridden Image child resolves its OWN texture against the inner scene.
    expect(
      ready.resourceStatuses.some((s) => s.path === "res://button.tres"),
    ).toBe(true);
  });

  it("mounts an OVERRIDDEN mounted child that is itself an instance, via the inner scene", async () => {
    // The deck-view scrollbar: scene A (card_grid) internally INSTANCES B (scrollbar.tscn,
    // with children) as a child; the host instances A AND property-overrides that child (to
    // reposition it) with NO `instance=`. The merged child takes the OUTER (host) source
    // scene, but its own `instance=ExtResource(...)` id is LOCAL to A — so resolving it
    // against the host fails and the child collapses to a childless `Node`. Resolution must
    // fall back to the recorded inner scene (A) so the child still mounts B + B's children.
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://grid.tscn" id="grid"]
[node name="Root" type="Control"]
[node name="Grid" parent="." instance=ExtResource("grid")]
[node name="Bar" parent="Grid" index="0"]
offset_left = -100.0
`,
      "/grid.tscn": `
[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://bar.tscn" id="bar"]
[node name="GridScene" type="Control"]
[node name="Bar" parent="." instance=ExtResource("bar")]
`,
      "/bar.tscn": `
[gd_scene load_steps=1 format=3]
[node name="BarScene" type="Range"]
[node name="Handle" type="TextureRect" parent="."]
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    const options = resolver.sceneOptions(scene);
    // Settle the nested instance chain (host → grid → bar).
    resolveGodotSceneTree(scene, options);
    await resolver.loadScene("res://grid.tscn");
    await resolver.loadScene("res://bar.tscn");
    const ready = resolveGodotSceneTree(scene, options);

    // The overridden Bar mounts bar.tscn (type from its root) AND its Handle child appears.
    expect(ready.nodes.find((node) => node.path === "Grid/Bar")?.type).toBe(
      "Range",
    );
    expect(ready.nodes.some((node) => node.path === "Grid/Bar/Handle")).toBe(
      true,
    );
  });

  it("accepts a pre-parsed GodotSceneState served as JSON (runtime producer)", async () => {
    // A runtime producer (e.g. a live game mod walking PackedScene.GetState()) serves the scene
    // as JSON instead of .tscn text, with a path-based ExtResource instance (no ext-resource table).
    const host: GodotSceneState = {
      kind: "scene",
      nodes: [
        { index: 0, name: "Root", type: "Control", groups: [], properties: [] },
        {
          index: 1,
          name: "Host",
          parent: ".",
          groups: [],
          properties: [],
          instance: { type: "ExtResource", path: "res://child.tscn" },
        },
      ],
      connections: [],
      extResources: [],
      subResources: [],
      editableInstances: [],
      diagnostics: [],
    };
    const fetcher = fakeFetch({
      "/host.tscn": JSON.stringify(host),
      "/child.tscn": `
[gd_scene load_steps=1 format=3]
[node name="Child" type="Control"]
[node name="Label" type="Label" parent="."]
text = "Ready"
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });

    const scene = await resolver.loadScene("res://host.tscn");
    expect(scene.kind).toBe("scene");
    expect(scene.nodes.map((node) => node.name)).toContain("Host");

    // Path-first resolution mounts the child from the inline `path` ref with no table entry.
    resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    await resolver.loadScene("res://child.tscn");
    const ready = resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    expect(ready.nodes.some((node) => node.path === "Host/Label")).toBe(true);
  });

  it("still parses .tscn text bodies (text producer)", async () => {
    const fetcher = fakeFetch({
      "/host.tscn": `
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
`,
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    expect(scene.kind).toBe("scene");
    expect(scene.nodes[0]?.name).toBe("Root");
  });

  it("accepts a pre-parsed GodotResource served as JSON (font producer)", async () => {
    // A runtime producer (live game mod loading a FontVariation Resource) serves the resource
    // as JSON instead of .tres text, with base_font as a path-based ExtResource pointing at the
    // actual .ttf. The resolver resolves it to a fontUrl + family/weight exactly as for text.
    const fontResource = {
      kind: "resource",
      header: { section: "gd_resource", attributes: { type: "FontVariation" } },
      extResources: [],
      subResources: [],
      properties: {
        base_font: { type: "ExtResource", path: "res://fonts/kreon_bold.ttf" },
        spacing_glyph: 2,
      },
      diagnostics: [],
    };
    const fetcher = fakeFetch({
      "/themes/kreon_bold_shared.tres": JSON.stringify(fontResource),
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });

    await resolver.resources.load("res://themes/kreon_bold_shared.tres");
    const resolved = resolver.resolveResourcePath(
      "res://themes/kreon_bold_shared.tres",
    );

    expect(resolved?.type).toBe("FontVariation");
    expect(resolved?.fontUrl).toBe("/fonts/kreon_bold.ttf");
    expect(resolved?.fontFamily).toBe("kreon_bold");
    expect(resolved?.fontWeight).toBe("700");
  });

  it("resolves a scene-local sub-resource (res://x.tscn::Sub) as a document", async () => {
    // A scene-local FontVariation is referenced by its `::` sub-resource path; it must be
    // fetched as a resource DOCUMENT (not treated as an opaque asset url) so its base_font
    // chain resolves to a real fontUrl. base_font here points at an external .ttf.
    const sceneLocalFont = {
      kind: "resource",
      header: { section: "gd_resource", attributes: { type: "FontVariation" } },
      extResources: [],
      subResources: [],
      properties: {
        base_font: {
          type: "ExtResource",
          path: "res://fonts/kreon_regular.ttf",
        },
      },
      diagnostics: [],
    };
    const subPath =
      "res://scenes/screens/character_select_screen.tscn::FontVariation_3rwao";
    const fetcher = fakeFetch({
      "/scenes/screens/character_select_screen.tscn::FontVariation_3rwao":
        JSON.stringify(sceneLocalFont),
    });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });

    await resolver.resources.load(subPath);
    const resolved = resolver.resolveResourcePath(subPath);

    expect(resolved?.type).toBe("FontVariation");
    expect(resolved?.fontUrl).toBe("/fonts/kreon_regular.ttf");
    expect(resolved?.fontFamily).toBe("kreon_regular");
    expect(fetcher.calls).toContain(
      "/scenes/screens/character_select_screen.tscn::FontVariation_3rwao",
    );
  });

  it("normalizes from_native tagged scalars when valueEncoding is set", async () => {
    // A from_native producer pipes `JSON.from_native`, which tags scalars as
    // strings (`f:120`, `i:10`, …). With `valueEncoding:"from_native"` gsw decodes
    // them on ingest, so they drive layout exactly like raw numbers.
    const host = {
      kind: "scene",
      valueEncoding: "from_native",
      nodes: [
        {
          index: 0,
          name: "Root",
          type: "Control",
          groups: [],
          properties: [
            { name: "offset_right", value: "f:120" },
            { name: "offset_bottom", value: "f:80" },
          ],
        },
        {
          index: 1,
          name: "Panel",
          type: "ColorRect",
          parent: ".",
          groups: [],
          properties: [
            { name: "offset_left", value: "i:10" },
            { name: "offset_top", value: "i:20" },
            { name: "offset_right", value: "i:60" },
            { name: "offset_bottom", value: "i:70" },
          ],
        },
      ],
      connections: [],
      extResources: [],
      subResources: [],
      editableInstances: [],
      diagnostics: [],
    };
    const fetcher = fakeFetch({ "/host.tscn": JSON.stringify(host) });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");

    const panel = scene.nodes.find((node) => node.name === "Panel");
    expect(panel?.properties.find((p) => p.name === "offset_left")?.value).toBe(
      10,
    );
    const tree = resolveGodotSceneTree(scene, resolver.sceneOptions(scene));
    expect(tree.nodes.find((node) => node.path === "Panel")?.rect).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 50,
    });
  });

  it("keeps tagged-looking strings verbatim without the valueEncoding flag", async () => {
    // A raw producer (or any scene with a literal value that happens to start with
    // a tag prefix) must NOT be decoded — the gate keeps `"f:stop"` untouched.
    const host = {
      kind: "scene",
      nodes: [
        {
          index: 0,
          name: "Root",
          type: "Label",
          groups: [],
          properties: [{ name: "text", value: "f:stop" }],
        },
      ],
      connections: [],
      extResources: [],
      subResources: [],
      editableInstances: [],
      diagnostics: [],
    };
    const fetcher = fakeFetch({ "/host.tscn": JSON.stringify(host) });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");
    expect(
      scene.nodes[0]?.properties.find((p) => p.name === "text")?.value,
    ).toBe("f:stop");
  });

  it("resolves an inline scene-local SubResource supplied by a JSON producer", async () => {
    // A live producer's scene-local sub-resources have no `res://` path; it can put
    // them inline in `subResources` as `{id, type, properties}` and reference them as
    // `{type:"SubResource", id}`. They resolve through the same path as `.tres` ones.
    const host: GodotSceneState = {
      kind: "scene",
      nodes: [
        {
          index: 0,
          name: "Root",
          type: "ColorRect",
          groups: [],
          properties: [
            { name: "material", value: { type: "SubResource", id: "mat_1" } },
          ],
        },
      ],
      connections: [],
      extResources: [],
      subResources: [
        {
          id: "mat_1",
          type: "CanvasItemMaterial",
          attributes: {},
          properties: { blend_mode: 1 },
        },
      ],
      editableInstances: [],
      diagnostics: [],
    };
    const fetcher = fakeFetch({ "/host.tscn": JSON.stringify(host) });
    const resolver = createGodotFetchProjectResolver({ fetch: fetcher.fetch });
    const scene = await resolver.loadScene("res://host.tscn");

    const resolved = resolver.resolveResource(scene, {
      type: "SubResource",
      id: "mat_1",
    });
    expect(resolved?.type).toBe("CanvasItemMaterial");
    expect(resolved?.document?.properties).toEqual({ blend_mode: 1 });
  });
});

function fakeFetch(responses: Record<string, string>): {
  calls: string[];
  fetch: (input: string) => Promise<Pick<Response, "ok" | "status" | "text">>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input) => {
      calls.push(input);
      const text = responses[input];
      return {
        ok: text !== undefined,
        status: text === undefined ? 404 : 200,
        text: async () => text ?? "",
      };
    },
  };
}
