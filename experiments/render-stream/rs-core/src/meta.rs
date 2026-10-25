//! Meta schema checks and lifting (render-stream-2.md to -6.md "Meta"), in `render-stream-2.ts`'s
//! exact check order: `checkSessionSchema`, `checkTransactionSchema` (with
//! `checkTextureEntrySchema`, `checkMeshEntrySchema`, `checkShaderEntrySchema`,
//! `checkMaterialEntrySchema`, `checkParamEntrySchema`), `checkResourceSchema`, `checkEndSchema`.
//! The first failing check produces the same code the TypeScript decoder reports, including the
//! self-coded `viewport-entry`, `publication-entry`, `canvas-entry`, `param-entry`, `shader-entry`
//! and `material-entry` (memory rs-schema-self-coded-errors).
//!
//! Integers: JSON numbers are doubles; a field the TypeScript checks with `Number.isInteger` is an
//! `i64` here. Ids are `u32` (state.rs's `Id`), so an id outside `0..=u32::MAX`, and any integer
//! outside `i64`, fails the check that asked for an integer (`validate`'s docs, "Deviations").

use crate::json::{js_cmp, Doc, Value};
use crate::state::*;
use crate::wire::{self, BlockDesc, BlockRange, BlockType, Error, F32s};
use std::cmp::Ordering;

mod fast;

// ------------------------------------------------------------------------------------- key lists

const SESSION_KEYS: &[&str] = &[
    "type",
    "protocol",
    "session_id",
    "stream",
    "engine",
    "capture",
    "viewport",
    "resources",
    "features",
    "sabotage",
    "blocks",
];
const SESSION_KEYS_V5: &[&str] = &[
    "type",
    "protocol",
    "session_id",
    "stream",
    "engine",
    "capture",
    "viewport",
    "resources",
    "materials",
    "features",
    "sabotage",
    "blocks",
];
const SESSION_KEYS_V6: &[&str] = &[
    "type",
    "protocol",
    "session_id",
    "stream",
    "engine",
    "capture",
    "viewport",
    "resources",
    "materials",
    "features",
    "publication",
    "sabotage",
    "blocks",
];
const STREAM_KEYS: &[&str] = &["stream_id", "connection", "transport", "encoding"];
const ENGINE_KEYS: &[&str] = &[
    "version_string",
    "sha256",
    "display_server",
    "rendering_driver",
    "rendering_method",
];
const CAPTURE_KEYS: &[&str] = &["calibrator_version", "hooks_planned", "hooks_omitted"];
const VIEWPORT_KEYS: &[&str] = &[
    "canvas_cull_mask",
    "root_canvas",
    "logical_size",
    "stretch",
    "stretch_applied_by",
    "root_size_policy",
    "host_size_status",
    "host_window_size",
];
const VIEWPORT_KEYS_V6: &[&str] = &[
    "canvas_cull_mask",
    "root_canvas",
    "logical_size",
    "stretch",
    "stretch_applied_by",
    "root_size_policy",
    "presentation_size",
    "host_size_status",
    "host_window_size",
    "font_oversampling",
    "snap_2d",
];
const STRETCH_KEYS: &[&str] = &["mode", "aspect", "scale_mode"];
const SNAP_2D_KEYS: &[&str] = &["transforms", "vertices"];
const PUBLICATION_KEYS: &[&str] = &["mode", "target_fps"];
/// render-stream-7.md "Publication": `credit_window` right after `target_fps`.
const PUBLICATION_KEYS_V7: &[&str] = &["mode", "target_fps", "credit_window"];
const RESOURCES_KEYS: &[&str] = &[
    "hash",
    "payload",
    "delivery",
    "inline_max_bytes",
    "max_payload_bytes",
    "permitted_formats",
    "fetch",
    "http_path",
    "auth",
];
const RESOURCES_KEYS_V4: &[&str] = &[
    "hash",
    "payloads",
    "delivery",
    "inline_max_bytes",
    "max_payload_bytes",
    "permitted_formats",
    "fetch",
    "http_path",
    "auth",
];
// render-stream-8.md "Session": "decode" after "auth" (the end of the resources object).
const RESOURCES_KEYS_V8: &[&str] = &[
    "hash",
    "payloads",
    "delivery",
    "inline_max_bytes",
    "max_payload_bytes",
    "permitted_formats",
    "fetch",
    "http_path",
    "auth",
    "decode",
];
// render-stream-9.md "Session": "texture_delivery" after "decode" (the end of the resources object).
const RESOURCES_KEYS_V9: &[&str] = &[
    "hash",
    "payloads",
    "delivery",
    "inline_max_bytes",
    "max_payload_bytes",
    "permitted_formats",
    "fetch",
    "http_path",
    "auth",
    "decode",
    "texture_delivery",
];
const TEXTURE_DECODES: &[&str] = &["off", "engine"];
const TEXTURE_DELIVERY_KEYS: &[&str] = &["mode", "encoder"];
/// texture-delivery-design.md D1: the session's delivery modes, and (render-stream-9.md) the
/// variant encodings each offers beside `decoded`.
pub const DELIVERY_MODES: &[&str] = &["rgba", "passthrough", "basis-uastc", "basis-etc1s"];
pub fn mode_offers(mode: &str, encoding: VariantEncoding) -> bool {
    match mode {
        "passthrough" => encoding == VariantEncoding::Block,
        "basis-uastc" => encoding != VariantEncoding::Etc1s,
        "basis-etc1s" => encoding == VariantEncoding::Etc1s,
        _ => false,
    }
}
const VARIANT_KEYS: &[&str] = &["encoding", "hash", "payload_bytes", "format", "params"];
const ADOPTION_KEYS: &[&str] = &["mode", "frame"];
const FEATURES_KEYS: &[&str] = &[
    "ops",
    "item_state",
    "resources",
    "unsupported_resources",
    "observed_unsupported_ops",
    "unobserved",
    "publication",
];
const FEATURES_KEYS_V5: &[&str] = &[
    "ops",
    "item_state",
    "canvas_state",
    "resources",
    "unsupported_resources",
    "observed_unsupported_ops",
    "unobserved",
    "publication",
];
const MATERIALS_KEYS: &[&str] = &["shader_policy"];
const SABOTAGE_KEYS: &[&str] = &["kind", "frame", "op"];
pub const SABOTAGE_KINDS: &[&str] = &[
    "freeze-frame",
    "omit-update",
    "perturb-transform",
    "omit-op",
    "patch-drop-item",
    "drop-message",
    "ignore-credit",
    "stale-coalesce",
    "stale-texture",
    "wrong-hash",
    "spurious-texture-update",
    "drop-resource",
    "unpin",
    "perturb-glyph",
    "perturb-vertex",
    "perturb-shader",
    "retain-superseded",
    // New at /8 (gate8-design.md Q2-Q5): legal in a /8 session only.
    "adopt-skip-state",
    "adopt-no-redraw",
    "adopt-skip-layers",
    "perturb-decode",
    "size-before-adopt",
    "adopt-raw-shader-code",
    "adopt-skip-params",
];
const SABOTAGE_V8_ONLY: &[&str] = &[
    "adopt-skip-state",
    "adopt-no-redraw",
    "adopt-skip-layers",
    "perturb-decode",
    "size-before-adopt",
    "adopt-raw-shader-code",
    "adopt-skip-params",
];
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
    "canvases",
    "items",
    "textures",
    "blocks",
];
const TRANSACTION_KEYS_V4: &[&str] = &[
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
    "canvases",
    "items",
    "textures",
    "meshes",
    "blocks",
];
const TRANSACTION_KEYS_V5: &[&str] = &[
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
const FAILURE_KEYS: &[&str] = &["reason", "detail"];
const UNKNOWN_ITEMS_KEYS: &[&str] = &[
    "unknown_rids",
    "withheld_items",
    "withheld_commands",
    "unknown_calls",
];
const UNSUPPORTED_KEYS: &[&str] = &["op", "item", "reason"];
const CANVAS_KEYS: &[&str] = &["id", "origin", "role", "attached", "items"];
const CANVAS_KEYS_V6: &[&str] = &[
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
    "content_version",
    "commands",
];
const ITEM_KEYS_V5: &[&str] = &[
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
// render-stream-10.md "Item": canvas_group and copy_to_backbuffer right after instance_params.
const ITEM_KEYS_V10: &[&str] = &[
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
    "canvas_group",
    "copy_to_backbuffer",
    "content_version",
    "commands",
];
const CANVAS_GROUP_KEYS: &[&str] = &["mode", "fit_empty", "blur_mipmaps", "f"];
const COPY_TO_BACKBUFFER_KEYS: &[&str] = &["f"];
const PARENT_KEYS: &[&str] = &["kind", "id"];
const ADD_RECT_KEYS: &[&str] = &["op", "aa", "f"];
const ADD_TEXTURE_RECT_KEYS: &[&str] = &["op", "tex", "tile", "transpose", "f"];
const ADD_TEXTURE_RECT_REGION_KEYS: &[&str] = &["op", "tex", "transpose", "clip_uv", "f"];
const ADD_MSDF_KEYS: &[&str] = &["op", "tex", "outline", "f"];
const UNSUPPORTED_CMD_KEYS: &[&str] = &["op", "name", "reason"];
const ADD_LINE_KEYS: &[&str] = &["op", "aa", "f"];
const ADD_POLYLINE_KEYS: &[&str] = &["op", "aa", "n", "colors", "f"];
const ADD_CIRCLE_KEYS: &[&str] = &["op", "aa", "f"];
const ADD_PRIMITIVE_KEYS: &[&str] = &["op", "tex", "n", "colors", "uvs", "f"];
const ADD_TRIANGLE_ARRAY_KEYS: &[&str] = &[
    "op", "tex", "n", "colors", "uvs", "indices", "count", "i", "f",
];
const ADD_NINE_PATCH_KEYS: &[&str] = &["op", "tex", "x_axis", "y_axis", "draw_center", "f"];
const ADD_MESH_KEYS: &[&str] = &["op", "mesh", "tex", "f"];
const ADD_SET_TRANSFORM_KEYS: &[&str] = &["op", "f"];
const ADD_CLIP_IGNORE_KEYS: &[&str] = &["op", "ignore"];
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
// render-stream-8.md "Resource tables": adopted_content right after origin, source_format right
// after format (texture); adopted_content right after origin (mesh).
const TEXTURE_KEYS_V8: &[&str] = &[
    "id",
    "origin",
    "adopted_content",
    "kind",
    "status",
    "reason",
    "version",
    "hash",
    "format",
    "source_format",
    "width",
    "height",
    "mipmaps",
    "payload_bytes",
    "canvas",
];
// render-stream-9.md "Texture entries": "variants" right after "payload_bytes".
const TEXTURE_KEYS_V9: &[&str] = &[
    "id",
    "origin",
    "adopted_content",
    "kind",
    "status",
    "reason",
    "version",
    "hash",
    "format",
    "source_format",
    "width",
    "height",
    "mipmaps",
    "payload_bytes",
    "variants",
    "canvas",
];
const CANVAS_TEXTURE_KEYS: &[&str] = &["diffuse", "filter", "repeat"];
const MESH_KEYS: &[&str] = &[
    "id", "origin", "status", "reason", "version", "f", "surfaces",
];
const MESH_KEYS_V8: &[&str] = &[
    "id",
    "origin",
    "adopted_content",
    "status",
    "reason",
    "version",
    "f",
    "surfaces",
];
const MESH_SURFACE_KEYS: &[&str] = &[
    "hash",
    "payload_bytes",
    "primitive",
    "format",
    "vertex_count",
    "index_count",
];
const SHADER_KEYS: &[&str] = &[
    "id",
    "origin",
    "status",
    "reason",
    "version",
    "mode",
    "source",
    "hash",
    "payload_bytes",
    "builtin",
    "uses",
    "default_textures",
];
const BUILTIN_KEYS: &[&str] = &["kind", "blend_mode", "light_mode", "particles_animation"];
const DEFAULT_TEXTURE_KEYS: &[&str] = &["name", "index", "tex"];
const MATERIAL_KEYS: &[&str] = &[
    "id", "origin", "status", "reason", "version", "shader", "params",
];
const PARAM_KEYS: &[&str] = &["name", "type", "n", "tex", "f"];
const RESOURCE_KEYS: &[&str] = &["type", "hash", "bytes", "blocks"];
const END_KEYS: &[&str] = &["type", "transactions", "reason", "stats", "blocks"];
const STATS_KEYS: &[&str] = &[
    "bytes_total",
    "encode_ns_total",
    "snapshot_ns_total",
    "diff_ns_total",
    "max_record_bytes",
    "full_transactions",
    "patch_transactions",
    "resource_records",
    "resource_bytes",
];
const BLOCK_KEYS: &[&str] = &["name", "type", "count"];

pub const SESSION_BLOCK_NAMES: &[&str] = &[
    "clear_color",
    "root_canvas_xform",
    "host_visible_rect",
    "host_final_xform",
    "content_scale_factor",
];
const SESSION_BLOCK_COUNTS: &[u64] = &[4, 6, 4, 6, 1];
pub const TRANSACTION_BLOCK_NAMES: &[&str] = &[
    "item_f32",
    "canvas_f32",
    "cmd_f32",
    "cmd_i32",
    "mesh_f32",
    "param_f64",
    "backbuffer_f32",
];
const TRANSACTION_BLOCK_TYPES: &[BlockType] = &[
    BlockType::F32,
    BlockType::F32,
    BlockType::F32,
    BlockType::I32,
    BlockType::F32,
    BlockType::F64,
    BlockType::F32,
];

/// How many transaction blocks a version's transactions carry (render-stream-10.md "Transaction
/// blocks": seven from /10).
pub fn transaction_block_count(version: u8) -> usize {
    match version {
        10.. => 7,
        5..=9 => 6,
        4 => 5,
        _ => 3,
    }
}

const FAILURE_REASONS: &[&str] = &[
    "root-query-failed",
    "pre-existing-object",
    "mirror-capacity",
    "root-size-enforce-failed",
];
pub const TEXTURE_REASONS: &[&str] = &[
    "unsupported-format",
    "payload-too-large",
    "payload-unavailable",
    "update-shape-mismatch",
    "layered-update",
    "unknown-texture",
    "canvas-texture-channel",
];
/// render-stream-9.md "Texture reasons": /9 adds `delivery-pending`.
const TEXTURE_REASONS_V9: &[&str] = &[
    "unsupported-format",
    "payload-too-large",
    "payload-unavailable",
    "update-shape-mismatch",
    "layered-update",
    "unknown-texture",
    "canvas-texture-channel",
    "delivery-pending",
];
const UNSUPPORTED_RESOURCE_REASONS: &[&str] = &["canvas-texture-headless"];
const SESSION_UNSUPPORTED_REASONS: &[&str] =
    &["non-root-viewport", "extra-canvas", "degenerate-host-size"];
const ITEM_UNSUPPORTED_REASONS: &[&str] = &[
    "unsupported-op",
    "unsupported-state",
    "draw-index-tie",
    "unknown-texture",
    "unsupported-texture",
    "canvas-texture-headless",
    "unknown-mesh",
    "skinned-geometry",
    "unsupported-mesh",
];
const ITEM_UNSUPPORTED_REASONS_V5: &[&str] = &[
    "unsupported-op",
    "unsupported-state",
    "draw-index-tie",
    "unknown-texture",
    "unsupported-texture",
    "canvas-texture-headless",
    "unknown-mesh",
    "skinned-geometry",
    "unsupported-mesh",
    "unsupported-material",
    "unknown-material",
    "param-type",
];
const SESSION_UNSUPPORTED_REASONS_V5: &[&str] = &[
    "non-root-viewport",
    "extra-canvas",
    "degenerate-host-size",
    "canvas-light",
];
const SESSION_UNSUPPORTED_REASONS_V6: &[&str] = &[
    "non-root-viewport",
    "extra-canvas",
    "degenerate-host-size",
    "canvas-light",
    "canvas-stacking-tie",
    "canvas-repeat",
    "canvas-follow-viewport",
    "global-canvas-transform",
    "snap-2d",
];
pub const MESH_REASONS: &[&str] = &["mesh-format", "mesh-blend-shapes", "payload-too-large"];
pub const SHADER_REASONS: &[&str] = &[
    "shader-mode",
    "shader-screen-texture",
    "shader-sdf",
    "shader-time",
    "shader-global-uniform",
    "shader-excluded",
    "payload-too-large",
    "payload-unavailable",
    // render-stream-8.md "Resource tables" (gate8-design.md Q5): /8, adopted entries only.
    "shader-adopt-include",
];
pub const MATERIAL_REASONS: &[&str] = &[
    "unknown-shader",
    "unknown-texture",
    "param-type",
    "param-range",
];
const SHADER_POLICIES: &[&str] = &["source", "params", "exclude"];
const DELIVERIES: &[&str] = &["out-of-band", "inline", "mixed"];
const FETCHES: &[&str] = &["http", "directory", "none"];
const AUTHS: &[&str] = &["none", "bearer"];

// ------------------------------------------------------------------------------------- checker

/// An object's fields in a fixed key order, after `hasExactKeys` passed.
pub enum Fields<'a> {
    /// Flattened `[key, value, ...]` pairs straight from the document (no duplicate keys).
    Direct(&'a [Value]),
    /// Values after `JSON.parse`'s duplicate collapse.
    Owned(Vec<Value>),
}

impl Fields<'_> {
    #[inline]
    pub fn at(&self, i: usize) -> Value {
        match self {
            Fields::Direct(p) => p[2 * i + 1],
            Fields::Owned(v) => v[i],
        }
    }
}

const MAX_I64_F: f64 = 9223372036854775808.0;

/// Schema-check helpers over one parsed meta.
pub struct Ck<'a, 's> {
    pub doc: &'a Doc<'s>,
    pub offset: usize,
    /// A checked object repeated a key (so the text is not canonical).
    pub dups: bool,
    scratch: Vec<(Value, Value)>,
}

impl<'a, 's> Ck<'a, 's> {
    pub fn new(doc: &'a Doc<'s>, offset: usize) -> Self {
        Ck {
            doc,
            offset,
            dups: false,
            scratch: Vec::new(),
        }
    }

    /// `isPlainObject(v) && hasExactKeys(v, keys)`.
    pub fn fields(&mut self, v: Value, keys: &[&str]) -> Option<Fields<'a>> {
        let doc = self.doc;
        let e = doc.obj(v)?;
        if e.len() == 2 * keys.len() {
            for (i, k) in keys.iter().enumerate() {
                if doc.str_bytes(e[2 * i]) != Some(k.as_bytes()) {
                    return None;
                }
            }
            return Some(Fields::Direct(e));
        }
        if e.len() < 2 * keys.len() {
            return None;
        }
        // More entries than keys: only a duplicate collapse can make it match.
        let dups = doc.dedup_entries(v, &mut self.scratch);
        if self.scratch.len() != keys.len() {
            return None;
        }
        for (i, k) in keys.iter().enumerate() {
            if doc.str_bytes(self.scratch[i].0) != Some(k.as_bytes()) {
                return None;
            }
        }
        self.dups |= dups;
        Some(Fields::Owned(self.scratch.iter().map(|e| e.1).collect()))
    }

    #[inline]
    pub fn has_key(&self, v: Value, key: &str) -> bool {
        self.doc.get(v, key).is_some()
    }

    #[inline]
    pub fn null(&self, v: Value) -> bool {
        self.doc.is_null(v)
    }

    /// `Number.isInteger(v)`, within i64.
    #[inline]
    pub fn int(&self, v: Value) -> Option<i64> {
        let x = self.doc.as_num(v)?;
        if x.fract() != 0.0 || !x.is_finite() || x.abs() >= MAX_I64_F {
            return None;
        }
        Some(x as i64)
    }

    /// An integer >= `min` (as `isInt(v) && v >= min`).
    #[inline]
    pub fn int_ge(&self, v: Value, min: i64) -> Option<i64> {
        self.int(v).filter(|&x| x >= min)
    }

    /// A non-negative integer as u64.
    #[inline]
    pub fn uint(&self, v: Value) -> Option<u64> {
        self.int(v).filter(|&x| x >= 0).map(|x| x as u64)
    }

    /// An integer id (u32).
    #[inline]
    pub fn id(&self, v: Value) -> Option<u32> {
        self.int(v).and_then(|x| u32::try_from(x).ok())
    }

    /// An integer id >= 1.
    #[inline]
    pub fn id1(&self, v: Value) -> Option<u32> {
        self.id(v).filter(|&x| x >= 1)
    }

    /// `null` or an id >= 1: Some(None) / Some(Some(id)); None when neither.
    #[inline]
    pub fn opt_id1(&self, v: Value) -> Option<Option<u32>> {
        if self.null(v) {
            Some(None)
        } else {
            self.id1(v).map(Some)
        }
    }

    #[inline]
    pub fn boolean(&self, v: Value) -> Option<bool> {
        self.doc.as_bool(v)
    }

    #[inline]
    pub fn string(&self, v: Value) -> Option<&'a [u8]> {
        self.doc.str_bytes(v)
    }

    /// A string that state.rs can hold (valid UTF-8: no lone surrogate).
    #[inline]
    pub fn owned(&self, v: Value) -> Option<Box<str>> {
        self.doc.as_str(v).map(Box::from)
    }

    /// `isOneOf(v, options)`: the index of the matching option.
    #[inline]
    pub fn one_of(&self, v: Value, options: &[&'static str]) -> Option<usize> {
        let s = self.doc.str_bytes(v)?;
        options.iter().position(|o| o.as_bytes() == s)
    }

    #[inline]
    pub fn one_of_str(&self, v: Value, options: &[&'static str]) -> Option<&'static str> {
        self.one_of(v, options).map(|i| options[i])
    }

    #[inline]
    pub fn arr(&self, v: Value) -> Option<&'a [Value]> {
        self.doc.arr(v)
    }

    pub fn is_string_array(&self, v: Value) -> bool {
        self.arr(v)
            .is_some_and(|a| a.iter().all(|&x| self.string(x).is_some()))
    }

    pub fn string_vec(&self, v: Value) -> Vec<String> {
        self.arr(v)
            .map(|a| {
                a.iter()
                    .map(|&x| String::from_utf8_lossy(self.string(x).unwrap_or(b"")).into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `isIntArray(v)` into i64.
    pub fn int_array(&self, v: Value, out: &mut Vec<i64>) -> bool {
        out.clear();
        let Some(a) = self.arr(v) else { return false };
        for &x in a {
            match self.int(x) {
                Some(i) => out.push(i),
                None => return false,
            }
        }
        true
    }

    /// `isIntArray(v)` of ids, appended to `out`.
    pub fn id_array(&self, v: Value, out: &mut Vec<Id>) -> Option<Rng> {
        let a = self.arr(v)?;
        let start = out.len() as u32;
        for &x in a {
            match self.id(x) {
                Some(i) => out.push(i),
                None => {
                    out.truncate(start as usize);
                    return None;
                }
            }
        }
        Some(Rng {
            start,
            end: out.len() as u32,
        })
    }

    pub fn int_pair(&self, v: Value) -> Option<[i64; 2]> {
        let a = self.arr(v)?;
        if a.len() != 2 {
            return None;
        }
        Some([self.int(a[0])?, self.int(a[1])?])
    }

    /// `isLowerHex(v, 64)`.
    pub fn hash(&self, v: Value) -> Option<Hash> {
        let s = self.string(v)?;
        if s.len() != 64 {
            return None;
        }
        let t = std::str::from_utf8(s).ok()?;
        Hash::from_hex(t)
    }

    pub fn err(&self, code: &'static str, detail: impl AsRef<str>) -> Error {
        Error::new(
            code,
            format!("record at offset {}: {}", self.offset, detail.as_ref()),
        )
    }

    pub fn schema(&self, detail: impl AsRef<str>) -> Error {
        self.err("meta-schema", detail)
    }

    /// `checkBlocksField` then `checkFixedBlockNames`.
    fn blocks(
        &mut self,
        v: Value,
        names: &[&str],
        types: Option<&[BlockType]>,
        out: &mut Vec<BlockDesc>,
    ) -> Result<(), Error> {
        out.clear();
        let Some(a) = self.arr(v) else {
            return Err(self.schema("\"blocks\" is not an array"));
        };
        let mut found_names: Vec<Value> = Vec::with_capacity(a.len());
        for &entry in a {
            let Some(f) = self.fields(entry, BLOCK_KEYS) else {
                return Err(self.schema("a blocks[] entry has the wrong keys"));
            };
            let ty = self.string(f.at(1)).and_then(BlockType::parse);
            match (self.string(f.at(0)), ty, self.uint(f.at(2))) {
                (Some(_), Some(ty), Some(count)) => {
                    out.push(BlockDesc { ty, count });
                    found_names.push(f.at(0));
                }
                _ => return Err(self.schema("a blocks[] entry has an invalid field")),
            }
        }
        if out.len() != names.len() {
            return Err(self.schema(format!(
                "expected {} blocks ({}), got {}",
                names.len(),
                names.join(", "),
                out.len()
            )));
        }
        for (i, name) in names.iter().enumerate() {
            if self.string(found_names[i]) != Some(name.as_bytes()) {
                return Err(self.schema(format!(
                    "block {i} is named \"{}\", expected \"{name}\"",
                    self.lossy(found_names[i])
                )));
            }
            let expected = types.map(|t| t[i]).unwrap_or(BlockType::F32);
            if out[i].ty != expected {
                return Err(self.schema(format!(
                    "block \"{name}\" has type \"{}\", expected \"{}\"",
                    out[i].ty.as_str(),
                    expected.as_str()
                )));
            }
        }
        Ok(())
    }

    fn lossy(&self, v: Value) -> String {
        String::from_utf8_lossy(self.string(v).unwrap_or(b"?")).into_owned()
    }

    /// Strings in `a` are non-decreasing in JavaScript's default sort order.
    fn sorted_strings(&self, a: &[Value]) -> bool {
        a.windows(2).all(|w| {
            js_cmp(self.string(w[0]).unwrap(), self.string(w[1]).unwrap()) != Ordering::Greater
        })
    }
}

/// A `[start, end)` range into one of [`TxMeta`]'s shared buffers.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Rng {
    pub start: u32,
    pub end: u32,
}

impl Rng {
    #[inline]
    pub fn len(&self) -> usize {
        (self.end - self.start) as usize
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.end == self.start
    }
    #[inline]
    pub fn of<'a, T>(&self, v: &'a [T]) -> &'a [T] {
        &v[self.start as usize..self.end as usize]
    }
}

// ------------------------------------------------------------------------------------- session

#[derive(Clone, Debug, PartialEq)]
pub struct StreamInfo {
    pub stream_id: String,
    pub connection: Option<i64>,
    /// "file" or "websocket".
    pub transport: &'static str,
    pub encoding: Encoding,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Engine {
    pub version_string: String,
    pub sha256: String,
    pub display_server: String,
    pub rendering_driver: String,
    pub rendering_method: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Capture {
    pub calibrator_version: i64,
    pub hooks_planned: Vec<String>,
    pub hooks_omitted: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stretch {
    /// "disabled", "canvas_items" or "viewport".
    pub mode: &'static str,
    /// "ignore", "keep", "keep_width", "keep_height" or "expand".
    pub aspect: &'static str,
    /// "fractional" or "integer".
    pub scale_mode: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Viewport {
    pub canvas_cull_mask: i64,
    pub root_canvas: i64,
    pub logical_size: [i64; 2],
    pub stretch: Stretch,
    /// "observe", "enforce-min-size" or (/6) "presentation".
    pub root_size_policy: &'static str,
    /// /6 only.
    pub presentation_size: Option<[i64; 2]>,
    /// "match", "degenerate-visible" or "degenerate-window".
    pub host_size_status: &'static str,
    pub host_window_size: [i64; 2],
    /// /6 only.
    pub font_oversampling: Option<f64>,
    /// /6 only: (transforms, vertices).
    pub snap_2d: Option<(bool, bool)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resources {
    /// /2 and /3: the single payload schema string.
    pub payload: Option<String>,
    /// /4 and later: the sorted payload schema strings.
    pub payloads: Vec<String>,
    /// "out-of-band", "inline" or "mixed".
    pub delivery: &'static str,
    pub inline_max_bytes: i64,
    pub max_payload_bytes: i64,
    pub permitted_formats: Vec<String>,
    /// "http", "directory" or "none".
    pub fetch: &'static str,
    pub http_path: Option<String>,
    /// "none" or "bearer".
    pub auth: &'static str,
    /// /8 only (render-stream-8.md "Session"): "off" or "engine".
    pub decode: Option<&'static str>,
    /// /9 only (render-stream-9.md "Session"): the host's declared texture-delivery mode and
    /// encoder prefix.
    pub texture_delivery: Option<TextureDelivery>,
}

/// `resources.texture_delivery`: `{"mode":<D1 mode>,"encoder":null|<params_id prefix>}`.
#[derive(Clone, Debug, PartialEq)]
pub struct TextureDelivery {
    pub mode: &'static str,
    pub encoder: Option<String>,
}

/// /8 only (render-stream-8.md "Session"): the late-join adoption declaration,
/// `{"mode":"arm","frame":<int >= 1>}`; absent when the session says null (or below /8).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adoption {
    pub frame: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Features {
    pub ops: Vec<String>,
    pub item_state: Vec<String>,
    /// /5 and later.
    pub canvas_state: Option<Vec<String>>,
    pub resources: Vec<String>,
    pub unsupported_resources: Vec<(String, &'static str)>,
    pub observed_unsupported_ops: Vec<String>,
    pub unobserved: Vec<String>,
    pub publication: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Publication {
    /// "every-frame" or "rate".
    pub mode: &'static str,
    pub target_fps: Option<i64>,
    /// /7 only (render-stream-7.md "Publication"): the granted credit window, 1 or 2.
    pub credit_window: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sabotage {
    pub kind: &'static str,
    pub frame: i64,
    pub op: Option<String>,
}

/// The session record: its typed meta and its five decoded blocks.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub version: u8,
    pub protocol: String,
    pub session_id: String,
    pub stream: StreamInfo,
    pub engine: Engine,
    pub capture: Capture,
    pub viewport: Viewport,
    pub resources: Resources,
    /// /5 and later: "source", "params" or "exclude".
    pub shader_policy: Option<&'static str>,
    pub features: Features,
    /// /6 only (the top-level key, not `features.publication`).
    pub publication: Option<Publication>,
    pub sabotage: Option<Sabotage>,
    /// /8 only: `Some` when the session declares adoption (null otherwise, and below /8).
    pub adoption: Option<Adoption>,
    /// protocol/unknown-item-skip.md: the session declared `unknown_item_policy: "skip"`.
    pub unknown_item_skip: bool,
    pub clear_color: [f32; 4],
    pub root_canvas_xform: [f32; 6],
    pub host_visible_rect: [f32; 4],
    pub host_final_xform: [f32; 6],
    pub content_scale_factor: f32,
}

fn check_resources(ck: &mut Ck, v: Value, version: u8) -> Result<Resources, Error> {
    let err = |ck: &Ck, d: &str| ck.schema(format!("resources {d}"));
    let v4 = version >= 4;
    let Some(f) = ck.fields(
        v,
        if version >= 9 {
            RESOURCES_KEYS_V9
        } else if version >= 8 {
            RESOURCES_KEYS_V8
        } else if v4 {
            RESOURCES_KEYS_V4
        } else {
            RESOURCES_KEYS
        },
    ) else {
        return Err(err(ck, "has the wrong keys"));
    };
    if ck.string(f.at(0)) != Some(b"sha256") {
        return Err(err(ck, "\"hash\" must be \"sha256\""));
    }
    let mut payload = None;
    let mut payloads = Vec::new();
    if v4 {
        if !ck.is_string_array(f.at(1)) {
            return Err(err(ck, "\"payloads\" is not an array of strings"));
        }
        if !ck.sorted_strings(ck.arr(f.at(1)).unwrap()) {
            return Err(err(ck, "\"payloads\" is not sorted ascending"));
        }
        payloads = ck.string_vec(f.at(1));
    } else {
        match ck.string(f.at(1)) {
            Some(s) => payload = Some(String::from_utf8_lossy(s).into_owned()),
            None => return Err(err(ck, "\"payload\" is not a string")),
        }
    }
    let Some(delivery) = ck.one_of_str(f.at(2), DELIVERIES) else {
        return Err(err(ck, "has an invalid delivery"));
    };
    let Some(inline_max_bytes) = ck.int_ge(f.at(3), 0) else {
        return Err(err(
            ck,
            "\"inline_max_bytes\" is not a non-negative integer",
        ));
    };
    let Some(max_payload_bytes) = ck.int_ge(f.at(4), 1) else {
        return Err(err(ck, "\"max_payload_bytes\" is not an integer >= 1"));
    };
    if !ck.is_string_array(f.at(5)) {
        return Err(err(ck, "\"permitted_formats\" is not an array of strings"));
    }
    let Some(fetch) = ck.one_of_str(f.at(6), FETCHES) else {
        return Err(err(ck, "has an invalid fetch"));
    };
    let http_path = if ck.null(f.at(7)) {
        None
    } else if let Some(s) = ck.string(f.at(7)) {
        Some(String::from_utf8_lossy(s).into_owned())
    } else {
        return Err(err(ck, "\"http_path\" is neither null nor a string"));
    };
    if (fetch == "http") != http_path.is_some() {
        return Err(err(
            ck,
            "\"http_path\" must be non-null exactly for fetch \"http\"",
        ));
    }
    let Some(auth) = ck.one_of_str(f.at(8), AUTHS) else {
        return Err(err(ck, "has an invalid auth"));
    };
    let decode = if version >= 8 {
        match ck.one_of_str(f.at(9), TEXTURE_DECODES) {
            Some(d) => Some(d),
            None => return Err(err(ck, "\"decode\" must be \"off\" or \"engine\"")),
        }
    } else {
        None
    };
    let texture_delivery = if version >= 9 {
        let Some(d) = ck.fields(f.at(10), TEXTURE_DELIVERY_KEYS) else {
            return Err(err(ck, "\"texture_delivery\" has the wrong keys"));
        };
        let Some(mode) = ck.one_of_str(d.at(0), DELIVERY_MODES) else {
            return Err(err(
                ck,
                "\"texture_delivery.mode\" must be \"rgba\", \"passthrough\", \"basis-uastc\" or \"basis-etc1s\"",
            ));
        };
        let encoder = if ck.null(d.at(1)) {
            None
        } else if let Some(e) = ck
            .string(d.at(1))
            .filter(|e| is_params_prefix(e))
            .map(|e| String::from_utf8_lossy(e).into_owned())
        {
            Some(e)
        } else {
            return Err(err(
                ck,
                "\"texture_delivery.encoder\" is neither null nor a params_id prefix",
            ));
        };
        Some(TextureDelivery { mode, encoder })
    } else {
        None
    };
    let expected = if inline_max_bytes == 0 {
        "out-of-band"
    } else if inline_max_bytes >= max_payload_bytes {
        "inline"
    } else {
        "mixed"
    };
    if delivery != expected {
        return Err(err(
            ck,
            &format!("\"delivery\" is \"{delivery}\", expected \"{expected}\" from inline_max_bytes/max_payload_bytes"),
        ));
    }
    if (delivery == "inline") != (fetch == "none") {
        return Err(err(
            ck,
            "\"fetch\" must be \"none\" exactly when delivery is \"inline\"",
        ));
    }
    Ok(Resources {
        payload,
        payloads,
        delivery,
        inline_max_bytes,
        max_payload_bytes,
        permitted_formats: ck.string_vec(f.at(5)),
        fetch,
        http_path,
        auth,
        decode,
        texture_delivery,
    })
}

/// `^[a-z0-9][a-z0-9._-]*$`: a params_id prefix such as `basisu-1.60`.
fn is_params_prefix(s: &[u8]) -> bool {
    !s.is_empty()
        && (s[0].is_ascii_lowercase() || s[0].is_ascii_digit())
        && s.iter().all(|&b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-'
        })
}

fn string_vec_checked(ck: &Ck, v: Value) -> Option<Vec<String>> {
    ck.is_string_array(v).then(|| ck.string_vec(v))
}

fn lossy(ck: &Ck, v: Value) -> String {
    String::from_utf8_lossy(ck.string(v).unwrap_or(b"")).into_owned()
}

/// `checkSessionSchema`, lifting the meta into a [`Session`] (blocks zeroed; the caller fills them).
fn check_session(
    ck: &mut Ck,
    meta: Value,
    version: u8,
    blocks: &mut Vec<BlockDesc>,
) -> Result<Session, Error> {
    let v6 = version >= 6;
    let v5 = version >= 5;
    let skip_declared = version >= 4 && ck.has_key(meta, "unknown_item_policy");
    let base = if v6 {
        SESSION_KEYS_V6
    } else if v5 {
        SESSION_KEYS_V5
    } else {
        SESSION_KEYS
    };
    let mut keys: Vec<&str> = base.to_vec();
    if skip_declared {
        let at = keys.iter().position(|&k| k == "sabotage").unwrap() + 1;
        keys.insert(at, "unknown_item_policy");
    }
    if version >= 8 {
        // render-stream-8.md "Session": "adoption" is always present, right after
        // "unknown_item_policy" (or after "sabotage" when that key is absent).
        let after = if skip_declared {
            "unknown_item_policy"
        } else {
            "sabotage"
        };
        let at = keys.iter().position(|&k| k == after).unwrap() + 1;
        keys.insert(at, "adoption");
    }
    let Some(f) = ck.fields(meta, &keys) else {
        return Err(ck.schema("session has the wrong top-level keys or order"));
    };
    let at = |name: &str| f.at(keys.iter().position(|&k| k == name).unwrap());
    if skip_declared && ck.string(at("unknown_item_policy")) != Some(b"skip") {
        return Err(ck.schema("\"unknown_item_policy\" must be \"skip\" when present"));
    }
    let expected_protocol = format!("render-stream/{version}");
    if ck.string(at("protocol")) != Some(expected_protocol.as_bytes()) {
        return Err(ck.schema(format!("unknown protocol {}", lossy(ck, at("protocol")))));
    }
    let Some(session_id) = ck.string(at("session_id")) else {
        return Err(ck.schema("\"session_id\" is not a string"));
    };
    let session_id = String::from_utf8_lossy(session_id).into_owned();

    let stream = (|| {
        let s = ck.fields(at("stream"), STREAM_KEYS)?;
        let stream_id = ck.string(s.at(0))?;
        let connection = if ck.null(s.at(1)) {
            None
        } else {
            Some(ck.int_ge(s.at(1), 1)?)
        };
        let transport = ck.one_of_str(s.at(2), &["file", "websocket"])?;
        let encoding = Encoding::parse(std::str::from_utf8(ck.string(s.at(3))?).ok()?)?;
        Some(StreamInfo {
            stream_id: String::from_utf8_lossy(stream_id).into_owned(),
            connection,
            transport,
            encoding,
        })
    })();
    let Some(stream) = stream else {
        return Err(ck.schema("\"stream\" has the wrong keys or an invalid field"));
    };

    let engine = (|| {
        let e = ck.fields(at("engine"), ENGINE_KEYS)?;
        let s = |i: usize| {
            ck.string(e.at(i))
                .map(|b| String::from_utf8_lossy(b).into_owned())
        };
        Some(Engine {
            version_string: s(0)?,
            sha256: s(1)?,
            display_server: s(2)?,
            rendering_driver: s(3)?,
            rendering_method: s(4)?,
        })
    })();
    let Some(engine) = engine else {
        return Err(ck.schema("\"engine\" has the wrong keys or a non-string field"));
    };

    let capture = (|| {
        let c = ck.fields(at("capture"), CAPTURE_KEYS)?;
        let calibrator_version = ck.int(c.at(0))?;
        if !ck.is_string_array(c.at(1)) || !ck.is_string_array(c.at(2)) {
            return None;
        }
        Some(Capture {
            calibrator_version,
            hooks_planned: ck.string_vec(c.at(1)),
            hooks_omitted: ck.string_vec(c.at(2)),
        })
    })();
    let Some(capture) = capture else {
        return Err(ck.schema("\"capture\" has the wrong keys or an invalid field"));
    };

    let vkeys = if v6 { VIEWPORT_KEYS_V6 } else { VIEWPORT_KEYS };
    let Some(vp) = ck.fields(at("viewport"), vkeys) else {
        return Err(ck.schema("\"viewport\" has the wrong keys"));
    };
    let vat = |name: &str| vp.at(vkeys.iter().position(|&k| k == name).unwrap());
    let policies: &[&'static str] = if v6 {
        &["observe", "enforce-min-size", "presentation"]
    } else {
        &["observe", "enforce-min-size"]
    };
    let fields = (|| {
        Some((
            ck.int(vat("canvas_cull_mask"))?,
            ck.int(vat("root_canvas"))?,
            ck.int_pair(vat("logical_size"))?,
            ck.int_pair(vat("host_window_size"))?,
            ck.one_of_str(vat("stretch_applied_by"), &["receiver"])?,
            ck.one_of_str(vat("root_size_policy"), policies)?,
            ck.one_of_str(
                vat("host_size_status"),
                &["match", "degenerate-visible", "degenerate-window"],
            )?,
        ))
    })();
    let Some((
        canvas_cull_mask,
        root_canvas,
        logical_size,
        host_window_size,
        _,
        root_size_policy,
        host_size_status,
    )) = fields
    else {
        return Err(ck.schema("\"viewport\" has an invalid field"));
    };
    let mut presentation_size = None;
    let mut font_oversampling = None;
    let mut snap_2d = None;
    if v6 {
        let Some(p) = ck.int_pair(vat("presentation_size")) else {
            return Err(ck.schema("\"viewport.presentation_size\" is not a pair of integers"));
        };
        presentation_size = Some(p);
        match ck.doc.as_num(vat("font_oversampling")) {
            Some(x) if x > 0.0 => font_oversampling = Some(x),
            _ => {
                return Err(ck.err(
                    "viewport-entry",
                    "\"font_oversampling\" is not a positive number",
                ));
            }
        }
        let snap = (|| {
            let s = ck.fields(vat("snap_2d"), SNAP_2D_KEYS)?;
            Some((ck.boolean(s.at(0))?, ck.boolean(s.at(1))?))
        })();
        let Some(snap) = snap else {
            return Err(ck.schema("\"viewport.snap_2d\" has the wrong keys or an invalid field"));
        };
        snap_2d = Some(snap);
    }
    let stretch = (|| {
        let s = ck.fields(vat("stretch"), STRETCH_KEYS)?;
        Some(Stretch {
            mode: ck.one_of_str(s.at(0), &["disabled", "canvas_items", "viewport"])?,
            aspect: ck.one_of_str(
                s.at(1),
                &["ignore", "keep", "keep_width", "keep_height", "expand"],
            )?,
            scale_mode: ck.one_of_str(s.at(2), &["fractional", "integer"])?,
        })
    })();
    let Some(stretch) = stretch else {
        return Err(ck.schema("\"viewport.stretch\" has the wrong keys or an invalid field"));
    };
    if let Some(p) = presentation_size {
        if root_size_policy != "presentation" {
            if p != logical_size {
                return Err(ck.err(
                    "viewport-entry",
                    "\"presentation_size\" differs from \"logical_size\" without root_size_policy \"presentation\"",
                ));
            }
        } else if stretch.mode == "disabled" && p != logical_size {
            return Err(ck.err(
                "viewport-entry",
                "\"presentation_size\" differs from \"logical_size\" under stretch \"disabled\"",
            ));
        }
    }

    let resources = check_resources(ck, at("resources"), version)?;

    let mut shader_policy = None;
    if v5 {
        let m = (|| {
            let m = ck.fields(at("materials"), MATERIALS_KEYS)?;
            ck.one_of_str(m.at(0), SHADER_POLICIES)
        })();
        let Some(m) = m else {
            return Err(ck.schema("\"materials\" has the wrong keys or an invalid field"));
        };
        shader_policy = Some(m);
    }

    let fkeys = if v5 { FEATURES_KEYS_V5 } else { FEATURES_KEYS };
    let features = (|| {
        let f = ck.fields(at("features"), fkeys)?;
        let fat = |name: &str| f.at(fkeys.iter().position(|&k| k == name).unwrap());
        let ops = string_vec_checked(ck, fat("ops"))?;
        let item_state = string_vec_checked(ck, fat("item_state"))?;
        let canvas_state = if v5 {
            Some(string_vec_checked(ck, fat("canvas_state"))?)
        } else {
            None
        };
        let resources = string_vec_checked(ck, fat("resources"))?;
        let ur = ck.arr(fat("unsupported_resources"))?;
        let mut unsupported_resources = Vec::new();
        let mut last: Option<&[u8]> = None;
        for &e in ur {
            let ef = ck.fields(e, &["resource", "reason"])?;
            let resource = ck.string(ef.at(0))?;
            let reason = ck.one_of_str(ef.at(1), UNSUPPORTED_RESOURCE_REASONS)?;
            if let Some(l) = last {
                if js_cmp(l, resource) != Ordering::Less {
                    return None;
                }
            }
            last = Some(resource);
            unsupported_resources.push((String::from_utf8_lossy(resource).into_owned(), reason));
        }
        let observed_unsupported_ops = string_vec_checked(ck, fat("observed_unsupported_ops"))?;
        let unobserved = string_vec_checked(ck, fat("unobserved"))?;
        let publication = String::from_utf8_lossy(ck.string(fat("publication"))?).into_owned();
        Some(Features {
            ops,
            item_state,
            canvas_state,
            resources,
            unsupported_resources,
            observed_unsupported_ops,
            unobserved,
            publication,
        })
    })();
    let Some(features) = features else {
        return Err(ck.schema("\"features\" has the wrong keys or an invalid field"));
    };

    let mut publication = None;
    if v6 {
        let p = (|| {
            let keys = if version >= 7 {
                PUBLICATION_KEYS_V7
            } else {
                PUBLICATION_KEYS
            };
            let p = ck.fields(at("publication"), keys)?;
            let mode = ck.one_of_str(p.at(0), &["every-frame", "rate"])?;
            let target_fps = if ck.null(p.at(1)) {
                None
            } else {
                Some(ck.int_ge(p.at(1), 1)?)
            };
            // The wide shape check (an integer at all) is meta-schema; the 1..2 rule below is
            // publication-entry (render-stream-7.md "As built (G7w)").
            let credit_window = if version >= 7 {
                Some(ck.int_ge(p.at(2), 0)?)
            } else {
                None
            };
            Some(Publication {
                mode,
                target_fps,
                credit_window,
            })
        })();
        let Some(p) = p else {
            return Err(ck.schema("\"publication\" has the wrong keys or an invalid field"));
        };
        if (p.mode == "every-frame") != p.target_fps.is_none() {
            return Err(ck.err(
                "publication-entry",
                "\"every-frame\" must carry target_fps null, and \"rate\" must carry a non-null target_fps",
            ));
        }
        if p.mode == "rate" && p.target_fps.unwrap() > 240 {
            return Err(ck.err(
                "publication-entry",
                "\"rate\"'s target_fps must be in 1..240",
            ));
        }
        if let Some(w) = p.credit_window {
            if !(1..=2).contains(&w) {
                return Err(ck.err(
                    "publication-entry",
                    "publication.credit_window must be in 1..2",
                ));
            }
            if w != 1 && stream.transport == "file" {
                return Err(ck.err(
                    "publication-entry",
                    "a \"file\" stream must declare publication.credit_window 1",
                ));
            }
        }
        if p.mode == "rate" && stream.transport == "file" {
            return Err(ck.err(
                "publication-entry",
                "a \"file\" stream must not declare publication \"rate\"",
            ));
        }
        publication = Some(p);
    }

    let sab_v = at("sabotage");
    let mut sabotage = None;
    if !ck.null(sab_v) {
        let s = (|| {
            let s = ck.fields(sab_v, SABOTAGE_KEYS)?;
            let kind = ck.one_of_str(s.at(0), SABOTAGE_KINDS)?;
            let frame = ck.int_ge(s.at(1), 1)?;
            let op = if ck.null(s.at(2)) {
                None
            } else {
                Some(String::from_utf8_lossy(ck.string(s.at(2))?).into_owned())
            };
            Some(Sabotage { kind, frame, op })
        })();
        let Some(s) = s else {
            return Err(ck.schema("\"sabotage\" is neither null nor a valid sabotage object"));
        };
        if (s.kind == "omit-op") != s.op.is_some() {
            return Err(ck.schema("\"sabotage.op\" must be non-null exactly for kind \"omit-op\""));
        }
        if version < 8 && SABOTAGE_V8_ONLY.contains(&s.kind) {
            return Err(ck.schema(format!(
                "\"sabotage.kind\" \"{}\" is legal only at /8",
                s.kind
            )));
        }
        sabotage = Some(s);
    }

    let mut adoption = None;
    if version >= 8 {
        // render-stream-8.md "Session": null, or {"mode":"arm","frame":<int >= 1>}.
        let av = at("adoption");
        if !ck.null(av) {
            let a = (|| {
                let a = ck.fields(av, ADOPTION_KEYS)?;
                if ck.string(a.at(0)) != Some(b"arm") {
                    return None;
                }
                ck.int(a.at(1))
            })();
            let Some(frame) = a else {
                return Err(ck.err(
                    "adoption-entry",
                    "\"adoption\" is neither null nor {\"mode\":\"arm\",\"frame\":<integer>}",
                ));
            };
            if frame < 1 {
                return Err(ck.err(
                    "adoption-entry",
                    format!("adoption.frame is {frame}, not >= 1"),
                ));
            }
            adoption = Some(Adoption { frame });
        }
    }

    ck.blocks(at("blocks"), SESSION_BLOCK_NAMES, None, blocks)?;
    for (i, &expected) in SESSION_BLOCK_COUNTS.iter().enumerate() {
        if blocks[i].count != expected {
            return Err(ck.schema(format!(
                "session block \"{}\" has count {}, expected {expected}",
                SESSION_BLOCK_NAMES[i], blocks[i].count
            )));
        }
    }

    Ok(Session {
        version,
        protocol: expected_protocol,
        session_id,
        stream,
        engine,
        capture,
        viewport: Viewport {
            canvas_cull_mask,
            root_canvas,
            logical_size,
            stretch,
            root_size_policy,
            presentation_size,
            host_size_status,
            host_window_size,
            font_oversampling,
            snap_2d,
        },
        resources,
        shader_policy,
        features,
        publication,
        sabotage,
        adoption,
        unknown_item_skip: skip_declared,
        clear_color: [0.0; 4],
        root_canvas_xform: [0.0; 6],
        host_visible_rect: [0.0; 4],
        host_final_xform: [0.0; 6],
        content_scale_factor: 0.0,
    })
}

// ------------------------------------------------------------------------------------- transaction

/// A wire command op.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Op {
    Rect,
    TextureRect,
    TextureRectRegion,
    Msdf,
    Line,
    Polyline,
    Multiline,
    Circle,
    Primitive,
    Polygon,
    TriangleArray,
    NinePatch,
    Mesh,
    SetTransform,
    ClipIgnore,
    Unsupported,
}

impl Op {
    pub fn parse(text: &[u8]) -> Option<Op> {
        Some(match text {
            b"add_rect" => Op::Rect,
            b"add_texture_rect" => Op::TextureRect,
            b"add_texture_rect_region" => Op::TextureRectRegion,
            b"add_msdf_texture_rect_region" => Op::Msdf,
            b"add_line" => Op::Line,
            b"add_polyline" => Op::Polyline,
            b"add_multiline" => Op::Multiline,
            b"add_circle" => Op::Circle,
            b"add_primitive" => Op::Primitive,
            b"add_polygon" => Op::Polygon,
            b"add_triangle_array" => Op::TriangleArray,
            b"add_nine_patch" => Op::NinePatch,
            b"add_mesh" => Op::Mesh,
            b"add_set_transform" => Op::SetTransform,
            b"add_clip_ignore" => Op::ClipIgnore,
            b"unsupported" => Op::Unsupported,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Rect => "add_rect",
            Op::TextureRect => "add_texture_rect",
            Op::TextureRectRegion => "add_texture_rect_region",
            Op::Msdf => "add_msdf_texture_rect_region",
            Op::Line => "add_line",
            Op::Polyline => "add_polyline",
            Op::Multiline => "add_multiline",
            Op::Circle => "add_circle",
            Op::Primitive => "add_primitive",
            Op::Polygon => "add_polygon",
            Op::TriangleArray => "add_triangle_array",
            Op::NinePatch => "add_nine_patch",
            Op::Mesh => "add_mesh",
            Op::SetTransform => "add_set_transform",
            Op::ClipIgnore => "add_clip_ignore",
            Op::Unsupported => "unsupported",
        }
    }
}

/// One wire command (render-stream-2.md to -4.md "Command").
#[derive(Clone, Debug)]
pub struct CmdMeta {
    pub op: Op,
    /// aa (rect, line, polyline, multiline, circle), tile (texture_rect), transpose
    /// (texture_rect_region), draw_center (nine_patch), ignore (clip_ignore).
    pub b1: bool,
    /// transpose (texture_rect), clip_uv (texture_rect_region).
    pub b2: bool,
    pub tex: Option<Id>,
    pub n: u64,
    pub colors: u64,
    pub uvs: u64,
    pub indices: u64,
    pub count: i64,
    pub outline: i64,
    pub i: u64,
    pub f: u64,
    pub mesh: Id,
    pub x_axis: Axis,
    pub y_axis: Axis,
    pub name: Option<Box<str>>,
    pub reason: UnsupportedCmdReason,
}

impl CmdMeta {
    fn new(op: Op) -> CmdMeta {
        CmdMeta {
            op,
            b1: false,
            b2: false,
            tex: None,
            n: 0,
            colors: 0,
            uvs: 0,
            indices: 0,
            count: 0,
            outline: 0,
            i: 0,
            f: 0,
            mesh: 0,
            x_axis: Axis::Stretch,
            y_axis: Axis::Stretch,
            name: None,
            reason: UnsupportedCmdReason::UnsupportedOp,
        }
    }

    /// `commandFloatCount` (saturating; offsets beyond u64 are never valid).
    pub fn float_count(&self) -> u64 {
        let s = |a: u64, b: u64| a.saturating_mul(b);
        match self.op {
            Op::Rect | Op::TextureRect => 8,
            Op::TextureRectRegion => 12,
            Op::Msdf => 14,
            Op::Line => 9,
            Op::Polyline | Op::Multiline => 1u64
                .saturating_add(s(2, self.n))
                .saturating_add(s(4, self.colors)),
            Op::Circle => 7,
            Op::Primitive | Op::Polygon | Op::TriangleArray => s(2, self.n)
                .saturating_add(s(4, self.colors))
                .saturating_add(s(2, self.uvs)),
            Op::NinePatch => 16,
            Op::Mesh => 10,
            Op::SetTransform => 6,
            Op::ClipIgnore | Op::Unsupported => 0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ParamMeta {
    pub name: Box<str>,
    pub ty: VariantType,
    pub n: u64,
    pub tex: Option<Id>,
    pub f: u64,
}

#[derive(Clone, Debug)]
pub struct CanvasMeta {
    pub id: Id,
    pub origin: Origin,
    pub root: bool,
    pub attached: bool,
    /// /6 only.
    pub layer: Option<(i64, i64)>,
    pub items: Rng,
}

#[derive(Clone, Debug)]
pub struct ItemMeta {
    pub id: Id,
    pub origin: Origin,
    pub parent: Option<Parent>,
    pub children: Rng,
    pub visible: bool,
    pub draw_index: i64,
    pub z_index: i64,
    pub z_relative: bool,
    pub behind: bool,
    pub clip: bool,
    pub custom_rect: bool,
    pub visibility_layer: u32,
    pub texture_filter: Filter,
    pub texture_repeat: Repeat,
    pub material: Option<Id>,
    pub use_parent_material: bool,
    pub instance_params: Rng,
    /// /10 only: `None` is a null `canvas_group`.
    pub canvas_group: Option<CanvasGroupMeta>,
    /// /10 only: a non-null `copy_to_backbuffer`'s `f`.
    pub copy_to_backbuffer: Option<u64>,
    pub content_version: i64,
    pub commands: Option<Rng>,
}

/// A non-null /10 `canvas_group` (render-stream-10.md "Item"); its two floats, `clear_margin`
/// then `fit_margin`, are at `f` in `backbuffer_f32`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CanvasGroupMeta {
    pub mode: CanvasGroupMode,
    pub fit_empty: bool,
    pub blur_mipmaps: bool,
    pub f: u64,
}

#[derive(Clone, Debug)]
pub struct MeshMeta {
    pub id: Id,
    pub origin: Origin,
    pub adopted_content: Option<AdoptedContent>,
    pub status: EntryStatus,
    pub reason: Option<&'static str>,
    pub version: i64,
    pub f: Option<u64>,
    pub surfaces: Vec<MeshSurface>,
}

#[derive(Clone, Debug)]
pub struct MaterialMeta {
    pub id: Id,
    pub origin: Origin,
    pub status: EntryStatus,
    pub reason: Option<&'static str>,
    pub version: i64,
    pub shader: Option<Id>,
    pub params: Rng,
}

#[derive(Clone, Debug)]
pub struct UnsupportedMeta {
    pub op: Box<str>,
    pub item: Option<i64>,
    pub reason: &'static str,
}

/// A checked transaction meta, in reusable buffers (cleared per record).
#[derive(Default, Debug)]
pub struct TxMeta {
    pub seq: i64,
    pub frame: i64,
    pub encoding: Option<Encoding>,
    pub base_seq: Option<i64>,
    pub status: Option<TxStatus>,
    pub failures: Vec<Failure>,
    pub unsupported: Vec<UnsupportedMeta>,
    pub unknown_items: Option<UnknownItems>,
    /// P3-TM: `/10`'s `shader_time.f`, the host's shader time's offset in `param_f64`.
    pub shader_time_f: Option<u64>,
    pub default_texture_filter: Option<Filter>,
    pub default_texture_repeat: Option<Repeat>,
    pub removed_canvases: Vec<i64>,
    pub removed_items: Vec<i64>,
    pub removed_textures: Vec<i64>,
    pub removed_meshes: Vec<i64>,
    pub removed_shaders: Vec<i64>,
    pub removed_materials: Vec<i64>,
    pub canvases: Vec<CanvasMeta>,
    pub items: Vec<ItemMeta>,
    pub cmds: Vec<CmdMeta>,
    pub ids: Vec<Id>,
    pub params: Vec<ParamMeta>,
    pub textures: Vec<Texture>,
    pub meshes: Vec<MeshMeta>,
    pub shaders: Vec<Shader>,
    pub materials: Vec<MaterialMeta>,
    pub blocks: Vec<BlockDesc>,
}

impl TxMeta {
    pub(crate) fn clear(&mut self) {
        self.failures.clear();
        self.unsupported.clear();
        self.unknown_items = None;
        self.shader_time_f = None;
        self.removed_canvases.clear();
        self.removed_items.clear();
        self.removed_textures.clear();
        self.removed_meshes.clear();
        self.removed_shaders.clear();
        self.removed_materials.clear();
        self.canvases.clear();
        self.items.clear();
        self.cmds.clear();
        self.ids.clear();
        self.params.clear();
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.materials.clear();
        self.blocks.clear();
    }
    pub fn encoding(&self) -> Encoding {
        self.encoding.unwrap_or(Encoding::Full)
    }
    pub fn is_full(&self) -> bool {
        self.encoding() == Encoding::Full
    }
}

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

fn filter(ck: &Ck, v: Value) -> Option<Filter> {
    ck.one_of(v, FILTERS).map(|i| Filter::ALL[i])
}
fn repeat(ck: &Ck, v: Value) -> Option<Repeat> {
    ck.one_of(v, REPEATS).map(|i| Repeat::ALL[i])
}
fn origin(ck: &Ck, v: Value) -> Option<Origin> {
    ck.one_of(v, &["created", "root-query", "adopted"])
        .map(|i| Origin::ALL[i])
}
fn enum_of<T: Copy>(ck: &Ck, v: Value, all: &[T], name: fn(T) -> &'static str) -> Option<T> {
    let s = ck.string(v)?;
    all.iter().copied().find(|&t| name(t).as_bytes() == s)
}

/// `checkParamEntrySchema`.
fn check_param(ck: &mut Ck, p: Value, wherein: &str) -> Result<ParamMeta, Error> {
    let err = |ck: &Ck, d: &str| ck.err("param-entry", format!("a {wherein} param {d}"));
    let Some(f) = ck.fields(p, PARAM_KEYS) else {
        return Err(err(ck, "has the wrong keys"));
    };
    if ck.string(f.at(0)).is_none() {
        return Err(err(ck, "\"name\" is not a string"));
    }
    let Some(name) = ck.owned(f.at(0)) else {
        return Err(err(ck, "\"name\" holds a lone surrogate (unsupported)"));
    };
    let Some(ty) = enum_of(ck, f.at(1), VariantType::ALL, VariantType::as_str) else {
        return Err(err(ck, "has an invalid type"));
    };
    let Some(n) = ck.int_ge(f.at(2), 1) else {
        return Err(err(ck, "\"n\" is not an integer >= 1"));
    };
    let Some(tex) = ck.opt_id1(f.at(3)) else {
        return Err(err(ck, "\"tex\" is neither null nor an integer >= 1"));
    };
    if (ty == VariantType::Rid) != tex.is_some() {
        return Err(err(ck, "\"tex\" must be non-null exactly for type \"rid\""));
    }
    let Some(fo) = ck.uint(f.at(4)) else {
        return Err(err(ck, "\"f\" is not a non-negative integer"));
    };
    Ok(ParamMeta {
        name,
        ty,
        n: n as u64,
        tex,
        f: fo,
    })
}

/// The origin of a resource-table entry: "created" below /8, "created" or "adopted" from /8
/// (render-stream-8.md "Resource tables").
fn table_origin(ck: &Ck, v: Value, version: u8) -> Option<Origin> {
    match ck.string(v)? {
        b"created" => Some(Origin::Created),
        b"adopted" if version >= 8 => Some(Origin::Adopted),
        _ => None,
    }
}

fn table_origin_message(version: u8) -> &'static str {
    if version >= 8 {
        "\"origin\" must be \"created\" or \"adopted\""
    } else {
        "\"origin\" must be \"created\""
    }
}

/// `adopted_content` of a /8 texture or mesh entry: null or "current"/"creation", non-null exactly
/// when `origin` is "adopted" (self-coded `adoption-entry`).
fn check_adopted_content(
    ck: &Ck,
    v: Value,
    origin: Origin,
    what: &str,
) -> Result<Option<AdoptedContent>, Error> {
    let content = if ck.null(v) {
        None
    } else if let Some(i) = ck.one_of(v, &["current", "creation"]) {
        Some(AdoptedContent::ALL[i])
    } else {
        return Err(ck.schema(format!(
            "a {what} entry's \"adopted_content\" is neither null nor \"current\"/\"creation\""
        )));
    };
    if (origin == Origin::Adopted) != content.is_some() {
        return Err(ck.err(
            "adoption-entry",
            format!(
                "a {what} entry's \"adopted_content\" must be non-null exactly when \"origin\" is \"adopted\""
            ),
        ));
    }
    Ok(content)
}

/// Every `Image.Format` name (render-stream-2.md "Texture payload"): a /8 texture entry's
/// `source_format` must be one of them.
const IMAGE_FORMAT_NAMES: &[&str] = &[
    "L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
    "RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
    "BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
    "ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
    "ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
];

/// `checkTextureEntrySchema`.
fn check_texture(ck: &mut Ck, t: Value, version: u8) -> Result<Texture, Error> {
    let err = |ck: &Ck, d: &str| ck.schema(format!("a textures[] entry {d}"));
    // render-stream-8.md "Resource tables": at /8 `adopted_content` follows `origin` and
    // `source_format` follows `format`, so the later keys shift by one, then two.
    let v8 = version >= 8;
    let v9 = version >= 9;
    let (s1, s2) = if v8 { (1, 2) } else { (0, 0) };
    let Some(f) = ck.fields(
        t,
        if v9 {
            TEXTURE_KEYS_V9
        } else if v8 {
            TEXTURE_KEYS_V8
        } else {
            TEXTURE_KEYS
        },
    ) else {
        return Err(err(ck, "has the wrong keys"));
    };
    let Some(id) = ck.id1(f.at(0)) else {
        return Err(err(ck, "\"id\" is not an integer >= 1"));
    };
    let origin = table_origin(ck, f.at(1), version).ok_or_else(|| {
        err(
            ck,
            if v8 {
                "\"origin\" must be \"created\" or \"adopted\""
            } else {
                "\"origin\" must be \"created\""
            },
        )
    })?;
    let mut adopted_content = None;
    let mut source_format = None;
    if v8 {
        adopted_content = check_adopted_content(ck, f.at(2), origin, "textures[]")?;
        source_format = if ck.null(f.at(9)) {
            None
        } else if let Some(name) = ck.owned(f.at(9)).filter(|n| IMAGE_FORMAT_NAMES.contains(&&**n)) {
            Some(name)
        } else {
            return Err(err(ck, "\"source_format\" is neither null nor an Image format name"));
        };
    }
    let Some(kind) = enum_of(ck, f.at(2 + s1), TextureKind::ALL, TextureKind::as_str) else {
        return Err(err(ck, "has an invalid kind"));
    };
    let Some(status) = enum_of(ck, f.at(3 + s1), EntryStatus::ALL, EntryStatus::as_str) else {
        return Err(err(ck, "has an invalid status"));
    };
    let reason = if ck.null(f.at(4 + s1)) {
        None
    } else if let Some(r) = ck.one_of_str(
        f.at(4 + s1),
        if v9 { TEXTURE_REASONS_V9 } else { TEXTURE_REASONS },
    ) {
        Some(r)
    } else {
        return Err(err(
            ck,
            "\"reason\" is neither null nor a valid texture reason",
        ));
    };
    let Some(version) = ck.int_ge(f.at(5 + s1), 1) else {
        return Err(err(ck, "\"version\" is not an integer >= 1"));
    };
    let hash = if ck.null(f.at(6 + s1)) {
        None
    } else if let Some(h) = ck.hash(f.at(6 + s1)) {
        Some(h)
    } else {
        return Err(err(
            ck,
            "\"hash\" is neither null nor 64 lowercase hex digits",
        ));
    };
    let format = if ck.null(f.at(7 + s1)) {
        None
    } else if let Some(s) = ck.owned(f.at(7 + s1)) {
        Some(s)
    } else {
        return Err(err(ck, "\"format\" is neither null nor a string"));
    };
    let Some(width) = ck.int_ge(f.at(8 + s2), 0) else {
        return Err(err(ck, "\"width\" is not a non-negative integer"));
    };
    let Some(height) = ck.int_ge(f.at(9 + s2), 0) else {
        return Err(err(ck, "\"height\" is not a non-negative integer"));
    };
    let Some(mipmaps) = ck.boolean(f.at(10 + s2)) else {
        return Err(err(ck, "\"mipmaps\" is not a boolean"));
    };
    let Some(payload_bytes) = ck.int_ge(f.at(11 + s2), 0) else {
        return Err(err(ck, "\"payload_bytes\" is not a non-negative integer"));
    };
    // render-stream-9.md "Texture entries": variants is an array of five-key objects; the
    // cross-entry rules are `delivery-entry` (validate.rs).
    let mut variants = Vec::new();
    if v9 {
        let Some(list) = ck.arr(f.at(12 + s2)) else {
            return Err(err(ck, "\"variants\" is not an array"));
        };
        for &item in list {
            let Some(v) = ck.fields(item, VARIANT_KEYS) else {
                return Err(err(ck, "has a \"variants\" entry with the wrong keys"));
            };
            let Some(encoding) = enum_of(ck, v.at(0), VariantEncoding::ALL, VariantEncoding::as_str)
            else {
                return Err(err(ck, "has a variant with an invalid \"encoding\""));
            };
            let Some(hash) = ck.hash(v.at(1)) else {
                return Err(err(
                    ck,
                    "has a variant \"hash\" that is not 64 lowercase hex digits",
                ));
            };
            let Some(payload_bytes) = ck.int_ge(v.at(2), 0) else {
                return Err(err(
                    ck,
                    "has a variant \"payload_bytes\" that is not a non-negative integer",
                ));
            };
            let format = if ck.null(v.at(3)) {
                None
            } else if let Some(s) = ck.owned(v.at(3)) {
                Some(s)
            } else {
                return Err(err(
                    ck,
                    "has a variant \"format\" that is neither null nor a string",
                ));
            };
            let params = if ck.null(v.at(4)) {
                None
            } else if let Some(s) = ck.owned(v.at(4)) {
                Some(s)
            } else {
                return Err(err(
                    ck,
                    "has a variant \"params\" that is neither null nor a string",
                ));
            };
            variants.push(TextureVariant {
                encoding,
                hash,
                payload_bytes,
                format,
                params,
            });
        }
    }
    let cs = if v9 { 1 } else { 0 };
    let canvas = if ck.null(f.at(12 + s2 + cs)) {
        None
    } else {
        let Some(c) = ck.fields(f.at(12 + s2 + cs), CANVAS_TEXTURE_KEYS) else {
            return Err(err(ck, "\"canvas\" has the wrong keys"));
        };
        let Some(diffuse) = ck.opt_id1(c.at(0)) else {
            return Err(err(
                ck,
                "\"canvas.diffuse\" is neither null nor an integer >= 1",
            ));
        };
        let Some(filter) = filter(ck, c.at(1)) else {
            return Err(err(ck, "\"canvas.filter\" is invalid"));
        };
        let Some(repeat) = repeat(ck, c.at(2)) else {
            return Err(err(ck, "\"canvas.repeat\" is invalid"));
        };
        Some(CanvasTexture {
            diffuse,
            filter,
            repeat,
        })
    };
    Ok(Texture {
        id,
        origin,
        adopted_content,
        kind,
        status,
        reason,
        version,
        hash,
        format,
        source_format,
        width,
        height,
        mipmaps,
        payload_bytes,
        variants,
        canvas,
    })
}

/// `checkMeshEntrySchema` (with `checkMeshSurfaceSchema`).
fn check_mesh(ck: &mut Ck, m: Value, version: u8) -> Result<MeshMeta, Error> {
    let err = |ck: &Ck, d: &str| ck.schema(format!("a meshes[] entry {d}"));
    let v8 = version >= 8;
    let s1 = if v8 { 1 } else { 0 };
    let Some(f) = ck.fields(m, if v8 { MESH_KEYS_V8 } else { MESH_KEYS }) else {
        return Err(err(ck, "has the wrong keys"));
    };
    let Some(id) = ck.id1(f.at(0)) else {
        return Err(err(ck, "\"id\" is not an integer >= 1"));
    };
    let origin = table_origin(ck, f.at(1), version).ok_or_else(|| {
        err(
            ck,
            if v8 {
                "\"origin\" must be \"created\" or \"adopted\""
            } else {
                "\"origin\" must be \"created\""
            },
        )
    })?;
    let adopted_content = if v8 {
        check_adopted_content(ck, f.at(2), origin, "meshes[]")?
    } else {
        None
    };
    let Some(status) = enum_of(ck, f.at(2 + s1), EntryStatus::ALL, EntryStatus::as_str) else {
        return Err(err(ck, "has an invalid status"));
    };
    let reason = if ck.null(f.at(3 + s1)) {
        None
    } else if let Some(r) = ck.one_of_str(f.at(3 + s1), MESH_REASONS) {
        Some(r)
    } else {
        return Err(err(
            ck,
            "\"reason\" is neither null nor a valid mesh reason",
        ));
    };
    let Some(version) = ck.int_ge(f.at(4 + s1), 1) else {
        return Err(err(ck, "\"version\" is not an integer >= 1"));
    };
    let fo = if ck.null(f.at(5 + s1)) {
        None
    } else if let Some(x) = ck.uint(f.at(5 + s1)) {
        Some(x)
    } else {
        return Err(err(ck, "\"f\" is neither null nor a non-negative integer"));
    };
    let Some(surfs) = ck.arr(f.at(6 + s1)) else {
        return Err(err(ck, "\"surfaces\" is not an array"));
    };
    let mut surfaces = Vec::with_capacity(surfs.len());
    for &s in surfs {
        let serr = |ck: &Ck, d: &str| ck.schema(format!("a meshes[].surfaces[] entry {d}"));
        let Some(sf) = ck.fields(s, MESH_SURFACE_KEYS) else {
            return Err(serr(ck, "has the wrong keys"));
        };
        let Some(hash) = ck.hash(sf.at(0)) else {
            return Err(serr(ck, "\"hash\" is not 64 lowercase hex digits"));
        };
        let Some(payload_bytes) = ck.int_ge(sf.at(1), 1) else {
            return Err(serr(ck, "\"payload_bytes\" is not an integer >= 1"));
        };
        let Some(primitive) = enum_of(ck, sf.at(2), Primitive::ALL, Primitive::as_str) else {
            return Err(serr(ck, "has an invalid primitive"));
        };
        let Some(format) = ck.int(sf.at(3)) else {
            return Err(serr(ck, "\"format\" is not an integer"));
        };
        let Some(vertex_count) = ck.int_ge(sf.at(4), 0) else {
            return Err(serr(ck, "\"vertex_count\" is not a non-negative integer"));
        };
        let Some(index_count) = ck.int_ge(sf.at(5), 0) else {
            return Err(serr(ck, "\"index_count\" is not a non-negative integer"));
        };
        surfaces.push(MeshSurface {
            hash,
            payload_bytes,
            primitive,
            format,
            vertex_count,
            index_count,
        });
    }
    Ok(MeshMeta {
        id,
        origin,
        adopted_content,
        status,
        reason,
        version,
        f: fo,
        surfaces,
    })
}

/// `checkShaderEntrySchema` (self-coded `shader-entry`).
fn check_shader(ck: &mut Ck, s: Value, version: u8) -> Result<Shader, Error> {
    let err = |ck: &Ck, d: &str| ck.err("shader-entry", format!("a shaders[] entry {d}"));
    let Some(f) = ck.fields(s, SHADER_KEYS) else {
        return Err(err(ck, "has the wrong keys"));
    };
    let Some(id) = ck.id1(f.at(0)) else {
        return Err(err(ck, "\"id\" is not an integer >= 1"));
    };
    let Some(origin) = table_origin(ck, f.at(1), version) else {
        return Err(err(ck, table_origin_message(version)));
    };
    let Some(status) = ck.one_of(f.at(2), &["ok", "unsupported"]) else {
        return Err(err(ck, "has an invalid status"));
    };
    let status = if status == 0 {
        EntryStatus::Ok
    } else {
        EntryStatus::Unsupported
    };
    let reason = if ck.null(f.at(3)) {
        None
    } else if let Some(r) = ck.one_of_str(f.at(3), SHADER_REASONS) {
        Some(r)
    } else {
        return Err(err(
            ck,
            "\"reason\" is neither null nor a valid shader reason",
        ));
    };
    if (status == EntryStatus::Ok) != reason.is_none() {
        return Err(err(ck, "\"reason\" must be null exactly for status \"ok\""));
    }
    let adopt_include = reason == Some("shader-adopt-include");
    if adopt_include && (version < 8 || origin != Origin::Adopted) {
        return Err(err(
            ck,
            "\"reason\" \"shader-adopt-include\" needs render-stream/8, origin \"adopted\" and no code",
        ));
    }
    let Some(version) = ck.int_ge(f.at(4), 1) else {
        return Err(err(ck, "\"version\" is not an integer >= 1"));
    };
    let mode = if ck.null(f.at(5)) {
        None
    } else if let Some(m) = enum_of(ck, f.at(5), ShaderMode::ALL, ShaderMode::as_str) {
        Some(m)
    } else {
        return Err(err(ck, "\"mode\" is neither null nor a valid shader mode"));
    };
    let source = if ck.null(f.at(6)) {
        None
    } else if let Some(m) = enum_of(ck, f.at(6), ShaderSource::ALL, ShaderSource::as_str) {
        Some(m)
    } else {
        return Err(err(
            ck,
            "\"source\" is neither null nor a valid shader source",
        ));
    };
    if mode.is_none() != source.is_none() {
        return Err(err(
            ck,
            "\"mode\" and \"source\" must be null together (no code yet)",
        ));
    }
    let hash = if ck.null(f.at(7)) {
        None
    } else if let Some(h) = ck.hash(f.at(7)) {
        Some(h)
    } else {
        return Err(err(
            ck,
            "\"hash\" is neither null nor 64 lowercase hex digits",
        ));
    };
    let Some(payload_bytes) = ck.int_ge(f.at(8), 0) else {
        return Err(err(ck, "\"payload_bytes\" is not a non-negative integer"));
    };
    if adopt_include && hash.is_some() {
        return Err(err(
            ck,
            "\"reason\" \"shader-adopt-include\" needs render-stream/8, origin \"adopted\" and no code",
        ));
    }
    let builtin = if ck.null(f.at(9)) {
        None
    } else {
        let b = (|| {
            let b = ck.fields(f.at(9), BUILTIN_KEYS)?;
            if ck.string(b.at(0)) != Some(b"canvas_item_material") {
                return None;
            }
            Some(Builtin {
                blend_mode: enum_of(ck, b.at(1), BlendMode::ALL, BlendMode::as_str)?,
                light_mode: enum_of(ck, b.at(2), LightMode::ALL, LightMode::as_str)?,
                particles_animation: ck.boolean(b.at(3))?,
            })
        })();
        let Some(b) = b else {
            return Err(err(
                ck,
                "\"builtin\" has the wrong keys or an invalid field",
            ));
        };
        Some(b)
    };
    let uses_v = ck.arr(f.at(10));
    let uses: Option<Vec<ShaderUse>> = uses_v.and_then(|a| {
        a.iter()
            .map(|&u| enum_of(ck, u, ShaderUse::ALL, ShaderUse::as_str))
            .collect()
    });
    let Some(uses) = uses else {
        return Err(err(ck, "\"uses\" is not an array of valid shader uses"));
    };
    if !ck.sorted_strings(uses_v.unwrap()) {
        return Err(err(ck, "\"uses\" is not sorted ascending"));
    }
    let Some(dts) = ck.arr(f.at(11)) else {
        return Err(err(ck, "\"default_textures\" is not an array"));
    };
    let mut default_textures = Vec::with_capacity(dts.len());
    let mut last: Option<(&[u8], i64)> = None;
    for &d in dts {
        let entry = (|| {
            let df = ck.fields(d, DEFAULT_TEXTURE_KEYS)?;
            let name = ck.string(df.at(0))?;
            let index = ck.int_ge(df.at(1), 0)?;
            let tex = ck.id1(df.at(2))?;
            Some((name, index, tex, df.at(0)))
        })();
        let Some((name, index, tex, name_v)) = entry else {
            return Err(err(
                ck,
                "a \"default_textures\" entry has the wrong keys or an invalid field",
            ));
        };
        if let Some((ln, li)) = last {
            let c = js_cmp(ln, name);
            if !(c == Ordering::Less || (c == Ordering::Equal && li < index)) {
                return Err(err(
                    ck,
                    "\"default_textures\" is not sorted strictly ascending by (name, index)",
                ));
            }
        }
        last = Some((name, index));
        let Some(name) = ck.owned(name_v) else {
            return Err(err(
                ck,
                "a \"default_textures\" name holds a lone surrogate (unsupported)",
            ));
        };
        default_textures.push(DefaultTexture { name, index, tex });
    }
    Ok(Shader {
        id,
        origin,
        status,
        reason,
        version,
        mode,
        source,
        hash,
        payload_bytes,
        builtin,
        uses,
        default_textures,
    })
}

/// `checkMaterialEntrySchema` (self-coded `material-entry`).
fn check_material(
    ck: &mut Ck,
    m: Value,
    params: &mut Vec<ParamMeta>,
    version: u8,
) -> Result<MaterialMeta, Error> {
    let err = |ck: &Ck, d: &str| ck.err("material-entry", format!("a materials[] entry {d}"));
    let Some(f) = ck.fields(m, MATERIAL_KEYS) else {
        return Err(err(ck, "has the wrong keys"));
    };
    let Some(id) = ck.id1(f.at(0)) else {
        return Err(err(ck, "\"id\" is not an integer >= 1"));
    };
    let Some(origin) = table_origin(ck, f.at(1), version) else {
        return Err(err(ck, table_origin_message(version)));
    };
    let Some(status) = ck.one_of(f.at(2), &["ok", "unsupported"]) else {
        return Err(err(ck, "has an invalid status"));
    };
    let status = if status == 0 {
        EntryStatus::Ok
    } else {
        EntryStatus::Unsupported
    };
    let reason = if ck.null(f.at(3)) {
        None
    } else if let Some(r) = ck.one_of_str(f.at(3), MATERIAL_REASONS) {
        Some(r)
    } else {
        return Err(err(
            ck,
            "\"reason\" is neither null nor a valid material reason",
        ));
    };
    if (status == EntryStatus::Ok) != reason.is_none() {
        return Err(err(ck, "\"reason\" must be null exactly for status \"ok\""));
    }
    let Some(version) = ck.int_ge(f.at(4), 1) else {
        return Err(err(ck, "\"version\" is not an integer >= 1"));
    };
    let Some(shader) = ck.opt_id1(f.at(5)) else {
        return Err(err(ck, "\"shader\" is neither null nor an integer >= 1"));
    };
    let Some(ps) = ck.arr(f.at(6)) else {
        return Err(err(ck, "\"params\" is not an array"));
    };
    let start = params.len() as u32;
    for (k, &p) in ps.iter().enumerate() {
        let pm = check_param(ck, p, "materials[]")?;
        if k > 0
            && js_cmp(params.last().unwrap().name.as_bytes(), pm.name.as_bytes()) != Ordering::Less
        {
            return Err(err(
                ck,
                "\"params\" is not sorted strictly ascending by name",
            ));
        }
        params.push(pm);
    }
    Ok(MaterialMeta {
        id,
        origin,
        status,
        reason,
        version,
        shader,
        params: Rng {
            start,
            end: params.len() as u32,
        },
    })
}

/// One command of an item (inside `checkTransactionSchema`'s items loop).
fn check_command(ck: &mut Ck, cmd: Value) -> Result<CmdMeta, Error> {
    if ck.doc.obj(cmd).is_none() {
        return Err(ck.schema("a commands[] entry is not an object"));
    }
    let op_v = ck.doc.get(cmd, "op");
    let op = op_v.and_then(|v| ck.string(v)).and_then(Op::parse);
    let Some(op) = op else {
        let shown = op_v
            .map(|v| {
                format!(
                    "{:?}",
                    String::from_utf8_lossy(ck.string(v).unwrap_or(b"?"))
                )
            })
            .unwrap_or("undefined".into());
        return Err(ck.schema(format!("a commands[] entry has an unknown op {shown}")));
    };
    let malformed = |ck: &Ck| {
        ck.schema(format!(
            "a commands[] \"{}\" entry is malformed",
            op.as_str()
        ))
    };
    let mut c = CmdMeta::new(op);
    let ok = (|| -> Option<()> {
        match op {
            Op::Rect | Op::Line | Op::Circle => {
                let keys = match op {
                    Op::Rect => ADD_RECT_KEYS,
                    Op::Line => ADD_LINE_KEYS,
                    _ => ADD_CIRCLE_KEYS,
                };
                let f = ck.fields(cmd, keys)?;
                c.b1 = ck.boolean(f.at(1))?;
                c.f = ck.uint(f.at(2))?;
            }
            Op::TextureRect => {
                let f = ck.fields(cmd, ADD_TEXTURE_RECT_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.b1 = ck.boolean(f.at(2))?;
                c.b2 = ck.boolean(f.at(3))?;
                c.f = ck.uint(f.at(4))?;
            }
            Op::TextureRectRegion => {
                let f = ck.fields(cmd, ADD_TEXTURE_RECT_REGION_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.b1 = ck.boolean(f.at(2))?;
                c.b2 = ck.boolean(f.at(3))?;
                c.f = ck.uint(f.at(4))?;
            }
            Op::Msdf => {
                let f = ck.fields(cmd, ADD_MSDF_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.outline = ck.int_ge(f.at(2), 0)?;
                c.f = ck.uint(f.at(3))?;
            }
            Op::Polyline | Op::Multiline => {
                let f = ck.fields(cmd, ADD_POLYLINE_KEYS)?;
                c.b1 = ck.boolean(f.at(1))?;
                c.n = ck.uint(f.at(2))?;
                c.colors = ck.uint(f.at(3))?;
                c.f = ck.uint(f.at(4))?;
            }
            Op::Primitive | Op::Polygon => {
                let f = ck.fields(cmd, ADD_PRIMITIVE_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.n = ck.uint(f.at(2))?;
                c.colors = ck.uint(f.at(3))?;
                c.uvs = ck.uint(f.at(4))?;
                c.f = ck.uint(f.at(5))?;
            }
            Op::TriangleArray => {
                let f = ck.fields(cmd, ADD_TRIANGLE_ARRAY_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.n = ck.uint(f.at(2))?;
                c.colors = ck.uint(f.at(3))?;
                c.uvs = ck.uint(f.at(4))?;
                c.indices = ck.uint(f.at(5))?;
                c.count = ck.int(f.at(6))?;
                c.i = ck.uint(f.at(7))?;
                c.f = ck.uint(f.at(8))?;
            }
            Op::NinePatch => {
                let f = ck.fields(cmd, ADD_NINE_PATCH_KEYS)?;
                c.tex = ck.opt_id1(f.at(1))?;
                c.x_axis = enum_of(ck, f.at(2), Axis::ALL, Axis::as_str)?;
                c.y_axis = enum_of(ck, f.at(3), Axis::ALL, Axis::as_str)?;
                c.b1 = ck.boolean(f.at(4))?;
                c.f = ck.uint(f.at(5))?;
            }
            Op::Mesh => {
                let f = ck.fields(cmd, ADD_MESH_KEYS)?;
                c.mesh = ck.id1(f.at(1))?;
                c.tex = ck.opt_id1(f.at(2))?;
                c.f = ck.uint(f.at(3))?;
            }
            Op::SetTransform => {
                let f = ck.fields(cmd, ADD_SET_TRANSFORM_KEYS)?;
                c.f = ck.uint(f.at(1))?;
            }
            Op::ClipIgnore => {
                let f = ck.fields(cmd, ADD_CLIP_IGNORE_KEYS)?;
                c.b1 = ck.boolean(f.at(1))?;
            }
            Op::Unsupported => {
                let f = ck.fields(cmd, UNSUPPORTED_CMD_KEYS)?;
                ck.string(f.at(1))?;
                c.reason = enum_of(
                    ck,
                    f.at(2),
                    UnsupportedCmdReason::ALL,
                    UnsupportedCmdReason::as_str,
                )?;
                // Deviation: a name with a lone surrogate cannot live in state.rs (reported here).
                c.name = Some(ck.owned(f.at(1))?);
            }
        }
        Some(())
    })();
    match ok {
        Some(()) => Ok(c),
        None => Err(malformed(ck)),
    }
}

/// `checkTransactionSchema`, filling `tx`.
fn check_transaction(ck: &mut Ck, meta: Value, version: u8, tx: &mut TxMeta) -> Result<(), Error> {
    tx.clear();
    let v6 = version >= 6;
    let v5 = version >= 5;
    let v4 = version >= 4;
    let base = if v5 {
        TRANSACTION_KEYS_V5
    } else if v4 {
        TRANSACTION_KEYS_V4
    } else {
        TRANSACTION_KEYS
    };
    let has_unknown = v4 && ck.has_key(meta, "unknown_items");
    // P3-TM (render-stream-10.md "Shader time"): /10's optional `shader_time`, right before
    // `blocks`.
    let has_time = version >= 10 && ck.has_key(meta, "shader_time");
    let mut keys_buf: Vec<&str>;
    let keys: &[&str] = if has_unknown || has_time {
        keys_buf = base.to_vec();
        if has_unknown {
            let at = keys_buf.iter().position(|&k| k == "unsupported").unwrap() + 1;
            keys_buf.insert(at, "unknown_items");
        }
        if has_time {
            let at = keys_buf.iter().position(|&k| k == "blocks").unwrap();
            keys_buf.insert(at, "shader_time");
        }
        &keys_buf
    } else {
        base
    };
    let Some(f) = ck.fields(meta, keys) else {
        return Err(ck.schema("transaction has the wrong top-level keys or order"));
    };
    // Field positions (the optional unknown_items shifts every later key by one).
    let shift = has_unknown as usize;
    let pos = |name: &str| -> usize {
        let i = base.iter().position(|&k| k == name).unwrap();
        let i = if i >= 8 { i + shift } else { i };
        i + (has_time && name == "blocks") as usize
    };
    if has_unknown {
        let u = (|| {
            let u = ck.fields(f.at(8), UNKNOWN_ITEMS_KEYS)?;
            Some(UnknownItems {
                unknown_rids: ck.int_ge(u.at(0), 0)?,
                withheld_items: ck.int_ge(u.at(1), 0)?,
                withheld_commands: ck.int_ge(u.at(2), 0)?,
                unknown_calls: ck.int_ge(u.at(3), 0)?,
            })
        })();
        let Some(u) = u else {
            return Err(ck.schema(
                "\"unknown_items\" must be {unknown_rids, withheld_items, withheld_commands, unknown_calls}, each an integer >= 0",
            ));
        };
        tx.unknown_items = Some(u);
    }
    let Some(seq) = ck.int_ge(f.at(1), 1) else {
        return Err(ck.schema("\"seq\" is not an integer >= 1"));
    };
    tx.seq = seq;
    let Some(frame) = ck.int_ge(f.at(2), 1) else {
        return Err(ck.schema("\"frame\" is not an integer >= 1"));
    };
    tx.frame = frame;
    let Some(enc) = ck.one_of(f.at(3), &["full", "patch"]) else {
        return Err(ck.schema(format!("unknown encoding {}", lossy(ck, f.at(3)))));
    };
    tx.encoding = Some(if enc == 0 {
        Encoding::Full
    } else {
        Encoding::Patch
    });
    tx.base_seq = if ck.null(f.at(4)) {
        None
    } else if let Some(b) = ck.int_ge(f.at(4), 1) {
        Some(b)
    } else {
        return Err(ck.schema("\"base_seq\" is neither null nor an integer >= 1"));
    };
    let Some(st) = ck.one_of(f.at(5), &["ok", "capture-failure"]) else {
        return Err(ck.schema(format!("unknown status {}", lossy(ck, f.at(5)))));
    };
    tx.status = Some(if st == 0 {
        TxStatus::Ok
    } else {
        TxStatus::CaptureFailure
    });

    let Some(failures) = ck.arr(f.at(6)) else {
        return Err(ck.schema("\"failures\" is not an array"));
    };
    for &fv in failures {
        let e = (|| {
            let ff = ck.fields(fv, FAILURE_KEYS)?;
            let reason = ck.one_of_str(ff.at(0), FAILURE_REASONS)?;
            ck.string(ff.at(1))?;
            Some(Failure {
                reason,
                detail: ck.owned(ff.at(1))?,
            })
        })();
        let Some(e) = e else {
            return Err(ck.schema("a failures[] entry is malformed"));
        };
        tx.failures.push(e);
    }

    let Some(unsupported) = ck.arr(f.at(7)) else {
        return Err(ck.schema("\"unsupported\" is not an array"));
    };
    for &uv in unsupported {
        let e = (|| {
            let uf = ck.fields(uv, UNSUPPORTED_KEYS)?;
            ck.string(uf.at(0))?;
            let item = if ck.null(uf.at(1)) {
                None
            } else {
                Some(ck.int(uf.at(1))?)
            };
            Some((uf.at(0), item, uf.at(2)))
        })();
        let Some((op_v, item, reason_v)) = e else {
            return Err(ck.schema("an unsupported[] entry is malformed"));
        };
        let allowed = if v6 {
            if item.is_none() {
                SESSION_UNSUPPORTED_REASONS_V6
            } else {
                ITEM_UNSUPPORTED_REASONS_V5
            }
        } else if v5 {
            if item.is_none() {
                SESSION_UNSUPPORTED_REASONS_V5
            } else {
                ITEM_UNSUPPORTED_REASONS_V5
            }
        } else if item.is_none() {
            SESSION_UNSUPPORTED_REASONS
        } else {
            ITEM_UNSUPPORTED_REASONS
        };
        let Some(reason) = ck.one_of_str(reason_v, allowed) else {
            return Err(ck.schema("an unsupported[] entry is malformed"));
        };
        let Some(op) = ck.owned(op_v) else {
            return Err(
                ck.schema("an unsupported[] entry's op holds a lone surrogate (unsupported)")
            );
        };
        tx.unsupported.push(UnsupportedMeta { op, item, reason });
    }

    let dtf = filter(ck, f.at(pos("default_texture_filter"))).filter(|&x| x != Filter::Default);
    let Some(dtf) = dtf else {
        return Err(ck.schema("\"default_texture_filter\" is invalid or \"default\""));
    };
    tx.default_texture_filter = Some(dtf);
    let dtr = repeat(ck, f.at(pos("default_texture_repeat"))).filter(|&x| x != Repeat::Default);
    let Some(dtr) = dtr else {
        return Err(ck.schema("\"default_texture_repeat\" is invalid or \"default\""));
    };
    tx.default_texture_repeat = Some(dtr);

    if !ck.int_array(f.at(pos("removed_canvases")), &mut tx.removed_canvases) {
        return Err(ck.schema("\"removed_canvases\" is not an array of integers"));
    }
    if !ck.int_array(f.at(pos("removed_items")), &mut tx.removed_items) {
        return Err(ck.schema("\"removed_items\" is not an array of integers"));
    }
    if !ck.int_array(f.at(pos("removed_textures")), &mut tx.removed_textures) {
        return Err(ck.schema("\"removed_textures\" is not an array of integers"));
    }
    if v4 && !ck.int_array(f.at(pos("removed_meshes")), &mut tx.removed_meshes) {
        return Err(ck.schema("\"removed_meshes\" is not an array of integers"));
    }
    if v5
        && (!ck.int_array(f.at(pos("removed_shaders")), &mut tx.removed_shaders)
            || !ck.int_array(f.at(pos("removed_materials")), &mut tx.removed_materials))
    {
        return Err(
            ck.schema("\"removed_shaders\"/\"removed_materials\" is not an array of integers")
        );
    }

    let Some(canvases) = ck.arr(f.at(pos("canvases"))) else {
        return Err(ck.schema("\"canvases\" is not an array"));
    };
    let ckeys = if v6 { CANVAS_KEYS_V6 } else { CANVAS_KEYS };
    for &cv in canvases {
        let c = (|| {
            let cf = ck.fields(cv, ckeys)?;
            let id = ck.id(cf.at(0))?;
            let origin = origin(ck, cf.at(1))?;
            let root = if ck.null(cf.at(2)) {
                false
            } else if ck.string(cf.at(2)) == Some(b"root") {
                true
            } else {
                return None;
            };
            let attached = ck.boolean(cf.at(3))?;
            let items_at = if v6 { 6 } else { 4 };
            let items = ck.id_array(cf.at(items_at), &mut tx.ids)?;
            Some((
                CanvasMeta {
                    id,
                    origin,
                    root,
                    attached,
                    layer: None,
                    items,
                },
                cf,
            ))
        })();
        let Some((mut c, cf)) = c else {
            return Err(ck.schema("a canvases[] entry is malformed"));
        };
        if v6 {
            match (ck.int(cf.at(4)), ck.int(cf.at(5))) {
                (Some(l), Some(s)) => c.layer = Some((l, s)),
                _ => {
                    return Err(ck.err(
                        "canvas-entry",
                        format!(
                            "canvas {}'s \"layer\"/\"sublayer\" must both be integers",
                            c.id
                        ),
                    ))
                }
            }
        }
        tx.canvases.push(c);
    }

    let Some(items) = ck.arr(f.at(pos("items"))) else {
        return Err(ck.schema("\"items\" is not an array"));
    };
    let v10 = version >= 10;
    let ikeys = if v10 {
        ITEM_KEYS_V10
    } else if v5 {
        ITEM_KEYS_V5
    } else {
        ITEM_KEYS
    };
    let cv_at = if v10 {
        19
    } else if v5 {
        17
    } else {
        14
    };
    for &iv in items {
        let it = (|| {
            let itf = ck.fields(iv, ikeys)?;
            let id = ck.id(itf.at(0))?;
            let origin = origin(ck, itf.at(1))?;
            let visible = ck.boolean(itf.at(4))?;
            let draw_index = ck.int(itf.at(5))?;
            let z_index = ck.int(itf.at(6))?;
            let z_relative = ck.boolean(itf.at(7))?;
            let behind = ck.boolean(itf.at(8))?;
            let clip = ck.boolean(itf.at(9))?;
            let custom_rect = ck.boolean(itf.at(10))?;
            let visibility_layer = u32::try_from(ck.int(itf.at(11))?).ok()?;
            let texture_filter = filter(ck, itf.at(12))?;
            let texture_repeat = repeat(ck, itf.at(13))?;
            let content_version = ck.int(itf.at(cv_at))?;
            let children = ck.id_array(itf.at(3), &mut tx.ids)?;
            let cmds_v = itf.at(cv_at + 1);
            if !ck.null(cmds_v) {
                ck.arr(cmds_v)?;
            }
            Some((
                ItemMeta {
                    id,
                    origin,
                    parent: None,
                    children,
                    visible,
                    draw_index,
                    z_index,
                    z_relative,
                    behind,
                    clip,
                    custom_rect,
                    visibility_layer,
                    texture_filter,
                    texture_repeat,
                    material: None,
                    use_parent_material: false,
                    instance_params: Rng::default(),
                    canvas_group: None,
                    copy_to_backbuffer: None,
                    content_version,
                    commands: None,
                },
                itf,
            ))
        })();
        let Some((mut it, itf)) = it else {
            return Err(ck.schema("an items[] entry is malformed"));
        };
        if v5 {
            let mv = (|| {
                Some((
                    ck.opt_id1(itf.at(14))?,
                    ck.boolean(itf.at(15))?,
                    ck.arr(itf.at(16))?,
                ))
            })();
            let Some((material, upm, ips)) = mv else {
                return Err(ck.schema(
                    "an items[] entry has an invalid \"material\"/\"use_parent_material\"/\"instance_params\"",
                ));
            };
            it.material = material;
            it.use_parent_material = upm;
            let start = tx.params.len() as u32;
            for (k, &p) in ips.iter().enumerate() {
                let pm = check_param(ck, p, "items[].instance_params")?;
                if k > 0
                    && js_cmp(
                        tx.params.last().unwrap().name.as_bytes(),
                        pm.name.as_bytes(),
                    ) != Ordering::Less
                {
                    return Err(ck.schema("an items[] entry's \"instance_params\" is not sorted strictly ascending by name"));
                }
                tx.params.push(pm);
            }
            it.instance_params = Rng {
                start,
                end: tx.params.len() as u32,
            };
        }
        if v10 {
            let gv = itf.at(17);
            if !ck.null(gv) {
                let g = (|| {
                    let gf = ck.fields(gv, CANVAS_GROUP_KEYS)?;
                    Some(CanvasGroupMeta {
                        mode: enum_of(ck, gf.at(0), CanvasGroupMode::ALL, CanvasGroupMode::as_str)?,
                        fit_empty: ck.boolean(gf.at(1))?,
                        blur_mipmaps: ck.boolean(gf.at(2))?,
                        f: ck.uint(gf.at(3))?,
                    })
                })();
                let Some(g) = g else {
                    return Err(ck.schema("an items[] entry has an invalid \"canvas_group\""));
                };
                it.canvas_group = Some(g);
            }
            let bv = itf.at(18);
            if !ck.null(bv) {
                let b = (|| {
                    let bf = ck.fields(bv, COPY_TO_BACKBUFFER_KEYS)?;
                    ck.uint(bf.at(0))
                })();
                let Some(b) = b else {
                    return Err(ck.schema("an items[] entry has an invalid \"copy_to_backbuffer\""));
                };
                it.copy_to_backbuffer = Some(b);
            }
        }
        let pv = itf.at(2);
        if !ck.null(pv) {
            let p = (|| {
                let pf = ck.fields(pv, PARENT_KEYS)?;
                let kind = enum_of(ck, pf.at(0), ParentKind::ALL, ParentKind::as_str)?;
                Some(Parent {
                    kind,
                    id: ck.id(pf.at(1))?,
                })
            })();
            let Some(p) = p else {
                return Err(ck.schema("an items[] entry has an invalid \"parent\""));
            };
            it.parent = Some(p);
        }
        let cmds_v = itf.at(cv_at + 1);
        if let Some(cmds) = ck.arr(cmds_v) {
            let start = tx.cmds.len() as u32;
            for &cmd in cmds {
                let c = check_command(ck, cmd)?;
                tx.cmds.push(c);
            }
            it.commands = Some(Rng {
                start,
                end: tx.cmds.len() as u32,
            });
        }
        tx.items.push(it);
    }

    let Some(textures) = ck.arr(f.at(pos("textures"))) else {
        return Err(ck.schema("\"textures\" is not an array"));
    };
    for &t in textures {
        let t = check_texture(ck, t, version)?;
        tx.textures.push(t);
    }
    if v4 {
        let Some(meshes) = ck.arr(f.at(pos("meshes"))) else {
            return Err(ck.schema("\"meshes\" is not an array"));
        };
        for &m in meshes {
            let m = check_mesh(ck, m, version)?;
            tx.meshes.push(m);
        }
    }
    if v5 {
        let Some(shaders) = ck.arr(f.at(pos("shaders"))) else {
            return Err(ck.schema("\"shaders\" is not an array"));
        };
        for &s in shaders {
            let s = check_shader(ck, s, version)?;
            tx.shaders.push(s);
        }
        let Some(materials) = ck.arr(f.at(pos("materials"))) else {
            return Err(ck.schema("\"materials\" is not an array"));
        };
        for &m in materials {
            let m = check_material(ck, m, &mut tx.params, version)?;
            tx.materials.push(m);
        }
    }
    if has_time {
        let at = keys.iter().position(|&k| k == "shader_time").unwrap();
        let t = (|| {
            let t = ck.fields(f.at(at), &["f"])?;
            ck.int_ge(t.at(0), 0)
        })();
        let Some(t) = t else {
            return Err(ck.schema("\"shader_time\" must be {f}, an integer >= 0"));
        };
        tx.shader_time_f = Some(t as u64);
    }
    let n = transaction_block_count(version);
    let types = if v4 {
        Some(&TRANSACTION_BLOCK_TYPES[..n])
    } else {
        None
    };
    ck.blocks(
        f.at(pos("blocks")),
        &TRANSACTION_BLOCK_NAMES[..n],
        types,
        &mut tx.blocks,
    )?;
    Ok(())
}

// ------------------------------------------------------------------------------------- resource, end

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceMeta {
    pub hash: Hash,
    pub bytes: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EndMeta {
    pub transactions: i64,
    /// "shutdown" or "disarm".
    pub reason: &'static str,
    /// bytes_total, encode_ns_total, snapshot_ns_total, diff_ns_total, max_record_bytes,
    /// full_transactions, patch_transactions, resource_records, resource_bytes.
    pub stats: [i64; 9],
}

fn check_resource(
    ck: &mut Ck,
    meta: Value,
    blocks: &mut Vec<BlockDesc>,
) -> Result<ResourceMeta, Error> {
    let Some(f) = ck.fields(meta, RESOURCE_KEYS) else {
        return Err(ck.schema("resource has the wrong top-level keys or order"));
    };
    let Some(hash) = ck.hash(f.at(1)) else {
        return Err(ck.schema("\"hash\" is not 64 lowercase hex digits"));
    };
    let Some(bytes) = ck.int_ge(f.at(2), 1) else {
        return Err(ck.schema("\"bytes\" is not an integer >= 1"));
    };
    // checkBlocksField, then the one-u8-block rule.
    blocks.clear();
    let Some(a) = ck.arr(f.at(3)) else {
        return Err(ck.schema("\"blocks\" is not an array"));
    };
    let mut first_name = None;
    for &entry in a {
        let Some(bf) = ck.fields(entry, BLOCK_KEYS) else {
            return Err(ck.schema("a blocks[] entry has the wrong keys"));
        };
        let ty = ck.string(bf.at(1)).and_then(BlockType::parse);
        match (ck.string(bf.at(0)), ty, ck.uint(bf.at(2))) {
            (Some(name), Some(ty), Some(count)) => {
                blocks.push(BlockDesc { ty, count });
                first_name.get_or_insert(name);
            }
            _ => return Err(ck.schema("a blocks[] entry has an invalid field")),
        }
    }
    if blocks.len() != 1
        || first_name != Some(b"payload".as_slice())
        || blocks[0].ty != BlockType::U8
    {
        return Err(ck.schema("\"blocks\" must be exactly one u8 block named \"payload\""));
    }
    if blocks[0].count as i64 != bytes || blocks[0].count > i64::MAX as u64 {
        return Err(ck.schema("the payload block's count disagrees with \"bytes\""));
    }
    Ok(ResourceMeta { hash, bytes })
}

fn check_end(ck: &mut Ck, meta: Value, blocks: &mut Vec<BlockDesc>) -> Result<EndMeta, Error> {
    blocks.clear();
    let Some(f) = ck.fields(meta, END_KEYS) else {
        return Err(ck.schema("end has the wrong top-level keys or order"));
    };
    let Some(transactions) = ck.int_ge(f.at(1), 0) else {
        return Err(ck.schema("\"transactions\" is not a non-negative integer"));
    };
    let Some(reason) = ck.one_of_str(f.at(2), &["shutdown", "disarm"]) else {
        return Err(ck.schema(format!("unknown reason {}", lossy(ck, f.at(2)))));
    };
    let stats = (|| {
        let s = ck.fields(f.at(3), STATS_KEYS)?;
        let mut out = [0i64; 9];
        for (k, o) in out.iter_mut().enumerate() {
            *o = ck.int(s.at(k))?;
        }
        Some(out)
    })();
    let Some(stats) = stats else {
        return Err(ck.schema("\"stats\" has the wrong keys or a non-integer field"));
    };
    if !ck.arr(f.at(4)).is_some_and(|a| a.is_empty()) {
        return Err(ck.schema("\"blocks\" must be an empty array for an end record"));
    }
    Ok(EndMeta {
        transactions,
        reason,
        stats,
    })
}

// ------------------------------------------------------------------------------------- decodeRecord

/// What a record decoded as. A transaction's fields are in the caller's [`TxMeta`].
#[derive(Debug)]
pub enum Decoded {
    Session(Box<Session>),
    Transaction,
    Resource(ResourceMeta),
    End(EndMeta),
}

/// Reusable storage for [`decode_record`].
#[derive(Default)]
pub struct DecodeBufs {
    pub json: Option<crate::json::Buffers>,
    pub descs: Vec<BlockDesc>,
    pub blocks: Vec<BlockRange>,
}

/// Every byte is printable ASCII (0x20..=0x7e).
pub fn printable_ascii(bytes: &[u8]) -> bool {
    // Branch-free per 32-byte chunk (vectorizes), early exit per chunk.
    let mut chunks = bytes.chunks_exact(32);
    for c in &mut chunks {
        let mut bad = 0u8;
        for &b in c {
            bad |= (b.wrapping_sub(0x20) >= 0x5f) as u8;
        }
        if bad != 0 {
            return false;
        }
    }
    chunks
        .remainder()
        .iter()
        .all(|&b| b.wrapping_sub(0x20) < 0x5f)
}

/// `decodeRecord()`: framing, `meta-json`, the schema checks, `meta-noncanonical`, then block
/// framing. `record` is one whole record (its `record_len` prefix included); `offset` is its
/// offset in the recording (messages only). On success `bufs.blocks` holds the block ranges.
pub fn decode_record(
    record: &[u8],
    offset: usize,
    version: u8,
    bufs: &mut DecodeBufs,
    tx: &mut TxMeta,
) -> Result<Decoded, Error> {
    decode_record_with(record, offset, version, bufs, tx, true)
}

/// [`decode_record`], optionally without the transaction fast path (`fast::transaction`), which
/// only ever accepts what the general path accepts and then fills `tx` identically.
pub fn decode_record_with(
    record: &[u8],
    offset: usize,
    version: u8,
    bufs: &mut DecodeBufs,
    tx: &mut TxMeta,
    fast_path: bool,
) -> Result<Decoded, Error> {
    let frame = wire::frame(record, offset)?;
    if fast_path
        && frame.meta.starts_with(b"{\"type\":\"transaction\",")
        && fast::transaction(frame.meta, version, tx).is_some()
    {
        let names = |i: usize| {
            TRANSACTION_BLOCK_NAMES
                .get(i)
                .copied()
                .unwrap_or("?")
                .to_string()
        };
        bufs.descs.clear();
        bufs.descs.extend_from_slice(&tx.blocks);
        wire::read_blocks(record, &frame, &tx.blocks, &names, offset, &mut bufs.blocks)?;
        return Ok(Decoded::Transaction);
    }
    if !printable_ascii(frame.meta) {
        return Err(Error::new(
            "meta-json",
            format!("record at offset {offset}: meta contains a non-printable-ASCII byte"),
        ));
    }
    let doc = match Doc::parse_with(frame.meta, bufs.json.take().unwrap_or_default()) {
        Ok(d) => d,
        Err(e) => {
            bufs.json = Some(e.buffers);
            return Err(Error::new(
                "meta-json",
                format!("record at offset {offset}: {}", e.message),
            ));
        }
    };
    let result = check_meta(&doc, offset, version, tx, &mut bufs.descs);
    let canonical = doc.lexically_canonical();
    bufs.json = Some(doc.into_buffers());
    let (decoded, dups) = result?;
    if dups || !canonical {
        return Err(Error::new(
            "meta-noncanonical",
            format!("record at offset {offset}: meta is not canonical JSON"),
        ));
    }
    let names = |i: usize| -> String {
        match &decoded {
            Decoded::Session(_) => SESSION_BLOCK_NAMES
                .get(i)
                .copied()
                .unwrap_or("?")
                .to_string(),
            Decoded::Transaction => TRANSACTION_BLOCK_NAMES
                .get(i)
                .copied()
                .unwrap_or("?")
                .to_string(),
            Decoded::Resource(_) => "payload".to_string(),
            Decoded::End(_) => "?".to_string(),
        }
    };
    let descs = std::mem::take(&mut bufs.descs);
    let r = wire::read_blocks(record, &frame, &descs, &names, offset, &mut bufs.blocks);
    bufs.descs = descs;
    r?;
    let mut decoded = decoded;
    if let Decoded::Session(s) = &mut decoded {
        let b = |i: usize| {
            F32s(&record[bufs.blocks[i].start..bufs.blocks[i].start + bufs.blocks[i].len])
        };
        s.clear_color = b(0).arr::<4>(0);
        s.root_canvas_xform = b(1).arr::<6>(0);
        s.host_visible_rect = b(2).arr::<4>(0);
        s.host_final_xform = b(3).arr::<6>(0);
        s.content_scale_factor = b(4).get(0);
    }
    Ok(decoded)
}

/// `checkMetaSchema`: returns the decoded kind and whether a checked object repeated a key.
fn check_meta(
    doc: &Doc,
    offset: usize,
    version: u8,
    tx: &mut TxMeta,
    descs: &mut Vec<BlockDesc>,
) -> Result<(Decoded, bool), Error> {
    let mut ck = Ck::new(doc, offset);
    let meta = doc.root();
    if doc.obj(meta).is_none() {
        return Err(ck.schema("meta is not a JSON object"));
    }
    let ty = doc.get(meta, "type").and_then(|v| doc.str_bytes(v));
    let decoded = match ty {
        Some(b"session") => {
            Decoded::Session(Box::new(check_session(&mut ck, meta, version, descs)?))
        }
        Some(b"transaction") => {
            check_transaction(&mut ck, meta, version, tx)?;
            descs.clear();
            descs.extend_from_slice(&tx.blocks);
            Decoded::Transaction
        }
        Some(b"resource") => Decoded::Resource(check_resource(&mut ck, meta, descs)?),
        Some(b"end") => Decoded::End(check_end(&mut ck, meta, descs)?),
        _ => {
            let shown = doc
                .get(meta, "type")
                .map(|v| lossy(&ck, v))
                .unwrap_or_else(|| "undefined".into());
            return Err(ck.schema(format!("unknown \"type\" {shown}")));
        }
    };
    Ok((decoded, ck.dups))
}
