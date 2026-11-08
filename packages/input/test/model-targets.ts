// Test-only model of the target half of the GDScript injector (gsw_input_targets.gd) plus
// the slice of Godot the target vectors observe: a scene of Nodes, Controls and Node2Ds under the
// root (translation and Node2D scale only), `CanvasItem.is_visible_in_tree()`, and the GUI's
// routing of mouse and touch events to `Control._gui_input` (viewport.cpp `_gui_input_event`:
// mouse focus and its mask, hover only inside the headless root's 64x64 visible rect,
// `touch_focus`). The vectors' `gui` lines come from that routing; `target_signals` from the
// injector's signals. Rule for rule as the GDScript, in the same order.

type Json = Record<string, unknown>;
export type Vec = [number, number];
/** Godot's Transform2D columns: x (a, b), y (c, d), origin (e, f). */
type Affine = [number, number, number, number, number, number];

const f32 = (value: number) => Math.fround(value) + 0;
export const xy = ([x, y]: Vec) =>
  `${(x + 0).toFixed(2)},${(y + 0).toFixed(2)}`;

/** The headless root window's visible rect (64x64: SceneTree's minimum window size). */
const VISIBLE = 64;

export interface SceneNodeSpec {
  /** Path from the root, e.g. "Main/Pad"; the parent must exist (or be the root). */
  path: string;
  class: "Node" | "Control" | "Node2D";
  position?: [number, number];
  size?: [number, number];
  scale?: [number, number];
  visible?: boolean;
  scene_file_path?: string;
  /** Synthetic decimal id; Godot vectors substitute the node's real ObjectID on receive. */
  instance_id?: string;
}

export class SceneNode {
  instanceId?: string;
  freed = false;
  children: SceneNode[] = [];
  constructor(
    public name: string,
    public cls: SceneNodeSpec["class"],
    public parent: SceneNode | null,
    public position: Vec,
    public size: Vec,
    public scale: Vec,
    public visible: boolean,
    public sceneFile: string,
  ) {}
}

export class ModelScene {
  readonly root = new SceneNode(
    "root",
    "Node",
    null,
    [0, 0],
    [0, 0],
    [1, 1],
    true,
    "",
  );
  /** Called with every node a `free` removes. */
  onFree: (node: SceneNode) => void = () => {};

  add(spec: SceneNodeSpec): SceneNode {
    const parts = spec.path.split("/");
    const name = parts.pop() as string;
    const parent = parts.length === 0 ? this.root : this.get(parts.join("/"));
    if (!parent) throw new Error(`scene: no parent for ${spec.path}`);
    const node = new SceneNode(
      name,
      spec.class,
      parent,
      vec(spec.position),
      vec(spec.size),
      spec.scale ? vec(spec.scale) : [1, 1],
      spec.visible ?? true,
      spec.scene_file_path ?? "",
    );
    if (spec.instance_id !== undefined) node.instanceId = spec.instance_id;
    parent.children.push(node);
    return node;
  }

  /** The node at a root-relative path, or null. */
  get(path: string): SceneNode | null {
    return this.from(this.root, path);
  }

  /** Godot `get_node_or_null` from `base`: "." , "A/B", or absolute "/root/A". */
  from(base: SceneNode, path: string): SceneNode | null {
    let node: SceneNode | null = base;
    let parts = path.split("/");
    if (path.startsWith("/")) {
      if (parts[1] !== "root") return null;
      node = this.root;
      parts = parts.slice(2);
    }
    for (const part of parts) {
      if (!node) return null;
      if (part === "" || part === ".") continue;
      if (part === "..") node = node.parent;
      else node = node.children.find((child) => child.name === part) ?? null;
    }
    return node;
  }

  pathOf(node: SceneNode): string {
    const names: string[] = [];
    for (let n: SceneNode | null = node; n && n !== this.root; n = n.parent)
      names.unshift(n.name);
    return names.join("/");
  }

  free(path: string): void {
    const node = this.get(path);
    if (!node?.parent) throw new Error(`scene: no node ${path}`);
    node.parent.children = node.parent.children.filter((c) => c !== node);
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop() as SceneNode;
      n.freed = true;
      this.onFree(n);
      stack.push(...n.children);
    }
  }

  /** Pre-order (tree order). */
  order(): SceneNode[] {
    const out: SceneNode[] = [];
    const walk = (n: SceneNode) => {
      for (const child of n.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this.root);
    return out;
  }

  isCanvas(node: SceneNode): boolean {
    return node.cls !== "Node";
  }

  /** `get_screen_transform()` (root final transform is the identity headless). */
  xf(node: SceneNode): Affine {
    const own: Affine = [
      node.scale[0],
      0,
      0,
      node.scale[1],
      node.position[0],
      node.position[1],
    ];
    const parent = node.parent;
    if (!parent || !this.isCanvas(parent)) return own;
    return mul(this.xf(parent), own);
  }

  visibleInTree(node: SceneNode): boolean {
    for (let n: SceneNode | null = node; n && this.isCanvas(n); n = n.parent)
      if (!n.visible) return false;
    return true;
  }

  /** `gui_find_control`: the topmost visible Control whose rect holds `p`. */
  findControl(p: Vec): SceneNode | null {
    const order = this.order();
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (n.cls !== "Control" || !this.visibleInTree(n)) continue;
      if (inRect(n.size, apply(invert(this.xf(n)), p))) return n;
    }
    return null;
  }

  /** Nodes whose `scene_file_path` is `scene`, in tree order. */
  instances(scene: string): SceneNode[] {
    return this.order().filter((n) => n.sceneFile === scene);
  }
}

export function vec(value: unknown, fallback: Vec = [0, 0]): Vec {
  return Array.isArray(value) ? [f32(value[0]), f32(value[1])] : fallback;
}

function mul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function invert(t: Affine): Affine {
  const det = t[0] * t[3] - t[1] * t[2];
  const i = det === 0 ? 0 : 1 / det;
  const a = t[3] * i;
  const b = -t[1] * i;
  const c = -t[2] * i;
  const d = t[0] * i;
  return [a, b, c, d, -(a * t[4] + c * t[5]), -(b * t[4] + d * t[5])];
}

function apply(t: Affine, [x, y]: Vec): Vec {
  return [f32(t[0] * x + t[2] * y + t[4]), f32(t[1] * x + t[3] * y + t[5])];
}

/** Rect2(Vector2.ZERO, size).has_point(p). */
function inRect(size: Vec, [x, y]: Vec): boolean {
  return x >= 0 && y >= 0 && x < size[0] && y < size[1];
}

/** The `gsw_target` meta: {path, local, handle}. */
export interface TargetMeta {
  handle: number;
  path: string;
  local: Vec;
}

/** A press's binding (GswInputTargets.place's `binding`). */
export interface Binding {
  handle: number;
  offset: Vec;
  declaration: Json;
  node: SceneNode | null;
  local: Vec;
}

export interface Placement {
  position: Vec;
  drop: boolean;
  meta: TargetMeta | null;
  node: SceneNode | null;
  local: Vec;
  binding: Binding | null;
}

export interface TargetsConfig {
  retarget?: string;
  missing_target?: string;
  verify_targets?: boolean;
  target_tolerance?: number;
}

/** gsw_input_targets.gd, rule for rule. */
export class ModelTargets {
  retarget = "when-missed";
  missingTarget = "coordinate";
  verifyTargets = false;
  tolerance = 1;
  /** The signal lines (`target_signals`). */
  signals: string[] = [];
  private verifyPending: [string, Json, SceneNode | null] | null = null;

  constructor(
    readonly scene: ModelScene,
    private readonly count: (code: string) => void,
  ) {}

  configure(config: TargetsConfig) {
    this.retarget = config.retarget ?? this.retarget;
    this.missingTarget = config.missing_target ?? this.missingTarget;
    this.verifyTargets = config.verify_targets ?? this.verifyTargets;
    this.tolerance = config.target_tolerance ?? this.tolerance;
  }

  place(
    source: string,
    handles: Map<number, Json>,
    resolved: Map<number, SceneNode[]>,
    record: Json,
    position: Vec,
    binding: Binding | null,
    release: boolean,
  ): Placement {
    if (binding) return this.bound(binding, position);
    const out: Placement = {
      position,
      drop: false,
      meta: null,
      node: null,
      local: [0, 0],
      binding: null,
    };
    const handle = (record.target as number | undefined) ?? 0;
    const declaration = handles.get(handle);
    if (handle === 0 || !declaration) return out;
    const local = vec(record.local);
    out.local = local;
    out.meta = { handle, path: (declaration.path as string) ?? "", local };
    const node = this.resolve(handles, resolved, handle, position, local);
    const canvas = node !== null && this.scene.isCanvas(node);
    if (node === null || (canvas && !this.scene.visibleInTree(node))) {
      this.signals.push(`target_missing ${source} ${handle}`);
      if (this.missingTarget === "drop" && !release) {
        out.drop = true;
        return out;
      }
      out.binding = { handle, offset: [0, 0], declaration, node: null, local };
      return out;
    }
    let placed = position;
    if (canvas && this.retarget !== "off") {
      const xf = this.scene.xf(node);
      if (this.retarget === "always" || !this.lands(node, xf, position, local))
        placed = apply(xf, local);
    }
    out.position = placed;
    out.node = node;
    out.binding = {
      handle,
      offset: [f32(placed[0] - position[0]), f32(placed[1] - position[1])],
      declaration,
      node,
      local,
    };
    return out;
  }

  /** GswInputTargets.tag's signal half (the meta rides on the model event). */
  tag(source: string, mouse: boolean, placement: Placement): TargetMeta | null {
    const meta = placement.meta;
    if (!meta) return null;
    if (placement.node)
      this.signals.push(
        `pointer_target ${source} ${this.scene.pathOf(placement.node)} ${xy(placement.local)}`,
      );
    if (this.verifyTargets && mouse)
      this.verifyPending = [source, { handle: meta.handle }, placement.node];
    return meta;
  }

  verify(hovered: SceneNode | null) {
    const pending = this.verifyPending;
    this.verifyPending = null;
    if (!pending) return;
    const target = pending[2];
    if (!target || target.freed || target.cls !== "Control") return;
    if (hovered === target || (hovered !== null && isAncestor(target, hovered)))
      return;
    this.signals.push(
      `target_mismatch ${pending[0]} ${pending[1].handle} ${hovered ? this.scene.pathOf(hovered) : "-"}`,
    );
  }

  private bound(binding: Binding, position: Vec): Placement {
    const placed: Vec = [
      f32(position[0] + binding.offset[0]),
      f32(position[1] + binding.offset[1]),
    ];
    let local = binding.local;
    let node = binding.node;
    if (node && !node.freed && this.scene.isCanvas(node))
      local = apply(invert(this.scene.xf(node)), placed);
    else if (node?.freed) node = null;
    return {
      position: placed,
      drop: false,
      node,
      local,
      binding,
      meta: {
        handle: binding.handle,
        path: (binding.declaration.path as string) ?? "",
        local,
      },
    };
  }

  private lands(
    node: SceneNode,
    xf: Affine,
    position: Vec,
    local: Vec,
  ): boolean {
    if (node.cls === "Control")
      return inRect(node.size, apply(invert(xf), position));
    const [x, y] = apply(xf, local);
    return Math.hypot(x - position[0], y - position[1]) <= this.tolerance;
  }

  private resolve(
    handles: Map<number, Json>,
    resolved: Map<number, SceneNode[]>,
    handle: number,
    position: Vec,
    local: Vec,
  ): SceneNode | null {
    let candidates = resolved.get(handle) ?? [];
    if (candidates.length === 0 || candidates.some((n) => n.freed)) {
      candidates = this.find(handles.get(handle) as Json);
      if (candidates.length > 0) resolved.set(handle, candidates);
      else resolved.delete(handle);
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return null;
    let landed: SceneNode | null = null;
    for (const node of candidates) {
      if (
        this.scene.isCanvas(node) &&
        this.scene.visibleInTree(node) &&
        this.lands(node, this.scene.xf(node), position, local)
      ) {
        if (landed) {
          landed = null;
          break;
        }
        landed = node;
      }
    }
    if (!landed) this.count("target-ambiguous");
    return landed;
  }

  private find(declaration: Json): SceneNode[] {
    if (typeof declaration.instance_id === "string") {
      if (BigInt(declaration.instance_id) >= 1n << 63n) return [];
      const node = this.scene
        .order()
        .find((n) => n.instanceId === declaration.instance_id);
      return node && this.scene.isCanvas(node) ? [node] : [];
    }
    const path = (declaration.path as string | undefined) ?? "";
    if (path === "") return [];
    if (typeof declaration.scene === "string") {
      const out: SceneNode[] = [];
      for (const root of this.scene.instances(declaration.scene)) {
        const node = this.scene.from(root, path);
        if (node) out.push(node);
      }
      return out;
    }
    // Headless --script runs have no current scene: relative paths start at the root.
    const node = this.scene.from(this.scene.root, path);
    return node ? [node] : [];
  }
}

function isAncestor(ancestor: SceneNode, node: SceneNode): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** A mouse or touch event as Godot's GUI receives it (the model event's routing fields). */
export interface GuiEvent {
  type: "mouse_button" | "mouse_motion" | "screen_touch" | "screen_drag";
  device: number;
  position: Vec;
  button?: number;
  pressed?: boolean;
  index?: number;
  meta?: TargetMeta | null;
}

/** viewport.cpp `_gui_input_event` routing to the test Controls' `_gui_input`, as `gui` lines. */
export class ModelGui {
  lines: string[] = [];
  private focus: SceneNode | null = null;
  private focusMask = 0;
  private inViewport = false;
  hovered: SceneNode | null = null;
  private readonly touchFocus = new Map<number, SceneNode>();

  constructor(private readonly scene: ModelScene) {
    scene.onFree = (node) => {
      if (this.focus === node) {
        this.focus = null;
        this.focusMask = 0;
      }
      if (this.hovered === node) this.hovered = null;
    };
  }

  dispatch(event: GuiEvent) {
    if (event.type === "mouse_button" || event.type === "mouse_motion")
      this.mouse(event);
    else this.touch(event);
  }

  private mouse(event: GuiEvent) {
    const pos = event.position;
    this.inViewport =
      pos[0] >= 0 && pos[1] >= 0 && pos[0] < VISIBLE && pos[1] < VISIBLE;
    this.hovered = this.inViewport ? this.scene.findControl(pos) : null;
    if (event.type === "mouse_button") {
      const bit = 1 << ((event.button ?? 1) - 1);
      if (event.pressed) {
        if (this.focusMask !== 0 && (this.focusMask & bit) === 0)
          this.focusMask |= bit;
        else {
          this.focus = this.scene.findControl(pos);
          if (!this.focus) return;
          this.focusMask |= bit;
        }
        this.send(this.focus, event);
      } else {
        this.focusMask &= ~bit;
        const focus = this.focus;
        if (!focus) return;
        if (this.focusMask === 0) this.focus = null;
        this.send(focus, event);
      }
      return;
    }
    const over =
      this.focus ?? (this.inViewport ? this.scene.findControl(pos) : null);
    if (over) this.send(over, event);
  }

  private touch(event: GuiEvent) {
    const index = event.index ?? 0;
    const alive = (n: SceneNode | undefined) => (n && !n.freed ? n : null);
    if (event.type === "screen_touch") {
      if (event.pressed) {
        const over = this.scene.findControl(event.position);
        if (over) {
          this.touchFocus.set(index, over);
          this.send(over, event);
        }
      } else {
        const over = alive(this.touchFocus.get(index));
        if (over) this.send(over, event);
        this.touchFocus.delete(index);
      }
      return;
    }
    const over =
      alive(this.touchFocus.get(index)) ??
      this.scene.findControl(event.position);
    if (over) this.send(over, event);
  }

  private send(control: SceneNode, event: GuiEvent) {
    const local = apply(invert(this.scene.xf(control)), event.position);
    const path = this.scene.pathOf(control);
    const what = event.pressed ? "down" : "up";
    let line: string;
    switch (event.type) {
      case "mouse_button":
        line = `${path} mouse_button ${event.device} ${event.button} ${what} ${xy(local)}`;
        break;
      case "mouse_motion":
        line = `${path} mouse_motion ${event.device} ${xy(local)}`;
        break;
      case "screen_touch":
        line = `${path} screen_touch ${event.index} ${what} ${xy(local)}`;
        break;
      default:
        line = `${path} screen_drag ${event.index} ${xy(local)}`;
    }
    const meta = event.meta;
    if (meta) line += ` meta=${meta.handle}:${meta.path}@${xy(meta.local)}`;
    this.lines.push(line);
  }
}
