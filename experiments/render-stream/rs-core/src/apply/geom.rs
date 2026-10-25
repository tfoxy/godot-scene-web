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

/// `Transform2D::affine_inverse()` (core/math/transform_2d.cpp:48-60), float32 per operation:
/// `idet = 1 / det`, the basis diagonal swapped and scaled by `(idet, -idet)` / `(-idet, idet)`,
/// the origin `basis_xform(-origin)` of the new basis.
pub fn affine_inverse(t: &Xform) -> Xform {
    let det = t[0] * t[3] - t[1] * t[2];
    let idet = 1.0f32 / det;
    let (a, b, c, d) = (t[3] * idet, t[1] * -idet, t[2] * -idet, t[0] * idet);
    let (ox, oy) = (-t[4], -t[5]);
    [a, b, c, d, a * ox + c * oy, b * ox + d * oy]
}

/// A `Transform2D` as the column-major `mat4` GLES3 builds for it
/// (`_update_transform_2d_to_mat4`, rasterizer_canvas_gles3.cpp).
pub fn to_mat4(t: &Xform) -> [f32; 16] {
    [
        t[0], t[1], 0.0, 0.0, t[2], t[3], 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, t[4], t[5], 0.0, 1.0,
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
/// `Rect2::intersects(p_rect, p_include_borders = true)` (core/math/rect2.h): touching counts.
pub fn intersects_inclusive(a: &Rect, b: &Rect) -> bool {
    !(a[0] > b[0] + b[2] || a[0] + a[2] < b[0] || a[1] > b[1] + b[3] || a[1] + a[3] < b[1])
}

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

/// `RendererCanvasCull`'s `FEATHER_SIZE` (renderer_canvas_cull.h).
pub const FEATHER_SIZE: f32 = 1.25;

/// One feather quad (a 4-point `CommandPrimitive`): its points and their straight colours.
pub type Feather = ([[f32; 2]; 4], [[f32; 4]; 4]);

/// The eight feather quads of an antialiased line or rect, in the engine's command order
/// (`left_border`, `right_border`, `top_border`, `bottom_border`, then the four corners), from the
/// four corners and the two border vectors, exactly as `canvas_item_add_line` and
/// `canvas_item_add_rect` build them (renderer_canvas_cull.cpp:760-881, 1266-1419).
fn feather_quads(
    begin_left: [f32; 2],
    begin_right: [f32; 2],
    end_left: [f32; 2],
    end_right: [f32; 2],
    border: [f32; 2],
    border2: [f32; 2],
    color: [f32; 4],
) -> [Feather; 8] {
    let t = [color[0], color[1], color[2], 0.0];
    let edge = [color, t, t, color];
    let corner = [color, t, t, t];
    [
        (
            [
                begin_left,
                add(begin_left, border),
                add(end_left, border),
                end_left,
            ],
            edge,
        ),
        (
            [
                begin_right,
                sub(begin_right, border),
                sub(end_right, border),
                end_right,
            ],
            edge,
        ),
        (
            [
                begin_left,
                add(begin_left, border2),
                add(begin_right, border2),
                begin_right,
            ],
            edge,
        ),
        (
            [
                end_left,
                sub(end_left, border2),
                sub(end_right, border2),
                end_right,
            ],
            edge,
        ),
        (
            [
                begin_left,
                add(begin_left, border2),
                add(add(begin_left, border), border2),
                add(begin_left, border),
            ],
            corner,
        ),
        (
            [
                begin_right,
                add(begin_right, border2),
                add(sub(begin_right, border), border2),
                sub(begin_right, border),
            ],
            corner,
        ),
        (
            [
                end_left,
                sub(end_left, border2),
                sub(add(end_left, border), border2),
                add(end_left, border),
            ],
            corner,
        ),
        (
            [
                end_right,
                sub(end_right, border2),
                sub(sub(end_right, border), border2),
                sub(end_right, border),
            ],
            corner,
        ),
    ]
}

/// The eight feather quads `canvas_item_add_line` adds when antialiased (renderer_canvas_cull.cpp:
/// 759-881): `border` along the line's normal, `border2` along `from - to`.
pub fn line_feathers(from: [f32; 2], to: [f32; 2], width: f32, color: [f32; 4]) -> [Feather; 8] {
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
    let dir2 = normalized(diff);
    feather_quads(
        begin_left,
        begin_right,
        end_left,
        end_right,
        scale(dir, border_size),
        scale(dir2, border_size),
        color,
    )
}

/// The eight feather quads `canvas_item_add_rect` adds when antialiased (renderer_canvas_cull.cpp:
/// 1266-1419): the corners from the rect as given (no size normalization), `dir` = (0, -1) and
/// `dir2` = (-1, 0).
pub fn rect_feathers(rect: Rect, color: [f32; 4]) -> [Feather; 8] {
    let mut border_size = FEATHER_SIZE;
    let size = rect[2].min(rect[3]);
    if (0.0..1.0).contains(&size) {
        border_size *= size;
    }
    let pos = [rect[0], rect[1]];
    let begin_left = pos;
    let begin_right = add(pos, [0.0, rect[3]]);
    let end_left = add(pos, [rect[2], 0.0]);
    let end_right = add(pos, [rect[2], rect[3]]);
    feather_quads(
        begin_left,
        begin_right,
        end_left,
        end_right,
        scale([0.0, -1.0], border_size),
        scale([-1.0, 0.0], border_size),
        color,
    )
}

/// `canvas_item_add_circle`'s antialiased feather (renderer_canvas_cull.cpp:1466-1510): a triangle
/// strip of `2·64 + 2` points alternating the rim (opaque) and the rim pushed out by the border
/// (transparent).
pub fn circle_feather(
    position: [f32; 2],
    radius: f32,
    color: [f32; 4],
) -> (Vec<[f32; 2]>, Vec<[f32; 4]>) {
    const SEGMENTS: usize = 64;
    let mut border_size = FEATHER_SIZE;
    let diameter = radius * 2.0;
    if (0.0..1.0).contains(&diameter) {
        border_size *= radius;
    }
    let step: f32 = std::f32::consts::TAU / SEGMENTS as f32;
    let transparent = [color[0], color[1], color[2], 0.0];
    let mut points = Vec::with_capacity(2 * SEGMENTS + 2);
    let mut colors = Vec::with_capacity(2 * SEGMENTS + 2);
    let outer = radius + border_size;
    for i in 0..=SEGMENTS {
        let angle = i as f32 * step;
        let (c, s) = (angle.cos(), angle.sin());
        points.push(add([c * radius, s * radius], position));
        points.push(add([c * outer, s * outer], position));
        colors.push(color);
        colors.push(transparent);
    }
    (points, colors)
}

/// `Math::make_half_float` then `unpackHalf2x16` (math_funcs.h:748-794, canvas.glsl): how GLES3's
/// `TYPE_PRIMITIVE` carries its vertex colours. The mantissa is truncated, and values below the
/// half's normal range (`|v| < 2^-14`) become zero.
pub fn godot_half(v: f32) -> f32 {
    let x = v.to_bits();
    let sign = x >> 31;
    let mantissa = x & ((1 << 23) - 1);
    let exponent = x & (0xFF << 23);
    let hf: u32 = if exponent >= 0x4780_0000 {
        let m = if mantissa != 0 && exponent == (0xFF << 23) {
            (1 << 23) - 1
        } else {
            0
        };
        (sign << 15) | (0x1F << 10) | (m >> 13)
    } else if exponent <= 0x3800_0000 {
        0
    } else {
        (sign << 15) | ((exponent - 0x3800_0000) >> 13) | (mantissa >> 13)
    };
    // binary16 to binary32 (exact).
    let s = (hf >> 15) & 1;
    let e = (hf >> 10) & 0x1F;
    let m = hf & 0x3FF;
    let bits = if e == 0 {
        s << 31
    } else if e == 0x1F {
        (s << 31) | (0xFF << 23) | (m << 13)
    } else {
        (s << 31) | ((e + 112) << 23) | (m << 13)
    };
    f32::from_bits(bits)
}

/// A colour through [`godot_half`].
pub fn godot_half4(c: [f32; 4]) -> [f32; 4] {
    [
        godot_half(c[0]),
        godot_half(c[1]),
        godot_half(c[2]),
        godot_half(c[3]),
    ]
}

/// `canvas_item_add_polyline` with `width >= 0` and antialiasing (renderer_canvas_cull.cpp:
/// 1006-1162): the middle strip (with 2 + 2 extra feather points at the open ends), and the left
/// and right feather strips (`2·n`, plus 5 at the open ends). Each is `(points, colours)`.
pub type Strip = (Vec<[f32; 2]>, Vec<[f32; 4]>);

pub fn polyline_aa(points: &[[f32; 2]], colors: &[[f32; 4]], width: f32) -> [Strip; 3] {
    let n = points.len();
    let pc = 2 * n;
    let empty = || (Vec::new(), Vec::new());
    if n < 2 {
        return [empty(), empty(), empty()];
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
    let extra = if loop_ { 0 } else { 4 };
    let side_extra = if loop_ { 0 } else { 5 };
    let mut mp = vec![[0.0f32; 2]; pc + extra];
    let mut mc = vec![[0.0f32; 4]; pc + extra];
    let mut lp = vec![[0.0f32; 2]; pc + side_extra];
    let mut lc = vec![[0.0f32; 4]; pc + side_extra];
    let mut rp = vec![[0.0f32; 2]; pc + side_extra];
    let mut rc = vec![[0.0f32; 4]; pc + side_extra];
    let mut border_size = FEATHER_SIZE;
    if width < 1.0 {
        border_size *= width;
    }
    let mut color = [1.0f32; 4];
    let mut color2 = [1.0f32, 1.0, 1.0, 0.0];
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
        let border = scale(base_edge_offset, border_size);
        let pos = points[i];
        let j = i * 2 + if loop_ { 0 } else { 2 };
        mp[j] = add(pos, edge_offset);
        mp[j + 1] = sub(pos, edge_offset);
        lp[j] = add(pos, edge_offset);
        lp[j + 1] = add(add(pos, edge_offset), border);
        rp[j] = sub(pos, edge_offset);
        rp[j + 1] = sub(sub(pos, edge_offset), border);
        if i < colors.len() {
            color = colors[i];
            color2 = [color[0], color[1], color[2], 0.0];
        }
        mc[j] = color;
        mc[j + 1] = color;
        lc[j] = color;
        lc[j + 1] = color2;
        rc[j] = color;
        rc[j + 1] = color2;
        if is_first && !loop_ {
            let begin_border = scale(scale(segment_dir, -1.0), border_size);
            mp[0] = add(add(pos, edge_offset), begin_border);
            mp[1] = add(sub(pos, edge_offset), begin_border);
            mc[0] = color2;
            mc[1] = color2;
            lp[0] = add(add(pos, edge_offset), begin_border);
            lp[1] = add(add(add(pos, edge_offset), begin_border), border);
            lc[0] = color2;
            lc[1] = color2;
            rp[0] = add(sub(pos, edge_offset), begin_border);
            rp[1] = sub(add(sub(pos, edge_offset), begin_border), border);
            rc[0] = color2;
            rc[1] = color2;
        }
        if is_last && !loop_ {
            let end_border = scale(prev_segment_dir, border_size);
            let e = pc + 2;
            mp[e] = add(add(pos, edge_offset), end_border);
            mp[e + 1] = add(sub(pos, edge_offset), end_border);
            mc[e] = color2;
            mc[e + 1] = color2;
            lp[e] = add(pos, edge_offset);
            lp[e + 1] = add(add(add(pos, edge_offset), end_border), border);
            lp[e + 2] = add(add(pos, edge_offset), end_border);
            lc[e] = color;
            lc[e + 1] = color2;
            lc[e + 2] = color2;
            rp[e] = sub(pos, edge_offset);
            rp[e + 1] = sub(add(sub(pos, edge_offset), end_border), border);
            rp[e + 2] = add(sub(pos, edge_offset), end_border);
            rc[e] = color;
            rc[e + 1] = color2;
            rc[e + 2] = color2;
        }
        prev_segment_dir = segment_dir;
    }
    [(mp, mc), (lp, lc), (rp, rc)]
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
