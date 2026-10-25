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
use gsw_canvas_draw_list::UniformValue;

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
            samplers.push(SamplerDecl {
                name: str_of(s, "name")?.into(),
                linear: filter.map(|f| f == "linear"),
                repeat: doc.get(s, "repeat").and_then(|v| doc.as_bool(v)),
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
        Ok(ProgramInfo {
            program,
            blend,
            light,
            uniforms,
            samplers,
            screen,
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
