//! What [`crate::renderer::Renderer`] asks of the GPU.
//!
//! The renderer owns everything that is not a GPU call: the scene contract, staging, geometry, the
//! damage plan, the bind caches, residency bookkeeping, which canvas regions a present writes, and
//! every counter. A backend owns the GPU objects and issues the calls. One present asks, in order:
//!
//! 1. [`GpuBackend::context_state`]: a lost context fails the present before any work;
//! 2. [`GpuBackend::acquire_frame`] (only when the present renders);
//! 3. [`GpuBackend::begin_validation`];
//! 4. instance writes ([`GpuBackend::grow_instances`], [`GpuBackend::write_instances`]), binds for
//!    draws new to the caches ([`GpuBackend::create_bind`]) and the design size
//!    ([`GpuBackend::write_design_size`]);
//! 5. [`GpuBackend::encode`]: the picture pass (whole, or scissored to the damage rectangles) and
//!    the surface copy, submitted;
//! 6. [`GpuBackend::end_validation`]. A failure discards the candidate: the renderer restores the
//!    instance ranges it wrote and keeps the last accepted picture;
//! 7. the present: [`GpuBackend::present_frame`] for an acquired surface frame, otherwise
//!    [`GpuBackend::present_picture`] into the canvas the backend draws to.
//!
//! A [`BackendError::Lost`] from any step, or [`ContextState::Lost`], means every GPU object is
//! gone: the renderer drops its textures, binds and residency, and the caller uploads and admits
//! again once [`ContextState::Restored`] (or, for a backend that cannot restore in place, on a new
//! renderer).
//!
//! Implementations: [`wgpu_backend::WgpuBackend`], and with the `gl-backend` feature in the browser,
//! `gl::GlBackend`.
use crate::{
    damage::DeviceRect,
    geometry::{Draw, Instance, TEXTURE_SLOTS},
    present::PresentMode,
    resources::ResourceFormat,
};

#[cfg(all(target_arch = "wasm32", feature = "gl-backend"))]
pub mod gl;
#[cfg(feature = "gl-backend")]
pub mod gl_layout;
pub mod wgpu_backend;

/// Why a backend operation failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendError {
    /// The GPU context (or device) is lost: nothing the backend created survives.
    Lost,
    /// This operation was refused; the context is fine and keeps the last accepted picture.
    Failed(String),
}
impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Lost => f.write_str("GPU context lost"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

/// The backend's context, as its own loss and restore events last reported it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextState {
    Ready,
    /// Lost and not (yet) restored. Every operation is refused.
    Lost,
    /// A lost context came back and this call re-created every object the backend owns. Every
    /// texture and bind the renderer held belongs to the old context.
    Restored,
}

/// GPU objects an operation allocated (the renderer's creation counters).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Created {
    pub textures: u64,
    pub buffers: u64,
}

/// How much of picture `target` a picture pass redraws.
pub enum PictureRegion<'a> {
    /// Clear the picture to transparent and replay every draw.
    Full,
    /// Redraw `rects` in place: per rectangle, scissor, clear to transparent, then replay in order
    /// every draw whose `selection` bound reaches it.
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

    /// The backend name reported in every present result (`webgl2`, `gles`, `webgl2-direct`, ...).
    fn name(&self) -> &str;
    fn present_mode(&self) -> PresentMode;
    fn max_texture_side(&self) -> u32;
    /// Sampled texture slots the adapter offers (at least [`TEXTURE_SLOTS`]).
    fn sampled_texture_slots(&self) -> u32;
    /// The `gpuTimerCapability` diagnostic.
    fn timer_capability(&self) -> serde_json::Value;
    /// What the backend allocated during construction: the renderer's counter baseline.
    fn creation_baseline(&self) -> Created;
    /// A backend-specific draw-state option (`Renderer::set_draw_state_dedupe`). Default: ignored.
    fn set_draw_state_dedupe(&mut self, _enabled: bool) {}

    /// The context as the backend's loss and restore hooks (events or callbacks, never a GPU query)
    /// last reported it. `Restored` is returned once, by the call that re-created the backend's
    /// objects.
    fn context_state(&mut self) -> ContextState;

    /// Size the output and recreate both pictures at `width` x `height` (at least 1x1, already
    /// checked against [`Self::max_texture_side`]). Their contents are undefined until the next
    /// full redraw, and the canvas is cleared. An error leaves the size, the pictures and the canvas
    /// as they were (`Failed`), or reports the context lost (`Lost`).
    fn resize(&mut self, width: u32, height: u32) -> Result<Created, BackendError>;

    /// Create a texture, filled with `pixels` (tightly packed RGBA8) when given.
    fn create_texture(
        &mut self,
        width: u32,
        height: u32,
        format: ResourceFormat,
        pixels: Option<&[u8]>,
    ) -> Result<Self::Texture, BackendError>;
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
    /// been invalidated, or is invalidated before the next draw. (After a loss the renderer drops
    /// the old context's textures without releasing them.)
    fn release_texture(&mut self, texture: Self::Texture);
    /// The bind for one draw: slot `i` samples `slots[i]`, or opaque white when `None`.
    fn create_bind(&self, slots: &[Option<&Self::Texture>; TEXTURE_SLOTS]) -> Self::Bind;
    /// Prepare what a partial picture pass clears with, once (the damage present is turning on).
    fn ensure_damage_clear(&mut self) -> Created;

    /// Replace the instance buffer's storage with room for `capacity` instances. Its contents are
    /// undefined. Reports a buffer only when it created a new buffer object.
    fn grow_instances(&mut self, capacity: usize) -> Created;
    /// Write `instances` at instance index `first` of the buffer.
    fn write_instances(&mut self, first: usize, instances: &[Instance]);
    /// The design size the scene's vertex stage projects through.
    fn write_design_size(&mut self, width: u32, height: u32);

    /// Acquire the surface frame a rendering present draws into, or `None` when the backend
    /// presents the picture itself. An error fails the present before any GPU work.
    fn acquire_frame(&mut self) -> Result<Option<Self::Frame>, BackendError>;
    fn begin_validation(&mut self) -> Self::Validation;
    /// Encode and submit one present's GPU work. Returns the partial pass's work, if one ran.
    fn encode(&mut self, work: FrameWork<'_, Self>) -> Option<PartialWork>;
    /// Close the scope `begin_validation` opened. An error discards the candidate; the renderer
    /// keeps the last accepted picture.
    fn end_validation(&mut self, scope: Self::Validation) -> Result<(), BackendError>;
    /// Present an acquired surface frame (after a passed validation).
    fn present_frame(&mut self, frame: Self::Frame);
    /// Draw `regions` of picture `picture` into the canvas (scissored to them when `scissored`;
    /// otherwise `regions` is the whole canvas). The renderer chose the regions.
    fn present_picture(
        &mut self,
        picture: usize,
        regions: &[DeviceRect],
        scissored: bool,
    ) -> Result<(), BackendError>;
}
