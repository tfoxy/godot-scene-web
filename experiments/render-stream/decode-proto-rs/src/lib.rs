//! Receiver decode profile (2026-10-14): a Rust COST PROTOTYPE of what `Rs2Decoder.decode_record` +
//! `Stream.accept` do per render-stream/6 transaction (receiver/rs2_decoder.gd), to price a shared
//! Rust core natively and as wasm. It is not a decoder: it covers the work, not every rule, and
//! nothing reads its output.
//!
//! Per transaction, in the GDScript order and with the GDScript's data volume:
//!   frame         record framing (lengths, block spans)
//!   record_sha256 SHA-256 of the whole record (decode_record's `sha256`)
//!   meta_ascii    the printable-ASCII rule over the meta bytes
//!   json_parse    serde_json into an order-preserving Value (key order is part of the schema)
//!   schema        Schema.transaction's checks: exact key order of every object, every field's
//!                 type/range/enum, per command op (paths are static labels, built on failure only)
//!   blocks        little-endian f32/i32/f64 blocks into Vecs
//!   lift_resolve  offset walks, block-length checks, lifting into flat structs (each command's
//!                 floats copied into its own Vec, triangle indices too) and patch resolution
//!   invariants    _check_resolved_invariants's walks over the whole resolved state: root canvas,
//!                 dangling parents, child lists, parent cycles, texture/mesh refs, draw-index
//!                 ties, derived unsupported entries against the declared ones
//!   rest          texture-version, id-reused and the known-id rebuild
//!
//! Not ported: session/resource/end records (not timed), shader/material/param tables (empty on
//! gate6-scene), resource-missing/-payload (out-of-band recording: no inline resources).

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub const STAGES: [&str; 9] = [
    "frame",
    "record_sha256",
    "meta_ascii",
    "json_parse",
    "schema",
    "blocks",
    "lift_resolve",
    "invariants",
    "rest",
];

type Obj = Map<String, Value>;

const TRANSACTION_KEYS: &[&str] = &[
    "type",
    "seq",
    "frame",
    "encoding",
    "base_seq",
    "status",
    "failures",
    "unsupported",
    "default_texture_filter",
    "default_texture_repeat",
    "removed_canvases",
    "removed_items",
    "removed_textures",
    "removed_meshes",
    "removed_shaders",
    "removed_materials",
    "canvases",
    "items",
    "textures",
    "meshes",
    "shaders",
    "materials",
    "blocks",
];
const CANVAS_KEYS: &[&str] = &[
    "id", "origin", "role", "attached", "layer", "sublayer", "items",
];
const ITEM_KEYS: &[&str] = &[
    "id",
    "origin",
    "parent",
    "children",
    "visible",
    "draw_index",
    "z_index",
    "z_relative",
    "behind",
    "clip",
    "custom_rect",
    "visibility_layer",
    "texture_filter",
    "texture_repeat",
    "material",
    "use_parent_material",
    "instance_params",
    "content_version",
    "commands",
];
const PARENT_KEYS: &[&str] = &["kind", "id"];
const TEXTURE_KEYS: &[&str] = &[
    "id",
    "origin",
    "kind",
    "status",
    "reason",
    "version",
    "hash",
    "format",
    "width",
    "height",
    "mipmaps",
    "payload_bytes",
    "canvas",
];
const MESH_KEYS: &[&str] = &[
    "id", "origin", "status", "reason", "version", "f", "surfaces",
];
const MESH_SURFACE_KEYS: &[&str] = &[
    "hash",
    "payload_bytes",
    "primitive",
    "format",
    "vertex_count",
    "index_count",
];
const UNSUPPORTED_KEYS: &[&str] = &["op", "item", "reason"];
const BLOCK_KEYS: &[&str] = &["name", "type", "count"];
const BLOCK_NAMES: &[&str] = &[
    "item_f32",
    "canvas_f32",
    "cmd_f32",
    "cmd_i32",
    "mesh_f32",
    "param_f64",
];
const BLOCK_TYPES: &[&str] = &["f32", "f32", "f32", "i32", "f32", "f64"];
const ORIGINS: &[&str] = &["created", "root-query", "adopted"];
const ENCODINGS: &[&str] = &["full", "patch"];
const STATUSES: &[&str] = &["ok", "capture-failure"];
const FILTERS: &[&str] = &[
    "default",
    "nearest",
    "linear",
    "nearest_mipmaps",
    "linear_mipmaps",
    "nearest_mipmaps_anisotropic",
    "linear_mipmaps_anisotropic",
];
const REPEATS: &[&str] = &["default", "disabled", "enabled", "mirror"];
const PARENT_KINDS: &[&str] = &["canvas", "item"];
const AXIS: &[&str] = &["stretch", "tile", "tile_fit"];
const MAX_SAFE: f64 = 9007199254740991.0;

// Command op codes.
const RECT: u8 = 0;
const TEX_RECT: u8 = 1;
const TEX_REGION: u8 = 2;
const MSDF: u8 = 3;
const LINE: u8 = 4;
const POLYLINE: u8 = 5;
const MULTILINE: u8 = 6;
const CIRCLE: u8 = 7;
const PRIMITIVE: u8 = 8;
const POLYGON: u8 = 9;
const TRIANGLES: u8 = 10;
const NINE_PATCH: u8 = 11;
const MESH: u8 = 12;
const SET_TRANSFORM: u8 = 13;
const CLIP_IGNORE: u8 = 14;
const UNSUPPORTED: u8 = 15;

fn op_code(op: &str) -> Option<u8> {
    Some(match op {
        "add_rect" => RECT,
        "add_texture_rect" => TEX_RECT,
        "add_texture_rect_region" => TEX_REGION,
        "add_msdf_texture_rect_region" => MSDF,
        "add_line" => LINE,
        "add_polyline" => POLYLINE,
        "add_multiline" => MULTILINE,
        "add_circle" => CIRCLE,
        "add_primitive" => PRIMITIVE,
        "add_polygon" => POLYGON,
        "add_triangle_array" => TRIANGLES,
        "add_nine_patch" => NINE_PATCH,
        "add_mesh" => MESH,
        "add_set_transform" => SET_TRANSFORM,
        "add_clip_ignore" => CLIP_IGNORE,
        "unsupported" => UNSUPPORTED,
        _ => return None,
    })
}

fn tex_bearing(op: u8) -> bool {
    matches!(
        op,
        TEX_RECT | TEX_REGION | MSDF | PRIMITIVE | POLYGON | TRIANGLES | NINE_PATCH | MESH
    )
}

// ------------------------------------------------------------------------------------- schema

struct Check {
    ok: bool,
    first: String,
}

impl Check {
    fn fail(&mut self, what: &str) {
        if self.ok {
            self.ok = false;
            self.first = what.to_string();
        }
    }
    fn object<'a>(&mut self, v: &'a Value, keys: &[&str], what: &str) -> Option<&'a Obj> {
        match v.as_object() {
            Some(o) if o.len() == keys.len() && o.keys().zip(keys).all(|(a, b)| a == b) => Some(o),
            _ => {
                self.fail(what);
                None
            }
        }
    }
    fn int(&mut self, v: Option<&Value>, lo: f64, hi: f64, what: &str) -> i64 {
        let n = match v {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        };
        if !(n.is_finite() && n == n.floor() && n.abs() <= MAX_SAFE && n >= lo && n <= hi) {
            self.fail(what);
            return 0;
        }
        n as i64
    }
    fn nullable_int(&mut self, v: Option<&Value>, lo: f64, hi: f64, what: &str) {
        if !matches!(v, Some(Value::Null)) {
            self.int(v, lo, hi, what);
        }
    }
    fn boolean(&mut self, v: Option<&Value>, what: &str) -> bool {
        match v {
            Some(Value::Bool(b)) => *b,
            _ => {
                self.fail(what);
                false
            }
        }
    }
    fn string<'a>(&mut self, v: Option<&'a Value>, what: &str) -> &'a str {
        match v {
            Some(Value::String(s)) => s.as_str(),
            _ => {
                self.fail(what);
                ""
            }
        }
    }
    fn one_of(&mut self, v: Option<&Value>, allowed: &[&str], what: &str) {
        let s = self.string(v, what);
        if self.ok && !allowed.contains(&s) {
            self.fail(what);
        }
    }
    fn array<'a>(&mut self, v: Option<&'a Value>, what: &str) -> &'a [Value] {
        match v {
            Some(Value::Array(a)) => a.as_slice(),
            _ => {
                self.fail(what);
                &[]
            }
        }
    }
    fn int_list(&mut self, v: Option<&Value>, what: &str) {
        for x in self.array(v, what) {
            self.int(Some(x), 1.0, MAX_SAFE, what);
        }
    }
    fn tex(&mut self, c: &Obj) {
        if !matches!(c.get("tex"), Some(Value::Null)) {
            self.int(c.get("tex"), 1.0, MAX_SAFE, "tex");
        }
    }
}

fn schema_command(ck: &mut Check, v: &Value) {
    let Some(c) = v.as_object() else {
        return ck.fail("command is not an object");
    };
    let op = c.get("op").and_then(Value::as_str).unwrap_or("");
    let f = |ck: &mut Check| {
        ck.int(c.get("f"), 0.0, MAX_SAFE, "f");
    };
    match op {
        "add_rect" | "add_line" | "add_circle" => {
            ck.object(v, &["op", "aa", "f"], "rect keys");
            ck.boolean(c.get("aa"), "aa");
            f(ck);
        }
        "add_texture_rect" => {
            ck.object(v, &["op", "tex", "tile", "transpose", "f"], "keys");
            ck.tex(c);
            ck.boolean(c.get("tile"), "tile");
            ck.boolean(c.get("transpose"), "transpose");
            f(ck);
        }
        "add_texture_rect_region" => {
            ck.object(v, &["op", "tex", "transpose", "clip_uv", "f"], "keys");
            ck.tex(c);
            ck.boolean(c.get("transpose"), "transpose");
            ck.boolean(c.get("clip_uv"), "clip_uv");
            f(ck);
        }
        "add_msdf_texture_rect_region" => {
            ck.object(v, &["op", "tex", "outline", "f"], "keys");
            ck.tex(c);
            ck.int(c.get("outline"), 0.0, MAX_SAFE, "outline");
            f(ck);
        }
        "add_polyline" | "add_multiline" => {
            ck.object(v, &["op", "aa", "n", "colors", "f"], "keys");
            ck.boolean(c.get("aa"), "aa");
            ck.int(c.get("n"), 0.0, MAX_SAFE, "n");
            ck.int(c.get("colors"), 0.0, MAX_SAFE, "colors");
            f(ck);
        }
        "add_primitive" | "add_polygon" => {
            ck.object(v, &["op", "tex", "n", "colors", "uvs", "f"], "keys");
            ck.tex(c);
            ck.int(c.get("n"), 0.0, MAX_SAFE, "n");
            ck.int(c.get("colors"), 0.0, MAX_SAFE, "colors");
            ck.int(c.get("uvs"), 0.0, MAX_SAFE, "uvs");
            f(ck);
        }
        "add_triangle_array" => {
            ck.object(
                v,
                &[
                    "op", "tex", "n", "colors", "uvs", "indices", "count", "i", "f",
                ],
                "keys",
            );
            ck.tex(c);
            for k in ["n", "colors", "uvs", "indices", "i"] {
                ck.int(c.get(k), 0.0, MAX_SAFE, k);
            }
            ck.int(c.get("count"), -MAX_SAFE, MAX_SAFE, "count");
            f(ck);
        }
        "add_nine_patch" => {
            ck.object(
                v,
                &["op", "tex", "x_axis", "y_axis", "draw_center", "f"],
                "keys",
            );
            ck.tex(c);
            ck.one_of(c.get("x_axis"), AXIS, "x_axis");
            ck.one_of(c.get("y_axis"), AXIS, "y_axis");
            ck.boolean(c.get("draw_center"), "draw_center");
            f(ck);
        }
        "add_mesh" => {
            ck.object(v, &["op", "mesh", "tex", "f"], "keys");
            ck.int(c.get("mesh"), 1.0, MAX_SAFE, "mesh");
            ck.tex(c);
            f(ck);
        }
        "add_set_transform" => {
            ck.object(v, &["op", "f"], "keys");
            f(ck);
        }
        "add_clip_ignore" => {
            ck.object(v, &["op", "ignore"], "keys");
            ck.boolean(c.get("ignore"), "ignore");
        }
        "unsupported" => {
            ck.object(v, &["op", "name", "reason"], "keys");
            ck.string(c.get("name"), "name");
            ck.string(c.get("reason"), "reason");
        }
        _ => ck.fail("unknown op"),
    }
}

fn schema_transaction(ck: &mut Check, meta: &Value) {
    let Some(m) = ck.object(meta, TRANSACTION_KEYS, "meta keys") else {
        return;
    };
    ck.int(m.get("seq"), 1.0, MAX_SAFE, "seq");
    ck.int(m.get("frame"), 1.0, MAX_SAFE, "frame");
    ck.one_of(m.get("encoding"), ENCODINGS, "encoding");
    ck.nullable_int(m.get("base_seq"), 1.0, MAX_SAFE, "base_seq");
    ck.one_of(m.get("status"), STATUSES, "status");
    for f in ck.array(m.get("failures"), "failures") {
        if let Some(o) = ck.object(f, &["reason", "detail"], "failure") {
            ck.string(o.get("reason"), "reason");
            ck.string(o.get("detail"), "detail");
        }
    }
    for u in ck.array(m.get("unsupported"), "unsupported") {
        if let Some(o) = ck.object(u, UNSUPPORTED_KEYS, "unsupported entry") {
            ck.string(o.get("op"), "op");
            ck.nullable_int(o.get("item"), 1.0, MAX_SAFE, "item");
            ck.string(o.get("reason"), "reason");
        }
    }
    ck.one_of(m.get("default_texture_filter"), FILTERS, "filter");
    ck.one_of(m.get("default_texture_repeat"), REPEATS, "repeat");
    for k in [
        "removed_canvases",
        "removed_items",
        "removed_textures",
        "removed_meshes",
        "removed_shaders",
        "removed_materials",
    ] {
        ck.int_list(m.get(k), k);
    }
    for c in ck.array(m.get("canvases"), "canvases") {
        let Some(o) = ck.object(c, CANVAS_KEYS, "canvas keys") else {
            continue;
        };
        ck.int(o.get("id"), 1.0, MAX_SAFE, "canvas id");
        ck.one_of(o.get("origin"), ORIGINS, "origin");
        if !matches!(o.get("role"), Some(Value::Null)) {
            ck.one_of(o.get("role"), &["root"], "role");
        }
        ck.boolean(o.get("attached"), "attached");
        ck.int(o.get("layer"), -MAX_SAFE, MAX_SAFE, "layer");
        ck.int(o.get("sublayer"), -MAX_SAFE, MAX_SAFE, "sublayer");
        ck.int_list(o.get("items"), "canvas items");
    }
    for it in ck.array(m.get("items"), "items") {
        let Some(o) = ck.object(it, ITEM_KEYS, "item keys") else {
            continue;
        };
        ck.int(o.get("id"), 1.0, MAX_SAFE, "item id");
        ck.one_of(o.get("origin"), ORIGINS, "origin");
        if let Some(p) = o.get("parent").filter(|p| !p.is_null()) {
            if let Some(po) = ck.object(p, PARENT_KEYS, "parent") {
                ck.one_of(po.get("kind"), PARENT_KINDS, "parent kind");
                ck.int(po.get("id"), 1.0, MAX_SAFE, "parent id");
            }
        }
        ck.int_list(o.get("children"), "children");
        ck.boolean(o.get("visible"), "visible");
        ck.int(o.get("draw_index"), -MAX_SAFE, MAX_SAFE, "draw_index");
        ck.int(o.get("z_index"), -MAX_SAFE, MAX_SAFE, "z_index");
        for k in ["z_relative", "behind", "clip", "custom_rect"] {
            ck.boolean(o.get(k), k);
        }
        ck.int(
            o.get("visibility_layer"),
            0.0,
            4294967295.0,
            "visibility_layer",
        );
        ck.one_of(o.get("texture_filter"), FILTERS, "texture_filter");
        ck.one_of(o.get("texture_repeat"), REPEATS, "texture_repeat");
        ck.nullable_int(o.get("material"), 1.0, MAX_SAFE, "material");
        ck.boolean(o.get("use_parent_material"), "use_parent_material");
        ck.array(o.get("instance_params"), "instance_params");
        ck.int(o.get("content_version"), 0.0, MAX_SAFE, "content_version");
        if let Some(cmds) = o.get("commands").filter(|c| !c.is_null()) {
            for c in ck.array(Some(cmds), "commands") {
                schema_command(ck, c);
            }
        }
    }
    for t in ck.array(m.get("textures"), "textures") {
        let Some(o) = ck.object(t, TEXTURE_KEYS, "texture keys") else {
            continue;
        };
        ck.int(o.get("id"), 1.0, MAX_SAFE, "texture id");
        ck.one_of(o.get("origin"), ORIGINS, "origin");
        ck.one_of(o.get("kind"), &["image", "placeholder", "canvas"], "kind");
        ck.string(o.get("status"), "status");
        ck.int(o.get("version"), 0.0, MAX_SAFE, "version");
    }
    for me in ck.array(m.get("meshes"), "meshes") {
        let Some(o) = ck.object(me, MESH_KEYS, "mesh keys") else {
            continue;
        };
        ck.int(o.get("id"), 1.0, MAX_SAFE, "mesh id");
        ck.string(o.get("status"), "status");
        ck.int(o.get("version"), 0.0, MAX_SAFE, "version");
        for s in ck.array(o.get("surfaces"), "surfaces") {
            if let Some(so) = ck.object(s, MESH_SURFACE_KEYS, "surface keys") {
                ck.string(so.get("hash"), "hash");
                ck.int(so.get("payload_bytes"), 0.0, MAX_SAFE, "payload_bytes");
            }
        }
    }
    ck.array(m.get("shaders"), "shaders");
    ck.array(m.get("materials"), "materials");
    let blocks = ck.array(m.get("blocks"), "blocks");
    if blocks.len() != BLOCK_NAMES.len() {
        ck.fail("block count");
    }
    for (i, b) in blocks.iter().enumerate() {
        if let Some(o) = ck.object(b, BLOCK_KEYS, "block keys") {
            if o.get("name").and_then(Value::as_str) != BLOCK_NAMES.get(i).copied()
                || o.get("type").and_then(Value::as_str) != BLOCK_TYPES.get(i).copied()
            {
                ck.fail("block name/type");
            }
            ck.int(o.get("count"), 0.0, 4294967295.0, "count");
        }
    }
}

// ------------------------------------------------------------------------------------- resolved state

#[derive(Clone)]
pub struct Cmd {
    pub op: u8,
    pub tex: Option<u32>,
    pub mesh: Option<u32>,
    pub floats: Vec<f32>,
    pub ints: Vec<i32>,
    pub unsupported_name: Option<String>,
}

pub struct Item {
    pub parent: Option<(bool, u32)>, // (is_item, id)
    pub children: Vec<u32>,
    pub visible: bool,
    pub draw_index: i64,
    pub content_version: i64,
    pub floats: [f32; 18],
    pub commands: Rc<Vec<Cmd>>,
}

pub struct Canvas {
    pub root: bool,
    pub attached: bool,
    pub layer: i64,
    pub sublayer: i64,
    pub items: Vec<u32>,
    pub floats: [f32; 10],
}

pub struct Texture {
    pub kind: u8, // 0 image, 1 placeholder, 2 canvas
    pub unsupported: bool,
    pub diffuse: Option<u32>,
    pub entry: Value,
}

#[derive(Default)]
pub struct State {
    pub canvases: HashMap<u32, Canvas>,
    pub items: HashMap<u32, Item>,
    pub textures: HashMap<u32, Texture>,
    pub meshes: HashMap<u32, bool>, // id -> unsupported
    last_seq: i64,
    last_frame: i64,
    last_seen_texture: HashMap<u32, Value>,
    known: [HashSet<u32>; 4],
    max_id: [u32; 4],
}

fn u(v: &Value) -> u32 {
    v.as_f64().unwrap_or(0.0) as u32
}
fn i(v: &Value) -> i64 {
    v.as_f64().unwrap_or(0.0) as i64
}
fn ids(v: &Value) -> Vec<u32> {
    v.as_array()
        .map(|a| a.iter().map(u).collect())
        .unwrap_or_default()
}

fn float_count(op: u8, c: &Obj) -> usize {
    let g = |k: &str| c.get(k).map(u).unwrap_or(0) as usize;
    match op {
        RECT | TEX_RECT => 8,
        TEX_REGION => 12,
        MSDF => 14,
        LINE => 9,
        POLYLINE | MULTILINE => 1 + 2 * g("n") + 4 * g("colors"),
        CIRCLE => 7,
        PRIMITIVE | POLYGON | TRIANGLES => 2 * g("n") + 4 * g("colors") + 2 * g("uvs"),
        NINE_PATCH => 16,
        MESH => 10,
        SET_TRANSFORM => 6,
        _ => 0,
    }
}

fn opt_id(v: Option<&Value>) -> Option<u32> {
    v.filter(|x| !x.is_null()).map(u)
}

/// Offset walks, block checks, lift and patch resolution (`lift_resolve`).
fn resolve(
    st: &mut State,
    m: &Obj,
    blocks: &[Vec<f32>; 3],
    cmd_i32: &[i32],
    mesh_count: usize,
) -> Result<(), String> {
    let seq = i(&m["seq"]);
    let frame = i(&m["frame"]);
    if seq != st.last_seq + 1 {
        return Err(format!("seq-gap at {seq}"));
    }
    if frame <= st.last_frame {
        return Err("frame-order".into());
    }
    let items_meta = m["items"].as_array().unwrap();
    let canvases_meta = m["canvases"].as_array().unwrap();
    let [item_f32, canvas_f32, cmd_f32] = blocks;
    // cmd-offset / cmd-int-offset / mesh-offset walks
    let (mut running, mut running_int) = (0usize, 0usize);
    for it in items_meta {
        let Some(cmds) = it["commands"].as_array() else {
            continue;
        };
        for c in cmds {
            let c = c.as_object().unwrap();
            let op = op_code(c["op"].as_str().unwrap()).unwrap();
            if op == UNSUPPORTED || op == CLIP_IGNORE {
                continue;
            }
            if u(&c["f"]) as usize != running {
                return Err("cmd-offset".into());
            }
            running += float_count(op, c);
            if op == TRIANGLES {
                if u(&c["i"]) as usize != running_int {
                    return Err("cmd-int-offset".into());
                }
                running_int += u(&c["indices"]) as usize;
            }
        }
    }
    if item_f32.len() != 18 * items_meta.len()
        || canvas_f32.len() != 10 * canvases_meta.len()
        || cmd_f32.len() != running
        || cmd_i32.len() != running_int
        || mesh_count
            != 6 * m["meshes"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|me| !me["f"].is_null())
                .count()
    {
        return Err("block-count".into());
    }
    let full = m["encoding"].as_str() == Some("full");
    if full {
        st.canvases.clear();
        st.items.clear();
        st.textures.clear();
        st.meshes.clear();
    }
    for id in ids(&m["removed_canvases"]) {
        st.canvases.remove(&id);
    }
    for id in ids(&m["removed_items"]) {
        st.items.remove(&id);
    }
    for id in ids(&m["removed_textures"]) {
        st.textures.remove(&id);
    }
    for id in ids(&m["removed_meshes"]) {
        st.meshes.remove(&id);
    }
    for (k, c) in canvases_meta.iter().enumerate() {
        let mut floats = [0f32; 10];
        floats.copy_from_slice(&canvas_f32[k * 10..k * 10 + 10]);
        st.canvases.insert(
            u(&c["id"]),
            Canvas {
                root: !c["role"].is_null(),
                attached: c["attached"].as_bool().unwrap_or(false),
                layer: i(&c["layer"]),
                sublayer: i(&c["sublayer"]),
                items: ids(&c["items"]),
                floats,
            },
        );
    }
    for (k, it) in items_meta.iter().enumerate() {
        let id = u(&it["id"]);
        let commands = match it["commands"].as_array() {
            None => match st.items.get(&id) {
                Some(base) if base.content_version == i(&it["content_version"]) => {
                    base.commands.clone()
                }
                Some(_) => return Err("patch-commands".into()),
                None => return Err("patch-commands".into()),
            },
            Some(cmds) => {
                let mut out = Vec::with_capacity(cmds.len());
                for c in cmds {
                    let c = c.as_object().unwrap();
                    let op = op_code(c["op"].as_str().unwrap()).unwrap();
                    let n = float_count(op, c);
                    let f = c.get("f").map(u).unwrap_or(0) as usize;
                    let ints = if op == TRIANGLES {
                        let at = u(&c["i"]) as usize;
                        cmd_i32[at..at + u(&c["indices"]) as usize].to_vec()
                    } else {
                        Vec::new()
                    };
                    out.push(Cmd {
                        op,
                        tex: opt_id(c.get("tex")),
                        mesh: opt_id(c.get("mesh")),
                        floats: cmd_f32[f..f + n].to_vec(),
                        ints,
                        unsupported_name: c.get("name").and_then(Value::as_str).map(str::to_string),
                    });
                }
                Rc::new(out)
            }
        };
        let mut floats = [0f32; 18];
        floats.copy_from_slice(&item_f32[k * 18..k * 18 + 18]);
        let parent = it["parent"]
            .as_object()
            .map(|p| (p["kind"].as_str() == Some("item"), u(&p["id"])));
        st.items.insert(
            id,
            Item {
                parent,
                children: ids(&it["children"]),
                visible: it["visible"].as_bool().unwrap_or(false),
                draw_index: i(&it["draw_index"]),
                content_version: i(&it["content_version"]),
                floats,
                commands,
            },
        );
    }
    for t in m["textures"].as_array().unwrap() {
        let kind = match t["kind"].as_str() {
            Some("image") => 0,
            Some("placeholder") => 1,
            _ => 2,
        };
        let diffuse = t["canvas"]
            .as_object()
            .and_then(|c| opt_id(c.get("diffuse")));
        st.textures.insert(
            u(&t["id"]),
            Texture {
                kind,
                unsupported: t["status"].as_str() == Some("unsupported"),
                diffuse,
                entry: t.clone(),
            },
        );
    }
    for me in m["meshes"].as_array().unwrap() {
        st.meshes
            .insert(u(&me["id"]), me["status"].as_str() == Some("unsupported"));
    }
    st.last_seq = seq;
    st.last_frame = frame;
    Ok(())
}

/// `_check_resolved_invariants` over the whole resolved state.
fn invariants(st: &State, unsupported_meta: &[Value]) -> Result<(), String> {
    let roots: Vec<u32> = st
        .canvases
        .iter()
        .filter(|(_, c)| c.root)
        .map(|(id, _)| *id)
        .collect();
    if roots != [1] {
        return Err("root-canvas".into());
    }
    let mut stacking: HashMap<(i64, i64), u32> = HashMap::new();
    for c in st.canvases.values().filter(|c| c.attached) {
        *stacking.entry((c.layer, c.sublayer)).or_default() += 1;
    }
    let stacking_tie = stacking.values().any(|n| *n >= 2);
    let mut claimed: HashMap<(bool, u32), Vec<u32>> = HashMap::new();
    for (id, it) in &st.items {
        if let Some((is_item, target)) = it.parent {
            let exists = if is_item {
                st.items.contains_key(&target)
            } else {
                st.canvases.contains_key(&target)
            };
            if !exists {
                return Err("dangling-parent".into());
            }
            claimed.entry((is_item, target)).or_default().push(*id);
        }
    }
    let same = |declared: &[u32], claimed: Option<&Vec<u32>>| -> bool {
        let claimed: &[u32] = claimed.map(|v| v.as_slice()).unwrap_or(&[]);
        if declared.len() != claimed.len() {
            return false;
        }
        let set: HashSet<u32> = declared.iter().copied().collect();
        set.len() == declared.len() && claimed.iter().all(|c| set.contains(c))
    };
    for (id, c) in &st.canvases {
        if !same(&c.items, claimed.get(&(false, *id))) {
            return Err("child-list-mismatch".into());
        }
    }
    for (id, it) in &st.items {
        if !same(&it.children, claimed.get(&(true, *id))) {
            return Err("child-list-mismatch".into());
        }
    }
    for id in st.items.keys() {
        let mut seen = HashSet::new();
        let mut cursor = *id;
        loop {
            if !seen.insert(cursor) {
                return Err("parent-cycle".into());
            }
            match st.items[&cursor].parent {
                Some((true, p)) => cursor = p,
                _ => break,
            }
        }
    }
    for it in st.items.values() {
        for c in it.commands.iter() {
            if tex_bearing(c.op) {
                if let Some(t) = c.tex {
                    if !st.textures.contains_key(&t) {
                        return Err("texture-ref".into());
                    }
                }
            }
            if c.op == MESH && !c.mesh.is_some_and(|m| st.meshes.contains_key(&m)) {
                return Err("mesh-ref".into());
            }
        }
    }
    for t in st.textures.values() {
        if let Some(d) = t.diffuse {
            match st.textures.get(&d) {
                Some(e) if e.kind != 2 => {}
                _ => return Err("texture-ref diffuse".into()),
            }
        }
    }
    // draw-index ties per container
    let mut expected_ties: HashSet<u32> = HashSet::new();
    let containers = st
        .canvases
        .values()
        .map(|c| &c.items)
        .chain(st.items.values().map(|i| &i.children));
    for list in containers {
        let mut by_di: HashMap<i64, Vec<u32>> = HashMap::new();
        for id in list {
            if let Some(child) = st.items.get(id) {
                by_di.entry(child.draw_index).or_default().push(*id);
            }
        }
        for group in by_di.values() {
            let drawing: Vec<u32> = group
                .iter()
                .copied()
                .filter(|id| {
                    let c = &st.items[id];
                    !c.commands.is_empty() || !c.children.is_empty()
                })
                .collect();
            if drawing.len() >= 2 {
                expected_ties.insert(*drawing.iter().min().unwrap());
            }
        }
    }
    // derived unsupported entries
    let mut actual: HashSet<(u32, String)> = HashSet::new();
    for (id, it) in &st.items {
        for c in it.commands.iter() {
            if c.op == UNSUPPORTED {
                actual.insert((*id, c.unsupported_name.clone().unwrap_or_default()));
            } else if tex_bearing(c.op) {
                if let Some(t) = c.tex.and_then(|t| st.textures.get(&t)) {
                    let via_diffuse = t
                        .diffuse
                        .and_then(|d| st.textures.get(&d))
                        .is_some_and(|d| d.unsupported);
                    if t.unsupported || via_diffuse {
                        actual.insert((*id, format!("rs:{}", c.op)));
                    }
                }
            }
            if c.op == MESH
                && c.mesh
                    .and_then(|m| st.meshes.get(&m))
                    .copied()
                    .unwrap_or(false)
            {
                actual.insert((*id, "canvas_item_add_mesh".into()));
            }
        }
    }
    let mut declared_ties = 0usize;
    let mut declared = 0usize;
    for e in unsupported_meta {
        match e["reason"].as_str() {
            Some("draw-index-tie") => declared_ties += 1,
            Some("canvas-stacking-tie") if !stacking_tie => {
                return Err("unsupported-mismatch".into())
            }
            Some(_) if !e["item"].is_null() => declared += 1,
            _ => {}
        }
    }
    if declared_ties != expected_ties.len() || declared != actual.len() {
        return Err("unsupported-mismatch".into());
    }
    Ok(())
}

/// texture-version, id-reused and the known-id rebuild (`rest`).
fn rest(st: &mut State, m: &Obj) -> Result<(), String> {
    for t in m["textures"].as_array().unwrap() {
        let id = u(&t["id"]);
        if let Some(prev) = st.last_seen_texture.get(&id) {
            if i(&prev["version"]) == i(&t["version"]) && prev != t {
                return Err("texture-version".into());
            }
        }
        st.last_seen_texture.insert(id, t.clone());
    }
    for (slot, key) in ["canvases", "items", "textures", "meshes"]
        .iter()
        .enumerate()
    {
        for e in m[*key].as_array().unwrap() {
            let id = u(&e["id"]);
            if id <= st.max_id[slot] && !st.known[slot].contains(&id) {
                return Err("id-reused".into());
            }
        }
    }
    let lists: [Vec<u32>; 4] = [
        st.canvases.keys().copied().collect(),
        st.items.keys().copied().collect(),
        st.textures.keys().copied().collect(),
        st.meshes.keys().copied().collect(),
    ];
    for (slot, list) in lists.into_iter().enumerate() {
        st.max_id[slot] = st.max_id[slot].max(list.iter().copied().max().unwrap_or(0));
        st.known[slot] = list.into_iter().collect();
    }
    Ok(())
}

fn le_u32(d: &[u8], at: usize) -> usize {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]]) as usize
}

fn to_hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// One transaction record, each stage timed with `now` (microseconds).
fn one(
    st: &mut State,
    data: &[u8],
    offset: usize,
    now: &dyn Fn() -> f64,
    t: &mut [f64; 9],
) -> Result<String, String> {
    let mut t0 = now();
    let record_len = le_u32(data, offset);
    let end = offset + 4 + record_len;
    let meta_len = le_u32(data, offset + 4);
    let meta_start = offset + 8;
    let mut p = meta_start + meta_len;
    let block_count = le_u32(data, p);
    p += 4;
    let mut spans = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let len = le_u32(data, p);
        spans.push((p + 4, len));
        p += 4 + len;
    }
    if p != end {
        return Err("record-length".into());
    }
    let mut t1 = now();
    t[0] = t1 - t0;
    t0 = t1;

    let digest = to_hex(&Sha256::digest(&data[offset..end]));
    t1 = now();
    t[1] = t1 - t0;
    t0 = t1;

    let meta_bytes = &data[meta_start..meta_start + meta_len];
    if meta_bytes.iter().any(|b| !(0x20..=0x7e).contains(b)) {
        return Err("meta-json".into());
    }
    let text = std::str::from_utf8(meta_bytes).map_err(|e| e.to_string())?;
    t1 = now();
    t[2] = t1 - t0;
    t0 = t1;

    let meta: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    t1 = now();
    t[3] = t1 - t0;
    t0 = t1;

    let mut ck = Check {
        ok: true,
        first: String::new(),
    };
    schema_transaction(&mut ck, &meta);
    if !ck.ok {
        return Err(format!("meta-schema: {}", ck.first));
    }
    t1 = now();
    t[4] = t1 - t0;
    t0 = t1;

    let f32s = |(s, l): (usize, usize)| -> Vec<f32> {
        data[s..s + l]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    };
    let item_f32 = f32s(spans[0]);
    let canvas_f32 = f32s(spans[1]);
    let cmd_f32 = f32s(spans[2]);
    let (s, l) = spans[3];
    let cmd_i32: Vec<i32> = data[s..s + l]
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let mesh_f32 = f32s(spans[4]);
    let (s, l) = spans[5];
    let param_f64: Vec<f64> = data[s..s + l]
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect();
    t1 = now();
    t[5] = t1 - t0;
    t0 = t1;

    let m = meta.as_object().unwrap();
    let blocks = [item_f32, canvas_f32, cmd_f32];
    resolve(st, m, &blocks, &cmd_i32, mesh_f32.len())?;
    std::hint::black_box(&param_f64);
    t1 = now();
    t[6] = t1 - t0;
    t0 = t1;

    invariants(st, m["unsupported"].as_array().unwrap())?;
    t1 = now();
    t[7] = t1 - t0;
    t0 = t1;

    rest(st, m)?;
    t[8] = now() - t0;
    Ok(digest)
}

pub struct Report {
    pub transactions: usize,
    pub stage_mean_us: [f64; 9],
    pub total_mean_us: f64,
    pub total_p50_us: f64,
    pub total_p95_us: f64,
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// Every transaction record of `data`, one warmup plus `repeats` timed passes on a fresh state each;
/// each stage's per-transaction value is the median over the timed passes.
pub fn run(data: &[u8], repeats: usize, now: &dyn Fn() -> f64) -> Result<Report, String> {
    if data.len() < 8 || &data[..4] != b"GRS6" {
        return Err("bad-magic".into());
    }
    let mut txs = Vec::new();
    let mut pos = 8;
    while pos < data.len() {
        let len = le_u32(data, pos);
        let meta_len = le_u32(data, pos + 4);
        let meta: Value = serde_json::from_slice(&data[pos + 8..pos + 8 + meta_len])
            .map_err(|e| e.to_string())?;
        if meta["type"].as_str() == Some("transaction") {
            txs.push(pos);
        }
        pos += 4 + len;
    }
    let mut samples: Vec<Vec<[f64; 9]>> = vec![Vec::new(); txs.len()];
    for r in 0..=repeats {
        let mut st = State::default();
        for (k, &off) in txs.iter().enumerate() {
            let mut t = [0f64; 9];
            one(&mut st, data, off, now, &mut t).map_err(|e| format!("tx {k}: {e}"))?;
            if r > 0 {
                samples[k].push(t);
            }
        }
    }
    let mut stage_mean = [0f64; 9];
    let mut totals = Vec::with_capacity(txs.len());
    for s in &samples {
        let mut total = 0.0;
        for (stage, mean) in stage_mean.iter_mut().enumerate() {
            let mut v: Vec<f64> = s.iter().map(|t| t[stage]).collect();
            let m = median(&mut v);
            *mean += m / txs.len() as f64;
            total += m;
        }
        totals.push(total);
    }
    let total_mean = totals.iter().sum::<f64>() / totals.len().max(1) as f64;
    let mut sorted = totals.clone();
    let p50 = median(&mut sorted);
    let p95 = sorted[((sorted.len() as f64 * 0.95) as usize).min(sorted.len() - 1)];
    Ok(Report {
        transactions: txs.len(),
        stage_mean_us: stage_mean,
        total_mean_us: total_mean,
        total_p50_us: p50,
        total_p95_us: p95,
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    extern "C" {
        fn now_us() -> f64;
    }

    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = vec![0u8; len];
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// Returns a pointer to 13 f64: transactions, the 9 stage means, total mean/p50/p95; or null.
    #[no_mangle]
    pub extern "C" fn profile(ptr: *const u8, len: usize, repeats: usize) -> *const f64 {
        let data = unsafe { std::slice::from_raw_parts(ptr, len) };
        let now = || unsafe { now_us() };
        match super::run(data, repeats, &now) {
            Ok(r) => {
                let mut out = vec![r.transactions as f64];
                out.extend_from_slice(&r.stage_mean_us);
                out.extend_from_slice(&[r.total_mean_us, r.total_p50_us, r.total_p95_us]);
                Box::leak(out.into_boxed_slice()).as_ptr()
            }
            Err(_) => std::ptr::null(),
        }
    }
}
