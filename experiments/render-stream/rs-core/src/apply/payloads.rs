//! Verified payloads in the shapes the applier draws from: textures as straight RGBA8 level-0
//! pixels (Godot's GLES3 swizzles, `texture_storage.cpp` `_get_gl_image_and_format`), mesh surfaces
//! as flat 2D geometry (`rendering_server.cpp` `_surface_set_data` layout: 2D positions, then per
//! vertex `color` RGBA8 unorm and `tex_uv` f32×2 interleaved in the attribute buffer, then 16- or
//! 32-bit indices).
//!
//! The bytes reach this store only after their SHA-256 was checked against the hash the wire
//! names (the adapter's `provide`, or the validator's inline resource records): verification
//! cannot be skipped by drawing from here.

use crate::state::{Hash, Primitive};
use gsw_canvas_draw_list::SharedBytes;
use std::collections::{HashMap, HashSet, VecDeque};

/// A texture's level 0 as straight RGBA8, or (G8kp, a render-stream/9 `block` variant) as the
/// source's own block-compressed level 0 (`compressed`; `rgba` is then empty and `format` names
/// the block format).
#[derive(Clone, Debug)]
pub struct TexturePixels {
    pub width: u32,
    pub height: u32,
    /// GLJ: shared with the draw list's upload of it (no copy), as are `compressed` and `half`.
    pub rgba: SharedBytes,
    /// G8kp: level 0 of a block-format payload, exactly the payload's bytes (no decode here: the
    /// GPU samples it).
    pub compressed: Option<SharedBytes>,
    /// P3-CK: level 0 of a half-float payload (`RH`, `RGH`, `RGBH`, `RGBAH`) as RGBA16F, 8 bytes a
    /// texel (a missing G or B is 0, a missing alpha 1, each half little-endian and bit-exact):
    /// GLES3 samples these images at half precision, which RGBA8 cannot carry (a fine `mod()` over
    /// a half-float distance field reads a different band). `rgba` is then empty.
    pub half: Option<SharedBytes>,
    /// PM6b: level 0 of an f32 payload (`RF`, `RGF`, `RGBF`, `RGBAF`) at most 4 rows high, as
    /// RGBA f32 (a missing G or B is 0, a missing alpha 1): the curve and gradient textures a /12
    /// process material names (render-stream-12.md "Curve textures"). GSW's particle simulation
    /// samples them on the CPU at their stored values (`rgba` clamps them to [0, 1]).
    pub floats: Option<Vec<f32>>,
    /// Which texels of `rgba` are fully opaque, made beside the RGBA8 pixels and built from them
    /// when first asked (None for a block, half-float or empty texture: those never count as
    /// opaque). The applier's cover walk reads it to prove that a draw sampling this texture
    /// overwrites what lies beneath.
    pub opacity: Option<std::sync::Arc<gsw_canvas_draw_list::opacity::Opacity>>,
    /// The payload's own `Image.Format` name, mipmaps flag and `data` length (every level): what
    /// the native receiver's upload accounting reads (the former GDScript applier, `rs_applier.gd`, removed in G7gd; `uploads[].data_bytes`).
    pub format: String,
    pub mipmaps: bool,
    pub data_len: usize,
}

/// One mesh surface's 2D geometry.
#[derive(Clone, Debug)]
pub struct MeshGeometry {
    pub primitive: Primitive,
    pub positions: Vec<[f32; 2]>,
    /// Straight RGBA from the unorm8 attribute (`v / 255`), when the format has `ARRAY_FORMAT_COLOR`.
    pub colors: Option<Vec<[f32; 4]>>,
    /// When the format has `ARRAY_FORMAT_TEX_UV` (uncompressed).
    pub uvs: Option<Vec<[f32; 2]>>,
    /// When the format has `ARRAY_FORMAT_INDEX`.
    pub indices: Option<Vec<u32>>,
    /// The GRM1 geometry block's AABB: position xyz, size xyz.
    pub aabb: [f32; 6],
    /// What the native receiver's mesh residency compares (`rs_applier.gd` `_layout_key`): a
    /// surface whose layout changes is rebuilt, one whose layout holds is updated in place.
    pub layout: MeshLayout,
    /// The raw vertex, attribute, skin and index buffers, as `mesh_surface_update_*_region` would
    /// send them (an in-place update lists exactly the buffers whose bytes differ).
    pub buffers: [Vec<u8>; 4],
}

/// `rs_applier.gd` `_layout_key`: primitive, format, counts, buffer sizes, AABB and uv_scale.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshLayout {
    pub primitive: Primitive,
    pub format: i64,
    pub vertex_count: usize,
    pub index_count: usize,
    pub buffer_bytes: [usize; 4],
    pub aabb_bits: [u32; 6],
    pub uv_scale_bits: [u32; 4],
}

impl MeshGeometry {
    /// `_data_bytes`: the four buffers' sizes summed.
    pub fn data_bytes(&self) -> u64 {
        self.layout.buffer_bytes.iter().map(|b| *b as u64).sum()
    }
}

/// The raw GRM1 buffers of one surface (`mesh_geometry`'s input).
pub struct MeshBuffers<'a> {
    pub vertex: &'a [u8],
    pub attribute: &'a [u8],
    pub skin: &'a [u8],
    pub index: &'a [u8],
    pub uv_scale: [f32; 4],
}

pub const ARRAY_FORMAT_COLOR: i64 = 1 << 3;
pub const ARRAY_FORMAT_TEX_UV: i64 = 1 << 4;
pub const ARRAY_FORMAT_TEX_UV2: i64 = 1 << 5;
pub const ARRAY_FORMAT_CUSTOM0: i64 = 1 << 6;
pub const ARRAY_FORMAT_INDEX: i64 = 1 << 12;
pub const ARRAY_FLAG_COMPRESS_ATTRIBUTES: i64 = 1 << 29;

/// The IEEE-754 binary16 value of `h` as an `f32`, exactly (every half is representable).
pub fn half_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0f32 } else { 1.0f32 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let frac = (h & 0x03ff) as f32;
    if exp == 0 {
        // zero or subnormal: frac * 2^-24
        sign * frac * (1.0 / 16_777_216.0)
    } else if exp == 31 {
        if frac == 0.0 {
            sign * f32::INFINITY
        } else {
            f32::NAN
        }
    } else {
        sign * (1.0 + frac / 1024.0) * (2.0f32).powi(exp - 15)
    }
}

/// The unorm8 a float channel quantizes to for a receiver that cannot sample float (
/// render-stream-8.md): NaN is 0; any other value is clamped to [0, 1]
/// (so +-infinity and everything outside become 1 and 0); then `floor(fl32(fl32(c * 255) + 0.5))`,
/// that is round-half-up in single precision. No sRGB conversion: the value is taken as stored.
pub fn quantize_unorm8(v: f32) -> u8 {
    if v.is_nan() {
        return 0;
    }
    let c = v.clamp(0.0, 1.0);
    let scaled: f32 = c * 255.0;
    let biased: f32 = scaled + 0.5;
    biased.floor() as u8
}

/// Straight RGBA8 from a permitted format's level 0 (render-stream-2.md "Texture payload"):
/// L8 -> (l,l,l,1), LA8 -> (l,l,l,a), R8 -> (r,0,0,1), RG8 -> (r,g,0,1), RGB8 -> (r,g,b,1). From
/// /8 the float formats too (D9): RF, RGF, RGBF, RGBAF, RH, RGH, RGBH, RGBAH map their channels the
/// way R8, RG8, RGB8 and RGBA8 do (a missing G or B is 0, a missing alpha is 1), each channel
/// little-endian IEEE-754 (halves widened exactly first) and quantized by [`quantize_unorm8`].
pub fn texture_rgba8(
    format: &str,
    width: u32,
    height: u32,
    data: &[u8],
) -> Result<TexturePixels, String> {
    let n = width as usize * height as usize;
    // (bytes per channel, channels): 1 byte = unorm8, 2 = half, 4 = f32
    let (bpc, channels) = match format {
        "L8" | "R8" => (1, 1),
        "LA8" | "RG8" => (1, 2),
        "RGB8" => (1, 3),
        "RGBA8" => (1, 4),
        "RF" => (4, 1),
        "RGF" => (4, 2),
        "RGBF" => (4, 3),
        "RGBAF" => (4, 4),
        "RH" => (2, 1),
        "RGH" => (2, 2),
        "RGBH" => (2, 3),
        "RGBAH" => (2, 4),
        other => return Err(format!("texture format {other} has no RGBA8 conversion")),
    };
    let px = bpc * channels;
    if data.len() < n * px {
        return Err(format!(
            "texture data {} bytes < {}×{}×{px}",
            data.len(),
            width,
            height
        ));
    }
    let mut rgba = Vec::with_capacity(4 * n);
    let src = &data[..n * px];
    if bpc > 1 {
        // PM6b: a curve-sized f32 texture keeps its values too.
        let floats = (bpc == 4 && height <= 4).then(|| {
            let mut out = Vec::with_capacity(4 * n);
            for p in src.chunks_exact(px) {
                let mut v = [0.0f32, 0.0, 0.0, 1.0];
                for (i, c) in p.chunks_exact(4).enumerate() {
                    v[i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                }
                out.extend_from_slice(&v);
            }
            out
        });
        let channel = |c: &[u8]| -> u8 {
            if bpc == 2 {
                quantize_unorm8(half_to_f32(u16::from_le_bytes([c[0], c[1]])))
            } else {
                quantize_unorm8(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            }
        };
        for p in src.chunks_exact(px) {
            let mut v = [0u8, 0, 0, 255];
            for (i, c) in p.chunks_exact(bpc).enumerate() {
                v[i] = channel(c);
            }
            rgba.extend_from_slice(&v);
        }
        return Ok(TexturePixels {
            width,
            height,
            rgba: rgba.into(),
            format: format.to_string(),
            mipmaps: false,
            data_len: data.len(),
            compressed: None,
            half: None,
            floats,
            opacity: None,
        }
        .with_opacity());
    }
    match format {
        "RGBA8" => rgba.extend_from_slice(src),
        "RGB8" => {
            for c in src.chunks_exact(3) {
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        "LA8" => {
            for c in src.chunks_exact(2) {
                rgba.extend_from_slice(&[c[0], c[0], c[0], c[1]]);
            }
        }
        "L8" => {
            for &l in src {
                rgba.extend_from_slice(&[l, l, l, 255]);
            }
        }
        "RG8" => {
            for c in src.chunks_exact(2) {
                rgba.extend_from_slice(&[c[0], c[1], 0, 255]);
            }
        }
        _ => {
            for &r in src {
                rgba.extend_from_slice(&[r, 0, 0, 255]);
            }
        }
    }
    Ok(TexturePixels {
        width,
        height,
        rgba: rgba.into(),
        format: format.to_string(),
        mipmaps: false,
        data_len: data.len(),
        compressed: None,
        half: None,
        floats: None,
        opacity: None,
    }
    .with_opacity())
}

impl TexturePixels {
    /// [`TexturePixels::opacity`] over `rgba` (shared, not copied; the table is built on first
    /// need).
    pub fn with_opacity(mut self) -> Self {
        let n = 4 * self.width as usize * self.height as usize;
        self.opacity =
            (self.compressed.is_none() && self.half.is_none() && n > 0 && self.rgba.len() == n)
                .then(|| {
                    std::sync::Arc::new(gsw_canvas_draw_list::opacity::Opacity::lazy(
                        self.width,
                        self.height,
                        self.rgba.clone(),
                    ))
                });
        self
    }

    /// The bytes this store holds for the texture (G7k's budget): RGBA8 pixels, or a block
    /// variant's level 0.
    pub fn held_bytes(&self) -> u64 {
        self.rgba.len() as u64
            + self.compressed.as_ref().map_or(0, |c| c.len() as u64)
            + self.half.as_ref().map_or(0, |h| h.len() as u64)
    }
}

/// P3-CK: a half-float payload's level 0 as RGBA16F ([`TexturePixels::half`]), or None for any
/// other format. Channels map as [`texture_rgba8`]'s do: `RH` -> (r,0,0,1), `RGH` -> (r,g,0,1),
/// `RGBH` -> (r,g,b,1), `RGBAH` as is.
pub fn texture_rgba16f(
    format: &str,
    width: u32,
    height: u32,
    data: &[u8],
) -> Option<Result<TexturePixels, String>> {
    let channels = match format {
        "RH" => 1,
        "RGH" => 2,
        "RGBH" => 3,
        "RGBAH" => 4,
        _ => return None,
    };
    let n = width as usize * height as usize;
    let px = 2 * channels;
    if data.len() < n * px {
        return Some(Err(format!(
            "texture data {} bytes < {}×{}×{px}",
            data.len(),
            width,
            height
        )));
    }
    let half = if channels == 4 {
        data[..n * 8].to_vec()
    } else {
        let mut out = Vec::with_capacity(8 * n);
        for p in data[..n * px].chunks_exact(px) {
            // (0, 0, 0, 1.0) in binary16, little-endian; the payload's channels over it
            let mut v = [0u8, 0, 0, 0, 0, 0, 0x00, 0x3c];
            v[..px].copy_from_slice(p);
            out.extend_from_slice(&v);
        }
        out
    };
    Some(Ok(TexturePixels {
        width,
        height,
        rgba: SharedBytes::default(),
        compressed: None,
        half: Some(half.into()),
        floats: None,
        opacity: None,
        format: format.to_string(),
        mipmaps: false,
        data_len: data.len(),
    }))
}

/// G8kp: a block-format GRT1 payload's level 0 (render-stream-9.md "Texture payload": whole blocks
/// covering the level), kept as bytes for a compressed upload. None for a non-block format.
pub fn texture_block_level0(
    format: &str,
    width: u32,
    height: u32,
    data: &[u8],
) -> Option<Result<TexturePixels, String>> {
    crate::payload::block_format(format)?;
    let len = crate::payload::block_data_bytes(format, u64::from(width), u64::from(height), false)?;
    let len = usize::try_from(len).ok()?;
    if data.len() < len {
        return Some(Err(format!(
            "block texture {format} {width}x{height}: {} data bytes, level 0 needs {len}",
            data.len()
        )));
    }
    Some(Ok(TexturePixels {
        width,
        height,
        rgba: SharedBytes::default(),
        compressed: Some(data[..len].to_vec().into()),
        half: None,
        floats: None,
        opacity: None,
        format: format.to_string(),
        mipmaps: false,
        data_len: data.len(),
    }))
}

/// a KTX2 `uastc` variant after the browser's
/// transcoder worker turned it into `format` (an Image.Format name: a block format the context
/// uploads, or `RGBA8`, the fallback when it has none of D14's families). `data` is every
/// transcoded level, level 0 first; level 0 is what is uploaded, as for every other payload, and
/// `data.len()` is the upload accounting's `data_len`. The KTX2 itself was verified against its
/// hash and shape before it was transcoded ([`verify_ktx2`]).
pub fn texture_transcoded(
    format: &str,
    width: u32,
    height: u32,
    mipmaps: bool,
    data: &[u8],
) -> Result<TexturePixels, String> {
    let mut px = if format == "RGBA8" {
        let need = 4 * width as usize * height as usize;
        if data.len() < need {
            return Err(format!(
                "transcoded RGBA8 {width}x{height}: {} bytes, level 0 needs {need}",
                data.len()
            ));
        }
        let mut px = texture_rgba8("RGBA8", width, height, &data[..need])?;
        px.data_len = data.len();
        px
    } else {
        match texture_block_level0(format, width, height, data) {
            Some(r) => r?,
            None => return Err(format!("transcode target {format} is not a block format")),
        }
    };
    px.mipmaps = mipmaps;
    Ok(px)
}

/// G8kb: a KTX2 payload's SHA-256 against `expected` (skipped only under `skip-payload-hash`) and
/// its shape against the entry that lists it as a `uastc` variant (render-stream-9.md, Q6: the
/// receiver checks the KTX2 shape only; the transcode is the worker's). Nothing is decoded here.
pub fn verify_ktx2(
    bytes: &[u8],
    expected: &Hash,
    verify: bool,
    width: i64,
    height: i64,
    mipmaps: bool,
) -> Result<(), crate::wire::Error> {
    use crate::prof;
    let t = prof::start();
    if verify {
        let actual = crate::wire::sha256(bytes);
        if actual != *expected {
            return Err(crate::wire::Error::new(
                "resource-hash",
                format!(
                    "payload sha256 {} disagrees with the wire's {}",
                    actual.to_hex(),
                    expected.to_hex()
                ),
            ));
        }
    }
    prof::add(prof::PAYLOAD_HASH, t);
    let k = crate::payload::decode_ktx2(bytes)?;
    crate::payload::check_ktx2_shape(&k, "uastc", width, height, mipmaps)?;
    Ok(())
}

/// Mesh geometry from a GRM1 surface's decoded buffers.
pub fn mesh_geometry(
    primitive: Primitive,
    format: i64,
    aabb: [f32; 6],
    vertex_count: usize,
    index_count: usize,
    raw: MeshBuffers<'_>,
) -> Result<MeshGeometry, String> {
    mesh_geometry_reusing(primitive, format, aabb, vertex_count, index_count, raw, None)
}

/// PH2: [`mesh_geometry`] into a replaced geometry's buffers (`spare`), so a dynamic body that
/// arrives every transaction is decoded without allocating them again.
pub fn mesh_geometry_reusing(
    primitive: Primitive,
    format: i64,
    aabb: [f32; 6],
    vertex_count: usize,
    index_count: usize,
    raw: MeshBuffers<'_>,
    spare: Option<MeshGeometry>,
) -> Result<MeshGeometry, String> {
    let (mut positions, mut colors_buf, mut uvs_buf, mut indices_buf, mut buffers) = match spare {
        Some(g) => (
            g.positions,
            g.colors.unwrap_or_default(),
            g.uvs.unwrap_or_default(),
            g.indices.unwrap_or_default(),
            g.buffers,
        ),
        None => Default::default(),
    };
    let (vertex_data, attribute_data, index_data) = (raw.vertex, raw.attribute, raw.index);
    if format & ARRAY_FLAG_COMPRESS_ATTRIBUTES != 0 {
        return Err("compressed attributes".into());
    }
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if vertex_data.len() < vertex_count * 8 {
        return Err("short vertex buffer".into());
    }
    positions.clear();
    positions
        .extend((0..vertex_count).map(|i| [f32_at(vertex_data, 8 * i), f32_at(vertex_data, 8 * i + 4)]));
    let has_color = format & ARRAY_FORMAT_COLOR != 0;
    let has_uv = format & ARRAY_FORMAT_TEX_UV != 0;
    let stride = attribute_data.len().checked_div(vertex_count).unwrap_or(0);
    let needed = (if has_color { 4 } else { 0 }) + (if has_uv { 8 } else { 0 });
    if vertex_count > 0 && stride < needed {
        return Err("short attribute buffer".into());
    }
    let colors = has_color.then(|| {
        colors_buf.clear();
        colors_buf.extend((0..vertex_count).map(|i| {
            let o = i * stride;
            let c = &attribute_data[o..o + 4];
            [
                c[0] as f32 / 255.0,
                c[1] as f32 / 255.0,
                c[2] as f32 / 255.0,
                c[3] as f32 / 255.0,
            ]
        }));
        colors_buf
    });
    let uv_offset = if has_color { 4 } else { 0 };
    let uvs = has_uv.then(|| {
        uvs_buf.clear();
        uvs_buf.extend((0..vertex_count).map(|i| {
            let o = i * stride + uv_offset;
            [f32_at(attribute_data, o), f32_at(attribute_data, o + 4)]
        }));
        uvs_buf
    });
    let indices = if index_count > 0 {
        let wide = vertex_count > 65536;
        let size = if wide { 4 } else { 2 };
        if index_data.len() < index_count * size {
            return Err("short index buffer".into());
        }
        indices_buf.clear();
        indices_buf.extend((0..index_count).map(|i| {
            if wide {
                u32::from_le_bytes([
                    index_data[4 * i],
                    index_data[4 * i + 1],
                    index_data[4 * i + 2],
                    index_data[4 * i + 3],
                ])
            } else {
                u16::from_le_bytes([index_data[2 * i], index_data[2 * i + 1]]) as u32
            }
        }));
        Some(indices_buf)
    } else {
        None
    };
    for (b, src) in buffers
        .iter_mut()
        .zip([raw.vertex, raw.attribute, raw.skin, raw.index])
    {
        b.clear();
        b.extend_from_slice(src);
    }
    Ok(MeshGeometry {
        primitive,
        positions,
        colors,
        uvs,
        indices,
        aabb,
        layout: MeshLayout {
            primitive,
            format,
            vertex_count,
            index_count,
            buffer_bytes: [
                raw.vertex.len(),
                raw.attribute.len(),
                raw.skin.len(),
                raw.index.len(),
            ],
            aabb_bits: aabb.map(f32::to_bits),
            uv_scale_bits: raw.uv_scale.map(f32::to_bits),
        },
        buffers,
    })
}

/// G7o4: payload tables hash a digest's first 8 bytes ([`Hash`]'s `Hash` impl) with the id
/// hasher, not SipHash: a lookup per texture draw and per dependency check stays a few
/// instructions. No caller depends on a table's iteration order (each sorts or keeps its own).
pub type HashBuild = std::hash::BuildHasherDefault<crate::validate::IdHasher>;

/// Verified, decoded payloads by content hash.
#[derive(Default)]
pub struct PayloadStore {
    pub textures: HashMap<Hash, TexturePixels, HashBuild>,
    pub meshes: HashMap<Hash, MeshGeometry, HashBuild>,
    /// Shader code (GRP1): a payload's, or a `withheld` shader's from the adapter's library. The
    /// adapter transpiles it once per hash ([`super::Applier::pending_shaders`], G7s).
    pub shaders: HashMap<Hash, String, HashBuild>,
    /// G7k (D29 amendment, Q10 soak): touch order for budget eviction, oldest-touched at the
    /// front. `insert` moves a hash to the back; nothing else reorders it (a mere [`Self::has`]
    /// query is not a touch, matching the native receiver's cache, which only re-orders on a
    /// re-provide). A browser adapter with no budget never calls [`Self::evict_unreferenced`], so
    /// this is dead weight (one `VecDeque` push per provide) until it does.
    ///
    /// each slot carries its touch stamp, and a slot whose stamp is
    /// no longer the hash's current one in `touched` (re-touched later, or evicted) is stale and
    /// skipped, so a touch is O(1) instead of a scan of every held entry. At game scale the store
    /// holds one entry per animated mesh pose ever received (hundreds of thousands), and the scan
    /// made every provide linear in the session's length.
    order: VecDeque<(Hash, u64)>,
    /// P3-LV: each held hash's current touch stamp (the live slot in `order`).
    touched: HashMap<Hash, u64, HashBuild>,
    /// P3-LV: the last stamp handed out.
    stamp: u64,
    /// P3-LV: [`Self::total_bytes`], kept as entries come and go (it summed every entry).
    bytes: u64,
    /// W11c: /11 dynamic mesh geometry by mesh id (no hash, so no entry here per pose); not
    /// counted by [`Self::len`], [`Self::total_bytes`] or the budget eviction.
    pub dynamic: super::dynamic::DynamicMeshes,
    /// PM3: /11 multimesh instance buffers by multimesh id ([`super::multimesh`]); not counted by
    /// [`Self::len`], [`Self::total_bytes`] or the budget eviction.
    pub multimeshes: super::multimesh::MultimeshBuffers,
    /// PM6b: /12 emitters' simulated instance buffers by particles id ([`super::particles`]),
    /// set by the shell; not counted by [`Self::len`], [`Self::total_bytes`] or the budget
    /// eviction.
    pub particles: super::particles::ParticleBuffers,
}

/// P3-LV: a decoded payload's bytes as [`PayloadStore::total_bytes`] counts them.
fn decoded_bytes(d: &Decoded) -> u64 {
    match d {
        Decoded::Texture(px) => px.held_bytes(),
        Decoded::Mesh(g) => g.data_bytes(),
        Decoded::Shader(code) => code.len() as u64,
    }
}

impl PayloadStore {
    pub fn has(&self, hash: &Hash) -> bool {
        self.textures.contains_key(hash)
            || self.meshes.contains_key(hash)
            || self.shaders.contains_key(hash)
    }

    pub fn clear(&mut self) {
        self.textures.clear();
        self.meshes.clear();
        self.shaders.clear();
        self.order.clear();
        self.touched.clear();
        self.bytes = 0;
        self.dynamic.clear();
        self.multimeshes.clear();
        self.particles.clear();
    }

    /// W11c (render-stream-11.md "Receivers"): drop `hash` from the store now (a /11 hash that
    /// left the receiver's retention set H). Returns whether it was held.
    pub fn release(&mut self, hash: &Hash) -> bool {
        let held = self.has(hash);
        if held {
            self.remove_held(hash);
            self.compact_order();
        }
        held
    }

    /// W11c (render-stream-11.md "Receivers"): the store's half of an accepted /11 transaction,
    /// called right after `accept` returned `Accepted::Transaction`, with the same `record`: its
    /// dynamic mesh bodies replace their surfaces' geometry in [`Self::dynamic`] (by mesh id), and
    /// what the new state no longer holds as dynamic is dropped. A no-op below /11 (no bodies, no
    /// dynamic meshes). Retention of hashed entries is [`super::retention::Retention`]'s.
    pub fn accept_transaction(
        &mut self,
        v: &crate::validate::Validator,
        record: &[u8],
    ) -> Result<u32, crate::wire::Error> {
        // The motion measure reads what this transaction ingested, never an earlier one's.
        self.dynamic.recycle_moved();
        self.multimeshes.recycle_moved();
        // /13: the block ranges index the reconstructed /12 record.
        let record = v.record_view(record);
        if !self.multimeshes.is_empty() || !v.multimesh_buffers().is_empty() {
            // PM3: the transaction's multimesh buffers, by multimesh id.
            self.multimeshes
                .ingest(v.state(), v.multimesh_buffers(), record);
        }
        if self.dynamic.is_empty() && v.dynamic_bodies().is_empty() {
            return Ok(0);
        }
        self.dynamic.ingest(v.state(), v.dynamic_bodies(), record)
    }

    /// W11c: every hash held (textures, meshes and shaders).
    pub fn hashes(&self) -> impl Iterator<Item = &Hash> + '_ {
        self.textures
            .keys()
            .chain(self.meshes.keys())
            .chain(self.shaders.keys())
    }

    /// P3-LV: removes `hash` from every table and from `bytes` (its slot in `order` goes stale).
    fn remove_held(&mut self, hash: &Hash) {
        if let Some(t) = self.textures.remove(hash) {
            self.bytes = self.bytes.saturating_sub(t.held_bytes());
        }
        if let Some(m) = self.meshes.remove(hash) {
            self.bytes = self.bytes.saturating_sub(m.data_bytes());
        }
        if let Some(c) = self.shaders.remove(hash) {
            self.bytes = self.bytes.saturating_sub(c.len() as u64);
        }
        self.touched.remove(hash);
    }

    /// P3-LV: drops stale slots at the front, and every stale slot once they outnumber the live
    /// ones (amortised O(1) per touch).
    fn compact_order(&mut self) {
        while let Some((h, st)) = self.order.front() {
            if self.touched.get(h) == Some(st) {
                break;
            }
            self.order.pop_front();
        }
        if self.order.len() > 2 * self.touched.len() + 64 {
            let touched = &self.touched;
            self.order.retain(|(h, st)| touched.get(h) == Some(st));
        }
    }

    /// Verify and ingest one payload (Q14c `provide`): its SHA-256 must equal `expected` (the hash
    /// the wire named; `verify == false` is the `skip-payload-hash` sabotage only), then it is
    /// decoded by its own magic with the decoder's checks (`payload-*` codes) and converted.
    pub fn provide(
        &mut self,
        bytes: &[u8],
        expected: &Hash,
        version: u8,
        verify: bool,
    ) -> Result<(), crate::wire::Error> {
        let d = verify_decode(bytes, expected, version, verify)?;
        self.insert(*expected, d);
        Ok(())
    }

    /// A payload [`verify_decode`] already checked against `hash` (G7o2: a staged payload moving
    /// into the store when its transaction is applied).
    pub fn insert(&mut self, hash: Hash, d: Decoded) {
        // A re-provide replaces the held entry and moves the hash to the back (its old slot goes
        // stale), as the scan-and-remove this replaces did.
        self.remove_held(&hash);
        self.stamp += 1;
        self.touched.insert(hash, self.stamp);
        self.order.push_back((hash, self.stamp));
        self.bytes += decoded_bytes(&d);
        self.compact_order();
        match d {
            Decoded::Texture(px) => {
                self.textures.insert(hash, px);
            }
            Decoded::Mesh(g) => {
                self.meshes.insert(hash, g);
            }
            Decoded::Shader(code) => {
                self.shaders.insert(hash, code);
            }
        }
    }

    /// G7k: decoded bytes held (textures' straight RGBA8 pixels, meshes' four buffers, shaders'
    /// source) -- what a browser adapter counts toward `RS_RECEIVER_MEMORY_BUDGET_BYTES` (D29
    /// amendment: "the core's payload cache in wasm memory"; GL texture bytes are counted
    /// separately, by the adapter, since they are not in this store).
    ///
    /// P3-LV: kept as entries are inserted and evicted (it summed every entry on each call, once
    /// per eviction step), so it counts what [`Self::insert`]/[`Self::provide`] put in.
    pub fn total_bytes(&self) -> u64 {
        self.bytes
    }

    /// G7k: decoded bytes of the entries in `hashes` that this store holds (each hash once).
    pub fn bytes_of(&self, hashes: &HashSet<Hash>) -> u64 {
        hashes
            .iter()
            .map(|h| {
                self.textures.get(h).map_or(0, |t| t.held_bytes())
                    + self.meshes.get(h).map_or(0, |m| m.data_bytes())
                    + self.shaders.get(h).map_or(0, |s| s.len() as u64)
            })
            .sum()
    }

    /// G7k: entries currently held (the "memory-cache entries" metric G6s checks natively).
    pub fn len(&self) -> usize {
        self.textures.len() + self.meshes.len() + self.shaders.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// G7k (Q10 soak, `residency-bounded`/`cache-budget-respected`): evicts the oldest-touched
    /// entries not in `referenced`, until `total_bytes() <= budget_bytes` or nothing more can be
    /// evicted (every remaining entry is referenced -- the native rule, G6s: never evict the
    /// needed set, so one still-needed payload may keep the store over budget). Returns the
    /// number of entries evicted. The `no-evict` sabotage is simply never calling this.
    pub fn evict_unreferenced(&mut self, referenced: &HashSet<Hash>, budget_bytes: u64) -> u32 {
        let mut evicted = 0u32;
        let mut i = 0;
        while self.bytes > budget_bytes && i < self.order.len() {
            let (hash, st) = self.order[i];
            i += 1;
            // A stale slot (re-touched later, or already evicted), or a referenced entry, stays.
            if self.touched.get(&hash) != Some(&st) || referenced.contains(&hash) {
                continue;
            }
            // P3-LV: its slot goes stale in place (no shift of everything after it).
            self.remove_held(&hash);
            evicted += 1;
        }
        self.compact_order();
        evicted
    }
}

/// One verified, decoded payload, not yet in a [`PayloadStore`].
#[derive(Clone, Debug)]
pub enum Decoded {
    Texture(TexturePixels),
    Mesh(MeshGeometry),
    Shader(String),
}

/// The SHA-256 check against `expected` (skipped only by `verify == false`, the
/// `skip-payload-hash` sabotage) and the decode by magic: [`PayloadStore::provide`]'s work, with
/// nothing stored. Timed as the `payload_hash` and `payload_decode` phases.
pub fn verify_decode(
    bytes: &[u8],
    expected: &Hash,
    version: u8,
    verify: bool,
) -> Result<Decoded, crate::wire::Error> {
    use crate::prof;
    let t = prof::start();
    if verify {
        check_hash(crate::wire::sha256(bytes), expected)?;
    }
    prof::add(prof::PAYLOAD_HASH, t);
    let t = prof::start();
    let d = decode_payload(bytes, version)?;
    prof::add(prof::PAYLOAD_DECODE, t);
    Ok(d)
}

/// `resource-hash` unless the payload's `actual` SHA-256 is the wire's `expected` one.
fn check_hash(actual: Hash, expected: &Hash) -> Result<(), crate::wire::Error> {
    if actual != *expected {
        return Err(crate::wire::Error::new(
            "resource-hash",
            format!(
                "payload sha256 {} disagrees with the wire's {}",
                actual.to_hex(),
                expected.to_hex()
            ),
        ));
    }
    Ok(())
}

fn bad_payload(e: String) -> crate::wire::Error {
    crate::wire::Error::new("resource-payload", e)
}

/// [`verify_decode`]'s decode by magic, of bytes whose hash was already checked.
fn decode_payload(bytes: &[u8], version: u8) -> Result<Decoded, crate::wire::Error> {
    use crate::payload::{decode_mesh, decode_shader, decode_texture_v, payload_kind, PayloadKind};
    let bad = bad_payload;
    Ok(match payload_kind(bytes, version) {
        PayloadKind::Texture => {
            let t = decode_texture_v(bytes, version)?;
            Decoded::Texture(texture_pixels(
                &t.format,
                t.width as u32,
                t.height as u32,
                t.mipmaps,
                t.data,
                version,
            )?)
        }
        PayloadKind::Mesh => {
            let m = decode_mesh(bytes)?;
            Decoded::Mesh(
                mesh_geometry(
                    m.primitive,
                    m.format,
                    m.aabb,
                    m.vertex_count as usize,
                    m.index_count as usize,
                    MeshBuffers {
                        vertex: m.vertex_data,
                        attribute: m.attribute_data,
                        skin: m.skin_data,
                        index: m.index_data,
                        uv_scale: m.uv_scale,
                    },
                )
                .map_err(bad)?,
            )
        }
        PayloadKind::Shader => Decoded::Shader(decode_shader(bytes)?.code.to_string()),
        // /9: a KTX2 payload is a delivery variant; nothing here draws from one (render-stream-9.md).
        PayloadKind::Ktx2 => {
            return Err(bad(
                "a KTX2 payload is a delivery variant, not a drawable texture".to_string(),
            ))
        }
    })
}

/// A GRT1 texture's data bytes as the store holds them: block level 0 (/9), RGBA16F for a half
/// format, else straight RGBA8.
fn texture_pixels(
    format: &str,
    width: u32,
    height: u32,
    mipmaps: bool,
    data: &[u8],
    version: u8,
) -> Result<TexturePixels, crate::wire::Error> {
    let bad = bad_payload;
    if version < 8 && crate::payload::float_pixel_size(format).is_some() {
        return Err(bad(format!(
            "texture format {format} is a float format, legal at /8 only"
        )));
    }
    // G8kp: a block payload (legal only at /9, decode_texture_v sized it) stays compressed.
    let block = if version >= 9 {
        texture_block_level0(format, width, height, data)
    } else {
        None
    };
    // P3-CK: a half-float payload stays half (RGBA16F), as GLES3 keeps it.
    let block = block.or_else(|| texture_rgba16f(format, width, height, data));
    let mut px = match block {
        Some(b) => b.map_err(bad)?,
        None => texture_rgba8(format, width, height, data).map_err(bad)?,
    };
    px.mipmaps = mipmaps;
    Ok(px)
}

/// The most a size hint reserves up front; a longer body grows its buffer as it arrives.
const STREAM_HINT_MAX: usize = 256 << 20;

/// A GRT1 header longer than this is never split off (the payload stays contiguous).
const STREAM_SPLIT_HEADER_MAX: usize = 1 << 20;

enum StreamSplit {
    /// Fewer than 8 bytes so far.
    Undecided,
    /// Not GRT1 (or a header too long to split): the body stays one buffer.
    Contiguous,
    /// GRT1, its header not complete yet.
    Pending,
    /// GRT1: the header is in `header`, and `buf` holds only the data bytes.
    Split,
}

/// A payload arriving in pieces (a fetch body's chunks). Each piece is hashed as it arrives
/// (an incremental SHA-256, so [`PayloadStream::finish`] hashes nothing), and the bytes land in a
/// buffer reserved once from the size hint with no zero fill. A GRT1 texture's header is split off
/// as soon as it is complete, so `buf` holds exactly the data bytes and an unmipmapped RGBA8
/// texture moves that buffer into its pixels instead of copying it. The hint only sizes the
/// reservation: a body longer than it grows, and correctness never depends on it (a
/// content-encoded body's decoded length differs from its `Content-Length`).
pub struct PayloadStream {
    expected: Hash,
    version: u8,
    verify: bool,
    hasher: Option<sha2::Sha256>,
    buf: Vec<u8>,
    header: Vec<u8>,
    split: StreamSplit,
    /// Bytes received, header included.
    total: usize,
}

impl PayloadStream {
    pub fn new(expected: Hash, version: u8, verify: bool, size_hint: usize) -> Self {
        use sha2::Digest;
        PayloadStream {
            expected,
            version,
            verify,
            hasher: verify.then(sha2::Sha256::new),
            buf: Vec::with_capacity(size_hint.min(STREAM_HINT_MAX)),
            header: Vec::new(),
            split: StreamSplit::Undecided,
            total: 0,
        }
    }

    pub fn expected(&self) -> &Hash {
        &self.expected
    }

    /// Bytes received so far.
    pub fn len(&self) -> usize {
        self.total
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// Room for the next `len` bytes: a pointer to `len` bytes of spare capacity, which the
    /// caller fills and then [`commit`](Self::commit)s. The buffer may move (it grows when the
    /// hint was short), so the pointer is valid only until the next call on this stream.
    pub fn spare(&mut self, len: usize) -> *mut u8 {
        self.buf.reserve(len);
        self.buf.spare_capacity_mut().as_mut_ptr().cast::<u8>()
    }

    /// The next `len` bytes, written through [`spare`](Self::spare), are part of the payload.
    ///
    /// # Safety
    /// The caller wrote all `len` bytes at the pointer the last `spare(n)` (with `n >= len`)
    /// returned. (On wasm32, where every byte of linear memory is initialized, a short write
    /// exposes stale bytes, never uninitialized memory; the hash then refuses them.)
    pub unsafe fn commit(&mut self, len: usize) {
        let from = self.buf.len();
        assert!(len <= self.buf.capacity() - from, "commit past spare");
        // SAFETY: the caller initialized these `len` bytes of spare capacity.
        unsafe { self.buf.set_len(from + len) };
        self.arrived(from);
    }

    /// The next bytes of the payload, copied in.
    pub fn write(&mut self, bytes: &[u8]) {
        let from = self.buf.len();
        self.buf.extend_from_slice(bytes);
        self.arrived(from);
    }

    fn arrived(&mut self, from: usize) {
        use crate::prof;
        use sha2::Digest;
        let t = prof::start();
        if let Some(h) = self.hasher.as_mut() {
            h.update(&self.buf[from..]);
        }
        prof::add(prof::PAYLOAD_HASH, t);
        self.total += self.buf.len() - from;
        loop {
            match self.split {
                StreamSplit::Undecided if self.buf.len() >= 8 => {
                    self.split = if self.buf[..8] == crate::payload::GRT1_MAGIC {
                        StreamSplit::Pending
                    } else {
                        StreamSplit::Contiguous
                    };
                }
                StreamSplit::Pending if self.buf.len() >= 12 => {
                    let meta_len = crate::wire::le_u32(&self.buf, 8) as usize;
                    if meta_len > STREAM_SPLIT_HEADER_MAX {
                        self.split = StreamSplit::Contiguous;
                        continue;
                    }
                    let data_at = 16 + meta_len;
                    if self.buf.len() < data_at {
                        return;
                    }
                    // Only the bytes already past the header move (at most one piece).
                    self.header = self.buf[..data_at].to_vec();
                    let n = self.buf.len();
                    self.buf.copy_within(data_at..n, 0);
                    self.buf.truncate(n - data_at);
                    self.split = StreamSplit::Split;
                }
                _ => return,
            }
        }
    }

    /// The whole payload is in: the SHA-256 check (`resource-hash`, as [`verify_decode`]) and the
    /// decode. Every result and refusal is [`verify_decode`]'s for the same bytes.
    pub fn finish(self) -> Result<(Decoded, usize), crate::wire::Error> {
        use crate::prof;
        use sha2::Digest;
        let t = prof::start();
        if let Some(h) = self.hasher {
            let mut out = [0u8; 32];
            out.copy_from_slice(&h.finalize());
            check_hash(Hash(out), &self.expected)?;
        }
        prof::add(prof::PAYLOAD_HASH, t);
        let t = prof::start();
        let total = self.total;
        let d = match self.split {
            StreamSplit::Split => {
                let h = crate::payload::texture_header_v(&self.header, total, self.version)?;
                Decoded::Texture(texture_pixels_owned(h, self.buf, self.version)?)
            }
            _ => decode_payload(&self.buf, self.version)?,
        };
        prof::add(prof::PAYLOAD_DECODE, t);
        Ok((d, total))
    }
}

/// [`texture_pixels`] over the data bytes in their own buffer: an unmipmapped RGBA8 texture takes
/// the buffer as its pixels (no copy); every other format converts as [`texture_pixels`] does.
fn texture_pixels_owned(
    h: crate::payload::TextureHeader,
    mut data: Vec<u8>,
    version: u8,
) -> Result<TexturePixels, crate::wire::Error> {
    let level0 = h.width as usize * h.height as usize * 4;
    if h.format == "RGBA8" && !h.mipmaps && data.len() == level0 {
        if data.capacity() - data.len() > 64 << 10 {
            data.shrink_to_fit();
        }
        return Ok(TexturePixels {
            width: h.width as u32,
            height: h.height as u32,
            data_len: data.len(),
            rgba: std::sync::Arc::new(data),
            format: h.format,
            mipmaps: false,
            compressed: None,
            half: None,
            floats: None,
            opacity: None,
        }
        .with_opacity());
    }
    texture_pixels(
        &h.format,
        h.width as u32,
        h.height as u32,
        h.mipmaps,
        &data,
        version,
    )
}

/// G7o2: payloads verified and decoded when they arrive (a fetch completion, between frames),
/// ahead of the transaction that uses them. Nothing draws from here: [`PayloadStage::take`] hands
/// a staged payload to the store when its transaction is provided, and only a payload whose
/// SHA-256 matched the hash it was staged under ever enters (a mismatch is refused at
/// [`PayloadStage::stage`] and stages nothing). `verified` is false only under the
/// `skip-payload-hash` sabotage, which the `payload-verified-before-use` check counts.
#[derive(Default)]
pub struct PayloadStage {
    staged: HashMap<Hash, Staged, HashBuild>,
    /// Payloads staged (verified) / refused, since the last `clear`.
    pub staged_count: u64,
    pub refused_count: u64,
}

pub struct Staged {
    pub decoded: Decoded,
    pub bytes: usize,
    pub verified: bool,
}

impl PayloadStage {
    /// Verify `bytes` against `expected` and decode them; on success hold the result until
    /// `take`. A refused payload leaves nothing staged under `expected`.
    pub fn stage(
        &mut self,
        bytes: &[u8],
        expected: &Hash,
        version: u8,
        verify: bool,
    ) -> Result<(), crate::wire::Error> {
        match verify_decode(bytes, expected, version, verify) {
            Ok(decoded) => {
                self.staged.insert(
                    *expected,
                    Staged {
                        decoded,
                        bytes: bytes.len(),
                        verified: verify,
                    },
                );
                self.staged_count += 1;
                Ok(())
            }
            Err(e) => {
                self.staged.remove(expected);
                self.refused_count += 1;
                Err(e)
            }
        }
    }

    /// [`stage`](Self::stage) for a payload that arrived in pieces: hashed as it came, checked
    /// and decoded here, held until `take`. A refused payload leaves nothing staged under its hash.
    pub fn stage_stream(&mut self, stream: PayloadStream) -> Result<(), crate::wire::Error> {
        let expected = *stream.expected();
        let verify = stream.verify;
        match stream.finish() {
            Ok((decoded, bytes)) => {
                self.staged.insert(
                    expected,
                    Staged {
                        decoded,
                        bytes,
                        verified: verify,
                    },
                );
                self.staged_count += 1;
                Ok(())
            }
            Err(e) => {
                self.staged.remove(&expected);
                self.refused_count += 1;
                Err(e)
            }
        }
    }

    pub fn has(&self, hash: &Hash) -> bool {
        self.staged.contains_key(hash)
    }

    /// G8kb: stage a payload verified elsewhere (a KTX2 checked by [`verify_ktx2`] and transcoded
    /// by the browser's worker): `bytes` is the payload's own length, `verified` false only under
    /// `skip-payload-hash`.
    pub fn put(&mut self, hash: Hash, decoded: Decoded, bytes: usize, verified: bool) {
        self.staged.insert(
            hash,
            Staged {
                decoded,
                bytes,
                verified,
            },
        );
        self.staged_count += 1;
    }

    pub fn take(&mut self, hash: &Hash) -> Option<Staged> {
        self.staged.remove(hash)
    }

    pub fn len(&self) -> usize {
        self.staged.len()
    }

    pub fn is_empty(&self) -> bool {
        self.staged.is_empty()
    }

    pub fn clear(&mut self) {
        self.staged.clear();
        self.staged_count = 0;
        self.refused_count = 0;
    }
}

/// The payload hashes the last accepted transaction needs before it can be applied and that the
/// store does not hold yet (Q14c's needed set): `ok` image textures, `ok` mesh surfaces and shaders
/// whose code travels as a payload. `all` (a fresh receiver, or after a reset) looks at the whole
/// state, otherwise only at the delta's upserts.
pub fn needed(
    state: &crate::state::ResolvedState,
    delta: &crate::state::TxDelta,
    all: bool,
    store: &PayloadStore,
    out: &mut Vec<Hash>,
) {
    use crate::state::{EntryStatus, ShaderSource, TextureKind};
    out.clear();
    let mut push = |h: Hash, out: &mut Vec<Hash>| {
        if !store.has(&h) && !out.contains(&h) {
            out.push(h);
        }
    };
    let texture =
        |id: &crate::state::Id, out: &mut Vec<Hash>, push: &mut dyn FnMut(Hash, &mut Vec<Hash>)| {
            if let Some(t) = state.textures.get(id) {
                if t.kind == TextureKind::Image && t.status == EntryStatus::Ok {
                    if let Some(h) = t.hash {
                        push(h, out);
                    }
                }
            }
        };
    let mesh =
        |id: &crate::state::Id, out: &mut Vec<Hash>, push: &mut dyn FnMut(Hash, &mut Vec<Hash>)| {
            if let Some(m) = state.meshes.get(id) {
                if m.status == EntryStatus::Ok {
                    // /11: a dynamic surface has no payload to fetch.
                    for h in m.surfaces.iter().filter_map(|s| s.hash) {
                        push(h, out);
                    }
                }
            }
        };
    let shader =
        |id: &crate::state::Id, out: &mut Vec<Hash>, push: &mut dyn FnMut(Hash, &mut Vec<Hash>)| {
            if let Some(s) = state.shaders.get(id) {
                if s.status == EntryStatus::Ok && s.source == Some(ShaderSource::Payload) {
                    if let Some(h) = s.hash {
                        push(h, out);
                    }
                }
            }
        };
    if all {
        for id in state.textures.keys() {
            texture(id, out, &mut push);
        }
        for id in state.meshes.keys() {
            mesh(id, out, &mut push);
        }
        for id in state.shaders.keys() {
            shader(id, out, &mut push);
        }
    } else {
        for id in &delta.textures_upserted {
            texture(id, out, &mut push);
        }
        for id in &delta.meshes_upserted {
            mesh(id, out, &mut push);
        }
        for id in &delta.shaders_upserted {
            shader(id, out, &mut push);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2×1 RGBA8 GRT1 payload.
    fn grt1(px: [u8; 8]) -> Vec<u8> {
        let meta = br#"{"type":"texture-2d","format":"RGBA8","width":2,"height":1,"mipmaps":false,"data_bytes":8}"#;
        let mut b = crate::payload::GRT1_MAGIC.to_vec();
        b.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        b.extend_from_slice(meta);
        b.extend_from_slice(&8u32.to_le_bytes());
        b.extend_from_slice(&px);
        b
    }

    /// A float GRT1 payload of `format` (width x 1) over `data`.
    fn grt1_float(format: &str, width: u32, data: &[u8]) -> Vec<u8> {
        let meta = format!(
            r#"{{"type":"texture-2d","format":"{format}","width":{width},"height":1,"mipmaps":false,"data_bytes":{}}}"#,
            data.len()
        );
        let mut b = crate::payload::GRT1_MAGIC.to_vec();
        b.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        b.extend_from_slice(meta.as_bytes());
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(data);
        b
    }

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    #[test]
    fn half_floats_widen_exactly() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert!(half_to_f32(0x8000).is_sign_negative() && half_to_f32(0x8000) == 0.0);
        assert_eq!(half_to_f32(0x3c00), 1.0);
        assert_eq!(half_to_f32(0xc000), -2.0);
        assert_eq!(half_to_f32(0x3800), 0.5);
        assert_eq!(half_to_f32(0x7bff), 65504.0);
        assert_eq!(half_to_f32(0x0001), 2.0f32.powi(-24)); // the smallest subnormal
        assert_eq!(half_to_f32(0x0400), 2.0f32.powi(-14)); // the smallest normal
        assert_eq!(half_to_f32(0x7c00), f32::INFINITY);
        assert_eq!(half_to_f32(0xfc00), f32::NEG_INFINITY);
        assert!(half_to_f32(0x7e00).is_nan());
        // every half but NaN round-trips through f32 to the same value: spot-check the grid
        for h in (0u16..0x7c00).step_by(97) {
            let want = (h >> 10) as i32;
            let v = half_to_f32(h);
            assert!(v >= 0.0 && (want == 0 || v >= 2.0f32.powi(want - 15)));
        }
    }

    /// D9's rule, value by value: NaN 0, clamp to [0,1], floor(c*255 + 0.5) in single precision.
    #[test]
    fn float_channels_quantize_by_the_documented_rule() {
        let q = quantize_unorm8;
        assert_eq!(q(f32::NAN), 0);
        assert_eq!(q(f32::NEG_INFINITY), 0);
        assert_eq!(q(f32::INFINITY), 255);
        assert_eq!(q(-0.0), 0);
        assert_eq!(q(-3.5), 0);
        assert_eq!(q(0.0), 0);
        assert_eq!(q(1.0), 255);
        assert_eq!(q(2.0), 255);
        assert_eq!(q(65504.0), 255);
        assert_eq!(q(0.5), 128); // 127.5 rounds half up
        assert_eq!(q(1.0 / 255.0), 1);
        assert_eq!(q(0.5 / 255.0), 1); // exactly half rounds up (0.5/255*255 = 0.5 in f32)
        assert_eq!(q(0.499 / 255.0), 0);
        assert_eq!(q(254.5 / 255.0), 255);
        assert_eq!(q(254.4 / 255.0), 254);
        assert_eq!(q(0.2), 51);
        assert_eq!(q(1e-30), 0); // a tiny positive
        // monotone over a dense ramp, and the ends are exact
        let mut last = 0u8;
        for i in 0..=1000 {
            let v = q(i as f32 / 1000.0);
            assert!(v >= last);
            last = v;
        }
        assert_eq!(last, 255);
    }

    #[test]
    fn half_formats_keep_rgba16f() {
        // P3-CK: the half family stays half, bit for bit, with (0, 0, 0, 1.0) filling the
        // channels a format lacks; every other format is not this path's.
        let h = |v: &[u16]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        let half = |f: &str, v: &[u16]| texture_rgba16f(f, 1, 1, &h(v)).unwrap().unwrap();
        assert_eq!(
            half("RH", &[0x3801]).half.as_deref().unwrap()[..],
            h(&[0x3801, 0, 0, 0x3c00])[..]
        );
        assert_eq!(
            half("RGH", &[0x3c00, 0xbc00]).half.as_deref().unwrap()[..],
            h(&[0x3c00, 0xbc00, 0, 0x3c00])[..]
        );
        assert_eq!(
            half("RGBH", &[0x3c00, 0x3800, 0x7c00]).half.as_deref().unwrap()[..],
            h(&[0x3c00, 0x3800, 0x7c00, 0x3c00])[..]
        );
        let rgbah = half("RGBAH", &[0x3800, 0x3c00, 0x0000, 0x3401]);
        assert_eq!(
            rgbah.half.as_deref().map(|v| &v[..]),
            Some(&h(&[0x3800, 0x3c00, 0x0000, 0x3401])[..])
        );
        assert!(rgbah.rgba.is_empty() && rgbah.compressed.is_none());
        assert_eq!((rgbah.held_bytes(), rgbah.format.as_str()), (8, "RGBAH"));
        assert!(texture_rgba16f("RGBAF", 1, 1, &[0; 16]).is_none());
        assert!(texture_rgba16f("RGBA8", 1, 1, &[0; 4]).is_none());
        assert!(texture_rgba16f("RGBAH", 2, 1, &h(&[0; 4]))
            .unwrap()
            .is_err());
    }

    #[test]
    fn float_formats_convert_to_straight_rgba8() {
        // RF: (r,0,0,1); the second pixel is out of range and clamps.
        let rf = texture_rgba8("RF", 2, 1, &f32_bytes(&[0.5, 7.0])).unwrap();
        assert_eq!(rf.rgba[..], [128, 0, 0, 255, 255, 0, 0, 255]);
        // RGF: (r,g,0,1)
        let rgf = texture_rgba8("RGF", 1, 1, &f32_bytes(&[1.0, -1.0])).unwrap();
        assert_eq!(rgf.rgba[..], [255, 0, 0, 255]);
        // RGBF: (r,g,b,1)
        let rgbf = texture_rgba8("RGBF", 1, 1, &f32_bytes(&[0.0, 0.5, f32::NAN])).unwrap();
        assert_eq!(rgbf.rgba[..], [0, 128, 0, 255]);
        // RGBAF: alpha is quantized like a colour channel, straight
        let rgbaf = texture_rgba8("RGBAF", 1, 1, &f32_bytes(&[0.2, 4.0, 0.0, 0.5])).unwrap();
        assert_eq!(rgbaf.rgba[..], [51, 255, 0, 128]);
        // The half family: 0x3800 = 0.5, 0x3c00 = 1.0, 0x0000, 0xbc00 = -1
        let h = |v: &[u16]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        assert_eq!(texture_rgba8("RH", 1, 1, &h(&[0x3800])).unwrap().rgba[..], [128, 0, 0, 255]);
        assert_eq!(
            texture_rgba8("RGH", 1, 1, &h(&[0x3c00, 0xbc00])).unwrap().rgba[..],
            [255, 0, 0, 255]
        );
        assert_eq!(
            texture_rgba8("RGBH", 1, 1, &h(&[0x3c00, 0x3800, 0x7c00])).unwrap().rgba[..],
            [255, 128, 255, 255]
        );
        assert_eq!(
            texture_rgba8("RGBAH", 1, 1, &h(&[0x3800, 0x3c00, 0x0000, 0x3800])).unwrap().rgba[..],
            [128, 255, 0, 128]
        );
        // short data is refused, as for the 8-bit formats
        assert!(texture_rgba8("RGBAF", 2, 1, &[0u8; 31]).is_err());
        // a format with no conversion still has none
        assert!(texture_rgba8("RGBE9995", 1, 1, &[0u8; 4]).is_err());
    }

    /// The shared vectors (protocol/golden-8/float-quantize.json), produced by the checker's own
    /// TypeScript implementation of the rule: both must give every byte.
    #[test]
    fn quantization_matches_the_independent_vectors() {
        let text = include_str!("../../../protocol/golden-8/float-quantize.json");
        let field = |chunk: &str, key: &str| -> String {
            let k = format!("\"{key}\": ");
            let at = chunk.find(&k).unwrap_or_else(|| panic!("no {key}")) + k.len();
            let rest = &chunk[at..];
            let rest = rest.trim_start_matches('"');
            rest.split(['"', ',', '\n']).next().unwrap().trim().to_string()
        };
        let unhex = |h: &str| -> Vec<u8> {
            (0..h.len() / 2)
                .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap())
                .collect()
        };
        let mut n = 0;
        for chunk in text.split("\"name\": ").skip(1) {
            let format = field(chunk, "format");
            let width: u32 = field(chunk, "width").parse().unwrap();
            let height: u32 = field(chunk, "height").parse().unwrap();
            let data = unhex(&field(chunk, "data_hex"));
            let want = unhex(&field(chunk, "rgba_hex"));
            let got = texture_rgba8(&format, width, height, &data).unwrap();
            assert_eq!(got.rgba[..], want[..], "{format} {}", field(chunk, "name"));
            n += 1;
        }
        assert_eq!(n, 8, "one vector per float format");
    }

    #[test]
    fn a_float_payload_is_legal_at_v8_only() {
        let data = f32_bytes(&[0.25, 0.5, 0.75]);
        let bytes = grt1_float("RF", 3, &data);
        let hash = crate::wire::sha256(&bytes);
        match verify_decode(&bytes, &hash, 8, true).unwrap() {
            Decoded::Texture(t) => {
                assert_eq!(t.format, "RF");
                assert_eq!(t.rgba[..], [64, 0, 0, 255, 128, 0, 0, 255, 191, 0, 0, 255]);
            }
            _ => panic!("a texture"),
        }
        for v in [6u8, 7] {
            let e = verify_decode(&bytes, &hash, v, true).unwrap_err();
            assert_eq!(e.code, "resource-payload", "/{v}");
        }
    }

    #[test]
    fn a_ktx2_is_verified_against_hash_and_shape_before_transcoding() {
        // G8kb: the committed golden-9 UASTC file (16x16, five levels).
        let good = include_bytes!("../../../protocol/golden-9/payloads/ktx2-16x16-mips.ktx2");
        let h = crate::wire::sha256(good);
        assert!(verify_ktx2(good, &h, true, 16, 16, true).is_ok());
        assert_eq!(verify_ktx2(good, &Hash([0; 32]), true, 16, 16, true).unwrap_err().code, "resource-hash");
        assert!(verify_ktx2(good, &Hash([0; 32]), false, 16, 16, true).is_ok());
        assert_eq!(verify_ktx2(good, &h, true, 8, 8, true).unwrap_err().code, "ktx2-shape");
        let mut bad = good.to_vec();
        bad[0] ^= 1;
        assert_eq!(verify_ktx2(&bad, &crate::wire::sha256(&bad), true, 16, 16, true).unwrap_err().code, "ktx2-header");
    }

    #[test]
    fn a_transcode_keeps_level_0_and_counts_every_level() {
        // BC7 16x16 with mips: level 0 is 16 blocks (256 B); the data is every level (5 levels).
        let data = vec![7u8; 256 + 64 + 16 + 16 + 16];
        let px = texture_transcoded("BPTC_RGBA", 16, 16, true, &data).unwrap();
        assert_eq!(px.compressed.as_ref().unwrap().len(), 256);
        assert_eq!((px.data_len, px.mipmaps, px.format.as_str()), (data.len(), true, "BPTC_RGBA"));
        assert!(px.rgba.is_empty());
        let rgba = texture_transcoded("RGBA8", 2, 2, false, &[9u8; 16]).unwrap();
        assert_eq!((rgba.rgba.len(), rgba.compressed.is_none()), (16, true));
        assert!(texture_transcoded("RGBA8", 4, 4, false, &[0u8; 16]).is_err());
        assert!(texture_transcoded("ASTC_4x4", 16, 16, false, &[0u8; 255]).is_err());
        assert!(texture_transcoded("PNG", 4, 4, false, &[0u8; 64]).is_err());
    }

    #[test]
    fn staged_payload_is_verified_before_it_reaches_the_store() {
        let bytes = grt1([1, 2, 3, 4, 5, 6, 7, 8]);
        let hash = crate::wire::sha256(&bytes);
        let mut stage = PayloadStage::default();
        stage.stage(&bytes, &hash, 2, true).unwrap();
        assert!(stage.has(&hash));
        let mut store = PayloadStore::default();
        assert!(!store.has(&hash));
        let s = stage.take(&hash).unwrap();
        assert!(s.verified);
        assert_eq!(s.bytes, bytes.len());
        store.insert(hash, s.decoded);
        assert_eq!(store.textures[&hash].rgba[..], [1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(stage.is_empty());
    }

    /// Sabotage: one corrupted byte is refused at staging, so nothing can be provided under the
    /// wire's hash (the transaction waits or fails exactly as for a missing payload).
    #[test]
    fn corrupted_payload_byte_is_refused_before_use() {
        let bytes = grt1([1, 2, 3, 4, 5, 6, 7, 8]);
        let hash = crate::wire::sha256(&bytes);
        let mut bad = bytes.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0x01;
        let mut stage = PayloadStage::default();
        let e = stage.stage(&bad, &hash, 2, true).unwrap_err();
        assert_eq!(e.code, "resource-hash");
        assert!(!stage.has(&hash));
        assert_eq!((stage.staged_count, stage.refused_count), (0, 1));
        // A good copy staged earlier is dropped by a later refused one under the same hash.
        stage.stage(&bytes, &hash, 2, true).unwrap();
        assert!(stage.stage(&bad, &hash, 2, true).is_err());
        assert!(stage.take(&hash).is_none());
        // The skip-payload-hash sabotage stages it, marked unverified.
        stage.stage(&bad, &hash, 2, false).unwrap();
        assert!(!stage.take(&hash).unwrap().verified);
    }

    /// `bytes` streamed in pieces of `chunk` bytes (through `spare`/`commit` on odd pieces,
    /// `write` on even ones).
    fn streamed(bytes: &[u8], expected: &Hash, version: u8, verify: bool, chunk: usize, hint: usize)
        -> Result<(Decoded, usize), crate::wire::Error> {
        let mut st = PayloadStream::new(*expected, version, verify, hint);
        for (i, piece) in bytes.chunks(chunk.max(1)).enumerate() {
            if i % 2 == 0 {
                let p = st.spare(piece.len());
                // SAFETY: `spare` reserved `piece.len()` bytes at `p`; all of them are written.
                unsafe {
                    std::ptr::copy_nonoverlapping(piece.as_ptr(), p, piece.len());
                    st.commit(piece.len());
                }
            } else {
                st.write(piece);
            }
        }
        st.finish()
    }

    /// Every chunking of `bytes` decodes (or is refused) exactly as `verify_decode` does it whole.
    fn assert_stream_matches(bytes: &[u8], expected: &Hash, version: u8, verify: bool) {
        let whole = verify_decode(bytes, expected, version, verify);
        let n = bytes.len();
        for chunk in [1, 2, 3, 7, 11, 13, 16, 17, 61, 64, 4093, n.max(1)] {
            for hint in [0, n, n / 2, n * 3] {
                let got = streamed(bytes, expected, version, verify, chunk, hint);
                match (&whole, &got) {
                    (Ok(a), Ok((b, len))) => {
                        assert_eq!(format!("{a:?}"), format!("{b:?}"), "chunk {chunk} hint {hint}");
                        assert_eq!(*len, n);
                    }
                    (Err(a), Err(b)) => assert_eq!(
                        (a.code, &a.detail),
                        (b.code, &b.detail),
                        "chunk {chunk} hint {hint}"
                    ),
                    (a, b) => panic!("chunk {chunk} hint {hint}: whole {a:?} streamed {b:?}"),
                }
            }
        }
    }

    fn grt1_any(format: &str, width: u32, height: u32, mipmaps: bool, data: &[u8]) -> Vec<u8> {
        let meta = format!(
            r#"{{"type":"texture-2d","format":"{format}","width":{width},"height":{height},"mipmaps":{mipmaps},"data_bytes":{}}}"#,
            data.len()
        );
        let mut b = crate::payload::GRT1_MAGIC.to_vec();
        b.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        b.extend_from_slice(meta.as_bytes());
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(data);
        b
    }

    fn noise(n: usize, seed: u32) -> Vec<u8> {
        let mut x = seed.wrapping_mul(2654435761).max(1);
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn incremental_sha256_equals_the_one_shot_digest() {
        use sha2::Digest;
        let bytes = noise(100_003, 7);
        let whole = crate::wire::sha256(&bytes);
        for chunk in [1, 3, 63, 64, 65, 4097, 100_003] {
            let mut h = sha2::Sha256::new();
            for p in bytes.chunks(chunk) {
                h.update(p);
            }
            assert_eq!(h.finalize()[..], whole.0[..], "chunk {chunk}");
        }
    }

    #[test]
    fn a_streamed_payload_decodes_as_the_whole_one_at_every_chunking() {
        let mut payloads: Vec<(Vec<u8>, u8)> = vec![
            (grt1_any("RGBA8", 33, 7, false, &noise(33 * 7 * 4, 1)), 2),
            (grt1_any("RGB8", 5, 3, false, &noise(45, 2)), 2),
            (grt1_any("RGBA8", 4, 4, true, &noise(64 + 16 + 4, 3)), 2),
            (grt1_any("RGBAH", 3, 2, false, &noise(48, 4)), 8),
            (grt1_any("RGBAF", 2, 1, false, &f32_bytes(&[0.5, 2.0, -1.0, 0.25, 0.0, 1.0, 0.5, 0.5])), 8),
        ];
        payloads.push((include_bytes!("../../../protocol/golden-10/payloads/mesh1-a.grm").to_vec(), 10));
        payloads.push((include_bytes!("../../../protocol/golden-10/payloads/shader2-tint-v1.grp").to_vec(), 10));
        payloads.push((include_bytes!("../../../protocol/golden-10/payloads/dxt5-16x16-mips.grt").to_vec(), 10));
        payloads.push((include_bytes!("../../../protocol/golden-10/payloads/mip16.grt").to_vec(), 10));
        payloads.push((include_bytes!("../../../protocol/golden-10/payloads/ktx2-4x4.ktx2").to_vec(), 10));
        for (bytes, version) in &payloads {
            let hash = crate::wire::sha256(bytes);
            assert_stream_matches(bytes, &hash, *version, true);
            assert_stream_matches(bytes, &hash, *version, false);
        }
    }

    /// Malformed bodies are refused with `verify_decode`'s very code and detail: a header cut
    /// short, a body one byte short or long, a bad meta, a float format before /8, an empty body.
    #[test]
    fn a_malformed_streamed_payload_is_refused_as_the_whole_one() {
        let good = grt1_any("RGBA8", 3, 2, false, &noise(24, 5));
        let mut cases: Vec<(Vec<u8>, u8)> = vec![
            (Vec::new(), 2),
            (good[..5].to_vec(), 2),
            (good[..14].to_vec(), 2),
            (good[..good.len() - 1].to_vec(), 2),
            ([good.clone(), vec![0]].concat(), 2),
            (grt1_any("RGBA8", 3, 2, false, &noise(20, 6)), 2),
            (grt1_any("RGBAF", 1, 1, false, &noise(16, 7)), 7),
            (grt1_any("PNG", 1, 1, false, &noise(4, 8)), 2),
        ];
        let mut long_meta = good.clone();
        long_meta[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        cases.push((long_meta, 2));
        let mut bad_meta = good.clone();
        bad_meta[13] = b'!';
        cases.push((bad_meta, 2));
        for (bytes, version) in &cases {
            assert!(verify_decode(bytes, &crate::wire::sha256(bytes), *version, true).is_err());
            assert_stream_matches(bytes, &crate::wire::sha256(bytes), *version, true);
            assert_stream_matches(bytes, &crate::wire::sha256(bytes), *version, false);
        }
    }

    /// Sabotage: one corrupted byte in any piece is refused at staging (`resource-hash`), nothing is
    /// staged, and a good copy staged earlier under that hash is dropped, as `stage` does it.
    #[test]
    fn a_corrupted_streamed_byte_is_refused_before_use() {
        let bytes = grt1_any("RGBA8", 16, 16, false, &noise(1024, 9));
        let hash = crate::wire::sha256(&bytes);
        for at in [0, 9, 20, bytes.len() / 2, bytes.len() - 1] {
            let mut bad = bytes.clone();
            bad[at] ^= 0x01;
            let e = streamed(&bad, &hash, 2, true, 37, bad.len()).unwrap_err();
            assert_eq!(e.code, "resource-hash");
            assert_eq!(
                e.detail,
                verify_decode(&bad, &hash, 2, true).unwrap_err().detail
            );
        }
        let stream = |b: &[u8], verify: bool| {
            let mut st = PayloadStream::new(hash, 2, verify, b.len());
            st.write(b);
            st
        };
        let mut bad = bytes.clone();
        bad[bytes.len() - 10] ^= 0x80;
        let mut stage = PayloadStage::default();
        stage.stage_stream(stream(&bytes, true)).unwrap();
        assert!(stage.has(&hash));
        assert_eq!(stage.stage_stream(stream(&bad, true)).unwrap_err().code, "resource-hash");
        assert!(!stage.has(&hash));
        assert_eq!((stage.staged_count, stage.refused_count), (1, 1));
        // skip-payload-hash stages it, marked unverified.
        stage.stage_stream(stream(&bad, false)).unwrap();
        let s = stage.take(&hash).unwrap();
        assert!(!s.verified);
        assert_eq!(s.bytes, bad.len());
    }

    /// The unmipmapped RGBA8 path moves the streamed data buffer into the texture (no copy), and
    /// its pixels equal the copying path's.
    #[test]
    fn an_rgba8_stream_moves_its_buffer_into_the_texture() {
        let data = noise(64 * 32 * 4, 11);
        let bytes = grt1_any("RGBA8", 64, 32, false, &data);
        let hash = crate::wire::sha256(&bytes);
        let mut st = PayloadStream::new(hash, 2, true, bytes.len());
        for p in bytes.chunks(1000) {
            st.write(p);
        }
        assert!(matches!(st.split, StreamSplit::Split));
        assert_eq!(st.buf.len(), data.len());
        let buf_ptr = st.buf.as_ptr();
        let (d, len) = st.finish().unwrap();
        assert_eq!(len, bytes.len());
        let Decoded::Texture(px) = d else { panic!("a texture") };
        assert_eq!(px.rgba.as_ptr(), buf_ptr, "moved, not copied");
        let Decoded::Texture(old) = verify_decode(&bytes, &hash, 2, true).unwrap() else {
            panic!("a texture")
        };
        assert_eq!(px.rgba[..], old.rgba[..]);
        assert_eq!(px.rgba[..], data[..]);
        assert_eq!(
            (px.width, px.height, px.data_len, px.mipmaps, px.held_bytes()),
            (old.width, old.height, old.data_len, old.mipmaps, old.held_bytes())
        );
        // An overlong hint is not kept as slack in the held pixels.
        let mut st = PayloadStream::new(hash, 2, true, bytes.len() * 4);
        st.write(&bytes);
        let Decoded::Texture(px) = st.finish().unwrap().0 else { panic!("a texture") };
        assert!(px.rgba.capacity() - px.rgba.len() <= 64 << 10);
    }

    fn provide_n(store: &mut PayloadStore, n: u8) -> Hash {
        let bytes = grt1([n, n, n, n, n, n, n, n]);
        let hash = crate::wire::sha256(&bytes);
        store.provide(&bytes, &hash, 2, true).unwrap();
        hash
    }

    /// G7k: oldest-touched entries go first, and a referenced hash is never evicted even if the
    /// store stays over budget because of it (G6s's native rule).
    #[test]
    fn eviction_is_lru_and_never_touches_the_referenced_set() {
        let mut store = PayloadStore::default();
        let h1 = provide_n(&mut store, 1);
        let h2 = provide_n(&mut store, 2);
        let h3 = provide_n(&mut store, 3);
        assert_eq!(store.len(), 3);
        let one_entry_bytes = store.total_bytes() / 3;

        // Nothing referenced, budget for one entry: the two oldest (h1, h2) go.
        let referenced = HashSet::new();
        let evicted = store.evict_unreferenced(&referenced, one_entry_bytes);
        assert_eq!(evicted, 2);
        assert_eq!(store.len(), 1);
        assert!(!store.has(&h1));
        assert!(!store.has(&h2));
        assert!(store.has(&h3));

        // Re-provide h1 and h2; h3 is now the oldest-touched. A budget of one entry that
        // references h3 must evict h1 and h2 instead, and must not evict h3 even though the
        // store then stays over budget.
        let h1 = provide_n(&mut store, 1);
        let h2 = provide_n(&mut store, 2);
        assert_eq!(store.len(), 3);
        let mut referenced = HashSet::new();
        referenced.insert(h3);
        let evicted = store.evict_unreferenced(&referenced, one_entry_bytes);
        assert_eq!(evicted, 2);
        assert_eq!(store.len(), 1);
        assert!(store.has(&h3));
        assert!(!store.has(&h1));
        assert!(!store.has(&h2));
        assert!(store.total_bytes() > 0);

        // Re-touching a hash (a re-provide of an already-resident one) moves it to the back.
        let mut store = PayloadStore::default();
        let h1 = provide_n(&mut store, 1);
        let h2 = provide_n(&mut store, 2);
        provide_n(&mut store, 1); // re-provide: h1 is now the most-recently-touched.
        let evicted = store.evict_unreferenced(&HashSet::new(), one_entry_bytes);
        assert_eq!(evicted, 1);
        assert!(!store.has(&h2)); // h2, not h1, was the oldest-touched.
        assert!(store.has(&h1));
    }

    /// P3-LV: the touch order is stamped, not scanned. Re-provides leave stale slots that eviction
    /// skips and compaction drops, so the order stays bounded by the live entries, `total_bytes`
    /// follows every insert, re-provide and eviction, and the LRU order is the scan's.
    #[test]
    fn stamped_touch_order_stays_bounded_and_counts_bytes() {
        let mut store = PayloadStore::default();
        let hashes: Vec<Hash> = (1..=50u8).map(|n| provide_n(&mut store, n)).collect();
        let one = store.total_bytes() / 50;
        assert_eq!(store.total_bytes(), 50 * one);
        // 2,000 re-provides of the same hashes: no growth in entries, bytes or the order.
        for round in 0..40u8 {
            for n in 1..=50u8 {
                provide_n(&mut store, n);
            }
            assert_eq!(store.len(), 50, "round {round}");
            assert_eq!(store.total_bytes(), 50 * one, "round {round}");
            assert!(store.order.len() <= 2 * store.touched.len() + 64, "round {round}");
        }
        // Touch 1..=10 once more: 11..=50 are now the oldest, in provide order.
        for n in 1..=10u8 {
            provide_n(&mut store, n);
        }
        let mut referenced = HashSet::new();
        referenced.insert(hashes[10]); // h11, the oldest, is referenced and must stay
        let evicted = store.evict_unreferenced(&referenced, 20 * one);
        assert_eq!(evicted, 30);
        assert_eq!(store.total_bytes(), 20 * one);
        assert!(store.has(&hashes[10]));
        for h in &hashes[11..41] {
            assert!(!store.has(h)); // h12..=h41 went, oldest first
        }
        for h in hashes[41..].iter().chain(&hashes[..10]) {
            assert!(store.has(h));
        }
        // An evicted hash provided again is held again, at the back.
        provide_n(&mut store, 12);
        assert!(store.has(&hashes[11]));
        assert_eq!(store.total_bytes(), 21 * one);
        store.clear();
        assert_eq!(store.total_bytes(), 0);
        assert!(store.order.is_empty() && store.touched.is_empty());
    }

    /// G7k: `bytes_of` counts each named hash once, and only what the store holds.
    #[test]
    fn bytes_of_counts_held_hashes_once() {
        let mut store = PayloadStore::default();
        let h1 = provide_n(&mut store, 1);
        let h2 = provide_n(&mut store, 2);
        let one = store.total_bytes() / 2;
        let mut set = HashSet::new();
        set.insert(h1);
        assert_eq!(store.bytes_of(&set), one);
        set.insert(h2);
        set.insert(Hash([9u8; 32])); // never provided: contributes nothing
        assert_eq!(store.bytes_of(&set), 2 * one);
    }

    /// `no-evict` is simply never calling [`PayloadStore::evict_unreferenced`]: the store keeps
    /// growing past the budget, by construction (no new behaviour to test beyond "it was never
    /// called" -- the adapter's own call site is what a sabotage omits).
    #[test]
    fn a_budget_respected_by_one_call_is_unbounded_without_it() {
        let mut store = PayloadStore::default();
        for n in 0..10u8 {
            provide_n(&mut store, n);
        }
        assert_eq!(store.len(), 10);
        // "no-evict": the adapter never calls evict_unreferenced, so nothing shrinks.
        assert_eq!(store.len(), 10);
    }
}
