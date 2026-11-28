use super::*;
use render_stream_core::tweens::{Begin, Event, Kind, Pose, Record, Step};
use wasm_bindgen::JsCast;

fn receiver() -> GswRs {
    std::panic::set_hook(Box::new(|p| {
        web_sys::console::error_1(&p.to_string().into())
    }));
    let canvas = JsValue::NULL.unchecked_into();
    let mut g = GswRs::new(canvas, "{\"client_tweens\":true}").unwrap();
    let data = include_bytes!("../../../protocol/golden-17/full.rs17");
    let spans = wire::split_records(data, 17).unwrap();
    let mut v = Validator::new(spans[0].bytes(data), 0, Options::new(17)).unwrap();
    for span in spans.iter().skip(1) {
        v.accept(span.bytes(data), span.offset).unwrap();
    }
    let vp = Viewport {
        width: 640,
        height: 360,
        clear: [0.; 4],
        global_xform: geom::IDENTITY,
        cull_mask: u32::MAX,
        format: Format::Rgba8,
    };
    let mut a = Applier::new(vp);
    a.apply(v.state(), v.delta(), &g.payloads);
    g.viewport = Some(vp);
    g.validator = Some(v);
    g.applier = Some(a);
    g
}
fn record(g: &GswRs, id: i64, order: i64, start: i64, component: usize) -> Record {
    let state = g.validator.as_ref().unwrap().state();
    let item = *state.items.keys().min().unwrap();
    Record {
        seq: state.seq,
        frame: state.frame,
        time: start,
        poses: vec![Pose {
            item,
            kind: Kind::Node2d,
            values: [
                0., 0., 0., 1., 1., 0., 0., 0., 1., 1., 1., 1., 1., 1., 1., 1.,
            ],
        }],
        events: vec![Event::Begin(Begin {
            id,
            item,
            order,
            begin: start,
            end: start + 1_000_000,
            steps: vec![Step {
                components: vec![component],
                start: 0,
                duration: 1_000_000,
                trans: 0,
                ease: 0,
                from: Some(vec![0.]),
                to: vec![100.],
            }],
        })],
    }
}
fn picture(g: &mut GswRs, time: i64, records: &[Record]) {
    let state = g.validator.as_ref().unwrap().state();
    g.applier
        .as_mut()
        .unwrap()
        .tween_tick(state, &g.payloads, time as f64, Some((time, records)));
}
fn apply(g: &mut GswRs) {
    let v = g.validator.as_ref().unwrap();
    g.applier
        .as_mut()
        .unwrap()
        .apply(v.state(), v.delta(), &g.payloads);
}

#[test]
#[wasm_bindgen]
pub fn regression_resync_full_keeps_new_begin_and_drops_old_playback() {
    let mut g = receiver();
    let old = record(&g, 1, 1, 0, 0);
    picture(&mut g, 0, &[old]);
    g.transport_skip();
    assert!(
        !g.tweens_active(),
        "resync must clear old playback immediately"
    );
    let new = record(&g, 2, 2, 200_000, 1);
    let item = new.poses[0].item;
    // The accepted full and its announcement are already queued when the shell rebuilds.
    g.tween_records.push(new);
    g.tween_picture = true;
    assert!(g.live_rebuild() >= 0);
    assert!(
        g.tween_picture,
        "the resync-ending full is still a new picture"
    );
    let records = std::mem::take(&mut g.tween_records);
    assert_eq!(records.len(), 1);
    picture(&mut g, 200_000, &records);
    apply(&mut g);
    let state = g.validator.as_ref().unwrap().state();
    let a = g.applier.as_mut().unwrap();
    a.tween_tick(state, &g.payloads, 700_000., None);
    assert_eq!(a.tweens.counts().0, 1);
    assert_eq!(a.tweens.display[&item].xform[5], 50.);
}

#[test]
#[wasm_bindgen]
pub fn regression_window_one_rebuild_keeps_playback_and_folded_begins() {
    let mut g = receiver();
    let old = record(&g, 1, 1, 0, 0);
    let item = old.poses[0].item;
    picture(&mut g, 0, &[old]);
    picture(&mut g, 300_000, &[]);
    assert_eq!(
        g.applier.as_ref().unwrap().tweens.display[&item].xform[4],
        30.
    );
    // An announcement belongs to the older of two superseded accepted transactions.
    g.tween_records.push(record(&g, 2, 2, 300_000, 1));
    g.tween_picture = true;
    assert!(g.live_rebuild() >= 0);
    assert!(g.tween_picture);
    assert_eq!(g.applier.as_ref().unwrap().tweens.counts().0, 1);
    let records = std::mem::take(&mut g.tween_records);
    assert_eq!(records.len(), 1);
    picture(&mut g, 400_000, &records);
    apply(&mut g);
    let a = g.applier.as_ref().unwrap();
    assert_eq!(a.tweens.counts().0, 2);
    assert_eq!(
        a.tweens.display[&item].xform[4], 40.,
        "old playback must not restart or snap"
    );
    assert_eq!(
        a.tweens.display[&item].xform[5], 10.,
        "the superseded announcement still plays"
    );
}

fn freeze_item(g: &mut GswRs, item: u32) {
    g.applier
        .as_mut()
        .unwrap()
        .set_overrides(
            &[item],
            &[
                1., 0., 0., 1., 0., 0., 1., 1., 1., 1., 1., 1., 0., 0., 0., 0.,
            ],
        )
        .unwrap();
    apply(g);
}

#[test]
#[wasm_bindgen]
pub fn regression_frozen_tween_survives_supersession_rebuild() {
    let mut g = receiver();
    let r = record(&g, 1, 1, 0, 0);
    let item = r.poses[0].item;
    picture(&mut g, 0, &[r]);
    picture(&mut g, 100_000, &[]);
    freeze_item(&mut g, item);
    assert!(g.live_rebuild() >= 0);
    apply(&mut g);
    let state = g.validator.as_ref().unwrap().state();
    let a = g.applier.as_mut().unwrap();
    assert_eq!(a.display_local(item, &state.items[&item]).xform[4], 10.);
    a.tween_tick(state, &g.payloads, 600_000., None);
    assert_eq!(a.tweens.display[&item].xform[4], 60.);
    assert_eq!(a.display_local(item, &state.items[&item]).xform[4], 10.);
}

#[test]
#[wasm_bindgen]
pub fn regression_resync_recaptures_frozen_tween_from_host() {
    let mut g = receiver();
    let r = record(&g, 1, 1, 0, 0);
    let item = r.poses[0].item;
    picture(&mut g, 0, &[r]);
    picture(&mut g, 100_000, &[]);
    freeze_item(&mut g, item);
    g.transport_skip();
    assert!(!g.tweens_active());
    assert!(g.live_rebuild() >= 0);
    apply(&mut g);
    let state = g.validator.as_ref().unwrap().state();
    let a = g.applier.as_mut().unwrap();
    let host = state.items[&item].xform;
    assert_eq!(a.display_local(item, &state.items[&item]).xform, host);
    // Playback restarted after the resync must not move the recaptured frozen pose.
    let next = record(&g, 2, 2, 200_000, 0);
    picture(&mut g, 200_000, &[next]);
    picture(&mut g, 600_000, &[]);
    let state = g.validator.as_ref().unwrap().state();
    let a = g.applier.as_ref().unwrap();
    assert_eq!(a.tweens.display[&item].xform[4], 40.);
    assert_eq!(a.display_local(item, &state.items[&item]).xform, host);
}

#[test]
#[wasm_bindgen]
pub fn regression_v18_live_options_keep_tweens() {
    // The Node runner invokes exported regressions rather than libtest's WASM entry point.
    cover_tiles_option_defaults_on_and_either_disable_wins();
    std::panic::set_hook(Box::new(|p| {
        web_sys::console::error_1(&p.to_string().into())
    }));
    for version in [17, 18, 19] {
        let options = format!("{{\"live_protocol\":{version},\"client_tweens\":true}}");
        let parsed = parse_options(&options).unwrap();
        assert_eq!(parsed.live_protocol, version);
        assert!(parsed.client_tweens);
        let original = include_bytes!("../../../protocol/golden-17/full.rs17");
        let data = render_stream_core::item_meta::restamp(original, 17, version).unwrap();
        let span = wire::split_records(&data, version).unwrap()[0];
        let record = span.bytes(&data);
        let frame = wire::frame(record, span.offset).unwrap();
        // The shared full-stream vector opts out of tweens. Add the negotiated
        // grant without requiring a canvas context in this Node regression.
        let meta = std::str::from_utf8(frame.meta)
            .unwrap()
            .replace("\"blocks\":", "\"client_tweens\":true,\"blocks\":");
        let body = &record[frame.body..];
        let mut granted = ((4 + meta.len() + body.len()) as u32)
            .to_le_bytes()
            .to_vec();
        granted.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        granted.extend_from_slice(meta.as_bytes());
        granted.extend_from_slice(body);
        let validator = Validator::new(&granted, span.offset, Options::new(version)).unwrap();
        assert_eq!(parsed.client_tweens, validator.session().client_tweens);
    }
}

fn material_receiver() -> GswRs {
    std::panic::set_hook(Box::new(|p| {
        web_sys::console::error_1(&p.to_string().into())
    }));
    let canvas = JsValue::NULL.unchecked_into();
    let mut g = GswRs::new(canvas, "{\"live_protocol\":19,\"client_tweens\":true}").unwrap();
    let data = include_bytes!("../../../protocol/golden-19/mixed.rs19");
    let spans = wire::split_records(data, 19).unwrap();
    let mut v = Validator::new(spans[0].bytes(data), 8, Options::new(19)).unwrap();
    for span in &spans[1..] {
        v.accept(span.bytes(data), span.offset).unwrap();
    }
    let vp = Viewport {
        width: 640,
        height: 360,
        clear: [0.; 4],
        global_xform: geom::IDENTITY,
        cull_mask: u32::MAX,
        format: Format::Rgba8,
    };
    let mut a = Applier::new(vp);
    a.apply(v.state(), v.delta(), &g.payloads);
    g.viewport = Some(vp);
    g.validator = Some(v);
    g.applier = Some(a);
    g
}
#[test]
#[wasm_bindgen]
pub fn regression_material_decode_tick_diagnostics_and_resync() {
    // Wire integers are safe JavaScript integers, not wrapping wasm32 indices.
    for (record, from, to, code) in [
        (
            include_bytes!("../../../protocol/golden-19/material-begin.record").as_slice(),
            "\"from\":0",
            "\"from\":4294967296",
            "tween-offset",
        ),
        (
            include_bytes!("../../../protocol/golden-19/material-component.record").as_slice(),
            "\"component\":1",
            "\"component\":4294967297",
            "meta-schema",
        ),
    ] {
        let f = wire::frame(record, 0).unwrap();
        let meta = std::str::from_utf8(f.meta).unwrap().replace(from, to);
        let mut bytes = ((4 + meta.len() + record.len() - f.body) as u32)
            .to_le_bytes()
            .to_vec();
        bytes.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        bytes.extend_from_slice(meta.as_bytes());
        bytes.extend_from_slice(&record[f.body..]);
        assert_eq!(
            render_stream_core::meta::decode_record(
                &bytes,
                0,
                19,
                &mut Default::default(),
                &mut Default::default()
            )
            .unwrap_err()
            .code,
            code
        );
    }
    let mut g = material_receiver();
    let r = render_stream_core::tweens::decode_version(
        include_bytes!("../../../protocol/golden-19/material-begin.record"),
        0,
        19,
        &mut Default::default(),
    )
    .unwrap();
    g.tween_records.push(r);
    g.tween_picture = true;
    assert_eq!(g.tween_tick(0., true), 1);
    assert!(g.tweens_active());
    assert_eq!(g.tween_tick(500_000., false), 1);
    let a = g.applier.as_ref().unwrap();
    assert_eq!(
        a.tweens.materials.display[&1]["threshold"].components,
        [Some(0.5)]
    );
    let d = js_sys::JSON::parse(&g.tween_diagnostics_json()).unwrap();
    for key in [
        "material_begins",
        "live_material_tweens",
        "held_material_components",
    ] {
        assert_eq!(
            js_sys::Reflect::get(&d, &key.into()).unwrap().as_f64(),
            Some(1.)
        );
    }
    g.transport_skip();
    assert!(!g.tweens_active());
    assert!(g
        .applier
        .as_ref()
        .unwrap()
        .tweens
        .materials
        .display
        .is_empty());
}
#[test]
#[wasm_bindgen]
pub fn regression_material_rebuild_completion_and_transcode() {
    let mut g = material_receiver();
    let r = render_stream_core::tweens::decode_version(
        include_bytes!("../../../protocol/golden-19/material-begin.record"),
        0,
        19,
        &mut Default::default(),
    )
    .unwrap();
    picture(&mut g, 0, &[r]);
    picture(&mut g, 200_000, &[]);
    assert!(g.live_rebuild() >= 0);
    apply(&mut g);
    let s = g.validator.as_ref().unwrap().state();
    g.applier
        .as_mut()
        .unwrap()
        .tween_tick(s, &g.payloads, 700_000., None);
    let held = g.applier.as_ref().unwrap().tweens.materials.display[&1]["threshold"].components[0]
        .unwrap();
    assert!((held - 0.3).abs() < 1e-6);
    assert_eq!(g.tween_tick(1_000_000., false), 1);
    assert!(!g.tweens_active());
    assert_eq!(g.tween_tick(1_100_000., false), 0);
    let down = render_stream_core::tweens::to18_from19(include_bytes!(
        "../../../protocol/golden-19/mixed.rs19"
    ))
    .unwrap();
    assert_eq!(
        down,
        include_bytes!("../../../protocol/golden-19/mixed.to18.rs18")
    );
}

#[test]
#[wasm_bindgen]
pub fn cover_tiles_option_defaults_on_and_either_disable_wins() {
    for (json, off) in [
        ("{}", false),
        (r#"{"coverTiles":true}"#, false),
        (r#"{"coverTiles":false}"#, true),
        (r#"{"sabotage":["no-cover-tiles"]}"#, true),
        (r#"{"coverTiles":true,"sabotage":["no-cover-tiles"]}"#, true),
    ] {
        assert_eq!(parse_options(json).unwrap().no_cover_tiles, off, "{json}");
    }
}
