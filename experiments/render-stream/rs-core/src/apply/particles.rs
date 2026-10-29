//! PM6b (render-stream-12.md "As built (PM6b)"): GSW's half of /12 GPU particles.
//!
//! GSW simulates each emitter itself (`packages/effects` `GodotGpuEmitter`, the shell's
//! `particles.ts`): this module is what the applier and the shell share.
//!
//! - [`describe`] writes the emitters an item can draw (every `ok` 2D entry of the resolved
//!   table) with their process material's builtin key, uniforms and curve textures (sampled at
//!   their stored values: [`super::payloads::TexturePixels::floats`]), as JSON for the shell. It
//!   lists an emitter or a material only when it changed since the last call ([`Described`]), so a
//!   stream whose emitters hold still costs one id walk a frame.
//! - [`ParticleBuffers`] holds the newest instance buffer the shell simulated for each emitter
//!   (16 floats an instance, the 2D multimesh layout PM3 draws), by particles id, with a serial
//!   that moves on every set: the applier rewrites an instanced draw's range when it moved, as it
//!   does for a multimesh's buffer.

use std::fmt::Write as _;

use crate::state::{EntryStatus, Id, ParamValue, ParticlesMode, ResolvedState, VariantType};

/// Floats per simulated instance: transform rows (8), colour (4), custom (4).
pub const PT_INSTANCE_FLOATS: usize = 16;

/// One emitter's newest simulated instances.
#[derive(Clone, Debug, Default)]
pub struct PtBuffer {
    pub floats: Vec<f32>,
    pub serial: u64,
}

/// What [`describe`] last listed: per emitter its version and its material's (id, version, curve
/// textures resolved); per material the same.
#[derive(Default)]
pub struct Described {
    emitters: super::IdMap<(i64, Option<Id>)>,
    materials: super::IdMap<(i64, usize)>,
    ids: Vec<Id>,
}

#[derive(Default)]
pub struct ParticleBuffers {
    map: super::IdMap<PtBuffer>,
    serial: u64,
    pub described: Described,
    /// Evidence since the session began: buffers set, emitters first held and dropped, the wire's
    /// emits consumed (gl_compatibility's `particles_emit` is a no-op: render-stream-12.md "As
    /// built (PM6a)" rule 10) and, under the receiver sabotage `ignore-particle-emits`, dropped.
    pub sets_total: u64,
    pub created_total: u64,
    pub freed_total: u64,
    pub emits_total: u64,
    pub emits_dropped: u64,
    /// Moves whenever an emitter gains or loses its buffer (an applier re-lowers the items that
    /// draw it: the draw is skipped until the first buffer arrives).
    pub membership: u64,
}

impl ParticleBuffers {
    pub fn clear(&mut self) {
        *self = ParticleBuffers::default();
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get(&self, id: Id) -> Option<&PtBuffer> {
        self.map.get(&id)
    }

    /// The shell's simulated instances for emitter `id` (a whole number of instances).
    pub fn set(&mut self, id: Id, floats: &[f32]) {
        self.serial += 1;
        self.sets_total += 1;
        if !self.map.contains_key(&id) {
            self.created_total += 1;
            self.membership += 1;
        }
        let e = self.map.entry(id).or_default();
        e.floats.clear();
        e.floats.extend_from_slice(floats);
        e.serial = self.serial;
    }

    /// Drops every buffer whose emitter the state no longer holds as `ok`.
    pub fn retain(&mut self, state: &ResolvedState) {
        if self.map.is_empty() {
            return;
        }
        let before = self.map.len();
        self.map.retain(|id, _| {
            state
                .particles
                .get(id)
                .is_some_and(|p| p.status == EntryStatus::Ok)
        });
        let gone = (before - self.map.len()) as u64;
        self.freed_total += gone;
        if gone > 0 {
            self.membership += 1;
        }
    }
}

fn num(out: &mut String, v: f64) {
    if v.is_finite() {
        let _ = write!(out, "{v}");
    } else {
        out.push('0');
    }
}

fn nums(out: &mut String, v: &[f32]) {
    out.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        num(out, f64::from(*x));
    }
    out.push(']');
}

fn string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A texture's level 0 as RGBA floats when it is small enough to be a curve (at most 4 rows):
/// its f32 values, else its half floats widened, else its RGBA8 over 255.
fn curve_texels(
    state: &ResolvedState,
    textures: &super::payloads::PayloadStore,
    tex: Id,
) -> Option<(u32, u32, Vec<f32>)> {
    let t = state.textures.get(&tex)?;
    if t.status != EntryStatus::Ok || t.height > 4 {
        return None;
    }
    let px = textures.textures.get(&t.hash?)?;
    if px.height > 4 {
        return None;
    }
    let n = (px.width * px.height) as usize;
    if let Some(f) = &px.floats {
        return Some((px.width, px.height, f.clone()));
    }
    if let Some(h) = &px.half {
        let v: Vec<f32> = h
            .chunks_exact(2)
            .map(|c| super::payloads::half_to_f32(u16::from_le_bytes([c[0], c[1]])))
            .collect();
        return (v.len() == 4 * n).then_some((px.width, px.height, v));
    }
    (px.rgba.len() == 4 * n).then(|| {
        (
            px.width,
            px.height,
            px.rgba.iter().map(|b| f32::from(*b) / 255.0).collect(),
        )
    })
}

/// The emitters GSW simulates (every `ok` 2D entry), ascending.
fn simulated(state: &ResolvedState) -> Vec<Id> {
    let mut ids: Vec<Id> = state
        .particles
        .iter()
        .filter(|(_, p)| p.status == EntryStatus::Ok && p.mode == ParticlesMode::D2)
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    ids
}

/// The shell's sync message, or an empty string when nothing changed since the last call:
/// `{"ids":[..], "emitters":[..], "materials":[..]}` (render-stream-12.md "As built (PM6b)").
/// PFB (render-stream-12.md "As built (PFB)"): whether a host rendering with
/// `engine.rendering_method` uploads a particles material's colour uniforms in linear space.
/// RendererRD (`forward_plus`, `mobile`) fills a particles material's uniform buffer with
/// `p_use_linear_color` true unconditionally (particles_storage.cpp:1768): a `Color` value
/// (variant_converters.h:208-213) and a `source_color` default (material_storage.cpp:456-459) go
/// through `Color::srgb_to_linear()`. GLES3 converts nothing (gl_compatibility's
/// material_storage.cpp has no such parameter). The 2D canvas is not linear on either backend
/// (`hdr_2d` off), so the converted colour reaches the canvas as is: a Forward+ host draws a
/// `ParticleProcessMaterial.color` of 0.29 as 0.069.
pub fn host_linearizes_particle_colors(rendering_method: &str) -> bool {
    matches!(rendering_method, "forward_plus" | "mobile")
}

/// PFB: Godot's `Color::srgb_to_linear()` on one channel (core/math/color.h:191-197), in its
/// float precision: the inner expression in double, narrowed to float before `pow`.
pub fn srgb_to_linear(c: f32) -> f32 {
    if c < 0.04045 {
        c * (1.0f32 / 12.92f32)
    } else {
        (((f64::from(c) + 0.055) * (1.0 / (1.0 + 0.055))) as f32).powf(2.4)
    }
}

/// PFB: a particles material's uniform value as a host that linearizes colours
/// ([`host_linearizes_particle_colors`]) uploads it: a `color` parameter's RGB through
/// [`srgb_to_linear`] (alpha untouched), every other parameter unchanged.
pub fn host_uniform_value(ty: VariantType, v: &[f64], linear_colors: bool) -> Vec<f64> {
    let mut out = v.to_vec();
    if linear_colors && ty == VariantType::Color && out.len() == 4 {
        for c in out.iter_mut().take(3) {
            *c = f64::from(srgb_to_linear(*c as f32));
        }
    }
    out
}

/// `linear_colors`: the host linearizes a particles material's colour uniforms
/// ([`host_linearizes_particle_colors`] of the session's `engine.rendering_method`); the listed
/// uniforms are then the values the host's process shader read.
pub fn describe(
    state: &ResolvedState,
    store: &mut super::payloads::PayloadStore,
    linear_colors: bool,
) -> String {
    let ids = simulated(state);
    // A material's key: its version and how many of its texture params resolve to a curve now
    // (a curve payload may arrive after the material).
    let mut mat_keys: Vec<(Id, (i64, usize))> = Vec::new();
    for id in &ids {
        let Some(mid) = state.particles.get(id).and_then(|p| p.process_material) else {
            continue;
        };
        if mat_keys.iter().any(|(m, _)| *m == mid) {
            continue;
        }
        let Some(m) = state.materials.get(&mid) else {
            continue;
        };
        let curves = m
            .params
            .iter()
            .filter(|p| match p.value {
                ParamValue::Tex(t) => curve_texels(state, store, t).is_some(),
                _ => false,
            })
            .count();
        mat_keys.push((mid, (m.version, curves)));
    }
    let d = &store.particles.described;
    let changed_emitters: Vec<Id> = ids
        .iter()
        .copied()
        .filter(|id| {
            let p = &state.particles[id];
            d.emitters.get(id) != Some(&(p.version, p.process_material))
        })
        .collect();
    let changed_materials: Vec<Id> = mat_keys
        .iter()
        .filter(|(m, k)| d.materials.get(m) != Some(k))
        .map(|(m, _)| *m)
        .collect();
    if changed_emitters.is_empty() && changed_materials.is_empty() && d.ids == ids {
        return String::new();
    }
    let mut out = String::with_capacity(256);
    out.push_str("{\"ids\":[");
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{id}");
    }
    out.push_str("],\"emitters\":[");
    for (i, id) in changed_emitters.iter().enumerate() {
        let p = &state.particles[id];
        if i > 0 {
            out.push(',');
        }
        let _ = write!(
            out,
            "{{\"id\":{id},\"version\":{},\"emitting\":{},\"amount\":{},\"one_shot\":{},\"fixed_fps\":{},\"interpolate\":{},\"fractional_delta\":{},\"local\":{},\"draw_order\":\"{}\",\"trails\":{},\"seed\":{},\"restarts\":{},\"emits\":{},\"process_requests\":{},\"material\":{}",
            p.version,
            p.emitting,
            p.amount,
            p.one_shot,
            p.fixed_fps,
            p.interpolate,
            p.fractional_delta,
            p.local,
            p.draw_order.as_str(),
            p.trails,
            p.seed,
            p.restarts,
            p.emits,
            p.process_requests,
            p.process_material
                .map(|m| m.to_string())
                .unwrap_or_else(|| "null".into()),
        );
        if let Some(f) = &p.floats {
            out.push_str(",\"f\":{\"amount_ratio\":");
            num(&mut out, f64::from(f.amount_ratio));
            out.push_str(",\"lifetime\":");
            num(&mut out, f64::from(f.lifetime));
            out.push_str(",\"pre_process_time\":");
            num(&mut out, f64::from(f.pre_process_time));
            out.push_str(",\"explosiveness\":");
            num(&mut out, f64::from(f.explosiveness));
            out.push_str(",\"randomness\":");
            num(&mut out, f64::from(f.randomness));
            out.push_str(",\"speed_scale\":");
            num(&mut out, f64::from(f.speed_scale));
            out.push_str(",\"interp_to_end\":");
            num(&mut out, f64::from(f.interp_to_end));
            out.push_str(",\"request_process_time\":");
            num(&mut out, f64::from(f.request_process_time));
            out.push_str(",\"emission_transform\":");
            nums(&mut out, &f.emission_transform);
            out.push_str(",\"emitter_velocity\":");
            nums(&mut out, &f.emitter_velocity);
            out.push('}');
        }
        out.push('}');
    }
    out.push_str("],\"materials\":[");
    for (i, mid) in changed_materials.iter().enumerate() {
        let m = &state.materials[mid];
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{{\"id\":{mid},\"version\":{},\"builtin\":", m.version);
        let process = m
            .shader
            .and_then(|s| state.shaders.get(&s))
            .and_then(|s| s.process.as_ref());
        match process {
            None => out.push_str("null"),
            Some(b) => {
                out.push_str("{\"emission_shape\":");
                string(&mut out, b.emission_shape.as_str());
                out.push_str(",\"particle_flags\":[");
                for (k, f) in b.particle_flags.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    string(&mut out, f.as_str());
                }
                out.push_str("],\"sub_emitter\":");
                string(&mut out, b.sub_emitter.as_str());
                let _ = write!(
                    out,
                    ",\"attractor\":{},\"collision\":\"{}\",\"turbulence\":{}}}",
                    b.attractor,
                    b.collision.as_str(),
                    b.turbulence
                );
            }
        }
        out.push_str(",\"uniforms\":{");
        let mut first = true;
        for p in &m.params {
            let v: Option<Vec<f64>> = match &p.value {
                ParamValue::Scalar(x) => Some(vec![*x]),
                ParamValue::Flat(v) => Some(host_uniform_value(p.ty, v, linear_colors)),
                _ => None,
            };
            let Some(v) = v else { continue };
            if !first {
                out.push(',');
            }
            first = false;
            string(&mut out, &p.name);
            out.push(':');
            if v.len() == 1 {
                num(&mut out, v[0]);
            } else {
                out.push('[');
                for (k, x) in v.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    num(&mut out, *x);
                }
                out.push(']');
            }
        }
        out.push_str("},\"curves\":{");
        let mut first = true;
        for p in &m.params {
            let ParamValue::Tex(t) = p.value else {
                continue;
            };
            let Some((w, h, data)) = curve_texels(state, store, t) else {
                continue;
            };
            if !first {
                out.push(',');
            }
            first = false;
            string(&mut out, &p.name);
            let _ = write!(out, ":{{\"width\":{w},\"height\":{h},\"data\":");
            nums(&mut out, &data);
            out.push('}');
        }
        out.push_str("}}");
    }
    out.push_str("]}");
    let d = &mut store.particles.described;
    for id in &changed_emitters {
        let p = &state.particles[id];
        d.emitters.insert(*id, (p.version, p.process_material));
    }
    d.emitters.retain(|id, _| ids.binary_search(id).is_ok());
    for (m, k) in mat_keys {
        d.materials.insert(m, k);
    }
    d.ids = ids;
    out
}

#[cfg(test)]
mod pfb_tests {
    use super::*;

    #[test]
    fn host_backends() {
        assert!(host_linearizes_particle_colors("forward_plus"));
        assert!(host_linearizes_particle_colors("mobile"));
        assert!(!host_linearizes_particle_colors("gl_compatibility"));
        assert!(!host_linearizes_particle_colors("dummy"));
        assert!(!host_linearizes_particle_colors(""));
    }

    #[test]
    fn srgb_to_linear_matches_godot() {
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert_eq!(srgb_to_linear(1.0), 1.0);
        // The linear segment below 0.04045, and the curve above it (Color::srgb_to_linear).
        assert_eq!(srgb_to_linear(0.04), 0.04f32 * (1.0f32 / 12.92f32));
        assert!((srgb_to_linear(0.5) - 0.214_041_14).abs() < 1e-6);
        assert!((srgb_to_linear(0.2901960015296936) - 0.068_478_6).abs() < 1e-5);
    }

    #[test]
    fn only_colours_move_and_alpha_never() {
        let c = [0.5, 0.25, 0.75, 0.4];
        let lin = host_uniform_value(VariantType::Color, &c, true);
        assert_eq!(lin[3], 0.4);
        assert!((lin[0] - 0.214_041_14).abs() < 1e-6);
        assert_eq!(host_uniform_value(VariantType::Color, &c, false), c.to_vec());
        assert_eq!(host_uniform_value(VariantType::Vector4, &c, true), c.to_vec());
        assert_eq!(host_uniform_value(VariantType::Vector3, &c[..3], true), c[..3].to_vec());
    }
}
