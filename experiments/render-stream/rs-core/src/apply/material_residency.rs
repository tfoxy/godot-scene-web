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
//!
//! MRA: the per-transaction cost follows the delta, not the resident set. A resident, still-named
//! material whose entry did not change and whose shader stayed (non-)resident would count nothing
//! in a full walk (its held parameters already equal its entry's), so only these are visited:
//! every named material on `all`; else the newly named ones, the upserted ones, those whose shader
//! became or stopped being resident this transaction, and those with a duplicated parameter name
//! (whose full walk counts sets every time). The stale-name scan is linear. The full walk stays as
//! [`MaterialResidency::full_walk`], the oracle `rs-core-check material-diff` compares against.

use crate::state::{EntryStatus, Hash, Id, Param, ResolvedState, ShaderSource, TxDelta};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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

#[derive(Default, Clone, PartialEq, Debug)]
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
    /// MRA: the named materials of the previous transaction (a newly named one is visited).
    prev_named: BTreeSet<Id>,
    /// MRA: materials whose entry names a parameter twice: the full walk counts sets for them at
    /// every transaction, so they are visited at every transaction.
    dup_names: BTreeSet<Id>,
    /// MRA diagnostics (`rs-core-check material-diff`): visit every named material and compare
    /// names quadratically, the walk before MRA, the oracle the incremental walk is checked
    /// against.
    pub full_walk: bool,
    /// MRA sabotage `mra-skip-changed`: per transaction, the lowest-id resident material the
    /// transaction upserted is dropped from the visit set (the differential must catch it).
    pub skip_changed: bool,
}

/// The names `held` holds that `params` does not name, ascending, and whether `params` names one
/// parameter twice: one hash set over `params`, one pass over `held` only when something is stale
/// (MRA: was a scan of `params` per held name). The caller inserted every one of `params` first,
/// so `held` holds each of their names and is stale exactly when it holds more names than
/// `params` has distinct ones.
fn stale_names(held: &BTreeMap<Box<str>, Param>, params: &[Param]) -> (Vec<Box<str>>, bool) {
    let wanted: HashSet<&str> = params.iter().map(|p| &*p.name).collect();
    let dup = wanted.len() < params.len();
    if held.len() <= wanted.len() {
        return (Vec::new(), dup);
    }
    let stale = held
        .keys()
        .filter(|n| !wanted.contains(&***n))
        .cloned()
        .collect();
    (stale, dup)
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
        if self.full_walk {
            return self.apply_full(
                state,
                delta,
                all,
                named_materials,
                named_shaders,
                skipped,
                stale_param,
            );
        }
        let mut c = MaterialCounts::default();
        // Shaders (`_apply_shaders`): a handful, walked whole. `moved`: the ids that became or
        // stopped being resident, whose materials' bindings may change.
        let mut moved: BTreeSet<Id> = BTreeSet::new();
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
            moved.insert(id);
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
                    moved.insert(id);
                    c.shaders_freed += 1;
                }
                continue;
            }
            let held = self.shaders.entry(id).or_insert_with(|| {
                moved.insert(id);
                c.shaders_created += 1;
                None
            });
            if *held != hash || hash.is_none() {
                *held = hash;
                c.shader_code_sets += 1;
            }
        }
        // Materials (`_apply_materials`). An entry changes only through the transaction's
        // upserts and removals, so only those can leave the table or stop being `ok`.
        let gone: BTreeSet<Id> = if all {
            self.materials.keys().copied().collect()
        } else {
            delta
                .materials_removed
                .iter()
                .chain(&delta.materials_upserted)
                .copied()
                .filter(|id| self.materials.contains_key(id))
                .collect()
        };
        for id in gone {
            let live = state
                .materials
                .get(&id)
                .is_some_and(|m| m.status == EntryStatus::Ok);
            if !live {
                self.materials.remove(&id);
                self.dup_names.remove(&id);
                c.materials_freed += 1;
            }
        }
        let visit: BTreeSet<Id> = if all {
            named_materials.clone()
        } else {
            let mut v: BTreeSet<Id> = named_materials
                .difference(&self.prev_named)
                .copied()
                .collect();
            v.extend(
                delta
                    .materials_upserted
                    .iter()
                    .filter(|id| named_materials.contains(id)),
            );
            v.extend(
                self.dup_names
                    .iter()
                    .filter(|id| named_materials.contains(id)),
            );
            if !moved.is_empty() {
                v.extend(named_materials.iter().filter(|id| {
                    state
                        .materials
                        .get(id)
                        .and_then(|m| m.shader)
                        .is_some_and(|s| moved.contains(&s))
                }));
            }
            if self.skip_changed {
                let drop = delta
                    .materials_upserted
                    .iter()
                    .filter(|id| v.contains(id) && self.materials.contains_key(id))
                    .min()
                    .copied();
                if let Some(id) = drop {
                    v.remove(&id);
                }
            }
            v
        };
        for id in visit {
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
            let (stale, dup) = stale_names(&m.params, &entry.params);
            for n in stale {
                m.params.remove(&n);
                c.param_sets += 1;
            }
            if dup {
                self.dup_names.insert(id);
            } else {
                self.dup_names.remove(&id);
            }
        }
        if self.prev_named != *named_materials {
            self.prev_named = named_materials.clone();
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
            for n in stale_names(held, &it.instance_params).0 {
                held.remove(&n);
                c.instance_param_sets += 1;
            }
            if held.is_empty() {
                self.instance.remove(&id);
            }
        }
        c
    }

    /// MRA (`rs-core-check material-diff`): whether two residencies hold the same shaders,
    /// materials (bindings and parameters) and instance parameters.
    pub fn same_residency(&self, other: &MaterialResidency) -> bool {
        self.shaders == other.shaders
            && self.materials == other.materials
            && self.instance == other.instance
    }

    /// The walk before MRA, kept verbatim as [`MaterialResidency::full_walk`]'s oracle: every
    /// named material's every parameter, and a quadratic stale-name scan.
    #[allow(clippy::too_many_arguments)]
    fn apply_full(
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

#[cfg(test)]
mod tests {
    //! MRA: the incremental walk against its oracle (the full walk before MRA) over random
    //! transactions: shaders and materials created, changed, removed, made unsupported, named and
    //! un-named, withheld and skipped, parameters renamed, dropped and duplicated, and items'
    //! instance parameters likewise; plus `stale-param`. Every transaction's counters and the
    //! residency itself must be identical, and the `mra-skip-changed` sabotage must break that.
    use super::*;
    use crate::state::{Material, Origin, ParamValue, Shader, VariantType};

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
        fn below(&mut self, n: u32) -> u32 {
            self.next() % n
        }
        fn chance(&mut self, pct: u32) -> bool {
            self.below(100) < pct
        }
    }

    fn shader(id: Id, rng: &mut Rng) -> Shader {
        Shader {
            id,
            origin: Origin::Created,
            status: if rng.chance(10) {
                EntryStatus::Unsupported
            } else {
                EntryStatus::Ok
            },
            reason: None,
            version: 1,
            mode: None,
            source: Some(if rng.chance(30) {
                ShaderSource::Withheld
            } else {
                ShaderSource::Payload
            }),
            hash: if rng.chance(10) {
                None
            } else {
                Some(Hash([rng.below(4) as u8; 32]))
            },
            payload_bytes: 0,
            builtin: None,
            process: None,
            uses: Vec::new(),
            default_textures: Vec::new(),
        }
    }

    fn params(rng: &mut Rng, names: u32) -> Vec<Param> {
        let n = rng.below(names + 1);
        let mut out: Vec<Param> = (0..n)
            .map(|_| Param {
                name: format!("p{}", rng.below(names)).into(),
                ty: VariantType::Float,
                value: ParamValue::Scalar(rng.below(3) as f64),
            })
            .collect();
        if !rng.chance(5) {
            // Mostly distinct names, as a host sends them; sometimes a duplicate survives.
            out.sort_by(|a, b| a.name.cmp(&b.name));
            out.dedup_by(|a, b| a.name == b.name);
        }
        out
    }

    fn material(id: Id, rng: &mut Rng) -> Material {
        Material {
            id,
            origin: Origin::Created,
            status: if rng.chance(8) {
                EntryStatus::Unsupported
            } else {
                EntryStatus::Ok
            },
            reason: None,
            version: 1,
            shader: if rng.chance(20) {
                None
            } else {
                Some(rng.below(6))
            },
            params: params(rng, 8),
        }
    }

    /// One random run: returns the first transaction at which the two walks differ.
    fn run(seed: u64, txs: usize, stale_param: bool, skip_changed: bool) -> Option<usize> {
        let mut rng = Rng(seed);
        let mut st = ResolvedState::empty(12);
        let mut inc = MaterialResidency {
            skip_changed,
            ..Default::default()
        };
        let mut full = MaterialResidency {
            full_walk: true,
            ..Default::default()
        };
        let mut named: BTreeSet<Id> = BTreeSet::new();
        let mut instance: HashMap<Id, Vec<Param>> = HashMap::new();
        for tx in 0..txs {
            let mut d = TxDelta::default();
            let all = tx == 0 || rng.chance(2);
            for sid in 0..6 {
                if rng.chance(if tx == 0 { 80 } else { 6 }) {
                    st.shaders.insert(sid, shader(sid, &mut rng));
                    d.shaders_upserted.push(sid);
                } else if rng.chance(3) && st.shaders.remove(&sid).is_some() {
                    d.shaders_removed.push(sid);
                }
            }
            for mid in 0..16 {
                if rng.chance(if tx == 0 { 90 } else { 10 }) {
                    st.materials.insert(mid, material(mid, &mut rng));
                    d.materials_upserted.push(mid);
                } else if rng.chance(3) && st.materials.remove(&mid).is_some() {
                    d.materials_removed.push(mid);
                }
                if rng.chance(8) && !named.remove(&mid) {
                    named.insert(mid);
                }
            }
            for iid in 0..4 {
                if rng.chance(20) {
                    instance.insert(iid, params(&mut rng, 3));
                    d.items_upserted.push(iid);
                } else if rng.chance(5) && instance.remove(&iid).is_some() {
                    d.items_removed.push(iid);
                }
            }
            // Items carry only instance parameters here: build them from a default item.
            st.items = Default::default();
            for (&iid, ps) in &instance {
                let mut it = crate::validate::blank_item();
                it.id = iid;
                it.instance_params = ps.clone();
                st.items.insert(iid, it);
            }
            // What `Names` would hand over: the `ok` named materials and their `ok` shaders.
            let nm: BTreeSet<Id> = named
                .iter()
                .copied()
                .filter(|m| {
                    st.materials
                        .get(m)
                        .is_some_and(|e| e.status == EntryStatus::Ok)
                })
                .collect();
            let ns: BTreeSet<Id> = nm
                .iter()
                .filter_map(|m| st.materials[m].shader)
                .filter(|s| {
                    st.shaders
                        .get(s)
                        .is_some_and(|e| e.status == EntryStatus::Ok)
                })
                .collect();
            let skip_hash = Hash([rng.below(4) as u8; 32]);
            let skipped = |_: Id, h: Hash| h == skip_hash;
            let a = inc.apply(&st, &d, all, &nm, &ns, skipped, stale_param);
            let b = full.apply(&st, &d, all, &nm, &ns, skipped, stale_param);
            if a != b || !inc.same_residency(&full) {
                return Some(tx);
            }
        }
        None
    }

    #[test]
    fn mra_incremental_walk_equals_full_walk() {
        for seed in 0..200 {
            for stale_param in [false, true] {
                assert_eq!(run(seed, 120, stale_param, false), None, "seed {seed}");
            }
        }
    }

    #[test]
    fn mra_skip_changed_sabotage_is_caught() {
        let caught = (0..50)
            .filter(|s| run(*s, 120, false, true).is_some())
            .count();
        assert_eq!(caught, 50, "the sabotage must fail every run");
    }
}
