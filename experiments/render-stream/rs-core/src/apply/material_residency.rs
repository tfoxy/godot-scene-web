//! Shader and material residency the native receiver's way (G7s), for `applied.json`'s /5
//! counters (`shaders_created`, `shader_code_sets`, `materials_created`, `param_sets`,
//! `instance_param_sets`; gate5_5-design.md Q5): what the former GDScript applier (`rs_applier.gd`, removed in G7gd) creates, sets and frees in
//! `_apply_shaders`, `_apply_materials` and `_apply_item_material`. The GSW applier draws from the
//! resolved state directly, so this is accounting only: it decides no pixel.
//!
//! - Shaders: a resident shader whose entry left the table or is no longer `ok` is freed; every
//!   `ok` shader a named material names is made resident (`shaders_created`) and current: a code
//!   hash it does not hold yet is one `shader_code_sets` (creation included). A `withheld` shader
//!   whose code no library supplied is skipped, and freed if resident.
//! - Materials: freed likewise; every `ok` material an item names is made resident
//!   (`materials_created`) with one `param_sets` per parameter that differs from what it holds and
//!   one per parameter it held that is gone. Under `stale-param` only at creation.
//! - Instance parameters: per upserted item, one `instance_param_sets` per changed or removed one.

use crate::state::{EntryStatus, Hash, Id, Param, ResolvedState, ShaderSource, TxDelta};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MaterialCounts {
    pub shaders_created: u32,
    pub shaders_freed: u32,
    pub shader_code_sets: u32,
    pub materials_created: u32,
    pub materials_freed: u32,
    pub material_shader_sets: u32,
    pub param_sets: u32,
    pub instance_param_sets: u32,
}

#[derive(Default)]
struct ResidentMaterial {
    /// The resident shader it is bound to (`material_set_shader`).
    shader: Option<Id>,
    params: BTreeMap<Box<str>, Param>,
}

#[derive(Default)]
pub struct MaterialResidency {
    /// Resident shader id -> the code hash it holds (None: created, no code set yet).
    shaders: BTreeMap<Id, Option<Hash>>,
    materials: BTreeMap<Id, ResidentMaterial>,
    instance: HashMap<Id, BTreeMap<Box<str>, Param>>,
}

impl MaterialResidency {
    /// G7l: how many shaders and materials are resident.
    pub fn resident_counts(&self) -> (usize, usize) {
        (self.shaders.len(), self.materials.len())
    }

    /// One transaction. `named_materials`/`named_shaders`: the `ok` entries items name (and their
    /// materials name), ascending; `skipped(id, hash)`: a `withheld` shader without library code.
    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        &mut self,
        state: &ResolvedState,
        delta: &TxDelta,
        all: bool,
        named_materials: &BTreeSet<Id>,
        named_shaders: &BTreeSet<Id>,
        skipped: impl Fn(Id, Hash) -> bool,
        stale_param: bool,
    ) -> MaterialCounts {
        let mut c = MaterialCounts::default();
        // Shaders (`_apply_shaders`).
        let gone: Vec<Id> = self
            .shaders
            .keys()
            .filter(|id| {
                state
                    .shaders
                    .get(id)
                    .is_none_or(|s| s.status != EntryStatus::Ok)
            })
            .copied()
            .collect();
        for id in gone {
            self.shaders.remove(&id);
            c.shaders_freed += 1;
        }
        for &id in named_shaders {
            let Some(entry) = state.shaders.get(&id) else {
                continue;
            };
            let hash = entry.hash;
            let current = self
                .shaders
                .get(&id)
                .is_some_and(|h| *h == hash && hash.is_some());
            if current {
                continue;
            }
            if entry.source == Some(ShaderSource::Withheld) && hash.is_some_and(|h| skipped(id, h))
            {
                if self.shaders.remove(&id).is_some() {
                    c.shaders_freed += 1;
                }
                continue;
            }
            let held = self.shaders.entry(id).or_insert_with(|| {
                c.shaders_created += 1;
                None
            });
            if *held != hash || hash.is_none() {
                *held = hash;
                c.shader_code_sets += 1;
            }
        }
        // Materials (`_apply_materials`).
        let gone: Vec<Id> = self
            .materials
            .keys()
            .filter(|id| {
                state
                    .materials
                    .get(id)
                    .is_none_or(|m| m.status != EntryStatus::Ok)
            })
            .copied()
            .collect();
        for id in gone {
            self.materials.remove(&id);
            c.materials_freed += 1;
        }
        for &id in named_materials {
            let Some(entry) = state.materials.get(&id) else {
                continue;
            };
            let is_new = !self.materials.contains_key(&id);
            if is_new {
                c.materials_created += 1;
            }
            let shader = entry.shader.filter(|s| self.shaders.contains_key(s));
            let m = self.materials.entry(id).or_default();
            if m.shader != shader {
                m.shader = shader;
                c.material_shader_sets += 1;
            }
            if stale_param && !is_new {
                continue;
            }
            for p in &entry.params {
                if m.params.get(&p.name) == Some(p) {
                    continue;
                }
                m.params.insert(p.name.clone(), p.clone());
                c.param_sets += 1;
            }
            let stale: Vec<Box<str>> = m
                .params
                .keys()
                .filter(|n| !entry.params.iter().any(|p| &p.name == *n))
                .cloned()
                .collect();
            for n in stale {
                m.params.remove(&n);
                c.param_sets += 1;
            }
        }
        // Instance parameters (`_apply_item_material`), per upserted item.
        for id in &delta.items_removed {
            self.instance.remove(id);
        }
        let ids: Vec<Id> = if all {
            self.instance.retain(|id, _| state.items.contains_key(id));
            state.items.keys().copied().collect()
        } else {
            delta.items_upserted.clone()
        };
        for id in ids {
            let Some(it) = state.items.get(&id) else {
                continue;
            };
            let held = self.instance.entry(id).or_default();
            for p in &it.instance_params {
                if held.get(&p.name) == Some(p) {
                    continue;
                }
                held.insert(p.name.clone(), p.clone());
                c.instance_param_sets += 1;
            }
            let stale: Vec<Box<str>> = held
                .keys()
                .filter(|n| !it.instance_params.iter().any(|p| &p.name == *n))
                .cloned()
                .collect();
            for n in stale {
                held.remove(&n);
                c.instance_param_sets += 1;
            }
            if held.is_empty() {
                self.instance.remove(&id);
            }
        }
        c
    }
}
