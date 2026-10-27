//! Mesh residency with the native receiver's semantics (the former GDScript applier, `rs_applier.gd`, removed in G7gd; `_apply_meshes`, gate5-design.md
//! Q5 step 3b, G5e), so `mesh-upload-parity` can hold the GSW receiver to the native census (G7t).
//!
//! A mesh becomes resident when an `add_mesh` first names it (create: every surface added). After
//! that, a mesh whose surfaces' layouts (`_layout_key`) change is rebuilt, and one whose layouts
//! hold has each changed surface updated in place, buffer by buffer. A resident mesh leaves when its
//! entry leaves the table or becomes a tombstone. Every step is an `uploads` row as natively
//! (`{id, op, surfaces, buffers, bytes}`); the lowering draws the *resident* surfaces, so the native
//! sabotages `drop-mesh-surface` and `stale-mesh` change pixels exactly as they do natively.

use super::payloads::{MeshGeometry, PayloadStore};
use crate::state::{EntryStatus, Hash, Id, ResolvedState};
use std::collections::BTreeSet;

/// The native mesh sabotages (`receiver.gd`: `drop-mesh-surface`, `stale-mesh`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MeshSabotage {
    /// A build or rebuild never adds the surface at index 1, and its in-place updates are dropped.
    pub drop_surface: bool,
    /// In-place payload changes of a resident surface are ignored; layout changes still rebuild.
    pub stale: bool,
}

/// One `mesh_uploads` row.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshUpload {
    pub id: Id,
    pub op: &'static str,
    pub surfaces: Vec<u32>,
    pub buffers: Vec<&'static str>,
    pub bytes: u64,
}

/// Where a built surface's geometry lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Src {
    /// A static surface: the [`PayloadStore`] entry of this hash.
    Hash(Hash),
    /// W11c: a /11 dynamic surface: [`PayloadStore::dynamic`]'s body of the mesh's surface `k`.
    Dyn(u32),
}

#[derive(Clone, Debug)]
struct Resident {
    /// The wire hash per surface as last seen (`MeshState.hashes`); empty for a dynamic mesh.
    hashes: Vec<Hash>,
    layouts: Vec<super::payloads::MeshLayout>,
    custom_aabb: [u32; 6],
    /// The geometry each built surface draws, by surface index (absent: dropped by the sabotage).
    drawn: Vec<Option<Src>>,
    /// W11c: a dynamic mesh's surfaces' body serials as last built or updated
    /// ([`super::dynamic::DynMesh::serials`]); empty for a static mesh.
    serials: Vec<u64>,
    /// W11c: a dynamic mesh's index bytes per surface as built (an index change rebuilds).
    index_bytes: Vec<Vec<u8>>,
}

const BUFFERS: [&str; 4] = ["vertex", "attribute", "skin", "index"];

/// The resident meshes and the items that name them.
#[derive(Default)]
pub struct MeshResidency {
    resident: super::IdMap<Resident>,
    /// Mesh ids each item's commands name (`_named_mesh_ids`, kept per item).
    named_by: super::IdMap<Vec<Id>>,
    pub sabotage: MeshSabotage,
    /// This transaction's rows.
    pub uploads: Vec<MeshUpload>,
    /// Meshes whose drawn geometry changed this transaction (items naming them re-lower).
    pub changed: Vec<Id>,
    /// /11: the named dynamic meshes this transaction left undrawn because a surface's body was
    /// never ingested into [`PayloadStore::dynamic`] (an adapter that does not call
    /// [`super::dynamic::DynamicMeshes::ingest`]); 0 on a W11c adapter.
    pub dynamic_undrawn: u64,
    /// W11c: the named dynamic meshes resident after this transaction.
    pub dynamic_resident: u64,
}

impl MeshResidency {
    /// G7l: how many meshes are resident.
    pub fn resident_count(&self) -> usize {
        self.resident.len()
    }

    /// G7k: every surface hash the resident meshes currently draw from (a dropped surface, G7t's
    /// `drop-mesh-surface` sabotage, contributes none). A [`PayloadStore`] budget must never evict
    /// one of these.
    pub fn resident_hashes(&self) -> impl Iterator<Item = Hash> + '_ {
        self.resident
            .values()
            .flat_map(|r| r.drawn.iter().flatten())
            .filter_map(|s| match s {
                Src::Hash(h) => Some(*h),
                Src::Dyn(_) => None,
            })
    }

    fn named(&self) -> BTreeSet<Id> {
        self.named_by.values().flatten().copied().collect()
    }

    /// Bring residency in line with the mesh table, after the transaction's item changes. `items`
    /// are the items upserted (all of them on a fresh applier), `removed` those that left.
    pub fn sync(
        &mut self,
        state: &ResolvedState,
        items: &[Id],
        removed: &[Id],
        first: bool,
        payloads: &PayloadStore,
    ) {
        self.uploads.clear();
        self.changed.clear();
        self.dynamic_undrawn = 0;
        self.dynamic_resident = 0;
        if first {
            self.named_by.clear();
        }
        for id in removed {
            self.named_by.remove(id);
        }
        for id in items {
            let Some(it) = state.items.get(id) else {
                continue;
            };
            let mut meshes: Vec<Id> = it
                .commands
                .list
                .iter()
                .filter_map(|c| match c {
                    crate::state::Command::Mesh { mesh, .. } => Some(*mesh),
                    _ => None,
                })
                .collect();
            meshes.sort_unstable();
            meshes.dedup();
            if meshes.is_empty() {
                self.named_by.remove(id);
            } else {
                self.named_by.insert(*id, meshes);
            }
        }
        // Frees first, ascending: an entry that left the table or became a tombstone.
        let mut gone: Vec<Id> =
            self.resident
                .keys()
                .filter(|id| {
                    // W11c: a mesh also leaves when it turns dynamic (its static build goes) or
                    // stops being dynamic (emptied, or no longer `ok`).
                    let was_dynamic = !self.resident[*id].serials.is_empty();
                    state.meshes.get(id).is_none_or(|m| {
                        m.status == EntryStatus::Freed || m.is_dynamic() != was_dynamic
                    })
                })
                .copied()
                .collect();
        gone.sort_unstable();
        for id in gone {
            self.resident.remove(&id);
            self.changed.push(id);
            self.uploads.push(MeshUpload {
                id,
                op: "free",
                surfaces: vec![],
                buffers: vec![],
                bytes: 0,
            });
        }
        // Then every named `ok` mesh, ascending. Only a mesh whose entry or naming changed can
        // produce a row; the others are skipped by comparing hashes, as natively.
        for id in self.named() {
            let Some(entry) = state.meshes.get(&id) else {
                continue;
            };
            if entry.status != EntryStatus::Ok {
                continue;
            }
            let surfaces: Vec<(Hash, &MeshGeometry)> = entry
                .surfaces
                .iter()
                .filter_map(|s| {
                    let h = s.hash?;
                    payloads.meshes.get(&h).map(|g| (h, g))
                })
                .collect();
            if entry.is_dynamic() {
                // W11c: a dynamic mesh's geometry is keyed by mesh id (its bodies travel in the
                // transactions' `mesh_u8`), replaced in place by the adapter's ingest.
                self.sync_dynamic(id, entry, payloads);
                continue;
            }
            if surfaces.len() != entry.surfaces.len() {
                // A payload is missing (the adapter blocks apply until it is provided).
                continue;
            }
            let hashes: Vec<Hash> = surfaces.iter().map(|(h, _)| *h).collect();
            let layouts: Vec<_> = surfaces.iter().map(|(_, g)| g.layout.clone()).collect();
            let custom_aabb = entry.custom_aabb.map(f32::to_bits);
            let fresh = !self.resident.contains_key(&id);
            if fresh || self.resident[&id].layouts != layouts {
                let mut added = Vec::new();
                let mut drawn = Vec::with_capacity(hashes.len());
                let mut bytes = 0u64;
                for (k, (h, g)) in surfaces.iter().enumerate() {
                    if self.sabotage.drop_surface && k == 1 {
                        drawn.push(None);
                        continue;
                    }
                    added.push(k as u32);
                    drawn.push(Some(Src::Hash(*h)));
                    bytes += g.data_bytes();
                }
                let old_aabb = self.resident.get(&id).map(|r| r.custom_aabb);
                self.uploads.push(MeshUpload {
                    id,
                    op: if fresh { "create" } else { "rebuild" },
                    surfaces: added,
                    buffers: vec![],
                    bytes,
                });
                // A new mesh gets its custom AABB in its create row; a rebuild keeps the old one
                // (GLES3's mesh_clear does not reset it) and sets it only when it changed.
                if !fresh && old_aabb != Some(custom_aabb) {
                    self.uploads.push(MeshUpload {
                        id,
                        op: "custom_aabb",
                        surfaces: vec![],
                        buffers: vec![],
                        bytes: 0,
                    });
                }
                self.resident.insert(
                    id,
                    Resident {
                        hashes,
                        layouts,
                        custom_aabb,
                        drawn,
                        serials: Vec::new(),
                        index_bytes: Vec::new(),
                    },
                );
                self.changed.push(id);
                continue;
            }
            let stale = self.sabotage.stale;
            let drop_surface = self.sabotage.drop_surface;
            let r = self.resident.get_mut(&id).unwrap();
            for (k, (h, after)) in surfaces.iter().enumerate() {
                if r.hashes[k] == *h || stale {
                    continue;
                }
                if drop_surface && k == 1 {
                    r.hashes[k] = *h;
                    continue;
                }
                let Some(before) = payloads.meshes.get(&r.hashes[k]) else {
                    r.hashes[k] = *h;
                    continue;
                };
                let mut buffers = Vec::new();
                let mut bytes = 0u64;
                for (b, name) in BUFFERS.iter().enumerate() {
                    if before.buffers[b] != after.buffers[b] {
                        buffers.push(*name);
                        bytes += after.buffers[b].len() as u64;
                    }
                }
                r.hashes[k] = *h;
                if r.drawn[k].is_some() {
                    r.drawn[k] = Some(Src::Hash(*h));
                }
                self.uploads.push(MeshUpload {
                    id,
                    op: "update",
                    surfaces: vec![k as u32],
                    buffers,
                    bytes,
                });
                if !self.changed.contains(&id) {
                    self.changed.push(id);
                }
            }
            if r.custom_aabb != custom_aabb {
                r.custom_aabb = custom_aabb;
                self.uploads.push(MeshUpload {
                    id,
                    op: "custom_aabb",
                    surfaces: vec![],
                    buffers: vec![],
                    bytes: 0,
                });
                if !self.changed.contains(&id) {
                    self.changed.push(id);
                }
            }
        }
    }

    /// The geometry a resident mesh draws (its built surfaces, in surface order), with the
    /// custom AABB it holds; `None` when it is not resident.
    pub fn drawn<'p>(
        &self,
        id: Id,
        payloads: &'p PayloadStore,
    ) -> Option<(Vec<&'p MeshGeometry>, [f32; 6])> {
        let r = self.resident.get(&id)?;
        let mut out = Vec::with_capacity(r.drawn.len());
        for s in r.drawn.iter().flatten() {
            out.push(match s {
                Src::Hash(h) => payloads.meshes.get(h)?,
                Src::Dyn(k) => payloads
                    .dynamic
                    .get(id)?
                    .surfaces
                    .get(*k as usize)?
                    .as_ref()?,
            });
        }
        Some((out, r.custom_aabb.map(f32::from_bits)))
    }

    /// W11c: one named `ok` dynamic mesh. Rows as for a static mesh (render-stream-11.md
    /// "Receivers", W11d's rule): `create` when it becomes resident, `rebuild` when a surface's
    /// shape or index bytes change (`mesh_clear` plus `mesh_add_surface`), else one `update` per
    /// surface whose body moved since it was built, listing the region buffers a native receiver
    /// re-sends (`mesh_surface_update_vertex_region` / `_attribute_region`, plus a skin buffer if
    /// the format has one). `drop_surface` acts as on a static mesh (surface 1 is never built);
    /// `stale` does not apply (the geometry is the store's newest body, replaced in place: the
    /// adapter's own `stale-dynamic-rx` sabotage skips the ingest instead).
    fn sync_dynamic(&mut self, id: Id, entry: &crate::state::Mesh, payloads: &PayloadStore) {
        let n = entry.surfaces.len();
        let Some(dm) = payloads.dynamic.get(id) else {
            self.dynamic_undrawn += 1;
            return;
        };
        let geos: Vec<&MeshGeometry> = dm.surfaces.iter().take(n).flatten().collect();
        if geos.len() != n {
            self.dynamic_undrawn += 1;
            return;
        }
        self.dynamic_resident += 1;
        let custom_aabb = entry.custom_aabb.map(f32::to_bits);
        let layouts: Vec<_> = geos.iter().map(|g| g.layout.clone()).collect();
        let fresh = !self.resident.contains_key(&id);
        let reshaped = !fresh && {
            let r = &self.resident[&id];
            r.layouts.len() != n
                || r.layouts.iter().zip(&geos).any(|(l, g)| {
                    (
                        l.primitive,
                        l.format,
                        l.vertex_count,
                        l.index_count,
                        l.buffer_bytes,
                    ) != (
                        g.layout.primitive,
                        g.layout.format,
                        g.layout.vertex_count,
                        g.layout.index_count,
                        g.layout.buffer_bytes,
                    )
                })
                || r.drawn.iter().enumerate().any(|(k, s)| {
                    // An index change rebuilds (the region uploads carry no indices): compared
                    // against the serial the surface was built from, so only a moved body can.
                    s.is_some()
                        && r.serials[k] != dm.serials[k]
                        && r.layouts[k].index_count > 0
                        && r.index_bytes
                            .get(k)
                            .is_some_and(|b| b != &geos[k].buffers[3])
                })
        };
        if fresh || reshaped {
            let mut added = Vec::new();
            let mut drawn = Vec::with_capacity(n);
            let mut bytes = 0u64;
            for (k, g) in geos.iter().enumerate() {
                if self.sabotage.drop_surface && k == 1 {
                    drawn.push(None);
                    continue;
                }
                added.push(k as u32);
                drawn.push(Some(Src::Dyn(k as u32)));
                bytes += g.data_bytes();
            }
            let old_aabb = self.resident.get(&id).map(|r| r.custom_aabb);
            self.uploads.push(MeshUpload {
                id,
                op: if fresh { "create" } else { "rebuild" },
                surfaces: added,
                buffers: vec![],
                bytes,
            });
            if !fresh && old_aabb != Some(custom_aabb) {
                self.uploads.push(MeshUpload {
                    id,
                    op: "custom_aabb",
                    surfaces: vec![],
                    buffers: vec![],
                    bytes: 0,
                });
            }
            self.resident.insert(
                id,
                Resident {
                    hashes: Vec::new(),
                    layouts,
                    custom_aabb,
                    drawn,
                    serials: dm.serials[..n].to_vec(),
                    index_bytes: geos.iter().map(|g| g.buffers[3].clone()).collect(),
                },
            );
            self.changed.push(id);
            return;
        }
        let r = self.resident.get_mut(&id).unwrap();
        {
            for (k, g) in geos.iter().enumerate() {
                if r.serials[k] == dm.serials[k] {
                    continue;
                }
                r.serials[k] = dm.serials[k];
                if r.drawn[k].is_none() {
                    continue;
                }
                let mut buffers = Vec::new();
                let mut bytes = 0u64;
                for (b, name) in BUFFERS.iter().enumerate().take(3) {
                    if !g.buffers[b].is_empty() {
                        buffers.push(*name);
                        bytes += g.buffers[b].len() as u64;
                    }
                }
                r.layouts[k] = g.layout.clone();
                self.uploads.push(MeshUpload {
                    id,
                    op: "update",
                    surfaces: vec![k as u32],
                    buffers,
                    bytes,
                });
                if !self.changed.contains(&id) {
                    self.changed.push(id);
                }
            }
        }
        if r.custom_aabb != custom_aabb {
            r.custom_aabb = custom_aabb;
            self.uploads.push(MeshUpload {
                id,
                op: "custom_aabb",
                surfaces: vec![],
                buffers: vec![],
                bytes: 0,
            });
            if !self.changed.contains(&id) {
                self.changed.push(id);
            }
        }
    }

    /// Whether the mesh is resident.
    pub fn is_resident(&self, id: Id) -> bool {
        self.resident.contains_key(&id)
    }
}
