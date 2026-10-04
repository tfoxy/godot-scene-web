//! The direct-WebGL2 implementation of [`GpuBackend`]: `glow` calls on a context this backend
//! creates, with no wgpu device, queue, encoder, validation scope or per-pass state reset in between.
//!
//! It compiles the program wgpu-hal compiles for the scene (naga's translation of `shader.wgsl`,
//! generated at build time) and presents with wgpu-hal's sRGB present shader, so its pixels are the
//! wgpu backend's. What it does not do is re-issue state:
//! - samplers are bound to their units, the sampler uniforms, the globals block binding, the
//!   viewport, the clear colour and the scissor test are set once (at creation, on restore, and the
//!   viewport on resize); textures get no per-bind parameters (sampler objects decide);
//! - a vertex array per draw start (WebGL2 has no base instance) holds that draw's attribute
//!   pointers, created on first use, so a draw binds one vertex array and toggles no attributes;
//! - framebuffer, program, blending, blend function, texture units, vertex array and scissor go
//!   through a cache and are issued only when they change;
//! - no fences, no `getError`, no per-frame fixed-function resets.
//!
//! Context loss is the canvas's `webglcontextlost` event ([`LossWatch`]); a GL object the context
//! refuses to create also reports it. On `webglcontextrestored` the next call re-creates every object
//! this backend owns ([`ContextState::Restored`]); the renderer then starts from an empty residency.
use super::{
    BackendError, ContextState, Created, FrameWork, GpuBackend, PartialWork, PictureRegion,
    gl_layout::{INSTANCE_ATTRIBUTES, shaders},
};
use crate::{
    contract::Blend,
    damage::DeviceRect,
    geometry::{Draw, Instance, TEXTURE_SLOTS},
    present::{self, PresentMode, canvas::LossWatch},
    resources::ResourceFormat,
};
use glow::HasContext;
use std::collections::{HashMap, HashSet};

const STRIDE: i32 = std::mem::size_of::<Instance>() as i32;
/// The present program samples the picture on this unit; the scene samples units 0..7.
const PRESENT_UNIT: u32 = 8;
/// Uploads bind here, so they never disturb a draw's units.
const UPLOAD_UNIT: u32 = 9;

/// What is bound, so a frame issues only the changes. Reset whenever the objects are re-created.
#[derive(Default)]
struct StateCache {
    framebuffer: Option<Option<glow::Framebuffer>>,
    program: Option<glow::Program>,
    blend_enabled: Option<bool>,
    blend: Option<Blend>,
    vertex_array: Option<glow::VertexArray>,
    active_unit: Option<u32>,
    units: [Option<glow::Texture>; TEXTURE_SLOTS + 1],
    scissor: Option<[i32; 4]>,
}

struct Picture {
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
}

/// Every GL object the backend owns besides resource textures (re-created on restore).
struct Objects {
    scene_program: glow::Program,
    present_program: glow::Program,
    scene_sampler: glow::Sampler,
    present_sampler: glow::Sampler,
    pictures: [Picture; 2],
    white: glow::Texture,
    instance_buffer: glow::Buffer,
    globals: glow::Buffer,
    /// One vertex array per draw start: its attribute pointers start at that instance.
    vertex_arrays: HashMap<u32, glow::VertexArray>,
}

pub struct GlBackend {
    canvas: web_sys::HtmlCanvasElement,
    context: web_sys::WebGl2RenderingContext,
    gl: glow::Context,
    mode: PresentMode,
    width: u32,
    height: u32,
    max_side: u32,
    texture_units: u32,
    /// `None` only while the context is lost and a restore could not re-create them (the backend
    /// then reports `Lost` until the next restore event re-creates them).
    objects: Option<Objects>,
    cache: StateCache,
    loss: LossWatch,
}

fn lost<T>(_: T) -> BackendError {
    BackendError::Lost
}

/// GL objects created so far by an operation that may still fail: on failure every one is deleted,
/// so a refused creation leaves nothing behind.
#[derive(Default)]
struct Partial {
    programs: Vec<glow::Program>,
    samplers: Vec<glow::Sampler>,
    textures: Vec<glow::Texture>,
    framebuffers: Vec<glow::Framebuffer>,
    buffers: Vec<glow::Buffer>,
}
impl Partial {
    unsafe fn delete(self, gl: &glow::Context) {
        unsafe {
            for program in self.programs {
                gl.delete_program(program);
            }
            for sampler in self.samplers {
                gl.delete_sampler(sampler);
            }
            for framebuffer in self.framebuffers {
                gl.delete_framebuffer(framebuffer);
            }
            for texture in self.textures {
                gl.delete_texture(texture);
            }
            for buffer in self.buffers {
                gl.delete_buffer(buffer);
            }
        }
    }
}

/// Put back the context state this backend sets (bindings, samplers, units, scissor, blend), so
/// whoever uses the canvas's context next (a wgpu fallback on the same canvas, say) starts from the
/// WebGL defaults for everything this backend touched.
unsafe fn reset_gl_state(gl: &glow::Context) {
    unsafe {
        gl.use_program(None);
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        gl.bind_vertex_array(None);
        gl.bind_buffer(glow::ARRAY_BUFFER, None);
        gl.bind_buffer_base(glow::UNIFORM_BUFFER, 0, None);
        gl.bind_buffer(glow::UNIFORM_BUFFER, None);
        for unit in 0..=UPLOAD_UNIT {
            gl.active_texture(glow::TEXTURE0 + unit);
            gl.bind_texture(glow::TEXTURE_2D, None);
            gl.bind_sampler(unit, None);
        }
        gl.active_texture(glow::TEXTURE0);
        gl.disable(glow::SCISSOR_TEST);
        gl.disable(glow::BLEND);
    }
}

unsafe fn compile(
    gl: &glow::Context,
    vert: &str,
    frag: &str,
    partial: &mut Partial,
) -> Result<glow::Program, String> {
    unsafe {
        let program = gl.create_program()?;
        partial.programs.push(program);
        let mut shaders = Vec::new();
        for (kind, source) in [(glow::VERTEX_SHADER, vert), (glow::FRAGMENT_SHADER, frag)] {
            let shader = match gl.create_shader(kind) {
                Ok(shader) => shader,
                Err(error) => {
                    for shader in shaders {
                        gl.delete_shader(shader);
                    }
                    return Err(error);
                }
            };
            gl.shader_source(shader, source);
            gl.compile_shader(shader);
            gl.attach_shader(program, shader);
            shaders.push(shader);
        }
        gl.link_program(program);
        let linked = gl.get_program_link_status(program);
        let log = if linked {
            String::new()
        } else {
            let mut log = gl.get_program_info_log(program);
            for shader in &shaders {
                log.push_str(&gl.get_shader_info_log(*shader));
            }
            log
        };
        for shader in shaders {
            gl.detach_shader(program, shader);
            gl.delete_shader(shader);
        }
        if !linked {
            return Err(format!("program link failed: {log}"));
        }
        Ok(program)
    }
}

unsafe fn create_picture(
    gl: &glow::Context,
    width: u32,
    height: u32,
    partial: &mut Partial,
) -> Result<Picture, String> {
    unsafe {
        let texture = gl.create_texture()?;
        partial.textures.push(texture);
        let framebuffer = gl.create_framebuffer()?;
        partial.framebuffers.push(framebuffer);
        gl.active_texture(glow::TEXTURE0 + UPLOAD_UNIT);
        gl.bind_texture(glow::TEXTURE_2D, Some(texture));
        // wgpu's `Rgba8UnormSrgb` picture: blending happens in linear space, storage is sRGB.
        gl.tex_storage_2d(
            glow::TEXTURE_2D,
            1,
            glow::SRGB8_ALPHA8,
            width as i32,
            height as i32,
        );
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
        gl.framebuffer_texture_2d(
            glow::FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::TEXTURE_2D,
            Some(texture),
            0,
        );
        let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
        if status != glow::FRAMEBUFFER_COMPLETE {
            return Err(format!("picture framebuffer incomplete: {status:#x}"));
        }
        Ok(Picture {
            texture,
            framebuffer,
        })
    }
}

impl Objects {
    /// Create every object and set the state that stays for their life. Leaves the context with
    /// the instance buffer on `ARRAY_BUFFER`, the globals on `UNIFORM_BUFFER` binding 0, the samplers
    /// on their units, the upload unit active, no framebuffer bound and the scissor test on.
    /// On failure every object created so far is deleted and the context state reset.
    unsafe fn create(gl: &glow::Context, width: u32, height: u32) -> Result<Self, String> {
        let mut partial = Partial::default();
        let created = unsafe { Self::create_into(gl, width, height, &mut partial) };
        if created.is_err() {
            unsafe {
                partial.delete(gl);
                reset_gl_state(gl);
            }
        }
        created
    }
    unsafe fn create_into(
        gl: &glow::Context,
        width: u32,
        height: u32,
        partial: &mut Partial,
    ) -> Result<Self, String> {
        unsafe {
            let scene_program = compile(gl, shaders::SCENE_VERT, shaders::SCENE_FRAG, partial)?;
            let present_program = compile(
                gl,
                present::SRGB_PRESENT_VERT,
                present::SRGB_PRESENT_FRAG,
                partial,
            )?;
            gl.use_program(Some(scene_program));
            for (name, slot) in shaders::SCENE_TEXTURES {
                let location = gl.get_uniform_location(scene_program, name);
                gl.uniform_1_i32(location.as_ref(), slot as i32);
            }
            let block = gl
                .get_uniform_block_index(scene_program, shaders::GLOBALS_BLOCK)
                .ok_or("globals uniform block missing")?;
            gl.uniform_block_binding(scene_program, block, 0);
            gl.use_program(Some(present_program));
            let location = gl.get_uniform_location(present_program, "present_texture");
            gl.uniform_1_i32(location.as_ref(), PRESENT_UNIT as i32);
            gl.use_program(None);
            // wgpu's sampler with linear filters as wgpu-hal maps it: clamp-to-edge,
            // LINEAR_MIPMAP_NEAREST over one level, lod 0..32.
            let scene_sampler = gl.create_sampler()?;
            partial.samplers.push(scene_sampler);
            gl.sampler_parameter_i32(
                scene_sampler,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR_MIPMAP_NEAREST as i32,
            );
            gl.sampler_parameter_i32(scene_sampler, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
            for wrap in [
                glow::TEXTURE_WRAP_S,
                glow::TEXTURE_WRAP_T,
                glow::TEXTURE_WRAP_R,
            ] {
                gl.sampler_parameter_i32(scene_sampler, wrap, glow::CLAMP_TO_EDGE as i32);
            }
            gl.sampler_parameter_f32(scene_sampler, glow::TEXTURE_MIN_LOD, 0.0);
            gl.sampler_parameter_f32(scene_sampler, glow::TEXTURE_MAX_LOD, 32.0);
            // wgpu-hal's present: nearest filters, every other parameter at its default.
            let present_sampler = gl.create_sampler()?;
            partial.samplers.push(present_sampler);
            gl.sampler_parameter_i32(
                present_sampler,
                glow::TEXTURE_MIN_FILTER,
                glow::NEAREST as i32,
            );
            gl.sampler_parameter_i32(
                present_sampler,
                glow::TEXTURE_MAG_FILTER,
                glow::NEAREST as i32,
            );
            for unit in 0..TEXTURE_SLOTS as u32 {
                gl.bind_sampler(unit, Some(scene_sampler));
            }
            gl.bind_sampler(PRESENT_UNIT, Some(present_sampler));
            let pictures = [
                create_picture(gl, width, height, partial)?,
                create_picture(gl, width, height, partial)?,
            ];
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            let white = gl.create_texture()?;
            partial.textures.push(white);
            gl.bind_texture(glow::TEXTURE_2D, Some(white));
            gl.tex_storage_2d(glow::TEXTURE_2D, 1, glow::SRGB8_ALPHA8, 1, 1);
            gl.tex_sub_image_2d(
                glow::TEXTURE_2D,
                0,
                0,
                0,
                1,
                1,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(&[255, 255, 255, 255])),
            );
            let instance_buffer = gl.create_buffer()?;
            partial.buffers.push(instance_buffer);
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(instance_buffer));
            let globals = gl.create_buffer()?;
            partial.buffers.push(globals);
            gl.bind_buffer_base(glow::UNIFORM_BUFFER, 0, Some(globals));
            gl.buffer_data_u8_slice(
                glow::UNIFORM_BUFFER,
                bytemuck::cast_slice(&[1.0f32, 1.0, 0.0, 0.0]),
                glow::DYNAMIC_DRAW,
            );
            gl.viewport(0, 0, width as i32, height as i32);
            gl.enable(glow::SCISSOR_TEST);
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            gl.disable(glow::DEPTH_TEST);
            gl.disable(glow::STENCIL_TEST);
            gl.disable(glow::CULL_FACE);
            gl.disable(glow::BLEND);
            Ok(Self {
                scene_program,
                present_program,
                scene_sampler,
                present_sampler,
                pictures,
                white,
                instance_buffer,
                globals,
                vertex_arrays: HashMap::new(),
            })
        }
    }
    unsafe fn delete(&mut self, gl: &glow::Context) {
        unsafe {
            gl.delete_program(self.scene_program);
            gl.delete_program(self.present_program);
            gl.delete_sampler(self.scene_sampler);
            gl.delete_sampler(self.present_sampler);
            for picture in &self.pictures {
                gl.delete_framebuffer(picture.framebuffer);
                gl.delete_texture(picture.texture);
            }
            gl.delete_texture(self.white);
            gl.delete_buffer(self.instance_buffer);
            gl.delete_buffer(self.globals);
            for (_, vertex_array) in self.vertex_arrays.drain() {
                gl.delete_vertex_array(vertex_array);
            }
        }
    }
}

/// The state [`Objects::create`] leaves behind.
fn fresh_cache() -> StateCache {
    StateCache {
        framebuffer: Some(None),
        program: None,
        blend_enabled: Some(false),
        active_unit: Some(UPLOAD_UNIT),
        ..StateCache::default()
    }
}

impl GlBackend {
    /// Create `canvas`'s WebGL2 context with `mode`'s attributes and every object a present needs.
    /// `mode` must draw into the canvas: `direct`, `preserved` or `preserved-desync`.
    pub fn new(canvas: web_sys::HtmlCanvasElement, mode: PresentMode) -> Result<Self, String> {
        if mode == PresentMode::Surface {
            return Err(
                "the GL backend draws into the canvas: direct, preserved or preserved-desync"
                    .into(),
            );
        }
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let context = present::canvas::create_context(&canvas, mode.context_attributes())?;
        let gl = glow::Context::from_webgl2_context(context.clone());
        let max_side = unsafe { gl.get_parameter_i32(glow::MAX_TEXTURE_SIZE) } as u32;
        let texture_units = unsafe { gl.get_parameter_i32(glow::MAX_TEXTURE_IMAGE_UNITS) } as u32;
        if texture_units <= PRESENT_UNIT {
            return Err(format!(
                "{} fragment texture units required; context provides {texture_units}",
                PRESENT_UNIT + 1
            ));
        }
        if width.max(height) > max_side {
            return Err(format!(
                "surface {width}x{height} exceeds max texture side {max_side}"
            ));
        }
        // As wgpu-hal's surface configure does: the canvas backing is the configured size.
        canvas.set_width(width);
        canvas.set_height(height);
        let objects = Some(unsafe { Objects::create(&gl, width, height) }?);
        let loss = LossWatch::new(&canvas);
        Ok(Self {
            canvas,
            context,
            gl,
            mode,
            width,
            height,
            max_side,
            texture_units,
            objects,
            cache: fresh_cache(),
            loss,
        })
    }
    /// The objects; they exist whenever the context is ready, which is the only time the renderer
    /// asks for GPU work.
    fn objects(&self) -> &Objects {
        self.objects
            .as_ref()
            .expect("GL objects exist while the context is ready")
    }
    fn objects_mut(&mut self) -> &mut Objects {
        self.objects
            .as_mut()
            .expect("GL objects exist while the context is ready")
    }
    fn bind_framebuffer(&mut self, framebuffer: Option<glow::Framebuffer>) {
        if self.cache.framebuffer != Some(framebuffer) {
            unsafe { self.gl.bind_framebuffer(glow::FRAMEBUFFER, framebuffer) };
            self.cache.framebuffer = Some(framebuffer);
        }
    }
    fn use_program(&mut self, program: glow::Program) {
        if self.cache.program != Some(program) {
            unsafe { self.gl.use_program(Some(program)) };
            self.cache.program = Some(program);
        }
    }
    fn set_blend_enabled(&mut self, enabled: bool) {
        if self.cache.blend_enabled != Some(enabled) {
            unsafe {
                if enabled {
                    self.gl.enable(glow::BLEND);
                } else {
                    self.gl.disable(glow::BLEND);
                }
            }
            self.cache.blend_enabled = Some(enabled);
        }
    }
    fn set_blend(&mut self, blend: Blend) {
        if self.cache.blend != Some(blend) {
            // wgpu's PREMULTIPLIED_ALPHA_BLENDING (one, one-minus-src-alpha for colour and alpha)
            // and the renderer's additive state (one, one).
            let dst = if blend == Blend::Add {
                glow::ONE
            } else {
                glow::ONE_MINUS_SRC_ALPHA
            };
            unsafe { self.gl.blend_func(glow::ONE, dst) };
            self.cache.blend = Some(blend);
        }
    }
    fn set_active_unit(&mut self, unit: u32) {
        if self.cache.active_unit != Some(unit) {
            unsafe { self.gl.active_texture(glow::TEXTURE0 + unit) };
            self.cache.active_unit = Some(unit);
        }
    }
    fn bind_unit(&mut self, unit: u32, texture: glow::Texture) {
        if self.cache.units[unit as usize] != Some(texture) {
            self.set_active_unit(unit);
            unsafe { self.gl.bind_texture(glow::TEXTURE_2D, Some(texture)) };
            self.cache.units[unit as usize] = Some(texture);
        }
    }
    /// Bind `texture` on the upload unit, outside the cached draw units.
    fn bind_upload(&mut self, texture: glow::Texture) {
        self.set_active_unit(UPLOAD_UNIT);
        unsafe { self.gl.bind_texture(glow::TEXTURE_2D, Some(texture)) };
    }
    /// A deleted texture is unbound from every unit it was on.
    fn forget_texture(&mut self, texture: glow::Texture) {
        for unit in self.cache.units.iter_mut() {
            if *unit == Some(texture) {
                *unit = None;
            }
        }
    }
    fn scissor(&mut self, rect: [i32; 4]) {
        if self.cache.scissor != Some(rect) {
            unsafe { self.gl.scissor(rect[0], rect[1], rect[2], rect[3]) };
            self.cache.scissor = Some(rect);
        }
    }
    fn bind_vertex_array(&mut self, start: u32) {
        let vertex_array = match self.objects_mut().vertex_arrays.get(&start) {
            Some(vertex_array) => *vertex_array,
            None => {
                let Ok(vertex_array) = (unsafe { self.gl.create_vertex_array() }) else {
                    // Only a lost context refuses; the draw that follows is a no-op there too.
                    self.loss.mark_lost();
                    return;
                };
                unsafe {
                    self.gl.bind_vertex_array(Some(vertex_array));
                    for (location, components, offset) in INSTANCE_ATTRIBUTES {
                        self.gl.enable_vertex_attrib_array(location);
                        self.gl.vertex_attrib_pointer_f32(
                            location,
                            components,
                            glow::FLOAT,
                            false,
                            STRIDE,
                            offset + start as i32 * STRIDE,
                        );
                        self.gl.vertex_attrib_divisor(location, 1);
                    }
                }
                self.cache.vertex_array = Some(vertex_array);
                self.objects_mut().vertex_arrays.insert(start, vertex_array);
                vertex_array
            }
        };
        if self.cache.vertex_array != Some(vertex_array) {
            unsafe { self.gl.bind_vertex_array(Some(vertex_array)) };
            self.cache.vertex_array = Some(vertex_array);
        }
    }
    /// Keep the vertex-array cache to the starts a draw table uses: after a rebuild moved them,
    /// delete the arrays no draw names (rare: only once the cache outgrows the table).
    fn prune_vertex_arrays(&mut self, draws: &[Draw]) {
        if self.objects_mut().vertex_arrays.len() <= 2 * draws.len() + 32 {
            return;
        }
        let live: HashSet<u32> = draws.iter().map(|draw| draw.start).collect();
        let gl = &self.gl;
        let bound = &mut self.cache.vertex_array;
        let Some(objects) = self.objects.as_mut() else {
            return;
        };
        objects.vertex_arrays.retain(|start, vertex_array| {
            let keep = live.contains(start);
            if !keep {
                if *bound == Some(*vertex_array) {
                    *bound = None;
                }
                unsafe { gl.delete_vertex_array(*vertex_array) };
            }
            keep
        });
    }
    /// One draw: its eight units (white where a slot is empty), its blend function, its vertex array.
    fn draw(&mut self, draw: &Draw, bind: &[glow::Texture; TEXTURE_SLOTS]) {
        for (unit, texture) in bind.iter().enumerate() {
            self.bind_unit(unit as u32, *texture);
        }
        self.set_blend(draw.blend);
        self.bind_vertex_array(draw.start);
        unsafe {
            self.gl
                .draw_arrays_instanced(glow::TRIANGLES, 0, 6, draw.count as i32)
        };
    }
    /// Scissor to `rect` (device space; the picture is stored Y-flipped like wgpu-hal's, so device
    /// rows are framebuffer rows) and clear it to transparent.
    fn clear_rect(&mut self, rect: &DeviceRect) {
        self.scissor([rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0]);
        unsafe { self.gl.clear(glow::COLOR_BUFFER_BIT) };
    }
}

impl GpuBackend for GlBackend {
    type Texture = glow::Texture;
    type Bind = [glow::Texture; TEXTURE_SLOTS];
    type Frame = std::convert::Infallible;
    type Validation = ();

    fn name(&self) -> &str {
        "webgl2-gl"
    }
    fn present_mode(&self) -> PresentMode {
        self.mode
    }
    fn max_texture_side(&self) -> u32 {
        self.max_side
    }
    fn sampled_texture_slots(&self) -> u32 {
        self.texture_units
    }
    fn timer_capability(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": self.name(),
            "adapterName": null,
            "adapterVendor": null,
            "adapterDevice": null,
            "adapterDriver": null,
            "adapterDriverInfo": null,
            "adapterTimestampQuerySupported": false,
            "wgpuTimestampQuery": false,
            "webgl2TimerExtension": null,
            "webgl2TimerExtensionReason": "not probed by the direct-GL backend",
            "gpuElapsedNs": null,
            "gpuElapsedNsReason": "no validated timer query on the executor context"
        })
    }
    fn creation_baseline(&self) -> Created {
        // Two pictures and white; the instance and globals buffers.
        Created {
            textures: 3,
            buffers: 2,
        }
    }
    fn context_state(&mut self) -> ContextState {
        if !self.loss.lost() {
            return ContextState::Ready;
        }
        if !self.loss.take_restored() {
            return ContextState::Lost;
        }
        // The context object is the same; every GL object of the lost one is gone. Their handles
        // are dropped with the old glow context, never deleted against the new one.
        self.objects = None;
        self.cache = fresh_cache();
        self.gl = glow::Context::from_webgl2_context(self.context.clone());
        match unsafe { Objects::create(&self.gl, self.width, self.height) } {
            Ok(objects) => {
                self.objects = Some(objects);
                ContextState::Restored
            }
            Err(_) => {
                // `create` deleted what it made. Stay lost; the next restore event tries again.
                self.loss.mark_lost();
                ContextState::Lost
            }
        }
    }
    fn resize(&mut self, width: u32, height: u32) -> Result<Created, BackendError> {
        // Both new pictures first: a refusal leaves the size, the canvas, the pictures and the
        // viewport as they were.
        let mut partial = Partial::default();
        let created = unsafe {
            create_picture(&self.gl, width, height, &mut partial)
                .and_then(|a| Ok([a, create_picture(&self.gl, width, height, &mut partial)?]))
        };
        // `create_picture` bound the upload unit and the new framebuffer.
        self.cache.framebuffer = None;
        self.cache.active_unit = Some(UPLOAD_UNIT);
        let pictures = match created {
            Ok(pictures) => pictures,
            Err(error) => {
                unsafe { partial.delete(&self.gl) };
                // A creation the context refuses is a loss only if the context really is lost.
                if self.context.is_context_lost() {
                    self.loss.mark_lost();
                    return Err(BackendError::Lost);
                }
                return Err(BackendError::Failed(format!("resize: {error}")));
            }
        };
        self.width = width;
        self.height = height;
        // Setting either dimension clears the canvas.
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.cache.units[TEXTURE_SLOTS] = None;
        for old in std::mem::replace(&mut self.objects_mut().pictures, pictures) {
            unsafe {
                self.gl.delete_framebuffer(old.framebuffer);
                self.gl.delete_texture(old.texture);
            }
        }
        unsafe { self.gl.viewport(0, 0, width as i32, height as i32) };
        Ok(Created {
            textures: 2,
            buffers: 0,
        })
    }
    fn create_texture(
        &mut self,
        width: u32,
        height: u32,
        format: ResourceFormat,
        pixels: Option<&[u8]>,
    ) -> Result<glow::Texture, BackendError> {
        let texture = unsafe { self.gl.create_texture() }.map_err(|error| {
            self.loss.mark_lost();
            lost(error)
        })?;
        let internal = match format {
            ResourceFormat::Srgb => glow::SRGB8_ALPHA8,
            ResourceFormat::Linear => glow::RGBA8,
        };
        self.bind_upload(texture);
        unsafe {
            self.gl
                .tex_storage_2d(glow::TEXTURE_2D, 1, internal, width as i32, height as i32);
            if let Some(pixels) = pixels {
                self.gl.tex_sub_image_2d(
                    glow::TEXTURE_2D,
                    0,
                    0,
                    0,
                    width as i32,
                    height as i32,
                    glow::RGBA,
                    glow::UNSIGNED_BYTE,
                    glow::PixelUnpackData::Slice(Some(pixels)),
                );
            }
        }
        Ok(texture)
    }
    fn write_texture(
        &mut self,
        texture: &glow::Texture,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) {
        self.bind_upload(*texture);
        unsafe {
            self.gl.tex_sub_image_2d(
                glow::TEXTURE_2D,
                0,
                x as i32,
                y as i32,
                width as i32,
                height as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(pixels)),
            );
        }
    }
    fn release_texture(&mut self, texture: glow::Texture) {
        self.forget_texture(texture);
        unsafe { self.gl.delete_texture(texture) };
    }
    fn create_bind(&self, slots: &[Option<&glow::Texture>; TEXTURE_SLOTS]) -> Self::Bind {
        std::array::from_fn(|slot| slots[slot].copied().unwrap_or(self.objects().white))
    }
    fn ensure_damage_clear(&mut self) -> Created {
        // A scissored `clear` clears exactly the damaged pixels: nothing to create.
        Created::default()
    }
    fn grow_instances(&mut self, capacity: usize) -> Created {
        // The buffer object (and so every vertex array's pointers into it) stays; only its storage
        // grows, so no buffer is created.
        unsafe {
            self.gl.buffer_data_size(
                glow::ARRAY_BUFFER,
                capacity as i32 * STRIDE,
                glow::DYNAMIC_DRAW,
            )
        };
        Created::default()
    }
    fn write_instances(&mut self, first: usize, instances: &[Instance]) {
        unsafe {
            self.gl.buffer_sub_data_u8_slice(
                glow::ARRAY_BUFFER,
                first as i32 * STRIDE,
                bytemuck::cast_slice(instances),
            )
        };
    }
    fn write_design_size(&mut self, width: u32, height: u32) {
        unsafe {
            self.gl.buffer_sub_data_u8_slice(
                glow::UNIFORM_BUFFER,
                0,
                bytemuck::cast_slice(&[width as f32, height as f32, 0.0, 0.0]),
            )
        };
    }
    fn acquire_frame(&mut self) -> Result<Option<Self::Frame>, BackendError> {
        Ok(None)
    }
    fn begin_validation(&mut self) {}
    fn encode(&mut self, work: FrameWork<'_, Self>) -> Option<PartialWork> {
        let picture = work.picture?;
        let framebuffer = self.objects().pictures[picture.target].framebuffer;
        self.bind_framebuffer(Some(framebuffer));
        self.use_program(self.objects().scene_program);
        self.set_blend_enabled(true);
        self.prune_vertex_arrays(picture.draws);
        match picture.region {
            PictureRegion::Full => {
                self.clear_rect(&DeviceRect::full(self.width, self.height));
                for (draw, bind) in picture.draws.iter().zip(picture.binds) {
                    self.draw(draw, bind);
                }
                None
            }
            PictureRegion::Partial { rects, selection } => {
                let mut issued = 0usize;
                let mut pixels = 0u64;
                for rect in rects {
                    self.clear_rect(rect);
                    issued += 1;
                    for ((draw, bind), bounds) in
                        picture.draws.iter().zip(picture.binds).zip(selection)
                    {
                        if bounds.intersects(rect) {
                            self.draw(draw, bind);
                            issued += 1;
                        }
                    }
                    pixels += rect.area();
                }
                Some((issued, pixels))
            }
        }
    }
    fn end_validation(&mut self, _scope: ()) -> Result<(), BackendError> {
        // GL validates nothing ahead of execution; a lost context is the one failure it reports.
        if self.loss.lost() {
            Err(BackendError::Lost)
        } else {
            Ok(())
        }
    }
    fn present_frame(&mut self, frame: Self::Frame) {
        match frame {}
    }
    fn present_picture(
        &mut self,
        picture: usize,
        regions: &[DeviceRect],
        _scissored: bool,
    ) -> Result<(), BackendError> {
        if self.loss.lost() {
            return Err(BackendError::Lost);
        }
        let texture = self.objects().pictures[picture].texture;
        self.bind_framebuffer(None);
        self.use_program(self.objects().present_program);
        self.set_blend_enabled(false);
        self.bind_unit(PRESENT_UNIT, texture);
        // Every fragment of the present triangle samples only its own texel, so a scissor box per
        // region (the whole canvas when unscissored) writes exactly those regions.
        for rect in regions {
            self.scissor(present::gl_scissor_box(rect, self.height));
            unsafe { self.gl.draw_arrays(glow::TRIANGLES, 0, 3) };
        }
        Ok(())
    }
}

impl Drop for GlBackend {
    /// The renderer released its resource textures first; this deletes the rest. On a lost context
    /// the deletes are no-ops.
    fn drop(&mut self) {
        if let Some(mut objects) = self.objects.take() {
            unsafe { objects.delete(&self.gl) };
        }
        // Leave the canvas's context as WebGL defaults it for what this backend set, so a later
        // renderer on the same canvas (a wgpu fallback) starts clean.
        unsafe { reset_gl_state(&self.gl) };
    }
}
