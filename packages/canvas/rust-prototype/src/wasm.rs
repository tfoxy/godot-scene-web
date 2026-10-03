//! wasm-bindgen boundary: one scene, patch, or resource bundle per call.
use crate::{idle::IdleSet, present::PresentMode, renderer::Renderer};
use wasm_bindgen::prelude::*;

/// Decode an `RIA1` idle set and return every target's command matrix at `t_ms` (six f64 per target), with no
/// renderer: the parity check for a caller's own patch path.
#[wasm_bindgen(js_name = idleEvaluate)]
pub fn idle_evaluate(bytes: &[u8], t_ms: f64) -> Result<Vec<f64>, JsValue> {
    let set = IdleSet::decode(bytes).map_err(|e| JsValue::from_str(&e))?;
    Ok(set.evaluate(t_ms).into_iter().flatten().collect())
}

#[wasm_bindgen]
pub struct RustRenderer {
    inner: Renderer,
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
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let inner = Renderer::new(&instance, surface, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;
        inner.record_wasm_call();
        Ok(Self { inner })
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
        Ok(Self { inner })
    }
    /// The present mode this renderer was created with.
    #[wasm_bindgen(getter)]
    pub fn present_mode(&self) -> String {
        self.inner.record_wasm_call();
        self.inner.present_mode().name().to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.inner.record_wasm_call();
        self.inner.backend_name().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn max_texture_side(&self) -> u32 {
        self.inner.record_wasm_call();
        self.inner.max_texture_side()
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        self.inner.record_wasm_call();
        self.inner
            .resize(width, height)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn upload_rgba_batch(&mut self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.inner.record_wasm_call();
        self.inner
            .upload_rgba_batch(bytes)
            .map(|n| n as u32)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn admit_scene(&mut self, bytes: &[u8]) -> String {
        self.inner.record_wasm_call();
        serde_json::to_string(&self.inner.admit_scene(bytes)).unwrap()
    }
    pub fn apply_patch(&mut self, bytes: &[u8]) -> String {
        self.inner.record_wasm_call();
        serde_json::to_string(&self.inner.apply_patch(bytes)).unwrap()
    }
    pub async fn present(&mut self) -> String {
        self.inner.record_wasm_call();
        serde_json::to_string(&self.inner.present().await).unwrap()
    }
    /// Install idle animations (`RIA1`) for the committed revision; returns the target count. Replaces any
    /// installed set; a refused set leaves none installed.
    pub fn set_idle_anims(&mut self, bytes: &[u8]) -> Result<u32, JsValue> {
        self.inner.record_wasm_call();
        self.inner
            .set_idle_anims(bytes)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn clear_idle_anims(&mut self) {
        self.inner.record_wasm_call();
        self.inner.clear_idle_anims();
    }
    /// One synchronous idle frame at `t_ms` (see `Renderer::present_idle`): a bit set, 0 on refusal.
    pub fn present_idle(&mut self, t_ms: f64) -> u32 {
        self.inner.record_wasm_call();
        self.inner.present_idle(t_ms)
    }
    /// The installed set's command matrices at `t_ms` (six f64 per target).
    pub fn idle_poses(&self, t_ms: f64) -> Vec<f64> {
        self.inner.idle_poses(t_ms)
    }
    /// The last `present_idle`'s present result as JSON (`present()`'s shape), or `null` before one.
    pub fn idle_last_result(&self) -> String {
        serde_json::to_string(&self.inner.idle_last_result()).unwrap()
    }
    /// Cumulative idle counters as JSON (diagnostics; not for the frame path).
    pub fn idle_stats(&self) -> String {
        serde_json::to_string(self.inner.idle_stats()).unwrap()
    }
    /// Capability probe: `set_idle_anims` / `present_idle` exist. Older glue reads `undefined`.
    #[wasm_bindgen(getter)]
    pub fn idle_anims(&self) -> bool {
        true
    }
    /// Diagnostic only: associates one present call with a scene/patch operation ID.
    pub fn set_phase_operation_id(&mut self, id: u32) {
        self.inner.set_phase_operation_id(id);
    }
    pub fn set_phase_identity(&mut self, run_id: String, renderer_instance_id: String, id: u32) {
        self.inner
            .set_phase_identity(run_id, renderer_instance_id, id);
    }
    /// Opt into the `set_pipeline`-dedupe draw path (default off). One
    /// artifact serves both A/B arms of the `rustFast` measurement.
    pub fn set_draw_state_dedupe(&mut self, enabled: bool) {
        self.inner.record_wasm_call();
        self.inner.set_draw_state_dedupe(enabled);
    }
    /// Opt into the damage present (default off): a patch redraws only the
    /// picture pixels it can change, and a present with nothing to change
    /// skips the GPU. A caller probes for this method before calling it.
    pub fn set_damage_present(&mut self, enabled: bool) {
        self.inner.record_wasm_call();
        self.inner.set_damage_present(enabled);
    }
    /// Diagnostic: brute-force re-derivation of every partial damage plan
    /// (same bounds model, so a bookkeeping check, not pixel evidence); a
    /// failed check counts in `damageStats.verifyMismatches` and redraws whole.
    pub fn set_damage_verify(&mut self, enabled: bool) {
        self.inner.record_wasm_call();
        self.inner.set_damage_verify(enabled);
    }
    #[wasm_bindgen(js_name = gpuTimerCapability)]
    pub fn gpu_timer_capability(&self) -> String {
        self.inner.gpu_timer_capability().to_string()
    }
    #[cfg(feature = "fault-injection")]
    #[wasm_bindgen(js_name = debugValidationFailureOnce)]
    pub fn debug_validation_failure_once(&mut self) {
        self.inner.record_wasm_call();
        self.inner.debug_validation_failure_once();
    }
    /// Capability probe: `apply_patch` accepts a patch `resources` list (a replaced raster-text key). Glue
    /// built before this returns `undefined` for the property, and such a crate refuses the field.
    #[wasm_bindgen(getter)]
    pub fn patch_resources(&self) -> bool {
        true
    }
    #[wasm_bindgen(getter)]
    pub fn upload_calls(&self) -> u64 {
        self.inner.record_wasm_call();
        self.inner.upload_calls
    }
    #[wasm_bindgen(getter)]
    pub fn present_calls(&self) -> u64 {
        self.inner.record_wasm_call();
        self.inner.present_calls
    }
    #[wasm_bindgen(getter)]
    pub fn upload_bytes(&self) -> u64 {
        self.inner.record_wasm_call();
        self.inner.upload_bytes
    }
    #[wasm_bindgen(getter)]
    pub fn texture_creations(&self) -> u64 {
        self.inner.record_wasm_call();
        self.inner.texture_creations
    }
    pub fn dispose(self) {}
}
