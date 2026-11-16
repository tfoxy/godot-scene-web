//! A live client keeps streaming through payloads it cannot get: deferred shader code (still
//! loading, or unavailable) omits what its materials draw (never shaderless) while independent
//! descendants keep drawing, and compiles before the apply that draws it once it arrives; a
//! deferred hash the newest state no longer names leaves the set; a resident texture a context
//! restore cannot fetch again leaves residency and what draws it is re-lowered.

use super::override_tests::{
    applier, base, full_delta, full_delta_tex, tex_scene, C1, C2, G, P, Q,
};
use super::programs::{ProgramEntry, ProgramInfo};
use super::*;
use crate::state::*;

const MAT: Id = 40;
const SHADER: Id = 41;
const CODE: Hash = Hash([0x51; 32]);

fn shader(uses: Vec<ShaderUse>) -> Shader {
    Shader {
        id: SHADER,
        origin: Origin::Created,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        mode: Some(ShaderMode::CanvasItem),
        source: Some(ShaderSource::Payload),
        hash: Some(CODE),
        payload_bytes: 64,
        builtin: None,
        process: None,
        uses,
        default_textures: Vec::new(),
    }
}

/// The base scene with P drawing a rect under a custom-shader material: C1 inherits it
/// (`use_parent_material`), C2 has none of its own and does not inherit, G and Q have none.
fn material_scene(uses: Vec<ShaderUse>) -> ResolvedState {
    let mut s = base();
    s.shaders.insert(SHADER, shader(uses));
    s.materials.insert(
        MAT,
        Material {
            id: MAT,
            origin: Origin::Created,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            shader: Some(SHADER),
            params: Vec::new(),
        },
    );
    let rect = s.items[&C1].commands.clone();
    let p = s.items.get_mut(&P).unwrap();
    p.material = Some(MAT);
    p.commands = rect;
    s.items.get_mut(&C1).unwrap().use_parent_material = true;
    s
}

fn material_delta(s: &ResolvedState) -> TxDelta {
    TxDelta {
        shaders_upserted: vec![SHADER],
        materials_upserted: vec![MAT],
        ..full_delta(s)
    }
}

fn ready() -> ProgramEntry {
    ProgramEntry::Ready(ProgramInfo {
        program: 1,
        blend: BlendMode::Mix,
        light: LightMode::Normal,
        uniforms: Vec::new(),
        samplers: Vec::new(),
        screen: None,
        vertex: false,
        time: false,
    })
}

/// Items the last walk emitted draws for.
fn drawn(a: &Applier) -> Vec<Id> {
    let mut ids: Vec<Id> = a
        .attach
        .iter()
        .filter(|x| x.would_emit)
        .map(|x| x.item)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn code_store() -> PayloadStore {
    let mut store = PayloadStore::default();
    store.shaders.insert(
        CODE,
        "shader_type canvas_item;\nvoid fragment() {}\n".into(),
    );
    store
}

#[test]
fn a_deferred_shader_omits_its_material_users_but_not_independent_descendants() {
    let s = material_scene(Vec::new());
    let d = material_delta(&s);
    let empty = PayloadStore::default();
    let mut a = applier();
    a.prepare(&s, &d);
    let mut needed = Vec::new();
    a.needed(&s, &d, &empty, &mut needed);
    assert_eq!(needed, vec![CODE], "the shader code is the needed set");
    assert_eq!(
        a.pending_shaders_held(&s, &empty).len(),
        1,
        "pending before the defer"
    );
    a.defer(CODE);
    assert!(
        a.pending_shaders_held(&s, &empty).is_empty(),
        "deferred code not held is not pending (no program can be defined)"
    );
    a.apply(&s, &d, &empty);
    let ids = drawn(&a);
    assert!(
        !ids.contains(&P),
        "the material's owner drew without its shader"
    );
    assert!(
        !ids.contains(&C1),
        "the inheriting child drew without its shader"
    );
    for keep in [G, C2, Q] {
        assert!(
            ids.contains(&keep),
            "independent item {keep} was not drawn: {ids:?}"
        );
    }
    assert!(
        a.shortcut_totals.contains_key("shader-unavailable-skipped"),
        "the omission is typed"
    );
    // A revisit with nothing arrived does nothing.
    assert!(!a.revisit(&s, &empty));
    // The code arrives (the client took it into the store): it is pending again, compiles before
    // the revisit, and one walk draws its users with the program.
    let store = code_store();
    let pending = a.pending_shaders_held(&s, &store);
    assert_eq!(pending.len(), 1, "arrived code is pending again");
    a.set_program(CODE, ready());
    assert!(a.revisit(&s, &store), "the arrival was not revisited");
    assert!(
        a.stats.why & Why::MATERIAL != 0,
        "the program did not re-walk the materials"
    );
    let ids = drawn(&a);
    for keep in [G, P, C1, C2, Q] {
        assert!(
            ids.contains(&keep),
            "item {keep} not drawn after the arrival: {ids:?}"
        );
    }
    assert_eq!(a.deferred_len(), 0);
    assert!(
        a.list.draws.iter().any(|d| d.program != BUILTIN_PROGRAM),
        "the owner draws with its program"
    );
}

#[test]
fn a_refused_program_still_draws_shaderless_unlike_an_unavailable_one() {
    // Compile refusal keeps its established semantics: the native receiver's shaderless material.
    let s = material_scene(Vec::new());
    let d = material_delta(&s);
    let store = code_store();
    let mut a = applier();
    a.prepare(&s, &d);
    a.set_program(
        CODE,
        ProgramEntry::Refused {
            reason: "gsw-shader-transpile",
            detail: "unsupported".into(),
        },
    );
    a.apply(&s, &d, &store);
    let ids = drawn(&a);
    assert!(
        ids.contains(&P) && ids.contains(&C1),
        "a refused program omitted its users"
    );
}

#[test]
fn a_deferred_screen_reading_shader_omits_its_own_draw() {
    let s = material_scene(vec![ShaderUse::ScreenTexture]);
    let d = material_delta(&s);
    let empty = PayloadStore::default();
    let mut a = applier();
    a.prepare(&s, &d);
    a.defer(CODE);
    a.apply(&s, &d, &empty);
    let ids = drawn(&a);
    assert!(!ids.contains(&P) && !ids.contains(&C1));
    assert!(ids.contains(&C2) && ids.contains(&Q));
}

#[test]
fn a_replacement_shader_draws_while_the_old_one_is_unavailable() {
    // The material moves to a shader whose code is held: the deferred one no longer decides.
    let mut s = material_scene(Vec::new());
    let d = material_delta(&s);
    let empty = PayloadStore::default();
    let mut a = applier();
    a.prepare(&s, &d);
    a.defer(CODE);
    a.apply(&s, &d, &empty);
    assert!(!drawn(&a).contains(&P));
    let other = Hash([0x52; 32]);
    let mut sh = shader(Vec::new());
    sh.id = SHADER + 1;
    sh.hash = Some(other);
    s.shaders.insert(SHADER + 1, sh);
    s.materials.get_mut(&MAT).unwrap().shader = Some(SHADER + 1);
    s.materials.get_mut(&MAT).unwrap().version = 2;
    s.seq += 1;
    let d2 = TxDelta {
        seq: s.seq,
        shaders_upserted: vec![SHADER + 1],
        materials_upserted: vec![MAT],
        ..TxDelta::default()
    };
    a.prepare(&s, &d2);
    a.set_program(other, ready());
    // The newest state names the old code no longer: it leaves the deferred set.
    assert_eq!(a.prune_deferred(|h| *h != CODE), 1);
    a.apply(&s, &d2, &empty);
    let ids = drawn(&a);
    assert!(
        ids.contains(&P) && ids.contains(&C1),
        "the replacement did not draw: {ids:?}"
    );
}

#[test]
fn prune_deferred_keeps_only_named_hashes() {
    let mut a = applier();
    a.defer(Hash([1; 32]));
    a.defer(Hash([2; 32]));
    assert_eq!(a.prune_deferred(|h| *h == Hash([2; 32])), 1);
    assert_eq!(
        a.deferred_hashes().copied().collect::<Vec<_>>(),
        vec![Hash([2; 32])]
    );
    assert_eq!(a.prune_deferred(|_| false), 1);
    assert_eq!(a.deferred_len(), 0);
}

/// `tex_scene` with C2 drawing texture 5 too (one payload, two users).
fn shared_tex_scene() -> (ResolvedState, PayloadStore, Hash) {
    let (mut s, store, h) = tex_scene();
    let cmds = s.items[&C1].commands.clone();
    s.items.get_mut(&C2).unwrap().commands = cmds;
    (s, store, h)
}

#[test]
fn a_restore_that_cannot_refetch_a_shared_texture_takes_it_out_of_residency() {
    let (s, full, h) = shared_tex_scene();
    let d = full_delta_tex(&s);
    let mut a = applier();
    a.prepare(&s, &d);
    a.apply(&s, &d, &full);
    let all = drawn(&a);
    assert!(all.contains(&C1) && all.contains(&C2));
    // The context was lost and the store evicted the payload meanwhile.
    let lost = PayloadStore::default();
    assert_eq!(a.restore_missing(&lost), vec![h]);
    assert_eq!(a.restore_unavailable(h), 1, "texture 5 leaves residency");
    assert!(
        !a.referenced_payload_hashes().contains(&h),
        "still resident"
    );
    assert!(
        a.restore_missing(&lost).is_empty(),
        "nothing left to refetch"
    );
    // No transaction prepared: a revisit re-lowers both users through the dependency path.
    assert!(a.revisit(&s, &lost), "the restore did not revisit");
    let ids = drawn(&a);
    assert!(
        !ids.contains(&C1) && !ids.contains(&C2),
        "a user drew stale contents: {ids:?}"
    );
    assert!(
        ids.contains(&G) && ids.contains(&Q),
        "the rest stopped drawing"
    );
    assert!(
        !a.revisit(&s, &lost),
        "a second revisit had something to do"
    );
    // The payload comes back (the entry is named again and fetched): both draw again.
    assert!(a.revisit(&s, &full));
    let ids = drawn(&a);
    assert!(ids.contains(&C1) && ids.contains(&C2));
    assert_eq!(a.deferred_len(), 0);
}

#[test]
fn a_restore_mark_with_a_transaction_prepared_waits_for_its_apply() {
    let (mut s, full, h) = shared_tex_scene();
    let d = full_delta_tex(&s);
    let mut a = applier();
    a.prepare(&s, &d);
    a.apply(&s, &d, &full);
    let lost = PayloadStore::default();
    // A transaction arrived while the context was lost (a move of Q).
    s.seq += 1;
    s.items.get_mut(&Q).unwrap().xform[4] += 5.0;
    let d2 = TxDelta {
        seq: s.seq,
        items_upserted: vec![Q],
        ..TxDelta::default()
    };
    a.prepare(&s, &d2);
    assert_eq!(a.restore_unavailable(h), 1);
    assert!(
        !a.revisit(&s, &lost),
        "an empty apply ran over the prepared transaction"
    );
    a.apply(&s, &d2, &lost);
    let ids = drawn(&a);
    assert!(
        !ids.contains(&C1) && !ids.contains(&C2),
        "a user drew stale contents: {ids:?}"
    );
    assert!(ids.contains(&Q));
}
