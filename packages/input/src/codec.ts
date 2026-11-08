// gsw-input/1 codec: parse, validate and canonically encode messages (docs/input.md "Validation",
// "Canonical encoding"). DOM-free and stateless: session rules (epoch, seq, declared handles) live
// in the session and the host, not here.
//
// ONE TABLE, TWO USES. The field tables below define, per message type and record kind, the order
// fields are CHECKED in (the first failure wins, so the order is part of the contract: the GDScript
// validator must report the same `code` and `path` for every vector in conformance/v1/codec) and
// the order they are WRITTEN in by the encoder. Keeping both in one table is what stops them
// drifting apart.

import {
  INPUT_FORMAT,
  INPUT_MAX_EVENTS,
  INPUT_MAX_MESSAGE_BYTES,
  INPUT_MAX_TARGET_HANDLE,
  type InputErrorCode,
  type InputMessage,
  type InputParseResult,
  type InputRecord,
  type InputSyncScope,
} from "./format";
import { isInstanceId } from "./instance-id";

/** Largest absolute value of a position, relative motion, pan delta or target-local point. */
const MAX_COORD = 1_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const U32_MAX = 4_294_967_295;
/** Key values without modifier masks (core/os/keyboard.h:250, CODE_MASK). */
const KEY_MAX = 0x7f_ffff;

const SOURCE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const CODE_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const CLASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_KINDS = 32;

type FieldType =
  | { t: "int"; min: number; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "bool" }
  | { t: "instance_id" }
  | { t: "vec2"; min: number; max: number }
  | { t: "pattern"; re: RegExp }
  /** Free text: UTF-8 length 1..maxBytes, no C0 control characters or DEL. */
  | { t: "text"; maxBytes: number };

interface Field {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Value the encoder omits (Godot's default). Never omitted when `required`. */
  def?: number | boolean | readonly [number, number];
}

const int = (min: number, max: number): FieldType => ({ t: "int", min, max });
const num = (min: number, max: number): FieldType => ({ t: "num", min, max });
const BOOL: FieldType = { t: "bool" };
const COORD: FieldType = { t: "vec2", min: -MAX_COORD, max: MAX_COORD };
const UNIT_VEC: FieldType = { t: "vec2", min: -1, max: 1 };
const ZERO2 = [0, 0] as const;

const opt = (
  name: string,
  type: FieldType,
  def: NonNullable<Field["def"]>,
): Field => ({
  name,
  type,
  def,
});
const req = (name: string, type: FieldType): Field => ({
  name,
  type,
  required: true,
});
const flag = (name: string): Field => opt(name, BOOL, false);

const MODIFIERS: Field[] = [
  flag("shift_pressed"),
  flag("ctrl_pressed"),
  flag("alt_pressed"),
  flag("meta_pressed"),
];
const TARGET_FIELDS: Field[] = [
  { name: "target", type: int(0, INPUT_MAX_TARGET_HANDLE) },
  { name: "local", type: COORD },
  { name: "frame", type: int(0, MAX_SAFE) },
];
const BUTTON_MASK = opt("button_mask", int(0, 511), 0);

/** Record fields in check-and-write order (docs/input.md "Records"). */
const RECORD_FIELDS: Record<InputRecord["event"], Field[]> = {
  key: [
    opt("physical_keycode", int(0, KEY_MAX), 0),
    opt("keycode", int(0, KEY_MAX), 0),
    opt("key_label", int(0, KEY_MAX), 0),
    opt("unicode", int(0, 0x10_ffff), 0),
    opt("location", int(0, 2), 0),
    req("pressed", BOOL),
    flag("echo"),
    ...MODIFIERS,
    { name: "code", type: { t: "pattern", re: CODE_PATTERN } },
  ],
  joypad_button: [
    opt("device", int(0, 15), 0),
    opt("button_index", int(0, 127), 0),
    req("pressed", BOOL),
  ],
  joypad_motion: [
    opt("device", int(0, 15), 0),
    opt("axis", int(0, 9), 0),
    opt("axis_value", num(-1, 1), 0),
  ],
  mouse_button: [
    req("button_index", int(1, 9)),
    req("pressed", BOOL),
    req("position", COORD),
    BUTTON_MASK,
    flag("double_click"),
    flag("canceled"),
    opt("factor", num(0, 10_000), 1),
    ...MODIFIERS,
    ...TARGET_FIELDS,
  ],
  mouse_motion: [
    req("position", COORD),
    opt("relative", COORD, ZERO2),
    BUTTON_MASK,
    opt("pressure", num(0, 1), 0),
    opt("tilt", UNIT_VEC, ZERO2),
    flag("pen_inverted"),
    ...MODIFIERS,
    ...TARGET_FIELDS,
  ],
  screen_touch: [
    opt("index", int(0, 31), 0),
    req("pressed", BOOL),
    req("position", COORD),
    flag("canceled"),
    flag("double_tap"),
    ...TARGET_FIELDS,
  ],
  screen_drag: [
    opt("index", int(0, 31), 0),
    req("position", COORD),
    opt("relative", COORD, ZERO2),
    opt("pressure", num(0, 1), 0),
    opt("tilt", UNIT_VEC, ZERO2),
    flag("pen_inverted"),
    ...TARGET_FIELDS,
  ],
  magnify_gesture: [
    req("position", COORD),
    opt("factor", num(0, 10_000), 1),
    ...MODIFIERS,
  ],
  pan_gesture: [
    req("position", COORD),
    opt("delta", COORD, ZERO2),
    ...MODIFIERS,
  ],
  action: [
    req("action", { t: "text", maxBytes: 128 }),
    req("pressed", BOOL),
    opt("strength", num(0, 1), 1),
  ],
  target: [
    req("handle", int(1, INPUT_MAX_TARGET_HANDLE)),
    { name: "path", type: { t: "text", maxBytes: 1024 } },
    { name: "scene", type: { t: "text", maxBytes: 512 } },
    { name: "class", type: { t: "pattern", re: CLASS_PATTERN } },
    { name: "item", type: int(0, MAX_SAFE) },
    { name: "instance_id", type: { t: "instance_id" } },
  ],
};

const EPOCH = req("epoch", int(0, U32_MAX));
const SEQ = req("seq", int(0, MAX_SAFE));
const REASON: Field = {
  name: "reason",
  type: { t: "pattern", re: SOURCE_PATTERN },
};

/** Scalar message fields in check-and-write order; arrays are handled beside them. */
const MESSAGE_FIELDS = {
  hello: [
    req("source", { t: "pattern", re: SOURCE_PATTERN }),
    EPOCH,
    opt("seq", int(0, MAX_SAFE), 0),
  ],
  events: [EPOCH, SEQ],
  sync: [EPOCH, SEQ],
  reset: [EPOCH, SEQ, REASON],
  bye: [EPOCH, SEQ, REASON],
  heartbeat: [EPOCH, SEQ],
} satisfies Record<InputMessage["type"], Field[]>;

const SCOPES: readonly InputSyncScope[] = ["keyboard", "joypad", "pointer"];

class Reject {
  constructor(
    readonly code: InputErrorCode,
    readonly path: string | undefined,
    readonly detail: string,
  ) {}
}

const bad = (path: string, detail: string) =>
  new Reject("bad-field", path, detail);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(object: Json, key: string): boolean {
  return Object.hasOwn(object, key);
}

/** UTF-8 length of a JS string; a lone surrogate counts as U+FFFD (3 bytes), as TextEncoder does. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Check one present field; returns the value to keep (a fresh tuple for vectors). */
function checkField(value: unknown, field: Field, path: string): unknown {
  const type = field.type;
  switch (type.t) {
    case "int":
      if (!finiteIn(value, type.min, type.max) || !Number.isInteger(value))
        throw bad(path, `integer ${type.min}..${type.max} expected`);
      return value;
    case "num":
      if (!finiteIn(value, type.min, type.max))
        throw bad(path, `number ${type.min}..${type.max} expected`);
      return value;
    case "instance_id":
      if (!isInstanceId(value))
        throw bad(path, "nonzero u64 decimal string expected");
      return value;
    case "bool":
      if (typeof value !== "boolean") throw bad(path, "boolean expected");
      return value;
    case "vec2":
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !finiteIn(value[0], type.min, type.max) ||
        !finiteIn(value[1], type.min, type.max)
      )
        throw bad(path, `[x, y] with |v| <= ${type.max} expected`);
      return [value[0], value[1]];
    case "pattern":
      if (typeof value !== "string" || !type.re.test(value))
        throw bad(path, `string matching ${type.re.source} expected`);
      return value;
    case "text":
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        utf8Length(value) > type.maxBytes ||
        hasControl(value)
      )
        throw bad(
          path,
          `string of 1..${type.maxBytes} UTF-8 bytes without control characters expected`,
        );
      return value;
  }
}

/** Check `fields` of `source` in table order, copying the present ones into `into`. */
function checkFields(
  source: Json,
  fields: readonly Field[],
  prefix: string,
  into: Json,
): void {
  for (const field of fields) {
    const path = prefix + field.name;
    if (!has(source, field.name)) {
      if (field.required) throw bad(path, "required");
      continue;
    }
    into[field.name] = checkField(source[field.name], field, path);
  }
}

function isKnownKind(kind: string): kind is InputRecord["event"] {
  return Object.hasOwn(RECORD_FIELDS, kind);
}

/** Validate one record. Returns null for an unknown kind (skipped), throws for an invalid known one. */
function checkRecord(value: unknown, path: string): Json | null {
  if (!isObject(value)) throw bad(path, "object expected");
  const kind = value.event;
  if (typeof kind !== "string") throw bad(`${path}.event`, "string expected");
  if (!isKnownKind(kind)) return null;
  const out: Json = { event: kind };
  const prefix = `${path}.`;
  checkFields(value, RECORD_FIELDS[kind], prefix, out);

  // Cross-field rules, after every field passed, in this order.
  if (kind === "key") {
    if (out.echo === true && out.pressed !== true)
      throw bad(`${prefix}echo`, "echo needs pressed: true");
    if (!out.physical_keycode && !out.keycode && !out.key_label)
      throw bad(
        `${prefix}keycode`,
        "one of physical_keycode, keycode, key_label must be nonzero",
      );
  } else if (kind === "target") {
    if (has(out, "scene") && !has(out, "path"))
      throw bad(`${prefix}scene`, "scene needs path");
    if (!has(out, "path") && !has(out, "item"))
      throw bad(`${prefix}path`, "a target needs path or item");
  } else if (has(out, "target") || has(out, "local") || has(out, "frame")) {
    const target = out.target as number | undefined;
    if (target ? !has(out, "local") : has(out, "local"))
      throw bad(
        `${prefix}local`,
        "local is required with a nonzero target and forbidden otherwise",
      );
    if (has(out, "frame") && target === undefined)
      throw bad(`${prefix}frame`, "frame needs target");
  }
  return out;
}

const WHEEL_FIRST = 4;
const WHEEL_LAST = 7;

/** sync: which known kinds a scope's `held` may list and what they must say. */
function checkHeld(
  record: Json,
  scope: InputSyncScope,
  device: number | undefined,
  path: string,
): void {
  const kind = record.event as InputRecord["event"];
  const allowed: Record<InputSyncScope, readonly string[]> = {
    keyboard: ["key"],
    joypad: ["joypad_button", "joypad_motion"],
    pointer: ["target", "mouse_button", "mouse_motion", "screen_touch"],
  };
  if (!allowed[scope].includes(kind))
    throw bad(`${path}.event`, `${kind} is not held state of scope ${scope}`);
  if (has(record, "pressed") && record.pressed !== true)
    throw bad(`${path}.pressed`, "held state is pressed: true");
  if (kind === "key" && record.echo === true)
    throw bad(`${path}.echo`, "held state is not an echo");
  if (
    scope === "joypad" &&
    ((record.device as number | undefined) ?? 0) !== device
  )
    throw bad(`${path}.device`, "held state must match the sync device");
  if (kind === "mouse_button") {
    const button = record.button_index as number;
    if (button >= WHEEL_FIRST && button <= WHEEL_LAST)
      throw bad(`${path}.button_index`, "a wheel button is never held");
  }
}

function checkRecords(
  value: unknown,
  path: string,
  min: number,
  scope?: { scope: InputSyncScope; device: number | undefined },
): { records: Json[]; skipped: number } {
  if (!Array.isArray(value)) throw bad(path, "array expected");
  if (value.length < min) throw bad(path, `at least ${min} record expected`);
  if (value.length > INPUT_MAX_EVENTS)
    throw new Reject(
      "too-many-events",
      path,
      `at most ${INPUT_MAX_EVENTS} records`,
    );
  const records: Json[] = [];
  let skipped = 0;
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = checkRecord(item, itemPath);
    if (record === null) {
      skipped++;
      return;
    }
    if (scope) checkHeld(record, scope.scope, scope.device, itemPath);
    records.push(record);
  });
  return { records, skipped };
}

function checkMessage(value: unknown): { message: Json; skipped: number } {
  if (!isObject(value))
    throw new Reject("malformed", undefined, "a JSON object expected");
  const type = value.type;
  if (typeof type !== "string")
    throw new Reject("malformed", undefined, "type must be a string");
  if (!Object.hasOwn(MESSAGE_FIELDS, type))
    throw new Reject("unknown-type", "type", `unknown message type ${type}`);
  const kind = type as InputMessage["type"];
  const out: Json = { type: kind };
  let skipped = 0;

  if (kind === "hello") {
    if (!has(value, "format")) throw bad("format", "required");
    if (typeof value.format !== "string")
      throw bad("format", "string expected");
    if (value.format !== INPUT_FORMAT)
      throw new Reject(
        "unsupported-format",
        "format",
        `format ${value.format} is not ${INPUT_FORMAT}`,
      );
    out.format = INPUT_FORMAT;
  }
  checkFields(value, MESSAGE_FIELDS[kind], "", out);

  if (kind === "hello" && has(value, "kinds")) {
    const kinds = value.kinds;
    if (!Array.isArray(kinds) || kinds.length > MAX_KINDS)
      throw bad("kinds", `array of at most ${MAX_KINDS} kinds expected`);
    kinds.forEach((name, index) => {
      if (typeof name !== "string" || !KIND_PATTERN.test(name))
        throw bad(`kinds[${index}]`, "a record kind name expected");
    });
    out.kinds = [...kinds];
  } else if (kind === "events") {
    if (!has(value, "events")) throw bad("events", "required");
    const checked = checkRecords(value.events, "events", 1);
    out.events = checked.records;
    skipped = checked.skipped;
  } else if (kind === "sync") {
    if (!has(value, "scope")) throw bad("scope", "required");
    const scope = value.scope;
    if (typeof scope !== "string" || !SCOPES.includes(scope as InputSyncScope))
      throw bad("scope", `one of ${SCOPES.join(", ")} expected`);
    out.scope = scope;
    let device: number | undefined;
    if (scope === "joypad") {
      if (!has(value, "device")) throw bad("device", "required for joypad");
      device = checkField(
        value.device,
        req("device", int(0, 15)),
        "device",
      ) as number;
      out.device = device;
    } else if (has(value, "device"))
      throw bad("device", "only a joypad sync has a device");
    if (!has(value, "held")) throw bad("held", "required");
    const checked = checkRecords(value.held, "held", 0, {
      scope: scope as InputSyncScope,
      device,
    });
    out.held = checked.records;
    skipped = checked.skipped;
  }
  return { message: out, skipped };
}

function result(
  run: () => { message: Json; skipped: number },
): InputParseResult {
  try {
    const { message, skipped } = run();
    return { ok: true, message: message as unknown as InputMessage, skipped };
  } catch (error) {
    if (!(error instanceof Reject)) throw error;
    return error.path === undefined
      ? { ok: false, code: error.code, detail: error.detail }
      : { ok: false, code: error.code, path: error.path, detail: error.detail };
  }
}

/**
 * Validate an already-parsed JSON value as a gsw-input/1 message. It cannot see the text, so the
 * byte limit is the caller's: use `parseInputMessage` whenever the carrier hands you text.
 */
export function validateInputMessage(value: unknown): InputParseResult {
  return result(() => checkMessage(value));
}

/** Parse and validate one gsw-input/1 message text (UTF-8 limit first, then JSON, then fields). */
export function parseInputMessage(text: string): InputParseResult {
  return result(() => {
    if (utf8Length(text) > INPUT_MAX_MESSAGE_BYTES)
      throw new Reject(
        "too-large",
        undefined,
        `message exceeds ${INPUT_MAX_MESSAGE_BYTES} bytes`,
      );
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Reject("malformed", undefined, "not JSON");
    }
    return checkMessage(value);
  });
}

export type InputEncodeErrorCode = "invalid" | "too-large";

/** The message is invalid, or a part of it cannot fit in one message. */
export class InputEncodeError extends Error {
  override readonly name = "InputEncodeError";
  constructor(
    readonly code: InputEncodeErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export interface InputEncodeOptions {
  /** Byte budget per message, 64..INPUT_MAX_MESSAGE_BYTES (default the maximum). */
  maxBytes?: number | undefined;
}

function isDefault(value: unknown, def: Field["def"]): boolean {
  if (Array.isArray(def))
    return Array.isArray(value) && value[0] === def[0] && value[1] === def[1];
  return value === def;
}

function writeFields(source: Json, fields: readonly Field[], parts: string[]) {
  for (const field of fields) {
    if (!has(source, field.name)) continue;
    const value = source[field.name];
    if (
      !field.required &&
      field.def !== undefined &&
      isDefault(value, field.def)
    )
      continue;
    parts.push(`${JSON.stringify(field.name)}:${JSON.stringify(value)}`);
  }
}

function writeRecord(record: Json): string {
  const kind = record.event as InputRecord["event"];
  const parts = [`"event":${JSON.stringify(kind)}`];
  writeFields(record, RECORD_FIELDS[kind], parts);
  return `{${parts.join(",")}}`;
}

function writeHead(message: Json, seq?: number): string[] {
  const kind = message.type as InputMessage["type"];
  const parts = [`"type":${JSON.stringify(kind)}`];
  if (kind === "hello") parts.push(`"format":${JSON.stringify(INPUT_FORMAT)}`);
  writeFields(
    seq === undefined ? message : { ...message, seq },
    MESSAGE_FIELDS[kind],
    parts,
  );
  return parts;
}

/**
 * Encode a message canonically: fields in spec order, defaults omitted, no whitespace. Returns one
 * text per message. Only `events` is split: when its records do not fit `maxBytes` (or exceed
 * INPUT_MAX_EVENTS) they are spread, in order, over consecutive messages numbered `seq`,
 * `seq + 1`, ...; the caller's next seq is `seq + texts.length`. Throws InputEncodeError for an
 * invalid message (`invalid`) or for one record or a non-splittable message that cannot fit
 * (`too-large`).
 */
export function encodeInputMessage(
  message: InputMessage,
  options: InputEncodeOptions = {},
): string[] {
  const maxBytes = options.maxBytes ?? INPUT_MAX_MESSAGE_BYTES;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 64 ||
    maxBytes > INPUT_MAX_MESSAGE_BYTES
  )
    throw new RangeError(
      `maxBytes must be an integer 64..${INPUT_MAX_MESSAGE_BYTES}`,
    );
  // Validate a copy with an `events` length the splitter will fix, so a long batch is legal input.
  const probe =
    message.type === "events" && message.events.length > INPUT_MAX_EVENTS
      ? { ...message, events: message.events.slice(0, INPUT_MAX_EVENTS) }
      : message;
  const checked = validateInputMessage(probe);
  if (!checked.ok)
    throw new InputEncodeError("invalid", checked.detail, checked.path);
  if (checked.skipped > 0)
    throw new InputEncodeError("invalid", "unknown record kind");
  const canonical = checked.message as unknown as Json;

  if (message.type !== "events") {
    const parts = writeHead(canonical);
    const kinds = canonical.kinds as string[] | undefined;
    if (kinds !== undefined && kinds.length > 0)
      parts.push(`"kinds":${JSON.stringify(kinds)}`);
    if (canonical.type === "sync") {
      parts.push(`"scope":${JSON.stringify(canonical.scope)}`);
      if (has(canonical, "device")) parts.push(`"device":${canonical.device}`);
      const held = (canonical.held as Json[]).map(writeRecord);
      parts.push(`"held":[${held.join(",")}]`);
    }
    const text = `{${parts.join(",")}}`;
    if (utf8Length(text) > maxBytes)
      throw new InputEncodeError(
        "too-large",
        `${message.type} message is ${utf8Length(text)} bytes, budget ${maxBytes}`,
      );
    return [text];
  }

  // events: validate every record (the probe saw at most INPUT_MAX_EVENTS of them), then pack.
  const records: string[] = [];
  message.events.forEach((record, index) => {
    const path = `events[${index}]`;
    let out: Json | null;
    try {
      out = checkRecord(record, path);
    } catch (error) {
      if (error instanceof Reject)
        throw new InputEncodeError("invalid", error.detail, error.path);
      throw error;
    }
    if (out === null)
      throw new InputEncodeError("invalid", "unknown record kind", path);
    records.push(writeRecord(out));
  });
  const texts: string[] = [];
  let next = 0;
  let seq = message.seq;
  while (next < records.length) {
    if (seq > MAX_SAFE)
      throw new InputEncodeError("invalid", "seq overflow", "seq");
    const head = `{${writeHead(canonical, seq).join(",")},"events":[`;
    let bytes = utf8Length(head) + 2; // "]}"
    const first = next;
    while (next < records.length && next - first < INPUT_MAX_EVENTS) {
      const add = utf8Length(records[next]) + (next > first ? 1 : 0);
      if (bytes + add > maxBytes) break;
      bytes += add;
      next++;
    }
    if (next === first)
      throw new InputEncodeError(
        "too-large",
        `record does not fit in ${maxBytes} bytes`,
        `events[${first}]`,
      );
    texts.push(`${head}${records.slice(first, next).join(",")}]}`);
    seq++;
  }
  return texts;
}
