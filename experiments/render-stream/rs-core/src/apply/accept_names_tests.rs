//! Ordered needed output against an applier whose name cache is rebuilt for every query.
use super::*;
use crate::state::*;
use super::override_tests::{applier, base, full_delta, C1, C2, tex_scene};

fn shader(id: Id) -> Shader {
    Shader {
        id, origin: Origin::Created, status: EntryStatus::Ok, reason: None,
        version: 1, mode: Some(ShaderMode::CanvasItem), source: Some(ShaderSource::Payload),
        hash: Some(Hash([id as u8; 32])), payload_bytes: 64, builtin: None,
        process: None, uses: Vec::new(), default_textures: Vec::new(),
    }
}

fn compare(a: &mut Applier, s: &ResolvedState, d: &TxDelta, store: &PayloadStore) -> Vec<Hash> {
    let mut want = Vec::new();
    let mut got = Vec::new();
    a.needed(s, d, store, &mut got);
    let materials = a.names.named_materials(s);
    let shaders = a.names.named_shaders(s);
    let cached = std::mem::take(&mut a.names);
    a.names.update(s, d, true);
    a.needed(s, d, store, &mut want);
    assert_eq!(materials, a.names.named_materials(s));
    assert_eq!(shaders, a.names.named_shaders(s));
    a.names = cached;
    assert_eq!(got, want, "seq {}", s.seq);
    got
}

#[test]
fn ordered_needed_survives_updates_arrival_eviction_defer_reset_and_merging() {
    let (mut s, texture_store, texture_hash) = tex_scene();
    for id in [41, 43] {
        s.shaders.insert(id, shader(id));
        s.materials.insert(id - 1, Material {
            id: id - 1, origin: Origin::Created, status: EntryStatus::Ok,
            reason: None, version: 1, shader: Some(id), params: Vec::new(),
        });
    }
    s.items.get_mut(&C1).unwrap().material = Some(42);
    s.items.get_mut(&C2).unwrap().material = Some(40);
    let mut a = applier();
    let mut store = PayloadStore::default();
    let full = full_delta(&s);
    a.prepare(&s, &full);
    assert_eq!(compare(&mut a, &s, &full, &store), vec![Hash([41;32]), Hash([43;32]), texture_hash]);
    a.defer(Hash([41;32]));
    a.apply(&s, &full, &store);
    for seq in 2..=16 {
        let cached_node = a.names.shaders(&s).iter().next().map(|id| id as *const Id as usize);
        s.seq = seq;
        s.frame = seq;
        s.items.get_mut(&C1).unwrap().xform[4] += 1.0;
        let mut d = TxDelta { seq, items_upserted: vec![C1], ..TxDelta::default() };
        match seq {
            3 => { store.textures = texture_store.textures.clone(); store.shaders.insert(Hash([41;32]), "shader_type canvas_item;".into()); }
            4 => { store.shaders.clear(); store.textures.clear(); }
            5 => { s.materials.get_mut(&40).unwrap().shader = Some(43); d.materials_upserted.push(40); }
            6 => { s.shaders.get_mut(&43).unwrap().source = Some(ShaderSource::Withheld); d.shaders_upserted.push(43); }
            7 => { s.items.get_mut(&C1).unwrap().material = None; }
            8 => { s.items.get_mut(&C2).unwrap().material = None; d.items_upserted.push(C2); }
            9 => { s.items.get_mut(&C1).unwrap().material = Some(40); }
            10 => { s.shaders.remove(&43); d.shaders_removed.push(43); }
            11 => { s.shaders.insert(43, shader(43)); d.shaders_upserted.push(43); }
            12 => { s.materials.get_mut(&40).unwrap().status = EntryStatus::Freed; d.materials_upserted.push(40); }
            13 => { s.materials.get_mut(&40).unwrap().status = EntryStatus::Ok; d.materials_upserted.push(40); }
            14 => { s.materials.remove(&40); d.materials_removed.push(40); }
            _ => {}
        }
        a.prepare(&s, &d);
        if seq == 2 {
            assert_eq!(a.names.shaders(&s).iter().next().map(|id| id as *const Id as usize), cached_node,
                "unchanged entries should retain the ordered set allocation");
        }
        compare(&mut a, &s, &d, &store);
        // Two accepted transactions before apply exercise merged preparation.
        if seq % 2 == 0 { a.apply(&s, &d, &store); }
    }
    a = applier();
    a.prepare(&s, &full_delta(&s));
    compare(&mut a, &s, &full_delta(&s), &store);
}

#[test]
fn unrelated_state_queries_cannot_be_carried_into_the_next_preparation() {
    let mut s = base();
    s.shaders.insert(41, shader(41));
    s.materials.insert(40, Material {
        id: 40, origin: Origin::Created, status: EntryStatus::Ok, reason: None,
        version: 1, shader: Some(41), params: Vec::new(),
    });
    s.items.get_mut(&C1).unwrap().material = Some(40);
    let mut a = applier();
    let store = PayloadStore::default();
    a.apply(&s, &full_delta(&s), &store);
    compare(&mut a, &s, &TxDelta::default(), &store);
    let mut other = s.clone();
    other.shaders.get_mut(&41).unwrap().status = EntryStatus::Freed;
    assert!(a.names.named_shaders(&other).is_empty());
    s.seq += 1;
    let d = TxDelta { seq: s.seq, ..TxDelta::default() };
    a.prepare(&s, &d);
    assert_eq!(compare(&mut a, &s, &d, &store), vec![Hash([41;32])]);
}
