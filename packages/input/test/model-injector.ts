// Test-only model of the GDScript reference injector (packages/input/godot/addons/gsw_input/
// gsw_input_injector.gd) and of the Godot `Input` state it drives, so the conformance/v1/injector
// vectors can be checked for self-consistency without Godot. Godot's runner
// (packages/input/godot/tests/injector_selftest.gd) checks the same vectors against real Input.
//
// It mirrors the injector rule for rule, in the same order (dispatch order is asserted): the
// session table, the two-level ledger, release-all and the gates. Input is modelled as the three
// key sets, the joypad button set and axis map (axes stored as float32, as Godot does), and the
// test project's two actions (packages/input/godot/project.godot).
import { parseInputMessage } from "../src/index";

type Json = Record<string, unknown>;

export interface InjectorConfig {
  accept_kinds?: string[];
  allowed_actions?: string[];
  device_base?: number;
  devices_per_source?: number;
  share_devices?: boolean;
  key_device?: number;
  stale_timeout_ms?: number;
  max_events_per_second?: number;
}

export type InjectorStep =
  | { recv: Json | string; channel?: string; at?: number; result?: string }
  | { close: string; at?: number }
  | { tick: number }
  | { release_all: true };

export interface InjectorExpect {
  after: number;
  physical_keys?: number[];
  keys?: number[];
  labels?: number[];
  joy_buttons?: [number, number][];
  joy_axes?: [number, number, number][];
  actions?: string[];
  dispatched?: string[];
  stats?: Record<string, number>;
}

export interface InjectorVector {
  name: string;
  description: string;
  config: InjectorConfig;
  steps: InjectorStep[];
  expect: InjectorExpect[];
}

/** The state an expect entry compares, in the vectors' normal form (sorted, all fields present). */
export type InjectorState = Required<Omit<InjectorExpect, "after">>;

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
const MAX_DEVICE = 2047;
const RATE_WINDOW_MS = 1000;
const ID_KEYCODE = 1 << 24;
const ID_LABEL = 2 << 24;
const BUTTON_BITS = 7;
const AXIS_BITS = 4;
/** project.godot: gsw_test_jump = joypad A (any device) + physical W; gsw_test_right = axis 0 +. */
const KEY_W = 87;
const DEADZONE = 0.5;

/** Godot's Input, reduced to what the vectors observe. */
class ModelInput {
  physical = new Set<number>();
  keycodes = new Set<number>();
  labels = new Set<number>();
  buttons = new Set<string>();
  axes = new Map<string, number>();
  dispatched: string[] = [];

  key(
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

  button(device: number, button: number, pressed: boolean) {
    const id = `${device}:${button}`;
    if (pressed) this.buttons.add(id);
    else this.buttons.delete(id);
    this.dispatched.push(
      `joy_button ${device} ${button} ${pressed ? "down" : "up"}`,
    );
  }

  axis(device: number, axis: number, value: number) {
    // InputEventJoypadMotion.axis_value is a C++ float.
    const stored = Math.fround(value) + 0;
    const id = `${device}:${axis}`;
    if (stored === 0) this.axes.delete(id);
    else this.axes.set(id, stored);
    this.dispatched.push(`joy_motion ${device} ${axis} ${stored.toFixed(4)}`);
  }

  state(): Omit<InjectorState, "stats"> {
    const numeric = (a: number, b: number) => a - b;
    const pair = (id: string) => id.split(":").map(Number);
    const buttons = [...this.buttons]
      .map(pair)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]) as [number, number][];
    const axes = [...this.axes]
      .map(([id, value]) => [...pair(id), value])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]) as [number, number, number][];
    const actions: string[] = [];
    if (this.physical.has(KEY_W) || buttons.some(([, button]) => button === 0))
      actions.push("gsw_test_jump");
    if (axes.some(([, axis, value]) => axis === 0 && value >= DEADZONE))
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
      dispatched,
    };
  }
}

interface Source {
  id: string;
  index: number;
  channel: string | null;
  open: boolean;
  epoch: number;
  lastSeq: number;
  lastMsec: number;
  stale: boolean;
  keys: Map<number, Json>;
  buttons: Set<number>;
  axes: Map<number, number>;
  handles: Map<number, Json>;
  rateStart: number;
  rateCount: number;
}

const num = (record: Json, field: string, fallback = 0): number =>
  (record[field] as number | undefined) ?? fallback;

/** The injector, rule for rule as gsw_input_injector.gd. */
export class ModelInjector {
  readonly input = new ModelInput();
  acceptKinds = DEFAULT_ACCEPT_KINDS;
  allowedActions: string[] = [];
  deviceBase = 64;
  devicesPerSource = 4;
  shareDevices = false;
  staleTimeoutMs = 0;
  maxEventsPerSecond = 2000;

  private readonly sources = new Map<string, Source>();
  private readonly byChannel = new Map<string, Source>();
  private nextIndex = 0;
  private readonly keyRefs = new Map<string, number>();
  private readonly buttonRefs = new Map<number, number>();
  private readonly axisHolders = new Map<number, Map<string, number>>();
  private readonly axisEmitted = new Map<number, number>();
  private readonly counters = new Map<string, number>();

  constructor(config: InjectorConfig = {}) {
    if (config.accept_kinds) this.acceptKinds = config.accept_kinds;
    if (config.allowed_actions) this.allowedActions = config.allowed_actions;
    this.deviceBase = config.device_base ?? this.deviceBase;
    this.devicesPerSource = config.devices_per_source ?? this.devicesPerSource;
    this.shareDevices = config.share_devices ?? this.shareDevices;
    this.staleTimeoutMs = config.stale_timeout_ms ?? this.staleTimeoutMs;
    this.maxEventsPerSecond =
      config.max_events_per_second ?? this.maxEventsPerSecond;
  }

  stats(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  deviceFor(source: string, slot: number): number {
    const state = this.sources.get(source);
    if (!state || slot < 0 || slot >= this.devicesPerSource) return -1;
    let device = this.deviceBase + slot;
    if (!this.shareDevices) device += state.index * this.devicesPerSource;
    return device <= MAX_DEVICE ? device : -1;
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
        this.closeSource(source);
        break;
    }
    return "";
  }

  closeChannel(channel: string) {
    const source = this.byChannel.get(channel);
    if (source) this.closeSource(source);
  }

  releaseAll() {
    for (const source of this.sources.values()) this.releaseSource(source);
  }

  tick(now: number) {
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
    let source = this.sources.get(id);
    if (!source) {
      source = {
        id,
        index: this.nextIndex++,
        channel: null,
        open: false,
        epoch: -1,
        lastSeq: 0,
        lastMsec: 0,
        stale: false,
        keys: new Map(),
        buttons: new Set(),
        axes: new Map(),
        handles: new Map(),
        rateStart: 0,
        rateCount: 0,
      };
      this.sources.set(id, source);
    } else if (source.open && source.epoch === epoch)
      return this.drop("duplicate");
    const bound = this.byChannel.get(channel);
    if (bound && bound !== source) this.closeSource(bound);
    if (source.open) {
      this.releaseSource(source);
      source.handles.clear();
      if (source.channel !== null) this.byChannel.delete(source.channel);
    }
    source.open = true;
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

  private closeSource(source: Source) {
    this.releaseSource(source);
    source.open = false;
    source.epoch = -1;
    source.handles.clear();
    if (source.channel !== null) this.byChannel.delete(source.channel);
    source.channel = null;
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
    if (
      kind !== "key" &&
      kind !== "joypad_button" &&
      kind !== "joypad_motion"
    ) {
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
    else this.joypadMotion(source, record);
  }

  private key(source: Source, record: Json) {
    const id = keyIdentity(record);
    if (record.pressed === true && record.echo === true) {
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
    const device = this.deviceFor(source.id, num(record, "device"));
    if (device < 0) {
      this.count("device-refused");
      return;
    }
    const key = (device << BUTTON_BITS) | num(record, "button_index");
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
    const device = this.deviceFor(source.id, num(record, "device"));
    if (device < 0) {
      this.count("device-refused");
      return;
    }
    const key = (device << AXIS_BITS) | num(record, "axis");
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
      const device = this.deviceFor(source.id, message.device as number);
      if (device < 0) {
        this.count("device-refused");
        return;
      }
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
    } else for (const record of held) this.admit(source, record);
  }

  private releaseSource(source: Source) {
    for (const press of [...source.keys.values()]) this.releaseKey(press);
    source.keys.clear();
    for (const key of [...source.buttons]) this.releaseButton(source, key);
    for (const key of [...source.axes.keys()]) this.setAxis(source, key, 0);
  }
}

function keyIdentity(record: Json): number {
  const physical = num(record, "physical_keycode");
  if (physical !== 0) return physical;
  const keycode = num(record, "keycode");
  if (keycode !== 0) return ID_KEYCODE | keycode;
  return ID_LABEL | num(record, "key_label");
}

function isRelease(record: Json): boolean {
  if (record.event === "key" || record.event === "joypad_button")
    return record.pressed === false;
  if (record.event === "joypad_motion") return num(record, "axis_value") === 0;
  return false;
}

/** Run a vector; returns, per expect entry, the actual state in the vectors' normal form. */
export function runInjectorVector(vector: InjectorVector): InjectorState[] {
  const injector = new ModelInjector(vector.config);
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
    } else if ("close" in step) injector.closeChannel(step.close);
    else if ("tick" in step) {
      now = step.tick;
      injector.tick(now);
    } else if ("release_all" in step) injector.releaseAll();
    else throw new Error(`${vector.name} step ${index}: unknown step`);
    while (next < vector.expect.length && vector.expect[next].after === index) {
      states.push({ ...injector.input.state(), stats: injector.stats() });
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
    dispatched: expect.dispatched ?? [],
    stats: expect.stats ?? {},
  };
}
