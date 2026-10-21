//! G7q (credit window 2, gate7-design.md Q2 "Credit with window w"): a receiver may accept
//! several transactions before one apply, drawing only the last. The applier is delta-driven, so
//! `prepare` merges every prepared transaction's delta (`TxDelta::merge`). This checks the
//! result against applying each transaction on its own: after every grouped apply the painted
//! result (`paint_digest`, the scissors and the lowered items) equals the sequential applier's at
//! the same seq. It runs over the golden recordings, and over any real recordings named in
//! RS_CORE_MERGE_RECORDINGS (comma-separated paths).

use super::geom;
use super::payloads::PayloadStore;
use super::{Applier, Viewport};
use crate::state::TxDelta;
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use gsw_canvas_draw_list::Format;
use std::path::PathBuf;

fn applier_for(v: &Validator) -> Applier {
    let s = v.session();
    let size = s.viewport.logical_size;
    Applier::new(Viewport {
        width: size[0] as u32,
        height: size[1] as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: Format::Rgb10A2,
    })
}

/// Applies `data` twice in step: one applier per transaction, one per group of `group`
/// transactions (prepared one by one, applied once). Returns the grouped applies compared.
fn compare_grouped(name: &str, data: &[u8], group: usize) -> usize {
    let version = wire::version_of_magic(data).expect("a render-stream recording");
    let spans = wire::split_records(data, version).expect("framing");
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, Options::new(version))
        .expect("session");
    let mut seq_applier = applier_for(&v);
    let mut grouped = applier_for(&v);
    let payloads = PayloadStore::default();
    let mut in_group = 0usize;
    let mut compared = 0usize;
    for span in &spans[1..] {
        if !matches!(v.accept(span.bytes(data), span.offset), Ok(Accepted::Transaction)) {
            continue;
        }
        seq_applier.prepare(v.state(), v.delta());
        seq_applier.apply(v.state(), v.delta(), &payloads);
        seq_applier.list.consumed();
        grouped.prepare(v.state(), v.delta());
        in_group += 1;
        if in_group < group {
            continue;
        }
        in_group = 0;
        grouped.apply(v.state(), v.delta(), &payloads);
        grouped.list.consumed();
        let seq = v.state().seq;
        assert_eq!(
            grouped.paint_digest(),
            seq_applier.paint_digest(),
            "{name}: seq {seq}, groups of {group}: the grouped apply paints what applying each did"
        );
        assert_eq!(grouped.scissors(), seq_applier.scissors(), "{name}: seq {seq} scissors");
        let lowered = |a: &Applier| {
            a.lowered_items()
                .into_iter()
                .map(|(id, l)| format!("{id:?} {l:?}"))
                .collect::<Vec<_>>()
        };
        assert_eq!(lowered(&grouped), lowered(&seq_applier), "{name}: seq {seq} lowered");
        compared += 1;
    }
    compared
}

#[test]
fn grouped_apply_matches_sequential_on_goldens() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol");
    let mut compared = 0;
    for rel in [
        "golden-2/patch.rs2",
        "golden-3/patch.rs3",
        "golden-4/patch.rs4",
        "golden-5/patch.rs5",
        "golden-5/params.rs5",
        "golden-6/patch.rs6",
        "golden-6/rate.rs6",
        "golden-7/window2.rs7",
    ] {
        let Ok(data) = std::fs::read(dir.join(rel)) else {
            continue;
        };
        for group in [2, 3] {
            compared += compare_grouped(rel, &data, group);
        }
    }
    assert!(compared > 0, "no golden recording was compared");
}

#[test]
fn grouped_apply_matches_sequential_on_recordings() {
    let Ok(list) = std::env::var("RS_CORE_MERGE_RECORDINGS") else {
        eprintln!("window_tests: no real recordings (RS_CORE_MERGE_RECORDINGS unset)");
        return;
    };
    for path in list.split(',').filter(|p| !p.is_empty()) {
        let data = std::fs::read(path).expect("RS_CORE_MERGE_RECORDINGS: a readable recording");
        for group in [2, 3] {
            let n = compare_grouped(path, &data, group);
            eprintln!("window_tests: {path}: {n} grouped applies of {group} matched");
            assert!(n > 0, "{path}: nothing compared");
        }
    }
}

#[test]
fn merge_is_the_ascending_union() {
    let mut a = TxDelta {
        seq: 4,
        items_upserted: vec![1, 3, 5],
        items_removed: vec![2],
        items_commands: vec![3],
        ..TxDelta::default()
    };
    let b = TxDelta {
        seq: 5,
        items_upserted: vec![2, 3, 6],
        items_removed: vec![5],
        items_commands: vec![6],
        defaults_changed: true,
        ..TxDelta::default()
    };
    a.merge(&b);
    assert_eq!(a.seq, 5);
    assert_eq!(a.items_upserted, vec![1, 2, 3, 5, 6]);
    assert_eq!(a.items_removed, vec![2, 5]);
    assert_eq!(a.items_commands, vec![3, 6]);
    assert!(a.defaults_changed && !a.full);
}
