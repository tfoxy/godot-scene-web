//! Announced /17 tweens. Host state stays authoritative; only the applier's local display
//! components change. The clock is anchored by pictures, never by message arrival.
use crate::{
    state::{Id, Item, ResolvedState},
    wire::{self, Error},
};
use serde_json::Value as J;
use std::collections::BTreeMap;

pub mod material;

pub const MAX_INT: i64 = (1i64 << 53) - 1;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Node2d,
    Control,
}
#[derive(Clone, Debug)]
pub struct Pose {
    pub item: Id,
    pub kind: Kind,
    pub values: [f32; 16],
}
#[derive(Clone, Debug)]
pub struct Step {
    pub components: Vec<usize>,
    pub start: i64,
    pub duration: i64,
    pub trans: u8,
    pub ease: u8,
    pub from: Option<Vec<f32>>,
    pub to: Vec<f32>,
}
#[derive(Clone, Debug)]
pub struct Begin {
    pub id: i64,
    pub item: Id,
    pub order: i64,
    pub begin: i64,
    pub end: i64,
    pub steps: Vec<Step>,
}
#[derive(Clone, Debug)]
pub enum Event {
    Begin(Begin),
    MaterialBegin(material::Begin),
    Cancel(i64),
}
#[derive(Clone, Debug)]
pub struct Record {
    pub seq: i64,
    pub frame: i64,
    pub time: i64,
    pub events: Vec<Event>,
    pub poses: Vec<Pose>,
}
fn err(code: &'static str, message: &str) -> Error {
    Error::new(code, message)
}
fn keys(j: &J, expected: &[&str]) -> Result<(), Error> {
    if j.as_object()
        .is_some_and(|m| m.keys().map(String::as_str).eq(expected.iter().copied()))
    {
        Ok(())
    } else {
        Err(err("meta-schema", "tween keys or order"))
    }
}
fn int(j: &J, min: i64) -> Result<i64, Error> {
    j.as_i64()
        .filter(|&n| n >= min && n <= MAX_INT)
        .ok_or_else(|| err("meta-schema", "tween integer range"))
}
fn id(j: &J) -> Result<Id, Error> {
    u32::try_from(int(j, 1)?).map_err(|_| err("meta-schema", "tween item id"))
}
fn tween_id(j: &J) -> Result<i64, Error> {
    let s = j
        .as_str()
        .ok_or_else(|| err("meta-schema", "tween_id string"))?;
    s.parse::<i64>()
        .ok()
        .filter(|n| n.to_string() == s)
        .ok_or_else(|| err("meta-schema", "tween_id range or spelling"))
}
fn array(j: &J) -> Result<&Vec<J>, Error> {
    j.as_array()
        .ok_or_else(|| err("meta-schema", "tween array"))
}
pub fn components(s: &str) -> Option<Vec<usize>> {
    let (base, component) = s.split_once(':').map_or((s, None), |(a, b)| (a, Some(b)));
    let range = match base {
        "position" => 0..2,
        "rotation" => 2..3,
        "scale" => 3..5,
        "skew" => 5..6,
        "modulate" => 8..12,
        "self_modulate" => 12..16,
        _ => return None,
    };
    match component {
        None => Some(range.collect()),
        Some(c) => {
            let k = match base {
                "position" | "scale" => match c {
                    "x" => 0,
                    "y" => 1,
                    _ => return None,
                },
                "modulate" | "self_modulate" => match c {
                    "r" => 0,
                    "g" => 1,
                    "b" => 2,
                    "a" => 3,
                    _ => return None,
                },
                _ => return None,
            };
            Some(vec![range.start + k])
        }
    }
}
/// Validate all /19 scalar schema before looking at endpoint bytes. The validator also uses
/// the header to associate a record whose float/timing error must wait for its transaction.
pub(crate) fn schema19(bytes: &[u8], offset: usize) -> Result<Record, Error> {
    let f = wire::frame(bytes, offset)?;
    let j: J = serde_json::from_slice(f.meta).map_err(|_| err("meta-json", "tween JSON"))?;
    keys(
        &j,
        &["type", "seq", "frame", "t_us", "events", "poses", "blocks"],
    )?;
    if j["type"] != "tween" {
        return Err(err("meta-schema", "tween type"));
    }
    if serde_json::to_vec(&j).unwrap() != f.meta {
        return Err(err("meta-noncanonical", "tween JSON"));
    }
    let header = Record {
        seq: int(&j["seq"], 1)?,
        frame: int(&j["frame"], 1)?,
        time: int(&j["t_us"], 0)?,
        events: vec![],
        poses: vec![],
    };
    for e in array(&j["events"])? {
        match e["op"].as_str() {
            Some("cancel") => {
                keys(e, &["op", "tween_id"])?;
                tween_id(&e["tween_id"])?;
            }
            Some("begin") if e.get("material").is_some() => {
                material::decode_begin(e)?;
            }
            Some("begin") => {
                keys(
                    e,
                    &[
                        "op", "tween_id", "item", "order", "begin_us", "end_us", "steps",
                    ],
                )?;
                tween_id(&e["tween_id"])?;
                id(&e["item"])?;
                int(&e["order"], 1)?;
                int(&e["begin_us"], 0)?;
                int(&e["end_us"], 0)?;
                for step in array(&e["steps"])? {
                    keys(
                        step,
                        &[
                            "property",
                            "start_us",
                            "duration_us",
                            "trans",
                            "ease",
                            "from",
                            "to",
                        ],
                    )?;
                    if step["property"].as_str().and_then(components).is_none()
                        || int(&step["trans"], 0)? > 11
                        || int(&step["ease"], 0)? > 3
                    {
                        return Err(err("meta-schema", "tween property or easing"));
                    }
                    int(&step["start_us"], 0)?;
                    int(&step["duration_us"], 0)?;
                    if !step["from"].is_null() {
                        int(&step["from"], 0)?;
                    }
                    int(&step["to"], 0)?;
                }
            }
            _ => return Err(err("meta-schema", "tween event")),
        }
    }
    for pose in array(&j["poses"])? {
        keys(pose, &["item", "kind", "f"])?;
        id(&pose["item"])?;
        int(&pose["f"], 0)?;
        if pose["kind"] != "node2d" && pose["kind"] != "control" {
            return Err(err("meta-schema", "tween node kind"));
        }
    }
    for b in array(&j["blocks"])? {
        keys(b, &["name", "type", "count"])?;
        if b["name"] != "tween_f32" || b["type"] != "f32" {
            return Err(err("meta-schema", "tween block"));
        }
        int(&b["count"], 1)?;
    }
    Ok(header)
}

/// Decode all values before publishing a record. Offsets must consume one contiguous float arena.
pub fn decode(
    bytes: &[u8],
    offset: usize,
    bufs: &mut crate::meta::DecodeBufs,
) -> Result<Record, Error> {
    decode_version(bytes, offset, 17, bufs)
}

pub fn decode_version(
    bytes: &[u8],
    offset: usize,
    version: u8,
    bufs: &mut crate::meta::DecodeBufs,
) -> Result<Record, Error> {
    if version >= 19 {
        schema19(bytes, offset)?;
    }
    let f = wire::frame(bytes, offset)?;
    let j: J = serde_json::from_slice(f.meta).map_err(|_| err("meta-json", "tween JSON"))?;
    keys(
        &j,
        &["type", "seq", "frame", "t_us", "events", "poses", "blocks"],
    )?;
    if serde_json::to_vec(&j).unwrap() != f.meta {
        return Err(err("meta-noncanonical", "tween JSON"));
    }
    let mut r = Record {
        seq: int(&j["seq"], 1)?,
        frame: int(&j["frame"], 1)?,
        time: int(&j["t_us"], 0)?,
        events: vec![],
        poses: vec![],
    };
    let blocks = array(&j["blocks"])?;
    bufs.descs.clear();
    for b in blocks {
        keys(b, &["name", "type", "count"])?;
        if b["name"] != "tween_f32" || b["type"] != "f32" {
            return Err(err("meta-schema", "tween block"));
        }
        bufs.descs.push(wire::BlockDesc {
            ty: wire::BlockType::F32,
            count: int(&b["count"], 1)? as u64,
        });
    }
    if blocks.len() > 1 {
        return Err(err("tween-offset", "extra tween block"));
    }
    wire::read_blocks(
        bytes,
        &f,
        &bufs.descs,
        &|_| "tween_f32".into(),
        offset,
        false,
        &mut bufs.blocks,
    )
    .map_err(|e| {
        if e.code == "block-length" || e.code == "record-length" || e.code == "truncated" {
            err("tween-offset", &e.detail)
        } else {
            e
        }
    })?;
    let floats = bufs
        .blocks
        .first()
        .map_or(&[][..], |b| &bytes[b.start..b.start + b.len]);
    let fs = wire::F32s(floats);
    let mut next = 0usize;
    let mut take = |at: &J, n: usize| -> Result<Vec<f32>, Error> {
        if int(at, 0)? as u64 != next as u64 || next + n > fs.len() {
            return Err(err("tween-offset", "noncontiguous tween floats"));
        }
        let out = (next..next + n).map(|i| fs.get(i)).collect::<Vec<_>>();
        next += n;
        if out.iter().any(|v| !v.is_finite()) {
            return Err(err("tween-offset", "nonfinite tween float"));
        }
        Ok(out)
    };
    let mut material_events = Vec::new();
    for e in array(&j["events"])? {
        match e["op"].as_str() {
            Some("cancel") => {
                keys(e, &["op", "tween_id"])?;
                r.events.push(Event::Cancel(tween_id(&e["tween_id"])?));
            }
            Some("begin") if e.get("material").is_some() => {
                if version < 19 {
                    return Err(err("meta-schema", "material tween below /19"));
                }
                // Phase three consumes these endpoints after all node poses.
                let b = material::decode_begin(e)?;
                material_events.push((r.events.len(), e));
                r.events.push(Event::MaterialBegin(b));
            }
            Some("begin") => {
                keys(
                    e,
                    &[
                        "op", "tween_id", "item", "order", "begin_us", "end_us", "steps",
                    ],
                )?;
                let mut b = Begin {
                    id: tween_id(&e["tween_id"])?,
                    item: id(&e["item"])?,
                    order: int(&e["order"], 1)?,
                    begin: int(&e["begin_us"], 0)?,
                    end: int(&e["end_us"], 0)?,
                    steps: vec![],
                };
                for s in array(&e["steps"])? {
                    keys(
                        s,
                        &[
                            "property",
                            "start_us",
                            "duration_us",
                            "trans",
                            "ease",
                            "from",
                            "to",
                        ],
                    )?;
                    let c = s["property"]
                        .as_str()
                        .and_then(components)
                        .ok_or_else(|| err("meta-schema", "tween property"))?;
                    let trans = int(&s["trans"], 0)?;
                    let ease = int(&s["ease"], 0)?;
                    if trans > 11 || ease > 3 {
                        return Err(err("meta-schema", "tween easing"));
                    }
                    let from = if s["from"].is_null() {
                        None
                    } else {
                        Some(take(&s["from"], c.len())?)
                    };
                    let to = take(&s["to"], c.len())?;
                    b.steps.push(Step {
                        components: c,
                        start: int(&s["start_us"], 0)?,
                        duration: int(&s["duration_us"], 0)?,
                        trans: trans as u8,
                        ease: ease as u8,
                        from,
                        to,
                    });
                }
                r.events.push(Event::Begin(b));
            }
            _ => return Err(err("meta-schema", "tween event")),
        }
    }
    let mut last = 0;
    for p in array(&j["poses"])? {
        keys(p, &["item", "kind", "f"])?;
        let item = id(&p["item"])?;
        if version < 19 && item <= last {
            return Err(err("tween-entry", "tween poses not ascending"));
        }
        last = item;
        let kind = match p["kind"].as_str() {
            Some("node2d") => Kind::Node2d,
            Some("control") => Kind::Control,
            _ => return Err(err("meta-schema", "tween node kind")),
        };
        let values: [f32; 16] = take(&p["f"], 16)?.try_into().unwrap();
        if (kind == Kind::Node2d && (values[6] != 0. || values[7] != 0.))
            || (kind == Kind::Control && values[5] != 0.)
        {
            return Err(err("tween-offset", "tween fixed component"));
        }
        r.poses.push(Pose { item, kind, values });
    }
    for (index, e) in material_events {
        let Event::MaterialBegin(b) = &mut r.events[index] else {
            unreachable!()
        };
        for (s, raw) in b.steps.iter_mut().zip(array(&e["steps"])?) {
            s.value.from = if raw["from"].is_null() {
                None
            } else {
                Some(take(&raw["from"], s.value.components.len())?)
            };
            s.value.to = take(&raw["to"], s.value.components.len())?;
        }
    }
    if next != fs.len() || (r.events.is_empty() && r.poses.is_empty()) {
        return Err(err("tween-offset", "unused tween floats or empty record"));
    }
    if version >= 19 {
        for e in &r.events {
            let (begin, steps): (i64, Vec<&Step>) = match e {
                Event::Begin(b) => (b.begin, b.steps.iter().collect()),
                Event::MaterialBegin(b) => (b.begin, b.steps.iter().map(|s| &s.value).collect()),
                Event::Cancel(_) => continue,
            };
            if begin > r.time {
                return Err(err("tween-time", "future begin"));
            }
            for step in steps {
                if begin
                    .checked_add(step.start)
                    .and_then(|v| v.checked_add(step.duration))
                    .is_none_or(|v| v > MAX_INT)
                {
                    return Err(err("tween-time", "tween timing overflow"));
                }
            }
        }
        if r.poses.windows(2).any(|p| p[0].item >= p[1].item) {
            return Err(err("tween-entry", "tween poses not ascending"));
        }
    }
    for e in &r.events {
        if let Event::MaterialBegin(b) = e {
            material::check_time(b, r.time)?;
        }
        if let Event::Begin(b) = e {
            if b.begin > r.time {
                return Err(err("tween-time", "future begin"));
            }
            let mut end = 0;
            for s in &b.steps {
                let sum = b
                    .begin
                    .checked_add(s.start)
                    .and_then(|n| n.checked_add(s.duration))
                    .filter(|&n| n <= MAX_INT)
                    .ok_or_else(|| err("tween-time", "tween timing overflow"))?;
                end = end.max(sum);
            }
            if b.steps.is_empty() || b.end != end {
                return Err(err("tween-entry", "empty steps or inconsistent end"));
            }
            let p = r
                .poses
                .iter()
                .find(|p| p.item == b.item)
                .ok_or_else(|| err("tween-entry", "begin missing pose"))?;
            if p.kind == Kind::Control && b.steps.iter().any(|s| s.components.contains(&5)) {
                return Err(err("tween-entry", "Control skew"));
            }
        }
    }
    Ok(r)
}

#[derive(Default, Clone, Debug)]
pub struct Diagnostics {
    pub begins: u64,
    pub cancels: u64,
    pub claims_replaced: u64,
    pub completed: u64,
    pub retired_unowned: u64,
    pub unknown_cancels: u64,
    pub backward_anchor_holds: u64,
    pub tween_redraws: u64,
    pub material_begins: u64,
    pub material_retired: u64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub xform: [f32; 6],
    pub modulate: [f32; 4],
    pub self_modulate: [f32; 4],
}
impl Display {
    pub fn host(i: &Item) -> Self {
        Self {
            xform: i.xform,
            modulate: i.modulate,
            self_modulate: i.self_modulate,
        }
    }
}
#[derive(Debug)]
struct Live {
    b: Begin,
    owned: [bool; 16],
    now: f64,
    from: Vec<Option<Vec<f32>>>,
    started: Vec<bool>,
    values: [Option<f32>; 16],
    initial: Option<[f32; 16]>,
}
impl Live {
    fn evaluate(&mut self, order: &[usize], time: f64) {
        for &i in order {
            if !self.started[i] {
                continue;
            }
            let step = &self.b.steps[i];
            let elapsed = time - self.b.begin as f64 - step.start as f64;
            if elapsed < 0. {
                continue;
            }
            let u = if step.duration == 0 {
                1.
            } else {
                elapsed / step.duration as f64
            };
            let eased = ease_sample(step.trans, step.ease, u);
            for (k, &c) in step.components.iter().enumerate() {
                if self.owned[c] {
                    let from = self.from[i].as_ref().unwrap()[k] as f64;
                    self.values[c] = Some(if u >= 1. {
                        step.to[k]
                    } else {
                        (from + (step.to[k] as f64 - from) * eased) as f32
                    });
                }
            }
        }
    }
}
#[derive(Default, Debug)]
pub struct Playback {
    pub materials: material::Playback,
    live: Vec<Live>,
    poses: BTreeMap<Id, Pose>,
    pub display: BTreeMap<Id, Display>,
    anchor: Option<(f64, f64)>,
    pub diagnostics: Diagnostics,
}
impl Playback {
    pub fn active(&self) -> bool {
        !self.live.is_empty() || self.materials.active()
    }
    pub fn counts(&self) -> (usize, usize) {
        (
            self.live.len() + self.materials.live_len(),
            self.live
                .iter()
                .map(|l| {
                    l.values
                        .iter()
                        .enumerate()
                        .filter(|(i, v)| l.owned[*i] && v.is_some())
                        .count()
                })
                .sum::<usize>()
                + self.materials.held_count(),
        )
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    /// Called only for a picture which will draw. Folded records keep call order but only the
    /// newest picture sets the clock and component baseline.
    pub fn picture(&mut self, time: i64, local_us: f64, records: &[Record], state: &ResolvedState) {
        if self.live.iter().any(|l| (time as f64) < l.now) || self.materials.ahead(time) {
            self.diagnostics.backward_anchor_holds += 1;
        }
        self.anchor = Some((time as f64, local_us));
        // Retire ended IDs and advance existing claims without starting delayed steps
        // against the previous picture's baseline.
        self.sample_inner(local_us, state, false);
        for r in records {
            for p in &r.poses {
                self.poses.insert(p.item, p.clone());
            }
        }
        for r in records {
            for e in &r.events {
                match e {
                    Event::Cancel(id) => {
                        self.diagnostics.cancels += 1;
                        let material_cancelled = self.materials.cancel(*id, &mut self.diagnostics);
                        let n = self.live.len();
                        self.live.retain(|l| l.b.id != *id);
                        if n == self.live.len() && !material_cancelled {
                            self.diagnostics.unknown_cancels += 1;
                        }
                    }
                    Event::MaterialBegin(b) => {
                        self.diagnostics.begins += 1;
                        self.diagnostics.material_begins += 1;
                        self.materials.begin(b, state, &mut self.diagnostics);
                    }
                    Event::Begin(b) => {
                        self.diagnostics.begins += 1;
                        let mut owned = [false; 16];
                        for s in &b.steps {
                            for &c in &s.components {
                                owned[c] = true;
                            }
                        }
                        // Implicit starts observe what was displayed before the newer owner writes.
                        let initial = self.poses.get(&b.item).map(|p| {
                            let mut v = p.values;
                            for owner in self.live.iter().filter(|l| l.b.item == b.item) {
                                for c in 0..16 {
                                    if owner.owned[c] {
                                        if let Some(x) = owner.values[c] {
                                            v[c] = x;
                                        }
                                    }
                                }
                            }
                            v
                        });
                        // Wire validation has already checked precedence; records retain host announce order.
                        for l in &mut self.live {
                            if l.b.item == b.item {
                                for c in 0..16 {
                                    if owned[c] && l.owned[c] {
                                        l.owned[c] = false;
                                        self.diagnostics.claims_replaced += 1;
                                    }
                                }
                            }
                        }
                        let n = self.live.len();
                        self.live.retain(|l| l.owned.iter().any(|&o| o));
                        self.diagnostics.retired_unowned += (n - self.live.len()) as u64;
                        self.live.push(Live {
                            b: b.clone(),
                            owned,
                            now: b.begin as f64,
                            from: vec![None; b.steps.len()],
                            started: vec![false; b.steps.len()],
                            values: [None; 16],
                            initial,
                        });
                    }
                }
            }
        }
        self.sample(local_us, state);
    }
    pub fn sample(&mut self, local_us: f64, state: &ResolvedState) {
        self.sample_inner(local_us, state, true);
    }
    fn sample_inner(&mut self, local_us: f64, state: &ResolvedState, start_steps: bool) {
        let Some((host, local)) = self.anchor else {
            return;
        };
        let now = host + (local_us - local).max(0.);
        self.materials
            .sample(now, state, start_steps, &mut self.diagnostics);
        self.live.retain(|l| state.items.contains_key(&l.b.item));
        for l in &mut self.live {
            l.now = l.now.max(now);
            let Some(p) = self.poses.get(&l.b.item) else {
                continue;
            };
            let mut order = (0..l.b.steps.len()).collect::<Vec<_>>();
            order.sort_by_key(|&i| (l.b.steps[i].start, i));
            // Cross boundaries before evaluating the final pose. Both walks use start-time
            // order (original index breaks ties), so implicit-from sees the previous winner.
            for &i in &order {
                let step = &l.b.steps[i];
                let boundary = l.b.begin as f64 + step.start as f64;
                if !start_steps || l.started[i] || l.now < boundary {
                    continue;
                }
                l.evaluate(&order, boundary);
                let step = &l.b.steps[i];
                l.from[i] = Some(step.from.clone().unwrap_or_else(|| {
                    step.components
                        .iter()
                        .map(|&c| l.values[c].unwrap_or(l.initial.as_ref().unwrap_or(&p.values)[c]))
                        .collect()
                }));
                l.started[i] = true;
            }
            l.evaluate(&order, l.now);
            l.initial = None;
        }
        let n = self.live.len();
        self.live.retain(|l| l.now < (l.b.end as f64));
        self.diagnostics.completed += (n - self.live.len()) as u64;
        self.display.clear();
        for l in &self.live {
            let Some(p) = self.poses.get(&l.b.item) else {
                continue;
            };
            let Some(item) = state.items.get(&l.b.item) else {
                continue;
            };
            let d = self
                .display
                .entry(l.b.item)
                .or_insert_with(|| Display::host(item));
            let mut values = p.values;
            let mut held = [false; 16];
            for owner in self.live.iter().filter(|o| o.b.item == l.b.item) {
                for c in 0..16 {
                    if owner.owned[c] {
                        if let Some(v) = owner.values[c] {
                            values[c] = v;
                            held[c] = true;
                        }
                    }
                }
            }
            if held[..6].iter().any(|&h| h) {
                d.xform = matrix(p.kind, &values);
            }
            if held[8..12].iter().any(|&h| h) {
                d.modulate.copy_from_slice(&values[8..12]);
            }
            if held[12..16].iter().any(|&h| h) {
                d.self_modulate.copy_from_slice(&values[12..16]);
            }
        }
        // Baselines remain only while ownership can need them, including delayed first steps.
        self.poses
            .retain(|id, _| self.live.iter().any(|l| l.b.item == *id));
    }
}
pub fn matrix(kind: Kind, v: &[f32; 16]) -> [f32; 6] {
    let (sr, cr) = v[2].sin_cos();
    let (sk, ck) = (v[2] + v[5]).sin_cos();
    let a = cr * v[3];
    let b = sr * v[3];
    let c = -sk * v[4];
    let d = ck * v[4];
    let (x, y) = if kind == Kind::Control {
        (
            v[0] + v[6] - a * v[6] - c * v[7],
            v[1] + v[7] - b * v[6] - d * v[7],
        )
    } else {
        (v[0], v[1])
    };
    [a, b, c, d, x, y]
}

// Godot 4.5.1 easing_equations.h (MIT, Godot contributors / Robert Penner), normalized
// identically to packages/effects/src/easing/numeric.ts. Endpoints are assigned exactly.
pub fn ease_sample(trans: u8, ease: u8, t: f64) -> f64 {
    if t <= 0. {
        return 0.;
    }
    if t >= 1. {
        return 1.;
    }
    if trans == 0 {
        return t;
    }
    if ease == 3 {
        return if t < 0.5 {
            0.5 * ease_sample(trans, 1, t * 2.)
        } else {
            0.5 + 0.5 * ease_sample(trans, 0, t * 2. - 1.)
        };
    }
    if ease == 2 && (trans == 9 || trans == 11) {
        return if t < 0.5 {
            0.5 * ease_sample(trans, 0, t * 2.)
        } else {
            0.5 + 0.5 * ease_sample(trans, 1, t * 2. - 1.)
        };
    }
    let pi = std::f64::consts::PI;
    match trans {
        1 => match ease {
            0 => 1. - (t * pi / 2.).cos(),
            1 => (t * pi / 2.).sin(),
            _ => -0.5 * ((pi * t).cos() - 1.),
        },
        2 | 3 | 4 | 7 => {
            let n = match trans {
                2 => 5,
                3 => 4,
                4 => 2,
                _ => 3,
            };
            match ease {
                0 => t.powi(n),
                1 => 1. - (1. - t).powi(n),
                _ => {
                    if t < 0.5 {
                        0.5 * (2. * t).powi(n)
                    } else {
                        1. - 0.5 * (2. - 2. * t).powi(n)
                    }
                }
            }
        }
        5 => match ease {
            0 => 2f64.powf(10. * (t - 1.)) - 0.001,
            1 => 1.001 * (1. - 2f64.powf(-10. * t)),
            _ => {
                if t < 0.5 {
                    0.5 * 2f64.powf(10. * (2. * t - 1.)) - 0.0005
                } else {
                    0.5 * 1.0005 * (2. - 2f64.powf(-10. * (2. * t - 1.)))
                }
            }
        },
        6 => match ease {
            0 => -2f64.powf(10. * (t - 1.)) * ((t - 1. - 0.075) * 2. * pi / 0.3).sin(),
            1 => 2f64.powf(-10. * t) * ((t - 0.075) * 2. * pi / 0.3).sin() + 1.,
            _ => {
                let v = 2. * t - 1.;
                let phase = ((v - 0.1125) * 2. * pi / 0.45).sin();
                if t < 0.5 {
                    -0.5 * 2f64.powf(10. * v) * phase
                } else {
                    0.5 * 2f64.powf(-10. * v) * phase + 1.
                }
            }
        },
        8 => match ease {
            0 => 1. - (1. - t * t).sqrt(),
            1 => (1. - (t - 1.).powi(2)).sqrt(),
            _ => {
                if t < 0.5 {
                    -0.5 * ((1. - (2. * t).powi(2)).sqrt() - 1.)
                } else {
                    0.5 * ((1. - (2. * t - 2.).powi(2)).sqrt() + 1.)
                }
            }
        },
        9 => {
            fn out(t: f64) -> f64 {
                if t < 1. / 2.75 {
                    7.5625 * t * t
                } else if t < 2. / 2.75 {
                    7.5625 * (t - 1.5 / 2.75).powi(2) + 0.75
                } else if t < 2.5 / 2.75 {
                    7.5625 * (t - 2.25 / 2.75).powi(2) + 0.9375
                } else {
                    7.5625 * (t - 2.625 / 2.75).powi(2) + 0.984375
                }
            }
            if ease == 0 {
                1. - out(1. - t)
            } else {
                out(t)
            }
        }
        10 => {
            let s = 1.70158;
            match ease {
                0 => t * t * ((s + 1.) * t - s),
                1 => {
                    let u = t - 1.;
                    u * u * ((s + 1.) * u + s) + 1.
                }
                _ => {
                    let s = s * 1.525;
                    let u = 2. * t;
                    if u < 1. {
                        0.5 * u * u * ((s + 1.) * u - s)
                    } else {
                        let v = u - 2.;
                        0.5 * (v * v * ((s + 1.) * v + s) + 2.)
                    }
                }
            }
        }
        11 => {
            fn out(t: f64) -> f64 {
                let s = 1. - t;
                ((t * std::f64::consts::PI * (0.2 + 2.5 * t * t * t)).sin() * s.powf(2.2) + t)
                    * (1. + 1.2 * s)
            }
            if ease == 0 {
                1. - out(1. - t)
            } else {
                out(t)
            }
        }
        _ => t,
    }
}

/// Wire lifetime validation is independent of the local playback clock.
#[derive(Clone, Default)]
pub struct Registry {
    live: BTreeMap<i64, (Begin, [bool; 16])>,
    material_live: material::Registry,
    precedence: Option<(i64, i64)>,
    kinds: BTreeMap<Id, Kind>,
}
impl Registry {
    fn check_begin(&self, id: i64, order: i64, begin: i64) -> Result<(), Error> {
        if self.live.contains_key(&id)
            || self.material_live.contains(id)
            || self
                .precedence
                .is_some_and(|p| order < p.0 || (order == p.0 && begin <= p.1))
        {
            return Err(err("tween-entry", "duplicate live ID or begin precedence"));
        }
        Ok(())
    }
    pub fn transaction(
        &self,
        time: i64,
        record: Option<&Record>,
        state: &ResolvedState,
    ) -> Result<Self, Error> {
        let mut next = self.clone();
        next.live
            .retain(|_, (b, _)| b.end > time && state.items.contains_key(&b.item));
        next.material_live.retain(time, state);
        if let Some(r) = record {
            next.kinds
                .retain(|item, _| next.live.values().any(|(b, _)| b.item == *item));
            for p in &r.poses {
                if next.kinds.get(&p.item).is_some_and(|kind| *kind != p.kind) {
                    return Err(err("tween-entry", "active item node kind changed"));
                }
                next.kinds.insert(p.item, p.kind);
            }
            for e in &r.events {
                match e {
                    Event::Cancel(id) => {
                        next.live.remove(id);
                        next.material_live.cancel(*id);
                    }
                    Event::MaterialBegin(b) => {
                        next.check_begin(b.id, b.order, b.begin)?;
                        next.material_live.begin(b, time, state)?;
                        next.precedence = Some((b.order, b.begin));
                    }
                    Event::Begin(b) => {
                        if next.material_live.contains(b.id)
                            || next.live.contains_key(&b.id)
                            || next.precedence.is_some_and(|p| {
                                b.order < p.0 || (b.order == p.0 && b.begin <= p.1)
                            })
                        {
                            return Err(err(
                                "tween-entry",
                                "duplicate live ID or begin precedence",
                            ));
                        }
                        if !state.items.contains_key(&b.item) {
                            return Err(err("tween-entry", "begin item missing"));
                        }
                        next.precedence = Some((b.order, b.begin));
                        let mut owned = [false; 16];
                        for s in &b.steps {
                            for &c in &s.components {
                                owned[c] = true;
                            }
                        }
                        for (old, mask) in next.live.values_mut() {
                            if old.item == b.item {
                                for c in 0..16 {
                                    mask[c] &= !owned[c];
                                }
                            }
                        }
                        next.live.retain(|_, (_, mask)| mask.iter().any(|&v| v));
                        if b.end > time {
                            next.live.insert(b.id, (b.clone(), owned));
                        }
                    }
                }
            }
        }
        for (b, _) in next.live.values() {
            if !record.is_some_and(|r| r.poses.iter().any(|p| p.item == b.item)) {
                return Err(err("tween-entry", "active item missing pose"));
            }
        }
        Ok(next)
    }
}

/// Strip /17's opted-in playback metadata, keeping /16 host transactions and predictor history.
pub fn to16(data: &[u8]) -> Result<Vec<u8>, Error> {
    use crate::validate::{Accepted, Options, Validator};
    let records = wire::split_records(data, 17)?;
    let first = records
        .first()
        .ok_or_else(|| err("missing-session", "no session"))?;
    let mut v = Validator::new(first.bytes(data), first.offset, Options::new(17))?;
    let mut out = wire::magic(16).to_vec();
    let mut input_lens = Vec::new();
    let mut output_lens = Vec::new();
    for (i, span) in records.iter().enumerate() {
        let rec = span.bytes(data);
        let at = out.len();
        let kind = if i == 0 {
            None
        } else {
            Some(v.accept(rec, span.offset)?)
        };
        match kind {
            Some(Accepted::Tween) => {}
            Some(Accepted::End) => {
                crate::predict::fix_end(rec, &output_lens, &input_lens, &mut out)
            }
            None | Some(Accepted::Transaction) => {
                let frame = wire::frame(rec, span.offset)?;
                let mut meta: J = serde_json::from_slice(frame.meta)
                    .map_err(|_| err("meta-json", "transcode"))?;
                let obj = meta.as_object_mut().unwrap();
                if i == 0 {
                    obj.insert("protocol".into(), J::String("render-stream/16".into()));
                    obj.shift_remove("client_tweens");
                } else {
                    obj.shift_remove("t_us");
                }
                let json = serde_json::to_vec(&meta).unwrap();
                crate::predict::make_record(&mut out, &[&json], &rec[8 + frame.meta.len()..]);
            }
            _ => out.extend_from_slice(rec),
        }
        input_lens.push(rec.len());
        output_lens.push(out.len() - at);
    }
    v.finish()?;
    Ok(out)
}

/// The only /19 downgrade: retain the node float prefix and ordinary host state.
pub fn to18_from19(data: &[u8]) -> Result<Vec<u8>, Error> {
    use crate::validate::{validate_recording, Accepted, Options};
    // Association and scene errors take precedence over malformed endpoint data. Validate the
    // whole input before indexing or retaining any of its float prefix.
    validate_recording(data, Options::new(19))?;
    let records = wire::split_records(data, 19)?;
    let mut out = wire::magic(18).to_vec();
    let mut material_ids = std::collections::BTreeSet::new();
    let mut input_lens = Vec::new();
    let mut output_lens = Vec::new();
    for (i, span) in records.iter().enumerate() {
        let record = span.bytes(data);
        let at = out.len();
        let frame = wire::frame(record, span.offset)?;
        let kind = if i == 0 {
            None
        } else if frame.meta.starts_with(b"{\"type\":\"tween\"") {
            Some(Accepted::Tween)
        } else if frame.meta.starts_with(b"{\"type\":\"end\"") {
            Some(Accepted::End)
        } else {
            Some(Accepted::Transaction)
        };
        match kind {
            Some(Accepted::End) => {
                crate::predict::fix_end(record, &output_lens, &input_lens, &mut out)
            }
            None | Some(Accepted::Tween) => {
                let frame = wire::frame(record, span.offset)?;
                let mut meta: J = serde_json::from_slice(frame.meta)
                    .map_err(|_| err("meta-json", "transcode"))?;
                let mut blocks = record[8 + frame.meta.len()..].to_vec();
                let mut keep = true;
                if i == 0 {
                    meta["protocol"] = J::String("render-stream/18".into());
                } else {
                    let events = meta["events"].as_array_mut().unwrap();
                    // Track kind per announcement, including reuse and begin/cancel in one record.
                    events.retain(|e| {
                        let id = tween_id(&e["tween_id"]).unwrap();
                        if e["op"] == "begin" {
                            if e.get("material").is_some() {
                                material_ids.insert(id);
                                false
                            } else {
                                material_ids.remove(&id);
                                true
                            }
                        } else {
                            !material_ids.remove(&id)
                        }
                    });
                    let mut count = 0usize;
                    for e in meta["events"].as_array().unwrap() {
                        if e["op"] == "begin" {
                            for step in e["steps"].as_array().unwrap() {
                                count = step["to"].as_u64().unwrap() as usize
                                    + components(step["property"].as_str().unwrap())
                                        .unwrap()
                                        .len();
                            }
                        }
                    }
                    for pose in meta["poses"].as_array().unwrap() {
                        count = pose["f"].as_u64().unwrap() as usize + 16;
                    }
                    if count == 0 {
                        meta["blocks"] = J::Array(vec![]);
                        blocks = vec![0; 4];
                    } else {
                        meta["blocks"][0]["count"] = J::from(count);
                        blocks.truncate(8 + count * 4);
                        blocks[4..8].copy_from_slice(&((count * 4) as u32).to_le_bytes());
                    }
                    keep = !meta["events"].as_array().unwrap().is_empty()
                        || !meta["poses"].as_array().unwrap().is_empty();
                }
                if keep {
                    let json = serde_json::to_vec(&meta).unwrap();
                    crate::predict::make_record(&mut out, &[&json], &blocks);
                }
            }
            _ => out.extend_from_slice(record),
        }
        input_lens.push(record.len());
        output_lens.push(out.len() - at);
    }
    Ok(out)
}
