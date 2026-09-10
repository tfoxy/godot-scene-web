import {
  asBoolean,
  asNumber,
  asRect2,
  asResourceRef,
  asString,
  asVector2,
  decodeFromNativeValue,
  type GodotExtResource,
  type GodotNode,
  type GodotResource,
  type GodotResourceRefValue,
  type GodotSceneState,
  type GodotVariant,
} from "@godot-scene-web/core";
import {
  MOUNTED_INNER_SCENE_PATH_ATTRIBUTE,
  SOURCE_SCENE_PATH_ATTRIBUTE,
  tagSceneNodes,
} from "@godot-scene-web/scene-graph";
import {
  parseGodotResource,
  parseGodotTextScene,
} from "@godot-scene-web/tscn-parser";
import type { GodotProjectResolvedResource } from "./shared";
import { queryTheme } from "./theme-query";

export type { GodotProjectResolvedResource } from "./shared";

// Set by scene-graph's `mergeMountedNode` on a merged mount (instance root OR
// overridden child): the INNER (instanced) scene a node was authored in, when the
// merged node's `source_scene_path` took the OUTER placeholder scene. Lets the
// resolver fall back to the inner scene for the node's own base-authored ext refs.

type AtlasRect = { x: number; y: number; width: number; height: number };

// The `croppedAtlas` cache is keyed by (atlas page url + region + margin) so each
// distinct sprite crop loads once. Encoded as a single string (the cache key type) with
// a NUL separator that can't appear in a url or number.
function encodeCroppedAtlasKey(
  atlasUrl: string,
  region: AtlasRect,
  margin: AtlasRect,
): string {
  const rect = (r: AtlasRect): string => `${r.x},${r.y},${r.width},${r.height}`;
  return `${atlasUrl}\0${rect(region)}\0${rect(margin)}`;
}

function decodeCroppedAtlasKey(key: string): {
  atlasUrl: string;
  region: AtlasRect;
  margin: AtlasRect;
} {
  const [atlasUrl, regionPart, marginPart] = key.split("\0");
  const rect = (part: string | undefined): AtlasRect => {
    const [x, y, width, height] = (part ?? "").split(",").map(Number);
    return { x: x || 0, y: y || 0, width: width || 0, height: height || 0 };
  };
  return {
    atlasUrl: atlasUrl ?? "",
    region: rect(regionPart),
    margin: rect(marginPart),
  };
}

export type GodotFetchCacheSnapshot<T> =
  | { status: "ready"; path: string; value: T }
  | { status: "pending"; path: string; promise: Promise<T> }
  | { status: "error"; path: string; message: string; error: unknown };

export interface GodotFetchDocumentCache<T> {
  peek: (resourcePath: string) => GodotFetchCacheSnapshot<T> | undefined;
  load: (resourcePath: string) => Promise<T>;
  preload: (resourcePath: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export interface GodotFetchProjectResolverOptions {
  assetBaseUrl?: string | ((resourcePath: string) => string);
  fetch?: (input: string) => Promise<Pick<Response, "ok" | "status" | "text">>;
  /**
   * Transitive prefetch: the moment a scene/resource document parses, kick loads
   * for every `.tscn`/`.tres`/`.res` it references, so a tree's dependencies fan
   * out level-parallel instead of being discovered one consumer render at a time.
   * Off by default — lazy consumers rely on hidden external scenes NOT fetching.
   */
  preloadDependencies?: boolean;
  /**
   * Intrinsic pixel size for a direct image resource (a `Texture2D` ExtResource
   * pointing at a `.png`/`.webp`/…), from host asset metadata (captured/extracted).
   * Used so `NinePatchRect` 9-slice margins that exceed the texture (event_button.png:
   * 284px wide, 192px L/R margins) clamp to the source the way Godot does, and so a
   * `Sprite2D` box can size to its texture. Return `undefined` when unknown — in a
   * browser the resolver then falls back to measuring the decoded image itself (see
   * the `imageSizes` cache); outside a browser the texture resolves without a size,
   * as before.
   */
  resourceSize?: (
    resourcePath: string,
  ) => { width: number; height: number } | undefined;
  /**
   * Crop an AtlasTexture sprite (a region of a larger atlas page) into a standalone
   * image, returning a usable URL (e.g. a `blob:`/`data:` URL the host produced with a
   * canvas). Used ONLY when the atlas page resolves to an EXTERNAL url (not a `data:`
   * URL): the renderer's built-in SVG crop embeds the atlas via `<image href>`, which
   * browsers block for external refs inside CSS-image SVGs, and CSS `border-image`
   * cannot 9-slice a sub-region of an atlas — so a NinePatch atlas sprite over an
   * external atlas can't be cropped in pure CSS. The host fetches each atlas page ONCE
   * (cached) and crops regions on a canvas, so the page is reused across its sprites.
   * Async: the result settles through the resolver's cache like any other resource, so
   * the consumer re-renders when the crop is ready. Absent ⇒ unchanged behavior (the
   * sprite keeps its embedded-SVG crop / CSS-offset fallback), so goldens and hosts that
   * pre-crop server-side are byte-identical.
   */
  cropAtlasRegion?: (
    atlasUrl: string,
    region: { x: number; y: number; width: number; height: number },
    margin: { x: number; y: number; width: number; height: number },
  ) => Promise<string>;
}

export interface GodotFetchExternalSceneResolveContext {
  ref: GodotResourceRefValue;
  node: GodotNode;
  nodePath: string;
  props: Record<string, GodotVariant>;
}

export interface GodotFetchProjectSceneOptions {
  resolveExternalScene: (
    context: GodotFetchExternalSceneResolveContext,
  ) =>
    | GodotSceneState
    | { status: "ready"; scene: GodotSceneState; path?: string }
    | { status: "pending"; path?: string; message?: string }
    | { status: "error"; path?: string; message: string }
    | undefined;
  resolveResource: (
    ref: GodotResourceRefValue,
    node: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  resolveResourcePath: (
    path: string,
    node: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  /**
   * Resolve a theme item (e.g. a font size) for a node from its assigned `theme`
   * resource, following Godot's type-variation -> type -> default cascade. Optional:
   * absent ⇒ the renderer keeps its built-in fallbacks (the prior behavior). The HTML
   * renderer calls this for `font_size`/`normal_font_size`/… when a node carries no
   * inline `theme_override_font_sizes/*`.
   */
  resolveTheme?: (node: GodotNode, name: string) => GodotVariant | undefined;
}

export interface GodotFetchProjectResolver {
  resourcePathToUrl: (resourcePath: string) => string;
  scenes: GodotFetchDocumentCache<GodotSceneState>;
  resources: GodotFetchDocumentCache<GodotResource>;
  peekScene: (
    resourcePath: string,
  ) => GodotFetchCacheSnapshot<GodotSceneState> | undefined;
  loadScene: (resourcePath: string) => Promise<GodotSceneState>;
  preload: (resourcePath: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  extResource: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
  ) => GodotExtResource | undefined;
  resolveResource: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    node?: GodotNode,
  ) => GodotProjectResolvedResource | undefined;
  resolveResourcePath: (
    resourcePath: string,
    type?: string,
  ) => GodotProjectResolvedResource | undefined;
  resolveExternalScene: (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    node?: GodotNode,
  ) =>
    | GodotSceneState
    | { status: "ready"; scene: GodotSceneState; path?: string }
    | { status: "pending"; path?: string; message?: string }
    | { status: "error"; path?: string; message: string }
    | undefined;
  sceneOptions: (scene: GodotSceneState) => GodotFetchProjectSceneOptions;
  /**
   * Monotonic settle counters, one per document cache. A consumer can use them
   * for cache-state-keyed memoization: scene-graph derivation depends on scene
   * documents but never on `.tres` resource content, so a derive memo stays
   * valid while `scenes` is unchanged even as `resources` advances.
   */
  generations: () => {
    scenes: number;
    resources: number;
    croppedAtlas: number;
    imageSizes: number;
  };
}

export function createGodotFetchProjectResolver(
  options: GodotFetchProjectResolverOptions = {},
): GodotFetchProjectResolver {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  // ONE deferred emit per settle burst, shared across the scene + resource caches —
  // every emit makes subscribers re-derive expensive state, so a burst of N settles
  // across both caches must cost one notification, not N (and never a synchronous
  // one: an emit inside a consumer's walk would re-enter it). setTimeout rather than
  // queueMicrotask so settles landing in separate macrotasks still merge.
  let emitScheduled = false;
  const scheduledCacheFlushes = new Set<() => void>();
  const scheduleEmit = (flushCacheListeners: () => void): void => {
    scheduledCacheFlushes.add(flushCacheListeners);
    if (emitScheduled) {
      return;
    }
    emitScheduled = true;
    setTimeout(() => {
      emitScheduled = false;
      const flushes = [...scheduledCacheFlushes];
      scheduledCacheFlushes.clear();
      notify();
      for (const flush of flushes) {
        flush();
      }
    }, 0);
  };
  const fetchText = async (resourcePath: string): Promise<string> => {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new Error("No fetch implementation is available.");
    }
    const response = await fetchImpl(resourcePathToUrl(resourcePath));
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${resourcePath}: HTTP ${response.status}`,
      );
    }
    return response.text();
  };
  // Memoized by path: `resolvePathResource` resolves every node's resource ref each render and
  // calls this once per ref, with a small recurring set of paths. `assetBaseUrl` is fixed for
  // the client's lifetime, so the URL is stable per path.
  const urlCache = new Map<string, string>();
  const resourcePathToUrl = (resourcePath: string): string => {
    let url = urlCache.get(resourcePath);
    if (url === undefined) {
      assertResourcePath(resourcePath);
      if (typeof options.assetBaseUrl === "function") {
        url = options.assetBaseUrl(resourcePath);
      } else {
        const relativePath = resourcePath.replace(/^res:\/\//, "");
        const base = options.assetBaseUrl ?? "/";
        url = `${base.replace(/\/?$/, "/")}${relativePath}`;
      }
      urlCache.set(resourcePath, url);
    }
    return url;
  };
  let scenesGeneration = 0;
  let resourcesGeneration = 0;
  const scenes = createDocumentCache(
    async (resourcePath) => {
      const scene = parseSceneBody(await fetchText(resourcePath), resourcePath);
      tagSceneNodes(scene, resourcePath);
      preloadDependenciesOf(scene.extResources);
      return scene;
    },
    scheduleEmit,
    () => {
      scenesGeneration += 1;
    },
  );
  const resources = createDocumentCache(
    (resourcePath) =>
      fetchText(resourcePath).then((text) => {
        const document = parseResourceBody(text, resourcePath);
        preloadDependenciesOf(document.extResources);
        return document;
      }),
    scheduleEmit,
    () => {
      resourcesGeneration += 1;
    },
  );
  // Host-cropped AtlasTexture sprites (the `cropAtlasRegion` seam). Each (atlas page,
  // region, margin) crops once; the result settles through the SAME shared emit as the
  // scene/resource caches, so a consumer that rendered a pending sprite re-renders when
  // its crop is ready. Only used for EXTERNAL atlas pages (see resolvePathResource).
  let croppedAtlasGeneration = 0;
  const croppedAtlas = createDocumentCache<string>(
    (key) => {
      const crop = options.cropAtlasRegion;
      if (!crop) {
        return Promise.reject(
          new Error("cropAtlasRegion seam is not configured"),
        );
      }
      const { atlasUrl, region, margin } = decodeCroppedAtlasKey(key);
      return crop(atlasUrl, region, margin);
    },
    scheduleEmit,
    () => {
      croppedAtlasGeneration += 1;
    },
  );
  // Measured intrinsic raster sizes — the browser-only fallback when the host
  // supplies no `resourceSize` for a direct image. A Sprite2D has no anchors or
  // offsets: Godot derives its rect from the TEXTURE — `Sprite2D::get_rect()` is
  // texture size × the node's scale, CENTERED on `position` unless
  // `centered = false`/`offset` shifts it (scene/2d/sprite_2d.cpp) — so a resolver
  // that never learns raster dimensions collapses such sprites to a 0×0 box, and
  // anything sized by that box (e.g. a SCREEN_TEXTURE shader canvas on the Neow
  // event's `water effect` sprites) never shows. Measuring costs no extra bytes:
  // the SAME url is already painted by the page's CSS, so the browser shares one
  // fetch/decode — this only reads the intrinsic size. Each path measures ONCE;
  // the result settles through the shared deferred emit like any other cache, and
  // the resolved resource carries `status: "pending"` while the measure is in
  // flight so per-node consumer caches re-derive on settle (the same contract as
  // `croppedAtlas` above). Errors settle to "no size" — the prior behavior.
  let imageSizesGeneration = 0;
  const imageSizes = createDocumentCache<{ width: number; height: number }>(
    (resourcePath) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        // No `crossOrigin`: a cross-origin texture served without CORS headers
        // still reports its intrinsic size (pixels are never read) — the same
        // choice as tint-bake's nine-patch size loader.
        image.onload = () => {
          if (image.naturalWidth && image.naturalHeight) {
            resolve({
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          } else {
            reject(new Error(`Image has no intrinsic size: ${resourcePath}`));
          }
        };
        image.onerror = () =>
          reject(new Error(`Image failed to load: ${resourcePath}`));
        image.src = resourcePathToUrl(resourcePath);
      }),
    scheduleEmit,
    () => {
      imageSizesGeneration += 1;
    },
  );
  const measuredImageSize = (
    resourcePath: string,
  ):
    | { size: { width: number; height: number }; status?: undefined }
    | { size?: undefined; status: "pending" }
    | undefined => {
    if (typeof Image === "undefined" || !isRasterImagePath(resourcePath)) {
      return undefined;
    }
    let snapshot = imageSizes.peek(resourcePath);
    if (!snapshot) {
      void imageSizes.load(resourcePath).catch(() => undefined);
      snapshot = imageSizes.peek(resourcePath);
    }
    if (snapshot?.status === "ready") {
      return { size: snapshot.value };
    }
    return snapshot?.status === "pending" ? { status: "pending" } : undefined;
  };

  // Hoisted (function declaration) so the cache loaders above can call it: it
  // needs both caches, the caches need their loaders first.
  function preloadDependenciesOf(extResources: GodotExtResource[]): void {
    if (!options.preloadDependencies) {
      return;
    }
    for (const resource of extResources) {
      const path = resource.path;
      if (!path) {
        continue;
      }
      if (path.endsWith(".tscn")) {
        void scenes.preload(path);
      } else if (path.endsWith(".tres") || path.endsWith(".res")) {
        void resources.preload(path);
      }
    }
  }

  // Public id-based accessor: returns the ext-resource table entry for a
  // scene-local `id` ref (path-only runtime refs have no table entry).
  const extResource = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
  ): GodotExtResource | undefined =>
    ref.type === "ExtResource" && ref.id !== undefined
      ? scene.extResources.find((resource) => resource.id === ref.id)
      : undefined;

  // Resolve an ExtResource ref to a res:// path (+ table type when known).
  // Path-first, id-fallback: a runtime producer supplies `ref.path` directly; a
  // text producer supplies a scene-local `id` we look up in the ext-resource
  // table. A path-only ref has no table entry, so its `type` is unknown.
  const extTarget = (
    extResources: GodotExtResource[],
    ref: GodotResourceRefValue,
  ): { path: string; type?: string } | undefined => {
    if (ref.type !== "ExtResource") {
      return undefined;
    }
    if (ref.path) {
      return { path: ref.path };
    }
    const resource = extResources.find((candidate) => candidate.id === ref.id);
    return resource?.path
      ? { path: resource.path, type: resource.type }
      : undefined;
  };

  const resolveExternalScene = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    _node?: GodotNode,
  ): ReturnType<GodotFetchProjectResolver["resolveExternalScene"]> => {
    const target = extTarget(scene.extResources, ref);
    if (!target?.path.endsWith(".tscn")) {
      return undefined;
    }
    const snapshot = scenes.peek(target.path);
    if (snapshot?.status === "ready") {
      return { status: "ready", scene: snapshot.value, path: target.path };
    }
    if (snapshot?.status === "error") {
      return {
        status: "error",
        path: target.path,
        message: snapshot.message,
      };
    }
    if (!snapshot) {
      void scenes.load(target.path).catch(() => undefined);
    }
    return { status: "pending", path: target.path };
  };

  const resolveResource = (
    scene: GodotSceneState,
    ref: GodotResourceRefValue,
    _node?: GodotNode,
  ): GodotProjectResolvedResource | undefined => {
    if (ref.type === "SubResource") {
      const resource = scene.subResources.find(
        (candidate) => candidate.id === ref.id,
      );
      return resource
        ? { type: resource.type, document: subResourceDocument(resource) }
        : undefined;
    }
    const target = extTarget(scene.extResources, ref);
    return target ? resolvePathResource(target.path, target.type) : undefined;
  };

  const resolveDocumentResource = (
    document: GodotResource,
    ref: GodotResourceRefValue,
    seen: Set<string>,
  ): GodotProjectResolvedResource | undefined => {
    if (ref.type === "SubResource") {
      const resource = document.subResources.find(
        (candidate) => candidate.id === ref.id,
      );
      return resource
        ? { type: resource.type, document: subResourceDocument(resource) }
        : undefined;
    }
    const target = extTarget(document.extResources, ref);
    return target
      ? resolvePathResource(target.path, target.type, seen)
      : undefined;
  };

  const resolvePathResource = (
    resourcePath: string,
    type?: string,
    seen: Set<string> = new Set(),
  ): GodotProjectResolvedResource | undefined => {
    if (seen.has(resourcePath)) {
      return { type, path: resourcePath, url: resourcePathToUrl(resourcePath) };
    }
    const nextSeen = new Set(seen).add(resourcePath);
    if (resourcePath.endsWith(".tscn")) {
      return { type, path: resourcePath, url: resourcePathToUrl(resourcePath) };
    }
    // `.tres`/`.res` files and scene/resource-local sub-resources (`res://x.tscn::SubId`,
    // emitted by a runtime producer that holds the loaded sub-resource) are fetched as
    // resource DOCUMENTS so e.g. a scene-local FontVariation resolves its base_font -> .ttf.
    if (
      resourcePath.endsWith(".tres") ||
      resourcePath.endsWith(".res") ||
      resourcePath.includes("::")
    ) {
      const snapshot = resources.peek(resourcePath);
      if (snapshot?.status === "error") {
        return {
          type,
          path: resourcePath,
          url: resourcePathToUrl(resourcePath),
          status: "error",
          message: snapshot.message,
        };
      }
      if (snapshot?.status !== "ready") {
        if (!snapshot) {
          void resources.load(resourcePath).catch(() => undefined);
        }
        return {
          type,
          path: resourcePath,
          url: resourcePathToUrl(resourcePath),
          status: "pending",
        };
      }
      const document = snapshot.value;
      const resourceType = asString(document.header?.attributes.type) ?? type;
      const baseResource = {
        type: resourceType,
        path: resourcePath,
        url: resourcePathToUrl(resourcePath),
        document,
      };
      if (resourceType === "AtlasTexture") {
        const region = asRect2(document.properties.region);
        const margin = asRect2(document.properties.margin) ?? {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
        const atlasRef = asResourceRef(document.properties.atlas);
        let atlas = atlasRef
          ? resolveDocumentResource(document, atlasRef, nextSeen)
          : undefined;
        // The atlas PAGE size lets a downstream consumer scale the cropped region into a box that
        // differs from the sprite's native size (CSS background scaling). A host that fetches only
        // URLs (no `resourceSize`) can't size the page image, so the document carries `atlas_size`
        // (a runtime producer emits it). Attach it to the resolved atlas when the host didn't supply
        // a size, so `imageResource`/`regionBackgroundStyle` scale instead of falling back to native px.
        const docAtlasSize = asVector2(document.properties.atlas_size);
        if (atlas && !atlas.size && docAtlasSize) {
          atlas = {
            ...atlas,
            size: { width: docAtlasSize.x, height: docAtlasSize.y },
          };
        }
        // External atlas page + host crop seam → crop the region into a standalone
        // sprite url (a `blob:`/`data:` the host's canvas produced). Needed because an
        // external atlas can't be referenced from a CSS-image SVG and CSS can't 9-slice
        // a sub-region. The crop settles through `croppedAtlas`, so a pending sprite
        // re-renders when ready. `data:` atlases (embedded) keep the built-in SVG crop.
        if (
          region &&
          atlas?.url &&
          !atlas.url.startsWith("data:") &&
          options.cropAtlasRegion
        ) {
          const key = encodeCroppedAtlasKey(atlas.url, region, margin);
          const snapshot = croppedAtlas.peek(key);
          if (snapshot?.status === "ready") {
            return {
              ...baseResource,
              url: snapshot.value,
              atlas,
              size: { width: region.width, height: region.height },
            };
          }
          if (snapshot?.status !== "error") {
            if (!snapshot) {
              void croppedAtlas.load(key).catch(() => undefined);
            }
            return {
              ...baseResource,
              url: undefined,
              atlas,
              region,
              size: { width: region.width, height: region.height },
              status: "pending",
            };
          }
          // Crop errored: fall through to the standard region/atlas resolution so the
          // sprite still paints its CSS-offset / embedded fallback.
        }
        return {
          ...baseResource,
          url: undefined,
          atlas,
          region,
          size: region
            ? { width: region.width, height: region.height }
            : atlas?.size,
        };
      }
      if (resourceType === "FontVariation") {
        const baseRef = asResourceRef(document.properties.base_font);
        const base = baseRef
          ? resolveDocumentResource(document, baseRef, nextSeen)
          : undefined;
        const variationWeight = fontWeightFromVariation(document);
        const glyphSpacing = asNumber(document.properties.spacing_glyph);
        const fontMsdf = asBoolean(
          document.properties.multichannel_signed_distance_field,
        );
        return {
          ...base,
          ...baseResource,
          status: base?.status,
          message: base?.message,
          fontFamily:
            base?.fontFamily ?? fontMetadataFromPath(resourcePath).fontFamily,
          fontUrl: base?.fontUrl,
          fontStyle: base?.fontStyle,
          fontWeight: variationWeight ?? base?.fontWeight,
          glyphSpacing: glyphSpacing ?? base?.glyphSpacing,
          fontMsdf: fontMsdf ?? base?.fontMsdf,
        };
      }
      if (resourceType === "FontFile") {
        const fontPath = asString(document.properties.font_path);
        const metadata = fontPath
          ? fontMetadataFromPath(fontPath)
          : fontMetadataFromPath(resourcePath);
        return {
          ...baseResource,
          fontUrl:
            fontPath && isFontPath(fontPath)
              ? resourcePathToUrl(fontPath)
              : undefined,
          fontMsdf: asBoolean(
            document.properties.multichannel_signed_distance_field,
          ),
          ...metadata,
        };
      }
      if (resourceType === "ShaderMaterial") {
        const shaderRef = asResourceRef(document.properties.shader);
        return {
          ...baseResource,
          shader: shaderRef
            ? resolveDocumentResource(document, shaderRef, nextSeen)
            : undefined,
        };
      }
      const fontPath = asString(document.properties.font_path);
      return {
        type: resourceType,
        path: resourcePath,
        url: resourcePathToUrl(resourcePath),
        fontUrl:
          fontPath && isFontPath(fontPath)
            ? resourcePathToUrl(fontPath)
            : undefined,
        document,
        ...fontMetadataFromPath(resourcePath),
      };
    }
    // A direct raster ExtResource (`Texture2D` → .png): the host-supplied intrinsic
    // size wins (authoritative metadata, works outside browsers); otherwise fall
    // back to the one-shot browser measure (see `imageSizes`), whose in-flight
    // window is surfaced as `status: "pending"` so consumers re-resolve on settle.
    const hostSize = options.resourceSize?.(resourcePath);
    const measured = hostSize ? undefined : measuredImageSize(resourcePath);
    return {
      type,
      path: resourcePath,
      url: resourcePathToUrl(resourcePath),
      fontUrl: isFontPath(resourcePath)
        ? resourcePathToUrl(resourcePath)
        : undefined,
      size: hostSize ?? measured?.size,
      status: measured?.status,
      ...fontMetadataFromPath(resourcePath),
    };
  };

  const sceneForNode = (node: GodotNode): GodotSceneState | undefined => {
    const sourcePath = asString(node.properties[SOURCE_SCENE_PATH_ATTRIBUTE]);
    const snapshot = sourcePath ? scenes.peek(sourcePath) : undefined;
    return snapshot?.status === "ready" ? snapshot.value : undefined;
  };

  return {
    resourcePathToUrl,
    scenes,
    resources,
    peekScene: scenes.peek,
    loadScene: scenes.load,
    preload: async (resourcePath) => {
      if (resourcePath.endsWith(".tscn")) {
        await scenes.preload(resourcePath);
      } else if (
        resourcePath.endsWith(".tres") ||
        resourcePath.endsWith(".res")
      ) {
        await resources.preload(resourcePath);
      }
    },
    subscribe,
    generations: () => ({
      scenes: scenesGeneration,
      resources: resourcesGeneration,
      croppedAtlas: croppedAtlasGeneration,
      imageSizes: imageSizesGeneration,
    }),
    extResource,
    resolveResource,
    resolveResourcePath: resolvePathResource,
    resolveExternalScene,
    sceneOptions: (scene) => ({
      // Resource resolution is NOT gated by visibility: the renderer resolves resources for
      // ALL nodes (a hidden node still renders with `visibility:hidden` and needs its styles
      // — see html.test.ts "renders ... hidden styles"). Only EXTERNAL SCENE fetches are
      // visibility-gated, by the caller's EFFECTIVE/merged `effectivelyVisible`
      // (scene-index.ts). A prior guard here gated resource resolution on the raw
      // SOURCE-authored `node.properties.visible`, which a catalog `visible` override does
      // NOT change — so it dropped authored textures on override-shown nodes (the char-select
      // selection outline), diverging from the eager/CEL path. Resolve unconditionally.
      resolveExternalScene: ({ ref, node }) => {
        const resolved = resolveExternalScene(
          sceneForNode(node) ?? scene,
          ref,
          node,
        );
        if (resolved) return resolved;
        // Inner-scene fallback for a merged mount (instance ROOT or OVERRIDDEN CHILD): the
        // merged node takes the OUTER placeholder scene's `source_scene_path`, but its OWN
        // `instance=ExtResource(...)` id is LOCAL to the INNER instanced scene — which the
        // outer scene doesn't define (deck_view overriding card_grid's `Scrollbar`, whose
        // instance id belongs to card_grid; resolving it against deck_view fails, so the
        // scrollbar.tscn instance never mounts → a childless `Node`). Outer is tried FIRST so
        // override-authored refs win; mirrors the `resolveResource` fallback below.
        const innerScenePath = node
          ? asString(node.properties[MOUNTED_INNER_SCENE_PATH_ATTRIBUTE])
          : undefined;
        if (innerScenePath) {
          const innerSnap = scenes.peek(innerScenePath);
          if (innerSnap?.status === "ready") {
            return resolveExternalScene(innerSnap.value, ref, node);
          }
        }
        return resolved;
      },
      resolveResource: (ref, node) => {
        const scope = sceneForNode(node) ?? scene;
        const resolved = resolveResource(scope, ref, node);
        if (resolved) return resolved;
        // Inner-scene fallback for a merged mount (instance ROOT or OVERRIDDEN CHILD):
        // the merged node takes the OUTER placeholder scene's `source_scene_path`, but
        // its own base-authored refs (e.g. a TextureRect's `texture`) use ext ids LOCAL
        // to the INNER instanced scene, which the outer scene doesn't define.
        // `mergeMountedNode` records that inner scene; retry the ref there. Outer is
        // tried FIRST, so override-authored refs (e.g. an outer-scene SubResource
        // material) still resolve against the outer scene. (Regression: defeat-screen
        // banner root + Continue-button `Image` child rendered blank.)
        const innerScenePath = asString(
          node?.properties[MOUNTED_INNER_SCENE_PATH_ATTRIBUTE],
        );
        if (innerScenePath) {
          const innerSnap = scenes.peek(innerScenePath);
          if (innerSnap?.status === "ready") {
            return resolveResource(innerSnap.value, ref, node);
          }
        }
        return undefined;
      },
      resolveResourcePath: (path) => resolvePathResource(path),
      // A node's own theme resource (`theme = ExtResource(...)`) resolves through the
      // SAME on-demand resource cache as any other `.tres`; query the parsed Theme doc
      // for the requested item. Pending/absent theme ⇒ undefined, and the renderer
      // re-queries once the resource cache settles (same as textures/fonts).
      resolveTheme: (node, name) => {
        const themeRef = asResourceRef(node.properties?.theme);
        if (!themeRef) return undefined;
        const doc = resolveResource(
          sceneForNode(node) ?? scene,
          themeRef,
          node,
        )?.document;
        return doc
          ? queryTheme(
              doc,
              node.type,
              asString(node.properties?.theme_type_variation),
              name,
            )
          : undefined;
      },
    }),
  };
}

function createDocumentCache<T>(
  loadDocument: (resourcePath: string) => Promise<T>,
  // Settle notifications go through the resolver's shared deferred emitter (one
  // notification per burst across caches); a load KICK never emits at all — the
  // caller just observed the pending status itself, and a synchronous emit
  // mid-walk would re-enter the consumer's walk (walks kick loads on cache miss).
  scheduleEmit: (flushCacheListeners: () => void) => void,
  // Synchronous per-settle hook (generation counters): runs the moment the cache
  // entry flips, BEFORE the deferred emit, so listeners always observe a counter
  // that already covers the settle they are being notified about.
  onSettle?: () => void,
): GodotFetchDocumentCache<T> {
  const entries = new Map<string, GodotFetchCacheSnapshot<T>>();
  const listeners = new Set<() => void>();
  const flushListeners = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const load = (resourcePath: string): Promise<T> => {
    const cached = entries.get(resourcePath);
    if (cached?.status === "ready") {
      return Promise.resolve(cached.value);
    }
    if (cached?.status === "pending") {
      return cached.promise;
    }
    const promise = loadDocument(resourcePath)
      .then((value) => {
        entries.set(resourcePath, {
          status: "ready",
          path: resourcePath,
          value,
        });
        onSettle?.();
        scheduleEmit(flushListeners);
        return value;
      })
      .catch((error: unknown) => {
        entries.set(resourcePath, {
          status: "error",
          path: resourcePath,
          message: errorMessage(error),
          error,
        });
        onSettle?.();
        scheduleEmit(flushListeners);
        throw error;
      });
    entries.set(resourcePath, {
      status: "pending",
      path: resourcePath,
      promise,
    });
    return promise;
  };
  return {
    peek: (resourcePath) => entries.get(resourcePath),
    load,
    preload: (resourcePath) =>
      load(resourcePath)
        .then(() => undefined)
        .catch(() => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// A scene body may arrive two ways: as Godot `[gd_scene …]` source text (the text
// parser produces a GodotSceneState), or as a pre-parsed GodotSceneState serialized to
// JSON by a runtime producer (e.g. a live game mod walking `PackedScene.GetState()`).
// Both reach the same GodotSceneState boundary. Sniff: a JSON object with `kind:"scene"`
// is used directly; anything else (and any malformed JSON) falls back to the .tscn text
// parser.
//
// Live-producer ingest contract (everything a faithful `GetState()` dump needs):
//   - Values use gsw's canonical Variant shape (raw scalars, `{ type, args }` math,
//     `{ type, id|path }` resource refs). A producer that pipes Godot `JSON.from_native`
//     (which tags scalars as `i:`/`f:`/`s:`/`sn:`/`np:`) can set top-level
//     `valueEncoding:"from_native"` to have those tags decoded on ingest here; without
//     the flag, values are taken verbatim.
//   - Nested-node `parent` paths may be the live `GetNodePath(…, for_parent=true)`
//     NodePath form with a leading `./`; that is normalized in layout's
//     `sceneNodesFromState`, so both `./Panel/Flow` and bare `Panel/Flow` resolve.
//   - Scene-local sub-resources can be supplied inline in `subResources` as
//     `{ id, type, properties }` (no `res://` path); a node property referencing one as
//     `{ type:"SubResource", id }` resolves through the same path as a `.tres` sub-resource.
function parseSceneBody(body: string, resourcePath: string): GodotSceneState {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<GodotSceneState> & {
        valueEncoding?: string;
      };
      if (parsed?.kind === "scene" && Array.isArray(parsed.nodes)) {
        const state: GodotSceneState = {
          kind: "scene",
          nodes: parsed.nodes,
          connections: parsed.connections ?? [],
          extResources: parsed.extResources ?? [],
          subResources: parsed.subResources ?? [],
          editableInstances: parsed.editableInstances ?? [],
          basePath: parsed.basePath,
          diagnostics: parsed.diagnostics ?? [],
        };
        if (parsed.valueEncoding === "from_native") {
          normalizeFromNativeSceneValues(state);
        }
        return state;
      }
    } catch {
      // Not a JSON scene document — fall through to the text parser.
    }
  }
  return parseGodotTextScene(body, { path: resourcePath });
}

// Rewrite a JSON-ingested scene's Variant value positions from Godot's
// `JSON.from_native` tagged form into gsw's canonical contract (see
// `decodeFromNativeValue`). Touches only value positions — node properties,
// sub-resource attributes/properties, and connection binds — never structural fields
// (names, types, parent paths). Gated by `valueEncoding:"from_native"` so raw producers
// (and the text path) keep strings like `"i:3"` verbatim.
function normalizeFromNativeSceneValues(state: GodotSceneState): void {
  for (const node of state.nodes) {
    for (const property of node.properties) {
      property.value = decodeFromNativeValue(property.value);
    }
  }
  for (const subResource of state.subResources) {
    if (subResource.attributes) {
      subResource.attributes = mapRecordValues(subResource.attributes);
    }
    if (subResource.properties) {
      subResource.properties = mapRecordValues(subResource.properties);
    }
  }
  for (const connection of state.connections) {
    if (connection.binds) {
      connection.binds = connection.binds.map(decodeFromNativeValue);
    }
  }
}

function mapRecordValues(
  record: Record<string, GodotVariant>,
): Record<string, GodotVariant> {
  const result: Record<string, GodotVariant> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = decodeFromNativeValue(value);
  }
  return result;
}

// A resource body may arrive two ways: as Godot `[gd_resource …]` source text (the text
// parser produces a GodotResource), or as a pre-parsed GodotResource serialized to JSON by
// a runtime producer (e.g. a live game mod loading a `Resource` and walking its properties —
// fonts/materials/styleboxes). Both reach the same GodotResource boundary. Sniff: a JSON
// object with `kind:"resource"` is used directly; anything else (and any malformed JSON)
// falls back to the `.tres` text parser. Mirrors `parseSceneBody`; the same
// `valueEncoding:"from_native"` opt-in decodes Godot-tagged scalars on ingest.
function parseResourceBody(body: string, resourcePath: string): GodotResource {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<GodotResource> & {
        kind?: string;
        valueEncoding?: string;
      };
      if (parsed?.kind === "resource") {
        const resource: GodotResource = {
          type: parsed.type ?? asString(parsed.header?.attributes?.type),
          header: parsed.header ?? null,
          extResources: parsed.extResources ?? [],
          subResources: parsed.subResources ?? [],
          properties: parsed.properties ?? {},
          diagnostics: parsed.diagnostics ?? [],
        };
        if (parsed.valueEncoding === "from_native") {
          resource.properties = mapRecordValues(resource.properties);
          for (const subResource of resource.subResources) {
            if (subResource.properties) {
              subResource.properties = mapRecordValues(subResource.properties);
            }
          }
        }
        return resource;
      }
    } catch {
      // Not a JSON resource document — fall through to the text parser.
    }
  }
  return parseGodotResource(body, { path: resourcePath });
}

function assertResourcePath(resourcePath: string): void {
  if (!resourcePath.startsWith("res://")) {
    throw new Error(
      `Expected a Godot resource path starting with res://, got ${resourcePath}`,
    );
  }
}

function subResourceDocument(resource: {
  type?: string;
  properties: Record<string, unknown>;
}): GodotResource {
  return {
    type: resource.type,
    header: resource.type
      ? { section: "gd_resource", attributes: { type: resource.type } }
      : null,
    extResources: [],
    subResources: [],
    properties: resource.properties as GodotResource["properties"],
    diagnostics: [],
  };
}

function isFontPath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?|ttc)$/i.test(path);
}

// Raster formats whose intrinsic size an `Image` decode reports reliably. SVG is
// deliberately excluded (its intrinsic size is optional and browser-dependent).
function isRasterImagePath(path: string): boolean {
  return /\.(?:png|webp|jpe?g|gif|bmp)$/i.test(path);
}

function fontMetadataFromPath(
  path: string,
): Partial<GodotProjectResolvedResource> {
  if (!isFontPath(path)) {
    return {};
  }
  return {
    fontFamily: path
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, ""),
    fontStyle: /italic/i.test(path) ? "italic" : "normal",
    fontWeight: /bold/i.test(path) ? "700" : "400",
  };
}

function fontWeightFromVariation(document: GodotResource): number | undefined {
  const variation = document.properties.variation_opentype;
  if (
    !variation ||
    typeof variation !== "object" ||
    Array.isArray(variation) ||
    "type" in variation
  ) {
    return undefined;
  }
  return asNumber((variation as Record<string, GodotVariant>)["2003265652"]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
