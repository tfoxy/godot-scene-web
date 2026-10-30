//! W11c (render-stream-11.md "Receivers"): /11 dynamic mesh geometry, held by mesh id and replaced
//! in place, never by payload hash.
//!
//! A /11 dynamic mesh's surfaces carry no hash; each transaction whose entry has a non-null `u8`
//! carries the surface bodies in its `mesh_u8` block ([`crate::validate::Validator::dynamic_bodies`]
//! locates them in the accepted record). A receiver keeps exactly one decoded body per dynamic
//! surface: the newest. That is what bounds a long session's memory by the state instead of by the
//! number of poses it has seen (the P3-SP growth: one [`super::payloads::PayloadStore`] entry per
//! pose).
//!
//! The adapter calls [`DynamicMeshes::ingest`] right after every accepted transaction, while the
//! record's bytes are still in hand (a live message buffer is reused by the next message), and
//! before it applies. A credit-window-2 fold (two transactions accepted, one apply) needs nothing
//! more: a later transaction's null `u8` keeps the earlier body, and its frees and shape changes are
//! seen by [`DynamicMeshes::retain`], which `ingest` runs.

use super::payloads::{mesh_geometry_reusing, MeshBuffers, MeshGeometry};
use crate::state::{Id, ResolvedState};
use crate::validate::BodyRef;
use crate::wire::Error;

/// The SHA-256 of the body `g` was decoded from (its 40-byte geometry header, then the four raw
/// buffers): equal to the resolved surface's `body_sha256` exactly when `g` holds that body. An
/// adapter's evidence compares the two (`dynamic-applied`).
pub fn body_sha256(g: &MeshGeometry) -> crate::state::Hash {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for bits in g
        .layout
        .aabb_bits
        .iter()
        .chain(g.layout.uv_scale_bits.iter())
    {
        h.update(bits.to_le_bytes());
    }
    for buf in &g.buffers {
        h.update(buf);
    }
    crate::state::Hash(h.finalize().into())
}

/// One dynamic mesh: its newest body per surface, and the serial of the ingest that set it.
#[derive(Clone, Debug, Default)]
pub struct DynMesh {
    pub surfaces: Vec<Option<MeshGeometry>>,
    pub serials: Vec<u64>,
}

/// The newest body of every dynamic mesh surface the newest accepted state holds.
#[derive(Default)]
pub struct DynamicMeshes {
    meshes: super::IdMap<DynMesh>,
    /// Decoded bytes held (the four raw buffers), kept as bodies come and go.
    bytes: u64,
    /// Bumped once per body ingested: a surface's serial says whether its geometry moved since a
    /// consumer last looked (the mesh residency's in-place update rows).
    serial: u64,
    /// Bodies ingested since the session began (evidence).
    pub bodies_total: u64,
    /// Body bytes ingested since the session began (the `mesh_u8` bytes; evidence).
    pub body_bytes_total: u64,
    /// PH2: geometries replaced by newer bodies, whose buffers the next bodies decode into.
    spare: Vec<MeshGeometry>,
}

impl DynamicMeshes {
    pub fn clear(&mut self) {
        self.meshes.clear();
        self.bytes = 0;
        self.serial = 0;
        self.bodies_total = 0;
        self.body_bytes_total = 0;
    }

    /// Dynamic meshes held.
    pub fn len(&self) -> usize {
        self.meshes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.meshes.is_empty()
    }

    /// Dynamic surfaces held (one body each).
    pub fn surfaces(&self) -> usize {
        self.meshes
            .values()
            .map(|m| m.surfaces.iter().flatten().count())
            .sum()
    }

    /// Decoded bytes held.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn get(&self, id: Id) -> Option<&DynMesh> {
        self.meshes.get(&id)
    }

    /// Replace each body `bodies` names (the last accepted transaction's
    /// [`crate::validate::Validator::dynamic_bodies`], ranges of `record`) in place, decoded by the
    /// surface's shape in `state` (the state that transaction resolved to), then drop what `state`
    /// no longer holds as dynamic ([`Self::retain`]). Returns the number of bodies ingested.
    ///
    /// The validator has already checked every body's length against its shape
    /// (`payload-size`), so an error here is a receiver-side conversion refusal (compressed
    /// attributes), typed `resource-payload` as a static surface's would be.
    pub fn ingest(
        &mut self,
        state: &ResolvedState,
        bodies: &[BodyRef],
        record: &[u8],
    ) -> Result<u32, Error> {
        for b in bodies {
            let surface = state
                .meshes
                .get(&b.mesh)
                .and_then(|m| m.surfaces.get(b.surface as usize))
                .ok_or_else(|| {
                    Error::new(
                        "mesh-dynamic",
                        format!(
                            "a body for mesh {} surface {} that the resolved state does not hold",
                            b.mesh, b.surface
                        ),
                    )
                })?;
            let body = record.get(b.start..b.start + b.len).ok_or_else(|| {
                Error::new(
                    "truncated",
                    format!(
                        "mesh {} surface {}: body outside the record",
                        b.mesh, b.surface
                    ),
                )
            })?;
            let raw = crate::payload::decode_mesh_body(
                body,
                surface.primitive,
                surface.format,
                surface.vertex_count,
                surface.index_count,
            )?;
            let g = mesh_geometry_reusing(
                raw.primitive,
                raw.format,
                raw.aabb,
                raw.vertex_count as usize,
                raw.index_count as usize,
                MeshBuffers {
                    vertex: raw.vertex_data,
                    attribute: raw.attribute_data,
                    skin: raw.skin_data,
                    index: raw.index_data,
                    uv_scale: raw.uv_scale,
                },
                self.spare.pop(),
            )
            .map_err(|e| Error::new("resource-payload", e))?;
            self.serial += 1;
            self.bodies_total += 1;
            self.body_bytes_total += b.len as u64;
            let m = self.meshes.entry(b.mesh).or_default();
            let k = b.surface as usize;
            if m.surfaces.len() <= k {
                m.surfaces.resize(k + 1, None);
                m.serials.resize(k + 1, 0);
            }
            self.bytes += g.data_bytes();
            if let Some(old) = m.surfaces[k].replace(g) {
                self.bytes = self.bytes.saturating_sub(old.data_bytes());
                if self.spare.len() < 64 {
                    self.spare.push(old);
                }
            }
            m.serials[k] = self.serial;
        }
        self.retain(state);
        Ok(bodies.len() as u32)
    }

    /// Drop every mesh `state` does not hold as dynamic (freed, gone, or emptied: render-stream-11.md
    /// "As built (W11b)" 2, an empty dynamic mesh is encoded like a static one), and every surface
    /// past the mesh's surface count.
    pub fn retain(&mut self, state: &ResolvedState) {
        let mut freed = 0u64;
        self.meshes.retain(|id, m| {
            let keep = state.meshes.get(id).filter(|e| e.is_dynamic());
            match keep {
                None => {
                    freed += m
                        .surfaces
                        .iter()
                        .flatten()
                        .map(|g| g.data_bytes())
                        .sum::<u64>();
                    false
                }
                Some(e) => {
                    let n = e.surfaces.len();
                    if m.surfaces.len() > n {
                        freed += m.surfaces[n..]
                            .iter()
                            .flatten()
                            .map(|g| g.data_bytes())
                            .sum::<u64>();
                        m.surfaces.truncate(n);
                        m.serials.truncate(n);
                    }
                    true
                }
            }
        });
        self.bytes = self.bytes.saturating_sub(freed);
    }
}
