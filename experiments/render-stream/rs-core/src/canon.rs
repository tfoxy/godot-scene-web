//! Canonical JSON of resolved state, byte-identical to TypeScript's `JSON.stringify(t)` for one
//! element `t` of `resolveRecording(data, version).transactions` (render-stream-2.md to -6.md
//! "Decoded and resolved forms"): every key in the TypeScript's insertion order, version-dependent
//! keys exactly where it includes them, float32 values printed as JavaScript prints the widened
//! double, float64 params as JavaScript prints them, non-finite numbers as `null`.
//!
//! Also the decoded-record form (`decodeRecording()`), a slow `serde_json` path for the
//! `*.decoded.json` goldens.

use crate::json::{write_int, write_number, write_string};
use crate::meta::{self, DecodeBufs, TxMeta};
use crate::state::*;
use crate::wire::{self, BlockType, Error};

/// The writer; the flag selects Godot's float spelling (the native receiver's state dumps,
/// [`write_state_godot`]) instead of JavaScript's.
struct W<'a>(&'a mut Vec<u8>, bool);

/// One float as Godot 4.5.1's `JSON.stringify(..., full_precision = true)` prints it
/// (core/io/json.cpp `_stringify` FLOAT, core/string/ustring.cpp `String::num`): `0.0` for zero,
/// else `%.{p}lf` with `p = max(1, 17 - floor(log10|x|))` (at most 32), trailing zeros removed
/// down to one digit after the point.
pub fn write_godot_float(out: &mut Vec<u8>, x: f64) {
    if x == 0.0 {
        out.extend_from_slice(b"0.0");
        return;
    }
    if x.is_nan() {
        out.extend_from_slice(b"nan");
        return;
    }
    if x.is_infinite() {
        out.extend_from_slice(if x < 0.0 { b"-inf" } else { b"inf" });
        return;
    }
    let magnitude = x.abs().log10();
    let precision = (17 - magnitude.floor() as i64).clamp(1, 32) as usize;
    let mut text = format!("{x:.precision$}");
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.push('0');
        }
    }
    out.extend_from_slice(text.as_bytes());
}

impl W<'_> {
    #[inline]
    fn raw(&mut self, s: &str) {
        self.0.extend_from_slice(s.as_bytes());
    }
    #[inline]
    fn key(&mut self, k: &str) {
        // Keys are fixed ASCII identifiers: no escaping needed.
        self.0.push(b'"');
        self.0.extend_from_slice(k.as_bytes());
        self.0.extend_from_slice(b"\":");
    }
    #[inline]
    fn str(&mut self, s: &str) {
        write_string(self.0, s.as_bytes());
    }
    #[inline]
    fn int(&mut self, v: i64) {
        write_int(self.0, v);
    }
    #[inline]
    fn f32(&mut self, v: f32) {
        self.f64(v as f64);
    }
    #[inline]
    fn f64(&mut self, v: f64) {
        if self.1 {
            write_godot_float(self.0, v);
        } else {
            write_number(self.0, v);
        }
    }
    #[inline]
    fn bool(&mut self, b: bool) {
        self.raw(if b { "true" } else { "false" });
    }
    #[inline]
    fn opt_id(&mut self, v: Option<Id>) {
        match v {
            Some(i) => self.int(i as i64),
            None => self.raw("null"),
        }
    }
    #[inline]
    fn opt_str(&mut self, v: Option<&str>) {
        match v {
            Some(s) => self.str(s),
            None => self.raw("null"),
        }
    }
    fn floats(&mut self, v: &[f32]) {
        self.0.push(b'[');
        for (i, &x) in v.iter().enumerate() {
            if i > 0 {
                self.0.push(b',');
            }
            self.f32(x);
        }
        self.0.push(b']');
    }
    fn f64s(&mut self, v: &[f64]) {
        self.0.push(b'[');
        for (i, &x) in v.iter().enumerate() {
            if i > 0 {
                self.0.push(b',');
            }
            self.f64(x);
        }
        self.0.push(b']');
    }
    fn ids(&mut self, v: &[Id]) {
        self.0.push(b'[');
        for (i, &x) in v.iter().enumerate() {
            if i > 0 {
                self.0.push(b',');
            }
            self.int(x as i64);
        }
        self.0.push(b']');
    }
    /// `[[a, b], ...]` (or quads) from a command span.
    fn groups(&mut self, flat: &[f32], width: usize) {
        self.0.push(b'[');
        for (i, g) in flat.chunks_exact(width).enumerate() {
            if i > 0 {
                self.0.push(b',');
            }
            self.floats(g);
        }
        self.0.push(b']');
    }
    fn hash(&mut self, h: &Option<Hash>) {
        match h {
            Some(h) => {
                self.0.push(b'"');
                self.raw(&h.to_hex());
                self.0.push(b'"');
            }
            None => self.raw("null"),
        }
    }
}

fn command(w: &mut W, c: &Command, cmds: &Commands) {
    w.raw("{\"op\":\"");
    w.raw(c.op());
    w.raw("\"");
    match c {
        Command::Rect { aa, rect, color } => {
            w.raw(",");
            w.key("aa");
            w.bool(*aa);
            w.raw(",");
            w.key("rect");
            w.floats(rect);
            w.raw(",");
            w.key("color");
            w.floats(color);
        }
        Command::TextureRect {
            tex,
            tile,
            transpose,
            rect,
            modulate,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("tile");
            w.bool(*tile);
            w.raw(",");
            w.key("transpose");
            w.bool(*transpose);
            w.raw(",");
            w.key("rect");
            w.floats(rect);
            w.raw(",");
            w.key("modulate");
            w.floats(modulate);
        }
        Command::TextureRectRegion {
            tex,
            transpose,
            clip_uv,
            rect,
            src,
            modulate,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("transpose");
            w.bool(*transpose);
            w.raw(",");
            w.key("clip_uv");
            w.bool(*clip_uv);
            w.raw(",");
            w.key("rect");
            w.floats(rect);
            w.raw(",");
            w.key("src");
            w.floats(src);
            w.raw(",");
            w.key("modulate");
            w.floats(modulate);
        }
        Command::MsdfTextureRectRegion {
            tex,
            outline,
            rect,
            src,
            modulate,
            px_range,
            scale,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("outline");
            w.int(*outline);
            w.raw(",");
            w.key("rect");
            w.floats(rect);
            w.raw(",");
            w.key("src");
            w.floats(src);
            w.raw(",");
            w.key("modulate");
            w.floats(modulate);
            w.raw(",");
            w.key("px_range");
            w.f32(*px_range);
            w.raw(",");
            w.key("scale");
            w.f32(*scale);
        }
        Command::Line {
            aa,
            from,
            to,
            colour,
            width,
        } => {
            w.raw(",");
            w.key("aa");
            w.bool(*aa);
            w.raw(",");
            w.key("from");
            w.floats(from);
            w.raw(",");
            w.key("to");
            w.floats(to);
            w.raw(",");
            w.key("colour");
            w.floats(colour);
            w.raw(",");
            w.key("width");
            w.f32(*width);
        }
        Command::Polyline {
            aa,
            width,
            points,
            colors,
        }
        | Command::Multiline {
            aa,
            width,
            points,
            colors,
        } => {
            w.raw(",");
            w.key("aa");
            w.bool(*aa);
            w.raw(",");
            w.key("width");
            w.f32(*width);
            w.raw(",");
            w.key("points");
            w.groups(cmds.pairs(*points), 2);
            w.raw(",");
            w.key("colors");
            w.groups(cmds.quads(*colors), 4);
        }
        Command::Circle {
            aa,
            position,
            radius,
            colour,
        } => {
            w.raw(",");
            w.key("aa");
            w.bool(*aa);
            w.raw(",");
            w.key("position");
            w.floats(position);
            w.raw(",");
            w.key("radius");
            w.f32(*radius);
            w.raw(",");
            w.key("colour");
            w.floats(colour);
        }
        Command::Primitive {
            tex,
            points,
            colors,
            uvs,
        }
        | Command::Polygon {
            tex,
            points,
            colors,
            uvs,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("points");
            w.groups(cmds.pairs(*points), 2);
            w.raw(",");
            w.key("colors");
            w.groups(cmds.quads(*colors), 4);
            w.raw(",");
            w.key("uvs");
            w.groups(cmds.pairs(*uvs), 2);
        }
        Command::TriangleArray {
            tex,
            count,
            points,
            colors,
            uvs,
            indices,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("count");
            w.int(*count);
            w.raw(",");
            w.key("points");
            w.groups(cmds.pairs(*points), 2);
            w.raw(",");
            w.key("colors");
            w.groups(cmds.quads(*colors), 4);
            w.raw(",");
            w.key("uvs");
            w.groups(cmds.pairs(*uvs), 2);
            w.raw(",");
            w.key("indices");
            w.0.push(b'[');
            for (i, &x) in cmds.ints(*indices).iter().enumerate() {
                if i > 0 {
                    w.0.push(b',');
                }
                w.int(x as i64);
            }
            w.0.push(b']');
        }
        Command::NinePatch {
            tex,
            rect,
            source,
            margins,
            x_axis,
            y_axis,
            draw_center,
            modulate,
        } => {
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("rect");
            w.floats(rect);
            w.raw(",");
            w.key("source");
            w.floats(source);
            w.raw(",");
            w.key("margins");
            w.floats(margins);
            w.raw(",");
            w.key("x_axis");
            w.str(x_axis.as_str());
            w.raw(",");
            w.key("y_axis");
            w.str(y_axis.as_str());
            w.raw(",");
            w.key("draw_center");
            w.bool(*draw_center);
            w.raw(",");
            w.key("modulate");
            w.floats(modulate);
        }
        Command::Mesh {
            mesh,
            tex,
            transform,
            modulate,
        } => {
            w.raw(",");
            w.key("mesh");
            w.int(*mesh as i64);
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
            w.raw(",");
            w.key("transform");
            w.floats(transform);
            w.raw(",");
            w.key("modulate");
            w.floats(modulate);
        }
        Command::SetTransform { transform } => {
            w.raw(",");
            w.key("transform");
            w.floats(transform);
        }
        Command::ClipIgnore { ignore } => {
            w.raw(",");
            w.key("ignore");
            w.bool(*ignore);
        }
        Command::Multimesh { multimesh, tex } => {
            w.raw(",");
            w.key("multimesh");
            w.int(*multimesh as i64);
            w.raw(",");
            w.key("tex");
            w.opt_id(*tex);
        }
        Command::Unsupported { name, reason } => {
            w.raw(",");
            w.key("name");
            w.str(name);
            w.raw(",");
            w.key("reason");
            w.str(reason.as_str());
        }
    }
    w.raw("}");
}

fn params(w: &mut W, ps: &[Param]) {
    w.raw("[");
    for (i, p) in ps.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{");
        w.key("name");
        w.str(&p.name);
        w.raw(",");
        w.key("type");
        w.str(p.ty.as_str());
        w.raw(",");
        w.key("value");
        match &p.value {
            ParamValue::Nil => w.raw("null"),
            ParamValue::Tex(t) => {
                w.raw("{\"tex\":");
                w.int(*t as i64);
                w.raw("}");
            }
            ParamValue::Scalar(x) => w.f64(*x),
            ParamValue::Flat(v) => w.f64s(v),
            ParamValue::Nested { components, values } => {
                w.raw("[");
                for (k, g) in values
                    .chunks_exact((*components).max(1) as usize)
                    .enumerate()
                {
                    if k > 0 {
                        w.raw(",");
                    }
                    w.f64s(g);
                }
                w.raw("]");
            }
        }
        w.raw("}");
    }
    w.raw("]");
}

fn canvas(w: &mut W, c: &Canvas, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(c.id as i64);
    w.raw(",");
    w.key("origin");
    w.str(c.origin.as_str());
    w.raw(",");
    w.key("role");
    w.raw(if c.root { "\"root\"" } else { "null" });
    w.raw(",");
    w.key("attached");
    w.bool(c.attached);
    if v >= 6 {
        w.raw(",");
        w.key("layer");
        w.int(c.layer);
        w.raw(",");
        w.key("sublayer");
        w.int(c.sublayer);
    }
    w.raw(",");
    w.key("items");
    w.ids(&c.items);
    w.raw(",");
    w.key("xform");
    w.floats(&c.xform);
    if v >= 5 {
        w.raw(",");
        w.key("modulate");
        w.floats(&c.modulate);
    }
    w.raw("}");
}

fn item(w: &mut W, it: &Item, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(it.id as i64);
    w.raw(",");
    w.key("origin");
    w.str(it.origin.as_str());
    w.raw(",");
    w.key("parent");
    match &it.parent {
        Some(p) => {
            w.raw("{\"kind\":");
            w.str(p.kind.as_str());
            w.raw(",\"id\":");
            w.int(p.id as i64);
            w.raw("}");
        }
        None => w.raw("null"),
    }
    w.raw(",");
    w.key("children");
    w.ids(&it.children);
    w.raw(",");
    w.key("visible");
    w.bool(it.visible);
    w.raw(",");
    w.key("draw_index");
    w.int(it.draw_index);
    w.raw(",");
    w.key("z_index");
    w.int(it.z_index);
    w.raw(",");
    w.key("z_relative");
    w.bool(it.z_relative);
    w.raw(",");
    w.key("behind");
    w.bool(it.behind);
    w.raw(",");
    w.key("clip");
    w.bool(it.clip);
    w.raw(",");
    w.key("custom_rect");
    w.bool(it.custom_rect);
    w.raw(",");
    w.key("visibility_layer");
    w.int(it.visibility_layer as i64);
    w.raw(",");
    w.key("texture_filter");
    w.str(it.texture_filter.as_str());
    w.raw(",");
    w.key("texture_repeat");
    w.str(it.texture_repeat.as_str());
    if v >= 5 {
        w.raw(",");
        w.key("material");
        w.opt_id(it.material);
        w.raw(",");
        w.key("use_parent_material");
        w.bool(it.use_parent_material);
        w.raw(",");
        w.key("instance_params");
        params(w, &it.instance_params);
    }
    if v >= 10 {
        // render-stream-10.md "Decoded and resolved forms": the floats inline, no `f`.
        w.raw(",");
        w.key("canvas_group");
        match &it.canvas_group {
            None => w.raw("null"),
            Some(g) => {
                w.raw("{");
                w.key("mode");
                w.str(g.mode.as_str());
                w.raw(",");
                w.key("clear_margin");
                w.f32(g.clear_margin);
                w.raw(",");
                w.key("fit_empty");
                w.bool(g.fit_empty);
                w.raw(",");
                w.key("fit_margin");
                w.f32(g.fit_margin);
                w.raw(",");
                w.key("blur_mipmaps");
                w.bool(g.blur_mipmaps);
                w.raw("}");
            }
        }
        w.raw(",");
        w.key("copy_to_backbuffer");
        match &it.copy_to_backbuffer {
            None => w.raw("null"),
            Some(rect) => {
                w.raw("{");
                w.key("rect");
                w.floats(rect);
                w.raw("}");
            }
        }
    }
    w.raw(",");
    w.key("content_version");
    w.int(it.content_version);
    w.raw(",");
    w.key("xform");
    w.floats(&it.xform);
    w.raw(",");
    w.key("modulate");
    w.floats(&it.modulate);
    w.raw(",");
    w.key("self_modulate");
    w.floats(&it.self_modulate);
    w.raw(",");
    w.key("custom_rect_rect");
    w.floats(&it.custom_rect_rect);
    w.raw(",");
    w.key("commands");
    w.raw("[");
    for (i, c) in it.commands.list.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        command(w, c, &it.commands);
    }
    w.raw("]}");
}

/// The table entries' `origin` (and, at /8, `adopted_content`), right after `id`: "created" below
/// /8, the entry's own origin from /8 (render-stream-8.md "Resource tables").
fn table_origin(w: &mut W, origin: Origin, adopted: Option<Option<AdoptedContent>>, v: u8) {
    if v < 8 {
        w.raw(",\"origin\":\"created\",");
        return;
    }
    w.raw(",\"origin\":\"");
    w.raw(origin.as_str());
    w.raw("\",");
    if let Some(content) = adopted {
        w.key("adopted_content");
        w.opt_str(content.map(|c| c.as_str()));
        w.raw(",");
    }
}

fn texture(w: &mut W, t: &Texture, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(t.id as i64);
    table_origin(w, t.origin, Some(t.adopted_content), v);
    w.key("kind");
    w.str(t.kind.as_str());
    w.raw(",");
    w.key("status");
    w.str(t.status.as_str());
    w.raw(",");
    w.key("reason");
    w.opt_str(t.reason);
    w.raw(",");
    w.key("version");
    w.int(t.version);
    w.raw(",");
    w.key("hash");
    w.hash(&t.hash);
    w.raw(",");
    w.key("format");
    w.opt_str(t.format.as_deref());
    w.raw(",");
    if v >= 8 {
        w.key("source_format");
        w.opt_str(t.source_format.as_deref());
        w.raw(",");
    }
    w.key("width");
    w.int(t.width);
    w.raw(",");
    w.key("height");
    w.int(t.height);
    w.raw(",");
    w.key("mipmaps");
    w.bool(t.mipmaps);
    w.raw(",");
    w.key("payload_bytes");
    w.int(t.payload_bytes);
    w.raw(",");
    if v >= 9 {
        // render-stream-9.md "Texture entries": variants, right after payload_bytes.
        w.key("variants");
        w.raw("[");
        for (i, variant) in t.variants.iter().enumerate() {
            if i > 0 {
                w.raw(",");
            }
            w.raw("{");
            w.key("encoding");
            w.str(variant.encoding.as_str());
            w.raw(",");
            w.key("hash");
            w.hash(&Some(variant.hash));
            w.raw(",");
            w.key("payload_bytes");
            w.int(variant.payload_bytes);
            w.raw(",");
            w.key("format");
            w.opt_str(variant.format.as_deref());
            w.raw(",");
            w.key("params");
            w.opt_str(variant.params.as_deref());
            w.raw("}");
        }
        w.raw("],");
    }
    w.key("canvas");
    match &t.canvas {
        Some(c) => {
            w.raw("{");
            w.key("diffuse");
            w.opt_id(c.diffuse);
            w.raw(",");
            w.key("filter");
            w.str(c.filter.as_str());
            w.raw(",");
            w.key("repeat");
            w.str(c.repeat.as_str());
            w.raw("}");
        }
        None => w.raw("null"),
    }
    w.raw("}");
}

fn mesh(w: &mut W, m: &Mesh, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(m.id as i64);
    table_origin(w, m.origin, Some(m.adopted_content), v);
    w.key("status");
    w.str(m.status.as_str());
    w.raw(",");
    w.key("reason");
    w.opt_str(m.reason);
    w.raw(",");
    w.key("version");
    w.int(m.version);
    w.raw(",");
    w.key("custom_aabb");
    w.floats(&m.custom_aabb);
    w.raw(",");
    w.key("surfaces");
    w.raw("[");
    for (i, s) in m.surfaces.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{");
        w.key("hash");
        w.hash(&s.hash);
        w.raw(",");
        if v >= 11 {
            // render-stream-11.md "Resolution and resolved form": resolved-only, after `hash`.
            w.key("body_sha256");
            w.hash(&s.body_sha256);
            w.raw(",");
        }
        w.key("payload_bytes");
        w.int(s.payload_bytes);
        w.raw(",");
        w.key("primitive");
        w.str(s.primitive.as_str());
        w.raw(",");
        w.key("format");
        w.int(s.format);
        w.raw(",");
        w.key("vertex_count");
        w.int(s.vertex_count);
        w.raw(",");
        w.key("index_count");
        w.int(s.index_count);
        w.raw("}");
    }
    w.raw("]}");
}

/// render-stream-11.md "As built (PM1)" rule 10: `id, origin, status, reason, version, mesh,
/// format, colors, custom, instances, visible, custom_aabb, buffer_sha256`.
fn multimesh(w: &mut W, m: &Multimesh) {
    w.raw("{");
    w.key("id");
    w.int(m.id as i64);
    w.raw(",");
    w.key("origin");
    w.str(m.origin.as_str());
    w.raw(",");
    w.key("status");
    w.str(m.status.as_str());
    w.raw(",");
    w.key("reason");
    w.opt_str(m.reason);
    w.raw(",");
    w.key("version");
    w.int(m.version);
    w.raw(",");
    w.key("mesh");
    w.opt_id(m.mesh);
    w.raw(",");
    w.key("format");
    w.str(m.format.as_str());
    w.raw(",");
    w.key("colors");
    w.bool(m.colors);
    w.raw(",");
    w.key("custom");
    w.bool(m.custom);
    w.raw(",");
    w.key("instances");
    w.int(m.instances);
    w.raw(",");
    w.key("visible");
    w.int(m.visible);
    w.raw(",");
    w.key("custom_aabb");
    match &m.custom_aabb {
        Some(a) => w.floats(a),
        None => w.raw("null"),
    }
    w.raw(",");
    w.key("buffer_sha256");
    w.hash(&m.buffer_sha256);
    w.raw("}");
}

fn shader(w: &mut W, s: &Shader, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(s.id as i64);
    table_origin(w, s.origin, None, v);
    w.key("status");
    w.str(s.status.as_str());
    w.raw(",");
    w.key("reason");
    w.opt_str(s.reason);
    w.raw(",");
    w.key("version");
    w.int(s.version);
    w.raw(",");
    w.key("mode");
    w.opt_str(s.mode.map(|m| m.as_str()));
    w.raw(",");
    w.key("source");
    w.opt_str(s.source.map(|m| m.as_str()));
    w.raw(",");
    w.key("hash");
    w.hash(&s.hash);
    w.raw(",");
    w.key("payload_bytes");
    w.int(s.payload_bytes);
    w.raw(",");
    w.key("builtin");
    match &s.builtin {
        Some(b) => {
            w.raw("{\"kind\":\"canvas_item_material\",");
            w.key("blend_mode");
            w.str(b.blend_mode.as_str());
            w.raw(",");
            w.key("light_mode");
            w.str(b.light_mode.as_str());
            w.raw(",");
            w.key("particles_animation");
            w.bool(b.particles_animation);
            w.raw("}");
        }
        None => w.raw("null"),
    }
    w.raw(",");
    w.key("uses");
    w.raw("[");
    for (i, u) in s.uses.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.str(u.as_str());
    }
    w.raw("],");
    w.key("default_textures");
    w.raw("[");
    for (i, d) in s.default_textures.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{");
        w.key("name");
        w.str(&d.name);
        w.raw(",");
        w.key("index");
        w.int(d.index);
        w.raw(",");
        w.key("tex");
        w.int(d.tex as i64);
        w.raw("}");
    }
    w.raw("]}");
}

fn material(w: &mut W, m: &Material, v: u8) {
    w.raw("{");
    w.key("id");
    w.int(m.id as i64);
    table_origin(w, m.origin, None, v);
    w.key("status");
    w.str(m.status.as_str());
    w.raw(",");
    w.key("reason");
    w.opt_str(m.reason);
    w.raw(",");
    w.key("version");
    w.int(m.version);
    w.raw(",");
    w.key("shader");
    w.opt_id(m.shader);
    w.raw(",");
    w.key("params");
    params(w, &m.params);
    w.raw("}");
}

fn list<T>(w: &mut W, items: impl Iterator<Item = T>, mut f: impl FnMut(&mut W, T)) {
    w.raw("[");
    for (i, x) in items.enumerate() {
        if i > 0 {
            w.raw(",");
        }
        f(w, x);
    }
    w.raw("]");
}

/// The resolved `state` object of a transaction (`ResolvedTransaction.state`).
pub fn write_state(out: &mut Vec<u8>, st: &ResolvedState) {
    write_state_as(out, st, false)
}

/// The native receiver's state dump (`receiver.gd` `_state_json`, written with
/// `JSON.stringify(state, "", false, true)`): the same keys in the same order as
/// [`write_state`], without `unknown_items` (the dump never carries it), every float spelled as
/// Godot spells it ([`write_godot_float`]). Byte-identical to the native dump of the same state.
pub fn write_state_godot(out: &mut Vec<u8>, st: &ResolvedState) {
    write_state_as(out, st, true)
}

fn write_state_as(out: &mut Vec<u8>, st: &ResolvedState, godot: bool) {
    let v = st.version;
    let w = &mut W(out, godot);
    w.raw("{");
    w.key("status");
    w.str(st.status.as_str());
    w.raw(",");
    w.key("failures");
    list(w, st.failures.iter(), |w, f| {
        w.raw("{");
        w.key("reason");
        w.str(f.reason);
        w.raw(",");
        w.key("detail");
        w.str(&f.detail);
        w.raw("}");
    });
    w.raw(",");
    w.key("unsupported");
    list(w, st.unsupported.iter(), |w, u| {
        w.raw("{");
        w.key("op");
        w.str(&u.op);
        w.raw(",");
        w.key("item");
        w.opt_id(u.item);
        w.raw(",");
        w.key("reason");
        w.str(u.reason);
        w.raw("}");
    });
    if let Some(u) = st.unknown_items.as_ref().filter(|_| !godot) {
        w.raw(",");
        w.key("unknown_items");
        w.raw("{");
        w.key("unknown_rids");
        w.int(u.unknown_rids);
        w.raw(",");
        w.key("withheld_items");
        w.int(u.withheld_items);
        w.raw(",");
        w.key("withheld_commands");
        w.int(u.withheld_commands);
        w.raw(",");
        w.key("unknown_calls");
        w.int(u.unknown_calls);
        w.raw("}");
    }
    // P3-TM (render-stream-10.md "Shader time"): only in a transaction whose state reads TIME.
    if let Some(t) = st.shader_time.filter(|_| !godot) {
        w.raw(",");
        w.key("shader_time");
        w.f64(t);
    }
    w.raw(",");
    w.key("default_texture_filter");
    w.str(st.default_texture_filter.as_str());
    w.raw(",");
    w.key("default_texture_repeat");
    w.str(st.default_texture_repeat.as_str());
    w.raw(",");
    w.key("canvases");
    list(w, st.canvases.values(), |w, c| canvas(w, c, v));
    w.raw(",");
    w.key("items");
    list(w, st.items.values(), |w, i| item(w, i, v));
    w.raw(",");
    w.key("textures");
    list(w, st.textures.values(), |w, t| texture(w, t, v));
    if v >= 4 {
        w.raw(",");
        w.key("meshes");
        list(w, st.meshes.values(), |w, m| mesh(w, m, v));
    }
    if v >= 5 {
        w.raw(",");
        w.key("shaders");
        list(w, st.shaders.values(), |w, s| shader(w, s, v));
        w.raw(",");
        w.key("materials");
        list(w, st.materials.values(), |w, m| material(w, m, v));
    }
    // PM1 (render-stream-11.md "As built (PM1)" rule 10): only when the table is non-empty.
    if v >= 11 && !st.multimeshes.is_empty() {
        w.raw(",");
        w.key("multimeshes");
        list(w, st.multimeshes.values(), multimesh);
    }
    w.raw("}");
}

/// `JSON.stringify(t)` for the resolved transaction `t` the state holds.
pub fn write_transaction(out: &mut Vec<u8>, st: &ResolvedState) {
    out.extend_from_slice(b"{\"seq\":");
    write_int(out, st.seq);
    out.extend_from_slice(b",\"frame\":");
    write_int(out, st.frame);
    out.extend_from_slice(b",\"encoding\":\"");
    out.extend_from_slice(st.encoding.as_str().as_bytes());
    out.extend_from_slice(b"\",\"state\":");
    write_state(out, st);
    out.push(b'}');
}

pub fn transaction_json(st: &ResolvedState) -> String {
    let mut out = Vec::with_capacity(4096);
    write_transaction(&mut out, st);
    String::from_utf8(out).expect("canonical JSON is UTF-8")
}

// ------------------------------------------------------------------------------------- decoded form

/// One record in `decodeRecording()`'s form: `{offset, byte_length, sha256, meta, blocks}`.
pub fn decoded_record(
    record: &[u8],
    offset: usize,
    version: u8,
) -> Result<serde_json::Value, Error> {
    use serde_json::{json, Value as J};
    let mut bufs = DecodeBufs::default();
    let mut tx = TxMeta::default();
    meta::decode_record(record, offset, version, &mut bufs, &mut tx)?;
    let frame = wire::frame(record, offset)?;
    let meta: J =
        serde_json::from_slice(frame.meta).map_err(|e| Error::new("meta-json", e.to_string()))?;
    let mut blocks = Vec::new();
    for (d, b) in bufs.descs.iter().zip(&bufs.blocks) {
        let bytes = &record[b.start..b.start + b.len];
        let num = |x: f64| {
            serde_json::Number::from_f64(x)
                .map(J::Number)
                .unwrap_or(J::Null)
        };
        blocks.push(match d.ty {
            BlockType::F32 => J::Array(
                bytes
                    .chunks_exact(4)
                    .map(|c| num(f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64))
                    .collect(),
            ),
            BlockType::I32 => J::Array(
                bytes
                    .chunks_exact(4)
                    .map(|c| J::from(i32::from_le_bytes([c[0], c[1], c[2], c[3]])))
                    .collect(),
            ),
            BlockType::F64 => J::Array(
                bytes
                    .chunks_exact(8)
                    .map(|c| {
                        num(f64::from_le_bytes([
                            c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7],
                        ]))
                    })
                    .collect(),
            ),
            BlockType::U8 => json!({"u8_bytes": b.len, "sha256": wire::sha256(bytes).to_hex()}),
        });
    }
    Ok(json!({
        "offset": offset,
        "byte_length": record.len(),
        "sha256": wire::record_sha256(record).to_hex(),
        "meta": meta,
        "blocks": blocks,
    }))
}

/// `decodeRecording()`: the whole recording's decoded form.
pub fn decoded_recording(data: &[u8], version: u8) -> Result<serde_json::Value, Error> {
    let records = wire::split_records(data, version)?;
    let mut out = Vec::with_capacity(records.len());
    for r in &records {
        out.push(decoded_record(r.bytes(data), r.offset, version)?);
    }
    Ok(serde_json::json!({
        "schema": format!("render-stream-{version}-decoded/1"),
        "magic": wire::hex(&wire::magic(version)),
        "records": out,
    }))
}
