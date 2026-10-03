//! wasm-bindgen boundary: one scene, patch, or resource bundle per call.
use crate::renderer::Renderer;
use wasm_bindgen::prelude::*;

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
