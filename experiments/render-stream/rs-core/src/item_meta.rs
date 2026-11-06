//! TAG1: the render-stream/13 `item_meta` record (client-extensions-design.md §2.4) and the
//! receiver's identity table it builds; ID3: render-stream/14's item_meta v2
//! (render-stream-14.md), which adds the `instance_id` and `mouse_filter` columns and re-stamped
//! rows.
//!
//! The record is a JSON meta with no blocks, keys in this order:
//! `{"type":"item_meta","form":"full"|"delta","grant":{"fields":[..],"groups":[..],"meta_keys":[..]}|null,
//! "strings_from":n,"strings":[..],"items":[[id,col..],..],"blocks":[]}`. A `full` carries the
//! grant and replaces the table; a `delta` (grant `null`) appends strings and upserts rows. A row
//! is `[id]` (an item with no node) or `[id, c..]` with one column per granted field (a string
//! index or `null`; at /14 `instance_id` is an inline decimal string or `null` and `mouse_filter`
//! an int in 0..6 or `null`), the groups bitmask when groups are granted, then one column per meta
//! key. A delta row for an id the table holds replaces the held row (at /13 as at /14; /14 names
//! it a re-stamp).
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

/// The grantable fields, in wire order (the last two, [`V2_FIELDS`], only at /14).
pub const FIELDS: [&str; 6] = [
    "class",
    "script",
    "scene",
    "path",
    "instance_id",
    "mouse_filter",
];
/// ID3: the item_meta v2 fields, grantable from render-stream/14 on.
pub const V2_FIELDS: [&str; 2] = ["instance_id", "mouse_filter"];
/// ID3: the first version whose grants may name [`V2_FIELDS`].
pub const V2_VERSION: u8 = 14;
/// ID3: the largest `mouse_filter` value (low two bits the filter, bit 4 `_has_point`).
pub const MAX_MOUSE_FILTER: u32 = 6;
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

    /// The hello / grant list rules at the newest version: `None` when valid, else what is
    /// wrong.
    pub fn problem(&self) -> Option<&'static str> {
        self.problem_at(crate::wire::LATEST)
    }

    /// The hello / grant list rules at `version`: below /14 the v2 names are unknown fields.
    pub fn problem_at(&self, version: u8) -> Option<&'static str> {
        let known = if version >= V2_VERSION { FIELDS.len() } else { 4 };
        let mut last = None;
        for f in &self.fields {
            match FIELDS[..known].iter().position(|x| x == f) {
                Some(i) if last.is_none_or(|l| i > l) => last = Some(i),
                _ if known == 4 => return Some("\"fields\" is not a subset of class, script, scene, path in that order without duplicates"),
                _ => return Some("\"fields\" is not a subset of class, script, scene, path, instance_id, mouse_filter in that order without duplicates"),
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

    /// ID3: whether the request or grant names an item_meta v2 field (a /14-only grant).
    pub fn has_v2(&self) -> bool {
        self.fields.iter().any(|f| V2_FIELDS.contains(&f.as_str()))
    }

    /// Parses `{"fields":[..],"groups":[..],"meta_keys":[..]}` (key order free) and checks it
    /// against the newest version's rules (a request is version-free: a /13 viewer never names a
    /// v2 field, and a /13 grant that does fails [`check_record`]).
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

/// One column of a node row, as the record holds it (its type is checked against the grant).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ItemMetaCol {
    Null,
    /// A string index, the groups bitmask, or (/14) a `mouse_filter` value; a non-negative
    /// integer clamped to `u32::MAX`.
    Uint(u32),
    /// ID3 (/14 only): an inline string, which only the `instance_id` column holds.
    Str(Box<str>),
}

impl ItemMetaCol {
    /// The integer, `None` for null or a string.
    pub fn uint(&self) -> Option<u32> {
        match self {
            ItemMetaCol::Uint(x) => Some(*x),
            _ => None,
        }
    }

    /// The inline string, `None` for null or an integer.
    pub fn str(&self) -> Option<&str> {
        match self {
            ItemMetaCol::Str(s) => Some(s),
            _ => None,
        }
    }

    fn to_json(&self) -> J {
        match self {
            ItemMetaCol::Null => J::Null,
            ItemMetaCol::Uint(x) => json!(x),
            ItemMetaCol::Str(s) => J::String(s.to_string()),
        }
    }
}

/// One item's row.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ItemMetaRow {
    /// `[id]`: the item has no node (a quadrant, a viewport internal).
    NoNode,
    /// The columns after the id, in wire order: per granted field a string index (null, or at /14
    /// the `instance_id` string and the `mouse_filter` int), the groups bitmask when groups are
    /// granted, then per meta key a string index. Read them through [`ItemMetaTable`]'s
    /// accessors.
    Node(Box<[ItemMetaCol]>),
}

impl ItemMetaRow {
    /// The wire row `[id, col..]`.
    pub fn to_json(&self, id: Id) -> J {
        let mut row = vec![json!(id)];
        if let ItemMetaRow::Node(c) = self {
            row.extend(c.iter().map(ItemMetaCol::to_json));
        }
        J::Array(row)
    }
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

    fn cell(&self, id: Id, col: Option<usize>) -> Option<&ItemMetaCol> {
        match self.rows.get(&id)? {
            ItemMetaRow::Node(c) => c.get(col?),
            ItemMetaRow::NoNode => None,
        }
    }

    fn col(&self, id: Id, col: Option<usize>) -> Option<u32> {
        self.cell(id, col)?.uint()
    }

    /// A granted field's value (`class`, `script`, `scene` or `path`) of item `id`.
    pub fn field(&self, id: Id, field: &str) -> Option<&str> {
        let g = self.grant.as_ref()?;
        let i = self.col(id, g.field_column(field))?;
        self.strings.get(i as usize).map(String::as_str)
    }

    /// ID3 (/14): item `id`'s Godot `ObjectID` as its inline decimal string, when `instance_id`
    /// is granted and the row has one.
    pub fn instance_id(&self, id: Id) -> Option<&str> {
        let g = self.grant.as_ref()?;
        self.cell(id, g.field_column("instance_id"))?.str()
    }

    /// ID3 (/14): [`ItemMetaTable::instance_id`] as a `u64` (`None` also for a 20-digit value
    /// past `u64::MAX`, which the wire's `^[1-9][0-9]{0,19}$` admits but no `ObjectID` is).
    pub fn instance_id_u64(&self, id: Id) -> Option<u64> {
        self.instance_id(id)?.parse().ok()
    }

    /// ID3 (/14): item `id`'s `mouse_filter` (0..6: the low two bits
    /// `get_mouse_filter_with_override()`, bit 4 a script `_has_point`), when granted and the
    /// node is a Control.
    pub fn mouse_filter(&self, id: Id) -> Option<u8> {
        let g = self.grant.as_ref()?;
        self.col(id, g.field_column("mouse_filter"))
            .map(|x| x as u8)
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
    /// (`groups` and `meta` only when granted). ID3: `instance_id` is its inline string or null
    /// and `mouse_filter` its int or null.
    pub fn row_json(&self, row: &ItemMetaRow) -> J {
        let (ItemMetaRow::Node(c), Some(g)) = (row, self.grant.as_ref()) else {
            return J::Null;
        };
        let s = |k: usize| -> J {
            c.get(k)
                .and_then(ItemMetaCol::uint)
                .and_then(|i| self.strings.get(i as usize))
                .map_or(J::Null, |x| J::String(x.clone()))
        };
        let mut o = serde_json::Map::new();
        for (k, f) in g.fields.iter().enumerate() {
            let v = match f.as_str() {
                "instance_id" | "mouse_filter" => c.get(k).map_or(J::Null, ItemMetaCol::to_json),
                _ => s(k),
            };
            o.insert(f.clone(), v);
        }
        if let Some(k) = g.groups_column() {
            o.insert("groups".into(), json!(c.get(k).and_then(ItemMetaCol::uint)));
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

/// ID3: `^[1-9][0-9]{0,19}$`, an `instance_id` column's string.
pub fn instance_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=20).contains(&b.len()) && (b'1'..=b'9').contains(&b[0]) && b.iter().all(u8::is_ascii_digit)
}

/// Row shape against a grant: each row `[id]` or one column per granted column, the groups
/// column a mask below `2^|groups|`, (/14) the `instance_id` column a decimal string
/// ([`instance_id_ok`]) or null and the `mouse_filter` column an int in 0..6 or null, and every
/// other column null or an integer (a string index). `Err(detail)` for `item-meta-schema`.
pub fn check_rows(items: &[(Id, ItemMetaRow)], grant: &ItemMetaGrant) -> Result<(), String> {
    let n = grant.columns();
    let gc = grant.groups_column();
    let ic = grant.field_column("instance_id");
    let mc = grant.field_column("mouse_filter");
    for (id, row) in items {
        let ItemMetaRow::Node(c) = row else { continue };
        if c.len() != n {
            return Err(format!(
                "item {id}'s row has {} columns, the grant {n}",
                c.len()
            ));
        }
        for (k, v) in c.iter().enumerate() {
            let bad = if Some(k) == gc {
                let ok = v
                    .uint()
                    .is_some_and(|m| (m as u64) < (1u64 << grant.groups.len()));
                if !ok {
                    return Err(format!(
                        "item {id}'s groups column is not a bitmask below 2^{}",
                        grant.groups.len()
                    ));
                }
                None
            } else if Some(k) == ic {
                let ok = matches!(v, ItemMetaCol::Null) || v.str().is_some_and(instance_id_ok);
                (!ok).then_some("instance_id column is neither null nor a decimal string matching ^[1-9][0-9]{0,19}$")
            } else if Some(k) == mc {
                let ok = matches!(v, ItemMetaCol::Null)
                    || v.uint().is_some_and(|x| x <= MAX_MOUSE_FILTER);
                (!ok).then_some("mouse_filter column is neither null nor an integer in 0..6")
            } else {
                v.str()
                    .map(|_| "string-index column holds an inline string")
            };
            if let Some(why) = bad {
                return Err(format!("item {id}'s {why}"));
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
    let skip = [
        grant.groups_column(),
        grant.field_column("instance_id"),
        grant.field_column("mouse_filter"),
    ];
    for (id, row) in items {
        let ItemMetaRow::Node(c) = row else { continue };
        for (k, v) in c.iter().enumerate() {
            if skip.contains(&Some(k)) {
                continue;
            }
            if let Some(i) = v.uint() {
                if i as u64 >= size {
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

fn grant_of(ck: &mut Ck, v: Value, version: u8) -> Result<ItemMetaGrant, String> {
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
    match g.problem_at(version) {
        Some(p) => Err(format!("grant: {p}")),
        None => Ok(g),
    }
}

/// `decodeRecord`'s `item_meta` checks (only called from /13 on): the shape (`item-meta-schema`)
/// and, for a `full` (whose grant is in the record), the row columns against it and `strings_from`
/// 0 and every string index in range (`item-meta-string`). A `delta`'s rows are read against the
/// stream's grant by the validator. ID3: at /14 a grant may name the v2 fields and a column may
/// be a string (the grant decides which may); below /14 neither.
pub(crate) fn check_record(
    ck: &mut Ck,
    meta: Value,
    version: u8,
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
        Some(grant_of(ck, f.at(2), version).map_err(|d| schema(ck, &d))?)
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
                cols.push(ItemMetaCol::Null);
            } else if let Some(x) = uint_clamped(ck, c) {
                cols.push(ItemMetaCol::Uint(x));
            } else if let Some(s) = ck.string(c).filter(|_| version >= V2_VERSION) {
                cols.push(ItemMetaCol::Str(String::from_utf8_lossy(s).into()));
            } else if version >= V2_VERSION {
                return Err(schema(
                    ck,
                    &format!("item {id}'s row holds a column that is neither null, a non-negative integer nor a string"),
                ));
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

// --------------------------------------------------------------------------- ID3 transcode

const PROTOCOL_13: &[u8] = b"\"protocol\":\"render-stream/13\"";
const PROTOCOL_14: &[u8] = b"\"protocol\":\"render-stream/14\"";

/// ID3: a recording at version `from` re-stamped `to`: the magic and the session's `protocol`,
/// every other byte as it is (render-stream-14.md: /13 re-stamped /14 is the /14 stream of the
/// same records, valid exactly when the /13 one is; a /14 stream with no v2 grant re-stamped /13
/// is its /13 stream). Not validated.
pub fn restamp(data: &[u8], from: u8, to: u8) -> Result<Vec<u8>, Error> {
    let spans = crate::wire::split_records(data, from)?;
    let key = |v: u8| format!("\"protocol\":\"{}\"", crate::wire::protocol(v));
    let (old, new) = (key(from), key(to));
    let mut out = crate::wire::magic(to).to_vec();
    out.reserve(data.len());
    for (i, span) in spans.iter().enumerate() {
        if i == 0 {
            crate::predict::swap_protocol(span.bytes(data), old.as_bytes(), new.as_bytes(), &mut out)?;
        } else {
            out.extend_from_slice(span.bytes(data));
        }
    }
    Ok(out)
}

/// ID3: a /13 recording re-stamped /14 ([`restamp`]).
pub fn to14_from13(data13: &[u8]) -> Result<Vec<u8>, Error> {
    restamp(data13, 13, 14)
}

/// ID3 `rs-core-check transcode --to 13` from /14 (render-stream-14.md "Tools"): validates the
/// input (its first error is returned) and writes the /13 stream of it. The v2 columns and grant
/// names are dropped; a `full` whose grant is left empty is dropped with every delta after it; a
/// re-stamped delta row that equals the held row after the drop is dropped, and a delta left with
/// no rows (and no strings) is dropped. The end record's stats follow, as `to12`'s do.
pub fn to13_from14(data14: &[u8]) -> Result<Vec<u8>, Error> {
    use crate::validate::{Accepted, Options, Validator};
    let spans = crate::wire::split_records(data14, 14)?;
    let first = spans
        .first()
        .ok_or_else(|| Error::new("missing-session", "the recording has no records"))?;
    let mut v = Validator::new(first.bytes(data14), first.offset, Options::new(14))?;
    let mut out = crate::wire::magic(13).to_vec();
    out.reserve(data14.len());
    crate::predict::swap_protocol(first.bytes(data14), PROTOCOL_14, PROTOCOL_13, &mut out)?;
    let mut out_lens = vec![out.len() - crate::wire::MAGIC_LEN];
    let mut in_lens = vec![first.bytes(data14).len()];
    let mut dropping = false;
    for span in &spans[1..] {
        let rec = span.bytes(data14);
        let at = out.len();
        match v.accept(rec, span.offset)? {
            Accepted::ItemMeta => {
                let p = v
                    .item_meta_pending()
                    .expect("an accepted item_meta record is pending");
                if let Some(meta) = project_13(p, v.item_meta(), &mut dropping) {
                    // Display is the compact (canonical) form; it shares the goldens' serializer.
                    let meta = meta.to_string().into_bytes();
                    let meta_len = crate::wire::le_u32(rec, 4) as usize;
                    crate::predict::make_record(&mut out, &[&meta], &rec[8 + meta_len..]);
                }
            }
            Accepted::End => crate::predict::fix_end(rec, &out_lens, &in_lens, &mut out),
            Accepted::Transaction | Accepted::Resource { .. } => out.extend_from_slice(rec),
        }
        out_lens.push(out.len() - at);
        in_lens.push(rec.len());
    }
    v.finish()?;
    Ok(out)
}

/// The /13 projection of a pending /14 record against the table it lands on (`None`: dropped).
/// `dropping` is whether the stream's grant has nothing left at /13 (set by each `full`).
fn project_13(p: &ItemMetaRecord, held: &ItemMetaTable, dropping: &mut bool) -> Option<J> {
    let g = if p.full { p.grant.as_ref() } else { held.grant.as_ref() }?;
    let keep: Vec<usize> = (0..g.columns())
        .filter(|&k| {
            k >= g.fields.len() || !V2_FIELDS.contains(&g.fields[k].as_str())
        })
        .collect();
    let g13 = ItemMetaGrant {
        fields: g
            .fields
            .iter()
            .filter(|f| !V2_FIELDS.contains(&f.as_str()))
            .cloned()
            .collect(),
        groups: g.groups.clone(),
        meta_keys: g.meta_keys.clone(),
    };
    if p.full {
        *dropping = g13.columns() == 0;
    }
    if *dropping {
        return None;
    }
    let project = |row: &ItemMetaRow| match row {
        ItemMetaRow::NoNode => ItemMetaRow::NoNode,
        ItemMetaRow::Node(c) => ItemMetaRow::Node(keep.iter().map(|&k| c[k].clone()).collect()),
    };
    let mut items = Vec::with_capacity(p.items.len());
    for (id, row) in &p.items {
        let r13 = project(row);
        if !p.full && held.rows.get(id).is_some_and(|h| project(h) == r13) {
            continue;
        }
        items.push(r13.to_json(*id));
    }
    if !p.full && items.is_empty() && p.strings.is_empty() {
        return None;
    }
    Some(json!({
        "type": "item_meta",
        "form": if p.full { "full" } else { "delta" },
        "grant": if p.full { g13.to_json() } else { J::Null },
        "strings_from": p.strings_from,
        "strings": p.strings,
        "items": items,
        "blocks": [],
    }))
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
        // ID3: the v2 names, in order, after the /13 ones; a /13 grant may not name them.
        let r = ok(r#"{"fields":["class","path","instance_id","mouse_filter"],"groups":[],"meta_keys":[]}"#).unwrap();
        assert!(r.has_v2() && r.problem_at(14).is_none() && r.problem_at(13).is_some());
        assert!(ok(r#"{"fields":["mouse_filter","instance_id"],"groups":[],"meta_keys":[]}"#).is_err());
        assert!(ok(r#"{"fields":["instance_id","class"],"groups":[],"meta_keys":[]}"#).is_err());
    }

    fn v2_request() -> ItemMetaRequest {
        ItemMetaRequest {
            fields: FIELDS.iter().map(|f| f.to_string()).collect(),
            groups: vec!["rs_hand".into(), "rs_ui".into()],
            meta_keys: vec!["rs_tag".into()],
        }
    }

    /// Validates `data` at `version` and returns the validator after `finish`, with the table
    /// as it stood after each transaction (by seq).
    fn tables(data: &[u8], version: u8, ask: ItemMetaAsk) -> BTreeMap<i64, ItemMetaTable> {
        let spans = wire::split_records(data, version).unwrap();
        let opts = Options {
            item_meta: ask,
            ..Options::new(version)
        };
        let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, opts).unwrap();
        let mut out = BTreeMap::new();
        for s in &spans[1..] {
            if v.accept(s.bytes(data), s.offset).unwrap() == Accepted::Transaction {
                out.insert(v.state().seq, v.item_meta().clone());
            }
        }
        v.finish().unwrap();
        out
    }

    /// ID3: item-meta-v2.rs14's v2 columns through the table's accessors, re-stamps replacing
    /// the held row at receipt and later fulls carrying the re-stamped value.
    #[test]
    fn v2_columns_and_restamps() {
        let data = protocol("golden-14/item-meta-v2.rs14");
        let t = tables(&data, 14, ItemMetaAsk::Asked(v2_request()));
        let at = |seq: i64| &t[&seq];
        let first = at(1);
        assert_eq!(first.instance_id(1), Some("30001000003"));
        assert_eq!(first.instance_id_u64(1), Some(30_001_000_003));
        assert_eq!(first.instance_id(5), Some("18446744073709551615"));
        assert_eq!(first.instance_id_u64(5), Some(u64::MAX));
        assert_eq!(first.mouse_filter(1), Some(1));
        assert_eq!(first.mouse_filter(2), None, "Sprite2D: not a Control");
        assert_eq!(first.instance_id(3), None, "no node");
        assert_eq!(first.field(1, "class"), Some("Label"));
        assert_eq!(at(9).instance_id(10), None);
        assert_eq!(at(9).mouse_filter(12), Some(0));
        assert_eq!(at(4).mouse_filter(7), Some(5), "_has_point");
        assert_eq!(first.mouse_filter(5), Some(6), "_has_point");
        assert_eq!(at(9).mouse_filter(14), None, "Sprite2D");
        assert_eq!(at(11).mouse_filter(7), Some(5));
        assert_eq!(at(12).mouse_filter(7), Some(4), "re-stamped before seq 12");
        assert_eq!(at(16).mouse_filter(7), Some(4), "a later full carries the re-stamp");
        assert_eq!(at(16).mouse_filter(1), Some(1));
        assert_eq!(at(17).mouse_filter(1), Some(2), "re-stamped before seq 17");
        assert_eq!(at(17).field(1, "class"), Some("Label"));
        assert_eq!(at(26).mouse_filter(1), Some(2));
        // The same rows in a /13 stream: the v2 grant is item-meta-schema at the first full.
        let e = validate_recording(&to13_stamp(&data), Options::new(13)).unwrap_err();
        assert_eq!(e.code, "item-meta-schema", "{e}");
    }

    /// `data` (a /14 file) stamped /13, every record as it is.
    fn to13_stamp(data: &[u8]) -> Vec<u8> {
        restamp(data, 14, 13).unwrap()
    }

    /// ID3: a re-stamp at /13 is the upsert /13 always did (unchanged): a delta row for a held
    /// id replaces it.
    #[test]
    fn a_13_delta_row_for_a_held_id_replaces_it() {
        let data = protocol("golden-13/item-meta.rs13");
        let spans = wire::split_records(&data, 13).unwrap();
        let opts = Options::new(13);
        let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, opts).unwrap();
        for s in &spans[1..] {
            let rec = s.bytes(&data);
            let meta = wire::frame(rec, s.offset).unwrap().meta;
            let tx: J = serde_json::from_slice(meta).unwrap();
            if tx["type"] == "transaction" && tx["seq"] == 12 {
                // Item 2's row with its class string index swapped (to item 1's).
                let n = v.item_meta().strings.len();
                let row1 = v.item_meta().rows[&1].to_json(1);
                let mut row2 = v.item_meta().rows[&2].to_json(2);
                row2[1] = row1[1].clone();
                let r = format!(r#"{{"type":"item_meta","form":"delta","grant":null,"strings_from":{n},"strings":[],"items":[{row2}],"blocks":[]}}"#);
                assert_eq!(v.accept(&record(&r), s.offset).unwrap(), Accepted::ItemMeta);
                v.accept(rec, s.offset).unwrap();
                assert_eq!(v.item_meta().field(2, "class"), v.item_meta().field(1, "class"));
                return;
            }
            v.accept(rec, s.offset).unwrap();
        }
        panic!("no seq 12");
    }

    /// ID3 transcode --to 13: golden-14's lanes go to their /13 twins, and back by re-stamp.
    #[test]
    fn transcode_to_13() {
        let v2 = protocol("golden-14/item-meta-v2.rs14");
        let got = to13_from14(&v2).unwrap();
        assert!(got == protocol("golden-14/item-meta-v2.rs13"));
        validate_recording(&got, Options::new(13)).unwrap();
        let v1 = protocol("golden-14/item-meta.rs14");
        assert!(to13_from14(&v1).unwrap() == protocol("golden-13/item-meta.rs13"));
        assert!(to14_from13(&protocol("golden-13/item-meta.rs13")).unwrap() == v1);
        // An invalid /14 input is refused with its code.
        let bad = protocol("golden-14/invalid/item-meta-v2-mouse-filter-7.rs14");
        assert_eq!(to13_from14(&bad).unwrap_err().code, "item-meta-schema");
    }

    /// ID3: a grant of v2 fields only leaves nothing at /13: every record is dropped and the /13
    /// stream is patch.rs13 byte for byte (the end record's stats follow).
    #[test]
    fn transcode_drops_an_all_v2_grant() {
        let patch = protocol("golden-14/patch.rs14");
        let spans = wire::split_records(&patch, 14).unwrap();
        // Pass 1: each full transaction's target items.
        let mut v = Validator::new(spans[0].bytes(&patch), spans[0].offset, Options::new(14))
            .unwrap();
        let mut full_items: BTreeMap<usize, Vec<Id>> = BTreeMap::new();
        for (i, s) in spans.iter().enumerate().skip(1) {
            if v.accept(s.bytes(&patch), s.offset).unwrap() == Accepted::Transaction
                && v.state().seq > 0
            {
                let meta: J =
                    serde_json::from_slice(wire::frame(s.bytes(&patch), s.offset).unwrap().meta)
                        .unwrap();
                if meta["encoding"] == "full" {
                    let mut ids: Vec<Id> = v.state().items.keys().copied().collect();
                    ids.sort();
                    full_items.insert(i, ids);
                }
            }
        }
        // Pass 2: a full {"fields":["instance_id","mouse_filter"]} before each full.
        let mut out = wire::magic(14).to_vec();
        let (mut in_lens, mut out_lens) = (Vec::new(), Vec::new());
        for (i, s) in spans.iter().enumerate() {
            let rec = s.bytes(&patch);
            if let Some(ids) = full_items.get(&i) {
                let rows: Vec<String> = ids
                    .iter()
                    .map(|id| format!(r#"[{id},"{}",{}]"#, 1000 + id, id % 3))
                    .collect();
                let r = record(&format!(r#"{{"type":"item_meta","form":"full","grant":{{"fields":["instance_id","mouse_filter"],"groups":[],"meta_keys":[]}},"strings_from":0,"strings":[],"items":[{}],"blocks":[]}}"#, rows.join(",")));
                out_lens.push(r.len());
                out.extend(r);
            }
            if i == spans.len() - 1 {
                let at = out.len();
                crate::predict::fix_end(rec, &out_lens, &in_lens, &mut out);
                out_lens.push(out.len() - at);
            } else {
                out.extend_from_slice(rec);
                out_lens.push(rec.len());
            }
            in_lens.push(rec.len());
        }
        let t = tables(&out, 14, ItemMetaAsk::Asked(v2_request()));
        assert_eq!(t[&1].mouse_filter(2), Some(2));
        assert!(to13_from14(&out).unwrap() == protocol("golden-13/patch.rs13"));
    }
}
