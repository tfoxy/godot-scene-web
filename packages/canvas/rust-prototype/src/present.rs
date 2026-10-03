//! How a rendered picture reaches the canvas.
//!
//! `surface` (the default) is wgpu's own path. A full-screen copy pass draws the picture into the
//! acquired surface texture, then wgpu-hal's WebGL2 present draws that texture into the canvas's
//! default framebuffer. The surface format wgpu picks there is `Rgba8UnormSrgb` (wgpu-core sorts
//! sRGB formats first), so that present is not its `blitFramebuffer` branch but its sRGB branch:
//! a full-screen triangle through a small re-encoding shader (`SRGB_PRESENT_*` below).
//!
//! The other modes create the canvas's WebGL2 context themselves, build the wgpu adapter on it
//! (`wgpu_hal::gles::Adapter::new_external`) and never create a `wgpu::Surface`. Their present runs
//! that same shader, with the same sampling state, straight from the committed picture: one
//! full-surface pass instead of two, and the same pixels by construction. A raw
//! `blitFramebuffer` cannot be used: reading an sRGB texture through a framebuffer decodes it to
//! linear, and WebGL2 has no way to copy its encoded bytes into the (linear) default framebuffer.
//!
//! `preserved` and `preserved-desync` also ask for `preserveDrawingBuffer` (and `desynchronized`),
//! so after a partial redraw the present runs only inside the damage rectangles (scissored).
//! Every fragment of the triangle samples only its own texel, so scissoring changes no pixel.
//!
//! The decisions here are pure so they test natively; the GL calls live in [`canvas`].
use crate::damage::DeviceRect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentMode {
    Surface,
    Direct,
    Preserved,
    PreservedDesync,
}

impl PresentMode {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "surface" => Ok(Self::Surface),
            "direct" => Ok(Self::Direct),
            "preserved" => Ok(Self::Preserved),
            "preserved-desync" => Ok(Self::PreservedDesync),
            other => Err(format!(
                "unknown present mode {other:?}; expected surface, direct, preserved or preserved-desync"
            )),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Surface => "surface",
            Self::Direct => "direct",
            Self::Preserved => "preserved",
            Self::PreservedDesync => "preserved-desync",
        }
    }
    /// The default framebuffer keeps its pixels between frames, so a partial present is enough.
    pub fn preserves_drawing_buffer(self) -> bool {
        matches!(self, Self::Preserved | Self::PreservedDesync)
    }
    /// WebGL2 context attributes for the modes that create the context. Everything except the two
    /// preserved-mode switches is what wgpu-hal's `create_surface_from_canvas` produces today: it sets
    /// only `antialias: false`, so the rest are the WebGL defaults, spelled out here.
    pub fn context_attributes(self) -> ContextAttributes {
        ContextAttributes {
            alpha: true,
            antialias: false,
            depth: true,
            stencil: false,
            premultiplied_alpha: true,
            preserve_drawing_buffer: self.preserves_drawing_buffer(),
            desynchronized: self == Self::PreservedDesync,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextAttributes {
    pub alpha: bool,
    pub antialias: bool,
    pub depth: bool,
    pub stencil: bool,
    pub premultiplied_alpha: bool,
    pub preserve_drawing_buffer: bool,
    pub desynchronized: bool,
}

/// The regions of the committed picture this present must copy to the canvas, in the renderer's
/// device space (origin top-left, the space of the damage rectangles and the scissor).
///
/// A partial redraw changed only `partial` inside the picture; when the canvas keeps its pixels
/// (`preserved`) and still holds the previous picture (`!force_full`), those rectangles are all it
/// needs. Every other case copies the whole picture.
pub fn blit_regions(
    mode: PresentMode,
    force_full: bool,
    partial: Option<&[DeviceRect]>,
    width: u32,
    height: u32,
) -> Vec<DeviceRect> {
    let full = DeviceRect::full(width, height);
    match partial {
        Some(rects) if mode.preserves_drawing_buffer() && !force_full => rects
            .iter()
            .map(|rect| rect.intersection(&full))
            .filter(|rect| !rect.is_empty())
            .collect(),
        _ => vec![full],
    }
}

pub fn blit_pixels(regions: &[DeviceRect]) -> u64 {
    regions.iter().map(DeviceRect::area).sum()
}

/// A device-space rectangle (origin top-left, as the damage rectangles and wgpu's scissor use)
/// as a `glScissor` box `[x, y, width, height]` on the default framebuffer of a canvas `height`
/// pixels tall, whose rows run bottom-up: device rows `y0..y1` are framebuffer rows
/// `height - y1 .. height - y0`. That matches the present shader, which maps texture row `y` of a
/// wgpu-rendered picture (wgpu-hal renders Y-flipped, so that is device row `y`) to canvas row `y`
/// from the top.
pub fn gl_scissor_box(rect: &DeviceRect, height: u32) -> [i32; 4] {
    [
        rect.x0,
        height as i32 - rect.y1,
        rect.x1 - rect.x0,
        rect.y1 - rect.y0,
    ]
}

/// wgpu-hal 30.0.1 `src/gles/shaders/srgb_present.vert` and `.frag` (MIT OR Apache-2.0), verbatim:
/// the program its WebGL2 surface present runs for an sRGB surface. Reusing the exact source keeps
/// the direct present's output identical to the surface path's.
pub const SRGB_PRESENT_VERT: &str = "#version 300 es
precision mediump float;
// A triangle that fills the whole screen
const vec2[3] TRIANGLE_POS = vec2[](
  vec2( 0.0, -3.0),
  vec2(-3.0,  1.0),
  vec2( 3.0,  1.0)
);
const vec2[3] TRIANGLE_UV = vec2[](
  vec2( 0.5,  1.),
  vec2( -1.0,  -1.0),
  vec2( 2.0,  -1.0)
);
out vec2 uv;
void main() {
  uv = TRIANGLE_UV[gl_VertexID];
  gl_Position = vec4(TRIANGLE_POS[gl_VertexID], 0.0, 1.0);
}";
pub const SRGB_PRESENT_FRAG: &str = "#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D present_texture;
out vec4 frag;
vec4 linear_to_srgb(vec4 linear) {
    vec3 color_linear = linear.rgb;
    vec3 selector = ceil(color_linear - 0.0031308); // 0 if under value, 1 if over
    vec3 under = 12.92 * color_linear;
    vec3 over = 1.055 * pow(color_linear, vec3(0.41666)) - 0.055;
    vec3 result = mix(under, over, selector);
    return vec4(result, linear.a);
}
void main() {
  frag = linear_to_srgb(texture(present_texture, uv));
}";

#[cfg(target_arch = "wasm32")]
pub mod canvas {
    //! The WebGL2 side of the direct present. Thin by design: every decision is above.
    use super::{ContextAttributes, PresentMode};
    use crate::damage::DeviceRect;
    use glow::HasContext;
    use wasm_bindgen::{JsCast, JsValue};

    /// Create the canvas's WebGL2 context with `attributes`. A canvas that already has a context
    /// returns that one (the browser ignores the attributes then), exactly as `getContext` does.
    pub fn create_context(
        canvas: &web_sys::HtmlCanvasElement,
        attributes: ContextAttributes,
    ) -> Result<web_sys::WebGl2RenderingContext, String> {
        let options = js_sys::Object::new();
        let set = |key: &str, value: bool| {
            js_sys::Reflect::set(&options, &key.into(), &JsValue::from_bool(value))
                .map(|_| ())
                .map_err(|e| format!("context options: {e:?}"))
        };
        set("alpha", attributes.alpha)?;
        set("antialias", attributes.antialias)?;
        set("depth", attributes.depth)?;
        set("stencil", attributes.stencil)?;
        set("premultipliedAlpha", attributes.premultiplied_alpha)?;
        set("preserveDrawingBuffer", attributes.preserve_drawing_buffer)?;
        set("desynchronized", attributes.desynchronized)?;
        match canvas.get_context_with_context_options("webgl2", &options) {
            Ok(Some(context)) => context
                .dyn_into::<web_sys::WebGl2RenderingContext>()
                .map_err(|_| "canvas context is not a WebGl2RenderingContext".to_string()),
            Ok(None) => Err(
                "canvas.getContext() returned null; webgl2 not available or canvas already in use"
                    .into(),
            ),
            Err(error) => Err(format!("canvas.getContext() threw exception {error:?}")),
        }
    }

    /// The canvas the direct present writes, plus the present program and its sampler.
    pub struct CanvasPresenter {
        pub canvas: web_sys::HtmlCanvasElement,
        pub mode: PresentMode,
        /// The next present covers the whole canvas: set at creation and on resize (which clears
        /// the canvas), cleared by a present. A lost context is rebuilt by the caller as a new
        /// renderer, so it starts full too.
        pub force_full: bool,
        /// Created once with the device (`init`), so a present never creates GL objects.
        program: Option<glow::Program>,
        sampler: Option<glow::Sampler>,
    }

    impl CanvasPresenter {
        pub fn new(canvas: web_sys::HtmlCanvasElement, mode: PresentMode) -> Self {
            Self {
                canvas,
                mode,
                force_full: true,
                program: None,
                sampler: None,
            }
        }
        /// Compile the present program and create its sampler: nearest filtering, every other
        /// parameter at its default, which is the sampling state of wgpu-hal's swapchain texture
        /// (its present binds no sampler object and sets only the two filters on the texture).
        ///
        /// # Safety
        /// `gl` must be wgpu-hal's glow context for this canvas's WebGL2 context.
        pub unsafe fn init(&mut self, gl: &glow::Context) -> Result<(), String> {
            if self.program.is_none() {
                self.program = Some(unsafe { compile_program(gl) }?);
            }
            if self.sampler.is_none() {
                let sampler = unsafe { gl.create_sampler() }?;
                unsafe {
                    gl.sampler_parameter_i32(
                        sampler,
                        glow::TEXTURE_MIN_FILTER,
                        glow::NEAREST as i32,
                    );
                    gl.sampler_parameter_i32(
                        sampler,
                        glow::TEXTURE_MAG_FILTER,
                        glow::NEAREST as i32,
                    );
                }
                self.sampler = Some(sampler);
            }
            Ok(())
        }
        /// Size the canvas backing as wgpu-hal's `Surface::configure` does. Setting either
        /// dimension clears the drawing buffer, so the next present is full.
        pub fn set_size(&mut self, width: u32, height: u32) {
            self.canvas.set_width(width);
            self.canvas.set_height(height);
            self.force_full = true;
        }
        /// Draw `regions` of the picture (raw GL texture `texture`) into the default framebuffer.
        ///
        /// Runs after `queue.submit`: wgpu-hal's GLES queue issues every recorded command inside
        /// `submit`, so the picture's draws precede this one in the context's command stream.
        /// It sets the state wgpu-hal's own sRGB present sets (viewport, default draw framebuffer,
        /// texture unit 0, program, depth/stencil/scissor/blend/cull off, `BACK` draw buffer),
        /// scissors to each region when `partial`, then leaves the program, texture, sampler,
        /// framebuffer and scissor unbound or off. wgpu-hal's `Queue::reset_state` rebinds or
        /// disables all of that at the start of every command buffer and the command buffers
        /// rebind textures, samplers, viewport and scissor per pass, so it caches none of it
        /// across a submit and nothing it tracks is invalidated.
        ///
        /// # Safety
        /// `gl` must be wgpu-hal's glow context for this canvas's WebGL2 context, `init` must have
        /// succeeded, and `texture` must be a live 2D texture of `width` x `height` on it.
        #[allow(clippy::too_many_arguments)]
        pub unsafe fn present(
            &mut self,
            gl: &glow::Context,
            texture: glow::Texture,
            regions: &[DeviceRect],
            partial: bool,
            width: u32,
            height: u32,
        ) -> Result<(), String> {
            let (Some(program), Some(sampler)) = (self.program, self.sampler) else {
                return Err("present program not created".into());
            };
            unsafe {
                gl.viewport(0, 0, width as i32, height as i32);
                gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None);
                gl.active_texture(glow::TEXTURE0);
                gl.bind_texture(glow::TEXTURE_2D, Some(texture));
                gl.bind_sampler(0, Some(sampler));
                gl.use_program(Some(program));
                gl.disable(glow::DEPTH_TEST);
                gl.disable(glow::STENCIL_TEST);
                gl.disable(glow::BLEND);
                gl.disable(glow::CULL_FACE);
                gl.color_mask(true, true, true, true);
                gl.draw_buffers(&[glow::BACK]);
                if partial {
                    gl.enable(glow::SCISSOR_TEST);
                    for rect in regions {
                        let [x, y, w, h] = super::gl_scissor_box(rect, height);
                        gl.scissor(x, y, w, h);
                        gl.draw_arrays(glow::TRIANGLES, 0, 3);
                    }
                } else {
                    gl.disable(glow::SCISSOR_TEST);
                    gl.draw_arrays(glow::TRIANGLES, 0, 3);
                }
                gl.disable(glow::SCISSOR_TEST);
                gl.use_program(None);
                gl.bind_sampler(0, None);
                gl.bind_texture(glow::TEXTURE_2D, None);
                gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            }
            self.force_full = false;
            Ok(())
        }
        /// Delete the program and sampler (renderer drop).
        ///
        /// # Safety
        /// `gl` must be wgpu-hal's glow context for this canvas's WebGL2 context.
        pub unsafe fn release(&mut self, gl: &glow::Context) {
            if let Some(program) = self.program.take() {
                unsafe { gl.delete_program(program) };
            }
            if let Some(sampler) = self.sampler.take() {
                unsafe { gl.delete_sampler(sampler) };
            }
        }
    }

    unsafe fn compile_program(gl: &glow::Context) -> Result<glow::Program, String> {
        let program = unsafe { gl.create_program() }?;
        let mut shaders = Vec::new();
        for (kind, source) in [
            (glow::VERTEX_SHADER, super::SRGB_PRESENT_VERT),
            (glow::FRAGMENT_SHADER, super::SRGB_PRESENT_FRAG),
        ] {
            let shader = unsafe { gl.create_shader(kind) }?;
            unsafe {
                gl.shader_source(shader, source);
                gl.compile_shader(shader);
                gl.attach_shader(program, shader);
            }
            shaders.push(shader);
        }
        unsafe { gl.link_program(program) };
        let linked = unsafe { gl.get_program_link_status(program) };
        let log = if linked {
            String::new()
        } else {
            unsafe { gl.get_program_info_log(program) }
        };
        for shader in shaders {
            unsafe {
                gl.detach_shader(program, shader);
                gl.delete_shader(shader);
            }
        }
        if !linked {
            unsafe { gl.delete_program(program) };
            return Err(format!("present program link failed: {log}"));
        }
        Ok(program)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: i32, y0: i32, x1: i32, y1: i32) -> DeviceRect {
        DeviceRect { x0, y0, x1, y1 }
    }

    #[test]
    fn modes_parse_round_trip_and_unknown_is_refused() {
        for mode in [
            PresentMode::Surface,
            PresentMode::Direct,
            PresentMode::Preserved,
            PresentMode::PreservedDesync,
        ] {
            assert_eq!(PresentMode::parse(mode.name()), Ok(mode));
        }
        assert!(PresentMode::parse("Direct").is_err());
        assert!(PresentMode::parse("").is_err());
        assert!(PresentMode::parse("preserved-desynchronized").is_err());
    }

    #[test]
    fn only_the_preserved_modes_change_context_attributes() {
        let surface_like = PresentMode::Surface.context_attributes();
        assert_eq!(PresentMode::Direct.context_attributes(), surface_like);
        assert!(!surface_like.antialias && surface_like.alpha && surface_like.premultiplied_alpha);
        assert!(!surface_like.preserve_drawing_buffer && !surface_like.desynchronized);
        let preserved = PresentMode::Preserved.context_attributes();
        assert!(preserved.preserve_drawing_buffer && !preserved.desynchronized);
        let desync = PresentMode::PreservedDesync.context_attributes();
        assert!(desync.preserve_drawing_buffer && desync.desynchronized);
        assert_eq!(
            ContextAttributes {
                preserve_drawing_buffer: false,
                desynchronized: false,
                ..desync
            },
            surface_like
        );
    }

    #[test]
    fn scissor_box_flips_device_rows_into_the_bottom_up_framebuffer() {
        let height = 200;
        assert_eq!(
            gl_scissor_box(&DeviceRect::full(300, height), height),
            [0, 0, 300, 200]
        );
        // Device rows 30..70 from the top are framebuffer rows 130..170 from the bottom.
        assert_eq!(
            gl_scissor_box(&rect(10, 30, 50, 70), height),
            [10, 130, 40, 40]
        );
        // A rectangle touching the top edge of the canvas ends at the framebuffer's last row.
        assert_eq!(gl_scissor_box(&rect(0, 0, 5, 3), height), [0, 197, 5, 3]);
        // The present triangle maps texture row t (device row t) to framebuffer row h - 1 - t: its
        // uv.y runs 1 at the top edge of the clip space to 0 at the bottom, and wgpu-hal stores
        // device row t at texture row t. The scissor box keeps exactly those rows.
        let r = rect(0, 30, 1, 70);
        let [_, y, _, h] = gl_scissor_box(&r, height);
        for row in r.y0..r.y1 {
            let framebuffer_row = height as i32 - 1 - row;
            assert!((y..y + h).contains(&framebuffer_row));
        }
        assert!(!(y..y + h).contains(&(height as i32 - 1 - r.y1)));
        assert!(!(y..y + h).contains(&(height as i32 - r.y0)));
    }

    #[test]
    fn present_shader_is_wgpu_hal_source() {
        assert!(SRGB_PRESENT_VERT.starts_with("#version 300 es\nprecision mediump float;"));
        assert!(SRGB_PRESENT_FRAG.contains("pow(color_linear, vec3(0.41666))"));
        assert!(
            SRGB_PRESENT_FRAG.ends_with("frag = linear_to_srgb(texture(present_texture, uv));\n}")
        );
    }

    #[test]
    fn non_preserved_modes_always_blit_the_whole_picture() {
        let partial = [rect(1, 2, 3, 4)];
        for mode in [PresentMode::Surface, PresentMode::Direct] {
            let regions = blit_regions(mode, false, Some(&partial), 40, 30);
            assert_eq!(regions, vec![DeviceRect::full(40, 30)]);
            assert_eq!(blit_pixels(&regions), 1200);
        }
    }

    #[test]
    fn preserved_partial_blits_only_the_damage_and_counts_its_area() {
        let partial = [rect(0, 0, 10, 5), rect(20, 10, 25, 30)];
        for mode in [PresentMode::Preserved, PresentMode::PreservedDesync] {
            let regions = blit_regions(mode, false, Some(&partial), 40, 30);
            assert_eq!(regions, partial.to_vec());
            assert_eq!(blit_pixels(&regions), 50 + 100);
        }
    }

    #[test]
    fn preserved_full_cases_blit_everything() {
        let partial = [rect(0, 0, 10, 5)];
        // First frame, resize, restore or failure: forced full even for a partial redraw.
        let forced = blit_regions(PresentMode::Preserved, true, Some(&partial), 40, 30);
        assert_eq!(forced, vec![DeviceRect::full(40, 30)]);
        // A full redraw (or the damage present off) has no partial rectangles.
        let full = blit_regions(PresentMode::Preserved, false, None, 40, 30);
        assert_eq!(blit_pixels(&full), 1200);
    }

    #[test]
    fn preserved_partial_regions_are_clamped_to_the_surface() {
        let partial = [
            rect(-5, -5, 5, 5),
            rect(38, 28, 45, 35),
            rect(50, 50, 60, 60),
        ];
        let regions = blit_regions(PresentMode::Preserved, false, Some(&partial), 40, 30);
        assert_eq!(regions, vec![rect(0, 0, 5, 5), rect(38, 28, 40, 30)]);
        assert_eq!(blit_pixels(&regions), 25 + 4);
    }
}
