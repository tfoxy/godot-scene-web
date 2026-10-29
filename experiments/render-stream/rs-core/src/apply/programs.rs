//! G7s: custom `ShaderMaterial`s as item-space programs (gate7-design.md Q5 "Materials", G7s).
//!
//! The core never sees GLSL. Its adapter transpiles each shader's code once per GRP1 hash
//! (`@godot-scene-web/effects`' `transpileGodotItemShader`), registers the module with the executor,
//! and hands the applier a [`ProgramEntry`] for the hash: the program id and what the code
//! declares (render modes, uniforms, samplers), or a typed refusal. The applier then draws every
//! item whose effective material names that shader with a [`Binding`]: the program plus its
//! uniform values, converted from the wire's resolved parameters exactly as Godot's GLES3
//! material storage converts a `Variant` (drivers/gles3/storage/material_storage.cpp:49-349,
//! 717-794).

use crate::state::{BlendMode, LightMode, Param, ParamValue};
use gsw_canvas_draw_list::{
    ANISOTROPY_TEXTURE, BLACK_TEXTURE, NORMAL_TEXTURE, TRANSPARENT_TEXTURE, UniformValue,
    WHITE_TEXTURE,
};

/// How a uniform's GL values are stored.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UniformKind {
    /// `bool` (GL int 0/1).
    Bool,
    /// `int`, `ivecN`.
    Int,
    /// `float`, `vecN`.
    Float,
}

/// A non-sampler uniform as the code declares it.
#[derive(Clone, PartialEq, Debug)]
pub struct UniformDecl {
    pub name: Box<str>,
    pub kind: UniformKind,
    /// Components per element, 1 to 4.
    pub components: u32,
    /// `name[N]`'s N.
    pub array: Option<u32>,
    /// `instance uniform`: the item's value, not the material's.
    pub instance: bool,
    /// The value nothing set: the declared default, else Godot's unset value, flattened.
    pub unset: Vec<f64>,
}

impl UniformDecl {
    fn len(&self) -> usize {
        self.components as usize * self.array.unwrap_or(1).max(1) as usize
    }
}

/// A `sampler2D` uniform: its hints (`None` when absent: Godot 4.5's canvas defaults are linear
/// and repeat disabled, `filter_from_uniform_canvas` / `repeat_from_uniform_canvas`,
/// material_storage.cpp:691-715).
#[derive(Clone, PartialEq, Debug)]
pub struct SamplerDecl {
    pub name: Box<str>,
    pub linear: Option<bool>,
    pub repeat: Option<bool>,
    /// P3-TM: the draw-list default-texture id GLES3 binds when the material sets no texture
    /// (`default`: white, black, transparent, normal, anisotropy; material_storage.cpp:928-953).
    pub default: u32,
}

/// A transpiled shader: the executor program id and what its code declares.
#[derive(Clone, PartialEq, Debug)]
pub struct ProgramInfo {
    pub program: u32,
    pub blend: BlendMode,
    pub light: LightMode,
    pub uniforms: Vec<UniformDecl>,
    pub samplers: Vec<SamplerDecl>,
    /// P3-ST: the code samples the screen (`hint_screen_texture`): `Some(mipmaps)`, `mipmaps`
    /// being GLES3's `uses_screen_texture_mipmaps` (a read screen sampler with a mipmap filter).
    /// The applier binds the back-buffer copy to `SCREEN_TEXTURE` and marks the draws where
    /// GLES3 takes the copy (rasterizer_canvas_gles3.cpp:426-533).
    pub screen: Option<bool>,
    /// P3-VX: the program has its own vertex stage (`vertexStage`: a `vertex()`, or
    /// `skip_vertex_transform`), which reads its canvas's transform and inverse from the binding
    /// (`gsw_canvas_matrix` / `gsw_canvas_inverse`).
    pub vertex: bool,
    /// P3-TM: the code reads `TIME`, which the executor sets from the list's shader time.
    pub time: bool,
}

impl ProgramInfo {
    pub fn has_instance_uniforms(&self) -> bool {
        self.uniforms.iter().any(|u| u.instance)
    }

    /// `program` described by a transpiled item shader's metadata: `transpileGodotItemShader`'s
    /// result without its `glsl`, as JSON (`{blend, lightMode, uniforms: [{name, type,
    /// arrayLength?, instance, components, integer, unset}], samplers: [{name, filter,
    /// repeat}]}`).
    pub fn from_meta_json(program: u32, meta: &str) -> Result<ProgramInfo, String> {
        use crate::json::Doc;
        let doc =
            Doc::parse(meta.as_bytes()).map_err(|e| format!("program meta: {}", e.message))?;
        let root = doc.root();
        let str_of = |v, key: &str| -> Result<String, String> {
            doc.get(v, key)
                .and_then(|x| doc.as_str(x))
                .map(str::to_string)
                .ok_or_else(|| format!("program meta: {key} is not a string"))
        };
        let blend = match str_of(root, "blend")?.as_str() {
            "mix" => BlendMode::Mix,
            "add" => BlendMode::Add,
            "sub" => BlendMode::Sub,
            "mul" => BlendMode::Mul,
            "premul_alpha" => BlendMode::PremulAlpha,
            "disabled" => BlendMode::Disabled,
            other => return Err(format!("program meta: blend {other:?}")),
        };
        let light = match str_of(root, "lightMode")?.as_str() {
            "normal" => LightMode::Normal,
            "unshaded" => LightMode::Unshaded,
            "light_only" => LightMode::LightOnly,
            other => return Err(format!("program meta: lightMode {other:?}")),
        };
        let list = |key: &str| -> Result<Vec<crate::json::Value>, String> {
            doc.get(root, key)
                .and_then(|v| doc.arr(v))
                .map(|a| a.to_vec())
                .ok_or_else(|| format!("program meta: {key} is not an array"))
        };
        let mut uniforms = Vec::new();
        for u in list("uniforms")? {
            let ty = str_of(u, "type")?;
            let kind = match ty.as_str() {
                "bool" => UniformKind::Bool,
                "int" | "ivec2" | "ivec3" | "ivec4" => UniformKind::Int,
                "float" | "vec2" | "vec3" | "vec4" => UniformKind::Float,
                other => return Err(format!("program meta: uniform type {other:?}")),
            };
            let components = doc
                .get(u, "components")
                .and_then(|v| doc.as_num(v))
                .filter(|n| (1.0..=4.0).contains(n))
                .ok_or("program meta: components")? as u32;
            let array = doc
                .get(u, "arrayLength")
                .and_then(|v| doc.as_num(v))
                .map(|n| n as u32);
            let unset = doc
                .get(u, "unset")
                .and_then(|v| doc.arr(v))
                .ok_or("program meta: unset")?
                .iter()
                .map(|x| doc.as_num(*x).ok_or("program meta: unset value"))
                .collect::<Result<Vec<f64>, _>>()?;
            uniforms.push(UniformDecl {
                name: str_of(u, "name")?.into(),
                kind,
                components,
                array,
                instance: doc
                    .get(u, "instance")
                    .and_then(|v| doc.as_bool(v))
                    .unwrap_or(false),
                unset,
            });
        }
        let mut samplers = Vec::new();
        for s in list("samplers")? {
            let filter = doc.get(s, "filter").and_then(|v| doc.as_str(v));
            // P3-TM: `default`; an older transpiler omits it (and admitted white only).
            let default = match doc.get(s, "default").and_then(|v| doc.as_str(v)) {
                None | Some("white") => WHITE_TEXTURE,
                Some("black") => BLACK_TEXTURE,
                Some("transparent") => TRANSPARENT_TEXTURE,
                Some("normal") => NORMAL_TEXTURE,
                Some("anisotropy") => ANISOTROPY_TEXTURE,
                Some(other) => return Err(format!("program meta: sampler default {other:?}")),
            };
            samplers.push(SamplerDecl {
                name: str_of(s, "name")?.into(),
                linear: filter.map(|f| f == "linear"),
                repeat: doc.get(s, "repeat").and_then(|v| doc.as_bool(v)),
                default,
            });
        }
        // P3-ST: `screenTexture` is null or {names, mipmaps}; an older transpiler omits it.
        let screen = match doc.get(root, "screenTexture") {
            None => None,
            Some(v) if doc.is_null(v) => None,
            Some(v) => Some(
                doc.get(v, "mipmaps")
                    .and_then(|m| doc.as_bool(m))
                    .ok_or("program meta: screenTexture.mipmaps")?,
            ),
        };
        // P3-VX: `vertexStage`; an older transpiler omits it (and refused every vertex()).
        let vertex = doc
            .get(root, "vertexStage")
            .and_then(|v| doc.as_bool(v))
            .unwrap_or(false);
        // P3-TM: `time`; an older transpiler omits it (and refused TIME).
        let time = doc
            .get(root, "time")
            .and_then(|v| doc.as_bool(v))
            .unwrap_or(false);
        Ok(ProgramInfo {
            program,
            blend,
            light,
            uniforms,
            samplers,
            screen,
            vertex,
            time,
        })
    }
}

/// What the adapter registered for one GRP1 hash.
#[derive(Clone, PartialEq, Debug)]
pub enum ProgramEntry {
    Ready(ProgramInfo),
    /// Not drawn with its code: the item draws without its material, as the native receiver
    /// draws a shaderless one. `reason` is `gsw-shader-transpile` (the transpiler or the GL
    /// compile refused it; `detail` says why) or `shader-withheld` (a `withheld` shader whose code
    /// no library supplied).
    Refused {
        reason: &'static str,
        detail: Box<str>,
    },
}

/// The receiver sabotage `vertex-flat-varyings` (P3-VX): `code` with every `varying` declared
/// `flat` (a `smooth` one turned `flat`, an unqualified one given `flat`), so a vertex stage's
/// outputs reach `fragment()` as the provoking vertex's value instead of interpolated. Both the
/// native receiver (before `shader_set_code`) and GSW (before its transpiler) apply it to the code
/// they are about to compile; a shader without varyings is returned unchanged.
pub fn flat_varyings(code: &str) -> String {
    let bytes = code.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = String::with_capacity(code.len() + 16);
    let mut last = 0;
    let mut i = 0;
    while let Some(at) = code[i..].find("varying") {
        let start = i + at;
        let end = start + "varying".len();
        i = end;
        if (start > 0 && word(bytes[start - 1]))
            || bytes.get(end).is_none_or(|c| !c.is_ascii_whitespace())
        {
            continue;
        }
        let mut next = end;
        while bytes.get(next).is_some_and(|c| c.is_ascii_whitespace()) {
            next += 1;
        }
        let mut token_end = next;
        while bytes.get(token_end).copied().is_some_and(word) {
            token_end += 1;
        }
        match &code[next..token_end] {
            "flat" => {}
            "smooth" => {
                out.push_str(&code[last..next]);
                out.push_str("flat");
                last = token_end;
            }
            _ => {
                out.push_str(&code[last..next]);
                out.push_str("flat ");
                last = next;
            }
        }
    }
    out.push_str(&code[last..]);
    out
}

/// P3-TM: the material parameter a native receiver's rewritten code reads in place of `TIME`
/// ([`host_time`]).
pub const HOST_TIME_PARAM: &str = "rs_host_time";

/// P3-TM: `code` with every `TIME` (an identifier outside comments, not after `.`, the capture's
/// own D11 scan) read from the uniform [`HOST_TIME_PARAM`] instead, declared right after the
/// `shader_type` statement. A native receiver compiles this so its draws follow the host's shader
/// time (which it sets as that material parameter per transaction) rather than its own
/// rasterizer's clock. Code without `TIME` is returned unchanged.
pub fn host_time(code: &str) -> String {
    let bytes = code.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = String::with_capacity(code.len() + 64);
    let mut last = 0;
    let mut i = 0;
    let mut declare_at: Option<usize> = None;
    let mut in_shader_type = false;
    let mut replaced = false;
    let mut prev_sig: u8 = 0; // the last non-space byte outside comments
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if word(c) && (i == 0 || !word(bytes[i - 1])) {
            let mut end = i;
            while end < bytes.len() && word(bytes[end]) {
                end += 1;
            }
            let ident = &code[i..end];
            if ident == "shader_type" && declare_at.is_none() {
                in_shader_type = true;
            } else if ident == "TIME" && prev_sig != b'.' {
                out.push_str(&code[last..i]);
                out.push_str(HOST_TIME_PARAM);
                last = end;
                replaced = true;
            }
            prev_sig = bytes[end - 1];
            i = end;
            continue;
        }
        if c == b';' && in_shader_type {
            in_shader_type = false;
            declare_at = Some(i + 1);
        }
        if !c.is_ascii_whitespace() {
            prev_sig = c;
        }
        i += 1;
    }
    out.push_str(&code[last..]);
    if !replaced {
        return code.to_string();
    }
    // `declare_at` indexes `code`; map it into `out` (no replacement precedes `shader_type`'s `;`
    // in valid code, so the offsets agree up to there).
    let decl = format!("\nuniform float {HOST_TIME_PARAM};\n");
    match declare_at {
        Some(at) if at <= out.len() && code[..at] == out[..at] => {
            out.insert_str(at, &decl);
            out
        }
        _ => format!("{decl}{out}"),
    }
}

/// PSE: the function a gl_compatibility receiver's rewritten particles code calls in place of
/// `emit_subparticle` ([`without_subparticles`]).
pub const NO_SUBPARTICLE_FN: &str = "rs_emit_subparticle_off";

/// PSE (render-stream-12.md "As built (PSE)"): `code` (a `particles` shader) with every
/// `emit_subparticle` call (an identifier outside comments, not after `.`) calling
/// [`NO_SUBPARTICLE_FN`] instead, a top-level function with `emit_subparticle`'s signature that
/// emits nothing and returns `false`, declared before the first top-level definition (the first
/// `{` at depth 0 begins one: a function or a struct). GLES3 declares no `emit_subparticle`
/// (its particles template has no sub-emitter buffer; `ParticleProcessMaterial` writes no
/// sub-emitter code there, particle_process_material.cpp `is_low_end`), so code written for a
/// RendererRD host (Forward+, Mobile) fails to compile on a gl_compatibility receiver and its
/// emitters draw nothing. It is the only RendererRD-only particles builtin in 4.5.1
/// (`shader_types.cpp` declares it for every backend; RD's particles.glsl defines it, GLES3's
/// does not; every other particles built-in is renamed by both).
/// GLES3 ignores sub-emitters anyway (PM6a rule 10), so the stub changes no pixel such a
/// receiver could draw. `None` when the code calls no `emit_subparticle`.
pub fn without_subparticles(code: &str) -> Option<String> {
    let bytes = code.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut out = String::with_capacity(code.len() + 128);
    let mut last = 0;
    let mut i = 0;
    let mut depth: i32 = 0;
    let mut stmt_start: usize = 0; // where the current top-level statement began, in `code`
    let mut define_at: Option<usize> = None;
    let mut replaced = false;
    let mut prev_sig: u8 = 0;
    let mut line_start = true;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if c == b'#' && line_start {
            // A preprocessor line: skipped whole, and a top-level statement starts after it.
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            if depth == 0 {
                stmt_start = i;
            }
            continue;
        }
        if c == b'\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if !c.is_ascii_whitespace() {
            line_start = false;
        }
        if word(c) && (i == 0 || !word(bytes[i - 1])) {
            let mut end = i;
            while end < bytes.len() && word(bytes[end]) {
                end += 1;
            }
            if &code[i..end] == "emit_subparticle" && prev_sig != b'.' {
                out.push_str(&code[last..i]);
                out.push_str(NO_SUBPARTICLE_FN);
                last = end;
                replaced = true;
            }
            prev_sig = bytes[end - 1];
            i = end;
            continue;
        }
        match c {
            b'{' => {
                if depth == 0 && define_at.is_none() {
                    define_at = Some(stmt_start);
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    stmt_start = i + 1;
                }
            }
            b';' if depth == 0 => stmt_start = i + 1,
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            prev_sig = c;
        }
        i += 1;
    }
    if !replaced {
        return None;
    }
    out.push_str(&code[last..]);
    let def = format!(
        "\nbool {NO_SUBPARTICLE_FN}(mat4 xform, vec3 velocity, vec4 color, vec4 custom, uint flags) {{\n\treturn false;\n}}\n"
    );
    // `define_at` indexes `code`; no replacement precedes the first top-level definition (a call
    // sits inside one), so the offsets agree up to there.
    match define_at {
        Some(at) if at <= out.len() && code[..at] == out[..at] => {
            out.insert_str(at, &def);
            Some(out)
        }
        _ => None,
    }
}

/// A wire parameter's numbers, flattened (a packed array's elements in order).
fn numbers(value: &ParamValue) -> Option<&[f64]> {
    match value {
        ParamValue::Nil | ParamValue::Tex(_) => None,
        ParamValue::Scalar(v) => Some(std::slice::from_ref(v)),
        ParamValue::Flat(v) => Some(v),
        ParamValue::Nested { values, .. } => Some(values),
    }
}

/// The GL value of `decl` for the wire parameter `param` (absent or `nil`: not set), as
/// `_fill_std140_variant_ubo_value` writes it: the parameter's components in order, an element
/// whose source is short zero-filled (`write_array_std140`), floats rounded to f32, ints truncated
/// toward zero (Variant's float to int), bools any non-zero. Unset: [`UniformDecl::unset`].
pub fn uniform_value(decl: &UniformDecl, param: Option<&Param>) -> UniformValue {
    let len = decl.len();
    let source: Vec<f64> = match param.and_then(|p| numbers(&p.value)) {
        Some(v) => {
            let n = decl.components as usize;
            let mut out = vec![0.0; len];
            if decl.array.is_some() {
                // Whole elements only; the rest stay zero.
                let whole = v.len() / n * n;
                let k = whole.min(len);
                out[..k].copy_from_slice(&v[..k]);
            } else {
                // A scalar or vector: its first components (convert_to_vector pads with zeros).
                let k = v.len().min(len);
                out[..k].copy_from_slice(&v[..k]);
            }
            out
        }
        None => {
            let mut out = decl.unset.clone();
            out.resize(len, 0.0);
            out
        }
    };
    match decl.kind {
        UniformKind::Float => UniformValue::Float(source.iter().map(|x| *x as f32).collect()),
        UniformKind::Int => UniformValue::Int(source.iter().map(|x| x.trunc() as i32).collect()),
        UniformKind::Bool => {
            UniformValue::Int(source.iter().map(|x| i32::from(*x != 0.0)).collect())
        }
    }
}

/// The parameter named `name` of `params`, if set and not `nil`.
pub fn param<'p>(params: &'p [Param], name: &str) -> Option<&'p Param> {
    params
        .iter()
        .find(|p| &*p.name == name && p.value != ParamValue::Nil)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::VariantType;

    #[test]
    fn without_subparticles_stubs_every_call() {
        let code = "shader_type particles;\n#define N 2\nuniform vec4 c = vec4(1.0);\n// emit_subparticle( in a comment\nfloat f(float x) { return x; }\nvoid process() {\n\tif (true) {\n\t\temit_subparticle(TRANSFORM, VELOCITY, vec4(0.0), vec4(0.0), 1u);\n\t}\n}\n";
        let out = super::without_subparticles(code).expect("a call is rewritten");
        let def = out.find("bool rs_emit_subparticle_off(").expect("the stub is defined");
        assert!(def < out.find("float f(").unwrap(), "before the first definition: {out}");
        assert!(def > out.find("uniform vec4 c").unwrap(), "after the uniforms: {out}");
        assert!(out.contains("\t\trs_emit_subparticle_off(TRANSFORM"), "the call: {out}");
        assert!(out.contains("// emit_subparticle( in a comment"), "comments untouched: {out}");
        assert_eq!(out.matches("emit_subparticle(").count(), 1, "only the comment keeps the name");
        assert!(super::without_subparticles("shader_type particles;\nvoid process() {}\n").is_none());
    }

    /// PSE: a struct first (the stub goes before it), a call in a helper, `.emit_subparticle`
    /// (a member) and an identifier that merely contains the name stay.
    #[test]
    fn without_subparticles_struct_first_and_lookalikes() {
        let code = "shader_type particles;\nuniform int m;\nstruct P {\n\tfloat a;\n};\nvoid start() {\n\tfloat my_emit_subparticle = 1.0;\n\tbool ok = emit_subparticle(TRANSFORM, VELOCITY, vec4(0.0), vec4(0.0), FLAG_EMIT_POSITION);\n}\n";
        let out = without_subparticles(code).expect("a call is rewritten");
        let def = out.find("bool rs_emit_subparticle_off(").unwrap();
        assert!(def < out.find("struct P").unwrap(), "before the struct: {out}");
        assert!(def > out.find("uniform int m;").unwrap(), "after the uniform: {out}");
        assert!(out.contains("my_emit_subparticle = 1.0"), "a longer identifier stays: {out}");
        assert!(out.contains("bool ok = rs_emit_subparticle_off(TRANSFORM"), "{out}");
    }

    fn decl(kind: UniformKind, components: u32, array: Option<u32>, unset: &[f64]) -> UniformDecl {
        UniformDecl {
            name: "u".into(),
            kind,
            components,
            array,
            instance: false,
            unset: unset.to_vec(),
        }
    }

    fn p(ty: VariantType, value: ParamValue) -> Param {
        Param {
            name: "u".into(),
            ty,
            value,
        }
    }

    #[test]
    fn host_time_reads_the_parameter_for_every_time_token() {
        let code = "shader_type canvas_item; render_mode unshaded;\n// TIME in a comment\nvoid fragment() { COLOR.r = sin(TIME * 2.0) + s.TIME; /* TIME */ float TIMES = TIME; }";
        assert_eq!(
            host_time(code),
            "shader_type canvas_item;\nuniform float rs_host_time;\n render_mode unshaded;\n// TIME in a comment\nvoid fragment() { COLOR.r = sin(rs_host_time * 2.0) + s.TIME; /* TIME */ float TIMES = rs_host_time; }"
        );
        let plain = "shader_type canvas_item; void fragment() { COLOR.a = 1.0; }";
        assert_eq!(host_time(plain), plain);
    }

    #[test]
    fn flat_varyings_sabotage_rewrites_only_varying_declarations() {
        let code = "shader_type canvas_item;\nvarying vec4 a;\nvarying smooth vec2 b;\nvarying flat int c;\nvarying\thighp float d;\nfloat varying_x;\nvoid fragment() { COLOR = a; }";
        assert_eq!(
            flat_varyings(code),
            "shader_type canvas_item;\nvarying flat vec4 a;\nvarying flat vec2 b;\nvarying flat int c;\nvarying\tflat highp float d;\nfloat varying_x;\nvoid fragment() { COLOR = a; }"
        );
        let plain = "shader_type canvas_item;\nvoid fragment() {}";
        assert_eq!(flat_varyings(plain), plain);
    }

    #[test]
    fn godot_variant_conversions() {
        // vec4 from a Color.
        let v = uniform_value(
            &decl(UniformKind::Float, 4, None, &[1.0; 4]),
            Some(&p(
                VariantType::Color,
                ParamValue::Flat(vec![0.2, 0.4, 0.2, 1.0]),
            )),
        );
        assert_eq!(v, UniformValue::Float(vec![0.2, 0.4, 0.2, 1.0]));
        // int from an int; truncation from a float.
        let d = decl(UniformKind::Int, 1, None, &[0.0]);
        assert_eq!(
            uniform_value(&d, Some(&p(VariantType::Int, ParamValue::Scalar(7.0)))),
            UniformValue::Int(vec![7])
        );
        assert_eq!(
            uniform_value(&d, Some(&p(VariantType::Float, ParamValue::Scalar(-2.7)))),
            UniformValue::Int(vec![-2])
        );
        // bool.
        assert_eq!(
            uniform_value(
                &decl(UniformKind::Bool, 1, None, &[0.0]),
                Some(&p(VariantType::Bool, ParamValue::Scalar(1.0)))
            ),
            UniformValue::Int(vec![1])
        );
        // float[4] from a short packed array: whole elements, zero-filled.
        assert_eq!(
            uniform_value(
                &decl(UniformKind::Float, 1, Some(4), &[0.0; 4]),
                Some(&p(
                    VariantType::PackedFloat32Array,
                    ParamValue::Flat(vec![0.5, 0.25, 0.75])
                ))
            ),
            UniformValue::Float(vec![0.5, 0.25, 0.75, 0.0])
        );
        // Unset and nil take the declared default.
        let d = decl(UniformKind::Float, 1, None, &[1.0]);
        assert_eq!(uniform_value(&d, None), UniformValue::Float(vec![1.0]));
        assert_eq!(
            param(&[p(VariantType::Nil, ParamValue::Nil)], "u").map(|_| ()),
            None
        );
    }
}
