use super::{
    override_tests::{applier, base, C1, P},
    *,
};
use crate::tweens::*;
fn pose() -> Pose {
    Pose {
        item: P,
        kind: Kind::Node2d,
        values: [
            5., 0., 0., 1., 1., 0., 0., 0., 1., 1., 1., 1., 1., 1., 1., 1.,
        ],
    }
}
fn begin(id: i64, order: i64, property: &str, to: Vec<f32>, start: i64, duration: i64) -> Begin {
    Begin {
        id,
        item: P,
        order,
        begin: 0,
        end: start + duration,
        steps: vec![Step {
            components: components(property).unwrap(),
            start,
            duration,
            trans: 0,
            ease: 0,
            from: None,
            to,
        }],
    }
}
fn record(events: Vec<Event>) -> Record {
    Record {
        seq: 1,
        frame: 1,
        time: 0,
        events,
        poses: vec![pose()],
    }
}
#[test]
fn easing_matches_effects_all_48_pairs() {
    let rows: Vec<[f64; 4]> =
        serde_json::from_str(include_str!("../../test/tween-easing.json")).unwrap();
    let mut max = 0f64;
    for [tr, ea, t, want] in rows {
        let got = ease_sample(tr as u8, ea as u8, t);
        max = max.max((got - want).abs());
        assert!(
            (got - want).abs() < 2e-12,
            "trans {tr} ease {ea} t {t}: {got} != {want}"
        );
    }
    eprintln!("tween easing maximum absolute progress error: {max}");
}
#[test]
fn golden_records_decode_and_invalid_vectors_fail() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-17");
    for file in ["begin.record", "poses.record", "cancel-removed.record"] {
        let bytes = std::fs::read(root.join(file)).unwrap();
        decode(&bytes, 0, &mut Default::default()).unwrap();
    }
    for entry in std::fs::read_dir(root.join("invalid")).unwrap() {
        let path = entry.unwrap().path();
        let bytes = std::fs::read(&path).unwrap();
        let result = decode(&bytes, 0, &mut Default::default());
        if path.file_name().unwrap() == "mismatch-frame.record" {
            continue;
        }
        assert!(result.is_err(), "{} accepted", path.display());
    }
}
#[test]
fn linear_position_and_rotation_are_components() {
    let s = base();
    let mut p = Playback::default();
    let mut b = begin(1, 1, "position:x", vec![105.], 0, 1000000);
    b.steps.push(Step {
        components: vec![2],
        start: 0,
        duration: 1000000,
        trans: 0,
        ease: 0,
        from: Some(vec![0.]),
        to: vec![std::f32::consts::PI],
    });
    p.picture(0, 0., &[record(vec![Event::Begin(b)])], &s);
    p.sample(500000., &s);
    let d = p.display[&P];
    assert_eq!(d.xform[4], 55.);
    assert!(d.xform[0].abs() < 1e-6);
    assert!((d.xform[1] - 1.).abs() < 1e-6);
    assert_eq!(s.items[&P].xform[4], 5.);
}
#[test]
fn matrix_preserves_negative_zero_scale_skew_and_control_pivot() {
    let mut v = pose().values;
    v[2] = 0.7;
    v[3] = -2.;
    v[4] = 3.;
    v[5] = 0.3;
    let n = matrix(Kind::Node2d, &v);
    assert_eq!(n[0], 0.7f32.cos() * -2.);
    assert_eq!(n[2], -1f32.sin() * 3.);
    v[3] = 0.;
    v[5] = 0.;
    v[6] = 20.;
    v[7] = 30.;
    let c = matrix(Kind::Control, &v);
    assert_eq!(c[4], v[0] + 20. - c[0] * 20. - c[2] * 30.);
    assert_eq!(c[5], v[1] + 30. - c[1] * 20. - c[3] * 30.);
}
#[test]
fn delayed_components_follow_host_then_hold_and_handover() {
    let mut s = base();
    let mut p = Playback::default();
    let b = begin(1, 1, "position:x", vec![105.], 100000, 900000);
    p.picture(0, 0., &[record(vec![Event::Begin(b)])], &s);
    assert_eq!(p.display[&P].xform, s.items[&P].xform);
    let mut r = record(vec![]);
    r.seq = 2;
    r.time = 50000;
    r.poses[0].values[0] = 15.;
    r.poses[0].values[1] = 20.;
    s.items.get_mut(&P).unwrap().xform[4] = 15.;
    s.items.get_mut(&P).unwrap().xform[5] = 20.;
    p.picture(50000, 50000., &[r], &s);
    p.sample(550000., &s);
    assert_eq!(p.display[&P].xform[4], 60.);
    assert_eq!(p.display[&P].xform[5], 20.);
    p.sample(1000000., &s);
    assert!(!p.active());
    assert!(!p.display.contains_key(&P));
}
#[test]
fn chains_gaps_zero_duration_and_crossed_boundaries() {
    let s = base();
    let mut b = begin(1, 1, "position:x", vec![15.], 0, 100000);
    b.end = 500000;
    b.steps.push(Step {
        components: vec![0],
        start: 200000,
        duration: 100000,
        trans: 0,
        ease: 0,
        from: None,
        to: vec![25.],
    });
    b.steps.push(Step {
        components: vec![1],
        start: 400000,
        duration: 0,
        trans: 0,
        ease: 0,
        from: None,
        to: vec![50.],
    });
    let mut p = Playback::default();
    p.picture(250000, 0., &[record(vec![Event::Begin(b)])], &s);
    assert_eq!(p.display[&P].xform[4], 20.);
    p.sample(160000., &s);
    assert_eq!(p.display[&P].xform[5], 50.);
}
#[test]
fn claims_replaced_once_no_resurrection_cancel_reuse() {
    let s = base();
    let mut p = Playback::default();
    let b = begin(1, 1, "position", vec![105., 200.], 0, 1000000);
    p.picture(0, 0., &[record(vec![Event::Begin(b)])], &s);
    let mut r = record(vec![Event::Begin(begin(
        2,
        2,
        "position:x",
        vec![50.],
        0,
        1000000,
    ))]);
    r.time = 100000;
    p.picture(100000, 100000., &[r], &s);
    assert_eq!(p.diagnostics.claims_replaced, 1);
    assert_eq!(p.counts().0, 2);
    p.picture(200000, 200000., &[record(vec![Event::Cancel(2)])], &s);
    assert_eq!(p.display[&P].xform[4], 5.);
    assert!(p.display[&P].xform[5] > 0.);
    p.picture(
        300000,
        300000.,
        &[record(vec![
            Event::Cancel(1),
            Event::Begin(begin(1, 3, "scale:x", vec![2.], 0, 1000000)),
        ])],
        &s,
    );
    assert_eq!(p.counts().0, 1);
}
#[test]
fn backward_anchor_holds_once_forward_anchor_completes() {
    let s = base();
    let mut p = Playback::default();
    p.picture(
        0,
        0.,
        &[record(vec![Event::Begin(begin(
            1,
            1,
            "position:x",
            vec![105.],
            0,
            1000000,
        ))])],
        &s,
    );
    p.sample(500000., &s);
    p.picture(400000, 500000., &[], &s);
    assert_eq!(p.display[&P].xform[4], 55.);
    p.sample(550000., &s);
    assert_eq!(p.display[&P].xform[4], 55.);
    assert_eq!(p.diagnostics.backward_anchor_holds, 1);
    p.picture(1000000, 600000., &[], &s);
    assert!(!p.active());
    p.picture(0, 700000., &[], &s);
    assert!(!p.active());
}
#[test]
fn applier_composes_parent_tween_below_overrides_and_keeps_host_query() {
    let s = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &super::override_tests::full_delta(&s), &store);
    let host = a.query_item(&s, C1).unwrap().xform.unwrap();
    let vals = vec![
        1., 0., 0., 1., 0., -10., 1., 1., 1., 1., 1., 0., 0., 0., 0., 0.,
    ];
    a.set_overrides(&[P], &vals).unwrap();
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1000000,
    ))]);
    a.tween_tick(&s, &store, 0., Some((0, &[r])));
    a.tween_tick(&s, &store, 500000., None);
    assert_eq!(a.query_item(&s, C1).unwrap().xform, Some(host));
    let child = a
        .paint_order()
        .into_iter()
        .find(|(id, _, _)| *id == C1)
        .unwrap();
    assert!((child.1[4] - host[4] - 50.).abs() < 1e-6);
    assert!((child.1[5] - host[5] + 10.).abs() < 1e-6);
    a.tween_tick(&s, &store, 1000000., None);
    assert!(!a.tweens.active());
}

#[test]
fn prepared_transaction_pauses_redraw_without_host_leak_and_resumes_forward() {
    let mut state = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&state, &super::override_tests::full_delta(&state), &store);
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1000000,
    ))]);
    a.tween_tick(&state, &store, 0., Some((0, &[r])));
    a.tween_tick(&state, &store, 100000., None);
    let previous = a
        .paint_order()
        .into_iter()
        .find(|(id, _, _)| *id == C1)
        .unwrap()
        .1;
    let displayed = a.tweens.display.clone();
    state.items.get_mut(&C1).unwrap().xform[5] = 999.;
    let delta = super::override_tests::full_delta(&state);
    a.prepare(&state, &delta);
    for now in [200000., 300000., 400000.] {
        assert_eq!(
            a.tween_tick(&state, &store, now, None),
            super::overrides::Refresh::Deferred
        );
        assert_eq!(
            a.tweens.display, displayed,
            "undrawn host fields stay invisible"
        );
        assert_eq!(
            a.paint_order()
                .into_iter()
                .find(|(id, _, _)| *id == C1)
                .unwrap()
                .1,
            previous
        );
    }
    // No reanchor: the old clock still includes all elapsed payload-wait time.
    // A real draw below then reanchors at the newer host time.
    let r = record(vec![]);
    a.tween_tick(&state, &store, 500000., Some((600000, &[r])));
    a.apply(&state, &delta, &store);
    let resumed = a
        .paint_order()
        .into_iter()
        .find(|(id, _, _)| *id == C1)
        .unwrap()
        .1;
    assert!((resumed[4] - previous[4] - 50.).abs() < 1e-6);
    assert_ne!(resumed[5], previous[5]);
    a.tween_tick(&state, &store, 600000., None);
    assert!((a.tweens.display[&P].xform[4] - 75.).abs() < 1e-6);
}

#[test]
fn network_stall_extrapolates_and_handover_uses_exact_host_matrix() {
    let mut state = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&state, &super::override_tests::full_delta(&state), &store);
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1000000,
    ))]);
    a.tween_tick(&state, &store, 0., Some((0, &[r])));
    a.tween_tick(&state, &store, 900000., None);
    assert_eq!(a.tweens.display[&P].xform[4], 95.);
    let before = a
        .paint_order()
        .into_iter()
        .find(|(id, _, _)| *id == C1)
        .unwrap()
        .1;
    a.tween_tick(&state, &store, 1000000., None);
    assert!(!a.tweens.active());
    let after = a
        .paint_order()
        .into_iter()
        .find(|(id, _, _)| *id == C1)
        .unwrap()
        .1;
    assert_eq!(
        before[4] - after[4],
        90.,
        "handover residual snap measured in presentation px"
    );
    assert_eq!(
        a.tween_tick(&state, &store, 2000000., None),
        super::overrides::Refresh::Clean
    );
    state.items.get_mut(&P).unwrap().xform = [1.234, 0.1, 0.2, 0.87, 5., 7.];
    a.apply(&state, &super::override_tests::full_delta(&state), &store);
    assert_eq!(
        a.display_local(P, &state.items[&P]).xform,
        state.items[&P].xform
    );
}

#[test]
fn implicit_from_observes_replaced_owner_and_schedule_order() {
    let s = base();
    let mut p = Playback::default();
    p.picture(
        0,
        0.,
        &[record(vec![Event::Begin(begin(
            1,
            1,
            "position:x",
            vec![105.],
            0,
            1000000,
        ))])],
        &s,
    );
    p.sample(500000., &s);
    assert_eq!(p.display[&P].xform[4], 55.);
    let mut replacement = begin(2, 2, "position:x", vec![155.], 0, 1000000);
    replacement.begin = 500000;
    replacement.end = 1500000;
    p.picture(
        500000,
        500000.,
        &[record(vec![Event::Begin(replacement)])],
        &s,
    );
    assert_eq!(
        p.display[&P].xform[4], 55.,
        "first replacement draw has no implicit-from snap"
    );
    p.sample(1000000., &s);
    assert_eq!(p.display[&P].xform[4], 105.);
    // The array is intentionally not in schedule order. At 250 ms the later-start winner
    // must capture the prior schedule winner's endpoint, regardless of original index.
    let mut b = begin(3, 3, "position:x", vec![25.], 200000, 100000);
    b.steps.push(Step {
        components: vec![0],
        start: 0,
        duration: 100000,
        trans: 0,
        ease: 0,
        from: None,
        to: vec![15.],
    });
    let mut q = Playback::default();
    q.picture(250000, 0., &[record(vec![Event::Begin(b)])], &s);
    assert_eq!(q.display[&P].xform[4], 20.);
}

#[test]
fn colors_hold_only_claimed_channels_and_cancel_hands_over_exactly() {
    let mut s = base();
    let mut p = Playback::default();
    let mut b = begin(1, 1, "modulate:a", vec![0.], 0, 1000000);
    b.steps.push(Step {
        components: vec![12],
        start: 0,
        duration: 1000000,
        trans: 0,
        ease: 0,
        from: None,
        to: vec![0.],
    });
    p.picture(0, 0., &[record(vec![Event::Begin(b)])], &s);
    s.items.get_mut(&P).unwrap().modulate = [0.2, 0.3, 0.4, 0.9];
    s.items.get_mut(&P).unwrap().self_modulate = [0.8, 0.7, 0.6, 0.5];
    let mut r = record(vec![]);
    r.poses[0].values[8..12].copy_from_slice(&[0.2, 0.3, 0.4, 0.9]);
    r.poses[0].values[12..16].copy_from_slice(&[0.8, 0.7, 0.6, 0.5]);
    p.picture(500000, 500000., &[r], &s);
    assert_eq!(p.display[&P].modulate, [0.2, 0.3, 0.4, 0.5]);
    assert_eq!(p.display[&P].self_modulate, [0.5, 0.7, 0.6, 0.5]);
    p.picture(600000, 600000., &[record(vec![Event::Cancel(1)])], &s);
    assert!(!p.active());
    assert!(!p.display.contains_key(&P));
}

#[test]
fn displayed_base_and_drawn_hits_include_tween_but_host_queries_do_not() {
    let s = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &super::override_tests::full_delta(&s), &store);
    let host = a.query_item(&s, C1).unwrap().xform.unwrap();
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1000000,
    ))]);
    a.tween_tick(&s, &store, 0., Some((0, &[r])));
    a.tween_tick(&s, &store, 500000., None);
    let display = a.query_display_transform(&s, C1).unwrap();
    assert_eq!(display[4], host[4] + 50.);
    assert_eq!(a.query_item(&s, C1).unwrap().xform, Some(host));
    assert_eq!(a.hit_test(display[4] + 1., display[5] + 1.), Some(C1));
    a.set_hit_filters(&[C1], &[super::overrides::HIT_INPUT])
        .unwrap();
    assert_eq!(a.pick_tree(&s, display[4] + 1., display[5] + 1.), Some(C1));
    assert_eq!(a.pick_tree(&s, host[4] + 1., host[5] + 1.), None);
}

fn reframe(bytes: &[u8], update: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    let f = crate::wire::frame(bytes, 0).unwrap();
    let mut j: serde_json::Value = serde_json::from_slice(f.meta).unwrap();
    update(&mut j);
    let json = serde_json::to_vec(&j).unwrap();
    let mut out = vec![];
    crate::predict::make_record(&mut out, &[&json], &bytes[8 + f.meta.len()..]);
    out
}
fn wire_fixture() -> Vec<u8> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-17");
    let data = std::fs::read(root.join("full.rs17")).unwrap();
    let mut out = crate::wire::magic(17).to_vec();
    let mut input = vec![];
    let mut output = vec![];
    for span in crate::wire::split_records(&data, 17).unwrap() {
        let bytes = span.bytes(&data);
        let f = crate::wire::frame(bytes, 0).unwrap();
        let j: serde_json::Value = serde_json::from_slice(f.meta).unwrap();
        let at = out.len();
        match j["type"].as_str().unwrap() {
            "session" => {
                let m = std::str::from_utf8(f.meta)
                    .unwrap()
                    .replace(",\"blocks\":", ",\"client_tweens\":true,\"blocks\":");
                crate::predict::make_record(&mut out, &[m.as_bytes()], &bytes[8 + f.meta.len()..]);
            }
            "transaction" => {
                let seq = j["seq"].as_i64().unwrap();
                let frame = j["frame"].as_i64().unwrap();
                let time = 101000 + seq * 1000;
                let template = if seq == 1 {
                    "begin.record"
                } else {
                    "poses.record"
                };
                let tween = reframe(&std::fs::read(root.join(template)).unwrap(), |m| {
                    m["seq"] = seq.into();
                    m["frame"] = frame.into();
                    m["t_us"] = time.into();
                    for e in m["events"].as_array_mut().unwrap() {
                        if e["op"] == "begin" {
                            e["item"] = 1.into();
                        }
                    }
                    m["poses"][0]["item"] = 1.into();
                });
                out.extend_from_slice(&tween);
                input.push(0);
                output.push(tween.len());
                let m = std::str::from_utf8(f.meta).unwrap().replacen(
                    ",\"encoding\":",
                    &format!(",\"t_us\":{time},\"encoding\":"),
                    1,
                );
                crate::predict::make_record(&mut out, &[m.as_bytes()], &bytes[8 + f.meta.len()..]);
                input.push(bytes.len());
                output.push(out.len() - at - tween.len());
                continue;
            }
            "end" => crate::predict::fix_end(bytes, &output, &input, &mut out),
            _ => out.extend_from_slice(bytes),
        }
        input.push(bytes.len());
        output.push(out.len() - at);
    }
    out
}
#[test]
fn granted_recording_validation_decoding_and_transcode_preserve_host_bytes() {
    use crate::{
        canon,
        validate::{validate_recording, Options},
        wire,
    };
    let data = wire_fixture();
    validate_recording(&data, Options::new(17)).unwrap();
    let decoded = canon::decoded_recording(&data, 17).unwrap();
    assert_eq!(decoded["schema"], "render-stream-17-decoded/1");
    let down = to16(&data).unwrap();
    validate_recording(&down, Options::new(16)).unwrap();
    let original = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-16/full.rs16"),
    )
    .unwrap();
    assert_eq!(
        down, original,
        "stripped stream is byte identical, including end statistics"
    );
    let pure = crate::item_meta::restamp(&original, 16, 17).unwrap();
    assert_eq!(
        to16(&pure).unwrap(),
        original,
        "opted-out records keep their bytes"
    );
    assert_eq!(wire::version_of_magic(&data), Some(17));
}
#[test]
fn v18_preserves_v17_granted_tween_records() {
    use crate::{
        canon,
        validate::{validate_recording, Options},
        wire,
    };
    let data = wire_fixture();
    let widened = crate::item_meta::restamp(&data, 17, 18).unwrap();
    validate_recording(&widened, Options::new(18)).unwrap();
    let decoded = canon::decoded_recording(&widened, 18).unwrap();
    assert_eq!(decoded["schema"], "render-stream-18-decoded/1");
    let before = wire::split_records(&data, 17).unwrap();
    let after = wire::split_records(&widened, 18).unwrap();
    assert_eq!(before.len(), after.len());
    for (a, b) in before.iter().zip(after.iter()).skip(1) {
        assert_eq!(a.bytes(&data), b.bytes(&widened));
    }
}
#[test]
fn golden_invalid_records_report_spec_errors_and_association_is_atomic() {
    use crate::{
        validate::{Accepted, Options, Validator},
        wire,
    };
    let data = wire_fixture();
    let spans = wire::split_records(&data, 17).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-17");
    let index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("index.json")).unwrap()).unwrap();
    for entry in index["invalid"].as_array().unwrap() {
        let name = entry["file"].as_str().unwrap();
        let bytes = std::fs::read(root.join(name)).unwrap();
        let bytes = reframe(&bytes, |m| {
            m["seq"] = 1.into();
            m["frame"] = if name.contains("mismatch-frame") {
                2.into()
            } else {
                1.into()
            };
            m["t_us"] = 102000.into();
            for e in m["events"].as_array_mut().unwrap() {
                if e["op"] == "begin" {
                    e["item"] = 1.into();
                }
            }
            for p in m["poses"].as_array_mut().unwrap() {
                p["item"] = 1.into();
            }
        });
        let mut v = Validator::new(spans[0].bytes(&data), 0, Options::new(17)).unwrap();
        let result = v.accept(&bytes, 0).and_then(|kind| {
            assert_eq!(kind, Accepted::Tween);
            v.accept(spans[2].bytes(&data), 0)
        });
        let error = result.unwrap_err();
        assert_eq!(
            error.code,
            entry["error"].as_str().unwrap(),
            "{name}: {error}"
        );
        assert!(
            v.state().items.is_empty(),
            "rejected record cannot expose host state"
        );
    }
}
#[test]
fn grant_timestamp_orphan_active_pose_and_backward_time_validation() {
    use crate::{
        validate::{Options, Validator},
        wire,
    };
    let data = wire_fixture();
    let spans = wire::split_records(&data, 17).unwrap();
    let session = spans[0].bytes(&data);
    let tween = spans[1].bytes(&data);
    let tx = spans[2].bytes(&data);
    let mut v = Validator::new(session, 0, Options::new(17)).unwrap();
    let missing = reframe(tx, |m| {
        m.as_object_mut().unwrap().shift_remove("t_us");
    });
    assert_eq!(v.accept(&missing, 0).unwrap_err().code, "tween-association");
    v.accept(tween, 0).unwrap();
    assert_eq!(v.finish().unwrap_err().code, "tween-association");
    assert_eq!(v.accept(tween, 0).unwrap_err().code, "tween-association");
    v.accept(tx, 0).unwrap();
    assert_eq!(
        v.accept(spans[4].bytes(&data), 0).unwrap_err().code,
        "tween-entry",
        "active item needs per-picture pose"
    );
    let backwards = reframe(spans[4].bytes(&data), |m| m["t_us"] = 1.into());
    assert_eq!(v.accept(&backwards, 0).unwrap_err().code, "tween-time");
    let changed_kind = reframe(spans[3].bytes(&data), |m| {
        m["poses"][0]["kind"] = "control".into()
    });
    v.accept(&changed_kind, 0).unwrap();
    assert_eq!(
        v.accept(spans[4].bytes(&data), 0).unwrap_err().code,
        "tween-entry"
    );
    v.transport_skip();
    assert!(v.tween_record().is_none());
    let unasked = reframe(session, |m| {
        m.as_object_mut().unwrap().shift_remove("client_tweens");
    });
    let mut v = Validator::new(&unasked, 0, Options::new(17)).unwrap();
    assert_eq!(v.accept(tween, 0).unwrap_err().code, "meta-schema");
    assert_eq!(v.accept(tx, 0).unwrap_err().code, "meta-schema");
}

#[test]
fn handover_residual_metrics_and_reset() {
    let s = base();
    let mut p = Playback::default();
    let mut b = begin(1, 1, "rotation", vec![1.], 0, 1000000);
    for (components, to) in [
        (vec![3, 4], vec![2., 2.]),
        (vec![5], vec![0.2]),
        (vec![8, 9, 10, 11], vec![0.5; 4]),
    ] {
        b.steps.push(Step {
            components,
            start: 0,
            duration: 1000000,
            trans: 0,
            ease: 0,
            from: None,
            to,
        });
    }
    p.picture(0, 0., &[record(vec![Event::Begin(b)])], &s);
    p.sample(900000., &s);
    let before = p.display[&P];
    let after = Display::host(&s.items[&P]);
    // C1 draws a 30 x 20 rectangle at (2, 3) below P. Its inherited
    // ancestor is a translation, so these are presentation-space corner deltas.
    let corner_px = [[2., 3.], [32., 3.], [2., 23.], [32., 23.]]
        .into_iter()
        .map(|[x, y]| {
            let a = &before.xform;
            let b = &after.xform;
            let dx = (a[0] - b[0]) * x + (a[2] - b[2]) * y + a[4] - b[4];
            let dy = (a[1] - b[1]) * x + (a[3] - b[3]) * y + a[5] - b[5];
            dx.hypot(dy)
        })
        .fold(0f32, f32::max);
    let rotation_rad = before.xform[1].atan2(before.xform[0]);
    let scale_delta = before.xform[0].hypot(before.xform[1]) - 1.;
    let skew_delta = (-before.xform[2]).atan2(before.xform[3]) - rotation_rad;
    let rgba_delta = before
        .modulate
        .iter()
        .zip(after.modulate)
        .map(|(a, b)| (a - b).abs())
        .fold(0f32, f32::max);
    assert!(corner_px > 1.);
    assert!((rotation_rad - 0.9).abs() < 1e-6);
    assert!((scale_delta - 0.9).abs() < 1e-6);
    assert!((skew_delta - 0.18).abs() < 1e-6);
    assert!((rgba_delta - 0.45).abs() < 1e-6);
    eprintln!("handover residual: {corner_px} px, {rotation_rad} rad, scale {scale_delta}, skew {skew_delta} rad, RGBA {rgba_delta}");
    p.sample(1000000., &s);
    assert!(p.display.is_empty());
    assert!(!p.active());
    p.clear();
    assert_eq!(p.counts(), (0, 0));
    assert_eq!(p.diagnostics.completed, 0);
}


#[test]
fn regression_delayed_announcements_follow_order_before_begin_time() {
    let s = base();
    let mut first = begin(1, 1, "position:x", vec![105.], 0, 10_000_000);
    first.begin = 200_000;
    first.end += first.begin;
    let mut delayed = begin(2, 2, "position:y", vec![100.], 0, 10_000_000);
    delayed.begin = 100_000;
    delayed.end += delayed.begin;
    let r1 = record(vec![Event::Begin(first.clone())]);
    let r2 = record(vec![Event::Begin(delayed.clone())]);
    let registry = Registry::default()
        .transaction(200_000, Some(&r1), &s)
        .unwrap();
    registry.transaction(300_000, Some(&r2), &s).unwrap();
    Registry::default()
        .transaction(
            300_000,
            Some(&record(vec![
                Event::Begin(first),
                Event::Begin(delayed.clone()),
            ])),
            &s,
        )
        .unwrap();
    // Ties in order are resolved by begin_us; the identical pair is still invalid.
    delayed.id = 3;
    delayed.order = 1;
    delayed.begin = 250_000;
    delayed.end = 10_250_000;
    let tied = record(vec![Event::Begin(delayed.clone())]);
    let registry = registry.transaction(300_000, Some(&tied), &s).unwrap();
    delayed.id = 4;
    assert!(registry
        .transaction(300_000, Some(&record(vec![Event::Begin(delayed)])), &s)
        .is_err());
}

#[test]
fn regression_delayed_implicit_from_uses_first_crossing_picture() {
    let mut s = base();
    s.items.get_mut(&P).unwrap().xform[4] = 0.;
    let mut p = Playback::default();
    let mut r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![100.],
        100_000,
        1_000_000,
    ))]);
    r.poses[0].values[0] = 0.;
    p.picture(0, 0., &[r], &s);
    let mut next = record(vec![]);
    next.poses[0].values[0] = 20.;
    s.items.get_mut(&P).unwrap().xform[4] = 20.;
    p.picture(200_000, 200_000., &[next], &s);
    assert!((p.display[&P].xform[4] - 28.).abs() < 1e-4);
    p.sample(600_000., &s);
    assert!((p.display[&P].xform[4] - 60.).abs() < 1e-4);
}

#[test]
fn regression_frozen_still_applies_bypasses_frozen_and_tween_display() {
    for force_walk in [false, true] {
        for sabotage in [false, true] {
            let mut s = base();
            let store = PayloadStore::default();
            let mut a = applier();
            a.always_walk = force_walk;
            a.apply(&s, &super::override_tests::full_delta(&s), &store);
            let mut color = begin(
                2,
                2,
                "self_modulate",
                vec![0.5, 0.5, 0.5, 0.5],
                0,
                1_000_000,
            );
            color.item = C1;
            let mut r = record(vec![
                Event::Begin(begin(1, 1, "position:x", vec![105.], 0, 1_000_000)),
                Event::Begin(color),
            ]);
            let mut child_pose = pose();
            child_pose.item = C1;
            child_pose.values[0] = 2.;
            child_pose.values[1] = 3.;
            r.poses.push(child_pose);
            a.tween_tick(&s, &store, 0., Some((0, &[r])));
            a.tween_tick(&s, &store, 100_000., None);
            assert_eq!(a.tweens.display[&P].xform[4], 15.);
            assert_eq!(a.tweens.display[&C1].self_modulate, [0.95; 4]);
            let frozen = [
                1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 1., 0., 0., 0., 0.,
            ];
            a.set_overrides(&[P], &frozen).unwrap();
            a.apply(&s, &TxDelta::default(), &store);
            assert!(a.frozen_display.contains_key(&P));
            let held = a.paint_digest();

            a.ov_sabotage.frozen_still_applies = sabotage;
            let item = s.items.get_mut(&P).unwrap();
            item.xform[4] = 65.;
            item.modulate = [0.25, 0.5, 0.75, 1.];
            // P has no drawing commands; also change its drawn child's self-modulate.
            s.items.get_mut(&C1).unwrap().self_modulate = [0.5, 0.25, 1., 0.75];
            a.apply(
                &s,
                &TxDelta {
                    seq: 2,
                    items_upserted: vec![P, C1],
                    ..TxDelta::default()
                },
                &store,
            );
            let mut host = applier();
            host.apply(&s, &super::override_tests::full_delta(&s), &store);
            assert_ne!(host.paint_digest(), held);
            assert_eq!(
                a.paint_digest(),
                if sabotage { host.paint_digest() } else { held },
                "frozen display: force_walk={force_walk}, frozen_still_applies={sabotage}"
            );
        }
    }
}

#[test]
fn regression_frozen_tween_holds_ticks_and_forced_walk_until_unfreeze() {
    use super::override_tests::Q;
    let s = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &super::override_tests::full_delta(&s), &store);
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1_000_000,
    ))]);
    a.tween_tick(&s, &store, 0., Some((0, &[r])));
    a.tween_tick(&s, &store, 100_000., None);
    let frozen = [
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 1., 0., 0., 0., 0.,
    ];
    a.set_overrides(&[P], &frozen).unwrap();
    a.apply(&s, &TxDelta::default(), &store);
    let held = a.paint_digest();
    for t in [300_000., 600_000., 700_000.] {
        a.tween_tick(&s, &store, t, None);
        assert_eq!(a.paint_digest(), held, "frozen subtree moved on a tick");
    }
    // A clip outset on an unrelated item forces a walk without changing its visible paint.
    let mut both = frozen.to_vec();
    both.extend_from_slice(&[
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 0., 1., 0., 0., 0.,
    ]);
    a.set_overrides(&[P, Q], &both).unwrap();
    assert_eq!(
        a.refresh_overrides(&s, &store),
        super::overrides::Refresh::Walked
    );
    assert_eq!(
        a.paint_digest(),
        held,
        "a forced walk resampled the frozen tween"
    );
    a.set_overrides(&[], &[]).unwrap();
    a.apply(&s, &TxDelta::default(), &store);
    assert_ne!(a.paint_digest(), held);
    assert_eq!(a.display_local(P, &s.items[&P]).xform[4], 75.);
}

#[test]
fn regression_frozen_tween_after_supersession_rebuild() {
    use super::override_tests::Q;
    let s = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &super::override_tests::full_delta(&s), &store);
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1_000_000,
    ))]);
    a.tween_tick(&s, &store, 0., Some((0, &[r])));
    a.tween_tick(&s, &store, 100_000., None);
    let frozen = [
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 1., 0., 0., 0., 0.,
    ];
    a.set_overrides(&[P], &frozen).unwrap();
    a.apply(&s, &TxDelta::default(), &store);
    let held = a.paint_digest();
    assert_eq!(a.display_local(P, &s.items[&P]).xform[4], 15.);
    // Supersession preserves the frozen display as well as the live playback.
    let mut b = applier();
    b.inherit_overrides(&mut a);
    b.tweens = std::mem::take(&mut a.tweens);
    b.apply(&s, &super::override_tests::full_delta(&s), &store);
    assert_eq!(b.paint_digest(), held, "frozen pose changed at rebuild");
    b.tween_tick(&s, &store, 600_000., None);
    assert_eq!(b.paint_digest(), held, "frozen pose changed on a tick");
    // A clip outset on an unrelated item forces a walk without changing its paint.
    let mut both = frozen.to_vec();
    both.extend_from_slice(&[
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 0., 1., 0., 0., 0.,
    ]);
    b.set_overrides(&[P, Q], &both).unwrap();
    assert_eq!(
        b.refresh_overrides(&s, &store),
        super::overrides::Refresh::Walked
    );
    assert_eq!(
        b.paint_digest(),
        held,
        "frozen pose changed on a forced walk"
    );
    assert_eq!(b.display_local(P, &s.items[&P]).xform[4], 15.);
}

#[test]
fn regression_frozen_tween_recaptures_host_after_resync() {
    use super::override_tests::Q;
    let mut s = base();
    let store = PayloadStore::default();
    let mut a = applier();
    a.apply(&s, &super::override_tests::full_delta(&s), &store);
    let r = record(vec![Event::Begin(begin(
        1,
        1,
        "position:x",
        vec![105.],
        0,
        1_000_000,
    ))]);
    a.tween_tick(&s, &store, 0., Some((0, &[r])));
    a.tween_tick(&s, &store, 100_000., None);
    let frozen = [
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 1., 0., 0., 0., 0.,
    ];
    a.set_overrides(&[P], &frozen).unwrap();
    a.apply(&s, &TxDelta::default(), &store);
    assert_eq!(a.display_local(P, &s.items[&P]).xform[4], 15.);
    // transport_skip resets playback before accepting the full transaction.
    a.reset_tweens_for_resync();
    s.items.get_mut(&P).unwrap().xform[4] = 25.;
    let mut b = applier();
    b.inherit_overrides(&mut a);
    b.tweens = std::mem::take(&mut a.tweens);
    b.apply(&s, &super::override_tests::full_delta(&s), &store);
    assert!(!b.tweens.active());
    assert_eq!(b.display_local(P, &s.items[&P]).xform[4], 25.);
    let held = b.paint_digest();
    // A new timeline after resync cannot replace the recaptured frozen pose.
    let r = record(vec![Event::Begin(begin(
        2,
        2,
        "position:x",
        vec![105.],
        0,
        1_000_000,
    ))]);
    b.tween_tick(&s, &store, 0., Some((0, &[r])));
    b.tween_tick(&s, &store, 600_000., None);
    let mut both = frozen.to_vec();
    both.extend_from_slice(&[
        1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 0., 1., 0., 0., 0.,
    ]);
    b.set_overrides(&[P, Q], &both).unwrap();
    assert_eq!(
        b.refresh_overrides(&s, &store),
        super::overrides::Refresh::Walked
    );
    assert_eq!(
        b.paint_digest(),
        held,
        "resynced frozen pose changed on a forced walk"
    );
    assert_eq!(b.display_local(P, &s.items[&P]).xform[4], 25.);
}
