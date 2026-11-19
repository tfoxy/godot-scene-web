// Shared by the native unit test and the dependency-free Node wasm probe.
type Filter = fn(&[u8], u32, u32, u32) -> Vec<u8>;

pub fn check(candidate: Filter, scalar: Filter) -> usize {
    let mut seed = 0x73a9_1b2du32;
    let mut random = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut count = 0;
    let mut check_image = |w: u32, h: u32, k: u32, mode: u32| {
        let mut src = vec![0; (w * h * 4) as usize];
        for (i, p) in src.chunks_exact_mut(4).enumerate() {
            p.copy_from_slice(&random().to_le_bytes());
            // Large mixed images also contain entire clear and opaque blocks.
            p[3] = match mode {
                0 => 0,
                1 => 255,
                2 => {
                    if p[3] < 128 {
                        0
                    } else {
                        255
                    }
                }
                _ => match (i / w as usize / 2 + i % w as usize / 2) % 5 {
                    0 => 0,
                    1 => 255,
                    _ => p[3],
                },
            };
        }
        let expected = scalar(&src, w, h, k);
        let actual = candidate(&src, w, h, k);
        assert_eq!(actual.len(), expected.len(), "size {w}x{h}, k={k}");
        if let Some(i) = actual.iter().zip(&expected).position(|(a, b)| a != b) {
            panic!(
                "size {w}x{h}, k={k}, mode={mode}, byte {i}: {} != {}",
                actual[i], expected[i]
            );
        }
        count += 1;
    };
    for (w, h) in [(1, 1), (2, 2), (3, 2), (2, 3), (3, 3), (9, 7)] {
        for mode in 0..4 {
            for k in [1, 2, 3] {
                check_image(w, h, k, mode);
            }
        }
    }
    // Different row alignment, tails and alpha patterns; deterministic on both targets.
    for i in 0..1000u32 {
        check_image(1 + i * 37 % 97, 1 + i * 53 % 89, 1 + i % 4, (i / 4) % 4);
    }
    check_image(5380, 1320, 2, 3);
    count
}

// Every numerator in a superset of the filter's possible premul + floor(alpha/2),
// including exact multiples and the neighbours on either side of each boundary.
pub fn check_quotients(divide: impl Fn([u32; 4], [u32; 4]) -> [u32; 4]) -> u64 {
    let mut count = 0;
    for a in 1..=1020u32 {
        let last = 255 * a + a / 2;
        for n in (0..=last).step_by(4) {
            let ns = core::array::from_fn(|i| (n + i as u32).min(last));
            let actual = divide(ns, [a; 4]);
            for i in 0..4 {
                assert_eq!(actual[i], ns[i] / a, "numerator={}, alpha={a}", ns[i]);
            }
            count += u64::from((last - n + 1).min(4));
        }
    }
    count
}
