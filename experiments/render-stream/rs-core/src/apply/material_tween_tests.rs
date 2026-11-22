//! /19 display behavior with a fake clock and real applier bindings; no GPU required.
use super::{
    override_tests::{applier, base, full_delta, C1, C2, P, Q},
    *,
};
use crate::{
    state::*,
    tweens::{
        material::{self, MaterialStep},
        *,
    },
    validate::{Options, Validator},
    wire,
};
use gsw_canvas_draw_list::UniformValue;

fn fixture() -> ResolvedState {
    let data = include_bytes!("../../../protocol/golden-19/mixed.rs19");
    let spans = wire::split_records(data, 19).unwrap();
    let mut v = Validator::new(spans[0].bytes(data), 8, Options::new(19)).unwrap();
    for span in &spans[1..] {
        v.accept(span.bytes(data), span.offset).unwrap();
    }
    let mut s = base();
    s.materials = v.state().materials.clone();
    s.shaders = v.state().shaders.clone();
    s.items.get_mut(&P).unwrap().material = Some(1);
    for id in [C1, C2] {
        s.items.get_mut(&id).unwrap().use_parent_material = true;
    }
    let mut unrelated = s.materials[&1].clone();
    unrelated.id = 2;
    s.materials.insert(2, unrelated);
    s.items.get_mut(&Q).unwrap().material = Some(2);
    s
}
fn ms(
    param: &str,
    ty: VariantType,
    components: Vec<usize>,
    to: Vec<f32>,
    start: i64,
    duration: i64,
) -> MaterialStep {
    MaterialStep {
        param: param.into(),
        ty,
        value: Step {
            components,
            start,
            duration,
            trans: 0,
            ease: 0,
            from: None,
            to,
        },
    }
}
fn mb(id: i64, order: i64, steps: Vec<MaterialStep>) -> material::Begin {
    material::Begin {
        id,
        material: 1,
        order,
        begin: 0,
        end: steps
            .iter()
            .map(|s| s.value.start + s.value.duration)
            .max()
            .unwrap(),
        steps,
    }
}
fn rec(events: Vec<Event>) -> Record {
    Record {
        seq: 1,
        frame: 1,
        time: 0,
        events,
        poses: vec![],
    }
}
fn scalar() -> material::Begin {
    mb(
        1,
        1,
        vec![ms(
            "threshold",
            VariantType::Float,
            vec![0],
            vec![0.],
            0,
            1_000_000,
        )],
    )
}
fn param_mut<'a>(s: &'a mut ResolvedState, name: &str) -> &'a mut Param {
    s.materials
        .get_mut(&1)
        .unwrap()
        .params
        .iter_mut()
        .find(|p| &*p.name == name)
        .unwrap()
}
fn value(p: &Playback, s: &ResolvedState, name: &str) -> ParamValue {
    let host = s.materials[&1]
        .params
        .iter()
        .find(|p| &*p.name == name)
        .unwrap();
    p.materials
        .effective(1, host)
        .unwrap_or_else(|| host.clone())
        .value
}
fn ready(a: &mut Applier, s: &ResolvedState) {
    let hash = s.shaders[&1].hash.unwrap();
    a.set_program(hash, ProgramEntry::Ready(ProgramInfo {
        program:7, blend:BlendMode::Mix, light:LightMode::Normal,
        uniforms: vec![programs::UniformDecl { name:"threshold".into(),kind:programs::UniformKind::Float,
            components:1,array:None,instance:false,unset:vec![0.] }],
        samplers:vec![],screen:None,vertex:false,time:false,alpha:None,
    }.with_code("shader_type canvas_item; uniform float threshold; void fragment(){COLOR.a = threshold;}")));
}
fn uniform(a: &Applier, material: Id) -> f32 {
    let slot = a
        .binding_keys
        .iter()
        .position(|key| key.is_some_and(|k| k.material == material))
        .unwrap();
    let UniformValue::Float(v) = &a.list.bindings[slot].uniforms[0].value else {
        panic!()
    };
    v[0]
}
#[test]
fn material_goldens_cover_atomic_validation_and_prefix_transcode() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol");
    let read = |name: &str| std::fs::read(root.join(name)).ok();
    let checks = crate::goldens::run_golden(19, &read, Default::default());
    let bad: Vec<_> = checks
        .iter()
        .filter(|c| !c.ok)
        .map(|c| format!("{}: {}", c.name, c.detail))
        .collect();
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
#[test]
fn material_all_arities_components_and_host_precision_handover() {
    for (name, ty, n) in [
        ("threshold", VariantType::Float, 1),
        ("offset", VariantType::Vector2, 2),
        ("v3", VariantType::Vector3, 3),
        ("v4", VariantType::Vector4, 4),
        ("tint", VariantType::Color, 4),
    ] {
        for component in 0..=n {
            if n == 1 && component < n {
                continue;
            }
            let s = fixture();
            let host = s.materials[&1]
                .params
                .iter()
                .find(|p| &*p.name == name)
                .unwrap();
            let values = material::numbers(host, ty).unwrap();
            let components: Vec<_> = if component == n {
                (0..n).collect()
            } else {
                vec![component]
            };
            let to = components.iter().map(|&c| values[c] as f32 + 10.).collect();
            let mut p = Playback::default();
            p.picture(
                0,
                0.,
                &[rec(vec![Event::MaterialBegin(mb(
                    1,
                    1,
                    vec![ms(name, ty, components.clone(), to, 0, 1_000_000)],
                ))])],
                &s,
            );
            p.sample(500_000., &s);
            let effective = p.materials.effective(1, host).unwrap();
            let got = material::numbers(&effective, ty).unwrap();
            for c in 0..n {
                assert_eq!(
                    got[c],
                    values[c] + if components.contains(&c) { 5. } else { 0. }
                );
            }
            p.sample(999_999., &s);
            let before = material::numbers(&p.materials.effective(1, host).unwrap(), ty)
                .unwrap()
                .to_vec();
            p.sample(1_000_000., &s);
            assert!(!p.active());
            assert!(p.materials.display.is_empty());
            assert_eq!(value(&p, &s, name), host.value);
            for c in components {
                eprintln!(
                    "handover {name}[{c}]: {} shader-parameter units",
                    values[c] - before[c]
                );
            }
        }
    }
}
#[test]
fn material_chained_delayed_parallel_implicit_zero_and_gap() {
    let mut s = fixture();
    let mut p = Playback::default();
    let b = mb(
        1,
        1,
        vec![
            ms(
                "offset",
                VariantType::Vector2,
                vec![0],
                vec![11.],
                100_000,
                100_000,
            ),
            ms(
                "offset",
                VariantType::Vector2,
                vec![0],
                vec![21.],
                300_000,
                100_000,
            ),
            ms(
                "offset",
                VariantType::Vector2,
                vec![1],
                vec![52.],
                350_000,
                0,
            ),
            ms(
                "threshold",
                VariantType::Float,
                vec![0],
                vec![0.],
                0,
                500_000,
            ),
        ],
    );
    p.picture(0, 0., &[rec(vec![Event::MaterialBegin(b)])], &s);
    param_mut(&mut s, "offset").value = ParamValue::Flat(vec![3., 4.]);
    p.picture(50_000, 50_000., &[], &s);
    assert_eq!(value(&p, &s, "offset"), ParamValue::Flat(vec![3., 4.]));
    p.sample(350_000., &s);
    assert_eq!(value(&p, &s, "offset"), ParamValue::Flat(vec![16., 52.]));
    p.sample(500_000., &s);
    assert!(!p.active());
}
#[test]
fn material_partial_claim_replacement_no_resurrection_and_node_namespace() {
    let s = fixture();
    let mut p = Playback::default();
    let whole = mb(
        1,
        1,
        vec![ms(
            "offset",
            VariantType::Vector2,
            vec![0, 1],
            vec![11., 22.],
            0,
            1_000_000,
        )],
    );
    p.picture(0, 0., &[rec(vec![Event::MaterialBegin(whole)])], &s);
    p.sample(500_000., &s);
    let replacement = mb(
        2,
        2,
        vec![ms(
            "offset",
            VariantType::Vector2,
            vec![0],
            vec![100.],
            0,
            1_000_000,
        )],
    );
    p.picture(
        500_000,
        500_000.,
        &[rec(vec![Event::MaterialBegin(replacement)])],
        &s,
    );
    // New implicit from samples 6, the old owner's displayed component.
    assert_eq!(value(&p, &s, "offset"), ParamValue::Flat(vec![53., 12.]));
    assert_eq!(p.diagnostics.claims_replaced, 1);
    p.picture(600_000, 600_000., &[rec(vec![Event::Cancel(2)])], &s);
    let ParamValue::Flat(v) = value(&p, &s, "offset") else {
        panic!()
    };
    assert_eq!(v[0], 1.);
    assert_eq!(v[1], 14.);
    let mut registry = Registry::default();
    registry = registry
        .transaction(0, Some(&rec(vec![Event::MaterialBegin(scalar())])), &s)
        .unwrap();
    assert!(registry
        .transaction(0, Some(&rec(vec![Event::MaterialBegin(scalar())])), &s)
        .is_err());
    let mut reused = scalar();
    reused.order = 3;
    assert!(registry
        .transaction(
            0,
            Some(&rec(vec![Event::Cancel(1), Event::MaterialBegin(reused)])),
            &s
        )
        .is_ok());
}
#[test]
fn material_guard_preserves_claims_through_transient_invalidations_and_cancel_reuse() {
    let mut s = fixture();
    let mut p = Playback::default();
    let mut registry = Registry::default();
    let begin = rec(vec![Event::MaterialBegin(scalar())]);
    registry = registry.transaction(0, Some(&begin), &s).unwrap();
    p.picture(0, 0., &[begin], &s);
    for ty in [VariantType::Int, VariantType::Bool, VariantType::Float] {
        param_mut(&mut s, "threshold").ty = ty;
        registry = registry.transaction(100_000, None, &s).unwrap();
        p.picture(100_000, 100_000., &[], &s);
        assert_eq!(p.materials.live_len(), 1);
        if ty != VariantType::Float {
            assert_eq!(value(&p, &s, "threshold"), ParamValue::Scalar(1.));
        }
    }
    let param = param_mut(&mut s, "threshold").clone();
    s.materials
        .get_mut(&1)
        .unwrap()
        .params
        .retain(|p| &*p.name != "threshold");
    p.picture(200_000, 200_000., &[], &s);
    assert_eq!(p.materials.live_len(), 1);
    assert!(p.materials.display.is_empty());
    s.materials.get_mut(&1).unwrap().params.push(param);
    let mut reused = scalar();
    reused.order = 2;
    let r = rec(vec![Event::Cancel(1), Event::MaterialBegin(reused)]);
    registry.transaction(300_000, Some(&r), &s).unwrap();
    p.picture(300_000, 300_000., &[r], &s);
    assert_eq!(p.materials.live_len(), 1);
    s.materials.remove(&1);
    p.picture(400_000, 400_000., &[], &s);
    assert!(!p.active());
}
#[test]
fn material_bindings_shared_inherited_unrelated_dirty_alpha_and_release() {
    let mut s = fixture();
    let store = PayloadStore::default();
    let mut a = applier();
    ready(&mut a, &s);
    a.apply(&s, &full_delta(&s), &store);
    assert_eq!(uniform(&a, 1), 1.);
    assert_eq!(uniform(&a, 2), 1.);
    a.tween_tick(
        &s,
        &store,
        0.,
        Some((0, &[rec(vec![Event::MaterialBegin(scalar())])])),
    );
    a.list.consumed();
    a.bindings_changed.clear();
    a.tween_tick(&s, &store, 500_000., None);
    assert_eq!(uniform(&a, 1), 0.5);
    assert_eq!(uniform(&a, 2), 1.);
    assert!(a
        .bindings_changed
        .iter()
        .all(|&slot| a.binding_keys[slot as usize].unwrap().material == 1));
    assert!(!a.list.dirty.bindings.is_empty());
    assert_eq!(param_mut(&mut s, "threshold").value, ParamValue::Scalar(1.));
    param_mut(&mut s, "threshold").value = ParamValue::Scalar(0.123456789);
    a.apply(
        &s,
        &TxDelta {
            materials_upserted: vec![1],
            ..TxDelta::default()
        },
        &store,
    );
    assert_eq!(uniform(&a, 1), 0.5);
    a.tween_tick(&s, &store, 1_000_000., None);
    assert_eq!(uniform(&a, 1), 0.123456789_f64 as f32);
    a.list.consumed();
    assert_eq!(
        a.tween_tick(&s, &store, 1_500_000., None),
        overrides::Refresh::Clean
    );
    assert!(a.list.dirty.bindings.is_empty());
}
#[test]
fn material_payload_wait_refusal_and_rebuild_keep_timeline() {
    let mut s = fixture();
    let store = PayloadStore::default();
    let mut a = applier();
    ready(&mut a, &s);
    a.apply(&s, &full_delta(&s), &store);
    a.tween_tick(
        &s,
        &store,
        0.,
        Some((0, &[rec(vec![Event::MaterialBegin(scalar())])])),
    );
    a.tween_tick(&s, &store, 200_000., None);
    let before = uniform(&a, 1);
    param_mut(&mut s, "threshold").value = ParamValue::Scalar(0.123);
    a.prepare(
        &s,
        &TxDelta {
            materials_upserted: vec![1],
            ..TxDelta::default()
        },
    );
    assert_eq!(
        a.tween_tick(&s, &store, 600_000., None),
        overrides::Refresh::Deferred
    );
    assert_eq!(uniform(&a, 1), before);
    let mut b = applier();
    ready(&mut b, &s);
    b.tweens = std::mem::take(&mut a.tweens);
    b.apply(&s, &full_delta(&s), &store);
    b.tween_tick(&s, &store, 700_000., None);
    assert!((uniform(&b, 1) - 0.3).abs() < 1e-6);
    b.set_program(
        s.shaders[&1].hash.unwrap(),
        ProgramEntry::Refused {
            reason: "gsw-shader-transpile",
            detail: "test refusal".into(),
        },
    );
    b.apply(&s, &TxDelta::default(), &store);
    b.tween_tick(&s, &store, 800_000., None);
    assert!(b.tweens.active());
    b.tween_tick(&s, &store, 1_000_000., None);
    assert!(!b.tweens.active());
}

#[test]
fn material_begin_record_decodes_at_19() {
    let data = include_bytes!("../../../protocol/golden-19/material-begin.record");
    crate::meta::decode_record(
        data,
        0,
        19,
        &mut Default::default(),
        &mut Default::default(),
    )
    .unwrap();
}
#[test]
fn material_easing_all_48_pairs_and_backward_anchor_holds() {
    let s = fixture();
    let mut max = 0f64;
    // Existing independent godotEaseSample oracle shared with node playback.
    let oracle: Vec<[f64; 4]> =
        serde_json::from_str(include_str!("../../test/tween-easing.json")).unwrap();
    for trans in 0..12 {
        for ease in 0..4 {
            let mut b = scalar();
            b.steps[0].value.trans = trans;
            b.steps[0].value.ease = ease;
            let mut p = Playback::default();
            p.picture(0, 0., &[rec(vec![Event::MaterialBegin(b)])], &s);
            for &[_, _, t, eased] in oracle
                .iter()
                .filter(|r| r[0] == trans as f64 && r[1] == ease as f64 && r[2] < 1.)
            {
                p.sample(t * 1_000_000., &s);
                let ParamValue::Scalar(got) = value(&p, &s, "threshold") else {
                    panic!()
                };
                let want = 1. - eased;
                max = max.max((got - want).abs());
                assert!((got - want).abs() < 1e-6);
            }
        }
    }
    eprintln!("material easing maximum absolute scalar error: {max} shader-parameter units");
    let mut p = Playback::default();
    p.picture(0, 0., &[rec(vec![Event::MaterialBegin(scalar())])], &s);
    p.sample(500_000., &s);
    p.picture(400_000, 500_000., &[], &s);
    p.sample(550_000., &s);
    assert_eq!(value(&p, &s, "threshold"), ParamValue::Scalar(0.5));
    assert_eq!(p.diagnostics.backward_anchor_holds, 1);
}
#[test]
fn material_claims_and_node_claims_have_separate_targets_but_shared_ids() {
    let mut s = fixture();
    let mut m = s.materials[&1].clone();
    m.id = P;
    s.materials.insert(P, m);
    let mut material = scalar();
    material.material = P;
    let node = Begin {
        id: 2,
        item: P,
        order: 2,
        begin: 0,
        end: 1_000_000,
        steps: vec![Step {
            components: vec![0],
            start: 0,
            duration: 1_000_000,
            trans: 0,
            ease: 0,
            from: None,
            to: vec![105.],
        }],
    };
    let mut r = rec(vec![Event::MaterialBegin(material), Event::Begin(node)]);
    r.poses.push(Pose {
        item: P,
        kind: Kind::Node2d,
        values: [
            5., 0., 0., 1., 1., 0., 0., 0., 1., 1., 1., 1., 1., 1., 1., 1.,
        ],
    });
    Registry::default().transaction(0, Some(&r), &s).unwrap();
    let mut p = Playback::default();
    p.picture(0, 0., &[r.clone()], &s);
    p.sample(500_000., &s);
    assert_eq!(p.counts(), (2, 2));
    assert_eq!(p.display[&P].xform[4], 55.);
    assert_eq!(p.materials.display[&P]["threshold"].components, [Some(0.5)]);
    let Event::Begin(node) = &mut r.events[1] else {
        panic!()
    };
    node.id = 1;
    assert_eq!(
        Registry::default()
            .transaction(0, Some(&r), &s)
            .err()
            .unwrap()
            .code,
        "tween-entry"
    );
}

#[test]
fn material_viewport_tick_updates_shared_binding_and_alpha_damage() {
    let mut s = super::surface_tests::scene();
    let material = fixture();
    s.materials = material.materials;
    s.shaders = material.shaders;
    s.items.get_mut(&10).unwrap().material = Some(2);
    s.items.get_mut(&20).unwrap().material = Some(1);
    let mut a = applier();
    ready(&mut a, &s);
    let mut store = PayloadStore::default();
    store.shaders.insert(
        s.shaders[&1].hash.unwrap(),
        "shader_type canvas_item; uniform float threshold; void fragment(){COLOR.a = threshold;}"
            .into(),
    );
    a.apply(&s, &full_delta(&s), &store);
    let b = mb(
        1,
        1,
        vec![
            ms(
                "threshold",
                VariantType::Float,
                vec![0],
                vec![0.],
                0,
                500_000,
            ),
            ms(
                "offset",
                VariantType::Vector2,
                vec![0],
                vec![3.],
                0,
                1_000_000,
            ),
        ],
    );
    a.tween_tick(
        &s,
        &store,
        0.,
        Some((0, &[rec(vec![Event::MaterialBegin(b)])])),
    );
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    a.tween_tick(&s, &store, 250_000., None);
    let pass = a.surfaces.as_ref().unwrap().applier(5).unwrap();
    assert_eq!(uniform(pass, 1), 0.5);
    assert!(!pass.list.dirty.bindings.is_empty());
    a.list.consumed();
    a.surfaces.as_mut().unwrap().consumed();
    a.tween_tick(&s, &store, 500_000., None);
    let pass = a.surfaces.as_ref().unwrap().applier(5).unwrap();
    assert_eq!(uniform(pass, 1), 0.);
    assert!(pass.cover.alpha_zero.iter().any(|v| *v));
    assert!(pass.list.dirty.draws, "alpha no-op changes surface draws");
    assert_eq!(
        uniform(&a, 2),
        1.,
        "unrelated root material stays unchanged"
    );
    a.tween_tick(&s, &store, 1_000_000., None);
    assert_eq!(
        uniform(a.surfaces.as_ref().unwrap().applier(5).unwrap(), 1),
        1.
    );
}

fn raw(record: &[u8]) -> (serde_json::Value, Vec<u8>) {
    let f = wire::frame(record, 0).unwrap();
    (
        serde_json::from_slice(f.meta).unwrap(),
        record[f.body..].to_vec(),
    )
}
fn encoded(meta: &serde_json::Value, body: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    crate::predict::make_record(&mut out, &[&serde_json::to_vec(meta).unwrap()], body);
    out
}
#[test]
fn material_validation_order_and_atomic_rollback() {
    let source = include_bytes!("../../../protocol/golden-19/mixed.rs19");
    let spans = wire::split_records(source, 19).unwrap();
    let (mut meta, body) = raw(spans[1].bytes(source));
    meta["events"][0]["steps"][0]["to"] = 999.into();
    meta["events"][1]["steps"][0]["property"] = "unknown".into();
    assert_eq!(
        crate::tweens::decode_version(&encoded(&meta, &body), 0, 19, &mut Default::default())
            .unwrap_err()
            .code,
        "meta-schema"
    );
    meta["events"][1]["steps"][0]["property"] = "position".into();
    for (seq, want) in [(2, "tween-association"), (1, "tween-offset")] {
        meta["seq"] = seq.into();
        let mut v = Validator::new(spans[0].bytes(source), 8, Options::new(19)).unwrap();
        v.accept(&encoded(&meta, &body), 0).unwrap();
        assert_eq!(
            v.accept(spans[2].bytes(source), spans[2].offset)
                .unwrap_err()
                .code,
            want
        );
        assert_eq!(v.state().seq, 0, "invalid associated picture cannot commit");
        let mut bad = wire::magic(19).to_vec();
        bad.extend_from_slice(spans[0].bytes(source));
        bad.extend_from_slice(&encoded(&meta, &body));
        for span in &spans[2..] {
            bad.extend_from_slice(span.bytes(source));
        }
        assert_eq!(crate::tweens::to18_from19(&bad).unwrap_err().code, want);
    }
}
#[test]
fn material_transcode_drops_cancels_empty_records_and_handles_id_reuse() {
    let source = include_bytes!("../../../protocol/golden-19/invalidation-cancel.rs19");
    let down = crate::tweens::to18_from19(source).unwrap();
    crate::validate::validate_recording(&down, Options::new(18)).unwrap();
    assert_eq!(
        wire::split_records(&down, 18).unwrap().len(),
        4,
        "both material records disappear"
    );
    let source = include_bytes!("../../../protocol/golden-19/mixed.rs19");
    let spans = wire::split_records(source, 19).unwrap();
    // Make the material record the largest input record, so dropping it must also
    // recompute max_record_bytes rather than only subtracting bytes_total.
    let (mut first, _) = raw(include_bytes!(
        "../../../protocol/golden-19/material-begin.record"
    ));
    let step = first["events"][0]["steps"][0].clone();
    let mut steps = vec![];
    let mut floats = vec![];
    for i in 0..100 {
        let mut step = step.clone();
        step["from"] = (2 * i).into();
        step["to"] = (2 * i + 1).into();
        steps.push(step);
        floats.extend_from_slice(&1f32.to_le_bytes());
        floats.extend_from_slice(&0f32.to_le_bytes());
    }
    first["events"][0]["steps"] = steps.into();
    first["blocks"][0]["count"] = 200.into();
    let mut first_body = 1u32.to_le_bytes().to_vec();
    first_body.extend_from_slice(&(floats.len() as u32).to_le_bytes());
    first_body.extend(floats);
    let mut records = vec![
        spans[0].bytes(source).to_vec(),
        encoded(&first, &first_body),
        spans[2].bytes(source).to_vec(),
    ];
    assert!(records[1].len() > records[2].len());
    let (mut meta, mut body) = raw(spans[1].bytes(source));
    let node = &mut meta["events"][1];
    node["tween_id"] = "7001".into();
    node["begin_us"] = 500_000.into();
    node["end_us"] = 1_500_000.into();
    let node = node.clone();
    meta["events"] = serde_json::json!([{"op":"cancel","tween_id":"7001"},node]);
    meta["seq"] = 2.into();
    meta["frame"] = 2.into();
    meta["t_us"] = 500_000.into();
    meta["blocks"][0]["count"] = 18.into();
    body.truncate(8 + 18 * 4);
    body[4..8].copy_from_slice(&(18u32 * 4).to_le_bytes());
    records.push(encoded(&meta, &body));
    let (mut tx, body) = raw(spans[2].bytes(source));
    tx["seq"] = 2.into();
    tx["frame"] = 2.into();
    tx["t_us"] = 500_000.into();
    records.push(encoded(&tx, &body));
    let mut data = wire::magic(19).to_vec();
    let lens: Vec<_> = records.iter().map(Vec::len).collect();
    for r in records {
        data.extend(r);
    }
    let (mut end, endbody) = raw(spans.last().unwrap().bytes(source));
    end["transactions"] = 2.into();
    end["stats"]["full_transactions"] = 2.into();
    end["stats"]["bytes_total"] = (8 + lens.iter().sum::<usize>()).into();
    end["stats"]["max_record_bytes"] = (*lens.iter().max().unwrap()).into();
    data.extend(encoded(&end, &endbody));
    crate::validate::validate_recording(&data, Options::new(19)).unwrap();
    let down = crate::tweens::to18_from19(&data).unwrap();
    crate::validate::validate_recording(&down, Options::new(18)).unwrap();
    let spans = wire::split_records(&down, 18).unwrap();
    let (end, _) = raw(spans.last().unwrap().bytes(&down));
    let output_bytes = 8 + spans[..spans.len() - 1]
        .iter()
        .map(|s| s.byte_length)
        .sum::<usize>();
    assert_eq!(end["stats"]["bytes_total"], output_bytes);
    assert!(output_bytes < 8 + lens.iter().sum::<usize>());
    let output_max = spans[..spans.len() - 1]
        .iter()
        .map(|s| s.byte_length)
        .max()
        .unwrap();
    assert_eq!(end["stats"]["max_record_bytes"], output_max);
    assert!(output_max < *lens.iter().max().unwrap());
    let (meta, _) = raw(spans[2].bytes(&down));
    assert_eq!(
        meta["events"].as_array().unwrap().len(),
        1,
        "material cancel removed before node ID reuse"
    );
    assert_eq!(meta["events"][0]["item"], 1);
    assert_eq!(meta["events"][0]["tween_id"], "7001");
}

#[test]
fn material_unowned_components_keep_host_f64_precision_and_root_alpha_damage() {
    let mut s = fixture();
    let mut p = Playback::default();
    p.picture(
        0,
        0.,
        &[rec(vec![Event::MaterialBegin(mb(
            1,
            1,
            vec![ms(
                "offset",
                VariantType::Vector2,
                vec![0],
                vec![11.],
                0,
                1_000_000,
            )],
        ))])],
        &s,
    );
    param_mut(&mut s, "offset").value = ParamValue::Flat(vec![0.123456789, 0.987654321]);
    p.picture(500_000, 500_000., &[], &s);
    assert_eq!(
        value(&p, &s, "offset"),
        ParamValue::Flat(vec![6., 0.987654321])
    );
    let mut store = PayloadStore::default();
    store.shaders.insert(
        s.shaders[&1].hash.unwrap(),
        "shader_type canvas_item; uniform float threshold; void fragment(){COLOR.a = threshold;}"
            .into(),
    );
    let mut a = applier();
    ready(&mut a, &s);
    a.apply(&s, &full_delta(&s), &store);
    let b = mb(
        1,
        1,
        vec![
            ms(
                "threshold",
                VariantType::Float,
                vec![0],
                vec![0.],
                0,
                500_000,
            ),
            ms(
                "offset",
                VariantType::Vector2,
                vec![0],
                vec![3.],
                0,
                1_000_000,
            ),
        ],
    );
    a.tween_tick(
        &s,
        &store,
        0.,
        Some((0, &[rec(vec![Event::MaterialBegin(b)])])),
    );
    a.list.consumed();
    a.tween_tick(&s, &store, 500_000., None);
    let slot = a
        .binding_keys
        .iter()
        .position(|k| k.is_some_and(|k| k.material == 1))
        .unwrap();
    assert!(a.cover.alpha_zero[slot]);
    assert!(a.list.dirty.draws);
    assert_eq!(uniform(&a, 2), 1.);
}

#[test]
fn material_begin_on_patch_uses_retained_unchanged_material_baseline() {
    let source = include_bytes!("../../../protocol/golden-19/mixed.rs19");
    let spans = wire::split_records(source, 19).unwrap();
    let mut v = Validator::new(spans[0].bytes(source), 8, Options::new(19)).unwrap();
    v.accept(spans[2].bytes(source), spans[2].offset).unwrap();
    let (mut tween, body) = raw(include_bytes!(
        "../../../protocol/golden-19/material-begin.record"
    ));
    tween["seq"] = 2.into();
    tween["frame"] = 2.into();
    tween["t_us"] = 500_000.into();
    tween["events"][0]["begin_us"] = 500_000.into();
    tween["events"][0]["end_us"] = 1_500_000.into();
    v.accept(&encoded(&tween, &body), 0).unwrap();
    let (mut tx, body) = raw(spans[2].bytes(source));
    tx["seq"] = 2.into();
    tx["frame"] = 2.into();
    tx["t_us"] = 500_000.into();
    tx["encoding"] = "patch".into();
    tx["base_seq"] = 1.into();
    tx["materials"] = serde_json::json!([]);
    tx["shaders"] = serde_json::json!([]);
    tx["blocks"][5]["count"] = 0.into();
    let mut blocks = vec![];
    let mut at = 4;
    for _ in 0..wire::le_u32(&body, 0) {
        let n = wire::le_u32(&body, at) as usize;
        at += 4;
        blocks.push(body[at..at + n].to_vec());
        at += n;
    }
    blocks[5].clear();
    let mut body = (blocks.len() as u32).to_le_bytes().to_vec();
    for block in blocks {
        body.extend_from_slice(&(block.len() as u32).to_le_bytes());
        body.extend(block);
    }
    v.accept(&encoded(&tx, &body), 0).unwrap();
    assert!(v.delta().materials_upserted.is_empty());
    let r = v.tween_record().unwrap().clone();
    let mut p = Playback::default();
    p.picture(500_000, 0., &[r], v.state());
    p.sample(500_000., v.state());
    assert_eq!(p.materials.display[&1]["threshold"].components, [Some(0.5)]);
    assert_eq!(
        v.state().materials[&1]
            .params
            .iter()
            .find(|p| &*p.name == "threshold")
            .unwrap()
            .value,
        ParamValue::Scalar(1.)
    );
}
