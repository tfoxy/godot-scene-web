// Browser keyboard capture -> gsw-input/1 `key` records (docs/input.md "Keyboard"), exported as
// `@godot-scene-web/input/keyboard`. The DOM `code`/`key` mapping is ./keymap (Godot's
// dom_keys.inc port); this file is the capture policy around it, ported from CouchCoop's mirror
// keyboard capture.
//
// EDGES, NOTHING STUCK. A forwarded press latches its record under its `code`; only the matching
// keyup, or a release-all, clears it, and the release replays the press record whatever the
// modifiers or focus have since become. Releases are UNGATED: once a press went out, its release
// goes out too (a filter applied to a release is how a key sticks down on the host). Every path that
// can end a press without a keyup releases everything latched: window blur, the tab hidden,
// `pagehide` (back/forward cache), `enabled()` turning false (on `refresh()`), dispose, and on
// macOS the Cmd key (`macMetaRelease`: the browser drops keyups while Cmd is held).
//
// GATES, PRESSES ONLY, in this order: auto-repeat (a latched key's repeat is an `echo` record when
// `echo` is on, an unlatched repeat never goes out), disabled or hidden page, IME composition
// (`isComposing` / keyCode 229), a code Godot's table does not map, `reservedCodes`, `filter`,
// ctrl/meta chords (`chords: "browser"`; the modifier keys themselves and AltGr are exempt), the
// text-entry and activation guards on the focused element, and `maxHeld`.
//
// The capture never sees epochs, seqs or the carrier: it pushes records into an InputSink and
// exposes its latched presses through `heldState()` (an InputSyncSource), so a session can heal the
// host after a (re)connect: `session.attach(createKeyboardCapture({ sink: session }))`.
//
// DOM-free types: the package typechecks without DOM libraries, so the browser objects are read
// through the structural interfaces below, which the real `window`, `document`, `KeyboardEvent`,
// `Element` and `navigator.keyboard` satisfy.

import type { InputRecord, InputSyncScope, KeyRecord } from "./format";
import { Key } from "./godot-enums";
import {
  type DomKeyEvent,
  type KeyboardLayoutLike,
  keyRecordFromDom,
  releaseKeyRecord,
} from "./keymap";

/**
 * Where a capture writes its records, in order (the root entry's session is one). A capture pushes
 * a fresh object per record and never mutates it afterwards. Structurally the session's `InputSink`.
 */
export interface KeyboardSink {
  push(record: InputRecord): void;
}

/** One scope's complete held state: a `sync` message without `type`, `epoch` and `seq`. */
export interface KeyboardHeldState {
  scope: InputSyncScope;
  device?: number;
  held: readonly InputRecord[];
}

/** The fields of a DOM `KeyboardEvent` the capture reads. */
export interface KeyboardEventLike extends Omit<DomKeyEvent, "altGraph"> {
  getModifierState?(key: string): boolean;
  preventDefault?(): void;
}

/**
 * An event target (`window`, `document`). The listener takes any event with a `type`, so a DOM
 * `EventTarget` fits; the capture reads its `keydown`/`keyup` events as `KeyboardEventLike`.
 */
export interface KeyEventTargetLike {
  addEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
}

/** The page-visibility source (`document`), which also answers "what has focus". */
export interface KeyVisibilitySource extends KeyEventTargetLike {
  visibilityState?: string;
  activeElement?: FocusedElementLike | null;
}

/** The focused element, as the guards read it. A real `Element` satisfies it. */
export interface FocusedElementLike {
  tagName: string;
  type?: string | null;
  isContentEditable?: boolean;
  hasAttribute?(name: string): boolean;
  getAttribute?(name: string): string | null;
}

/** `navigator.keyboard` (Keyboard Map API; Chromium, secure contexts only). */
export interface KeyboardLayoutSource {
  getLayoutMap(): Promise<KeyboardLayoutLike>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** Why a keydown was not forwarded. */
export type KeyboardDropReason =
  | "repeat"
  | "inactive"
  | "composing"
  | "unmapped"
  | "reserved"
  | "filtered"
  | "chord"
  | "text-entry"
  | "activation"
  | "held"
  | "max-held";

export interface KeyboardCaptureStats {
  /** Presses pushed. */
  presses: number;
  /** Releases pushed (keyups and release-alls). */
  releases: number;
  /** Echo records pushed (`echo: true`). */
  echoes: number;
  /** Keydowns not forwarded, by reason. */
  dropped: Record<KeyboardDropReason, number>;
}

/** Which forwarded keys get `preventDefault()` on their keydown, repeats and keyup. */
export type KeyboardPreventDefault =
  | "scroll"
  | "forwarded"
  | "none"
  | ((record: KeyRecord) => boolean);

export interface KeyboardCaptureOptions {
  /** Where records go: a session, or a consumer's own adapter. */
  sink: KeyboardSink;
  /**
   * Read live, per keydown, so a flip lands on the next keystroke (default: always on). Turning
   * it off releases anything held on the next `refresh()`.
   */
  enabled?: () => boolean;
  /** Where `keydown`/`keyup`/`blur`/`focus`/`pagehide` are heard (default `window`; null: inert). */
  events?: KeyEventTargetLike | null;
  /** Where `visibilitychange` is heard and what is focused (default `document`). */
  visibility?: KeyVisibilitySource | null;
  /** The focused element for the guards (default `visibility.activeElement`). */
  activeElement?: () => FocusedElementLike | null;
  /**
   * The element the game is drawn on. Focused, it is never a text-entry or activation target (a
   * pointer capture focuses its stage, which carries a `tabindex`).
   */
  stage?: FocusedElementLike | null;
  /** The layout map source (default `navigator.keyboard`; `null` = none). */
  keyboard?: KeyboardLayoutSource | null;
  /** Forward only the codes this accepts (default: every code Godot's table maps). */
  filter?: (code: string, record: KeyRecord) => boolean;
  /** Codes left to the browser: never forwarded, never prevented (default none). */
  reservedCodes?: Iterable<string>;
  /** Send a latched key's auto-repeat as `echo: true` (default false: repeats are dropped). */
  echo?: boolean;
  /**
   * `"browser"` (default): a non-modifier key pressed with Ctrl or Meta is the browser's and the
   * OS's (reload, devtools, tab switching) and is not forwarded; the Control/Meta keys themselves
   * are, and AltGr (`getModifierState("AltGraph")`, which Windows reports as Ctrl+Alt) is exempt.
   * `"forward"`: chords go to the game too.
   */
  chords?: "browser" | "forward";
  /**
   * Leave keys to a focused element taking typed text (`<input>` of a text type, `<textarea>`,
   * contenteditable). `true` (default) uses `isTextEntryElement`; a function replaces it.
   */
  textEntry?: boolean | ((element: FocusedElementLike) => boolean);
  /**
   * Leave Space/Enter to a focused control they activate (button, checkbox, link). `true`
   * (default) uses `isActivationTarget`; a function replaces it.
   */
  activation?:
    | boolean
    | ((element: FocusedElementLike, code: string) => boolean);
  /** Default `"scroll"`: only keys that would scroll the page (Space, arrows, Page*, Home, End). */
  preventDefault?: KeyboardPreventDefault;
  /**
   * Release latched non-modifier keys when Meta goes down or up, because macOS drops keyups while
   * Cmd is held. Default: on when `platform` is macOS or iOS.
   */
  macMetaRelease?: boolean;
  /**
   * The platform string for the `macMetaRelease` default (default
   * `navigator.userAgentData.platform`, else `navigator.platform`).
   */
  platform?: string;
  /** Most keys held at once; the next press is not forwarded and is counted (default 16). */
  maxHeld?: number;
}

export interface KeyboardCapture {
  /** The latched presses as one `keyboard` scope (a session's `InputSyncSource`). Fresh objects. */
  heldState(): readonly KeyboardHeldState[];
  /** Re-read `enabled()`: off releases everything held. Cheap and idempotent. */
  refresh(): void;
  /** Release every latched key now, in press order. */
  releaseAll(): void;
  /** Drop every listener and release anything still latched. */
  dispose(): void;
  /** The latched codes, in press order (diagnostics). */
  held(): readonly string[];
  stats(): KeyboardCaptureStats;
}

/** Keys that scroll the page: the `"scroll"` preventDefault set (CouchCoop's). */
const SCROLL_CODES: ReadonlySet<string> = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/** `<input>` types that take text. A checkbox, radio, range or button does not consume typing. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Keys that activate a focused browser control. */
const ACTIVATION_CODES: ReadonlySet<string> = new Set([
  "Space",
  "Enter",
  "NumpadEnter",
]);

const MODIFIER_KEYS: ReadonlySet<number> = new Set([
  Key.SHIFT,
  Key.CTRL,
  Key.ALT,
  Key.META,
]);

/**
 * Is the focused element taking typed text? Only then does every key belong to the page. Any other
 * `<input>` (a checkbox clicked in a settings panel and still focused) must not blind the game.
 */
export function isTextEntryElement(element: FocusedElementLike): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = element.type;
    return (
      type === undefined ||
      type === null ||
      type === "" ||
      TEXT_INPUT_TYPES.has(type.toLowerCase())
    );
  }
  return element.isContentEditable === true;
}

/**
 * Would this key activate the focused control? A focused checkbox still toggles on Space and a
 * focused button fires on Enter; every other key still goes to the game.
 */
export function isActivationTarget(
  element: FocusedElementLike,
  code: string,
): boolean {
  if (!ACTIVATION_CODES.has(code)) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT") return true;
  if (tag === "A" && element.hasAttribute?.("href") === true) return true;
  return (
    element.getAttribute?.("role") === "button" ||
    element.hasAttribute?.("tabindex") === true
  );
}

const isModifierRecord = (record: KeyRecord) =>
  MODIFIER_KEYS.has(record.physical_keycode ?? 0);
const isMetaRecord = (record: KeyRecord) =>
  record.physical_keycode === Key.META;

interface NavigatorLike {
  keyboard?: KeyboardLayoutSource;
  platform?: string;
  userAgentData?: { platform?: string };
}

function defaultPlatform(): string {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  return nav?.userAgentData?.platform ?? nav?.platform ?? "";
}

const isApplePlatform = (platform: string) =>
  /^(mac|iphone|ipad|ipod|ios)/i.test(platform);

const emptyDropped = (): Record<KeyboardDropReason, number> => ({
  repeat: 0,
  inactive: 0,
  composing: 0,
  unmapped: 0,
  reserved: 0,
  filtered: 0,
  chord: 0,
  "text-entry": 0,
  activation: 0,
  held: 0,
  "max-held": 0,
});

/**
 * Create the keyboard capture. Inert wherever there is no window to listen on, so callers never
 * guard the construction.
 */
export function createKeyboardCapture(
  options: KeyboardCaptureOptions,
): KeyboardCapture {
  const g = globalThis as {
    window?: KeyEventTargetLike;
    document?: KeyVisibilitySource;
    navigator?: NavigatorLike;
  };
  const sink = options.sink;
  const enabled = options.enabled ?? (() => true);
  const events = options.events === undefined ? g.window : options.events;
  const visibility =
    options.visibility === undefined ? g.document : options.visibility;
  const activeElement =
    options.activeElement ?? (() => visibility?.activeElement ?? null);
  const stage = options.stage ?? null;
  const keyboard =
    options.keyboard === undefined ? g.navigator?.keyboard : options.keyboard;
  const filter = options.filter;
  const reserved = new Set(options.reservedCodes ?? []);
  const echo = options.echo ?? false;
  const chords = options.chords ?? "browser";
  const textEntry =
    options.textEntry === false
      ? null
      : typeof options.textEntry === "function"
        ? options.textEntry
        : isTextEntryElement;
  const activation =
    options.activation === false
      ? null
      : typeof options.activation === "function"
        ? options.activation
        : isActivationTarget;
  const prevent = options.preventDefault ?? "scroll";
  const macMetaRelease =
    options.macMetaRelease ??
    isApplePlatform(options.platform ?? defaultPlatform());
  const maxHeld = options.maxHeld ?? 16;

  // code -> the record its press pushed. Map iteration order is press order.
  const held = new Map<string, KeyRecord>();
  const stats: KeyboardCaptureStats = {
    presses: 0,
    releases: 0,
    echoes: 0,
    dropped: emptyDropped(),
  };
  let layout: KeyboardLayoutLike | null = null;
  let layoutRequest = 0;
  let disposed = false;

  function loadLayout(): void {
    if (!keyboard || disposed) return;
    const request = ++layoutRequest;
    let pending: Promise<KeyboardLayoutLike>;
    try {
      pending = keyboard.getLayoutMap();
    } catch {
      return;
    }
    // A rejection (no permission in an iframe, an insecure context) keeps the fallback rules.
    pending.then(
      (map) => {
        if (!disposed && request === layoutRequest) layout = map;
      },
      () => {},
    );
  }

  function pageVisible(): boolean {
    // No visibility signal at all counts as visible: refusing keys there would be a dead feature.
    return visibility?.visibilityState !== "hidden";
  }

  function shouldPrevent(record: KeyRecord): boolean {
    if (prevent === "none") return false;
    if (prevent === "forwarded") return true;
    if (prevent === "scroll") return SCROLL_CODES.has(record.code ?? "");
    return prevent(record);
  }

  function preventFor(event: KeyboardEventLike, record: KeyRecord): void {
    if (shouldPrevent(record)) event.preventDefault?.();
  }

  function release(code: string): void {
    const press = held.get(code);
    if (!press) return;
    held.delete(code);
    stats.releases++;
    sink.push(releaseKeyRecord(press));
  }

  function releaseAll(): void {
    for (const code of [...held.keys()]) release(code);
  }

  /** macOS: keyups of keys held across a Cmd edge never arrive. */
  function releaseNonModifiers(): void {
    for (const [code, press] of [...held])
      if (!isModifierRecord(press)) release(code);
  }

  function drop(reason: KeyboardDropReason): void {
    stats.dropped[reason]++;
  }

  function guarded(code: string): KeyboardDropReason | null {
    const focused = activeElement();
    if (!focused || focused === stage) return null;
    if (textEntry?.(focused)) return "text-entry";
    if (activation?.(focused, code)) return "activation";
    return null;
  }

  /** Forward one keydown, or say why not. */
  function keyDown(event: KeyboardEventLike): KeyboardDropReason | null {
    if (disposed) return null;
    const latched = held.get(event.code);
    if (latched) {
      // K1/K2: a latched key's repeat is an echo (or nothing); a second plain keydown (a lost keyup
      // across a focus round trip) is ignored, since the host already holds the key.
      preventFor(event, latched);
      if (event.repeat !== true) return "held";
      if (!echo) return "repeat";
      stats.echoes++;
      sink.push({ ...latched, echo: true });
      return null;
    }
    if (event.repeat === true) return "repeat";
    if (enabled() === false || !pageVisible()) return "inactive";
    if (event.isComposing === true || event.keyCode === 229) return "composing";
    const altGraph = event.getModifierState?.("AltGraph") === true;
    const record = keyRecordFromDom(
      {
        type: "keydown",
        code: event.code,
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        altGraph,
      },
      { layout },
    );
    if (!record) return "unmapped";
    if (reserved.has(event.code)) return "reserved";
    if (filter && !filter(event.code, record)) return "filtered";
    if (
      chords === "browser" &&
      (event.ctrlKey === true || event.metaKey === true) &&
      !altGraph &&
      !isModifierRecord(record)
    )
      return "chord";
    const guard = guarded(event.code);
    if (guard) return guard;
    if (held.size >= maxHeld) return "max-held";
    if (macMetaRelease && isMetaRecord(record)) releaseNonModifiers();
    held.set(event.code, record);
    stats.presses++;
    sink.push({ ...record });
    preventFor(event, record);
    return null;
  }

  function onKeyDown(event: KeyboardEventLike): void {
    const reason = keyDown(event);
    if (reason) drop(reason);
  }

  // UNGATED on purpose: the latch is the only authority on whether a release is owed.
  function onKeyUp(event: KeyboardEventLike): void {
    const press = held.get(event.code);
    if (!press) return;
    if (macMetaRelease && isMetaRecord(press)) releaseNonModifiers();
    release(event.code);
    preventFor(event, press);
  }

  const onBlur = (): void => releaseAll();
  const onFocus = (): void => loadLayout(); // the layout may have changed while away
  const onPageHide = (): void => releaseAll();
  const onVisibility = (): void => {
    if (!pageVisible()) releaseAll();
  };
  const onLayoutChange = (): void => loadLayout();

  type Listener = (event: { type: string }) => void;
  if (events) {
    events.addEventListener("keydown", onKeyDown as Listener);
    events.addEventListener("keyup", onKeyUp as Listener);
    events.addEventListener("blur", onBlur);
    events.addEventListener("focus", onFocus);
    events.addEventListener("pagehide", onPageHide);
    visibility?.addEventListener("visibilitychange", onVisibility);
    keyboard?.addEventListener?.("layoutchange", onLayoutChange);
    loadLayout();
  }

  return {
    heldState(): readonly KeyboardHeldState[] {
      return [
        {
          scope: "keyboard",
          held: [...held.values()].map((record) => ({ ...record })),
        },
      ];
    },
    refresh(): void {
      if (!disposed && enabled() === false) releaseAll();
    },
    releaseAll,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (events) {
        events.removeEventListener("keydown", onKeyDown as Listener);
        events.removeEventListener("keyup", onKeyUp as Listener);
        events.removeEventListener("blur", onBlur);
        events.removeEventListener("focus", onFocus);
        events.removeEventListener("pagehide", onPageHide);
        visibility?.removeEventListener("visibilitychange", onVisibility);
        keyboard?.removeEventListener?.("layoutchange", onLayoutChange);
      }
      releaseAll();
    },
    held(): readonly string[] {
      return [...held.keys()];
    },
    stats(): KeyboardCaptureStats {
      return { ...stats, dropped: { ...stats.dropped } };
    },
  };
}
