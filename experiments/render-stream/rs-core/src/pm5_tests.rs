//! PM5 (render-stream-12.md): the particles table, `particle_emits`, `add_particles`, `pt_f32`
//! and the `particle_process_material` builtin at /12, beyond what golden-12's own vectors cover,
//! and the API PM6 builds on (`ResolvedState::particles`, `Command::Particles`,
//! `TxDelta::particles_upserted`/`particles_removed`, `Validator::particle_emits`). Each rejection
//! mutates one record of golden-12's `patch.rs12` (states 22 to 26 carry particles) and checks the
//! code.

use crate::apply::payloads::PayloadStore;
use crate::apply::{geom, Applier, Viewport};
use crate::meta::{self, Op};
use crate::state::{
    Command, EmissionShape, EntryStatus, ParticleEmit, ParticlesMode, ProcessParam, ShaderMode,
    SubEmitterMode,
};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use serde_json::{json, Value as J};
use std::path::PathBuf;

fn golden(rel: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol").join(rel)).unwrap()
}

fn meta_of(rec: &[u8]) -> J {
    let n = wire::le_u32(rec, 4) as usize;
    serde_json::from_slice(&rec[8..8 + n]).unwrap()
}

fn with_meta(rec: &[u8], meta: &J) -> Vec<u8> {
    let meta = serde_json::to_string(meta).unwrap();
    let n = wire::le_u32(rec, 4) as usize;
    let rest = &rec[8 + n..];
    let mut out = Vec::new();
    out.extend_from_slice(&((4 + meta.len() + rest.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(meta.as_bytes());
    out.extend_from_slice(rest);
    out
}

/// Replays `patch.rs12` up to the transaction before `seq`, then offers `seq`'s record with its
/// meta changed by `edit`; returns the error code (or "accepted").
fn reject_at(seq: i64, edit: impl Fn(&mut J)) -> String {
    let data = golden("golden-12/patch.rs12");
    let records = wire::split_records(&data, 12).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(12)).unwrap();
    for r in records.iter().skip(1) {
        let rec = r.bytes(&data);
        let m = meta_of(rec);
        if m["type"] == "transaction" && m["seq"] == seq {
            let mut m = m;
            edit(&mut m);
            return match v.accept(&with_meta(rec, &m), r.offset) {
                Ok(_) => "accepted".into(),
                Err(e) => e.code.to_string(),
            };
        }
        v.accept(rec, r.offset).unwrap();
    }
    panic!("no seq {seq}");
}

fn pt(m: &mut J, id: u64) -> &mut J {
    m["particles"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"] == id)
        .unwrap()
}

/// Inserts `key: value` into the transaction meta right after `after` (key order is schema).
fn insert_after(m: &mut J, after: &str, key: &str, value: J) {
    let keys: Vec<String> = m.as_object().unwrap().keys().cloned().collect();
    let mut out = serde_json::Map::new();
    for k in keys {
        out.insert(k.clone(), m[&k].clone());
        if k == after {
            out.insert(key.into(), value.clone());
        }
    }
    *m = J::Object(out);
}

/// The identity `Transform3D` (memory order) with `origin`, and `diag` on the basis diagonal.
fn xform(diag: [f32; 3], origin: [f32; 3]) -> [f32; 12] {
    let [a, b, c] = diag;
    let [x, y, z] = origin;
    [a, 0., 0., 0., b, 0., 0., 0., c, x, y, z]
}

#[test]
fn particle_emits_are_the_accepted_transactions_with_floats() {
    let want = [
        ParticleEmit {
            particles: 1,
            restarts: 1,
            flags: 5,
            transform: xform([1., 1., 1.], [8., 4., 0.]),
            velocity: [0., -16., 0.],
            color: [1., 1., 1., 1.],
            custom: [0., 0., 0., 0.],
        },
        ParticleEmit {
            particles: 1,
            restarts: 1,
            flags: 31,
            transform: xform([2., 2., 1.], [-8., 4., 0.]),
            velocity: [0., -32., 0.],
            color: [1., 0.5, 0.25, 1.],
            custom: [0.5, 0., 0., 1.],
        },
    ];
    for f in ["patch", "full", "inline"] {
        let data = golden(&format!("golden-12/{f}.rs12"));
        let records = wire::split_records(&data, 12).unwrap();
        let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(12)).unwrap();
        let mut txs = 0;
        for r in records.iter().skip(1) {
            if v.accept(r.bytes(&data), r.offset).unwrap() != Accepted::Transaction {
                // A resource or end record clears the list.
                assert!(v.particle_emits().is_empty(), "{f}");
                continue;
            }
            txs += 1;
            let seq = v.state().seq;
            if seq == 23 {
                // Patch and full alike: T's own frame's emits, in call order.
                assert_eq!(v.particle_emits(), &want[..], "{f}");
                // Each names a resolved entry whose restarts the emit's does not exceed.
                for e in v.particle_emits() {
                    assert!(e.restarts <= v.state().particles[&e.particles].restarts);
                }
            } else {
                assert!(v.particle_emits().is_empty(), "{f} seq {seq}");
            }
        }
        assert_eq!(txs, 26, "{f}");
    }
}

#[test]
fn the_particles_table_resolves_as_golden_12_says() {
    let data = golden("golden-12/patch.rs12");
    let records = wire::split_records(&data, 12).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(12)).unwrap();
    for r in records.iter().skip(1) {
        if v.accept(r.bytes(&data), r.offset).unwrap() != Accepted::Transaction {
            continue;
        }
        let st = v.state();
        let d = v.delta();
        if st.seq < 22 {
            // States 1 to 21 are golden-11's: no particles, no delta.
            assert!(st.particles.is_empty());
            assert!(d.particles_upserted.is_empty() && d.particles_removed.is_empty());
            continue;
        }
        // Every listed (non-freed) entry carries its floats; a tombstone none.
        for p in st.particles.values() {
            assert_eq!(p.floats.is_none(), p.status == EntryStatus::Freed, "seq {}", st.seq);
            if let Some(fl) = &p.floats {
                assert_eq!(fl.trail_poses.len() as i64, p.trail_poses);
            }
        }
        match st.seq {
            22 => {
                assert_eq!(d.particles_upserted, vec![1, 2]);
                let e1 = &st.particles[&1];
                assert_eq!(e1.status, EntryStatus::Ok);
                assert_eq!(e1.reason, None);
                assert_eq!((e1.version, e1.amount, e1.fixed_fps, e1.seed), (14, 8, 30, 1234));
                assert_eq!(e1.mode, ParticlesMode::D2);
                assert!(e1.emitting && e1.local && e1.interpolate && !e1.one_shot);
                assert_eq!(e1.process_material, Some(2));
                assert_eq!(e1.draw_passes, vec![Some(1)]);
                let f1 = e1.floats.as_ref().unwrap();
                assert_eq!((f1.lifetime, f1.explosiveness, f1.randomness), (2., 0.25, 0.5));
                assert_eq!(f1.collision_base_size, 1.);
                assert_eq!(f1.custom_aabb, [-64., -64., 0., 128., 128., 0.]);
                let e2 = &st.particles[&2];
                assert!(!e2.local);
                assert_eq!(e2.subemitter, Some(1));
                assert_eq!(e2.draw_passes, vec![None]);
                let f2 = e2.floats.as_ref().unwrap();
                assert_eq!(f2.emission_transform, xform([1., 1., 1.], [100., 50., 0.]));
                assert_eq!(f2.emitter_velocity, [4., 0., 0.]);
                // Item 18 draws emitters 1 (tex 1) and 2; item 19's unknown RID is typed.
                assert_eq!(
                    st.items[&18].commands.list,
                    vec![
                        Command::Particles { particles: 1, tex: Some(1) },
                        Command::Particles { particles: 2, tex: None },
                    ]
                );
                assert!(matches!(
                    &st.items[&19].commands.list[..],
                    [Command::Unsupported { name, .. }] if &**name == "canvas_item_add_particles"
                ));
                // The process material's shader carries the builtin, and is ok.
                let sh = &st.shaders[&2];
                assert_eq!(sh.status, EntryStatus::Ok);
                assert_eq!(sh.mode, Some(ShaderMode::Particles));
                assert!(sh.builtin.is_none());
                let b = sh.process.as_ref().unwrap();
                assert_eq!(b.emission_shape, EmissionShape::Box);
                assert_eq!(b.textures, vec![ProcessParam::Scale]);
                assert!(b.color_ramp && !b.turbulence && b.particle_flags.is_empty());
                assert_eq!(b.sub_emitter, SubEmitterMode::Disabled);
            }
            23 => {
                // Emitter 2 moves by floats only; emitter 1 restarts with a new seed and emits.
                assert_eq!(d.particles_upserted, vec![1, 2]);
                let e1 = &st.particles[&1];
                assert_eq!((e1.version, e1.restarts, e1.emits, e1.seed), (18, 1, 2, 4321));
                let e2 = &st.particles[&2];
                assert_eq!(e2.version, 10);
                assert_eq!(
                    e2.floats.as_ref().unwrap().emission_transform,
                    xform([1., 1., 1.], [104., 50., 0.])
                );
            }
            24 => {
                assert_eq!(d.particles_upserted, vec![1, 3]);
                let e1 = &st.particles[&1];
                assert!(e1.trails);
                assert_eq!((e1.version, e1.trail_poses), (20, 2));
                let f1 = e1.floats.as_ref().unwrap();
                assert_eq!(f1.trail_length, 0.5);
                assert_eq!(f1.trail_poses[1], xform([1., 1., 1.], [0., -4., 0.]));
                let e3 = &st.particles[&3];
                assert_eq!(e3.status, EntryStatus::Unsupported);
                assert_eq!(e3.reason, Some("particles-3d"));
                assert_eq!(e3.mode, ParticlesMode::D3);
            }
            25 => {
                // Emitter 3's tombstone; nothing names emitter 2 any more.
                assert_eq!(d.particles_upserted, vec![3]);
                assert_eq!(d.particles_removed, vec![2]);
                assert!(!st.particles.contains_key(&2));
                let e3 = &st.particles[&3];
                assert_eq!(e3.status, EntryStatus::Freed);
                assert_eq!((e3.version, e3.process_material, e3.subemitter), (4, None, None));
                assert!(e3.draw_passes.is_empty());
                // A tombstone is still a valid command target.
                assert!(st.items[&18]
                    .commands
                    .list
                    .contains(&Command::Particles { particles: 3, tex: None }));
            }
            26 => {
                // Re-sent full: both entries carried, nothing removed.
                assert!(d.full);
                assert_eq!(d.particles_upserted, vec![1, 3]);
                assert!(d.particles_removed.is_empty());
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn folded_deltas_union_the_particles_ids() {
    // A credit-window-2 receiver folds 24 into 25: emitter 1 and 3 upserted, 2 removed.
    let data = golden("golden-12/patch.rs12");
    let records = wire::split_records(&data, 12).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(12)).unwrap();
    let mut folded = None::<crate::state::TxDelta>;
    for r in records.iter().skip(1) {
        if v.accept(r.bytes(&data), r.offset).unwrap() != Accepted::Transaction {
            continue;
        }
        match v.state().seq {
            24 => folded = Some(v.delta().clone()),
            25 => folded.as_mut().unwrap().merge(v.delta()),
            _ => {}
        }
    }
    let f = folded.unwrap();
    assert_eq!(f.particles_upserted, vec![1, 3]);
    assert_eq!(f.particles_removed, vec![2]);
}

#[test]
fn shape_rules_are_particles_entry() {
    // ok: reason null, mode 2d.
    assert_eq!(reject_at(22, |m| pt(m, 1)["reason"] = json!("unknown-mesh")), "particles-entry");
    assert_eq!(reject_at(22, |m| pt(m, 1)["mode"] = json!("3d")), "particles-entry");
    // unsupported: a reason.
    assert_eq!(reject_at(24, |m| pt(m, 3)["reason"] = J::Null), "particles-entry");
    // freed: the tombstone's fixed fields (state 25 frees emitter 3).
    assert_eq!(reject_at(25, |m| pt(m, 3)["process_material"] = json!(2)), "particles-entry");
    assert_eq!(reject_at(25, |m| pt(m, 3)["draw_passes"] = json!([null])), "particles-entry");
    assert_eq!(reject_at(25, |m| pt(m, 3)["subemitter"] = json!(1)), "particles-entry");
    assert_eq!(reject_at(25, |m| pt(m, 3)["reason"] = json!("particles-3d")), "particles-entry");
    // Types and spellings are the schema's.
    assert_eq!(reject_at(22, |m| pt(m, 1)["draw_order"] = json!("depth")), "meta-schema");
    assert_eq!(reject_at(22, |m| pt(m, 1)["transform_align"] = json!("none")), "meta-schema");
    assert_eq!(reject_at(22, |m| pt(m, 1)["seed"] = json!(4294967296u64)), "meta-schema");
    assert_eq!(reject_at(22, |m| pt(m, 1)["amount"] = json!(-1)), "meta-schema");
    assert_eq!(reject_at(22, |m| pt(m, 1)["origin"] = json!("root-query")), "meta-schema");
    assert_eq!(reject_at(22, |m| pt(m, 1)["reason"] = json!("nope")), "meta-schema");
}

#[test]
fn version_rules_are_particles_version() {
    // State 23 moves emitter 2 to version 10 by its emission transform alone: at the base's 9
    // the JSON fields are equal, so only the float half (resolved) catches it.
    assert_eq!(reject_at(23, |m| pt(m, 2)["version"] = json!(9)), "particles-version");
    // At the base's version with a changed JSON field (emitter 1's seed), before resolving.
    assert_eq!(reject_at(23, |m| pt(m, 1)["version"] = json!(14)), "particles-version");
    // A version below the base's.
    assert_eq!(reject_at(23, |m| pt(m, 1)["version"] = json!(13)), "particles-version");
    // Moving by more than one is legal (the host may change an entry twice between publishes).
    assert_eq!(reject_at(23, |m| pt(m, 1)["version"] = json!(19)), "accepted");
}

#[test]
fn emit_rules_are_particle_emits() {
    // restarts above the entry's.
    assert_eq!(reject_at(23, |m| m["particle_emits"][0]["restarts"] = json!(2)), "particle-emits");
    // An emit on emitter 2, whose emits counter did not move.
    assert_eq!(reject_at(23, |m| m["particle_emits"][1]["particles"] = json!(2)), "particle-emits");
    // An unknown emitter.
    assert_eq!(reject_at(23, |m| m["particle_emits"][0]["particles"] = json!(9)), "particle-emits");
    // flags is 0..31, a shape.
    assert_eq!(reject_at(23, |m| m["particle_emits"][0]["flags"] = json!(32)), "meta-schema");
    // A moved offset is pt-offset (emits claim after the entries, in list order).
    assert_eq!(reject_at(23, |m| m["particle_emits"][1]["f"] = json!(84)), "pt-offset");
}

#[test]
fn removal_and_reference_rules() {
    // removed_particles names an id absent from the base.
    assert_eq!(reject_at(25, |m| m["removed_particles"] = json!([2, 9])), "patch-removed");
    // removed_particles is ascending.
    assert_eq!(reject_at(25, |m| m["removed_particles"] = json!([2, 1])), "meta-schema");
    // A removed emitter still named by a command (item 18 draws emitter 2 at 24).
    assert_eq!(
        reject_at(24, |m| insert_after(m, "particles", "removed_particles", json!([2]))),
        "particles-ref"
    );
    // An id both listed and removed (state 24 lists emitter 1).
    assert_eq!(
        reject_at(24, |m| insert_after(m, "particles", "removed_particles", json!([1]))),
        "patch-removed"
    );
    // State 25 lists only emitter 3; removing emitter 1 too leaves item 18's command dangling.
    assert_eq!(reject_at(25, |m| m["removed_particles"] = json!([1, 2])), "particles-ref");
}

#[test]
fn unsupported_particles_is_derived() {
    // State 24 declares (18, canvas_item_add_particles, unsupported-particles): dropping it is
    // unsupported-mismatch, and so is declaring it at state 25, where emitter 3 is a tombstone.
    assert_eq!(
        reject_at(24, |m| m["unsupported"]
            .as_array_mut()
            .unwrap()
            .retain(|u| u["reason"] != "unsupported-particles")),
        "unsupported-mismatch"
    );
    assert_eq!(
        reject_at(25, |m| {
            let u = m["unsupported"].as_array_mut().unwrap();
            let at = u
                .iter()
                .position(|e| e["item"].as_i64().unwrap_or(0) > 18)
                .unwrap();
            u.insert(
                at,
                json!({"op":"canvas_item_add_particles","item":18,"reason":"unsupported-particles"}),
            );
        }),
        "unsupported-mismatch"
    );
}

#[test]
fn particles_are_version_gated() {
    // add_particles exists from /12 only: below, an unknown op. The meta path decodes it at /12.
    let parse = |v: u8| {
        let data = golden("golden-12/patch.rs12");
        let records = wire::split_records(&data, 12).unwrap();
        let rec = records
            .iter()
            .map(|r| r.bytes(&data))
            .find(|r| meta_of(r)["seq"] == 22 && meta_of(r)["type"] == "transaction")
            .unwrap();
        let mut bufs = meta::DecodeBufs::default();
        let mut tx = meta::TxMeta::default();
        let r = meta::decode_record(rec, 0, v, &mut bufs, &mut tx).map(|_| ());
        (r, tx.cmds.iter().filter(|c| c.op == Op::Particles).count())
    };
    let (ok, n) = parse(12);
    assert!(ok.is_ok(), "{ok:?}");
    assert_eq!(n, 2);
    assert_eq!(parse(11).0.unwrap_err().code, "meta-schema");
}

#[test]
fn pm5_sabotage_kinds_are_legal_at_12_only() {
    for kind in ["perturb-seed", "drop-restart"] {
        for (v, rel, ok) in [
            (12u8, "golden-12/patch.rs12", true),
            (11, "golden-11/patch.rs11", false),
        ] {
            let data = golden(rel);
            let records = wire::split_records(&data, v).unwrap();
            let rec = records[0].bytes(&data);
            let mut m = meta_of(rec);
            m["sabotage"] = json!({"kind": kind, "frame": 1, "op": null});
            let got = Validator::new(&with_meta(rec, &m), 8, Options::new(v));
            assert_eq!(got.is_ok(), ok, "{kind} at /{v}: {:?}", got.err());
        }
    }
}

fn viewport(v: &Validator) -> Viewport {
    let s = v.session();
    let size = s
        .viewport
        .presentation_size
        .unwrap_or(s.viewport.logical_size);
    Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    }
}

/// GSW's executor (rs-core's applier) over golden-12's inline stream: every transaction applies,
/// and under PM6a's receiver sabotage `undrawn-particles` (the pre-PM6b executor) every lowered
/// `add_particles` is a `particles-undrawn` shortcut (a typed skip). Item 18 is lowered at states
/// 22 (2 emitters), 24 (3) and 25 (2). The honest executor draws them (apply/pm6b_tests.rs).
#[test]
fn gsw_counts_every_add_particles_undrawn() {
    let data = golden("golden-12/inline.rs12");
    let spans = wire::split_records(&data, 12).unwrap();
    let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(12)).unwrap();
    let mut a = Applier::new(viewport(&v));
    a.sabotage.lower.undrawn_particles = true;
    let mut store = PayloadStore::default();
    let mut need = Vec::new();
    let mut txs = 0;
    for span in &spans[1..] {
        let rec = span.bytes(&data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                // golden-11's KTX2 variants travel inline (decision 2); nothing draws one.
                if crate::payload::payload_kind(&b, 12) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, 12, true).unwrap();
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                txs += 1;
                store.accept_transaction(&v, rec).unwrap();
                let st = v.state();
                a.prepare(st, v.delta());
                a.needed(st, v.delta(), &store, &mut need);
                assert!(need.is_empty(), "seq {}: nothing to fetch ({need:?})", st.seq);
                a.apply(st, v.delta(), &store);
                a.list.consumed();
            }
        }
    }
    assert_eq!(txs, 26);
    assert_eq!(a.shortcut_totals.get("particles-undrawn").copied(), Some(7));
    assert!(crate::apply::lower::Shortcut::ParticlesUndrawn.is_skip());
}
