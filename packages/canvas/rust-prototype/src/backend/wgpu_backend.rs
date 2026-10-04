//! The wgpu implementation of [`GpuBackend`]: a wgpu device on WebGL2 (browser) or any native
//! adapter, presenting through wgpu's surface or, in the direct present modes, through the canvas
//! context the backend created ([`crate::present::canvas`]).
use super::{FrameWork, GpuBackend, PartialWork, PictureRegion};
use crate::{
    contract::{Blend, Command, Quad, SCENE_VERSION, Scene},
    damage::DeviceRect,
    geometry::{self, Draw, Instance, TEXTURE_SLOTS},
    present::PresentMode,
    resources::ResourceFormat,
};
use wgpu::util::DeviceExt;

pub struct TextureEntry {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}
struct Picture {
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
}
/// Where a present puts the committed picture (see [`crate::present`]).
enum Output {
    /// wgpu's surface: copy pass into the acquired texture, then wgpu-hal's present draw.
    Surface(wgpu::Surface<'static>),
    /// A canvas whose WebGL2 context this backend created: one present draw from the picture.
    #[cfg(target_arch = "wasm32")]
    Canvas(crate::present::canvas::CanvasPresenter),
}
pub struct WgpuBackend {
    output: Output,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface_globals: wgpu::Buffer,
    surface_globals_bind: wgpu::BindGroup,
    design_globals: wgpu::Buffer,
    design_globals_bind: wgpu::BindGroup,
    pipelines: [wgpu::RenderPipeline; 2],
    copy_pipeline: wgpu::RenderPipeline,
    texture_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    white: TextureEntry,
    pictures: [Picture; 2],
    instance_buffer: Option<wgpu::Buffer>,
    fullscreen_buffer: wgpu::Buffer,
    /// A 1x1 transparent texture bound to the copy pipeline: drawn under a
    /// scissor it clears exactly the damaged pixels, which `LoadOp::Clear`
    /// cannot (it ignores the scissor). Created on first enable.
    damage_clear: Option<(TextureEntry, wgpu::BindGroup)>,
    backend: String,
    adapter_info: wgpu::AdapterInfo,
    adapter_timestamp_query_supported: bool,
    adapter_texture_slots: u32,
}
/// Poll a future once. Every future the present path awaits (wgpu-core's error-scope pop) is ready on its first
/// poll, so a present runs to completion synchronously; `None` means a backend broke that assumption.
fn resolve_now<F: std::future::Future>(future: F) -> Option<F::Output> {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(value) => Some(value),
        std::task::Poll::Pending => None,
    }
}

impl WgpuBackend {
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| e.to_string())?;
        Self::with_adapter(adapter, Output::Surface(surface), width, height).await
    }
    /// The direct present (`mode` is not `Surface`): create `canvas`'s WebGL2 context with the
    /// mode's attributes and build the adapter on it. No `wgpu::Surface` exists; `present` draws
    /// the committed picture into the canvas itself.
    #[cfg(target_arch = "wasm32")]
    pub async fn new_direct(
        instance: &wgpu::Instance,
        canvas: web_sys::HtmlCanvasElement,
        mode: PresentMode,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if mode == PresentMode::Surface {
            return Err("the surface present mode uses Renderer::new".into());
        }
        let context = crate::present::canvas::create_context(&canvas, mode.context_attributes())?;
        // SAFETY: the context was just created and is not lost; the renderer keeps the canvas
        // (and so the context) alive at least as long as the device built on it.
        let exposed = unsafe {
            wgpu::hal::gles::Adapter::new_external(context, wgpu::GlBackendOptions::default())
        }
        .ok_or("WebGL2 adapter unavailable on the created context")?;
        // SAFETY: the WebGL GLES instance holds no per-instance adapter state; any GL instance
        // accepts an adapter exposed from an external context.
        let adapter = unsafe { instance.create_adapter_from_hal(exposed) };
        let presenter = crate::present::canvas::CanvasPresenter::new(canvas, mode);
        Self::with_adapter(adapter, Output::Canvas(presenter), width, height).await
    }
    async fn with_adapter(
        adapter: wgpu::Adapter,
        mut output: Output,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let adapter_info = adapter.get_info();
        let adapter_timestamp_query_supported =
            adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let backend = match adapter_info.backend {
            wgpu::Backend::Gl if cfg!(target_arch = "wasm32") => "webgl2".to_string(),
            wgpu::Backend::Gl => "gles".to_string(),
            wgpu::Backend::Vulkan => "vulkan".to_string(),
            wgpu::Backend::BrowserWebGpu => "webgpu".to_string(),
            other => format!("{other:?}"),
        };
        let actual = adapter.limits();
        if actual.max_sampled_textures_per_shader_stage < TEXTURE_SLOTS as u32 {
            return Err(format!(
                "8 texture slots required; adapter provides {}",
                actual.max_sampled_textures_per_shader_stage
            ));
        }
        let mut requested = wgpu::Limits::downlevel_webgl2_defaults();
        requested.max_texture_dimension_2d = actual.max_texture_dimension_2d;
        requested.max_sampled_textures_per_shader_stage = TEXTURE_SLOTS as u32;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_limits: requested,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        let max_side = device.limits().max_texture_dimension_2d;
        if width.max(height) > max_side {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max_side}"
            ));
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let config = match &mut output {
            Output::Surface(surface) => {
                let config = surface
                    .get_default_config(&adapter, width.max(1), height.max(1))
                    .ok_or("surface unsupported")?;
                surface.configure(&device, &config);
                config
            }
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => {
                presenter.set_size(width.max(1), height.max(1));
                // Never configured; it carries the size and the picture format. `get_default_config`
                // on the WebGL2 surface picks `Rgba8UnormSrgb` (wgpu-core lists sRGB formats
                // first), so the surface path's pictures are sRGB; these must be too, or the scene
                // would blend in a different space.
                wgpu::SurfaceConfiguration {
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    color_space: wgpu::SurfaceColorSpace::Auto,
                    width: width.max(1),
                    height: height.max(1),
                    desired_maximum_frame_latency: 2,
                    present_mode: wgpu::PresentMode::Fifo,
                    alpha_mode: wgpu::CompositeAlphaMode::Auto,
                    view_formats: vec![],
                }
            }
        };
        let surface_globals = viewport_buffer(&device, width, height);
        let design_globals = viewport_buffer(&device, 1, 1);
        let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let surface_globals_bind = viewport_bind(&device, &globals_layout, &surface_globals);
        let design_globals_bind = viewport_bind(&device, &globals_layout, &design_globals);
        let texture_entries: Vec<_> = (0..TEXTURE_SLOTS)
            .map(|i| wgpu::BindGroupLayoutEntry {
                binding: i as u32,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            })
            .chain(std::iter::once(wgpu::BindGroupLayoutEntry {
                binding: TEXTURE_SLOTS as u32,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            }))
            .collect();
        let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &texture_entries,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("instanced scene shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shader.wgsl").into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&globals_layout), Some(&texture_layout)],
            immediate_size: 0,
        });
        let attrs = wgpu::vertex_attr_array![0=>Float32x4,1=>Float32x4,2=>Float32x4,3=>Float32x4,4=>Float32x4,5=>Float32x4,6=>Float32x4,7=>Float32x4,8=>Float32x4,9=>Float32x4,10=>Float32x2,11=>Float32x2,12=>Float32x2];
        let make_pipeline = |entry_point: &str, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("instanced scene pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<Instance>() as u64,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &attrs,
                    })],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let add = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let pipelines = [
            make_pipeline("fs", Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)),
            make_pipeline("fs", Some(add)),
        ];
        let copy_pipeline = make_pipeline("fs_copy", None);
        let white = create_texture(
            &device,
            &queue,
            1,
            1,
            ResourceFormat::Srgb,
            Some(&[255, 255, 255, 255]),
        );
        let pictures = [
            create_picture(&device, &texture_layout, &sampler, &config),
            create_picture(&device, &texture_layout, &sampler, &config),
        ];
        let fullscreen_buffer = create_fullscreen_buffer(&device, width, height);
        if let Some(error) = scope.pop().await {
            return Err(format!("GPU initialization validation: {error}"));
        }
        #[cfg(target_arch = "wasm32")]
        if let Output::Canvas(presenter) = &mut output {
            // Everything a canvas present needs from wgpu-hal is checked here, so it cannot fail later.
            for picture in &pictures {
                gl_texture(&picture.texture)?;
            }
            // SAFETY: wgpu-hal's glow context of this device, which is the canvas's context.
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Gles>() }
                .ok_or("device is not a GLES device")?;
            unsafe { presenter.init(hal.context().lock()) }?;
        }
        Ok(Self {
            output,
            device,
            queue,
            config,
            surface_globals,
            surface_globals_bind,
            design_globals,
            design_globals_bind,
            pipelines,
            copy_pipeline,
            texture_layout,
            sampler,
            white,
            pictures,
            instance_buffer: None,
            fullscreen_buffer,
            damage_clear: None,
            backend,
            adapter_info,
            adapter_timestamp_query_supported,
            adapter_texture_slots: actual.max_sampled_textures_per_shader_stage,
        })
    }
    /// Redraw `rects` of picture `target` in place: per rectangle, scissor,
    /// clear to transparent, then replay in order every draw whose footprint
    /// reaches it. Returns the draw calls issued and the pixels covered.
    fn encode_partial_picture(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: usize,
        draws: &[Draw],
        binds: &[wgpu::BindGroup],
        rects: &[DeviceRect],
        selection: &[DeviceRect],
    ) -> PartialWork {
        let (_, clear_bind) = self.damage_clear.as_ref().expect("damage present enabled");
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("damaged picture"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.pictures[target].view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            ..Default::default()
        });
        let mut issued = 0usize;
        let mut pixels = 0u64;
        for rect in rects {
            pass.set_scissor_rect(
                rect.x0 as u32,
                rect.y0 as u32,
                (rect.x1 - rect.x0) as u32,
                (rect.y1 - rect.y0) as u32,
            );
            // The picture has the surface's size, so the surface quad and
            // globals cover it exactly; the copy pipeline does not blend.
            pass.set_pipeline(&self.copy_pipeline);
            pass.set_bind_group(0, &self.surface_globals_bind, &[]);
            pass.set_bind_group(1, clear_bind, &[]);
            pass.set_vertex_buffer(0, self.fullscreen_buffer.slice(..));
            pass.draw(0..6, 0..1);
            issued += 1;
            pass.set_bind_group(0, &self.design_globals_bind, &[]);
            if let Some(buffer) = &self.instance_buffer {
                pass.set_vertex_buffer(0, buffer.slice(..));
            }
            let mut last_pipeline: Option<usize> = None;
            for ((draw, bind), bounds) in draws.iter().zip(binds).zip(selection) {
                if !bounds.intersects(rect) {
                    continue;
                }
                let pipeline_index = if draw.blend == Blend::Add { 1 } else { 0 };
                if last_pipeline != Some(pipeline_index) {
                    pass.set_pipeline(&self.pipelines[pipeline_index]);
                    last_pipeline = Some(pipeline_index);
                }
                pass.set_bind_group(1, bind, &[]);
                pass.draw(0..6, draw.start..draw.start + draw.count);
                issued += 1;
            }
            pixels += rect.area();
        }
        (issued, pixels)
    }
}

impl GpuBackend for WgpuBackend {
    type Texture = TextureEntry;
    type Bind = wgpu::BindGroup;
    type Frame = wgpu::SurfaceTexture;
    type Validation = wgpu::ErrorScopeGuard;

    fn name(&self) -> &str {
        &self.backend
    }
    fn present_mode(&self) -> PresentMode {
        match &self.output {
            Output::Surface(_) => PresentMode::Surface,
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => presenter.mode,
        }
    }
    fn max_texture_side(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }
    fn sampled_texture_slots(&self) -> u32 {
        self.adapter_texture_slots
    }
    fn timer_capability(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": self.backend,
            "adapterName": self.adapter_info.name,
            "adapterVendor": self.adapter_info.vendor,
            "adapterDevice": self.adapter_info.device,
            "adapterDriver": self.adapter_info.driver,
            "adapterDriverInfo": self.adapter_info.driver_info,
            "adapterTimestampQuerySupported": self.adapter_timestamp_query_supported,
            "wgpuTimestampQuery": self.device.features().contains(wgpu::Features::TIMESTAMP_QUERY),
            "webgl2TimerExtension": null,
            "webgl2TimerExtensionReason": "wgpu owns the WebGL2 context and exposes no safe context accessor",
            "gpuElapsedNs": null,
            "gpuElapsedNsReason": "no validated timer query on the executor context"
        })
    }
    fn creation_baseline(&self) -> (u64, u64) {
        // White and the two pictures; the two viewport buffers and the surface quad.
        (3, 3)
    }
    fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        match &mut self.output {
            Output::Surface(surface) => surface.configure(&self.device, &self.config),
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(presenter) => presenter.set_size(self.config.width, self.config.height),
        }
        self.pictures = [
            create_picture(
                &self.device,
                &self.texture_layout,
                &self.sampler,
                &self.config,
            ),
            create_picture(
                &self.device,
                &self.texture_layout,
                &self.sampler,
                &self.config,
            ),
        ];
        self.fullscreen_buffer = create_fullscreen_buffer(&self.device, width, height);
        self.queue.write_buffer(
            &self.surface_globals,
            0,
            bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        );
    }
    fn create_texture(
        &mut self,
        width: u32,
        height: u32,
        format: ResourceFormat,
        pixels: Option<&[u8]>,
    ) -> TextureEntry {
        create_texture(&self.device, &self.queue, width, height, format, pixels)
    }
    fn write_texture(
        &mut self,
        texture: &TextureEntry,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) {
        write_texture_region(&self.queue, &texture.texture, x, y, width, height, pixels);
    }
    fn release_texture(&mut self, texture: TextureEntry) {
        drop(texture);
    }
    fn create_bind(&self, slots: &[Option<&TextureEntry>; TEXTURE_SLOTS]) -> wgpu::BindGroup {
        let views: Vec<_> = slots
            .iter()
            .map(|slot| slot.map_or(&self.white.view, |entry| &entry.view))
            .collect();
        bind_textures(&self.device, &self.texture_layout, &self.sampler, &views)
    }
    fn ensure_damage_clear(&mut self) -> bool {
        if self.damage_clear.is_some() {
            return false;
        }
        let entry = create_texture(
            &self.device,
            &self.queue,
            1,
            1,
            ResourceFormat::Linear,
            Some(&[0, 0, 0, 0]),
        );
        let bind = bind_textures(
            &self.device,
            &self.texture_layout,
            &self.sampler,
            &[&entry.view; TEXTURE_SLOTS],
        );
        self.damage_clear = Some((entry, bind));
        true
    }
    fn grow_instances(&mut self, capacity: usize) {
        self.instance_buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("grow-only scene instances"),
            size: (capacity * std::mem::size_of::<Instance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
    }
    fn write_instances(&mut self, first: usize, instances: &[Instance]) {
        let buffer = self
            .instance_buffer
            .as_ref()
            .expect("instance buffer allocated");
        self.queue.write_buffer(
            buffer,
            (first * std::mem::size_of::<Instance>()) as u64,
            bytemuck::cast_slice(instances),
        );
    }
    fn write_design_size(&mut self, width: u32, height: u32) {
        self.queue.write_buffer(
            &self.design_globals,
            0,
            bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        );
    }
    fn acquire_frame(&mut self) -> Result<Option<wgpu::SurfaceTexture>, String> {
        match &self.output {
            Output::Surface(surface) => match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(f)
                | wgpu::CurrentSurfaceTexture::Suboptimal(f) => Ok(Some(f)),
                e => Err(format!("{e:?}")),
            },
            #[cfg(target_arch = "wasm32")]
            Output::Canvas(_) => Ok(None),
        }
    }
    fn begin_validation(&mut self) -> wgpu::ErrorScopeGuard {
        self.device.push_error_scope(wgpu::ErrorFilter::Validation)
    }
    fn encode(&mut self, work: FrameWork<'_, Self>) -> Option<PartialWork> {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("scene and surface"),
            });
        let mut partial = None;
        if let Some(picture) = work.picture {
            match picture.region {
                PictureRegion::Partial { rects, selection } => {
                    partial = Some(self.encode_partial_picture(
                        &mut encoder,
                        picture.target,
                        picture.draws,
                        picture.binds,
                        rects,
                        selection,
                    ));
                }
                PictureRegion::Full { dedupe_pipelines } => {
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("candidate picture"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &self.pictures[picture.target].view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        ..Default::default()
                    });
                    pass.set_bind_group(0, &self.design_globals_bind, &[]);
                    if let Some(buffer) = &self.instance_buffer {
                        pass.set_vertex_buffer(0, buffer.slice(..));
                    }
                    let mut last_pipeline: Option<usize> = None;
                    for (draw, bind) in picture.draws.iter().zip(picture.binds) {
                        let pipeline_index = if draw.blend == Blend::Add { 1 } else { 0 };
                        if !dedupe_pipelines || last_pipeline != Some(pipeline_index) {
                            pass.set_pipeline(&self.pipelines[pipeline_index]);
                            last_pipeline = Some(pipeline_index);
                        }
                        pass.set_bind_group(1, bind, &[]);
                        pass.draw(0..6, draw.start..draw.start + draw.count);
                    }
                }
            }
        }
        if let Some((frame, shown)) = work.surface_copy {
            let picture = &self.pictures[shown];
            let view = frame.texture.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("surface copy"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.copy_pipeline);
            pass.set_bind_group(0, &self.surface_globals_bind, &[]);
            pass.set_bind_group(1, &picture.bind, &[]);
            pass.set_vertex_buffer(0, self.fullscreen_buffer.slice(..));
            pass.draw(0..6, 0..1);
        }
        #[cfg(feature = "fault-injection")]
        if work.inject_validation_failure {
            // Both buffers are 16 bytes and lack copy usages. The validation
            // scope must refuse this candidate before queue.present.
            encoder.copy_buffer_to_buffer(&self.surface_globals, 0, &self.design_globals, 0, 32);
        }
        #[cfg(not(feature = "fault-injection"))]
        let _ = work.inject_validation_failure;
        self.queue.submit([encoder.finish()]);
        partial
    }
    fn end_validation(&mut self, scope: wgpu::ErrorScopeGuard) -> Result<(), String> {
        match resolve_now(scope.pop()) {
            Some(None) => Ok(()),
            Some(Some(error)) => Err(error.to_string()),
            None => Err("validation scope did not resolve synchronously".into()),
        }
    }
    fn present_frame(&mut self, frame: wgpu::SurfaceTexture) {
        self.queue.present(frame);
    }
    /// Direct present: draw picture `index` into the canvas, only inside `partial` on a preserved
    /// canvas that still shows the previous picture. Construction checked every fallible step, so
    /// an error here means wgpu-hal changed under us.
    #[cfg(target_arch = "wasm32")]
    fn present_picture(
        &mut self,
        index: usize,
        partial: Option<&[DeviceRect]>,
    ) -> Result<u64, String> {
        let Output::Canvas(presenter) = &mut self.output else {
            return Err("no canvas output".into());
        };
        let (width, height) = (self.config.width, self.config.height);
        let regions = crate::present::blit_regions(
            presenter.mode,
            presenter.force_full,
            partial,
            width,
            height,
        );
        let scissored = regions != [DeviceRect::full(width, height)];
        let raw = gl_texture(&self.pictures[index].texture)?;
        // SAFETY: wgpu-hal's glow context of this device, which is the canvas's context; `raw` is a
        // picture this backend keeps alive, sized to the configured surface.
        let device = unsafe { self.device.as_hal::<wgpu::hal::api::Gles>() }
            .ok_or("device is not a GLES device")?;
        unsafe {
            presenter.present(
                device.context().lock(),
                raw,
                &regions,
                scissored,
                width,
                height,
            )
        }?;
        Ok(crate::present::blit_pixels(&regions))
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn present_picture(
        &mut self,
        _index: usize,
        _partial: Option<&[DeviceRect]>,
    ) -> Result<u64, String> {
        Err("no canvas output".into())
    }
}
#[cfg(target_arch = "wasm32")]
impl Drop for WgpuBackend {
    fn drop(&mut self) {
        if let Output::Canvas(presenter) = &mut self.output {
            // SAFETY: wgpu-hal's glow context of this (still alive) device.
            if let Some(device) = unsafe { self.device.as_hal::<wgpu::hal::api::Gles>() } {
                unsafe { presenter.release(device.context().lock()) };
            }
        }
    }
}
/// The raw GL texture behind a wgpu texture on the WebGL2 backend.
#[cfg(target_arch = "wasm32")]
fn gl_texture(texture: &wgpu::Texture) -> Result<glow::Texture, String> {
    // SAFETY: only reads the handle; the guard is dropped before returning and the texture is
    // kept alive by its owner.
    let hal = unsafe { texture.as_hal::<wgpu::hal::api::Gles>() }.ok_or("not a GLES texture")?;
    match hal.inner {
        wgpu::hal::gles::TextureInner::Texture { raw, .. } => Ok(raw),
        _ => Err("not a GL texture object".into()),
    }
}
fn viewport_buffer(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("viewport"),
        contents: bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}
fn viewport_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    })
}
fn bind_textures(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    views: &[&wgpu::TextureView],
) -> wgpu::BindGroup {
    let entries: Vec<_> = views
        .iter()
        .enumerate()
        .map(|(i, v)| wgpu::BindGroupEntry {
            binding: i as u32,
            resource: wgpu::BindingResource::TextureView(v),
        })
        .chain(std::iter::once(wgpu::BindGroupEntry {
            binding: TEXTURE_SLOTS as u32,
            resource: wgpu::BindingResource::Sampler(sampler),
        }))
        .collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout,
        entries: &entries,
    })
}
fn create_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    w: u32,
    h: u32,
    format: ResourceFormat,
    pixels: Option<&[u8]>,
) -> TextureEntry {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: match format {
            ResourceFormat::Srgb => wgpu::TextureFormat::Rgba8UnormSrgb,
            ResourceFormat::Linear => wgpu::TextureFormat::Rgba8Unorm,
        },
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    if let Some(pixels) = pixels {
        write_texture_region(queue, &texture, 0, 0, w, h, pixels);
    }
    let view = texture.create_view(&Default::default());
    TextureEntry { texture, view }
}
fn write_texture_region(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    pixels: &[u8],
) {
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
            aspect: wgpu::TextureAspect::All,
        },
        pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(w * 4),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
}
fn create_picture(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    config: &wgpu::SurfaceConfiguration,
) -> Picture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("reusable picture"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: config.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let views = [&view; TEXTURE_SLOTS];
    let bind = bind_textures(device, layout, sampler, &views);
    Picture {
        texture,
        view,
        bind,
    }
}
fn create_fullscreen_buffer(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Buffer {
    let quad = Quad {
        resource: None,
        m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        w: width as f32,
        h: height as f32,
        src: [0.0, 0.0, 1.0, 1.0],
        color: [1.0; 4],
        blend: Blend::Mix,
        flip_h: false,
        flip_v: false,
        color_matrix: None,
    };
    let scene = Scene {
        version: SCENE_VERSION,
        revision: 0,
        width,
        height,
        design_width: width,
        design_height: height,
        resources: vec![],
        commands: vec![Command::Quad {
            id: "full".into(),
            quad,
        }],
    };
    let geometry = geometry::build(&scene);
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("static surface quad"),
        contents: bytemuck::cast_slice(&geometry.instances),
        usage: wgpu::BufferUsages::VERTEX,
    })
}
