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
    })?;
    Some(size as u128 * mip_chain_texels(width, height, mipmaps))
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
}

pub fn payload_kind(bytes: &[u8], version: u8) -> PayloadKind {
    let head = bytes.get(..8);
    if version >= 5 && head == Some(&GRP1_MAGIC[..]) {
        PayloadKind::Shader
    } else if version >= 4 && head == Some(&GRM1_MAGIC[..]) {
        PayloadKind::Mesh
    } else {
        PayloadKind::Texture
    }
}
