//! Ordered instanced wgpu executor shared by browser WebGL2 and native harnesses.
use crate::{
    contract::{Admission, Blend, Command, Patch, Quad, SCENE_VERSION, Scene, SceneState},
    geometry::{self, Geometry, Instance, TEXTURE_SLOTS},
    resources::ResourceStore,
};
use std::cell::Cell;
use std::collections::HashMap;
use wgpu::util::DeviceExt;

// These trace timestamps bracket synchronous Rust execution only. A dropped span
// closes on every early return; no span crosses the validation future's await.
#[derive(Clone)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct PhaseIdentity {
    run_id: String,
    renderer_instance_id: String,
    operation_id: u32,
}
struct PhaseSpan {
    identity: Option<PhaseIdentity>,
    name: &'static str,
}
impl PhaseSpan {
    fn new(identity: Option<&PhaseIdentity>, name: &'static str) -> Self {
        phase_stamp(identity, name, "start");
        Self {
            identity: identity.cloned(),
            name,
        }
    }
}
impl Drop for PhaseSpan {
    fn drop(&mut self) {
        phase_stamp(self.identity.as_ref(), self.name, "end");
    }
}
#[cfg(target_arch = "wasm32")]
fn phase_stamp(identity: Option<&PhaseIdentity>, name: &str, edge: &str) {
    if let Some(identity) = identity {
        let label = if identity.run_id.is_empty() || identity.renderer_instance_id.is_empty() {
            format!("cc:rust-exec:{}:{name}:{edge}", identity.operation_id)
        } else {
            format!(
                "canvas-profile/1:{}",
                serde_json::json!({
                    "runId": identity.run_id,
                    "rendererInstanceId": identity.renderer_instance_id,
                    "operationId": identity.operation_id,
                    "phase": format!("rust.{name}"),
                    "edge": edge,
                })
            )
        };
        web_sys::console::time_stamp_with_data(&wasm_bindgen::JsValue::from_str(&label));
    }
}
#[cfg(not(target_arch = "wasm32"))]
fn phase_stamp(_identity: Option<&PhaseIdentity>, _name: &str, _edge: &str) {}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentResult {
    pub operation_id: Option<u32>,
    pub presented: bool,
    pub revision: Option<u64>,
    /// Draws submitted by this present, including the surface draw.
    pub draws: usize,
    pub resource_pending: usize,
    pub unsupported_commands: usize,
    pub backend: String,
    pub max_texture_side: u32,
    pub max_sampled_textures: u32,
    pub draw_calls: u64,
    pub buffer_creations: u64,
    pub texture_creations: u64,
    pub upload_bytes: u64,
    pub instance_upload_bytes: u64,
    pub completed_presents: u64,
    pub incremental_patches: u64,
    pub geometry_rebuilds: u64,
    pub wasm_calls: u64,
    pub error: Option<String>,
}
struct TextureEntry {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
}
struct Picture {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
}
pub struct Renderer {
    surface: wgpu::Surface<'static>,
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
    textures: HashMap<String, TextureEntry>,
    bind_cache: HashMap<Vec<Option<String>>, wgpu::BindGroup>,
    white: TextureEntry,
    pictures: [Picture; 2],
    committed_picture: Option<usize>,
    instance_buffer: Option<wgpu::Buffer>,
    instance_capacity: usize,
    committed_geometry: Geometry,
    fullscreen_buffer: wgpu::Buffer,
    pub resources: ResourceStore,
    pub state: SceneState,
    staged: Option<SceneState>,
    staged_patch_ids: Option<Vec<String>>,
    staged_delta: Option<(u64, Vec<(usize, Command)>)>,
    admitted_dimensions_epoch: u64,
    pub upload_calls: u64,
    pub upload_bytes: u64,
    pub instance_upload_bytes: u64,
    pub texture_creations: u64,
    pub buffer_creations: u64,
    pub draw_calls: u64,
    pub completed_presents: u64,
    pub incremental_patches: u64,
    pub geometry_rebuilds: u64,
    pub wasm_calls: Cell<u64>,
    pub present_calls: u64,
    phase_identity: Option<PhaseIdentity>,
    active_operation_id: Option<u32>,
    backend: String,
    adapter_info: wgpu::AdapterInfo,
    adapter_timestamp_query_supported: bool,
    adapter_texture_slots: u32,
    #[cfg(feature = "fault-injection")]
    validation_failure_once: bool,
}
impl Renderer {
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
        let adapter_info = adapter.get_info();
        let adapter_timestamp_query_supported = adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
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
        let config = surface
            .get_default_config(&adapter, width.max(1), height.max(1))
            .ok_or("surface unsupported")?;
        surface.configure(&device, &config);
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
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
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
        let white = create_texture(&device, &queue, 1, 1, &[255, 255, 255, 255]);
        let pictures = [
            create_picture(&device, &texture_layout, &sampler, &config),
            create_picture(&device, &texture_layout, &sampler, &config),
        ];
        let fullscreen_buffer = create_fullscreen_buffer(&device, width, height);
        if let Some(error) = scope.pop().await {
            return Err(format!("GPU initialization validation: {error}"));
        }
        Ok(Self {
            surface,
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
            textures: HashMap::new(),
            bind_cache: HashMap::new(),
            white,
            pictures,
            committed_picture: None,
            instance_buffer: None,
            instance_capacity: 0,
            committed_geometry: Geometry::default(),
            fullscreen_buffer,
            resources: ResourceStore::with_max_side(max_side),
            state: SceneState::default(),
            staged: None,
            staged_patch_ids: None,
            staged_delta: None,
            admitted_dimensions_epoch: 0,
            upload_calls: 0,
            upload_bytes: 0,
            instance_upload_bytes: 0,
            texture_creations: 3,
            buffer_creations: 3,
            draw_calls: 0,
            completed_presents: 0,
            incremental_patches: 0,
            geometry_rebuilds: 0,
            wasm_calls: Cell::new(0),
            present_calls: 0,
            phase_identity: None,
            active_operation_id: None,
            backend,
            adapter_info,
            adapter_timestamp_query_supported,
            adapter_texture_slots: actual.max_sampled_textures_per_shader_stage,
            #[cfg(feature = "fault-injection")]
            validation_failure_once: false,
        })
    }
    pub fn backend_name(&self) -> &str {
        &self.backend
    }
    pub fn set_phase_operation_id(&mut self, id: u32) {
        self.phase_identity = (id > 0).then_some(PhaseIdentity {
            run_id: String::new(),
            renderer_instance_id: String::new(),
            operation_id: id,
        });
    }
    pub fn set_phase_identity(&mut self, run_id: String, renderer_instance_id: String, id: u32) {
        self.phase_identity = (id > 0 && !run_id.is_empty() && !renderer_instance_id.is_empty())
            .then_some(PhaseIdentity {
                run_id,
                renderer_instance_id,
                operation_id: id,
            });
    }
    pub fn gpu_timer_capability(&self) -> serde_json::Value {
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
    pub fn record_wasm_call(&self) {
        self.wasm_calls.set(self.wasm_calls.get() + 1);
    }
    #[cfg(feature = "fault-injection")]
    pub fn debug_validation_failure_once(&mut self) {
        self.validation_failure_once = true;
    }
    pub fn max_texture_side(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let max = self.max_texture_side();
        if width.max(height) > max {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max}"
            ));
        }
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device, &self.config);
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
        self.texture_creations += 2;
        self.committed_picture = None;
        self.staged = None;
        self.staged_patch_ids = None;
        self.staged_delta = None;
        self.fullscreen_buffer = create_fullscreen_buffer(&self.device, width, height);
        self.buffer_creations += 1;
        self.queue.write_buffer(
            &self.surface_globals,
            0,
            bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
        );
        Ok(())
    }
    pub fn upload_rgba_batch(&mut self, bytes: &[u8]) -> Result<usize, String> {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "upload");
        let changed = self.resources.upload_batch(bytes)?;
        let uploaded_pixels: usize = changed
            .iter()
            .map(|key| self.resources.pixels[key].2.len())
            .sum();
        for key in &changed {
            let (w, h, p) = &self.resources.pixels[key];
            self.textures.insert(
                key.clone(),
                create_texture(&self.device, &self.queue, *w, *h, p),
            );
        }
        if !changed.is_empty() {
            self.bind_cache.clear();
        }
        self.upload_calls += 1;
        self.upload_bytes += uploaded_pixels as u64;
        self.texture_creations += changed.len() as u64;
        Ok(changed.len())
    }
    pub fn admit_scene(&mut self, bytes: &[u8]) -> Admission {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "admit");
        self.staged_patch_ids = None;
        self.staged_delta = None;
        let mut candidate = SceneState::default();
        let result = candidate.admit(bytes, &self.resources.ready());
        if result.accepted {
            let scene = candidate.scene().expect("accepted scene");
            let latest_revision = self
                .state
                .scene()
                .into_iter()
                .chain(self.staged.as_ref().and_then(|staged| staged.scene()))
                .map(|scene| scene.revision)
                .max();
            if latest_revision.is_some_and(|revision| scene.revision <= revision) {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some("version or revision mismatch".into()),
                };
            }
            if scene.width != self.config.width || scene.height != self.config.height {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some(format!(
                        "scene surface {}x{} does not match configured {}x{}",
                        scene.width, scene.height, self.config.width, self.config.height
                    )),
                };
            }
            self.staged = Some(candidate);
        } else {
            self.state.refused_total += result.unsupported_commands;
            self.staged = None;
        }
        result
    }
    pub fn apply_patch(&mut self, bytes: &[u8]) -> Admission {
        let _phase = PhaseSpan::new(self.phase_identity.as_ref(), "admit");
        let patch: Patch = match serde_json::from_slice(bytes) {
            Ok(patch) => patch,
            Err(error) => {
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some(error.to_string()),
                };
            }
        };
        if self.staged.is_none()
            && self.staged_delta.is_none()
            && self.state.scene().is_some()
            && patch.updates.iter().all(|u| u.command.quad().is_some())
        {
            let ready = (self.resources.dimensions_epoch != self.admitted_dimensions_epoch)
                .then(|| self.resources.ready());
            match self.state.preflight_patch(&patch, ready.as_ref()) {
                Ok(updates) => {
                    self.staged_delta = Some((patch.revision, updates));
                    return Admission {
                        accepted: true,
                        revision: Some(patch.revision),
                        unsupported_commands: 0,
                        resource_pending: 0,
                        error: None,
                    };
                }
                Err(error) => {
                    return Admission {
                        accepted: false,
                        revision: None,
                        unsupported_commands: 0,
                        resource_pending: 0,
                        error: Some(error),
                    };
                }
            }
        }
        let patch_ids = patch
            .updates
            .iter()
            .map(|update| update.id.clone())
            .collect::<Vec<_>>();
        let had_staged = self.staged.is_some();
        let had_delta = self.staged_delta.is_some();
        let mut candidate = SceneState::default();
        if let Some(scene) = self
            .staged
            .as_ref()
            .or(Some(&self.state))
            .and_then(|s| s.scene())
        {
            candidate.set_scene(scene.clone());
        }
        if let Some((revision, updates)) = self.staged_delta.take() {
            let scene = candidate.scene().expect("delta base");
            let materialized = Scene {
                revision,
                commands: {
                    let mut commands = scene.commands.clone();
                    for (index, command) in updates {
                        commands[index] = command;
                    }
                    commands
                },
                ..scene.clone()
            };
            candidate.set_scene(materialized);
        }
        let result = candidate.patch_parsed(patch, &self.resources.ready());
        if result.accepted {
            let scene = candidate.scene().expect("accepted patch");
            if scene.width != self.config.width || scene.height != self.config.height {
                self.staged = None;
                return Admission {
                    accepted: false,
                    revision: None,
                    unsupported_commands: 0,
                    resource_pending: 0,
                    error: Some("patch surface does not match configured surface".into()),
                };
            }
            self.staged = Some(candidate);
            if had_delta {
                self.staged_patch_ids = None;
            } else if !had_staged && self.state.scene().is_some() {
                self.staged_patch_ids = Some(patch_ids);
            } else if let (Some(existing), Some(mut ids)) =
                (self.staged_patch_ids.as_mut(), Some(patch_ids))
            {
                existing.append(&mut ids);
            }
        } else {
            self.staged = None;
            self.staged_patch_ids = None;
            self.staged_delta = None;
        }
        result
    }
    fn texture_bind(&mut self, resources: &[Option<String>]) -> wgpu::BindGroup {
        if let Some(bind) = self.bind_cache.get(resources) {
            return bind.clone();
        }
        let views: Vec<_> = (0..TEXTURE_SLOTS)
            .map(|i| {
                resources
                    .get(i)
                    .and_then(|r| r.as_ref())
                    .and_then(|key| self.textures.get(key))
                    .map_or(&self.white.view, |entry| &entry.view)
            })
            .collect();
        let bind = bind_textures(&self.device, &self.texture_layout, &self.sampler, &views);
        self.bind_cache.insert(resources.to_vec(), bind.clone());
        bind
    }
    pub async fn present(&mut self) -> PresentResult {
        let phase_identity = self.phase_identity.take();
        self.active_operation_id = phase_identity
            .as_ref()
            .map(|identity| identity.operation_id);
        let prepare_phase = PhaseSpan::new(phase_identity.as_ref(), "prepare");
        self.present_calls += 1;
        let candidate_scene = self
            .staged
            .as_ref()
            .and_then(|s| s.scene())
            .or_else(|| self.staged_delta.as_ref().and_then(|_| self.state.scene()));
        if let Some(scene) = candidate_scene {
            if scene.width != self.config.width || scene.height != self.config.height {
                return self.failed("scene surface does not match configured surface", 0, 0);
            }
            let pending = if self.staged_delta.is_some()
                && self.resources.dimensions_epoch == self.admitted_dimensions_epoch
            {
                0
            } else {
                scene
                    .resources
                    .iter()
                    .filter(|r| {
                        !self.textures.contains_key(&r.key)
                            || self.resources.pixels.get(&r.key).map(|p| (p.0, p.1))
                                != Some((r.width, r.height))
                    })
                    .count()
            };
            if pending > 0 {
                return self.failed("textures missing on GPU", pending, 0);
            }
        }
        if candidate_scene.is_none() && self.committed_picture.is_none() {
            return self.failed("no completed picture", 0, 0);
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            e => return self.failed(&format!("{e:?}"), 0, 0),
        };
        let design_size = candidate_scene.map(|scene| (scene.design_width, scene.design_height));
        let mut delta_spans = self.staged_delta.as_ref().and_then(|(_, updates)| {
            let scene = self.state.scene()?;
            geometry::patch_spans(&self.committed_geometry, scene, updates, |index| {
                self.state.clips_at(index).copied()
            })
        });
        let mut incremental = delta_spans.is_some();
        let candidate_geometry = self.staged.as_ref().and_then(|s| s.scene()).map(|scene| {
            if let Some(patched) = self.staged_patch_ids.as_ref().and_then(|ids| {
                self.state.scene().and_then(|old| {
                    geometry::patch_instances(&self.committed_geometry, old, scene, ids)
                })
            }) {
                incremental = true;
                patched
            } else {
                geometry::build(scene)
            }
        });
        let fallback_geometry = if self.staged_delta.is_some() && delta_spans.is_none() {
            let scene = self.state.scene().expect("delta base");
            let mut next = scene.clone();
            for (index, command) in &self.staged_delta.as_ref().expect("delta").1 {
                next.commands[*index] = command.clone();
            }
            next.revision = self.staged_delta.as_ref().expect("delta").0;
            Some(geometry::build(&next))
        } else {
            None
        };
        let candidate_geometry = candidate_geometry.or(fallback_geometry);
        let target = if candidate_geometry.is_some() || delta_spans.is_some() {
            Some(self.committed_picture.map_or(0, |i| 1 - i))
        } else {
            None
        };
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut draws = 1usize;
        let mut dirty = Vec::new();
        if let Some(spans) = delta_spans.as_ref() {
            draws += self.committed_geometry.draws.len();
            let buffer = self
                .instance_buffer
                .as_ref()
                .expect("committed instances allocated");
            for (start, instances) in spans {
                if instances.is_empty() {
                    continue;
                }
                let end = start + instances.len();
                let bytes = bytemuck::cast_slice(instances);
                self.queue.write_buffer(
                    buffer,
                    (*start * std::mem::size_of::<Instance>()) as u64,
                    bytes,
                );
                self.upload_bytes += bytes.len() as u64;
                self.instance_upload_bytes += bytes.len() as u64;
                dirty.push((*start, end));
            }
        }
        if let Some(ref g) = candidate_geometry {
            draws += g.draws.len();
            let needed = g.instances.len().max(1);
            if needed > self.instance_capacity {
                self.instance_capacity = needed.next_power_of_two();
                self.instance_buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("grow-only scene instances"),
                    size: (self.instance_capacity * std::mem::size_of::<Instance>()) as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }));
                self.buffer_creations += 1;
                dirty.push((0, g.instances.len()));
            } else if geometry::same_layout(&self.committed_geometry, g) {
                dirty = geometry::dirty_ranges(&self.committed_geometry.instances, &g.instances);
            } else {
                dirty.push((0, g.instances.len()));
            }
            let buffer = self
                .instance_buffer
                .as_ref()
                .expect("instance buffer allocated");
            for &(start, end) in &dirty {
                if start < end {
                    let bytes = bytemuck::cast_slice(&g.instances[start..end]);
                    self.queue.write_buffer(
                        buffer,
                        (start * std::mem::size_of::<Instance>()) as u64,
                        bytes,
                    );
                    self.upload_bytes += bytes.len() as u64;
                    self.instance_upload_bytes += bytes.len() as u64;
                }
            }
        }
        let bind_resources: Vec<_> = candidate_geometry
            .as_ref()
            .or_else(|| delta_spans.as_ref().map(|_| &self.committed_geometry))
            .map(|g| g.draws.iter().map(|d| d.resources.clone()).collect())
            .unwrap_or_default();
        let binds: Vec<_> = bind_resources
            .iter()
            .map(|resources| self.texture_bind(resources))
            .collect();
        if let Some((design_width, design_height)) = design_size {
            self.queue.write_buffer(
                &self.design_globals,
                0,
                bytemuck::cast_slice(&[design_width as f32, design_height as f32, 0.0, 0.0]),
            );
        }
        drop(prepare_phase);
        let encode_phase = PhaseSpan::new(phase_identity.as_ref(), "encode-submit");
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("scene and surface"),
            });
        let render_geometry = candidate_geometry
            .as_ref()
            .or_else(|| delta_spans.as_ref().map(|_| &self.committed_geometry));
        if let (Some(g), Some(target)) = (render_geometry, target) {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("candidate picture"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pictures[target].view,
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
            for (draw, bind) in g.draws.iter().zip(&binds) {
                pass.set_pipeline(&self.pipelines[if draw.blend == Blend::Add { 1 } else { 0 }]);
                pass.set_bind_group(1, bind, &[]);
                pass.draw(0..6, draw.start..draw.start + draw.count);
            }
        }
        let picture = &self.pictures[target.or(self.committed_picture).expect("picture exists")];
        let view = frame.texture.create_view(&Default::default());
        {
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
        if std::mem::take(&mut self.validation_failure_once) {
            // Both buffers are 16 bytes and lack copy usages. The validation
            // scope must refuse this candidate before queue.present.
            encoder.copy_buffer_to_buffer(&self.surface_globals, 0, &self.design_globals, 0, 32);
        }
        self.queue.submit([encoder.finish()]);
        self.draw_calls += draws as u64;
        drop(encode_phase);
        // The validation future may suspend here. Its initial poll and wait are unclassified.
        phase_stamp(phase_identity.as_ref(), "validation.wait", "start");
        let validation_error = scope.pop().await;
        phase_stamp(phase_identity.as_ref(), "validation.wait", "end");
        let _resume_phase = PhaseSpan::new(phase_identity.as_ref(), "resume");
        if let Some(error) = validation_error {
            self.restore_instances(&dirty);
            self.staged = None;
            self.staged_patch_ids = None;
            self.staged_delta = None;
            return self.failed(&format!("GPU validation: {error}"), 0, draws);
        }
        self.queue.present(frame);
        self.completed_presents += 1;
        if let Some(g) = candidate_geometry {
            if incremental {
                self.incremental_patches += 1;
            } else {
                self.geometry_rebuilds += 1;
            }
            self.committed_geometry = g;
            self.committed_picture = target;
            if let Some(staged) = self.staged.take() {
                self.state = staged;
                self.admitted_dimensions_epoch = self.resources.dimensions_epoch;
            } else if let Some((revision, updates)) = self.staged_delta.take() {
                self.state.commit_updates(revision, updates);
            }
            self.staged_patch_ids = None;
        } else if let Some(spans) = delta_spans.take() {
            for (start, instances) in spans {
                let end = start + instances.len();
                self.committed_geometry.instances[start..end].copy_from_slice(&instances);
            }
            let (revision, updates) = self.staged_delta.take().expect("delta exists");
            self.state.commit_updates(revision, updates);
            self.committed_picture = target;
            self.incremental_patches += 1;
        }
        self.result(true, draws, None, 0)
    }
    fn restore_instances(&mut self, dirty: &[(usize, usize)]) {
        if let Some(buffer) = &self.instance_buffer {
            for &(start, end) in dirty {
                let end = end.min(self.committed_geometry.instances.len());
                if start < end {
                    let bytes =
                        bytemuck::cast_slice(&self.committed_geometry.instances[start..end]);
                    self.queue.write_buffer(
                        buffer,
                        (start * std::mem::size_of::<Instance>()) as u64,
                        bytes,
                    );
                    self.upload_bytes += bytes.len() as u64;
                }
            }
        }
    }
    fn failed(&mut self, error: &str, pending: usize, draws: usize) -> PresentResult {
        self.staged = None;
        self.staged_patch_ids = None;
        self.staged_delta = None;
        self.result(false, draws, Some(error.into()), pending)
    }
    fn result(
        &self,
        presented: bool,
        draws: usize,
        error: Option<String>,
        pending: usize,
    ) -> PresentResult {
        PresentResult {
            operation_id: self.active_operation_id,
            presented,
            revision: self.state.scene().map(|s| s.revision),
            draws,
            resource_pending: pending,
            unsupported_commands: self.state.refused_total,
            backend: self.backend.clone(),
            max_texture_side: self.max_texture_side(),
            max_sampled_textures: self.adapter_texture_slots,
            draw_calls: self.draw_calls,
            buffer_creations: self.buffer_creations,
            texture_creations: self.texture_creations,
            upload_bytes: self.upload_bytes,
            instance_upload_bytes: self.instance_upload_bytes,
            completed_presents: self.completed_presents,
            incremental_patches: self.incremental_patches,
            geometry_rebuilds: self.geometry_rebuilds,
            wasm_calls: self.wasm_calls.get(),
            error,
        }
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
    pixels: &[u8],
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
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
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
    let view = texture.create_view(&Default::default());
    TextureEntry {
        _texture: texture,
        view,
    }
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
        _texture: texture,
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
