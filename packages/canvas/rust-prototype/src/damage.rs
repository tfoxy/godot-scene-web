//! Device-space bounds and damage rectangles for the opt-in damage present
//! (`Renderer::set_damage_present`).
//!
//! Everything here is conservative: a rectangle may cover more pixels than an
//! instance can touch, never fewer. An instance only writes pixels whose
//! centres fall inside its transformed quad (and inside its clip slots), so
//! the axis-aligned box of the four corners, intersected with the clip boxes
//! and widened by one device pixel for float error, holds every pixel it can
//! write. Linear sampling and MSDF `fwidth` read neighbouring texels but never
//! widen the rasterized footprint.
use crate::geometry::{Draw, Instance};

/// Half-open device-pixel rectangle `[x0, x1) x [y0, y1)`. Empty when either
/// extent is non-positive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl DeviceRect {
    pub const EMPTY: Self = Self {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };
    pub fn full(width: u32, height: u32) -> Self {
        Self {
            x0: 0,
            y0: 0,
            x1: width as i32,
            y1: height as i32,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }
    pub fn area(&self) -> u64 {
        if self.is_empty() {
            0
        } else {
            (self.x1 - self.x0) as u64 * (self.y1 - self.y0) as u64
        }
    }
    pub fn union(&self, other: &Self) -> Self {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }
    pub fn intersection(&self, other: &Self) -> Self {
        Self {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        }
    }
    pub fn intersects(&self, other: &Self) -> bool {
        !self.intersection(other).is_empty()
    }
    /// Overlapping or sharing an edge span. Two rectangles that meet only at
    /// a corner do not touch: their union would add two empty quadrants.
    fn touches(&self, other: &Self) -> bool {
        if self.is_empty() || other.is_empty() {
            return false;
        }
        let overlap_x = self.x1.min(other.x1) - self.x0.max(other.x0);
        let overlap_y = self.y1.min(other.y1) - self.y0.max(other.y0);
        overlap_x >= 0 && overlap_y >= 0 && (overlap_x > 0 || overlap_y > 0)
    }
    pub fn contains(&self, other: &Self) -> bool {
        other.is_empty()
            || (self.x0 <= other.x0
                && self.y0 <= other.y0
                && self.x1 >= other.x1
                && self.y1 >= other.y1)
    }
}

/// Design-space to device-pixel mapping of the picture pass: the vertex stage
/// projects design coordinates through `design_width,design_height` onto the
/// whole `width,height` surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projection {
    pub sx: f32,
    pub sy: f32,
    pub width: u32,
    pub height: u32,
}

impl Projection {
    pub fn new(width: u32, height: u32, design_width: u32, design_height: u32) -> Self {
        Self {
            sx: width as f32 / design_width.max(1) as f32,
            sy: height as f32 / design_height.max(1) as f32,
            width,
            height,
        }
    }
    pub fn full(&self) -> DeviceRect {
        DeviceRect::full(self.width, self.height)
    }
}

/// Every device pixel `instance` can write, clamped to the surface. A
/// non-finite coordinate anywhere answers the whole surface.
pub fn instance_bounds(instance: &Instance, projection: &Projection) -> DeviceRect {
    let [ox, oy, axx, axy] = instance.origin_axis_x;
    let [ayx, ayy, _, _] = instance.axis_y_uv_origin;
    let xs = [ox, ox + axx, ox + ayx, ox + axx + ayx];
    let ys = [oy, oy + axy, oy + ayy, oy + axy + ayy];
    let mut x0 = xs.iter().copied().fold(f32::INFINITY, f32::min);
    let mut x1 = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut y0 = ys.iter().copied().fold(f32::INFINITY, f32::min);
    let mut y1 = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if !(xs.iter().chain(&ys).all(|v| v.is_finite())) {
        return projection.full();
    }
    // The fragment stage discards outside each active clip slot (radius
    // only removes corners, so the box is a superset). `params.x < 0`
    // marks an unused slot, exactly as `inside` in shader.wgsl reads it.
    for (rect, params) in instance.clips.iter().zip(&instance.clip_params) {
        if params[0] < 0.0 {
            continue;
        }
        if !(rect.iter().chain(params).all(|v| v.is_finite())) {
            return projection.full();
        }
        let outset = params[1];
        x0 = x0.max(rect[0] - outset);
        x1 = x1.min(rect[0] + rect[2] + outset);
        y0 = y0.max(rect[1]);
        y1 = y1.min(rect[1] + rect[3]);
    }
    if x1 < x0 || y1 < y0 {
        return DeviceRect::EMPTY;
    }
    let clamp = |v: f32, max: u32| (v.max(-1.0).min(max as f32 + 1.0)) as i32;
    let rect = DeviceRect {
        x0: clamp((x0 * projection.sx).floor() - 1.0, projection.width),
        y0: clamp((y0 * projection.sy).floor() - 1.0, projection.height),
        x1: clamp((x1 * projection.sx).ceil() + 1.0, projection.width),
        y1: clamp((y1 * projection.sy).ceil() + 1.0, projection.height),
    };
    rect.intersection(&projection.full())
}

/// Union of every instance bound in one draw.
pub fn draw_bounds(draw: &Draw, instances: &[Instance], projection: &Projection) -> DeviceRect {
    let start = draw.start as usize;
    let end = (start + draw.count as usize).min(instances.len());
    instances[start.min(end)..end]
        .iter()
        .fold(DeviceRect::EMPTY, |acc, instance| {
            acc.union(&instance_bounds(instance, projection))
        })
}

/// The draw whose instance range holds `instance`. Draws are contiguous and
/// ordered by `start`.
pub fn draw_of(draws: &[Draw], instance: usize) -> Option<usize> {
    let index = draws.partition_point(|draw| draw.start as usize <= instance);
    let candidate = index.checked_sub(1)?;
    let draw = &draws[candidate];
    (instance < draw.start as usize + draw.count as usize).then_some(candidate)
}

/// A small set of damage rectangles. Each added rectangle ends up wholly
/// inside exactly one member, so "covered" is a per-member containment test.
#[derive(Clone, Debug, Default)]
pub struct DamageSet {
    rects: Vec<DeviceRect>,
}

/// Each member costs a clear quad plus a pass over the draw table; past this
/// many, the closest pair merges.
pub const MAX_DAMAGE_RECTS: usize = 4;

impl DamageSet {
    pub fn rects(&self) -> &[DeviceRect] {
        &self.rects
    }
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }
    pub fn area(&self) -> u64 {
        self.rects.iter().map(DeviceRect::area).sum()
    }
    pub fn add(&mut self, rect: DeviceRect) {
        if rect.is_empty() || self.rects.iter().any(|r| r.contains(&rect)) {
            return;
        }
        let mut merged = rect;
        // Absorb every member the growing rectangle touches until none does.
        loop {
            let before = self.rects.len();
            self.rects.retain(|r| {
                if r.touches(&merged) {
                    merged = merged.union(r);
                    false
                } else {
                    true
                }
            });
            if self.rects.len() == before {
                break;
            }
        }
        self.rects.push(merged);
        while self.rects.len() > MAX_DAMAGE_RECTS {
            let mut best = (0, 1, u64::MAX);
            for i in 0..self.rects.len() {
                for j in i + 1..self.rects.len() {
                    let (a, b) = (self.rects[i], self.rects[j]);
                    let growth = a.union(&b).area().saturating_sub(a.area() + b.area());
                    if growth < best.2 {
                        best = (i, j, growth);
                    }
                }
            }
            let b = self.rects.swap_remove(best.1);
            let a = self.rects.swap_remove(best.0);
            self.add(a.union(&b));
        }
    }
    /// Whether every pixel of `rect` lies inside some member (members may
    /// overlap after a capacity merge, so split around each one in turn).
    pub fn covers(&self, rect: &DeviceRect) -> bool {
        fn covered(rect: DeviceRect, rects: &[DeviceRect]) -> bool {
            if rect.is_empty() {
                return true;
            }
            let Some((first, rest)) = rects.split_first() else {
                return false;
            };
            if !first.intersects(&rect) {
                return covered(rect, rest);
            }
            let inner = first.intersection(&rect);
            [
                DeviceRect {
                    y1: inner.y0,
                    ..rect
                },
                DeviceRect {
                    y0: inner.y1,
                    ..rect
                },
                DeviceRect {
                    x1: inner.x0,
                    y0: inner.y0,
                    y1: inner.y1,
                    ..rect
                },
                DeviceRect {
                    x0: inner.x1,
                    y0: inner.y0,
                    y1: inner.y1,
                    ..rect
                },
            ]
            .into_iter()
            .all(|piece| covered(piece, rest))
        }
        covered(*rect, &self.rects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Blend;

    fn instance(x: f32, y: f32, w: f32, h: f32) -> Instance {
        Instance {
            origin_axis_x: [x, y, w, 0.0],
            axis_y_uv_origin: [0.0, h, 0.0, 0.0],
            uv_size_slot: [1.0, 1.0, 0.0, 0.0],
            color: [1.0; 4],
            matrix: [0.0; 12],
            clips: [[0.0; 4]; 3],
            clip_params: [[-1.0, 0.0]; 3],
        }
    }
    fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> DeviceRect {
        DeviceRect { x0, y0, x1, y1 }
    }

    #[test]
    fn bounds_scale_round_out_and_pad_one_pixel() {
        let projection = Projection::new(200, 100, 100, 50);
        let bounds = instance_bounds(&instance(10.25, 5.0, 10.0, 10.0), &projection);
        assert_eq!(bounds, rect(19, 9, 42, 31));
    }

    #[test]
    fn rotated_quads_use_all_four_corners() {
        let projection = Projection::new(100, 100, 100, 100);
        let mut rotated = instance(50.0, 10.0, 0.0, 0.0);
        rotated.origin_axis_x = [50.0, 10.0, 10.0, 10.0];
        rotated.axis_y_uv_origin = [-10.0, 10.0, 0.0, 0.0];
        assert_eq!(instance_bounds(&rotated, &projection), rect(39, 9, 61, 31));
    }

    #[test]
    fn clips_shrink_and_can_empty_the_bounds() {
        let projection = Projection::new(100, 100, 100, 100);
        let mut clipped = instance(0.0, 0.0, 100.0, 100.0);
        clipped.clips[1] = [10.0, 20.0, 30.0, 40.0];
        clipped.clip_params[1] = [4.0, 2.0];
        assert_eq!(instance_bounds(&clipped, &projection), rect(7, 19, 43, 61));
        clipped.clips[0] = [80.0, 80.0, 5.0, 5.0];
        clipped.clip_params[0] = [0.0, 0.0];
        assert!(instance_bounds(&clipped, &projection).is_empty());
    }

    #[test]
    fn non_finite_and_offscreen_bounds() {
        let projection = Projection::new(64, 32, 64, 32);
        assert_eq!(
            instance_bounds(&instance(f32::NAN, 0.0, 1.0, 1.0), &projection),
            projection.full()
        );
        assert!(instance_bounds(&instance(500.0, 0.0, 10.0, 10.0), &projection).is_empty());
        assert_eq!(
            instance_bounds(&instance(-10.0, -10.0, 1000.0, 1000.0), &projection),
            projection.full()
        );
    }

    #[test]
    fn draw_lookup_and_union() {
        let draws = vec![
            Draw {
                start: 0,
                count: 2,
                resources: vec![None],
                blend: Blend::Mix,
            },
            Draw {
                start: 2,
                count: 1,
                resources: vec![None],
                blend: Blend::Add,
            },
        ];
        assert_eq!(draw_of(&draws, 0), Some(0));
        assert_eq!(draw_of(&draws, 1), Some(0));
        assert_eq!(draw_of(&draws, 2), Some(1));
        assert_eq!(draw_of(&draws, 3), None);
        let projection = Projection::new(100, 100, 100, 100);
        let instances = vec![
            instance(0.0, 0.0, 10.0, 10.0),
            instance(50.0, 50.0, 10.0, 10.0),
            instance(90.0, 0.0, 1.0, 1.0),
        ];
        assert_eq!(
            draw_bounds(&draws[0], &instances, &projection),
            rect(0, 0, 61, 61)
        );
    }

    #[test]
    fn damage_set_merges_touching_and_caps_members() {
        let mut set = DamageSet::default();
        set.add(rect(0, 0, 10, 10));
        set.add(rect(10, 0, 20, 10));
        assert_eq!(set.rects(), &[rect(0, 0, 20, 10)]);
        set.add(rect(5, 5, 6, 6));
        assert_eq!(set.rects().len(), 1);
        for i in 0..6 {
            set.add(rect(100 * (i + 1), 100, 100 * (i + 1) + 5, 105));
        }
        assert!(set.rects().len() <= MAX_DAMAGE_RECTS);
        for i in 0..6 {
            assert!(set.covers(&rect(100 * (i + 1), 100, 100 * (i + 1) + 5, 105)));
        }
        assert!(set.covers(&rect(0, 0, 20, 10)));
    }

    #[test]
    fn corner_contact_does_not_merge() {
        let mut set = DamageSet::default();
        set.add(rect(0, 0, 10, 10));
        set.add(rect(10, 10, 20, 20));
        assert_eq!(set.rects().len(), 2);
        assert_eq!(set.area(), 200);
        set.add(rect(10, 0, 20, 10));
        assert_eq!(set.rects(), &[rect(0, 0, 20, 20)]);
    }

    #[test]
    fn covers_spans_several_members() {
        let mut set = DamageSet::default();
        set.add(rect(0, 0, 10, 10));
        set.add(rect(20, 0, 30, 10));
        assert!(!set.covers(&rect(5, 0, 25, 10)));
        assert!(set.covers(&rect(2, 2, 8, 8)));
        let overlapping = DamageSet {
            rects: vec![rect(0, 0, 10, 10), rect(5, 0, 20, 10)],
        };
        assert!(overlapping.covers(&rect(0, 0, 20, 10)));
        assert!(!overlapping.covers(&rect(0, 0, 20, 11)));
    }
}
