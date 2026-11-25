# Optional host FMOD module

GSW does not include or license FMOD. This module only drives a host game's own
licensed FMOD inside that game's process, opt-in per title. Any other deployment
needs its own licence determination. Before a release ships this module, maintainers
must re-diff the FMOD EULA and FAQ against their archived copies.

`libgrc_fmod` is a native C++ shared library with a standalone C ABI in `grc_fmod.h`.
The host loads its FMOD libraries first, then loads this module and obtains
`grc_fmod_get_v1`. Keep the module loaded until process exit. It binds only to
already-loaded libraries; it never loads an FMOD library from disk itself.

The module binds FMOD 2.03 and renders in private non-realtime systems. One or two
dedicated take workers share a guarded one-shot SFX cache and deduplicate cold
requests across seats. A separate lane system renders live music, ambience or
loops; it exists only while at least one seat subscribes to a lane.

Bank data stays in the host process. The built-in source reads unencrypted,
uncompressed Godot PCK v2/v3 files through positional reads and fixed callback
slots. It never extracts or serves banks. No FMOD runtime, bank, event replay or
parameter replay belongs in a browser: clients receive rendered PCM only.
Only guarded one-shot SFX takes may be cached. Live lanes have no cache path,
never enter `take_index` or `take_get`, and never write `take_cache_dir`. A product
must keep lane PCM out of persistent storage and serve it with `no-store` semantics.

Build and run the synthetic tests without an FMOD SDK:

```sh
cmake -S experiments/render-stream/fmod -B experiments/render-stream/fmod/build
cmake --build experiments/render-stream/fmod/build
ctest --test-dir experiments/render-stream/fmod/build --output-on-failure
experiments/render-stream/scripts/check-fmod-licence.sh
```

The separate-process native install tests skip unless both
`GRC_FMOD_TEST_GAME_DIR` and `GRC_FMOD_TEST_REFERENCE` are set. The former points at
the host game's existing libraries and PCK; the latter points at the PCM parity
reference directory. Tests load those libraries as the host would, then load this
module. They never copy game files. The render test checks byte identity for
stable keys. Unstable keys must match the reference's deterministic prefix, have
1..480000 frames and non-zero energy, and pass the renderer's music/ambience bus
guards. Their lengths are not compared with the reference. Tests also check
the 60 MiB renderer RSS bound and zero allocations in file/DSP callbacks. First-mix
timing acceptance is opt-in with `GRC_FMOD_TEST_TIMING=1` on an otherwise quiet host;
do not use timing observations from a loaded machine. The native endpoint test
checks take delivery, refusals, lane subscriptions, dormancy, fresh epochs on rejoin,
observation replay and cache isolation. Synthetic tests check link mismatches and
that a worker failure keeps answering pending and future wants with `fmod-off`.

Host config keys used at startup are `core_lib`, `studio_lib` (loaded library names),
`pck_path`, and `banks` (comma-separated `res://` paths; empty selects all banks).
The configured bank list and its bankset digest stay fixed for the session.
Observed bank loads/unloads count as evidence only; paths outside that list count
as `bank-unknown`. Teardown logs their totals through the host's `log` callback.
`take_workers` accepts 1 or 2 (default 1). `take_cache_bytes` defaults to 64 MiB.
`take_cache_dir` opts into persistent guarded SFX takes, partitioned by bankset;
leave it unset for an in-memory cache. `take_get` returns the canonical WAV by its
SHA-256; `take_index` returns the bankset and available hashes. Release every returned
buffer exactly once through `release(self, owner)`. Its immutable bytes survive
cache eviction and `stop`; duplicate or unknown releases free nothing and are counted.
The cache never accepts refused takes.

`lanes` is a comma-separated list of `id:name:bus_path[:group]`, for example
`1:music:bus:/master/music,2:ambience:bus:/master/ambience:amb`. IDs are 1–15;
`group` defaults to `name`. Group names are 1–64 printable ASCII bytes excluding
quotes and backslashes. Invalid entries are disabled with a `lane-config` diagnostic.
All buses render at unity; the viewer applies the host product's group gains.

Call `seat_open` before forwarding the seat's hello to `link_in`, and `seat_close`
when its link closes. The product relays whole opaque `grc-audio-link/1` messages,
in order; only whole lane blocks may be dropped under pressure. `link_out` sends
the host hello (version, boot clock domain, bankset and lanes), take lifecycle
messages and Q2.1 PCM blocks. Closing a seat drops subscriptions and pending wants;
reopening it cannot receive an earlier connection's completion. Protocol or clock
domain mismatches disable that seat and log its first failure. An FMOD failure
latches the module off for the process, logs once, and keeps the endpoint alive to
answer wants with `fmod-off`. A new process is required to retry FMOD.

`observe` accepts operations 1–9 documented in the header. Forward event creation,
start, stop, release, named parameters, global parameters and pause state using the
product's instance IDs. The module retains current live state while dormant and
starts from that snapshot on rejoin; it does not retain PCM or an event timeline.
In v1, op 6 removes the instance from lane state and rejoin replay. Send op 6 only
once the host event has stopped (op 5) or ended. If the host releases an event while
it is still playing, late subscribers will not hear that event.
The lane media clock advances in 512-frame blocks at 48 kHz only while the union
subscription is nonzero. It skips expired block indices after a stall, marks a gap,
and starts a fresh epoch at block zero after the last subscription ends.

A product may instead provide a `grc_fmod_bank_source_v1`. Callbacks and their
contexts must outlive asynchronous teardown. Source metadata must stay fixed for
the session; a changed bankset is refused before loading a render system. Callbacks
must not throw or take
product locks. File callbacks must not allocate. Callbacks run on module threads,
outside module locks. The product must copy outgoing bytes and return promptly.
`stop` requests teardown and returns immediately; the module never joins the host
thread to its worker.
