//! Mesh residency with the native receiver's semantics (`rs_applier.gd` `_apply_meshes`, gate5-design.md
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

#[derive(Clone, Debug)]
struct Resident {
    /// The wire hash per surface as last seen (`MeshState.hashes`).
    hashes: Vec<Hash>,
    layouts: Vec<super::payloads::MeshLayout>,
    custom_aabb: [u32; 6],
    /// The geometry each built surface draws, by surface index (absent: dropped by the sabotage).
    drawn: Vec<Option<Hash>>,
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
}

impl MeshResidency {
    /// G7l: how many meshes are resident.
    pub fn resident_count(&self) -> usize {
        self.resident.len()
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
        let mut gone: Vec<Id> = self
            .resident
            .keys()
            .filter(|id| {
                state
                    .meshes
                    .get(id)
                    .is_none_or(|m| m.status == EntryStatus::Freed)
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
                .filter_map(|s| payloads.meshes.get(&s.hash).map(|g| (s.hash, g)))
                .collect();
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
                    drawn.push(Some(*h));
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
                    r.drawn[k] = Some(*h);
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
        for h in r.drawn.iter().flatten() {
            out.push(payloads.meshes.get(h)?);
        }
        Some((out, r.custom_aabb.map(f32::from_bits)))
    }

    /// Whether the mesh is resident.
    pub fn is_resident(&self, id: Id) -> bool {
        self.resident.contains_key(&id)
    }
}
