//! wasm-bindgen boundary: one scene, patch, or resource bundle per call.
#[cfg(feature = "gl-backend")]
use crate::backend::gl::GlBackend;
use crate::{
    backend::wgpu_backend::WgpuBackend, idle::IdleSet, present::PresentMode, renderer::Renderer,
};
use wasm_bindgen::prelude::*;

/// The renderer over the backend it was created with: wgpu (`create`, `createWithPresent`) or, with
/// the `gl-backend` feature, direct WebGL2 (`createWithGl`).
// One per RustRenderer, matched on every call: boxing a variant would add an indirection, not save memory.
#[allow(clippy::large_enum_variant)]
enum Inner {
    Wgpu(Renderer<WgpuBackend>),
    #[cfg(feature = "gl-backend")]
    Gl(Renderer<GlBackend>),
}
/// Run `$body` with `$r` bound to the renderer, whichever backend it has.
macro_rules! with {
    ($inner:expr, $r:ident => $body:expr) => {
        match $inner {
            Inner::Wgpu($r) => $body,
            #[cfg(feature = "gl-backend")]
            Inner::Gl($r) => $body,
        }
    };
}

/// Decode an `RIA1` idle set and return every target's command matrix at `t_ms` (six f64 per target), with no
/// renderer: the parity check for a caller's own patch path.
#[wasm_bindgen(js_name = idleEvaluate)]
pub fn idle_evaluate(bytes: &[u8], t_ms: f64) -> Result<Vec<f64>, JsValue> {
    let set = IdleSet::decode(bytes).map_err(|e| JsValue::from_str(&e))?;
    Ok(set.evaluate(t_ms).into_iter().flatten().collect())
}

#[wasm_bindgen]
pub struct RustRenderer {
    inner: Inner,
}
#[wasm_bindgen]
impl RustRenderer {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(canvas: web_sys::HtmlCanvasElement) -> Result<RustRenderer, JsValue> {
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let watched = canvas.clone();
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut inner = Renderer::new(&instance, surface, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;
        inner.watch_context_loss(&watched);
        inner.record_wasm_call();
        Ok(Self {
            inner: Inner::Wgpu(inner),
        })
    }
    /// `create` with a present mode: `"surface"` (what `create` does), `"direct"` (this renderer
    /// creates the WebGL2 context and blits the picture into the canvas without a wgpu surface),
    /// `"preserved"` (direct, `preserveDrawingBuffer: true`, a partial redraw blits only its damage)
    /// or `"preserved-desync"` (preserved plus `desynchronized: true`). Any other mode is an error.
    #[wasm_bindgen(js_name = createWithPresent)]
    pub async fn create_with_present(
        canvas: web_sys::HtmlCanvasElement,
        mode: String,
    ) -> Result<RustRenderer, JsValue> {
        let mode = PresentMode::parse(&mode).map_err(|e| JsValue::from_str(&e))?;
        if mode == PresentMode::Surface {
            return Self::create(canvas).await;
        }
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let inner = Renderer::new_direct(&instance, canvas, mode, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;
        inner.record_wasm_call();
        Ok(Self {
            inner: Inner::Wgpu(inner),
        })
    }
    /// The direct-WebGL2 backend: the same renderer (wire, damage present, idle animations), issuing
    /// GL through glow on a context it creates, with no wgpu device in between. `mode` is
    /// `"direct"`, `"preserved"` or `"preserved-desync"`; `"surface"` and unknown modes are errors.
    /// A lost context is restored in place: after `webglcontextrestored` the caller calls
    /// `restore_context()`, then uploads and admits again. Present only in builds with the
    /// `gl-backend` feature: its presence is the capability probe. A refused creation deletes
    /// whatever it made and resets the context state it set; the canvas keeps a WebGL2 context with
    /// `mode`'s attributes, which `createWithPresent(canvas, mode)` reuses as is.
    #[cfg(feature = "gl-backend")]
    #[wasm_bindgen(js_name = createWithGl)]
    pub async fn create_with_gl(
        canvas: web_sys::HtmlCanvasElement,
        mode: String,
    ) -> Result<RustRenderer, JsValue> {
        let mode = PresentMode::parse(&mode).map_err(|e| JsValue::from_str(&e))?;
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let backend = GlBackend::new(canvas, mode).map_err(|e| JsValue::from_str(&e))?;
        let inner =
            Renderer::with_backend(backend, width, height).map_err(|e| JsValue::from_str(&e))?;
        inner.record_wasm_call();
        Ok(Self {
            inner: Inner::Gl(inner),
        })
    }
    /// The present mode this renderer was created with.
    #[wasm_bindgen(getter)]
    pub fn present_mode(&self) -> String {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.present_mode().name().to_owned()
        })
    }

    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.backend_name().to_owned()
        })
    }
    #[wasm_bindgen(getter)]
    pub fn max_texture_side(&self) -> u32 {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.max_texture_side()
        })
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.resize(width, height).map_err(|e| JsValue::from_str(&e))
        })
    }
    pub fn upload_rgba_batch(&mut self, bytes: &[u8]) -> Result<u32, JsValue> {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.upload_rgba_batch(bytes)
                .map(|n| n as u32)
                .map_err(|e| JsValue::from_str(&e))
        })
    }
    pub fn admit_scene(&mut self, bytes: &[u8]) -> String {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            serde_json::to_string(&r.admit_scene(bytes)).unwrap()
        })
    }
    pub fn apply_patch(&mut self, bytes: &[u8]) -> String {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            serde_json::to_string(&r.apply_patch(bytes)).unwrap()
        })
    }
    pub async fn present(&mut self) -> String {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            serde_json::to_string(&r.present().await).unwrap()
        })
    }
    /// Call from a `webglcontextrestored` handler: takes the restore now (the GL backend re-creates
    /// its objects in place; every texture and the scene must be uploaded and admitted again).
    /// `false` while the context is still lost: a wgpu renderer (replace it) or a GL restore that
    /// could not re-create its objects (the next restore event tries again).
    pub fn restore_context(&mut self) -> bool {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.restore_context()
        })
    }
    /// Install idle animations (`RIA1`) for the committed revision; returns the target count. Replaces any
    /// installed set; a refused set leaves none installed.
    pub fn set_idle_anims(&mut self, bytes: &[u8]) -> Result<u32, JsValue> {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.set_idle_anims(bytes).map_err(|e| JsValue::from_str(&e))
        })
    }
    pub fn clear_idle_anims(&mut self) {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.clear_idle_anims();
        })
    }
    /// One synchronous idle frame at `t_ms` (see `Renderer::present_idle`): a bit set, 0 on refusal.
    pub fn present_idle(&mut self, t_ms: f64) -> u32 {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.present_idle(t_ms)
        })
    }
    /// The installed set's command matrices at `t_ms` (six f64 per target).
    pub fn idle_poses(&self, t_ms: f64) -> Vec<f64> {
        with!(&self.inner, r => r.idle_poses(t_ms))
    }
    /// The last `present_idle`'s present result as JSON (`present()`'s shape), or `null` before one.
    pub fn idle_last_result(&self) -> String {
        with!(&self.inner, r => serde_json::to_string(&r.idle_last_result()).unwrap())
    }
    /// Cumulative idle counters as JSON (diagnostics; not for the frame path).
    pub fn idle_stats(&self) -> String {
        with!(&self.inner, r => serde_json::to_string(r.idle_stats()).unwrap())
    }
    /// Capability probe: `set_idle_anims` / `present_idle` exist. Older glue reads `undefined`.
    #[wasm_bindgen(getter)]
    pub fn idle_anims(&self) -> bool {
        true
    }
    /// Diagnostic only: associates one present call with a scene/patch operation ID.
    pub fn set_phase_operation_id(&mut self, id: u32) {
        with!(&mut self.inner, r => r.set_phase_operation_id(id))
    }
    pub fn set_phase_identity(&mut self, run_id: String, renderer_instance_id: String, id: u32) {
        with!(&mut self.inner, r => r.set_phase_identity(run_id, renderer_instance_id, id))
    }
    /// Opt into the `set_pipeline`-dedupe draw path (default off). One
    /// artifact serves both A/B arms of the `rustFast` measurement.
    pub fn set_draw_state_dedupe(&mut self, enabled: bool) {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.set_draw_state_dedupe(enabled);
        })
    }
    /// Opt into the damage present (default off): a patch redraws only the
    /// picture pixels it can change, and a present with nothing to change
    /// skips the GPU. A caller probes for this method before calling it.
    pub fn set_damage_present(&mut self, enabled: bool) {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.set_damage_present(enabled);
        })
    }
    /// Diagnostic: brute-force re-derivation of every partial damage plan
    /// (same bounds model, so a bookkeeping check, not pixel evidence); a
    /// failed check counts in `damageStats.verifyMismatches` and redraws whole.
    pub fn set_damage_verify(&mut self, enabled: bool) {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.set_damage_verify(enabled);
        })
    }
    #[wasm_bindgen(js_name = gpuTimerCapability)]
    pub fn gpu_timer_capability(&self) -> String {
        with!(&self.inner, r => r.gpu_timer_capability().to_string())
    }
    #[cfg(feature = "fault-injection")]
    #[wasm_bindgen(js_name = debugValidationFailureOnce)]
    pub fn debug_validation_failure_once(&mut self) {
        with!(&mut self.inner, r => {
            r.record_wasm_call();
            r.debug_validation_failure_once();
        })
    }
    /// Capability probe: `apply_patch` accepts a patch `resources` list (a replaced raster-text key). Glue
    /// built before this returns `undefined` for the property, and such a crate refuses the field.
    #[wasm_bindgen(getter)]
    pub fn patch_resources(&self) -> bool {
        true
    }
    #[wasm_bindgen(getter)]
    pub fn upload_calls(&self) -> u64 {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.upload_calls
        })
    }
    #[wasm_bindgen(getter)]
    pub fn present_calls(&self) -> u64 {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.present_calls
        })
    }
    #[wasm_bindgen(getter)]
    pub fn upload_bytes(&self) -> u64 {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.upload_bytes
        })
    }
    #[wasm_bindgen(getter)]
    pub fn texture_creations(&self) -> u64 {
        with!(&self.inner, r => {
            r.record_wasm_call();
            r.texture_creations
        })
    }
    pub fn dispose(self) {}
}
