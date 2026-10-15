//! `ordering-model` (gate7-design.md G7a "Checks"): the applier's walk against gate 1's hand
//! model, from the resolved states and with no GPU. Gate 1's fixture (fixtures/gate1/) steps
//! through draw order, z (relative and absolute), `draw_behind_parent`, `top_level` (items whose
//! parent is the canvas), visibility and the cull mask, and its `expected.json` lists every
//! step's draws in final paint order (`draws`: rect in pixels and RGBA8). Here a real gate 1
//! recording is replayed through the validator and the applier, and at each step's settle
//! transaction the walk's paint order, lowered to the same (rect, colour) pairs, must equal that
//! list exactly.
//!
//! The recording is a native gate 1 source run's (D21): `RS_CORE_ORDERING_RECORDING` names its
//! `capture/recording.rs2` and `RS_CORE_ORDERING_SEQS` the settle seqs (its
//! `receiver/shot-seqs.txt`, step k = k-th). Without them the test reports that it did not run
//! and passes, so `cargo test` stays hermetic; `run-gate7.sh --legs g7-1` sets both and requires
//! the "ran" line in its log.

use super::geom;
use super::payloads::PayloadStore;
use super::{Applier, Viewport};
use crate::state::Command;
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use gsw_canvas_draw_list::Format;

fn rgba8(c: [f32; 4]) -> [i64; 4] {
    c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as i64)
}

/// The (rect_px, rgba8) pairs one step's walk paints, in order.
fn painted(a: &Applier, st: &crate::state::ResolvedState) -> Vec<([i64; 4], [i64; 4])> {
    let mut out = Vec::new();
    for (id, xf, modulate) in a.paint_order() {
        let Some(it) = st.items.get(&id) else {
            continue;
        };
        for c in &it.commands.list {
            if let Command::Rect { rect, color, .. } = c {
                let r = geom::xform_rect(&xf, rect);
                let px = [r[0], r[1], r[2], r[3]].map(|v| v.round() as i64);
                let col = [
                    color[0] * modulate[0],
                    color[1] * modulate[1],
                    color[2] * modulate[2],
                    color[3] * modulate[3],
                ];
                out.push((px, rgba8(col)));
            }
        }
    }
    out
}

#[test]
fn ordering_model() {
    let (Ok(path), Ok(seqs)) = (
        std::env::var("RS_CORE_ORDERING_RECORDING"),
        std::env::var("RS_CORE_ORDERING_SEQS"),
    ) else {
        eprintln!(
            "ordering-model: not run (RS_CORE_ORDERING_RECORDING / RS_CORE_ORDERING_SEQS unset)"
        );
        return;
    };
    let seqs: Vec<i64> = seqs
        .split(',')
        .map(|s| s.trim().parse().expect("RS_CORE_ORDERING_SEQS: integers"))
        .collect();
    let expected_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/gate1/expected.json"
    );
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(expected_path).expect("gate1 expected.json"))
            .expect("expected.json parses");
    let steps = expected["steps"].as_array().expect("steps[]");
    assert_eq!(
        steps.len(),
        seqs.len(),
        "one settle seq per expected.json step"
    );

    let data = std::fs::read(&path).expect("the gate 1 recording");
    let version = wire::version_of_magic(&data).expect("a render-stream recording");
    let spans = wire::split_records(&data, version).expect("framing");
    let mut v = Validator::new(
        spans[0].bytes(&data),
        spans[0].offset,
        Options::new(version),
    )
    .expect("session");
    let s = v.session();
    let size = s.viewport.logical_size;
    let mut a = Applier::new(Viewport {
        width: size[0] as u32,
        height: size[1] as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: Format::Rgb10A2,
    });
    let payloads = PayloadStore::default();
    let mut step = 0usize;
    let mut problems = Vec::new();
    for span in &spans[1..] {
        if step == seqs.len() {
            break;
        }
        if !matches!(
            v.accept(span.bytes(&data), span.offset)
                .expect("record accepted"),
            Accepted::Transaction
        ) {
            continue;
        }
        a.apply(v.state(), v.delta(), &payloads);
        a.list.consumed();
        if v.state().seq != seqs[step] {
            continue;
        }
        let want: Vec<([i64; 4], [i64; 4])> = steps[step]["draws"]
            .as_array()
            .expect("draws[]")
            .iter()
            .map(|d| {
                let r: Vec<i64> = d["rect_px"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_i64().unwrap())
                    .collect();
                let c: Vec<i64> = d["rgba8"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_i64().unwrap())
                    .collect();
                ([r[0], r[1], r[2], r[3]], [c[0], c[1], c[2], c[3]])
            })
            .collect();
        let got = painted(&a, v.state());
        if got != want {
            problems.push(format!(
                "step {step} (seq {}): walk paints {got:?}, expected.json lists {want:?}",
                seqs[step]
            ));
        }
        step += 1;
    }
    assert_eq!(step, seqs.len(), "every settle seq was reached");
    eprintln!(
        "ordering-model: ran {} steps of {path}: {} mismatching",
        seqs.len(),
        problems.len()
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
