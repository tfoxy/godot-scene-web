//! render-stream/16 (render-stream-16.md): the viewport table, `viewport_f32`, the `viewport` and
//! `proxy` texture kinds and their codes, on small recordings built here. The session record is
//! golden-16's (`viewports.rs16`, re-keyed per test); every transaction is written by [`Tx`].

use crate::validate::{Accepted, Options, Validator};
use crate::wire::{self, Error};
use std::path::PathBuf;

fn golden(rel: &str) -> Vec<u8> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol");
    std::fs::read(base.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The predict_check of a transaction whose three predicted blocks are empty.
const EMPTY_CHECK: &str = "ef46db3751d8e999";
const HASH1: &str = "e65a0caf1a46175e39e501f3000016c9b56958648fda140874f93c9fcbd03fa9";

/// golden-16's session at `version` (protocol re-stamped; below /16 without `viewports`), with
/// `viewports` set to `mode` (`None`: the key removed) and, when `adoption` is false, a null
/// adoption.
fn session(version: u8, mode: Option<&str>, adoption: bool) -> Vec<u8> {
    let data = golden("golden-16/viewports.rs16");
    let spans = wire::split_records(&data, 16).unwrap();
    let rec = spans[0].bytes(&data);
    let meta_len = wire::le_u32(rec, 4) as usize;
    let mut meta = String::from_utf8(rec[8..8 + meta_len].to_vec()).unwrap();
    meta = meta.replace(
        "\"protocol\":\"render-stream/16\"",
        &format!("\"protocol\":\"render-stream/{version}\""),
    );
    let key = match mode {
        Some(m) => format!(",\"viewports\":\"{m}\""),
        None => String::new(),
    };
    meta = meta.replace(",\"viewports\":\"on\"", &key);
    if !adoption {
        meta = meta.replace("\"adoption\":{\"mode\":\"arm\",\"frame\":12}", "\"adoption\":null");
    }
    let mut out = Vec::new();
    crate::predict::make_record(&mut out, &[meta.as_bytes()], &rec[8 + meta_len..]);
    out
}

/// One transaction. Lists are JSON text; `vp` is the text between `materials` and
/// `predict_check` (`,"removed_viewports":[..],"viewports":[..]`), `vp_floats` the count of the
/// trailing `viewport_f32` block (`None`: no block).
#[derive(Clone)]
struct Tx {
    seq: i64,
    full: bool,
    unsupported: String,
    removed_canvases: String,
    removed_textures: String,
    canvases: String,
    n_canvases: usize,
    items: String,
    n_items: usize,
    cmd_floats: usize,
    textures: String,
    vp: String,
    vp_floats: Option<usize>,
    vp_values: Vec<f32>,
}

impl Tx {
    fn full(seq: i64) -> Tx {
        Tx {
            seq,
            full: true,
            unsupported: "[]".into(),
            removed_canvases: "[]".into(),
            removed_textures: "[]".into(),
            canvases: format!("[{},{}]", ROOT, canvas(2, false, "[]")),
            n_canvases: 2,
            items: "[]".into(),
            n_items: 0,
            cmd_floats: 0,
            textures: "[]".into(),
            vp: String::new(),
            vp_floats: None,
            vp_values: Vec::new(),
        }
    }
    fn patch(seq: i64) -> Tx {
        Tx {
            full: false,
            unsupported: "null".into(),
            canvases: "[]".into(),
            n_canvases: 0,
            ..Tx::full(seq)
        }
    }
    fn textures(mut self, t: &[String]) -> Tx {
        self.textures = format!("[{}]", t.join(","));
        self
    }
    fn viewports(mut self, v: &[String], floats: usize) -> Tx {
        self.vp = format!(",\"viewports\":[{}]", v.join(","));
        self.vp_floats = Some(floats);
        self
    }
    fn items(mut self, it: &[String]) -> Tx {
        self.items = format!("[{}]", it.join(","));
        self.n_items = it.len();
        self.cmd_floats = 8 * it.len();
        self
    }
    fn record(&self) -> Vec<u8> {
        let mut blocks: Vec<(&str, &str, usize)> = vec![
            ("item_f32", "f32", 18 * self.n_items),
            ("canvas_f32", "f32", 10 * self.n_canvases),
            ("cmd_f32", "f32", self.cmd_floats),
            ("cmd_i32", "i32", 0),
            ("mesh_f32", "f32", 0),
            ("param_f64", "f64", 0),
            ("backbuffer_f32", "f32", 0),
            ("mesh_u8", "u8", 0),
            ("mm_f32", "f32", 0),
        ];
        if let Some(n) = self.vp_floats {
            blocks.push(("viewport_f32", "f32", n));
        }
        let descs: Vec<String> = blocks
            .iter()
            .map(|(n, t, c)| format!("{{\"name\":\"{n}\",\"type\":\"{t}\",\"count\":{c}}}"))
            .collect();
        let meta = format!(
            "{{\"type\":\"transaction\",\"seq\":{seq},\"frame\":{seq},\"encoding\":\"{enc}\",\"base_seq\":{base},\"status\":\"ok\",\"failures\":[],\"unsupported\":{u},\"default_texture_filter\":\"nearest\",\"default_texture_repeat\":\"disabled\",\"removed_canvases\":{rc},\"removed_items\":[],\"removed_textures\":{rt},\"removed_meshes\":[],\"removed_shaders\":[],\"removed_materials\":[],\"canvases\":{c},\"items\":{i},\"textures\":{t},\"meshes\":[],\"shaders\":[],\"materials\":[]{vp},\"predict_check\":\"{EMPTY_CHECK}\",\"blocks\":[{b}]}}",
            seq = self.seq,
            enc = if self.full { "full" } else { "patch" },
            base = if self.full { "null".to_string() } else { (self.seq - 1).to_string() },
            u = self.unsupported,
            rc = self.removed_canvases,
            rt = self.removed_textures,
            c = self.canvases,
            i = self.items,
            t = self.textures,
            vp = self.vp,
            b = descs.join(","),
        );
        let mut body = (blocks.len() as u32).to_le_bytes().to_vec();
        for (k, (_, t, c)) in blocks.iter().enumerate() {
            let w = match *t {
                "f64" => 8,
                "u8" => 1,
                _ => 4,
            };
            body.extend_from_slice(&((c * w) as u32).to_le_bytes());
            let mut bytes = vec![0u8; c * w];
            if k == 1 {
                // A canvas's xform (identity) and modulate (white).
                for n in 0..self.n_canvases {
                    for (j, x) in [1f32, 0., 0., 1., 0., 0., 1., 1., 1., 1.].iter().enumerate() {
                        bytes[4 * (10 * n + j)..4 * (10 * n + j + 1)]
                            .copy_from_slice(&x.to_le_bytes());
                    }
                }
            }
            if k == 9 {
                for (j, x) in self.vp_values.iter().enumerate().take(*c) {
                    bytes[4 * j..4 * j + 4].copy_from_slice(&x.to_le_bytes());
                }
            }
            body.extend_from_slice(&bytes);
        }
        let mut out = Vec::new();
        crate::predict::make_record(&mut out, &[meta.as_bytes()], &body);
        out
    }
}

const ROOT: &str = "{\"id\":1,\"origin\":\"root-query\",\"role\":\"root\",\"attached\":true,\"layer\":0,\"sublayer\":0,\"items\":[]}";

fn canvas(id: u32, attached: bool, items: &str) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"role\":null,\"attached\":{attached},\"layer\":0,\"sublayer\":0,\"items\":{items}}}")
}

/// An item on canvas `canvas` drawing `add_texture_rect` of `tex` at cmd float `f`.
fn item(id: u32, canvas: u32, draw_index: i64, tex: u32, f: usize) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"parent\":{{\"kind\":\"canvas\",\"id\":{canvas}}},\"children\":[],\"visible\":true,\"draw_index\":{draw_index},\"z_index\":0,\"z_relative\":true,\"behind\":false,\"clip\":false,\"custom_rect\":false,\"visibility_layer\":4294967295,\"texture_filter\":\"default\",\"texture_repeat\":\"default\",\"material\":null,\"use_parent_material\":false,\"instance_params\":[],\"canvas_group\":null,\"copy_to_backbuffer\":null,\"content_version\":1,\"commands\":[{{\"op\":\"add_texture_rect\",\"tex\":{tex},\"tile\":false,\"transpose\":false,\"f\":{f}}}]}}")
}

/// A texture entry with every payload field blank; `kind_key` is the text after `variants`
/// (`"viewport":1,` or `"target":null,`).
fn bare(id: u32, kind: &str, status: &str, reason: &str, kind_key: &str) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"{kind}\",\"status\":\"{status}\",\"reason\":{reason},\"version\":1,\"hash\":null,\"format\":null,\"source_format\":null,\"width\":0,\"height\":0,\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],{kind_key}\"canvas\":null}}")
}
fn vtex(id: u32, viewport: u32) -> String {
    bare(id, "viewport", "ok", "null", &format!("\"viewport\":{viewport},"))
}
fn proxy(id: u32, target: u32) -> String {
    bare(id, "proxy", "ok", "null", &format!("\"target\":{target},"))
}
fn image(id: u32) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"image\",\"status\":\"ok\",\"reason\":null,\"version\":1,\"hash\":\"{HASH1}\",\"format\":\"RGBA8\",\"source_format\":null,\"width\":16,\"height\":16,\"mipmaps\":false,\"payload_bytes\":1135,\"variants\":[],\"canvas\":null}}")
}
fn unsupported_image(id: u32) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"image\",\"status\":\"unsupported\",\"reason\":\"unsupported-format\",\"version\":1,\"hash\":null,\"format\":\"RGBAF\",\"source_format\":null,\"width\":4,\"height\":4,\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],\"canvas\":null}}")
}
fn canvas_texture(id: u32, diffuse: u32) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"canvas\",\"status\":\"ok\",\"reason\":null,\"version\":1,\"hash\":null,\"format\":null,\"source_format\":null,\"width\":0,\"height\":0,\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],\"canvas\":{{\"diffuse\":{diffuse},\"filter\":\"default\",\"repeat\":\"default\"}}}}")
}

/// A viewport entry: `parent` and `canvases` as JSON text.
fn vp(id: u32, parent: &str, canvases: &str, f: usize) -> String {
    format!("{{\"id\":{id},\"origin\":\"created\",\"parent\":{parent},\"active\":true,\"active_seq\":{id},\"size\":[32,32],\"transparent\":false,\"update\":\"always\",\"once_seq\":0,\"clear\":\"always\",\"clear_seq\":0,\"disable_2d\":false,\"renders_3d\":false,\"hdr_2d\":false,\"msaa_2d\":0,\"canvas_cull_mask\":4294967295,\"default_texture_filter\":\"linear\",\"default_texture_repeat\":\"disabled\",\"snap_2d\":[false,false],\"canvases\":{canvases},\"f\":{f}}}")
}

/// The base scene: viewport 1 (parent 0, canvas 2) with its texture 3, image 1, unsupported
/// image 2.
fn base(seq: i64) -> Tx {
    Tx::full(seq)
        .textures(&[image(1), unsupported_image(2), vtex(3, 1)])
        .viewports(&[vp(1, "0", "[[2,0,0]]", 0)], 12)
}

/// The recording of `txs` after `session`, with an end record.
fn recording(version: u8, session: Vec<u8>, txs: &[Tx]) -> Vec<u8> {
    let mut out = wire::magic(version).to_vec();
    let mut lens = vec![session.len()];
    out.extend_from_slice(&session);
    for t in txs {
        let r = t.record();
        lens.push(r.len());
        out.extend_from_slice(&r);
    }
    let bytes: usize = wire::MAGIC_LEN + lens.iter().sum::<usize>();
    let max = lens.iter().max().unwrap();
    let fulls = txs.iter().filter(|t| t.full).count();
    let end = format!(
        "{{\"type\":\"end\",\"transactions\":{},\"reason\":\"shutdown\",\"stats\":{{\"bytes_total\":{bytes},\"encode_ns_total\":0,\"snapshot_ns_total\":0,\"diff_ns_total\":0,\"max_record_bytes\":{max},\"full_transactions\":{fulls},\"patch_transactions\":{},\"resource_records\":0,\"resource_bytes\":0}},\"blocks\":[]}}",
        txs.len(),
        txs.len() - fulls
    );
    let mut rec = Vec::new();
    crate::predict::make_record(&mut rec, &[end.as_bytes()], &0u32.to_le_bytes());
    out.extend_from_slice(&rec);
    out
}

/// The first error over `txs` (session at /16, "on", with adoption) and the seq it failed at.
fn run_at(version: u8, session: Vec<u8>, txs: &[Tx]) -> Result<Validator, (Error, i64)> {
    let mut v = Validator::new(&session, wire::MAGIC_LEN, Options::new(version))
        .map_err(|e| (e, 0))?;
    let mut at = wire::MAGIC_LEN + session.len();
    for t in txs {
        let r = t.record();
        match v.accept(&r, at) {
            Ok(Accepted::Transaction) => {}
            Ok(other) => panic!("unexpected {other:?}"),
            Err(e) => return Err((e, t.seq)),
        }
        at += r.len();
    }
    Ok(v)
}

fn run(txs: &[Tx]) -> Result<Validator, (Error, i64)> {
    run_at(16, session(16, Some("on"), true), txs)
}

#[track_caller]
fn ok(txs: &[Tx]) -> Validator {
    match run(txs) {
        Ok(v) => v,
        Err((e, seq)) => panic!("seq {seq}: {e}"),
    }
}

#[track_caller]
fn fails(txs: &[Tx], code: &str, seq: i64) {
    match run(txs) {
        Ok(_) => panic!("accepted; expected {code} at seq {seq}"),
        Err((e, s)) => assert_eq!((e.code, s), (code, seq), "{e}"),
    }
}

// ------------------------------------------------------------------------------- valid streams

#[test]
fn a_nested_viewport_with_a_shared_canvas_resolves() {
    // Canvas 3 sits on the root (attached, layer 0) and on viewport 2, nested in viewport 1.
    let mut t1 = base(1);
    t1.canvases = format!("[{},{},{}]", ROOT, canvas(2, false, "[]"), canvas(3, true, "[]").replace("\"layer\":0", "\"layer\":1"));
    t1.n_canvases = 3;
    t1 = t1
        .textures(&[image(1), unsupported_image(2), vtex(3, 1), vtex(4, 2)])
        .viewports(
            &[vp(1, "0", "[[2,0,0]]", 0), vp(2, "1", "[[2,0,0],[3,1,0]]", 12)],
            30,
        );
    t1.vp_values = (0..30).map(|i| i as f32).collect();
    let v = ok(&[t1.clone()]);
    let st = v.state();
    assert_eq!(st.viewports.len(), 2);
    let v2 = &st.viewports[&2];
    assert_eq!(v2.parent, Some(1));
    assert_eq!(v2.global_xform, [12., 13., 14., 15., 16., 17.]);
    assert_eq!(v2.canvas_xforms, vec![[18., 19., 20., 21., 22., 23.], [24., 25., 26., 27., 28., 29.]]);
    // The resolved form: "viewports" last, floats grouped, `f` dropped; textures carry their
    // kind key.
    let json = crate::canon::transaction_json(st);
    let at = json.find(",\"viewports\":[{\"id\":1,\"origin\":\"created\",\"parent\":0,").unwrap();
    assert!(json[at..].contains("\"canvases\":[[2,0,0],[3,1,0]],\"floats\":{\"global_xform\":[12,13,14,15,16,17],\"canvas_xforms\":[[18,19,20,21,22,23],[24,25,26,27,28,29]]}}]}}"), "{json}");
    assert!(!json[at..].contains("\"f\":"));
    assert!(json.contains("\"variants\":[],\"viewport\":2,\"canvas\":null"));
    // A patch that moves one float lists only that viewport; its removal frees its texture.
    let mut t2 = Tx::patch(2).viewports(&[vp(1, "0", "[[2,0,0]]", 0)], 12);
    t2.vp_values = vec![9.0];
    let mut t3 = Tx::patch(3).textures(&[bare(4, "viewport", "freed", "null", "\"viewport\":2,")]);
    t3.vp = ",\"removed_viewports\":[2]".into();
    let v = ok(&[t1, t2, t3]);
    assert_eq!(v.state().viewports[&1].global_xform[0], 9.0);
    assert!(!v.state().viewports.contains_key(&2));
}

#[test]
fn a_proxy_keeps_a_freed_target_and_diffuse_may_name_a_proxy() {
    let t1 = base(1).textures(&[
        image(1),
        unsupported_image(2),
        vtex(3, 1),
        proxy(4, 1),
        canvas_texture(5, 4),
        canvas_texture(6, 3),
        bare(7, "proxy", "unsupported", "\"proxy-unresolved\"", "\"target\":null,"),
    ]);
    let freed = "{\"id\":1,\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"image\",\"status\":\"freed\",\"reason\":null,\"version\":1,\"hash\":null,\"format\":null,\"source_format\":null,\"width\":0,\"height\":0,\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],\"canvas\":null}";
    let t2 = Tx::patch(2).textures(&[freed.to_string()]);
    let v = ok(&[t1, t2]);
    assert_eq!(v.state().textures[&4].target, Some(1));
    // A freed proxy's target is not checked.
    let t2 = Tx::patch(2).textures(&[bare(4, "proxy", "freed", "null", "\"target\":99,")]);
    let t1 = base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), proxy(4, 1)]);
    ok(&[t1, t2]);
}

#[test]
fn an_adopted_viewport_texture_is_current() {
    let adopted = vtex(3, 1).replace(
        "\"origin\":\"created\",\"adopted_content\":null",
        "\"origin\":\"adopted\",\"adopted_content\":\"current\"",
    );
    ok(&[base(1).textures(&[image(1), unsupported_image(2), adopted.clone()])]);
    // adoption-entry: "creation" on a viewport texture.
    let creation = adopted.replace("\"current\"", "\"creation\"");
    fails(&[base(1).textures(&[image(1), unsupported_image(2), creation])], "adoption-entry", 1);
    // adoption-entry: an adopted viewport in a session without adoption.
    let t = base(1).viewports(&[vp(1, "0", "[[2,0,0]]", 0).replace("\"created\"", "\"adopted\"")], 12);
    let got = run_at(16, session(16, Some("on"), false), &[t]).err().expect("fails");
    assert_eq!(got.0.code, "adoption-entry", "{}", got.0);
}

// ------------------------------------------------------------------------------- meta-schema

#[test]
fn every_16_addition_is_meta_schema_below_16() {
    let s15 = || session(15, None, true);
    let schema = |txs: &[Tx]| {
        let got = run_at(15, s15(), txs).err().expect("rejected at /15");
        assert_eq!(got.0.code, "meta-schema", "{}", got.0);
    };
    // The plain /15 stream is valid.
    run_at(15, s15(), &[Tx::full(1).textures(&[image(1)])]).map_err(|e| e.0.to_string()).unwrap();
    // A viewport table (and its block).
    schema(&[base(1)]);
    // A viewport or proxy texture, a proxy-unresolved reason.
    schema(&[Tx::full(1).textures(&[vtex(3, 1)])]);
    schema(&[Tx::full(1).textures(&[proxy(3, 1)])]);
    schema(&[Tx::full(1).textures(&[unsupported_image(2).replace("unsupported-format", "proxy-unresolved")])]);
    // A viewport_f32 block alone.
    let mut t = Tx::full(1);
    t.vp_floats = Some(6);
    schema(&[t]);
    // A viewport-* session reason.
    let mut t = Tx::full(1);
    t.unsupported = "[{\"op\":\"viewport_attach_camera\",\"item\":null,\"reason\":\"viewport-3d\"}]".into();
    schema(&[t]);
    // A /15 session carrying "viewports".
    let got = run_at(15, session(15, Some("on"), true), &[]).err().expect("rejected");
    assert_eq!(got.0.code, "meta-schema");
    // A /16 file is not a /15 one.
    let data = recording(16, session(16, Some("on"), true), &[base(1)]);
    crate::validate::validate_recording(&data, Options::new(16)).unwrap();
    let e = crate::validate::validate_recording(&data, Options::new(15)).unwrap_err();
    assert_eq!(e.code, "bad-magic");
}

#[test]
fn every_16_addition_is_meta_schema_unless_viewports_is_on() {
    for mode in ["off", "unavailable"] {
        let s = || session(16, Some(mode), true);
        let schema = |txs: &[Tx]| {
            let got = run_at(16, s(), txs).err().expect("rejected");
            assert_eq!(got.0.code, "meta-schema", "{mode}: {}", got.0);
        };
        run_at(16, s(), &[Tx::full(1).textures(&[image(1)])]).map_err(|e| e.0.to_string()).unwrap();
        schema(&[base(1)]);
        schema(&[Tx::full(1).textures(&[proxy(3, 1)])]);
        let mut t = Tx::full(1);
        t.unsupported = "[{\"op\":\"viewport_set_msaa_2d\",\"item\":null,\"reason\":\"viewport-msaa-2d\"}]".into();
        schema(&[t]);
        // non-root-viewport stays /15's typing under off.
        let mut t = Tx::full(1);
        t.unsupported = "[{\"op\":\"viewport_attach_canvas\",\"item\":null,\"reason\":\"non-root-viewport\"}]".into();
        run_at(16, s(), &[t]).map_err(|e| e.0.to_string()).unwrap();
    }
    // A missing or misspelled session key.
    for s in [session(16, None, true), session(16, Some("yes"), true)] {
        let e = Validator::new(&s, 8, Options::new(16)).err().expect("rejected");
        assert_eq!(e.code, "meta-schema");
    }
}

#[test]
fn viewport_keys_and_kind_keys_are_schema() {
    // An empty table or removed list is the absent key.
    let mut t = base(1);
    t.vp = ",\"viewports\":[]".into();
    t.vp_floats = None;
    fails(&[t], "meta-schema", 1);
    let mut t = Tx::patch(2);
    t.vp = ",\"removed_viewports\":[]".into();
    fails(&[base(1), t], "meta-schema", 2);
    // Key order: the table before removed_viewports, and an entry's keys out of order.
    let mut t = Tx::patch(2).viewports(&[vp(1, "0", "[[2,0,0]]", 0)], 12);
    t.vp = format!("{},\"removed_viewports\":[1]", t.vp);
    fails(&[base(1), t], "meta-schema", 2);
    let swapped = vp(1, "0", "[[2,0,0]]", 0).replace("\"active\":true,\"active_seq\":1", "\"active_seq\":1,\"active\":true");
    fails(&[base(1).viewports(&[swapped], 12)], "meta-schema", 1);
    // A kind key on another kind, or missing on its kind, or with size_override.
    let img = image(1).replace("\"variants\":[],", "\"variants\":[],\"viewport\":1,");
    fails(&[base(1).textures(&[img, unsupported_image(2), vtex(3, 1)])], "meta-schema", 1);
    let nokey = vtex(3, 1).replace("\"viewport\":1,", "");
    fails(&[base(1).textures(&[image(1), unsupported_image(2), nokey])], "meta-schema", 1);
    let so = vtex(3, 1).replace("\"viewport\":1,", "\"size_override\":[2,2],\"viewport\":1,");
    fails(&[base(1).textures(&[image(1), unsupported_image(2), so])], "meta-schema", 1);
    let target = bare(4, "proxy", "ok", "null", "\"viewport\":1,");
    fails(&[base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), target])], "meta-schema", 1);
}

// ------------------------------------------------------------------------------- codes

#[test]
fn viewport_offset() {
    let mut wrong = base(1);
    wrong.vp = format!(",\"viewports\":[{}]", vp(1, "0", "[[2,0,0]]", 6));
    fails(&[wrong], "viewport-offset", 1);
    let mut missing = base(1);
    missing.vp_floats = None;
    fails(&[missing], "viewport-offset", 1);
    let mut stray = Tx::patch(2);
    stray.vp_floats = Some(6);
    fails(&[base(1), stray], "viewport-offset", 2);
    let mut count = base(1);
    count.vp_floats = Some(6);
    fails(&[count], "viewport-offset", 1);
}

#[test]
fn viewport_entry() {
    let tex = |extra: &[String]| {
        let mut t = vec![image(1), unsupported_image(2), vtex(3, 1)];
        t.extend_from_slice(extra);
        t
    };
    let one = |v: String| base(1).viewports(&[v], 12);
    // Values: an enum, a range, a default filter.
    fails(&[one(vp(1, "0", "[[2,0,0]]", 0).replace("\"always\",\"once_seq\"", "\"sometimes\",\"once_seq\""))], "viewport-entry", 1);
    fails(&[one(vp(1, "0", "[[2,0,0]]", 0).replace("\"msaa_2d\":0", "\"msaa_2d\":4"))], "viewport-entry", 1);
    fails(&[one(vp(1, "0", "[[2,0,0]]", 0).replace("\"linear\"", "\"default\""))], "viewport-entry", 1);
    fails(&[one(vp(1, "0", "[[2,0,0]]", 0).replace("\"size\":[32,32]", "\"size\":[-1,32]"))], "viewport-entry", 1);
    // Order of the table.
    let two = base(1)
        .textures(&tex(&[vtex(4, 2)]))
        .viewports(&[vp(2, "0", "[]", 0), vp(1, "0", "[[2,0,0]]", 6)], 18);
    fails(&[two], "viewport-entry", 1);
    // Rows: not ascending, or naming no canvas.
    let mut rows = base(1).viewports(&[vp(1, "0", "[[2,0,0],[1,0,0]]", 0)], 18);
    rows = rows.textures(&tex(&[]));
    fails(&[rows], "viewport-entry", 1);
    fails(&[one(vp(1, "0", "[[7,0,0]]", 0))], "viewport-entry", 1);
    // A removed canvas leaves a row dangling.
    let mut t2 = Tx::patch(2);
    t2.removed_canvases = "[2]".into();
    fails(&[base(1), t2], "viewport-entry", 2);
    // Parent: neither null, 0 nor a viewport.
    fails(&[one(vp(1, "5", "[[2,0,0]]", 0))], "viewport-entry", 1);
    ok(&[one(vp(1, "null", "[[2,0,0]]", 0))]);
    // Exactly one ok viewport texture per viewport.
    fails(&[base(1).textures(&[image(1), unsupported_image(2)])], "viewport-entry", 1);
    fails(&[base(1).textures(&tex(&[vtex(4, 1)]))], "viewport-entry", 1);
    // Freeing the texture while the viewport stays.
    let t2 = Tx::patch(2).textures(&[bare(3, "viewport", "freed", "null", "\"viewport\":1,")]);
    fails(&[base(1), t2], "viewport-entry", 2);
}

#[test]
fn viewport_parent_cycle() {
    let tex = vec![image(1), unsupported_image(2), vtex(3, 1), vtex(4, 2)];
    fails(&[base(1).viewports(&[vp(1, "1", "[[2,0,0]]", 0)], 12)], "viewport-parent-cycle", 1);
    let cycle = base(1)
        .textures(&tex)
        .viewports(&[vp(1, "2", "[[2,0,0]]", 0), vp(2, "1", "[]", 12)], 18);
    fails(&[cycle], "viewport-parent-cycle", 1);
    let chain = base(1)
        .textures(&tex)
        .viewports(&[vp(1, "0", "[[2,0,0]]", 0), vp(2, "1", "[]", 12)], 18);
    ok(&[chain]);
}

#[test]
fn proxy_target() {
    let with = |p: String| base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), p]);
    ok(&[with(proxy(4, 3))]);
    ok(&[with(proxy(4, 2))]);
    fails(&[with(bare(4, "proxy", "ok", "null", "\"target\":null,"))], "proxy-target", 1);
    fails(&[with(proxy(4, 9))], "proxy-target", 1);
    let chain = base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), proxy(4, 1), proxy(5, 4)]);
    fails(&[chain], "proxy-target", 1);
    let unsup = bare(4, "proxy", "unsupported", "\"proxy-unresolved\"", "\"target\":1,");
    fails(&[with(unsup)], "proxy-target", 1);
    // Removing the target from the table leaves the proxy dangling.
    let mut t2 = Tx::patch(2);
    t2.removed_textures = "[1]".into();
    fails(&[with(proxy(4, 1)), t2], "proxy-target", 2);
}

#[test]
fn texture_entry_for_the_new_kinds() {
    let with = |t: String| base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), t]);
    // proxy-unresolved on anything but an unsupported proxy.
    fails(&[with(unsupported_image(4).replace("unsupported-format", "proxy-unresolved"))], "texture-entry", 1);
    fails(&[with(bare(4, "proxy", "ok", "\"proxy-unresolved\"", "\"target\":1,"))], "texture-entry", 1);
    // An unsupported viewport; an unsupported proxy with another reason.
    fails(&[with(bare(4, "viewport", "unsupported", "\"proxy-unresolved\"", "\"viewport\":1,"))], "texture-entry", 1);
    fails(&[with(bare(4, "proxy", "unsupported", "\"unknown-texture\"", "\"target\":null,"))], "texture-entry", 1);
    // Payload fields on a viewport entry.
    fails(&[with(vtex(4, 1).replace("\"width\":0", "\"width\":4"))], "texture-entry", 1);
}

#[test]
fn texture_ref_for_viewports_and_diffuse() {
    // An ok viewport texture naming no viewport (and the viewport's own texture present).
    let t = base(1).textures(&[image(1), unsupported_image(2), vtex(3, 1), vtex(4, 9)]);
    fails(&[t], "texture-ref", 1);
    // Diffuse: image, placeholder, viewport, proxy yes; canvas no.
    let with = |extra: Vec<String>| {
        let mut t = vec![image(1), unsupported_image(2), vtex(3, 1)];
        t.extend(extra);
        base(1).textures(&t)
    };
    ok(&[with(vec![canvas_texture(4, 3)])]);
    ok(&[with(vec![proxy(4, 1), canvas_texture(5, 4)])]);
    fails(&[with(vec![canvas_texture(4, 1), canvas_texture(5, 4)])], "texture-ref", 1);
}

#[test]
fn unsupported_mismatch_session_reasons() {
    let with = |u: &str| {
        let mut t = base(1);
        t.unsupported = format!("[{u}]");
        t
    };
    ok(&[with("{\"op\":\"viewport_attach_camera\",\"item\":null,\"reason\":\"viewport-3d\"}")]);
    ok(&[with("{\"op\":\"viewport_set_use_hdr_2d\",\"item\":null,\"reason\":\"viewport-hdr-2d\"}")]);
    ok(&[with("{\"op\":\"viewport_set_msaa_2d\",\"item\":null,\"reason\":\"viewport-msaa-2d\"}")]);
    fails(&[with("{\"op\":\"viewport_set_msaa_2d\",\"item\":null,\"reason\":\"viewport-3d\"}")], "unsupported-mismatch", 1);
    fails(&[with("{\"op\":\"viewport_attach_camera\",\"item\":null,\"reason\":\"viewport-hdr-2d\"}")], "unsupported-mismatch", 1);
    fails(&[with("{\"op\":\"viewport_attach_canvas\",\"item\":null,\"reason\":\"non-root-viewport\"}")], "unsupported-mismatch", 1);
}

#[test]
fn derived_unsupported_texture_reads_through_an_ok_proxy() {
    let entry = "{\"op\":\"canvas_item_add_texture_rect\",\"item\":1,\"reason\":\"unsupported-texture\"}";
    let scene = |textures: Vec<String>, tex: u32, declared: bool| {
        let mut t = base(1).textures(&textures).items(&[item(1, 1, 0, tex, 0)]);
        t.canvases = format!("[{},{}]", ROOT.replace("\"items\":[]", "\"items\":[1]"), canvas(2, false, "[]"));
        if declared {
            t.unsupported = format!("[{entry}]");
        }
        t
    };
    let tex = |extra: &[String]| {
        let mut t = vec![image(1), unsupported_image(2), vtex(3, 1)];
        t.extend_from_slice(extra);
        t
    };
    // tex = an ok proxy of an unsupported entry.
    ok(&[scene(tex(&[proxy(4, 2)]), 4, true)]);
    fails(&[scene(tex(&[proxy(4, 2)]), 4, false)], "unsupported-mismatch", 1);
    // tex = an ok proxy of an ok image: nothing derived.
    ok(&[scene(tex(&[proxy(4, 1)]), 4, false)]);
    fails(&[scene(tex(&[proxy(4, 1)]), 4, true)], "unsupported-mismatch", 1);
    // tex = an ok proxy of a canvas texture whose diffuse is unsupported.
    ok(&[scene(tex(&[proxy(4, 5), canvas_texture(5, 2)]), 4, true)]);
    // tex = a canvas texture whose diffuse is an ok proxy of an unsupported entry.
    ok(&[scene(tex(&[proxy(4, 2), canvas_texture(5, 4)]), 5, true)]);
    fails(&[scene(tex(&[proxy(4, 2), canvas_texture(5, 4)]), 5, false)], "unsupported-mismatch", 1);
    // An unsupported proxy is an unsupported entry.
    let unres = bare(4, "proxy", "unsupported", "\"proxy-unresolved\"", "\"target\":null,");
    ok(&[scene(tex(&[unres]), 4, true)]);
    // Re-pointing a proxy in a patch that leaves the item alone moves the derived entry.
    let t1 = scene(tex(&[proxy(4, 1), canvas_texture(5, 4)]), 5, false);
    let repoint = proxy(4, 2).replace("\"version\":1", "\"version\":2");
    let mut t2 = Tx::patch(2).textures(&[repoint]);
    fails(&[t1.clone(), t2.clone()], "unsupported-mismatch", 2);
    t2.unsupported = format!("[{entry}]");
    ok(&[t1.clone(), t2.clone()]);
    // ... and its target's status change does too (proxy untouched).
    let t1 = scene(tex(&[proxy(4, 1)]), 4, false);
    let unsup1 = unsupported_image(1).replace("\"version\":1", "\"version\":2");
    let mut t2 = Tx::patch(2).textures(&[unsup1]);
    fails(&[t1.clone(), t2.clone()], "unsupported-mismatch", 2);
    t2.unsupported = format!("[{entry}]");
    ok(&[t1, t2]);
}

/// render-stream-2.md "Texture" and "Item-level unsupported entries" (unchanged through /16): a
/// freed canvas entry carries `canvas: null`, so a draw naming its tombstone derives nothing from
/// the diffuse it had, at /13 (frozen) as at /16. The host derives from the same wire state.
#[test]
fn a_freed_canvas_tombstone_names_no_diffuse() {
    let entry = "{\"op\":\"canvas_item_add_texture_rect\",\"item\":1,\"reason\":\"unsupported-texture\"}";
    let freed_ct = "{\"id\":5,\"origin\":\"created\",\"adopted_content\":null,\"kind\":\"canvas\",\"status\":\"freed\",\"reason\":null,\"version\":1,\"hash\":null,\"format\":null,\"source_format\":null,\"width\":0,\"height\":0,\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],\"canvas\":null}";
    for version in [13u8, 16] {
        let at16 = version == 16;
        let t1 = if at16 { base(1) } else { Tx::full(1) };
        let mut textures = vec![image(1), unsupported_image(2)];
        if at16 {
            textures.push(vtex(3, 1));
        }
        textures.push(canvas_texture(5, 2));
        let mut t1 = t1.textures(&textures).items(&[item(1, 1, 0, 5, 0)]);
        t1.canvases = format!("[{},{}]", ROOT.replace("\"items\":[]", "\"items\":[1]"), canvas(2, false, "[]"));
        t1.unsupported = format!("[{entry}]");
        let session = if at16 { session(16, Some("on"), true) } else { session(13, None, true) };
        // The canvas texture freed at the same version while the draw still names it.
        let mut t2 = Tx::patch(2).textures(&[freed_ct.to_string()]);
        t2.unsupported = "[]".into();
        if let Err((e, seq)) = run_at(version, session.clone(), &[t1.clone(), t2.clone()]) {
            panic!("/{version} seq {seq}: {e}");
        }
        t2.unsupported = format!("[{entry}]");
        match run_at(version, session, &[t1, t2]) {
            Ok(_) => panic!("/{version}: a derived entry through a freed canvas was accepted"),
            Err((e, s)) => assert_eq!((e.code, s), ("unsupported-mismatch", 2), "/{version}: {e}"),
        }
    }
}

#[test]
fn patch_rules_and_id_reuse_cover_viewports() {
    // patch-removed: absent from the base, or both removed and listed.
    let mut t2 = Tx::patch(2);
    t2.vp = ",\"removed_viewports\":[5]".into();
    fails(&[base(1), t2], "patch-removed", 2);
    let mut t2 = Tx::patch(2).viewports(&[vp(1, "0", "[[2,0,0]]", 0)], 12);
    t2.vp = format!(",\"removed_viewports\":[1]{}", t2.vp);
    fails(&[base(1), t2], "patch-removed", 2);
    // patch-encoding: a full transaction with removed_viewports.
    let mut t2 = base(2);
    t2.vp = format!(",\"removed_viewports\":[1]{}", t2.vp);
    fails(&[base(1), t2], "patch-encoding", 2);
    // removed_viewports strictly ascending.
    let tex = vec![image(1), unsupported_image(2), vtex(3, 1), vtex(4, 2)];
    let two = base(1).textures(&tex).viewports(&[vp(1, "0", "[[2,0,0]]", 0), vp(2, "0", "[]", 12)], 18);
    let mut t2 = Tx::patch(2).textures(&[
        bare(3, "viewport", "freed", "null", "\"viewport\":1,"),
        bare(4, "viewport", "freed", "null", "\"viewport\":2,"),
    ]);
    t2.vp = ",\"removed_viewports\":[2,1]".into();
    fails(&[two.clone(), t2.clone()], "meta-schema", 2);
    t2.vp = ",\"removed_viewports\":[1,2]".into();
    ok(&[two, t2]);
    // id-reused: viewport 1 leaves and comes back.
    let mut t2 = Tx::patch(2).textures(&[bare(3, "viewport", "freed", "null", "\"viewport\":1,")]);
    t2.vp = ",\"removed_viewports\":[1]".into();
    let t3 = Tx::patch(3)
        .textures(&[vtex(4, 1)])
        .viewports(&[vp(1, "0", "[[2,0,0]]", 0)], 12);
    fails(&[base(1), t2, t3], "id-reused", 3);
}

#[test]
fn a_failed_viewport_transaction_leaves_the_state_untouched() {
    let mut v = ok(&[base(1)]);
    let before = v.state().clone();
    let bad = Tx::patch(2).viewports(&[vp(1, "7", "[[2,0,0]]", 0)], 12);
    let r = bad.record();
    assert!(v.accept(&r, 100_000).is_err());
    assert_eq!(*v.state(), before);
}

// ------------------------------------------------------------------------------- restamp

#[test]
fn restamp_across_16_moves_the_session_key_and_the_end_stats() {
    for lane in ["full", "patch", "inline", "predict", "hints"] {
        let d15 = golden(&format!("golden-15/{lane}.rs15"));
        let d16 = golden(&format!("golden-16/{lane}.rs16"));
        let up = crate::item_meta::restamp(&d15, 15, 16).unwrap();
        assert!(up == d16, "{lane}.rs15 re-stamped /16 differs from {lane}.rs16");
        let down = crate::item_meta::restamp(&d16, 16, 15).unwrap();
        assert!(down == d15, "{lane}.rs16 re-stamped /15 differs from {lane}.rs15");
        if lane != "hints" {
            let d13 = crate::item_meta::restamp(&d16, 16, 13).unwrap();
            crate::validate::validate_recording(&d13, Options::new(13)).unwrap();
        }
    }
    // The session's viewports value goes whatever it is.
    let data = recording(16, session(16, Some("off"), true), &[Tx::full(1).textures(&[image(1)])]);
    let d15 = crate::item_meta::restamp(&data, 16, 15).unwrap();
    crate::validate::validate_recording(&d15, Options::new(15)).unwrap();
}

#[test]
fn v18_credit_window_goldens() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-18");
    let index: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("index.json")).unwrap()).unwrap();
    for entry in index["valid"].as_array().unwrap() {
        let file = entry["file"].as_str().unwrap();
        let data = std::fs::read(dir.join(file)).unwrap();
        crate::validate::validate_recording(&data, Options::new(18))
            .unwrap_or_else(|e| panic!("{file}: {e}"));
        assert_eq!(wire::version_of_magic(&data), Some(18));
    }
    for entry in index["invalid"].as_array().unwrap() {
        let file = entry["file"].as_str().unwrap();
        let data = std::fs::read(dir.join(file)).unwrap();
        let options = Options::new(entry["version"].as_u64().unwrap() as u8);
        let error = crate::validate::validate_recording(&data, options).unwrap_err();
        assert_eq!(
            error.code,
            entry["code"].as_str().unwrap(),
            "{file}: {error}"
        );
    }
}
