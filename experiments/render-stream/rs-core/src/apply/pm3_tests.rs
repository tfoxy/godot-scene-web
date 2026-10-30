//! PM3: GSW's instanced multimesh draws over golden-11's multimesh states (17-21): instances
//! written from the accepted buffers at accept time, GLES3's half floats, and the receiver
//! sabotage `undrawn-multimesh`.

use super::payloads::PayloadStore;
use super::{geom, Applier, Viewport};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use gsw_canvas_draw_list::{Instance, DRAW_INSTANCED};
use std::path::PathBuf;

fn golden(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/golden-11")
            .join(name),
    )
    .unwrap()
}

struct Seen {
    /// Per applied transaction: (seq, instanced draws, instances, the raw floats of multimesh 1).
    frames: Vec<(i64, usize, Vec<Instance>, Option<Vec<f32>>)>,
    undrawn: u64,
    skipped: u64,
}

fn replay(half: bool, undrawn: bool) -> Seen {
    let data = golden("inline.rs11");
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
    a.half_instances = half;
    a.sabotage.lower.undrawn_multimesh = undrawn;
    let mut store = PayloadStore::default();
    let mut frames = Vec::new();
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
                // The store holds exactly the `ok` multimeshes of the state.
                let ok = st
                    .multimeshes
                    .values()
                    .filter(|m| m.status == crate::state::EntryStatus::Ok)
                    .count();
                assert_eq!(store.multimeshes.len(), ok, "seq {}", st.seq);
                let instanced = a
                    .list
                    .draws
                    .iter()
                    .filter(|d| d.flags & DRAW_INSTANCED != 0)
                    .count();
                assert_eq!(instanced, a.list.instanced.len());
                frames.push((
                    st.seq,
                    instanced,
                    a.list.instances.clone(),
                    store.multimeshes.get(1).map(|b| b.floats.clone()),
                ));
                a.list.consumed();
            }
        }
    }
    let total = |k: &str| a.shortcut_totals.get(k).copied().unwrap_or(0);
    Seen {
        frames,
        undrawn: total("multimesh-undrawn"),
        skipped: total("multimesh-unavailable-skipped"),
    }
}

#[test]
fn golden_11_multimesh_draws_instanced_with_half_floats() {
    let exact = replay(false, false);
    let half = replay(true, false);
    // States 1-16 hold no multimesh; 17 draws multimesh 1 (3 instances, a mesh, colours and
    // custom data). Multimesh 2 has no mesh and 3 is 3D: typed, not drawn (as GLES3 draws them).
    let at = |s: &Seen, seq: i64| s.frames.iter().find(|f| f.0 == seq).cloned().unwrap();
    for seq in 1..=16 {
        assert_eq!(at(&exact, seq).1, 0, "seq {seq}");
    }
    let (_, draws, inst, floats) = at(&exact, 17);
    assert!(draws >= 1);
    let floats = floats.expect("multimesh 1 held");
    assert_eq!(floats.len(), 3 * 16);
    assert_eq!(inst.len(), 3);
    for (i, x) in inst.iter().enumerate() {
        let d = &floats[16 * i..16 * (i + 1)];
        assert_eq!(&x.xform[..], &d[..8], "instance {i} transform, bit for bit");
        assert_eq!(&x.color[..], &d[8..12]);
        assert_eq!(&x.custom[..], &d[12..16]);
        let h = &at(&half, 17).2[i];
        assert_eq!(h.xform, x.xform, "transforms stay f32");
        assert_eq!(h.color, geom::godot_half4(x.color));
        assert_eq!(h.custom, geom::godot_half4(x.custom));
    }
    // 18: the buffer changes, so do the instances; 19 re-allocates 5 instances.
    assert_ne!(at(&exact, 18).2, inst);
    assert_eq!(at(&exact, 19).2.len(), 5);
    assert_eq!(exact.undrawn, 0);
    assert!(exact.skipped >= 2, "{}", exact.skipped);
    // The sabotage draws none of them, typed as before PM3.
    let sab = replay(false, true);
    assert!(sab.frames.iter().all(|f| f.1 == 0));
    assert!(sab.undrawn >= 3);
}
