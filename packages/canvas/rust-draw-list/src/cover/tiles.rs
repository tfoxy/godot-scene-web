//! The cover walk's tile half: where a later draw overwrites only PART of what an earlier draw
//! touches, the walk keeps the earlier draw (it drops whole draws only), yet its fragments under
//! the later one change nothing that is ever seen. [`TileWalk`] finds the cells of a
//! [`TILE`]-pixel grid on the target that a draw overwrites (its tiles), and the earlier draws
//! worth depth-testing against them, as [`DrawList::depth_tiles`] and [`DrawList::depth_draws`].
//! An executor that honours them rejects those fragments; one that ignores them paints the same
//! pixels.
//!
//! **A tile** of draw `e` (its owner) is a grid cell, clipped to the target, whose every pixel `e`
//! overwrites by the cover rules of the module docs, applied to the cell instead of a rectangle
//! the triangles tile:
//! - the owner's state is a cover's ([`super::cover_state`]: the builtin program; not MSDF,
//!   instanced or a group draw; [`crate::Blend::Disabled`], or mix / premultiplied alpha with every
//!   vertex colour alpha and the item modulate alpha at least 1), over one item row;
//! - the cell lies inside its scissor;
//! - the cell's pixel centres, grown by [`MARGIN`] (and by [`DRIFT`], below), meet no boundary edge
//!   of its consistently oriented mesh ([`super::mesh_boundary`]), and one point of the connected
//!   run of such cells lies inside a triangle: the triangle count changes only across boundary
//!   edges, so the whole run is inside, and a rasterizer covers each of its pixel centres exactly
//!   as the cover rule requires (shared edges bit-identical, so watertight);
//! - every texel the grown cell can sample is opaque: each triangle meeting it is clipped to it,
//!   its texture coordinates taken at the clipped corners, and the filter footprint of their
//!   bounds ([`super::texel_region`], the reduced-texture rule included) read in the texture's
//!   opacity table. A white or untextured owner, or one whose whole texture coordinate range is
//!   opaque, skips this.
//!
//! Such a fragment leaves the source colour whatever the destination held: mix and premultiplied
//! alpha with a source alpha of 1 are `src + dst·0` (GL clamps the alpha of a unorm target's
//! fragment to 1 before blending), and disabled blending writes the source. On a
//! [`crate::Target::opaque`] target mix keeps the destination alpha, so a draw that writes alpha
//! there ([`crate::Blend::Disabled`]) is never tested; on a transparent target every owner writes
//! alpha 1 too.
//!
//! **Which draws are tested.** A depth buffer holds only within one target pass, so only draws
//! before the list's first [`DRAW_SCREEN_OPS`] or [`DRAW_TO_BACK_BUFFER`] draw (the window) are
//! listed: of the builtin program, neither MSDF nor a group draw. An owner may lie anywhere after
//! a tested draw, but a back-buffer copy between them reads the target in its region, so an
//! owner's cell meeting the region of a copy at or before it is not its tile (every tested draw
//! precedes every copy). Nothing else reads the target: screen readers and group owners read the
//! back buffer.
//!
//! **Levels.** Owners are numbered in paint order from 1 ([`crate::MAX_DEPTH_LEVEL`] at most). A
//! cell's level is that of its last owner (the highest), and a tested draw's level is the number of
//! owners at or before it, so a draw is rejected at a cell exactly when an owner after it
//! overwrites the cell. A draw is listed only when such cells hide at least
//! [`TileWalk::min_hidden_px`] of its bounds (counting the cells wholly inside them), and only cells
//! hiding a listed draw are emitted
//! (others reject nothing), merged into rectangles.
//!
//! **Cost.** An owner's tiles are kept across runs while its state, topology, texture
//! coordinates, colour alphas, rows and texture's opacity table are equal, no triangle's
//! orientation flipped, and every vertex is placed within its slack (per axis) of where it was
//! classified: every point of a triangle then moved by less than the slack (a convex combination
//! of its vertices' moves), so the boundary never crossed a pixel centre the grown test cleared
//! (vertex records that shared a position must still share it bit for bit: the boundary cancels
//! an edge between them by position, and their separating would open an untested seam),
//! the triangle count there is unchanged, and the texture coordinates a pixel centre now takes
//! are ones the triangle took inside the grown cell. The slack starts at [`DRIFT`] and doubles,
//! up to [`MAX_DRIFT`], for an owner classified again soon after its last classification (a
//! wobbling mesh), at a small cost in cells, and halves for one that held eight times as long. An
//! owner that moves past its memo in consecutive runs (animated) claims nothing until it holds
//! still for a few runs: cells found for a frame it leaves at once would hide nothing.

use super::{
    clip_poly, clip_rect, cover_state_of, draw_bounds, far, index_range, local_of, local_tris,
    mesh_boundary, place, segment_meets_rect, texel_region, whole_opaque, CoverFacts, Local,
    PxRect, Scratch, MARGIN,
};
use crate::{
    Blend, DepthDraw, DepthTile, Draw, DrawList, ScreenOpKind, BUILTIN_PROGRAM, DRAW_GROUP_CLIP,
    DRAW_GROUP_COMPOSITE, DRAW_MSDF, DRAW_SCREEN_OPS, DRAW_TO_BACK_BUFFER, DRAW_UNTEXTURED,
    MAX_DEPTH_LEVEL, WHITE_TEXTURE,
};

/// The grid's cell edge in target pixels.
pub const TILE: i32 = 32;

/// Slack, in pixels, every cell is tested with beyond [`MARGIN`] (at least; see the module docs):
/// an owner whose vertices moved by less than its slack per axis keeps its tiles.
pub const DRIFT: f64 = 1.0;

/// The largest slack an often re-classified owner is tested with.
pub const MAX_DRIFT: f64 = 8.0;

/// An owner classified again within this many runs of its last classification doubles its slack;
/// one held for eight times as long halves it.
const SOON: u64 = 32;

/// Runs a memo no run asked for is kept.
const KEEP: u64 = 64;

/// Runs an animated owner must hold still before it is classified again.
pub(crate) const STILL: u32 = 4;

/// [`TileWalk::min_hidden_px`]'s default.
pub const DEFAULT_MIN_HIDDEN_PX: u32 = 4096;

/// What one owner's classification read, and the cells it claimed: kept while every vertex stays
/// within [`DRIFT`] of where it was placed then (see the module docs).
struct OwnerMemo {
    /// The draw's state, its first index aside (a change earlier in the list moves it).
    draw: Draw,
    /// Per index: its offset from the range's lowest index (the topology).
    rel: Vec<u32>,
    /// Per index: its vertex's texture coordinate and colour alpha bits, and its row.
    attrs: Vec<[u32; 4]>,
    /// Per index: its vertex placed by its row when classified.
    placed: Vec<[f64; 2]>,
    /// Per index: the first index whose vertex had a bit-identical local position. The boundary
    /// cancels an edge between distinct vertex records by position, so such coincidences must
    /// stay: separated copies would open a seam the classification never tested.
    twin: Vec<u32>,
    /// Per triangle: the sign of its placed area when classified.
    signs: Vec<i8>,
    opacity: u64,
    /// Claimed cells (`cy · grid width + cx`), ascending, while `valid`: a backed-off owner keeps
    /// only where it was placed (its cells, of an older placement, stand for nothing).
    cells: Vec<u32>,
    valid: bool,
    /// Consecutive runs in which the owner moved past its memo.
    misses: u32,
    /// The slack its cells were classified with, and the run that classified them.
    drift: f64,
    born: u64,
    /// While not `valid`: consecutive runs it held still.
    still: u32,
}

/// The memo key of owner `e`: its texture, index count and every indexed texture coordinate,
/// hashed. Two owners alike share a memo, which [`OwnerMemo::holds`] tells apart (costing a
/// classification, never a wrong cell).
fn owner_key(list: &DrawList, e: usize) -> u64 {
    let d = &list.draws[e];
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |v: u32| {
        h ^= u64::from(v);
        h = h.wrapping_mul(0x0100_0000_01b3);
    };
    mix(d.texture);
    mix(d.index_count);
    for &i in &list.indices[index_range(list, d)] {
        if let Some(v) = list.vertices.get(i as usize) {
            mix(v.uv[0].to_bits());
            mix(v.uv[1].to_bits());
        }
    }
    h
}

/// Draw `d`'s state with its first index cleared.
fn state_of(d: &Draw) -> Draw {
    Draw {
        first_index: 0,
        ..*d
    }
}

fn opacity_of(list: &DrawList, e: usize, facts: &impl CoverFacts) -> u64 {
    facts.opacity(list.draws[e].texture).map_or(0, |o| o.id())
}

/// The placed position of every index of draw `e`, by its vertex's row (None: a missing vertex,
/// or a term past [`super::FAR`]).
fn placed_of(list: &DrawList, e: usize, out: &mut Vec<[f64; 2]>) -> bool {
    out.clear();
    for &i in &list.indices[index_range(list, &list.draws[e])] {
        let Some(v) = list.vertices.get(i as usize) else {
            return false;
        };
        let x = list
            .items
            .get(v.item as usize)
            .map_or(super::IDENTITY, |r| r.xform);
        if far(&x, None, v.pos) {
            return false;
        }
        out.push(place(&x, None, v.pos));
    }
    true
}

/// The sign of each placed triangle's area.
fn signs_of(placed: &[[f64; 2]]) -> impl Iterator<Item = i8> + '_ {
    placed.chunks_exact(3).map(|t| {
        let a2 =
            (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]);
        if a2 > 0.0 {
            1
        } else if a2 < 0.0 {
            -1
        } else {
            0
        }
    })
}

impl OwnerMemo {
    fn of(
        list: &DrawList,
        e: usize,
        facts: &impl CoverFacts,
        cells: Vec<u32>,
        misses: u32,
        (drift, born): (f64, u64),
    ) -> Option<OwnerMemo> {
        let mut m = OwnerMemo {
            draw: Draw::default(),
            rel: Vec::new(),
            attrs: Vec::new(),
            placed: Vec::new(),
            twin: Vec::new(),
            signs: Vec::new(),
            opacity: 0,
            cells,
            valid: true,
            misses,
            drift,
            born,
            still: 0,
        };
        m.refill(list, e, facts).then_some(m)
    }

    /// Takes draw `e` as `list` has it now (its cells, slack and counters untouched). False: a
    /// missing vertex or a term past [`super::FAR`].
    fn refill(&mut self, list: &DrawList, e: usize, facts: &impl CoverFacts) -> bool {
        let draw = &list.draws[e];
        let indices = &list.indices[index_range(list, draw)];
        let min = indices.iter().copied().min().unwrap_or(0);
        if !placed_of(list, e, &mut self.placed) {
            return false;
        }
        self.draw = state_of(draw);
        self.rel.clear();
        self.rel.extend(indices.iter().map(|i| i - min));
        self.attrs.clear();
        self.attrs.extend(indices.iter().map(|&i| {
            let v = &list.vertices[i as usize];
            [
                v.uv[0].to_bits(),
                v.uv[1].to_bits(),
                v.color[3].to_bits(),
                v.item,
            ]
        }));
        self.twin.clear();
        let mut first: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();
        for (k, &i) in indices.iter().enumerate() {
            let p = list.vertices[i as usize].pos;
            let key = (u64::from(p[0].to_bits()) << 32) | u64::from(p[1].to_bits());
            self.twin.push(*first.entry(key).or_insert(k as u32));
        }
        self.signs.clear();
        self.signs.extend(signs_of(&self.placed));
        self.opacity = opacity_of(list, e, facts);
        true
    }

    /// Whether the memo's cells still hold for draw `e` as `list` has it: the same state,
    /// topology, texture coordinates, colour alphas and rows, the texture's same opacity table,
    /// every vertex placed within its slack of where it was (per axis, strictly), no triangle's
    /// orientation changed, and (cells claimed) the row's modulate still opaque.
    fn holds(&self, list: &DrawList, e: usize, facts: &impl CoverFacts) -> bool {
        let draw = &list.draws[e];
        let indices = &list.indices[index_range(list, draw)];
        if state_of(draw) != self.draw
            || indices.len() != self.rel.len()
            || opacity_of(list, e, facts) != self.opacity
        {
            return false;
        }
        let min = indices.iter().copied().min().unwrap_or(0);
        let mut sign_at = 0usize;
        let mut tri = [[0.0f64; 2]; 3];
        for (k, &i) in indices.iter().enumerate() {
            let Some(v) = list.vertices.get(i as usize) else {
                return false;
            };
            if i - min != self.rel[k]
                || [
                    v.uv[0].to_bits(),
                    v.uv[1].to_bits(),
                    v.color[3].to_bits(),
                    v.item,
                ] != self.attrs[k]
            {
                return false;
            }
            let twin = self.twin[k] as usize;
            if twin != k {
                let Some(t) = list.vertices.get(indices[twin] as usize) else {
                    return false;
                };
                if t.pos.map(f32::to_bits) != v.pos.map(f32::to_bits) {
                    return false;
                }
            }
            let Some(row) = list.items.get(v.item as usize) else {
                return false;
            };
            if far(&row.xform, None, v.pos) {
                return false;
            }
            let p = place(&row.xform, None, v.pos);
            let q = self.placed[k];
            if !((p[0] - q[0]).abs() < self.drift && (p[1] - q[1]).abs() < self.drift) {
                return false;
            }
            if self.valid
                && !self.cells.is_empty()
                && draw.blend != Blend::Disabled as u32
                && !super::opaque_alpha(row.modulate[3])
            {
                return false;
            }
            tri[k % 3] = p;
            if k % 3 == 2 {
                let sign = signs_of(&tri).next().unwrap_or(0);
                if sign != self.signs[sign_at]
                    || (sign == 0 && self.valid && !self.cells.is_empty())
                {
                    return false;
                }
                sign_at += 1;
            }
        }
        true
    }
}

/// The tile half's result and its reusable state.
pub struct TileWalk {
    /// Owners whose bounds on the target cover fewer pixels than this are never classified
    /// (the cover walk's [`super::CoverWalk::min_cover_area`]).
    pub min_cover_area: u32,
    /// A draw is listed only when its tiles would hide at least this many of its pixels.
    pub min_hidden_px: u32,
    /// The last [`TileWalk::run`]'s tables (empty together).
    pub tiles: Vec<DepthTile>,
    pub draws: Vec<DepthDraw>,
    /// Per level (index `level - 1`): the owner's draw index.
    pub owners: Vec<u32>,
    /// Owners with a level, draws listed, and the pixels the tiles hide of them (counting the
    /// cells wholly inside each listed draw's bounds).
    pub covers: u32,
    pub tested: u32,
    pub hidden_px: u64,
    /// Owners classified afresh by the last run (the rest reused their memo).
    pub classified: u32,
    /// Per owner, by [`owner_key`] (its texture, index count and texture coordinates, which
    /// survive a re-assembly and a whole-draw walk's compaction, while its position and index range
    /// move): what its last classification found, and the run that last
    /// asked (memos not asked for [`KEEP`] runs are dropped).
    memo: std::collections::HashMap<u64, (u64, OwnerMemo)>,
    serial: u64,
    memo_key: (u32, u32, bool, u32, u32),
    scratch: Scratch,
    local: Local,
    edges: Vec<[[f64; 2]; 2]>,
    /// Per inside cell of a classification, the triangles whose bounds reach it (CSR).
    bucket_start: Vec<u32>,
    bucket: Vec<u32>,
    state: Vec<u8>,
    stack: Vec<usize>,
    cells: Vec<u32>,
    level: Vec<u16>,
    needed: Vec<bool>,
    bounds: Vec<(u32, PxRect)>,
    /// Per window draw of `bounds`: the cells wholly inside its bounds and the cells meeting them,
    /// `[i0, i1, j0, j1]` each (half-open), which is all the choice reads of the bounds.
    ranges: Vec<(u32, [i32; 8])>,
    /// Per cell: its area (cells at the target's right and bottom edges are cut).
    areas: Vec<i64>,
    /// The last run's choice of tested draws and tiles, and what it was made from (the cell
    /// levels, the window's draws and bounds, the owners and their levels): equal inputs, equal
    /// choice.
    prev: Option<Prev>,
}

struct Prev {
    level: Vec<u16>,
    ranges: Vec<(u32, [i32; 8])>,
    owners: Vec<(u32, u16)>,
    min_hidden_px: u32,
    tiles: Vec<DepthTile>,
    draws: Vec<DepthDraw>,
    hidden_px: u64,
}

impl Default for TileWalk {
    fn default() -> Self {
        TileWalk {
            min_cover_area: super::DEFAULT_MIN_COVER_AREA,
            min_hidden_px: DEFAULT_MIN_HIDDEN_PX,
            tiles: Vec::new(),
            draws: Vec::new(),
            owners: Vec::new(),
            covers: 0,
            tested: 0,
            hidden_px: 0,
            classified: 0,
            memo: std::collections::HashMap::new(),
            serial: 0,
            memo_key: (0, 0, false, 0, 0),
            scratch: Scratch::default(),
            local: Local::default(),
            edges: Vec::new(),
            bucket_start: Vec::new(),
            bucket: Vec::new(),
            state: Vec::new(),
            stack: Vec::new(),
            cells: Vec::new(),
            level: Vec::new(),
            needed: Vec::new(),
            bounds: Vec::new(),
            ranges: Vec::new(),
            areas: Vec::new(),
            prev: None,
        }
    }
}

/// The grid's width and height in cells.
fn grid(list: &DrawList) -> (i32, i32) {
    let (w, h) = (list.target.width as i32, list.target.height as i32);
    ((w + TILE - 1) / TILE, (h + TILE - 1) / TILE)
}

/// Cell `(cx, cy)` clipped to the target.
fn cell_rect(list: &DrawList, cx: i32, cy: i32) -> PxRect {
    PxRect {
        x0: cx * TILE,
        y0: cy * TILE,
        x1: (cx * TILE + TILE).min(list.target.width as i32),
        y1: (cy * TILE + TILE).min(list.target.height as i32),
    }
}

/// The first draw an executor cannot depth-test through (see the module docs): every listed draw
/// precedes it.
pub fn window_end(list: &DrawList) -> usize {
    list.draws
        .iter()
        .position(|d| d.flags & (DRAW_SCREEN_OPS | DRAW_TO_BACK_BUFFER) != 0)
        .unwrap_or(list.draws.len())
}

/// Whether draw `d` (inside the window) may be depth-tested.
pub fn testable(list: &DrawList, d: usize) -> bool {
    let draw = &list.draws[d];
    draw.index_count >= 3
        && draw.program == BUILTIN_PROGRAM
        && draw.flags & (DRAW_MSDF | DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE | DRAW_TO_BACK_BUFFER)
            == 0
        && match Blend::from_u32(draw.blend) {
            None => false,
            Some(Blend::Disabled) => !list.target.opaque,
            Some(_) => true,
        }
}

/// The pixel-centre rectangle of `cell` grown by `grow`.
fn grown(cell: &PxRect, grow: f64) -> [f64; 4] {
    [
        f64::from(cell.x0) + 0.5 - grow,
        f64::from(cell.y0) + 0.5 - grow,
        f64::from(cell.x1) - 0.5 + grow,
        f64::from(cell.y1) - 0.5 + grow,
    ]
}

/// Whether `r` lies inside the mesh of placed triangles `screen`, read at one probe point well
/// clear of every edge (None: every probe lies near one). Only meaningful where no boundary edge
/// meets the region the answer stands for.
fn probe_inside(screen: &[[[f64; 2]; 3]], r: [f64; 4]) -> Option<bool> {
    for (fx, fy) in [
        (0.5, 0.5),
        (0.3141, 0.7183),
        (0.8862, 0.2236),
        (0.1732, 0.4142),
    ] {
        let p = [r[0] + (r[2] - r[0]) * fx, r[1] + (r[3] - r[1]) * fy];
        let mut inside = false;
        let mut near = false;
        for t in screen {
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
            return Some(inside);
        }
    }
    None
}

impl TileWalk {
    /// Forget every owner's memo (the next run classifies afresh).
    pub fn forget(&mut self) {
        self.memo.clear();
        self.prev = None;
    }

    /// The cells draw `e` overwrites, tested grown by `drift` beyond [`MARGIN`], into `out`
    /// (ascending). Returns the row's linear part and origin when the draw is an owner candidate
    /// at all (the memo's anchor), else None (and `out` empty).
    fn classify(
        &mut self,
        list: &DrawList,
        e: usize,
        facts: &impl CoverFacts,
        drift: f64,
        out: &mut Vec<u32>,
    ) -> Option<([u32; 4], [f64; 2])> {
        out.clear();
        let draw = &list.draws[e];
        cover_state_of(draw, list.target.opaque, || facts.opacity(draw.texture))?;
        let local = &mut self.local;
        local_of(list, e, facts, local, true);
        let item = local.item?;
        let lc = local.cover.and_then(|c| c)?;
        let row = list.items.get(item as usize)?;
        let needs_alpha = draw.blend != Blend::Disabled as u32;
        if needs_alpha && !super::opaque_alpha(row.modulate[3]) {
            return None;
        }
        let x = row.xform;
        let anchor = (
            [
                x[0].to_bits(),
                x[1].to_bits(),
                x[2].to_bits(),
                x[3].to_bits(),
            ],
            [f64::from(x[4]), f64::from(x[5])],
        );
        let clip = clip_rect(list, draw);
        if clip.is_empty() {
            return Some(anchor);
        }
        let [lx0, ly0, lx1, ly1] = local.lbox;
        let corners = [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]];
        if corners.iter().any(|p| far(&x, None, *p)) {
            return Some(anchor);
        }
        let placed = corners.map(|p| place(&x, None, p));
        let gx0 = placed.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
        let gx1 = placed.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        let gy0 = placed.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
        let gy1 = placed.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
        let (sx0, sx1) = (gx0.max(f64::from(clip.x0)), gx1.min(f64::from(clip.x1)));
        let (sy0, sy1) = (gy0.max(f64::from(clip.y0)), gy1.min(f64::from(clip.y1)));
        if !(sx1 > sx0 && sy1 > sy0) || (sx1 - sx0) * (sy1 - sy0) < f64::from(self.min_cover_area) {
            return Some(anchor);
        }
        let s = &mut self.scratch;
        local_tris(list, e, &mut s.local);
        if !mesh_boundary(&s.local, &mut s.counted, &mut local.boundary) {
            return Some(anchor);
        }
        let white = draw.flags & DRAW_UNTEXTURED != 0 || draw.texture == WHITE_TEXTURE;
        let opacity = if white {
            None
        } else {
            facts.opacity(draw.texture)
        };
        let whole = !needs_alpha
            || white
            || opacity.is_some_and(|o| o.all())
            || whole_opaque(draw, lc.uv, facts, &mut s.regions);
        if !whole && opacity.is_none() {
            return Some(anchor);
        }
        s.screen.clear();
        s.screen
            .extend(s.local.iter().map(|t| t.map(|p| place(&x, None, p))));
        self.edges.clear();
        self.edges.extend(
            local
                .boundary
                .iter()
                .map(|e| [place(&x, None, e[0]), place(&x, None, e[1])]),
        );
        // The candidate cells: inside the scissor and the placed bounds.
        let (gw, _) = grid(list);
        let cx0 = (sx0.floor() as i32).div_euclid(TILE).max(0);
        let cy0 = (sy0.floor() as i32).div_euclid(TILE).max(0);
        let cx1 = ((sx1.ceil() as i32 + TILE - 1) / TILE).min(gw);
        let cy1 = ((sy1.ceil() as i32 + TILE - 1) / TILE).min(grid(list).1);
        if cx1 <= cx0 || cy1 <= cy0 {
            return Some(anchor);
        }
        let (nx, ny) = ((cx1 - cx0) as usize, (cy1 - cy0) as usize);
        let g = MARGIN + drift;
        // 0 not a candidate, 1 candidate, 2 blocked by a boundary edge, 3 inside, 4 outside.
        let state = &mut self.state;
        state.clear();
        state.resize(nx * ny, 0);
        for j in 0..ny {
            for i in 0..nx {
                let c = cell_rect(list, cx0 + i as i32, cy0 + j as i32);
                if !c.is_empty() && clip.contains(&c) {
                    state[j * nx + i] = 1;
                }
            }
        }
        let reach = g + 1.0;
        for [a, b] in &self.edges {
            let (ex0, ex1) = (a[0].min(b[0]) - reach, a[0].max(b[0]) + reach);
            let (ey0, ey1) = (a[1].min(b[1]) - reach, a[1].max(b[1]) + reach);
            let i0 = ((ex0.floor() as i32).div_euclid(TILE) - cx0).max(0) as usize;
            let j0 = ((ey0.floor() as i32).div_euclid(TILE) - cy0).max(0) as usize;
            let i1 = ((ex1.floor() as i32).div_euclid(TILE) - cx0 + 1).clamp(0, nx as i32) as usize;
            let j1 = ((ey1.floor() as i32).div_euclid(TILE) - cy0 + 1).clamp(0, ny as i32) as usize;
            for j in j0..j1 {
                for i in i0..i1 {
                    let k = j * nx + i;
                    if state[k] == 1 {
                        let c = cell_rect(list, cx0 + i as i32, cy0 + j as i32);
                        if segment_meets_rect(*a, *b, grown(&c, g)) {
                            state[k] = 2;
                        }
                    }
                }
            }
        }
        // Each 4-connected run of unblocked candidates: one probe decides it, as long as their
        // grown rectangles overlap (beyond half a pixel of growth), so the run's union is
        // connected and meets no boundary edge. With less, an edge may pass between two cells:
        // each cell is probed on its own.
        let connected = g > 0.5;
        let stack = &mut self.stack;
        for start in 0..nx * ny {
            if state[start] != 1 {
                continue;
            }
            let c = cell_rect(list, cx0 + (start % nx) as i32, cy0 + (start / nx) as i32);
            let verdict = if probe_inside(&s.screen, grown(&c, g)) == Some(true) {
                3
            } else {
                4
            };
            stack.clear();
            stack.push(start);
            state[start] = verdict;
            while let Some(k) = stack.pop().filter(|_| connected) {
                let (i, j) = (k % nx, k / nx);
                let mut visit = |k2: usize| {
                    if state[k2] == 1 {
                        state[k2] = verdict;
                        stack.push(k2);
                    }
                };
                if i > 0 {
                    visit(k - 1);
                }
                if i + 1 < nx {
                    visit(k + 1);
                }
                if j > 0 {
                    visit(k - nx);
                }
                if j + 1 < ny {
                    visit(k + nx);
                }
            }
        }
        if !state.contains(&3) {
            return Some(anchor);
        }
        // The texels: per inside cell, the triangles whose bounds reach it.
        let (starts, bucket) = (&mut self.bucket_start, &mut self.bucket);
        if !whole {
            starts.clear();
            starts.resize(nx * ny + 1, 0);
            let cells_of = |t: &[[f64; 2]; 3]| {
                let tx0 = t.iter().map(|p| p[0]).fold(f64::MAX, f64::min) - reach;
                let tx1 = t.iter().map(|p| p[0]).fold(f64::MIN, f64::max) + reach;
                let ty0 = t.iter().map(|p| p[1]).fold(f64::MAX, f64::min) - reach;
                let ty1 = t.iter().map(|p| p[1]).fold(f64::MIN, f64::max) + reach;
                let i0 = ((tx0.floor() as i32).div_euclid(TILE) - cx0).max(0) as usize;
                let i1 =
                    ((tx1.floor() as i32).div_euclid(TILE) - cx0 + 1).clamp(0, nx as i32) as usize;
                let j0 = ((ty0.floor() as i32).div_euclid(TILE) - cy0).max(0) as usize;
                let j1 =
                    ((ty1.floor() as i32).div_euclid(TILE) - cy0 + 1).clamp(0, ny as i32) as usize;
                (i0, i1, j0, j1)
            };
            for t in s.screen.iter() {
                let (i0, i1, j0, j1) = cells_of(t);
                for j in j0..j1 {
                    for i in i0..i1 {
                        if state[j * nx + i] == 3 {
                            starts[j * nx + i + 1] += 1;
                        }
                    }
                }
            }
            for k in 0..nx * ny {
                starts[k + 1] += starts[k];
            }
            bucket.clear();
            bucket.resize(starts[nx * ny] as usize, 0);
            let mut fill: Vec<u32> = starts[..nx * ny].to_vec();
            for (ti, t) in s.screen.iter().enumerate() {
                let (i0, i1, j0, j1) = cells_of(t);
                for j in j0..j1 {
                    for i in i0..i1 {
                        let k = j * nx + i;
                        if state[k] == 3 {
                            bucket[fill[k] as usize] = ti as u32;
                            fill[k] += 1;
                        }
                    }
                }
            }
        }
        let k = opacity.map_or(1, |o| {
            crate::downscale_factor(o.width(), o.height(), facts.max_texture_side())
        });
        for j in 0..ny {
            for i in 0..nx {
                if state[j * nx + i] != 3 {
                    continue;
                }
                let (cx, cy) = (cx0 + i as i32, cy0 + j as i32);
                if !whole {
                    let o = opacity.expect("checked");
                    let r = grown(&cell_rect(list, cx, cy), g);
                    let (mut u0, mut v0, mut u1, mut v1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                    let tris = &list.indices[index_range(list, draw)];
                    let at = j * nx + i;
                    for &ti in &bucket[starts[at] as usize..starts[at + 1] as usize] {
                        let p = s.screen[ti as usize];
                        let tx0 = p.iter().map(|q| q[0]).fold(f64::MAX, f64::min);
                        let tx1 = p.iter().map(|q| q[0]).fold(f64::MIN, f64::max);
                        let ty0 = p.iter().map(|q| q[1]).fold(f64::MAX, f64::min);
                        let ty1 = p.iter().map(|q| q[1]).fold(f64::MIN, f64::max);
                        if tx1 < r[0] || tx0 > r[2] || ty1 < r[1] || ty0 > r[3] {
                            continue;
                        }
                        let a2 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1])
                            - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
                        if a2 == 0.0 {
                            continue;
                        }
                        let base = 3 * ti as usize;
                        let vs = [0, 1, 2].map(|q| list.vertices[tris[base + q] as usize]);
                        // The cell's corners against each edge (positive inside): all outside one
                        // edge, the triangle misses the cell; inside every edge, the cell lies in
                        // the triangle and its corners are the clipped polygon.
                        let corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
                        let mut inside = true;
                        let mut misses = false;
                        for k in 0..3 {
                            let (a, b) = (p[k], p[(k + 1) % 3]);
                            let side = |q: &[f64; 2]| {
                                a2.signum()
                                    * ((b[0] - a[0]) * (q[1] - a[1])
                                        - (b[1] - a[1]) * (q[0] - a[0]))
                            };
                            let d = corners.map(|q| side(&q));
                            inside &= d.iter().all(|v| *v >= 0.0);
                            misses |= d.iter().all(|v| *v < 0.0);
                        }
                        if misses {
                            continue;
                        }
                        if inside {
                            s.poly.clear();
                            s.poly.extend_from_slice(&corners);
                        } else {
                            clip_poly(&p, r, &mut s.poly, &mut s.poly_next);
                        }
                        for q in &s.poly {
                            let w1 = ((q[0] - p[0][0]) * (p[2][1] - p[0][1])
                                - (q[1] - p[0][1]) * (p[2][0] - p[0][0]))
                                / a2;
                            let w2 = ((p[1][0] - p[0][0]) * (q[1] - p[0][1])
                                - (p[1][1] - p[0][1]) * (q[0] - p[0][0]))
                                / a2;
                            let w0 = 1.0 - w1 - w2;
                            let uv = |c: usize| {
                                w0 * f64::from(vs[0].uv[c])
                                    + w1 * f64::from(vs[1].uv[c])
                                    + w2 * f64::from(vs[2].uv[c])
                            };
                            let (u, v) = (uv(0), uv(1));
                            u0 = u0.min(u);
                            v0 = v0.min(v);
                            u1 = u1.max(u);
                            v1 = v1.max(v);
                        }
                    }
                    if !(u0.is_finite() && v0.is_finite() && u1.is_finite() && v1.is_finite()) {
                        continue;
                    }
                    // (Each cell reads its own rectangle: no point caching the verdicts.)
                    let region = texel_region(o, draw.sampler, [u0, v0, u1, v1], k);
                    if !o.region(region[0], region[1], region[2], region[3]) {
                        continue;
                    }
                }
                out.push((cy * gw + cx) as u32);
            }
        }
        out.sort_unstable();
        Some(anchor)
    }

    /// Whether owner `e` claims its memo's cells this run (the caller then reads
    /// `self.memo[e]`). A memo still holding (see the module docs) answers; else the owner is
    /// classified afresh, unless it also moved past its memo in the run before: an animated owner
    /// claims nothing, is re-placed in its memo only, and is classified once it holds still for
    /// [`STILL`] runs.
    fn owner_cells(
        &mut self,
        list: &DrawList,
        e: usize,
        facts: &impl CoverFacts,
        union: &PxRect,
        key: u64,
    ) -> bool {
        let serial = self.serial;
        let (misses, last) = match self.memo.get_mut(&key) {
            Some((seen, m)) if m.holds(list, e, facts) => {
                *seen = serial;
                if m.valid {
                    m.misses = 0;
                    return true;
                }
                m.still += 1;
                if m.still < STILL {
                    return false;
                }
                (0, Some((m.drift, m.born)))
            }
            Some((_, m)) => (m.misses + 1, Some((m.drift, m.born))),
            None => (0, None),
        };
        if misses > 1 {
            // Re-placed where it now is, its cells void.
            let refilled = self.memo.get_mut(&key).is_some_and(|(seen, m)| {
                *seen = serial;
                m.misses = misses;
                m.valid = false;
                m.still = 0;
                m.cells.clear();
                m.refill(list, e, facts)
            });
            if !refilled {
                self.memo.remove(&key);
            }
            return false;
        }
        let drift = match last {
            Some((d, born)) if serial - born < SOON => (2.0 * d).min(MAX_DRIFT),
            Some((d, born)) if serial - born >= 8 * SOON => (0.5 * d).max(DRIFT),
            Some((d, _)) => d,
            None => DRIFT,
        };
        let mut cells = std::mem::take(&mut self.cells);
        cells.clear();
        let b = draw_bounds(list, e, facts);
        if b.intersects(union) && b.area() >= i64::from(self.min_cover_area) {
            self.classify(list, e, facts, drift, &mut cells);
            self.classified += 1;
        }
        let memo = OwnerMemo::of(list, e, facts, cells.clone(), misses, (drift, serial));
        self.cells = cells;
        match memo {
            Some(m) => {
                self.memo.insert(key, (serial, m));
                true
            }
            None => {
                self.memo.remove(&key);
                false
            }
        }
    }

    /// The tables for `list` (see the module docs) into [`TileWalk::tiles`] and
    /// [`TileWalk::draws`]. Call it on the list the executor draws (after the cover walk's
    /// compaction).
    pub fn run(&mut self, list: &DrawList, facts: &impl CoverFacts) {
        self.tiles.clear();
        self.draws.clear();
        self.owners.clear();
        self.covers = 0;
        self.tested = 0;
        self.hidden_px = 0;
        self.classified = 0;
        let key = (
            list.target.width,
            list.target.height,
            list.target.opaque,
            self.min_cover_area,
            facts.max_texture_side(),
        );
        if key != self.memo_key {
            self.memo.clear();
            self.prev = None;
            self.areas.clear();
            self.memo_key = key;
        }
        let n = list.draws.len();
        // Memos no run asked for in a while go.
        self.serial += 1;
        let serial = self.serial;
        if serial % 16 == 0 {
            self.memo.retain(|_, (seen, _)| *seen + KEEP >= serial);
        }
        let end = window_end(list);
        // The window's testable draws and their bounds.
        self.bounds.clear();
        let mut union = PxRect::EMPTY;
        for d in 0..end {
            if !testable(list, d) {
                continue;
            }
            let b = draw_bounds(list, d, facts);
            if b.area() >= i64::from(self.min_hidden_px.max(1)) {
                union = if union.is_empty() {
                    b
                } else {
                    PxRect {
                        x0: union.x0.min(b.x0),
                        y0: union.y0.min(b.y0),
                        x1: union.x1.max(b.x1),
                        y1: union.y1.max(b.y1),
                    }
                };
                self.bounds.push((d as u32, b));
            }
        }
        let Some(&(first, _)) = self.bounds.first() else {
            return;
        };
        let (gw, gh) = grid(list);
        let cells = (gw * gh) as usize;
        self.level.clear();
        self.level.resize(cells, 0);
        // Owners in paint order, after the first testable draw.
        let mut copies: Vec<PxRect> = Vec::new();
        let mut next_op = 0usize;
        let ops = &list.screen_ops;
        let mut owner_levels: Vec<(u32, u16)> = Vec::new();
        for e in (first as usize + 1)..n {
            while let Some(op) = ops.get(next_op) {
                if op.before as usize > e {
                    break;
                }
                if op.kind == ScreenOpKind::Copy {
                    let target = PxRect {
                        x0: 0,
                        y0: 0,
                        x1: list.target.width as i32,
                        y1: list.target.height as i32,
                    };
                    let r = PxRect::xywh(op.region).intersect(&target);
                    if !r.is_empty() {
                        copies.push(r);
                    }
                }
                next_op += 1;
            }
            if self.covers >= MAX_DEPTH_LEVEL {
                break;
            }
            let draw = &list.draws[e];
            if cover_state_of(draw, list.target.opaque, || facts.opacity(draw.texture)).is_none() {
                continue;
            }
            // (Only an owner over some testable draw before it is classified.)
            let key = owner_key(list, e);
            if !self.owner_cells(list, e, facts, &union, key) {
                continue;
            }
            let Some((_, m)) = self.memo.get(&key) else {
                continue;
            };
            let level = (self.covers + 1) as u16;
            let mut any = false;
            for &c in &m.cells {
                let (cx, cy) = (c as i32 % gw, c as i32 / gw);
                let r = cell_rect(list, cx, cy);
                if copies.iter().any(|q| q.intersects(&r)) {
                    continue;
                }
                self.level[c as usize] = level;
                any = true;
            }
            if any {
                self.covers += 1;
                self.owners.push(e as u32);
                owner_levels.push((e as u32, level));
            }
        }
        if self.covers == 0 {
            return;
        }
        let (w, h) = (list.target.width as i32, list.target.height as i32);
        self.ranges.clear();
        for &(d, b) in &self.bounds {
            // Wholly inside (a target-edge cell ends at the edge), and meeting.
            let inside = [
                (b.x0 + TILE - 1).div_euclid(TILE).max(0),
                if b.x1 >= w {
                    gw
                } else {
                    b.x1.div_euclid(TILE).min(gw)
                },
                (b.y0 + TILE - 1).div_euclid(TILE).max(0),
                if b.y1 >= h {
                    gh
                } else {
                    b.y1.div_euclid(TILE).min(gh)
                },
            ];
            let meet = [
                b.x0.div_euclid(TILE).max(0),
                ((b.x1 + TILE - 1).div_euclid(TILE)).min(gw),
                b.y0.div_euclid(TILE).max(0),
                ((b.y1 + TILE - 1).div_euclid(TILE)).min(gh),
            ];
            let mut r = [0; 8];
            r[..4].copy_from_slice(&inside);
            r[4..].copy_from_slice(&meet);
            self.ranges.push((d, r));
        }
        if let Some(p) = self.prev.as_ref().filter(|p| {
            p.level == self.level
                && p.ranges == self.ranges
                && p.owners == owner_levels
                && p.min_hidden_px == self.min_hidden_px
        }) {
            self.tiles.clone_from(&p.tiles);
            self.draws.clone_from(&p.draws);
            self.tested = self.draws.len() as u32;
            self.hidden_px = p.hidden_px;
            if self.draws.is_empty() {
                self.owners.clear();
                self.covers = 0;
            }
            return;
        }
        if self.areas.len() != cells {
            self.areas.clear();
            for j in 0..gh {
                for i in 0..gw {
                    self.areas.push(cell_rect(list, i, j).area());
                }
            }
        }
        // The draws worth testing: those with at least `min_hidden_px` in cells wholly inside
        // their bounds and above their level; then the cells that hide a tested draw. Both walk
        // the cells that have a level only.
        let mut nz: Vec<(i32, i32, u16, i64)> = Vec::new();
        let mut row_start: Vec<usize> = Vec::with_capacity(gh as usize + 1);
        for j in 0..gh {
            row_start.push(nz.len());
            for i in 0..gw {
                let c = (j * gw + i) as usize;
                if self.level[c] > 0 {
                    nz.push((i, j, self.level[c], self.areas[c]));
                }
            }
        }
        row_start.push(nz.len());
        let min_hidden = i64::from(self.min_hidden_px.max(1));
        let mut tested: Vec<(u16, [i32; 4])> = Vec::new();
        for &(d, r) in &self.ranges {
            let level = owner_levels.partition_point(|(e, _)| *e <= d) as u16;
            if usize::from(level) >= owner_levels.len() {
                continue;
            }
            let [i0, i1, j0, j1] = [r[0], r[1], r[2], r[3]];
            if i1 <= i0
                || j1 <= j0
                || i64::from(i1 - i0) * i64::from(j1 - j0) * i64::from(TILE * TILE) < min_hidden
            {
                continue;
            }
            let mut hidden = 0i64;
            for j in j0 as usize..j1 as usize {
                let row = &nz[row_start[j]..row_start[j + 1]];
                let from = row.partition_point(|c| c.0 < i0);
                for &(i, _, l, a) in &row[from..] {
                    if i >= i1 {
                        break;
                    }
                    if l > level {
                        hidden += a;
                    }
                }
            }
            if hidden < min_hidden {
                continue;
            }
            tested.push((level, [r[4], r[5], r[6], r[7]]));
            self.draws.push(DepthDraw {
                draw: d,
                level: u32::from(level),
            });
            self.tested += 1;
            self.hidden_px += hidden as u64;
        }
        self.needed.clear();
        self.needed.resize(cells, false);
        for &(i, j, l, _) in &nz {
            self.needed[(j * gw + i) as usize] = tested
                .iter()
                .any(|(tl, m)| *tl < l && i >= m[0] && i < m[1] && j >= m[2] && j < m[3]);
        }
        if self.draws.is_empty() {
            self.owners.clear();
            self.covers = 0;
            self.remember(&owner_levels);
            return;
        }
        // The needed cells, as row runs of one level merged down equal runs.
        let mut open: Vec<(i32, i32, u32, usize)> = Vec::new();
        let mut next: Vec<(i32, i32, u32, usize)> = Vec::new();
        for cy in 0..gh {
            next.clear();
            let mut cx = 0;
            while cx < gw {
                let c = (cy * gw + cx) as usize;
                if !self.needed[c] {
                    cx += 1;
                    continue;
                }
                let level = self.level[c];
                let start = cx;
                while cx < gw
                    && self.needed[(cy * gw + cx) as usize]
                    && self.level[(cy * gw + cx) as usize] == level
                {
                    cx += 1;
                }
                let l = u32::from(level);
                let r0 = cell_rect(list, start, cy);
                let r1 = cell_rect(list, cx - 1, cy);
                let at = match open.iter().find(|o| o.0 == start && o.1 == cx && o.2 == l) {
                    Some(o) => {
                        let t = &mut self.tiles[o.3];
                        t.rect[3] = r1.y1 - t.rect[1];
                        o.3
                    }
                    None => {
                        self.tiles.push(DepthTile {
                            rect: [r0.x0, r0.y0, r1.x1 - r0.x0, r1.y1 - r0.y0],
                            level: l,
                        });
                        self.tiles.len() - 1
                    }
                };
                next.push((start, cx, l, at));
            }
            std::mem::swap(&mut open, &mut next);
        }
        self.remember(&owner_levels);
    }

    fn remember(&mut self, owners: &[(u32, u16)]) {
        let p = self.prev.get_or_insert_with(|| Prev {
            level: Vec::new(),
            ranges: Vec::new(),
            owners: Vec::new(),
            min_hidden_px: 0,
            tiles: Vec::new(),
            draws: Vec::new(),
            hidden_px: 0,
        });
        p.min_hidden_px = self.min_hidden_px;
        p.level.clone_from(&self.level);
        p.ranges.clone_from(&self.ranges);
        p.owners.clear();
        p.owners.extend_from_slice(owners);
        p.tiles.clone_from(&self.tiles);
        p.draws.clone_from(&self.draws);
        p.hidden_px = self.hidden_px;
    }

    /// Whether `list`'s depth tables are ones this walk could stand behind, checked afresh with
    /// no slack (a diagnostic for memo staleness): every tile cell is claimed by its owner with
    /// no [`DRIFT`], meets no copy at or before the owner, every listed draw precedes the window's
    /// end, is testable and carries the number of owners at or before it, and owners are in
    /// paint order.
    pub fn verify(&mut self, list: &DrawList, owners: &[u32], facts: &impl CoverFacts) -> bool {
        if list.depth_tiles.is_empty() != list.depth_draws.is_empty() {
            return false;
        }
        if list.depth_tiles.is_empty() {
            return true;
        }
        if owners.windows(2).any(|w| w[0] >= w[1]) || owners.len() > MAX_DEPTH_LEVEL as usize {
            return false;
        }
        // Any owner the tables name passed the minimum area of the walk that wrote them.
        self.min_cover_area = 0;
        let end = window_end(list);
        for dd in &list.depth_draws {
            let d = dd.draw as usize;
            if d >= end || !testable(list, d) {
                return false;
            }
            if dd.level as usize != owners.partition_point(|e| *e <= dd.draw) {
                return false;
            }
        }
        let (gw, _) = grid(list);
        let mut cells = Vec::new();
        for (l, &e) in owners.iter().enumerate() {
            let e = e as usize;
            if e >= list.draws.len() {
                return false;
            }
            let tiles: Vec<&DepthTile> = list
                .depth_tiles
                .iter()
                .filter(|t| t.level as usize == l + 1)
                .collect();
            if tiles.is_empty() {
                continue;
            }
            if self.classify(list, e, facts, 0.0, &mut cells).is_none() {
                return false;
            }
            let copies: Vec<PxRect> = list
                .screen_ops
                .iter()
                .filter(|op| op.kind == ScreenOpKind::Copy && op.before as usize <= e)
                .map(|op| PxRect::xywh(op.region))
                .collect();
            for t in tiles {
                let r = PxRect::xywh(t.rect);
                if r.x0 % TILE != 0 || r.y0 % TILE != 0 {
                    return false;
                }
                let mut cy = r.y0 / TILE;
                while cy * TILE < r.y1 {
                    let mut cx = r.x0 / TILE;
                    while cx * TILE < r.x1 {
                        let c = cell_rect(list, cx, cy);
                        if cells.binary_search(&((cy * gw + cx) as u32)).is_err()
                            || copies.iter().any(|q| q.intersects(&c))
                        {
                            return false;
                        }
                        cx += 1;
                    }
                    cy += 1;
                }
            }
        }
        true
    }
}
