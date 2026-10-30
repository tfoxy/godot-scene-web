//! TAG1: the render-stream/13 `item_meta` record (client-extensions-design.md §2.4) and the
//! receiver's identity table it builds.
//!
//! The record is a JSON meta with no blocks, keys in this order:
//! `{"type":"item_meta","form":"full"|"delta","grant":{"fields":[..],"groups":[..],"meta_keys":[..]}|null,
//! "strings_from":n,"strings":[..],"items":[[id,col..],..],"blocks":[]}`. A `full` carries the
//! grant and replaces the table; a `delta` (grant `null`) appends strings and upserts rows. A row
//! is `[id]` (an item with no node) or `[id, c..]` with one column per granted field (a string
//! index or `null`), the groups bitmask when groups are granted, then one column per meta key.
//!
//! [`check_record`] is `decodeRecord`'s record-local part (`item-meta-schema`, and for a `full`
//! `item-meta-string`); the stream rules (the ask, the grant a `delta` is read against, orphans,
//! forms, ids) are the validator's (`validate.rs`). The reference is
//! `protocol/golden-13/make_golden.py` (`item_meta_check`), and `scripts/lib/render-stream-2.ts`
//! implements the same rules with the same codes.

use crate::json::Value;
use crate::meta::Ck;
use crate::state::Id;
use crate::wire::{BlockDesc, Error};
use serde_json::{json, Value as J};
use std::collections::BTreeMap;

/// The grantable fields, in wire order.
pub const FIELDS: [&str; 4] = ["class", "script", "scene", "path"];
pub const MAX_GROUPS: usize = 31;
pub const MAX_META_KEYS: usize = 8;
pub const MAX_NAME_BYTES: usize = 64;
/// The canonical meta's first bytes: the validator reads them before decoding, so the ask and an
/// orphan are judged before the record's own schema (render-stream-0's key order puts `type`
/// first).
pub const PREFIX: &[u8] = b"{\"type\":\"item_meta\",";

const KEYS: &[&str] = &[
    "type",
    "form",
    "grant",
    "strings_from",
    "strings",
    "items",
    "blocks",
];
const GRANT_KEYS: &[&str] = &["fields", "groups", "meta_keys"];

/// A viewer's `item_meta` hello request, and (same shape) a host's grant.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ItemMetaRequest {
    /// A subset of [`FIELDS`], in that order.
    pub fields: Vec<String>,
    /// At most 31 group names (bit i of a row's mask is `groups[i]`).
    pub groups: Vec<String>,
    /// At most 8 meta keys.
    pub meta_keys: Vec<String>,
}

/// The grant a `full` record carries (the request's shape).
pub type ItemMetaGrant = ItemMetaRequest;

fn name_ok(s: &[u8]) -> bool {
    (1..=MAX_NAME_BYTES).contains(&s.len()) && s.iter().all(|&b| (0x20..=0x7e).contains(&b))
}

fn no_dups(v: &[String]) -> bool {
    v.iter().enumerate().all(|(i, a)| !v[..i].contains(a))
}

impl ItemMetaRequest {
    /// Columns after the id in a row of a node.
    pub fn columns(&self) -> usize {
        self.fields.len() + usize::from(!self.groups.is_empty()) + self.meta_keys.len()
    }

    /// The hello / grant list rules: `None` when valid, else what is wrong.
    pub fn problem(&self) -> Option<&'static str> {
        let mut last = None;
        for f in &self.fields {
            match FIELDS.iter().position(|x| x == f) {
                Some(i) if last.is_none_or(|l| i > l) => last = Some(i),
                _ => return Some("\"fields\" is not a subset of class, script, scene, path in that order without duplicates"),
            }
        }
        if self.groups.len() > MAX_GROUPS {
            return Some("\"groups\" holds more than 31 names");
        }
        if self.meta_keys.len() > MAX_META_KEYS {
            return Some("\"meta_keys\" holds more than 8 names");
        }
        for list in [&self.groups, &self.meta_keys] {
            if !list.iter().all(|s| name_ok(s.as_bytes())) || !no_dups(list) {
                return Some("a group or meta key is not 1-64 printable ASCII bytes, or repeats");
            }
        }
        if self.fields.is_empty() && self.groups.is_empty() && self.meta_keys.is_empty() {
            return Some("\"fields\", \"groups\" and \"meta_keys\" are all empty");
        }
        None
    }

    /// The column of a granted field (0-based, after the id).
    pub fn field_column(&self, field: &str) -> Option<usize> {
        self.fields.iter().position(|f| f == field)
    }

    /// The column of the groups bitmask, when groups are granted.
    pub fn groups_column(&self) -> Option<usize> {
        (!self.groups.is_empty()).then_some(self.fields.len())
    }

    /// The column of a granted meta key.
    pub fn meta_column(&self, key: &str) -> Option<usize> {
        let base = self.fields.len() + usize::from(!self.groups.is_empty());
        self.meta_keys.iter().position(|k| k == key).map(|i| base + i)
    }

    /// Whether `self` (a grant) is within `req`: fields a subset, groups and meta_keys each
    /// empty or equal to the request's.
    pub fn within(&self, req: &ItemMetaRequest) -> bool {
        self.fields.iter().all(|f| req.fields.contains(f))
            && (self.groups.is_empty() || self.groups == req.groups)
            && (self.meta_keys.is_empty() || self.meta_keys == req.meta_keys)
    }

    /// Parses `{"fields":[..],"groups":[..],"meta_keys":[..]}` (key order free) and checks it.
    pub fn from_json(v: &J) -> Result<ItemMetaRequest, String> {
        let o = v.as_object().ok_or("the request is not a JSON object")?;
        if o.len() != 3 {
            return Err("the request must have exactly fields, groups and meta_keys".into());
        }
        let list = |k: &str| -> Result<Vec<String>, String> {
            o.get(k)
                .and_then(|x| x.as_array())
                .ok_or(format!("\"{k}\" is not an array"))?
                .iter()
                .map(|s| {
                    s.as_str()
                        .map(str::to_string)
                        .ok_or(format!("\"{k}\" holds a non-string"))
                })
                .collect()
        };
        let r = ItemMetaRequest {
            fields: list("fields")?,
            groups: list("groups")?,
            meta_keys: list("meta_keys")?,
        };
        match r.problem() {
            Some(p) => Err(p.into()),
            None => Ok(r),
        }
    }

    pub fn to_json(&self) -> J {
        json!({"fields": self.fields, "groups": self.groups, "meta_keys": self.meta_keys})
    }
}

/// What the validator was told about the stream's item_meta opt-in.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub enum ItemMetaAsk {
    /// A recording (or a client that does not say): records are accepted and validated.
    #[default]
    Unknown,
    /// A live viewer whose hello had no `item_meta` key: any record is `item-meta-unexpected`.
    NotAsked,
    /// A live viewer's hello request: a `full`'s grant must be within it.
    Asked(ItemMetaRequest),
}

/// One item's row.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ItemMetaRow {
    /// `[id]`: the item has no node (a quadrant, a viewport internal).
    NoNode,
    /// The columns after the id, in wire order: per granted field a string index (`None` for
    /// null), the groups bitmask as `Some(mask)` when groups are granted, then per meta key a
    /// string index. Read them through [`ItemMetaTable`]'s accessors.
    Node(Box<[Option<u32>]>),
}

/// A decoded, record-locally valid `item_meta` record.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ItemMetaRecord {
    pub full: bool,
    /// `Some` exactly for a `full`.
    pub grant: Option<ItemMetaGrant>,
    pub strings_from: u64,
    pub strings: Vec<String>,
    /// Sorted by id, no duplicates.
    pub items: Vec<(Id, ItemMetaRow)>,
}

/// The receiver's identity table: what every accepted record says, as of the newest accepted
/// transaction. `grant` is `None` until a `full` grants (and for a viewer that was refused).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ItemMetaTable {
    pub grant: Option<ItemMetaGrant>,
    pub strings: Vec<String>,
    /// The rows of the items of the newest state that have one (removed items' rows dropped).
    pub rows: BTreeMap<Id, ItemMetaRow>,
}

impl ItemMetaTable {
    pub fn row(&self, id: Id) -> Option<&ItemMetaRow> {
        self.rows.get(&id)
    }

    fn col(&self, id: Id, col: Option<usize>) -> Option<u32> {
        match self.rows.get(&id)? {
            ItemMetaRow::Node(c) => c.get(col?).copied().flatten(),
            ItemMetaRow::NoNode => None,
        }
    }

    /// A granted field's value (`class`, `script`, `scene` or `path`) of item `id`.
    pub fn field(&self, id: Id, field: &str) -> Option<&str> {
        let g = self.grant.as_ref()?;
        let i = self.col(id, g.field_column(field))?;
        self.strings.get(i as usize).map(String::as_str)
    }

    /// Item `id`'s groups bitmask (bit i is the grant's i-th group).
    pub fn groups(&self, id: Id) -> Option<u32> {
        let g = self.grant.as_ref()?;
        self.col(id, g.groups_column())
    }

    /// A granted meta key's value of item `id`.
    pub fn meta(&self, id: Id, key: &str) -> Option<&str> {
        let g = self.grant.as_ref()?;
        let i = self.col(id, g.meta_column(key))?;
        self.strings.get(i as usize).map(String::as_str)
    }

    /// A row in `rs-core-check --item-meta-dump`'s form: `null` for no node, else
    /// `{<field>: string|null.., "groups": mask, "meta": {<key>: string|null}}` over the grant
    /// (`groups` and `meta` only when granted).
    pub fn row_json(&self, row: &ItemMetaRow) -> J {
        let (ItemMetaRow::Node(c), Some(g)) = (row, self.grant.as_ref()) else {
            return J::Null;
        };
        let s = |k: usize| -> J {
            c.get(k)
                .copied()
                .flatten()
                .and_then(|i| self.strings.get(i as usize))
                .map_or(J::Null, |x| J::String(x.clone()))
        };
        let mut o = serde_json::Map::new();
        for (k, f) in g.fields.iter().enumerate() {
            o.insert(f.clone(), s(k));
        }
        if let Some(k) = g.groups_column() {
            o.insert("groups".into(), json!(c.get(k).copied().flatten()));
        }
        if !g.meta_keys.is_empty() {
            let mut m = serde_json::Map::new();
            for key in &g.meta_keys {
                m.insert(key.clone(), s(g.meta_column(key).unwrap_or(usize::MAX)));
            }
            o.insert("meta".into(), J::Object(m));
        }
        J::Object(o)
    }
}

/// Row shape against a grant: each row `[id]` or one column per granted column, the groups
/// column a mask below `2^|groups|`. `Err(detail)` for `item-meta-schema`.
pub fn check_rows(items: &[(Id, ItemMetaRow)], grant: &ItemMetaGrant) -> Result<(), String> {
    let n = grant.columns();
    let gc = grant.groups_column();
    for (id, row) in items {
        let ItemMetaRow::Node(c) = row else { continue };
        if c.len() != n {
            return Err(format!(
                "item {id}'s row has {} columns, the grant {n}",
                c.len()
            ));
        }
        if let Some(k) = gc {
            let ok = c[k].is_some_and(|m| (m as u64) < (1u64 << grant.groups.len()));
            if !ok {
                return Err(format!(
                    "item {id}'s groups column is not a bitmask below 2^{}",
                    grant.groups.len()
                ));
            }
        }
    }
    Ok(())
}

/// Every string column of every row is below `size`. `Err(detail)` for `item-meta-string`.
pub fn check_indices(
    items: &[(Id, ItemMetaRow)],
    grant: &ItemMetaGrant,
    size: u64,
) -> Result<(), String> {
    let gc = grant.groups_column();
    for (id, row) in items {
        let ItemMetaRow::Node(c) = row else { continue };
        for (k, v) in c.iter().enumerate() {
            if Some(k) == gc {
                continue;
            }
            if let Some(i) = v {
                if *i as u64 >= size {
                    return Err(format!(
                        "item {id}'s column {k} names string {i}, the table holds {size}"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// A non-negative integer, clamped to u32::MAX (every such value is out of range wherever it is
/// read, so the clamp keeps each verdict: `Number.isInteger(v) && v >= 0` in TypeScript).
fn uint_clamped(ck: &Ck, v: Value) -> Option<u32> {
    let x = ck.doc.as_num(v)?;
    (x.is_finite() && x.fract() == 0.0 && x >= 0.0).then(|| x.min(u32::MAX as f64) as u32)
}

fn grant_of(ck: &mut Ck, v: Value) -> Result<ItemMetaGrant, String> {
    // `fields` collapses a repeated key as JSON.parse does (and marks the meta non-canonical).
    let Some(f) = ck.fields(v, GRANT_KEYS) else {
        return Err("\"grant\" is not an object with fields, groups, meta_keys in that order".into());
    };
    let list = |i: usize| -> Result<Vec<String>, String> {
        let Some(a) = ck.arr(f.at(i)) else {
            return Err(format!("grant.{} is not an array", GRANT_KEYS[i]));
        };
        a.iter()
            .map(|&x| {
                ck.string(x)
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .ok_or(format!("grant.{} holds a non-string", GRANT_KEYS[i]))
            })
            .collect()
    };
    let g = ItemMetaGrant {
        fields: list(0)?,
        groups: list(1)?,
        meta_keys: list(2)?,
    };
    match g.problem() {
        Some(p) => Err(format!("grant: {p}")),
        None => Ok(g),
    }
}

/// `decodeRecord`'s `item_meta` checks (only called at /13): the shape (`item-meta-schema`) and,
/// for a `full` (whose grant is in the record), the row columns against it and `strings_from` 0
/// and every string index in range (`item-meta-string`). A `delta`'s rows are read against the
/// stream's grant by the validator.
pub(crate) fn check_record(
    ck: &mut Ck,
    meta: Value,
    blocks: &mut Vec<BlockDesc>,
) -> Result<ItemMetaRecord, Error> {
    blocks.clear();
    let schema = |ck: &Ck, d: &str| ck.err("item-meta-schema", d);
    let Some(f) = ck.fields(meta, KEYS) else {
        return Err(schema(ck, "item_meta has the wrong top-level keys or order"));
    };
    let full = match ck.one_of(f.at(1), &["full", "delta"]) {
        Some(i) => i == 0,
        None => return Err(schema(ck, "\"form\" is not \"full\" or \"delta\"")),
    };
    let grant = if full {
        Some(grant_of(ck, f.at(2)).map_err(|d| schema(ck, &d))?)
    } else if ck.null(f.at(2)) {
        None
    } else {
        return Err(schema(ck, "a delta's \"grant\" is not null"));
    };
    let Some(strings_from) = uint_clamped(ck, f.at(3)).map(u64::from) else {
        return Err(schema(ck, "\"strings_from\" is not a non-negative integer"));
    };
    let Some(sa) = ck.arr(f.at(4)) else {
        return Err(schema(ck, "\"strings\" is not an array"));
    };
    let mut strings = Vec::with_capacity(sa.len());
    for &s in sa {
        match ck.string(s) {
            Some(b) => strings.push(String::from_utf8_lossy(b).into_owned()),
            None => return Err(schema(ck, "\"strings\" holds a non-string")),
        }
    }
    let Some(ia) = ck.arr(f.at(5)) else {
        return Err(schema(ck, "\"items\" is not an array"));
    };
    let mut items: Vec<(Id, ItemMetaRow)> = Vec::with_capacity(ia.len());
    for &r in ia {
        let row = ck.arr(r).filter(|a| !a.is_empty());
        let Some(row) = row else {
            return Err(schema(ck, "an items[] row is not a non-empty array"));
        };
        let Some(id) = ck.id1(row[0]) else {
            return Err(schema(ck, "an items[] row's id is not an integer in 1..2^32"));
        };
        if items.last().is_some_and(|(last, _)| *last >= id) {
            return Err(schema(
                ck,
                &format!("items[] ids are not strictly increasing at {id}"),
            ));
        }
        if row.len() == 1 {
            items.push((id, ItemMetaRow::NoNode));
            continue;
        }
        let mut cols = Vec::with_capacity(row.len() - 1);
        for &c in &row[1..] {
            if ck.null(c) {
                cols.push(None);
            } else if let Some(x) = uint_clamped(ck, c) {
                cols.push(Some(x));
            } else {
                return Err(schema(
                    ck,
                    &format!("item {id}'s row holds a column that is neither null nor a non-negative integer"),
                ));
            }
        }
        items.push((id, ItemMetaRow::Node(cols.into_boxed_slice())));
    }
    if !ck.arr(f.at(6)).is_some_and(|a| a.is_empty()) {
        return Err(schema(ck, "\"blocks\" must be an empty array for an item_meta record"));
    }
    if let Some(g) = &grant {
        check_rows(&items, g).map_err(|d| schema(ck, &d))?;
        if strings_from != 0 {
            return Err(ck.err(
                "item-meta-string",
                format!("a full's strings_from is {strings_from}, not 0"),
            ));
        }
        check_indices(&items, g, strings.len() as u64)
            .map_err(|d| ck.err("item-meta-string", d))?;
    }
    Ok(ItemMetaRecord {
        full,
        grant,
        strings_from,
        strings,
        items,
    })
}

/// `rs-core-check --item-meta-dump` (and golden-13's `item_meta_valid[].dump`): the table after
/// the last record, plus every row each item ever had, over a validation. Feed it every
/// `accept` result with [`ItemMetaDump::observe`].
#[derive(Default)]
pub struct ItemMetaDump {
    held: Option<ItemMetaRecord>,
    seen: BTreeMap<Id, J>,
    full_records: u64,
    delta_records: u64,
}

impl ItemMetaDump {
    pub fn observe(&mut self, v: &crate::validate::Validator, accepted: crate::validate::Accepted) {
        use crate::validate::Accepted;
        match accepted {
            Accepted::ItemMeta => self.held = v.item_meta_pending().cloned(),
            Accepted::Transaction => {
                if let Some(r) = self.held.take() {
                    if r.full {
                        self.full_records += 1;
                    } else {
                        self.delta_records += 1;
                    }
                    let t = v.item_meta();
                    for (id, row) in &r.items {
                        self.seen.insert(*id, t.row_json(row));
                    }
                }
            }
            _ => {}
        }
    }

    /// `{"grant", "strings", "rows": {"<id>": row}, "seen": {"<id>": row}, "full_records",
    /// "delta_records"}`; rows in [`ItemMetaTable::row_json`]'s form.
    pub fn to_json(&self, t: &ItemMetaTable) -> J {
        let rows: serde_json::Map<String, J> = t
            .rows
            .iter()
            .map(|(id, r)| (id.to_string(), t.row_json(r)))
            .collect();
        let seen: serde_json::Map<String, J> = self
            .seen
            .iter()
            .map(|(id, r)| (id.to_string(), r.clone()))
            .collect();
        json!({
            "grant": t.grant.as_ref().map_or(J::Null, ItemMetaRequest::to_json),
            "strings": t.strings,
            "rows": rows,
            "seen": seen,
            "full_records": self.full_records,
            "delta_records": self.delta_records,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::{validate_recording, Accepted, Options, Validator};
    use crate::wire;

    fn protocol(rel: &str) -> Vec<u8> {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol");
        std::fs::read(dir.join(rel)).unwrap()
    }

    fn record(meta: &str) -> Vec<u8> {
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta.as_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend(body);
        out
    }

    fn request() -> ItemMetaRequest {
        ItemMetaRequest {
            fields: vec!["class".into(), "script".into(), "scene".into(), "path".into()],
            groups: vec!["rs_hand".into(), "rs_ui".into()],
            meta_keys: vec!["rs_tag".into()],
        }
    }

    /// item-meta.rs13's records, and a validator over its session.
    fn stream(ask: ItemMetaAsk) -> (Vec<u8>, Vec<(usize, usize)>, Validator) {
        let data = protocol("golden-13/item-meta.rs13");
        let spans: Vec<(usize, usize)> = wire::split_records(&data, 13)
            .unwrap()
            .iter()
            .map(|s| (s.offset, s.offset + s.byte_length))
            .collect();
        let opts = Options {
            item_meta: ask,
            ..Options::new(13)
        };
        let v = Validator::new(&data[spans[0].0..spans[0].1], spans[0].0, opts).unwrap();
        (data, spans, v)
    }

    #[test]
    fn below_13_item_meta_is_an_unknown_type() {
        let mut data = protocol("golden-12/patch.rs12");
        let spans = wire::split_records(&data, 12).unwrap();
        let at = spans[1].offset;
        let rec = record(r#"{"type":"item_meta","form":"delta","grant":null,"strings_from":0,"strings":[],"items":[],"blocks":[]}"#);
        data.splice(at..at, rec);
        let e = validate_recording(&data, Options::new(12)).unwrap_err();
        assert_eq!(e.code, "meta-schema", "{e}");
    }

    /// A rejected record changes nothing: the stream goes on as if it never came.
    #[test]
    fn a_rejected_record_changes_nothing() {
        let (data, spans, mut v) = stream(ItemMetaAsk::Asked(request()));
        let mut bad_tried = 0;
        for (i, &(a, b)) in spans.iter().enumerate().skip(1) {
            let rec = &data[a..b];
            if rec.len() > 28 && &rec[8..8 + PREFIX.len()] == PREFIX && i > 1 {
                // A delta with the wrong strings_from, one with a short row, and one before a
                // full transaction (or a full before a patch), ahead of the real record.
                let n = v.item_meta().strings.len();
                for bad in [
                    format!(r#"{{"type":"item_meta","form":"delta","grant":null,"strings_from":{},"strings":[],"items":[],"blocks":[]}}"#, n + 1),
                    format!(r#"{{"type":"item_meta","form":"delta","grant":null,"strings_from":{n},"strings":[],"items":[[1,0]],"blocks":[]}}"#),
                ] {
                    let e = v.accept(&record(&bad), a).unwrap_err();
                    assert!(e.code.starts_with("item-meta-"), "{e}");
                    assert!(v.item_meta_pending().is_none());
                    bad_tried += 1;
                }
            }
            v.accept(rec, a).unwrap();
        }
        v.finish().unwrap();
        assert!(bad_tried >= 10);
        assert_eq!(v.item_meta().rows.len(), 16);
        assert_eq!(v.item_meta().field(1, "class"), Some("Label"));
        assert_eq!(v.item_meta().field(1, "script"), None);
        assert_eq!(v.item_meta().groups(7), Some(3));
        assert_eq!(v.item_meta().meta(2, "rs_tag"), Some("tag2"));
        assert_eq!(v.item_meta().row(3), Some(&ItemMetaRow::NoNode));
    }

    /// item-meta-id rolls the transaction back: it can be accepted after the record is dropped.
    #[test]
    fn item_meta_id_rolls_back() {
        let data = protocol("golden-13/invalid/item-meta-id.rs13");
        let spans = wire::split_records(&data, 13).unwrap();
        let opts = Options {
            item_meta: ItemMetaAsk::Asked(request()),
            ..Options::new(13)
        };
        let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, opts).unwrap();
        for s in &spans[1..] {
            match v.accept(s.bytes(&data), s.offset) {
                Ok(_) => {}
                Err(e) => {
                    assert_eq!(e.code, "item-meta-id");
                    let seq = v.state().seq;
                    // The receiver drops the record (a transport skip forgets it) and the
                    // transaction then applies.
                    v.transport_skip();
                    assert_eq!(v.accept(s.bytes(&data), s.offset).unwrap(), Accepted::Transaction);
                    assert_eq!(v.state().seq, seq + 1);
                    return;
                }
            }
        }
        panic!("item-meta-id.rs13 validated");
    }

    #[test]
    fn requests_follow_the_hello_rules() {
        let ok = |t: &str| ItemMetaRequest::from_json(&serde_json::from_str(t).unwrap());
        assert!(ok(r#"{"fields":["scene","path","script"],"groups":[],"meta_keys":[]}"#).is_err());
        assert!(ok(r#"{"fields":["class","class"],"groups":[],"meta_keys":[]}"#).is_err());
        assert!(ok(r#"{"fields":[],"groups":[""],"meta_keys":[]}"#).is_err());
        assert!(ok(r#"{"fields":[],"groups":["a","a"],"meta_keys":[]}"#).is_err());
        assert!(ok(r#"{"fields":[],"groups":[],"meta_keys":["a","b","c","d","e","f","g","h","i"]}"#).is_err());
        assert!(ok(r#"{"fields":["script","path"],"groups":["g"],"meta_keys":["k"]}"#).is_ok());
    }
}
