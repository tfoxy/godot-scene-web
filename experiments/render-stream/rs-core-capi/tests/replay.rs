//! The adapter over golden-6's valid recordings (protocol/golden-6): every transaction applies
//! without error, the delta-driven planner's RenderingServer call stream equals the former GDScript applier (`rs_applier.gd`, removed in G7gd)'s
//! O(state) walk (`full_scan`) call for call, and every sabotage keeps that equality. The
//! comparison against the GDScript receiver's own evidence is `rs-core-capi-check legs`.
//!
//! G7xwl: the same adapter at render-stream/7 (protocol/golden-7, the live-transport-only
//! version): golden-7's streams are golden-6's `rate.rs6` scene, so they must issue exactly
//! `rate.rs6`'s RenderingServer calls, and a stream at the other version is refused.

use render_stream_core::state::Hash;
use render_stream_core::wire;
use rs_core_capi::core::{Core, KIND_ERROR, KIND_RESOURCE, KIND_SESSION, KIND_TRANSACTION};
use std::collections::HashMap;
use std::path::PathBuf;

fn golden() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-6")
}

fn golden7() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-7")
}

fn payloads() -> HashMap<Hash, Vec<u8>> {
    payloads_in(&golden().join("payloads"))
}

fn payloads_in(dir: &std::path::Path) -> HashMap<Hash, Vec<u8>> {
    let mut out = HashMap::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let bytes = std::fs::read(e.unwrap().path()).unwrap();
        out.insert(wire::sha256(&bytes), bytes);
    }
    out
}

/// Reads the core's Variant-tree `needed()` answer: the hash list and the library list.
fn needed(core: &mut Core) -> (Vec<String>, Vec<String>) {
    let n = core.needed_raw();
    (
        n.hashes.iter().map(|h| h.to_hex()).collect(),
        n.library.clone(),
    )
}

/// Replays `name` applying after every transaction; returns every call batch (words, arena).
fn replay(name: &str, full_scan: bool, sabotage: &str) -> Vec<(Vec<u32>, Vec<u8>)> {
    replay_at(&golden().join(name), 6, full_scan, sabotage)
}

/// `replay` of any recording at render-stream/`version`.
fn replay_at(
    path: &std::path::Path,
    version: u8,
    full_scan: bool,
    sabotage: &str,
) -> Vec<(Vec<u32>, Vec<u8>)> {
    let name = path.display().to_string();
    let data = std::fs::read(path).unwrap();
    // A golden directory's own payloads when it has them (golden-9, golden-10), else golden-6's.
    // golden-11's own directory holds only dynamic bodies (they travel in `mesh_u8`): its hashed
    // payloads are golden-10's.
    let mut own = path.parent().unwrap().join("payloads");
    if path.parent().unwrap().ends_with("golden-11") {
        own = path.parent().unwrap().join("../golden-10/payloads");
    }
    let mut store = if own.is_dir() {
        payloads_in(&own)
    } else {
        payloads()
    };
    let mut core = Core::new();
    core.planner.full_scan = full_scan;
    core.set_sabotage(sabotage);
    let spans = wire::split_records(&data, version).unwrap();
    let mut batches = Vec::new();
    for (i, s) in spans.iter().enumerate() {
        if i == 0 {
            assert_eq!(
                core.session(&data, s.offset, version),
                KIND_SESSION,
                "{name}: session"
            );
            core.begin_session();
            batches.push((core.ops.words.clone(), core.ops.arena.clone()));
            continue;
        }
        let kind = core.accept(&data, s.offset);
        assert_ne!(kind, KIND_ERROR, "{name}: record {i}");
        if kind == KIND_RESOURCE {
            assert!(core.resource_payload());
            let p = core.text.clone();
            store.insert(wire::sha256(&p), p);
            continue;
        }
        if kind != KIND_TRANSACTION {
            continue;
        }
        let (hashes, library) = needed(&mut core);
        for h in hashes {
            let bytes = store
                .get(&Hash::from_hex(&h).unwrap())
                .unwrap_or_else(|| panic!("{name}: payload {h} is not in golden-6/payloads"));
            core.provide(&h, bytes).unwrap();
        }
        for h in library {
            core.provide_library(&h, false, "no library in the golden test");
        }
        core.apply()
            .unwrap_or_else(|e| panic!("{name}: apply after record {i}: {e}"));
        batches.push((core.ops.words.clone(), core.ops.arena.clone()));
        STAT_TOTALS.with(|t| {
            if let Some(t) = t.borrow_mut().as_mut() {
                t.0 += stat_int(&core.vt.out, "canvas_group_sets");
                t.1 += stat_int(&core.vt.out, "backbuffer_copy_sets");
            }
        });
    }
    core.dispose();
    batches.push((core.ops.words.clone(), core.ops.arena.clone()));
    batches
}

thread_local! {
    /// When set, `replay_at` sums each apply's canvas_group_sets and backbuffer_copy_sets.
    static STAT_TOTALS: std::cell::RefCell<Option<(i64, i64)>> = const { std::cell::RefCell::new(None) };
}

/// An int stat from an apply's Variant-tree stats: the key's string, then tag 2 and an i64.
fn stat_int(vt: &[u8], key: &str) -> i64 {
    let at = vt
        .windows(key.len())
        .position(|w| w == key.as_bytes())
        .unwrap_or_else(|| panic!("no {key} in the apply stats"));
    let v = at + key.len();
    assert_eq!(vt[v], 2, "{key} is not an int");
    i64::from_le_bytes(vt[v + 1..v + 9].try_into().unwrap())
}

/// `replay_at`, also returning the summed (canvas_group_sets, backbuffer_copy_sets).
fn replay_counting(
    path: &std::path::Path,
    version: u8,
    full_scan: bool,
    sabotage: &str,
) -> (Vec<(Vec<u32>, Vec<u8>)>, (i64, i64)) {
    STAT_TOTALS.with(|t| *t.borrow_mut() = Some((0, 0)));
    let batches = replay_at(path, version, full_scan, sabotage);
    let totals = STAT_TOTALS.with(|t| t.borrow_mut().take().unwrap());
    (batches, totals)
}

const RECORDINGS: [&str; 6] = [
    "full.rs6",
    "patch.rs6",
    "inline.rs6",
    "presentation.rs6",
    "rate.rs6",
    "snap.rs6",
];

const SABOTAGES: [&str; 20] = [
    "",
    "reupload",
    "ignore-clip",
    "clip-before-clear",
    "drop-msdf",
    "ignore-set-transform",
    "ignore-clip-ignore",
    "ignore-nine-patch-axis",
    "drop-mesh-surface",
    "stale-mesh",
    "refuse-canvas-texture",
    "ignore-material",
    "ignore-canvas-modulate",
    "stale-param",
    "stale-texture",
    "ignore-canvas-stacking",
    "screen-copy-per-reader",
    "vertex-flat-varyings",
    "drop-canvas-group",
    "full-backbuffer-copy",
];

#[test]
fn delta_equals_full_scan_on_golden_6() {
    for name in RECORDINGS {
        for sabotage in SABOTAGES {
            let delta = replay(name, false, sabotage);
            let full = replay(name, true, sabotage);
            assert_eq!(delta.len(), full.len(), "{name} {sabotage:?}: batch counts");
            for (k, (d, f)) in delta.iter().zip(&full).enumerate() {
                assert!(d == f, "{name} {sabotage:?}: call batch {k} differs");
            }
        }
    }
}

#[test]
fn sabotages_change_the_calls() {
    // A sabotage that changes no call on any golden-6 recording is inert there; the gate legs
    // (rs-core-capi-check, the native receiver legs under rust) are what prove each one acts. This
    // pins which ones golden-6 can and cannot exercise, so a sabotage that silently stops acting
    // fails here.
    let mut inert = Vec::new();
    for sabotage in &SABOTAGES[1..] {
        let acts = RECORDINGS
            .iter()
            .any(|name| replay(name, false, sabotage) != replay(name, false, ""));
        if !acts {
            inert.push(*sabotage);
        }
    }
    println!("inert on golden-6: {inert:?}");
    assert_eq!(inert, EXPECTED_INERT);
}

/// golden-6 has no clipping item, no in-place mesh payload change, no CanvasTexture, no
/// screen-reading shader and no varying: these five have nothing to act on there (the gate legs
/// exercise them). The two CG1 sabotages act only on /10 state
/// (`golden_10_reissues_the_backbuffer_state`).
const EXPECTED_INERT: &[&str] = &[
    "ignore-clip",
    "stale-mesh",
    "refuse-canvas-texture",
    "screen-copy-per-reader",
    "vertex-flat-varyings",
    "drop-canvas-group",
    "full-backbuffer-copy",
];

#[test]
fn golden_7_applies_as_golden_6() {
    // rate.rs7 is rate.rs6's scene with /7's session (render-stream-7.md "Golden vectors"): the
    // same calls, batch for batch, under every sabotage.
    for sabotage in SABOTAGES {
        let six = replay("rate.rs6", false, sabotage);
        let seven = replay_at(&golden7().join("rate.rs7"), 7, false, sabotage);
        assert!(
            six == seven,
            "rate.rs7 {sabotage:?}: calls differ from rate.rs6"
        );
        assert!(
            replay_at(&golden7().join("rate.rs7"), 7, true, sabotage) == seven,
            "rate.rs7 {sabotage:?}: delta differs from full_scan"
        );
        // window2.rs7: the same full transaction, then two idle patches that change nothing.
        let w2 = replay_at(&golden7().join("window2.rs7"), 7, false, sabotage);
        assert_eq!(
            w2.len(),
            six.len() + 2,
            "window2.rs7 {sabotage:?}: batch count"
        );
        assert!(
            w2[..2] == six[..2],
            "window2.rs7 {sabotage:?}: session/full calls"
        );
        for (k, b) in w2[2..4].iter().enumerate() {
            assert!(
                b.0.is_empty(),
                "window2.rs7 {sabotage:?}: idle patch {k} issued calls"
            );
        }
        assert!(
            w2.last() == six.last(),
            "window2.rs7 {sabotage:?}: dispose calls"
        );
    }
}

/// The session at `version`: its kind and the vt answer's bytes.
fn session_at(path: &std::path::Path, version: u8) -> (i32, Vec<u8>) {
    let data = std::fs::read(path).unwrap();
    let mut core = Core::new();
    let kind = core.session(&data, wire::MAGIC_LEN, version);
    (kind, core.vt.out.clone())
}

fn mentions(bytes: &[u8], needle: &str) -> bool {
    bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn the_session_is_at_the_streams_version() {
    let rs6 = golden().join("rate.rs6");
    let rs7 = golden7().join("rate.rs7");
    assert_eq!(session_at(&rs6, 6).0, KIND_SESSION);
    assert_eq!(session_at(&rs7, 7).0, KIND_SESSION);
    // The protocol string is the version's: a /6 session read as /7 and the reverse are refused.
    assert_eq!(session_at(&rs6, 7).0, KIND_ERROR);
    assert_eq!(session_at(&rs7, 6).0, KIND_ERROR);
    // G8t: a /8 file (golden-8's full sink) opens at /8 and only at /8.
    let rs8 = golden7().join("../golden-8/full.rs8");
    assert_eq!(session_at(&rs8, 8).0, KIND_SESSION);
    // CG1: a /10 file opens at /10 and only at /10.
    let rs10 = golden7().join("../golden-10/full.rs10");
    assert_eq!(session_at(&rs10, 10).0, KIND_SESSION);
    assert_eq!(session_at(&rs10, 9).0, KIND_ERROR);
    // W11a: a /11 file opens at /11 and only at /11.
    let rs11 = golden7().join("../golden-11/full.rs11");
    assert_eq!(session_at(&rs11, 11).0, KIND_SESSION);
    assert_eq!(session_at(&rs11, 10).0, KIND_ERROR);
    assert_eq!(session_at(&rs10, 11).0, KIND_ERROR);
    assert_eq!(session_at(&rs8, 6).0, KIND_ERROR);
    assert_eq!(session_at(&rs6, 8).0, KIND_ERROR);
    // Only 6, 7 and 8: an older version is not a receiver stream.
    let (kind, vt) = session_at(&rs6, 5);
    assert_eq!(kind, KIND_ERROR);
    assert!(mentions(&vt, "bad-magic"));
    // golden-7's two publication invalids fail at the session with their own code.
    for name in ["publication-window.rs7", "publication-file-window.rs7"] {
        let (kind, vt) = session_at(&golden7().join("invalid").join(name), 7);
        assert_eq!(kind, KIND_ERROR, "{name}");
        assert!(mentions(&vt, "publication-entry"), "{name}");
    }
}

#[test]
fn op_table_matches_the_shim() {
    // receiver/ext/rs_core_capi.h's OP_COUNT.
    assert_eq!(rs_core_capi::ops::OP_COUNT, 68);
}

/// CG1 (render-stream-10.md "Receivers"): golden-10's states 9 and 10 re-issue the canvas-group
/// mode 5 times (three owners set; the transparent owner's fit margin; the clip-only owner
/// disabled -- the freed clip-and-draw item and the cleared full-copy item issue nothing) and the
/// back-buffer copy 3 times (two set, the rect copy disabled), at either encoding, and the delta
/// walk equals the full scan. The two CG1 sabotages each change the calls.
#[test]
fn golden_10_reissues_the_backbuffer_state() {
    let g10 = golden().join("../golden-10");
    for name in ["full.rs10", "patch.rs10", "inline.rs10"] {
        let path = g10.join(name);
        let (honest, totals) = replay_counting(&path, 10, false, "");
        assert_eq!(totals, (5, 3), "{name}");
        assert!(replay_at(&path, 10, true, "") == honest, "{name}: delta vs full scan");
        let (dropped, totals) = replay_counting(&path, 10, false, "drop-canvas-group");
        assert_eq!(totals, (0, 3), "{name}: drop-canvas-group");
        assert!(dropped != honest, "{name}: drop-canvas-group changes the calls");
        let (full, totals) = replay_counting(&path, 10, false, "full-backbuffer-copy");
        // The full-target copy is Rect2() already; the rect copy now is too.
        assert_eq!(totals, (5, 3), "{name}: full-backbuffer-copy");
        assert!(full != honest, "{name}: full-backbuffer-copy changes the calls");
    }
    // golden-9's states at /9 issue neither op (the keys do not exist below /10).
    let (_, totals) = replay_counting(&golden().join("../golden-9/full.rs9"), 9, false, "");
    assert_eq!(totals, (0, 0));
}

/// W11a (render-stream-11.md decision 12): golden-11 replays through the capi at /11. States 1 to
/// 10 are golden-10's, so the canvas-group and back-buffer calls are golden-10's; from state 11
/// the dynamic meshes are left undrawn (typed `mesh-dynamic`, counted `meshes_dynamic_undrawn`)
/// and the delta walk still equals the full scan.
#[test]
fn golden_11_replays_with_dynamic_meshes_undrawn() {
    let g11 = golden().join("../golden-11");
    for name in ["full.rs11", "patch.rs11", "inline.rs11"] {
        let path = g11.join(name);
        let (honest, totals) = replay_counting(&path, 11, false, "");
        assert_eq!(totals, (5, 3), "{name}");
        assert!(
            replay_at(&path, 11, true, "") == honest,
            "{name}: delta vs full scan"
        );
    }
    // The stats name the undrawn dynamic meshes at /11.
    let data = std::fs::read(g11.join("patch.rs11")).unwrap();
    let mut store = payloads_in(&g11.join("../golden-10/payloads"));
    let mut core = Core::new();
    let spans = wire::split_records(&data, 11).unwrap();
    assert_eq!(core.session(&data, spans[0].offset, 11), KIND_SESSION);
    core.begin_session();
    let mut undrawn = 0;
    let mut typed = false;
    for s in &spans[1..] {
        let kind = core.accept(&data, s.offset);
        assert_ne!(kind, KIND_ERROR);
        if kind == KIND_RESOURCE {
            assert!(core.resource_payload());
            let p = core.text.clone();
            store.insert(wire::sha256(&p), p);
            continue;
        }
        if kind != KIND_TRANSACTION {
            continue;
        }
        let (hashes, library) = needed(&mut core);
        for h in hashes {
            core.provide(&h, &store[&Hash::from_hex(&h).unwrap()])
                .unwrap();
        }
        for h in library {
            core.provide_library(&h, false, "no library in the golden test");
        }
        core.apply().unwrap();
        if mentions(&core.vt.out, "meshes_dynamic_undrawn") {
            undrawn += stat_int(&core.vt.out, "meshes_dynamic_undrawn");
        }
        typed |= mentions(&core.vt.out, "mesh-dynamic");
    }
    assert!(undrawn > 0, "no dynamic mesh was counted undrawn");
    assert!(typed, "no add_mesh command was typed mesh-dynamic");
}

/// G7o2 (D31): a deferred-digest session answers every record without its sha256, and
/// `record_digest` afterwards gives exactly the digest an inline session answered.
#[test]
fn deferred_record_digest_equals_inline() {
    let path = golden().join("rate.rs6");
    let data = std::fs::read(&path).unwrap();
    let spans = wire::split_records(&data, 6).unwrap();
    let mut inline = Core::new();
    let mut deferred = Core::new();
    deferred.digest_deferred = true;
    let mut checked = 0;
    for (i, s) in spans.iter().enumerate() {
        let (a, b) = if i == 0 {
            (
                inline.session(&data, s.offset, 6),
                deferred.session(&data, s.offset, 6),
            )
        } else {
            (
                inline.accept(&data, s.offset),
                deferred.accept(&data, s.offset),
            )
        };
        assert_eq!(a, b, "record {i}");
        assert_ne!(a, KIND_ERROR, "record {i}");
        deferred.record_digest(&data, s.offset).unwrap();
        let hex = String::from_utf8(deferred.text.clone()).unwrap();
        assert_eq!(hex.len(), 64);
        assert!(
            mentions(&inline.vt.out, &hex),
            "record {i}: inline answer has {hex}"
        );
        assert!(
            !mentions(&deferred.vt.out, &hex),
            "record {i}: deferred answer has no digest"
        );
        checked += 1;
    }
    assert_eq!(checked, spans.len());
    assert!(deferred.record_digest(&data, data.len() + 1).is_err());
}

/// G7o3 (D31): payloads staged as they arrive issue exactly the RenderingServer calls of payloads
/// provided (and verified) inside the frame, and once staged, no apply hashes a payload again.
#[test]
fn staged_payloads_apply_as_provided_ones() {
    for name in RECORDINGS {
        let path = golden().join(name);
        let data = std::fs::read(&path).unwrap();
        let store = payloads();
        let mut core = Core::new();
        let spans = wire::split_records(&data, 6).unwrap();
        let mut batches = Vec::new();
        for (i, s) in spans.iter().enumerate() {
            if i == 0 {
                assert_eq!(core.session(&data, s.offset, 6), KIND_SESSION);
                core.begin_session();
                batches.push((core.ops.words.clone(), core.ops.arena.clone()));
                continue;
            }
            let kind = core.accept(&data, s.offset);
            if kind == KIND_RESOURCE {
                assert!(core.resource_payload());
                let p = core.text.clone();
                core.stage(&wire::sha256(&p).to_hex(), &p).unwrap();
                continue;
            }
            if kind != KIND_TRANSACTION {
                continue;
            }
            let (hashes, library) = needed(&mut core);
            for h in &hashes {
                // A store payload arrives (is staged) just before its transaction; an inline
                // one was staged when its record arrived.
                if let Some(bytes) = store.get(&Hash::from_hex(h).unwrap()) {
                    core.stage(h, bytes).unwrap();
                }
            }
            for h in &hashes {
                // The frame's provide reads only the stage: these bytes are never hashed.
                core.provide(h, b"not the payload").unwrap();
            }
            for h in library {
                core.provide_library(&h, false, "no library in the golden test");
            }
            core.apply().unwrap();
            batches.push((core.ops.words.clone(), core.ops.arena.clone()));
        }
        assert_eq!(core.payloads.provided_in_frame, 0, "{name}");
        assert_eq!(core.payloads.refused, 0, "{name}");
        core.dispose();
        batches.push((core.ops.words.clone(), core.ops.arena.clone()));
        assert_eq!(batches, replay(name, false, ""), "{name}");
    }
}

/// G7o3 (D31): a corrupted payload is refused when it arrives and stages nothing, so the frame's
/// provide verifies whatever it is handed and refuses it again; unstage drops a staged payload.
#[test]
fn corrupted_payload_is_refused_on_arrival() {
    let store = payloads();
    let (hash, bytes) = store.iter().next().unwrap();
    let hex = hash.to_hex();
    let mut bad = bytes.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    let mut core = Core::new();
    let e = core.stage(&hex, &bad).unwrap_err();
    assert!(e.starts_with("resource-hash-mismatch"), "{e}");
    assert_eq!(core.staged_len(), 0);
    let e = core.provide(&hex, &bad).unwrap_err();
    assert!(e.starts_with("resource-hash-mismatch"), "{e}");
    // A good copy staged earlier is dropped by a later refused one under the same name.
    core.stage(&hex, bytes).unwrap();
    assert!(core.stage(&hex, &bad).is_err());
    assert_eq!(core.staged_len(), 0);
    core.stage(&hex, bytes).unwrap();
    core.unstage(&hex);
    assert_eq!(core.staged_len(), 0);
    assert_eq!(core.payloads.unstaged, 1);
    assert_eq!(core.payloads.refused, 2);
}
