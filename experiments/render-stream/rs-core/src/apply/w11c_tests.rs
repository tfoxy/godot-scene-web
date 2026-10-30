//! W11c: /11 applied through the core as GSW applies it (render-stream-11.md "Receivers"):
//! dynamic bodies by mesh id ([`super::dynamic::DynamicMeshes`]), the retention rule
//! ([`super::retention::Retention`]), and credit-window-2 folds, over golden-11's inline stream.

use super::payloads::PayloadStore;
use super::retention::Retention;
use super::{geom, Applier, Viewport};
use crate::state::{EntryStatus, Hash};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use std::collections::HashSet;
use std::path::PathBuf;

fn golden(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/golden-11")
            .join(name),
    )
    .unwrap()
}

fn viewport(v: &Validator) -> Viewport {
    let s = v.session();
    let size = s
        .viewport
        .presentation_size
        .unwrap_or(s.viewport.logical_size);
    Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    }
}

#[derive(Default, Debug)]
struct Run {
    txs: usize,
    bodies: u64,
    released: u64,
    max_entries: usize,
    digests: Vec<(i64, Hash)>,
    mm_undrawn: u64,
    mm_skipped: u64,
    instances_written: u64,
}

/// Replays `data` (/11), applying every `apply_every`-th transaction (a fold of the ones between,
/// as a credit-window-2 receiver does), and checks after every transaction:
/// - every dynamic surface of the newest state is held, and its geometry hashes to `body_sha256`;
/// - every named `ok` dynamic mesh is drawn after an apply (no `dynamic_undrawn`);
/// - the store holds only H = names(S_n) ∪ C ∪ what the display draws (with `retain`).
fn replay(data: &[u8], apply_every: usize, retain: bool) -> Run {
    let spans = wire::split_records(data, 11).unwrap();
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, Options::new(11)).unwrap();
    let mut a = Applier::new(viewport(&v));
    let mut store = PayloadStore::default();
    let mut retention = Retention::default();
    let mut need = Vec::new();
    let mut run = Run::default();
    let mut since_apply = 0;
    for span in &spans[1..] {
        let rec = span.bytes(data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                // golden-11 carries its KTX2 variants inline (decision 2); nothing draws one.
                if crate::payload::payload_kind(&b, 11) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, 11, true).unwrap();
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                run.txs += 1;
                run.bodies += u64::from(store.accept_transaction(&v, rec).unwrap());
                if retain {
                    retention.note(&v);
                    retention.sweep(&v, &mut store, || a.referenced_payload_hashes());
                }
                let st = v.state();
                for (id, m) in &st.meshes {
                    if !m.is_dynamic() {
                        assert!(
                            store.dynamic.get(*id).is_none(),
                            "mesh {id} held but not dynamic"
                        );
                        continue;
                    }
                    let held = store.dynamic.get(*id).expect("dynamic mesh held");
                    assert_eq!(held.surfaces.len(), m.surfaces.len());
                    for (k, s) in m.surfaces.iter().enumerate() {
                        let g = held.surfaces[k].as_ref().expect("body held");
                        assert_eq!(
                            Some(super::dynamic::body_sha256(g)),
                            s.body_sha256,
                            "mesh {id} surface {k}"
                        );
                    }
                }
                a.prepare(st, v.delta());
                since_apply += 1;
                if since_apply < apply_every {
                    continue;
                }
                since_apply = 0;
                a.needed(st, v.delta(), &store, &mut need);
                assert!(
                    need.is_empty(),
                    "inline stream: nothing to fetch ({need:?})"
                );
                a.apply(st, v.delta(), &store);
                assert_eq!(a.meshes.dynamic_undrawn, 0, "seq {}", st.seq);
                for (id, m) in &st.meshes {
                    if m.is_dynamic() && m.status == EntryStatus::Ok && a.meshes.is_resident(*id) {
                        assert!(a.meshes.drawn(*id, &store).is_some(), "mesh {id} drawable");
                    }
                }
                a.list.consumed();
                if retain {
                    retention.sweep(&v, &mut store, || a.referenced_payload_hashes());
                    let shown = a.referenced_payload_hashes();
                    let extra: Vec<&Hash> = store
                        .hashes()
                        .filter(|h| !v.names_contains(h) && !v.is_carried(h) && !shown.contains(h))
                        .collect();
                    assert!(
                        extra.is_empty(),
                        "seq {}: store holds {extra:?} outside H",
                        st.seq
                    );
                }
                run.max_entries = run.max_entries.max(store.len());
                run.digests.push((st.seq, a.paint_digest()));
            }
        }
    }
    run.released = retention.released_total;
    // PM1: states 17-21 draw add_multimesh. PM3 draws the drawable ones (instances written);
    // the 3D one and the unknown id are typed `multimesh-unavailable-skipped`.
    run.mm_undrawn = a
        .shortcut_totals
        .get("multimesh-undrawn")
        .copied()
        .unwrap_or(0);
    run.mm_skipped = a
        .shortcut_totals
        .get("multimesh-unavailable-skipped")
        .copied()
        .unwrap_or(0);
    run.instances_written = a.instances_written;
    run
}

#[test]
fn golden_11_inline_applies_dynamic_bodies_by_id_and_retains_h() {
    let data = golden("inline.rs11");
    let r = replay(&data, 1, true);
    // 16 W11a states, then PM1's multimesh states 17 to 21 and UIT's 22 and 23.
    assert_eq!(r.txs, 23);
    assert_eq!(r.mm_undrawn, 0, "{r:?}");
    assert!(r.mm_skipped >= 1, "{r:?}");
    assert!(r.instances_written >= 3, "{r:?}");
    assert!(r.bodies >= 3, "{r:?}");
    // Texture F leaves at 12: the store drops it (H), and it returns inline before 13.
    assert!(r.released >= 1, "{r:?}");
    // Without the rule the store keeps F past seq 12, and the paint is the same either way.
    let kept = replay(&data, 1, false);
    eprintln!(
        "w11c run {} txs, {} bodies, {} released, max entries {} (kept {})",
        r.txs, r.bodies, r.released, r.max_entries, kept.max_entries
    );
    assert_eq!(kept.digests, r.digests);
    assert!(kept.max_entries >= r.max_entries);
}

#[test]
fn golden_11_folds_paint_as_the_unfolded_stream() {
    let data = golden("inline.rs11");
    let each = replay(&data, 1, true);
    for every in [2, 3] {
        let folded = replay(&data, every, true);
        for (seq, d) in &folded.digests {
            let same = each.digests.iter().find(|(s, _)| s == seq).unwrap();
            assert_eq!(&same.1, d, "fold every {every}: seq {seq}");
        }
    }
}

#[test]
fn golden_11_incremental_paint_equals_a_fresh_applier() {
    // The in-place dynamic updates (`update` rows) must paint what a fresh build of the same state
    // paints (the oracle: a new applier over the resolved state and the same store).
    let data = golden("inline.rs11");
    let spans = wire::split_records(&data, 11).unwrap();
    let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(11)).unwrap();
    let mut a = Applier::new(viewport(&v));
    let mut store = PayloadStore::default();
    let mut updates = 0;
    for span in &spans[1..] {
        let rec = span.bytes(&data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                // golden-11 carries its KTX2 variants inline (decision 2); nothing draws one.
                if crate::payload::payload_kind(&b, 11) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, 11, true).unwrap();
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                store.accept_transaction(&v, rec).unwrap();
                a.apply(v.state(), v.delta(), &store);
                updates += a.meshes.uploads.iter().filter(|u| u.op == "update").count();
                a.list.consumed();
                let mut fresh = Applier::new(viewport(&v));
                let mut delta = crate::state::TxDelta {
                    full: true,
                    ..Default::default()
                };
                delta.canvases_upserted = v.state().canvases.keys().copied().collect();
                delta.items_upserted = v.state().items.keys().copied().collect();
                delta.items_commands = delta.items_upserted.clone();
                fresh.apply(v.state(), &delta, &store);
                assert_eq!(
                    a.paint_digest(),
                    fresh.paint_digest(),
                    "seq {}",
                    v.state().seq
                );
            }
        }
    }
    let _ = HashSet::<Hash>::new();
    assert!(updates >= 1, "an in-place dynamic update ran");
}
