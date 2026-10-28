//! PM1 (render-stream-11.md "As built (PM1): decisions"): the multimesh table, `add_multimesh`
//! and `mm_f32` at /11, beyond what golden-11's own vectors cover. Each rejection mutates one
//! record of golden-11's `patch.rs11` (states 17 to 21 carry multimeshes) and checks the code.

use crate::meta::{self, Op};
use crate::state::{EntryStatus, MultimeshFormat};
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

/// Replays `patch.rs11` up to the transaction before `seq`, then offers `seq`'s record with its
/// meta changed by `edit`; returns the error code (or "accepted").
fn reject_at(seq: i64, edit: impl Fn(&mut J)) -> String {
    let data = golden("golden-11/patch.rs11");
    let records = wire::split_records(&data, 11).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(11)).unwrap();
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

fn mm<'a>(m: &'a mut J, id: u64) -> &'a mut J {
    m["multimeshes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["id"] == id)
        .unwrap()
}

#[test]
fn every_multimesh_buffer_hashes_to_its_resolved_digest() {
    for f in ["patch", "full", "inline"] {
        let data = golden(&format!("golden-11/{f}.rs11"));
        let records = wire::split_records(&data, 11).unwrap();
        let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(11)).unwrap();
        let mut seen = 0;
        let mut held = 0;
        for r in records.iter().skip(1) {
            let rec = r.bytes(&data);
            if v.accept(rec, r.offset).unwrap() != Accepted::Transaction {
                assert!(v.multimesh_buffers().is_empty());
                continue;
            }
            let st = v.state();
            for b in v.multimesh_buffers() {
                let e = &st.multimeshes[&b.multimesh];
                assert_eq!(e.status, EntryStatus::Ok);
                assert_eq!(b.floats as u64, e.instances as u64 * e.stride());
                assert_eq!(Some(wire::sha256(b.bytes(rec))), e.buffer_sha256, "{f} seq {}", st.seq);
                seen += 1;
            }
            for e in st.multimeshes.values() {
                // Rule 10: buffer_sha256 is null unless ok, custom_aabb null only on freed.
                assert_eq!(e.buffer_sha256.is_some(), e.status == EntryStatus::Ok);
                assert_eq!(e.custom_aabb.is_none(), e.status == EntryStatus::Freed);
                if e.status == EntryStatus::Ok
                    && !v.multimesh_buffers().iter().any(|b| b.multimesh == e.id)
                {
                    held += 1;
                }
            }
            // Delta: every carried entry is upserted; a removed one is gone.
            let d = v.delta();
            for id in &d.multimeshes_removed {
                assert!(!st.multimeshes.contains_key(id));
            }
        }
        assert!(seen >= 4, "{f}: {seen} buffers");
        if f == "patch" {
            // State 18's multimesh 2 (custom AABB moved, buffer_f null) keeps its floats.
            assert!(held >= 1, "{f}: no held buffer");
        }
    }
}

#[test]
fn a_held_buffer_keeps_its_digest() {
    let data = golden("golden-11/patch.rs11");
    let records = wire::split_records(&data, 11).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(11)).unwrap();
    let mut prev = None;
    for r in records.iter().skip(1) {
        if v.accept(r.bytes(&data), r.offset).unwrap() != Accepted::Transaction {
            continue;
        }
        let st = v.state();
        match st.seq {
            17 => prev = st.multimeshes.get(&2).cloned(),
            18 => {
                let (a, b) = (prev.take().unwrap(), st.multimeshes[&2].clone());
                assert_eq!(a.buffer_sha256, b.buffer_sha256);
                assert_ne!(a.custom_aabb, b.custom_aabb);
                assert_eq!(b.version, a.version + 1);
                assert_eq!(b.format, MultimeshFormat::D2);
                assert_eq!(b.drawn_instances(), 1);
            }
            20 => assert_eq!(v.delta().multimeshes_removed, vec![2, 3]),
            _ => {}
        }
    }
}

#[test]
fn shape_rules_are_multimesh_entry() {
    // ok: visible <= instances.
    assert_eq!(reject_at(17, |m| mm(m, 1)["visible"] = json!(4)), "multimesh-entry");
    // ok: format 2d.
    assert_eq!(reject_at(17, |m| mm(m, 1)["format"] = json!("3d")), "multimesh-entry");
    // ok: aabb_f non-null (the floats then claim nothing at 0, so it must fail first).
    assert_eq!(reject_at(17, |m| mm(m, 1)["aabb_f"] = J::Null), "multimesh-entry");
    // unsupported: reason non-null.
    assert_eq!(reject_at(17, |m| mm(m, 3)["reason"] = J::Null), "multimesh-entry");
    // freed: the tombstone's fixed fields (state 19 frees multimesh 3).
    assert_eq!(reject_at(19, |m| mm(m, 3)["instances"] = json!(4)), "multimesh-entry");
    assert_eq!(reject_at(19, |m| mm(m, 3)["visible"] = json!(0)), "multimesh-entry");
    // Rule 3: a null buffer_f for an entry new to the table (state 17 adds multimesh 1).
    assert_eq!(reject_at(17, |m| mm(m, 1)["buffer_f"] = J::Null), "multimesh-entry");
    // Types are the schema's.
    assert_eq!(reject_at(17, |m| mm(m, 1)["visible"] = json!(-2)), "meta-schema");
    assert_eq!(reject_at(17, |m| mm(m, 1)["reason"] = json!("nope")), "meta-schema");
    assert_eq!(reject_at(17, |m| mm(m, 1)["origin"] = json!("root-query")), "meta-schema");
}

#[test]
fn version_rules_are_multimesh_version() {
    // State 18 moves multimesh 1 to version 5 with new floats: at version 4 (equal to the base's)
    // the JSON fields equal the base's, so only the floats' half catches it.
    assert_eq!(reject_at(18, |m| mm(m, 1)["version"] = json!(4)), "multimesh-version");
    // And at an unmoved version a changed field is caught before resolving.
    assert_eq!(
        reject_at(18, |m| {
            mm(m, 2)["version"] = json!(5);
            mm(m, 2)["visible"] = json!(0);
        }),
        "multimesh-version"
    );
}

#[test]
fn table_rules() {
    // An id ordering error (state 17's multimeshes swapped).
    assert_eq!(
        reject_at(17, |m| m["multimeshes"].as_array_mut().unwrap().swap(0, 1)),
        "meta-schema"
    );
    // removed_multimeshes names an id absent from the base.
    assert_eq!(
        reject_at(20, |m| m["removed_multimeshes"] = json!([2, 3, 9])),
        "patch-removed"
    );
    // A removed multimesh still named by a command.
    assert_eq!(
        reject_at(19, |m| {
            let keys: Vec<String> = m.as_object().unwrap().keys().cloned().collect();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), m[&k].clone());
                if k == "multimeshes" {
                    out.insert("removed_multimeshes".into(), json!([2]));
                }
            }
            *m = J::Object(out);
        }),
        "multimesh-ref"
    );
}

#[test]
fn unsupported_multimesh_is_derived() {
    // State 17 declares (16, canvas_item_add_multimesh, unsupported-multimesh): dropping it is
    // unsupported-mismatch, and so is declaring it at state 19, where multimesh 3 is freed.
    assert_eq!(
        reject_at(17, |m| m["unsupported"]
            .as_array_mut()
            .unwrap()
            .retain(|u| u["reason"] != "unsupported-multimesh")),
        "unsupported-mismatch"
    );
    assert_eq!(
        reject_at(19, |m| {
            let u = m["unsupported"].as_array_mut().unwrap();
            let at = u
                .iter()
                .position(|e| e["item"].as_i64().unwrap_or(0) > 16)
                .unwrap();
            u.insert(
                at,
                json!({"op":"canvas_item_add_multimesh","item":16,"reason":"unsupported-multimesh"}),
            );
        }),
        "unsupported-mismatch"
    );
}

#[test]
fn multimesh_is_version_gated() {
    // add_multimesh and the unknown-multimesh reason exist from /11 only: below, an unknown op /
    // reason. The meta path decodes them at /11.
    let parse = |v: u8| {
        let data = golden("golden-11/patch.rs11");
        let records = wire::split_records(&data, 11).unwrap();
        let rec = records
            .iter()
            .map(|r| r.bytes(&data))
            .find(|r| meta_of(r)["seq"] == 17 && meta_of(r)["type"] == "transaction")
            .unwrap();
        let mut bufs = meta::DecodeBufs::default();
        let mut tx = meta::TxMeta::default();
        let r = meta::decode_record(rec, 0, v, &mut bufs, &mut tx).map(|_| ());
        (r, tx.cmds.iter().filter(|c| c.op == Op::Multimesh).count())
    };
    let (ok, n) = parse(11);
    assert!(ok.is_ok());
    assert_eq!(n, 3);
    assert_eq!(parse(10).0.unwrap_err().code, "meta-schema");
}

#[test]
fn pm1_sabotage_kinds_are_legal_at_11_only() {
    for kind in ["perturb-instance", "stale-buffer"] {
        for (v, rel, ok) in [
            (11u8, "golden-11/patch.rs11", true),
            (10, "golden-10/patch.rs10", false),
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
