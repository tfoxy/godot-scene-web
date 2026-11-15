//! I1: the item-query epoch. `Validator::items_epoch` plus `Applier::items_epoch` must move
//! whenever any item-query answer may change (`query_item`, `item_visible`, `query_children`,
//! `query_subtree_rect`), observed after every accept and after every apply over the goldens.
//! The converse is the point of the counter: a transaction that changes no item or canvas
//! leaves it, so a client may keep what it read.

use super::payloads::PayloadStore;
use super::{geom, Applier, Viewport};
use crate::state::Id;
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use std::path::PathBuf;

type Answers = Vec<(Id, String)>;

/// Every item's answers, as one comparable string each.
fn answers(v: &Validator, a: &Applier) -> Answers {
    let st = v.state();
    st.items
        .keys()
        .map(|&id| {
            let f = a.query_item(st, id);
            (
                id,
                format!(
                    "{:?} {:?} {:?} {:?}",
                    f.map(|f| (
                        f.parent,
                        f.visible,
                        f.xform.map(|x| x.map(f32::to_bits)),
                        f.rect.map(|r| r.map(f32::to_bits))
                    )),
                    a.item_visible(st, id),
                    a.query_children(st, id),
                    a.query_subtree_rect(st, id).map(|r| r.map(f32::to_bits)),
                ),
            )
        })
        .collect()
}

/// (transactions, observations where the epoch held, observations where it moved).
fn run(path: &str, version: u8) -> (usize, usize, usize) {
    let data = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
    let spans = wire::split_records(&data, version).unwrap();
    let mut v = Validator::new(
        spans[0].bytes(&data),
        spans[0].offset,
        Options::new(version),
    )
    .unwrap();
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
    let mut store = PayloadStore::default();
    let epoch = |v: &Validator, a: &Applier| (v.items_epoch(), a.items_epoch());
    let mut last = (epoch(&v, &a), answers(&v, &a));
    let (mut txs, mut held, mut moved) = (0, 0, 0);
    let mut observe = |v: &Validator, a: &Applier, last: &mut ((u64, u64), Answers)| {
        let now = (epoch(v, a), answers(v, a));
        if now.0 == last.0 {
            assert_eq!(
                now.1,
                last.1,
                "{path}: seq {} answers moved, epoch held",
                v.state().seq
            );
            held += 1;
        } else {
            assert!(now.0 > last.0, "{path}: the epoch only grows");
            moved += 1;
        }
        *last = now;
    };
    for span in &spans[1..] {
        let rec = span.bytes(&data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                if crate::payload::payload_kind(&b, version) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, version, true).unwrap();
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                txs += 1;
                observe(&v, &a, &mut last);
                store.accept_transaction(&v, rec).unwrap();
                let st = v.state();
                a.prepare(st, v.delta());
                a.apply(st, v.delta(), &store);
                a.list.consumed();
                observe(&v, &a, &mut last);
            }
        }
    }
    (txs, held, moved)
}

#[test]
fn equal_epochs_mean_equal_answers_over_the_goldens() {
    let mut held_total = 0;
    for (path, version) in [
        ("../protocol/golden-11/inline.rs11", 11),
        ("../protocol/golden-13/inline.rs13", 13),
        ("../protocol/golden-13/full.rs13", 13),
        ("../protocol/golden-13/patch.rs13", 13),
    ] {
        let (txs, held, moved) = run(path, version);
        assert!(
            txs > 0 && moved > 0,
            "{path}: {txs} transactions, {moved} moves"
        );
        held_total += held;
    }
    // The counter is worth keeping only if it holds somewhere: an apply after its accept
    // already moved, or a transaction that changed no item.
    assert!(held_total > 0);
}
