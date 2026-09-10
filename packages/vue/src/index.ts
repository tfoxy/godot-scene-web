import type {
  GodotNode,
  GodotResourceRefValue,
  GodotSceneState,
  GodotVariant,
} from "@godot-scene-web/core";
import {
  type BrowserNativeParentContext,
  buildGraphNodeHtml,
  buildHiddenGraphNode,
  buildNodePresentation,
  buildSceneFragment,
  buildSceneStructure,
  buildStyleElement,
  buildTintDefsElement,
  contentScaleStageStyle,
  DEFAULT_BROWSER_VIEWPORT,
  FRAME_CLASS,
  type GodotHtmlFontFace,
  type GodotHtmlModel,
  type GodotHtmlNode,
  type GodotHtmlRenderOptions,
  type GraphNodeBuildResult,
  observeContentScale,
  type RenderElement,
  type ResolvedContentScale,
  ROOT_PARENT_CONTEXT,
  renderSceneGraphToHtmlModel,
  renderSceneToHtmlModel,
  resolveContentScale,
  STAGE_CLASS,
  stabilizeRenderElements,
  uniqueFontFaces,
} from "@godot-scene-web/html";
import {
  createHtmlEffectsHost,
  type GodotHtmlMountOptions,
  type GodotHtmlRuntimeOptions,
  type HtmlEffectsHost,
} from "@godot-scene-web/html/runtime";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import {
  type GodotLayoutOptions,
  resolveGodotSceneTree,
} from "@godot-scene-web/layout";
import type {
  GodotResourceStatus,
  SceneGraph,
  SceneGraphNode,
  SceneStructureOptions,
} from "@godot-scene-web/scene-graph";
import {
  createSceneGraphNodeMemo,
  deriveSceneGraph,
  type SceneGraphNodeMemo,
} from "@godot-scene-web/scene-graph";
import {
  type ComputedRef,
  computed,
  createCommentVNode,
  defineComponent,
  h,
  type InjectionKey,
  inject,
  onBeforeUnmount,
  onMounted,
  type PropType,
  provide,
  type Ref,
  ref,
  type Slots,
  type VNodeChild,
  watch,
} from "vue";

export type GodotSceneViewOptions = SceneStructureOptions &
  GodotLayoutOptions &
  GodotHtmlRenderOptions &
  GodotHtmlRuntimeOptions & {
    /**
     * Layout pipeline. `"browser"` (default): the browser CSS engine resolves
     * layout (containers flex/grid, anchored Controls via CSS insets, text sizes
     * itself) straight from the structural `SceneGraph`, never running the rect
     * cascade. `"computed"`: gsw's rect cascade produces absolute px — opt in for
     * the layout-diff/parity oracle or pixel-exact needs.
     */
    layoutMode?: "browser" | "computed";
  };

// Per-mounted-view counter feeding a distinct tint-filter id prefix. The
// `filter: url(#id)` references and their `<svg><defs>` share the document, so
// two live views (couch-coop's per-player renders) — or a dev harness showing a
// live view beside a static one — would otherwise collide on `godot-tint-N` and
// resolve each other's filters. Each `useGodotSceneModel` call (one per view)
// takes the next prefix; the static renderers keep the unprefixed default, so
// their goldens are unchanged.
let tintFilterViewSeq = 0;
function nextTintFilterIdPrefix(): string {
  tintFilterViewSeq += 1;
  return `godot-tint-v${tintFilterViewSeq}-`;
}

export interface GodotSubscribableResourceSource {
  subscribe: (listener: () => void) => () => void;
  /**
   * Monotonic settle counters from the backing resolver (see the gsw fetch
   * resolver's `generations()`). When present, `useGodotSceneModel` memoizes the
   * scene-graph derivation on (input identities + the `scenes` counter): graph
   * derivation reads scene documents but never `.tres`/font/texture content, so
   * resource-only settle notifications skip the derive and rebuild only the HTML
   * model. Absent ⇒ derive runs on every recompute (always correct).
   */
  generations?: () => { scenes: number; resources: number };
}

export interface GodotSceneModelSource {
  scene?: GodotSceneState;
  model?: GodotHtmlModel;
  options?: GodotSceneViewOptions;
  resolveResource?: (ref: GodotResourceRefValue, node: GodotNode) => unknown;
  resolveResourcePath?: (path: string, node: GodotNode) => unknown;
  overrideNodeProps?: (
    node: GodotNode,
    path: string,
  ) => Record<string, GodotVariant> | undefined;
  overrideNodeType?: (node: GodotNode, path: string) => string | undefined;
  nodeOverrides?: GodotNodePropertyOverrideMap;
  nodeNameOverrides?: GodotNodePropertyOverrideMap;
  mountExternalScene?: (
    ref: GodotResourceRefValue,
    node: GodotNode,
  ) => GodotSceneState | undefined;
  resourceSource?: GodotSubscribableResourceSource;
}

export type GodotNodePropertyOverrideMap = Record<
  string,
  Record<string, GodotVariant>
>;
export type GodotNodePropertyOverrideResolver = (
  node: GodotNode,
  path: string,
) => Record<string, GodotVariant> | undefined;

// The model the COMPONENT renderer consumes: per-node browser-native html
// (identity-stable for unchanged nodes), the behind/normal child slots (stabilized
// so a parent's child list keeps identity across leaf-only changes), and the shared
// font/tint/resource accumulators. Built incrementally by `buildComponentSceneModel`
// (per-node memo over the post-3.1 identity-stable scene graph), then PROVIDED so
// each `GodotNodeView` pulls only its own node — a leaf change re-renders just it.
interface ComponentSceneModel {
  rootPaths: string[];
  nodesByPath: Map<string, GodotHtmlNode>;
  childrenByPath: Map<string, { behind: string[]; normal: string[] }>;
  fontFaces: GodotHtmlFontFace[];
  tintFilters: Array<{ id: string; markup: string }>;
  resourceStatuses: GodotResourceStatus[];
  viewport: { width: number; height: number };
  contentScale: ResolvedContentScale | null;
  // Only read with `includeBaseCss` (component mode never does); kept so the model
  // satisfies `buildStyleElement`'s input.
  css: string;
}

// The provided component model. A `ComputedRef` (not the value) so each node
// component subscribes once and re-pulls its own entry when the model rebuilds —
// `null` outside component mode.
const COMPONENT_MODEL_KEY: InjectionKey<
  ComputedRef<ComponentSceneModel | null>
> = Symbol("godot-component-model");

// Scaffolding (font `<style>`, tint `<defs>`) carries no node children, so the
// shared `renderElement` emits it identically with no slots needed.
const EMPTY_SLOTS: Slots = {};

// A leaf (or hidden/missing) node's slots — a shared constant so a leaf's `slots`
// pull stays `===` across rebuilds and never forces a re-render.
const NO_CHILD_SLOTS: { behind: string[]; normal: string[] } = {
  behind: [],
  normal: [],
};

// One scene node, rendered as its OWN Vue component. It PULLS its built html node
// and child slots from the injected component model (keyed by `path`) rather than
// receiving them as pushed props — so when the model rebuilds, only the components
// whose own node/slots changed VALUE re-render (Vue's computed value-equality skips
// the rest), while a parent never re-renders just because a descendant changed.
// Vue devtools shows one component per scene node.
export const GodotNodeView = defineComponent({
  name: "GodotNodeView",
  props: {
    path: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const model = inject(COMPONENT_MODEL_KEY, null);
    const node = computed<GodotHtmlNode | null>(
      () => model?.value?.nodesByPath.get(props.path) ?? null,
    );
    const slots = computed(
      () => model?.value?.childrenByPath.get(props.path) ?? NO_CHILD_SLOTS,
    );
    return () => {
      const current = node.value;
      if (!current) {
        return null;
      }
      return renderComponentNode(current, slots.value);
    };
  },
});

// Emit one built node as Vue vnodes — the SAME shape as `buildNodeElement`: the
// outer element (carrying `data-godot-path` etc.) wraps `[behind children,
// self-layer, normal children]` in Godot's around-the-node paint order; the
// self-layer carries the node's paint/text. Children are nested `GodotNodeView`s
// addressed by path (they pull their own data).
function renderComponentNode(
  node: GodotHtmlNode,
  slots: { behind: string[]; normal: string[] },
): VNodeChild {
  const shell = buildNodePresentation(node);
  if (shell.kind === "comment") return createCommentVNode(shell.text ?? "");
  const self = shell.children?.[0];
  const childComponent = (path: string): VNodeChild =>
    h(GodotNodeView, { key: path, path });
  return h(
    shell.tag,
    {
      key: shell.key,
      class: shell.className,
      style: shell.style,
      ...shell.attributes,
    },
    [
      ...slots.behind.map(childComponent),
      ...(self ? [renderElement(self, EMPTY_SLOTS)] : []),
      ...slots.normal.map(childComponent),
    ],
  );
}

// The scene as a component tree: the shared scaffolding (font `<style>`, tint
// `<defs>`) emitted from the model's accumulators exactly as the fragment path,
// then the stage (+ content-scale frame) whose ROOT nodes are `GodotNodeView`
// components addressed by path. The component model itself is provided in
// `GodotSceneView` setup; this only emits the shell.
function renderComponentTree(
  model: ComponentSceneModel,
  frameRef: Ref<HTMLElement | null>,
  stageRef: Ref<HTMLElement | null>,
  debug: boolean,
): VNodeChild[] {
  const out: VNodeChild[] = [];
  const style = buildStyleElement(model, { includeBaseCss: false });
  if (style) {
    out.push(renderElement(style, EMPTY_SLOTS));
  }
  const tintDefs = buildTintDefsElement(model);
  if (tintDefs) {
    out.push(renderElement(tintDefs, EMPTY_SLOTS));
  }
  const stageStyle: Record<string, string> = model.contentScale
    ? { ...contentScaleStageStyle(model.contentScale) }
    : {
        width: `${model.viewport.width}px`,
        height: `${model.viewport.height}px`,
      };
  const stage = h(
    "div",
    {
      class: debug ? `${STAGE_CLASS} godot-scene-debug` : STAGE_CLASS,
      "data-godot-stage": "true",
      ref: stageRef,
      style: stageStyle,
    },
    model.rootPaths.map((path) => h(GodotNodeView, { key: path, path })),
  );
  if (!model.contentScale) {
    out.push(stage);
    return out;
  }
  const background = model.contentScale.background;
  out.push(
    h(
      "div",
      {
        class: FRAME_CLASS,
        ref: frameRef,
        style: background ? { background } : {},
      },
      [stage],
    ),
  );
  return out;
}

// Per-view caches threaded across rebuilds (held in `GodotSceneView` setup): a
// node entry is reused when its (identity-stable) SceneGraphNode AND parent context
// are unchanged; a child-slots entry when its children's identities are unchanged.
interface ComponentNodeCacheEntry {
  graphNode: SceneGraphNode;
  ctxKey: string;
  result: GraphNodeBuildResult;
}
interface ComponentChildCacheEntry {
  key: string;
  slots: { behind: string[]; normal: string[] };
}

function parentContextKey(ctx: BrowserNativeParentContext): string {
  return `${ctx.parentType ?? ""}|${ctx.parentHorizontal ? 1 : 0}`;
}

// Identity key for a parent's child slots: ONLY the child PATHS + their behind/
// normal split (newline-joined; paths never contain a newline). A child's PROP
// change does NOT change this — so the parent's `children` pull stays `===` and the
// parent never re-renders just because a descendant changed; only a structural
// change (child added/removed/reordered, or a behind/draw-order shift) does.
function childSlotsKey(slots: { behind: string[]; normal: string[] }): string {
  return `${slots.behind.join("\n")}\u0000${slots.normal.join("\n")}`;
}

// Build the component model from a `SceneGraph`, reusing per-node html for every
// node whose SceneGraphNode identity + parent context are unchanged. Because the
// post-3.1 graph keeps unchanged nodes `===`, a leaf change rebuilds only the
// changed node(s); every other entry (and every stabilized child-slot object)
// keeps identity, so the downstream pulls compare equal and skip re-rendering.
// `tintFilters` is the view's lifetime-stable filter table (append-only: a markup
// keeps its id), so a reused node's baked `filter: url(#id)` stays valid.
function buildComponentSceneModel(
  graph: SceneGraph,
  options: GodotHtmlRenderOptions,
  viewport: { width: number; height: number },
  contentScale: ResolvedContentScale | null,
  nodeCache: Map<string, ComponentNodeCacheEntry>,
  childCache: Map<string, ComponentChildCacheEntry>,
  tintFilters: Map<string, string>,
): ComponentSceneModel {
  const structure = buildSceneStructure(graph);
  const nodesByPath = new Map<string, GodotHtmlNode>();
  const fontFaces: GodotHtmlFontFace[] = [];
  const resourceStatuses: GodotResourceStatus[] = [
    ...(graph.resourceStatuses ?? []),
  ];
  const builtPaths = new Set<string>();

  const walk = (
    path: string,
    parentLayout: GodotSceneTreeNode | undefined,
    parentPath: string | null,
    parentContext: BrowserNativeParentContext,
  ): void => {
    const graphNode = structure.nodesByPath.get(path);
    if (!graphNode) {
      return;
    }
    builtPaths.add(path);
    if (!graphNode.visible) {
      // Hidden: comment placeholder in its slot; prune the subtree (descendants
      // dropped, fonts/tints unregistered) — matching the batch model.
      nodesByPath.set(path, buildHiddenGraphNode(graphNode, parentPath));
      return;
    }
    const ctxKey = parentContextKey(parentContext);
    let entry = nodeCache.get(path);
    // Force re-derive a node whose previous build still had PENDING resources. The graph node
    // identity is stable across a resource-only settle (the graph is memoized on the SCENES
    // generation), so without this the cached entry pins the node's pending placeholder (e.g. an
    // atlas sprite showing its raw `.tres` doc url) even after the doc loads and the resolver can
    // return the cropped image. Load-time-bounded: once every resource is ready the node has no
    // pending status, so steady state never re-derives.
    const hadPendingResource =
      entry?.result.resourceStatuses.some(
        (status) => status.status === "pending",
      ) ?? false;
    if (
      !entry ||
      entry.graphNode !== graphNode ||
      entry.ctxKey !== ctxKey ||
      hadPendingResource
    ) {
      const result = buildGraphNodeHtml(
        graphNode,
        parentLayout,
        parentPath,
        parentContext,
        options,
        tintFilters,
        viewport,
        contentScale,
      );
      entry = { graphNode, ctxKey, result };
      nodeCache.set(path, entry);
    }
    nodesByPath.set(path, entry.result.node);
    fontFaces.push(...entry.result.fontFaces);
    resourceStatuses.push(...entry.result.resourceStatuses);
    const slots = structure.childrenByPath.get(path);
    if (slots) {
      for (const childPath of slots.behind) {
        walk(childPath, entry.result.layout, path, entry.result.childContext);
      }
      for (const childPath of slots.normal) {
        walk(childPath, entry.result.layout, path, entry.result.childContext);
      }
    }
  };
  for (const rootPath of structure.rootPaths) {
    walk(rootPath, undefined, null, ROOT_PARENT_CONTEXT);
  }
  // Evict cache entries for nodes that vanished (e.g. a mount removed).
  for (const key of [...nodeCache.keys()]) {
    if (!builtPaths.has(key)) {
      nodeCache.delete(key);
    }
  }

  // Stabilize behind/normal child slots: reuse the previous object when the child
  // PATHS are unchanged, so a parent's `children` pull stays `===` across leaf-only
  // changes (no parent re-render) — only a structural change yields a new object.
  const childrenByPath = new Map<
    string,
    { behind: string[]; normal: string[] }
  >();
  for (const [path, slots] of structure.childrenByPath) {
    if (!builtPaths.has(path) || !structure.nodesByPath.get(path)?.visible) {
      continue;
    }
    const key = childSlotsKey(slots);
    const cached = childCache.get(path);
    if (cached && cached.key === key) {
      childrenByPath.set(path, cached.slots);
    } else {
      childCache.set(path, { key, slots });
      childrenByPath.set(path, slots);
    }
  }
  for (const key of [...childCache.keys()]) {
    if (!childrenByPath.has(key)) {
      childCache.delete(key);
    }
  }

  return {
    rootPaths: structure.rootPaths,
    nodesByPath,
    childrenByPath,
    fontFaces: uniqueFontFaces(fontFaces),
    tintFilters: [...tintFilters].map(([markup, id]) => ({ id, markup })),
    resourceStatuses,
    viewport,
    contentScale,
    css: "",
  };
}

export const GodotSceneView = defineComponent({
  name: "GodotSceneView",
  props: {
    scene: {
      type: Object as PropType<GodotSceneState>,
      required: false,
      default: undefined,
    },
    model: {
      type: Object as PropType<GodotHtmlModel>,
      required: false,
      default: undefined,
    },
    options: {
      type: Object as PropType<GodotSceneViewOptions>,
      required: false,
      default: () => ({}),
    },
    resolveResource: {
      type: Function as PropType<
        (ref: GodotResourceRefValue, node: GodotNode) => unknown
      >,
      required: false,
      default: undefined,
    },
    resolveResourcePath: {
      type: Function as PropType<(path: string, node: GodotNode) => unknown>,
      required: false,
      default: undefined,
    },
    overrideNodeProps: {
      type: Function as PropType<
        (
          node: GodotNode,
          path: string,
        ) => Record<string, GodotVariant> | undefined
      >,
      required: false,
      default: undefined,
    },
    overrideNodeType: {
      type: Function as PropType<
        (node: GodotNode, path: string) => string | undefined
      >,
      required: false,
      default: undefined,
    },
    nodeOverrides: {
      type: Object as PropType<GodotNodePropertyOverrideMap>,
      required: false,
      default: () => ({}),
    },
    nodeNameOverrides: {
      type: Object as PropType<GodotNodePropertyOverrideMap>,
      required: false,
      default: () => ({}),
    },
    mountExternalScene: {
      type: Function as PropType<
        (
          ref: GodotResourceRefValue,
          node: GodotNode,
        ) => GodotSceneState | undefined
      >,
      required: false,
      default: undefined,
    },
    resourceSource: {
      type: Object as PropType<GodotSubscribableResourceSource>,
      required: false,
      default: undefined,
    },
    debug: {
      type: Boolean,
      default: false,
    },
    // Render the scene as a recursive `GodotNodeView` COMPONENT tree (one component
    // per node) instead of the flat single-vnode fragment. Same DOM + same model
    // inputs; opt-in while the component path is validated (structural parity) and
    // grown toward fine-grained per-node reactivity. The `#node` slot and the
    // stabilize/vnode-cache fast path are fragment-mode only.
    componentTree: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { slots }) {
    const sceneModel = useGodotSceneModel(props);
    const fragmentModel = sceneModel.model;

    // Component-tree mode: build an incremental, per-node-memoized model from the
    // (identity-stable, post-3.1) scene graph and PROVIDE it as a `ComputedRef` so
    // each `GodotNodeView` pulls only its own node. Caches + the lifetime-stable
    // tint table live here, threaded across rebuilds. `null` outside component mode
    // (the graph is never read, so nothing derives).
    const nodeCache = new Map<string, ComponentNodeCacheEntry>();
    const childCache = new Map<string, ComponentChildCacheEntry>();
    const componentTintFilters = new Map<string, string>();
    const componentModel = computed<ComponentSceneModel | null>(() => {
      if (!props.componentTree) {
        return null;
      }
      // Rebuild on EVERY resolver settle, not only when the graph identity changes. A resource-only
      // settle (a `.tres`/font/texture doc finishing load) keeps the memoized graph `===` (it's keyed
      // on the SCENES generation), so depending on `graph.value` alone would never rebuild and a node
      // that resolved to a PENDING placeholder (an atlas sprite showing its raw `.tres` url) would be
      // pinned forever. `buildComponentSceneModel` re-derives only the nodes whose resources were
      // pending; everything else keeps its cached entry, so steady state stays cheap.
      sceneModel.revision.value;
      const graph = sceneModel.graph.value;
      if (!graph) {
        return null;
      }
      const options = props.options ?? {};
      const htmlOptions = resolveHtmlOptions(
        props,
        sceneModel.tintFilterIdPrefix,
      );
      const viewport = {
        width: options.viewport?.width ?? DEFAULT_BROWSER_VIEWPORT.width,
        height: options.viewport?.height ?? DEFAULT_BROWSER_VIEWPORT.height,
      };
      const contentScale = resolveContentScale(options.contentScale, viewport);
      return buildComponentSceneModel(
        graph,
        htmlOptions,
        viewport,
        contentScale,
        nodeCache,
        childCache,
        componentTintFilters,
      );
    });
    provide(COMPONENT_MODEL_KEY, componentModel);

    // The model the render actually consumes (so the scale observer never forces
    // the inactive renderer to build).
    const activeModel = computed<GodotHtmlModel | ComponentSceneModel | null>(
      () => (props.componentTree ? componentModel.value : fragmentModel.value),
    );

    // Transform-technique content-scale needs the live frame size; drive
    // `--godot-scale` from a ResizeObserver. The container technique is CSS-only
    // and needs none of this.
    const frame = ref<HTMLElement | null>(null);
    // The live runtimes (WebGL shaders + particles) attach to the mounted stage.
    const stage = ref<HTMLElement | null>(null);
    let disposeScale: (() => void) | null = null;
    const syncScale = (): void => {
      disposeScale?.();
      disposeScale = null;
      const contentScale = activeModel.value?.contentScale;
      if (
        contentScale &&
        contentScale.technique === "transform" &&
        frame.value
      ) {
        disposeScale = observeContentScale(frame.value, contentScale.base);
      }
    };
    onMounted(syncScale);
    watch([activeModel, frame], syncScale, { flush: "post" });
    onBeforeUnmount(() => {
      disposeScale?.();
      disposeScale = null;
    });

    // Live runtime ownership, mirroring the content-scale observer above. Runs
    // post-DOM-update so `stage.value` is the freshly mounted element; reconciles on
    // model changes (the DOM nodes + their `data-godot-particle-specs` may have changed).
    // Both runtimes are no-ops unless their option is set / WebGL2 is available.
    // `externalRuntimes` hosts own persistent runtimes over this DOM — attaching here
    // too would double-bind every node (two stacked canvases per shader node).
    let effectsHost: HtmlEffectsHost | null = null;
    let runtimeRoot: HTMLElement | null = null;
    const disposeRuntimes = (): void => {
      effectsHost?.dispose();
      effectsHost = null;
      runtimeRoot = null;
    };
    const syncRuntimes = (): void => {
      const el = stage.value;
      if (!el) {
        disposeRuntimes();
        return;
      }
      const options = resolveHtmlOptions(props, sceneModel.tintFilterIdPrefix);
      if (runtimeRoot !== el) {
        disposeRuntimes();
        runtimeRoot = el;
        effectsHost = createHtmlEffectsHost(el, options);
      } else {
        effectsHost?.updateOptions(options);
      }
      effectsHost?.reconcile();
    };
    onMounted(syncRuntimes);
    watch([activeModel, stage], syncRuntimes, { flush: "post" });
    onBeforeUnmount(() => {
      disposeRuntimes();
    });

    // Incremental re-render (fragment path): each model rebuild hands us an all-new
    // element tree, so without help every cycle re-creates every vnode and Vue
    // re-diffs every prop. `stabilizeRenderElements` restores object identity for
    // unchanged subtrees against the previous fragment; the WeakMap then reuses their
    // vnodes wholesale — Vue's normalization clones a reused vnode but keeps its props
    // and children REFERENCES, so per-prop diffing collapses to identity checks. The
    // `#node` slot disables this (slot output can depend on state the element
    // comparison can't see, and it reads `sourceNode`, which stabilization ignores).
    // The component path replaces all of this with per-node component reactivity.
    let previousFragment: RenderElement[] | undefined;
    const vnodeCache = new WeakMap<RenderElement, VNodeChild>();

    return () => {
      // Component-tree mode: render each node as its own `GodotNodeView` component
      // pulling from the provided model (Vue-native per-node reactivity + devtools),
      // emitting the same scaffolding + DOM as the fragment path.
      if (props.componentTree) {
        previousFragment = undefined;
        const current = componentModel.value;
        if (!current) {
          return null;
        }
        return renderComponentTree(current, frame, stage, props.debug);
      }
      const current = fragmentModel.value;
      if (!current) {
        previousFragment = undefined;
        return null;
      }
      // Emit the SAME structural fragment the DOM and HTML-string renderers build
      // (`<style>` @font-face, tint-filter defs, stage/frame). The Vue view is now a
      // thin emitter over the shared tree, so it can't drift from the others. Fonts
      // are self-injected (as the live view always has); base CSS stays a host
      // concern, matching the prior behavior. The frame element (when content-
      // scaled) takes the `frame` ref so the ResizeObserver can drive `--godot-scale`.
      let fragment = buildSceneFragment(current, {
        debug: props.debug,
        includeStyle: true,
        includeBaseCss: false,
      });
      if (slots.node) {
        previousFragment = undefined;
        return fragment.map((element) =>
          renderElement(element, slots, frame, undefined, stage),
        );
      }
      fragment = stabilizeRenderElements(previousFragment, fragment);
      previousFragment = fragment;
      return fragment.map((element) =>
        renderElement(element, slots, frame, vnodeCache, stage),
      );
    };
  },
});

export function useGodotSceneModel(source: GodotSceneModelSource): {
  model: ComputedRef<GodotHtmlModel | null>;
  // The identity-stable scene graph (post-3.1 node memo). Exposed so the component
  // renderer can build its model from the SAME derivation; `null` in direct-`model`
  // mode (no scene to derive).
  graph: ComputedRef<SceneGraph | null>;
  // The per-view tint-filter id prefix (lifetime-stable) the component build reuses.
  tintFilterIdPrefix: string;
  // Bumps on every resolver settle (scene/resource/font doc finishing load). The component
  // model depends on it so it rebuilds when a resource transitions PENDING → ready even though
  // the memoized scene graph keeps identity (the fragment `model` reads it for the same reason).
  revision: ComputedRef<number>;
  pendingResources: ComputedRef<GodotResourceStatus[]>;
  failedResources: ComputedRef<GodotResourceStatus[]>;
} {
  const revision = ref(0);
  // Stable for this view's lifetime (re-renders reuse it, so filter ids don't churn).
  const tintFilterIdPrefix = nextTintFilterIdPrefix();
  let unsubscribe: (() => void) | null = null;
  const resubscribe = (
    resourceSource: GodotSubscribableResourceSource | undefined,
  ): void => {
    unsubscribe?.();
    unsubscribe = resourceSource
      ? resourceSource.subscribe(() => {
          revision.value += 1;
        })
      : null;
  };
  watch(() => source.resourceSource, resubscribe, { immediate: true });
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
  const deriveMemo: DeriveMemo = { entry: null };
  // Per-view cross-render node cache: when the one-entry graph memo misses (any
  // override changed), this lets `deriveSceneGraph` reuse the SceneGraphNode object of
  // every node whose render fields are unchanged, so a host attack re-derives only the
  // changed nodes (and the html/component builds downstream bail out on the reused
  // identity).
  const nodeMemo = createSceneGraphNodeMemo();
  // The graph is the single shared producer; both the fragment html model and the
  // component model read `graph.value` (so derivation runs at most once per change).
  const graph = computed<SceneGraph | null>(() => {
    revision.value;
    if (source.model) {
      return null;
    }
    return resolveSceneGraph(source, deriveMemo, nodeMemo);
  });
  const model = computed<GodotHtmlModel | null>(() => {
    if (source.model) {
      return source.model;
    }
    const resolved = graph.value;
    if (!resolved) {
      return null;
    }
    const options = source.options ?? {};
    const htmlOptions = resolveHtmlOptions(source, tintFilterIdPrefix);
    // Computed mode (opt-in): run the rect cascade and render absolute px.
    if (options.layoutMode === "computed") {
      const tree = resolveGodotSceneTree(
        resolved,
        resolveStructureOptions(source),
      );
      return renderSceneToHtmlModel(tree, htmlOptions);
    }
    // Browser-native (default): the CSS engine resolves geometry from the graph.
    return renderSceneGraphToHtmlModel(resolved, {
      ...htmlOptions,
      viewport: options.viewport,
    });
  });
  const pendingResources = computed(() =>
    (model.value?.resourceStatuses ?? []).filter(
      (resource) => resource.status === "pending",
    ),
  );
  const failedResources = computed(() =>
    (model.value?.resourceStatuses ?? []).filter(
      (resource) => resource.status === "error",
    ),
  );
  return {
    model,
    graph,
    tintFilterIdPrefix,
    revision: computed(() => revision.value),
    pendingResources,
    failedResources,
  };
}

// One-entry derive memo, per view. The scene graph is a pure function of the
// scene document tree and the structural option hooks: it mounts external
// SCENES but never reads `.tres`/font/texture content. So a cached graph stays
// valid while (a) every structural input keeps object identity and (b) the
// resolver's SCENE cache is unchanged — the `scenes` settle counter from
// `GodotSubscribableResourceSource.generations`. Resource-only settles (the
// majority of a load's notifications) then skip straight to the HTML rebuild.
interface DeriveMemo {
  entry: {
    keys: readonly unknown[];
    scenesGeneration: number;
    graph: SceneGraph;
  } | null;
}

function deriveMemoKeys(source: GodotSceneModelSource): readonly unknown[] {
  return [
    source.scene,
    source.options,
    source.resolveResource,
    source.resolveResourcePath,
    source.overrideNodeProps,
    source.overrideNodeType,
    source.nodeOverrides,
    source.nodeNameOverrides,
    source.mountExternalScene,
  ];
}

// Structural options drive the single shared producer (`deriveSceneGraph`), which
// both render modes consume. Merges the resolver/override/mount hooks from `options`
// and the dedicated props.
function resolveStructureOptions(source: GodotSceneModelSource) {
  const options = source.options ?? {};
  const resolveResource = source.resolveResource ?? options.resolveResource;
  return {
    ...options,
    resolveResource,
    overrideNodeProps: resolveVueNodePropsOverride(
      options.overrideNodeProps,
      source.overrideNodeProps,
      source.nodeNameOverrides ?? {},
      source.nodeOverrides ?? {},
    ),
    overrideNodeType: source.overrideNodeType ?? options.overrideNodeType,
    mountExternalScene: source.mountExternalScene ?? options.mountExternalScene,
  };
}

// The per-node html options (paint/text resolvers + tint id prefix), shared by the
// fragment html model and the component build.
function resolveHtmlOptions(
  source: GodotSceneModelSource,
  tintFilterIdPrefix?: string,
): GodotHtmlMountOptions {
  const options = source.options ?? {};
  return {
    ...options,
    resolveResource: source.resolveResource ?? options.resolveResource,
    resolveResourcePath:
      source.resolveResourcePath ?? options.resolveResourcePath,
    // A caller-supplied prefix (via `options`) wins; otherwise the per-view prefix
    // keeps each mounted view's `<filter>` ids from colliding.
    tintFilterIdPrefix: options.tintFilterIdPrefix ?? tintFilterIdPrefix,
  };
}

// Derive (or reuse via the one-entry memo) the structural scene graph. The node
// memo inside `deriveSceneGraph` keeps unchanged nodes identity-stable across
// derives even when this one-entry memo misses.
function resolveSceneGraph(
  source: GodotSceneModelSource,
  deriveMemo?: DeriveMemo,
  nodeMemo?: SceneGraphNodeMemo,
): SceneGraph | null {
  if (!source.scene) {
    return null;
  }
  const structureOptions = resolveStructureOptions(source);
  const scenesGeneration = source.resourceSource?.generations?.().scenes;
  const memoKeys = deriveMemoKeys(source);
  const memoEntry = deriveMemo?.entry;
  if (
    memoEntry &&
    scenesGeneration !== undefined &&
    memoEntry.scenesGeneration === scenesGeneration &&
    memoEntry.keys.length === memoKeys.length &&
    memoEntry.keys.every((key, index) => key === memoKeys[index])
  ) {
    return memoEntry.graph;
  }
  const graph = deriveSceneGraph(source.scene, structureOptions, nodeMemo);
  if (deriveMemo && scenesGeneration !== undefined) {
    deriveMemo.entry = { keys: memoKeys, scenesGeneration, graph };
  }
  return graph;
}

export function overrideGodotNodePropsByPath(
  overrides: GodotNodePropertyOverrideMap,
): GodotNodePropertyOverrideResolver {
  return (_node, path) => overrides[path];
}

export function overrideGodotNodePropsByName(
  overrides: GodotNodePropertyOverrideMap,
): GodotNodePropertyOverrideResolver {
  return (node) => overrides[node.name];
}

export function mergeGodotNodePropOverrides(
  ...resolvers: Array<GodotNodePropertyOverrideResolver | undefined>
): GodotNodePropertyOverrideResolver {
  return (node, path) => {
    const merged: Record<string, GodotVariant> = {};
    for (const resolver of resolvers) {
      Object.assign(merged, resolver?.(node, path));
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  };
}

function resolveVueNodePropsOverride(
  optionsOverride: GodotNodePropertyOverrideResolver | undefined,
  propOverride: GodotNodePropertyOverrideResolver | undefined,
  nameOverrides: GodotNodePropertyOverrideMap,
  pathOverrides: GodotNodePropertyOverrideMap,
): GodotNodePropertyOverrideResolver {
  return mergeGodotNodePropOverrides(
    optionsOverride,
    propOverride,
    overrideGodotNodePropsByName(nameOverrides),
    overrideGodotNodePropsByPath(pathOverrides),
  );
}

// Emit a shared `RenderElement` tree as Vue vnodes. The structure (node element,
// self-layer, behind/self/normal order, rich-text innerHTML, scaffolding) comes
// from the shared builder; this function only translates it to `h()` calls and
// layers on the Vue-specific concerns: per-node `key`, the `#node` full-replace
// slot, and the content-scale frame `ref`.
//
// With a `cache` (stabilized fragments only — see GodotSceneView), an element
// whose object identity survived stabilization returns its previous vnode
// untouched. Reusing a mounted vnode at the same position is the static-hoist
// pattern: Vue clones it during child normalization, and the clone's shared
// props/children references short-circuit the patch. Never combined with the
// `#node` slot (the caller guarantees `slots.node` is absent when caching).
function renderElement(
  element: RenderElement,
  slots: Slots,
  frameRef?: Ref<HTMLElement | null>,
  cache?: WeakMap<RenderElement, VNodeChild>,
  stageRef?: Ref<HTMLElement | null>,
): VNodeChild {
  const cached = cache?.get(element);
  if (cached !== undefined) {
    return cached;
  }
  if (element.kind === "comment") {
    // Hidden-placeholder node: emit the same comment anchor Vue produces for
    // `v-if: false`. Carries no `sourceNode`, so the `#node` slot never sees it.
    const comment = createCommentVNode(element.text ?? "");
    cache?.set(element, comment);
    return comment;
  }
  const data: Record<string, unknown> = {};
  if (element.key !== undefined) {
    data.key = element.key;
  }
  if (element.className !== undefined) {
    data.class = element.className;
  }
  if (element.style !== undefined) {
    data.style = element.style;
  }
  if (element.attributes) {
    Object.assign(data, element.attributes);
  }
  if (frameRef && element.className === FRAME_CLASS) {
    data.ref = frameRef;
  }
  // The live runtimes (WebGL shaders, particles) attach to the mounted stage element.
  if (stageRef && element.attributes?.["data-godot-stage"] === "true") {
    data.ref = stageRef;
  }

  // Per-node element: expose the `#node` full-replace slot (`slot ?? default`).
  // The slot receives the model node and its rendered CHILD-NODE vnodes in source
  // order (excluding the self-layer), preserving the prior public contract.
  if (element.sourceNode && slots.node) {
    const node = element.sourceNode;
    const renderedByPath = new Map<string, VNodeChild>();
    const defaultChildren = (element.children ?? []).map((child) => {
      const vnode = renderElement(child, slots, frameRef, undefined, stageRef);
      if (child.sourceNode) {
        renderedByPath.set(child.sourceNode.path, vnode);
      }
      return vnode;
    });
    const childNodeVnodes = node.children
      .map((path) => renderedByPath.get(path))
      .filter((vnode): vnode is VNodeChild => vnode !== undefined);
    const slotResult = slots.node({ node, children: childNodeVnodes });
    return h(element.tag, data, slotResult ?? defaultChildren);
  }

  let vnode: VNodeChild;
  if (element.rawHtml !== undefined) {
    vnode = h(element.tag, { ...data, innerHTML: element.rawHtml });
  } else if (element.text !== undefined) {
    vnode = h(element.tag, data, [element.text]);
  } else {
    vnode = h(
      element.tag,
      data,
      (element.children ?? []).map((child) =>
        renderElement(child, slots, frameRef, cache, stageRef),
      ),
    );
  }
  cache?.set(element, vnode);
  return vnode;
}
