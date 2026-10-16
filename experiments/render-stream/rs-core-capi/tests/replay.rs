//! The adapter over golden-6's valid recordings (protocol/golden-6): every transaction applies
//! without error, the delta-driven planner's RenderingServer call stream equals rs_applier.gd's
//! O(state) walk (`full_scan`) call for call, and every sabotage keeps that equality. The
//! comparison against the GDScript receiver's own evidence is `rs-core-capi-check legs`.

use render_stream_core::state::Hash;
use render_stream_core::wire;
use rs_core_capi::core::{Core, KIND_ERROR, KIND_RESOURCE, KIND_SESSION, KIND_TRANSACTION};
use std::collections::HashMap;
use std::path::PathBuf;

fn golden() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-6")
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
    let data = std::fs::read(golden().join(name)).unwrap();
    let mut store = payloads();
    let mut core = Core::new();
    core.planner.full_scan = full_scan;
    core.set_sabotage(sabotage);
    let spans = wire::split_records(&data, 6).unwrap();
    let mut batches = Vec::new();
    for (i, s) in spans.iter().enumerate() {
        if i == 0 {
            assert_eq!(
                core.session(&data, s.offset),
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
fn op_table_matches_the_shim() {
    // receiver/ext/rs_core_capi.h's OP_COUNT.
    assert_eq!(rs_core_capi::ops::OP_COUNT, 66);
}
