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

use crate::state::{
    CollisionMode, EmissionShape, EntryStatus, Id, Param, ParamValue, ParticleFlag, ParticlesMode,
    ProcessBuiltin, ProcessParam, ResolvedState, SubEmitterMode, VariantType,
};

/// Floats per simulated instance: transform rows (8), colour (4), custom (4).
pub const PT_INSTANCE_FLOATS: usize = 16;

/// One emitter's newest simulated instances.
#[derive(Clone, Debug, Default)]
pub struct PtBuffer {
    pub floats: Vec<f32>,
    pub serial: u64,
}

/// What [`describe`] last listed: per emitter its version and its material's (id, version, curve
/// textures resolved); per material the same, with its shader's version and whether the shader's
/// code was held (PSE: a uniform-switched key reads the code's declarations).
#[derive(Default)]
pub struct Described {
    emitters: super::IdMap<(i64, Option<Id>)>,
    materials: super::IdMap<MaterialKey>,
    ids: Vec<Id>,
    /// PSE: each process shader code's switch declarations ([`declared_switches`]), by code hash,
    /// read once when the code is first held (so a store eviction never loses them).
    switches: std::collections::HashMap<crate::state::Hash, Vec<(Switch, Option<f64>)>>,
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

/// A material's [`Described`] key: its version, its curve textures resolved, its shader's version
/// and whether its shader code's switch declarations were known.
type MaterialKey = (i64, usize, i64, bool);

/// PSE (render-stream-12.md "As built (PSE)"): the `particle_process_material` key fields a
/// uniform-switched process shader reads from a uniform, by the uniform's name. Stock 4.5.1
/// generates one shader per `MaterialKey`, with each field compiled in, so every material on a
/// shader has the shader's key (the capture's builtin). A process shader may instead keep the
/// fields as uniforms (one shader for every key: an engine fork's `ParticleProcessMaterial`, or a
/// hand-made one set on a `ParticleProcessMaterial`'s RID), and then each material's key is its
/// own uniform values. The names follow `MaterialKey`'s fields; a field whose uniform the shader
/// does not declare keeps the capture's builtin.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Switch {
    /// `int`: `EmissionShape` by enum value.
    EmissionShape,
    /// `bool[PARTICLE_FLAG_MAX]`: `particle_flags` by flag.
    ParticleFlags,
    /// `bool[PARAM_MAX]`: `textures` by parameter.
    Textures,
    ColorRamp,
    ColorInitialRamp,
    AlphaCurve,
    EmissionCurve,
    VelocityLimitCurve,
    OrbitVelocityCurveXyz,
    EmissionColorTexture,
    /// `int`: `SubEmitterMode` by enum value.
    SubEmitter,
    Attractor,
    /// `int`: `CollisionMode` by enum value.
    Collision,
    Turbulence,
}

/// PSE: whether a process material's parameters name a switch uniform that stock 4.5.1's
/// `ParticleProcessMaterial` never sets (it sets `turbulence_enabled` on every material, a uniform
/// its generated code never declares). Only such a material's shader code is fetched by GSW
/// ([`switch_candidate_shader_hashes`]): a stream of stock materials fetches nothing more.
pub fn switch_candidate(params: &[Param]) -> bool {
    params.iter().any(|p| {
        &*p.name != "turbulence_enabled" && SWITCH_UNIFORMS.iter().any(|(n, _, _)| *n == &*p.name)
    })
}

/// PSE: the code hashes of the process shaders GSW reads switch declarations from: the shader of
/// every simulated emitter's process material that is a [`switch_candidate`], when the shader has
/// a `particle_process_material` builtin and its code is a payload.
pub fn switch_candidate_shader_hashes(state: &ResolvedState) -> Vec<crate::state::Hash> {
    let mut out: Vec<crate::state::Hash> = Vec::new();
    for id in simulated(state) {
        let Some(m) = state.particles[&id]
            .process_material
            .and_then(|m| state.materials.get(&m))
        else {
            continue;
        };
        if !switch_candidate(&m.params) {
            continue;
        }
        let Some(s) = m.shader.and_then(|s| state.shaders.get(&s)) else {
            continue;
        };
        if s.status != EntryStatus::Ok
            || s.process.is_none()
            || s.source != Some(crate::state::ShaderSource::Payload)
        {
            continue;
        }
        if let Some(h) = s.hash {
            if !out.contains(&h) {
                out.push(h);
            }
        }
    }
    out
}

/// PSE: each switch uniform's name, GLSL type and key field.
pub const SWITCH_UNIFORMS: &[(&str, &str, Switch)] = &[
    ("emission_shape", "int", Switch::EmissionShape),
    ("particle_flags", "bool", Switch::ParticleFlags),
    ("use_tex_param", "bool", Switch::Textures),
    ("use_color_ramp", "bool", Switch::ColorRamp),
    ("has_initial_ramp", "bool", Switch::ColorInitialRamp),
    ("use_alpha_curve", "bool", Switch::AlphaCurve),
    ("use_emission_curve", "bool", Switch::EmissionCurve),
    ("use_limiter_curve", "bool", Switch::VelocityLimitCurve),
    ("orbit_uses_curve_xyz", "bool", Switch::OrbitVelocityCurveXyz),
    ("has_emission_color", "bool", Switch::EmissionColorTexture),
    ("sub_emitter_mode", "int", Switch::SubEmitter),
    ("attractor_enabled", "bool", Switch::Attractor),
    ("collision_mode", "int", Switch::Collision),
    ("turbulence_enabled", "bool", Switch::Turbulence),
];

/// PSE: the switch uniforms `code` declares at the top level (`uniform <type> <name>`, an array
/// size allowed, with the type [`SWITCH_UNIFORMS`] gives), each with its declared default when it
/// is a `true`/`false`/integer literal (`None`: the GLSL zero). Comments are skipped.
pub fn declared_switches(code: &str) -> Vec<(Switch, Option<f64>)> {
    // Tokens outside comments, with the brace depth each one sits at.
    let bytes = code.as_bytes();
    let mut toks: Vec<(&str, i32)> = Vec::new();
    let mut depth = 0i32;
    let mut i = 0;
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
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
        if word(c) {
            let start = i;
            while i < bytes.len() && word(bytes[i]) {
                i += 1;
            }
            toks.push((&code[start..i], depth));
            continue;
        }
        match c {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            toks.push((&code[i..i + 1], depth));
        }
        i += 1;
    }
    let mut out: Vec<(Switch, Option<f64>)> = Vec::new();
    for k in 0..toks.len() {
        if toks[k] != ("uniform", 0) || k + 2 >= toks.len() {
            continue;
        }
        let (ty, name) = (toks[k + 1].0, toks[k + 2].0);
        let Some(&(_, _, sw)) = SWITCH_UNIFORMS
            .iter()
            .find(|(n, t, _)| *n == name && *t == ty)
        else {
            continue;
        };
        // `[N]` may follow the name; then `= literal`, `: hint` or `;`.
        let mut j = k + 3;
        if toks.get(j).map(|t| t.0) == Some("[") {
            while j < toks.len() && toks[j].0 != "]" {
                j += 1;
            }
            j += 1;
        }
        let default = match (toks.get(j).map(|t| t.0), toks.get(j + 1).map(|t| t.0)) {
            (Some("="), Some("true")) => Some(1.0),
            (Some("="), Some("false")) => Some(0.0),
            (Some("="), Some(v)) => v.parse::<i64>().ok().map(|n| n as f64),
            _ => None,
        };
        if !out.iter().any(|(s, _)| *s == sw) {
            out.push((sw, default));
        }
    }
    out
}

/// PSE: `base` (the capture's builtin: the first material's key) with every field whose switch
/// uniform `declared` lists taken from `params` (the material's own value; else the declared
/// default; else zero). An out-of-range enum value keeps the builtin's.
pub fn material_key(
    base: &ProcessBuiltin,
    declared: &[(Switch, Option<f64>)],
    params: &[Param],
) -> ProcessBuiltin {
    let mut k = base.clone();
    for &(sw, default) in declared {
        let name = SWITCH_UNIFORMS
            .iter()
            .find(|(_, _, s)| *s == sw)
            .map(|(n, _, _)| *n)
            .unwrap_or_default();
        let value: Vec<f64> = match params.iter().find(|p| &*p.name == name).map(|p| &p.value) {
            Some(ParamValue::Scalar(x)) => vec![*x],
            Some(ParamValue::Flat(v)) => v.clone(),
            Some(ParamValue::Nested { values, .. }) => values.clone(),
            _ => default.map(|d| vec![d]).unwrap_or_default(),
        };
        let on = |i: usize| value.get(i).is_some_and(|v| *v != 0.0);
        let int = || value.first().map(|v| *v as i64).unwrap_or(0);
        let pick = |all: usize| usize::try_from(int()).ok().filter(|n| *n < all);
        match sw {
            Switch::EmissionShape => {
                if let Some(n) = pick(EmissionShape::ALL.len()) {
                    k.emission_shape = EmissionShape::ALL[n];
                }
            }
            Switch::ParticleFlags => {
                k.particle_flags = (0..ParticleFlag::ALL.len())
                    .filter(|i| on(*i))
                    .map(|i| ParticleFlag::ALL[i])
                    .collect();
            }
            Switch::Textures => {
                k.textures = (0..ProcessParam::ALL.len())
                    .filter(|i| on(*i))
                    .map(|i| ProcessParam::ALL[i])
                    .collect();
            }
            Switch::ColorRamp => k.color_ramp = on(0),
            Switch::ColorInitialRamp => k.color_initial_ramp = on(0),
            Switch::AlphaCurve => k.alpha_curve = on(0),
            Switch::EmissionCurve => k.emission_curve = on(0),
            Switch::VelocityLimitCurve => k.velocity_limit_curve = on(0),
            Switch::OrbitVelocityCurveXyz => k.orbit_velocity_curve_xyz = on(0),
            Switch::EmissionColorTexture => k.emission_color_texture = on(0),
            Switch::SubEmitter => {
                if let Some(n) = pick(SubEmitterMode::ALL.len()) {
                    k.sub_emitter = SubEmitterMode::ALL[n];
                }
            }
            Switch::Attractor => k.attractor = on(0),
            Switch::Collision => {
                if let Some(n) = pick(CollisionMode::ALL.len()) {
                    k.collision = CollisionMode::ALL[n];
                }
            }
            Switch::Turbulence => k.turbulence = on(0),
        }
    }
    k
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
///
/// `shared_key` (GSW's receiver sabotage `shared-process-key`, the pre-PSE GSW): every material
/// on a process shader takes the shader's builtin as is, uniform-switched or not.
pub fn describe(
    state: &ResolvedState,
    store: &mut super::payloads::PayloadStore,
    linear_colors: bool,
    shared_key: bool,
) -> String {
    let ids = simulated(state);
    // A material's key: its version and how many of its texture params resolve to a curve now
    // (a curve payload may arrive after the material), its shader's version and whether the
    // shader's code is held (PSE: it may arrive after the material too).
    let mut mat_keys: Vec<(Id, MaterialKey)> = Vec::new();
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
        let shader = m.shader.and_then(|s| state.shaders.get(&s));
        // PSE: a candidate's shader code, read for its switch declarations once it is held.
        let mut known = false;
        if switch_candidate(&m.params) {
            if let Some(h) = shader.and_then(|s| s.hash) {
                let d = &mut store.particles.described;
                if !d.switches.contains_key(&h) {
                    if let Some(code) = store.shaders.get(&h) {
                        d.switches.insert(h, declared_switches(code));
                    }
                }
                known = store.particles.described.switches.contains_key(&h);
            }
        }
        let shader_version = shader.map(|s| s.version).unwrap_or(-1);
        mat_keys.push((mid, (m.version, curves, shader_version, known)));
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
        let shader = m.shader.and_then(|s| state.shaders.get(&s));
        // PSE: a uniform-switched process shader's key is each material's own.
        let switched;
        let process = match shader.and_then(|s| s.process.as_ref()) {
            Some(b) if !shared_key && switch_candidate(&m.params) => {
                let declared = shader
                    .and_then(|s| s.hash)
                    .and_then(|h| store.particles.described.switches.get(&h))
                    .cloned()
                    .unwrap_or_default();
                if declared.is_empty() {
                    Some(b)
                } else {
                    switched = material_key(b, &declared, &m.params);
                    Some(&switched)
                }
            }
            b => b,
        };
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

#[cfg(test)]
mod pse_tests {
    use super::*;

    fn base() -> ProcessBuiltin {
        ProcessBuiltin {
            emission_shape: EmissionShape::Box,
            particle_flags: vec![ParticleFlag::DisableZ],
            textures: vec![],
            color_ramp: true,
            color_initial_ramp: false,
            alpha_curve: true,
            emission_curve: false,
            velocity_limit_curve: false,
            orbit_velocity_curve_xyz: false,
            emission_color_texture: false,
            sub_emitter: SubEmitterMode::Disabled,
            attractor: true,
            collision: CollisionMode::Disabled,
            collision_scale: false,
            turbulence: false,
        }
    }

    fn param(name: &str, ty: VariantType, value: ParamValue) -> Param {
        Param {
            name: name.into(),
            ty,
            value,
        }
    }

    #[test]
    fn candidates_skip_stock_materials() {
        // Stock ParticleProcessMaterial sets turbulence_enabled (never declared) and the shape's
        // own parameters, never a switch uniform.
        let stock = [
            param("turbulence_enabled", VariantType::Bool, ParamValue::Scalar(0.0)),
            param("emission_sphere_radius", VariantType::Float, ParamValue::Scalar(1.0)),
        ];
        assert!(!switch_candidate(&stock));
        let switched = [param("emission_shape", VariantType::Int, ParamValue::Scalar(1.0))];
        assert!(switch_candidate(&switched));
    }

    #[test]
    fn stock_code_declares_no_switch() {
        // A stock generated shader: the shape compiled in, its parameters as uniforms.
        let code = "shader_type particles;\nuniform vec3 emission_box_extents;\nuniform float emission_sphere_radius;\n// uniform int emission_shape;\nvoid start() {\n\tint emission_shape = 1;\n}\n";
        assert!(declared_switches(code).is_empty());
    }

    #[test]
    fn switches_with_arrays_hints_and_defaults() {
        let code = "shader_type particles;\nconst int PARAM_MAX = 18;\nuniform bool use_color_ramp;\nuniform int emission_shape;\nuniform bool use_tex_param[PARAM_MAX];\nuniform bool particle_flags[4];\nuniform int collision_mode = 2;\nuniform bool turbulence_enabled = true;\nuniform float emission_shape_scale = 1.0;\nuniform vec3 emission_shape;\n/* uniform bool attractor_enabled; */\nvoid process() { bool use_alpha_curve = false; }\n";
        let d = declared_switches(code);
        assert_eq!(
            d,
            vec![
                (Switch::ColorRamp, None),
                (Switch::EmissionShape, None),
                (Switch::Textures, None),
                (Switch::ParticleFlags, None),
                (Switch::Collision, Some(2.0)),
                (Switch::Turbulence, Some(1.0)),
            ]
        );
    }

    #[test]
    fn each_material_its_own_key() {
        let code = "uniform int emission_shape;\nuniform bool use_color_ramp;\nuniform bool particle_flags[4];\nuniform bool use_tex_param[18];\nuniform int sub_emitter_mode;\nuniform bool attractor_enabled;\n";
        let d = declared_switches(code);
        // The first material (the capture's builtin) is a box; this one a sphere with no ramp.
        let sphere = [
            param("emission_shape", VariantType::Int, ParamValue::Scalar(1.0)),
            param(
                "particle_flags",
                VariantType::PackedInt32Array,
                ParamValue::Flat(vec![0.0, 1.0, 1.0, 0.0]),
            ),
            param(
                "use_tex_param",
                VariantType::PackedInt32Array,
                ParamValue::Flat({
                    let mut v = vec![0.0; 18];
                    v[8] = 1.0;
                    v
                }),
            ),
            param("sub_emitter_mode", VariantType::Int, ParamValue::Scalar(2.0)),
            param("emission_sphere_radius", VariantType::Float, ParamValue::Scalar(5.0)),
        ];
        let k = material_key(&base(), &d, &sphere);
        assert_eq!(k.emission_shape, EmissionShape::Sphere);
        assert_eq!(k.particle_flags, vec![ParticleFlag::RotateY, ParticleFlag::DisableZ]);
        assert_eq!(k.textures, vec![ProcessParam::Scale]);
        assert_eq!(k.sub_emitter, SubEmitterMode::AtEnd);
        // Declared but not set: the uniform's zero.
        assert!(!k.color_ramp);
        assert!(!k.attractor);
        // Not declared: the builtin's.
        assert!(k.alpha_curve);
        // An out-of-range shape keeps the builtin's.
        let bad = [param("emission_shape", VariantType::Int, ParamValue::Scalar(9.0))];
        assert_eq!(material_key(&base(), &d, &bad).emission_shape, EmissionShape::Box);
        // No declared switch: the builtin as is.
        assert_eq!(material_key(&base(), &[], &sphere), base());
    }
}
