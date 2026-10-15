// The wgpu renderer's browser backend is wgpu's `webgl` feature. A wasm32 build without it (a
// `canvas-items`-only consumer, gate7-design.md D30) leaves the wgpu renderer and `RustRenderer`'s
// wasm-bindgen exports out entirely; native builds and `build-web.sh` (`webgl,gl-backend`) are as
// before.
#[cfg(any(not(target_arch = "wasm32"), feature = "webgl"))]
pub mod backend;
#[cfg(feature = "canvas-items")]
pub mod canvas_items;
pub mod contract;
pub mod damage;
pub mod present;
pub mod geometry;
pub mod idle;
#[cfg(any(not(target_arch = "wasm32"), feature = "webgl"))]
pub mod renderer;
pub mod resources;
#[cfg(all(target_arch = "wasm32", feature = "webgl"))]
pub mod wasm;
