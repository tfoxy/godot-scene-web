//! Resource payload decoders, pure over `&[u8]`: render-stream-texture/1 (GRT1,
//! render-stream-2.md "Texture payload"), render-stream-mesh/1 (GRM1, render-stream-4.md "Mesh
//! payload") and render-stream-shader/1 (GRP1, render-stream-5.md "Shader payload"). Errors carry
//! the TypeScript decoders' codes: `payload-magic`, `payload-meta`, `payload-length`,
//! `payload-size`, `payload-utf8`.

use crate::json::Doc;
use crate::meta::{printable_ascii, Ck};
use crate::state::Primitive;
use crate::wire::{le_f32, le_u32, Error};

pub const GRT1_MAGIC: [u8; 8] = [0x47, 0x52, 0x54, 0x31, 0x0d, 0x0a, 0x1a, 0x0a];
pub const GRM1_MAGIC: [u8; 8] = [0x47, 0x52, 0x4d, 0x31, 0x0d, 0x0a, 0x1a, 0x0a];
pub const GRP1_MAGIC: [u8; 8] = [0x47, 0x52, 0x50, 0x31, 0x0d, 0x0a, 0x1a, 0x0a];

fn err(code: &'static str, detail: impl Into<String>) -> Error {
    Error::new(code, detail)
}

/// Parses a payload meta: printable ASCII, JSON, then `check` (which reports `payload-meta` for a
/// schema failure), then canonical form.
fn payload_meta<T>(
    meta: &[u8],
    check: impl FnOnce(&mut Ck, crate::json::Value) -> Option<T>,
) -> Result<T, Error> {
    if !printable_ascii(meta) {
        return Err(err(
            "payload-meta",
            "meta contains a non-printable-ASCII byte",
        ));
    }
    let doc = Doc::parse(meta).map_err(|_| err("payload-meta", "meta is not valid JSON"))?;
    let mut ck = Ck::new(&doc, 0);
    let out = check(&mut ck, doc.root()).ok_or_else(|| {
        err(
            "payload-meta",
            "meta has the wrong keys or an invalid field",
        )
    })?;
    if ck.dups || !doc.lexically_canonical() {
        return Err(err("payload-meta", "meta is not canonical JSON"));
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------- GRT1

/// The six uncompressed formats with a known pixel size (render-stream-2.md "Texture payload").
pub fn pixel_size(format: &str) -> Option<u64> {
    Some(match format {
        "L8" | "R8" => 1,
        "LA8" | "RG8" => 2,
        "RGB8" => 3,
        "RGBA8" => 4,
        _ => return None,
    })
}

/// The eight float payload formats' pixel sizes, legal at /8 only (render-stream-8.md "Texture
/// payload", gate8-design.md D9).
pub fn float_pixel_size(format: &str) -> Option<u64> {
    Some(match format {
        "RF" => 4,
        "RGF" => 8,
        "RGBF" => 12,
        "RGBAF" => 16,
        "RH" => 2,
        "RGH" => 4,
        "RGBH" => 6,
        "RGBAH" => 8,
        _ => return None,
    })
}

fn mip_chain_texels(width: u64, height: u64, mipmaps: bool) -> u128 {
    let (mut w, mut h) = (width as u128, height as u128);
    let mut total = w * h;
    if mipmaps {
        while w > 1 || h > 1 {
            w = (w / 2).max(1);
            h = (h / 2).max(1);
            total += w * h;
        }
    }
    total
}

/// `expectedDataBytes()`: None when the format has no known pixel size.
pub fn expected_data_bytes(format: &str, width: u64, height: u64, mipmaps: bool) -> Option<u128> {
    expected_data_bytes_v(format, width, height, mipmaps, 6)
}

/// [`expected_data_bytes`] at a protocol `version`: from /8 the float formats are sized too (below
/// /8 they stay unsized, as before).
pub fn expected_data_bytes_v(
    format: &str,
    width: u64,
    height: u64,
    mipmaps: bool,
    version: u8,
) -> Option<u128> {
    let size = pixel_size(format).or_else(|| {
        if version >= 8 {
            float_pixel_size(format)
        } else {
            None
        }
    });
    let Some(size) = size else {
        // /9: the block formats are sized too (render-stream-9.md "Texture payload").
        return if version >= 9 {
            block_data_bytes(format, width, height, mipmaps)
        } else {
            None
        };
    };
    Some(size as u128 * mip_chain_texels(width, height, mipmaps))
}

/// The block formats legal as a `block` variant (render-stream-9.md "Texture payload"): Godot's
/// block edge and pixel right-shift (`core/io/image.cpp` `get_format_block_size` / `_rshift`; the
/// pixel size of every block format is 1), so one level is
/// `ceil(w/block) * block * ceil(h/block) * block >> shift` bytes. The swizzled `*_RA_AS_RG` and
/// the HDR formats are not offered.
pub fn block_format(format: &str) -> Option<(u64, u32)> {
    Some(match format {
        "DXT1" | "RGTC_R" | "ETC" | "ETC2_R11" | "ETC2_R11S" | "ETC2_RGB8" | "ETC2_RGB8A1" => (4, 1),
        "DXT3" | "DXT5" | "RGTC_RG" | "BPTC_RGBA" | "ETC2_RG11" | "ETC2_RG11S" | "ETC2_RGBA8"
        | "ASTC_4x4" => (4, 0),
        "ASTC_8x8" => (8, 2),
        _ => return None,
    })
}

/// The data size of a block format's mip chain (`Image::_get_dst_image_size`), None for any other
/// format name.
pub fn block_data_bytes(format: &str, width: u64, height: u64, mipmaps: bool) -> Option<u128> {
    let (block, shift) = block_format(format)?;
    let (mut w, mut h) = (width, height);
    let mut total: u128 = 0;
    loop {
        let bw = if w % block != 0 { w + (block - w % block) } else { w };
        let bh = if h % block != 0 { h + (block - h % block) } else { h };
        total += ((bw as u128) * (bh as u128)) >> shift;
        if !mipmaps || (w == 1 && h == 1) {
            break;
        }
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    Some(total)
}

#[derive(Clone, Debug, PartialEq)]
pub struct TexturePayload<'a> {
    pub format: String,
    pub width: i64,
    pub height: i64,
    pub mipmaps: bool,
    pub data: &'a [u8],
}

/// `decodeTexturePayload()` (at /6).
pub fn decode_texture(bytes: &[u8]) -> Result<TexturePayload<'_>, Error> {
    decode_texture_v(bytes, 6)
}

/// `decodeTexturePayload()` at a protocol `version` (the float formats are sized from /8).
pub fn decode_texture_v(bytes: &[u8], version: u8) -> Result<TexturePayload<'_>, Error> {
    if bytes.len() < 16 || bytes[..8] != GRT1_MAGIC {
        return Err(err(
            "payload-magic",
            "the first 8 bytes are not the GRT1 magic",
        ));
    }
    let meta_len = le_u32(bytes, 8) as usize;
    if 12 + meta_len + 4 > bytes.len() {
        return Err(err(
            "payload-length",
            "meta_len runs past the end of the payload",
        ));
    }
    let (format, width, height, mipmaps, data_bytes) =
        payload_meta(&bytes[12..12 + meta_len], |ck, v| {
            let f = ck.fields(
                v,
                &["type", "format", "width", "height", "mipmaps", "data_bytes"],
            )?;
            if ck.string(f.at(0)) != Some(b"texture-2d") {
                return None;
            }
            let format = ck.string(f.at(1))?;
            let width = ck.int_ge(f.at(2), 1)?;
            let height = ck.int_ge(f.at(3), 1)?;
            let mipmaps = ck.boolean(f.at(4))?;
            let data_bytes = ck.int_ge(f.at(5), 0)?;
            Some((
                String::from_utf8_lossy(format).into_owned(),
                width,
                height,
                mipmaps,
                data_bytes,
            ))
        })?;
    let data_len_at = 12 + meta_len;
    let data_len = le_u32(bytes, data_len_at) as i64;
    if data_len != data_bytes {
        return Err(err(
            "payload-length",
            "data_len disagrees with meta.data_bytes",
        ));
    }
    let data_at = data_len_at + 4;
    if data_at + data_len as usize != bytes.len() {
        return Err(err(
            "payload-length",
            "the trailing bytes do not equal data_len",
        ));
    }
    if let Some(expected) =
        expected_data_bytes_v(&format, width as u64, height as u64, mipmaps, version)
    {
        if expected != data_len as u128 {
            return Err(err(
                "payload-size",
                format!("data_bytes is {data_len}, expected {expected} for {format} {width}x{height} mipmaps={mipmaps}"),
            ));
        }
    }
    Ok(TexturePayload {
        format,
        width,
        height,
        mipmaps,
        data: &bytes[data_at..data_at + data_len as usize],
    })
}

// ------------------------------------------------------------------------------------- GRM1

pub const ARRAY_FORMAT_COLOR: i64 = 1 << 3;
pub const ARRAY_FORMAT_TEX_UV: i64 = 1 << 4;
pub const ARRAY_FORMAT_BONES: i64 = 1 << 10;
pub const ARRAY_FORMAT_WEIGHTS: i64 = 1 << 11;
pub const ARRAY_FORMAT_INDEX: i64 = 1 << 12;
pub const ARRAY_FLAG_USE_8_BONE_WEIGHTS: i64 = 1 << 27;

/// JavaScript's `ToInt32` view of an integer-valued format (`format & bit` in the TypeScript).
fn js_bits(format: i64) -> i64 {
    format as i32 as i64
}

/// `expectedMeshBufferBytes()`: (vertex, attribute, skin, index) byte lengths.
pub fn expected_mesh_buffer_bytes(format: i64, vertex_count: i64, index_count: i64) -> [u128; 4] {
    let n = vertex_count as u128;
    let f = js_bits(format);
    let vertex = 8 * n;
    let attribute = n
        * ((if f & ARRAY_FORMAT_COLOR != 0 { 4 } else { 0 })
            + (if f & ARRAY_FORMAT_TEX_UV != 0 { 8 } else { 0 }));
    let skinned = f & ARRAY_FORMAT_BONES != 0 && f & ARRAY_FORMAT_WEIGHTS != 0;
    let skin = if skinned {
        n * (if f & ARRAY_FLAG_USE_8_BONE_WEIGHTS != 0 {
            32
        } else {
            16
        })
    } else {
        0
    };
    let index = if index_count == 0 {
        0
    } else {
        index_count as u128 * (if vertex_count <= 65536 { 2 } else { 4 })
    };
    [vertex, attribute, skin, index]
}

#[derive(Clone, Debug, PartialEq)]
pub struct MeshPayload<'a> {
    pub primitive: Primitive,
    pub format: i64,
    pub vertex_count: i64,
    pub index_count: i64,
    pub aabb: [f32; 6],
    pub uv_scale: [f32; 4],
    pub vertex_data: &'a [u8],
    pub attribute_data: &'a [u8],
    pub skin_data: &'a [u8],
    pub index_data: &'a [u8],
}

/// `decodeMeshPayload()`.
pub fn decode_mesh(bytes: &[u8]) -> Result<MeshPayload<'_>, Error> {
    if bytes.len() < 8 || bytes[..8] != GRM1_MAGIC {
        return Err(err(
            "payload-magic",
            "the first 8 bytes are not the GRM1 magic",
        ));
    }
    if bytes.len() < 12 {
        return Err(err(
            "payload-length",
            "the payload ends inside the meta_len prefix",
        ));
    }
    let meta_len = le_u32(bytes, 8) as usize;
    if 12 + meta_len + 40 > bytes.len() {
        return Err(err(
            "payload-length",
            "meta_len and the geometry block run past the end of the payload",
        ));
    }
    let (primitive, format, vertex_count, index_count, lens) =
        payload_meta(&bytes[12..12 + meta_len], |ck, v| {
            let f = ck.fields(
                v,
                &[
                    "type",
                    "primitive",
                    "format",
                    "vertex_count",
                    "index_count",
                    "vertex_bytes",
                    "attribute_bytes",
                    "skin_bytes",
                    "index_bytes",
                ],
            )?;
            if ck.string(f.at(0)) != Some(b"mesh-surface") {
                return None;
            }
            let p = ck.string(f.at(1))?;
            let primitive = Primitive::ALL
                .iter()
                .copied()
                .find(|x| x.as_str().as_bytes() == p)?;
            let format = ck.int(f.at(2))?;
            let vc = ck.int_ge(f.at(3), 0)?;
            let ic = ck.int_ge(f.at(4), 0)?;
            let mut lens = [0i64; 4];
            for (k, l) in lens.iter_mut().enumerate() {
                *l = ck.int_ge(f.at(5 + k), 0)?;
            }
            Some((primitive, format, vc, ic, lens))
        })?;
    let geo = 12 + meta_len;
    let mut aabb = [0f32; 6];
    for (k, a) in aabb.iter_mut().enumerate() {
        *a = le_f32(bytes, geo + 4 * k);
    }
    let mut uv_scale = [0f32; 4];
    for (k, u) in uv_scale.iter_mut().enumerate() {
        *u = le_f32(bytes, geo + 24 + 4 * k);
    }
    let data_at = geo + 40;
    let declared: u128 = lens.iter().map(|&l| l as u128).sum();
    if data_at as u128 + declared != bytes.len() as u128 {
        return Err(err(
            "payload-length",
            "the trailing bytes do not equal vertex_bytes+attribute_bytes+skin_bytes+index_bytes",
        ));
    }
    let expected = expected_mesh_buffer_bytes(format, vertex_count, index_count);
    if (0..4).any(|k| expected[k] != lens[k] as u128) {
        return Err(err(
            "payload-size",
            format!(
                "buffer lengths ({}, {}, {}, {}) disagree with the shape computed from format/vertex_count/index_count ({}, {}, {}, {})",
                lens[0], lens[1], lens[2], lens[3], expected[0], expected[1], expected[2], expected[3]
            ),
        ));
    }
    let mut p = data_at;
    let mut take = |n: i64| {
        let s = &bytes[p..p + n as usize];
        p += n as usize;
        s
    };
    let vertex_data = take(lens[0]);
    let attribute_data = take(lens[1]);
    let skin_data = take(lens[2]);
    let index_data = take(lens[3]);
    Ok(MeshPayload {
        primitive,
        format,
        vertex_count,
        index_count,
        aabb,
        uv_scale,
        vertex_data,
        attribute_data,
        skin_data,
        index_data,
    })
}

/// render-stream-11.md "Mesh entry": a dynamic surface's body length (40 bytes of geometry, then
/// the vertex, attribute, skin and index bytes), from its shape alone.
pub fn mesh_body_bytes(format: i64, vertex_count: i64, index_count: i64) -> u128 {
    40 + expected_mesh_buffer_bytes(format, vertex_count, index_count)
        .iter()
        .sum::<u128>()
}

/// A /11 dynamic surface's body (a `render-stream-mesh/1` payload without its first 12 bytes and
/// its meta), split like [`decode_mesh`] by the surface's shape: `payload-size` when its length
/// disagrees with that shape.
pub fn decode_mesh_body(
    bytes: &[u8],
    primitive: Primitive,
    format: i64,
    vertex_count: i64,
    index_count: i64,
) -> Result<MeshPayload<'_>, Error> {
    let lens = expected_mesh_buffer_bytes(format, vertex_count, index_count);
    let expected = mesh_body_bytes(format, vertex_count, index_count);
    if expected != bytes.len() as u128 {
        return Err(err(
            "payload-size",
            format!(
                "a dynamic mesh body is {} bytes, its shape needs {expected}",
                bytes.len()
            ),
        ));
    }
    let mut aabb = [0f32; 6];
    for (k, a) in aabb.iter_mut().enumerate() {
        *a = le_f32(bytes, 4 * k);
    }
    let mut uv_scale = [0f32; 4];
    for (k, u) in uv_scale.iter_mut().enumerate() {
        *u = le_f32(bytes, 24 + 4 * k);
    }
    let mut p = 40usize;
    let mut take = |n: u128| {
        let s = &bytes[p..p + n as usize];
        p += n as usize;
        s
    };
    let vertex_data = take(lens[0]);
    let attribute_data = take(lens[1]);
    let skin_data = take(lens[2]);
    let index_data = take(lens[3]);
    Ok(MeshPayload {
        primitive,
        format,
        vertex_count,
        index_count,
        aabb,
        uv_scale,
        vertex_data,
        attribute_data,
        skin_data,
        index_data,
    })
}

// ------------------------------------------------------------------------------------- GRP1

#[derive(Clone, Debug, PartialEq)]
pub struct ShaderPayload<'a> {
    pub code_bytes: i64,
    /// The code as `TextDecoder("utf-8", {fatal: true})` decodes it (a leading BOM is dropped).
    pub code: &'a str,
}

/// `decodeShaderPayload()`.
pub fn decode_shader(bytes: &[u8]) -> Result<ShaderPayload<'_>, Error> {
    if bytes.len() < 8 || bytes[..8] != GRP1_MAGIC {
        return Err(err(
            "payload-magic",
            "the first 8 bytes are not the GRP1 magic",
        ));
    }
    if bytes.len() < 12 {
        return Err(err(
            "payload-length",
            "the payload ends inside the meta_len prefix",
        ));
    }
    let meta_len = le_u32(bytes, 8) as usize;
    if 12 + meta_len > bytes.len() {
        return Err(err(
            "payload-length",
            "meta_len runs past the end of the payload",
        ));
    }
    let code_bytes = payload_meta(&bytes[12..12 + meta_len], |ck, v| {
        let f = ck.fields(v, &["type", "code_bytes"])?;
        if ck.string(f.at(0)) != Some(b"shader-code") {
            return None;
        }
        ck.int_ge(f.at(1), 0)
    })?;
    let at = 12 + meta_len;
    if at as u128 + code_bytes as u128 != bytes.len() as u128 {
        return Err(err(
            "payload-length",
            "the trailing bytes do not equal meta.code_bytes",
        ));
    }
    let code = std::str::from_utf8(&bytes[at..])
        .map_err(|_| err("payload-utf8", "the code bytes are not valid UTF-8"))?;
    let code = code.strip_prefix('\u{feff}').unwrap_or(code);
    Ok(ShaderPayload { code_bytes, code })
}

/// The payload format a resource record's payload claims by its magic, as the validator tells them
/// apart at `version` (GRP1 only from /5, GRM1 only from /4; anything else is read as GRT1).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayloadKind {
    Texture,
    Mesh,
    Shader,
    /// /9 only: a `render-stream-texture/ktx2` payload, a delivery variant (never drawn directly).
    Ktx2,
}

pub fn payload_kind(bytes: &[u8], version: u8) -> PayloadKind {
    let head = bytes.get(..8);
    if version >= 9 && bytes.get(..12) == Some(&KTX2_IDENTIFIER[..]) {
        PayloadKind::Ktx2
    } else if version >= 5 && head == Some(&GRP1_MAGIC[..]) {
        PayloadKind::Shader
    } else if version >= 4 && head == Some(&GRM1_MAGIC[..]) {
        PayloadKind::Mesh
    } else {
        PayloadKind::Texture
    }
}

// ------------------------------------------------------------------------------------- KTX2

/// The 12-byte KTX2 file identifier (KTX 2.0 section 2.1).
pub const KTX2_IDENTIFIER: [u8; 12] = [
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];

/// A decoded `render-stream-texture/ktx2` payload's shape (render-stream-9.md "KTX2 payload").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ktx2Payload {
    pub width: i64,
    pub height: i64,
    pub levels: i64,
    /// The DFD colour model: false = ETC1S (163), true = UASTC (166).
    pub uastc: bool,
    /// 1 = BasisLZ, 2 = Zstandard.
    pub supercompression: u32,
}

/// `decodeKtx2Payload()`: the header, level index and DFD of one 2D image, one face, no layers,
/// vkFormat UNDEFINED, ETC1S + BasisLZ or UASTC LDR 4x4 + Zstandard, linear transfer. Errors are
/// `ktx2-header`; the entry-dependent half is [`check_ktx2_shape`].
pub fn decode_ktx2(bytes: &[u8]) -> Result<Ktx2Payload, Error> {
    let fail = |d: String| Err(err("ktx2-header", d));
    if bytes.get(..12) != Some(&KTX2_IDENTIFIER[..]) {
        return fail("the first 12 bytes are not the KTX2 identifier".into());
    }
    if bytes.len() < 80 {
        return fail("the file ends inside the header or index".into());
    }
    let u32_at = |o: usize| le_u32(bytes, o) as u64;
    let u64_at = |o: usize| u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    let (vk, type_size, width, height) = (u32_at(12), u32_at(16), u32_at(20), u32_at(24));
    let (depth, layers, faces, levels, sc) =
        (u32_at(28), u32_at(32), u32_at(36), u32_at(40), u32_at(44));
    if vk != 0 {
        return fail(format!("vkFormat is {vk}, not 0 (UNDEFINED)"));
    }
    if type_size != 1 {
        return fail(format!("typeSize is {type_size}, not 1"));
    }
    if width < 1 || height < 1 {
        return fail("pixelWidth or pixelHeight is 0".into());
    }
    if depth != 0 {
        return fail(format!("pixelDepth is {depth}, not 0 (a 2D image)"));
    }
    if layers != 0 {
        return fail(format!("layerCount is {layers}, not 0 (not an array)"));
    }
    if faces != 1 {
        return fail(format!("faceCount is {faces}, not 1 (not a cube)"));
    }
    if !(1..=32).contains(&levels) {
        return fail(format!("levelCount is {levels}, not 1..32"));
    }
    if sc != 1 && sc != 2 {
        return fail(format!(
            "supercompressionScheme is {sc}, not 1 (BasisLZ) or 2 (Zstandard)"
        ));
    }
    let len = bytes.len() as u64;
    let level_index_end = 80 + 24 * levels;
    if level_index_end > len {
        return fail("the level index runs past the end of the file".into());
    }
    let (dfd_off, dfd_len, kvd_off, kvd_len) = (u32_at(48), u32_at(52), u32_at(56), u32_at(60));
    let (sgd_off, sgd_len) = (u64_at(64), u64_at(72));
    if dfd_off < level_index_end || dfd_off + dfd_len > len {
        return fail("the data format descriptor lies outside the file".into());
    }
    if kvd_len != 0 && kvd_off + kvd_len > len {
        return fail("the key/value data lies outside the file".into());
    }
    if sc == 1 {
        if sgd_len < 1 || sgd_off.saturating_add(sgd_len) > len {
            return fail("BasisLZ needs global data inside the file".into());
        }
    } else if sgd_len != 0 {
        return fail("Zstandard supercompression has no global data".into());
    }
    let d = dfd_off as usize;
    if dfd_len < 28 || u32_at(d) != dfd_len {
        return fail("the DFD total size disagrees with dfdByteLength".into());
    }
    let (word0, word1) = (u32_at(d + 4), u32_at(d + 8));
    if word0 != 0 {
        return fail("the DFD descriptor is not a Khronos basic block".into());
    }
    if word1 & 0xffff != 2 {
        return fail("the DFD version number is not 2 (KDF 1.3)".into());
    }
    if word1 >> 16 != dfd_len - 4 {
        return fail("the DFD descriptor block size disagrees with its length".into());
    }
    let (model, transfer) = (bytes[d + 12], bytes[d + 14]);
    if model != 163 && model != 166 {
        return fail(format!(
            "the DFD colour model is {model}, not ETC1S (163) or UASTC (166)"
        ));
    }
    if transfer != 1 {
        return fail(format!("the DFD transfer function is {transfer}, not 1 (linear)"));
    }
    if bytes[d + 16..d + 20] != [3, 3, 0, 0] {
        return fail("the DFD texel block is not 4x4x1".into());
    }
    if (model == 163) != (sc == 1) {
        return fail("the colour model and the supercompression scheme disagree (ETC1S is BasisLZ, UASTC is Zstandard)".into());
    }
    for l in 0..levels {
        let at = 80 + 24 * l as usize;
        let (offset, length, uncompressed) = (u64_at(at), u64_at(at + 8), u64_at(at + 16));
        if length < 1 || offset.saturating_add(length) > len {
            return fail(format!("level {l} lies outside the file"));
        }
        if sc == 2 {
            let w = (width >> l).max(1);
            let h = (height >> l).max(1);
            let expected = w.div_ceil(4) * h.div_ceil(4) * 16;
            if uncompressed != expected {
                return fail(format!(
                    "level {l} uncompressedByteLength is {uncompressed}, expected {expected}"
                ));
            }
        }
    }
    Ok(Ktx2Payload {
        width: width as i64,
        height: height as i64,
        levels: levels as i64,
        uastc: model == 166,
        supercompression: sc as u32,
    })
}

/// The entry-dependent half of the KTX2 rules (`ktx2-shape`): the file's codec is the variant's
/// encoding, its pixel size is the entry's, and its level count is the entry's mip chain.
pub fn check_ktx2_shape(
    k: &Ktx2Payload,
    encoding: &str,
    width: i64,
    height: i64,
    mipmaps: bool,
) -> Result<(), Error> {
    let model = if k.uastc { "uastc" } else { "etc1s" };
    if model != encoding {
        return Err(err(
            "ktx2-shape",
            format!("the file is {model}, the variant's encoding is {encoding}"),
        ));
    }
    if k.width != width || k.height != height {
        return Err(err(
            "ktx2-shape",
            format!(
                "the file is {}x{}, the entry is {width}x{height}",
                k.width, k.height
            ),
        ));
    }
    let levels = if mipmaps { mip_levels(width, height) } else { 1 };
    if k.levels != levels {
        return Err(err(
            "ktx2-shape",
            format!(
                "the file has {} levels, the entry's mip chain has {levels}",
                k.levels
            ),
        ));
    }
    Ok(())
}

fn mip_levels(width: i64, height: i64) -> i64 {
    let (mut w, mut h, mut n) = (width, height, 1);
    while w > 1 || h > 1 {
        w = (w / 2).max(1);
        h = (h / 2).max(1);
        n += 1;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_sizes_follow_godots_dst_image_size() {
        // Godot's _get_dst_image_size, by hand: the same values the TypeScript self-test pins.
        assert_eq!(block_data_bytes("DXT1", 4, 4, false), Some(8));
        assert_eq!(block_data_bytes("DXT5", 16, 16, true), Some(368));
        assert_eq!(block_data_bytes("ASTC_8x8", 16, 16, true), Some(128));
        assert_eq!(block_data_bytes("ETC2_RGB8", 5, 5, false), Some(32));
        assert_eq!(block_data_bytes("RGTC_R", 1, 1, true), Some(8));
        assert_eq!(block_data_bytes("RGBA8", 4, 4, false), None);
        // Block formats are sized from /9 only.
        assert_eq!(expected_data_bytes_v("DXT5", 4, 4, false, 8), None);
        assert_eq!(expected_data_bytes_v("DXT5", 4, 4, false, 9), Some(16));
    }

    #[test]
    fn a_ktx2_header_is_checked_field_by_field() {
        // The committed UASTC + Zstandard file Godot's editor binary wrote (golden-9 generator).
        let good = include_bytes!("../../protocol/golden-9/payloads/ktx2-16x16-mips.ktx2");
        let k = decode_ktx2(good).unwrap();
        assert_eq!((k.width, k.height, k.levels, k.uastc), (16, 16, 5, true));
        assert!(check_ktx2_shape(&k, "uastc", 16, 16, true).is_ok());
        assert_eq!(check_ktx2_shape(&k, "etc1s", 16, 16, true).unwrap_err().code, "ktx2-shape");
        assert_eq!(check_ktx2_shape(&k, "uastc", 16, 16, false).unwrap_err().code, "ktx2-shape");
        assert_eq!(check_ktx2_shape(&k, "uastc", 8, 8, true).unwrap_err().code, "ktx2-shape");
        let mut bad = good.to_vec();
        bad[12] = 37; // vkFormat
        assert_eq!(decode_ktx2(&bad).unwrap_err().code, "ktx2-header");
        assert_eq!(decode_ktx2(&good[..60]).unwrap_err().code, "ktx2-header");
        let mut srgb = good.to_vec();
        let dfd = u32::from_le_bytes(srgb[48..52].try_into().unwrap()) as usize;
        srgb[dfd + 14] = 2; // transfer: sRGB
        assert_eq!(decode_ktx2(&srgb).unwrap_err().code, "ktx2-header");
        assert_eq!(payload_kind(good, 9), PayloadKind::Ktx2);
        assert_eq!(payload_kind(good, 8), PayloadKind::Texture);
    }
}
