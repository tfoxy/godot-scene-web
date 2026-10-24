//! Texture residency the way the native receiver keeps it (the former GDScript applier, `rs_applier.gd`, removed in G7gd "Textures", gate2-design.md
//! Q5 step 3, D5's lazy residency), so GSW's upload accounting and needed set are the native ones:
//!
//! - a texture becomes resident only once something *names* it: a command of any item (visible or
//!   not), an item's instance parameter, a named material's `rid` parameter or its shader's default
//!   texture (`_all_texture_ids`);
//! - it stays resident until it leaves the table or becomes a `freed` tombstone, never because
//!   nothing names it any more;
//! - an `ok` image is created, `update`d in place when its format, size and mipmaps are unchanged
//!   (`ImageTexture::update`), else `replace`d; a placeholder or canvas texture is created once
//!   (and an image-to-placeholder change is a replace); `unsupported` entries are left alone.
//!
//! The applier's GPU textures are exactly the resident `ok` images with pixels. Names are tracked
//! incrementally (per item, from the transaction's delta), so a transaction that names nothing new
//! costs nothing here.

use crate::state::{EntryStatus, Hash, Id, ResolvedState, ShaderSource, TextureKind, TxDelta};
use std::collections::BTreeSet;

/// The engine's placeholder texture (drivers/gles3/storage/texture_storage.cpp
/// `texture_2d_placeholder`): 4×4 RGBA8, magenta where `(x + y)` is even, else black.
pub fn placeholder_checker() -> [u8; 64] {
    let mut out = [0u8; 64];
    for (i, px) in out.chunks_exact_mut(4).enumerate() {
        let (x, y) = (i % 4, i / 4);
        px.copy_from_slice(if (x + y) % 2 == 0 {
            &[255, 0, 255, 255]
        } else {
            &[0, 0, 0, 255]
        });
    }
    out
}

/// What the native receiver's `TextureState` remembers of a resident texture.
#[derive(Clone, Debug, PartialEq)]
pub struct Resident {
    pub kind: TextureKind,
    /// `Some` for an image.
    pub hash: Option<Hash>,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub mipmaps: bool,
    /// G8kb (D6): the entry's `version` when this payload was uploaded (or last kept): `keep`
    /// holds a resident payload only while the entry's version is unchanged.
    pub version: i64,
}

/// One `uploads[]` entry of applied.json (`{id, hash, op, data_bytes}`; the adapter adds `stream`
/// and `seq`).
#[derive(Clone, Debug, PartialEq)]
pub struct Upload {
    pub id: Id,
    pub hash: Option<Hash>,
    /// `create`, `update`, `replace`, `placeholder` or `canvas`.
    pub op: &'static str,
    pub data_bytes: u64,
    /// G8kp (texture-delivery-design.md D3): the encoding chosen (`decoded` or `block`), from /9
    /// only; None below /9 and for placeholders and canvas textures.
    pub encoding: Option<&'static str>,
}

/// Per-transaction texture accounting (`transactions[].resources`' texture fields).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextureAccount {
    pub created: u32,
    pub updated: u32,
    pub replaced: u32,
    pub freed: u32,
    pub upload_bytes: u64,
    pub uploads: Vec<Upload>,
}

/// Named-texture bookkeeping: per item, the texture ids its commands and instance parameters name,
/// with a reference count per texture; plus the set the named materials contribute.
#[derive(Default)]
pub struct Names {
    per_item: super::IdMap<Vec<Id>>,
    per_item_material: super::IdMap<Id>,
    refs: super::IdMap<u32>,
    material_refs: super::IdMap<u32>,
    /// Textures the named materials' parameters and their shaders' default textures name.
    from_materials: BTreeSet<Id>,
    /// Ids whose named-ness may have changed since the last [`Names::take_changed`].
    changed: BTreeSet<Id>,
    materials_dirty: bool,
    /// G7o4: bumped by every [`Names::update`]; with the state's identity it keys `named`.
    generation: u64,
    /// G7o4: the last [`Names::named_materials`] and [`Names::named_shaders`] (one transaction
    /// asks for them several times: the adapter's pending shaders, `needed`, the refusals and the
    /// material residency), with the key they were computed for.
    named: std::cell::RefCell<Option<(NamedKey, BTreeSet<Id>, BTreeSet<Id>)>>,
}

/// What the named materials and shaders depend on: the names' generation and the state (its
/// address, sequence number and frame: a new transaction, or another state, misses).
type NamedKey = (u64, usize, i64, i64);

fn item_names(it: &crate::state::Item) -> Vec<Id> {
    let mut out: Vec<Id> = it.commands.list.iter().filter_map(|c| c.tex()).collect();
    for p in &it.instance_params {
        if let crate::state::ParamValue::Tex(t) = p.value {
            out.push(t);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

impl Names {
    pub fn clear(&mut self) {
        let generation = self.generation + 1;
        *self = Names::default();
        self.generation = generation;
    }

    pub fn is_named(&self, id: Id) -> bool {
        self.refs.get(&id).is_some_and(|n| *n > 0) || self.from_materials.contains(&id)
    }

    /// Bring the names in line with `state` after `delta` (`all`: a fresh applier, every item).
    pub fn update(&mut self, state: &ResolvedState, delta: &TxDelta, all: bool) {
        if all {
            self.clear();
        }
        self.generation += 1;
        let touch = |names: &mut Names, id: Id, it: Option<&crate::state::Item>| {
            let new = it.map(item_names).unwrap_or_default();
            let new_mat = it.and_then(|i| i.material);
            let old = names.per_item.remove(&id).unwrap_or_default();
            if old != new {
                for t in &old {
                    let e = names.refs.entry(*t).or_insert(0);
                    *e = e.saturating_sub(1);
                    names.changed.insert(*t);
                }
                for t in &new {
                    *names.refs.entry(*t).or_insert(0) += 1;
                    names.changed.insert(*t);
                }
            }
            if !new.is_empty() {
                names.per_item.insert(id, new);
            }
            let old_mat = names.per_item_material.remove(&id);
            if old_mat != new_mat {
                if let Some(m) = old_mat {
                    let e = names.material_refs.entry(m).or_insert(0);
                    *e = e.saturating_sub(1);
                }
                if let Some(m) = new_mat {
                    *names.material_refs.entry(m).or_insert(0) += 1;
                }
                names.materials_dirty = true;
            }
            if let Some(m) = new_mat {
                names.per_item_material.insert(id, m);
            }
        };
        if all {
            for (id, it) in &state.items {
                touch(self, *id, Some(it));
            }
        } else {
            for id in &delta.items_removed {
                touch(self, *id, None);
            }
            for id in &delta.items_upserted {
                touch(self, *id, state.items.get(id));
            }
        }
        if all
            || self.materials_dirty
            || !delta.materials_upserted.is_empty()
            || !delta.materials_removed.is_empty()
            || !delta.shaders_upserted.is_empty()
            || !delta.shaders_removed.is_empty()
        {
            self.materials_dirty = false;
            let mut set = BTreeSet::new();
            for (mid, n) in &self.material_refs {
                if *n == 0 {
                    continue;
                }
                let Some(m) = state.materials.get(mid) else {
                    continue;
                };
                if m.status != EntryStatus::Ok {
                    continue;
                }
                for p in &m.params {
                    if let crate::state::ParamValue::Tex(t) = p.value {
                        set.insert(t);
                    }
                }
                if let Some(sh) = m.shader.and_then(|s| state.shaders.get(&s)) {
                    if sh.status == EntryStatus::Ok {
                        for d in &sh.default_textures {
                            set.insert(d.tex);
                        }
                    }
                }
            }
            for t in set.symmetric_difference(&self.from_materials) {
                self.changed.insert(*t);
            }
            self.from_materials = set;
        }
    }

    /// The ids whose named-ness may have changed, ascending, and forget them.
    pub fn take_changed(&mut self) -> BTreeSet<Id> {
        std::mem::take(&mut self.changed)
    }

    /// Every named texture id, ascending (`_all_texture_ids`).
    pub fn all(&self) -> BTreeSet<Id> {
        let mut out: BTreeSet<Id> = self
            .refs
            .iter()
            .filter(|(_, n)| **n > 0)
            .map(|(id, _)| *id)
            .collect();
        out.extend(self.from_materials.iter().copied());
        out
    }

    /// The `ok` shaders whose code is a payload, of the named materials (`_named_shader_ids`).
    pub fn named_payload_shaders(&self, state: &ResolvedState) -> BTreeSet<Id> {
        self.named_shaders(state)
            .into_iter()
            .filter(|sid| {
                state
                    .shaders
                    .get(sid)
                    .is_some_and(|s| s.source == Some(ShaderSource::Payload))
            })
            .collect()
    }

    /// The `ok` materials some item names (`_named_material_ids`), ascending.
    pub fn named_materials(&self, state: &ResolvedState) -> BTreeSet<Id> {
        self.named_cached(state).0
    }

    /// The `ok` shaders of the named materials, whatever their code's source (`_named_shader_ids`).
    pub fn named_shaders(&self, state: &ResolvedState) -> BTreeSet<Id> {
        self.named_cached(state).1
    }

    fn named_cached(&self, state: &ResolvedState) -> (BTreeSet<Id>, BTreeSet<Id>) {
        let key = (
            self.generation,
            state as *const ResolvedState as usize,
            state.seq,
            state.frame,
        );
        if let Some((k, m, s)) = self.named.borrow().as_ref() {
            if *k == key {
                return (m.clone(), s.clone());
            }
        }
        let m = self.compute_named_materials(state);
        let s = self.compute_named_shaders(state, &m);
        *self.named.borrow_mut() = Some((key, m.clone(), s.clone()));
        (m, s)
    }

    fn compute_named_materials(&self, state: &ResolvedState) -> BTreeSet<Id> {
        self.material_refs
            .iter()
            .filter(|(mid, n)| {
                **n > 0
                    && state
                        .materials
                        .get(mid)
                        .is_some_and(|m| m.status == EntryStatus::Ok)
            })
            .map(|(mid, _)| *mid)
            .collect()
    }

    fn compute_named_shaders(&self, state: &ResolvedState, named: &BTreeSet<Id>) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        for &mid in named {
            if let Some(sid) = state.materials.get(&mid).and_then(|m| m.shader) {
                if state
                    .shaders
                    .get(&sid)
                    .is_some_and(|s| s.status == EntryStatus::Ok)
                {
                    out.insert(sid);
                }
            }
        }
        out
    }
}

/// The texture ids to look at this transaction (ascending): every named id on a fresh applier;
/// else the ids whose named-ness changed, the upserted entries that are named, and (with the
/// `reupload` sabotage) every named id.
pub fn candidates(
    names: &mut Names,
    state: &ResolvedState,
    delta: &TxDelta,
    all: bool,
    reupload: bool,
) -> BTreeSet<Id> {
    let changed = names.take_changed();
    if all || reupload {
        return names.all();
    }
    let mut out: BTreeSet<Id> = changed.into_iter().filter(|t| names.is_named(*t)).collect();
    for t in &delta.textures_upserted {
        if names.is_named(*t) && state.textures.contains_key(t) {
            out.insert(*t);
        }
    }
    out
}
