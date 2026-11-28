//! Executor-facing lifetime invariants over actual accepted/apply/dispose sequences.
use render_stream_core::{state::Hash, wire};
use rs_core_capi::{
    core::{Core, KIND_SESSION, KIND_TRANSACTION},
    ops::{Op, KIND_TEXTURE},
    plan::Payloads,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
struct Lifetime {
    live: BTreeMap<u32, bool>,
    canvas_frees: BTreeMap<u32, usize>,
    draws: BTreeMap<u32, u32>,
    disposing: bool,
}

impl Lifetime {
    // Decode complete ops, never search operand windows (an operand can equal an opcode).
    fn observe(&mut self, words: &[u32]) {
        let mut at = 0;
        while at < words.len() {
            let op = words[at];
            let args = &words[at + 1..];
            let n = match op {
                x if x == Op::FreeRid as u32 => {
                    if args[0] >> 29 == KIND_TEXTURE {
                        let h = args[0] & ((1 << 29) - 1);
                        let canvas = self.live.remove(&h).expect("free must name a live texture");
                        if self.disposing && !canvas {
                            assert!(
                                !self.live.values().any(|&ct| ct),
                                "dispose must free CanvasTextures before channel images"
                            );
                        }
                        if canvas {
                            *self.canvas_frees.get_mut(&h).unwrap() += 1;
                        }
                    }
                    1
                }
                x if [
                    Op::CanvasTextureCreate as u32,
                    Op::Texture2dPlaceholderCreate as u32,
                    Op::Texture2dCreate as u32,
                ]
                .contains(&x) =>
                {
                    let canvas = x == Op::CanvasTextureCreate as u32;
                    assert!(
                        self.live.insert(args[0], canvas).is_none(),
                        "create overwrites a live texture slot"
                    );
                    if canvas {
                        assert!(
                            self.canvas_frees.insert(args[0], 0).is_none(),
                            "CanvasTexture handle reused"
                        );
                    }
                    if x == Op::Texture2dCreate as u32 {
                        9
                    } else {
                        1
                    }
                }
                x if x == Op::TextureReplaceWithImage as u32
                    || x == Op::TextureReplaceWithPlaceholder as u32 =>
                {
                    let h = args[0] & ((1 << 29) - 1);
                    assert_eq!(
                        self.live[&h], false,
                        "TextureReplace targets CanvasTexture h{h}"
                    );
                    if x == Op::TextureReplaceWithImage as u32 {
                        9
                    } else {
                        1
                    }
                }
                x if x == Op::CanvasTextureSetChannel as u32
                    || x == Op::CanvasTextureSetFilter as u32
                    || x == Op::CanvasTextureSetRepeat as u32 =>
                {
                    let h = args[0] & ((1 << 29) - 1);
                    assert!(self.live[&h], "CanvasTexture binding targets image h{h}");
                    if x == Op::CanvasTextureSetChannel as u32 {
                        3
                    } else {
                        2
                    }
                }
                x if x == Op::Texture2dUpdate as u32 => 9,
                x if x == Op::SetDefaultClearColor as u32 => 4,
                x if x == Op::ViewportSetCanvasTransform as u32
                    || x == Op::ItemSetTransform as u32 =>
                {
                    7
                }
                x if x == Op::ViewportSetCanvasCullMask as u32 => 2,
                x if x == Op::ViewportSetCanvasStacking as u32 => 5,
                x if [
                    Op::CanvasSetModulate as u32,
                    Op::ItemSetModulate as u32,
                    Op::ItemSetSelfModulate as u32,
                    Op::TextureSetSizeOverride as u32,
                ]
                .contains(&x) =>
                {
                    5
                }
                x if [
                    Op::ViewportSetDefaultFilter as u32,
                    Op::ViewportSetDefaultRepeat as u32,
                    Op::CanvasItemCreate as u32,
                ]
                .contains(&x) =>
                {
                    1
                }
                x if [
                    Op::ItemSetVisibilityLayer as u32,
                    Op::ItemSetZIndex as u32,
                    Op::ItemSetDrawIndex as u32,
                ]
                .contains(&x) =>
                {
                    3
                }
                x if [
                    Op::ItemSetParent as u32,
                    Op::ItemSetVisible as u32,
                    Op::ItemSetClip as u32,
                    Op::ItemSetZRelative as u32,
                    Op::ItemSetDrawBehindParent as u32,
                    Op::ItemSetDefaultFilter as u32,
                    Op::ItemSetDefaultRepeat as u32,
                    Op::ItemSetMaterial as u32,
                    Op::ItemSetUseParentMaterial as u32,
                ]
                .contains(&x) =>
                {
                    2
                }
                x if x == Op::ItemSetCustomRect as u32 => 6,
                x if x == Op::ItemClear as u32 => {
                    self.draws.remove(&args[0]);
                    1
                }
                x if x == Op::AddTextureRect as u32 || x == Op::AddTextureRectRegion as u32 => {
                    if args[5] >> 29 == KIND_TEXTURE {
                        self.draws.insert(args[0], args[5] & ((1 << 29) - 1));
                    }
                    if x == Op::AddTextureRect as u32 {
                        12
                    } else {
                        16
                    }
                }
                _ => panic!("unhandled fixture opcode {op} at {at}"),
            };
            at += 1 + n;
            assert!(at <= words.len(), "truncated op {op}");
        }
    }
    fn disposed(&self) {
        assert!(self.live.is_empty(), "textures remain after dispose");
        assert!(
            !self.canvas_frees.is_empty(),
            "test must create a CanvasTexture"
        );
        for (&h, &n) in &self.canvas_frees {
            assert_eq!(n, 1, "CanvasTexture h{h} free count");
        }
    }
}

struct Run {
    core: Core,
    session: Vec<u8>,
    resources: Vec<Vec<u8>>,
    meta: Value,
    body: Vec<u8>,
    payloads: BTreeMap<Hash, Vec<u8>>,
    lifetime: Lifetime,
    seq: u64,
}

impl Run {
    fn new(full_scan: bool) -> Self {
        let data = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../protocol/golden-6/inline.rs6"
        ))
        .unwrap();
        let spans = wire::split_records(&data, 6).unwrap();
        let session = spans[0].bytes(&data).to_vec();
        let mut core = Core::new();
        core.planner.full_scan = full_scan;
        assert_eq!(core.session(&data, spans[0].offset, 6), KIND_SESSION);
        core.begin_session();
        let mut lifetime = Lifetime::default();
        lifetime.observe(&core.ops.words);
        let mut payloads = BTreeMap::new();
        let mut resources = Vec::new();
        for span in &spans[1..] {
            let rec = span.bytes(&data);
            let f = wire::frame(rec, 0).unwrap();
            let meta: Value = serde_json::from_slice(f.meta).unwrap();
            if meta["type"] == "resource" {
                resources.push(rec.to_vec());
                core.accept(rec, 0);
                assert!(core.resource_payload());
                payloads.insert(wire::sha256(&core.text), core.text.clone());
            } else if meta["type"] == "transaction" {
                return Self {
                    core,
                    session,
                    resources,
                    meta,
                    body: rec[f.body..].to_vec(),
                    payloads,
                    lifetime,
                    seq: 0,
                };
            }
        }
        panic!("fixture transaction missing");
    }
    fn tx(&mut self, kind: &str, edit: impl FnOnce(&mut Value)) {
        assert_eq!(
            self.accept_tx(kind, edit),
            KIND_TRANSACTION,
            "{}",
            String::from_utf8_lossy(&self.core.vt.out)
        );
    }
    fn accept_tx(&mut self, kind: &str, edit: impl FnOnce(&mut Value)) -> i32 {
        self.seq += 1;
        let mut meta = self.meta.clone();
        meta["seq"] = self.seq.into();
        meta["frame"] = self.seq.into();
        let tex = &mut meta["textures"][0];
        tex["version"] = self.seq.into();
        tex["kind"] = kind.into();
        if kind != "image" {
            tex["hash"] = Value::Null;
            tex["format"] = Value::Null;
            tex["width"] = 0.into();
            tex["height"] = 0.into();
            tex["payload_bytes"] = 0.into();
            tex["canvas"] = if kind == "canvas" {
                json!({"diffuse":5,"filter":"default","repeat":"default"})
            } else {
                Value::Null
            };
        }
        edit(&mut meta);
        let bytes = serde_json::to_vec(&meta).unwrap();
        let mut rec = Vec::new();
        rec.extend_from_slice(&((4 + bytes.len() + self.body.len()) as u32).to_le_bytes());
        rec.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        rec.extend_from_slice(&bytes);
        rec.extend_from_slice(&self.body);
        self.core.accept(&rec, 0)
    }
    fn apply(&mut self) {
        for hash in self.core.needed_raw().hashes {
            self.core
                .provide(&hash.to_hex(), &self.payloads[&hash])
                .unwrap();
        }
        self.core.apply().unwrap();
        self.lifetime.observe(&self.core.ops.words);
    }
    fn finish(&mut self) {
        self.core.dispose();
        self.lifetime.disposing = true;
        self.lifetime.observe(&self.core.ops.words);
        self.lifetime.disposing = false;
        self.lifetime.disposed();
        assert_eq!(self.core.dispose(), 0);
        self.lifetime.observe(&self.core.ops.words);
    }
}

#[test]
fn canvas_kind_flips_both_ways_free_before_creating_the_new_kind() {
    for scan in [false, true] {
        for other in ["image", "placeholder"] {
            let mut run = Run::new(scan);
            for kind in ["canvas", other, "canvas", other, "canvas"] {
                run.tx(kind, |_| {});
                run.apply();
                for &h in run.lifetime.draws.values() {
                    assert!(
                        run.lifetime.live.contains_key(&h),
                        "unchanged draw content still names freed h{h}"
                    );
                }
            }
            run.finish();
            assert_eq!(run.lifetime.canvas_frees.len(), 3);
        }
    }
}

#[test]
fn canvas_removal_tombstone_and_id_reuse_preserve_frees() {
    for scan in [false, true] {
        for tombstone in [false, true] {
            let mut run = Run::new(scan);
            run.tx("canvas", |_| {});
            run.apply();
            run.tx("canvas", |m| {
                if tombstone {
                    m["textures"][0]["status"] = "freed".into();
                    m["textures"][0]["canvas"] = Value::Null;
                } else {
                    m["textures"].as_array_mut().unwrap().remove(0);
                    for item in m["items"].as_array_mut().unwrap() {
                        item["content_version"] = 2.into();
                        for cmd in item["commands"].as_array_mut().unwrap() {
                            if cmd["tex"] == 1 {
                                cmd["tex"] = 5.into();
                            }
                        }
                    }
                }
            });
            run.apply();
            let kind = run.accept_tx("canvas", |_| {});
            if tombstone {
                assert_eq!(kind, KIND_TRANSACTION);
                run.apply();
            } else {
                assert_ne!(kind, KIND_TRANSACTION, "removed wire ids cannot reappear");
            }
            run.finish();
            assert_eq!(
                run.lifetime.canvas_frees.len(),
                if tombstone { 2 } else { 1 }
            );
        }
    }
}

#[test]
fn canvas_non_ok_and_refused_drawing_keep_ownership_until_dispose() {
    for scan in [false, true] {
        let mut run = Run::new(scan);
        run.core.set_sabotage("refuse-canvas-texture");
        run.tx("canvas", |_| {});
        run.apply();
        run.tx("canvas", |m| {
            m["textures"][0]["status"] = "unsupported".into();
            m["textures"][0]["reason"] = "canvas-texture-channel".into();
            m["unsupported"].as_array_mut().unwrap().extend([
                json!({"op":"canvas_item_add_texture_rect","item":1,"reason":"unsupported-texture"}),
                json!({"op":"canvas_item_add_texture_rect_region","item":2,"reason":"unsupported-texture"}),
            ]);
            m["unsupported"].as_array_mut().unwrap().sort_by_key(|e| (e["item"].as_i64().unwrap(), e["op"].as_str().unwrap().to_owned()));
        });
        run.apply();
        run.core.set_sabotage("");
        run.tx("canvas", |_| {});
        run.apply();
        run.finish();
        assert_eq!(run.lifetime.canvas_frees.len(), 1);
    }
}

#[test]
fn canvas_resync_coalesced_applies_and_session_restart_preserve_ownership() {
    for scan in [false, true] {
        let mut run = Run::new(scan);
        run.tx("canvas", |_| {});
        run.apply();
        run.core.transport_skip();
        // A resync full restores state without dropping the planner's live RIDs.
        run.tx("canvas", |_| {});
        run.apply();
        // Credit may coalesce accepts before one apply; intermediate states create no RIDs.
        run.tx("placeholder", |_| {});
        run.tx("canvas", |_| {});
        run.apply();
        run.finish();
        assert_eq!(run.core.session(&run.session, 0, 6), KIND_SESSION);
        run.core.begin_session();
        run.lifetime.observe(&run.core.ops.words);
        for resource in &run.resources {
            run.core.accept(resource, 0);
        }
        run.seq = 0;
        run.tx("canvas", |_| {});
        run.apply();
        run.finish();
        assert_eq!(run.lifetime.canvas_frees.len(), 2);
    }
}

#[test]
fn canvas_apply_restart_after_missing_resource_keeps_existing_rids() {
    for scan in [false, true] {
        let mut run = Run::new(scan);
        run.tx("canvas", |_| {});
        run.apply();
        // Change the channel to a known but not-yet-provided RGBA8 body. Planning fails
        // before execute; retry must retain the already executed CT's ownership.
        let mut image = run.meta["textures"][0].clone();
        image["id"] = 5.into();
        image["version"] = 2.into();
        run.tx("canvas", |m| m["textures"][4] = image);
        let error = run.core.apply().unwrap_err();
        assert!(error.starts_with("resource-unavailable:"), "{error}");
        // The executor runs no partial op buffer when apply returns an error.
        run.apply();
        run.finish();
    }
}

#[test]
fn canvas_cross_kind_missing_payload_keeps_ct_ownership() {
    for scan in [false, true] {
        for retry in [false, true] {
            let mut run = Run::new(scan);
            run.tx("canvas", |_| {});
            run.apply();
            run.tx("image", |_| {});
            let error = run.core.apply().unwrap_err();
            assert!(error.starts_with("resource-unavailable:"), "{error}");
            if retry {
                run.apply();
            }
            run.finish();
        }
    }
}

#[test]
fn canvas_tombstone_then_missing_payload_keeps_ct_free() {
    for scan in [false, true] {
        let mut run = Run::new(scan);
        run.tx("canvas", |_| {});
        run.apply();
        let mut image = run.meta["textures"][0].clone();
        image["id"] = 5.into();
        image["version"] = 2.into();
        run.tx("canvas", |m| {
            m["textures"][0]["status"] = "freed".into();
            m["textures"][0]["canvas"] = Value::Null;
            m["textures"][4] = image;
        });
        let error = run.core.apply().unwrap_err();
        assert!(error.starts_with("resource-unavailable:"), "{error}");
        run.apply();
        run.finish();
    }
}

#[test]
fn canvas_created_in_failed_apply_is_created_on_retry() {
    for scan in [false, true] {
        let mut run = Run::new(scan);
        let mut image = run.meta["textures"][0].clone();
        image["id"] = 5.into();
        image["version"] = 2.into();
        run.tx("canvas", |m| m["textures"][4] = image);
        let error = run.core.apply().unwrap_err();
        assert!(error.starts_with("resource-unavailable:"), "{error}");
        run.apply();
        run.finish();
    }
}

#[test]
fn canvas_invalid_payload_preserves_ownership_and_dirty_tracking() {
    for scan in [false, true] {
        for retry in [false, true] {
            let mut run = Run::new(scan);
            run.tx("canvas", |_| {});
            run.apply();
            run.tx("image", |_| {});
            let state = run.core.state().unwrap().clone();
            let hash = run.core.needed_raw().hashes[0];
            // Core::provide rejects corrupt bytes earlier. Exercise the planner's own fallible
            // decoder boundary directly, with the accepted state and existing executor RIDs.
            let provided = HashMap::from([(hash, b"invalid texture payload".to_vec())]);
            let payloads = Payloads {
                provided: &provided,
                library: &Default::default(),
                dynamic: &Default::default(),
                multimeshes: &Default::default(),
                particle_emits: &[],
                version: 6,
            };
            run.core.ops.clear();
            let error = run
                .core
                .planner
                .apply(&state, &payloads, &mut run.core.ops, &mut run.core.vt)
                .unwrap_err();
            assert!(error.starts_with("resource-invalid:"), "{error}");
            assert!(
                run.core.ops.words.is_empty(),
                "failed plan must emit no ops"
            );
            if retry {
                run.apply();
            }
            run.finish();
        }
    }
}
