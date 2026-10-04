//! What [`crate::renderer::Renderer`] asks of the GPU.
//!
//! The renderer owns everything that is not a GPU call: the scene contract, staging, geometry, the
//! damage plan, the bind caches, residency bookkeeping and every counter. A backend owns the GPU
//! objects and issues the calls. One present asks, in this order:
//!
//! 1. [`GpuBackend::acquire_frame`] (only when the present renders);
//! 2. [`GpuBackend::begin_validation`];
//! 3. instance writes ([`GpuBackend::grow_instances`], [`GpuBackend::write_instances`]), binds for
//!    draws new to the caches ([`GpuBackend::create_bind`]) and the design size
//!    ([`GpuBackend::write_design_size`]);
//! 4. [`GpuBackend::encode`]: the picture pass (whole, or scissored to the damage rectangles) and
//!    the surface copy, submitted;
//! 5. [`GpuBackend::end_validation`]. A failure discards the candidate: the renderer restores the
//!    instance ranges it wrote and keeps the last accepted picture;
//! 6. the present: [`GpuBackend::present_frame`] for an acquired surface frame, otherwise
//!    [`GpuBackend::present_picture`] into the canvas the backend draws to.
//!
//! The wgpu implementation is [`wgpu_backend::WgpuBackend`].
use crate::{
    damage::DeviceRect,
    geometry::{Draw, Instance, TEXTURE_SLOTS},
    present::PresentMode,
    resources::ResourceFormat,
};

pub mod wgpu_backend;

/// How much of picture `target` a picture pass redraws.
pub enum PictureRegion<'a> {
    /// Clear the picture to transparent and replay every draw. `dedupe_pipelines` skips a pipeline
    /// switch to the pipeline already set (`Renderer::set_draw_state_dedupe`).
    Full { dedupe_pipelines: bool },
    /// Redraw `rects` in place: per rectangle, scissor, clear to transparent, then replay in order
    /// every draw whose `selection` bound reaches it. Needs [`GpuBackend::ensure_damage_clear`].
    Partial {
        rects: &'a [DeviceRect],
        selection: &'a [DeviceRect],
    },
}

/// One picture pass: `draws` over the instances written so far, each sampling its `binds` entry.
pub struct PicturePass<'a, Bind> {
    /// Which of the two pictures to draw into.
    pub target: usize,
    pub draws: &'a [Draw],
    /// One per draw, aligned with `draws`.
    pub binds: &'a [Bind],
    pub region: PictureRegion<'a>,
}

/// The GPU work of one rendering present, encoded and submitted by [`GpuBackend::encode`].
pub struct FrameWork<'a, B: GpuBackend + ?Sized> {
    pub picture: Option<PicturePass<'a, B::Bind>>,
    /// Copy picture `.1` into the acquired surface frame `.0` (wgpu's surface present only).
    pub surface_copy: Option<(&'a B::Frame, usize)>,
    /// `fault-injection` builds: make this submission fail validation (the rollback fixture).
    pub inject_validation_failure: bool,
}

/// Draw calls a partial picture pass issued (clears included) and the device pixels it covered.
pub type PartialWork = (usize, u64);

pub trait GpuBackend {
    /// One resident resource texture (an `upload_rgba_batch` key).
    type Texture;
    /// The textures one draw samples, slot by slot. Cached by the renderer per draw and per
    /// resource-key list, so it must be cheap to clone.
    type Bind: Clone;
    /// A surface frame acquired for one present. A backend that draws straight into its canvas
    /// never acquires one.
    type Frame;
    /// An open validation scope around one present's GPU work.
    type Validation;

    /// The backend name reported in every present result (`webgl2`, `gles`, ...).
    fn name(&self) -> &str;
    fn present_mode(&self) -> PresentMode;
    fn max_texture_side(&self) -> u32;
    /// Sampled texture slots the adapter offers (at least [`TEXTURE_SLOTS`]).
    fn sampled_texture_slots(&self) -> u32;
    /// The `gpuTimerCapability` diagnostic.
    fn timer_capability(&self) -> serde_json::Value;
    /// Textures and buffers the backend created during construction: the renderer's counter baseline.
    fn creation_baseline(&self) -> (u64, u64);

    /// Size the output and recreate both pictures at `width` x `height` (already checked against
    /// [`Self::max_texture_side`]). Their contents are undefined until the next full redraw.
    fn resize(&mut self, width: u32, height: u32);

    /// Create a texture, filled with `pixels` (tightly packed RGBA8) when given.
    fn create_texture(
        &mut self,
        width: u32,
        height: u32,
        format: ResourceFormat,
        pixels: Option<&[u8]>,
    ) -> Self::Texture;
    fn write_texture(
        &mut self,
        texture: &Self::Texture,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    );
    /// Release a texture the renderer dropped or replaced. Every cached bind naming it has already
    /// been invalidated, or is invalidated before the next draw.
    fn release_texture(&mut self, texture: Self::Texture);
    /// The bind for one draw: slot `i` samples `slots[i]`, or opaque white when `None`.
    fn create_bind(&self, slots: &[Option<&Self::Texture>; TEXTURE_SLOTS]) -> Self::Bind;
    /// Create what a partial picture pass clears with, once. `true` when this call created it
    /// (one texture).
    fn ensure_damage_clear(&mut self) -> bool;

    /// Replace the instance buffer with one of `capacity` instances. Its contents are undefined.
    fn grow_instances(&mut self, capacity: usize);
    /// Write `instances` at instance index `first` of the buffer.
    fn write_instances(&mut self, first: usize, instances: &[Instance]);
    /// The design size the scene's vertex stage projects through.
    fn write_design_size(&mut self, width: u32, height: u32);

    /// Acquire the surface frame a rendering present draws into, or `None` when the backend
    /// presents the picture itself. An error fails the present before any GPU work.
    fn acquire_frame(&mut self) -> Result<Option<Self::Frame>, String>;
    fn begin_validation(&mut self) -> Self::Validation;
    /// Encode and submit one present's GPU work. Returns the partial pass's work, if one ran.
    fn encode(&mut self, work: FrameWork<'_, Self>) -> Option<PartialWork>;
    /// Close the scope `begin_validation` opened. `Err` names the validation failure; the renderer
    /// then discards the candidate and keeps the last accepted picture.
    fn end_validation(&mut self, scope: Self::Validation) -> Result<(), String>;
    /// Present an acquired surface frame (after a passed validation).
    fn present_frame(&mut self, frame: Self::Frame);
    /// Draw picture `picture` into the canvas, only inside `partial` when the canvas keeps its
    /// previous pixels. Returns the pixels written. An error fails the present.
    fn present_picture(
        &mut self,
        picture: usize,
        partial: Option<&[DeviceRect]>,
    ) -> Result<u64, String>;
}
