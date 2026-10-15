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
//! - [`Draw`]: an index range plus the state it needs (texture, sampler, blend, program, scissor).
//!   Draws are in final paint order. An executor may merge ADJACENT draws whose state is equal and
//!   whose index ranges touch, never reorder them.
//! - [`TextureOp`]s beside the list: uploads of straight RGBA8 pixels and frees.
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
    /// Reserved for executor-visible item flags; 0 today.
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

/// One draw: an index range in paint order and its state. 44 bytes.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Pod, Zeroable)]
pub struct Draw {
    pub first_index: u32,
    pub index_count: u32,
    /// Texture id; [`WHITE_TEXTURE`] is the 1×1 white texel every executor provides.
    pub texture: u32,
    /// [`Sampler`] bits.
    pub sampler: u32,
    /// [`Blend`] as u32.
    pub blend: u32,
    /// Program id; [`BUILTIN_PROGRAM`] is the only one so far.
    pub program: u32,
    /// Integer scissor `[x, y, w, h]` in target pixels, top-left origin; meaningful only when
    /// `flags & DRAW_SCISSOR`.
    pub scissor: [i32; 4],
    pub flags: u32,
}

pub const WHITE_TEXTURE: u32 = 0;
pub const BUILTIN_PROGRAM: u32 = 0;
/// [`Draw::flags`]: the draw is scissored.
pub const DRAW_SCISSOR: u32 = 1;

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
}

impl Default for Target {
    fn default() -> Self {
        Target {
            width: 1,
            height: 1,
            format: Format::Rgb10A2,
            clear: [0.0, 0.0, 0.0, 1.0],
        }
    }
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
}

impl Dirty {
    pub fn clear(&mut self) {
        self.all = false;
        self.items.clear();
        self.vertices.clear();
        self.indices.clear();
        self.draws = false;
    }
    pub fn is_clean(&self) -> bool {
        !self.all
            && self.items.is_empty()
            && self.vertices.is_empty()
            && self.indices.is_empty()
            && !self.draws
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

    /// After an executor consumed the list: forget the dirty ranges and the texture operations.
    pub fn consumed(&mut self) {
        self.dirty.clear();
        self.texture_ops.clear();
        self.texture_bytes.clear();
    }

    /// Draw calls an executor issues for this list once it merges adjacent equal-state draws.
    pub fn merged_draw_count(&self) -> usize {
        let mut count = 0;
        let mut prev: Option<&Draw> = None;
        for d in &self.draws {
            if d.index_count == 0 {
                continue;
            }
            match prev {
                Some(p) if mergeable(p, d) => {}
                _ => count += 1,
            }
            prev = Some(d);
        }
        count
    }
}

/// Whether `next` can extend `prev` into one draw call: equal state and touching index ranges.
pub fn mergeable(prev: &Draw, next: &Draw) -> bool {
    prev.first_index + prev.index_count == next.first_index
        && prev.texture == next.texture
        && prev.sampler == next.sampler
        && prev.blend == next.blend
        && prev.program == next.program
        && prev.flags == next.flags
        && (prev.flags & DRAW_SCISSOR == 0 || prev.scissor == next.scissor)
}

/// `PDL1`: a byte dump of one frame's list for tests and evidence. Never on the frame path.
///
/// ```text
/// "PDL1" u32 version(1) u32 width u32 height u32 format f32×4 clear
/// u32 items u32 vertices u32 indices u32 draws
/// Item×items Vertex×vertices u32×indices Draw×draws      (all little-endian, packed)
/// ```
pub mod pdl1 {
    use super::*;

    pub const MAGIC: &[u8; 4] = b"PDL1";

    pub fn encode(list: &DrawList) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            48 + list.items.len() * 48
                + list.vertices.len() * 36
                + list.indices.len() * 4
                + list.draws.len() * 44,
        );
        out.extend_from_slice(MAGIC);
        for v in [
            1u32,
            list.target.width,
            list.target.height,
            list.target.format as u32,
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
        out.extend_from_slice(bytemuck::cast_slice(&list.draws));
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
        if u32_at(4)? != 1 {
            return Err("PDL1: unknown version".into());
        }
        let format = match u32_at(16)? {
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
        let draws: Vec<Draw> = bytemuck::pod_collect_to_vec(take(counts[3] * 44)?);
        if o != bytes.len() {
            return Err("PDL1: trailing bytes".into());
        }
        Ok(DrawList {
            target: Target {
                width: u32_at(8)?,
                height: u32_at(12)?,
                format,
                clear,
            },
            items,
            vertices,
            indices,
            draws,
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
        assert_eq!(std::mem::size_of::<Draw>(), 44);
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
        let back = pdl1::decode(&bytes).unwrap();
        assert_eq!(back.target, list.target);
        assert_eq!(back.items, list.items);
        assert_eq!(back.vertices, list.vertices);
        assert_eq!(back.indices, list.indices);
        assert_eq!(back.draws, list.draws);
    }
}
