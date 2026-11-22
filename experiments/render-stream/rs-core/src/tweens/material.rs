//! Material schedules and scalar claims. Host params are never mutated by display playback.
use super::*;
use crate::state::{EntryStatus, Param, ParamValue, ShaderMode, VariantType};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct MaterialStep {
    pub param: String,
    pub ty: VariantType,
    pub value: Step,
}
#[derive(Clone, Debug)]
pub struct Begin {
    pub id: i64,
    pub material: Id,
    pub order: i64,
    pub begin: i64,
    pub end: i64,
    pub steps: Vec<MaterialStep>,
}
pub fn arity(ty: VariantType) -> Option<usize> {
    use VariantType::*;
    Some(match ty {
        Float => 1,
        Vector2 => 2,
        Vector3 => 3,
        Vector4 | Color => 4,
        _ => return None,
    })
}
fn name_valid(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
pub(super) fn decode_begin(e: &J) -> Result<Begin, Error> {
    keys(
        e,
        &[
            "op", "tween_id", "material", "order", "begin_us", "end_us", "steps",
        ],
    )?;
    let mut b = Begin {
        id: tween_id(&e["tween_id"])?,
        material: id(&e["material"])?,
        order: int(&e["order"], 1)?,
        begin: int(&e["begin_us"], 0)?,
        end: int(&e["end_us"], 0)?,
        steps: vec![],
    };
    for s in array(&e["steps"])? {
        keys(
            s,
            &[
                "param",
                "type",
                "component",
                "start_us",
                "duration_us",
                "trans",
                "ease",
                "from",
                "to",
            ],
        )?;
        let param = s["param"]
            .as_str()
            .filter(|n| name_valid(n))
            .ok_or_else(|| err("meta-schema", "material param name"))?;
        let ty = match s["type"].as_str() {
            Some("float") => VariantType::Float,
            Some("vector2") => VariantType::Vector2,
            Some("vector3") => VariantType::Vector3,
            Some("vector4") => VariantType::Vector4,
            Some("color") => VariantType::Color,
            _ => return Err(err("meta-schema", "material param type")),
        };
        let n = arity(ty).unwrap();
        let components = if s["component"].is_null() {
            (0..n).collect()
        } else {
            let c = int(&s["component"], 0)? as u64;
            if n == 1 || c >= n as u64 {
                return Err(err("meta-schema", "material component range"));
            }
            vec![c as usize]
        };
        let trans = int(&s["trans"], 0)?;
        let ease = int(&s["ease"], 0)?;
        if trans > 11 || ease > 3 {
            return Err(err("meta-schema", "tween easing"));
        }
        // Validate offsets' scalar schema even though values are consumed in phase three.
        if !s["from"].is_null() {
            int(&s["from"], 0)?;
        }
        int(&s["to"], 0)?;
        b.steps.push(MaterialStep {
            param: param.into(),
            ty,
            value: Step {
                components,
                start: int(&s["start_us"], 0)?,
                duration: int(&s["duration_us"], 0)?,
                trans: trans as u8,
                ease: ease as u8,
                from: None,
                to: vec![],
            },
        });
    }
    Ok(b)
}
pub(super) fn check_time(b: &Begin, time: i64) -> Result<(), Error> {
    if b.begin > time {
        return Err(err("tween-time", "future begin"));
    }
    let mut end = 0;
    for s in &b.steps {
        let sum = b
            .begin
            .checked_add(s.value.start)
            .and_then(|x| x.checked_add(s.value.duration))
            .filter(|&x| x <= MAX_INT)
            .ok_or_else(|| err("tween-time", "tween timing overflow"))?;
        end = end.max(sum);
    }
    if b.steps.is_empty() || b.end != end {
        return Err(err("tween-entry", "empty steps or inconsistent end"));
    }
    Ok(())
}
/// Explicit Variant values only; shader declaration conversion belongs to uniform_value.
pub fn numbers(p: &Param, ty: VariantType) -> Option<&[f64]> {
    if p.ty != ty {
        return None;
    }
    let values = match &p.value {
        ParamValue::Scalar(v) => std::slice::from_ref(v),
        ParamValue::Flat(v) => v,
        _ => return None,
    };
    (values.len() == arity(ty)?
        && values
            .iter()
            .all(|x| x.is_finite() && (*x as f32).is_finite()))
    .then_some(values)
}
fn baseline<'a>(
    state: &'a ResolvedState,
    material: Id,
    name: &str,
    ty: VariantType,
) -> Option<&'a [f64]> {
    numbers(
        state
            .materials
            .get(&material)?
            .params
            .iter()
            .find(|p| &*p.name == name)?,
        ty,
    )
}
fn validate(b: &Begin, state: &ResolvedState) -> Result<(), Error> {
    let m = state
        .materials
        .get(&b.material)
        .ok_or_else(|| err("tween-entry", "begin material missing"))?;
    let shader = m.shader.and_then(|id| state.shaders.get(&id));
    if m.status != EntryStatus::Ok
        || !shader.is_some_and(|s| {
            s.status == EntryStatus::Ok
                && s.mode == Some(ShaderMode::CanvasItem)
                && s.builtin.is_none()
                && s.process.is_none()
        })
    {
        return Err(err("tween-entry", "unsupported begin material or shader"));
    }
    let mut types = BTreeMap::new();
    for s in &b.steps {
        if types.insert(&s.param, s.ty).is_some_and(|ty| ty != s.ty) {
            return Err(err("tween-entry", "inconsistent material param types"));
        }
        if baseline(state, b.material, &s.param, s.ty).is_none() {
            return Err(err(
                "tween-entry",
                "missing or incompatible material param baseline",
            ));
        }
    }
    Ok(())
}
type Claim = (String, usize);
fn claims(b: &Begin) -> BTreeSet<Claim> {
    b.steps
        .iter()
        .flat_map(|s| s.value.components.iter().map(|&c| (s.param.clone(), c)))
        .collect()
}
#[derive(Clone, Default)]
pub(super) struct Registry(BTreeMap<i64, (Begin, BTreeSet<Claim>)>);
impl Registry {
    pub fn contains(&self, id: i64) -> bool {
        self.0.contains_key(&id)
    }
    pub fn cancel(&mut self, id: i64) {
        self.0.remove(&id);
    }
    pub fn retain(&mut self, time: i64, state: &ResolvedState) {
        self.0
            .retain(|_, (b, _)| b.end > time && state.materials.contains_key(&b.material));
    }
    pub fn begin(&mut self, b: &Begin, time: i64, state: &ResolvedState) -> Result<(), Error> {
        validate(b, state)?;
        let owned = claims(b);
        for (old, mask) in self
            .0
            .values_mut()
            .filter(|(old, _)| old.material == b.material)
        {
            let _ = old;
            mask.retain(|c| !owned.contains(c));
        }
        self.0.retain(|_, (_, mask)| !mask.is_empty());
        if b.end > time {
            self.0.insert(b.id, (b.clone(), owned));
        }
        Ok(())
    }
}
#[derive(Debug)]
struct Live {
    b: Begin,
    owned: BTreeSet<Claim>,
    now: f64,
    from: Vec<Option<Vec<f32>>>,
    values: BTreeMap<Claim, f32>,
    baseline: BTreeMap<Claim, f32>,
    initial: Option<BTreeMap<Claim, f32>>,
}
impl Live {
    fn evaluate(&mut self, order: &[usize], time: f64) {
        for &i in order {
            let s = &self.b.steps[i];
            let Some(from) = &self.from[i] else { continue };
            let elapsed = time - self.b.begin as f64 - s.value.start as f64;
            if elapsed < 0. {
                continue;
            }
            let u = if s.value.duration == 0 {
                1.
            } else {
                elapsed / s.value.duration as f64
            };
            let eased = ease_sample(s.value.trans, s.value.ease, u);
            for (k, &c) in s.value.components.iter().enumerate() {
                let key = (s.param.clone(), c);
                if self.owned.contains(&key) {
                    let f = from[k] as f64;
                    self.values.insert(
                        key,
                        if u >= 1. {
                            s.value.to[k]
                        } else {
                            (f + (s.value.to[k] as f64 - f) * eased) as f32
                        },
                    );
                }
            }
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub ty: VariantType,
    pub components: Vec<Option<f32>>,
}
#[derive(Default, Debug)]
pub struct Playback {
    live: Vec<Live>,
    pub display: BTreeMap<Id, BTreeMap<String, Held>>,
}
impl Playback {
    pub fn active(&self) -> bool {
        !self.live.is_empty()
    }
    pub fn live_len(&self) -> usize {
        self.live.len()
    }
    pub fn held_count(&self) -> usize {
        self.live
            .iter()
            .map(|l| l.values.keys().filter(|k| l.owned.contains(*k)).count())
            .sum()
    }
    pub(super) fn ahead(&self, time: i64) -> bool {
        self.live.iter().any(|l| l.now > time as f64)
    }
    pub(super) fn cancel(&mut self, id: i64, d: &mut Diagnostics) -> bool {
        let n = self.live.len();
        self.live.retain(|l| l.b.id != id);
        d.material_retired += (n - self.live.len()) as u64;
        n != self.live.len()
    }
    pub(super) fn begin(&mut self, b: &Begin, state: &ResolvedState, d: &mut Diagnostics) {
        let owned = claims(b);
        let mut initial = BTreeMap::new();
        for s in &b.steps {
            if let Some(values) = baseline(state, b.material, &s.param, s.ty) {
                for (c, &value) in values.iter().enumerate() {
                    initial.insert((s.param.clone(), c), value as f32);
                }
            }
        }
        for old in self.live.iter_mut().filter(|l| l.b.material == b.material) {
            for key in &owned {
                if old.owned.remove(key) {
                    if let Some(value) = old.values.get(key) {
                        initial.insert(key.clone(), *value);
                    }
                    d.claims_replaced += 1;
                }
            }
        }
        let n = self.live.len();
        self.live.retain(|l| !l.owned.is_empty());
        d.retired_unowned += (n - self.live.len()) as u64;
        d.material_retired += (n - self.live.len()) as u64;
        self.live.push(Live {
            b: b.clone(),
            owned,
            now: b.begin as f64,
            from: vec![None; b.steps.len()],
            values: BTreeMap::new(),
            baseline: initial.clone(),
            initial: Some(initial),
        });
    }
    pub(super) fn sample(
        &mut self,
        now: f64,
        state: &ResolvedState,
        start: bool,
        d: &mut Diagnostics,
    ) {
        let n = self.live.len();
        self.live
            .retain(|l| state.materials.contains_key(&l.b.material));
        d.material_retired += (n - self.live.len()) as u64;
        for l in &mut self.live {
            l.now = l.now.max(now);
            let mut order: Vec<_> = (0..l.b.steps.len()).collect();
            order.sort_by_key(|&i| (l.b.steps[i].value.start, i));
            for &i in &order {
                let s = &l.b.steps[i];
                let boundary = l.b.begin as f64 + s.value.start as f64;
                if !start || l.from[i].is_some() || l.now < boundary {
                    continue;
                }
                l.evaluate(&order, boundary);
                let s = &l.b.steps[i];
                l.from[i] = Some(s.value.from.clone().unwrap_or_else(|| {
                    let host = baseline(state, l.b.material, &s.param, s.ty);
                    s.value
                        .components
                        .iter()
                        .map(|&c| {
                            let key = (s.param.clone(), c);
                            l.values
                                .get(&key)
                                .copied()
                                .or_else(|| l.initial.as_ref().and_then(|v| v.get(&key).copied()))
                                .unwrap_or_else(|| {
                                    host.map(|v| v[c] as f32)
                                        .or_else(|| l.baseline.get(&key).copied())
                                        .unwrap_or(0.)
                                })
                        })
                        .collect()
                }));
            }
            l.evaluate(&order, l.now);
            l.initial = None;
        }
        let n = self.live.len();
        self.live.retain(|l| l.now < l.b.end as f64);
        d.completed += (n - self.live.len()) as u64;
        d.material_retired += (n - self.live.len()) as u64;
        self.display.clear();
        for l in &self.live {
            for s in &l.b.steps {
                // A transient invalid param keeps claims but contributes no display override.
                if baseline(state, l.b.material, &s.param, s.ty).is_none() {
                    continue;
                }
                for &c in &s.value.components {
                    let key = (s.param.clone(), c);
                    if l.owned.contains(&key) {
                        if let Some(&value) = l.values.get(&key) {
                            let held = self
                                .display
                                .entry(l.b.material)
                                .or_default()
                                .entry(s.param.clone())
                                .or_insert_with(|| Held {
                                    ty: s.ty,
                                    components: vec![None; arity(s.ty).unwrap()],
                                });
                            held.components[c] = Some(value);
                        }
                    }
                }
            }
        }
    }
    /// Clone only an actually overridden uniform, retaining host precision for unowned components.
    pub fn effective(&self, material: Id, param: &Param) -> Option<Param> {
        let held = self.display.get(&material)?.get(&*param.name)?;
        let mut values = numbers(param, held.ty)?.to_vec();
        for (v, held) in values.iter_mut().zip(&held.components) {
            if let Some(h) = held {
                *v = *h as f64;
            }
        }
        Some(Param {
            name: param.name.clone(),
            ty: param.ty,
            value: if values.len() == 1 {
                ParamValue::Scalar(values[0])
            } else {
                ParamValue::Flat(values)
            },
        })
    }
}
