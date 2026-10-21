//! `render-stream-core` (gate7-design.md D29, D30, Q14a): one crate that decodes, validates and
//! resolves render-stream/2 to /6 behind one `version` parameter, keeps the retained state, and
//! lowers it through D7's applier to `gsw-canvas-draw-list`'s packed list. It depends only on that
//! list, `sha2` and a JSON parser, with no wasm-bindgen, web-sys, wgpu or Godot crate, so every
//! adapter (the browser's `rs-gsw-wasm`, later the GDExtension C ABI) links it unchanged.
//!
//! The TypeScript decoder (`scripts/lib/render-stream-2.ts`) stays the checkers' decoder and this
//! crate's cross-check: `rs-core-check goldens` and `scripts/test/self-test-rs-core.ts` hold the two
//! equal (Q14d).

pub mod apply;
pub mod state;

pub mod canon;
pub mod goldens;
pub mod idtable;
pub mod json;
pub mod meta;
pub mod payload;
pub mod prof;
pub mod validate;
pub mod wire;
