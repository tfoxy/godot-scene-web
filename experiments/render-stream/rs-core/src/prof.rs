//! Opt-in phase timers (G7o2, `protocol/gate7/g7o2.md` "Profile"): where a step transaction's
//! time goes, per phase, on whatever clock the adapter installs. Off by default: with no clock
//! every [`start`] returns `None` and every [`add`] is a no-op, so the bench arms that judge the
//! budget pay one thread-local read per mark and nothing else.
//!
//! The adapter calls [`set_clock`] once (natively `rs-core-check profile` passes a monotonic
//! clock; `rs-gsw-wasm` passes `performance.now`), then [`take`] after each frame to read and zero
//! the accumulated microseconds.

use std::cell::Cell;

/// The phases, in pipeline order. `NAMES[i]` is phase `i`'s report key.
pub const META: usize = 0;
pub const PRE_CHECKS: usize = 1;
pub const RESOLVE: usize = 2;
pub const POST_CHECKS: usize = 3;
pub const RECORD_DIGEST: usize = 4;
pub const PREPARE: usize = 5;
pub const NEEDED: usize = 6;
pub const PAYLOAD_HASH: usize = 7;
pub const PAYLOAD_DECODE: usize = 8;
pub const MESH_SYNC: usize = 9;
pub const TEXTURE_SYNC: usize = 10;
pub const MATERIALS: usize = 11;
pub const CLASSIFY: usize = 12;
pub const LOWER: usize = 13;
pub const DEPENDENCY: usize = 14;
pub const WALK: usize = 15;
pub const ASSEMBLE: usize = 16;
pub const BINDINGS: usize = 17;
pub const ADAPTER: usize = 18;
pub const EXECUTE: usize = 19;
pub const COUNT: usize = 20;

pub const NAMES: [&str; COUNT] = [
    "meta",
    "pre_checks",
    "resolve",
    "post_checks",
    "record_digest",
    "prepare",
    "needed",
    "payload_hash",
    "payload_decode",
    "mesh_sync",
    "texture_sync",
    "materials",
    "classify",
    "lower",
    "dependency",
    "walk",
    "assemble",
    "bindings",
    "adapter",
    "execute",
];

thread_local! {
    static CLOCK: Cell<Option<fn() -> f64>> = const { Cell::new(None) };
    static ACC: Cell<[f64; COUNT]> = const { Cell::new([0.0; COUNT]) };
    static ALLOCS: Cell<Option<fn() -> u64>> = const { Cell::new(None) };
}

/// G7o3: install (or remove) an allocation counter (the number of allocations so far, a native
/// adapter's counting allocator): [`replay`] then reports each transaction's allocations in
/// `accept` and in `apply`.
pub fn set_alloc_counter(counter: Option<fn() -> u64>) {
    ALLOCS.with(|c| c.set(counter));
}

fn allocs() -> Option<u64> {
    ALLOCS.with(|c| c.get().map(|f| f()))
}

/// Install (or with `None` remove) the clock, in microseconds.
pub fn set_clock(clock: Option<fn() -> f64>) {
    CLOCK.with(|c| c.set(clock));
}

pub fn enabled() -> bool {
    CLOCK.with(|c| c.get().is_some())
}

/// The clock's reading, when profiling is on.
#[inline]
pub fn start() -> Option<f64> {
    CLOCK.with(|c| c.get().map(|f| f()))
}

/// Charge the time since `since` (from [`start`]) to `phase`.
#[inline]
pub fn add(phase: usize, since: Option<f64>) {
    if let Some(t0) = since {
        let now = CLOCK.with(|c| c.get().map(|f| f())).unwrap_or(t0);
        ACC.with(|a| {
            let mut v = a.get();
            v[phase] += now - t0;
            a.set(v);
        });
    }
}

/// The time accumulated so far in `phase` (to take a nested phase out of its outer one).
pub fn get(phase: usize) -> f64 {
    ACC.with(|a| a.get()[phase])
}

/// Charge `us` microseconds back from `phase` (the nested time [`get`] measured inside it).
pub fn sub(phase: usize, us: f64) {
    ACC.with(|a| {
        let mut v = a.get();
        v[phase] -= us;
        a.set(v);
    });
}

/// Read and zero the accumulated phase times.
pub fn take() -> [f64; COUNT] {
    ACC.with(|a| a.replace([0.0; COUNT]))
}

/// One transaction of [`replay`]: the GSW page's top-level timers (µs) and the phases inside them.
#[derive(Clone, Debug, Default)]
pub struct TxProfile {
    pub seq: i64,
    pub full: bool,
    pub record_bytes: usize,
    /// `accept` (decode, validate, resolve; the inline digest when on; inline resource records
    /// since the last transaction), `prepare` + `needed`, `provide`, `apply`, and the deferred
    /// record digest (D31: outside the page's `total_us`).
    pub accept_us: f64,
    pub prepare_us: f64,
    pub provide_us: f64,
    pub apply_us: f64,
    pub digest_us: f64,
    /// G7o3: allocations in `accept` and in `apply` ([`set_alloc_counter`]; `None` without one).
    pub accept_allocs: Option<u64>,
    pub apply_allocs: Option<u64>,
    pub phases: [f64; COUNT],
    pub needed: usize,
    pub provided_bytes: usize,
    pub stats: crate::apply::ApplyStats,
    pub items: usize,
}

impl TxProfile {
    /// The page's `total_us` less `draw` (no executor here).
    pub fn total_us(&self) -> f64 {
        self.accept_us + self.prepare_us + self.provide_us + self.apply_us
    }

    /// One JSON object (`rs-core-check profile`'s line).
    pub fn to_json(&self) -> serde_json::Value {
        let st = &self.stats;
        let phases: serde_json::Map<String, serde_json::Value> = NAMES
            .iter()
            .zip(self.phases)
            .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
            .collect();
        let mut out = serde_json::json!({
            "seq": self.seq,
            "encoding": if self.full { "full" } else { "patch" },
            "record_bytes": self.record_bytes,
            "accept_us": self.accept_us,
            "prepare_needed_us": self.prepare_us,
            "provide_us": self.provide_us,
            "apply_us": self.apply_us,
            "digest_us": self.digest_us,
            "total_us": self.total_us(),
            "needed": self.needed,
            "provided_bytes": self.provided_bytes,
            "why": st.why,
            "reassembled": st.reassembled,
            "relowered": st.relowered,
            "relowered_in_place": st.relowered_in_place,
            "rows_written": st.rows_written,
            "commands_replayed": st.commands_replayed,
            "texture_uploads": st.texture_uploads,
            "texture_upload_bytes": st.texture_upload_bytes,
            "items": self.items,
            "phases": phases,
        });
        if let (Some(a), Some(b)) = (self.accept_allocs, self.apply_allocs) {
            out["accept_allocs"] = serde_json::json!(a);
            out["apply_allocs"] = serde_json::json!(b);
        }
        out
    }
}

/// The GSW page's per-transaction pipeline without an executor (G7o2's profile, natively in
/// `rs-core-check profile` and as wasm in `rs-gsw-wasm`'s `core_profile`): accept, prepare +
/// needed, provide each needed payload from `read` (verified), apply, then the deferred digest.
/// Needs a clock ([`set_clock`]); the phases are [`take`]n per transaction.
pub fn replay(
    data: &[u8],
    inline_digest: bool,
    read: &mut dyn FnMut(&crate::state::Hash) -> Option<Vec<u8>>,
) -> Result<Vec<TxProfile>, crate::wire::Error> {
    use crate::apply::payloads::PayloadStore;
    use crate::apply::{geom, Applier, Viewport};
    use crate::validate::{Accepted, DigestPolicy, Options, Validator};
    use crate::wire::{self, Error};
    let now = || CLOCK.with(|c| c.get().map(|f| f())).unwrap_or(0.0);
    let version = wire::version_of_magic(data)
        .ok_or_else(|| Error::new("bad-magic", "not a render-stream recording"))?;
    let spans = wire::split_records(data, version)?;
    let mut opts = Options::new(version);
    opts.digest = if inline_digest {
        DigestPolicy::Inline
    } else {
        DigestPolicy::Deferred
    };
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, opts)?;
    let s = v.session();
    let size = s
        .viewport
        .presentation_size
        .unwrap_or(s.viewport.logical_size);
    let mut a = Applier::new(Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    });
    let mut payloads = PayloadStore::default();
    let mut need = Vec::new();
    let mut rows = Vec::new();
    // Inline resource records since the last transaction: their accept and digest count toward
    // the next transaction.
    let (mut carry_accept, mut carry_digest) = (0.0, 0.0);
    take();
    for span in &spans[1..] {
        let rec = span.bytes(data);
        let a0 = allocs();
        let t0 = now();
        let acc = v.accept(rec, span.offset)?;
        let mut accept_us = now() - t0;
        let accept_allocs = a0.zip(allocs()).map(|(a, b)| b - a);
        let mut digest_us = 0.0;
        if !inline_digest {
            let t = now();
            std::hint::black_box(wire::record_sha256(rec));
            digest_us = now() - t;
        }
        match acc {
            Accepted::Resource { hash } => {
                let t = now();
                if let Some(b) = v.inline_payload(&hash) {
                    payloads.provide(b, &hash, version, false)?;
                }
                carry_accept += accept_us + (now() - t);
                carry_digest += digest_us;
            }
            Accepted::End => {}
            Accepted::Transaction => {
                accept_us += std::mem::take(&mut carry_accept);
                digest_us += std::mem::take(&mut carry_digest);
                let t1 = now();
                a.prepare(v.state(), v.delta());
                let t = start();
                a.needed(v.state(), v.delta(), &payloads, &mut need);
                add(NEEDED, t);
                let prepare_us = now() - t1;
                let mut provided_bytes = 0usize;
                let mut provide_us = 0.0;
                for h in &need {
                    let b =
                        read(h).ok_or_else(|| Error::new("resource-unavailable", h.to_hex()))?;
                    provided_bytes += b.len();
                    let t = now();
                    payloads.provide(&b, h, version, true)?;
                    provide_us += now() - t;
                }
                let a4 = allocs();
                let t4 = now();
                let stats = a.apply(v.state(), v.delta(), &payloads).clone();
                let apply_us = now() - t4;
                let apply_allocs = a4.zip(allocs()).map(|(a, b)| b - a);
                a.list.consumed();
                let s = v.state();
                rows.push(TxProfile {
                    seq: s.seq,
                    full: s.encoding.as_str() == "full",
                    record_bytes: rec.len(),
                    accept_us,
                    prepare_us,
                    provide_us,
                    apply_us,
                    digest_us,
                    accept_allocs,
                    apply_allocs,
                    phases: take(),
                    needed: need.len(),
                    provided_bytes,
                    stats,
                    items: s.items.len(),
                });
            }
        }
    }
    Ok(rows)
}

/// The per-transaction minimum of each timer over the runs (the same recording replayed).
pub fn min_over(runs: Vec<Vec<TxProfile>>) -> Vec<TxProfile> {
    let mut it = runs.into_iter();
    let Some(mut best) = it.next() else {
        return Vec::new();
    };
    for run in it {
        for (b, n) in best.iter_mut().zip(run) {
            b.accept_us = b.accept_us.min(n.accept_us);
            b.prepare_us = b.prepare_us.min(n.prepare_us);
            b.provide_us = b.provide_us.min(n.provide_us);
            b.apply_us = b.apply_us.min(n.apply_us);
            b.digest_us = b.digest_us.min(n.digest_us);
            for i in 0..COUNT {
                b.phases[i] = b.phases[i].min(n.phases[i]);
            }
        }
    }
    best
}
