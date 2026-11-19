/// Reduce a straight-alpha RGBA8 image by `k` with a box filter weighted by alpha (the mean of
/// the premultiplied texels, un-premultiplied), so transparent texels do not darken an edge. A
/// block with no alpha at all keeps its plain colour mean. Edge blocks average the texels they
/// have. `src` is `width * height * 4` bytes.
pub fn downscale_rgba8(src: &[u8], width: u32, height: u32, k: u32) -> Vec<u8> {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    if k == 2 && width >= 8 && height >= 2 {
        return simd::downscale(src, width, height);
    }
    downscale_rgba8_scalar(src, width, height, k)
}

pub(super) fn downscale_rgba8_scalar(src: &[u8], width: u32, height: u32, k: u32) -> Vec<u8> {
    let (w, h, k) = (width as usize, height as usize, k as usize);
    let (dw, dh) = (w.div_ceil(k), h.div_ceil(k));
    let mut out = vec![0u8; dw * dh * 4];
    for dy in 0..dh {
        let (y0, y1) = (dy * k, ((dy + 1) * k).min(h));
        for dx in 0..dw {
            let (x0, x1) = (dx * k, ((dx + 1) * k).min(w));
            let (mut a, mut premul, mut plain) = (0u64, [0u64; 3], [0u64; 3]);
            for y in y0..y1 {
                let row = &src[(y * w + x0) * 4..(y * w + x1) * 4];
                for p in row.chunks_exact(4) {
                    let pa = u64::from(p[3]);
                    a += pa;
                    for c in 0..3 {
                        premul[c] += u64::from(p[c]) * pa;
                        plain[c] += u64::from(p[c]);
                    }
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u64;
            let o = &mut out[(dy * dw + dx) * 4..][..4];
            for c in 0..3 {
                o[c] = if a > 0 {
                    ((premul[c] + a / 2) / a) as u8
                } else {
                    ((plain[c] + n / 2) / n) as u8
                };
            }
            o[3] = ((a + n / 2) / n) as u8;
        }
    }
    out
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd {
    use core::arch::wasm32::*;

    // Each input contains four source pixels. Sum the two rows and adjacent columns,
    // then collect the even lanes into four destination pixels.
    #[inline]
    fn sum_blocks(t0: v128, t1: v128, b0: v128, b1: v128) -> v128 {
        let left = u32x4_add(t0, b0);
        let right = u32x4_add(t1, b1);
        let left = u32x4_add(left, i32x4_shuffle::<1, 0, 3, 2>(left, left));
        let right = u32x4_add(right, i32x4_shuffle::<1, 0, 3, 2>(right, right));
        i32x4_shuffle::<0, 2, 4, 6>(left, right)
    }

    // Numerators <= 255*a + floor(a/2), a in 1..=1020. Both integer operands are
    // exactly representable in f32. The nearest non-integral quotient is >= 1/1020
    // from an integer, whereas f32 division's error here is <= 2^-16. Truncation
    // therefore gives the integer quotient, including exact multiples. The shared
    // native/wasm exhaustive test covers every numerator in this superset.
    #[inline]
    pub(super) fn divide(n: v128, a: v128) -> v128 {
        u32x4_trunc_sat_f32x4(f32x4_div(f32x4_convert_u32x4(n), f32x4_convert_u32x4(a)))
    }

    #[inline]
    fn colour<const SHIFT: u32>(pixels: [v128; 4], alphas: [v128; 4], a: v128) -> v128 {
        let mask = u32x4_splat(255);
        let c = pixels.map(|p| v128_and(u32x4_shr(p, SHIFT), mask));
        let plain = sum_blocks(c[0], c[1], c[2], c[3]);
        let p = core::array::from_fn::<_, 4, _>(|i| u32x4_mul(c[i], alphas[i]));
        let premul = sum_blocks(p[0], p[1], p[2], p[3]);
        let clear = u32x4_eq(a, u32x4_splat(0));
        let numerator = v128_bitselect(
            u32x4_add(plain, u32x4_splat(2)),
            u32x4_add(premul, u32x4_shr(a, 1)),
            clear,
        );
        let denominator = v128_bitselect(u32x4_splat(4), a, clear);
        divide(numerator, denominator)
    }

    pub(super) fn downscale(src: &[u8], width: u32, height: u32) -> Vec<u8> {
        let (w, h) = (width as usize, height as usize);
        // Establish the bound for all raw loads, including the last complete row pair.
        let len = w
            .checked_mul(h)
            .and_then(|pixels| pixels.checked_mul(4))
            .expect("RGBA8 image size overflow");
        assert!(src.len() >= len);
        let (dw, dh) = (w.div_ceil(2), h.div_ceil(2));
        let mut out = vec![0; dw * dh * 4];
        for y in 0..dh {
            let mut x = 0;
            if y * 2 + 1 < h {
                while x * 2 + 8 <= w {
                    let top = ((y * 2) * w + x * 2) * 4;
                    let bottom = top + w * 4;
                    // Eight pixels exist on both rows, and four output pixels exist.
                    unsafe {
                        let pixels = [
                            v128_load(src.as_ptr().add(top).cast()),
                            v128_load(src.as_ptr().add(top + 16).cast()),
                            v128_load(src.as_ptr().add(bottom).cast()),
                            v128_load(src.as_ptr().add(bottom + 16).cast()),
                        ];
                        let alphas = pixels.map(|p| u32x4_shr(p, 24));
                        let a = sum_blocks(alphas[0], alphas[1], alphas[2], alphas[3]);
                        let r = colour::<0>(pixels, alphas, a);
                        let g = colour::<8>(pixels, alphas, a);
                        let b = colour::<16>(pixels, alphas, a);
                        let alpha = u32x4_shl(u32x4_shr(u32x4_add(a, u32x4_splat(2)), 2), 24);
                        let rgba = v128_or(
                            v128_or(r, u32x4_shl(g, 8)),
                            v128_or(u32x4_shl(b, 16), alpha),
                        );
                        v128_store(out.as_mut_ptr().add((y * dw + x) * 4).cast(), rgba);
                    }
                    x += 4;
                }
            }
            // Incomplete SIMD groups and the odd last row use scalar arithmetic.
            for dx in x..dw {
                let mut texels = [0u8; 16];
                let cols = (w - dx * 2).min(2);
                let rows = (h - y * 2).min(2);
                for row in 0..rows {
                    let at = (((y * 2 + row) * w) + dx * 2) * 4;
                    texels[row * cols * 4..(row + 1) * cols * 4]
                        .copy_from_slice(&src[at..at + cols * 4]);
                }
                let pixel = super::downscale_rgba8_scalar(&texels, cols as u32, rows as u32, 2);
                out[(y * dw + dx) * 4..(y * dw + dx + 1) * 4].copy_from_slice(&pixel);
            }
        }
        out
    }
}

#[cfg(test)]
#[path = "../../tests/downscale_cases.rs"]
mod cases;

#[cfg(test)]
pub(super) mod tests {
    pub fn compare_images() -> usize {
        super::cases::check(super::downscale_rgba8, super::downscale_rgba8_scalar)
    }

    pub fn exhaustive_division() -> u64 {
        super::cases::check_quotients(|n, a| {
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            unsafe {
                use core::arch::wasm32::*;
                let q =
                    super::simd::divide(v128_load(n.as_ptr().cast()), v128_load(a.as_ptr().cast()));
                let mut out = [0; 4];
                v128_store(out.as_mut_ptr().cast(), q);
                out
            }
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            core::array::from_fn(|i| (n[i] as f32 / a[i] as f32) as u32)
        })
    }

    #[test]
    fn candidate_matches_scalar() {
        assert_eq!(compare_images(), 1073);
    }

    #[test]
    fn division_is_exact() {
        assert_eq!(exhaustive_division(), 133_042_170);
    }
}
