//! The adapter over golden-6's valid recordings (protocol/golden-6): every transaction applies
//! without error, the delta-driven planner's RenderingServer call stream equals rs_applier.gd's
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
    let mut out = HashMap::new();
    for e in std::fs::read_dir(golden().join("payloads")).unwrap() {
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
    let mut store = payloads();
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
    }
    core.dispose();
    batches.push((core.ops.words.clone(), core.ops.arena.clone()));
    batches
}

const RECORDINGS: [&str; 6] = [
    "full.rs6",
    "patch.rs6",
    "inline.rs6",
    "presentation.rs6",
    "rate.rs6",
    "snap.rs6",
];

const SABOTAGES: [&str; 16] = [
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

/// golden-6 has no clipping item, no in-place mesh payload change and no CanvasTexture: these
/// three have nothing to act on there (the gate legs exercise them).
const EXPECTED_INERT: &[&str] = &["ignore-clip", "stale-mesh", "refuse-canvas-texture"];

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
    // Only 6 and 7: an older version is not a receiver stream.
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
    assert_eq!(rs_core_capi::ops::OP_COUNT, 66);
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
