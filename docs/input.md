# gsw-input/1

Status: **draft, normative**. Format string `gsw-input/1`. The TypeScript codec is
`@godot-scene-web/input` (`packages/input/src/codec.ts`, private until `/1` is frozen by its first
two consumers); the shared conformance vectors are `packages/input/conformance/v1/`. Godot citations
are to `../godot-4.5.1-stable`.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Purpose and non-goals

`gsw-input/1` carries keyboard, gamepad and pointer (mouse, pen, touch, wheel) input from a browser
to a Godot process, in **Godot's own vocabulary**, so the host builds an `InputEvent` per record and
calls `Input.parse_input_event` without a mapping table:

- a record's `event` is the Godot class minus `InputEvent`, in snake_case (`InputEventMouseButton`
  -> `mouse_button`);
- field names are Godot property names (`physical_keycode`, `button_index`, `axis_value`);
- enum fields carry Godot's ints (`core/os/keyboard.h`, `core/input/input_enums.h`; the TypeScript
  copies are `packages/input/src/godot-enums.ts`).

Non-goals:

- **No carrier.** A message is one UTF-8 text on any reliable, ordered, message-framed channel (a
  WebSocket, a WebTransport stream with framing, a product's own socket). Datagrams are out of
  scope for `/1`. Render-stream may carry it as an opt-in **input track** on its own connection
  (`render-stream-track.1`), never on the view connection.
- **No product vocabulary.** Semantic tokens (`faceSouth`, "end turn", a card id) belong to
  consumers, which adapt records to them: a consumer that keeps its own carrier and token
  vocabulary implements the capture `sink` itself and maps records to its tokens. The `action` record exists for
  hosts that opt into it, gated by an allow-list.
- **No host-to-browser messages in `/1`.** `vibration` (mirrors `Input.start_joy_vibration`) and
  `status` are reserved names; a browser codec treats them as `unknown-type`.
- **No game logic.** Deadzones are Godot's per-action job; gestures that mean something to one game
  are product hooks in the capture, not records.

## Envelope

A message is a JSON object whose UTF-8 encoding is at most **4096 bytes**. Members:

- `type` (string, required) selects the message type. Message types: `hello`, `events`, `sync`,
  `reset`, `bye`, `heartbeat`.
- Every message except `hello` carries `epoch` and `seq`.
- Member order on the wire is free; the canonical encoding (below) fixes one.
- Unknown members, in a message or a record, are ignored.
- A present `null` is not an absent member: it fails the member's type check.
- Senders MUST NOT emit duplicate member names; both reference parsers keep the last one.
- Numbers are JSON numbers, read as IEEE-754 doubles (GDScript's `JSON` yields floats).
  - An **integer** field accepts any finite double with no fractional part (`87.0` is `87`).
  - A **number** field accepts any finite double in range.
  - A literal that overflows to infinity (`1e400`) fails both.

Common message fields:

| Field    | Type    | Range                   | Notes                                                              |
| -------- | ------- | ----------------------- | ------------------------------------------------------------------ |
| `epoch`  | integer | 0..4294967295           | Chosen by the sender on every open (random u32); scopes `seq`.     |
| `seq`    | integer | 0..2^53-1               | +1 per message within an epoch; `hello` is the first.              |
| `reason` | string  | `[A-Za-z0-9._:-]{1,64}` | `reset` / `bye` only; informational (`hidden`, `dispose`, `blur`). |

### `hello`

Opens a session, or reopens it with a new epoch.

```json
{
  "type": "hello",
  "format": "gsw-input/1",
  "source": "k3P9xQ2m",
  "epoch": 2840193,
  "kinds": ["key", "joypad_button", "joypad_motion"]
}
```

| Field    | Type            | Required | Rule                                                                       |
| -------- | --------------- | -------- | -------------------------------------------------------------------------- |
| `format` | string          | yes      | Exactly `gsw-input/1`, else `unsupported-format`.                          |
| `source` | string          | yes      | `[A-Za-z0-9._:-]{1,64}`; stable across one sender's reconnects.            |
| `epoch`  | integer         | yes      | u32.                                                                       |
| `seq`    | integer         | no (0)   | The hello's own sequence number.                                           |
| `kinds`  | array of string | no ([])  | ≤ 32 names matching `[a-z][a-z0-9_]{0,31}`; advisory, unknown names legal. |

### `events`

```json
{
  "type": "events",
  "epoch": 2840193,
  "seq": 7,
  "events": [
    {
      "event": "key",
      "physical_keycode": 87,
      "keycode": 87,
      "key_label": 87,
      "unicode": 119,
      "pressed": true,
      "code": "KeyW"
    },
    { "event": "joypad_button", "button_index": 0, "pressed": true },
    { "event": "joypad_motion", "axis_value": -0.7344 }
  ]
}
```

`events` holds 1..64 records, applied in order. More than 64 is `too-many-events`; an empty array
is `bad-field`. A batch whose every record is of an unknown kind is valid and applies nothing (its
`seq` still counts).

### `sync`

The complete held state of one **scope**. The host diffs it against what it holds for this source
in that scope: it releases what is not listed and presses what is listed and not held. A sync heals
any earlier loss, so senders send one per attached scope right after `hello`.

```json
{
  "type": "sync",
  "epoch": 2840193,
  "seq": 8,
  "scope": "joypad",
  "device": 0,
  "held": [
    { "event": "joypad_button", "button_index": 0, "pressed": true },
    { "event": "joypad_motion", "axis": 4, "axis_value": 0.5 }
  ]
}
```

| Field    | Type    | Required     | Rule                                               |
| -------- | ------- | ------------ | -------------------------------------------------- |
| `scope`  | string  | yes          | `keyboard`, `joypad` or `pointer`.                 |
| `device` | integer | iff `joypad` | 0..15, the sender's pad slot; forbidden otherwise. |
| `held`   | array   | yes          | 0..64 records (more is `too-many-events`).         |

What `held` may list, checked after each record passes its own field checks:

| Scope      | Kinds                                                    | Constraint                                                                                                            |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `keyboard` | `key`                                                    | `pressed: true`, no `echo: true`.                                                                                     |
| `joypad`   | `joypad_button`, `joypad_motion`                         | buttons `pressed: true`; `device` (default 0) equals the sync's `device`. Axes not listed are 0.                      |
| `pointer`  | `target`, `mouse_button`, `screen_touch`, `mouse_motion` | buttons/touches `pressed: true`; no wheel button (4..7). `mouse_motion` = last position. Declarations apply in order. |

Another known kind in `held` is `bad-field` at `held[i].event`; an unknown kind is skipped. A
pointer sync's mouse buttons and touches carry `position` (required by their kind), so a host
pressing them presses at the right place.

### `reset`, `bye`, `heartbeat`

```jsonl
{ "type": "reset", "epoch": 2840193, "seq": 10, "reason": "hidden" }
{ "type": "bye", "epoch": 2840193, "seq": 11, "reason": "dispose" }
{ "type": "heartbeat", "epoch": 2840193, "seq": 12 }
```

- `reset`: release everything the source holds, in every scope; the session continues.
- `bye`: release everything and end the session.
- `heartbeat`: liveness only, while a session is open and idle.

## Records

Every record has `event` (string, required). Fields marked _req_ are required; every other field
is optional and means the **default** when absent. Defaults are Godot's (`core/input/input_event.h`)
except where noted. Ranges are inclusive. "vec2" is `[x, y]`, two numbers. "coord" is a vec2 with
`|x|, |y| ≤ 1000000`.

Fields are listed **in check order and canonical order** (see "Validation").

Modifier fields, wherever listed as _modifiers_: `shift_pressed`, `ctrl_pressed`, `alt_pressed`,
`meta_pressed` (booleans, default false), in that order.

Target fields, wherever listed as _target fields_: `target`, `local`, `frame` (see "Pointer
targets").

### `key` (`InputEventKey`)

| Field              | Type    | Range               | Default | Notes                                                                 |
| ------------------ | ------- | ------------------- | ------- | --------------------------------------------------------------------- |
| `physical_keycode` | integer | 0..0x7FFFFF         | 0       | `Key`, US-QWERTY position (`KeyModifierMask::CODE_MASK` range).       |
| `keycode`          | integer | 0..0x7FFFFF         | 0       | `Key`, the unshifted Latin label (see "Keyboard").                    |
| `key_label`        | integer | 0..0x7FFFFF         | 0       | `Key`, the label as printed with current modifiers.                   |
| `unicode`          | integer | 0..0x10FFFF         | 0       | Code point produced, or 0.                                            |
| `location`         | integer | 0..2                | 0       | `KeyLocation`: 0 UNSPECIFIED, 1 LEFT, 2 RIGHT.                        |
| `pressed`          | boolean | _req_               |         |                                                                       |
| `echo`             | boolean |                     | false   | Only with `pressed: true`.                                            |
| _modifiers_        |         |                     |         |                                                                       |
| `code`             | string  | `[A-Za-z0-9]{1,32}` | —       | DOM `KeyboardEvent.code`; informational, hosts MUST NOT interpret it. |

Cross-field, in order: `echo: true` needs `pressed: true` (path `echo`); at least one of
`physical_keycode`, `keycode`, `key_label` is nonzero (path `keycode`).

### `joypad_button` (`InputEventJoypadButton`)

| Field          | Type    | Range  | Default | Notes                                                             |
| -------------- | ------- | ------ | ------- | ----------------------------------------------------------------- |
| `device`       | integer | 0..15  | 0       | The **sender's pad slot**, not a Godot device id (see "Devices"). |
| `button_index` | integer | 0..127 | 0       | `JoyButton` (`JoyButton::MAX` = 128).                             |
| `pressed`      | boolean | _req_  |         |                                                                   |

No `pressure`: Godot never sets it (`InputEventJoypadButton.pressure` is documented as unused).

### `joypad_motion` (`InputEventJoypadMotion`)

| Field        | Type    | Range | Default | Notes                                   |
| ------------ | ------- | ----- | ------- | --------------------------------------- |
| `device`     | integer | 0..15 | 0       | Sender pad slot.                        |
| `axis`       | integer | 0..9  | 0       | `JoyAxis` (`JoyAxis::MAX` = 10).        |
| `axis_value` | number  | -1..1 | 0       | Sticks -1..1 (up is -1); triggers 0..1. |

### `mouse_button` (`InputEventMouseButton`)

| Field           | Type    | Range    | Default | Notes                                                                                            |
| --------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `button_index`  | integer | 1..9     | _req_   | `MouseButton`: 1 LEFT, 2 RIGHT, 3 MIDDLE, 4..7 WHEEL_UP/DOWN/LEFT/RIGHT, 8 XBUTTON1, 9 XBUTTON2. |
| `pressed`       | boolean | _req_    |         |                                                                                                  |
| `position`      | coord   | _req_    |         | Host root-window pixels; the host sets `global_position` = `position`.                           |
| `button_mask`   | integer | 0..511   | 0       | `MouseButtonMask` bits `1 << (button - 1)` **after** this edge.                                  |
| `double_click`  | boolean |          | false   |                                                                                                  |
| `canceled`      | boolean |          | false   | A release that did not complete (release-all, `pointercancel`).                                  |
| `factor`        | number  | 0..10000 | 1       | Wheel amount (see "Wheel"); ignored for other buttons.                                           |
| _modifiers_     |         |          |         |                                                                                                  |
| _target fields_ |         |          |         |                                                                                                  |

### `mouse_motion` (`InputEventMouseMotion`, mouse and pen)

| Field           | Type    | Range  | Default | Notes                                                                               |
| --------------- | ------- | ------ | ------- | ----------------------------------------------------------------------------------- |
| `position`      | coord   | _req_  |         | Host root-window pixels.                                                            |
| `relative`      | coord   |        | [0, 0]  | Summed since the previous motion record.                                            |
| `button_mask`   | integer | 0..511 | 0       |                                                                                     |
| `pressure`      | number  | 0..1   | 0       | Pen; a mouse with a button down reports 0.5 in DOM, senders SHOULD send 0 for mice. |
| `tilt`          | vec2    | -1..1  | [0, 0]  | Pen `tiltX/90`, `tiltY/90`.                                                         |
| `pen_inverted`  | boolean |        | false   | Eraser end.                                                                         |
| _modifiers_     |         |        |         |                                                                                     |
| _target fields_ |         |        |         |                                                                                     |

The host sets `screen_relative` = `relative` and `velocity` / `screen_velocity` from
`Input.get_last_mouse_velocity()` / `get_last_mouse_screen_velocity()`, as Godot web does
(`display_server_web.cpp:337-340`).

### `screen_touch` (`InputEventScreenTouch`)

| Field           | Type    | Range | Default | Notes                             |
| --------------- | ------- | ----- | ------- | --------------------------------- |
| `index`         | integer | 0..31 | 0       | Sender touch index (see "Touch"). |
| `pressed`       | boolean | _req_ |         |                                   |
| `position`      | coord   | _req_ |         |                                   |
| `canceled`      | boolean |       | false   |                                   |
| `double_tap`    | boolean |       | false   |                                   |
| _target fields_ |         |       |         |                                   |

### `screen_drag` (`InputEventScreenDrag`)

| Field           | Type    | Range | Default | Notes |
| --------------- | ------- | ----- | ------- | ----- |
| `index`         | integer | 0..31 | 0       |       |
| `position`      | coord   | _req_ |         |       |
| `relative`      | coord   |       | [0, 0]  |       |
| `pressure`      | number  | 0..1  | 0       |       |
| `tilt`          | vec2    | -1..1 | [0, 0]  |       |
| `pen_inverted`  | boolean |       | false   |       |
| _target fields_ |         |       |         |       |

### `magnify_gesture`, `pan_gesture` (host-gated)

| Kind              | Fields (in order)                                                         |
| ----------------- | ------------------------------------------------------------------------- |
| `magnify_gesture` | `position` coord _req_; `factor` number 0..10000 (default 1); _modifiers_ |
| `pan_gesture`     | `position` coord _req_; `delta` coord (default [0, 0]); _modifiers_       |

### `action` (`InputEventAction`, host-gated)

| Field      | Type    | Range                         | Default |
| ---------- | ------- | ----------------------------- | ------- |
| `action`   | string  | 1..128 UTF-8 bytes, no C0/DEL | _req_   |
| `pressed`  | boolean | _req_                         |         |
| `strength` | number  | 0..1                          | 1       |

A host MUST refuse an `action` whose name is not in its allow-list (default: empty).

### `target` (pointer target declaration)

Not a Godot event and never injected. Binds `handle` to a node identity for the rest of the epoch;
a later declaration of the same handle replaces the binding.

| Field         | Type    | Range                                       | Notes                                                                                    |
| ------------- | ------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `handle`      | integer | 1..1023, _req_                              |                                                                                          |
| `path`        | string  | 1..1024 UTF-8 bytes, no C0/DEL              | Godot `NodePath`; relative to `scene`'s instance when `scene` is present, else absolute. |
| `scene`       | string  | 1..512 UTF-8 bytes, no C0/DEL               | The scene file (`res://…`) the path is relative to, as in render-stream `item_meta`.     |
| `class`       | string  | `[A-Za-z_][A-Za-z0-9_]{0,63}`               | The node's class; informational.                                                         |
| `item`        | integer | 0..2^53-1                                   | Opaque renderer item id (render-stream item).                                            |
| `instance_id` | string  | 1..20 ASCII digits, 1..18446744073709551615 | Godot ObjectID in decimal, with no leading zero; a string to preserve values above 2^53. |

Cross-field, in order: `scene` needs `path` (path `scene`); `path` or `item` is present (path
`path`).

## Validation

Validation is identical in every implementation (TypeScript `parseInputMessage` /
`validateInputMessage`, the GDScript injector, any port), and the **first** failure wins, so
`code` and `path` agree across implementations. The order:

1. UTF-8 length of the text > 4096 -> `too-large`.
2. Not JSON, or not a JSON object -> `malformed`. `type` absent or not a string -> `malformed`.
3. `type` not one of the six -> `unknown-type` (path `type`).
4. `hello` only: `format` absent or not a string -> `bad-field`; not `gsw-input/1` ->
   `unsupported-format`.
5. The message's scalar fields in table order (`hello`: `source`, `epoch`, `seq`; others: `epoch`,
   `seq`, then `reason`).
6. The message's array or scope fields: `hello.kinds`; `events.events` (array, non-empty, ≤ 64);
   `sync.scope`, `sync.device`, `sync.held` (array, ≤ 64).
7. Each record in array order: not an object -> `bad-field` `events[i]`; `event` absent or not a
   string -> `bad-field` `events[i].event`; unknown kind -> skipped and counted, no further checks;
   known kind -> its fields in table order, then its cross-field rules, then (in `sync`) the scope
   rules.

| Code                 | Meaning                                              | Receiver action                       |
| -------------------- | ---------------------------------------------------- | ------------------------------------- |
| `too-large`          | Over 4096 UTF-8 bytes; not parsed.                   | Drop, count.                          |
| `malformed`          | Not a JSON object with a string `type`.              | Drop, count.                          |
| `unknown-type`       | A message type this version does not know.           | **Ignore**, count; never a violation. |
| `unsupported-format` | `hello` for another format.                          | Drop; the source stays unopened.      |
| `bad-field`          | A known member is missing, mistyped or out of range. | Drop the **whole** message, count.    |
| `too-many-events`    | `events` or `held` longer than 64.                   | Drop the whole message, count.        |

`path` names the member: `source`, `events[2].position`, `held[0].device`. Rejection is
**atomic**: one invalid known record drops the whole message, so a press is never applied without
the release it was batched with. `skipped` (records of unknown kinds) is reported beside an
accepted message.

No codec outcome closes the carrier in `/1`; a host MAY close a channel after repeated violations.

## Canonical encoding

`encodeInputMessage(message, { maxBytes })` writes:

- members in the table order above (`type`, then `format` for hello, then the scalar fields, then
  `kinds` / `events` / `scope`, `device`, `held`); records with `event` first, then table order;
- no whitespace, `JSON.stringify` numbers and strings;
- no optional member equal to its default (false flags, 0 ints, [0, 0] vectors, `factor` 1,
  `strength` 1, hello `seq` 0, empty `kinds`); required members always, even `pressed: false`;
- no unknown members.

Splitting: only `events` splits. Records that exceed `maxBytes` (default and maximum 4096,
minimum 64) or 64 per message are spread **in order** over consecutive messages numbered `seq`,
`seq + 1`, …; the sender's next `seq` is `seq + texts.length`. A single record that cannot fit,
or any other message type over budget, throws `InputEncodeError` (`too-large`); an invalid
message throws `InputEncodeError` (`invalid`, with the validator's `path`). A `sync` is never
split: it would no longer be the scope's complete state. Senders keep syncs small by construction (≤ 16 held keys
≈ 1.6 KB worst case; ≤ 17 buttons + 6 axes per pad ≈ 1 KB).

Precision is the sender's: captures SHOULD quantize axes to 1/256 and write ≤ 4 decimals, and
positions to ≤ 2 decimals. Validators do not check precision.

## Session

A **source** is one sender (one browser page's input session) named by `hello.source`. A
**channel** is one carrier connection. A host keeps per source: the current epoch, the last seq,
the held state per scope, the target handle table, and its device lease.

Sender rules (`createInputSession`):

- `open()` picks a new random u32 epoch and sends `hello` (seq 0), then one `sync` per attached
  capture scope, then events. Presses made before the carrier opened, and state lost across a
  reconnect, heal through these syncs.
- While closed, captures' pushes are **dropped**, never queued: replaying stale input after a
  reconnect is wrong (a key released meanwhile would be pressed again).
- Records pushed in one task are batched into one `events` message at the end of the microtask;
  oversize batches split (above).
- `heartbeat` every `heartbeatMs` (suggested 1000) while open and nothing else was sent.
- `reset` when the page loses input focus or is hidden (captures release first, so the reset is a
  safety net); `bye` on dispose.

How captures attach (TypeScript, `packages/input/src/session.ts`). A capture never sees epochs,
seqs or the carrier; it takes two small interfaces:

```ts
// Where a capture's records go, in order.
interface InputSink {
  push(record: InputRecord): void;
}
// The capture's held state right now, one entry per scope it owns.
interface InputSyncSource {
  heldState(): readonly InputHeldState[];
}
// A `sync` message without type, epoch and seq.
interface InputHeldState {
  scope: InputSyncScope;
  device?: number; // joypad only
  held: readonly InputRecord[];
}
```

A session is an `InputSink`; `session.attach(capture)` registers its `InputSyncSource`, whose
`heldState()` the session turns into `sync` messages after every `hello` and on `session.sync()`
(and at once when attached while open). A consumer with its own wire implements `InputSink`
itself and needs no session. The root entry is DOM-free, so the page wires focus loss and hiding
to `session.reset("blur" | "hidden")` after its captures released. A reset releases every scope
on the host, so pad buttons still held come back only with the next `sync()` or `open()`. The
session drops a pushed record the encoder refuses (invalid, or one record over budget) and still
sends the rest of its batch, so a bad record never costs a good release.

Host rules (the injector):

| Situation                                             | Action                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Non-hello message on a channel with no accepted hello | Drop, count `no-hello`.                                                                       |
| `hello` with a new epoch for a known source           | Release the old epoch's state, clear its handles, adopt the epoch; keep the source's devices. |
| `hello` repeating the current epoch                   | Drop as `duplicate`.                                                                          |
| `epoch` ≠ the source's current epoch                  | Drop, count `stale-epoch`.                                                                    |
| `seq` ≤ last accepted                                 | Drop, count `duplicate`.                                                                      |
| `seq` > last + 1                                      | Count `gap`, apply; the next `sync` of each scope heals.                                      |
| `reset`                                               | Release all; keep epoch and handles.                                                          |
| `bye`, channel closed (`close_channel`)               | Release all; forget the epoch and handles; keep the device lease for `lease_ms`.              |
| No message for `stale_timeout_ms` (0 = off)           | Release all; the next `sync` restores held state. Set it ≥ 3× the sender's heartbeat.         |
| A record of a kind the host does not accept           | Drop that record, count `kind-refused` (other records apply).                                 |
| `action` not in the allow-list                        | Drop that record, count `action-refused`.                                                     |
| A mouse record from a source not owning the mouse     | Drop that record, count `mouse-not-owner` (`mouse_owner`, below).                             |
| Over `max_events_per_second`                          | Drop the message, count `rate`; releases (`pressed: false`) still apply.                      |
| `lease_ms` after the source closed                    | Its devices detach and the source is forgotten; a later `hello` starts it afresh.             |
| Host window lost focus (`on_focus_lost`)              | Forget what was emitted, emitting nothing (Godot already released it); see "Injector API".    |

"Release all" means: every held key up (replaying the press record with `pressed: false`), every
held action up, every held joypad button up and every nonzero axis to 0, every held mouse button up
at the last position with `canceled: true`, and every active touch `pressed: false, canceled: true`.

A record referencing an undeclared handle is applied by its coordinate and counted
`undeclared-target` (the codec cannot see declarations; it is a session rule).

## Keyboard

Derivation rules for a capture built on DOM `KeyboardEvent` (`./keyboard`). They port
Godot web (`platform/web/dom_keys.inc`, `display_server_web.cpp:147-217`) and fix its
press/release mismatches.

- `physical_keycode` = Godot's DOM `code` table (`dom_keys.inc:33-218`, ported with its MIT header;
  includes `IntlBackslash`, `IntlYen`, `OSLeft`/`OSRight`, media keys). A `code` the table does not
  map (`IntlRo`, `Lang1`, `KanaMode`, `Unidentified`) is **not forwarded**.
- `location` = `dom_code2godot_key_location` (`dom_keys.inc:227-246`): Shift/Control/Alt/Meta/OS
  Left/Right; numpad keys stay UNSPECIFIED, as in Godot.
- `keycode` is the **unshifted Latin label**, Godot's definition of `keycode`:
  1. `key` is a named key in the table (`Enter`, `ArrowUp`; `AltGraph` -> `ALT`) -> that value.
  2. `key` is one code point `c`: with no Shift/AltGraph and `c` in 0x20..0x7E -> `upper(c)`
     (Godot's `fix_keycode`, `keyboard.cpp:483-488`); an ASCII letter -> `upper(c)` (AZERTY `KeyQ`
     "a" -> `A`); else `navigator.keyboard.getLayoutMap()` maps `code` to ASCII -> `upper` of that;
     else `physical_keycode`.
  3. `Dead`, `Process`, `Unidentified` and other names -> `physical_keycode`.
- `key_label` = `upper(c)` for a printable `c` (`fix_key_label`, `keyboard.cpp:490-495`), else
  `keycode`.
- `unicode` = `c` when `key` is exactly one printable code point (≥ 0x20, ≠ 0x7F; count code
  points, not UTF-16 units), else 0 (`fix_unicode`, `keyboard.cpp:476-481`).
- Modifier flags from `shiftKey`/`ctrlKey`/`altKey`/`metaKey`; a modifier key's own record does not
  set its own flag (`dom2godot_mod`, `display_server_web.cpp:147-160`).
- **A release replays its press record** (all keycodes, `location`, `unicode`, modifiers) with
  `pressed: false`, whatever the modifiers are now. Godot clears `keys_pressed`,
  `physical_keys_pressed` and `key_label_pressed` by the released values (`input.cpp`), and
  `InputEventKey::action_match` (`input_event.cpp:557-600`) matches by the same fields, so a
  release that differs from its press leaves a key or an action stuck.

Godot-web quirks this fixes:

| Godot web (4.5.1)                                                                                                                    | gsw-input/1                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `keycode` from the shifted `key`: Shift+1 presses `!` (0x21); Shift released first, the release is `1`, `!` stays in `keys_pressed`. | `keycode` unshifted (`KEY_1`); release replays the press.                  |
| `Dead` maps to `D` by its first byte (`dom_keys.inc:210-216`).                                                                       | `keycode` = `physical_keycode`, `unicode` 0.                               |
| Non-Latin layouts: `keycode` = a Cyrillic code point Godot binds nothing to.                                                         | Layout map -> Latin label.                                                 |
| IME composition swallowed while composing (`ime_started`), its releases too.                                                         | Press not forwarded while `isComposing`/229; a release still owed is sent. |

Capture policy (options, defaults in parentheses): `echo` (off; a latched key's repeat is sent as
`echo: true` when on, an unlatched repeat never); `chords` (`browser`: a non-modifier key with
Ctrl/Meta stays the browser's, AltGr — `getModifierState("AltGraph")` — exempt); `filter`;
`reservedCodes`; text-entry and activation guards; `preventDefault` on forwarded keys;
`macMetaRelease` (macOS drops keyups while Cmd is held: release latched non-modifier keys when
Meta goes down or up); `maxHeld` (16; the 17th press is not forwarded, counted). Releases are
**never** gated by a filter or guard. Blur, `visibilitychange` hidden, `pagehide`, disable and
dispose release every latched key.

The capture (`@godot-scene-web/input/keyboard`, `createKeyboardCapture({ sink, … })`) pushes
records to its `sink` one at a time; `heldState()` returns one `keyboard` held state (the latched
presses in press order, empty when none) for the syncs that follow `hello`. Defaults:
repeats dropped, `chords: "browser"`, `preventDefault: "scroll"` (Space, arrows,
Page Up/Down, Home, End; `"forwarded"`, `"none"` or a function otherwise), no `filter` or
`reservedCodes`, both guards on, `macMetaRelease` on for macOS and iOS. A `stage` element (the one
a pointer capture focuses) is never a text-entry or activation target. `stats()` counts every
press not forwarded by reason (`chord`, `text-entry`, `max-held`, …).

## Gamepad

W3C "standard" mapping to Godot (`input_enums.h:68-105`; the same table as Godot's own Web entry,
`godotcontrollerdb.txt:23`):

| W3C | Godot                            | W3C      | Godot                            |
| --- | -------------------------------- | -------- | -------------------------------- |
| b0  | `JoyButton.A` 0                  | b9       | `START` 6                        |
| b1  | `B` 1                            | b10      | `LEFT_STICK` 7                   |
| b2  | `X` 2                            | b11      | `RIGHT_STICK` 8                  |
| b3  | `Y` 3                            | b12..b15 | `DPAD_UP/DOWN/LEFT/RIGHT` 11..14 |
| b4  | `LEFT_SHOULDER` 9                | b16      | `GUIDE` 5                        |
| b5  | `RIGHT_SHOULDER` 10              | a0, a1   | `JoyAxis.LEFT_X/LEFT_Y` 0, 1     |
| b6  | `JoyAxis.TRIGGER_LEFT` 4 (0..1)  | a2, a3   | `RIGHT_X/RIGHT_Y` 2, 3           |
| b7  | `JoyAxis.TRIGGER_RIGHT` 5 (0..1) |          | (stick up is -1)                 |
| b8  | `BACK` 4                         | b17+     | dropped                          |

Triggers are axes 4/5 in 0..1, exactly as Godot web feeds them (`display_server_web.cpp:980-985`).
A button reads pressed from `pressed`, or a bare number, or `value ≥ 0.5`. `mapping: "standard"` is
accepted; `xr-standard` is always skipped; `""` (non-standard) follows `nonStandard`
(`skip` default — Firefox/Linux evdev order differs, `godotcontrollerdb.txt:24-26` — or
`as-standard`, or a function).

Analog policy: quantize to 1/256; values with `|v| < 0.02` are 0 (rest floor; it kills drift
without becoming a deadzone — **deadzones stay Godot's per-action job**); send only changed axes,
at most once per animation frame, optionally capped by `maxHz` (buttons are never delayed). Per
frame, every button release precedes every axis motion, which precede every press (slots ascending
within each). `neutralizeHeldOnStart` ignores a control already held in the first sample that has
a usable pad until it is released (axes: until `|v| < 0.35`). `latched(value, wasHeld)` (exported,
press at `>= 0.55`, release at `<= 0.35`, both overridable) gives press/release hysteresis to
adapters that need edges from an analog control.

Lifecycle: poll only while a pad is connected; a disconnect releases its buttons and zeroes its
axes; a hidden tab stops polling and releases; `getGamepads` is bound to `navigator`; an insecure
context (no Gamepad API) leaves the capture inert. Pad slots: `pads: "claim"` (default, below),
`"merge"` (all pads as slot 0: buttons ORed, the largest-magnitude axis wins) or `"each"`
(`Gamepad.index` -> slot). `maxSlots` (4 by default, at most 16) bounds the slots of `each` and
`claim`.

Claim (the fix for several windows on one machine, see "Many instances on one machine"):

- A window reports only the pads it has claimed. Unclaimed pads emit nothing and are absent from
  `heldState()`.
- A pad is claimed by a **fresh press** made while `hasFocus()` (default `document.hasFocus()`) is
  true. A fresh press is a button going down, or a trigger reaching 0.55 (released below 0.35);
  stick motion never claims. A press made while unfocused and still held when focus arrives is not
  fresh. A pad first seen with a button down (Chrome exposes a pad on its first press) counts as
  fresh.
- The claim takes the lowest free slot below `maxSlots`, not `Gamepad.index`, so a window's first
  pad is its slot 0. With every slot taken, a press claims nothing.
- The claim requests the Web Lock `gsw-input/pad/<index>/<id>` (`Gamepad.index`, `Gamepad.id`;
  exported as `padLockName`) with `ifAvailable`. A pad reports from the next frame after the grant.
  If another same-origin window holds the lock, the press is ignored and a later fresh press asks
  again. A claim never steals; a lock taken away (another holder's `steal`) ends the claim.
- The claiming press is consumed: every control held at the grant stays suppressed until released
  (the `neutralizeHeldOnStart` rule), so the game never sees it.
- The claim ends, and its lock is handed back, when the pad disconnects (also while hidden, from
  `gamepaddisconnected`) or the capture is disposed; closing the window drops its locks too. A
  disconnected pad must be claimed again. A hidden tab or `enabled() === false` releases the pad's
  controls but keeps the claim.
- **Fallback.** Without Web Locks (`locks: null`, no `navigator.locks`, or a manager whose
  `request` throws or rejects, as in an opaque-origin sandbox) claims are per-window: still
  focus-gated and consumed, granted at once, but not exclusive, so two windows that each see a
  focused press on one pad both report it. Use one window per pad there.
- **Exclusivity scope.** Web Locks are scoped to one browser profile's storage partition, so a
  claim is exclusive only among windows that share it. Incognito windows, other profiles and other
  browsers do not see each other's locks, so a pad can be claimed in each of them and its presses
  reach every claiming window. There, use one window per pad or `pads: "each"`. In Chrome an
  Incognito window and a normal window of the same origin do not share locks, so both can claim
  pad 0.

The capture (`@godot-scene-web/input/gamepad`) pushes records to its `sink` (an `InputSink`) one at
a time; `heldState()` (an `InputSyncSource`) returns each present slot's `joypad` held state
(pressed buttons, then nonzero axes) for the syncs that follow `hello`. `claims()` lists the current
claims (`index`, `id`, `slot`, `state` `pending`/`held`, `exclusive`) for diagnostics.

## Pointer

### Coordinate space

`position`, `relative`, `delta` are **host root-window pixels**: the space of
`Viewport.get_mouse_position()` on the root viewport, which is what Godot's display servers put in
`InputEventMouse.position` (`display_server_web.cpp:236-238`). The capture's caller supplies the
mapping from DOM client coordinates (`map(clientX, clientY) -> {x, y} | null`): a render-stream
consumer passes the client's `cssToPresentation` / `clientToGame(..)?.point`; others use the
bundled `objectFitMapper`. `null` (letterbox, off picture) means a press does not start there.
`map` may be expensive (a render-stream `clientToGame` is a hit test), so the capture calls it
sparingly: [once per motion record, at the flush](#when-map-is-called). **Every pointer record
carries its coordinate**, and the coordinate is always authoritative unless
the host's retarget policy says otherwise (below).

### Mouse buttons

DOM `button` 0/1/2/3/4 -> `LEFT`/`MIDDLE`/`RIGHT`/`XBUTTON1`/`XBUTTON2` (Godot web's own mapping,
`display_server_web.cpp:243-260`). `button_mask` is the mask after the edge (Godot web computes it
the same way, `:284-294`). A second button pressed while one is held arrives in DOM as a
`pointermove` with a changed `buttons` mask, not a `pointerdown`; captures diff `buttons` to emit
its edge. Edges come only from pointer events: `click`/`auxclick` are ignored. `double_click` comes
from DOM `detail == 2` on the press when the browser reports a click count there; Chromium reports
`detail` 0 on `pointerdown`, and then the capture applies Godot web's own rule
(`display_server_web.cpp:263-280`): the same button again within 400 ms and under 5 host px, and
the press after a double click starts over.

Browser traps captures handle: X1/X2 navigate history on mouseup unless prevented (`pointerup` and
`auxclick` `preventDefault`); a middle press starts autoscroll on Windows/Linux (`pointerdown`
`preventDefault`); right opens the context menu (`contextmenu` suppressed on the stage).

### Wheel

Each wheel step is a **press + release pair** of a wheel button with a `factor`, as Godot does
(`display_server_web.cpp:689-718`). The factor is the DOM delta times Godot web's per-`deltaMode`
constant (`display_server_web.cpp:667-686`):

| `deltaMode` | Constant | Example                  |
| ----------- | -------- | ------------------------ |
| 0 pixel     | 0.03     | `deltaY` 100 -> factor 3 |
| 1 line      | 0.3      | `deltaY` 3 -> factor 0.9 |
| 2 page      | 1.0      | `deltaY` 1 -> factor 1   |

| DOM          | `button_index`  |
| ------------ | --------------- |
| `deltaY < 0` | `WHEEL_UP` 4    |
| `deltaY > 0` | `WHEEL_DOWN` 5  |
| `deltaX < 0` | `WHEEL_LEFT` 6  |
| `deltaX > 0` | `WHEEL_RIGHT` 7 |

Two deliberate differences from Godot web:

- **Horizontal direction.** Godot web sends `WHEEL_LEFT` for `deltaX > 0`
  (`display_server_web.cpp:696-701`). That is inverted against Godot on Windows (`WM_MOUSEHWHEEL`
  > 0 -> `WHEEL_RIGHT`, `display_server_windows.cpp:5631-5635`), on macOS
  > (`godot_content_view.mm:907`) and against `ScrollContainer`, which scrolls right on
  > `WHEEL_RIGHT` (`scroll_container.cpp:150-163`). gsw-input follows the desktop platforms.
- **Both axes.** Godot web emits one direction per DOM wheel event (vertical wins). A capture emits
  a pair for each nonzero axis; Shift+wheel arrives as `deltaX` from the browser and is sent as is.

The press's `button_mask` includes the wheel bit, the release's does not (Godot web,
`:706-716`). Trackpad high-resolution deltas are accumulated, never dropped below a threshold: the
capture sums `delta × constant` per axis and sends each event's whole 0.0001 steps, carrying the
remainder to the next event.
Ctrl+wheel (a trackpad pinch) is prevented so the page does not zoom, and is dropped or sent as
`magnify_gesture` (option).

### Motion and pen

Mouse and pen motion is `mouse_motion`, coalesced to at most one per animation frame with
`relative` summed, flushed before any button edge so a fast move-then-press presses at the right
place. Pen fields: `pressure`, `tilt` (`tiltX/90`, `tiltY/90`), `pen_inverted` (the eraser
button, DOM `buttons & 32`). With pointer lock (option) `relative` comes from
`movementX/movementY` and `position` stays at the lock point.

#### When `map` is called

Move samples are buffered as raw client points and mapped **once per emitted motion record, at the
flush** (the animation frame, or any edge that flushes pending motion first); a consumer needs no
coalescing proxy or per-turn memo in front of the capture to keep `map` cheap. Edges (press,
release, wheel, a touch's down and up) still map at event time, so their positions are exact, and
a press flushes the pending motion first, as before. So a frame costs:

| What                                             | `map` calls                                     |
| ------------------------------------------------ | ----------------------------------------------- |
| a frame of N mouse / pen moves                   | 1 (the newest sample), whatever N               |
| a frame of N moves of a native touch (per touch) | 1                                               |
| a frame of N moves of a mouse-mode drag          | 1                                               |
| a press, release or wheel event                  | 1 (its own point) + 1 for the motion it flushes |
| a frame of N moves under pointer lock            | 3, whatever N (one scale probe: centre, +x, +y) |
| `coalescedEvents` (a record per sample)          | 1 per record, as every sample is a record       |

Consequences, so they are not mistaken for bugs:

- **Off picture at the flush.** The newest sample is mapped first. Only when it maps to `null` (a
  letterbox bar) does the flush walk back through that frame's earlier samples (at most 64 are
  kept) to the newest one that maps, which is where a sample-by-sample capture ended up. A frame
  entirely off picture sends nothing and keeps the position; that costs one `map` call per sample
  of the frame, as before.
- **The very first position** of a capture has no previous one: its batch maps the newest sample
  and, once, the first (so `relative` still counts from the batch's first sample).
- **Zero net motion** from samples that never left their client point (a chord's button-only
  `pointermove`) sends no `mouse_motion`; a there-and-back that did move still does.
- **Pointer lock** measures the host-px-per-movement-px scale once per flush, at the lock point,
  and applies it to the frame's summed `movementX/Y`. The lock point is fixed while locked, so
  this equals measuring per sample; a lock taken or dropped mid-frame flushes the earlier samples
  first. The 3 calls (up to 5 beside a letterbox edge) remain per record, not per sample.
- **`heldState()`** maps nothing: it reports the last flushed position, and the buffered motion
  follows as the next record (its `relative` counts from that position).
- Hooks run at the flush too: see mouse mode's `drag-move` below.

### Touch

`screen_touch` / `screen_drag` with `index` = the lowest free index (≤ 31) for a `pointerId`,
released on `pointerup`, and `canceled: true` on `pointercancel`. **Senders never synthesize
mouse records for touch in native mode**: Godot's `emulate_mouse_from_touch` (project setting,
default on, `main.cpp:3510`) already turns the first touch into a LEFT mouse button with device
`DEVICE_ID_EMULATION` (-1) (`input.cpp:840-860`), so a twin would press twice. `mode: "mouse"`
captures (for mouse-only games or hosts with emulation off) instead translate touch into mouse
records (hover-first, slop, tap = click, optional long-press = right click, two-finger drag =
wheel) and send no touch records; see [Mouse mode](#mouse-mode).

Release guarantees: `setPointerCapture` keeps a release that ends off the stage; a press that went
out is always released (at the last mapped point if the release maps to `null`); `pointercancel`,
`blur`, hidden, `pagehide` and dispose release held buttons and cancel touches.

### Pointer capture (`@godot-scene-web/input/pointer`)

```ts
const capture = createPointerCapture({
  stage: canvas,
  map: objectFitMapper(() => canvas.getBoundingClientRect(), {
    width: 1920,
    height: 1080,
  }),
  sink: session,
});
session.attach(capture);
createKeyboardCapture({ sink: session, stage: canvas }); // the focused stage is never a text field
```

`createPointerCapture({ stage, map, sink, mode, targets, … })` listens on `stage` for
`pointerdown`/`pointermove`/`pointerup`/`pointercancel`/`lostpointercapture`/`wheel`/`auxclick`/
`contextmenu`, and on `events` (`window`) for `pointerup`/`pointercancel` it missed and for `blur`
and `pagehide`, and on `visibility` (`document`) for `visibilitychange`. It pushes records to its
`sink` one at a time. `mode` is `"native"` (default) or `"mouse"` ([Mouse mode](#mouse-mode)),
which changes only what touch becomes. `targets` is `"off"` (default: no resolver runs and no
record carries target fields), `"press"` or `"all"` with a `resolveTarget` (see
[Pointer targets](#pointer-targets-opt-in)).

- Mouse and pen share Godot's one mouse. A move that changes only `buttons` is an edge, not a
  motion. Buttons that went down elsewhere on the page and were dragged onto the stage never press
  there. A pen eraser contact (`buttons & 32`, DOM `button` 5) presses `LEFT`; pen `pressure` and
  `tilt` are sent to 4 decimals, mice send no pressure. Touch sends no `pressure`.
- Positions are rounded to 0.01 px and clamped to the coord range; `relative` is the sum of the
  rounded position steps, so a host summing `relative` lands on `position`.
- Every press calls `preventDefault()` and focuses the stage (`focus` option, default on; a stage
  without a `tabindex` gets `tabindex="-1"`, removed on dispose), so a form control left focused
  cannot keep the keyboard capture's text-entry guard engaged. `touchAction` (default on) sets
  `touch-action: none`; `contextMenu` (default on) suppresses the stage's context menu.
- A wheel event off picture or while disabled is neither forwarded nor prevented. Ctrl+wheel is
  always prevented; `pinch: "drop"` (default) forwards nothing, `pinch: "magnify"` sends
  `magnify_gesture` with `factor = exp(-deltaY × constant / 3)` (1% per pixel-mode unit, > 1 when
  pinching out).
- `pointerLock` (default off) requests the lock on a press; `coalescedEvents` (default off) sends
  every `getCoalescedEvents()` sample as its own record instead of one per animation frame.
- `enabled()` gates presses, wheel and hover, never releases; `refresh()` releases when it turns
  false. A `lostpointercapture` while a pointer still holds a button or touch cancels it.
- `heldState()` returns one `pointer` scope: the last mouse position as `mouse_motion`, then the
  held mouse buttons in press order (each at the last position, `button_mask` the mask after it),
  then the active touches by index at their last points. No wheel buttons.
- `flush()` pushes pending motion now; `releaseAll()` releases buttons and cancels touches;
  `stats()` counts records by kind and refusals by reason (`inactive`, `off-picture`,
  `max-touches`, `pinch`, `unmapped-button`, and in mouse mode `extra-touch`, `intercepted`,
  `button-held`), plus `resolves` (resolver calls) and `declarations` (`target` records pushed).
- `hover(position, client?)` pushes one `mouse_motion` to a host-px point now;
  `click(button, position, client?)` pushes a press+release pair of any `MouseButton` there
  without a motion first (a wheel button is one wheel step, factor 1). Both return false and send
  nothing while inactive; `click` also refuses a button that is held. They let gesture hooks and
  product UI (a confirm button outside the stage) act on Godot's one mouse without
  desynchronizing the capture's own state. With targets on, `client` (the DOM client point the
  call stands for) is resolved as a native motion (`"all"`) or press would be; without it the
  records carry no target.

`objectFitMapper(box, presentation, fit = "contain", position = {x: 0.5, y: 0.5})` is DOM-free:
`box` is a client rect (or a getter, read per call), `presentation` the host root-window size (or
a getter), `fit` a CSS `object-fit` and `position` the `object-position` as fractions. Points
outside the visible picture (letterbox bars, outside the box) map to `null`.

### Mouse mode

`mode: "mouse"` translates touch into mouse gestures, for mouse-only games and hosts with
`emulate_mouse_from_touch` off. Mouse and pen are untouched: every button (right, middle, X1/X2),
chords, the wheel and pen fields go out exactly as in native mode. Touch never produces
`screen_touch` / `screen_drag`.

One gesture runs at a time, from its first finger down until its own fingers have lifted:

| Gesture        | When                                                          | Records (default)                                                   |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `touch-down`   | the first finger lands on the picture                         | none                                                                |
| `tap`          | it lifts having travelled under `touchSlop`                   | `mouse_motion`, LEFT press + release at the lift point              |
| `drag-start`   | it travels past `touchSlop` (raw client px)                   | `mouse_motion`, LEFT press at the **down** point                    |
| `drag-move`    | a dragging finger moves (once per motion record, see below)   | `mouse_motion` (coalesced per frame, `button_mask` 1)               |
| `drag-end`     | the dragging finger lifts or is canceled                      | LEFT release at the lift point, else the last mapped point          |
| `long-press`   | the finger stays under the slop for `longPressMs` (opt-in)    | `mouse_motion`, RIGHT press + release at the down point; then inert |
| `scroll-start` | a second finger lands while the first is still under the slop | none; the latch point is the two fingers' mapped centroid           |
| `wheel`        | the vertical centroid drift crosses `wheelStep` host px       | WHEEL_UP (fingers down) / WHEEL_DOWN pair, factor 1, at the latch   |
| `touch-end`    | the gesture's own fingers are all up, or it was canceled      | none                                                                |

- **Hover first.** Every press is preceded by a `mouse_motion` at its point: hover-first widgets
  ignore a press the cursor never reached, and a finger, unlike a mouse, never travelled there.
  Wheel ticks are not: Godot routes a wheel by its own `position`.
- **Tap.** A sub-slop lift is a click at the lift point. A second tap within 400 ms and 24 CSS px
  of the previous one presses with `double_click` (Godot web's window, a finger-sized radius); the
  tap after a double click starts over. A tap lifted off the picture sends nothing.
- **Drag.** Once past the slop the finger stays a drag even off the picture; motion that maps to
  `null` is skipped and the release goes to the last mapped point. Drag samples are buffered like
  mouse moves and mapped at the flush ([when `map` is called](#when-map-is-called)), so
  `drag-move` is **per coalesced motion record, not per `pointermove`**: one gesture per frame
  carrying the newest sample that maps (`clientX/Y` and `position` of that sample), or one per
  sample with `coalescedEvents` or no frame scheduler. A `drag-move` that repeats the previous
  mapped point is skipped. `intercept("drag-move")` therefore runs at the flush, with the frame's
  record not yet pushed (a hook that follows the finger, like a held-card lift, wants
  exactly the newest point). A drag lifted (or canceled) before the frame flushes its buffered
  sample first, so the record and the gesture precede the release. Gestures that depend on
  distance keep their meaning: slops are raw client px (no `map`), and the scroll's `wheelStep`
  uses the scale measured once at the latch.
- **Scroll.** Natural direction: fingers moving down pull the content down, which is `WHEEL_UP`.
  Drift counts only once either finger has travelled `scrollSlop` CSS px, then one tick per whole
  `wheelStep` (several in one move when a fast drag covers several), the remainder carried. Drift
  is converted to host px with the map's vertical scale at the latch. Horizontal drift is ignored.
  When one finger lifts, the other is inert until it lifts too.
- **Other fingers.** A third finger, a second finger during a drag or after a long press, and any
  finger left down after its gesture ended are ignored until they lift (`dropped["extra-touch"]`).
- **One mouse.** Touch-made presses share Godot's one mouse with the real mouse: a tap or drag
  cannot press LEFT while the mouse holds it (`dropped["button-held"]`). `heldState()` lists a
  dragging finger's LEFT like a mouse button, and never a touch.
- **Release guarantees.** A press that went out is always released: `pointercancel`,
  `lostpointercapture`, blur, hidden, `pagehide`, `enabled()` turning false (on `refresh()`) and
  dispose release a drag with `canceled: true` at the last mapped point, and leave every finger
  still down ignored until it lifts. Nothing else is ever owed: no other gesture holds a button.
- `enabled()` gates `touch-down`, taps, drag presses, long presses and wheel ticks, never releases.

`gestures` options (all optional, ignored in native mode):

| Option        | Default | Meaning                                                                |
| ------------- | ------- | ---------------------------------------------------------------------- |
| `touchSlop`   | 8       | CSS px of travel before a finger is a drag, not a tap                  |
| `longPressMs` | 0 (off) | ms of a still hold before `long-press`                                 |
| `scrollSlop`  | 16      | CSS px either scroll finger travels before drift scrolls               |
| `wheelStep`   | 56      | host px of vertical centroid drift per wheel tick                      |
| `intercept`   |         | `(gesture) => "send" \| "swallow"`: whether the default records go out |
| `onGesture`   |         | `(gesture, decision) => void`: told after the records (or the swallow) |

A gesture is `{kind, pointerId, clientX, clientY, position, button?, doubleClick?, canceled?}`:
`position` is the host point the default records act at (for `drag-start` and `long-press` the
down point, for `wheel` the latch), `null` only on a `touch-end` that maps nowhere.

**Hooks.** `intercept` is asked before the default records of `touch-down`, `tap`, `long-press`,
`drag-start`, `drag-move` and `wheel`; `drag-end`, `scroll-start` and `touch-end` are only
observed, so no hook can keep a press from being released. A swallow counts in
`dropped.intercepted` and means:

- `touch-down`: the product claims the finger; nothing comes of it except its `touch-end`.
- `tap`, `drag-move`, `wheel`: that one gesture sends nothing.
- `drag-start`: no press; the finger is inert until it lifts.
- `long-press`: nothing is sent and the finger **stays pending**, so a later lift is still a
  `tap` and travel still a `drag-start`.

Hooks may call the capture's `hover()` and `click()` (also from inside `intercept`), which keeps
the capture's mouse state exact. Example product gestures, as recipes:

- Tap-to-focus: swallow a `tap` on an item not yet armed and `hover(gesture.position)`; let the
  re-tap of the armed item through.
- Held-card peek: `longPressMs: 100`; swallow the `long-press` on a hand card, lift it and
  `hover(position)`; swallow the `tap` that ends a peek; clear on `touch-end`. A peek that then
  travels is still a drag.
- Confirm tap: swallow a `tap` on a confirm-eligible widget and `hover(position)`; the product's
  button later calls `click(MouseButton.LEFT, position)`.

### Pointer targets (opt-in)

Only the client knows where a node was **drawn** when the user pointed at it: a client-side
override may have enlarged or raised it, a widescreen re-layout may have moved it, and by the time
the event arrives the host's node may have moved on. Targets let the client say "the user meant
_this node_, at _this point in it_", for presses, releases, wheel **and motion** (hover and focus),
on mouse, pen and touch.

Wire shape, designed so motion stays cheap:

1. The first time a node is hit, a `target` declaration defines a handle (1..1023):
   `{"event":"target","handle":3,"path":"Hand/Card2","scene":"res://scenes/combat.tscn","class":"Control","item":812}`.
2. Pointer records (`mouse_button`, `mouse_motion`, `screen_touch`, `screen_drag`) then carry the
   target fields:

| Field    | Type    | Range     | Rule                                                                                                                                                              |
| -------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target` | integer | 0..1023   | A declared handle, or 0 = "over no node".                                                                                                                         |
| `local`  | coord   |           | Required with a nonzero `target`, forbidden otherwise: the point in the node's own coordinates, measured against the transform the user saw (overrides included). |
| `frame`  | integer | 0..2^53-1 | Needs `target`: the renderer's id of the picture on screen (render-stream: the drawn transaction).                                                                |

A motion that stays on one node costs `"target":3,"local":[x,y]`; a full identity is sent only
when the hovered node changes. Handles are per epoch: a sender re-declares after every `open()`.
A sender MAY recycle handles (least recently used) by re-declaring; the host table is bounded by
the range.

```json
{
  "type": "events",
  "epoch": 7,
  "seq": 3,
  "events": [
    {
      "event": "target",
      "handle": 3,
      "path": "Hand/Card2",
      "scene": "res://scenes/combat.tscn",
      "class": "Control",
      "item": 812
    },
    {
      "event": "mouse_button",
      "button_index": 1,
      "pressed": true,
      "position": [512.5, 300],
      "button_mask": 1,
      "target": 3,
      "local": [12, 40.5],
      "frame": 1907
    }
  ]
}
```

Cost and opt-in (capture `targets` option):

- `"off"` (default): no resolver call, no target bytes (asserted by the tests).
- `"press"`: one resolve per press, release and wheel event (all steps of one wheel event share
  it). Capture-made cancels are never resolved.
- `"all"`: additionally one resolve per **coalesced** motion record (at most one mouse motion and
  one drag per touch per animation frame), never per raw `pointermove`. With `coalescedEvents`
  every sample is its own record, so it is resolved too.
- Mouse mode resolves the same way: a gesture's hover-first motion (`"all"`) and its drag
  motion, and its presses and releases (both modes) at the client point the gesture stands for
  (`drag-start` and `long-press`: the finger's down point).
- Nothing is resolved while the pointer is locked.
- The resolver is caller-supplied: `resolveTarget(clientX, clientY, point)` returns a
  `PointerTargetHit` `{key, identity: {path?, scene?, class?, item?, instanceId?}, local: {x, y}, frame?}`
  or `null` (over no node: the record carries no target fields; the capture never sends
  `target: 0`). `key` is any value compared as a `Map` key (the same node, the same key). A hit
  without a valid `path` or `item` counts as none; invalid fields are dropped, so a resolver
  cannot make the codec refuse a message; a resolver that throws counts as no target.
- Handles are interned per key, declared once per epoch and re-declared under the same handle
  when a key's identity changes (an identity grant arriving late). Past 1023 keys the least
  recently used handle no held state references is recycled. `heldState()` (run after every
  hello) forgets every declaration and lists the ones its records reference first; a held motion
  or touch keeps its target only while its point is the one it was resolved at, and held buttons
  carry none (their press's `local` no longer matches the point).
- Bundled resolvers live in their owning packages, so `input` depends on no renderer and they
  import nothing from `input`:
  - render-stream-client `pointerTargetResolver(client, {climb})`: `cssToPresentation`, the
    core's `hitTest` (topmost drawn item, overrides included), then a `parent` climb to the
    first item whose `meta(id).node` is true (or the item `climb(hit, query)` returns; `null`
    for none). `local` is the drawn point through `(E · T)⁻¹` (the item's game transform `T`
    under its composed override `E`), `frame` the drawn transaction. Identities need the host's
    `GRC_ITEM_META` grant for the fields `pointerTargetIdentity()` (an extension) asks; without
    it a hit is `{item}` only. On demand only: the client does no per-frame work for it, and the
    pure client's hello and wire are unchanged. When an extension asks for `instance_id` or
    `mouse_filter`, a /13 endpoint offers exactly `render-stream.14`; TAG1-only wants and an empty
    extension list keep `render-stream.13`. An explicit /14 endpoint always offers /14. V2 wants
    against /11 or /12 throw the client's typed bad-option error at construction. A host without
    the v2 grant refuses the handshake through the existing failure/reconnect path; there is no
    downgrade offer. The v2 fields arrive only when granted: `instanceId` is a decimal string
    (ObjectIDs can exceed JavaScript's safe integer range), and `mouseFilter` is `"stop"`, `"pass"`,
    `"ignore"`, or `null` for a non-Control. `hasPointOverride` reports a scripted `_has_point`;
    the resolver still uses the streamed rect. A resolved target includes `identity.instanceId`
    when its row carries one.

    Host-carried filters win over `ExtensionSession.mouseFilter` statements for the same item,
    including a host `null` (non-Control, treated as IGNORE). Statements still apply to items
    without a v2 row. Full metadata replaces the host table, deltas restamp rows, and removals
    drop them; changed filters are copied to the core at most once per frame. With a
    `mouse_filter` grant, picking defaults to Godot's tree order (`z_index` ignored, undrawn
    Controls found by their rect). `ExtensionSession.pickOrder("drawn")` overrides that default.
    Sessions with consumer statements alone keep draw order unless they call `pickOrder("tree")`.
    The default resets with each session. `clientToGame` uses the same filters and order.

  - html `htmlPointerTargetResolver(model | () => model, {scene, root, document})`:
    `elementFromPoint` (which skips `mouse_filter = IGNORE` Controls, rendered
    `pointer-events: none`, as Godot's picking does), the closest `[data-godot-path]`, `local`
    from that element's client rect scaled to the Control's model size (exact unrotated; a
    rotated Control is measured against its bounding box). `scene` is the `res://` file the
    model's paths are relative to; `key` is the node path.

The client's desktop metadata cost probe runs from the repository root:

```bash
experiments/render-stream/scripts/lib/quiet.sh exclusive -- mise exec -- pnpm exec tsx \
  --conditions=development packages/render-stream-client/scripts/bench-item-meta.ts
```

It compares TAG1 and v2 parsing of a synthetic 4,202-row full record and measures the TypeScript
filter-table rebuild separately. It discards one warmup and reports medians of five repeats in
microseconds per full record or whole filter table. The filter sink validates the packed table;
the probe does not measure the wasm transfer. An optional output path writes the JSON report.

Host semantics (the injector, `gsw_input_targets.gd`):

- Zero work when a record has no `target` (or `target` 0) and nothing is bound.
- Handles resolve once to live nodes and are kept as weak refs, re-resolved when a node is freed
  or leaves the tree (or the handle is re-declared):
  - with `instance_id`: first resolve the exact ObjectID via `instance_from_id`. It must be a
    valid `CanvasItem` inside the tree; values at or above 2^63 cannot name a Node. When it
    resolves, ignore `path` and `scene`. When it does not, emit `target_missing` and use the
    coordinate (or the configured `missing_target` policy); **never fall back to `path` or
    `scene`**, since a stale id must not select a different node;
  - absent `instance_id`, with `scene`: under every instance root whose `scene_file_path` is
    `scene` (one tree walk per resolution), `path` relative to it (`.` is the root). Several live instances make the
    path ambiguous: the one the coordinate lands on wins, else the target is missing (counted
    `target-ambiguous`), never a guess;
  - absent `instance_id` and `scene`: an absolute NodePath (`/root/…`) from the tree root, a
    relative one from the current scene (the tree root when there is none);
  - an identity with only `item` (a renderer id) names no node here: missing.
- Every targeted event gets `event.set_meta("gsw_target", {path, local, handle})` (the declared
  path, `""` when only `item` was declared), whether or not its node resolved: the meta is the
  sender's intent. `pointer_target(source, event, node, local)` fires, just before injection,
  only for a resolved node. The meta survives Godot's per-Control event copies (`xformed_by`
  merges meta), so `_gui_input` reads it; Godot's emulated mouse from a touch carries none.
- `retarget` policy (`"when-missed"` default):
  - `"off"`: the coordinate is used as sent.
  - `"when-missed"`: if the coordinate does not land on the target node **now**, the host rewrites
    `position` to the node's screen transform (`CanvasItem.get_screen_transform()`, root-window
    px) applied to `local`. A Control lands when the point, through the inverse of that
    transform, is inside `Rect2(Vector2.ZERO, size)`; another CanvasItem when `transform * local`
    is within `target_tolerance` (1 px) of the point. A node that is not a CanvasItem is never
    moved.
  - `"always"`: every targeted event is placed by node + `local`.
  - Motion follows the same rule, so hover and focus land on the node the user is over.
- **Held-button binding.** A press binds its target and the offset it was moved by (zero when it
  landed or its node is missing) until its release: every event of that held mouse button (the
  first press of a chord binds; the binding ends when every button is up) or touch, motion,
  release, wheel step, moves by that offset and carries the press's target, whatever target it
  names itself, with the meta's `local` recomputed through the node's inverse transform. Drags
  and sliders stay on their node, and relative motion is preserved.
- `missing_target`: a handle that cannot be resolved, or a node that is not visible in tree,
  emits `target_missing(source, identity)` and falls back to the coordinate (`"coordinate"`,
  default) or drops the event (`"drop"`, counted `target-dropped`). Releases are never dropped,
  so nothing stays held.
- `verify_targets` (default false): on `tick()`, the last targeted mouse event's Control target
  is compared with `Viewport.gui_get_hovered_control()`; `target_mismatch(source, identity,
hovered)` fires when the hovered Control is neither the target nor inside it (`hovered` null
  when nothing is hovered). Diagnostics only.
- Limits: nodes inside a SubViewport are placed in root-window px only through embedded windows
  (`get_screen_transform`), not through a `SubViewportContainer`; a game reading positions from
  `DisplayServer` instead of events sees the original coordinate.

## Many instances on one machine

Several Godot processes on one machine (local multiplayer seats, a host plus headless instances) and several
browser windows on one machine both break naive input. Rules:

- **Physical pads are seen by every process.** InputMap matches a binding when
  `binding.device == -1 || binding.device == event.device` (`input_map.cpp:150`), and default
  bindings are -1 (all devices), so every Godot process reacts to a pad plugged into the machine.
  `GswJoypadIsolation.isolate(devices)` rewrites each all-devices joypad binding to the host's
  virtual device ids, so physical pads (driver ids 0..15) stop matching while injected events
  still do. Limits: direct `Input.is_joy_button_pressed(0..15)` reads, Steam Input (which never
  consults the InputMap: it needs a product-side patch), and
  remaps made after isolation (call it again).
  Isolate while no joypad action is held: a press that matched an all-devices binding must be
  released by an event that matches the rewritten one.
- **Virtual devices.** The injector maps (source, slot) to `device_base + block * 4 + slot`,
  `device_base` 64 (≥ `Input::JOYPADS_MAX` 16, `input.h:81`), every id < 2048 because Godot packs
  `device << 20` into button and axis keys (`_combine_device`, `input.cpp:357-363`). A source gets
  the lowest free block on its first pad record and keeps it across reconnects until `lease_ms`
  after it closes. Injected devices read as pressed through `Input` and the InputMap but never
  appear in `get_connected_joypads()`, `get_joy_name()` or `joy_connection_changed`; the injector
  emits `joypad_attached` / `joypad_detached` and lists them in `remote_joypads()` instead.
- **Browser windows share pads too.** `pads: "claim"`: a window claims a pad by a fresh press while
  `document.hasFocus()`; Web Locks (`gsw-input/pad/<index>/<id>`, `ifAvailable`) make the claim
  exclusive across same-origin tabs; the claim press is consumed until released; the lock drops on
  disconnect and dispose (details and the no-Web-Locks fallback under "Gamepad"). Other origins and
  browsers cannot be coordinated: use one window per pad.
- **Keyboard follows focus.** Only the focused browser window receives keys; a capture releases
  everything on blur. On the host, a **windowed** Godot instance that loses OS focus calls
  `Input.release_pressed_events()` (`input.cpp:1281-1295`; called from every desktop display
  server's focus-out), which clears keys, joypad buttons and axes but not the mouse mask, and
  silently drops injected holds. `GswInputInjectorNode` clears its emitted set on focus loss and can
  `reassert` held state on focus-in. Windows (`WM_ENTERSIZEMOVE`) and macOS (`windowDidMove`) also
  release on a window drag, with no focus notification; holds then return with the next `sync`.
  Headless instances report focus always and are unaffected.
  Products whose game gates keys on its own window focus
  cannot be driven by keys from a browser on the same machine while the browser holds focus.
- **One mouse per Godot instance.** `Input` has a single mouse position and button mask. With
  several sources, `mouse_owner` (`"last-active"` default, `"first"`, or a fixed source) picks one;
  other sources' mouse records are dropped and counted, and a change of owner first releases the
  previous owner's buttons. Touches are multi-source: each source gets its own index range, so two
  viewers' fingers never collide (Godot emulates the mouse from the first touch only,
  `mouse_from_touch_index`, `input.cpp:842-856`).
- **Never `warp_mouse`.** On a windowed instance it moves the real OS cursor. Injected mouse and
  touch events carry a virtual device id, so the optional physical-pointer filter
  (`install_event_filter`) can drop the local physical mouse/touch (device 0) on a windowed
  instance; it never drops `DEVICE_ID_EMULATION` (-1) events, and it cannot undo the `Input`
  state and hover the physical event already changed (see "Injector API"). Headless
  `DisplayServer.mouse_get_position()` is always (0, 0) (`servers/display_server_headless.h:176`):
  games that read it instead of events or `Input.get_mouse_position()` see no motion.

## Security

The host parser runs **inside the game process** on bytes from the network: treat every message as
hostile.

- Size: 4096 bytes checked **before** JSON parsing; ≤ 64 records; strings length-capped in UTF-8
  bytes; arrays capped (`kinds` 32).
- Range: every number range-checked, integers integral, non-finite rejected; device ids, touch
  indices, handles and button indices bounded, so no record can address a device, index or handle
  table entry outside its range (device ids < 2048 by construction).
- Rate: `max_events_per_second` (default 2000) per source; releases are never dropped by it.
- Kinds: `accept_kinds` gates kinds (default key, joypad, mouse, touch); gestures and `action` are
  off unless enabled; `action` additionally needs `allowed_actions`.
- No member is ever used as a method name, a resource path to load, or a class to instantiate.
  `path`/`scene` are only looked up under the host's own tree.
- New `InputEvent` instances per record (`input.cpp:1205-1227` warns on reuse).
- The carrier authenticates the sender; `gsw-input` has no credential. Render-stream's input track
  needs its own grant and a credential that is never the view token.

## Injector API (reference GDScript, `packages/input/godot/addons/gsw_input/`)

Summary:

- `GswInputInjector` (RefCounted):
  - `receive(channel, text, now_msec) -> String` (`""` or a code);
  - `close_channel(channel, now_msec)`, `release_all()`, `tick(now_msec)`, `on_focus_lost()`,
    `reassert()` (every `now_msec` defaults to `Time.get_ticks_msec()`);
  - `remote_joypads() -> Array[int]`, `device_for(source, slot) -> int`,
    `virtual_devices(sources) -> Array[int]`, `stats() -> Dictionary`, `mouse_source() -> String`
    (the source owning the mouse, or `""`);
  - `pointer_device_for(source) -> int`, `touch_index_base(source) -> int`;
  - `static install_event_filter(root) -> GswInputPointerFilter`;
  - `configure(Dictionary) -> bool` sets any of the config below from JSON values.
- Config: `accept_kinds`, `allowed_actions` (`[]`), `device_base` (64), `devices_per_source` (4),
  `share_devices` (false), `key_device` (0), `lease_ms` (30000), `stale_timeout_ms` (0),
  `reassert_on_focus_in` (false), `max_events_per_second` (2000), `mouse_owner` (`last-active`),
  `retarget` (`when-missed`), `missing_target` (`coordinate`), `verify_targets` (false),
  `target_tolerance` (1.0 px).
- Signals: `source_opened`, `source_closed`, `joypad_attached(device, source, slot)`,
  `joypad_detached`, `rejected(channel, code, detail)`, `pointer_target`, `target_missing`,
  `target_mismatch`.
- `GswInputInjectorNode` (Node, `injector` property): calls `tick()` every frame
  (`PROCESS_MODE_ALWAYS`, so a paused tree still times sources out); on the root window's
  `focus_exited` and `NOTIFICATION_APPLICATION_FOCUS_OUT` calls `on_focus_lost()`; on
  `focus_entered` / `NOTIFICATION_APPLICATION_FOCUS_IN` calls `reassert()` when
  `reassert_on_focus_in`; `release_all()` when it leaves the tree.
- `GswJoypadIsolation.isolate(devices: Array[int]) -> Dictionary` and `restore(saved)` (static):
  see "Many instances on one machine".
- `GswInputDevices`: the injector's device allocator (blocks, attach/detach).
- Ledger: per source held keys/buttons/nonzero axes/touches, plus a global emitted refcount so a
  control two sources hold is released on its last holder.

`gsw_input_json.gd`, `gsw_input_codec.gd` and `gsw_input_injector.gd` inject `key`,
`joypad_button` and `joypad_motion`; `gsw_input_devices.gd`, `gsw_joypad_isolation.gd` and
`gsw_input_injector_node.gd` add device allocation, isolation and the node wrapper;
`gsw_input_pointer.gd` (with the filter in `gsw_input_pointer_filter.gd`) adds the pointer kinds and
`action`. `magnify_gesture` and `pan_gesture` pass the gates and are counted `kind-unsupported`.
`gsw_input_targets.gd` fills each source's handle table from target declarations and places
targeted records as "Pointer targets" describes. Host
behaviour the session table leaves open:

- **Shared controls.** `Input` keeps `physical_keycode`, `keycode` and `key_label` in three sets,
  so the refcount is per set entry: a press reaches `Input` with only the entries no other source
  holds (the rest 0), a release with only the entries whose last holder let go, and nothing at
  all when no entry changes. A joypad button is refcounted per device. A shared axis
  (`share_devices`) shows the last nonzero value written; when a holder returns to 0 it falls back
  to the largest-magnitude remaining holder, else 0. Axes are sent only when the shown value
  changes.
- **Key identity.** A held key is identified by its first nonzero `physical_keycode`, `keycode`,
  `key_label`. A release replays the host's stored press record, so it clears exactly what the
  press set even when the sender's release differs. A second press of a held key is dropped
  (`repeat`); an echo or release of a key, or a release of a button, the source does not hold is
  dropped (`unheld`).
- **Order.** Release all goes keys (press order), actions (press order), joypad buttons, axes, mouse
  buttons (ascending `button_index`, only if the source owns the mouse), then touches (press
  order), source by source in hello order. A sync releases what it does not list, then presses
  what it lists.
- **Channels.** A `hello` binds its source to the channel. A new epoch on another channel unbinds
  the old one (its later messages are `no-hello`); a `hello` for another source on a bound channel
  first closes the channel's previous source.
- **Devices.** A source's pad slot is on `device_base + block * devices_per_source + slot`
  (`device_base + slot` with `share_devices`). The block is acquired with the source's first
  joypad record or joypad `sync` (a keyboard-only source takes none): the lowest block whose ids
  all fit under 2048, else the record is dropped (`device-refused`), as is a slot ≥
  `devices_per_source`; a later record tries again. A device is attached (`joypad_attached`, in
  `remote_joypads()`) when its first holder first uses the slot. A closed source keeps its block
  and devices until `lease_ms` (30000; 0 = on close) after it closed, so a `hello` from it on any
  channel within the lease gets them back. When the lease ends (checked by `tick` and by each
  `hello`) its devices detach (`joypad_detached`, slot order; with `share_devices` only when no
  other holder is left), its block is free and the source is forgotten. Set the device config
  before the first `hello`.
- **Focus loss.** `on_focus_lost()` is for after Godot's `Input.release_pressed_events()`
  (keys, joypad buttons, axes and actions gone, no release events): it clears the emitted
  refcounts and moves each source's held keys, actions, buttons and axes aside, emitting nothing. Then a release of a
  set-aside control is applied silently, a press presses again, an echo of a set-aside key is
  `unheld`, a `sync` of the scope replaces them, and `reassert()` presses what is still set aside
  (keys in press order, then actions at their strength, then buttons, then axes, source by
  source, through the refcounts).
  Release all discards them. Pointer state is left alone: Godot keeps the mouse button mask.
- **One mouse (`mouse_owner`).** One source owns Godot's mouse at a time:
  - `"last-active"` (default): the first source to send a mouse record claims it. A mouse press
    from another source (wheel steps included) takes it over. That source's motion and releases
    are dropped (`mouse-not-owner`), so a second viewer's hover never moves the cursor under the
    first.
  - `"first"`: the first source keeps the mouse until its session closes.
  - Any other value is a fixed source id, and only that source drives the mouse.

  A takeover first releases the previous owner's held buttons. The owner keeps the mouse through
  `reset`, a new epoch and `stale_timeout_ms`; `bye` and `close_channel` give it up. A press of a
  held button is `repeat`, and a release of a button that is not held is `unheld`.

- **Mouse events.** `position` and `global_position` come from the record. `button_mask` comes from
  the host's ledger, not the record: it is the owner's held buttons after the edge. A wheel press
  includes its own bit and its release does not, as Godot web sends them. `factor`,
  `double_click`, `canceled` and the modifiers come from the record. A motion sets `relative` =
  `screen_relative` from the record, and `velocity` / `screen_velocity` from
  `Input.get_last_mouse_velocity()` / `get_last_mouse_screen_velocity()`. Godot's `Input` buffer
  accumulates consecutive motions with the same mask and modifiers into one event
  (`InputEventMouseMotion::accumulate`), and consecutive drags of one index the same way.
- **Touch ranges.** Sender touch index `i` of a source is host index
  `touch_index_base(source) + i`: 32 × the lowest range free at the source's first `hello`, kept
  until the source is forgotten at lease end. A drag
  or release of an index the source does not hold is `unheld`. The host never emits a mouse
  twin of a touch: `emulate_mouse_from_touch` makes exactly one LEFT press (device -1) from the
  first active touch of any source. That emulated button shares `Input`'s one mask with the
  mouse owner's buttons.
- **Synthesized releases.** Every release the host makes up is sent with `canceled: true`:
  release all, a takeover, and a sync that no longer lists a button or touch. A mouse button goes
  up at the last mouse position, a touch at its own last position, so a game never reads such a
  release as a completed click or tap.
- **Pointer sync.** The mouse part runs first: release unlisted buttons, emit the listed
  `mouse_motion` (if any), then press listed buttons that are not held. Listed buttons count as a
  press for `"last-active"`. A sync whose mouse part the policy refuses counts one
  `mouse-not-owner` per mouse record. Touches run next: release unlisted touches, then press
  listed ones that are not held.
- **Pointer devices.** Mouse and touch events carry `pointer_device_for(source)`: the first id of
  the source's leased block (`device_base` with `share_devices`), taken with its first pointer
  record without attaching a pad (its pad slot 0 later attaches on the same id). It is never 0, so
  the physical-pointer filter can tell them apart. `InputEventAction` carries `key_device`.
- **Actions.** An allow-listed `action` becomes an `InputEventAction` (`strength` from the record,
  default 1). It is refcounted per name across sources like a key: the press reaches `Input` on
  the first holder and the release (strength 0) on the last. A press of a held action is `repeat`,
  and a release of one the source does not hold is `unheld`.
- **Physical-pointer filter.** `install_event_filter(get_tree().root)` adds a
  `GswInputPointerFilter`. It drops `InputEventMouse`, screen touch/drag and gesture events from
  device 0, and passes everything else, `DEVICE_ID_EMULATION` (-1) included. `Viewport.push_input`
  runs `_input` before GUI and `_unhandled_input` (`viewport.cpp:3447-3458`), and `_input` runs in
  reverse tree order. The filter is an `INTERNAL_MODE_BACK` child of the root, so it stays last in
  tree order even after later scenes are added, sees each event first and marks dropped events
  handled. What it cannot undo:
  - `Input` has already applied the event: the mouse position, the button mask, and actions bound
    to mouse buttons.
  - The root viewport has already updated its hovered Control (`viewport.cpp:3431-3436`).
  - A physical touch's emulated mouse is device -1, so it passes.
- **Reading the mouse.** `Input.get_mouse_position()` is not bound for scripts in 4.5.1. Scripts
  read `Viewport.get_mouse_position()`. On headless (no `FEATURE_MOUSE`) that returns `Input`'s
  injected position. On a windowed host it reads the OS cursor (`DisplayServer.mouse_get_position()`,
  `viewport.cpp:1455-1461`), so games should take positions from events. Injected events also
  drive `Input.get_mouse_button_mask()` and the GUI.
- **Stats.** `stats()` holds only nonzero counters: the codec codes, `skipped`, the session codes
  (`no-hello`, `stale-epoch`, `duplicate`, `gap`, `rate`, `stale-timeout`), and per record
  `kind-refused`, `action-refused`, `kind-unsupported`, `undeclared-target`, `device-refused`,
  `mouse-not-owner`, `repeat`, `unheld`. A dropped or ignored message also returns its code from
  `receive`.

Porting notes (C++ module, C# / .NET hosts):

- Validate in the order of "Validation" and report the same `code`/`path`; run every
  `conformance/v1/codec` vector. Measure UTF-8 bytes of the received text before parsing.
- JSON numbers: read as double, then check finite, integral and range before converting; never
  cast first (C# `System.Text.Json` `GetInt32` throws on `87.0`; read `GetDouble`).
- Strings: length limits are UTF-8 bytes (GDScript `to_utf8_buffer().size()`, C#
  `Encoding.UTF8.GetByteCount`), not characters.
- GDScript: do not parse with Godot's `JSON`. Its number reader is not correctly rounded (it
  reads `9007199254740991` as 2^53, so a legal `seq` fails), it stops at 1024 levels of nesting,
  it refuses lone surrogate escapes and it accepts texts `JSON.parse` rejects (`01`, `1.`, any
  character ≤ 0x20 as whitespace). `gsw_input_json.gd` is a strict reader with `JSON.parse`'s
  grammar; port it, or use the host language's own standard parser.
- Build a fresh `InputEvent` per record; set `device` to the virtual id, `global_position` =
  `position` for mouse kinds, `screen_relative` = `relative`.
- C# hosts that inject through a product API MAY adopt only the record
  vocabulary and session rules, and keep their own injection; the release-all and held-button
  rules still apply.

## Conformance

`packages/input/conformance/v1/`:

- `codec/*.json`: `{description, vectors: [{name, text, ok, code?, path?, skipped?,
canonical?}]}`.
- `keymap/*.json`: `{description, vectors: [{name, dom: {type, code, key, shiftKey, …,
altGraph, repeat, isComposing, keyCode}, layout?, press?, expect}]}`, `expect` a key record or `null` (not forwarded).
  `altGraph` is `getModifierState("AltGraph")`, `layout` a `getLayoutMap()` snapshot. With `press`
  (the keydown that latched the key), `dom` is its keyup and `expect` the replayed release.
- `gamepad/*.json`: `{description, vectors: [{name, frames: [{pads: [{mapping,
buttons, axes, index?, id?}], t?, visibility?, focus?, others?, dispose?}], options, expect}]}`,
  `expect` the records pushed per frame. A runner fires `gamepadconnected`/`gamepaddisconnected`
  when a frame's pad set changes and `visibilitychange` when `visibility` does, then runs the
  pending poll at time `t`. `focus` is `document.hasFocus()` from that frame on (default true);
  `others` lists the lock names another window holds from that frame on. Each vector gets a Web
  Locks manager of its own unless `options.locks` is `null`, and lock grants settle between frames.
- `injector/*.json`: `{name, description, config, steps, expect}`, one vector per file
  named after it; `config` is injector settings. A step is one of `{recv, channel?, at?,
result?}` (a message object, or a text for exact bytes; channel default `"a"`; `at` sets the
  clock in ms; `result` is `receive`'s expected return, default `""`), `{close: channel}`,
  `{tick: msec}`, `{release_all: true}`, `{focus_lost: true}` (Godot's
  `release_pressed_events()`, then `on_focus_lost()`), `{reassert: true}` and
  `{isolate: [device]}` (`GswJoypadIsolation.isolate`, undone after the vector). `expect`
  lists `{after, physical_keys, keys, labels, joy_buttons, joy_axes, actions, mouse_mask,`
  `mouse_position, dispatched, joypads, joypad_signals, stats}`, the real `Input` state after
  step `after`: key codes in each set; `[device, button]`; nonzero `[device, axis, value]`; the
  test project's actions pressed; `Input.get_mouse_button_mask()`; the root viewport's mouse
  position (checked only where listed, since `Input` keeps it across vectors); the events
  `_input` received since the previous entry, Godot's emulated mouse included (`key P/K/L
down|up|echo`, `joy_button D B down|up`, `joy_motion D A V.VVVV`, `action NAME down|up S.SS`,
  and for pointer events, with `X,Y` as `%.2f,%.2f`: `mouse_button D B down|up X,Y mask=M
[factor=F.FF] [canceled] [double] [+shift]…`, `mouse_motion D X,Y rel=X,Y mask=M
[pressure=P.PP] [tilt=X,Y] [inverted] [+shift]…`, `screen_touch D I down|up X,Y [canceled]
[double]`, `screen_drag D I X,Y rel=X,Y [pressure=…] [tilt=…] [inverted]`); `remote_joypads()`;
  the joypad signals since the previous entry (`attached|detached D source slot`); every nonzero
  counter. An absent field is empty (`mouse_mask` 0). A dispatched event tagged with
  `gsw_target` meta ends with ` meta=HANDLE`. Target vectors add `scene` (nodes created
  under the root before the first step, freed after: `{path, class: Node|Control|Node2D,
position?, size?, scale?, visible?, scene_file_path?}`), the scene steps `{move: path,
position}`, `{free: path}`, `{add: node}`, `{hide: path}`, `{show: path}`, and two expect
  fields: `gui`, the scene Controls' `_gui_input` since the previous entry (`PATH mouse_button D
B down|up X,Y`, `PATH mouse_motion D X,Y`, `PATH screen_touch I down|up X,Y`, `PATH
screen_drag I X,Y`, control-local, then ` meta=HANDLE:PATH@X,Y` when tagged), and
  `target_signals` (`pointer_target SOURCE NODE X,Y`, `target_missing SOURCE HANDLE`,
  `target_mismatch SOURCE HANDLE NODE|-`). Hover reaches `_gui_input` only inside the headless
  root's 64×64 visible rect (`gui.mouse_in_viewport`, `viewport.cpp:2064`), so target vectors
  keep their Controls there. Godot runs them
  (`packages/input/godot/tests/injector_selftest.gd`, `pnpm test:input-godot`); a TypeScript
  model of the injector and of `Input` (mouse mask, touch emulation, the accumulating buffer)
  checks them without Godot (`packages/input/test/model-injector.ts`; the target half, the test
  scene and Godot's GUI routing in `model-targets.ts`).
  `tests/pointer_selftest.gd` adds what vectors cannot see: a test Control's `gui_input` for every
  button and wheel direction, and the physical-pointer filter.

Codec vectors: every implementation MUST match `ok`, `code`, `path` (when given) and `skipped`
(default 0). `canonical` is the TypeScript encoder's output for an accepted message (a host does
not encode). Vectors cover every message type and record kind, target declarations and targeted
pointer records, the 4096/4097 byte boundary (ASCII and two-byte characters), atomic reject,
skipped unknown kinds, ignored unknown types and members, nesting past 1024 levels (accepted: no
depth limit), lone surrogate escapes (accepted, read as U+FFFD, three UTF-8 bytes each), and every
error code.

A consumer that controls its host can send `gsw-input/1` text as is and run
`GswInputInjector` there.

## Versioning

Additive changes stay `/1`: a new optional member, a new record kind, a new message type (old
receivers skip or ignore them). A changed meaning, a new required member, a narrowed range or a
changed default is `/2`.
