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
    /// Emitters [`describe`] suspended: their process material keys from shader code a live
    /// client has not got (still loading, or unavailable). They hold no buffer (not drawn) and
    /// [`ParticleBuffers::set`] ignores them until the code arrives.
    suspended: Vec<Id>,
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

    /// The emitters [`describe`] suspended last (sorted).
    pub fn suspended(&self) -> &[Id] {
        &self.suspended
    }

    /// Suspends exactly `ids` (sorted): each one's buffer is dropped, so what draws it is
    /// re-lowered and skipped, and the old simulated output is never drawn again.
    fn suspend(&mut self, ids: Vec<Id>) {
        let mut gone = 0u64;
        for id in &ids {
            if self.map.remove(id).is_some() {
                gone += 1;
            }
        }
        self.freed_total += gone;
        if gone > 0 {
            self.membership += 1;
        }
        self.suspended = ids;
    }

    /// The shell's simulated instances for emitter `id` (a whole number of instances); ignored
    /// while `id` is suspended.
    pub fn set(&mut self, id: Id, floats: &[f32]) {
        if self.suspended.binary_search(&id).is_ok() {
            return;
        }
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

/// Borrow a curve payload (at most four rows) without decoding or allocating its texels.
/// Keep the same float, half-float and RGBA8 precedence and shape checks as the decoder.
fn curve_pixels<'a>(
    state: &ResolvedState,
    textures: &'a super::payloads::PayloadStore,
    tex: Id,
) -> Option<&'a super::payloads::TexturePixels> {
    let t = state.textures.get(&tex)?;
    if t.status != EntryStatus::Ok || t.height > 4 {
        return None;
    }
    let px = textures.textures.get(&t.hash?)?;
    if px.height > 4 {
        return None;
    }
    let n = (px.width * px.height) as usize;
    // Match the decoding path's precedence and shape checks without allocating texels.
    if px.floats.is_some()
        || px.half.as_ref().map_or_else(
            || px.rgba.len() == 4 * n,
            |h| h.len() / 2 == 4 * n,
        )
    {
        Some(px)
    } else {
        None
    }
}

fn append_curve(px: &super::payloads::TexturePixels, out: &mut Vec<f32>) {
    let finite = |v: f32| if v.is_finite() { v } else { 0.0 };
    if let Some(f) = &px.floats {
        out.extend(f.iter().copied().map(finite));
    } else if let Some(h) = &px.half {
        out.extend(h.chunks_exact(2).map(|c| {
            finite(super::payloads::half_to_f32(u16::from_le_bytes([c[0], c[1]])))
        }));
    } else {
        out.extend(px.rgba.iter().map(|b| f32::from(*b) / 255.0));
    }
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

/// PSE: whether `params` on `shader` key from the shader's code (a [`switch_candidate`] on an
/// `ok` process shader whose code is a payload): the materials [`switch_candidate_shader_hashes`]
/// fetches the code of.
fn keys_from_code(params: &[Param], shader: Option<&crate::state::Shader>) -> bool {
    switch_candidate(params)
        && shader.is_some_and(|s| {
            s.status == EntryStatus::Ok
                && s.process.is_some()
                && s.source == Some(crate::state::ShaderSource::Payload)
                && s.hash.is_some()
        })
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
    describe_impl(state, store, linear_colors, shared_key, None)
}

/// The wasm sync metadata, with curve offsets and lengths in floats into `curves`.
/// The arena is replaced on every sync; the caller must copy it before another wasm call.
pub fn describe_with_curves(
    state: &ResolvedState,
    store: &mut super::payloads::PayloadStore,
    linear_colors: bool,
    shared_key: bool,
    curves: &mut Vec<f32>,
) -> String {
    curves.clear();
    describe_impl(state, store, linear_colors, shared_key, Some(curves))
}

fn describe_impl(
    state: &ResolvedState,
    store: &mut super::payloads::PayloadStore,
    linear_colors: bool,
    shared_key: bool,
    mut curves: Option<&mut Vec<f32>>,
) -> String {
    let ids = simulated(state);
    // A material's key: its version and how many of its texture params resolve to a curve now
    // (a curve payload may arrive after the material), its shader's version and whether the
    // shader's code is held (PSE: it may arrive after the material too).
    let mut mat_keys: Vec<(Id, MaterialKey)> = Vec::new();
    let mut suspended_mats: Vec<Id> = Vec::new();
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
                ParamValue::Tex(t) => curve_pixels(state, store, t).is_some(),
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
        if !shared_key && !known && keys_from_code(&m.params, shader) {
            suspended_mats.push(mid);
        }
    }
    // A material keyed from process code not held yet is suspended, and so is every emitter it
    // drives: never simulated with the capture's builtin key in its place. Its emitters are
    // re-created (a fresh simulation) once the code arrives and the material is listed again.
    let suspended: Vec<Id> = if suspended_mats.is_empty() {
        Vec::new()
    } else {
        ids.iter()
            .copied()
            .filter(|id| {
                state.particles[id]
                    .process_material
                    .is_some_and(|m| suspended_mats.contains(&m))
            })
            .collect()
    };
    if suspended != store.particles.suspended {
        store.particles.suspend(suspended);
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
        let _ = write!(out, "{{\"id\":{mid},\"version\":{},", m.version);
        if suspended_mats.contains(mid) {
            out.push_str("\"suspended\":true,");
        }
        out.push_str("\"builtin\":");
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
            let Some(px) = curve_pixels(state, store, t) else {
                continue;
            };
            if !first {
                out.push(',');
            }
            first = false;
            string(&mut out, &p.name);
            let (w, h) = (px.width, px.height);
            let _ = write!(out, ":{{\"width\":{w},\"height\":{h},");
            if let Some(arena) = curves.as_deref_mut() {
                let offset = arena.len();
                append_curve(px, arena);
                let length = arena.len() - offset;
                let _ = write!(out, "\"offset\":{offset},\"length\":{length}");
            } else {
                let mut data = Vec::new();
                append_curve(px, &mut data);
                out.push_str("\"data\":");
                nums(&mut out, &data);
            }
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

    fn emitter(id: Id, material: Id) -> crate::state::Particles {
        crate::state::Particles {
            id,
            origin: crate::state::Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            mode: ParticlesMode::D2,
            emitting: true,
            amount: 4,
            one_shot: false,
            fixed_fps: 0,
            interpolate: false,
            fractional_delta: false,
            local: false,
            draw_order: crate::state::ParticlesDrawOrder::Index,
            transform_align: crate::state::ParticlesTransformAlign::Disabled,
            trails: false,
            trail_poses: 0,
            seed: 7,
            restarts: 0,
            emits: 0,
            process_requests: 0,
            process_material: Some(material),
            draw_passes: Vec::new(),
            subemitter: None,
            floats: None,
        }
    }

    fn process_shader(id: Id, hash: crate::state::Hash) -> crate::state::Shader {
        crate::state::Shader {
            id,
            origin: crate::state::Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            mode: Some(crate::state::ShaderMode::Particles),
            source: Some(crate::state::ShaderSource::Payload),
            hash: Some(hash),
            payload_bytes: 64,
            builtin: None,
            process: Some(base()),
            uses: Vec::new(),
            default_textures: Vec::new(),
        }
    }

    fn process_material(id: Id, shader: Id, params: Vec<Param>) -> crate::state::Material {
        crate::state::Material {
            id,
            origin: crate::state::Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            shader: Some(shader),
            params,
        }
    }

    #[test]
    fn curve_sidecar_matches_decimal_f32_bits_and_late_arrival() {
        use crate::apply::payloads::{PayloadStore, TexturePixels};
        use crate::state::{Hash, Origin, Texture, TextureKind};
        let hash = Hash([0x63; 32]);
        let mut s = ResolvedState::empty(12);
        s.particles.insert(1, emitter(1, 20));
        s.shaders.insert(30, process_shader(30, Hash([0x62; 32])));
        s.materials.insert(20, process_material(20, 30, vec![
            param("scale_curve", VariantType::Rid, ParamValue::Tex(40)),
            param("precise_uniform", VariantType::Float, ParamValue::Scalar(1.0000000000000002)),
        ]));
        s.textures.insert(40, Texture {
            id: 40, origin: Origin::Created, adopted_content: None, kind: TextureKind::Image,
            status: EntryStatus::Ok, reason: None, version: 1, hash: Some(hash),
            format: Some("RGBAF".into()), source_format: None, width: 2, height: 1,
            mipmaps: false, payload_bytes: 32, variants: Vec::new(), size_override: None,
            viewport: None, target: None, canvas: None,
        });
        let mut old = PayloadStore::default();
        let mut side = PayloadStore::default();
        let mut arena = vec![99.0];
        // Emitter precedes its curve hash. The first sync still carries the emitter.
        let initial = describe_with_curves(&s, &mut side, false, false, &mut arena);
        assert!(initial.contains("\"emitters\":[{\"id\":1"));
        assert!(arena.is_empty());
        assert_eq!(initial, describe(&s, &mut old, false, false));
        let values = vec![-0.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY,
            f32::from_bits(1), f32::MAX, -0.12345679, 1.0];
        let pixels = TexturePixels {
            width: 2, height: 1, rgba: std::sync::Arc::new(Vec::new()), compressed: None,
            half: None, floats: Some(values.clone()), opacity: None, format: "RGBAF".into(),
            mipmaps: false, data_len: 32,
        };
        for store in [&mut old, &mut side] { store.textures.insert(hash, pixels.clone()); }
        let legacy: serde_json::Value = serde_json::from_str(&describe(&s, &mut old, false, false)).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(
            &describe_with_curves(&s, &mut side, false, false, &mut arena)).unwrap();
        assert_eq!(metadata["emitters"].as_array().unwrap().len(), 0, "late material only");
        let curve = &metadata["materials"][0]["curves"]["scale_curve"];
        assert_eq!(curve["offset"], 0);
        assert_eq!(curve["length"], 8);
        assert!(curve.get("data").is_none());
        let expected: Vec<u32> = legacy["materials"][0]["curves"]["scale_curve"]["data"]
            .as_array().unwrap().iter().map(|v| (v.as_f64().unwrap() as f32).to_bits()).collect();
        assert_eq!(arena.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), expected);
        assert_eq!(arena[0].to_bits(), (-0.0f32).to_bits());
        assert_eq!(&expected[1..4], &[0, 0, 0]);
        assert_eq!(metadata["materials"][0]["uniforms"], legacy["materials"][0]["uniforms"]);
        assert_eq!(metadata["materials"][0]["uniforms"]["precise_uniform"].as_f64(), Some(1.0000000000000002));
        assert_eq!(describe_with_curves(&s, &mut side, false, false, &mut arena), "");
        assert!(arena.is_empty(), "unchanged sync must not retain old curve output");
        // A restart only sends the changed emitter; a reconnect resends its complete material.
        s.particles.get_mut(&1).unwrap().version += 1;
        s.particles.get_mut(&1).unwrap().restarts += 1;
        let restarted = describe_with_curves(&s, &mut side, false, false, &mut arena);
        assert!(restarted.contains("\"restarts\":1"));
        assert!(arena.is_empty());
        side.particles = Default::default();
        describe_with_curves(&s, &mut side, false, false, &mut arena);
        assert_eq!(arena.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), expected);
    }

    #[test]
    fn curve_half_and_byte_decoding_preserves_bits() {
        use crate::apply::payloads::TexturePixels;
        let mut px = TexturePixels {
            width: 1, height: 1, rgba: std::sync::Arc::new(vec![0, 1, 128, 255]),
            compressed: None, half: None, floats: None, opacity: None,
            format: "RGBA8".into(), mipmaps: false, data_len: 4,
        };
        let mut out = Vec::new();
        append_curve(&px, &mut out);
        assert_eq!(out, vec![0.0, 1.0f32 / 255.0, 128.0f32 / 255.0, 1.0]);
        px.half = Some(std::sync::Arc::new(vec![0, 128, 0, 124, 1, 0, 0, 60]));
        out.clear();
        append_curve(&px, &mut out);
        assert_eq!(out.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            vec![(-0.0f32).to_bits(), 0, (2.0f32.powi(-24)).to_bits(), 1.0f32.to_bits()]);
    }

    /// Emitter 1 keys from a uniform-switched process shader whose code is not held, emitter 2
    /// from a stock one: only emitter 1 is suspended (no buffer, `set` ignored, its material
    /// listed `suspended`), and once the code arrives its material is listed again with its key.
    #[test]
    fn a_process_shader_not_held_suspends_only_its_emitters() {
        let code = crate::state::Hash([0x61; 32]);
        let stock_code = crate::state::Hash([0x62; 32]);
        let mut s = ResolvedState::empty(12);
        s.shaders.insert(30, process_shader(30, code));
        s.shaders.insert(31, process_shader(31, stock_code));
        let switched = vec![param("emission_shape", VariantType::Int, ParamValue::Scalar(1.0))];
        s.materials.insert(20, process_material(20, 30, switched));
        s.materials.insert(21, process_material(21, 31, Vec::new()));
        s.particles.insert(1, emitter(1, 20));
        s.particles.insert(2, emitter(2, 21));
        assert_eq!(switch_candidate_shader_hashes(&s), vec![code]);
        let mut store = crate::apply::payloads::PayloadStore::default();
        // Emitter 1 drew from an earlier simulation (its old output).
        store.particles.set(1, &[0.0; PT_INSTANCE_FLOATS]);
        let before = store.particles.membership;
        let msg = describe(&s, &mut store, false, false);
        assert_eq!(store.particles.suspended(), &[1]);
        assert!(store.particles.get(1).is_none(), "the old simulated output survived");
        assert!(store.particles.membership > before, "the drop did not re-lower its draws");
        assert!(msg.contains("{\"id\":20,\"version\":1,\"suspended\":true,"), "{msg}");
        assert!(!msg.contains("{\"id\":21,\"version\":1,\"suspended\""), "{msg}");
        store.particles.set(1, &[0.0; PT_INSTANCE_FLOATS]);
        store.particles.set(2, &[0.0; PT_INSTANCE_FLOATS]);
        assert!(store.particles.get(1).is_none(), "a suspended emitter took a buffer");
        assert!(store.particles.get(2).is_some(), "the other emitter was suspended");
        assert_eq!(describe(&s, &mut store, false, false), "", "nothing changed");
        // The code arrives: nothing is suspended, and material 20 is listed again, keyed.
        store
            .shaders
            .insert(code, "shader_type particles;\nuniform int emission_shape;\n".into());
        let msg = describe(&s, &mut store, false, false);
        assert!(store.particles.suspended().is_empty());
        assert!(msg.contains("{\"id\":20,\"version\":1,\"builtin\":{\"emission_shape\":\"sphere\""), "{msg}");
        store.particles.set(1, &[0.0; PT_INSTANCE_FLOATS]);
        assert!(store.particles.get(1).is_some());
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
