# render-stream-audio/1 wire format

`render-stream-audio/1` is an opt-in audio connection to the seat listener, with
subprotocol `render-stream-audio.1` and payload format `gsw-audio/1`. It is versioned
independently of the view protocol and `render-stream-track/1`. All multi-byte binary
integers are unsigned little-endian, except the signed PCM16 samples. Times in µs
are integers on the capture's steady clock. The track carries rendered FMOD PCM,
never FMOD banks, engine code, or client-side event/parameter replay.

## Normative operating rules

- `GRC_LIVE_TRACKS=audio` (or a list including `audio`) grants audio. Its credential
  is `evidence/live-track-audio-token` or a capability with kind `audio`, separate
  from view and input credentials. Admission uses `GRC_LIVE_MAX_TRACKS` and the
  carrier's track pool; granted subprotocols include `render-stream-audio.1`.
- The built-in audio receiver is the only audio receiver. Script `bind("audio")`
  returns `track-kind-bound`. Hello receiver check succeeds only if Godot sample
  capture or an attached cue producer is armed; otherwise `track-no-receiver`.
- The clock is `std::chrono::steady_clock` in microseconds: CLOCK_MONOTONIC on
  Linux/Android, QPC on Windows, libc++ steady clock on macOS. Host and seat must
  share a machine and clock domain (Linux boot_id, otherwise boot instant rounded
  to 1 s). A domain mismatch disables FMOD with reason `clock-domain`.
- One seat audio sender owns all sends. Priority is strictly control texts, then
  takes, then lanes. It hands off only while queued bytes are below
  `GRC_LIVE_AUDIO_QUEUE_BYTES`. At dequeue, a lane block past
  `due_us + GRC_LIVE_AUDIO_LANE_LATE_MS × 1000` is dropped; the next block sent
  for that lane has `gap`. Control and takes are never dropped: waiting beyond
  `GRC_LIVE_AUDIO_STALL_MS` closes `audio-stalled`; reconnect snapshots resync.
- Audio has its own socket or QUIC session, queue and sender, independent of view
  fragments. A carrier with thread-safe media sends uses the sender thread and
  never reuses a local connection id in one run. Without that support sends run
  at the frame callback (`send_path: "frame"` rather than `"thread"`). WT must
  advertise audio support (feature bit 1) or the client falls back to WS.
- Each connection's `have` set controls take delivery. Every cue goes to every
  connection; if any lacks the key, the seat sends one host `want` immediately,
  in parallel with the cue. Takes render once per cold key or stream from the
  host cache. Only lacking connections receive take-start, blocks and take-ready.
  An optional immutable hash WAV route (`<takeBase><hash>.wav`) and index are for
  warming/reloads, never on the cue path.
- The product relays opaque, ordered reliable host/seat link messages. Cue
  producers compute keyIds; capture refuses a mismatch with the canonical key.
  Producer calls are allocation-free and dormant with no connection. Overflow
  of the producer ring or pending relay closes all affected audio connections
  `audio-overflow`, so cues cannot silently disappear.
- The optional host FMOD renderer binds only already-loaded game libraries; a
  failure disables FMOD for the session. The module is loaded on the first FMOD
  subscriber and is never unloaded. Rendering systems exist only while subscribed.
  FMOD group gains of zero suppress sends and unsubscribe their lanes. Renders
  and assets have unity gain; the client applies Godot bus and FMOD group gains.
  Group gains are linear amplitude; the toolkit imposes no product volume curve.
  Loop cue kinds gate lane gain on the client.
- Godot registered samples have SHA-256-addressed variants: original MP3 bytes,
  re-muxed Ogg Vorbis, and RIFF PCM16 WAV at native rate/channels as fallback.
  WAV is built on a worker only when a connection lacks the original codec.
  Assets use `/resources/sha256/<hash>` or WT `0x01`, with view-token bearer
  authorization. They remain served while registered or voiced, plus 30 s.
- Samples have `store: false`, HTTP `Cache-Control: no-store`, and client memory
  lifetime only while referenced if looping, longer than STORE_MAX_MS, or
  started on a NO_STORE_BUSES bus. The bus rule precedes its start message.
  Otherwise HTTP policy is `private, max-age=31536000, immutable`.
- The seat owns voice end via a playback clock integrating pitch and pauses:
  end = start time + remaining frames / (rate × pitch). It answers activity and
  position from that clock and emits exactly one stop, at the first frame
  callback after the deadline. Clients never report an end.
- Without a grant no capture hooks, ring, sender, renderer or audio evidence is
  installed, and the subprotocol is refused. With a grant but no connection,
  Godot hooks do one relaxed load and one O(1) fixed-slab write retaining samples
  and voices for join snapshots, without allocation, message or timer. Cue calls
  do one relaxed load and return. Before the first FMOD subscriber the host module remains unloaded.
- A viewer's Audio toggle opens/closes this connection. The client
  `@godot-scene-web/render-stream-client/audio` subpath exports `openAudioTrack`
  independently of the main entry and tracks subpath. Secure contexts default
  to Worker transport and AudioWorklet mixing; otherwise main-thread WebAudio
  nodes implement the same scheduling. Godot web-driver ports retain MIT notices.
- Every seat event text carries event capture time `t` and carrier hand-off
  time `s`; blocks carry made/due/sent times. Opt-in client stage tables and
  seat `render-stream-live-audio/1` evidence expose counts, drops, gaps, stalls
  and send path. Taps contain control types/counts, never PCM, assets or keys.

## Connection and handshake

The hello is a `track-hello` (the track/1 handshake rules below) with these values:

```json
{ "type": "track-hello", "protocol": "render-stream-audio/1", "kind": "audio",
  "formats": ["gsw-audio/1"], "credential": "…", "client": "test-web",
  "audio": { "codecs": ["pcm16"], "sample_codecs": ["ogg-vorbis", "mp3", "wav"] } }
```

- `audio` is an optional member (unknown hello members are ignored). `codecs` lists the block codecs
  the client decodes; `pcm16` is required. `sample_codecs` lists the asset codecs it decodes,
  client preference first; `wav` is always accepted, listed or not. A missing `audio` member means
  `{codecs:["pcm16"], sample_codecs:["wav"]}`.
- `track-ready` adds
  `audio: {clock_us, rate: 48000, lane_block_frames: 512, codec: "pcm16", godot: bool, fmod: bool, lanes: [{id, name, group}]}`.
  `clock_us` is the capture clock when the ready was sent.
- The inherited refusals and closes are listed below. New close reasons:

| Reason | Code | When | Client reconnects |
| ------ | ---- | ---- | ----------------- |
| `audio-stalled` | 1001 | Control or take messages waited past `GRC_LIVE_AUDIO_STALL_MS` | yes |
| `audio-overflow` | 1013 | The producer ring or the seat's pending relay overflowed: the seat could no longer guarantee every cue | yes, after at least 1 s |
| `audio-protocol` | 1002 | A client text outside the client text grammar | no |

## Payload phase

### Binary block (host to client), little-endian, 48-byte header

| Off | Size | Field | Rule |
| --- | ---- | ----- | ---- |
| 0 | 2 | `magic` | `0x47 0x41` ("GA") |
| 2 | 1 | `version` | 1 |
| 3 | 1 | `kind` | 1 take, 2 lane |
| 4 | 1 | `flags` | bit 0 `first`, bit 1 `last`, bit 2 `silent` (no payload; the decoder writes zeros), bit 3 `gap` (earlier blocks of this stream were dropped); other bits 0 |
| 5 | 1 | `lane` | 0 for a take; 1–15, a lane id from `track-ready` |
| 6 | 1 | `codec` | 0 `pcm16` (s16le interleaved); 1 reserved (Opus) |
| 7 | 1 | `channels` | 2 |
| 8 | 4 | `stream` | take: the host-assigned take stream id, non-zero, unique per host run; lane: the lane epoch, +1 per lane renderer start |
| 12 | 4 | `block` | 0-based index within the stream |
| 16 | 4 | `rate` | 48000 |
| 20 | 2 | `frames` | take 1–2048; lane = `lane_block_frames` |
| 22 | 2 | reserved | 0 |
| 24 | 8 | `made_us` | capture clock when the producer (host module or seat) finished the block |
| 32 | 8 | `due_us` | capture clock when frame 0 is due: take = cue `t` + offset; lane = the host lane clock |
| 40 | 8 | `sent_us` | capture clock when the seat's sender handed it to the carrier (the seat rewrites it; 0 on the link) |
| 48 | n | payload | `frames × channels × 2` bytes, or 0 when `silent` |

A decoder refuses a block with any rule broken, and the connection closes `audio-protocol`. The
host never sends anything else as binary. Any change to this layout needs `render-stream-audio/2`.

### Host texts (JSON, one object, `type` first; ≤ 65536 B)

Every text from a seat event carries `t` and `s` (µs integers). Voice and sample ids are u32,
assigned by the seat from 1 upward per run and never reused. They are never Godot ObjectIDs.

| `type` | Members | Meaning |
| ------ | ------- | ------- |
| `audio-state` | `godot: {buses, voices} \| null`, `fmod: {bankset, groups, lanes} \| null` | The snapshot after every `track-ready`, followed by one `sample` per registered or still-playing sample and `voice-volumes` updates restoring every changed route. `buses` is in bus-index order (see Buses below). `voices` entries are `start` members plus `position_s` and `paused`. |
| `sample` | `id, variants: [{codec, hash, bytes}], channels, rate, length_ms, loop: {mode, begin, end}, store` | Registration (`register_sample`) or a re-announce (store class changed). `mode` is `disabled\|forward\|pingpong\|backward`. `variants[0]` is the original codec. `begin`/`end` use its units: frames for `wav`, seconds for `mp3`/`ogg-vorbis` (Godot's `loop_offset`). A client selecting the native-rate WAV fallback converts seconds to frames with `round(seconds × rate)`. `sample-variant` carries no loop. |
| `sample-variant` | `id, codec, hash, bytes` | A lazily built `wav` variant is ready. |
| `sample-drop` | `id` | `unregister_sample`. While voices retain the sample, defer the drop until immediately after the last voice’s `stop`, including for snapshot recipients; an unannounced sample gets no drop. |
| `start` | `voice, sample, bus, offset_s, pitch, volumes: [8 floats]` | `start_sample_playback` (the web driver's argument set, `audio_driver_web.cpp:274-299`). `bus` is an integer index; volumes are four linear stereo pairs (L,R × 4 channels). |
| `stop` | `voice, reason: "stop"\|"end"` | Exactly one per `start` or snapshot voice. |
| `pause` | `voice, paused` | `set_sample_playback_pause`. |
| `pitch` | `voice, pitch` | `update_sample_playback_pitch_scale`. |
| `voice-volumes` | `voice, buses: [{bus, v: [8 floats]}]` | `set_sample_playback_bus_volumes_linear`. Bus identities are integer indices; `v` contains four linear stereo pairs. |
| `bus` | `op: count\|add\|remove\|move\|send\|volume_db\|solo\|mute`, `bus`, `value` | One per `set_sample_bus_*` call, in call order; integer indices and operation-specific values as below. |
| `cue` | `key_id, key, kind: oneshot\|loop-start\|loop-stop\|loop-stop-all, group, pitch, volume` | A producer cue . Loop kinds only gate a lane's gain on the client. |
| `groups` | `gains: {name: gain}, snapshot: bool` | FMOD group gains . |
| `take-start` | `key_id, stream, frames, bankset` | Before the first take block, only to a connection that lacks the key. |
| `take-ready` | `key_id, stream, hash` | After the `last` block. `hash` = SHA-256 of the take's canonical WAV (the warm route's name). |
| `take-unavailable` | `key_id, reason` | `refused-not-oneshot`, `refused-bus`, `unknown-event`, `fmod-off`, `link-down`. |
| `lanes` | `lanes: [{id, name, group, state: on\|off\|unavailable}]` | Lane state after a subscription change. |
| `clock` | `c, h` | Reply to a client `clock`: `h` = capture µs at reply. |
| `track-error` | (track/1) | Before a host close. |

### Buses

Bus identity is always the integer Godot bus index: `start.bus`,
`voice-volumes.buses[].bus`, `bus.bus`, and send targets. The host resolves names
with the bound `AudioServer.get_bus_index(name)` before emitting. An unknown name
maps to -1: a voice routes to Master and a send routes directly to the destination.
The client never resolves diagnostic names.

`audio-state.godot.buses` is in bus-index order (array position = Godot index).
Each entry is `{name: string, volume_db: number, send: int, solo: bool, mute: bool}`.
`send` is a destination bus index, or -1 for none. Master (bus 0) always has send
-1 and feeds the output. An empty array means one Master bus at 0 dB, send -1,
not soloed or muted. New buses take these default fields.

| `op` | `bus` | `value` |
| ---- | ----- | ------- |
| `count` | 0 | New count (int); truncate or extend. |
| `add` | Insert position (-1 = append) | Absent. |
| `remove` | Index | Absent. |
| `move` | From-index | To-index (int). |
| `send` | Index | Destination index (int; -1 = none). |
| `volume_db` | Index | Number. Non-finite Godot gains use finite float32 bounds: −∞ and NaN become −3.40282347e38 (exact silence after dB→linear), and +∞ becomes 3.40282347e38. |
| `solo` | Index | Bool. |
| `mute` | Index | Bool. |

Index shifts after `add`, `remove` and `move` follow Godot's semantics. Move
positions refer to the array before removal: a forward move inserts at
`to-index - 1`, a backward move at `to-index`, and -1 appends. Existing routes
retain their bus identity when indices shift. Out-of-range indices close
`audio-protocol`.

### Client texts (≤ 4096 B, track/1's rate bucket)

| `type` | Members | Meaning |
| ------ | ------- | ------- |
| `lanes` | `ids: [1–15]` | Lanes wanted (replaces the previous set). |
| `have` | `bankset, key_ids: [32 hex], reset: bool` | Takes the client holds. The first after open has `reset: true`. Several messages may follow, each listing at most 100 ids. |
| `clock` | `c` (`performance.now()` ms) | A clock sample request. |

Anything else closes `audio-protocol`. `""` is the keepalive. The client never sends voice state
or an end.

### Clock and scheduling (client)

- **Estimator.** 8 `clock` samples 50 ms apart after open, then one every 5 s. This is a
  media-clock sync, not a game poll. The offset comes from the minimum-RTT sample. Capture clock
  to `AudioContext` time goes through `getOutputTimestamp()`.
- **One-shots** (`start` of a non-looping voice, cached `cue`) start as soon as they are handled,
  from offset 0. This rule applies even to a late one-shot.
- **Looping voices** that start late start at `offset + lateness`.
- **Voice-relative commands** (`stop`, `pause`, `pitch`, `voice-volumes`) are scheduled at
  `A + (t − t_start)`, where `A` is the context time the voice actually started. Durations inside
  a voice are therefore exact, whatever the network delay.
- **`stop {reason:"end"}`** stops the voice at that mapped time if it is still playing.
- **Lane blocks** play at `due_us + 60 ms` (the jitter target). After a stall, the backlog is
  dropped, never played late.

## Carriage per carrier

| Carrier | Control texts | Take blocks | Lane blocks | Assets |
| ------- | ------------- | ----------- | ----------- | ------ |
| `ws`/`wss` | text frames | binary frames | binary frames; drops at the sender | HTTP GET on the same port |
| `wt` | `0x00` live stream (render-stream-wt/1 framing) | one `0x02` stream per (connection, take) | `0x03` segment streams | `0x01` resource streams, accepted on audio sessions |
| `ext` / RTC tunnel | as `ws` (one ordered channel) | as `ws` | as `ws` | the product's route |

- **`0x02` take stream:** `u8 0x02`, `u8[16] key_id`, then repeated `u32le length` + block, then
  FIN after the block flagged `last`. The key_id in the stream header removes any ordering
  dependency on `take-start`. A `take-unavailable {key_id}` control resets that connection's open
  take stream for the key with application error `0x03 abandoned`, releases its stream credit,
  and drops its sender state. The client discards the partial take and keeps the session open,
  whichever of the reset and control text arrives first. Any other take reset, or FIN without
  `last`, is fatal. Evidence counts `take_abandoned`.
- **`0x03` lane segment stream:** `u8 0x03`, `u8 lane`, then up to 8 length-prefixed blocks,
  then FIN after the eighth block. Blocks are sent immediately, without waiting to fill a segment.
  Once the newest block's `deadline_us` passes, a segment not known complete (still open, or FIN'd
  with acknowledgement unresolved) is reset with application error `0x02 stale`. The next block
  opens a new segment. A FIN'd, acknowledged segment is never reset. Lane `END_GROUP` is ignored.
  Deadlines are compared only against the optional, size-guarded carrier-host `now_us` callback,
  which uses the capture's steady-clock epoch. Without it WT does not reset lanes; carrier evidence
  records `lane_reset: "no-clock"`. Evidence counts `reset_open` and `reset_unacked` separately.
- **Client selection:** `openAudioTrack` accepts `webTransport: {url, certificateHashes?, features}`
  alongside its WS `url`. The product passes the loaded net module's feature bitmap. Audio uses
  WT when bit 1 is set and the carrier is available, otherwise WS; `carrier` selects `auto`,
  `websocket` or `webtransport`. The descriptor and carrier are forwarded to the audio Worker.
  Header keys identify take streams independently of `take-start`; control and media may arrive
  in either order. Stale lane and abandoned take resets keep the audio session open; other take
  failures do not.
- **Datagrams** are reserved for a later codec.

### Inherited track/1 handshake rules

The track/1 envelope is reused with the audio protocol/kind/format above. It has
required type, protocol, kind, formats and credential; optional down_formats
(default []), client (default ""), and advisory view (default null). Formats are
1..8 unique `<name>/<N>` strings, names `[a-z][a-z0-9.-]{0,47}`, N 1..65535
without leading zero. down_formats has 0..8. Client labels match
`[A-Za-z0-9._:-]{0,64}`. A view is `{stream_id: 32 lowercase hex, connection: integer ≥ 1}`.
Credentials are 64 lowercase hex or enabled track/1 capabilities. Unknown members
are ignored. The hello is at most 4096 UTF-8 bytes.

The host checks in order: (1) UTF-8 then hello grammar; (2) grant; (3) credential,
constant-time, rejecting view tokens separately; (4) receiver armed; (5) common
format in client preference order. It replies track-ready or track-error followed
by a close carrying the same reason. Error detail is `[a-z0-9-]{0,32}`, never a
secret. Ready preserves protocol, source, kind, format, down_format, keepalive_ms,
max_message_bytes and rate `{messages_per_second, burst}` from track/1 plus audio.
The client must read ready before sending payloads. Audio payload rules below
replace track/1's text-only payload phase.

Empty text is a keepalive, sent after keepalive_ms without other sends. Either
side closes track-idle after 3 × keepalive_ms without receiving anything. Client
texts, including keepalives, consume the track/1 token bucket. Hello timeout is
GRC_LIVE_HELLO_TIMEOUT_MS (default 5000). A client closes with 1000; there is no bye.
WS/WSS uses `/render-stream`, Origin/upgrade/subprotocol checks then track-pool
admission, with credential checked in the hello. WT uses extended CONNECT to
`/render-stream?protocol=render-stream-audio.1`, its live-stream hello and uplink
rules. Client binary is close 1003; oversized client text is close 1009.

| Reason | Code | Reconnect |
| --- | --- | --- |
| track-protocol | 1002 | no |
| track-utf8 | 1007 | no |
| track-hello-timeout | 1002 | yes |
| track-kind-refused | 1008 | no |
| track-unauthorized | 1008 | no; expired capability may refresh, at most 3 consecutive times |
| track-no-receiver | 1013 | yes |
| track-format-refused | 1008 | no |
| track-rate | 1008 | after at least 1 s |
| track-idle | 1001 | yes |
| track-receiver-gone | 1013 | yes |
| track-closed | 1000 or 4000..4999 | 1000 yes; 4xxx no |
| stream-ended | 1001 | yes |
| track-credential-failed (client) | 1011 | yes |
| track-credential-invalid (client) | 1008 | no |
| carrier inbound errors | 1009, 1003, 1002 | no |
| carrier admission | HTTP 503 | yes |
| carrier upgrade refused | HTTP 400, 403, 404 | no |

## `grc-audio-link/1` (host↔seat messages)

Every message is `u8 type` + body, little-endian. The product carries each one as one opaque,
ordered, reliable message per seat. Under pressure the product may drop only whole type-1 lane
messages.

| Type | Direction | Body |
| ---- | --------- | ---- |
| 0 `hello` | both | `u16 version=1`, `u8[16] clock_domain`, `u8[16] bankset` (host; zero from the seat), `u8 n_lanes`, then `{u8 id, u8 len, name, u8 len, group}` per lane (host) |
| 1 `block` | host→seat | one the binary audio block (`sent_us` = 0) |
| 2 `take-start` | host→seat | `u8[16] key_id`, `u32 stream`, `u32 frames` |
| 3 `take-ready` | host→seat | `u8[16] key_id`, `u32 stream`, `u8[32] wav_sha256` |
| 4 `take-unavailable` | host→seat | `u8[16] key_id`, `u8 reason` (0 refused-not-oneshot, 1 refused-bus, 2 unknown-event, 3 fmod-off, 4 link-down) |
| 5 `want` | seat→host | `u8[16] key_id`, `u64 t_us`, `u16 len`, key |
| 6 `lanes` | seat→host | `u16 lane_mask` (the union over the seat's connections) |

Link down, hello mismatch or clock-domain mismatch disables FMOD for that seat:
`take-unavailable` reason `link-down` and lanes `unavailable`. Godot continues.

The clock domain is 16 raw bytes, encoded as follows:

- Linux: `/proc/sys/kernel/random/boot_id`, with UUID separators removed.
- macOS: the first 16 bytes of SHA-256(`"grc-clock-boot-1\0darwin\0"` followed by
  `u64le(kern.boottime.tv_sec)`).
- Windows: the first 16 bytes of SHA-256(`"grc-clock-boot-1\0windows\0"` followed by
  `u64le(BootTime / 10000000)`). `BootTime` comes from
  `NtQuerySystemInformation(SystemTimeOfDayInformation)` in 100 ns ticks since 1601.
- Other platforms or a failed read: all zeros. Zero on either side is a mismatch.

The seat fixes each take's relay set at `take-start`. A late connection lacking the key joins a
pending set and receives no part of that take. After `take-ready` or `take-unavailable`, the seat
requests one new complete take for the pending set. Closing removes a connection from every set;
new `have` messages suppress delivery to warmed connections. The seat does not buffer whole takes.
Lane names are diagnostic: the seat truncates them at a UTF-8 code point boundary so their
JSON-escaped content is at most 128 bytes. Group names are identity keys and must be at most 64
printable ASCII bytes, excluding `"` and `\`.

## Canonical keys and keyIds

With no params the canonical key is the path. Otherwise it is path + `|` +
comma-separated `name=R(value)` entries sorted by ordinal UTF-16 code-unit name
order. Names are restricted to printable ASCII, so byte order is identical.
No spaces are inserted; paths are not trimmed or case-folded. Values are float32.
`R` is .NET `float.ToString("R", InvariantCulture)` shortest round-trip spelling:
at most 9 significant decimal digits that recover exactly the same float32.
Among the shortest candidates, choose the one nearest the exact value; a tie
takes the even last digit.
For significand d.ddd × 10^k, use exponent form iff k ≥ 9 or k ≤ -5. Otherwise
use fixed notation. Remove trailing fractional zeroes and the decimal point when
empty. Exponent form has uppercase E, mandatory sign and at least two exponent
digits (`1E+09`, `1E-05`). Negative zero is `-0`; minimum subnormal is `1E-45`.

Refuse an empty or all-whitespace path, `|` in a path, empty or duplicate param
names, names containing `=`, `,`, `|` or non-printable ASCII, non-finite values,
and a canonical key exceeding 512 UTF-8 bytes.

keyId is 32 lowercase hex characters: first 16 bytes of
SHA-256(`0x01` followed by UTF-8 canonical key). The string is the identity; a
producer using different float spelling causes cache misses.

## Configuration

| Variable | Values | Default | Meaning |
| -------- | ------ | ------- | ------- |
| `GRC_LIVE_TRACKS` | adds `audio` | unset | The grant . |
| `GRC_LIVE_AUDIO_GODOT` | `sample` \| `off` | `sample` | Godot capture on the dummy driver. |
| `GRC_LIVE_AUDIO_QUEUE_BYTES` | 4096..1048576 | 32768 | Hand-off cap . |
| `GRC_LIVE_AUDIO_LANE_LATE_MS` | 10..1000 | 60 | Lane drop lateness. |
| `GRC_LIVE_AUDIO_STALL_MS` | 500..30000 | 3000 | `audio-stalled`. |
| `GRC_LIVE_AUDIO_STORE_MAX_MS` | 1000..60000 | 10000 | Store class . |
| `GRC_LIVE_AUDIO_NO_STORE_BUSES` | comma list | empty | Bus names whose samples are `no-store`. |

A bad value is the arm refusal `audio-<name>-invalid`. Any `GRC_LIVE_AUDIO_*` set without `audio`
granted is `audio-not-granted`.

## Security

- **The audio credential** is separate from both the view token and the input credential. A
  leaked audio credential hears the seat. It cannot see the screen or drive the game.
- **Asset hashes** appear only on the audio track. Fetching assets still needs the view token
  (the texture policy).
- **Client texts** are size-capped, rate-limited and grammar-checked. `have` sets are capped at
  4096 ids per connection; more is `audio-protocol`.
- **The warm route** is the host product's. It serves only guarded SFX takes by hash.

## Versioning and golden vectors

A decoder accepts only its specified version. A change to binary framing,
layout, a required member, enum spelling or meaning requires
`render-stream-audio/2`, subprotocol `render-stream-audio.2`. Additive optional
handshake members retain /1. The view and track protocols are unchanged.

`audio-vectors.json` is shared by independent C++ and TypeScript judges. Hex
strings denote exact bytes; u64 fields use decimal strings to preserve precision.
Block vectors supply announced lane ids and lane_block_frames as decoder context.
Key float inputs are hexadecimal IEEE-754 float32 bits, including non-finite
refusal inputs. Negative vectors name the broken rule. Prefix vectors are the
WT stream headers preceding length-prefixed blocks, not complete streams.
