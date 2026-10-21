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
use std::collections::{HashMap, HashSet, VecDeque};

/// A texture's level 0 as straight RGBA8.
#[derive(Clone, Debug)]
pub struct TexturePixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
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

/// Straight RGBA8 from an uncompressed permitted format's level 0 (render-stream-2.md "Texture
/// payload"): L8 → (l,l,l,1), LA8 → (l,l,l,a), R8 → (r,0,0,1), RG8 → (r,g,0,1), RGB8 → (r,g,b,1).
pub fn texture_rgba8(
    format: &str,
    width: u32,
    height: u32,
    data: &[u8],
) -> Result<TexturePixels, String> {
    let n = width as usize * height as usize;
    let px = match format {
        "L8" | "R8" => 1,
        "LA8" | "RG8" => 2,
        "RGB8" => 3,
        "RGBA8" => 4,
        other => return Err(format!("texture format {other} has no RGBA8 conversion")),
    };
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
        rgba,
        format: format.to_string(),
        mipmaps: false,
        data_len: data.len(),
    })
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
    let (vertex_data, attribute_data, index_data) = (raw.vertex, raw.attribute, raw.index);
    if format & ARRAY_FLAG_COMPRESS_ATTRIBUTES != 0 {
        return Err("compressed attributes".into());
    }
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    if vertex_data.len() < vertex_count * 8 {
        return Err("short vertex buffer".into());
    }
    let positions: Vec<[f32; 2]> = (0..vertex_count)
        .map(|i| [f32_at(vertex_data, 8 * i), f32_at(vertex_data, 8 * i + 4)])
        .collect();
    let has_color = format & ARRAY_FORMAT_COLOR != 0;
    let has_uv = format & ARRAY_FORMAT_TEX_UV != 0;
    let stride = attribute_data.len().checked_div(vertex_count).unwrap_or(0);
    let needed = (if has_color { 4 } else { 0 }) + (if has_uv { 8 } else { 0 });
    if vertex_count > 0 && stride < needed {
        return Err("short attribute buffer".into());
    }
    let colors = has_color.then(|| {
        (0..vertex_count)
            .map(|i| {
                let o = i * stride;
                let c = &attribute_data[o..o + 4];
                [
                    c[0] as f32 / 255.0,
                    c[1] as f32 / 255.0,
                    c[2] as f32 / 255.0,
                    c[3] as f32 / 255.0,
                ]
            })
            .collect()
    });
    let uv_offset = if has_color { 4 } else { 0 };
    let uvs = has_uv.then(|| {
        (0..vertex_count)
            .map(|i| {
                let o = i * stride + uv_offset;
                [f32_at(attribute_data, o), f32_at(attribute_data, o + 4)]
            })
            .collect()
    });
    let indices = if index_count > 0 {
        let wide = vertex_count > 65536;
        let size = if wide { 4 } else { 2 };
        if index_data.len() < index_count * size {
            return Err("short index buffer".into());
        }
        Some(
            (0..index_count)
                .map(|i| {
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
                })
                .collect(),
        )
    } else {
        None
    };
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
        buffers: [
            raw.vertex.to_vec(),
            raw.attribute.to_vec(),
            raw.skin.to_vec(),
            raw.index.to_vec(),
        ],
    })
}

/// Verified, decoded payloads by content hash.
#[derive(Default)]
pub struct PayloadStore {
    pub textures: HashMap<Hash, TexturePixels>,
    pub meshes: HashMap<Hash, MeshGeometry>,
    /// Shader code (GRP1): a payload's, or a `withheld` shader's from the adapter's library. The
    /// adapter transpiles it once per hash ([`super::Applier::pending_shaders`], G7s).
    pub shaders: HashMap<Hash, String>,
    /// G7k (D29 amendment, Q10 soak): touch order for budget eviction, oldest-touched at the
    /// front. `insert` moves a hash to the back; nothing else reorders it (a mere [`Self::has`]
    /// query is not a touch, matching the native receiver's cache, which only re-orders on a
    /// re-provide). A browser adapter with no budget never calls [`Self::evict_unreferenced`], so
    /// this is dead weight (one `VecDeque` push per provide) until it does.
    order: VecDeque<Hash>,
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
        if let Some(pos) = self.order.iter().position(|h| *h == hash) {
            self.order.remove(pos);
        }
        self.order.push_back(hash);
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
    pub fn total_bytes(&self) -> u64 {
        self.textures
            .values()
            .map(|t| t.rgba.len() as u64)
            .sum::<u64>()
            + self.meshes.values().map(|m| m.data_bytes()).sum::<u64>()
            + self.shaders.values().map(|s| s.len() as u64).sum::<u64>()
    }

    /// G7k: decoded bytes of the entries in `hashes` that this store holds (each hash once).
    pub fn bytes_of(&self, hashes: &HashSet<Hash>) -> u64 {
        hashes
            .iter()
            .map(|h| {
                self.textures.get(h).map_or(0, |t| t.rgba.len() as u64)
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
        while self.total_bytes() > budget_bytes && i < self.order.len() {
            let hash = self.order[i];
            if referenced.contains(&hash) {
                i += 1;
                continue;
            }
            self.textures.remove(&hash);
            self.meshes.remove(&hash);
            self.shaders.remove(&hash);
            self.order.remove(i);
            evicted += 1;
            // The entry after the removed one shifted into index `i`: do not advance.
        }
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
    use crate::payload::{decode_mesh, decode_shader, decode_texture, payload_kind, PayloadKind};
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
    let t = prof::start();
    let bad = |e: String| crate::wire::Error::new("resource-payload", e);
    let d = match payload_kind(bytes, version) {
        PayloadKind::Texture => {
            let t = decode_texture(bytes)?;
            let mut px =
                texture_rgba8(&t.format, t.width as u32, t.height as u32, t.data).map_err(bad)?;
            px.mipmaps = t.mipmaps;
            Decoded::Texture(px)
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
    };
    prof::add(prof::PAYLOAD_DECODE, t);
    Ok(d)
}

/// G7o2: payloads verified and decoded when they arrive (a fetch completion, between frames),
/// ahead of the transaction that uses them. Nothing draws from here: [`PayloadStage::take`] hands
/// a staged payload to the store when its transaction is provided, and only a payload whose
/// SHA-256 matched the hash it was staged under ever enters (a mismatch is refused at
/// [`PayloadStage::stage`] and stages nothing). `verified` is false only under the
/// `skip-payload-hash` sabotage, which the `payload-verified-before-use` check counts.
#[derive(Default)]
pub struct PayloadStage {
    staged: HashMap<Hash, Staged>,
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

    pub fn has(&self, hash: &Hash) -> bool {
        self.staged.contains_key(hash)
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
                    for s in &m.surfaces {
                        push(s.hash, out);
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
        assert_eq!(store.textures[&hash].rgba, vec![1, 2, 3, 4, 5, 6, 7, 8]);
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
