//! `gsw-canvas-draw-list`: a packed, generic Godot `CanvasItem` draw list.
//!
//! A producer owns one [`DrawList`] and refills it frame to frame; an executor borrows it for one
//! `execute` call and uploads only what the dirty ranges name. Everything is little-endian POD in
//! struct-of-arrays form, so a wasm executor hands each array to WebGL as one typed-array view of
//! linear memory with no copy, and a native consumer (a test, the `PDL1` dump) reads the same bytes.
//!
//! The model is Godot's 2D renderer after culling (gate7-design.md Q14b, D7):
//! - [`Item`]: the final transform (canvas × item, 2×3) and the composed straight modulate of one
//!   canvas item. An executor keeps items in a float data texture and the vertex shader fetches its
//!   item's row, so a transform-only change moves one 48-byte row and no vertex.
//! - [`Vertex`]: an item-local position, a normalized uv, a STRAIGHT colour and the item index.
//! - indices: `u32`, in final paint order.
//! - [`Draw`]: an index range plus the state it needs (texture, sampler, blend, program, scissor,
//!   and a multi-channel signed distance field's parameters). Draws are in final paint order. An
//!   executor may merge ADJACENT draws whose state is equal and whose index ranges touch, never
//!   reorder them; an untextured draw's texture and sampler count as equal to anything
//!   ([`DRAW_UNTEXTURED`], G7o4).
//! - [`TextureOp`]s beside the list: uploads of straight RGBA8 pixels and frees.
//! - [`Binding`]s: item-space programs (Godot's custom `canvas_item` shaders, registered with the
//!   executor beside the list) with their uniform values, named by a draw's `program`.
//!
//! The colour contract (G7c's TypeScript executor, `packages/canvas/src/executor-webgl.ts`, is the
//! specification of record): textures are stored straight and premultiplied after filtering;
//! vertex colours are interpolated straight and premultiplied per fragment; the item modulate is
//! premultiplied and multiplied last (`texel * colour * modulate`), and every blend but
//! [`Blend::PremulAlpha`] composites premultiplied colour. A `PremulAlpha` draw uses the texel and
//! the vertex colour as given and the modulate straight (Godot's `BLEND_MODE_PREMULT_ALPHA`).
//!
//! No render-stream concept (wire ids, sessions, records) belongs here (D6, D30).

use bytemuck::{Pod, Zeroable};

/// One canvas item's per-frame state: 48 bytes, three RGBA32F texels in an executor's data
/// texture (`xform[0..4]`, `xform[4..6] ++ modulate[0..2]`, `modulate[2..4] ++ flags ++ reserved`).
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Debug, Default, Pod, Zeroable)]
pub struct Item {
    /// Godot `Transform2D` columns: `x.x, x.y, y.x, y.y, origin.x, origin.y`.
    pub xform: [f32; 6],
    /// Straight RGBA: the modulate composed down the tree, `self_modulate` last, times the canvas
    /// modulate.
    pub modulate: [f32; 4],
    /// Executor-visible item flags ([`ITEM_UNTEXTURED`]); an executor reads the word through its
    /// float texel's bits, so every defined flag keeps the word a normal (never denormal) float.
    pub flags: u32,
    pub reserved: u32,
}

/// One vertex: 36 bytes.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Debug, Default, Pod, Zeroable)]
pub struct Vertex {
    /// Item-local position (the item's draw transform applied, its item transform not).
    pub pos: [f32; 2],
    /// Normalized texture coordinate.
    pub uv: [f32; 2],
    /// Straight RGBA.
    pub color: [f32; 4],
    /// Index into [`DrawList::items`].
    pub item: u32,
}

/// One draw: an index range in paint order and its state. 52 bytes.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Debug, Default, Pod, Zeroable)]
pub struct Draw {
    pub first_index: u32,
    pub index_count: u32,
    /// Texture id; [`WHITE_TEXTURE`] is the 1×1 white texel every executor provides.
    pub texture: u32,
    /// [`Sampler`] bits.
    pub sampler: u32,
    /// [`Blend`] as u32.
    pub blend: u32,
    /// [`BUILTIN_PROGRAM`], or a 1-based index into [`DrawList::bindings`]: an item-space program
    /// with its uniform values (Godot's `ShaderMaterial`).
    pub program: u32,
    /// Integer scissor `[x, y, w, h]` in target pixels, top-left origin; meaningful only when
    /// `flags & DRAW_SCISSOR`.
    pub scissor: [i32; 4],
    pub flags: u32,
    /// `[px_range, outline]` of a [`DRAW_MSDF`] draw, as Godot's GLES3 renderer stores them per
    /// instance (rasterizer_canvas_gles3.cpp:999-1004): the field's distance range in texels and
    /// the outline thickness in texels (`outline_size / scale / 4`, renderer_canvas_cull.cpp:1574).
    /// Zero, and ignored, without the flag.
    pub msdf: [f32; 2],
}

pub const WHITE_TEXTURE: u32 = 0;
pub const BUILTIN_PROGRAM: u32 = 0;
/// [`Draw::flags`]: the draw is scissored.
pub const DRAW_SCISSOR: u32 = 1;
/// [`Draw::flags`]: the texture is a multi-channel signed distance field and the draw computes
/// its coverage the way Godot 4.5.1's `canvas.glsl` does for `INSTANCE_FLAGS_USE_MSDF`
/// (drivers/gles3/shaders/canvas.glsl:562-618): the median of the RGB distances (the alpha
/// channel's true distance bounds an outline), scaled to screen pixels by `px_range` over the
/// texture size times `1 / fwidth(uv)`. The texel is not multiplied in: the colour is the vertex
/// colour and the modulate, with the coverage multiplied into alpha. [`Draw::msdf`] holds the
/// parameters.
pub const DRAW_MSDF: u32 = 2;
/// [`Draw::flags`] (G7o4): an untextured draw. Its `texture` is [`WHITE_TEXTURE`], its `program`
/// [`BUILTIN_PROGRAM`], it is not [`DRAW_MSDF`], and its item's row carries [`ITEM_UNTEXTURED`],
/// so the builtin program colours its fragments as the white texel would (`texel = 1`) whatever
/// texture is bound. Its texture and sampler therefore never end a run: it merges with a textured
/// neighbour of otherwise equal state ([`mergeable`], [`merged`]).
pub const DRAW_UNTEXTURED: u32 = 4;

/// [`Item::flags`] (G7o4): every fragment the builtin program draws for this item takes the white
/// texel's value (`texel = 1`) instead of sampling the bound texture. Bit 30: the flags word reads
/// as the normal float 2.0 through a float texel. A producer sets it only on items whose every draw
/// is white, and marks those draws [`DRAW_UNTEXTURED`].
pub const ITEM_UNTEXTURED: u32 = 1 << 30;

/// Sampler bits.
pub struct Sampler;
impl Sampler {
    /// Linear filtering (else nearest).
    pub const LINEAR: u32 = 1;
    /// Wrap mode in bits 1..3: 0 clamp, 1 repeat, 2 mirror.
    pub const WRAP_SHIFT: u32 = 1;
    pub const WRAP_MASK: u32 = 3 << 1;
    pub const CLAMP: u32 = 0;
    pub const REPEAT: u32 = 1 << 1;
    pub const MIRROR: u32 = 2 << 1;
}

/// Godot `CanvasItemMaterial.BlendMode` (gate5_5-design.md D7).
#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Blend {
    Mix = 0,
    Add = 1,
    Sub = 2,
    Mul = 3,
    PremulAlpha = 4,
    Disabled = 5,
}

impl Blend {
    pub fn from_u32(v: u32) -> Option<Blend> {
        Some(match v {
            0 => Blend::Mix,
            1 => Blend::Add,
            2 => Blend::Sub,
            3 => Blend::Mul,
            4 => Blend::PremulAlpha,
            5 => Blend::Disabled,
            _ => return None,
        })
    }
}

/// The offscreen target an executor draws into before it blits to the canvas.
#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    /// Godot's non-transparent 2D render target (`GL_RGB10_A2`; D7). Shots read it back as
    /// RGBA/UNSIGNED_BYTE, `round(v·255/1023)` (G7c).
    Rgb10A2 = 0,
    Rgba8 = 1,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Target {
    pub width: u32,
    pub height: u32,
    pub format: Format,
    /// Straight RGBA clear colour.
    pub clear: [f32; 4],
    /// Draw as Godot's GLES3 canvas renderer draws into a NON-transparent render target (the root
    /// viewport, `transparent_render_target == false`; rasterizer_canvas_gles3.cpp:742-798):
    /// every blend keeps the destination's alpha (`GL_ZERO, GL_ONE`), [`Blend::Mul`] multiplies
    /// the destination by the STRAIGHT source colour, and [`Blend::Disabled`] writes the straight
    /// source. `false` (the default) is the premultiplied transparent-canvas contract of
    /// `executor-webgl.ts`.
    pub opaque: bool,
}

impl Default for Target {
    fn default() -> Self {
        Target {
            width: 1,
            height: 1,
            format: Format::Rgb10A2,
            clear: [0.0, 0.0, 0.0, 1.0],
            opaque: false,
        }
    }
}

/// Whether a draw with `blend` into a target premultiplies its colour in the shader (the blend
/// unit then takes it with `GL_ONE`). Godot's arithmetic is straight colour with `GL_SRC_ALPHA`
/// for mix/add/sub, which is equal; `premul_alpha` is premultiplied by the content itself; on an
/// [`Target::opaque`] target `mul` and `disabled` take the straight colour as Godot does.
pub fn premultiplies(blend: Blend, opaque: bool) -> bool {
    match blend {
        Blend::PremulAlpha => false,
        Blend::Mul | Blend::Disabled => !opaque,
        Blend::Mix | Blend::Add | Blend::Sub => true,
    }
}

/// One uniform's value for an item-space program: `components × count` numbers, flattened
/// (matrices column-major). Booleans are `Int` 0/1.
#[derive(Clone, PartialEq, Debug)]
pub enum UniformValue {
    Float(Vec<f32>),
    Int(Vec<i32>),
}

#[derive(Clone, PartialEq, Debug)]
pub struct Uniform {
    pub name: Box<str>,
    pub value: UniformValue,
}

/// A `sampler2D` uniform of an item-space program: which list texture it samples, how.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SamplerUniform {
    pub name: Box<str>,
    /// Texture id ([`WHITE_TEXTURE`] for the white texel).
    pub texture: u32,
    /// [`Sampler`] bits.
    pub sampler: u32,
}

/// What a draw with `program != BUILTIN_PROGRAM` draws with: an item-space program (Godot's
/// custom `canvas_item` shader) and its values (Godot's `ShaderMaterial` parameters and instance
/// parameters). The executor's fragment stage computes Godot's `canvas.glsl` order around the
/// program's function:
///
/// ```text
/// COLOR = vertex colour × item modulate × texel   (all straight)
/// program(COLOR, UV)                              (the program may overwrite COLOR)
/// COLOR *= post_modulate                          (Godot's canvas modulate; white when unshaded)
/// ```
///
/// then premultiplies for every blend but [`Blend::PremulAlpha`], as the builtin program does. An
/// item drawn with a binding therefore carries the modulate WITHOUT the canvas modulate in its
/// [`Item`] row.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Binding {
    /// The executor's program id (registered with the executor beside the list, like a texture);
    /// 0 marks an unused slot.
    pub program: u32,
    /// Straight RGBA multiplied in after the program.
    pub post_modulate: [f32; 4],
    /// Every uniform the program declares (an executor leaves an omitted one as GL last had it).
    pub uniforms: Vec<Uniform>,
    pub samplers: Vec<SamplerUniform>,
}

/// A texture operation to run before the frame's draws, in order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TextureOp {
    /// (Re)define texture `id` as `width × height` straight RGBA8, from
    /// `DrawList::texture_bytes[offset..offset + 4·width·height]`.
    Upload {
        id: u32,
        width: u32,
        height: u32,
        offset: u32,
    },
    Free {
        id: u32,
    },
}

/// Half-open ranges of changed elements, coalesced on insert.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Ranges(Vec<(u32, u32)>);

impl Ranges {
    pub fn as_slice(&self) -> &[(u32, u32)] {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
    /// Adds `[start, end)`, merging with the last range when they touch or overlap. Callers that
    /// add out of order still get correct (if less coalesced) ranges.
    pub fn add(&mut self, start: u32, end: u32) {
        if start >= end {
            return;
        }
        if let Some(last) = self.0.last_mut() {
            if start <= last.1 && end >= last.0 {
                last.0 = last.0.min(start);
                last.1 = last.1.max(end);
                return;
            }
        }
        self.0.push((start, end));
    }
    /// Total elements covered (ranges may overlap when added out of order).
    pub fn total(&self) -> u64 {
        self.0.iter().map(|(a, b)| u64::from(b - a)).sum()
    }
}

/// What changed since the executor last consumed the list.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Dirty {
    /// Everything: the executor re-uploads every array (first frame, a re-layout, a restored
    /// context).
    pub all: bool,
    pub items: Ranges,
    pub vertices: Ranges,
    pub indices: Ranges,
    /// The draw table changed (order, ranges or state).
    pub draws: bool,
    /// Changed [`DrawList::bindings`] slots (0-based slot indices).
    pub bindings: Ranges,
}

impl Dirty {
    pub fn clear(&mut self) {
        self.all = false;
        self.items.clear();
        self.vertices.clear();
        self.indices.clear();
        self.draws = false;
        self.bindings.clear();
    }
    pub fn is_clean(&self) -> bool {
        !self.all
            && self.items.is_empty()
            && self.vertices.is_empty()
            && self.indices.is_empty()
            && !self.draws
            && self.bindings.is_empty()
    }
}

/// One frame's packed list. The producer owns it; an executor borrows it.
#[derive(Clone, Debug, Default)]
pub struct DrawList {
    pub target: Target,
    pub items: Vec<Item>,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub draws: Vec<Draw>,
    /// Item-space program bindings; [`Draw::program`] `n > 0` is slot `n - 1`.
    pub bindings: Vec<Binding>,
    pub dirty: Dirty,
    pub texture_ops: Vec<TextureOp>,
    pub texture_bytes: Vec<u8>,
}

impl DrawList {
    pub fn new(target: Target) -> Self {
        DrawList {
            target,
            dirty: Dirty {
                all: true,
                ..Dirty::default()
            },
            ..DrawList::default()
        }
    }

    /// Queue an upload of straight RGBA8 pixels (copied once into the list's byte arena).
    pub fn upload_texture(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) {
        debug_assert_eq!(rgba.len(), 4 * width as usize * height as usize);
        let offset = self.texture_bytes.len() as u32;
        self.texture_bytes.extend_from_slice(rgba);
        self.texture_ops.push(TextureOp::Upload {
            id,
            width,
            height,
            offset,
        });
    }

    /// Reserve room for an upload and return the bytes to fill (no intermediate copy).
    pub fn upload_texture_in_place(&mut self, id: u32, width: u32, height: u32) -> &mut [u8] {
        let offset = self.texture_bytes.len();
        let len = 4 * width as usize * height as usize;
        self.texture_bytes.resize(offset + len, 0);
        self.texture_ops.push(TextureOp::Upload {
            id,
            width,
            height,
            offset: offset as u32,
        });
        &mut self.texture_bytes[offset..offset + len]
    }

    pub fn free_texture(&mut self, id: u32) {
        self.texture_ops.push(TextureOp::Free { id });
    }

    /// Set binding slot `slot` (0-based; draws name it as `slot + 1`), growing the table, and mark
    /// it dirty only when it changed. Returns whether it changed.
    pub fn set_binding(&mut self, slot: u32, binding: Binding) -> bool {
        let i = slot as usize;
        if self.bindings.len() <= i {
            self.bindings.resize_with(i + 1, Binding::default);
        }
        if self.bindings[i] == binding {
            return false;
        }
        self.bindings[i] = binding;
        self.dirty.bindings.add(slot, slot + 1);
        true
    }

    /// After an executor consumed the list: forget the dirty ranges and the texture operations.
    pub fn consumed(&mut self) {
        self.dirty.clear();
        self.texture_ops.clear();
        self.texture_bytes.clear();
    }

    /// Draw calls an executor issues for this list once it merges runs of adjacent draws
    /// ([`mergeable`] against the run's state, [`merged`]).
    pub fn merged_draw_count(&self) -> usize {
        let mut count = 0;
        let mut run: Option<Draw> = None;
        for d in &self.draws {
            if d.index_count == 0 {
                continue;
            }
            run = Some(match run {
                Some(r) if mergeable(&r, d) => merged(&r, d),
                _ => {
                    count += 1;
                    *d
                }
            });
        }
        count
    }
}

/// Whether `next` can extend the run `prev` (one draw, or a run's state from [`merged`]) into one
/// draw call: touching index ranges and equal state, where a [`DRAW_UNTEXTURED`] side's texture and
/// sampler match anything. Without untextured draws this is plain equality of adjacent draws.
pub fn mergeable(prev: &Draw, next: &Draw) -> bool {
    let untextured = (prev.flags | next.flags) & DRAW_UNTEXTURED != 0;
    prev.first_index + prev.index_count == next.first_index
        && (untextured || (prev.texture == next.texture && prev.sampler == next.sampler))
        && prev.blend == next.blend
        && prev.program == next.program
        && (prev.flags & !DRAW_UNTEXTURED) == (next.flags & !DRAW_UNTEXTURED)
        && (prev.flags & DRAW_SCISSOR == 0 || prev.scissor == next.scissor)
        && (prev.flags & DRAW_MSDF == 0 || prev.msdf == next.msdf)
}

/// The state of run `run` extended by `next` (which [`mergeable`] admitted): the index range
/// grows, and a run that was untextured so far takes a textured `next`'s texture and sampler (and
/// stops being untextured), which is what the merged call binds.
pub fn merged(run: &Draw, next: &Draw) -> Draw {
    let mut out = *run;
    out.index_count += next.index_count;
    if run.flags & DRAW_UNTEXTURED != 0 && next.flags & DRAW_UNTEXTURED == 0 {
        out.texture = next.texture;
        out.sampler = next.sampler;
        out.flags &= !DRAW_UNTEXTURED;
    }
    out
}

/// `PDL1`: a byte dump of one frame's list for tests and evidence. Never on the frame path. It
/// holds the POD arrays only: [`DrawList::bindings`] (G7s) are not in it.
///
/// ```text
/// "PDL1" u32 version u32 width u32 height u32 format f32×4 clear
/// u32 items u32 vertices u32 indices u32 draws
/// Item×items Vertex×vertices u32×indices Draw×draws      (all little-endian, packed)
/// ```
///
/// Version 1 draws are 44 bytes ([`Draw`] without [`Draw::msdf`]); version 2 draws are the whole
/// 52-byte [`Draw`]. [`encode`] writes version 1 unless a draw has [`DRAW_MSDF`], so a list with no
/// MSDF draw dumps exactly as before; [`decode`] reads both.
pub mod pdl1 {
    use super::*;

    pub const MAGIC: &[u8; 4] = b"PDL1";
    /// The header's format word carries [`Target::opaque`] in this bit.
    pub const OPAQUE_BIT: u32 = 1 << 8;

    /// Bytes of one version-1 draw: [`Draw`] up to [`Draw::msdf`].
    pub const DRAW_V1_BYTES: usize = 44;
    pub const DRAW_V2_BYTES: usize = std::mem::size_of::<Draw>();

    pub fn encode(list: &DrawList) -> Vec<u8> {
        let version = if list.draws.iter().any(|d| d.flags & DRAW_MSDF != 0) {
            2u32
        } else {
            1
        };
        let draw_bytes = if version == 1 {
            DRAW_V1_BYTES
        } else {
            DRAW_V2_BYTES
        };
        let mut out = Vec::with_capacity(
            48 + list.items.len() * 48
                + list.vertices.len() * 36
                + list.indices.len() * 4
                + list.draws.len() * draw_bytes,
        );
        out.extend_from_slice(MAGIC);
        // The format word's bit 8 is `Target::opaque` (the earliest dumps never set it).
        for v in [
            version,
            list.target.width,
            list.target.height,
            list.target.format as u32 | if list.target.opaque { OPAQUE_BIT } else { 0 },
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for c in list.target.clear {
            out.extend_from_slice(&c.to_le_bytes());
        }
        for n in [
            list.items.len(),
            list.vertices.len(),
            list.indices.len(),
            list.draws.len(),
        ] {
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        out.extend_from_slice(bytemuck::cast_slice(&list.items));
        out.extend_from_slice(bytemuck::cast_slice(&list.vertices));
        out.extend_from_slice(bytemuck::cast_slice(&list.indices));
        for d in &list.draws {
            out.extend_from_slice(&bytemuck::bytes_of(d)[..draw_bytes]);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<DrawList, String> {
        let u32_at = |o: usize| -> Result<u32, String> {
            bytes
                .get(o..o + 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .ok_or_else(|| "PDL1: truncated header".to_string())
        };
        if bytes.get(0..4) != Some(MAGIC.as_slice()) {
            return Err("PDL1: bad magic".into());
        }
        let draw_bytes = match u32_at(4)? {
            1 => DRAW_V1_BYTES,
            2 => DRAW_V2_BYTES,
            _ => return Err("PDL1: unknown version".into()),
        };
        let word = u32_at(16)?;
        let format = match word & !OPAQUE_BIT {
            0 => Format::Rgb10A2,
            1 => Format::Rgba8,
            f => return Err(format!("PDL1: unknown format {f}")),
        };
        let mut clear = [0f32; 4];
        for (i, c) in clear.iter_mut().enumerate() {
            *c = f32::from_bits(u32_at(20 + 4 * i)?);
        }
        let counts = [
            u32_at(36)? as usize,
            u32_at(40)? as usize,
            u32_at(44)? as usize,
            u32_at(48)? as usize,
        ];
        let mut o = 52;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = bytes
                .get(o..o + n)
                .ok_or_else(|| "PDL1: truncated arrays".to_string())?;
            o += n;
            Ok(s)
        };
        let items: Vec<Item> = bytemuck::pod_collect_to_vec(take(counts[0] * 48)?);
        let vertices: Vec<Vertex> = bytemuck::pod_collect_to_vec(take(counts[1] * 36)?);
        let indices: Vec<u32> = bytemuck::pod_collect_to_vec(take(counts[2] * 4)?);
        let draws: Vec<Draw> = take(counts[3] * draw_bytes)?
            .chunks_exact(draw_bytes)
            .map(|b| {
                let mut d = Draw::default();
                bytemuck::bytes_of_mut(&mut d)[..draw_bytes].copy_from_slice(b);
                d
            })
            .collect();
        if o != bytes.len() {
            return Err("PDL1: trailing bytes".into());
        }
        Ok(DrawList {
            target: Target {
                width: u32_at(8)?,
                height: u32_at(12)?,
                format,
                clear,
                opaque: word & OPAQUE_BIT != 0,
            },
            items,
            vertices,
            indices,
            draws,
            bindings: Vec::new(),
            dirty: Dirty {
                all: true,
                ..Dirty::default()
            },
            texture_ops: Vec::new(),
            texture_bytes: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_the_contract() {
        assert_eq!(std::mem::size_of::<Item>(), 48);
        assert_eq!(std::mem::size_of::<Vertex>(), 36);
        assert_eq!(std::mem::size_of::<Draw>(), 52);
        assert_eq!(std::mem::offset_of!(Draw, msdf), pdl1::DRAW_V1_BYTES);
    }

    #[test]
    fn ranges_coalesce_touching_and_overlapping() {
        let mut r = Ranges::default();
        r.add(0, 3);
        r.add(3, 5);
        r.add(4, 9);
        r.add(12, 13);
        r.add(5, 5);
        assert_eq!(r.as_slice(), &[(0, 9), (12, 13)]);
        assert_eq!(r.total(), 10);
    }

    #[test]
    fn merge_only_adjacent_equal_state() {
        let a = Draw {
            first_index: 0,
            index_count: 6,
            ..Draw::default()
        };
        let b = Draw {
            first_index: 6,
            index_count: 6,
            ..Draw::default()
        };
        let c = Draw {
            first_index: 12,
            index_count: 3,
            texture: 2,
            ..Draw::default()
        };
        let d = Draw {
            first_index: 15,
            index_count: 3,
            texture: 2,
            ..Draw::default()
        };
        let list = DrawList {
            draws: vec![a, b, c, d],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 2);
        let scissored = Draw {
            flags: DRAW_SCISSOR,
            scissor: [0, 0, 4, 4],
            ..b
        };
        let list = DrawList {
            draws: vec![a, scissored],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 2);
    }

    #[test]
    fn pdl1_round_trips() {
        let mut list = DrawList::new(Target {
            width: 64,
            height: 32,
            format: Format::Rgb10A2,
            clear: [0.2, 0.2, 0.4, 1.0],
            opaque: true,
        });
        list.items.push(Item {
            xform: [1.0, 0.0, 0.0, 1.0, 3.0, 4.0],
            modulate: [1.0; 4],
            ..Item::default()
        });
        list.vertices.push(Vertex {
            pos: [1.0, 2.0],
            uv: [0.5, 0.5],
            color: [1.0; 4],
            item: 0,
        });
        list.indices.extend_from_slice(&[0, 0, 0]);
        list.draws.push(Draw {
            index_count: 3,
            ..Draw::default()
        });
        let bytes = pdl1::encode(&list);
        // No MSDF draw: version 1, 44-byte draws.
        assert_eq!(&bytes[4..8], &1u32.to_le_bytes());
        assert_eq!(bytes.len(), 52 + 48 + 36 + 12 + 44);
        let back = pdl1::decode(&bytes).unwrap();
        assert_eq!(back.target, list.target);
        assert_eq!(back.items, list.items);
        assert_eq!(back.vertices, list.vertices);
        assert_eq!(back.indices, list.indices);
        assert_eq!(back.draws, list.draws);

        list.draws.push(Draw {
            first_index: 0,
            index_count: 3,
            texture: 7,
            flags: DRAW_MSDF,
            msdf: [24.0, 0.375],
            ..Draw::default()
        });
        let bytes = pdl1::encode(&list);
        assert_eq!(&bytes[4..8], &2u32.to_le_bytes());
        assert_eq!(bytes.len(), 52 + 48 + 36 + 12 + 2 * 52);
        let back = pdl1::decode(&bytes).unwrap();
        assert_eq!(back.draws, list.draws);
    }

    #[test]
    fn msdf_draws_merge_only_with_equal_parameters() {
        let a = Draw {
            first_index: 0,
            index_count: 6,
            texture: 3,
            flags: DRAW_MSDF,
            msdf: [24.0, 0.0],
            ..Draw::default()
        };
        let same = Draw {
            first_index: 6,
            ..a
        };
        let outline = Draw {
            first_index: 12,
            msdf: [24.0, 1.0],
            ..a
        };
        let plain = Draw {
            first_index: 18,
            flags: 0,
            msdf: [0.0; 2],
            ..a
        };
        assert!(mergeable(&a, &same));
        assert!(!mergeable(&same, &outline));
        assert!(!mergeable(&outline, &plain));
        // Without the flag the parameters are ignored.
        let plain2 = Draw {
            first_index: 24,
            msdf: [9.0, 9.0],
            ..plain
        };
        assert!(mergeable(&plain, &plain2));
    }

    #[test]
    fn untextured_draws_join_a_textured_run_without_bridging_two_textures() {
        let at = |first: u32, texture: u32, sampler: u32, flags: u32| Draw {
            first_index: first,
            index_count: 6,
            texture,
            sampler,
            flags,
            ..Draw::default()
        };
        let w = |first| at(first, WHITE_TEXTURE, 0, DRAW_UNTEXTURED);
        // W A W A W: one call bound to texture 3 (sampler 1).
        let list = DrawList {
            draws: vec![w(0), at(6, 3, 1, 0), w(12), at(18, 3, 1, 0), w(24)],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 1);
        let run = merged(&merged(&w(0), &at(6, 3, 1, 0)), &w(12));
        assert_eq!((run.texture, run.sampler, run.flags), (3, 1, 0));
        assert_eq!(run.index_count, 18);
        // W A W B: the untextured draw between two textures does not bridge them.
        let list = DrawList {
            draws: vec![w(0), at(6, 3, 1, 0), w(12), at(18, 4, 1, 0)],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 2);
        // A sampler change of the same texture ends the run too.
        let list = DrawList {
            draws: vec![at(0, 3, 1, 0), w(6), at(12, 3, 0, 0)],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 2);
        // A white draw WITHOUT the flag still ends a textured run (the pre-G7o4 rule).
        let list = DrawList {
            draws: vec![at(0, 3, 1, 0), at(6, WHITE_TEXTURE, 0, 0), at(12, 3, 1, 0)],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 3);
        // Other state still decides: a scissored untextured draw does not join an unscissored run.
        let scissored = Draw {
            flags: DRAW_UNTEXTURED | DRAW_SCISSOR,
            scissor: [0, 0, 4, 4],
            ..w(6)
        };
        let list = DrawList {
            draws: vec![at(0, 3, 1, 0), scissored],
            ..DrawList::default()
        };
        assert_eq!(list.merged_draw_count(), 2);
        // ITEM_UNTEXTURED reads as a normal float through a float texel.
        assert!(f32::from_bits(ITEM_UNTEXTURED).is_normal());
    }
}
