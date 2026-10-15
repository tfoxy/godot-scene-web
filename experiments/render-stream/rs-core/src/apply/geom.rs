//! Float32 geometry with Godot 4.5.1's own arithmetic (`real_t` is `float` in the release
//! template), shared by the lowering and the clip derivation. Every function names the engine
//! source it ports.

/// Godot `Transform2D` columns: `x.x, x.y, y.x, y.y, origin.x, origin.y`.
pub type Xform = [f32; 6];
/// `x, y, w, h`.
pub type Rect = [f32; 4];

pub const IDENTITY: Xform = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `Transform2D a * b` (b applied first), float32 per operation (`clip-derive.ts` `mulAffine`).
pub fn mul(a: &Xform, b: &Xform) -> Xform {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        (a[0] * b[4] + a[2] * b[5]) + a[4],
        (a[1] * b[4] + a[3] * b[5]) + a[5],
    ]
}

/// `Transform2D::xform(Vector2)`: `basis_xform(v) + origin`.
#[inline]
pub fn xform_point(t: &Xform, p: [f32; 2]) -> [f32; 2] {
    [
        (t[0] * p[0] + t[2] * p[1]) + t[4],
        (t[1] * p[0] + t[3] * p[1]) + t[5],
    ]
}

pub fn is_identity(t: &Xform) -> bool {
    *t == IDENTITY
}

/// `Transform2D::xform(Rect2)` (core/math/transform_2d.h:223-234; `clip-derive.ts` `xformRect`).
pub fn xform_rect(t: &Xform, r: &Rect) -> Rect {
    let [x, y, w, h] = *r;
    let px = (t[0] * x + t[2] * y) + t[4];
    let py = (t[1] * x + t[3] * y) + t[5];
    let ax = t[0] * w;
    let ay = t[1] * w;
    let bx = t[2] * h;
    let by = t[3] * h;
    let xs = [px, px + ax, px + bx, (px + ax) + bx];
    let ys = [py, py + ay, py + by, (py + ay) + by];
    let x0 = xs.iter().copied().fold(f32::INFINITY, f32::min);
    let y0 = ys.iter().copied().fold(f32::INFINITY, f32::min);
    let x1 = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let y1 = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    [x0, y0, x1 - x0, y1 - y0]
}

/// `Rect2::intersects` without borders.
fn intersects(a: &Rect, b: &Rect) -> bool {
    !(a[0] >= b[0] + b[2] || a[0] + a[2] <= b[0] || a[1] >= b[1] + b[3] || a[1] + a[3] <= b[1])
}

/// `Rect2::intersection`: `Rect2()` when the two do not overlap.
pub fn intersect(a: &Rect, b: &Rect) -> Rect {
    if !intersects(a, b) {
        return [0.0; 4];
    }
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    [
        x0,
        y0,
        (a[0] + a[2]).min(b[0] + b[2]) - x0,
        (a[1] + a[3]).min(b[1] + b[3]) - y0,
    ]
}

/// `Math::round` (std::round): half away from zero.
pub fn round_half_away(v: f32) -> f32 {
    v.round()
}

/// `Rect2(points[0])` expanded to every later point (`Rect2::expand_to`).
pub fn points_box(points: impl IntoIterator<Item = [f32; 2]>) -> Rect {
    let mut it = points.into_iter();
    let Some(first) = it.next() else {
        return [0.0; 4];
    };
    let (mut x0, mut y0, mut x1, mut y1) = (first[0], first[1], first[0], first[1]);
    for p in it {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    [x0, y0, x1 - x0, y1 - y0]
}

/// `Rect2::merge` of two boxes given as `x, y, w, h`.
pub fn merge(a: &Rect, b: &Rect) -> Rect {
    let x0 = a[0].min(b[0]);
    let y0 = a[1].min(b[1]);
    let x1 = (a[0] + a[2]).max(b[0] + b[2]);
    let y1 = (a[1] + a[3]).max(b[1] + b[3]);
    [x0, y0, x1 - x0, y1 - y0]
}

const CMP_EPSILON: f32 = 0.00001;

fn is_zero_approx(v: [f32; 2]) -> bool {
    v[0].abs() < CMP_EPSILON && v[1].abs() < CMP_EPSILON
}

fn is_equal_approx_f(a: f32, b: f32) -> bool {
    if a == b {
        return true;
    }
    let mut tolerance = CMP_EPSILON * a.abs();
    if tolerance < CMP_EPSILON {
        tolerance = CMP_EPSILON;
    }
    (a - b).abs() < tolerance
}

fn is_equal_approx(a: [f32; 2], b: [f32; 2]) -> bool {
    is_equal_approx_f(a[0], b[0]) && is_equal_approx_f(a[1], b[1])
}

/// `Vector2::normalized` (core/math/vector2.cpp:52-65).
pub fn normalized(v: [f32; 2]) -> [f32; 2] {
    let l = v[0] * v[0] + v[1] * v[1];
    if l != 0.0 {
        let l = l.sqrt();
        [v[0] / l, v[1] / l]
    } else {
        v
    }
}

/// `Vector2::orthogonal`: `(y, -x)`.
pub fn orthogonal(v: [f32; 2]) -> [f32; 2] {
    [v[1], -v[0]]
}

fn sub(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

fn add(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [a[0] + b[0], a[1] + b[1]]
}

fn scale(a: [f32; 2], s: f32) -> [f32; 2] {
    [a[0] * s, a[1] * s]
}

fn length(a: [f32; 2]) -> f32 {
    (a[0] * a[0] + a[1] * a[1]).sqrt()
}

/// `canvas_item_add_line`'s stored points (renderer_canvas_cull.cpp:717-756): the 4 corners of the
/// quad (`from ± t`, `to ∓ t` in the engine's order) for `width >= 0`, else the 2 end points.
pub fn line_points(from: [f32; 2], to: [f32; 2], width: f32) -> ([[f32; 2]; 4], usize) {
    let diff = sub(from, to);
    let dir = normalized(orthogonal(diff));
    let t = scale(scale(dir, width), 0.5);
    if width >= 0.0 {
        ([add(from, t), sub(from, t), sub(to, t), add(to, t)], 4)
    } else {
        ([from, to, to, to], 2)
    }
}

/// One feather quad: its 4 points and their straight colours.
pub type Feather = ([[f32; 2]; 4], [[f32; 4]; 4]);

/// The two feather quads `canvas_item_add_line` adds when antialiased (`left_border`,
/// `right_border`), each `(points, colours)` with the transparent edge in alpha 0.
pub fn line_feathers(from: [f32; 2], to: [f32; 2], width: f32, color: [f32; 4]) -> [Feather; 2] {
    const FEATHER_SIZE: f32 = 1.25;
    let diff = sub(from, to);
    let dir = normalized(orthogonal(diff));
    let t = scale(scale(dir, width), 0.5);
    let (begin_left, begin_right, end_left, end_right) = if width >= 0.0 {
        (add(from, t), sub(from, t), add(to, t), sub(to, t))
    } else {
        (from, from, to, to)
    };
    let mut border_size = FEATHER_SIZE;
    if (0.0..1.0).contains(&width) {
        border_size *= width;
    }
    let border = scale(dir, border_size);
    let transparent = [color[0], color[1], color[2], 0.0];
    [
        (
            [
                begin_left,
                add(begin_left, border),
                add(end_left, border),
                end_left,
            ],
            [color, transparent, transparent, color],
        ),
        (
            [
                begin_right,
                sub(begin_right, border),
                sub(end_right, border),
                end_right,
            ],
            [color, transparent, transparent, color],
        ),
    ]
}

fn compute_polyline_segment_dir(points: &[[f32; 2]], index: usize, prev: [f32; 2]) -> [f32; 2] {
    if index == points.len() - 1 {
        return prev;
    }
    let dir = normalized(sub(points[index + 1], points[index]));
    if is_zero_approx(dir) {
        prev
    } else {
        dir
    }
}

fn cross(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}

fn dot(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[0] * b[0] + a[1] * b[1]
}

// `!Math::is_zero_approx(sin_angle)` kept verbatim: a NaN angle takes the engine's branch.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn compute_polyline_edge_offset_clamped(
    segment_dir: [f32; 2],
    prev_segment_dir: [f32; 2],
) -> [f32; 2] {
    let mut length_out = 1.0f32;
    let mut bisector = normalized(sub(
        scale(prev_segment_dir, length(segment_dir)),
        scale(segment_dir, length(prev_segment_dir)),
    ));
    let angle = cross(bisector, prev_segment_dir).atan2(dot(bisector, prev_segment_dir));
    let sin_angle = angle.sin();
    if !(sin_angle.abs() < CMP_EPSILON) && !is_equal_approx(segment_dir, prev_segment_dir) {
        length_out = (1.0 / sin_angle).clamp(-3.0, 3.0);
    } else {
        bisector = orthogonal(segment_dir);
    }
    if is_zero_approx(bisector) {
        bisector = orthogonal(segment_dir);
    }
    scale(bisector, length_out)
}

/// `canvas_item_add_polyline` with `width >= 0` and no antialiasing (renderer_canvas_cull.cpp:
/// 945-1206): the triangle strip's points (`2·n`) and colours (each point's colour held to the
/// last given one, white when none).
pub fn polyline_strip(
    points: &[[f32; 2]],
    colors: &[[f32; 4]],
    width: f32,
) -> (Vec<[f32; 2]>, Vec<[f32; 4]>) {
    let n = points.len();
    let mut out_points = Vec::with_capacity(2 * n);
    let mut out_colors = Vec::with_capacity(2 * n);
    if n < 2 {
        return (out_points, out_colors);
    }
    let loop_ = is_equal_approx(points[0], points[n - 1]);
    let mut first_segment_dir = [0.0; 2];
    for i in 1..n {
        first_segment_dir = normalized(sub(points[i], points[i - 1]));
        if !is_zero_approx(first_segment_dir) {
            break;
        }
    }
    let mut last_segment_dir = [0.0; 2];
    for i in (1..n).rev() {
        last_segment_dir = normalized(sub(points[i], points[i - 1]));
        if !is_zero_approx(last_segment_dir) {
            break;
        }
    }
    let mut color = [1.0f32; 4];
    let mut prev_segment_dir = [0.0f32; 2];
    for i in 0..n {
        let is_first = i == 0;
        let is_last = i == n - 1;
        let segment_dir = compute_polyline_segment_dir(points, i, prev_segment_dir);
        if is_first && loop_ {
            prev_segment_dir = last_segment_dir;
        } else if is_last && loop_ {
            prev_segment_dir = first_segment_dir;
        }
        let base_edge_offset = if is_first && !loop_ {
            orthogonal(first_segment_dir)
        } else if is_last && !loop_ {
            orthogonal(last_segment_dir)
        } else {
            compute_polyline_edge_offset_clamped(segment_dir, prev_segment_dir)
        };
        let edge_offset = scale(base_edge_offset, width * 0.5);
        let pos = points[i];
        out_points.push(add(pos, edge_offset));
        out_points.push(sub(pos, edge_offset));
        if i < colors.len() {
            color = colors[i];
        }
        out_colors.push(color);
        out_colors.push(color);
        prev_segment_dir = segment_dir;
    }
    (out_points, out_colors)
}

/// `canvas_item_add_circle`'s polygon (renderer_canvas_cull.cpp:1422-1460): 64 rim points plus
/// the closing one, the centre last, and a fan of 64 triangles `(centre, i, i+1)`.
pub fn circle(position: [f32; 2], radius: f32) -> (Vec<[f32; 2]>, Vec<u32>) {
    const SEGMENTS: usize = 64;
    let step: f32 = std::f32::consts::TAU / SEGMENTS as f32;
    let mut points = Vec::with_capacity(SEGMENTS + 2);
    for i in 0..=SEGMENTS {
        let angle = i as f32 * step;
        points.push([
            angle.cos() * radius + position[0],
            angle.sin() * radius + position[1],
        ]);
    }
    points.push(position);
    let mut indices = Vec::with_capacity(SEGMENTS * 3);
    for i in 0..SEGMENTS as u32 {
        indices.extend_from_slice(&[SEGMENTS as u32 + 1, i, i + 1]);
    }
    (points, indices)
}

fn triangulate_area(contour: &[[f32; 2]]) -> f32 {
    let n = contour.len();
    let mut a = 0.0f32;
    let mut p = n - 1;
    for q in 0..n {
        a += cross(contour[p], contour[q]);
        p = q;
    }
    a * 0.5
}

#[allow(clippy::too_many_arguments)]
fn is_inside_triangle(
    ax_: f32,
    ay_: f32,
    bx_: f32,
    by_: f32,
    cx_: f32,
    cy_: f32,
    px: f32,
    py: f32,
    include_edges: bool,
) -> bool {
    let ax = cx_ - bx_;
    let ay = cy_ - by_;
    let bx = ax_ - cx_;
    let by = ay_ - cy_;
    let cx = bx_ - ax_;
    let cy = by_ - ay_;
    let apx = px - ax_;
    let apy = py - ay_;
    let bpx = px - bx_;
    let bpy = py - by_;
    let cpx = px - cx_;
    let cpy = py - cy_;
    let a_cross_bp = ax * bpy - ay * bpx;
    let c_cross_ap = cx * apy - cy * apx;
    let b_cross_cp = bx * cpy - by * cpx;
    if include_edges {
        a_cross_bp > 0.0 && b_cross_cp > 0.0 && c_cross_ap > 0.0
    } else {
        a_cross_bp >= 0.0 && b_cross_cp >= 0.0 && c_cross_ap >= 0.0
    }
}

fn snip(
    contour: &[[f32; 2]],
    u: usize,
    v: usize,
    w: usize,
    n: usize,
    vv: &[usize],
    relaxed: bool,
) -> bool {
    let [ax, ay] = contour[vv[u]];
    let [bx, by] = contour[vv[v]];
    let [cx, cy] = contour[vv[w]];
    let threshold: f32 = if relaxed { -CMP_EPSILON } else { CMP_EPSILON };
    if threshold > ((bx - ax) * (cy - ay)) - ((by - ay) * (cx - ax)) {
        return false;
    }
    for p in 0..n {
        if p == u || p == v || p == w {
            continue;
        }
        let [px, py] = contour[vv[p]];
        if is_inside_triangle(ax, ay, bx, by, cx, cy, px, py, relaxed) {
            return false;
        }
    }
    true
}

/// `Geometry2D::triangulate_polygon` = `Triangulate::triangulate` (core/math/triangulate.cpp), the
/// ear clipper `canvas_item_add_polygon` uses. `None` when it fails (the engine then adds no
/// command).
pub fn triangulate_polygon(contour: &[[f32; 2]]) -> Option<Vec<u32>> {
    let n = contour.len();
    if n < 3 {
        return None;
    }
    let mut vv: Vec<usize> = if 0.0 < triangulate_area(contour) {
        (0..n).collect()
    } else {
        (0..n).map(|v| n - 1 - v).collect()
    };
    let mut relaxed = false;
    let mut nv = n;
    let mut count: i64 = 2 * nv as i64;
    let mut result = Vec::with_capacity(3 * (n - 2));
    let mut v = nv - 1;
    while nv > 2 {
        let c = count;
        count -= 1;
        if 0 >= c {
            if relaxed {
                return None;
            }
            count = 2 * nv as i64;
            relaxed = true;
        }
        let mut u = v;
        if nv <= u {
            u = 0;
        }
        v = u + 1;
        if nv <= v {
            v = 0;
        }
        let mut w = v + 1;
        if nv <= w {
            w = 0;
        }
        if snip(contour, u, v, w, nv, &vv, relaxed) {
            result.extend_from_slice(&[vv[u] as u32, vv[v] as u32, vv[w] as u32]);
            vv.remove(v);
            nv -= 1;
            count = 2 * nv as i64;
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_triangulates_into_two() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let t = triangulate_polygon(&sq).unwrap();
        assert_eq!(t.len(), 6);
    }

    #[test]
    fn pentagon_triangulates_into_three() {
        let p = [
            [0.0, 0.0],
            [10.0, 0.0],
            [12.0, 6.0],
            [5.0, 10.0],
            [-2.0, 6.0],
        ];
        assert_eq!(triangulate_polygon(&p).unwrap().len(), 9);
    }

    #[test]
    fn circle_has_godot_counts() {
        let (p, i) = circle([5.0, 5.0], 3.0);
        assert_eq!(p.len(), 66);
        assert_eq!(i.len(), 192);
    }

    #[test]
    fn straight_polyline_offsets_by_half_width() {
        let (p, c) = polyline_strip(
            &[[0.0, 0.0], [10.0, 0.0], [20.0, 0.0]],
            &[[1.0, 0.0, 0.0, 1.0]],
            4.0,
        );
        assert_eq!(p.len(), 6);
        assert_eq!(c.len(), 6);
        assert_eq!(p[0], [0.0, -2.0]);
        assert_eq!(p[1], [0.0, 2.0]);
        assert_eq!(p[5], [20.0, 2.0]);
    }
}
