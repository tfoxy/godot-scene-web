//! Conservative positive-alpha coverage of RGBA8 level zero, in 8×8 texel blocks.

/// A summed-area table of blocks containing any alpha > 0 texel. Queries may include live
/// texels outside the requested rectangle's edge blocks, but never miss a live texel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlphaTable {
    pub width: u32,
    pub height: u32,
    stride: usize,
    sums: Vec<u32>,
}

impl AlphaTable {
    /// Unknown or malformed levels have no table. Storage is one word per block plus a zero
    /// border, independent of the number of live texels; no per-texel bitmap is retained.
    pub fn from_rgba8(width: u32, height: u32, rgba: &[u8]) -> Option<Self> {
        let len = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)?;
        if width == 0 || height == 0 || rgba.len() < len {
            return None;
        }
        let (bw, bh) = (width.div_ceil(8) as usize, height.div_ceil(8) as usize);
        let stride = bw + 1;
        let mut sums = vec![0u32; stride.checked_mul(bh + 1)?];
        for by in 0..bh {
            let mut row = 0;
            for bx in 0..bw {
                let mut live = false;
                for y in by * 8..((by + 1) * 8).min(height as usize) {
                    let start = (y * width as usize + bx * 8) * 4;
                    let end = (y * width as usize + ((bx + 1) * 8).min(width as usize)) * 4;
                    live |= rgba[start..end].chunks_exact(4).any(|p| p[3] != 0);
                }
                row += u32::from(live);
                sums[(by + 1) * stride + bx + 1] = sums[by * stride + bx + 1] + row;
            }
        }
        Some(Self {
            width,
            height,
            stride,
            sums,
        })
    }

    /// Inclusive texel bounds, after sampler handling, wholly inside this level.
    pub fn any(&self, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
        if x0 > x1 || y0 > y1 || x1 >= self.width || y1 >= self.height {
            return true;
        }
        let (x0, y0, x1, y1) = (
            x0 as usize / 8,
            y0 as usize / 8,
            x1 as usize / 8 + 1,
            y1 as usize / 8 + 1,
        );
        let at = |x, y| self.sums[y * self.stride + x];
        at(x1, y1) + at(x0, y0) != at(x0, y1) + at(x1, y0)
    }

    pub fn storage_bytes(&self) -> usize {
        self.sums.len() * 4
    }
}
