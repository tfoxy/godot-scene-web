//! UIT (render-stream-11.md "As built (UIT)"): GSW honours /11's `use_identity_transform` over
//! golden-11's states 22 and 23. Item 18 (a child of item 16 at x 192 y 64; its own xform x 8 y
//! 64) draws with the canvas transform alone at 22 (the root canvas's, the identity here) and with
//! the composed transform once the flag turns false at 23; the receiver sabotage
//! `ignore-identity-transform` draws it composed at 22 too.

use super::payloads::PayloadStore;
use super::{geom, Applier, Viewport};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use std::path::PathBuf;

/// Item 18's row transform after each of seqs 22 and 23 (none before 22: the item is new there).
fn rows_of_item_18(ignore: bool) -> Vec<(i64, [f32; 6])> {
    let data = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-11/inline.rs11"),
    )
    .unwrap();
    let spans = wire::split_records(&data, 11).unwrap();
    let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(11)).unwrap();
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
    a.sabotage.ignore_identity_transform = ignore;
    let mut store = PayloadStore::default();
    let mut out = Vec::new();
    for span in &spans[1..] {
        let rec = span.bytes(&data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                if crate::payload::payload_kind(&b, 11) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, 11, true).unwrap();
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                store.accept_transaction(&v, rec).unwrap();
                let st = v.state();
                a.prepare(st, v.delta());
                a.apply(st, v.delta(), &store);
                if let Some(rec) = a.items.get(&18) {
                    out.push((st.seq, a.list.items[rec.row as usize].xform));
                }
                a.list.consumed();
            }
        }
    }
    out
}

#[test]
fn golden_11_identity_item_draws_with_the_canvas_transform() {
    let composed = [1.0, 0.0, 0.0, 1.0, 200.0, 128.0];
    assert_eq!(
        rows_of_item_18(false),
        vec![(22, geom::IDENTITY), (23, composed)],
        "22: the canvas transform alone; 23: the flag cleared, the composed transform"
    );
    // The pre-UIT receiver composes it at both.
    assert_eq!(rows_of_item_18(true), vec![(22, composed), (23, composed)]);
}
