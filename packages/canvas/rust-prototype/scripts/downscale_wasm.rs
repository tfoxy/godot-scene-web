// Compiled directly by bench-downscale-wasm.mjs, without Cargo dependencies.
#[path = "../src/canvas_items/downscale.rs"]
mod downscale;

use std::{hint::black_box, sync::OnceLock};

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
compile_error!("This benchmark requires wasm32 with simd128");

const WIDTH: u32 = 5380;
const HEIGHT: u32 = 1320;
const OUTPUT_BYTES: usize = (WIDTH as usize / 2) * (HEIGHT as usize / 2) * 4;
static INPUT: OnceLock<Vec<u8>> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "C" fn prepare() -> usize {
    INPUT.get_or_init(|| {
        let mut seed = 0x73a9_1b2du32;
        let mut src = vec![0; (WIDTH * HEIGHT * 4) as usize];
        for (i, pixel) in src.chunks_exact_mut(4).enumerate() {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            pixel.copy_from_slice(&seed.to_le_bytes());
            // Include clear and opaque blocks alongside random partial alpha.
            match (i / WIDTH as usize / 2 + i % WIDTH as usize / 2) % 5 {
                0 => pixel[3] = 0,
                1 => pixel[3] = 255,
                _ => (),
            }
        }
        src
    });
    OUTPUT_BYTES
}

fn run(filter: fn(&[u8], u32, u32, u32) -> Vec<u8>) -> *mut u8 {
    let output = filter(
        black_box(INPUT.get().expect("call prepare first").as_slice()),
        black_box(WIDTH),
        black_box(HEIGHT),
        black_box(2),
    );
    // JS reads every output byte and frees it outside the timed call.
    Box::into_raw(output.into_boxed_slice()).cast::<u8>()
}

#[unsafe(no_mangle)]
pub extern "C" fn scalar() -> *mut u8 {
    run(downscale::downscale_rgba8_scalar)
}

#[unsafe(no_mangle)]
pub extern "C" fn simd() -> *mut u8 {
    run(downscale::downscale_rgba8)
}

/// # Safety
/// `ptr` must be an unfreed output returned by `scalar` or `simd` in this module.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_output(ptr: *mut u8) {
    unsafe {
        drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(
            ptr,
            OUTPUT_BYTES,
        )));
    }
}
