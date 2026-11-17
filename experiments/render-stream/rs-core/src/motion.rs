//! Per-transaction motion facts: how far the visible content of one accepted transaction moved,
//! in presentation pixels, and whether anything changed other than geometry and colour. A client
//! that lowers its presentation rate while nothing happens (render-stream-client's `frameCap`)
//! reads them to tell ambient motion (a background drifting by hundredths of a pixel, an idle
//! skeletal pose, a slow colour pulse) from a real change. Damage area cannot tell the two apart:
//! a full-screen layer drifting by a fraction of a pixel damages the whole screen every frame.
//!
//! The facts are computed from the validator's undo log (the previous entry of every item, canvas
//! and resource the transaction changed) and from the dynamic mesh bodies it replaced, so the cost
//! is O(changed), and nothing here reads or changes the applier. Every bound is conservative: a
//! measure that cannot be made (a singular transform, a body of another vertex count, a command
//! list of another shape, content a sub-viewport draws) reports a change or an infinite
//! displacement, never a small one.

use crate::apply::geom::{self, Xform};
use crate::apply::payloads::MeshGeometry;
use crate::state::{
    Canvas, Command, Commands, Id, Item, Mesh, Parent, ParentKind, ResolvedState, Span,
    ViewportSurface,
};

/// `TxMotion::changes` bits.
pub struct Change;
impl Change {
    /// A full transaction (a session's first, a resync's): everything is new.
    pub const FULL: u32 = 1;
    /// An item or canvas added or removed, reparented, reordered (children, draw index, z,
    /// layer) or moved to another visibility layer.
    pub const STRUCTURE: u32 = 2;
    /// An item shown or hidden.
    pub const VISIBILITY: u32 = 4;
    /// An item's commands changed in something other than positions and colours (another op,
    /// texture, source region, UVs, element count: new text, a sprite frame, a new shape).
    pub const CONTENT: u32 = 8;
    /// An item's drawing state other than transform and modulate changed (material, its
    /// parameters, clip, filter, repeat, canvas group, back-buffer copy).
    pub const APPEARANCE: u32 = 16;
    /// A texture, shader, material, multimesh or particles entry, a static mesh, a dynamic mesh's
    /// shape, or the default filter/repeat changed.
    pub const RESOURCE: u32 = 32;
    /// A dynamic mesh body drawn by a visible item that cannot be measured as motion: another
    /// vertex count, no previous body, other UVs or indices (an attachment swap, a draw-order
    /// change), or drawn through a multimesh or particles entry.
    pub const RESHAPE: u32 = 64;
    /// Content a sub-viewport draws changed (an item or canvas of a canvas a /16 viewport
    /// renders): it reaches the screen through that viewport's texture, at a scale the measure
    /// does not follow.
    pub const VIEWPORT: u32 = 128;
}

/// One transaction's facts.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TxMotion {
    /// `Change` bits.
    pub changes: u32,
    /// The largest displacement of a changed visible item's content, in presentation px (the
    /// root viewport's pixels): a bound, never an underestimate; `f32::INFINITY` when unbounded.
    pub max_px: f32,
    /// The largest step of one modulate or colour channel (0..1 straight), over the changed
    /// visible items, their commands and the canvases.
    pub color_step: f32,
}

impl TxMotion {
    pub fn clear(&mut self) {
        *self = TxMotion::default();
    }

    fn moved(&mut self, px: f32) {
        // A NaN (a degenerate transform) is unbounded.
        let px = if px.is_nan() { f32::INFINITY } else { px };
        if px > self.max_px {
            self.max_px = px;
        }
    }

    fn color(&mut self, step: f32) {
        let step = if step.is_nan() { 1.0 } else { step };
        if step > self.color_step {
            self.color_step = step;
        }
    }
}

/// What the measure needs of the viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionParams {
    /// The transform applied before every canvas transform (the stretch).
    pub global: Xform,
    /// The root viewport's size in presentation px. A change of an entity's linear part moves a
    /// visible point by at most the change (conjugated to the screen) times that point's distance
    /// from the entity's origin on screen, which the farthest corner of this rect bounds.
    pub size: [f32; 2],
}

type Lin = [f32; 4];

fn lin(x: &Xform) -> Lin {
    [x[0], x[1], x[2], x[3]]
}

/// `a * b` of two 2x2 linear parts (columns `x.x, x.y, y.x, y.y`).
fn lin_mul(a: &Lin, b: &Lin) -> Lin {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
    ]
}

fn lin_apply(a: &Lin, v: [f32; 2]) -> [f32; 2] {
    [a[0] * v[0] + a[2] * v[1], a[1] * v[0] + a[3] * v[1]]
}

/// The spectral norm (largest singular value) of a 2x2 linear part.
fn spectral(m: &Lin) -> f32 {
    let t = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
    let d = m[0] * m[3] - m[2] * m[1];
    let disc = (t * t - 4.0 * d * d).max(0.0);
    ((t + disc.sqrt()) * 0.5).max(0.0).sqrt()
}

fn lin_inv(m: &Lin) -> Option<Lin> {
    let det = m[0] * m[3] - m[2] * m[1];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    Some([m[3] / det, -m[1] / det, -m[2] / det, m[0] / det])
}

fn lin_sub(a: &Lin, b: &Lin) -> Lin {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]]
}

fn hypot(dx: f32, dy: f32) -> f32 {
    (dx * dx + dy * dy).sqrt()
}

/// The distance from `o` (presentation px) to the farthest corner of the viewport: how far a
/// visible point can be from `o`.
fn corner_reach(o: [f32; 2], p: &MotionParams) -> f32 {
    let dx = o[0].abs().max((p.size[0] - o[0]).abs());
    let dy = o[1].abs().max((p.size[1] - o[1]).abs());
    hypot(dx, dy)
}

/// The transform from the viewport down to (and including) `parent`, and the canvas the chain
/// ends at: what maps a point of the child's parent space to presentation px. A chain that does
/// not resolve (a dangling id, a cycle past 256 levels) ends where it stops.
pub fn parent_xform(
    st: &ResolvedState,
    p: &MotionParams,
    parent: Option<Parent>,
) -> (Xform, Option<Id>) {
    let mut acc: Xform = geom::IDENTITY;
    let mut cur = parent;
    let mut canvas = None;
    for _ in 0..256 {
        let Some(pa) = cur else { break };
        match pa.kind {
            ParentKind::Item => {
                let Some(it) = st.items.get(&pa.id) else {
                    break;
                };
                acc = geom::mul(&it.xform, &acc);
                cur = it.parent;
            }
            ParentKind::Canvas => {
                if let Some(c) = st.canvases.get(&pa.id) {
                    acc = geom::mul(&c.xform, &acc);
                }
                canvas = Some(pa.id);
                break;
            }
        }
    }
    (geom::mul(&p.global, &acc), canvas)
}

/// Whether a /16 viewport renders the canvas `canvas` (its content also reaches the screen through
/// that viewport's texture). One branch below /16.
pub fn in_sub_viewport(st: &ResolvedState, canvas: Option<Id>) -> bool {
    let Some(c) = canvas else { return false };
    !st.viewports.is_empty()
        && st
            .viewports
            .values()
            .any(|v| v.canvases.binary_search_by(|r| r.canvas.cmp(&c)).is_ok())
}

/// The displacement, in presentation px, of what an entity with transform `old` → `new` draws,
/// `parent` mapping its parent space to presentation px. `extent`: how far from its origin (in its
/// own space) its content reaches, when known (a leaf item's own commands). Otherwise a point
/// visible before or after moves by at most the conjugated change `‖P·dA·A⁻¹·P⁻¹‖` (with `A` the
/// side it is visible on) times its distance from that side's origin on screen.
fn change_px(
    parent: &Xform,
    old: &Xform,
    new: &Xform,
    extent: Option<f32>,
    p: &MotionParams,
) -> f32 {
    let pl = lin(parent);
    let dt = lin_apply(&pl, [new[4] - old[4], new[5] - old[5]]);
    let mut px = hypot(dt[0], dt[1]);
    let (lo, ln) = (lin(old), lin(new));
    if lo != ln {
        let d = lin_sub(&ln, &lo);
        px += match extent {
            Some(r) => spectral(&lin_mul(&pl, &d)) * r,
            None => {
                let side = |a: &Lin, x: &Xform| -> f32 {
                    let (Some(ai), Some(pi)) = (lin_inv(a), lin_inv(&pl)) else {
                        return f32::INFINITY;
                    };
                    let conj = lin_mul(&pl, &lin_mul(&d, &lin_mul(&ai, &pi)));
                    spectral(&conj) * corner_reach(geom::xform_point(parent, [x[4], x[5]]), p)
                };
                side(&lo, old).max(side(&ln, new))
            }
        };
    }
    px
}

fn color_step(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let mut m = 0.0f32;
    for k in 0..4 {
        m = m.max((a[k] - b[k]).abs());
    }
    m
}

/// One item of the transaction's undo log: `old` the entry before it, `new` the resolved one,
/// `commands_sent` whether the transaction carried the item's command list (else the old list
/// moved into the new entry unchanged and `old` holds none).
pub fn item(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    old: Option<&Item>,
    new: Option<&Item>,
    commands_sent: bool,
) {
    let (o, n) = match (old, new) {
        (None, None) => return,
        (None, Some(_)) | (Some(_), None) => {
            out.changes |= Change::STRUCTURE;
            return;
        }
        (Some(o), Some(n)) => (o, n),
    };
    // Nothing of a hidden item is drawn, before or after.
    if !o.visible && !n.visible {
        return;
    }
    let (parent, canvas) = parent_xform(st, p, n.parent);
    // A logged entry differs from the old one: drawn through a sub-viewport, any change wakes.
    if in_sub_viewport(st, canvas) {
        out.changes |= Change::VIEWPORT;
        return;
    }
    if o.visible != n.visible {
        out.changes |= Change::VISIBILITY;
    }
    if o.parent != n.parent
        || o.children != n.children
        || o.draw_index != n.draw_index
        || o.z_index != n.z_index
        || o.z_relative != n.z_relative
        || o.behind != n.behind
        || o.visibility_layer != n.visibility_layer
    {
        out.changes |= Change::STRUCTURE;
    }
    if o.clip != n.clip
        || o.custom_rect != n.custom_rect
        || o.texture_filter != n.texture_filter
        || o.texture_repeat != n.texture_repeat
        || o.material != n.material
        || o.use_parent_material != n.use_parent_material
        || o.instance_params != n.instance_params
        || o.canvas_group != n.canvas_group
        || o.copy_to_backbuffer != n.copy_to_backbuffer
        || o.use_identity_transform != n.use_identity_transform
    {
        out.changes |= Change::APPEARANCE;
    }
    // A custom rect is the clip rect of a clipping item and the own rect of a canvas group (or a
    // back-buffer copy): a change of it changes what is drawn. Otherwise it only culls, and its
    // edges moving is motion of the content's bounds.
    let rect_moved = n.custom_rect && o.custom_rect_rect != n.custom_rect_rect;
    if rect_moved
        && (o.clip
            || n.clip
            || o.canvas_group.is_some()
            || n.canvas_group.is_some()
            || o.copy_to_backbuffer.is_some()
            || n.copy_to_backbuffer.is_some())
    {
        out.changes |= Change::APPEARANCE;
    }
    out.color(color_step(&o.modulate, &n.modulate));
    out.color(color_step(&o.self_modulate, &n.self_modulate));
    let moved_xform = o.xform != n.xform;
    let cmds = if commands_sent {
        match commands_delta(&o.commands, &n.commands) {
            Some(d) => Some(d),
            None => {
                out.changes |= Change::CONTENT;
                None
            }
        }
    } else {
        None
    };
    if let Some(d) = &cmds {
        out.color(d.color);
    }
    let moved_cmds = cmds
        .as_ref()
        .is_some_and(|d| d.px > 0.0 || !d.xforms.is_empty());
    if !moved_xform && !moved_cmds && !rect_moved {
        return;
    }
    if moved_xform {
        let extent = if n.children.is_empty() {
            commands_extent(&n.commands)
        } else {
            None
        };
        out.moved(change_px(&parent, &o.xform, &n.xform, extent, p));
    }
    let g = geom::mul(&parent, &n.xform);
    let gs = spectral(&lin(&g));
    if rect_moved {
        out.moved(rect_delta(&o.custom_rect_rect, &n.custom_rect_rect) * gs);
    }
    if let Some(d) = cmds.filter(|_| moved_cmds) {
        out.moved(d.px * gs);
        for (a, b) in &d.xforms {
            out.moved(change_px(&g, a, b, None, p));
        }
    }
}

/// One canvas of the transaction's undo log.
pub fn canvas(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    old: Option<&Canvas>,
    new: Option<&Canvas>,
) {
    let (o, n) = match (old, new) {
        (None, None) => return,
        (Some(o), Some(n)) => (o, n),
        _ => {
            out.changes |= Change::STRUCTURE;
            return;
        }
    };
    if in_sub_viewport(st, Some(n.id)) {
        out.changes |= Change::VIEWPORT;
        return;
    }
    if o.root != n.root
        || o.attached != n.attached
        || o.layer != n.layer
        || o.sublayer != n.sublayer
        || o.items != n.items
    {
        out.changes |= Change::STRUCTURE;
    }
    out.color(color_step(&o.modulate, &n.modulate));
    if o.xform != n.xform {
        out.moved(change_px(&p.global, &o.xform, &n.xform, None, p));
    }
}

/// One /16 viewport entry of the transaction's undo log: added or removed is a structural change,
/// any other change (size, update mode, clear, canvases, transforms) one of appearance.
pub fn viewport(out: &mut TxMotion, old: Option<&ViewportSurface>, new: Option<&ViewportSurface>) {
    match (old, new) {
        (None, None) => {}
        (Some(o), Some(n)) => {
            if o != n {
                out.changes |= Change::APPEARANCE;
            }
        }
        _ => out.changes |= Change::STRUCTURE,
    }
}

/// One mesh entry of the transaction's undo log. A dynamic mesh whose surfaces keep their shape
/// (primitive, format, counts) changed only its body, whose displacement `dynamic_mesh` measures;
/// any other mesh change is a resource change.
pub fn mesh(out: &mut TxMotion, old: Option<&Mesh>, new: Option<&Mesh>) {
    if let (Some(o), Some(n)) = (old, new) {
        let same_shape = o.is_dynamic()
            && n.is_dynamic()
            && o.status == n.status
            && o.surfaces.len() == n.surfaces.len()
            && o.surfaces.iter().zip(&n.surfaces).all(|(a, b)| {
                a.hash.is_none()
                    && b.hash.is_none()
                    && a.primitive == b.primitive
                    && a.format == b.format
                    && a.vertex_count == b.vertex_count
                    && a.index_count == b.index_count
            });
        if same_shape {
            return;
        }
    }
    out.changes |= Change::RESOURCE;
}

/// The largest displacement between two bodies' positions (in the mesh's own space), or infinity
/// when their vertex counts differ.
pub fn positions_delta(old: &[[f32; 2]], new: &[[f32; 2]]) -> f32 {
    if old.len() != new.len() {
        return f32::INFINITY;
    }
    let mut m = 0.0f32;
    for (a, b) in old.iter().zip(new) {
        m = m.max(hypot(b[0] - a[0], b[1] - a[1]));
    }
    m
}

/// How one dynamic mesh body differs from the one it replaced.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodyDelta {
    /// The largest vertex displacement in the mesh's own space.
    pub px: f32,
    /// The largest vertex colour channel step (0..1).
    pub color: f32,
    /// Not comparable as motion: no previous body, another vertex count, or other UVs, indices or
    /// colour presence (an attachment swap, a draw-order change).
    pub reshaped: bool,
}

impl BodyDelta {
    /// A body with no previous one to compare.
    pub const NEW: BodyDelta = BodyDelta {
        px: 0.0,
        color: 0.0,
        reshaped: true,
    };

    pub fn is_zero(&self) -> bool {
        self.px == 0.0 && self.color == 0.0 && !self.reshaped
    }
}

/// How a dynamic body `new` differs from `old` (`DynamicMeshes::ingest`'s measure).
pub fn body_delta(old: &MeshGeometry, new: &MeshGeometry) -> BodyDelta {
    if old.positions.len() != new.positions.len()
        || old.primitive != new.primitive
        || old.uvs != new.uvs
        || old.indices != new.indices
    {
        return BodyDelta::NEW;
    }
    let color = match (&old.colors, &new.colors) {
        (None, None) => 0.0,
        (Some(a), Some(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .fold(0.0f32, |m, (x, y)| m.max(color_step(x, y))),
        _ => return BodyDelta::NEW,
    };
    BodyDelta {
        px: positions_delta(&old.positions, &new.positions),
        color,
        reshaped: false,
    }
}

/// Whether a multimesh or particles entry draws the mesh `mesh` (through instances the measure
/// does not follow).
pub fn mesh_drawn_indirectly(st: &ResolvedState, mesh: Id) -> bool {
    st.multimeshes.values().any(|m| m.mesh == Some(mesh))
        || st
            .particles
            .values()
            .any(|e| e.draw_passes.contains(&Some(mesh)))
}

/// A dynamic mesh body that changed by `d` (`body_delta`), drawn by the items `users` (its
/// `add_mesh` users): its displacement on screen is the largest over its visible users, through
/// each one's transform, the `add_set_transform` in effect and its `add_mesh` transform; its
/// colour step counts as is. A body that cannot be measured (`reshaped`), or one a multimesh or
/// particles entry draws, is a change; one a sub-viewport draws is too.
pub fn dynamic_mesh(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    mesh: Id,
    d: BodyDelta,
    users: impl Iterator<Item = Id>,
) {
    if d.is_zero() {
        return;
    }
    if mesh_drawn_indirectly(st, mesh) {
        out.changes |= Change::RESHAPE;
        return;
    }
    for id in users {
        let Some(it) = st.items.get(&id) else {
            continue;
        };
        if !it.visible {
            continue;
        }
        let (parent, canvas) = parent_xform(st, p, it.parent);
        if in_sub_viewport(st, canvas) {
            out.changes |= Change::VIEWPORT;
            continue;
        }
        if d.reshaped || !d.px.is_finite() {
            out.changes |= Change::RESHAPE;
            continue;
        }
        out.color(d.color);
        let g = lin(&geom::mul(&parent, &it.xform));
        let mut scale = 0.0f32;
        let mut set = lin(&geom::IDENTITY);
        for c in &it.commands.list {
            match c {
                Command::SetTransform { transform } => set = lin(transform),
                Command::Mesh {
                    mesh: m, transform, ..
                } if *m == mesh => {
                    let t = lin_mul(&set, &lin(transform));
                    scale = scale.max(spectral(&lin_mul(&g, &t)));
                }
                _ => {}
            }
        }
        out.moved(d.px * scale);
    }
}

fn rect_delta(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    hypot(b[0] - a[0], b[1] - a[1]).max(hypot(b[0] + b[2] - a[0] - a[2], b[1] + b[3] - a[1] - a[3]))
}

/// `commands_delta`'s answer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CmdDelta {
    /// The largest displacement of a position in the item's own space, through the
    /// `add_set_transform` in effect.
    pub px: f32,
    /// The largest colour step.
    pub color: f32,
    /// Every changed `add_set_transform`, and every `add_mesh` whose effective transform (the set
    /// transform, then its own) changed, as (old, new) in the item's space: the caller bounds what
    /// each moves on screen. Empty (no allocation) in the common case.
    pub xforms: Vec<(Xform, Xform)>,
}

/// How far two command lists of the same shape differ in geometry and colour only, or `None`
/// when they differ in anything else: another length, op, texture, flag, source region, UVs,
/// indices or element count.
pub fn commands_delta(o: &Commands, n: &Commands) -> Option<CmdDelta> {
    if o.list.len() != n.list.len() {
        return None;
    }
    let mut d = CmdDelta::default();
    let rect = |a: &[f32; 4], b: &[f32; 4]| -> f32 {
        hypot(b[0] - a[0], b[1] - a[1])
            .max(hypot(b[0] + b[2] - a[0] - a[2], b[1] + b[3] - a[1] - a[3]))
    };
    let pts = |a: Span, b: Span| -> Option<f32> {
        if a.len != b.len {
            return None;
        }
        Some(positions_delta_flat(o.pairs(a), n.pairs(b)))
    };
    let cols = |a: Span, b: Span| -> Option<f32> {
        if a.len != b.len {
            return None;
        }
        let (x, y) = (o.quads(a), n.quads(b));
        Some(
            x.iter()
                .zip(y)
                .fold(0.0f32, |m, (p, q)| m.max((q - p).abs())),
        )
    };
    let same_pairs = |a: Span, b: Span| a.len == b.len && o.pairs(a) == n.pairs(b);
    let same_ints = |a: Span, b: Span| a.len == b.len && o.ints(a) == n.ints(b);
    // The `add_set_transform` in effect on each side (Godot's set transform replaces, never
    // composes).
    let (mut set_o, mut set_n) = (geom::IDENTITY, geom::IDENTITY);
    for (a, b) in o.list.iter().zip(&n.list) {
        match (a, b) {
            (Command::SetTransform { transform }, Command::SetTransform { transform: x1 }) => {
                set_o = *transform;
                set_n = *x1;
                if set_o != set_n {
                    d.xforms.push((set_o, set_n));
                }
                continue;
            }
            (
                Command::Mesh {
                    mesh,
                    tex,
                    transform,
                    modulate,
                },
                Command::Mesh {
                    mesh: m1,
                    tex: t1,
                    transform: x1,
                    modulate: c1,
                },
            ) if mesh == m1 && tex == t1 => {
                let (eo, en) = (geom::mul(&set_o, transform), geom::mul(&set_n, x1));
                if eo != en {
                    d.xforms.push((eo, en));
                }
                d.color = d.color.max(color_step(modulate, c1));
                continue;
            }
            _ => {}
        }
        let (px, _rel, color) = match (a, b) {
            (
                Command::Rect {
                    aa,
                    rect: r0,
                    color: c0,
                },
                Command::Rect {
                    aa: aa1,
                    rect: r1,
                    color: c1,
                },
            ) if aa == aa1 => (rect(r0, r1), 0.0, color_step(c0, c1)),
            (
                Command::TextureRect {
                    tex,
                    tile,
                    transpose,
                    rect: r0,
                    modulate: m0,
                },
                Command::TextureRect {
                    tex: t1,
                    tile: ti1,
                    transpose: tr1,
                    rect: r1,
                    modulate: m1,
                },
            ) if tex == t1 && tile == ti1 && transpose == tr1 => {
                (rect(r0, r1), 0.0, color_step(m0, m1))
            }
            (
                Command::TextureRectRegion {
                    tex,
                    transpose,
                    clip_uv,
                    rect: r0,
                    src,
                    modulate: m0,
                },
                Command::TextureRectRegion {
                    tex: t1,
                    transpose: tr1,
                    clip_uv: cu1,
                    rect: r1,
                    src: s1,
                    modulate: m1,
                },
            ) if tex == t1 && transpose == tr1 && clip_uv == cu1 && src == s1 => {
                (rect(r0, r1), 0.0, color_step(m0, m1))
            }
            (
                Command::MsdfTextureRectRegion {
                    tex,
                    outline,
                    rect: r0,
                    src,
                    modulate: m0,
                    px_range,
                    scale,
                },
                Command::MsdfTextureRectRegion {
                    tex: t1,
                    outline: o1,
                    rect: r1,
                    src: s1,
                    modulate: m1,
                    px_range: p1,
                    scale: sc1,
                },
            ) if tex == t1 && outline == o1 && src == s1 && px_range == p1 && scale == sc1 => {
                (rect(r0, r1), 0.0, color_step(m0, m1))
            }
            (
                Command::Line {
                    aa,
                    from,
                    to,
                    colour,
                    width,
                },
                Command::Line {
                    aa: aa1,
                    from: f1,
                    to: t1,
                    colour: c1,
                    width: w1,
                },
            ) if aa == aa1 => (
                hypot(f1[0] - from[0], f1[1] - from[1]).max(hypot(t1[0] - to[0], t1[1] - to[1]))
                    + (w1 - width).abs() * 0.5,
                0.0,
                color_step(colour, c1),
            ),
            (
                Command::Polyline {
                    aa,
                    width,
                    points,
                    colors,
                },
                Command::Polyline {
                    aa: aa1,
                    width: w1,
                    points: p1,
                    colors: c1,
                },
            )
            | (
                Command::Multiline {
                    aa,
                    width,
                    points,
                    colors,
                },
                Command::Multiline {
                    aa: aa1,
                    width: w1,
                    points: p1,
                    colors: c1,
                },
            ) if aa == aa1 => (
                pts(*points, *p1)? + (w1 - width).abs() * 0.5,
                0.0,
                cols(*colors, *c1)?,
            ),
            (
                Command::Circle {
                    aa,
                    position,
                    radius,
                    colour,
                },
                Command::Circle {
                    aa: aa1,
                    position: p1,
                    radius: r1,
                    colour: c1,
                },
            ) if aa == aa1 => (
                hypot(p1[0] - position[0], p1[1] - position[1]) + (r1 - radius).abs(),
                0.0,
                color_step(colour, c1),
            ),
            (
                Command::Primitive {
                    tex,
                    points,
                    colors,
                    uvs,
                },
                Command::Primitive {
                    tex: t1,
                    points: p1,
                    colors: c1,
                    uvs: u1,
                },
            )
            | (
                Command::Polygon {
                    tex,
                    points,
                    colors,
                    uvs,
                },
                Command::Polygon {
                    tex: t1,
                    points: p1,
                    colors: c1,
                    uvs: u1,
                },
            ) if tex == t1 && same_pairs(*uvs, *u1) => {
                (pts(*points, *p1)?, 0.0, cols(*colors, *c1)?)
            }
            (
                Command::TriangleArray {
                    tex,
                    count,
                    points,
                    colors,
                    uvs,
                    indices,
                },
                Command::TriangleArray {
                    tex: t1,
                    count: n1,
                    points: p1,
                    colors: c1,
                    uvs: u1,
                    indices: i1,
                },
            ) if tex == t1 && count == n1 && same_pairs(*uvs, *u1) && same_ints(*indices, *i1) => {
                (pts(*points, *p1)?, 0.0, cols(*colors, *c1)?)
            }
            (
                Command::NinePatch {
                    tex,
                    rect: r0,
                    source,
                    margins,
                    x_axis,
                    y_axis,
                    draw_center,
                    modulate,
                },
                Command::NinePatch {
                    tex: t1,
                    rect: r1,
                    source: s1,
                    margins: g1,
                    x_axis: x1,
                    y_axis: y1,
                    draw_center: dc1,
                    modulate: m1,
                },
            ) if tex == t1
                && source == s1
                && margins == g1
                && x_axis == x1
                && y_axis == y1
                && draw_center == dc1 =>
            {
                (rect(r0, r1), 0.0, color_step(modulate, m1))
            }
            (a, b) if a == b && is_floatless(a) => (0.0, 0.0, 0.0),
            _ => return None,
        };
        d.px = d.px.max(px * spectral(&lin(&set_n)));
        d.color = d.color.max(color);
    }
    Some(d)
}

/// Ops with no geometry: equal or a content change.
fn is_floatless(c: &Command) -> bool {
    matches!(
        c,
        Command::ClipIgnore { .. }
            | Command::Multimesh { .. }
            | Command::Particles { .. }
            | Command::Unsupported { .. }
    )
}

fn positions_delta_flat(a: &[f32], b: &[f32]) -> f32 {
    let mut m = 0.0f32;
    for (p, q) in a.chunks_exact(2).zip(b.chunks_exact(2)) {
        m = m.max(hypot(q[0] - p[0], q[1] - p[1]));
    }
    m
}

/// How far from the origin, in the item's own space, its own commands reach; `None` when a
/// command's reach is not in the list itself (a mesh, a multimesh, particles, a transform).
pub fn commands_extent(c: &Commands) -> Option<f32> {
    let mut r = 0.0f32;
    let mut point = |x: f32, y: f32| r = r.max(hypot(x, y));
    let rect = |q: &[f32; 4], point: &mut dyn FnMut(f32, f32)| {
        point(q[0], q[1]);
        point(q[0] + q[2], q[1]);
        point(q[0], q[1] + q[3]);
        point(q[0] + q[2], q[1] + q[3]);
    };
    for cmd in &c.list {
        match cmd {
            Command::Rect { rect: q, .. }
            | Command::TextureRect { rect: q, .. }
            | Command::TextureRectRegion { rect: q, .. }
            | Command::MsdfTextureRectRegion { rect: q, .. }
            | Command::NinePatch { rect: q, .. } => rect(q, &mut point),
            Command::Line {
                from, to, width, ..
            } => {
                point(from[0].abs() + width * 0.5, from[1].abs() + width * 0.5);
                point(to[0].abs() + width * 0.5, to[1].abs() + width * 0.5);
            }
            Command::Polyline { points, width, .. } | Command::Multiline { points, width, .. } => {
                for q in c.pairs(*points).chunks_exact(2) {
                    point(q[0].abs() + width * 0.5, q[1].abs() + width * 0.5);
                }
            }
            Command::Circle {
                position, radius, ..
            } => point(position[0].abs() + radius, position[1].abs() + radius),
            Command::Primitive { points, .. }
            | Command::Polygon { points, .. }
            | Command::TriangleArray { points, .. } => {
                for q in c.pairs(*points).chunks_exact(2) {
                    point(q[0], q[1]);
                }
            }
            Command::ClipIgnore { .. } | Command::Unsupported { .. } => {}
            Command::Mesh { .. }
            | Command::SetTransform { .. }
            | Command::Multimesh { .. }
            | Command::Particles { .. } => return None,
        }
    }
    Some(r)
}

#[cfg(test)]
#[path = "motion_tests.rs"]
mod tests;
