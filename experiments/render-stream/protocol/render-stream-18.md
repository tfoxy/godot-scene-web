# render-stream/18 wire format

Status: **built (wire, adaptive host window and draw pacing)**. /18 is render-stream/17
([render-stream-17.md](render-stream-17.md)) plus a credit window in **1..8**, the adaptive
host window and /18-only draw pacing. Everything this text
does not list is /17's, byte for byte. /17 and earlier are unchanged.

## What differs from /17

- **Magic.** `47 52 53 49 0D 0A 1A 0A` (`GRSI`, /17's `GRSH` plus one). Recording files use `.rs18`.
- **Protocol strings.** The session's `protocol` and the hello's `protocol` are `render-stream/18`.
  The WebSocket subprotocol is `render-stream.18`.
- **Hello credit window.** `credit_window` is an integer in **1..8**, in its existing position.
  A value outside that range is a hello error.
- **Session credit window.** `publication.credit_window` is an integer in **1..8**
  (`publication-entry` otherwise). A file stream always declares **1**, as before.
- **Inherited tweens.** `client_tweens` remains valid in both the hello and session on /18,
  with /17's opt-in negotiation and tween records unchanged.
- There is no new key, message, record, block, command or acknowledgement. Every transaction,
  resource, hint and item metadata record is /17's byte for byte for the same state and coding.

## Who speaks /18

- **The host** offers /18 under `GRC_STREAM_VERSION=18`. It lists `render-stream.18` first,
  followed by `render-stream.17` and `render-stream.16`, and file sinks write /18.
  Each connection uses its selected subprotocol's version: /17 and /16 keep windows in 1..2,
  their existing grammar and bytes, and no adaptive draw pacing. Without this setting every
  /2 through /17 connection keeps its existing grammar and bytes.
- **The render-stream client package** offers exactly `render-stream.18` for an endpoint whose
  protocol is 18. It requests window 8 by default; below /18 it requests 2. An explicit window
  must be in the offered version's range. Item metadata, resource hints and viewport options
  keep /17's behaviour. The optional last `client_tweens` hello key is available
  on /18 with the same opt-in meaning and no silent downgrade below /17.
- **The native GDScript receiver** does not offer /18.

The declared session window is the grant. A host may send fewer transactions than that grant
allows without changing the session or acknowledgement grammar. Host adaptation and pacing
are implementation behaviour, outside this range widening.

The host caps the grant at `GRC_LIVE_CREDIT_WINDOW_MAX` (1..8, default 8). Its effective sending
window starts at `min(2, grant)`. After a credit RTT sample it uses
`clamp(ceil(srtt / period) + 1, min(2, grant), grant)`, where `srtt` and the measured host
frame-callback `period` use EWMA with alpha 1/8. A decrease below the outstanding count blocks
new sends until enough credits return. Grants of 1 or 2 retain their previous behaviour.
The `/18` live summary and per-second connection timeline report `w_eff`, `srtt_us` and the
existing `max_in_flight`. Older summary shapes stay unchanged.

Only `/18` connections pace publication to the client's draws. Over a sliding host-clock
second, the host counts distinct `submitted` acknowledgement `t_us` values as draws; a timestamp
shared by at least two distinct sequences is one coalesced draw. Duplicate acknowledgements do
not count twice. After a full second of observations, a coalesced share above 20% sets the
connection period to `1e9 / draws_per_second` ns, bounded below by the measured host callback
period and any explicit `GRC_PUBLISH_FPS` period. Each two seconds without coalescing shortens
the adaptive period by 10%; reaching the host period removes the adaptive cap. A connection
without submitted acknowledgements is never paced.

The session's declared `publication` remains unchanged. The `/18` connection summary and
per-second timeline additionally report `pace_period_us` (the actual connection period,
including the explicit rate floor; zero when uncapped), `draws_per_s` and `coalesced_share`.
`/17` and earlier retain the global publish period, their prior telemetry shape and their
existing transcripts.

## Validators and golden vectors

`golden-18/make_golden.py` deterministically derives the vectors from existing goldens without
changing the older directories. `golden-18/index.json` lists the vectors and expected error codes.

- `window1.rs18`, `window2.rs18`, `window4.rs18` and `window8.rs18` are valid, carrying /16's viewport
  recording under /18 with the specified grant.
- `invalid/window0.rs18` and `invalid/window9.rs18` fail with `publication-entry`.
- `invalid/file-window8.rs18` fails with `publication-entry`: a file stream's window is always 1.
- `invalid/window3.rs7` through `invalid/window3.rs17` fail with `publication-entry` under their
  own version. The original `golden-7` vectors are untouched.

## Versioning

Renaming the version-parameterized codecs is not part of this contract. Every /17-or-later
feature gate includes /18. Only the magic, protocol and subprotocol strings and the two credit
window range checks distinguish /18. Below /18 the range stays 1..2; /6 has no window field.
