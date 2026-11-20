use crate::cover::PxRect;
use std::collections::BTreeMap;

pub(super) struct Mask {
    pub width: u32,
    pub height: u32,
    pub cell: u32,
    cols: usize,
    rows: usize,
    bits: Vec<bool>,
}
impl Mask {
    pub fn new(width: u32, height: u32, cell: u32) -> Self {
        let cell = cell.max(1);
        let cols = width.div_ceil(cell) as usize;
        let rows = height.div_ceil(cell) as usize;
        Self {
            width,
            height,
            cell,
            cols,
            rows,
            bits: vec![false; cols * rows],
        }
    }
    pub fn target(&self) -> PxRect {
        PxRect::xywh([0, 0, self.width as i32, self.height as i32])
    }
    pub fn is_empty(&self) -> bool {
        !self.bits.iter().any(|b| *b)
    }
    pub fn add(&mut self, r: PxRect) -> bool {
        let r = r.intersect(&self.target());
        if r.is_empty() {
            return false;
        }
        let (x0, y0) = (
            (r.x0 as u32 / self.cell) as usize,
            (r.y0 as u32 / self.cell) as usize,
        );
        let (x1, y1) = (
            (r.x1 as u32).div_ceil(self.cell) as usize,
            (r.y1 as u32).div_ceil(self.cell) as usize,
        );
        let mut changed = false;
        for y in y0..y1 {
            for x in x0..x1 {
                let bit = &mut self.bits[y * self.cols + x];
                changed |= !*bit;
                *bit = true;
            }
        }
        changed
    }
    pub fn intersects(&self, r: PxRect) -> bool {
        let r = r.intersect(&self.target());
        if r.is_empty() {
            return false;
        }
        let x0 = (r.x0 as u32 / self.cell) as usize;
        let y0 = (r.y0 as u32 / self.cell) as usize;
        let x1 = (r.x1 as u32).div_ceil(self.cell) as usize;
        let y1 = (r.y1 as u32).div_ceil(self.cell) as usize;
        (y0..y1).any(|y| (x0..x1).any(|x| self.bits[y * self.cols + x]))
    }
    pub fn dilated(&self) -> Self {
        let mut out = Self::new(self.width, self.height, self.cell);
        for r in self.regions(usize::MAX) {
            out.add(super::back::grow(
                PxRect::xywh(r),
                self.cell.min(i32::MAX as u32) as i32,
            ));
        }
        out
    }
    pub fn regions(&self, max: usize) -> Vec<[i32; 4]> {
        let mut out: Vec<[i32; 4]> = Vec::new();
        let mut prior = BTreeMap::new();
        for y in 0..self.rows {
            let mut next = BTreeMap::new();
            let mut x = 0;
            while x < self.cols {
                if !self.bits[y * self.cols + x] {
                    x += 1;
                    continue;
                }
                let start = x;
                while x < self.cols && self.bits[y * self.cols + x] {
                    x += 1;
                }
                let key = (start, x);
                let bottom =
                    ((y as u64 + 1) * u64::from(self.cell)).min(u64::from(self.height)) as i32;
                let i = if let Some(&i) = prior.get(&key) {
                    let r: &mut [i32; 4] = &mut out[i];
                    r[3] = bottom - r[1];
                    i
                } else {
                    let left = (start as u64 * u64::from(self.cell)) as i32;
                    let top = (y as u64 * u64::from(self.cell)) as i32;
                    let right = (x as u64 * u64::from(self.cell)).min(u64::from(self.width)) as i32;
                    out.push([left, top, right - left, bottom - top]);
                    out.len() - 1
                };
                next.insert(key, i);
            }
            prior = next;
        }
        // Bound replay count by adding as little area as possible per pair merge.
        // Absorb overlaps to a fixed point: replaying a blended draw through overlapping
        // scissors would blend the same pixel twice, including in the back buffer.
        while out.len() > max.max(1) {
            let mut best = (0, 1, i64::MAX);
            for i in 0..out.len() {
                for j in i + 1..out.len() {
                    let a = PxRect::xywh(out[i]);
                    let b = PxRect::xywh(out[j]);
                    let union = union(a, b);
                    let growth = union.area() - a.area() - b.area() + a.intersect(&b).area();
                    if growth < best.2 {
                        best = (i, j, growth);
                    }
                }
            }
            let b = PxRect::xywh(out.remove(best.1));
            let a = PxRect::xywh(out.remove(best.0));
            let mut r = union(a, b);
            let mut slot = best.0;
            while let Some(i) = out
                .iter()
                .position(|other| r.intersects(&PxRect::xywh(*other)))
            {
                r = union(r, PxRect::xywh(out.remove(i)));
                if i < slot {
                    slot -= 1;
                }
            }
            out.insert(slot, [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]);
        }
        debug_assert!(out.iter().enumerate().all(|(i, a)| out[i + 1..]
            .iter()
            .all(|b| !PxRect::xywh(*a).intersects(&PxRect::xywh(*b)))));
        out
    }
}

fn union(a: PxRect, b: PxRect) -> PxRect {
    PxRect {
        x0: a.x0.min(b.x0),
        y0: a.y0.min(b.y0),
        x1: a.x1.max(b.x1),
        y1: a.y1.max(b.y1),
    }
}
