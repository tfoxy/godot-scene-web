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
    BlendMode, Canvas, Command, Commands, EntryStatus, Hash, Id, Item, Mesh, Multimesh,
    MultimeshFormat, ParamValue, Parent, ParentKind, Particles, ResolvedState, Span,
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
    /// A texture, shader or material entry, a multimesh's or emitter's configuration (anything
    /// but what `multimesh` and `particles` measure), a static mesh, a dynamic mesh's shape, or
    /// the default filter/repeat changed. An entry that differs in nothing but its `version` (a
    /// host call that set the value it already had) changes nothing drawn and is not counted.
    pub const RESOURCE: u32 = 32;
    /// A dynamic mesh body drawn by a visible item that cannot be measured as motion: another
    /// vertex count, no previous body, other UVs or indices (an attachment swap, a draw-order
    /// change), or drawn through a multimesh or particles entry. Also a multimesh instance buffer
    /// that cannot be measured: another length, no previous buffer, a 3D transform format, a mesh
    /// whose reach is unknown, or custom data that the drawing material reads.
    pub const RESHAPE: u32 = 64;
    /// Content a sub-viewport draws changed (an item or canvas of a canvas a /16 viewport
    /// renders): it reaches the screen through that viewport's texture, at a scale the measure
    /// does not follow.
    pub const VIEWPORT: u32 = 128;
    /// A multimesh instance buffer or a static mesh's geometry changed and has not been measured
    /// yet. The validator sets it for a multimesh whose entry changed only its buffer and for a
    /// static mesh that changed only its payloads (`mesh`); the receiver clears it once `ingested`
    /// has measured all of them. A receiver that does not measure them leaves it set, so an
    /// unmeasured change always wakes.
    pub const UNMEASURED: u32 = 256;
}

/// The intensity at or below which animation content counts as faint: at most this much of it
/// reaches a pixel (its alpha, or under an additive blend its alpha times its brightest channel),
/// where the material scales by alpha. Faint content that moves, however far (a particle that
/// dies faded out and respawns faded in at its emission point, a skeletal part parked
/// transparent), changes no pixel by more than this, so `dynamic_mesh` and `multimesh_buffer`
/// report it as a colour step of its intensity rather than a displacement. It is half of
/// render-stream-client's `IDLE_COLOR_STEP_MAX`.
pub const FAINT_ALPHA: f32 = 4.0 / 255.0;

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
    /// The same two measures over animation content, the host's per-frame animation systems
    /// rather than its scene: dynamic mesh bodies (skeletal deformation), multimesh instance
    /// buffers (CPU particles) and static mesh geometry swapped in place (a flipbook frame).
    /// A consumer bounds them separately: an idle skeleton sweeps parts by tens of pixels per
    /// frame while a UI element that moves a pixel is already a real change.
    pub anim_px: f32,
    pub anim_color: f32,
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

    fn anim_moved(&mut self, px: f32) {
        let px = if px.is_nan() { f32::INFINITY } else { px };
        if px > self.anim_px {
            self.anim_px = px;
        }
    }

    fn anim_color(&mut self, step: f32) {
        let step = if step.is_nan() { 1.0 } else { step };
        if step > self.anim_color {
            self.anim_color = step;
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
    // The item's own content draws with modulate times self_modulate; its children with its
    // modulate (times their own).
    let own =
        |it: &Item| -> [f32; 4] { std::array::from_fn(|k| it.modulate[k] * it.self_modulate[k]) };
    out.color(color_step(&own(o), &own(n)));
    if !o.children.is_empty() || !n.children.is_empty() {
        out.color(color_step(&o.modulate, &n.modulate));
    }
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
/// (primitive, format, counts) changed only its body, whose displacement `dynamic_mesh` measures.
/// A static mesh whose surfaces keep their shape but carry other payloads (geometry rebuilt with
/// the same layout, a flipbook frame) is measured the same way once the receiver holds both
/// payloads: it sets `UNMEASURED` and returns true, and the receiver compares the geometry of
/// the surface hashes it replaced (`ingested`; `MeshFrames` tells a frame the mesh showed
/// before). An entry that differs in nothing but its `version` changes nothing drawn. Any other
/// mesh change is a resource change.
pub fn mesh(out: &mut TxMotion, old: Option<&Mesh>, new: Option<&Mesh>) -> bool {
    if let (Some(o), Some(n)) = (old, new) {
        // Exhaustive, so a field added to `Mesh` must be placed here.
        let Mesh {
            id,
            origin,
            adopted_content,
            status,
            reason,
            version: _,
            custom_aabb,
            surfaces,
        } = n;
        let same_entry = *id == o.id
            && *origin == o.origin
            && *adopted_content == o.adopted_content
            && *status == o.status
            && *reason == o.reason;
        // A host call that set a value the mesh already had (a per-frame custom AABB, say)
        // advances the version alone: the same surfaces draw the same.
        if same_entry && *surfaces == o.surfaces {
            // The custom AABB alone: it is the item's rect for culling (`mesh_get_aabb`), and
            // nothing moved to bound it by.
            if *custom_aabb != o.custom_aabb {
                out.changes |= Change::RESOURCE;
            }
            return false;
        }
        let same_layout = |dynamic: bool| {
            o.surfaces.len() == n.surfaces.len()
                && o.surfaces.iter().zip(&n.surfaces).all(|(a, b)| {
                    a.hash.is_none() == dynamic
                        && b.hash.is_none() == dynamic
                        && a.primitive == b.primitive
                        && a.format == b.format
                        && a.vertex_count == b.vertex_count
                        && a.index_count == b.index_count
                })
        };
        if o.is_dynamic() && n.is_dynamic() && o.status == n.status && same_layout(true) {
            return false;
        }
        // A custom AABB that moves with them is `mesh_bounds`'s to measure.
        if same_entry && *status == EntryStatus::Ok && !n.surfaces.is_empty() && same_layout(false)
        {
            out.changes |= Change::UNMEASURED;
            return true;
        }
    }
    out.changes |= Change::RESOURCE;
    false
}

/// A mesh whose custom AABB changed together with its surfaces (`mesh` measured those), drawn by
/// the items `users`. The AABB is each user's rect (`mesh_get_aabb` through the draw transform,
/// renderer_canvas_cull's `get_rect`): it culls the item, and sizes the copy of an item that clips,
/// groups or copies to the back buffer (and, under a canvas group owner, merges into the rect the
/// group copies and clips). Through a visible user that does one of those, its edges
/// moving count as animation motion; through any other, it changes what is drawn only when the
/// item stops or starts being culled (the rect meets the viewport on one side only), and then
/// counts the same. A custom AABB set or cleared (all zero) on one side cannot be bounded without
/// the geometry's own box and is a resource change.
pub fn mesh_bounds(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    old: &Mesh,
    new: &Mesh,
    users: impl Iterator<Item = Id>,
) {
    let (a, b) = (old.custom_aabb, new.custom_aabb);
    if a == b {
        return;
    }
    let unset = |x: &[f32; 6]| x.iter().all(|v| *v == 0.0);
    if unset(&a) != unset(&b) {
        out.changes |= Change::RESOURCE;
        return;
    }
    let (ra, rb) = ([a[0], a[1], a[3], a[4]], [b[0], b[1], b[3], b[4]]);
    let delta = rect_delta(&ra, &rb);
    let corners = |r: &[f32; 4], g: &Xform| {
        let g = *g;
        [
            [r[0], r[1]],
            [r[0] + r[2], r[1]],
            [r[0], r[1] + r[3]],
            [r[0] + r[2], r[1] + r[3]],
        ]
        .into_iter()
        .map(move |q| geom::xform_point(&g, q))
    };
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
        let sized = it.clip
            || it.canvas_group.is_some()
            || it.copy_to_backbuffer.is_some()
            || under_canvas_group(st, it);
        let item = geom::mul(&parent, &it.xform);
        let mut set = geom::IDENTITY;
        for c in &it.commands.list {
            match c {
                Command::SetTransform { transform } => set = *transform,
                Command::Mesh { mesh, .. } if *mesh == new.id => {
                    let g = geom::mul(&item, &set);
                    // The item culls by the union of its commands' rects; the others are the
                    // same on both sides, so the union flips only where this rect flips (and
                    // never while another meets the viewport): testing this rect alone may
                    // count a move that does not flip the union, never miss one that does.
                    let culling_flips =
                        meets_viewport(corners(&ra, &g), p) != meets_viewport(corners(&rb, &g), p);
                    if sized || culling_flips {
                        out.anim_moved(delta * spectral(&lin(&g)));
                    }
                }
                _ => {}
            }
        }
    }
}

/// Whether an ancestor of `it` owns a canvas group: every descendant's rect merges into the
/// owner's, which is what the group copies and clips (the applier's `under_group`).
fn under_canvas_group(st: &ResolvedState, it: &Item) -> bool {
    let mut p = it.parent;
    for _ in 0..256 {
        let Some(Parent {
            kind: ParentKind::Item,
            id,
        }) = p
        else {
            return false;
        };
        let Some(a) = st.items.get(&id) else {
            return false;
        };
        if a.canvas_group.is_some() {
            return true;
        }
        p = a.parent;
    }
    // A chain past 256 levels: assume a group.
    true
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

/// How one dynamic mesh body differs from the one it replaced, in the mesh's own space.
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

/// How a dynamic body `new` differs from `old`: whether it is comparable, and its largest
/// displacement and colour step over all vertices.
pub fn body_delta(old: &MeshGeometry, new: &MeshGeometry) -> BodyDelta {
    body_delta_frames(old, new, false)
}

/// `body_delta`; with `frame` (a flipbook frame the mesh showed before), other UVs are part of
/// the animation and do not make the bodies incomparable.
fn body_delta_frames(old: &MeshGeometry, new: &MeshGeometry, frame: bool) -> BodyDelta {
    if old.positions.len() != new.positions.len()
        || old.primitive != new.primitive
        || (!frame && old.uvs != new.uvs)
        || old.uvs.is_some() != new.uvs.is_some()
        || old.indices != new.indices
        || new
            .indices
            .as_ref()
            .is_some_and(|ix| ix.iter().any(|&k| k as usize >= new.positions.len()))
        || !same_unmeasured_bytes(old, new)
    {
        return BodyDelta::NEW;
    }
    let color = match (&old.colors, &new.colors) {
        (None, None) => 0.0,
        (Some(a), Some(b)) if a.len() == b.len() && a.len() == new.positions.len() => a
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

/// Whether two bodies agree in every byte the measure does not read: the same format, buffer
/// sizes and UV scale, the same skin buffer (bones and weights), the vertex buffer past the 2D
/// positions, and every attribute byte other than the colour and UV (`CUSTOM0` to `CUSTOM3`,
/// UV2, which a canvas_item shader's vertex function may read). A change there is not motion.
fn same_unmeasured_bytes(old: &MeshGeometry, new: &MeshGeometry) -> bool {
    use crate::apply::payloads::{ARRAY_FORMAT_COLOR, ARRAY_FORMAT_TEX_UV};
    let (a, b) = (&old.layout, &new.layout);
    if a.format != b.format
        || a.buffer_bytes != b.buffer_bytes
        || a.uv_scale_bits != b.uv_scale_bits
        || old.buffers[2] != new.buffers[2]
    {
        return false;
    }
    let n = new.positions.len();
    let (va, vb) = (&old.buffers[0], &new.buffers[0]);
    if va.get(8 * n..) != vb.get(8 * n..) {
        return false;
    }
    let (aa, ab) = (&old.buffers[1], &new.buffers[1]);
    let Some(stride) = ab.len().checked_div(n) else {
        return aa == ab;
    };
    let color = if b.format & ARRAY_FORMAT_COLOR != 0 {
        4
    } else {
        0
    };
    let uv = if b.format & ARRAY_FORMAT_TEX_UV != 0 {
        8
    } else {
        0
    };
    let read = color + uv;
    if stride <= read {
        // Nothing past the colour and UV, unless the buffer is not whole vertices.
        return stride * n == ab.len() || aa == ab;
    }
    aa.len() == ab.len()
        && stride * n == ab.len()
        && (0..n).all(|i| {
            aa[i * stride + read..(i + 1) * stride] == ab[i * stride + read..(i + 1) * stride]
        })
}

/// The largest channel step between two straight colours premultiplied by their alpha: what a
/// pixel receives from them under a blend that scales by alpha.
fn premul_step(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let mut m = (a[3] - b[3]).abs();
    for k in 0..3 {
        m = m.max((a[k] * a[3] - b[k] * b[3]).abs());
    }
    m
}

/// Calls `f` with the vertex indices of each primitive of a body (`indices`, or the vertices in
/// order), as Godot assembles them: triangles by three, strips by sliding windows, lines by two.
fn primitives(
    primitive: crate::state::Primitive,
    indices: Option<&[u32]>,
    n: usize,
    mut f: impl FnMut(&[usize]),
) {
    use crate::state::Primitive as P;
    let len = indices.map_or(n, |ix| ix.len());
    let (size, step) = match primitive {
        P::Points => (1, 1),
        P::Lines => (2, 2),
        P::LineStrip => (2, 1),
        P::Triangles => (3, 3),
        P::TriangleStrip => (3, 1),
    };
    let mut buf = [0usize; 3];
    let mut k = 0;
    while k + size <= len {
        for (j, b) in buf.iter_mut().enumerate().take(size) {
            *b = indices.map_or(k + j, |ix| ix[k + j] as usize);
        }
        f(&buf[..size]);
        k += step;
    }
}

/// Whether the screen-space box of `pts` meets the viewport.
fn meets_viewport(pts: impl Iterator<Item = [f32; 2]>, p: &MotionParams) -> bool {
    let (mut lo, mut hi) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
    for q in pts {
        for k in 0..2 {
            lo[k] = lo[k].min(q[k]);
            hi[k] = hi[k].max(q[k]);
        }
    }
    // A NaN coordinate fails every comparison: it counts as on screen.
    !(hi[0] < 0.0 || hi[1] < 0.0 || lo[0] > p.size[0] || lo[1] > p.size[1])
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

/// A dynamic mesh body `new` that replaced `old` (`None`: the surface held none), drawn by the
/// items `users` (its `add_mesh` users), measured as animation content (`anim_px`,
/// `anim_color`). Through each visible user (its transform, the `add_set_transform` in effect
/// and the `add_mesh` transform) every primitive is placed on screen before and after, and counts
/// only where it is shown: on screen (its box meets the viewport) and, where the material scales
/// by alpha, not faint (a vertex brighter than `FAINT_ALPHA`, after the command's and the item's
/// own modulate alpha). A primitive
///
/// - shown on neither side draws nothing visible wherever it goes (a faint one may still step
///   its colour by up to its opacity, which counts);
/// - shown on both: the screen displacement of its vertices, and their colour step
///   (premultiplied where the material scales by alpha, so a vertex that stays transparent shows
///   no colour change);
/// - shown on one side only (it moved on or off screen, or faded in or out within one
///   transaction): the smaller of its vertices' displacement and its on-screen size, half its
///   box's diagonal on the side it is shown (what appeared or vanished lies that close to one
///   point), and with a fade its colour step.
///
/// A body that cannot be compared (`body_delta` reshaped), or one a multimesh or particles entry
/// draws, is a change; one a sub-viewport draws is too.
pub fn dynamic_mesh(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    mesh: Id,
    old: Option<&MeshGeometry>,
    new: &MeshGeometry,
    users: impl Iterator<Item = Id>,
) {
    geometry_change(out, p, st, mesh, old, new, false, users)
}

/// `dynamic_mesh`, with `frame` as in `body_delta_frames`.
#[allow(clippy::too_many_arguments)]
fn geometry_change(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    mesh: Id,
    old: Option<&MeshGeometry>,
    new: &MeshGeometry,
    frame: bool,
    users: impl Iterator<Item = Id>,
) {
    let d = old.map_or(BodyDelta::NEW, |o| body_delta_frames(o, new, frame));
    // A flipbook frame with nothing but other UVs moved nothing: its new image is the animation.
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
        let Some(old) = old.filter(|_| !d.reshaped && d.px.is_finite()) else {
            out.changes |= Change::RESHAPE;
            continue;
        };
        let sh = shading(st, it);
        let item = geom::mul(&parent, &it.xform);
        let own_alpha = it.modulate[3] * it.self_modulate[3];
        let mut set = geom::IDENTITY;
        for c in &it.commands.list {
            let (g, alpha) = match c {
                Command::SetTransform { transform } => {
                    set = *transform;
                    continue;
                }
                Command::Mesh {
                    mesh: m,
                    transform,
                    modulate,
                    ..
                } if *m == mesh => (
                    geom::mul(&item, &geom::mul(&set, transform)),
                    modulate[3] * own_alpha,
                ),
                _ => continue,
            };
            body_on_screen(out, p, &g, sh, alpha, old, new);
        }
    }
}

/// `dynamic_mesh` for one draw of a comparable body through `g`, with the user's shading `sh`
/// and `alpha`, what its colours' alpha is multiplied by (the command's and the item's own).
fn body_on_screen(
    out: &mut TxMotion,
    p: &MotionParams,
    g: &Xform,
    sh: Shading,
    alpha: f32,
    old: &MeshGeometry,
    new: &MeshGeometry,
) {
    let n = new.positions.len();
    let col = |b: &MeshGeometry, k: usize| -> [f32; 4] {
        let c = b.colors.as_ref().map_or([1.0f32; 4], |c| c[k]);
        [c[0], c[1], c[2], c[3] * alpha]
    };
    let faint = |b: &MeshGeometry, prim: &[usize]| -> bool {
        sh.alpha_scales && prim.iter().all(|&k| sh.faint(&col(b, k)))
    };
    let at = |b: &MeshGeometry, k: usize| geom::xform_point(g, b.positions[k]);
    primitives(new.primitive, new.indices.as_deref(), n, |prim| {
        let (fo, fn_) = (faint(old, prim), faint(new, prim));
        let so = !fo && meets_viewport(prim.iter().map(|&k| at(old, k)), p);
        let sn = !fn_ && meets_viewport(prim.iter().map(|&k| at(new, k)), p);
        // Premultiplied where the material scales by alpha (what a pixel receives), else as is.
        let step = |k: usize| -> f32 {
            let (c0, c1) = (col(old, k), col(new, k));
            if sh.alpha_scales {
                premul_step(&c0, &c1)
            } else {
                color_step(&c0, &c1)
            }
        };
        match (so, sn) {
            (false, false) => {
                // Faint on both sides (or off screen): at most its own intensity reaches a pixel.
                if fo && fn_ {
                    for &k in prim {
                        let i = |b: &MeshGeometry| sh.intensity(&col(b, k)).unwrap_or(0.0);
                        out.anim_color(i(old).max(i(new)));
                    }
                }
            }
            (true, true) => {
                for &k in prim {
                    let (q0, q1) = (at(old, k), at(new, k));
                    out.anim_moved(hypot(q1[0] - q0[0], q1[1] - q0[1]));
                    out.anim_color(step(k));
                }
            }
            (shown_old, _) => {
                let b = if shown_old { old } else { new };
                let (mut lo, mut hi) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
                let mut moved = 0.0f32;
                for &k in prim {
                    let q = at(b, k);
                    for j in 0..2 {
                        lo[j] = lo[j].min(q[j]);
                        hi[j] = hi[j].max(q[j]);
                    }
                    let (q0, q1) = (at(old, k), at(new, k));
                    moved = moved.max(hypot(q1[0] - q0[0], q1[1] - q0[1]));
                }
                out.anim_moved(moved.min(0.5 * hypot(hi[0] - lo[0], hi[1] - lo[1])));
                // Faded in or out within one transaction: a colour step too.
                if fo != fn_ {
                    for &k in prim {
                        out.anim_color(step(k));
                    }
                }
            }
        }
    });
}

/// How many payload sets `MeshFrames` remembers per mesh: a looping flipbook up to this many
/// frames long is recognised from its second loop on.
pub const ANIMATION_FRAMES_MAX: usize = 64;

/// The payload sets (surface hashes) each static mesh showed recently, to tell a looping flipbook
/// (an animated sprite drawn as a mesh, swapping between a few frames) from new content: a mesh
/// that returns to a payload set it showed before is animating, and its frame swaps are animation
/// content; one that shows a set never seen is a resource change. The first loop of a flipbook
/// therefore wakes; later ones do not.
#[derive(Default)]
pub struct MeshFrames {
    map: std::collections::HashMap<Id, Vec<Vec<Hash>>>,
}

impl MeshFrames {
    /// Mesh `mesh` replaced the payload set `old` with `new`: notes both, and answers whether
    /// `new` is one it showed before.
    pub fn swap(&mut self, mesh: Id, old: &[Hash], new: &[Hash]) -> bool {
        let seen = self.map.entry(mesh).or_default();
        let mut note = |set: &[Hash]| -> bool {
            match seen.iter().position(|s| s == set) {
                Some(k) => {
                    let s = seen.remove(k);
                    seen.push(s);
                    true
                }
                None => {
                    if seen.len() >= ANIMATION_FRAMES_MAX {
                        seen.remove(0);
                    }
                    seen.push(set.to_vec());
                    false
                }
            }
        };
        note(old);
        note(new)
    }

    /// Forgets what mesh `mesh` showed (freed, or created anew under the same id).
    pub fn forget(&mut self, mesh: Id) {
        self.map.remove(&mesh);
    }

    /// Forgets the meshes the state no longer holds.
    pub fn retain(&mut self, st: &ResolvedState) {
        if self.map.len() > st.meshes.len() {
            self.map.retain(|id, _| st.meshes.contains_key(id));
        }
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }
}

/// One multimesh entry of the transaction's undo log. An entry that changed only its buffer (its
/// `version` and buffer identity) is measured instance by instance by `multimesh_buffer`, so it
/// sets `UNMEASURED` until then; an entry that changed only its `version` changes nothing drawn;
/// anything else (mesh, format, instance or visible count, custom AABB, status) is a resource
/// change.
pub fn multimesh(out: &mut TxMotion, old: Option<&Multimesh>, new: Option<&Multimesh>) {
    if let (Some(o), Some(n)) = (old, new) {
        let same_config = Multimesh {
            version: o.version,
            buffer_sha256: o.buffer_sha256,
            ..n.clone()
        } == *o;
        if same_config {
            if o.buffer_sha256 != n.buffer_sha256 {
                out.changes |= Change::UNMEASURED;
            }
            return;
        }
    }
    out.changes |= Change::RESOURCE;
}

/// How far from the origin, in the mesh's own space, mesh `mesh` reaches: the largest vertex
/// distance over its surfaces' held geometry (`geometry` by payload hash). `None` when it cannot
/// be known: no such `ok` mesh, a dynamic surface, or a payload not held yet.
pub fn mesh_reach<'a>(
    st: &ResolvedState,
    mesh: Id,
    geometry: impl Fn(&Hash) -> Option<&'a MeshGeometry>,
) -> Option<f32> {
    let m = st.meshes.get(&mesh)?;
    if m.status != EntryStatus::Ok {
        return None;
    }
    let mut r = 0.0f32;
    for s in &m.surfaces {
        let g = geometry(s.hash.as_ref()?)?;
        for q in &g.positions {
            r = r.max(hypot(q[0], q[1]));
        }
    }
    r.is_finite().then_some(r)
}

/// How the material an item draws with treats the colour of what it draws (vertex and instance
/// colours) and a multimesh instance's custom data.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Shading {
    /// Alpha scales what a colour adds to a pixel (the default shader, or a builtin canvas
    /// material with a mix, add or sub blend): faint content is near invisible.
    alpha_scales: bool,
    /// The material may read INSTANCE_CUSTOM (a custom shader, or a builtin with particles
    /// animation, whose frame it selects).
    reads_custom: bool,
    /// The blend adds (or subtracts) colour times alpha, so a dark colour reaches a pixel as
    /// little as a transparent one (add, sub); otherwise alpha alone says how much (mix).
    additive: bool,
}

impl Shading {
    /// How much of a straight colour `c` reaches a pixel, when the material scales by alpha:
    /// its alpha, or under an additive blend its alpha times its brightest channel.
    fn intensity(&self, c: &[f32; 4]) -> Option<f32> {
        self.alpha_scales.then(|| {
            let a = c[3].max(0.0);
            if self.additive {
                a * c[0].max(c[1]).max(c[2]).max(0.0)
            } else {
                a
            }
        })
    }

    /// Whether `c` is faint: at most `FAINT_ALPHA` of it reaches a pixel.
    fn faint(&self, c: &[f32; 4]) -> bool {
        self.intensity(c).is_some_and(|i| i <= FAINT_ALPHA)
    }
}

/// `Shading` of what `it` draws with: its material, or with `use_parent_material` its material
/// owner's (the nearest ancestor that does not inherit, as the canvas walk resolves it).
fn shading(st: &ResolvedState, it: &Item) -> Shading {
    const UNKNOWN: Shading = Shading {
        alpha_scales: false,
        reads_custom: true,
        additive: false,
    };
    let mut owner = it;
    for _ in 0..256 {
        if !owner.use_parent_material {
            break;
        }
        match owner.parent {
            Some(Parent {
                kind: ParentKind::Item,
                id,
            }) => match st.items.get(&id) {
                Some(p) => owner = p,
                None => return UNKNOWN,
            },
            _ => break,
        }
    }
    let Some(mat) = owner.material else {
        return Shading {
            alpha_scales: true,
            reads_custom: false,
            additive: false,
        };
    };
    let builtin = st
        .materials
        .get(&mat)
        .filter(|m| m.status == EntryStatus::Ok)
        .and_then(|m| m.shader)
        .and_then(|s| st.shaders.get(&s))
        .filter(|s| s.status == EntryStatus::Ok)
        .and_then(|s| s.builtin.clone());
    match builtin {
        Some(b) => Shading {
            alpha_scales: matches!(
                b.blend_mode,
                BlendMode::Mix | BlendMode::Add | BlendMode::Sub
            ),
            reads_custom: b.particles_animation,
            additive: matches!(b.blend_mode, BlendMode::Add | BlendMode::Sub),
        },
        None => UNKNOWN,
    }
}

/// One instance of a 2D multimesh buffer: its transform (from the row-major `x.x, y.x, _, o.x,
/// x.y, y.y, _, o.y` layout), its colour (opaque white without colours) and its custom data.
fn instance(f: &[f32], colors: bool, custom: bool) -> (Xform, [f32; 4], Option<[f32; 4]>) {
    let x = [f[0], f[4], f[1], f[5], f[3], f[7]];
    let c = if colors {
        [f[8], f[9], f[10], f[11]]
    } else {
        [1.0; 4]
    };
    let at = 8 + 4 * colors as usize;
    let d = custom.then(|| [f[at], f[at + 1], f[at + 2], f[at + 3]]);
    (x, c, d)
}

/// A multimesh's instance buffer that replaced `old` with `new` (`None`: none was held), drawn
/// by the items `users` (its `add_multimesh` users) with a mesh reaching `reach` from its origin
/// (`mesh_reach`). Over its visible users, each drawn instance that changed counts as:
///
/// - shown on neither side (degenerate: zero area; off screen: its reach around its origin
///   misses the viewport; or faint: opacity at most `FAINT_ALPHA` where the material scales by
///   alpha): nothing visible changes however far it jumped (a particle that dies faded out and
///   respawns faded in), but a faint one's opacity counts as a colour step;
/// - shown on one side only (respawned, moved on or off screen, faded in or out within one
///   transaction): the smaller of its displacement and its on-screen reach (what appeared or
///   vanished lies that close to its origin), and with a fade its colour step;
/// - shown on both: the displacement of its transform through the user's (`change_px` with the
///   mesh reach), and its colour step.
///
/// Custom data that changed where the material may read it, a buffer of another length, no
/// previous buffer, a 3D format or an unknown reach is `RESHAPE`; a user a sub-viewport draws is
/// `VIEWPORT`. A multimesh drawn by no visible item changes nothing on screen.
pub fn multimesh_buffer(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    mm: Id,
    old: Option<&[f32]>,
    new: &[f32],
    reach: Option<f32>,
    users: impl Iterator<Item = Id>,
) {
    let Some(e) = st.multimeshes.get(&mm) else {
        return;
    };
    let stride = e.stride() as usize;
    let drawn = (e.drawn_instances().max(0) as usize).min(new.len() / stride);
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
        let (Some(old), Some(r), MultimeshFormat::D2) = (old, reach, e.format) else {
            out.changes |= Change::RESHAPE;
            return;
        };
        if old.len() != new.len() {
            out.changes |= Change::RESHAPE;
            return;
        }
        let sh = shading(st, it);
        let item = geom::mul(&parent, &it.xform);
        // The transform each of the item's `add_multimesh` of this multimesh draws through (the
        // `add_set_transform` in effect, then the item's).
        let mut set = geom::IDENTITY;
        for c in &it.commands.list {
            let g = match c {
                Command::SetTransform { transform } => {
                    set = *transform;
                    continue;
                }
                Command::Multimesh { multimesh, .. } if *multimesh == mm => geom::mul(&item, &set),
                _ => continue,
            };
            let gl = lin(&g);
            for k in 0..drawn {
                let (a, b) = (&old[k * stride..][..stride], &new[k * stride..][..stride]);
                if a == b {
                    continue;
                }
                let (xa, ca, da) = instance(a, e.colors, e.custom);
                let (xb, cb, db) = instance(b, e.colors, e.custom);
                if da != db && sh.reads_custom {
                    out.changes |= Change::RESHAPE;
                    return;
                }
                // Shown: not degenerate (zero area draws nothing), on screen (the mesh's reach
                // around the instance's origin meets the viewport), and not faint where the
                // material scales by alpha.
                let shown = |x: &Xform, c: &[f32; 4]| -> bool {
                    if x[0] * x[3] - x[2] * x[1] == 0.0 {
                        return false;
                    }
                    if sh.faint(c) {
                        return false;
                    }
                    let o = geom::xform_point(&g, [x[4], x[5]]);
                    let rr = spectral(&lin_mul(&gl, &lin(x))) * r;
                    meets_viewport(
                        [[o[0] - rr, o[1] - rr], [o[0] + rr, o[1] + rr]].into_iter(),
                        p,
                    )
                };
                let (sa, sb) = (shown(&xa, &ca), shown(&xb, &cb));
                // Premultiplied where the material scales by alpha (what a pixel receives).
                let step = |c0: &[f32; 4], c1: &[f32; 4]| -> f32 {
                    if sh.alpha_scales {
                        premul_step(c0, c1)
                    } else {
                        color_step(c0, c1)
                    }
                };
                let size = |x: &Xform| spectral(&lin_mul(&gl, &lin(x))) * r;
                match (sa, sb) {
                    (false, false) => {
                        // Faint on both sides: at most its intensity reaches a pixel.
                        if sh.faint(&ca) && sh.faint(&cb) {
                            let i = |c: &[f32; 4]| sh.intensity(c).unwrap_or(0.0);
                            out.anim_color(i(&ca).max(i(&cb)));
                        }
                    }
                    (true, true) => {
                        out.anim_color(step(&ca, &cb));
                        out.anim_moved(change_px(&g, &xa, &xb, Some(r), p));
                    }
                    // Appeared or vanished (respawned visible, moved on or off screen): what
                    // changed lies within its on-screen reach of its origin, and within its
                    // displacement of where it was.
                    (true, false) | (false, true) => {
                        let x = if sa { &xa } else { &xb };
                        out.anim_moved(size(x).min(change_px(&g, &xa, &xb, Some(r), p)));
                        // Faded in or out within one transaction: a colour step too.
                        if sh.alpha_scales && sh.faint(&ca) != sh.faint(&cb) {
                            out.anim_color(step(&ca, &cb));
                        }
                    }
                }
            }
        }
    }
}

/// One particles entry of the transaction's undo log, `users` its `add_particles` users. The
/// emitter's per-tick inputs are ambient: its `version`, and its emission transform (where new
/// particles spawn; Godot sets it from the emitter's global transform every time the node moves),
/// whose displacement counts through each visible user's canvas transform (global coordinates)
/// and its own (local coordinates), with no known reach. The emitter velocity is ambient only
/// when the process material is the builtin one with `inherit_velocity_ratio` 0, so it moves no
/// particle. Anything else (emitting, amount, restart, emit, process requests, seed, lifetime,
/// speed, the process material, draw passes, trails, a custom AABB) is a resource change, and so
/// is an entry added or removed.
pub fn particles(
    out: &mut TxMotion,
    p: &MotionParams,
    st: &ResolvedState,
    old: Option<&Particles>,
    new: Option<&Particles>,
    users: impl Iterator<Item = Id>,
) {
    let (Some(o), Some(n)) = (old, new) else {
        out.changes |= Change::RESOURCE;
        return;
    };
    let (Some(fo), Some(fn_)) = (&o.floats, &n.floats) else {
        if (Particles {
            version: o.version,
            ..n.clone()
        }) != *o
        {
            out.changes |= Change::RESOURCE;
        }
        return;
    };
    // Floats compare by bit pattern (`particles-version`'s rule), so a NaN field is not a change.
    let same_config = Particles {
        version: o.version,
        floats: None,
        ..n.clone()
    } == Particles {
        floats: None,
        ..o.clone()
    } && crate::state::ParticleFloats {
        emission_transform: fo.emission_transform,
        emitter_velocity: fo.emitter_velocity,
        ..fn_.clone()
    }
    .bits_eq(fo);
    if !same_config {
        out.changes |= Change::RESOURCE;
        return;
    }
    if fo.emitter_velocity != fn_.emitter_velocity && !inherits_no_velocity(st, n) {
        out.changes |= Change::RESOURCE;
        return;
    }
    if fo.emission_transform == fn_.emission_transform {
        return;
    }
    // `Transform3D` in memory order (basis rows, then origin): the 2D part.
    let e2 = |t: &[f32; 12]| -> Xform { [t[0], t[3], t[1], t[4], t[9], t[10]] };
    let (ea, eb) = (e2(&fo.emission_transform), e2(&fn_.emission_transform));
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
        let local = geom::mul(&parent, &it.xform);
        let global = match canvas.and_then(|c| st.canvases.get(&c)) {
            Some(c) => geom::mul(&p.global, &c.xform),
            None => p.global,
        };
        out.moved(change_px(&local, &ea, &eb, None, p).max(change_px(&global, &ea, &eb, None, p)));
    }
}

/// Whether emitter `e`'s process material is the builtin one with `inherit_velocity_ratio` 0:
/// the emitter's velocity then moves no particle.
fn inherits_no_velocity(st: &ResolvedState, e: &Particles) -> bool {
    let Some(m) = e.process_material.and_then(|m| st.materials.get(&m)) else {
        return false;
    };
    let builtin = m
        .shader
        .and_then(|s| st.shaders.get(&s))
        .is_some_and(|s| s.process.is_some());
    builtin
        && m.params.iter().any(|q| {
            &*q.name == "inherit_velocity_ratio"
                && matches!(q.value, ParamValue::Scalar(v) if v == 0.0)
        })
}

/// The receiver's half of one accepted transaction's facts, added to the validator's (`m`):
/// every dynamic body and multimesh buffer the payload store just ingested (with `measure` on),
/// and every static mesh whose payloads changed (`Validator::motion_geometry`), through the items
/// that draw them. A static surface whose old or new payload the store does not hold (yet) cannot
/// be compared and is a resource change. With the multimesh store measuring, every change that
/// set `UNMEASURED` has then been measured, so it clears.
pub fn ingested(
    m: &mut TxMotion,
    p: &MotionParams,
    v: &crate::validate::Validator,
    payloads: &crate::apply::payloads::PayloadStore,
) {
    let st = v.state();
    for (mesh, surface, old) in &payloads.dynamic.moved {
        let new = payloads
            .dynamic
            .get(*mesh)
            .and_then(|d| d.surfaces.get(*surface as usize))
            .and_then(|g| g.as_ref());
        // A body ingested for a mesh dropped in the same transaction: its removal is the change.
        if let Some(new) = new {
            dynamic_mesh(m, p, st, *mesh, old.as_ref(), new, v.mesh_users(*mesh));
        }
    }
    for (mesh, old_hashes, frame) in v.motion_geometry() {
        let Some(e) = st.meshes.get(mesh) else {
            continue;
        };
        for (s, old) in e.surfaces.iter().zip(old_hashes) {
            let Some(new) = s.hash.filter(|h| h != old) else {
                continue;
            };
            match (payloads.meshes.get(old), payloads.meshes.get(&new)) {
                (Some(a), Some(b)) => {
                    geometry_change(m, p, st, *mesh, Some(a), b, *frame, v.mesh_users(*mesh))
                }
                _ => m.changes |= Change::RESOURCE,
            }
        }
    }
    if !payloads.multimeshes.measure {
        return;
    }
    for (mm, old) in &payloads.multimeshes.moved {
        let Some(new) = payloads.multimeshes.get(*mm) else {
            continue;
        };
        let reach = st
            .multimeshes
            .get(mm)
            .and_then(|e| e.mesh)
            .and_then(|mesh| mesh_reach(st, mesh, |h| payloads.meshes.get(h)));
        multimesh_buffer(
            m,
            p,
            st,
            *mm,
            old.as_deref(),
            &new.floats,
            reach,
            v.multimesh_users(*mm),
        );
    }
    m.changes &= !Change::UNMEASURED;
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
