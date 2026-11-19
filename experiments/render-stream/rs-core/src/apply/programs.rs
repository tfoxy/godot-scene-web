//! custom `ShaderMaterial`s as item-space programs.
//!
//! The core never sees GLSL. Its adapter transpiles each shader's code once per GRP1 hash
//! (`@godot-scene-web/effects`' `transpileGodotItemShader`), registers the module with the executor,
//! and hands the applier a [`ProgramEntry`] for the hash: the program id and what the code
//! declares (render modes, uniforms, samplers), or a typed refusal. The applier then draws every
//! item whose effective material names that shader with a [`Binding`]: the program plus its
//! uniform values, converted from the wire's resolved parameters exactly as Godot's GLES3
//! material storage converts a `Variant` (drivers/gles3/storage/material_storage.cpp:49-349,
//! 717-794).

#[path = "alpha_range.rs"]
pub(super) mod alpha_range;

use crate::state::{BlendMode, LightMode, Param, ParamValue};
use gsw_canvas_draw_list::cover::AlphaUniform;
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
    /// The uniform the program's final alpha is a multiple of ([`alpha_uniform`], resolved
    /// against `uniforms` by [`ProgramInfo::with_code`]): a draw with it is a no-op where its
    /// binding holds 0 there (`gsw_canvas_draw_list::cover::noop`). None: not provable, or not
    /// derived (the transpiler's metadata does not carry it).
    pub alpha: Option<AlphaUniform>,
}

impl ProgramInfo {
    /// This program with the facts its Godot `code` proves (the code the adapter transpiled):
    /// [`ProgramInfo::alpha`], when [`alpha_uniform`] names a float uniform this program declares
    /// (not an array) with the component it reads.
    pub fn with_code(mut self, code: &str) -> ProgramInfo {
        self.alpha = alpha_uniform(code).and_then(|a| {
            let (k, u) = self
                .uniforms
                .iter()
                .enumerate()
                .find(|(_, u)| *u.name == *a.name)?;
            (u.kind == UniformKind::Float
                && u.array.is_none()
                && u32::from(a.component) < u.components)
                .then_some(AlphaUniform {
                    uniform: u16::try_from(k).ok()?,
                    component: a.component,
                })
        });
        self
    }

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
            alpha: None,
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

/// The uniform a `canvas_item` shader's final alpha provably is a multiple of: [`alpha_uniform`].
#[derive(Clone, Debug, PartialEq)]
pub struct AlphaRef {
    /// The uniform's name, as declared.
    pub name: Box<str>,
    /// The component read: 0 for a `float`, the swizzle's for one component of a `vecN`, 3 for
    /// a whole `vec4` assigned to `COLOR`.
    pub component: u8,
    /// Its type's components (1 for `float`).
    pub components: u8,
    /// Its declared default when that is a plain number (for a stand-in program's metadata).
    pub default: Option<f64>,
    /// `instance uniform`.
    pub instance: bool,
}

/// Numeric declarations for offline synthetic programs, independent of current material values.
/// This accepts the transpiler's literal defaults and Godot's unset source-colour alpha. A
/// declaration whose type/default cannot be represented is omitted; range proofs require every
/// numeric declaration to have a binding, so such an omission cannot prove a no-op.
pub fn synthetic_uniforms(code: &str) -> Vec<UniformDecl> {
    let Some(t) = tokens(code) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut depth = 0i32;
    for (i, token) in t.iter().enumerate() {
        match token {
            Tok::Punct("{") => depth += 1,
            Tok::Punct("}") => depth -= 1,
            Tok::Word("uniform") if depth == 0 => {
                let end = t[i + 1..].iter().position(|x| *x == Tok::Punct(";"));
                let Some(end) = end else { continue };
                let mut decl = &t[i + 1..i + 1 + end];
                if matches!(decl.first(), Some(Tok::Word("lowp" | "mediump" | "highp"))) {
                    decl = &decl[1..];
                }
                let [Tok::Word(ty), Tok::Word(name), rest @ ..] = decl else {
                    continue;
                };
                let (kind, n) = match *ty {
                    "bool" => (UniformKind::Bool, 1),
                    "int" => (UniformKind::Int, 1),
                    "ivec2" => (UniformKind::Int, 2),
                    "ivec3" => (UniformKind::Int, 3),
                    "ivec4" => (UniformKind::Int, 4),
                    _ => match float_components(ty) {
                        Some(n) => (UniformKind::Float, usize::from(n)),
                        None => continue,
                    },
                };
                if rest.first() == Some(&Tok::Punct("[")) {
                    continue;
                }
                if i > 0 && t[i - 1] == Tok::Word("global") {
                    continue;
                }
                let instance = i > 0 && t[i - 1] == Tok::Word("instance");
                let source_color = rest.contains(&Tok::Word("source_color"));
                let unset = if let Some(eq) = rest.iter().position(|x| *x == Tok::Punct("=")) {
                    let mut value = &rest[eq + 1..];
                    let constructor =
                        matches!(value, [Tok::Word(c), Tok::Punct("("), ..] if c == ty);
                    if constructor {
                        if value.last() != Some(&Tok::Punct(")")) {
                            continue;
                        }
                        value = &value[2..value.len() - 1];
                    } else if n != 1 {
                        continue;
                    }
                    let mut values = Vec::new();
                    for arg in value.split(|x| *x == Tok::Punct(",")) {
                        let number = match arg {
                            [Tok::Word("true")] => Some(1.0),
                            [Tok::Word("false")] => Some(0.0),
                            [Tok::Num(x)] | [Tok::Punct("+"), Tok::Num(x)] => x.parse::<f64>().ok(),
                            [Tok::Punct("-"), Tok::Num(x)] => x.parse::<f64>().ok().map(|v| -v),
                            _ => None,
                        };
                        let Some(number) = number.filter(|v| v.is_finite()) else {
                            break;
                        };
                        values.push(number);
                    }
                    // Reject the whole default if any argument was unsupported.
                    let count = value.split(|x| *x == Tok::Punct(",")).count();
                    if values.len() != count {
                        continue;
                    }
                    if constructor && values.len() == 1 {
                        values.resize(n, values[0]);
                    }
                    if values.len() != n {
                        continue;
                    }
                    values
                } else {
                    let mut values = vec![0.0; n];
                    if *ty == "vec4" && source_color {
                        values[3] = 1.0;
                    }
                    values
                };
                out.push(UniformDecl {
                    name: (*name).into(),
                    kind,
                    components: n as u32,
                    array: None,
                    instance,
                    unset,
                });
            }
            _ => {}
        }
    }
    out
}

/// One token of shader code: an identifier or keyword, a number, or one punctuator (`*=`, `==`
/// and the other two-character operators kept whole).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Tok<'a> {
    Word(&'a str),
    Num(&'a str),
    Punct(&'a str),
}

/// `code` without comments, as tokens; None when it holds anything a token-level reading cannot
/// vouch for (a preprocessor line, a string, a stray character).
fn tokens(code: &str) -> Option<Vec<Tok<'_>>> {
    let b = code.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut line_start = true;
    while i < b.len() {
        let c = b[i];
        if c == b'\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            let end = code[i + 2..].find("*/")?;
            i += 2 + end + 2;
            continue;
        }
        // The scene layer's include markers (`@@>path`, `@@<path`) stand on their own lines.
        if line_start && b[i..].starts_with(b"@@") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        line_start = false;
        if c == b'#' || c == b'"' {
            return None;
        }
        let start = i;
        if c.is_ascii_alphabetic() || c == b'_' {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            out.push(Tok::Word(&code[start..i]));
        } else if c.is_ascii_digit() || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit))
        {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                // An exponent's sign belongs to the number.
                if (b[i] == b'e' || b[i] == b'E')
                    && matches!(b.get(i + 1), Some(b'+' | b'-'))
                    && !code[start..i].starts_with("0x")
                {
                    i += 1;
                }
                i += 1;
            }
            out.push(Tok::Num(&code[start..i]));
        } else {
            const TWO: [&str; 18] = [
                "*=", "/=", "+=", "-=", "%=", "==", "!=", "<=", ">=", "&&", "||", "^^", "++", "--",
                "<<", ">>", "&=", "|=",
            ];
            let two = code.get(i..i + 2).filter(|t| TWO.contains(t));
            let len = two.map_or(1, str::len);
            if !c.is_ascii_punctuation() {
                return None;
            }
            out.push(Tok::Punct(&code[i..i + len]));
            i += len;
        }
    }
    Some(out)
}

/// The type names a uniform the fact can read may have, with their component counts.
fn float_components(ty: &str) -> Option<u8> {
    match ty {
        "float" => Some(1),
        "vec2" => Some(2),
        "vec3" => Some(3),
        "vec4" => Some(4),
        _ => None,
    }
}

/// The component index a one-letter swizzle names.
fn swizzle(s: &str) -> Option<u8> {
    match s {
        "x" | "r" | "s" => Some(0),
        "y" | "g" | "t" => Some(1),
        "z" | "b" | "p" => Some(2),
        "w" | "a" | "q" => Some(3),
        _ => None,
    }
}

/// The uniform a `canvas_item` shader's final `COLOR.a` provably is a multiple of, when the
/// code's shape proves it; None for every shape it does not recognise.
///
/// Recognised: `fragment()`'s last statement, at the top level of its body, is one of
/// - `COLOR.a = P;` or `COLOR.a *= P;` (`.w` alike), with `P` a product (`*` only) of factors
///   finite by construction (numeric literals, declared uniforms, `COLOR`, `texture()` and
///   `textureLod()` samples, each whole or swizzled; no local, other call, parenthesis or
///   division, since `0 * inf` is NaN), one of which is a scalar uniform reference `U`: a `float`
///   uniform's name, or one component of a `vecN` uniform (`tint.a`);
/// - `COLOR = P;` or `COLOR *= P;` with `P` such a product (every component is `U` times
///   something), or with `P` a whole `vec4` uniform, alone or times `COLOR` (its alpha is
///   `U.a` times that);
/// - `COLOR = vec4(..., P);`, its last argument such a product (the alpha it supplies) and
///   every other argument a product of such finite factors (the colour is premultiplied by it).
///
/// and the body holds no `return` (which could skip that statement), the code no preprocessor
/// line, the uniform is `uniform`/`instance uniform` (not `global`, not an array), and neither it
/// nor `COLOR` is declared anew in the body (every use outside the last statement follows an
/// operator or an opening parenthesis). A scalar factor of 0 makes the product 0 whatever its
/// other (finite) factors are, matrices included, and the store is the statement's last effect,
/// so the alpha the program leaves is 0 wherever `U` is: the executor then multiplies by the
/// post-modulate and premultiplies, which keeps it 0. `light()` never runs in an item-space
/// renderer, and `vertex()` writes no fragment alpha. What earlier statements leave in `COLOR`
/// (read by `COLOR.a *= U`, or premultiplied after `COLOR.a = U`) and the values materials give
/// uniforms are taken to be finite: GLSL ES 3.00 leaves arithmetic on an infinity or a NaN
/// undefined, in Godot's renderer as in the executor, so no defined pixel rests on one.
pub fn alpha_uniform(code: &str) -> Option<AlphaRef> {
    let t = tokens(code)?;
    // Top-level declarations and the fragment body.
    let mut uniforms: Vec<(Box<str>, u8, Option<f64>, bool)> = Vec::new();
    let mut body: Option<(usize, usize)> = None;
    let (mut i, mut depth) = (0usize, 0i32);
    while i < t.len() {
        match t[i] {
            Tok::Punct("{") => depth += 1,
            Tok::Punct("}") => depth -= 1,
            _ if depth != 0 => {}
            Tok::Word("uniform") => {
                let qualifier = i.checked_sub(1).map(|k| t[k]);
                let instance = qualifier == Some(Tok::Word("instance"));
                let global = qualifier == Some(Tok::Word("global"));
                let mut k = i + 1;
                while matches!(t.get(k), Some(Tok::Word("lowp" | "mediump" | "highp"))) {
                    k += 1;
                }
                if let (Some(Tok::Word(ty)), Some(Tok::Word(name))) = (t.get(k), t.get(k + 1)) {
                    let array = t.get(k + 2) == Some(&Tok::Punct("["));
                    if let (Some(n), false, false) = (float_components(ty), array, global) {
                        // A default: `= <number>;` at the end of the declaration.
                        let end = t[k..]
                            .iter()
                            .position(|x| *x == Tok::Punct(";"))
                            .map(|e| k + e);
                        let default = end.and_then(|e| match &t[k + 2..e] {
                            [.., Tok::Punct("="), Tok::Num(v)] => {
                                v.trim_end_matches('f').parse::<f64>().ok()
                            }
                            _ => None,
                        });
                        uniforms.push(((*name).into(), n, default, instance));
                    }
                }
            }
            Tok::Word("fragment")
                if t.get(i.wrapping_sub(1)) == Some(&Tok::Word("void"))
                    && t.get(i + 1) == Some(&Tok::Punct("("))
                    && t.get(i + 2) == Some(&Tok::Punct(")"))
                    && t.get(i + 3) == Some(&Tok::Punct("{")) =>
            {
                if body.is_some() {
                    return None;
                }
                let open = i + 3;
                let mut d = 0i32;
                let close = (open..t.len()).find(|&k| {
                    match t[k] {
                        Tok::Punct("{") => d += 1,
                        Tok::Punct("}") => d -= 1,
                        _ => {}
                    }
                    d == 0
                })?;
                body = Some((open + 1, close));
                i = close;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    let (b0, b1) = body?;
    let body = &t[b0..b1];
    if body.contains(&Tok::Word("return")) {
        return None;
    }
    // The last statement: from after the previous `;`, `{` or `}` at the body's top level.
    let (last, before) = {
        let [rest @ .., Tok::Punct(";")] = body else {
            return None;
        };
        let mut d = 0i32;
        let mut start = 0;
        for k in (0..rest.len()).rev() {
            match rest[k] {
                Tok::Punct(")" | "]") => d += 1,
                Tok::Punct("(" | "[") => d -= 1,
                Tok::Punct("}") if d == 0 => {
                    start = k + 1;
                    break;
                }
                Tok::Punct("}") => d += 1,
                Tok::Punct("{") if d == 0 => {
                    start = k + 1;
                    break;
                }
                Tok::Punct("{") => d -= 1,
                Tok::Punct(";") if d == 0 => {
                    start = k + 1;
                    break;
                }
                _ => {}
            }
        }
        (&rest[start..], &body[..start])
    };
    let uniform = |name: &str| uniforms.iter().find(|u| &*u.0 == name);
    // A scalar uniform reference: the factor's tokens, whole.
    let scalar = |f: &[Tok]| -> Option<(Box<str>, u8)> {
        match *f {
            [Tok::Word(n)] => uniform(n).filter(|u| u.1 == 1).map(|u| (u.0.clone(), 0)),
            [Tok::Word(n), Tok::Punct("."), Tok::Word(s)] => {
                let u = uniform(n).filter(|u| u.1 > 1)?;
                let c = swizzle(s).filter(|c| *c < u.1)?;
                Some((u.0.clone(), c))
            }
            _ => None,
        }
    };
    // `P`'s factors (split at top-level `*`), or None if anything but `*` joins them.
    let factors = |p: &'_ [Tok<'_>]| -> Option<Vec<std::ops::Range<usize>>> {
        if p.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        let (mut d, mut from) = (0i32, 0usize);
        for (k, x) in p.iter().enumerate() {
            match x {
                Tok::Punct("(" | "[") => d += 1,
                Tok::Punct(")" | "]") => d -= 1,
                Tok::Punct("*") if d == 0 => {
                    out.push(from..k);
                    from = k + 1;
                }
                Tok::Punct(".") => {}
                Tok::Punct(_) if d == 0 => return None,
                _ => {}
            }
        }
        out.push(from..p.len());
        out.iter().all(|r| !r.is_empty()).then_some(out)
    };
    // A factor that is finite by construction, so a zero beside it keeps the product 0 (`0 * inf`
    // is NaN): a numeric literal that fits a float, a declared uniform or COLOR (whole or
    // swizzled), or a `texture()` / `textureLod()` sample (whole or swizzled). Locals, calls of
    // anything else, parentheses and division are refused: none is bounded here.
    let swizzled = |rest: &[Tok]| match rest {
        [] => true,
        [Tok::Punct("."), Tok::Word(s)] => s.chars().all(|c| "xyzwrgbastpq".contains(c)),
        _ => false,
    };
    let finite = |f: &[Tok]| -> bool {
        match f {
            [Tok::Num(v)] => v
                .trim_end_matches(['f', 'F', 'u', 'U'])
                .parse::<f64>()
                .is_ok_and(|x| (x as f32).is_finite()),
            [Tok::Word(n), rest @ ..] if *n == "COLOR" || uniform(n).is_some() => swizzled(rest),
            [Tok::Word("texture" | "textureLod"), Tok::Punct("("), rest @ ..] => {
                // The call's own closing parenthesis, then at most a swizzle.
                let mut d = 1i32;
                let Some(close) = rest.iter().position(|x| {
                    match x {
                        Tok::Punct("(" | "[") => d += 1,
                        Tok::Punct(")" | "]") => d -= 1,
                        _ => {}
                    }
                    d == 0
                }) else {
                    return false;
                };
                swizzled(&rest[close + 1..])
            }
            _ => false,
        }
    };
    // A product of finite factors, one of them a scalar uniform reference.
    let scalar_factor = |p: &[Tok]| -> Option<(Box<str>, u8)> {
        let fs = factors(p)?;
        if !fs.iter().all(|r| finite(&p[r.clone()])) {
            return None;
        }
        fs.into_iter().find_map(|r| scalar(&p[r]))
    };
    let found = match last {
        [Tok::Word("COLOR"), Tok::Punct("."), Tok::Word(s), Tok::Punct("=" | "*="), p @ ..]
            if swizzle(s) == Some(3) =>
        {
            scalar_factor(p)
        }
        [Tok::Word("COLOR"), Tok::Punct("="), Tok::Word("vec4"), Tok::Punct("("), args @ .., Tok::Punct(")")] =>
        {
            // The parentheses must be the call's own: `vec4(a) * vec4(b)` is a product.
            let mut d = 0i32;
            for x in args {
                match x {
                    Tok::Punct("(" | "[") => d += 1,
                    Tok::Punct(")" | "]") => d -= 1,
                    _ => {}
                }
                if d < 0 {
                    return None;
                }
            }
            // The last top-level argument.
            let mut d = 0i32;
            let at = (0..args.len())
                .rev()
                .find(|&k| {
                    match args[k] {
                        Tok::Punct(")" | "]") => d += 1,
                        Tok::Punct("(" | "[") => d -= 1,
                        _ => {}
                    }
                    d == 0 && args[k] == Tok::Punct(",")
                })
                .map_or(0, |k| k + 1);
            if d != 0 {
                return None;
            }
            // The colour arguments are premultiplied by the alpha: finite products too.
            let mut from = 0;
            let mut d = 0i32;
            for (k, x) in args[..at].iter().enumerate() {
                match x {
                    Tok::Punct("(" | "[") => d += 1,
                    Tok::Punct(")" | "]") => d -= 1,
                    Tok::Punct(",") if d == 0 => {
                        let fs = factors(&args[from..k])?;
                        if !fs.iter().all(|r| finite(&args[from..k][r.clone()])) {
                            return None;
                        }
                        from = k + 1;
                    }
                    _ => {}
                }
            }
            scalar_factor(&args[at..])
        }
        [Tok::Word("COLOR"), Tok::Punct("=" | "*="), p @ ..] => scalar_factor(p).or_else(|| {
            // A whole vec4 uniform, alone or times COLOR.
            let fs = factors(p)?;
            let mut u = None;
            for r in fs {
                match p[r] {
                    [Tok::Word("COLOR")] => {}
                    [Tok::Word(n)] if u.is_none() => {
                        u = Some(uniform(n).filter(|x| x.1 == 4)?.0.clone());
                    }
                    _ => return None,
                }
            }
            u.map(|n| (n, 3))
        }),
        _ => None,
    };
    let (name, component) = found?;
    // Neither the uniform nor COLOR declared anew before the statement (a use after a type name
    // or a comma could be a declaration), and the statement itself starts at COLOR.
    let redeclared = |w: &str| {
        before.iter().enumerate().any(|(k, x)| {
            *x == Tok::Word(w) && k > 0 && matches!(before[k - 1], Tok::Word(_) | Tok::Punct(","))
        })
    };
    if redeclared(&name) || redeclared("COLOR") {
        return None;
    }
    let u = uniform(&name)?;
    Some(AlphaRef {
        name,
        component,
        components: u.1,
        default: u.2,
        instance: u.3,
    })
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
    #[test]
    fn synthetic_declarations_preserve_defaults_and_refuse_unknown_defaults() {
        let u = super::synthetic_uniforms(
            r#"
                shader_type canvas_item;
                uniform float threshold;
                instance uniform vec3 scale = vec3(1.0, -2.0, 3.0);
                uniform vec4 tint : source_color;
                uniform bool enabled = true;
                uniform int index = -2;
                uniform float live = 0.5;
                uniform vec2 repeat_value = vec2(0.25);
                uniform float unsupported = mystery(0.0);
                uniform float expression = 1.0 + 2.0;
                uniform float array_value[2];
                void fragment() { if (true) { COLOR.a = threshold; } }
            "#,
        );
        assert_eq!(
            u.iter().map(|u| &*u.name).collect::<Vec<_>>(),
            [
                "threshold",
                "scale",
                "tint",
                "enabled",
                "index",
                "live",
                "repeat_value"
            ]
        );
        assert_eq!(
            u.iter().map(|u| u.unset.clone()).collect::<Vec<_>>(),
            [
                vec![0.0],
                vec![1.0, -2.0, 3.0],
                vec![0.0, 0.0, 0.0, 1.0],
                vec![1.0],
                vec![-2.0],
                vec![0.5],
                vec![0.25, 0.25]
            ]
        );
        assert!(u[1].instance);
        assert_eq!(u[3].kind, super::UniformKind::Bool);
        assert_eq!(u[4].kind, super::UniformKind::Int);
    }

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

    fn alpha_of(code: &str) -> Option<(String, u8)> {
        alpha_uniform(code).map(|a| (a.name.to_string(), a.component))
    }

    /// The shapes the alpha fact recognises: the last statement of fragment() makes the alpha a
    /// uniform's value times something.
    #[test]
    fn alpha_uniform_recognises_a_final_alpha_that_is_a_uniform_multiple() {
        let head = "shader_type canvas_item;\nuniform float threshold : hint_range(0,1);\nuniform vec4 tint : source_color = vec4(1.0);\nuniform float fade = 0.5;\ninstance uniform float inst_a = 1.0;\n";
        let ok = |body: &str| alpha_of(&format!("{head}void fragment() {{\n{body}\n}}\n"));
        let t = || Some(("threshold".to_string(), 0));
        // The STS2 overlay, verbatim (the wire's whitespace-collapsed form).
        assert_eq!(
            alpha_of("shader_type canvas_item;\n\nuniform float threshold : hint_range(0,1);\n\nvoid fragment() {\n COLOR.a = threshold;\n}\n"),
            t()
        );
        assert_eq!(ok("COLOR.a = threshold;"), t());
        assert_eq!(ok("COLOR.w = 0.5 * threshold;"), t());
        assert_eq!(ok("COLOR.a *= threshold;"), t());
        assert_eq!(
            ok("COLOR.a = threshold * texture(TEXTURE, UV).a * COLOR.a * fade;"),
            t()
        );
        assert_eq!(
            ok("COLOR.a = textureLod(TEXTURE, UV, 0.0).r * threshold;"),
            t()
        );
        assert_eq!(
            ok("if (UV.x > 0.5) { COLOR.a = 1.0; } else { discard; }\nCOLOR.a = threshold;"),
            t()
        );
        assert_eq!(ok("COLOR.a = tint.a;"), Some(("tint".into(), 3)));
        assert_eq!(ok("COLOR.a = tint.g * 2.0;"), Some(("tint".into(), 1)));
        assert_eq!(ok("COLOR = tint;"), Some(("tint".into(), 3)));
        assert_eq!(ok("COLOR *= tint;"), Some(("tint".into(), 3)));
        assert_eq!(ok("COLOR = COLOR * tint;"), Some(("tint".into(), 3)));
        assert_eq!(
            ok("COLOR = texture(TEXTURE, UV) * fade;"),
            Some(("fade".into(), 0))
        );
        assert_eq!(ok("COLOR = vec4(COLOR.rgb, threshold);"), t());
        assert_eq!(
            ok("COLOR = vec4(0.2, 0.3, 0.4, fade * COLOR.a);"),
            Some(("fade".into(), 0))
        );
        assert_eq!(ok("COLOR.a = inst_a;"), Some(("inst_a".into(), 0)));
        // Comments and include markers are not code.
        assert_eq!(
            ok("// COLOR.a = 1.0;\nCOLOR.a = /* x */ threshold; // done"),
            t()
        );
        let d = alpha_uniform(&format!("{head}void fragment() {{ COLOR.a = fade; }}")).unwrap();
        assert_eq!((d.default, d.components, d.instance), (Some(0.5), 1, false));
    }

    /// Every shape the fact cannot vouch for is refused.
    #[test]
    fn alpha_uniform_refuses_what_it_cannot_prove() {
        let head = "shader_type canvas_item;\nuniform float threshold;\nuniform vec4 tint;\nuniform float arr[2];\nglobal uniform float g;\nuniform mat4 m;\n";
        let no = |body: &str| {
            let code = format!("{head}void fragment() {{\n{body}\n}}\n");
            assert_eq!(alpha_of(&code), None, "{body}");
        };
        // A sum, a difference, a quotient, a ternary, a call around it, a negation.
        no("COLOR.a = threshold + 0.1;");
        no("COLOR.a = 1.0 - threshold;");
        no("COLOR.a = threshold / 2.0;");
        no("COLOR.a = UV.x > 0.5 ? threshold : 1.0;");
        no("COLOR.a = max(threshold, 0.1);");
        no("COLOR.a = -threshold;");
        // Not the last statement, or a later write.
        no("COLOR.a = threshold;\nCOLOR.rgb = vec3(1.0);");
        no("COLOR.a = threshold;\nCOLOR = vec4(1.0);");
        // Conditional, looped, or skippable by a return.
        no("if (UV.x > 0.5) COLOR.a = threshold;");
        no("if (UV.x > 0.5) { COLOR.a = 1.0; } else COLOR.a = threshold;");
        no("for (int i = 0; i < 2; i++) COLOR.a = threshold;");
        no("if (UV.x > 0.5) { return; }\nCOLOR.a = threshold;");
        // A shadowing local.
        no("float threshold = 1.0;\nCOLOR.a = threshold;");
        no("float a = 1.0, threshold = 1.0;\nCOLOR.a = threshold;");
        // Arrays, global uniforms, matrices, non-float swizzles, a whole vec4 times a matrix.
        no("COLOR.a = arr[0];");
        no("COLOR.a = g;");
        no("COLOR = m * tint;");
        no("COLOR.a = tint.xy;");
        no("COLOR = vec4(1.0) * vec4(threshold);");
        no("COLOR.rgb = vec3(threshold);");
        // A factor not finite by construction: a local, a call, a parenthesis, a division, a
        // literal past a float's range (0 * inf is NaN, not 0).
        no("float k = 2.0;\nCOLOR.a = threshold * k;");
        no("COLOR.a = threshold * exp(UV.x * 100.0);");
        no("COLOR.a = threshold * pow(UV.x, -1.0);");
        no("COLOR.a = threshold * (1.0 / UV.x);");
        no("COLOR.a = threshold * 1e40;");
        no("vec4 c = texture(TEXTURE, UV); COLOR.a = c.a * threshold;");
        no("COLOR = vec4(vec3(1.0) / UV.x, threshold);");
        no("COLOR = vec4(exp(UV.x), 0.0, 0.0, threshold);");
        // Not a uniform at all.
        no("float k = 0.0;\nCOLOR.a = k;");
        // A preprocessor line can rename anything.
        assert_eq!(
            alpha_of("shader_type canvas_item;\n#define threshold 1.0\nuniform float t2;\nvoid fragment() { COLOR.a = t2; }"),
            None
        );
        // No fragment(), or two.
        assert_eq!(alpha_of("shader_type canvas_item;\nuniform float threshold;\nvoid vertex() { COLOR.a = threshold; }"), None);
    }

    /// The fact resolves against the program's declared uniforms: index and component.
    #[test]
    fn with_code_resolves_the_alpha_uniform_against_the_declarations() {
        let meta = r#"{"blend":"mix","lightMode":"normal","uniforms":[{"name":"fade","type":"float","components":1,"instance":false,"integer":false,"unset":[0]},{"name":"tint","type":"vec4","components":4,"instance":false,"integer":false,"unset":[1,1,1,1]}],"samplers":[]}"#;
        let info = ProgramInfo::from_meta_json(1, meta).unwrap();
        assert_eq!(info.alpha, None);
        let a = info.clone().with_code("shader_type canvas_item;\nuniform float fade;\nuniform vec4 tint;\nvoid fragment() { COLOR.a = tint.a; }");
        assert_eq!(
            a.alpha,
            Some(AlphaUniform {
                uniform: 1,
                component: 3
            })
        );
        // A uniform the metadata does not declare proves nothing.
        let b = info.with_code(
            "shader_type canvas_item;\nuniform float other;\nvoid fragment() { COLOR.a = other; }",
        );
        assert_eq!(b.alpha, None);
    }
}
