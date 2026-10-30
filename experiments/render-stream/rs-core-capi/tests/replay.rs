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
use rs_core_capi::core::{
    Core, KIND_ERROR, KIND_HELD, KIND_RESOURCE, KIND_SESSION, KIND_TRANSACTION,
};
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
    let mut store = if path.parent().unwrap().ends_with("golden-12")
        || path.parent().unwrap().ends_with("golden-13")
    {
        g12_payloads()
    } else if own.is_dir() {
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
    // PM5: a /12 file opens at /12 and only at /12.
    let rs12 = golden7().join("../golden-12/full.rs12");
    assert_eq!(session_at(&rs12, 12).0, KIND_SESSION);
    assert_eq!(session_at(&rs12, 11).0, KIND_ERROR);
    assert_eq!(session_at(&rs11, 12).0, KIND_ERROR);
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
    assert_eq!(rs_core_capi::ops::OP_COUNT, 92);
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

/// W11d (render-stream-11.md "As built (W11d)"): golden-11 replays through the capi at /11 with
/// every dynamic mesh drawn from its newest bodies. States 1 to 10 are golden-10's, so the
/// canvas-group and back-buffer calls are golden-10's; the delta walk equals the full scan; no
/// mesh is left undrawn or typed; after every transaction the bodies held hash to the resolved
/// surfaces' `body_sha256`; a body that moves with its shape kept is a region upload, a shape
/// change a rebuild of the same RID; and the retention rule hands back every hash that left H.
#[test]
fn golden_11_draws_dynamic_meshes() {
    let g11 = golden().join("../golden-11");
    for name in ["full.rs11", "patch.rs11", "inline.rs11"] {
        let path = g11.join(name);
        let (honest, totals) = replay_counting(&path, 11, false, "");
        assert_eq!(totals, (5, 3), "{name}");
        assert!(
            replay_at(&path, 11, true, "") == honest,
            "{name}: delta vs full scan"
        );
        assert!(
            replay_at(&path, 11, false, "stale-dynamic-rx") != honest,
            "{name}: stale-dynamic-rx changed no call"
        );
    }
    for name in ["patch.rs11", "inline.rs11"] {
        let data = std::fs::read(g11.join(name)).unwrap();
        let mut store = payloads_in(&g11.join("../golden-10/payloads"));
        let mut core = Core::new();
        let spans = wire::split_records(&data, 11).unwrap();
        assert_eq!(core.session(&data, spans[0].offset, 11), KIND_SESSION);
        core.begin_session();
        let (mut updates, mut rebuilt, mut released, mut checked) = (0, 0, 0usize, 0);
        // PM1: states 17-21 draw add_multimesh; PM2 draws them (multimesh_resources).
        let (mut mm_drawn, mut mm_buffers, mut mm_created, mut mm_freed) = (0, 0, 0, 0);
        for s in &spans[1..] {
            let kind = core.accept(&data, s.offset);
            assert_ne!(kind, KIND_ERROR, "{name}");
            core.take_released();
            released += count_strings(&core.vt.out);
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
                core.check_fetch(&h).ok();
                core.provide(&h, &store[&Hash::from_hex(&h).unwrap()])
                    .unwrap();
            }
            for h in library {
                core.provide_library(&h, false, "no library in the golden test");
            }
            core.apply().unwrap();
            assert!(!mentions(&core.vt.out, "meshes_dynamic_undrawn"), "{name}");
            assert!(!mentions(&core.vt.out, "mesh-dynamic"), "{name}");
            assert!(!mentions(&core.vt.out, "multimesh_commands_undrawn"), "{name}");
            // PM5: below /12 the key is never written (the stats stay byte-identical).
            assert!(!mentions(&core.vt.out, "particles_commands_undrawn"), "{name}");
            if mentions(&core.vt.out, "multimesh_resources") {
                mm_drawn += stat_int(&core.vt.out, "multimesh_commands");
                mm_buffers += stat_int(&core.vt.out, "buffer_sets");
                mm_created += stat_int(&core.vt.out, "multimeshes_created");
                mm_freed += stat_int(&core.vt.out, "multimeshes_freed");
            }
            updates += stat_int(&core.vt.out, "surface_updates");
            rebuilt += stat_int(&core.vt.out, "meshes_rebuilt");
            core.take_released();
            released += count_strings(&core.vt.out);
            // The bodies held against the resolved form's body_sha256, mesh by mesh.
            core.state_json();
            let state: serde_json::Value = serde_json::from_slice(&core.text).unwrap();
            let held = held_bodies(&mut core);
            for m in state["meshes"].as_array().unwrap() {
                let id = &m["id"].to_string();
                let want: Vec<String> = m["surfaces"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s["body_sha256"].as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                if want.is_empty() {
                    continue;
                }
                assert_eq!(held.get(id), Some(&want), "{name}: mesh {id}");
                checked += 1;
            }
        }
        assert!(mm_drawn > 0, "{name}: no add_multimesh drawn");
        assert!(mm_buffers > 0, "{name}: no multimesh_set_buffer");
        // State 17 makes 1 and 2 (3 is multimesh-3d); 19 frees 3 (never made); 20 removes 2.
        assert!(mm_created >= 2, "{name}: {mm_created} multimeshes made");
        assert!(mm_freed >= 1, "{name}: {mm_freed} multimeshes freed");
        assert!(checked > 0, "{name}: no dynamic mesh checked");
        assert!(updates > 0, "{name}: no region upload");
        assert!(rebuilt > 0, "{name}: no rebuild");
        assert!(released > 0, "{name}: the retention rule released nothing");
    }
}

/// golden-12's hashed payloads: golden-10's (states 1 to 21 are golden-11's) plus its own
/// (state 22's particles shader, and golden-11's dynamic bodies).
fn g12_payloads() -> HashMap<Hash, Vec<u8>> {
    let g12 = golden().join("../golden-12");
    let mut store = payloads_in(&g12.join("../golden-10/payloads"));
    store.extend(payloads_in(&g12.join("payloads")));
    store
}

/// The `unsupported_commands` rows of an apply's stats whose reason is `reason` (each row is a
/// 3-key dict ending in the reason's string).
fn count_mentions(bytes: &[u8], needle: &str) -> i64 {
    bytes.windows(needle.len()).filter(|w| *w == needle.as_bytes()).count() as i64
}

/// PM5 (render-stream-12.md "Receivers"), kept as PM6a's `undrawn-particles` sabotage (the
/// pre-PM6 planner): every `add_particles` is counted undrawn (`particles_commands_undrawn`,
/// written only when non-zero) and typed as one `unsupported_commands` row `particles-undrawn`.
/// Item 18 is drawn at states 22 (2 emitters), 24 (3) and 25 (2): 7 commands at either encoding.
#[test]
fn golden_12_counts_particles_undrawn() {
    for name in ["full.rs12", "patch.rs12", "inline.rs12"] {
        let (undrawn, rows, _) = replay_g12(name, "undrawn-particles");
        assert_eq!(undrawn, 7, "{name}: particles_commands_undrawn");
        assert_eq!(rows, 7, "{name}: particles-undrawn rows");
    }
}

/// PM6a (render-stream-12.md "As built (PM6a)"): golden-12 draws its emitters. State 22 makes
/// emitters 1 and 2 (2 is global and names 1 as its subemitter), with the process material and
/// its `particles` shader resident although no item names them; 23 restarts emitter 1 and
/// replays its two emits; 24's 3D emitter stays unmade (`unsupported-particles`); 25 frees
/// emitter 2 (no longer named); the unknown RID stays `unknown-particles`. Nothing is undrawn,
/// and the delta walk equals the full scan.
#[test]
fn golden_12_draws_particles() {
    for name in ["full.rs12", "patch.rs12", "inline.rs12"] {
        let (undrawn, rows, t) = replay_g12(name, "");
        assert_eq!((undrawn, rows), (0, 0), "{name}: undrawn");
        assert_eq!(t["particles_created"], 2, "{name}: created");
        assert_eq!(t["particles_freed"], 1, "{name}: freed");
        assert_eq!(t["emits"], 2, "{name}: emits");
        assert_eq!(t["emits_dropped"], 0, "{name}: emits dropped");
        assert!(t["restarts"] >= 1, "{name}: restarts {}", t["restarts"]);
        assert!(t["material_sets"] >= 2, "{name}: material sets");
        assert!(t["particles_commands"] >= 5, "{name}: drawn {}", t["particles_commands"]);
        assert!(t["shaders_created"] >= 1, "{name}: the particles shader");
        assert_eq!(t["unsupported-particles"], 1, "{name}: the 3D emitter");
        let (_, _, ignored) = replay_g12(name, "ignore-particle-emits");
        assert_eq!((ignored["emits"], ignored["emits_dropped"]), (0, 2), "{name}: sabotage");
        let (_, _, dropped) = replay_g12(name, "drop-particles-restart");
        assert_eq!(dropped["restarts"], 0, "{name}: drop-particles-restart");
        assert_eq!(dropped["emits"], 2, "{name}: drop-particles-restart keeps the emits");
        let delta = replay_at(&golden().join("../golden-12").join(name), 12, false, "");
        let full = replay_at(&golden().join("../golden-12").join(name), 12, true, "");
        assert_eq!(delta.len(), full.len(), "{name}: batch counts");
        for (k, (d, f)) in delta.iter().zip(&full).enumerate() {
            assert!(d == f, "{name}: call batch {k} differs from the full scan");
        }
    }
}

/// Replays a golden-12 recording under `sabotage`: (particles_commands_undrawn,
/// particles-undrawn rows, summed particles_resources and a few other totals).
fn replay_g12(name: &str, sabotage: &str) -> (i64, i64, HashMap<&'static str, i64>) {
    let path = golden().join("../golden-12").join(name);
    let data = std::fs::read(&path).unwrap();
    let mut store = g12_payloads();
    let mut core = Core::new();
    core.set_sabotage(sabotage);
    let spans = wire::split_records(&data, 12).unwrap();
    assert_eq!(core.session(&data, spans[0].offset, 12), KIND_SESSION);
    core.begin_session();
    let (mut undrawn, mut rows, mut applies) = (0, 0, 0);
    let keys = [
        "particles_created",
        "particles_freed",
        "emits",
        "emits_dropped",
        "restarts",
        "material_sets",
        "particles_commands",
        "shaders_created",
    ];
    let mut totals: HashMap<&'static str, i64> = HashMap::new();
    for s in &spans[1..] {
        let kind = core.accept(&data, s.offset);
        assert_ne!(kind, KIND_ERROR, "{name}");
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
            core.provide(&h, &store[&Hash::from_hex(&h).unwrap()]).unwrap();
        }
        for h in library {
            core.provide_library(&h, false, "no library in the golden test");
        }
        core.apply().unwrap();
        applies += 1;
        let out = &core.vt.out;
        let n = if mentions(out, "particles_commands_undrawn") {
            stat_int(out, "particles_commands_undrawn")
        } else {
            0
        };
        assert!(n != 0 || !mentions(out, "particles_commands_undrawn"), "{name}: a zero key");
        let r = count_mentions(out, "particles-undrawn");
        assert_eq!(r, n, "{name}: rows vs particles_commands_undrawn");
        undrawn += n;
        rows += r;
        *totals.entry("unsupported-particles").or_default() +=
            count_mentions(out, "unsupported-particles");
        *totals.entry("shaders_created").or_default() += stat_int(out, "shaders_created");
        if mentions(out, "particles_resources") {
            for k in keys {
                if k != "shaders_created" {
                    *totals.entry(k).or_default() += stat_int(out, k);
                }
            }
        }
    }
    assert_eq!(applies, 26, "{name}");
    for k in keys {
        totals.entry(k).or_default();
    }
    (undrawn, rows, totals)
}

/// The number of Strings in a vt Array of Strings (`take_released`): tag 10 (packed strings),
/// then a u32 count.
fn count_strings(vt: &[u8]) -> usize {
    assert_eq!(vt[0], 10, "not a String array");
    u32::from_le_bytes(vt[1..5].try_into().unwrap()) as usize
}

/// `dynamic_sha256()` as a map, read back through its JSON-free vt: mesh id -> body hashes.
fn held_bodies(core: &mut Core) -> HashMap<String, Vec<String>> {
    core.dynamic_sha256();
    let st = core.state().unwrap();
    let mut out = HashMap::new();
    for (id, m) in &st.meshes {
        if let Some(d) = core.dynamic.get(*id) {
            let _ = m;
            out.insert(
                id.to_string(),
                d.surfaces
                    .iter()
                    .map(|g| {
                        g.as_ref()
                            .map(|g| render_stream_core::apply::dynamic::body_sha256(g).to_hex())
                            .unwrap_or_default()
                    })
                    .collect(),
            );
        }
    }
    out
}

/// W11d (rs-core `Validator::transport_skip`): a coding resync skips transactions the receiver
/// never decodes; the records before them were accepted. After `transport_skip` the next full
/// transaction is accepted at its later seq (no `seq-gap`), a record re-carried against a skipped
/// base is not `resource-duplicate`, and the stream applies on as the unskipped one: its last
/// state equals the unskipped replay's.
#[test]
fn transport_skip_accepts_the_full_after_a_coding_resync() {
    let g11 = golden().join("../golden-11");
    let data = std::fs::read(g11.join("inline.rs11")).unwrap();
    let spans = wire::split_records(&data, 11).unwrap();
    let kinds: Vec<_> = {
        let mut c = Core::new();
        c.session(&data, spans[0].offset, 11);
        spans[1..]
            .iter()
            .map(|s| c.accept(&data, s.offset))
            .collect()
    };
    let tx_at: Vec<usize> = (0..kinds.len())
        .filter(|&i| kinds[i] == KIND_TRANSACTION)
        .collect();
    // Skip the third and fourth transactions (not their records); resume at the next full one.
    let skip: Vec<usize> = tx_at[2..4].to_vec();
    let mut core = Core::new();
    assert_eq!(core.session(&data, spans[0].offset, 11), KIND_SESSION);
    let mut skipping = false;
    let mut resumed = false;
    for (i, s) in spans[1..].iter().enumerate() {
        if skip.contains(&i) {
            core.transport_skip();
            skipping = true;
            continue;
        }
        if skipping && kinds[i] == KIND_TRANSACTION {
            let f = wire::frame(&data[s.offset..], 0).unwrap();
            let meta: serde_json::Value = serde_json::from_slice(f.meta).unwrap();
            if meta["encoding"] != "full" {
                continue; // the decoder skips every based transaction until the full one
            }
            skipping = false;
            resumed = true;
        }
        let kind = core.accept(&data, s.offset);
        assert_ne!(
            kind,
            KIND_ERROR,
            "record {i}: {}",
            String::from_utf8_lossy(&core.vt.out)
        );
    }
    assert!(
        resumed,
        "inline.rs11 has no full transaction after the skip"
    );
    // The unskipped stream's final state.
    let mut plain = Core::new();
    plain.session(&data, spans[0].offset, 11);
    for s in &spans[1..] {
        plain.accept(&data, s.offset);
    }
    core.state_json();
    plain.state_json();
    assert_eq!(core.text, plain.text);
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

/// UIT (render-stream-11.md "As built (UIT)"): golden-11's item 18 sets
/// `canvas_item_set_use_identity_transform` true at 22 and false at 23 (one
/// `ItemSetUseIdentityTransform` op each, item then the flag), at either encoding; every apply
/// before 22 is what it was, and the receiver sabotage `ignore-identity-transform` issues neither.
#[test]
fn golden_11_reissues_the_identity_flag() {
    let op = rs_core_capi::ops::Op::ItemSetUseIdentityTransform as u32;
    let has = |words: &[u32], flag: u32| words.windows(3).any(|w| w[0] == op && w[2] == flag);
    let g11 = golden().join("../golden-11");
    for name in ["full.rs11", "patch.rs11", "inline.rs11"] {
        let path = g11.join(name);
        let honest = replay_at(&path, 11, false, "");
        assert!(replay_at(&path, 11, true, "") == honest, "{name}: delta vs full scan");
        let ignored = replay_at(&path, 11, false, "ignore-identity-transform");
        // The session's batch, then one per transaction (resources push none), then dispose.
        assert_eq!(honest.len(), 23 + 2, "{name}");
        assert_eq!(ignored.len(), honest.len(), "{name}");
        for n in 0..=21 {
            assert!(honest[n] == ignored[n], "{name}: apply {n} moved");
            assert!(!has(&honest[n].0, 1), "{name}: apply {n}");
        }
        assert!(has(&honest[22].0, 1), "{name}: 22 sets the flag");
        assert!(has(&honest[23].0, 0), "{name}: 23 clears it");
        assert!(!has(&ignored[22].0, 1) && !has(&ignored[23].0, 0), "{name}: sabotage");
    }
}

/// W13d (render-stream-13.md "As built (W13d)"): a /13 recording applies exactly as its /12
/// twin: the same RenderingServer call batches after every transaction (the planner sees /12's
/// model, the ingest reads `record_view`'s reconstructed record), and the same held dynamic bodies.
#[test]
fn golden_13_applies_as_golden_12() {
    let g13 = golden().join("../golden-13");
    let g12 = golden().join("../golden-12");
    for (n13, twin) in [
        ("full.rs13", g12.join("full.rs12")),
        ("patch.rs13", g12.join("patch.rs12")),
        ("inline.rs13", g12.join("inline.rs12")),
        ("predict.rs13", g13.join("predict.rs12")),
    ] {
        let a = replay_at(&g13.join(n13), 13, false, "");
        let b = replay_at(&twin, 12, false, "");
        assert_eq!(a.len(), b.len(), "{n13}: batch counts");
        for (k, (x, y)) in a.iter().zip(&b).enumerate() {
            assert!(x == y, "{n13}: call batch {k} differs from the /12 twin's");
        }
        // The held bodies after every transaction.
        let held = |path: &std::path::Path, version: u8| {
            let data = std::fs::read(path).unwrap();
            let spans = wire::split_records(&data, version).unwrap();
            let mut core = Core::new();
            assert_eq!(core.session(&data, spans[0].offset, version), KIND_SESSION);
            let mut out = Vec::new();
            for s in &spans[1..] {
                let kind = core.accept(&data, s.offset);
                assert_ne!(kind, KIND_ERROR, "{}", String::from_utf8_lossy(&core.vt.out));
                if kind == KIND_TRANSACTION {
                    let mut h: Vec<_> = held_bodies(&mut core).into_iter().collect();
                    h.sort();
                    out.push(h);
                }
            }
            out
        };
        let (h13, h12) = (held(&g13.join(n13), 13), held(&twin, 12));
        assert_eq!(h13, h12, "{n13}: held bodies");
        if n13 == "predict.rs13" {
            assert!(h13.iter().any(|h| !h.is_empty()), "{n13}: no dynamic body held");
        }
    }
    // Below /13 the session refuses GRSD, and /13 refuses GRSC (`bad-magic` from the split).
    let data = std::fs::read(g13.join("patch.rs13")).unwrap();
    assert!(wire::split_records(&data, 12).is_err());
}

/// `counters`' integer value of `key` (0 when absent).
fn counter(core: &mut Core, key: &str) -> i64 {
    core.counters();
    if mentions(&core.vt.out, key) {
        stat_int(&core.vt.out, key)
    } else {
        0
    }
}

/// W13d: a /13 transaction whose `predict_check` is wrong is refused `predict-check` (nothing
/// changes); after it every patch is held (`KIND_HELD`, not accepted) until the full transaction,
/// which `transport_skip` lets in at its later seq; the stream then ends on the unbroken replay's
/// state. Under `no-predict-reset` the full fails `predict-check` too, so the stream stays held.
#[test]
fn predict_check_holds_patches_until_the_full() {
    let g13 = golden().join("../golden-13");
    let data = std::fs::read(g13.join("patch.rs13")).unwrap();
    let spans = wire::split_records(&data, 13).unwrap();
    // Corrupt seq 12's predict_check (one hex digit; the record keeps its length).
    let mut bad = data.clone();
    let mut target = None;
    for s in &spans[1..] {
        let f = wire::frame(&data[s.offset..], 0).unwrap();
        let meta: serde_json::Value = serde_json::from_slice(f.meta).unwrap();
        if meta["type"] == "transaction" && meta["seq"] == 12 {
            target = Some(s.offset);
        }
    }
    let at = target.expect("patch.rs13 has seq 12");
    let key = b"\"predict_check\":\"";
    let rec_len = wire::le_u32(&data, at) as usize;
    let rec = &data[at..at + 4 + rec_len];
    let k = rec.windows(key.len()).position(|w| w == key).unwrap() + key.len();
    bad[at + k] = if rec[k] == b'0' { b'1' } else { b'0' };

    let run = |sabotage: &str| {
        let mut core = Core::new();
        core.set_sabotage(sabotage);
        assert_eq!(core.session(&bad, spans[0].offset, 13), KIND_SESSION);
        let mut kinds = Vec::new();
        for s in &spans[1..] {
            let kind = core.accept(&bad, s.offset);
            if kind == KIND_ERROR {
                if !mentions(&core.vt.out, "predict-check") {
                    // no-predict-reset: the stream never recovers, so the end record's count is
                    // refused; the honest run never gets here.
                    assert!(
                        sabotage != "" && mentions(&core.vt.out, "end-count-mismatch"),
                        "{}",
                        String::from_utf8_lossy(&core.vt.out)
                    );
                    break;
                }
                core.transport_skip();
            }
            kinds.push(kind);
        }
        (core, kinds)
    };
    let (mut core, kinds) = run("");
    let errors = kinds.iter().filter(|k| **k == KIND_ERROR).count();
    let held = kinds.iter().filter(|k| **k == KIND_HELD).count();
    assert_eq!((errors, held), (1, 3), "seq 12 fails, 13 to 15 are held");
    assert_eq!(counter(&mut core, "w13_predict_failures"), 1);
    assert_eq!(counter(&mut core, "w13_predict_dropped"), 3);
    let mut plain = Core::new();
    plain.session(&data, spans[0].offset, 13);
    for s in &spans[1..] {
        assert_ne!(plain.accept(&data, s.offset), KIND_ERROR);
    }
    core.state_json();
    plain.state_json();
    assert_eq!(core.text, plain.text, "the resynced stream ends on the unbroken state");

    // no-predict-reset: the honest stream fails at the first full after units exist (seq 16).
    let mut sab = Core::new();
    sab.set_sabotage("no-predict-reset");
    assert_eq!(sab.session(&data, spans[0].offset, 13), KIND_SESSION);
    let mut first_error = None;
    for s in &spans[1..] {
        if sab.accept(&data, s.offset) == KIND_ERROR {
            first_error = Some(String::from_utf8_lossy(&sab.vt.out).to_string());
            break;
        }
    }
    let e = first_error.expect("no-predict-reset fails");
    assert!(e.contains("predict-check") && e.contains("seq 16"), "{e}");
    let (_, kinds) = run("no-predict-reset");
    assert!(
        kinds.iter().filter(|k| **k == KIND_ERROR).count() >= 2,
        "no-predict-reset: the resync's full fails too"
    );
}

/// W13d bench (ignored): `Core::accept` per transaction (rs-core's validator, the /13 un-predict,
/// the dynamic and multimesh ingest and the retention sweep; no apply) over the recording named by
/// `RSC_BENCH_RECORDING` at its magic's version, `RSC_BENCH_REPEATS` times (default 5). Prints the
/// minimum over repeats of each transaction's time, as p50, p95 and mean in µs.
/// `cargo test --release --test replay -- --ignored --nocapture accept_bench`
#[test]
#[ignore]
fn accept_bench() {
    let path = std::env::var("RSC_BENCH_RECORDING").expect("RSC_BENCH_RECORDING");
    let repeats: usize = std::env::var("RSC_BENCH_REPEATS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(5);
    let data = std::fs::read(&path).unwrap();
    let version = match &data[..4] {
        b"GRSD" => 13,
        b"GRSC" => 12,
        b"GRSB" => 11,
        m => panic!("unsupported magic {m:?}"),
    };
    let spans = wire::split_records(&data, version).unwrap();
    let mut best: Vec<u128> = Vec::new();
    for r in 0..repeats {
        let mut core = Core::new();
        assert_eq!(core.session(&data, spans[0].offset, version), KIND_SESSION);
        let mut k = 0;
        for s in &spans[1..] {
            let t = std::time::Instant::now();
            let kind = core.accept(&data, s.offset);
            let ns = t.elapsed().as_nanos();
            assert_ne!(kind, KIND_ERROR, "{}", String::from_utf8_lossy(&core.vt.out));
            if kind == KIND_TRANSACTION {
                if r == 0 {
                    best.push(ns);
                } else {
                    best[k] = best[k].min(ns);
                }
                k += 1;
            }
        }
    }
    let mut sorted = best.clone();
    sorted.sort_unstable();
    let pct = |p: f64| sorted[((sorted.len() - 1) as f64 * p).round() as usize] as f64 / 1000.0;
    let mean = best.iter().sum::<u128>() as f64 / best.len() as f64 / 1000.0;
    println!(
        "accept_bench {path} v{version}: {} transactions, p50 {:.1} us, p95 {:.1} us, mean {:.1} us",
        best.len(),
        pct(0.5),
        pct(0.95),
        mean
    );
}
