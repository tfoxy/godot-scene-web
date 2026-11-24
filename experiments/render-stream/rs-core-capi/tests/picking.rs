//! Native GUI queries share the web's tree picker without a second per-frame applier.
use gsw_canvas_draw_list::Format;
use render_stream_core::apply::overrides::{PickOrder, HIT_IGNORE, HIT_INPUT};
use render_stream_core::apply::{Applier, Viewport};
use render_stream_core::validate::{Options, Validator};
use render_stream_core::wire;
use rs_core_capi::*;

fn fixture() -> (Vec<u8>, Vec<u8>) {
    let data = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../protocol/golden-6/full.rs6"
    ))
    .unwrap();
    let spans = wire::split_records(&data, 6).unwrap();
    let session = spans[0].bytes(&data).to_vec();
    let rec = spans[1].bytes(&data);
    let frame = wire::frame(rec, 0).unwrap();
    let mut meta: serde_json::Value = serde_json::from_slice(frame.meta).unwrap();
    let items = meta["items"].as_array_mut().unwrap();
    for (i, item) in items.iter_mut().enumerate() {
        item["visible"] = (i < 3).into();
        item["custom_rect"] = true.into();
        item["clip"] = (i == 0).into();
        item["parent"] = if i == 1 {
            serde_json::json!({"kind":"item", "id":1})
        } else {
            serde_json::json!({"kind":"canvas", "id":1})
        };
        item["children"] = if i == 0 {
            serde_json::json!([2])
        } else {
            serde_json::json!([])
        };
    }
    meta["canvases"][0]["items"] = serde_json::json!([1, 3, 4, 5]);
    let mut body = rec[frame.body..].to_vec();
    // item_f32 is block 0: count, byte length, then 18 floats per item.
    for i in 0..3 {
        let values: [f32; 18] = [
            1.,
            0.,
            0.,
            1.,
            if i == 1 { 80. } else { 0. },
            0.,
            1.,
            1.,
            1.,
            1.,
            1.,
            1.,
            1.,
            1.,
            0.,
            0.,
            100.,
            100.,
        ];
        for (j, value) in values.iter().enumerate() {
            let at = 8 + 4 * (18 * i + j);
            body[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
    }
    let meta = serde_json::to_vec(&meta).unwrap();
    let mut tx = Vec::new();
    tx.extend_from_slice(&((4 + meta.len() + body.len()) as u32).to_le_bytes());
    tx.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    tx.extend_from_slice(&meta);
    tx.extend_from_slice(&body);
    (session, tx)
}

#[test]
fn capi_tree_queries_match_applier_on_clipped_grid() {
    let (session, tx) = fixture();
    let mut validator = Validator::new(&session, 0, Options::new(6)).unwrap();
    validator.accept(&tx, 0).unwrap();
    let mut applier = Applier::new(Viewport {
        width: 640,
        height: 360,
        clear: [0.; 4],
        global_xform: [1., 0., 0., 1., 0., 0.],
        cull_mask: u32::MAX,
        format: Format::Rgba8,
    });
    let ids = [1, 2, 3];
    let filters = [HIT_INPUT, HIT_INPUT, HIT_IGNORE];
    applier.set_hit_filters(&ids, &filters).unwrap();
    applier.set_pick_order(PickOrder::Tree);
    unsafe {
        let h = rsc_new();
        assert_eq!(rsc_session(h, session.as_ptr(), session.len(), 0, 6), 4);
        assert_eq!(rsc_accept(h, tx.as_ptr(), tx.len(), 0), 2);
        assert_eq!(rsc_pick(h, 10., 10.), -1, "no filters means no hit");
        let mut out = [0.; 3];
        assert!(rsc_to_game(h, 10., 10., out.as_mut_ptr()));
        assert_eq!(out, [-1., 10., 10.]);
        assert_eq!(rsc_set_hit_filters(h, ids.as_ptr(), filters.as_ptr(), 3), 1);
        let mut hits = 0;
        let mut empty = 0;
        for y in (-10..=120).step_by(10) {
            for x in (-10..=200).step_by(10) {
                let (x, y) = (x as f32, y as f32);
                let expected = applier
                    .pick_tree(validator.state(), x, y)
                    .map_or(-1, i64::from);
                assert_eq!(rsc_pick(h, x, y), expected, "{x},{y}");
                let (id, p) = applier.to_game(validator.state(), x, y).unwrap();
                assert!(rsc_to_game(h, x, y, out.as_mut_ptr()));
                assert_eq!(out, [id.map_or(-1., f64::from), p[0] as f64, p[1] as f64]);
                if expected < 0 {
                    empty += 1;
                } else {
                    hits += 1;
                }
            }
        }
        assert!(hits > 0 && empty > 0);
        eprintln!("native pick grid: {hits} hits, {empty} empty points");
        assert_eq!(
            rsc_pick(h, 90., 10.),
            2,
            "child before IGNORE decoration and parent"
        );
        assert_eq!(rsc_pick(h, 110., 10.), -1, "child clipped by parent");
        assert_eq!(
            rsc_set_hit_filters(h, ids.as_ptr(), [0, 1, 2].as_ptr(), 3),
            0
        );
        assert_eq!(rsc_pick(h, 90., 10.), 2, "invalid table is atomic");
        assert_eq!(
            rsc_set_hit_filters(h, std::ptr::null(), std::ptr::null(), 0),
            1
        );
        assert_eq!(rsc_pick(h, 90., 10.), -1);
        assert_eq!(rsc_set_hit_filters(h, std::ptr::null(), filters.as_ptr(), 3), 0);
        assert!(!rsc_to_game(h, 0., 0., std::ptr::null_mut()));
        rsc_free(h);
    }
}
