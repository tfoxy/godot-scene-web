# Mirror client design: a lean render-stream client package (MIR-D)

This note is the GSW half of MIR-D. The product half is couch-coop's
`docs/agents/handoff-mirror-new-renderer.md`, which covers the "Use new renderer (Beta)" checkbox, the settings it
forces, the streaming seat and pairing. This note says what godot-scene-web provides so that a product can show a live
render-stream in its own page:

- one package;
- its wasm;
- a transport seam;
- an extension hook that costs a pure render nothing.

The package carries no STS2 or couch-coop concept.

Base: `main` 8bfb9490. MIR-1 implements this note.

## Why a package, and not the harness receiver

`web/gsw-receiver/` is a gate harness. It reads `?env=` of `RS_RECEIVER_*`, keeps a tap of every received message, PUTs
`applied.json`, shots, state dumps and perf timelines, and implements sabotages, stalls, shot windows and forced
reconnects. Gate checkers judge its output. A product page needs none of that, and the tap alone would hold every byte of a
session in memory. Aliasing `experiments/` from a product would also make every harness edit a product change with no
export surface to review.

So the product loop gets its own package. The modules that both the product and the harness need move into it, so the wasm
ABI has one owner. The harness keeps its own `LiveReceiver` until the product loop has held. A later GSW item rebuilds the
harness as package + evidence observer, and deletes the duplicate loop.

## The package

`packages/render-stream-client`, `@godot-scene-web/render-stream-client`.

- **`"private": true` until the wire freezes** (the binary `/13`). Consumers alias the TS source, as couch-coop does for
  every GSW package. Publishing would turn an API tied to a moving wire into a compatibility promise.
- **Boundaries.** `package-boundaries.test.ts` gains `"render-stream-client": ["effects"]`: `programs.ts` and
  `particles.ts` use `effects`' shaders and particles. It imports nothing from `experiments/`. The Rust crate is a
  build input only (below).
- **Export surface pinned by a test**, as for `html` and `canvas`: consumers mirror these names.

### What moves in, and what stays out

| From `web/gsw-receiver/` | Fate |
| --- | --- |
| `common.ts`: `GswRs`, `GswRsModule`, `LiveCoding`, `ACCEPT_*`, `STAT_FIELDS`, `statsReader` | moves; the harness imports it |
| `common.ts`: `log`, `finish`, `shell`, `setUpCanvas`, `viewportReport`, `loadModule` | stays (harness); the package has its own loader (below) |
| `fetcher.ts`, `hello.ts`, `fold.ts`, `particles.ts`, `programs.ts` | moves |
| `transcode.ts` + `../basis-transcoder/` | moves with the delivery increment; until then the client's hello offers `decoded` only, and loads no transcoder |
| `live.ts` `LiveReceiver`, `main.ts`, `config.ts`, `evidence.ts`, `perf.ts`, `gl-leak.ts`, `source.ts` | stay (harness) |

**Never in the package:**
- the received tap;
- evidence PUTs, shots and state dumps;
- `RS_RECEIVER_*` parsing;
- sabotages (`ack-on-receipt`, `ack-while-hidden`, `wrong-http-token`, …), stalls, `DRAW_REPEAT`, shot windows;
- `window.__rs*` globals, and `performance.mark` calls the product did not ask for.

## API

```ts
export interface RenderStreamEndpoint {
  url: string;              // ws(s) URL of /render-stream, absolute or page-relative
  resourceBase: string;     // URL prefix, no trailing slash: GET resourceBase + session http_path + hash
  token: string | null;     // 64 hex, or null for GRC_LIVE_AUTH=none
  protocol: 11 | 12 | 13;   // the host's GRC_STREAM_VERSION; the only subprotocol offered (13: W13c)
  presentation?: [number, number]; // expected presentation size (the session confirms it)
}

export interface RenderStreamCore { glueUrl: string; wasmUrl: string; } // wasm-bindgen glue + its .wasm

export type RenderStreamStatus =
  | { kind: "connecting" }
  | { kind: "streaming"; firstFrame: boolean }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "failed"; reason: string; detail: string }
  | { kind: "ended" };      // the host's end record (disarm)

export function createRenderStreamClient(options: {
  canvas: HTMLCanvasElement;
  core: RenderStreamCore;
  endpoint: RenderStreamEndpoint;
  transport?: RenderStreamTransportFactory;   // default: WebSocket + fetch
  extensions?: readonly RenderStreamExtension[]; // default []; MIR-1 requires []
  creditWindow?: 1 | 2;                       // default 2
  onStatus?: (s: RenderStreamStatus) => void;
}): RenderStreamClient;

export interface RenderStreamClient {
  connect(): void;
  setEndpoint(e: RenderStreamEndpoint): void; // a changed descriptor reconnects with it
  stats(): Readonly<{ applied: number; appliesPerSec: number; creditRttMsP50: number | null; heapBytes: number }>;
  dispose(): void;                            // idempotent
}
```

`failed` reasons reuse the receiver's typed names: `live-connect-failed`, `host-error`, `live-disconnected`,
`resource-unavailable`, `receiver-error`, plus the client's `core-load-failed` and `no-webgl2`. `unauthorized` is
reported as `live-connect-failed` with detail `unauthorized`. The product then refreshes the descriptor once.

### Transport seam

```ts
export interface RenderStreamTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  fetchResource(path: string, init: { token: string | null; signal: AbortSignal }): Promise<{ status: number; body: ArrayBuffer | null }>;
}
export type RenderStreamTransportFactory = (
  endpoint: RenderStreamEndpoint, subprotocol: string,
  on: { open(): void; message(data: ArrayBuffer | string): void; close(code: number, reason: string): void },
) => RenderStreamTransport;
```

- The protocol loop sees only this interface. The default is `WebSocket` (`binaryType` arraybuffer) plus `fetch`, with
  `Authorization: Bearer` when a token is set.
- A product proxy that forwards over the same port needs no new transport: only the descriptor's values change.
- A later WebTransport or WebRTC data-channel transport implements this interface, with the hub side or the proxy speaking
  it. The hello, credit and records do not change.

## The wasm: build, serve, load

- **Build.** `packages/render-stream-client/scripts/build-web.sh` builds the existing crate,
  `experiments/render-stream/web/gsw-rs` (`rs-gsw-wasm`). It runs `cargo --release --target wasm32-unknown-unknown`
  offline and `wasm-bindgen =0.2.129 --target web --out-name rs_gsw_wasm`, into `$GSW_RENDER_STREAM_CLIENT_OUT`, then
  writes `build.json` there:
  - `rs_core_build` = `sha=<HEAD 12>[-dirty]`, by `build-rs-core.sh`'s dirty rule over the same paths;
  - `wasm_sha256`;
  - `wasm_bytes`.

  Nothing is committed. The crate stays in `experiments/` until rs-core leaves it, and the package does not own Rust
  code.
- **Serve.** That is the consumer's job: two static URLs (`glueUrl`, `wasmUrl`). A consumer must not bundle the glue
  through an import alias, because the loader needs a static URL it can import more than once.
- **Load: a fresh instance per client.** The `--target web` glue keeps its instance in a module-level variable, and a
  second `init` reuses it. So a page that imports the glue once can never give back its `WebAssembly.Memory`: 561 MB
  flat in STS2 combat (W11z).
  - The package compiles `wasmUrl` once per page, to a cached `WebAssembly.Module` (no heap).
  - Each client then imports `glueUrl + "?client=<n>"`, which makes a new module record, and initialises it from that
    module.
  - `dispose()` stops rAF, closes the transport (1000), aborts in-flight fetches, calls `free()` on every wasm-bindgen
    object, calls `WEBGL_lose_context.loseContext()`, and drops every reference to the module record, so the instance
    and its memory are collectable.
- **ABI check.** The client reads `build.json` next to `wasmUrl`. If its `rs_core_build` differs from the sha its own
  sources were built at, the client fails with `core-load-failed` (`stale core`). A consumer that aliases source passes
  that sha in. MIR-1 decides the exact handshake: either a package constant written by `build-web.sh`, or a wasm export
  `abi_version()` if one is cheaper.

## The loop (product semantics)

It is the harness's live order, minus everything evidence-only, with PH3's pacing (below):
1. `onmessage` decodes and validates (one copy into wasm, W11t live coding first), acks `received`, and queues.
2. PH3: while frame callbacks run (one within the last 100 ms), nothing waits ahead of it, and fewer than two applies
   wait for a draw, the same `onmessage` applies it at once when it needs no payload, and acks `applied`; one that
   needs payloads starts its fetches there.
3. Otherwise one rAF callback runs connection phases, then the pending transaction's fetches (verified by wasm before
   use), then apply, and acks `applied`.
4. Then, once MIR-TAG lands, the extension `beforeDraw` (below).
5. The rAF callback draws the newest applied state, once, and acks `submitted` for every transaction applied since
   the last draw.

Credit comes from the apply, never on receipt alone. The hello's `credit_stage` is `applied` (PH3; it was `submitted`
before): at window 2 the host can send at its frame rate only while each credit returns within two host frames
(33.3 ms), and crediting after a rAF callback put the wait for the next vsync (0-17 ms) into every round trip. Applying
in `onmessage` takes that wait out; the draw stays on rAF. The two gates keep `submitted`'s pacing where it matters:
a hidden page runs no frame callback, so after 100 ms arrivals wait for one, no `applied` ack returns and the hub stops
publishing to the connection (G7u); and a client whose draws fall behind applies at most two transactions per draw,
then is paced by its draws again. `creditStage: "submitted"` and `applyOn: "frame"` keep the MIR-1 loop. Measured on
the g31: [results/p3/ph3.md](../results/p3/ph3.md).

- **Hello.** The keys are `live.ts`'s, in its order:
  - `receiver_kind` is `"gsw-canvas"` (the same executor);
  - `receiver` names this client: check the hub's hello validation (`rs_live.cpp`) before choosing the string;
  - `credit_window` is 2, and `credit_stage` is `applied` (PH3; MIR-1 sent `submitted`);
  - `texture_encodings` is `decoded`, until the delivery increment adds `block,uastc`;
  - `gpu_formats` comes from the canvas's own context;
  - `live_coding` is `zstd-base,zstd`;
  - `manifest_sha256` is null.
- **Presentation.** The backing store is the session's presentation size 1:1 (D12). The product sizes the canvas's CSS
  box (letterbox). The hello reports the CSS size and DPR as today.
- **Loss.** A close without an end record, or not 1002/1008/1009, reconnects as a fresh session. That is G1d's
  RECONNECT: the applier is rebuilt, the compiled module and the browser HTTP cache are kept. Backoff is 1, 2, 4, 8 s,
  then 10 s. A product may `dispose()` instead, for example when its page has been hidden for a long time.
- **Hidden page.** Nothing extra: no rAF means no credit, so the hub stops publishing to this connection (G7u).
- **Coding resync.** W11t's in-place `live_rebuild`. Open finding (W11z): it adds a one-time +408 MB heap step, because
  the new applier is built while the old one is alive. Fix it in the package's resync path (dispose first) as part of
  MIR-1 or right after, and measure it at game scale.
- **Context loss.** G7u's in-place recovery, unchanged.

## Extensions: the attach point (sketch, for MIR-TAG)

Product modules attach here: bigger text without reflow, raised cards, nodes hidden or moved under a condition. The
mechanism is generic: identities, side records and an override table. What an identity *means* stays in the product.

```ts
export interface RenderStreamExtension {
  id: string;
  wants?: { itemPaths?: boolean; itemTags?: readonly string[] }; // hello opt-in
  onSession?(s: SessionInfo): void;
  onItemMeta?(batch: ItemMetaBatch): void;   // per-item identity, once at item creation
  beforeDraw?(frame: FrameContext): void;    // writes frame.overrides (transform, modulate, visible) by item id
}
```

- **Client.** The extension sites are three:
  - the hello merge;
  - receipt of the side records;
  - one `if (this.ext)` between apply and draw. That check is per frame, never per item.

  The override table is packed `f32` records copied once per frame into wasm. The executor composes an override after the
  resolved transform and before batching, and treats an overridden item as changed for damage. It checks
  `overrides.is_empty()` once per draw.
- **Wire and host.**
  - An `extensions` hello key opts a connection in. The default hello has no such key.
  - The host resolves identities (the node path of the item's `CanvasItem`, and its groups as tags) only while at least
    one connection has opted in, and only at item creation.
  - The host sends them as side records on that connection, after the shared transaction bytes, so P3-SP's shared
    diffs and encodes stay shared.
- **The zero-cost bar,** measured before and after MIR-TAG on the capture-scale fixture:
  - a pure client and an `extensions: []` client agree within noise on applies/s, frame time, wire bytes (identical)
    and host fps;
  - a product that has no module enabled does not load one: modules are the product's dynamic imports.

This is a sketch. MIR-TAG designs the record layout, the identity rules (late-join adoption, reparenting) and the
override semantics (local vs global, clip interaction) before the binary `/13`, which then carries them.

## Corrections for the gate 8 hand-off

- `gate8-product-handoff.md` does not list `GRC_HOOK_LOG`. It defaults to `on`, and then `evidence/resources.jsonl`
  grows with every hooked call: C3 measured ~38 GB in 22 minutes of STS2. A product seat must set `GRC_HOOK_LOG=off`.
  Add the row when the hand-off is next edited (`self-test-gate8z.ts` checks names against the source).
- A product seat needs `GRC_EVIDENCE_DIR` when `GRC_LIVE_AUTH=token`, because the token file is written there. With the
  hook log off and no file sink, that directory stays small. MIR-3 (couch) verifies this on a live seat.

## MIR-1 checks (GSW)

- **Unit** (vitest):
  - the hello builder against golden-11/12's control hellos (key order);
  - descriptor validation;
  - the credit/ack machine on a fake core and a fake transport: window 2, fold, end record, host `error`, unauthorized,
    loss backoff;
  - `dispose()` idempotent.
- **Surface and boundaries:** the export names are pinned, and `package-boundaries.test.ts` is green.
- **Typecheck:** `pnpm typecheck` and `pnpm typecheck:ts6`.
- **Harness regression**, scoped to what the moved modules reach: one `g7-*` live leg and one gate 8 delivery leg on
  GSW.
- **Live, no game.**
  - Run `bench-live-scale.sh` in a new host-only mode. It runs the capture-scale fixture with
    `GRC_LIVE_ALLOWED_ORIGINS` set to the page origin, and judges the connection from the host's own tap.
  - Drive a minimal page that mounts the package in the pinned Chromium, at `--protocol 12 --window 2`.
  - It must pass the existing `update-rate` and `credit-rtt` checks.
- **Remount.** Dispose and mount three times, with a CDP `HeapProfiler.collectGarbage` after each dispose. The renderer
  process RSS must return within 15% of its pre-mount level, and each new instance's heap must start at its baseline.

## As built (MIR-1)

`packages/render-stream-client` (`@godot-scene-web/render-stream-client`, `"private": true`, so
`pnpm -r publish` and `validate-release-tag.ts` both skip it). Results and measurements:
[results/p3/mir-1.md](../results/p3/mir-1.md).

**Sharing with the harness.** The modules both need moved into the package, and the harness imports
them from there by path, as it imports `effects`: `abi.ts` (from `common.ts`: `GswRs`,
`GswRsModule`, `LiveCoding`, `ACCEPT_*`, `STAT_FIELDS`, `statsReader`; `common.ts` re-exports them),
`fetcher.ts`, `hello.ts`, `fold.ts`, `particles.ts` and `programs.ts`. The package has its own lean
loop (`loop.ts`); the harness keeps `LiveReceiver`, unchanged except for its imports and one seam:
`LiveFetcher` takes an injected request function. The harness passes its old `fetch` call
(`live.ts` `harnessRequest`: token, the `ignore-cache` sabotage's cache mode, the four kept
headers), the client passes its transport's `fetchResource`. Rebuilding the harness on the
package's loop would have put every gate 7 GSW leg's evidence at risk for no product gain; that
stays the later item the design names.

**API as built.** The design's, with these additions:
- `RenderStreamCore` has `buildUrl?` (default `build.json` beside `wasmUrl`) and `expectedTree?`.
- `RenderStreamStatus` `streaming` is reported once per connection with `firstFrame: false` (its
  session) and once with `firstFrame: true` (its first drawn transaction).
- `RenderStreamStats.applied` counts over every connection of the client; `creditRttMsP50` is the
  median of the last 64 intervals from a credit-stage ack (`applied` since PH3) to the next
  transaction's arrival.
- Exports: `createRenderStreamClient`, `validateEndpoint`, `RenderStreamEndpointError`,
  `clientHello`, `CoreLoadError`, `RECONNECT_BACKOFF_MS`, `webSocketTransport`, and the types
  (pinned by `test/export-surface.test.ts`).
- `connect()` after `failed` or `ended` starts a fresh session. `setEndpoint` on an active client
  reconnects at once; on an idle, failed or ended one it is kept for the next `connect()` (the
  product's `unauthorized` refresh is `setEndpoint(fresh)` then `connect()`).
- The hello's `receiver` is `gsw-render-stream-client` (a free string at the host).

**Loading: a factory glue, not `?client=<n>`.** Measured in the pinned Chromium: importing the
`--target web` glue as `glueUrl?client=<n>` keeps every instance. A page's module map never drops a
module record, and each record's module-level `wasm` holds its instance. Five mounts of a 300 MB
instance grew the renderer by +287 MiB each: 701, 988, 1274 and 1561 MiB after the dispose and GC
of mounts 2 to 5.
So `scripts/build-web.sh` wraps the glue's body in `export default function createGlue()`
(`scripts/glue-factory.mjs`, which refuses any glue shape it does not know) and writes it as
`rs_gsw_wasm_client.js`. The client imports that module once per page and calls the factory per
client. Every client gets a fresh closure with its own instance, and the instance is collectable
when the client drops it: the same five mounts went back to 126-128 MiB each time. The `.wasm` is
fetched, checked against `build.json`'s `wasm_sha256`, and compiled once per page.

**ABI handshake.** `build.json` (schema `render-stream-client-core/1`) holds:
- `rs_core_build`: `sha=<HEAD 12>[-dirty]`, as the design says;
- `rs_core_tree`: `scripts/core-tree.sh`, the SHA-256 (12 hex) of the git tree ids of the four Rust
  inputs, plus the same dirty rule. HEAD changes with every commit; the tree changes only when the
  wasm's sources do;
- `wasm_sha256`, `wasm_bytes`, `wasm_bindgen`, `glue`, `wasm`.

A consumer that knows which tree its aliased TS matches passes it as `core.expectedTree`; any other
build is `core-load-failed` `stale core`. Independently, the glue must export every `GswRs` method
the client calls (`abi.ts` `CLIENT_CORE_METHODS`). A wasm `abi_version()` export would have been a
Rust change that every GSW leg reaches, for no more than the tree id gives.

**Coding resync.** The package reuses GRH's path unchanged: `transport_skip()` at the coding failure
(GTS), then `live_rebuild()`, whose fresh applier inherits the old one's GPU residency
(`Applier::inherit_residency`). The +408 MB step this note listed as open was fixed there.

**Dispose.** Stops rAF and the backoff timer, closes the transport (1000 `dispose`) after
detaching its message handlers (the WebSocket's `onclose` drops every handler when it fires, so a
socket the browser still holds keeps nothing reachable), aborts the GET in flight
(`LiveFetcher.abort`; the harness's reconnect `cancel` still lets one complete), frees `LiveCoding`
and `GswRs`, removes the canvas listeners, calls `loseContext()` and drops the instance.

**Consuming it (MIR-2).**
- Alias `@godot-scene-web/render-stream-client` to `packages/render-stream-client/src/index.ts`,
  above the bare GSW aliases. It needs `@godot-scene-web/effects` (already aliased).
- Build the core with
  `GSW_RENDER_STREAM_CLIENT_OUT=<dir> packages/render-stream-client/scripts/build-web.sh` (or the
  directory as its argument). It needs the cargo registry offline and `wasm-bindgen` 0.2.129.
- Serve `rs_gsw_wasm_client.js`, `rs_gsw_wasm_bg.wasm` and `build.json` side by side. Pass
  `{ glueUrl, wasmUrl, expectedTree }` as `core`, with `expectedTree` from
  `packages/render-stream-client/scripts/core-tree.sh <gsw root>`, which is the staleness check.
  Never import the glue through an alias or a bundler.

**Live check.** `bench-live-scale.sh --receiver host-only` is the new host-only mode: no harness
receiver, and the leg is judged from the host's tap. `--rx-cmd` runs a command in the receiver's
place. `scripts/client-live-check.ts` is that command for MIR-1: `web/client-check/` mounts the
package and nothing else.
