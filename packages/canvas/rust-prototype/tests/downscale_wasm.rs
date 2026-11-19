// rustc builds the production module directly: no browser, bindgen or extra Cargo dependency.
#[path = "../src/canvas_items/downscale.rs"]
mod downscale;

#[unsafe(no_mangle)]
pub extern "C" fn check_downscale() -> u32 {
    assert!(cfg!(all(
        target_arch = "wasm32",
        target_feature = "simd128"
    )));
    downscale::tests::compare_images() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn check_division() -> u32 {
    downscale::tests::exhaustive_division() as u32
}
