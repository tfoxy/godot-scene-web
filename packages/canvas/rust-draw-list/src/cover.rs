//! The cover walk: which draws (and back-buffer operations) of a [`DrawList`] cannot change a
//! pixel of the frame, because a later draw overwrites every pixel they touch before anything
//! reads it.
//!
//! Godot's 2D renderer has no occlusion: it draws every item, so a full-screen opaque layer over
//! a busy scene still pays for every fragment beneath it. Dropping those draws changes no pixel
//! when the rules below hold, so an executor running the culled list paints exactly what it
//! paints for the full one.
//!
//! **A cover** leaves the source colour (and, where it writes alpha, alpha 1 or the source alpha)
//! at every pixel it claims, whatever the destination held:
//! - the builtin program, no MSDF, not instanced, not a canvas-group draw or composite;
//! - [`Blend::Disabled`], which overwrites outright (it writes the source alpha too); or
//!   [`Blend::Mix`] / [`Blend::PremulAlpha`] with every vertex colour alpha and the item
//!   modulate alpha at least 1, and every texel the claimed pixels can sample opaque (the white
//!   texel, an untextured draw, or a texel rectangle [`Opacity::region`] holds opaque, its linear
//!   filtering footprint and clamp/repeat included). A texture over the executor's largest side
//!   ([`CoverFacts::max_texture_side`]) is held reduced by `k` ([`crate::downscale_factor`]), each
//!   texel the alpha-weighted mean of a `k`x`k` block: the footprint is taken in the reduced
//!   texels, and each must stand for a block whose every texel is opaque. Add, Sub and Mul never
//!   cover; neither does any item-space program.
//! - The claimed pixels are the pixel centres strictly inside a rectangle the draw's triangles
//!   provably fill, by [`MARGIN`] (more than a rasterizer's sub-pixel snapping), intersected with
//!   its scissor and the target: the triangles, in item space, must tile their bounding rectangle
//!   (consistent orientation, every interior edge shared bit for bit by exactly one opposite
//!   edge, every other edge on the rectangle's border, the areas summing to the rectangle's), and
//!   the item transform maps that rectangle to a parallelogram whose largest inscribed
//!   axis-aligned rectangle centred on it is the claim.
//! - Every term of its placed corners stays within [`FAR`] pixels, so the executor's f32
//!   arithmetic lands within [`MARGIN`] of the exact position.
//!
//! On a [`Target::opaque`] target every blend but `Disabled` keeps the destination alpha, so a
//! mix cover hides colour only: a draw that writes alpha there (`Disabled`) is dropped only under
//! covers that write alpha too. On a transparent target every cover writes alpha.
//!
//! **The walk** runs back to front over one target's list, keeping the set of target pixels
//! whose value is overwritten before anything observes it (an under-approximation, as
//! rectangles). A draw whose pixel bounds lie inside that set is dropped. A back-buffer copy
//! observes the target in its region, so a kept copy takes its region out of the set. The back
//! buffer's live texels are tracked the same way (an over-approximation): a kept screen-reading
//! program reads all of it (and its mip chain), a kept group composite reads its own pixels, a
//! draw into the back buffer is kept only where something later reads it, and a copy, clear or
//! mip chain is kept only when what it writes is read before it is overwritten, or when a kept
//! reader follows it before the next kept operation (which also keeps the sampling state the
//! operation sets, `ScreenOp::sample_mips`, exactly where a kept reader sees it). So a screen
//! copy and its mip chain go only when every reader of them is dropped.
//!
//! Nothing here assumes the target starts opaque or ends on screen: it is per list, so a list
//! drawn into an offscreen surface that something samples later is walked the same way.
//!
//! **Cost.** A walk runs after every change to the list, so per draw it keeps what it learned
//! ([`CoverWalk`]'s memo) while the list's dirty ranges and texture operations (the record an
//! executor uploads from) say nothing it read changed; a change of the draw's item row alone
//! re-runs only the screen half. Draws smaller than [`DEFAULT_MIN_COVER_AREA`] on the target are
//! never analysed as covers (they still get hidden).

use crate::opacity::Opacity;
use crate::{
    Blend, Draw, DrawList, InstancedDraw, ScreenOp, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP,
    DRAW_GROUP_COMPOSITE, DRAW_INSTANCED, DRAW_MSDF, DRAW_SCISSOR, DRAW_SCREEN_OPS,
    DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED, WHITE_TEXTURE,
};

/// Pixel-centre margin in pixels: a claimed pixel's centre lies at least this far inside the
/// claimed rectangle, and a draw's bounds grow by it. More than half the coarsest sub-pixel grid a
/// GL ES rasterizer may snap vertices to (4 bits, so 1/32 px), and more than the f32 transform's
/// error while every term stays within [`FAR`].
pub const MARGIN: f64 = 1.0 / 16.0;

/// The largest magnitude, in pixels, a term of a placed position may reach for [`MARGIN`] to hold
/// (2^17: an f32 there is exact to 1/64 px, so the few roundings of a transform stay well inside
/// the margin). Past it (world-space geometry under a far camera, say) a draw claims no cover,
/// and its bounds are its whole scissor.
pub const FAR: f64 = 131_072.0;

/// Texel margin around sampled texture coordinates (interpolation error).
const UV_EPS: f64 = 1.0 / 64.0;

/// Rectangles kept per region set before the smallest (dead set) or all (live set) are merged.
const SET_CAP: usize = 16;

/// What one item-space program does, as far as the walk cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgramFacts {
    /// It samples the screen (the back buffer).
    pub reads_screen: bool,
    /// It has its own vertex stage, so its fragments may land anywhere in its scissor.
    pub vertex_stage: bool,
}

impl ProgramFacts {
    /// What an unknown program is assumed to do.
    pub const UNKNOWN: ProgramFacts = ProgramFacts {
        reads_screen: true,
        vertex_stage: true,
    };
}

/// What the walk needs beyond the list.
pub trait CoverFacts {
    /// The opacity of texture `id` as the executor holds it (None: unknown, never opaque).
    fn opacity(&self, texture: u32) -> Option<&Opacity>;
    /// Binding slot `slot` (0-based): its program's facts.
    fn program(&self, slot: u32) -> ProgramFacts;
    /// The executor's largest texture side (`MAX_TEXTURE_SIZE`): a texture over it is held
    /// reduced ([`crate::downscale_factor`]). 0: no limit.
    fn max_texture_side(&self) -> u32 {
        0
    }
}

/// Whether placing item-local `p` under `x` (after `inst`) has a term past [`FAR`].
fn far(x: &[f32; 6], inst: Option<&[f32; 8]>, p: [f32; 2]) -> bool {
    let (mut px, mut py) = (f64::from(p[0]).abs(), f64::from(p[1]).abs());
    if let Some(i) = inst {
        let i = i.map(|v| f64::from(v).abs());
        let (ix, iy) = (i[0] * px + i[1] * py + i[3], i[4] * px + i[5] * py + i[7]);
        if !(ix <= FAR && iy <= FAR) {
            return true;
        }
        (px, py) = (ix, iy);
    }
    let x = x.map(|v| f64::from(v).abs());
    !(x[0] * px + x[2] * py + x[4] <= FAR && x[1] * px + x[3] * py + x[5] <= FAR)
}

/// The texel rectangle, inclusive and in `o`'s own texels, that texture coordinates
/// `[u0, v0, u1, v1]` can read through `sampler` when the executor holds the texture reduced by
/// `k`: the footprint in reduced texels, each widened to the `k`x`k` block it stands for. A reduced
/// texel is the alpha-weighted mean of its block, so it is opaque when the whole block is.
fn texel_region(o: &Opacity, sampler: u32, uv: [f64; 4], k: u32) -> [i64; 4] {
    let (w, h) = (o.width(), o.height());
    let (rw, rh) = crate::downscaled_size(w, h, k);
    let xs = texel_span(uv[0] * f64::from(rw), uv[2] * f64::from(rw), rw, sampler);
    let ys = texel_span(uv[1] * f64::from(rh), uv[3] * f64::from(rh), rh, sampler);
    let (x0, y0, x1, y1) = match (xs, ys) {
        (Some((tx0, tx1)), Some((ty0, ty1))) => (tx0, ty0, tx1, ty1),
        _ => (0, 0, i64::from(rw) - 1, i64::from(rh) - 1),
    };
    let k = i64::from(k);
    [
        k * x0,
        k * y0,
        (k * x1 + k - 1).min(i64::from(w) - 1),
        (k * y1 + k - 1).min(i64::from(h) - 1),
    ]
}

/// An integer pixel rectangle `[x0, x1) × [y0, y1)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PxRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl PxRect {
    pub const EMPTY: PxRect = PxRect {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };

    /// From `[x, y, w, h]`.
    pub fn xywh(r: [i32; 4]) -> PxRect {
        PxRect {
            x0: r[0],
            y0: r[1],
            x1: r[0].saturating_add(r[2]),
            y1: r[1].saturating_add(r[3]),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    pub fn area(&self) -> i64 {
        if self.is_empty() {
            0
        } else {
            i64::from(self.x1 - self.x0) * i64::from(self.y1 - self.y0)
        }
    }

    pub fn intersect(&self, o: &PxRect) -> PxRect {
        PxRect {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }

    pub fn intersects(&self, o: &PxRect) -> bool {
        !self.intersect(o).is_empty()
    }

    pub fn contains(&self, o: &PxRect) -> bool {
        o.is_empty() || (o.x0 >= self.x0 && o.y0 >= self.y0 && o.x1 <= self.x1 && o.y1 <= self.y1)
    }

    fn union(&self, o: &PxRect) -> PxRect {
        if self.is_empty() {
            return *o;
        }
        if o.is_empty() {
            return *self;
        }
        PxRect {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }

    fn grow(&self, by: i32) -> PxRect {
        PxRect {
            x0: self.x0 - by,
            y0: self.y0 - by,
            x1: self.x1 + by,
            y1: self.y1 + by,
        }
    }

    /// `self` minus `o`: up to four disjoint pieces.
    fn subtract(&self, o: &PxRect, out: &mut Vec<PxRect>) {
        let i = self.intersect(o);
        if i.is_empty() {
            out.push(*self);
            return;
        }
        let s = *self;
        let mut push = |r: PxRect| {
            if !r.is_empty() {
                out.push(r)
            }
        };
        push(PxRect { y1: i.y0, ..s });
        push(PxRect { y0: i.y1, ..s });
        push(PxRect {
            x1: i.x0,
            y0: i.y0,
            y1: i.y1,
            ..s
        });
        push(PxRect {
            x0: i.x1,
            y0: i.y0,
            y1: i.y1,
            ..s
        });
    }
}

/// Whether `r` lies inside the union of `set`.
fn covered_by(r: &PxRect, set: &[PxRect], work: &mut Vec<PxRect>, next: &mut Vec<PxRect>) -> bool {
    if r.is_empty() {
        return true;
    }
    if set.is_empty() {
        return false;
    }
    work.clear();
    work.push(*r);
    for s in set {
        next.clear();
        for w in work.iter() {
            w.subtract(s, next);
        }
        std::mem::swap(work, next);
        if work.is_empty() {
            return true;
        }
        if work.len() > 256 {
            return false;
        }
    }
    work.is_empty()
}

/// Pixels known dead (an under-approximation): at most [`SET_CAP`] rectangles, the smallest
/// forgotten first.
#[derive(Default)]
struct DeadSet(Vec<PxRect>);

impl DeadSet {
    fn add(&mut self, r: PxRect) {
        if r.is_empty() || self.0.iter().any(|s| s.contains(&r)) {
            return;
        }
        self.0.retain(|s| !r.contains(s));
        self.0.push(r);
        self.cap();
    }
    fn subtract(&mut self, r: &PxRect, scratch: &mut Vec<PxRect>) {
        if !self.0.iter().any(|s| s.intersects(r)) {
            return;
        }
        scratch.clear();
        for s in &self.0 {
            s.subtract(r, scratch);
        }
        std::mem::swap(&mut self.0, scratch);
        self.cap();
    }
    fn cap(&mut self) {
        if self.0.len() > SET_CAP {
            self.0.sort_by_key(|r| std::cmp::Reverse(r.area()));
            self.0.truncate(SET_CAP);
        }
    }
}

/// Back-buffer texels something later reads (an over-approximation): at most [`SET_CAP`]
/// rectangles, merged into their bounds beyond that.
#[derive(Default)]
struct LiveSet(Vec<PxRect>);

impl LiveSet {
    fn add(&mut self, r: PxRect) {
        if r.is_empty() || self.0.iter().any(|s| s.contains(&r)) {
            return;
        }
        self.0.push(r);
        self.cap();
    }
    fn intersects(&self, r: &PxRect) -> bool {
        self.0.iter().any(|s| s.intersects(r))
    }
    fn subtract(&mut self, r: &PxRect, scratch: &mut Vec<PxRect>) {
        scratch.clear();
        for s in &self.0 {
            s.subtract(r, scratch);
        }
        std::mem::swap(&mut self.0, scratch);
        self.cap();
    }
    fn cap(&mut self) {
        if self.0.len() > SET_CAP {
            let b = self.0.iter().fold(PxRect::EMPTY, |a, r| a.union(r));
            self.0.clear();
            self.0.push(b);
        }
    }
}

/// The screen position of item-local `p` under item transform `x` (Godot columns) after the
/// instance transform `inst` (Godot's buffer layout), if any.
#[inline]
fn place(x: &[f32; 6], inst: Option<&[f32; 8]>, p: [f32; 2]) -> [f64; 2] {
    let (mut px, mut py) = (f64::from(p[0]), f64::from(p[1]));
    if let Some(i) = inst {
        let (ix, iy) = (
            f64::from(i[0]) * px + f64::from(i[1]) * py + f64::from(i[3]),
            f64::from(i[4]) * px + f64::from(i[5]) * py + f64::from(i[7]),
        );
        (px, py) = (ix, iy);
    }
    [
        f64::from(x[0]) * px + f64::from(x[2]) * py + f64::from(x[4]),
        f64::from(x[1]) * px + f64::from(x[3]) * py + f64::from(x[5]),
    ]
}

const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// A draw's index range, clamped to the index buffer.
fn index_range(list: &DrawList, draw: &Draw) -> std::ops::Range<usize> {
    let first = (draw.first_index as usize).min(list.indices.len());
    let end = (first + draw.index_count as usize).min(list.indices.len());
    first..end - (end - first) % 3
}

/// The draw's scissor intersected with the target.
fn clip_rect(list: &DrawList, draw: &Draw) -> PxRect {
    let target = PxRect {
        x0: 0,
        y0: 0,
        x1: list.target.width as i32,
        y1: list.target.height as i32,
    };
    if draw.flags & DRAW_SCISSOR != 0 {
        PxRect::xywh(draw.scissor).intersect(&target)
    } else {
        target
    }
}

/// The pixels draw `d` can touch: its triangles' screen bounds grown by [`MARGIN`], as the pixels
/// whose centres they hold, within its scissor and the target. A program with its own vertex
/// stage may put fragments anywhere in its scissor.
pub fn draw_bounds(list: &DrawList, d: usize, facts: &impl CoverFacts) -> PxRect {
    let draw = &list.draws[d];
    let clip = clip_rect(list, draw);
    if clip.is_empty() {
        return PxRect::EMPTY;
    }
    if draw.program != BUILTIN_PROGRAM && facts.program(draw.program - 1).vertex_stage {
        return clip;
    }
    let range = index_range(list, draw);
    let instances: &[crate::Instance] = if draw.flags & DRAW_INSTANCED != 0 {
        match list.instanced.binary_search_by_key(&(d as u32), |r| r.draw) {
            Ok(i) => {
                let r = list.instanced[i];
                let from = (r.first as usize).min(list.instances.len());
                let to = (from + r.count as usize).min(list.instances.len());
                &list.instances[from..to]
            }
            Err(_) => &[],
        }
    } else {
        &[]
    };
    // The item-space bounds of the indexed vertices (one item: placing the bounds' four corners
    // bounds the placed triangles), else every vertex placed on its own.
    let (mut lx0, mut ly0, mut lx1, mut ly1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut item: Option<u32> = None;
    let mut one_item = true;
    for &i in &list.indices[range.clone()] {
        let Some(v) = list.vertices.get(i as usize) else {
            return clip;
        };
        match item {
            None => item = Some(v.item),
            Some(it) if it != v.item => one_item = false,
            _ => {}
        }
        lx0 = lx0.min(v.pos[0]);
        ly0 = ly0.min(v.pos[1]);
        lx1 = lx1.max(v.pos[0]);
        ly1 = ly1.max(v.pos[1]);
    }
    let Some(item) = item else {
        return PxRect::EMPTY;
    };
    if !(lx0.is_finite() && ly0.is_finite() && lx1.is_finite() && ly1.is_finite()) {
        return clip;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut any = false;
    let mut finite = true;
    let mut add = |p: [f64; 2]| {
        if !(p[0].is_finite() && p[1].is_finite()) {
            finite = false;
        }
        any = true;
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    };
    let corners = [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]];
    let mut too_far = false;
    let mut visit = |inst: Option<&[f32; 8]>| {
        if one_item {
            let x = list.items.get(item as usize).map_or(IDENTITY, |r| r.xform);
            for c in corners {
                too_far |= far(&x, inst, c);
                add(place(&x, inst, c));
            }
        } else {
            for &i in &list.indices[range.clone()] {
                let v = &list.vertices[i as usize];
                let x = list
                    .items
                    .get(v.item as usize)
                    .map_or(IDENTITY, |r| r.xform);
                too_far |= far(&x, inst, v.pos);
                add(place(&x, inst, v.pos));
            }
        }
    };
    if draw.flags & DRAW_INSTANCED != 0 {
        for inst in instances {
            visit(Some(&inst.xform));
        }
    } else {
        visit(None);
    }
    if !finite || too_far {
        return clip;
    }
    if !any {
        return PxRect::EMPTY;
    }
    // Pixel i may be touched when its centre i + 0.5 lies in [x0 - M, x1 + M].
    let lo = |v: f64| (v - MARGIN - 0.5).ceil().clamp(-1.0e9, 1.0e9) as i32;
    let hi = |v: f64| (v + MARGIN - 0.5).floor().clamp(-1.0e9, 1.0e9) as i32 + 1;
    PxRect {
        x0: lo(x0),
        y0: lo(y0),
        x1: hi(x1),
        y1: hi(y1),
    }
    .intersect(&clip)
}

/// An alpha that composites as 1: at least 1 (a unorm target clamps the fragment first), never NaN.
fn opaque_alpha(a: f32) -> bool {
    a >= 1.0
}

/// Whether draw `d`'s state can make it a cover (everything but its geometry and its texels).
/// Returns `Some(writes_alpha)`.
fn cover_state(list: &DrawList, d: usize, facts: &impl CoverFacts) -> Option<bool> {
    let draw = &list.draws[d];
    cover_state_of(draw, list.target.opaque, || facts.opacity(draw.texture))
}

/// [`cover_state`] of `draw` on a target that is `opaque_target`, `opacity` giving its texture's
/// table (asked only for a textured mix or premultiplied draw).
fn cover_state_of<'a>(
    draw: &Draw,
    opaque_target: bool,
    opacity: impl FnOnce() -> Option<&'a Opacity>,
) -> Option<bool> {
    if draw.index_count < 3
        || draw.program != BUILTIN_PROGRAM
        || draw.flags
            & (DRAW_TO_BACK_BUFFER
                | DRAW_MSDF
                | DRAW_INSTANCED
                | DRAW_GROUP_CLIP
                | DRAW_GROUP_COMPOSITE)
            != 0
    {
        return None;
    }
    match Blend::from_u32(draw.blend)? {
        Blend::Disabled => Some(true),
        Blend::Mix | Blend::PremulAlpha => {
            let white = draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE;
            if !white && !opacity().is_some_and(|o| o.any()) {
                return None;
            }
            Some(!opaque_target)
        }
        Blend::Add | Blend::Sub | Blend::Mul => None,
    }
}

/// Scratch for one cover analysis.
#[derive(Default)]
struct Scratch {
    /// Item-space positions of the draw's triangles.
    local: Vec<[[f32; 2]; 3]>,
    /// Directed edges as (from, to) position bit patterns.
    edges: Vec<(u64, u64)>,
    /// Undirected edges (lower key first) with their net count (+1 per edge in key order, -1 per
    /// edge against it).
    counted: Vec<(u64, u64, i32)>,
    /// The draw's triangles placed on screen.
    screen: Vec<[[f64; 2]; 3]>,
    poly: Vec<[f64; 2]>,
    poly_next: Vec<[f64; 2]>,
    /// Texel-rectangle verdicts ([`Regions`]).
    regions: Regions,
    /// A scan to compare a memo's with ([`CoverWalk::memo`]); holds the buffers of the scan it
    /// replaced last.
    spare: Local,
}

/// Whether texel rectangles of a texture are opaque throughout ([`Opacity::region`]), answered
/// once per (table identity, rectangle): a cover that drifts by a fraction of a pixel samples the
/// same texels frame after frame. A table's identity is never reused, so a re-uploaded texture
/// cannot be answered for from its old texels.
#[derive(Default)]
struct Regions {
    /// (opacity id, `[x0, y0, x1, y1]` inclusive, opaque), at most [`Regions::CAP`].
    seen: Vec<(u64, [i64; 4], bool)>,
    /// The entry the next miss replaces once full.
    next: usize,
}

impl Regions {
    const CAP: usize = 64;

    fn opaque(&mut self, o: &Opacity, r: [i64; 4]) -> bool {
        let id = o.id();
        if let Some(e) = self.seen.iter().find(|e| e.0 == id && e.1 == r) {
            return e.2;
        }
        let v = o.region(r[0], r[1], r[2], r[3]);
        if self.seen.len() < Self::CAP {
            self.seen.push((id, r, v));
        } else {
            self.seen[self.next] = (id, r, v);
            self.next = (self.next + 1) % Self::CAP;
        }
        v
    }
}

fn key(p: [f32; 2]) -> u64 {
    (u64::from(p[0].to_bits()) << 32) | u64::from(p[1].to_bits())
}

/// The item-space rectangle `[x0, y0, x1, y1]` the triangles tile exactly (see the module docs),
/// or None.
fn tiled_rect(tris: &[[[f32; 2]; 3]], edges: &mut Vec<(u64, u64)>) -> Option<[f32; 4]> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for t in tris {
        for p in t {
            if !(p[0].is_finite() && p[1].is_finite()) {
                return None;
            }
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
    }
    if !(x1 > x0 && y1 > y0) {
        return None;
    }
    // The areas first (cheap): only a mesh whose areas fill its bounds can tile them.
    let area = 2.0 * (f64::from(x1) - f64::from(x0)) * (f64::from(y1) - f64::from(y0));
    let sum: f64 = tris
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|p| [f64::from(p[0]), f64::from(p[1])]);
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs()
        })
        .sum();
    if (sum - area).abs() > 1e-9 * area {
        return None;
    }
    edges.clear();
    let mut sign = 0.0f64;
    let mut sum = 0.0f64;
    for t in tris {
        let [a, b, c] = t.map(|p| [f64::from(p[0]), f64::from(p[1])]);
        let a2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if a2 == 0.0 {
            // Rasterizes nothing.
            continue;
        }
        if sign == 0.0 {
            sign = a2.signum();
        } else if a2.signum() != sign {
            return None;
        }
        sum += a2.abs();
        let (p, q, r) = if a2 > 0.0 {
            (t[0], t[1], t[2])
        } else {
            (t[0], t[2], t[1])
        };
        edges.extend([(key(p), key(q)), (key(q), key(r)), (key(r), key(p))]);
    }
    let area = 2.0 * (f64::from(x1) - f64::from(x0)) * (f64::from(y1) - f64::from(y0));
    if sign == 0.0 || (sum - area).abs() > 1e-9 * area {
        return None;
    }
    edges.sort_unstable();
    for (i, &(p, q)) in edges.iter().enumerate() {
        if i > 0 && edges[i - 1] == (p, q) {
            // Two triangles on the same side of one edge overlap.
            return None;
        }
        if edges.binary_search(&(q, p)).is_ok() {
            continue;
        }
        let (px, py) = (f32::from_bits((p >> 32) as u32), f32::from_bits(p as u32));
        let (qx, qy) = (f32::from_bits((q >> 32) as u32), f32::from_bits(q as u32));
        let on_border =
            (px == qx && (px == x0 || px == x1)) || (py == qy && (py == y0 || py == y1));
        if !on_border {
            return None;
        }
    }
    Some([x0, y0, x1, y1])
}

/// The boundary of a consistently oriented mesh (item space): the edges no opposite edge cancels,
/// shared bit for bit, as a rasterizer draws a shared edge's pixels exactly once. The number of
/// triangles holding a point changes only across these edges, so on any region no boundary edge
/// meets it is the same everywhere, and one point of the region inside some triangle proves the
/// rest is covered ([`mesh_holds`]). Written to `out`; false (and `out` empty) when the
/// orientation is mixed (a fold) or there is no triangle.
fn mesh_boundary(
    tris: &[[[f32; 2]; 3]],
    counted: &mut Vec<(u64, u64, i32)>,
    out: &mut Vec<[[f32; 2]; 2]>,
) -> bool {
    out.clear();
    counted.clear();
    let mut sign = 0.0f64;
    for t in tris {
        let [a, b, c] = t.map(|p| [f64::from(p[0]), f64::from(p[1])]);
        let a2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if a2 == 0.0 {
            continue;
        }
        if !a2.is_finite() {
            return false;
        }
        if sign == 0.0 {
            sign = a2.signum();
        } else if a2.signum() != sign {
            return false;
        }
        for (p, q) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (kp, kq) = (key(p), key(q));
            counted.push(if kp < kq { (kp, kq, 1) } else { (kq, kp, -1) });
        }
    }
    if sign == 0.0 {
        return false;
    }
    counted.sort_unstable_by_key(|e| (e.0, e.1));
    let unkey = |k: u64| [f32::from_bits((k >> 32) as u32), f32::from_bits(k as u32)];
    let mut i = 0;
    while i < counted.len() {
        let (a, b) = (counted[i].0, counted[i].1);
        let mut net = 0;
        while i < counted.len() && counted[i].0 == a && counted[i].1 == b {
            net += counted[i].2;
            i += 1;
        }
        if net != 0 {
            out.push([unkey(a), unkey(b)]);
        }
    }
    true
}

/// Whether a mesh with `boundary` ([`mesh_boundary`]) covers every point of the closed screen
/// rectangle `r` under item transform `x`: no boundary edge meets `r`, and one point of `r` well
/// clear of every edge lies inside some triangle.
fn mesh_holds(
    tris: &[[[f32; 2]; 3]],
    boundary: &[[[f32; 2]; 2]],
    x: &[f32; 6],
    r: [f64; 4],
    screen: &mut Vec<[[f64; 2]; 3]>,
) -> bool {
    if !(r[0] <= r[2] && r[1] <= r[3]) {
        return false;
    }
    if boundary
        .iter()
        .any(|e| segment_meets_rect(place(x, None, e[0]), place(x, None, e[1]), r))
    {
        return false;
    }
    screen.clear();
    screen.extend(tris.iter().map(|t| t.map(|p| place(x, None, p))));
    for (fx, fy) in [
        (0.5, 0.5),
        (0.3141, 0.7183),
        (0.8862, 0.2236),
        (0.1732, 0.4142),
    ] {
        let p = [r[0] + (r[2] - r[0]) * fx, r[1] + (r[3] - r[1]) * fy];
        let mut inside = false;
        let mut near = false;
        for t in screen.iter() {
            let a2 = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1])
                - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]);
            if a2 == 0.0 {
                continue;
            }
            let mut min = f64::MAX;
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
                let d = a2.signum()
                    * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
                    / len;
                min = min.min(d);
            }
            if min.abs() < 1e-3 {
                near = true;
                break;
            }
            if min > 0.0 {
                inside = true;
            }
        }
        if !near {
            return inside;
        }
    }
    false
}

/// Whether segment `a`–`b` meets the closed rectangle `r` (Liang–Barsky).
fn segment_meets_rect(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> bool {
    if !(a[0].is_finite() && a[1].is_finite() && b[0].is_finite() && b[1].is_finite()) {
        return true;
    }
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let d = [b[0] - a[0], b[1] - a[1]];
    for (p, q) in [
        (-d[0], a[0] - r[0]),
        (d[0], r[2] - a[0]),
        (-d[1], a[1] - r[1]),
        (d[1], r[3] - a[1]),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

/// The largest axis-aligned rectangle centred on the image of item-space `r` under `x`
/// (a parallelogram), as `[x0, y0, x1, y1]` in screen pixels, or None when the image is
/// degenerate.
fn inscribed(x: &[f32; 6], r: [f32; 4]) -> Option<[f64; 4]> {
    let (w, h) = (
        f64::from(r[2]) - f64::from(r[0]),
        f64::from(r[3]) - f64::from(r[1]),
    );
    let e1 = [f64::from(x[0]) * w, f64::from(x[1]) * w];
    let e2 = [f64::from(x[2]) * h, f64::from(x[3]) * h];
    let det = e1[0] * e2[1] - e1[1] * e2[0];
    if !det.is_finite() || det == 0.0 {
        return None;
    }
    let o = place(x, None, [r[0], r[1]]);
    let c = [o[0] + 0.5 * (e1[0] + e2[0]), o[1] + 0.5 * (e1[1] + e2[1])];
    // A point c + (dx, dy) is inside when both coordinates of M⁻¹(dx, dy) are within ±1/2; for
    // the corners (±a, ±b) that is |m11| a + |m12| b ≤ 1/2 and |m21| a + |m22| b ≤ 1/2.
    let m11 = (e2[1] / det).abs();
    let m12 = (e2[0] / det).abs();
    let m21 = (e1[1] / det).abs();
    let m22 = (e1[0] / det).abs();
    let feasible = |a: f64, b: f64| {
        a >= 0.0
            && b >= 0.0
            && m11 * a + m12 * b <= 0.5 * (1.0 + 1e-12)
            && m21 * a + m22 * b <= 0.5 * (1.0 + 1e-12)
    };
    let mut best: Option<(f64, f64)> = None;
    let mut consider = |a: f64, b: f64| {
        if a.is_finite()
            && b.is_finite()
            && feasible(a, b)
            && best.is_none_or(|(x, y)| a * b > x * y)
        {
            best = Some((a, b));
        }
    };
    // Each constraint alone, at the maximum of a·b on its line.
    if m11 > 0.0 && m12 > 0.0 {
        consider(0.25 / m11, 0.25 / m12);
    }
    if m21 > 0.0 && m22 > 0.0 {
        consider(0.25 / m21, 0.25 / m22);
    }
    // Both tight.
    let d = m11 * m22 - m12 * m21;
    if d != 0.0 {
        consider(0.5 * (m22 - m12) / d, 0.5 * (m11 - m21) / d);
    }
    let (a, b) = best?;
    let (a, b) = (a * (1.0 - 1e-9), b * (1.0 - 1e-9));
    if a <= 0.0 || b <= 0.0 {
        return None;
    }
    Some([c[0] - a, c[1] - b, c[0] + a, c[1] + b])
}

/// The polygon of triangle `t` inside the closed rectangle `r` (Sutherland–Hodgman).
fn clip_poly(t: &[[f64; 2]; 3], r: [f64; 4], poly: &mut Vec<[f64; 2]>, next: &mut Vec<[f64; 2]>) {
    poly.clear();
    poly.extend_from_slice(t);
    for (axis, bound, ge) in [
        (0usize, r[0], true),
        (0, r[2], false),
        (1, r[1], true),
        (1, r[3], false),
    ] {
        next.clear();
        let inside = |p: &[f64; 2]| {
            if ge {
                p[axis] >= bound
            } else {
                p[axis] <= bound
            }
        };
        for i in 0..poly.len() {
            let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
            let (ia, ib) = (inside(&a), inside(&b));
            if ia {
                next.push(a);
            }
            if ia != ib {
                let s = (bound - a[axis]) / (b[axis] - a[axis]);
                next.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
            }
        }
        std::mem::swap(poly, next);
        if poly.is_empty() {
            return;
        }
    }
}

/// The inclusive texel range a sampler reads for texture coordinates in `[s0, s1]` (in texels):
/// `None` when it wraps outside `[0, size)` under repeat or mirror (the caller then needs the
/// whole texture).
fn texel_span(s0: f64, s1: f64, size: u32, sampler: u32) -> Option<(i64, i64)> {
    let linear = sampler & crate::Sampler::LINEAR != 0;
    let (mut t0, mut t1) = if linear {
        (
            (s0 - 0.5 - UV_EPS).floor() as i64,
            (s1 - 0.5 + UV_EPS).floor() as i64 + 1,
        )
    } else {
        ((s0 - UV_EPS).floor() as i64, (s1 + UV_EPS).floor() as i64)
    };
    let max = i64::from(size) - 1;
    if sampler & crate::Sampler::WRAP_MASK == crate::Sampler::CLAMP {
        t0 = t0.clamp(0, max);
        t1 = t1.clamp(0, max);
        Some((t0.min(t1), t1.max(t0)))
    } else if t0 < 0 || t1 > max {
        None
    } else {
        Some((t0, t1))
    }
}

/// What a draw's indices and vertices say, whatever its item row: kept by [`CoverWalk`] while a
/// new scan of them would be equal ([`Local::same_scan`]).
#[derive(Clone, Default)]
struct Local {
    /// Inclusive vertex and item-row ranges the draw's indices name.
    verts: (u32, u32),
    rows: (u32, u32),
    /// The row every vertex names (None: several).
    item: Option<u32>,
    /// Item-space bounds of the indexed vertices.
    lbox: [f32; 4],
    /// The opacity table of the draw's texture the scan saw ([`Opacity::id`]; 0: none, or the
    /// draw samples no texture).
    opacity: u64,
    /// The draw as a cover candidate as far as its state, rows and texture tell: whether it
    /// writes alpha (None: never a cover).
    cand: Option<bool>,
    /// A candidate's second scan ([`second_scan`], made only once a cover analysis gets past the
    /// cheap tests; None until then): the draw as a cover candidate as far as its vertices tell
    /// too (None: their alphas rule it out).
    cover: Option<Option<LocalCover>>,
    /// The second scan's indexed vertices in index order: the bit patterns of their positions
    /// and texture coordinates, all the cover analysis reads of them beyond the fields above.
    /// Two equal scans therefore give equal analyses.
    snap: Vec<[u32; 4]>,
    /// [`mesh_boundary`]'s edges, when `cover.boundary` is `Some(true)`.
    boundary: Vec<[[f32; 2]; 2]>,
}

#[derive(Clone, Copy)]
struct LocalCover {
    writes_alpha: bool,
    /// Mix or premultiplied alpha: the row's modulate alpha must be opaque too.
    needs_alpha: bool,
    /// Texture coordinate bounds `[u0, v0, u1, v1]` of the indexed vertices.
    uv: [f32; 4],
    /// Every texel they span is opaque (or the draw samples none); None until asked.
    whole_opaque: Option<bool>,
    /// Whether [`mesh_boundary`] found a consistently oriented mesh (its edges in
    /// [`Local::boundary`]), and [`tiled_rect`]: computed when first needed.
    boundary: Option<bool>,
    tiled: Option<Option<[f32; 4]>>,
}

fn bits4(v: [f32; 4]) -> [u32; 4] {
    v.map(f32::to_bits)
}

impl Local {
    /// Whether `o` scanned the same inputs: then every analysis made over `self` holds for `o`.
    /// Never for a draw over several rows (or missing vertices), whose bounds read every vertex.
    fn same_scan(&self, o: &Local) -> bool {
        self.item.is_some()
            && self.verts == o.verts
            && self.rows == o.rows
            && self.item == o.item
            && bits4(self.lbox) == bits4(o.lbox)
            && self.opacity == o.opacity
            && self.cand == o.cand
            && match (&self.cover, &o.cover) {
                (None, None) | (Some(None), Some(None)) => true,
                (Some(Some(a)), Some(Some(b))) => {
                    a.writes_alpha == b.writes_alpha
                        && a.needs_alpha == b.needs_alpha
                        && bits4(a.uv) == bits4(b.uv)
                }
                _ => false,
            }
            && self.snap == o.snap
    }
}

/// One scan of draw `d`'s indices (see [`Local`]) into `out`, keeping its buffers; with
/// `second`, a candidate's [`second_scan`] too.
fn local_of(list: &DrawList, d: usize, facts: &impl CoverFacts, out: &mut Local, second: bool) {
    let draw = &list.draws[d];
    let indices = &list.indices[index_range(list, draw)];
    // The index range first (a pass the compiler vectorises), so that the vertex pass knows
    // whether every index names a vertex.
    let (mut v0, mut v1) = (u32::MAX, 0u32);
    for &i in indices {
        v0 = v0.min(i);
        v1 = v1.max(i);
    }
    let (mut r0, mut r1) = (u32::MAX, 0u32);
    let (mut lx0, mut ly0, mut lx1, mut ly1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    // Bounds by comparison (a NaN never replaces a bound, as `f32::min` ignores it).
    let mut extend = |v: &crate::Vertex| {
        r0 = r0.min(v.item);
        r1 = r1.max(v.item);
        let [x, y] = v.pos;
        lx0 = if x < lx0 { x } else { lx0 };
        ly0 = if y < ly0 { y } else { ly0 };
        lx1 = if x > lx1 { x } else { lx1 };
        ly1 = if y > ly1 { y } else { ly1 };
    };
    let missing = if indices.is_empty() || (v1 as usize) < list.vertices.len() {
        let vertices = &list.vertices[..indices.first().map_or(0, |_| v1 as usize + 1)];
        for &i in indices {
            extend(&vertices[i as usize]);
        }
        false
    } else {
        for &i in indices {
            if let Some(v) = list.vertices.get(i as usize) {
                extend(v);
            }
        }
        true
    };
    let item = (r0 == r1 && !missing).then_some(r0);
    let lbox = [lx0, ly0, lx1, ly1];
    let finite = lbox.iter().all(|c| c.is_finite());
    let white = draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE;
    let opacity = if white {
        None
    } else {
        facts.opacity(draw.texture)
    };
    out.verts = (v0, v1);
    out.rows = (r0, r1);
    out.item = item;
    out.lbox = lbox;
    out.opacity = opacity.map_or(0, Opacity::id);
    out.cand = (|| {
        let writes_alpha = cover_state_of(draw, list.target.opaque, || opacity)?;
        item?;
        if !finite {
            return None;
        }
        let needs_alpha = Blend::from_u32(draw.blend)? != Blend::Disabled;
        if needs_alpha && !white && opacity.is_none() {
            return None;
        }
        Some(writes_alpha)
    })();
    out.cover = None;
    out.snap.clear();
    out.boundary.clear();
    if second {
        second_scan(list, d, out);
    }
}

/// A candidate's second scan (see [`Local::cover`]): its vertex alphas and texture coordinates.
fn second_scan(list: &DrawList, d: usize, out: &mut Local) {
    let Some(writes_alpha) = out.cand else {
        return;
    };
    let draw = &list.draws[d];
    let needs_alpha = draw.blend != Blend::Disabled as u32;
    let white = draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE;
    let range = index_range(list, draw);
    let snap = &mut out.snap;
    snap.clear();
    snap.reserve(range.len());
    out.cover = Some((|| {
        let mut uv = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for &i in &list.indices[range] {
            let v = &list.vertices[i as usize];
            if needs_alpha && !opaque_alpha(v.color[3]) {
                return None;
            }
            uv = [
                uv[0].min(v.uv[0]),
                uv[1].min(v.uv[1]),
                uv[2].max(v.uv[0]),
                uv[3].max(v.uv[1]),
            ];
            snap.push([
                v.pos[0].to_bits(),
                v.pos[1].to_bits(),
                v.uv[0].to_bits(),
                v.uv[1].to_bits(),
            ]);
        }
        // Whether every texel the texture coordinates span is opaque: asked only once the screen
        // half needs it ([`whole_opaque`]).
        let whole_opaque = (!needs_alpha || white).then_some(true);
        Some(LocalCover {
            writes_alpha,
            needs_alpha,
            uv,
            whole_opaque,
            boundary: None,
            tiled: None,
        })
    })());
    if matches!(out.cover, Some(None)) {
        out.snap.clear();
    }
}

/// Whether every texel draw `d`'s texture coordinates `uv` span (its filter footprint
/// included) is opaque.
fn whole_opaque(draw: &Draw, uv: [f32; 4], facts: &impl CoverFacts, regions: &mut Regions) -> bool {
    let Some(o) = facts.opacity(draw.texture) else {
        return false;
    };
    if o.all() {
        return true;
    }
    let k = crate::downscale_factor(o.width(), o.height(), facts.max_texture_side());
    regions.opaque(o, texel_region(o, draw.sampler, uv.map(f64::from), k))
}

/// Draw `d`'s triangles in item space (it names one row: [`Local::item`]).
fn local_tris(list: &DrawList, d: usize, out: &mut Vec<[[f32; 2]; 3]>) {
    out.clear();
    for t in list.indices[index_range(list, &list.draws[d])].chunks_exact(3) {
        out.push([0, 1, 2].map(|j| list.vertices[t[j] as usize].pos));
    }
}

/// Draw `d`'s pixel bounds from its [`Local`]: the item-space bounds' corners placed (one row),
/// else [`draw_bounds`].
fn bounds_of(list: &DrawList, d: usize, local: &Local, facts: &impl CoverFacts) -> PxRect {
    let draw = &list.draws[d];
    let Some(item) = local.item else {
        return draw_bounds(list, d, facts);
    };
    if index_range(list, draw).is_empty() {
        return PxRect::EMPTY;
    }
    let clip = clip_rect(list, draw);
    let [lx0, ly0, lx1, ly1] = local.lbox;
    if !local.lbox.iter().all(|c| c.is_finite()) {
        return clip;
    }
    let x = list.items.get(item as usize).map_or(IDENTITY, |r| r.xform);
    let corners = [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]];
    if corners.iter().any(|p| far(&x, None, *p)) {
        return clip;
    }
    let c = corners.map(|p| place(&x, None, p));
    let x0 = c.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
    let x1 = c.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
    let y0 = c.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
    let y1 = c.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
    if !(x0.is_finite() && x1.is_finite() && y0.is_finite() && y1.is_finite()) {
        return clip;
    }
    let lo = |v: f64| (v - MARGIN - 0.5).ceil().clamp(-1.0e9, 1.0e9) as i32;
    let hi = |v: f64| (v + MARGIN - 0.5).floor().clamp(-1.0e9, 1.0e9) as i32 + 1;
    PxRect {
        x0: lo(x0),
        y0: lo(y0),
        x1: hi(x1),
        y1: hi(y1),
    }
    .intersect(&clip)
}

/// The pixels draw `d` overwrites (see the module docs), with whether it writes alpha there, or
/// None when it is not a cover: the screen half of the analysis, over its [`Local`] (whose lazy
/// parts it fills in).
fn cover_rect(
    list: &DrawList,
    d: usize,
    local: &mut Local,
    facts: &impl CoverFacts,
    min_area: i64,
    s: &mut Scratch,
) -> Option<(PxRect, bool)> {
    let item = local.item?;
    local.cand?;
    let lbox = local.lbox;
    let draw = &list.draws[d];
    let row = list.items.get(item as usize)?;
    let needs_alpha = draw.blend != Blend::Disabled as u32;
    if needs_alpha && !opaque_alpha(row.modulate[3]) {
        return None;
    }
    let clip = clip_rect(list, draw);
    if clip.is_empty() {
        return None;
    }
    // A small cover hides less fill than its analysis costs: its screen bounds (the item-space
    // bounds' corners, placed) on the target must reach `min_area` pixels.
    let [lx0, ly0, lx1, ly1] = lbox;
    let local_corners = [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]];
    if local_corners.iter().any(|p| far(&row.xform, None, *p)) {
        return None;
    }
    let corners = local_corners.map(|p| place(&row.xform, None, p));
    let gx0 = corners.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
    let gx1 = corners.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
    let gy0 = corners.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
    let gy1 = corners.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
    let (sx0, sx1) = (gx0.max(f64::from(clip.x0)), gx1.min(f64::from(clip.x1)));
    let (sy0, sy1) = (gy0.max(f64::from(clip.y0)), gy1.min(f64::from(clip.y1)));
    if !(sx1 > sx0 && sy1 > sy0) || (sx1 - sx0) * (sy1 - sy0) < min_area as f64 {
        return None;
    }
    if local.cover.is_none() {
        second_scan(list, d, local);
    }
    let lc = local.cover.as_mut().and_then(Option::as_mut)?;
    // A texture opaque only in part covers only where the claim leaves the rest of the geometry
    // out, so only when the geometry reaches past the scissor.
    let inside_clip = gx0 >= f64::from(clip.x0)
        && gy0 >= f64::from(clip.y0)
        && gx1 <= f64::from(clip.x1)
        && gy1 <= f64::from(clip.y1);
    let whole = *lc
        .whole_opaque
        .get_or_insert_with(|| whole_opaque(draw, lc.uv, facts, &mut s.regions));
    if !whole && inside_clip {
        return None;
    }
    // First the whole scissor (a background reaching past every edge of the target), then the
    // rectangle the triangles tile (a sprite, wherever it lies).
    let centres = [
        f64::from(clip.x0) + 0.5 - MARGIN,
        f64::from(clip.y0) + 0.5 - MARGIN,
        f64::from(clip.x1) - 0.5 + MARGIN,
        f64::from(clip.y1) - 0.5 + MARGIN,
    ];
    let holds_clip =
        gx0 <= centres[0] && gy0 <= centres[1] && gx1 >= centres[2] && gy1 >= centres[3];
    let mut tris_loaded = false;
    let mut covers_clip = false;
    if holds_clip {
        if lc.boundary.is_none() {
            local_tris(list, d, &mut s.local);
            tris_loaded = true;
            lc.boundary = Some(mesh_boundary(&s.local, &mut s.counted, &mut local.boundary));
        }
        if lc.boundary == Some(true) {
            let boundary = &local.boundary;
            // Nothing of the boundary on the scissor: then one point decides.
            if !boundary.iter().any(|e| {
                segment_meets_rect(
                    place(&row.xform, None, e[0]),
                    place(&row.xform, None, e[1]),
                    centres,
                )
            }) {
                if !tris_loaded {
                    local_tris(list, d, &mut s.local);
                    tris_loaded = true;
                }
                covers_clip = mesh_holds(&s.local, boundary, &row.xform, centres, &mut s.screen);
            }
        }
    }
    let rect = if covers_clip {
        clip
    } else {
        if lc.tiled.is_none() {
            if !tris_loaded {
                local_tris(list, d, &mut s.local);
            }
            lc.tiled = Some(tiled_rect(&s.local, &mut s.edges));
        }
        let local_rect = lc.tiled.flatten()?;
        let [x0, y0, x1, y1] = inscribed(&row.xform, local_rect)?;
        // Pixel i is claimed when x0 + M < i + 0.5 < x1 - M.
        let lo = |v: f64| ((v + MARGIN - 0.5).floor() + 1.0).clamp(-1.0e9, 1.0e9) as i32;
        let hi = |v: f64| (v - MARGIN - 0.5).ceil().clamp(-1.0e9, 1.0e9) as i32;
        PxRect {
            x0: lo(x0),
            y0: lo(y0),
            x1: hi(x1),
            y1: hi(y1),
        }
        .intersect(&clip)
    };
    if rect.is_empty() {
        return None;
    }
    if !whole {
        let o = facts.opacity(draw.texture)?;
        // Only when the claim cuts the geometry can it leave out the part of the texture that is
        // not opaque.
        let uncut = f64::from(rect.x0) <= gx0
            && f64::from(rect.y0) <= gy0
            && f64::from(rect.x1) >= gx1
            && f64::from(rect.y1) >= gy1;
        if uncut {
            return None;
        }
        // The texture coordinates the claimed pixel centres can take: each triangle clipped to the
        // centres' rectangle, its texture coordinates at the clipped corners.
        let centres = [
            f64::from(rect.x0) + 0.5,
            f64::from(rect.y0) + 0.5,
            f64::from(rect.x1) - 0.5,
            f64::from(rect.y1) - 0.5,
        ];
        let inside = |q: &[f64; 2]| {
            q[0] >= centres[0] && q[0] <= centres[2] && q[1] >= centres[1] && q[1] <= centres[3]
        };
        let (mut u0, mut v0, mut u1, mut v1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for t in list.indices[index_range(list, draw)].chunks_exact(3) {
            let vs = [t[0], t[1], t[2]].map(|i| list.vertices[i as usize]);
            let p = vs.map(|v| place(&row.xform, None, v.pos));
            let a2 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1])
                - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
            if a2 == 0.0 {
                continue;
            }
            // A finite triangle wholly inside: the clip keeps its corners as they are, where the
            // barycentric weights below come out exactly 1 and 0, so its texture coordinates
            // are the corners' own.
            if a2.is_finite()
                && p.iter().all(|q| inside(q))
                && vs
                    .iter()
                    .all(|v| v.uv[0].is_finite() && v.uv[1].is_finite())
            {
                for v in &vs {
                    let (u, w) = (f64::from(v.uv[0]), f64::from(v.uv[1]));
                    u0 = u0.min(u);
                    v0 = v0.min(w);
                    u1 = u1.max(u);
                    v1 = v1.max(w);
                }
                continue;
            }
            clip_poly(&p, centres, &mut s.poly, &mut s.poly_next);
            for q in &s.poly {
                // Barycentric weights of q.
                let w1 = ((q[0] - p[0][0]) * (p[2][1] - p[0][1])
                    - (q[1] - p[0][1]) * (p[2][0] - p[0][0]))
                    / a2;
                let w2 = ((p[1][0] - p[0][0]) * (q[1] - p[0][1])
                    - (p[1][1] - p[0][1]) * (q[0] - p[0][0]))
                    / a2;
                let w0 = 1.0 - w1 - w2;
                let uv = |k: usize| {
                    w0 * f64::from(vs[0].uv[k])
                        + w1 * f64::from(vs[1].uv[k])
                        + w2 * f64::from(vs[2].uv[k])
                };
                let (u, v) = (uv(0), uv(1));
                u0 = u0.min(u);
                v0 = v0.min(v);
                u1 = u1.max(u);
                v1 = v1.max(v);
            }
        }
        if !(u0.is_finite() && v0.is_finite() && u1.is_finite() && v1.is_finite()) {
            return None;
        }
        let k = crate::downscale_factor(o.width(), o.height(), facts.max_texture_side());
        let region = texel_region(o, draw.sampler, [u0, v0, u1, v1], k);
        if !s.regions.opaque(o, region) {
            return None;
        }
    }
    Some((rect, lc.writes_alpha))
}

/// The walk's result and its reusable scratch.
pub struct CoverWalk {
    /// Draws whose screen bounds on the target cover fewer pixels than this are never analysed as
    /// covers ([`DEFAULT_MIN_COVER_AREA`]; 0 analyses every one).
    pub min_cover_area: u32,
    /// Per draw of the walked list: kept.
    pub keep_draw: Vec<bool>,
    /// Per screen operation of the walked list: kept.
    pub keep_op: Vec<bool>,
    /// Draws and operations dropped, and covers found, by the last [`CoverWalk::run`].
    pub dropped_draws: u32,
    pub dropped_ops: u32,
    pub covers: u32,
    /// The last [`CoverWalk::run`] found the draw table, operations and instanced ranges equal to
    /// the run's before and every answer that run's walk read unchanged, so it kept that run's
    /// `keep_draw` and `keep_op` as they were: a compaction of the same table with them is the
    /// one made then.
    pub reused: bool,
    scratch: Scratch,
    work: Vec<PxRect>,
    next: Vec<PxRect>,
    dead_full: DeadSet,
    dead_rgb: DeadSet,
    live: LiveSet,
    /// Per draw, what the runs learned of it (see [`Memo`]), and the target, minimum area and
    /// largest texture side they learned it under.
    memo: Vec<Option<Memo>>,
    memo_key: (u32, u32, bool, u32, u32),
    /// Counts runs: a memo checked in the run before this one has seen every change up to it.
    serial: u64,
    /// What changed since the last run (buffers kept across runs).
    dirt: Dirt,
    /// The walked table as the last run saw it.
    draws: Vec<Draw>,
    ops: Vec<ScreenOp>,
    instanced: Vec<InstancedDraw>,
    /// Per draw of that table: [`cover_state`] (-1 for None, else whether it writes alpha), while
    /// `class_valid`: a function of the draw, the target and its texture's opacity table.
    class: Vec<i8>,
    class_valid: bool,
    /// Every answer the last full walk read, in order, while `replayable`: the walk depends on the
    /// table and on nothing else, so the same answers replay it decision for decision.
    queries: Vec<Query>,
    replayable: bool,
    /// The region sets [`Answer::Decides`] names, as they stood when the walk read the answer.
    sets: Vec<PxRect>,
    /// [`CoverWalk::compact`]'s scratch.
    new_index: Vec<u32>,
    pending: Vec<ScreenOp>,
}

/// One answer the walk read about draw `draw`.
#[derive(Clone, Copy)]
struct Query {
    draw: u32,
    answer: Answer,
}

#[derive(Clone, Copy, PartialEq)]
enum Answer {
    /// [`CoverWalk::bounds`], read as a value (a group composite's, which joins the live set).
    Bounds(PxRect),
    /// [`CoverWalk::bounds`] read only for one decision: whether [`covered_by`] the dead set
    /// `set` (a range of [`CoverWalk::sets`]) holds it (`hit`), or, for a draw into the back
    /// buffer, whether the live set `set` meets it. The walk before this read is the same, so
    /// the set is too, and other bounds taking the same decision replay it.
    Decides {
        bounds: PxRect,
        set: (u32, u32),
        hit: bool,
    },
    /// [`CoverWalk::cover_of`] (a candidate's; anything else is never a cover, by its table row
    /// and texture alone).
    Cover(Option<(PxRect, bool)>),
    /// Its binding's program facts.
    Program(ProgramFacts),
}

/// One draw's bounds and cover analysis, kept across runs while what they read is unchanged:
/// the draw itself, the indices of its range, the vertices and item rows they name, and its
/// texture's opacity table. A memo checked by the run before this one is trusted where the list's
/// [`crate::Dirty`] ranges and texture operations (the same record an executor uploads from) say
/// nothing it read changed, so [`CoverWalk::run`] must see the list after every change and before
/// [`DrawList::consumed`] forgets them. Any other memo (one the walk did not read for a run, or
/// one in a dirty range) is scanned again and kept only when the scan, its row and its
/// texture's table are equal bit for bit. Builtin, non-instanced draws only.
#[derive(Clone)]
struct Memo {
    draw: Draw,
    /// The [`CoverWalk::serial`] of the run that last checked it.
    seen: u64,
    local: Local,
    /// The row the screen half read, as bit patterns of its transform and modulate alpha (None:
    /// no such row, or several rows).
    row: Option<[u32; 7]>,
    /// The screen half, cleared whenever the draw's row changes.
    bounds: Option<PxRect>,
    cover: Option<Option<(PxRect, bool)>>,
    /// While `raw`: the indices of the draw's range and the bytes of the vertices from the
    /// first to the last they name, as `local` scanned them. Equal bytes (and the same texture
    /// table) give an equal scan without making one.
    raw: bool,
    indices: Vec<u32>,
    vertices: Vec<u8>,
}

/// The longest vertex span, per index, a memo copies ([`Memo::raw`]): a draw naming a few
/// vertices far apart is scanned instead.
const RAW_SPAN_PER_INDEX: usize = 4;

impl Memo {
    /// Whether the draw's indices and vertices are byte for byte what `local` scanned.
    fn raw_same(&self, list: &DrawList) -> bool {
        if !self.raw || list.indices.get(index_range(list, &self.draw)) != Some(&self.indices[..]) {
            return false;
        }
        let (v0, v1) = self.local.verts;
        self.indices.is_empty()
            || list
                .vertices
                .get(v0 as usize..=v1 as usize)
                .is_some_and(|v| bytemuck::cast_slice::<_, u8>(v) == &self.vertices[..])
    }

    /// Copies what `local` scanned ([`Memo::raw`]), when it is one row's and compact enough.
    fn take_raw(&mut self, list: &DrawList) {
        let indices = &list.indices[index_range(list, &self.draw)];
        let (v0, v1) = self.local.verts;
        let span = (v1 as usize + 1).saturating_sub(v0 as usize);
        let vertices = if indices.is_empty() {
            Some(&list.vertices[..0])
        } else {
            list.vertices.get(v0 as usize..=v1 as usize)
        };
        self.raw = false;
        self.indices.clear();
        self.vertices.clear();
        let Some(vertices) = vertices else {
            return;
        };
        if self.local.item.is_none() || span > RAW_SPAN_PER_INDEX * indices.len().max(1) {
            return;
        }
        self.indices.extend_from_slice(indices);
        self.vertices
            .extend_from_slice(bytemuck::cast_slice::<_, u8>(vertices));
        self.raw = true;
    }
}

/// The id of draw `d`'s texture's opacity table, as [`local_of`] records it.
fn opacity_id(list: &DrawList, d: usize, facts: &impl CoverFacts) -> u64 {
    let draw = &list.draws[d];
    if draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE {
        0
    } else {
        facts.opacity(draw.texture).map_or(0, Opacity::id)
    }
}

/// The bit patterns of `local`'s row (see [`Memo::row`]).
fn row_key(list: &DrawList, local: &Local) -> Option<[u32; 7]> {
    let r = list.items.get(local.item? as usize)?;
    let x = r.xform.map(f32::to_bits);
    Some([x[0], x[1], x[2], x[3], x[4], x[5], r.modulate[3].to_bits()])
}

/// What changed since the last run, as sorted half-open ranges.
#[derive(Default)]
struct Dirt {
    items: Spans,
    vertices: Spans,
    indices: Spans,
    textures: Vec<u32>,
}

/// Half-open ranges sorted by start, each with the largest end up to it, so whether any meets
/// `[a, b)` is one binary search (ranges added out of order may overlap).
#[derive(Default)]
struct Spans(Vec<(u32, u32)>);

impl Spans {
    #[cfg(test)]
    fn of(r: &crate::Ranges) -> Spans {
        let mut s = Spans::default();
        s.set(r);
        s
    }

    fn set(&mut self, r: &crate::Ranges) {
        let v = &mut self.0;
        v.clear();
        v.extend_from_slice(r.as_slice());
        v.sort_unstable();
        let mut end = 0;
        for x in v.iter_mut() {
            end = end.max(x.1);
            x.1 = end;
        }
    }

    fn meets(&self, a: u32, b: u32) -> bool {
        let n = self.0.partition_point(|r| r.0 < b);
        n > 0 && self.0[n - 1].1 > a && a < b
    }
}

impl Dirt {
    fn set(&mut self, list: &DrawList) {
        self.textures.clear();
        self.textures
            .extend(list.texture_ops.iter().map(|op| match *op {
                crate::TextureOp::Upload { id, .. }
                | crate::TextureOp::UploadCompressed { id, .. }
                | crate::TextureOp::UploadHalf { id, .. }
                | crate::TextureOp::Free { id }
                | crate::TextureOp::Surface { id, .. } => id,
            }));
        self.textures.sort_unstable();
        self.textures.dedup();
        self.items.set(&list.dirty.items);
        self.vertices.set(&list.dirty.vertices);
        self.indices.set(&list.dirty.indices);
    }

    /// Whether the draw's item rows changed.
    fn touches_rows(&self, m: &Memo) -> bool {
        self.items
            .meets(m.local.rows.0, m.local.rows.1.saturating_add(1))
    }

    /// Whether what the draw's [`Local`] read changed.
    fn touches_local(&self, m: &Memo, draw: &Draw) -> bool {
        self.indices.meets(
            draw.first_index,
            draw.first_index.saturating_add(draw.index_count),
        ) || self
            .vertices
            .meets(m.local.verts.0, m.local.verts.1.saturating_add(1))
            || self.textures.binary_search(&draw.texture).is_ok()
    }
}

/// [`CoverWalk::min_cover_area`]'s default: 64×64 pixels. The text and icons of a UI are many
/// small opaque-looking quads; a cover that small hides little fill and would cost the walk an
/// analysis per glyph.
pub const DEFAULT_MIN_COVER_AREA: u32 = 64 * 64;

impl Default for CoverWalk {
    fn default() -> Self {
        CoverWalk {
            min_cover_area: DEFAULT_MIN_COVER_AREA,
            keep_draw: Vec::new(),
            keep_op: Vec::new(),
            dropped_draws: 0,
            dropped_ops: 0,
            covers: 0,
            reused: false,
            scratch: Scratch::default(),
            work: Vec::new(),
            next: Vec::new(),
            dead_full: DeadSet::default(),
            dead_rgb: DeadSet::default(),
            live: LiveSet::default(),
            memo: Vec::new(),
            memo_key: (0, 0, false, 0, 0),
            serial: 0,
            dirt: Dirt::default(),
            draws: Vec::new(),
            ops: Vec::new(),
            instanced: Vec::new(),
            class: Vec::new(),
            class_valid: false,
            queries: Vec::new(),
            replayable: false,
            sets: Vec::new(),
            new_index: Vec::new(),
            pending: Vec::new(),
        }
    }
}

impl CoverWalk {
    /// Trusts nothing learned until checked again (the next run walks in full, and every memo is
    /// scanned again and kept only where the scan is equal): for a caller that changes the list
    /// without running the walk after it, and after a change the dirty ranges do not itemise.
    pub fn forget(&mut self) {
        // No memo was checked by the run before the next one.
        self.serial += 1;
        self.class_valid = false;
        self.replayable = false;
    }

    /// Draw `d`'s memo, brought up to date (None: not memoised: an item-space program or an
    /// instanced draw).
    fn memo(&mut self, list: &DrawList, d: usize, facts: &impl CoverFacts) -> Option<usize> {
        let draw = &list.draws[d];
        if draw.program != BUILTIN_PROGRAM || draw.flags & DRAW_INSTANCED != 0 {
            return None;
        }
        let serial = self.serial;
        let dirt = &self.dirt;
        let spare = &mut self.scratch.spare;
        match &mut self.memo[d] {
            Some(m) if m.seen == serial && m.draw == *draw => {}
            Some(m) if m.draw == *draw => {
                // Checked by the last run: only this run's dirty ranges can have changed it.
                let trusted = m.seen + 1 == serial;
                if (!trusted || dirt.touches_local(m, draw))
                    && !(m.raw_same(list) && opacity_id(list, d, facts) == m.local.opacity)
                {
                    // A second scan only where the memo made one: both then say the same.
                    local_of(list, d, facts, spare, m.local.cover.is_some());
                    if !spare.same_scan(&m.local) {
                        std::mem::swap(&mut m.local, spare);
                        m.bounds = None;
                        m.cover = None;
                    }
                    m.take_raw(list);
                }
                if (!trusted || dirt.touches_rows(m)) && (m.bounds.is_some() || m.cover.is_some()) {
                    let row = row_key(list, &m.local);
                    if row.is_none() || row != m.row {
                        m.bounds = None;
                        m.cover = None;
                    }
                }
                m.row = row_key(list, &m.local);
                m.seen = serial;
            }
            slot => {
                let m = slot.get_or_insert_with(|| Memo {
                    draw: *draw,
                    seen: serial,
                    local: Local::default(),
                    row: None,
                    bounds: None,
                    cover: None,
                    raw: false,
                    indices: Vec::new(),
                    vertices: Vec::new(),
                });
                m.draw = *draw;
                m.seen = serial;
                local_of(list, d, facts, &mut m.local, false);
                m.row = row_key(list, &m.local);
                m.bounds = None;
                m.cover = None;
                m.take_raw(list);
            }
        }
        Some(d)
    }

    fn bounds(&mut self, list: &DrawList, d: usize, facts: &impl CoverFacts) -> PxRect {
        let Some(k) = self.memo(list, d, facts) else {
            return draw_bounds(list, d, facts);
        };
        let m = self.memo[k].as_mut().expect("memoised");
        if let Some(b) = m.bounds {
            return b;
        }
        let b = bounds_of(list, d, &m.local, facts);
        m.bounds = Some(b);
        b
    }

    /// The cover analysis of draw `d`, a candidate ([`cover_state`] is Some).
    fn cover_of(
        &mut self,
        list: &DrawList,
        d: usize,
        facts: &impl CoverFacts,
    ) -> Option<(PxRect, bool)> {
        let k = self.memo(list, d, facts)?;
        let min_area = i64::from(self.min_cover_area);
        let m = self.memo[k].as_mut().expect("memoised");
        if let Some(c) = m.cover {
            return c;
        }
        let c = cover_rect(list, d, &mut m.local, facts, min_area, &mut self.scratch);
        m.cover = Some(c);
        c
    }

    /// Whether every answer the last full walk read is still the same (see
    /// [`CoverWalk::queries`]). Stops at the first that is not.
    fn replay(&mut self, list: &DrawList, facts: &impl CoverFacts) -> bool {
        let mut queries = std::mem::take(&mut self.queries);
        let same = queries.iter_mut().all(|q| {
            let d = q.draw as usize;
            match &mut q.answer {
                Answer::Bounds(b) => self.bounds(list, d, facts) == *b,
                Answer::Decides { bounds, set, hit } => {
                    let b = self.bounds(list, d, facts);
                    if b == *bounds {
                        return true;
                    }
                    let set = &self.sets[set.0 as usize..(set.0 + set.1) as usize];
                    let now = if list.draws[d].flags & DRAW_TO_BACK_BUFFER != 0 {
                        set.iter().any(|s| s.intersects(&b))
                    } else {
                        covered_by(&b, set, &mut self.work, &mut self.next)
                    };
                    *bounds = b;
                    now == *hit
                }
                Answer::Cover(c) => self.cover_of(list, d, facts) == *c,
                Answer::Program(p) => facts.program(list.draws[d].program - 1) == *p,
            }
        });
        self.queries = queries;
        same
    }

    /// Walks `list` (see the module docs). Returns whether anything was dropped. Call it after
    /// every change to the list and before [`DrawList::consumed`] (its memo reads the dirty
    /// ranges).
    pub fn run(&mut self, list: &DrawList, facts: &impl CoverFacts) -> bool {
        let n = list.draws.len();
        self.serial += 1;
        self.reused = false;
        let key = (
            list.target.width,
            list.target.height,
            list.target.opaque,
            self.min_cover_area,
            facts.max_texture_side(),
        );
        let new_key = key != self.memo_key;
        if new_key {
            self.memo.clear();
            self.memo_key = key;
        }
        if list.dirty.all || new_key {
            self.forget();
        }
        self.memo.resize(n, None);
        self.dirt.set(list);
        if list.draws != self.draws
            || list.screen_ops != self.ops
            || list.instanced != self.instanced
        {
            self.draws.clone_from(&list.draws);
            self.ops.clone_from(&list.screen_ops);
            self.instanced.clone_from(&list.instanced);
            self.class_valid = false;
            self.replayable = false;
        }
        // Whether a draw can cover depends on its texture's opacity table, which only a texture
        // operation changes.
        if !self.dirt.textures.is_empty() {
            self.class_valid = false;
            self.replayable = false;
        }
        if !self.class_valid {
            self.class.clear();
            self.class
                .extend((0..n).map(|d| match cover_state(list, d, facts) {
                    None => -1,
                    Some(w) => i8::from(w),
                }));
            self.class_valid = true;
        }
        if self.replayable && self.keep_draw.len() == n && self.replay(list, facts) {
            self.reused = true;
            return self.dropped_draws > 0 || self.dropped_ops > 0;
        }
        self.queries.clear();
        self.sets.clear();
        self.replayable = true;
        self.keep_draw.clear();
        self.keep_draw.resize(n, true);
        self.keep_op.clear();
        self.keep_op.resize(list.screen_ops.len(), true);
        self.dropped_draws = 0;
        self.dropped_ops = 0;
        self.covers = 0;
        // Nothing can be dropped without a cover; most lists have no candidate at all.
        if !self.class.iter().any(|c| *c >= 0) {
            return false;
        }
        let target = PxRect {
            x0: 0,
            y0: 0,
            x1: list.target.width as i32,
            y1: list.target.height as i32,
        };
        let opaque = list.target.opaque;
        // Dead target pixels: colour (and alpha), and colour alone (opaque targets).
        let mut dead_full = std::mem::take(&mut self.dead_full);
        let mut dead_rgb = std::mem::take(&mut self.dead_rgb);
        let mut live = std::mem::take(&mut self.live);
        dead_full.0.clear();
        dead_rgb.0.clear();
        live.0.clear();
        let mut live_mips = false;
        let mut reader_after = false;
        // Where in `sets` each set stands as it is now (None: changed since last recorded).
        let (mut full_at, mut rgb_at, mut live_at): (
            Option<(u32, u32)>,
            Option<(u32, u32)>,
            Option<(u32, u32)>,
        ) = (None, None, None);
        fn record(
            sets: &mut Vec<PxRect>,
            at: &mut Option<(u32, u32)>,
            set: &[PxRect],
        ) -> (u32, u32) {
            *at.get_or_insert_with(|| {
                let start = sets.len() as u32;
                sets.extend_from_slice(set);
                (start, set.len() as u32)
            })
        }
        let ops = &list.screen_ops;
        let mut next_op = ops.len();
        // Operations past the last draw never run: kept as they are.
        while next_op > 0 && ops[next_op - 1].before as usize >= n {
            next_op -= 1;
        }
        for d in (0..n).rev() {
            let draw = &list.draws[d];
            if draw.index_count > 0 {
                if draw.flags & DRAW_TO_BACK_BUFFER != 0 {
                    let keep = !live.0.is_empty() && {
                        let b = self.bounds(list, d, facts);
                        let hit = live.intersects(&b);
                        let set = record(&mut self.sets, &mut live_at, &live.0);
                        self.queries.push(Query {
                            draw: d as u32,
                            answer: Answer::Decides {
                                bounds: b,
                                set,
                                hit,
                            },
                        });
                        hit
                    };
                    if keep {
                        reader_after = true;
                    } else {
                        self.keep_draw[d] = false;
                    }
                } else {
                    let writes_alpha =
                        !opaque || Blend::from_u32(draw.blend) == Some(Blend::Disabled);
                    let dead = if writes_alpha {
                        &dead_full.0
                    } else {
                        &dead_rgb.0
                    };
                    // Bounds only when something could hide the draw or it reads its own pixels.
                    let composite = draw.program == BUILTIN_PROGRAM
                        && draw.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0;
                    let (bounds, hidden) = if !dead.is_empty() || composite {
                        let b = self.bounds(list, d, facts);
                        let hit = covered_by(&b, dead, &mut self.work, &mut self.next);
                        let answer = if composite {
                            Answer::Bounds(b)
                        } else {
                            let at = if writes_alpha {
                                &mut full_at
                            } else {
                                &mut rgb_at
                            };
                            let set = record(&mut self.sets, at, dead);
                            Answer::Decides {
                                bounds: b,
                                set,
                                hit,
                            }
                        };
                        self.queries.push(Query {
                            draw: d as u32,
                            answer,
                        });
                        (Some(b), hit)
                    } else {
                        (None, false)
                    };
                    if hidden {
                        self.keep_draw[d] = false;
                    } else {
                        if self.class[d] >= 0 {
                            let c = self.cover_of(list, d, facts);
                            self.queries.push(Query {
                                draw: d as u32,
                                answer: Answer::Cover(c),
                            });
                            if let Some((r, full)) = c {
                                self.covers += 1;
                                dead_rgb.add(r);
                                rgb_at = None;
                                if full {
                                    dead_full.add(r);
                                    full_at = None;
                                }
                            }
                        }
                        if composite {
                            if let Some(b) = bounds {
                                live.add(b.grow(1).intersect(&target));
                                live_at = None;
                            }
                            reader_after = true;
                        } else if draw.program != BUILTIN_PROGRAM && {
                            let p = facts.program(draw.program - 1);
                            self.queries.push(Query {
                                draw: d as u32,
                                answer: Answer::Program(p),
                            });
                            p.reads_screen
                        } {
                            live.add(target);
                            live_at = None;
                            live_mips = true;
                            reader_after = true;
                        }
                    }
                }
            }
            // The operations run before this draw, last first.
            while next_op > 0 && ops[next_op - 1].before as usize >= d {
                next_op -= 1;
                let op = &ops[next_op];
                let region = PxRect::xywh(op.region).intersect(&target);
                let keep = match op.kind {
                    ScreenOpKind::Copy => {
                        reader_after || live.intersects(&region) || (op.mipmaps && live_mips)
                    }
                    ScreenOpKind::Clear => reader_after || !live.0.is_empty(),
                    ScreenOpKind::Mipmaps => reader_after || live_mips,
                };
                if !keep {
                    self.keep_op[next_op] = false;
                    continue;
                }
                match op.kind {
                    ScreenOpKind::Copy => {
                        // It reads the target there, and overwrites the back buffer there.
                        dead_full.subtract(&region, &mut self.work);
                        dead_rgb.subtract(&region, &mut self.work);
                        live.subtract(&region, &mut self.work);
                        (full_at, rgb_at, live_at) = (None, None, None);
                        if op.mipmaps && region == target {
                            live_mips = false;
                        }
                    }
                    ScreenOpKind::Clear => {
                        live.0.clear();
                        live_at = None;
                    }
                    ScreenOpKind::Mipmaps => {
                        live.add(region);
                        live_at = None;
                        if region == target {
                            live_mips = false;
                        }
                    }
                }
                reader_after = false;
            }
        }
        self.dead_full = dead_full;
        self.dead_rgb = dead_rgb;
        self.live = live;
        self.dropped_draws = self.keep_draw.iter().filter(|k| !**k).count() as u32;
        self.dropped_ops = self.keep_op.iter().filter(|k| !**k).count() as u32;
        self.dropped_draws > 0 || self.dropped_ops > 0
    }

    /// The walked table without what [`CoverWalk::run`] dropped: kept draws in order (their
    /// [`DRAW_SCREEN_OPS`] flag recomputed), each kept operation before the first kept non-empty
    /// draw at or after its own, and the instanced ranges renumbered.
    pub fn compact(
        &mut self,
        draws: &[Draw],
        ops: &[ScreenOp],
        instanced: &[InstancedDraw],
        out_draws: &mut Vec<Draw>,
        out_ops: &mut Vec<ScreenOp>,
        out_instanced: &mut Vec<InstancedDraw>,
    ) {
        out_draws.clear();
        out_ops.clear();
        out_instanced.clear();
        let mut new_index = std::mem::take(&mut self.new_index);
        new_index.clear();
        new_index.resize(draws.len(), u32::MAX);
        let mut pending = std::mem::take(&mut self.pending);
        pending.clear();
        let mut next_op = 0usize;
        for (d, draw) in draws.iter().enumerate() {
            while next_op < ops.len() && ops[next_op].before as usize <= d {
                if self.keep_op.get(next_op).copied().unwrap_or(true) {
                    pending.push(ops[next_op]);
                }
                next_op += 1;
            }
            if !self.keep_draw.get(d).copied().unwrap_or(true) {
                continue;
            }
            let at = out_draws.len() as u32;
            new_index[d] = at;
            let mut kept = *draw;
            kept.flags &= !DRAW_SCREEN_OPS;
            if !pending.is_empty() && kept.index_count > 0 {
                kept.flags |= DRAW_SCREEN_OPS;
                for mut o in pending.drain(..) {
                    o.before = at;
                    out_ops.push(o);
                }
            }
            out_draws.push(kept);
        }
        // Kept operations with no kept draw after them never run (as before the walk).
        for (k, op) in ops.iter().enumerate().skip(next_op) {
            if self.keep_op.get(k).copied().unwrap_or(true) {
                pending.push(*op);
            }
        }
        for mut o in pending.drain(..) {
            o.before = out_draws.len() as u32;
            out_ops.push(o);
        }
        for r in instanced {
            if let Some(&at) = new_index.get(r.draw as usize) {
                if at != u32::MAX {
                    out_instanced.push(InstancedDraw { draw: at, ..*r });
                }
            }
        }
        self.new_index = new_index;
        self.pending = pending;
    }
}

pub mod oracle;

#[cfg(test)]
mod tests;
