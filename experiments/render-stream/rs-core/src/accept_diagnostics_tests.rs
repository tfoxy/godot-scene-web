use super::*;

impl Validator {
    fn legacy_item_meta_form(&self, offset: usize) -> Result<(), Error> {
        let full = self.tx.is_full();
        let at = format!("record at offset {offset}, {}", where_(self.tx.seq));
        match &self.item_meta_pending {
            Some(p) if p.full != full => Err(Error::new(
                "item-meta-form",
                format!(
                    "{at}: a {} item_meta record precedes a {} transaction",
                    if p.full { "full" } else { "delta" },
                    if full { "full" } else { "patch" }
                ),
            )),
            None if full && self.item_meta.grant.is_some() => Err(Error::new(
                "item-meta-missing",
                format!("{at}: a full transaction on a granted stream without a full item_meta record before it"),
            )),
            _ => Ok(()),
        }
    }

    fn legacy_check_id_reuse(&self, offset: usize) -> Result<(), Error> {
        let tx = &self.tx;
        let v = self.opts.version;
        let lists: [(&str, Vec<Id>); 6] = [
            ("canvas", tx.canvases.iter().map(|c| c.id).collect()),
            ("item", tx.items.iter().map(|c| c.id).collect()),
            ("texture", tx.textures.iter().map(|c| c.id).collect()),
            ("mesh", tx.meshes.iter().map(|c| c.id).collect()),
            ("shader", tx.shaders.iter().map(|c| c.id).collect()),
            ("material", tx.materials.iter().map(|c| c.id).collect()),
        ];
        for (k, (kind, ids)) in lists.iter().enumerate() {
            if k == 3 && v < 4 || k >= 4 && v < 5 {
                continue;
            }
            for (j, &id) in ids.iter().enumerate() {
                if self.was_new[k][j] && id as i64 <= self.max_id[k] {
                    return Err(Error::new(
                        "id-reused",
                        format!("record at offset {offset}: {kind} id {id} reappears after not being in the previous transaction"),
                    ));
                }
            }
        }
        // render-stream-16.md "Viewport entry": viewport ids, likewise. An entry with a wrong value
        // (a bad id included) is viewport-entry's, reported later, never id-reused.
        for (j, vp) in tx.viewports.iter().enumerate() {
            if vp.bad.is_none()
                && self.viewport_new.get(j) == Some(&true)
                && vp.id as i64 <= self.max_viewport_id
            {
                return Err(Error::new(
                    "id-reused",
                    format!("record at offset {offset}: viewport id {} reappears after not being in the previous transaction", vp.id),
                ));
            }
        }
        Ok(())
    }

}

fn golden(name: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol").join(name)).unwrap()
}

#[test]
fn diagnostic_oracles_preserve_complete_errors_and_precedence() {
    let data = golden("golden-6/full.rs6");
    let records = wire::split_records(&data, 6).unwrap();
    let mut v = Validator::new(records[0].bytes(&data), 8, Options::new(6)).unwrap();
    for r in records.iter().skip(1) {
        v.accept(r.bytes(&data), r.offset).unwrap();
        if !v.tx.meshes.is_empty() && !v.tx.shaders.is_empty() && !v.tx.materials.is_empty() {
            break;
        }
    }
    assert!(!v.tx.meshes.is_empty() && !v.tx.shaders.is_empty() && !v.tx.materials.is_empty());
    for seq in [-1, 0, 9, i64::MAX] {
        v.tx.seq = seq;
        for full in [false, true] {
            v.tx.encoding = Some(if full { Encoding::Full } else { Encoding::Patch });
            for pending in [None, Some(false), Some(true)] {
                v.item_meta_pending = pending.map(|full| Box::new(ItemMetaRecord {
                    full, grant: None, strings_from: 0, strings: Vec::new(), items: Vec::new(),
                }));
                for grant in [false, true] {
                    v.item_meta.grant = grant.then(ItemMetaRequest::default);
                    assert_eq!(v.item_meta_form(123), v.legacy_item_meta_form(123));
                }
            }
        }
    }
    // Each table alone, and simultaneous failures: the first table and first wire id win.
    for version in 2..=16 {
        v.opts.version = version;
        for failing in 0..=6 {
            for k in 0..6 {
                v.was_new[k].fill(failing == 6 || failing == k);
                v.max_id[k] = i64::MAX;
            }
            assert_eq!(v.check_id_reuse(456), v.legacy_check_id_reuse(456));
        }
    }
    v.opts.version = 6;
    v.tx.seq = 42;
    let shader = &mut v.tx.shaders[0];
    shader.reason = if shader.status == EntryStatus::Ok { Some("bad".into()) } else { None };
    let id = shader.id;
    assert_eq!(v.check_invariants().unwrap_err().to_string(),
        format!("shader-entry: transaction seq 42: shader {id}: \"reason\" must be null exactly for status \"ok\""));
}

#[test]
fn rejected_diagnostics_preserve_state_delta_and_following_acceptance() {
    for form in ["full", "patch"] {
        let data = golden(&format!("golden-6/{form}.rs6"));
        let records = wire::split_records(&data, 6).unwrap();
        let mut candidate = Validator::new(records[0].bytes(&data), 8, Options::new(6)).unwrap();
        let mut control = Validator::new(records[0].bytes(&data), 8, Options::new(6)).unwrap();
        let mut rejected = 0;
        for r in records.iter().skip(1) {
            let rec = r.bytes(&data);
            let n = wire::le_u32(rec, 4) as usize;
            let mut meta: serde_json::Value = serde_json::from_slice(&rec[8..8+n]).unwrap();
            if meta["type"] == "transaction" {
                let seq = meta["seq"].as_i64().unwrap();
                meta["unsupported"] = serde_json::json!([
                    {"op":"x", "item":null, "reason":"canvas-light"}
                ]);
                let text = meta.to_string();
                let mut broken = Vec::new();
                broken.extend_from_slice(&((4 + text.len() + rec.len() - 8 - n) as u32).to_le_bytes());
                broken.extend_from_slice(&(text.len() as u32).to_le_bytes());
                broken.extend_from_slice(text.as_bytes());
                broken.extend_from_slice(&rec[8+n..]);
                let state = candidate.state().clone();
                let delta = candidate.delta().clone();
                assert_eq!(candidate.accept(&broken, r.offset).unwrap_err().to_string(),
                    format!("unsupported-mismatch: transaction seq {seq}: canvas-light entry names op x, expected canvas_light_attach_to_canvas"));
                assert_eq!(candidate.state(), &state);
                assert_eq!(candidate.delta(), &delta);
                rejected += 1;
            }
            assert_eq!(candidate.accept(rec, r.offset), control.accept(rec, r.offset));
            assert_eq!(candidate.state(), control.state());
            assert_eq!(candidate.delta(), control.delta());
        }
        assert!(rejected > 0);
    }
}
