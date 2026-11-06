// Test-only model of the GDScript reference injector (packages/input/godot/addons/gsw_input/
// gsw_input_injector.gd) and of the Godot `Input` state it drives, so the conformance/v1/injector
// vectors can be checked for self-consistency without Godot. Godot's runner
// (packages/input/godot/tests/injector_selftest.gd) checks the same vectors against real Input.
//
// It mirrors the injector rule for rule, in the same order (dispatch order is asserted): the
// session table, the two-level ledger, release-all, the gates, device leases (gsw_input_devices.gd),
// focus loss and the pointer half (gsw_input_pointer.gd: mouse ownership, per-source touch
// ranges). Input is modelled as the three key sets, the joypad button set and axis map (axes
// stored as float32, as Godot does), the test project's two actions
// (packages/input/godot/project.godot), whose joypad bindings GswJoypadIsolation can narrow, and
// the mouse: button mask, position, `emulate_mouse_from_touch` (core/input/input.cpp:840-893) and
// the buffer that accumulates consecutive motions and drags until the runner flushes
// (input.cpp:1229-1263). The IN12 target half, the test scene and Godot's GUI routing live in
// model-targets.ts.
import { parseInputMessage } from "../src/index";
import {
  type Binding,
  ModelGui,
  ModelScene,
  ModelTargets,
  type Placement,
  type SceneNode,
  type SceneNodeSpec,
  type TargetMeta,
} from "./model-targets";

type Json = Record<string, unknown>;

export interface InjectorConfig {
  accept_kinds?: string[];
  allowed_actions?: string[];
  device_base?: number;
  devices_per_source?: number;
  share_devices?: boolean;
  key_device?: number;
  lease_ms?: number;
  stale_timeout_ms?: number;
  reassert_on_focus_in?: boolean;
  max_events_per_second?: number;
  mouse_owner?: string;
  retarget?: string;
  missing_target?: string;
  verify_targets?: boolean;
  target_tolerance?: number;
}

export type InjectorStep =
  | { recv: Json | string; channel?: string; at?: number; result?: string }
  | { close: string; at?: number }
  | { tick: number }
  | { release_all: true }
  /** Godot's `Input.release_pressed_events()` (window focus-out), then `on_focus_lost()`. */
  | { focus_lost: true }
  | { reassert: true }
  /** `GswJoypadIsolation.isolate(devices)`; the runner restores the bindings after the vector. */
  | { isolate: number[] }
  /** Scene edits (IN12 target vectors): set a node's position, free it, add one, hide or show. */
  | { move: string; position: [number, number] }
  | { free: string }
  | { add: SceneNodeSpec }
  | { hide: string }
  | { show: string };

export interface InjectorExpect {
  after: number;
  physical_keys?: number[];
  keys?: number[];
  labels?: number[];
  joy_buttons?: [number, number][];
  joy_axes?: [number, number, number][];
  actions?: string[];
  mouse_mask?: number;
  /** Checked only where listed: Input keeps the mouse position across vectors. */
  mouse_position?: [number, number];
  dispatched?: string[];
  /** `remote_joypads()`. */
  joypads?: number[];
  /** `joypad_attached`/`joypad_detached` since the previous entry: `attached D source slot`. */
  joypad_signals?: string[];
  stats?: Record<string, number>;
  /** `_gui_input` of the scene's Controls since the previous entry (control-local positions). */
  gui?: string[];
  /** `pointer_target` / `target_missing` / `target_mismatch` since the previous entry. */
  target_signals?: string[];
}

export interface InjectorVector {
  name: string;
  description: string;
  config: InjectorConfig;
  /** Nodes created under the root before the first step, in order (IN12 target vectors). */
  scene?: SceneNodeSpec[];
  steps: InjectorStep[];
  expect: InjectorExpect[];
}

/** The state an expect entry compares, in the vectors' normal form (sorted, all fields present). */
export type InjectorState = Required<
  Omit<InjectorExpect, "after" | "mouse_position">
> & { mouse_position?: [number, number] };

const DEFAULT_ACCEPT_KINDS = [
  "key",
  "joypad_button",
  "joypad_motion",
  "mouse_button",
  "mouse_motion",
  "screen_touch",
  "screen_drag",
];
const POINTER_KINDS = [
  "mouse_button",
  "mouse_motion",
  "screen_touch",
  "screen_drag",
];
const INJECTED_KINDS = [
  "key",
  "joypad_button",
  "joypad_motion",
  ...POINTER_KINDS,
  "action",
];
const TOUCH_RANGE = 32;
const MOUSE_BUTTONS = 9;
const DEVICE_ID_EMULATION = -1;
const MAX_DEVICE = 2047;
const RATE_WINDOW_MS = 1000;
const ID_KEYCODE = 1 << 24;
const ID_LABEL = 2 << 24;
const BUTTON_BITS = 7;
const AXIS_BITS = 4;
/** project.godot: gsw_test_jump = joypad A (any device) + physical W; gsw_test_right = axis 0 +. */
const KEY_W = 87;
const DEADZONE = 0.5;

type Vec = [number, number];

/** A mouse or touch event as the injector builds it (the fields the vectors print). */
interface PointerEvent {
  type: "mouse_button" | "mouse_motion" | "screen_touch" | "screen_drag";
  device: number;
  position: Vec;
  button?: number;
  pressed?: boolean;
  mask?: number;
  factor?: number;
  canceled?: boolean;
  double?: boolean;
  index?: number;
  relative?: Vec;
  pressure?: number;
  tilt?: Vec;
  inverted?: boolean;
  mods?: Json;
  /** The `gsw_target` meta. */
  meta?: TargetMeta | null;
}

type Buffered =
  | { type: "key"; args: [number, number, number, boolean, boolean] }
  | { type: "button"; args: [number, number, boolean] }
  | { type: "axis"; args: [number, number, number] }
  | { type: "action"; args: [string, boolean, number] }
  | PointerEvent;

const f32 = (value: number) => Math.fround(value) + 0;
const vec = (value: unknown, fallback: Vec = [0, 0]): Vec =>
  Array.isArray(value) ? [f32(value[0]), f32(value[1])] : fallback;
const xy = ([x, y]: Vec) => `${(x + 0).toFixed(2)},${(y + 0).toFixed(2)}`;

/** Godot's Input, reduced to what the vectors observe. */
class ModelInput {
  physical = new Set<number>();
  keycodes = new Set<number>();
  labels = new Set<number>();
  buttons = new Set<string>();
  axes = new Map<string, number>();
  /** Actions pressed by InputEventAction (device key_device). */
  actionEvents = new Set<string>();
  mouseMask = 0;
  mousePosition: Vec = [0, 0];
  private mouseFromTouch = -1;
  private buffer: Buffered[] = [];
  dispatched: string[] = [];
  /** The devices GswJoypadIsolation narrowed the joypad bindings to; null = all devices. */
  isolated: number[] | null = null;
  /** Godot's GUI over the vector's scene (routes every dispatched mouse/touch event). */
  gui: ModelGui | null = null;

  /** `Input.release_pressed_events()`: state cleared, no events dispatched. */
  /** Input.release_pressed_events (input.cpp:1281-1295): the mouse mask is kept. */
  releasePressed() {
    this.flush();
    this.actionEvents.clear();
    this.physical.clear();
    this.keycodes.clear();
    this.labels.clear();
    this.buttons.clear();
    this.axes.clear();
  }

  key(
    physical: number,
    keycode: number,
    label: number,
    pressed: boolean,
    echo: boolean,
  ) {
    this.buffer.push({
      type: "key",
      args: [physical, keycode, label, pressed, echo],
    });
  }

  button(device: number, button: number, pressed: boolean) {
    this.buffer.push({ type: "button", args: [device, button, pressed] });
  }

  axis(device: number, axis: number, value: number) {
    this.buffer.push({ type: "axis", args: [device, axis, value] });
  }

  action(name: string, pressed: boolean, strength: number) {
    this.buffer.push({ type: "action", args: [name, pressed, strength] });
  }

  /** Input.parse_input_event: consecutive motions (same mask and modifiers) and drags (same
   * index) merge into the buffered one (InputEventMouseMotion/ScreenDrag::accumulate). */
  pointer(event: PointerEvent) {
    const last = this.buffer.at(-1);
    if (
      last &&
      last.type === event.type &&
      ((event.type === "mouse_motion" &&
        (last as PointerEvent).mask === event.mask &&
        sameMods((last as PointerEvent).mods, event.mods)) ||
        (event.type === "screen_drag" &&
          (last as PointerEvent).index === event.index))
    ) {
      const merged = last as PointerEvent;
      merged.position = event.position;
      const [rx, ry] = merged.relative ?? [0, 0];
      const [ex, ey] = event.relative ?? [0, 0];
      merged.relative = [f32(rx + ex), f32(ry + ey)];
      return;
    }
    this.buffer.push(event);
  }

  /** Input.flush_buffered_events: state changes, emulation and dispatch, in order. */
  flush() {
    const pending = this.buffer;
    this.buffer = [];
    for (const event of pending) {
      if (event.type === "key") this.applyKey(...event.args);
      else if (event.type === "button") this.applyButton(...event.args);
      else if (event.type === "axis") this.applyAxis(...event.args);
      else if (event.type === "action") this.applyAction(...event.args);
      else this.applyPointer(event);
    }
  }

  private applyKey(
    physical: number,
    keycode: number,
    label: number,
    pressed: boolean,
    echo: boolean,
  ) {
    if (!echo)
      for (const [set, code] of [
        [this.physical, physical],
        [this.keycodes, keycode],
        [this.labels, label],
      ] as const)
        if (code !== 0) {
          if (pressed) set.add(code);
          else set.delete(code);
        }
    const what = echo ? "echo" : pressed ? "down" : "up";
    this.dispatched.push(`key ${physical}/${keycode}/${label} ${what}`);
  }

  private applyButton(device: number, button: number, pressed: boolean) {
    const id = `${device}:${button}`;
    if (pressed) this.buttons.add(id);
    else this.buttons.delete(id);
    this.dispatched.push(
      `joy_button ${device} ${button} ${pressed ? "down" : "up"}`,
    );
  }

  private applyAxis(device: number, axis: number, value: number) {
    // InputEventJoypadMotion.axis_value is a C++ float.
    const stored = f32(value);
    const id = `${device}:${axis}`;
    if (stored === 0) this.axes.delete(id);
    else this.axes.set(id, stored);
    this.dispatched.push(`joy_motion ${device} ${axis} ${stored.toFixed(4)}`);
  }

  private applyAction(name: string, pressed: boolean, strength: number) {
    if (pressed) this.actionEvents.add(name);
    else this.actionEvents.delete(name);
    const shown = f32(strength).toFixed(2);
    this.dispatched.push(`action ${name} ${pressed ? "down" : "up"} ${shown}`);
  }

  private applyPointer(event: PointerEvent) {
    if (event.type === "mouse_button") {
      const bit = 1 << ((event.button ?? 1) - 1);
      if (event.pressed) this.mouseMask |= bit;
      else this.mouseMask &= ~bit;
      this.mousePosition = event.position;
    } else if (event.type === "mouse_motion")
      this.mousePosition = event.position;
    else if (event.type === "screen_touch") {
      let translate = false;
      if (event.pressed && this.mouseFromTouch === -1) {
        translate = true;
        this.mouseFromTouch = event.index ?? 0;
      } else if (!event.pressed && event.index === this.mouseFromTouch) {
        translate = true;
        this.mouseFromTouch = -1;
      }
      if (translate) {
        const mask = event.pressed ? this.mouseMask | 1 : this.mouseMask & ~1;
        this.applyPointer({
          type: "mouse_button",
          device: DEVICE_ID_EMULATION,
          position: event.position,
          button: 1,
          pressed: event.pressed,
          mask,
          canceled: event.canceled,
          double: event.double,
        });
      }
    } else if (event.index === this.mouseFromTouch)
      this.applyPointer({
        type: "mouse_motion",
        device: DEVICE_ID_EMULATION,
        position: event.position,
        relative: event.relative,
        mask: this.mouseMask,
        pressure: event.pressure,
        tilt: event.tilt,
        inverted: event.inverted,
      });
    this.dispatched.push(describePointer(event));
    this.gui?.dispatch(event);
  }

  state(): Omit<InjectorState, "stats" | "joypads" | "joypad_signals"> {
    const numeric = (a: number, b: number) => a - b;
    const pair = (id: string) => id.split(":").map(Number);
    const buttons = [...this.buttons]
      .map(pair)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]) as [number, number][];
    const axes = [...this.axes]
      .map(([id, value]) => [...pair(id), value])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]) as [number, number, number][];
    const actions: string[] = [];
    const bound = (device: number) =>
      this.isolated === null || this.isolated.includes(device);
    if (
      this.physical.has(KEY_W) ||
      buttons.some(([device, button]) => button === 0 && bound(device)) ||
      this.actionEvents.has("gsw_test_jump")
    )
      actions.push("gsw_test_jump");
    if (
      axes.some(
        ([device, axis, value]) =>
          axis === 0 && value >= DEADZONE && bound(device),
      ) ||
      this.actionEvents.has("gsw_test_right")
    )
      actions.push("gsw_test_right");
    const dispatched = this.dispatched;
    this.dispatched = [];
    return {
      physical_keys: [...this.physical].sort(numeric),
      keys: [...this.keycodes].sort(numeric),
      labels: [...this.labels].sort(numeric),
      joy_buttons: buttons,
      joy_axes: axes,
      actions,
      mouse_mask: this.mouseMask,
      mouse_position: this.mousePosition,
      dispatched,
    };
  }
}

function sameMods(a: Json | undefined, b: Json | undefined): boolean {
  return ["shift_pressed", "ctrl_pressed", "alt_pressed", "meta_pressed"].every(
    (field) => (a?.[field] === true) === (b?.[field] === true),
  );
}

/** The selftest's `dispatched` notation (injector_selftest.gd Probe.describe). */
function describePointerEvent(event: PointerEvent): string {
  const pen = () =>
    (event.pressure ? ` pressure=${f32(event.pressure).toFixed(2)}` : "") +
    (event.tilt && (event.tilt[0] !== 0 || event.tilt[1] !== 0)
      ? ` tilt=${xy(event.tilt)}`
      : "") +
    (event.inverted ? " inverted" : "");
  const mods = () =>
    ["shift", "ctrl", "alt", "meta"]
      .filter((name) => event.mods?.[`${name}_pressed`] === true)
      .map((name) => ` +${name}`)
      .join("");
  const what = event.pressed ? "down" : "up";
  const relative = xy(event.relative ?? [0, 0]);
  switch (event.type) {
    case "mouse_button":
      return (
        `mouse_button ${event.device} ${event.button} ${what} ${xy(event.position)} mask=${event.mask ?? 0}` +
        (event.factor !== undefined && f32(event.factor) !== 1
          ? ` factor=${f32(event.factor).toFixed(2)}`
          : "") +
        (event.canceled ? " canceled" : "") +
        (event.double ? " double" : "") +
        mods()
      );
    case "mouse_motion":
      return `mouse_motion ${event.device} ${xy(event.position)} rel=${relative} mask=${event.mask ?? 0}${pen()}${mods()}`;
    case "screen_touch":
      return (
        `screen_touch ${event.device} ${event.index} ${what} ${xy(event.position)}` +
        (event.canceled ? " canceled" : "") +
        (event.double ? " double" : "")
      );
    case "screen_drag":
      return `screen_drag ${event.device} ${event.index} ${xy(event.position)} rel=${relative}${pen()}`;
  }
}

/** The selftest's `dispatched` notation, with the ` meta=<handle>` suffix of a tagged event. */
function describePointer(event: PointerEvent): string {
  const line = describePointerEvent(event);
  return event.meta ? `${line} meta=${event.meta.handle}` : line;
}

/** A source's target tables, as the injector passes them to the pointer. */
interface TargetTables {
  handles: Map<number, Json>;
  resolved: Map<number, SceneNode[]>;
}

const NO_TABLES: TargetTables = { handles: new Map(), resolved: new Map() };

/** The pointer half, rule for rule as gsw_input_pointer.gd. */
class ModelPointer {
  mouseOwner = "last-active";
  owner = "";
  targets: ModelTargets | null = null;
  private held = 0;
  private heldDevice = 0;
  private position: Vec = [0, 0];
  /** source -> host touch index -> [position, device, binding], in press order. */
  private readonly touches = new Map<
    string,
    Map<number, [Vec, number, Binding | null]>
  >();
  private mouseBinding: Binding | null = null;

  constructor(
    private readonly input: ModelInput,
    private readonly count: (code: string, n?: number) => void,
  ) {}

  apply(
    source: string,
    device: number,
    touchBase: number,
    record: Json,
    tables: TargetTables = NO_TABLES,
  ) {
    switch (record.event) {
      case "mouse_button":
        if (this.take(source, device, record.pressed === true))
          this.mouseButton(device, record, source, tables);
        else this.count("mouse-not-owner");
        break;
      case "mouse_motion":
        if (this.take(source, device, false))
          this.mouseMotion(device, record, source, tables);
        else this.count("mouse-not-owner");
        break;
      case "screen_touch":
        this.screenTouch(source, device, touchBase, record, tables);
        break;
      case "screen_drag":
        this.screenDrag(source, device, touchBase, record, tables);
        break;
    }
  }

  sync(
    source: string,
    device: number,
    touchBase: number,
    held: Json[],
    tables: TargetTables = NO_TABLES,
  ) {
    const buttons = new Map<number, Json>();
    let motion: Json | null = null;
    const touches = new Map<number, Json>();
    for (const record of held)
      if (record.event === "mouse_button")
        buttons.set(record.button_index as number, record);
      else if (record.event === "mouse_motion") motion = record;
      else if (record.event === "screen_touch")
        touches.set(touchBase + num(record, "index"), record);
    const listed = buttons.size + (motion ? 1 : 0);
    if (listed > 0 && !this.take(source, device, buttons.size > 0))
      this.count("mouse-not-owner", listed);
    else if (this.owner === source) {
      for (let button = 1; button <= MOUSE_BUTTONS; button++)
        if (this.held & bit(button) && !buttons.has(button))
          this.releaseButton(button);
      if (motion) this.mouseMotion(device, motion, source, tables);
      for (let button = 1; button <= MOUSE_BUTTONS; button++) {
        const record = buttons.get(button);
        if (record && !(this.held & bit(button)))
          this.mouseButton(device, record, source, tables);
      }
    }
    const heldTouches = this.touches.get(source) ?? new Map();
    for (const index of [...heldTouches.keys()])
      if (!touches.has(index)) this.cancelTouch(source, index);
    for (const [index, record] of touches)
      if (!heldTouches.has(index))
        this.screenTouch(source, device, touchBase, record, tables);
  }

  release(source: string) {
    if (this.owner === source) this.releaseHeld();
    for (const index of [...(this.touches.get(source)?.keys() ?? [])])
      this.cancelTouch(source, index);
    this.touches.delete(source);
  }

  close(source: string) {
    this.release(source);
    if (this.owner === source) this.owner = "";
  }

  private take(source: string, device: number, press: boolean): boolean {
    if (this.owner === source) return true;
    const allowed =
      this.mouseOwner === "last-active"
        ? this.owner === "" || press
        : this.mouseOwner === "first"
          ? this.owner === ""
          : source === this.mouseOwner;
    if (!allowed) return false;
    this.releaseHeld();
    this.owner = source;
    this.heldDevice = device;
    return true;
  }

  /** gsw_input_pointer.gd `_place`: null when the record names no target and nothing is bound. */
  private place(
    source: string,
    tables: TargetTables,
    record: Json,
    position: Vec,
    binding: Binding | null,
    release: boolean,
  ): Placement | null {
    if (!this.targets || (!binding && num(record, "target") === 0)) return null;
    const placement = this.targets.place(
      source,
      tables.handles,
      tables.resolved,
      record,
      position,
      binding,
      release,
    );
    if (placement.drop) this.count("target-dropped");
    return placement;
  }

  private tag(source: string, mouse: boolean, placement: Placement | null) {
    return placement ? this.targets?.tag(source, mouse, placement) : null;
  }

  private mouseButton(
    device: number,
    record: Json,
    source = "",
    tables: TargetTables = NO_TABLES,
  ) {
    const button = record.button_index as number;
    const pressed = record.pressed === true;
    if (pressed === ((this.held & bit(button)) !== 0)) {
      this.count(pressed ? "repeat" : "unheld");
      return;
    }
    let position = vec(record.position);
    const placement = this.place(
      source,
      tables,
      record,
      position,
      this.mouseBinding,
      !pressed,
    );
    if (placement) {
      if (placement.drop) return;
      position = placement.position;
      if (pressed && this.held === 0) this.mouseBinding = placement.binding;
    }
    if (pressed) this.held |= bit(button);
    else {
      this.held &= ~bit(button);
      if (this.held === 0) this.mouseBinding = null;
    }
    this.heldDevice = device;
    this.position = position;
    this.input.pointer({
      type: "mouse_button",
      device,
      position: this.position,
      button,
      pressed,
      mask: this.held,
      factor: num(record, "factor", 1),
      canceled: record.canceled === true,
      double: record.double_click === true,
      mods: record,
      meta: this.tag(source, true, placement),
    });
  }

  private mouseMotion(
    device: number,
    record: Json,
    source = "",
    tables: TargetTables = NO_TABLES,
  ) {
    let position = vec(record.position);
    const placement = this.place(
      source,
      tables,
      record,
      position,
      this.mouseBinding,
      false,
    );
    if (placement) {
      if (placement.drop) return;
      position = placement.position;
    }
    this.position = position;
    this.input.pointer({
      type: "mouse_motion",
      device,
      position: this.position,
      relative: vec(record.relative),
      mask: this.held,
      pressure: num(record, "pressure"),
      tilt: vec(record.tilt),
      inverted: record.pen_inverted === true,
      mods: record,
      meta: this.tag(source, true, placement),
    });
  }

  private releaseHeld() {
    for (let button = 1; button <= MOUSE_BUTTONS; button++)
      if (this.held & bit(button)) this.releaseButton(button);
  }

  private releaseButton(button: number) {
    this.held &= ~bit(button);
    if (this.held === 0) this.mouseBinding = null;
    this.input.pointer({
      type: "mouse_button",
      device: this.heldDevice,
      position: this.position,
      button,
      pressed: false,
      mask: this.held,
      canceled: true,
    });
  }

  private screenTouch(
    source: string,
    device: number,
    touchBase: number,
    record: Json,
    tables: TargetTables = NO_TABLES,
  ) {
    const index = touchBase + num(record, "index");
    const pressed = record.pressed === true;
    const held =
      this.touches.get(source) ??
      new Map<number, [Vec, number, Binding | null]>();
    if (pressed === held.has(index)) {
      this.count(pressed ? "repeat" : "unheld");
      return;
    }
    let position = vec(record.position);
    let binding: Binding | null = pressed
      ? null
      : (held.get(index)?.[2] ?? null);
    const placement = this.place(
      source,
      tables,
      record,
      position,
      binding,
      !pressed,
    );
    if (placement) {
      if (placement.drop) return;
      position = placement.position;
      if (pressed) binding = placement.binding;
    }
    if (pressed) {
      held.set(index, [position, device, binding]);
      this.touches.set(source, held);
    } else held.delete(index);
    this.input.pointer({
      type: "screen_touch",
      device,
      index,
      pressed,
      position,
      canceled: record.canceled === true,
      double: record.double_tap === true,
      meta: this.tag(source, false, placement),
    });
  }

  private screenDrag(
    source: string,
    device: number,
    touchBase: number,
    record: Json,
    tables: TargetTables = NO_TABLES,
  ) {
    const index = touchBase + num(record, "index");
    const held = this.touches.get(source);
    const entry = held?.get(index);
    if (!held || !entry) {
      this.count("unheld");
      return;
    }
    let position = vec(record.position);
    const binding = entry[2];
    const placement = this.place(
      source,
      tables,
      record,
      position,
      binding,
      false,
    );
    if (placement) {
      if (placement.drop) return;
      position = placement.position;
    }
    held.set(index, [position, device, binding]);
    this.input.pointer({
      type: "screen_drag",
      device,
      index,
      position,
      relative: vec(record.relative),
      pressure: num(record, "pressure"),
      tilt: vec(record.tilt),
      inverted: record.pen_inverted === true,
      meta: this.tag(source, false, placement),
    });
  }

  private cancelTouch(source: string, index: number) {
    const held = this.touches.get(source);
    const entry = held?.get(index);
    if (!held || !entry) return;
    held.delete(index);
    this.input.pointer({
      type: "screen_touch",
      device: entry[1],
      index,
      pressed: false,
      canceled: true,
      position: entry[0],
    });
  }
}

const bit = (button: number) => 1 << (button - 1);

interface Source {
  id: string;
  channel: string | null;
  open: boolean;
  epoch: number;
  lastSeq: number;
  lastMsec: number;
  stale: boolean;
  keys: Map<number, Json>;
  buttons: Set<number>;
  axes: Map<number, number>;
  /** action name -> press strength, in press order. */
  actions: Map<string, number>;
  handles: Map<number, Json>;
  resolved: Map<number, SceneNode[]>;
  rateStart: number;
  rateCount: number;
  leaseUntil: number;
  lostKeys: Map<number, Json>;
  lostButtons: Set<number>;
  lostAxes: Map<number, number>;
  lostActions: Map<string, number>;
  touchRange: number;
}

/** gsw_input_devices.gd: lease blocks and attached virtual devices. */
class ModelDevices {
  deviceBase = 64;
  devicesPerSource = 4;
  shareDevices = false;
  signals: string[] = [];
  private readonly blocks = new Map<number, string>();
  private readonly blockOf = new Map<string, number>();
  private readonly slots = new Map<string, Map<number, number>>();
  private readonly users = new Map<number, string[]>();

  acquire(source: string, slot: number): number {
    if (slot < 0 || slot >= this.devicesPerSource) return -1;
    const slots = this.slots.get(source) ?? new Map<number, number>();
    const known = slots.get(slot);
    if (known !== undefined) return known;
    let device = this.deviceBase + slot;
    if (!this.shareDevices) {
      let block = this.blockOf.get(source) ?? -1;
      if (block < 0) {
        block = this.freeBlock();
        if (block < 0) return -1;
        this.blocks.set(block, source);
        this.blockOf.set(source, block);
      }
      device += block * this.devicesPerSource;
    }
    if (device < 0 || device > MAX_DEVICE) return -1;
    slots.set(slot, device);
    this.slots.set(source, slots);
    const users = this.users.get(device) ?? [];
    users.push(source);
    this.users.set(device, users);
    if (users.length === 1)
      this.signals.push(`attached ${device} ${source} ${slot}`);
    return device;
  }

  blockDevice(source: string): number {
    let device = this.deviceBase;
    if (!this.shareDevices) {
      let block = this.blockOf.get(source) ?? -1;
      if (block < 0) {
        block = this.freeBlock();
        if (block < 0) return -1;
        this.blocks.set(block, source);
        this.blockOf.set(source, block);
      }
      device += block * this.devicesPerSource;
    }
    return device >= 0 && device <= MAX_DEVICE ? device : -1;
  }

  release(source: string) {
    const slots = this.slots.get(source) ?? new Map<number, number>();
    for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
      const device = slots.get(slot) as number;
      const users = (this.users.get(device) ?? []).filter((u) => u !== source);
      if (users.length === 0) {
        this.users.delete(device);
        this.signals.push(`detached ${device} ${source} ${slot}`);
      } else this.users.set(device, users);
    }
    this.slots.delete(source);
    const block = this.blockOf.get(source);
    if (block !== undefined) {
      this.blocks.delete(block);
      this.blockOf.delete(source);
    }
  }

  attached(): number[] {
    return [...this.users.keys()].sort((a, b) => a - b);
  }

  private freeBlock(): number {
    const per = this.devicesPerSource;
    for (
      let block = 0;
      this.deviceBase + block * per + per - 1 <= MAX_DEVICE;
      block++
    )
      if (!this.blocks.has(block)) return block;
    return -1;
  }
}

const num = (record: Json, field: string, fallback = 0): number =>
  (record[field] as number | undefined) ?? fallback;

/** The injector, rule for rule as gsw_input_injector.gd. */
export class ModelInjector {
  readonly input = new ModelInput();
  readonly devices = new ModelDevices();
  acceptKinds = DEFAULT_ACCEPT_KINDS;
  allowedActions: string[] = [];
  leaseMs = 30000;
  staleTimeoutMs = 0;
  maxEventsPerSecond = 2000;

  private readonly sources = new Map<string, Source>();
  private readonly byChannel = new Map<string, Source>();
  private readonly keyRefs = new Map<string, number>();
  private readonly buttonRefs = new Map<number, number>();
  private readonly axisHolders = new Map<number, Map<string, number>>();
  private readonly axisEmitted = new Map<number, number>();
  private readonly actionRefs = new Map<string, number>();
  private readonly counters = new Map<string, number>();
  private readonly pointer = new ModelPointer(this.input, (code, n) =>
    this.count(code, n),
  );
  readonly scene = new ModelScene();
  readonly targets = new ModelTargets(this.scene, (code) => this.count(code));

  constructor(config: InjectorConfig = {}) {
    this.pointer.targets = this.targets;
    this.targets.configure(config);
    this.input.gui = new ModelGui(this.scene);
    if (config.accept_kinds) this.acceptKinds = config.accept_kinds;
    if (config.allowed_actions) this.allowedActions = config.allowed_actions;
    const devices = this.devices;
    devices.deviceBase = config.device_base ?? devices.deviceBase;
    devices.devicesPerSource =
      config.devices_per_source ?? devices.devicesPerSource;
    devices.shareDevices = config.share_devices ?? devices.shareDevices;
    this.leaseMs = config.lease_ms ?? this.leaseMs;
    this.staleTimeoutMs = config.stale_timeout_ms ?? this.staleTimeoutMs;
    this.maxEventsPerSecond =
      config.max_events_per_second ?? this.maxEventsPerSecond;
    this.pointer.mouseOwner = config.mouse_owner ?? "last-active";
  }

  stats(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  remoteJoypads(): number[] {
    return this.devices.attached();
  }

  pointerDeviceFor(source: string): number {
    return this.devices.blockDevice(source);
  }

  touchIndexBase(source: string): number {
    return (this.sources.get(source)?.touchRange ?? 0) * TOUCH_RANGE;
  }

  private freeTouchRange(): number {
    const used = new Set([...this.sources.values()].map((s) => s.touchRange));
    let range = 0;
    while (used.has(range)) range++;
    return range;
  }

  receive(channel: string, text: string, now: number): string {
    const result = parseInputMessage(text);
    if (!result.ok) {
      this.count(result.code);
      return result.code;
    }
    if (result.skipped > 0) this.count("skipped", result.skipped);
    const message = result.message as unknown as Json;
    if (message.type === "hello") return this.hello(channel, message, now);
    const source = this.byChannel.get(channel);
    if (!source) return this.drop("no-hello");
    if (message.epoch !== source.epoch) return this.drop("stale-epoch");
    const seq = message.seq as number;
    if (seq <= source.lastSeq) return this.drop("duplicate");
    if (seq > source.lastSeq + 1) this.count("gap");
    source.lastSeq = seq;
    source.lastMsec = now;
    source.stale = false;
    switch (message.type) {
      case "events":
        return this.applyEvents(source, message.events as Json[], now);
      case "sync":
        this.applySync(source, message);
        break;
      case "reset":
        this.releaseSource(source);
        break;
      case "bye":
        this.closeSource(source, now);
        break;
    }
    return "";
  }

  closeChannel(channel: string, now: number) {
    const source = this.byChannel.get(channel);
    if (source) this.closeSource(source, now);
  }

  releaseAll() {
    for (const source of this.sources.values()) this.releaseSource(source);
  }

  tick(now: number) {
    this.expireLeases(now);
    if (this.targets.verifyTargets)
      this.targets.verify(this.input.gui?.hovered ?? null);
    if (this.staleTimeoutMs <= 0) return;
    for (const source of this.sources.values())
      if (
        source.open &&
        !source.stale &&
        now - source.lastMsec >= this.staleTimeoutMs
      ) {
        source.stale = true;
        this.count("stale-timeout");
        this.releaseSource(source);
      }
  }

  private count(code: string, n = 1) {
    this.counters.set(code, (this.counters.get(code) ?? 0) + n);
  }

  private drop(code: string): string {
    this.count(code);
    return code;
  }

  private hello(channel: string, message: Json, now: number): string {
    const id = message.source as string;
    const epoch = message.epoch as number;
    this.expireLeases(now);
    let source = this.sources.get(id);
    if (!source) {
      source = {
        id,
        channel: null,
        open: false,
        epoch: -1,
        lastSeq: 0,
        lastMsec: 0,
        stale: false,
        keys: new Map(),
        buttons: new Set(),
        axes: new Map(),
        actions: new Map(),
        handles: new Map(),
        resolved: new Map(),
        rateStart: 0,
        rateCount: 0,
        leaseUntil: -1,
        lostKeys: new Map(),
        lostButtons: new Set(),
        lostAxes: new Map(),
        lostActions: new Map(),
        touchRange: this.freeTouchRange(),
      };
      this.sources.set(id, source);
    } else if (source.open && source.epoch === epoch)
      return this.drop("duplicate");
    const bound = this.byChannel.get(channel);
    if (bound && bound !== source) this.closeSource(bound, now);
    if (source.open) {
      this.releaseSource(source);
      source.handles.clear();
      source.resolved.clear();
      if (source.channel !== null) this.byChannel.delete(source.channel);
    }
    source.open = true;
    source.leaseUntil = -1;
    source.epoch = epoch;
    source.lastSeq = num(message, "seq");
    source.lastMsec = now;
    source.stale = false;
    source.rateStart = now;
    source.rateCount = 0;
    source.channel = channel;
    this.byChannel.set(channel, source);
    return "";
  }

  private closeSource(source: Source, now: number) {
    this.releaseSource(source);
    this.pointer.close(source.id);
    source.open = false;
    source.epoch = -1;
    source.handles.clear();
    source.resolved.clear();
    if (source.channel !== null) this.byChannel.delete(source.channel);
    source.channel = null;
    source.leaseUntil = now + this.leaseMs;
    if (this.leaseMs <= 0) this.forget(source);
  }

  private expireLeases(now: number) {
    const ended = [...this.sources.values()].filter(
      (source) =>
        !source.open && source.leaseUntil >= 0 && now >= source.leaseUntil,
    );
    for (const source of ended) this.forget(source);
  }

  private forget(source: Source) {
    this.sources.delete(source.id);
    this.devices.release(source.id);
  }

  onFocusLost() {
    for (const source of this.sources.values()) {
      for (const [id, record] of source.keys) source.lostKeys.set(id, record);
      for (const key of source.buttons) source.lostButtons.add(key);
      for (const [key, value] of source.axes) source.lostAxes.set(key, value);
      for (const [name, value] of source.actions)
        source.lostActions.set(name, value);
      source.keys.clear();
      source.buttons.clear();
      source.axes.clear();
      source.actions.clear();
    }
    this.keyRefs.clear();
    this.actionRefs.clear();
    this.buttonRefs.clear();
    this.axisHolders.clear();
    this.axisEmitted.clear();
  }

  reassert() {
    for (const source of this.sources.values()) {
      for (const [id, record] of source.lostKeys)
        if (!source.keys.has(id)) {
          source.keys.set(id, record);
          this.pressKey(record);
        }
      for (const [name, strength] of source.lostActions)
        if (!source.actions.has(name)) this.pressAction(source, name, strength);
      for (const key of source.lostButtons)
        if (!source.buttons.has(key)) this.pressButton(source, key);
      for (const [key, value] of source.lostAxes)
        this.setAxis(source, key, value);
      source.lostKeys.clear();
      source.lostActions.clear();
      source.lostButtons.clear();
      source.lostAxes.clear();
    }
  }

  private applyEvents(source: Source, records: Json[], now: number): string {
    if (this.maxEventsPerSecond > 0) {
      if (now - source.rateStart >= RATE_WINDOW_MS || now < source.rateStart) {
        source.rateStart = now;
        source.rateCount = 0;
      }
      if (source.rateCount + records.length > this.maxEventsPerSecond) {
        this.count("rate");
        for (const record of records)
          if (isRelease(record)) this.applyRecord(source, record);
        return "rate";
      }
      source.rateCount += records.length;
    }
    for (const record of records) this.applyRecord(source, record);
    return "";
  }

  private admit(source: Source, record: Json): boolean {
    const kind = record.event as string;
    if (kind === "target") {
      source.handles.set(record.handle as number, record);
      source.resolved.delete(record.handle as number);
      return false;
    }
    if (!this.acceptKinds.includes(kind)) {
      this.count("kind-refused");
      return false;
    }
    if (kind === "action") {
      if (!this.allowedActions.includes(record.action as string)) {
        this.count("action-refused");
        return false;
      }
    } else if (POINTER_KINDS.includes(kind)) {
      const handle = num(record, "target");
      if (handle !== 0 && !source.handles.has(handle))
        this.count("undeclared-target");
    }
    if (!INJECTED_KINDS.includes(kind)) {
      this.count("kind-unsupported");
      return false;
    }
    return true;
  }

  private applyRecord(source: Source, record: Json) {
    if (!this.admit(source, record)) return;
    if (record.event === "key") this.key(source, record);
    else if (record.event === "joypad_button")
      this.joypadButton(source, record);
    else if (record.event === "joypad_motion")
      this.joypadMotion(source, record);
    else if (record.event === "action") this.action(source, record);
    else {
      const device = this.pointerDeviceFor(source.id);
      if (device < 0) this.count("device-refused");
      else
        this.pointer.apply(
          source.id,
          device,
          this.touchIndexBase(source.id),
          record,
          source,
        );
    }
  }

  private action(source: Source, record: Json) {
    const action = record.action as string;
    const pressed = record.pressed === true;
    if (source.lostActions.delete(action) && !pressed) return;
    if (pressed === source.actions.has(action)) {
      this.count(pressed ? "repeat" : "unheld");
      return;
    }
    if (pressed) this.pressAction(source, action, num(record, "strength", 1));
    else this.releaseAction(source, action);
  }

  private pressAction(source: Source, action: string, strength: number) {
    source.actions.set(action, strength);
    const count = this.actionRefs.get(action) ?? 0;
    this.actionRefs.set(action, count + 1);
    if (count === 0) this.input.action(action, true, strength);
  }

  private releaseAction(source: Source, action: string) {
    source.actions.delete(action);
    const count = (this.actionRefs.get(action) ?? 0) - 1;
    if (count > 0) {
      this.actionRefs.set(action, count);
      return;
    }
    this.actionRefs.delete(action);
    this.input.action(action, false, 0);
  }

  private key(source: Source, record: Json) {
    const id = keyIdentity(record);
    const echo = record.pressed === true && record.echo === true;
    if (!echo && takeLost(source.lostKeys, id, record.pressed === true)) return;
    if (echo) {
      if (!source.keys.has(id)) {
        this.count("unheld");
        return;
      }
      this.input.key(
        num(record, "physical_keycode"),
        num(record, "keycode"),
        num(record, "key_label"),
        true,
        true,
      );
      return;
    }
    if (record.pressed === true) {
      if (source.keys.has(id)) {
        this.count("repeat");
        return;
      }
      source.keys.set(id, record);
      this.pressKey(record);
      return;
    }
    const held = source.keys.get(id);
    if (!held) {
      this.count("unheld");
      return;
    }
    source.keys.delete(id);
    this.releaseKey(held);
  }

  private refKey(prefix: string, code: number): number {
    if (code === 0) return 0;
    const entry = prefix + code;
    const count = (this.keyRefs.get(entry) ?? 0) + 1;
    this.keyRefs.set(entry, count);
    return count === 1 ? code : 0;
  }

  private unrefKey(prefix: string, code: number): number {
    if (code === 0) return 0;
    const entry = prefix + code;
    const count = (this.keyRefs.get(entry) ?? 0) - 1;
    if (count > 0) {
      this.keyRefs.set(entry, count);
      return 0;
    }
    this.keyRefs.delete(entry);
    return code;
  }

  private pressKey(record: Json) {
    const physical = this.refKey("p", num(record, "physical_keycode"));
    const keycode = this.refKey("k", num(record, "keycode"));
    const label = this.refKey("l", num(record, "key_label"));
    if (physical || keycode || label)
      this.input.key(physical, keycode, label, true, false);
  }

  private releaseKey(held: Json) {
    const physical = this.unrefKey("p", num(held, "physical_keycode"));
    const keycode = this.unrefKey("k", num(held, "keycode"));
    const label = this.unrefKey("l", num(held, "key_label"));
    if (physical || keycode || label)
      this.input.key(physical, keycode, label, false, false);
  }

  private joypadButton(source: Source, record: Json) {
    const device = this.devices.acquire(source.id, num(record, "device"));
    if (device < 0) {
      this.count("device-refused");
      return;
    }
    const key = (device << BUTTON_BITS) | num(record, "button_index");
    if (takeLost(source.lostButtons, key, record.pressed === true)) return;
    if (record.pressed === true) {
      if (source.buttons.has(key)) this.count("repeat");
      else this.pressButton(source, key);
    } else if (!source.buttons.has(key)) this.count("unheld");
    else this.releaseButton(source, key);
  }

  private pressButton(source: Source, key: number) {
    source.buttons.add(key);
    const count = (this.buttonRefs.get(key) ?? 0) + 1;
    this.buttonRefs.set(key, count);
    if (count === 1) this.emitButton(key, true);
  }

  private releaseButton(source: Source, key: number) {
    source.buttons.delete(key);
    const count = (this.buttonRefs.get(key) ?? 0) - 1;
    if (count > 0) {
      this.buttonRefs.set(key, count);
      return;
    }
    this.buttonRefs.delete(key);
    this.emitButton(key, false);
  }

  private emitButton(key: number, pressed: boolean) {
    this.input.button(
      key >> BUTTON_BITS,
      key & ((1 << BUTTON_BITS) - 1),
      pressed,
    );
  }

  private joypadMotion(source: Source, record: Json) {
    const device = this.devices.acquire(source.id, num(record, "device"));
    if (device < 0) {
      this.count("device-refused");
      return;
    }
    const key = (device << AXIS_BITS) | num(record, "axis");
    source.lostAxes.delete(key);
    this.setAxis(source, key, num(record, "axis_value") + 0);
  }

  private setAxis(source: Source, key: number, value: number) {
    const holders = this.axisHolders.get(key) ?? new Map<string, number>();
    let target = value;
    if (value !== 0) {
      source.axes.set(key, value);
      holders.set(source.id, value);
    } else {
      source.axes.delete(key);
      holders.delete(source.id);
      for (const other of holders.values())
        if (Math.abs(other) > Math.abs(target)) target = other;
    }
    if (holders.size === 0) this.axisHolders.delete(key);
    else this.axisHolders.set(key, holders);
    const emitted = this.axisEmitted.get(key) ?? 0;
    if (target === emitted) return;
    if (target === 0) this.axisEmitted.delete(key);
    else this.axisEmitted.set(key, target);
    this.input.axis(key >> AXIS_BITS, key & ((1 << AXIS_BITS) - 1), target);
  }

  private applySync(source: Source, message: Json) {
    const held = message.held as Json[];
    if (message.scope === "keyboard") {
      source.lostKeys.clear();
      const listed = new Map<number, Json>();
      for (const record of held)
        if (this.admit(source, record)) listed.set(keyIdentity(record), record);
      for (const [id, press] of [...source.keys])
        if (!listed.has(id)) {
          source.keys.delete(id);
          this.releaseKey(press);
        }
      for (const [id, record] of listed)
        if (!source.keys.has(id)) {
          source.keys.set(id, record);
          this.pressKey(record);
        }
    } else if (message.scope === "joypad") {
      const device = this.devices.acquire(source.id, message.device as number);
      if (device < 0) {
        this.count("device-refused");
        return;
      }
      for (const key of [...source.lostButtons])
        if (key >> BUTTON_BITS === device) source.lostButtons.delete(key);
      for (const key of [...source.lostAxes.keys()])
        if (key >> AXIS_BITS === device) source.lostAxes.delete(key);
      const buttons = new Set<number>();
      const axes = new Map<number, number>();
      for (const record of held) {
        if (!this.admit(source, record)) continue;
        if (record.event === "joypad_button")
          buttons.add((device << BUTTON_BITS) | num(record, "button_index"));
        else {
          const key = (device << AXIS_BITS) | num(record, "axis");
          const value = num(record, "axis_value");
          axes.delete(key);
          if (value !== 0) axes.set(key, value + 0);
        }
      }
      for (const key of [...source.buttons])
        if (key >> BUTTON_BITS === device && !buttons.has(key))
          this.releaseButton(source, key);
      for (const key of [...source.axes.keys()])
        if (key >> AXIS_BITS === device && !axes.has(key))
          this.setAxis(source, key, 0);
      for (const key of buttons)
        if (!source.buttons.has(key)) this.pressButton(source, key);
      for (const [key, value] of axes) this.setAxis(source, key, value);
    } else {
      const records = held.filter((record) => this.admit(source, record));
      const device = this.pointerDeviceFor(source.id);
      if (device < 0) {
        if (records.length > 0) this.count("device-refused");
        return;
      }
      this.pointer.sync(
        source.id,
        device,
        this.touchIndexBase(source.id),
        records,
        source,
      );
    }
  }

  private releaseSource(source: Source) {
    source.lostKeys.clear();
    source.lostButtons.clear();
    source.lostAxes.clear();
    source.lostActions.clear();
    for (const press of [...source.keys.values()]) this.releaseKey(press);
    source.keys.clear();
    for (const action of [...source.actions.keys()])
      this.releaseAction(source, action);
    for (const key of [...source.buttons]) this.releaseButton(source, key);
    for (const key of [...source.axes.keys()]) this.setAxis(source, key, 0);
    this.pointer.release(source.id);
  }
}

function keyIdentity(record: Json): number {
  const physical = num(record, "physical_keycode");
  if (physical !== 0) return physical;
  const keycode = num(record, "keycode");
  if (keycode !== 0) return ID_KEYCODE | keycode;
  return ID_LABEL | num(record, "key_label");
}

/** A record for a control focus loss dropped leaves the lost set; true when it is done (a release). */
function takeLost(
  lost: Map<number, unknown> | Set<number>,
  id: number,
  pressed: boolean,
): boolean {
  return lost.delete(id) && !pressed;
}

function isRelease(record: Json): boolean {
  if (
    record.event === "key" ||
    record.event === "joypad_button" ||
    record.event === "mouse_button" ||
    record.event === "screen_touch" ||
    record.event === "action"
  )
    return record.pressed === false;
  if (record.event === "joypad_motion") return num(record, "axis_value") === 0;
  return false;
}

/** Run a vector; returns, per expect entry, the actual state in the vectors' normal form. */
export function runInjectorVector(vector: InjectorVector): InjectorState[] {
  const injector = new ModelInjector(vector.config);
  for (const spec of vector.scene ?? []) injector.scene.add(spec);
  const gui = injector.input.gui as ModelGui;
  const states: InjectorState[] = [];
  let now = 0;
  let next = 0;
  vector.steps.forEach((step, index) => {
    if ("at" in step && step.at !== undefined) now = step.at;
    if ("recv" in step) {
      const text =
        typeof step.recv === "string" ? step.recv : JSON.stringify(step.recv);
      const got = injector.receive(step.channel ?? "a", text, now);
      const want = step.result ?? "";
      if (got !== want)
        throw new Error(
          `${vector.name} step ${index}: receive returned '${got}', expected '${want}'`,
        );
    } else if ("close" in step) injector.closeChannel(step.close, now);
    else if ("tick" in step) {
      now = step.tick;
      injector.tick(now);
    } else if ("release_all" in step) injector.releaseAll();
    else if ("focus_lost" in step) {
      injector.input.releasePressed();
      injector.onFocusLost();
    } else if ("reassert" in step) injector.reassert();
    else if ("isolate" in step) injector.input.isolated = step.isolate;
    else if ("move" in step) {
      const node = injector.scene.get(step.move);
      if (!node)
        throw new Error(`${vector.name} step ${index}: no ${step.move}`);
      node.position = [
        Math.fround(step.position[0]),
        Math.fround(step.position[1]),
      ];
    } else if ("free" in step) injector.scene.free(step.free);
    else if ("add" in step) injector.scene.add(step.add);
    else if ("hide" in step || "show" in step) {
      const path = "hide" in step ? step.hide : step.show;
      const node = injector.scene.get(path);
      if (!node) throw new Error(`${vector.name} step ${index}: no ${path}`);
      node.visible = "show" in step;
    } else throw new Error(`${vector.name} step ${index}: unknown step`);
    injector.input.flush();
    while (next < vector.expect.length && vector.expect[next].after === index) {
      const state: InjectorState = {
        ...injector.input.state(),
        joypads: injector.remoteJoypads(),
        joypad_signals: injector.devices.signals,
        stats: injector.stats(),
        gui: gui.lines,
        target_signals: injector.targets.signals,
      };
      gui.lines = [];
      injector.targets.signals = [];
      if (vector.expect[next].mouse_position === undefined)
        delete state.mouse_position;
      states.push(state);
      injector.devices.signals = [];
      next++;
    }
  });
  if (next < vector.expect.length)
    throw new Error(`${vector.name}: expect entry ${next} names no step`);
  return states;
}

/** An expect entry in normal form: absent state fields are empty, absent stats have no counter. */
export function normalizeExpect(expect: InjectorExpect): InjectorState {
  const numeric = (a: number, b: number) => a - b;
  return {
    physical_keys: [...(expect.physical_keys ?? [])].sort(numeric),
    keys: [...(expect.keys ?? [])].sort(numeric),
    labels: [...(expect.labels ?? [])].sort(numeric),
    joy_buttons: [...(expect.joy_buttons ?? [])].sort(
      (a, b) => a[0] - b[0] || a[1] - b[1],
    ),
    joy_axes: [...(expect.joy_axes ?? [])]
      .map(([d, a, v]) => [d, a, Math.fround(v)] as [number, number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    actions: [...(expect.actions ?? [])].sort(),
    mouse_mask: expect.mouse_mask ?? 0,
    ...(expect.mouse_position
      ? { mouse_position: vec(expect.mouse_position) }
      : {}),
    dispatched: expect.dispatched ?? [],
    joypads: [...(expect.joypads ?? [])].sort((a, b) => a - b),
    joypad_signals: expect.joypad_signals ?? [],
    stats: expect.stats ?? {},
    gui: expect.gui ?? [],
    target_signals: expect.target_signals ?? [],
  };
}
