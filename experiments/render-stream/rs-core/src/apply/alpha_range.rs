//! Conservative fragment ranges. Unknown syntax refuses the entire proof; unknown *ranges*
//! remain usable (for example, a finite unknown multiplied by zero). As with `alpha_uniform`,
//! the proof speaks only for finite, defined shader arithmetic. Texture bounds are supplied by
//! the caller, independently of expression evaluation, so narrower spatial bounds can reuse it.

use super::{float_components, swizzle, tokens, Tok};
use gsw_canvas_draw_list::{Binding, UniformValue};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Range {
    lo: f32,
    hi: f32,
}
impl Range {
    const UNKNOWN: Self = Self {
        lo: f32::NEG_INFINITY,
        hi: f32::INFINITY,
    };
    const UNIT: Self = Self { lo: 0.0, hi: 1.0 };
    fn point(x: f32) -> Option<Self> {
        x.is_finite().then_some(Self { lo: x, hi: x })
    }
    fn zero(self) -> bool {
        self.lo == 0.0 && self.hi == 0.0
    }
    fn exact(x: f32) -> Self {
        Self { lo: x, hi: x }
    }
    fn neg(self) -> Self {
        Self {
            lo: -self.hi,
            hi: -self.lo,
        }
    }
    // GLSL ES 3.00 error model: highp `+ - *` are correctly rounded, so one outward ULP covers
    // them and contraction of adjacent operations; `/` may be 2.5 ULP off, so it widens by 3
    // ([`Self::rounded_by`]). Preserve exact zero identities: under the finite-value contract
    // these produce an exact zero on the GPU.
    fn rounded(lo: f32, hi: f32) -> Option<Self> {
        Self::rounded_by(lo, hi, 1)
    }
    fn rounded_by(lo: f32, hi: f32, ulps: u32) -> Option<Self> {
        if lo.is_nan() || hi.is_nan() {
            return None;
        }
        let (mut lo, mut hi) = (lo, hi);
        for _ in 0..ulps {
            lo = lo.next_down();
            hi = hi.next_up();
        }
        Some(Self { lo, hi })
    }
    fn op(self, op: &str, b: Self) -> Option<Self> {
        match op {
            "+" if self.zero() => Some(b),
            "+" | "-" if b.zero() => Some(self),
            "+" => Self::rounded(self.lo + b.lo, self.hi + b.hi),
            "-" => Self::rounded(self.lo - b.hi, self.hi - b.lo),
            "*" | "/" => {
                if op == "/" && b.lo <= 0.0 && b.hi >= 0.0 {
                    return None;
                }
                if self.zero() || (op == "*" && b.zero()) {
                    return Some(Self::exact(0.0));
                }
                let mut lo = f32::INFINITY;
                let mut hi = f32::NEG_INFINITY;
                for x in [self.lo, self.hi] {
                    for y in [b.lo, b.hi] {
                        let v = if op == "*" { x * y } else { x / y };
                        if v.is_nan() {
                            return Some(Self::UNKNOWN);
                        }
                        lo = lo.min(v);
                        hi = hi.max(v);
                    }
                }
                Self::rounded_by(lo, hi, if op == "/" { 3 } else { 1 })
            }
            "<" => Some(if self.hi < b.lo {
                Self::exact(1.0)
            } else if self.lo >= b.hi {
                Self::exact(0.0)
            } else {
                Self::UNIT
            }),
            ">" => b.op("<", self),
            "<=" => b.op("<", self).map(|v| Self {
                lo: 1.0 - v.hi,
                hi: 1.0 - v.lo,
            }),
            ">=" => b.op("<=", self),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scalar {
    Float,
    Int,
    Bool,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Type {
    scalar: Scalar,
    width: usize,
}
impl Type {
    fn parse(s: &str) -> Option<Self> {
        let (scalar, width) = match s {
            "int" => (Scalar::Int, 1),
            "bool" => (Scalar::Bool, 1),
            _ => (Scalar::Float, usize::from(float_components(s)?)),
        };
        Some(Self { scalar, width })
    }
}
#[derive(Clone, Debug)]
struct Value {
    scalar: Scalar,
    lanes: Vec<Range>,
}
impl Value {
    fn floats(lanes: Vec<Range>) -> Self {
        Self {
            scalar: Scalar::Float,
            lanes,
        }
    }
    fn boolean(range: Range) -> Self {
        Self {
            scalar: Scalar::Bool,
            lanes: vec![range],
        }
    }
    fn ty(&self) -> Type {
        Type {
            scalar: self.scalar,
            width: self.lanes.len(),
        }
    }
}
// Arithmetic permits scalar/vector broadcasting. Builtins check their own (asymmetric)
// overload signatures before using this component-wise operation.
fn binary(a: Value, b: Value, mut f: impl FnMut(Range, Range) -> Option<Range>) -> Option<Value> {
    if a.scalar != Scalar::Float || b.scalar != Scalar::Float {
        return None;
    }
    let n = a.lanes.len().max(b.lanes.len());
    if (a.lanes.len() != 1 && a.lanes.len() != n) || (b.lanes.len() != 1 && b.lanes.len() != n) {
        return None;
    }
    Some(Value::floats(
        (0..n)
            .map(|i| f(a.lanes[i % a.lanes.len()], b.lanes[i % b.lanes.len()]))
            .collect::<Option<Vec<_>>>()?,
    ))
}

#[derive(Clone, Debug)]
enum Expr {
    Float(f32),
    Int(i32),
    Var(String),
    Neg(Box<Expr>),
    Swizzle(Box<Expr>, Vec<usize>),
    Op(String, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}
#[derive(Clone, Debug)]
struct Store {
    name: String,
    fields: Option<Vec<usize>>,
    expr: Expr,
    ty: Option<Type>,
}
#[derive(Clone, Debug)]
struct Uniform {
    name: String,
    ty: Option<Type>,
}
#[derive(Clone, Debug)]
pub(super) struct Shader {
    uniforms: Vec<Uniform>,
    body: Vec<Store>,
}

struct Parser<'a> {
    t: &'a [Tok<'a>],
    i: usize,
}
impl<'a> Parser<'a> {
    fn take(&mut self, t: Tok<'a>) -> bool {
        if self.t.get(self.i) == Some(&t) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn word(&mut self) -> Option<&'a str> {
        let Tok::Word(s) = self.t.get(self.i)? else {
            return None;
        };
        self.i += 1;
        Some(s)
    }
    fn expr(&mut self, min: u8) -> Option<Expr> {
        let mut a = if self.take(Tok::Punct("-")) {
            Expr::Neg(Box::new(self.expr(14)?))
        } else if self.take(Tok::Punct("(")) {
            let e = self.expr(0)?;
            if !self.take(Tok::Punct(")")) {
                return None;
            }
            e
        } else {
            match *self.t.get(self.i)? {
                Tok::Num(s) => {
                    self.i += 1;
                    if s.contains(['.', 'e', 'E']) {
                        Expr::Float(
                            s.trim_end_matches('f')
                                .parse::<f32>()
                                .ok()
                                .filter(|v| v.is_finite())?,
                        )
                    } else {
                        // Do not round integer literals into floats before type checking.
                        Expr::Int(s.parse::<i32>().ok()?)
                    }
                }
                Tok::Word(s) => {
                    self.i += 1;
                    if self.take(Tok::Punct("(")) {
                        let mut args = Vec::new();
                        if !self.take(Tok::Punct(")")) {
                            loop {
                                args.push(self.expr(0)?);
                                if self.take(Tok::Punct(")")) {
                                    break;
                                }
                                if !self.take(Tok::Punct(",")) {
                                    return None;
                                }
                            }
                        }
                        Expr::Call(s.into(), args)
                    } else {
                        Expr::Var(s.into())
                    }
                }
                _ => return None,
            }
        };
        loop {
            if self.take(Tok::Punct(".")) {
                a = Expr::Swizzle(Box::new(a), fields(self.word()?)?);
                continue;
            }
            let Some(Tok::Punct(op)) = self.t.get(self.i) else {
                break;
            };
            // Godot 4.5.1 ShaderLanguage::_parse_and_reduce_expression: unary 3,
            // multiply/divide 4, add/subtract 5, relational 7 (smaller binds tighter).
            // All accepted binary operators associate left-to-right. Equality (8) and
            // every unmodeled operator refuse instead of sharing a precedence level.
            let prec = match *op {
                "<" | ">" | "<=" | ">=" => 10,
                "+" | "-" => 12,
                "*" | "/" => 13,
                ")" | "," | ";" => break,
                _ => return None,
            };
            if prec < min {
                break;
            }
            self.i += 1;
            a = Expr::Op((*op).into(), Box::new(a), Box::new(self.expr(prec + 1)?));
        }
        Some(a)
    }
}
fn fields(s: &str) -> Option<Vec<usize>> {
    if s.is_empty() || s.len() > 4 {
        return None;
    }
    // Godot rejects mixing xyzw, rgba and stpq in one swizzle.
    if !["xyzw", "rgba", "stpq"]
        .iter()
        .any(|set| s.chars().all(|c| set.contains(c)))
    {
        return None;
    }
    s.chars()
        .map(|c| swizzle(&c.to_string()).map(usize::from))
        .collect()
}
impl Shader {
    pub(super) fn parse(code: &str) -> Option<Self> {
        let t = tokens(code)?;
        let mut p = Parser { t: &t, i: 0 };
        let mut uniforms = Vec::new();
        let mut body = None;
        while p.i < t.len() {
            match p.word()? {
                "shader_type" | "render_mode" => {
                    while !p.take(Tok::Punct(";")) {
                        p.i += 1;
                        if p.i >= t.len() {
                            return None;
                        }
                    }
                }
                "instance" => {
                    if p.t.get(p.i) != Some(&Tok::Word("uniform")) {
                        return None;
                    }
                }
                "uniform" => {
                    let mut ty = p.word()?;
                    if matches!(ty, "lowp" | "mediump") {
                        // These may quantize a binding differently from the f32 range model.
                        return None;
                    }
                    if ty == "highp" {
                        ty = p.word()?;
                    }
                    let ty = if ty == "sampler2D" {
                        None
                    } else {
                        Some(Type::parse(ty)?)
                    };
                    let name = p.word()?.to_string();
                    if uniforms.iter().any(|u: &Uniform| u.name == name) {
                        return None;
                    }
                    if p.take(Tok::Punct(":")) {
                        // Hints cannot contain an assignment. Balanced hint arguments are
                        // ignored; the expression after '=' is still parsed normally.
                        while !matches!(p.t.get(p.i), Some(Tok::Punct("=" | ";"))) {
                            p.i += 1;
                            if p.i >= t.len() {
                                return None;
                            }
                        }
                    }
                    if p.take(Tok::Punct("=")) {
                        p.expr(0)?;
                    }
                    if !p.take(Tok::Punct(";")) {
                        return None;
                    }
                    uniforms.push(Uniform { name, ty });
                }
                "void" => {
                    if p.word()? != "fragment"
                        || body.is_some()
                        || !p.take(Tok::Punct("("))
                        || !p.take(Tok::Punct(")"))
                        || !p.take(Tok::Punct("{"))
                    {
                        return None;
                    }
                    let mut stores = Vec::new();
                    while !p.take(Tok::Punct("}")) {
                        let first = p.word()?;
                        let ty = Type::parse(first);
                        let name = if ty.is_some() { p.word()? } else { first }.to_string();
                        let fields = if p.take(Tok::Punct(".")) {
                            Some(fields(p.word()?)?)
                        } else {
                            None
                        };
                        if ty.is_some() && fields.is_some() {
                            return None;
                        }
                        if !p.take(Tok::Punct("=")) {
                            return None;
                        }
                        let expr = p.expr(0)?;
                        if !p.take(Tok::Punct(";")) {
                            return None;
                        }
                        stores.push(Store {
                            name,
                            fields,
                            expr,
                            ty,
                        });
                    }
                    body = Some(stores);
                }
                _ => return None,
            }
        }
        Some(Self {
            uniforms,
            body: body?,
        })
    }

    fn zero(&self, binding: &Binding, sampler: impl Fn(&str) -> Option<[Range; 4]>) -> bool {
        self.evaluate(binding, &sampler)
            .is_some_and(|v| v.lanes[3].zero())
    }
    pub(super) fn zero_unorm(&self, binding: &Binding, unorm: impl Fn(&str) -> bool) -> bool {
        self.zero(binding, |s| {
            Some(
                [if unorm(s) {
                    Range::UNIT
                } else {
                    Range::UNKNOWN
                }; 4],
            )
        })
    }
    fn evaluate(
        &self,
        binding: &Binding,
        sampler: &impl Fn(&str) -> Option<[Range; 4]>,
    ) -> Option<Value> {
        let mut env = HashMap::from([
            ("COLOR".into(), Value::floats(vec![Range::UNKNOWN; 4])),
            ("UV".into(), Value::floats(vec![Range::UNKNOWN; 2])),
            ("TIME".into(), Value::floats(vec![Range::UNKNOWN])),
        ]);
        let samplers: Vec<_> = self
            .uniforms
            .iter()
            .filter(|u| u.ty.is_none())
            .map(|u| u.name.as_str())
            .chain(["TEXTURE"])
            .collect();
        for u in &self.uniforms {
            let Some(ty) = u.ty else { continue };
            let v = if let Some(v) = binding.uniforms.iter().find(|v| *v.name == u.name) {
                match (&v.value, ty.scalar) {
                    (UniformValue::Float(v), Scalar::Float) => Value::floats(
                        v.iter()
                            .map(|&x| Range::point(x))
                            .collect::<Option<Vec<_>>>()?,
                    ),
                    (UniformValue::Int(v), Scalar::Bool) if v.len() == 1 => {
                        Value::boolean(Range::exact(if v[0] == 0 { 0.0 } else { 1.0 }))
                    }
                    _ => return None,
                }
            } else {
                // Real and synthetic bindings carry the declared default when unset. Missing
                // metadata cannot stand in for a value: a later parameter update may be lost.
                return None;
            };
            if ty.scalar == Scalar::Int || v.ty() != ty || env.insert(u.name.clone(), v).is_some() {
                return None;
            }
        }
        for s in &self.body {
            let v = eval(&s.expr, &env, &samplers, sampler)?;
            if let Some(ty) = s.ty {
                if v.ty() != ty || env.contains_key(&s.name) || samplers.contains(&s.name.as_str())
                {
                    return None;
                }
                env.insert(s.name.clone(), v);
                continue;
            }
            if self.uniforms.iter().any(|u| u.name == s.name)
                || matches!(s.name.as_str(), "UV" | "TIME" | "true" | "false")
            {
                return None;
            }
            let old = env.get_mut(&s.name)?;
            if s.fields.is_some() && old.lanes.len() == 1 {
                return None; // Godot has no scalar swizzles, including on write.
            }
            let indices = s
                .fields
                .clone()
                .unwrap_or_else(|| (0..old.lanes.len()).collect());
            if old.scalar != v.scalar || indices.len() != v.lanes.len() {
                return None;
            }
            let mut seen = Vec::new();
            for (i, value) in indices.into_iter().zip(v.lanes) {
                if seen.contains(&i) {
                    return None;
                }
                seen.push(i);
                *old.lanes.get_mut(i)? = value;
            }
        }
        env.remove("COLOR")
    }
}
fn eval(
    e: &Expr,
    env: &HashMap<String, Value>,
    samplers: &[&str],
    sampler: &impl Fn(&str) -> Option<[Range; 4]>,
) -> Option<Value> {
    match e {
        Expr::Float(x) => Some(Value::floats(vec![Range::exact(*x)])),
        Expr::Int(_) => None, // Only the direct float(integer literal) conversion is modeled.
        Expr::Var(s) => env.get(s).cloned(),
        Expr::Neg(e) => {
            let v = eval(e, env, samplers, sampler)?;
            (v.scalar == Scalar::Float)
                .then(|| Value::floats(v.lanes.into_iter().map(Range::neg).collect()))
        }
        Expr::Swizzle(e, fields) => {
            let v = eval(e, env, samplers, sampler)?;
            if v.lanes.len() == 1 {
                return None;
            }
            Some(Value {
                scalar: v.scalar,
                lanes: fields
                    .iter()
                    .map(|&i| v.lanes.get(i).copied())
                    .collect::<Option<Vec<_>>>()?,
            })
        }
        Expr::Op(op, a, b) => {
            let a = eval(a, env, samplers, sampler)?;
            let b = eval(b, env, samplers, sampler)?;
            if matches!(op.as_str(), "<" | "<=" | ">" | ">=") {
                if a.scalar != Scalar::Float
                    || b.scalar != Scalar::Float
                    || a.lanes.len() != 1
                    || b.lanes.len() != 1
                {
                    return None;
                }
                Some(Value::boolean(a.lanes[0].op(op, b.lanes[0])?))
            } else {
                binary(a, b, |a, b| a.op(op, b))
            }
        }
        Expr::Call(name, args) => {
            if name == "texture" {
                let [Expr::Var(s), uv] = args.as_slice() else {
                    return None;
                };
                let uv = eval(uv, env, samplers, sampler)?;
                if !samplers.contains(&s.as_str())
                    || uv.ty()
                        != (Type {
                            scalar: Scalar::Float,
                            width: 2,
                        })
                {
                    return None;
                }
                return Some(Value::floats(sampler(s)?.to_vec()));
            }
            if name == "float" {
                if let [Expr::Int(n)] = args.as_slice() {
                    // A signed unary expression is deliberately not an integer literal here.
                    return (n.abs() <= (1 << 24))
                        .then(|| Value::floats(vec![Range::exact(*n as f32)]));
                }
            }
            let a = args
                .iter()
                .map(|e| eval(e, env, samplers, sampler))
                .collect::<Option<Vec<_>>>()?;
            if name == "float" {
                let [v] = a.as_slice() else {
                    return None;
                };
                return (v.lanes.len() == 1 && matches!(v.scalar, Scalar::Float | Scalar::Bool))
                    .then(|| Value::floats(v.lanes.clone()));
            }
            // Bool cannot silently enter arithmetic, vector constructors, or float builtins.
            // Godot's boolean mix overloads require bvecN, outside this scalar-bool subset.
            if a.iter().any(|v| v.scalar != Scalar::Float) {
                return None;
            }
            if let Some(n) = float_components(name).map(usize::from) {
                if let [v] = a.as_slice() {
                    if v.lanes.len() == 1 {
                        return Some(Value::floats(vec![v.lanes[0]; n]));
                    }
                }
                let v: Vec<_> = a.into_iter().flat_map(|v| v.lanes).collect();
                // Refuse partial/overfull constructors rather than inventing components or
                // truncation rules. Exact mixed-width constructors preserve component order.
                return (v.len() == n).then(|| Value::floats(v));
            }
            match (name.as_str(), a.as_slice()) {
                ("abs", [a]) => Some(Value::floats(
                    a.lanes
                        .iter()
                        .map(|x| Range {
                            lo: if x.lo <= 0.0 && x.hi >= 0.0 {
                                0.0
                            } else {
                                x.lo.abs().min(x.hi.abs())
                            },
                            hi: x.lo.abs().max(x.hi.abs()),
                        })
                        .collect(),
                )),
                // Inclusive 1 is intentional: x-floor(x) may round to 1 near a negative integer.
                ("fract", [a]) => Some(Value::floats(vec![Range::UNIT; a.lanes.len()])),
                ("sin" | "cos", [a]) => Some(Value::floats(vec![
                    Range { lo: -1.0, hi: 1.0 };
                    a.lanes.len()
                ])),
                ("min" | "max", [a, b]) => {
                    if b.lanes.len() != 1 && a.lanes.len() != b.lanes.len() {
                        return None;
                    }
                    binary(a.clone(), b.clone(), |x, y| {
                        Some(if name == "min" {
                            Range {
                                lo: x.lo.min(y.lo),
                                hi: x.hi.min(y.hi),
                            }
                        } else {
                            Range {
                                lo: x.lo.max(y.lo),
                                hi: x.hi.max(y.hi),
                            }
                        })
                    })
                }
                ("step", [edge, x]) => {
                    if edge.lanes.len() != 1 && edge.lanes.len() != x.lanes.len() {
                        return None;
                    }
                    binary(edge.clone(), x.clone(), |e, x| {
                        Some(if x.hi < e.lo {
                            Range::exact(0.0)
                        } else if x.lo >= e.hi {
                            Range::exact(1.0)
                        } else {
                            Range::UNIT
                        })
                    })
                }
                ("mix", [x, y, t]) => {
                    if x.lanes.len() != y.lanes.len()
                        || (t.lanes.len() != 1 && t.lanes.len() != x.lanes.len())
                    {
                        return None;
                    }
                    let one_t =
                        binary(Value::floats(vec![Range::exact(1.0)]), t.clone(), |a, b| {
                            a.op("-", b)
                        })?;
                    let left = binary(x.clone(), one_t, |a, b| a.op("*", b))?;
                    let right = binary(y.clone(), t.clone(), |a, b| a.op("*", b))?;
                    binary(left, right, |a, b| a.op("+", b))
                }
                ("clamp" | "smoothstep", [a, b, c]) => {
                    let (n, valid) = if name == "clamp" {
                        (
                            a.lanes.len(),
                            b.lanes.len() == c.lanes.len()
                                && (b.lanes.len() == 1 || b.lanes.len() == a.lanes.len()),
                        )
                    } else {
                        (
                            c.lanes.len(),
                            a.lanes.len() == b.lanes.len()
                                && (a.lanes.len() == 1 || a.lanes.len() == c.lanes.len()),
                        )
                    };
                    if !valid {
                        return None;
                    }
                    Some(Value::floats(
                        (0..n)
                            .map(|i| {
                                let (a, b, c) = (
                                    a.lanes[i % a.lanes.len()],
                                    b.lanes[i % b.lanes.len()],
                                    c.lanes[i % c.lanes.len()],
                                );
                                if name == "clamp" {
                                    if b.hi > c.lo {
                                        return None;
                                    }
                                    Some(Range {
                                        lo: a.lo.max(b.lo).min(c.lo),
                                        hi: a.hi.max(b.hi).min(c.hi),
                                    })
                                } else {
                                    if a.hi >= b.lo {
                                        return None;
                                    }
                                    Some(if c.hi <= a.lo {
                                        Range::exact(0.0)
                                    } else if c.lo >= b.hi {
                                        Range::exact(1.0)
                                    } else {
                                        Range::UNIT
                                    })
                                }
                            })
                            .collect::<Option<Vec<_>>>()?,
                    ))
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gsw_canvas_draw_list::Uniform;
    const OVERLAY: &str = include_str!("fixtures/transition.gdshader");
    fn binding(t: f32) -> Binding {
        Binding {
            uniforms: vec![Uniform {
                name: "threshold".into(),
                value: UniformValue::Float(vec![t]),
            }],
            ..Binding::default()
        }
    }
    fn prove(body: &str) -> bool {
        Shader::parse(&format!(
            "shader_type canvas_item; void fragment() {{ {body} }}"
        ))
        .is_some_and(|s| s.zero_unorm(&Binding::default(), |_| true))
    }
    #[test]
    fn overlay_thresholds() {
        let s = Shader::parse(OVERLAY).unwrap();
        for (v, zero) in [(0.0, true), (0.08, true), (0.09, false), (1.0, false)] {
            assert_eq!(s.zero_unorm(&binding(v), |_| true), zero, "{v}");
        }
        assert!(!s.zero_unorm(&Binding::default(), |_| true));
        assert!(!s.zero_unorm(&binding(0.0), |_| false));
    }
    #[test]
    fn refuses_unsupported_or_undefined_code() {
        for body in [
            "if (true) { COLOR.a = 0.0; }",
            "for (int i=0; i<2; i++) { COLOR.a=0.0; }",
            "COLOR.a = mystery(0.0);",
            "COLOR.a = 0.0 / sin(TIME);",
            "COLOR.a = COLOR.a;",
            "COLOR.a = smoothstep(0.0, 0.0, -1.0);",
            "COLOR.a = 0.0; discard;",
            "COLOR.a = varying_alpha;",
            "COLOR.a = 0.0; COLOR = vec4(1.0);",
            "COLOR.a = 0.0; COLOR.aa = vec2(0.0);",
        ] {
            assert!(!prove(body), "{body}");
        }
    }
    #[test]
    fn straight_line_vectors_and_builtins() {
        for body in [
            "vec4 c = vec4(UV, 1.0, 0.0); COLOR = c; COLOR.rgb = vec3(1.0);",
            "COLOR.a = 0.0 * COLOR.a;",
            "COLOR.a = smoothstep(0.1, 1.0, -1.0);",
            "COLOR.a = step(2.0, fract(TIME));",
            "COLOR.a = step(2.0, abs(sin(TIME)));",
            "COLOR.a = clamp(-1.0, 0.0, 1.0);",
            "COLOR.a = min(0.0, max(0.0, cos(TIME)));",
            "COLOR.a = float(1.0 > 2.0);",
            "float a = 1.0; a = a * 0.0; COLOR.a = a;",
            "COLOR.a = 0.0 / 2.0;",
        ] {
            assert!(prove(body), "{body}");
        }
        assert!(!prove("COLOR.a = 0.0; COLOR.a += 1.0;"));
        assert!(!prove("COLOR.a = 0.0; COLOR.rgb = vec3(mystery);"));
    }
    #[test]
    fn reviewer_precedence_regression() {
        assert!(!prove("COLOR.a = float(true == 2.0 > 1.0);"));
    }
    #[test]
    fn audited_typing_refusals() {
        for body in [
            "COLOR.a = 0.0.x;",
            "float a = 1.0; a.x = 0.0; COLOR.a = a;",
            "COLOR = vec4(vec2(0.0), 0.0);",
            "COLOR = vec4(0.0, vec4(0.0));",
            "COLOR = vec4(vec3(0.0), 0);",
            "COLOR.a = float(16777217) - 16777216.0;",
            "COLOR.a = float(1 < 2) - 1.0;",
            "COLOR.a = float(-1) + 1.0;",
            "COLOR.a = float(0.0 == 0.0) - 1.0;",
            "COLOR.a = float(0.0 < 1.0) - 1.0; COLOR.rgb = vec3(false);",
            "COLOR.a = min(vec2(0.0), vec2(1.0)).x; COLOR.rg = vec2(0.0).xr;",
            "COLOR = mix(vec4(0.0), 0.0, vec4(0.0));",
            "COLOR = step(vec4(1.0), 0.0);",
            "COLOR = clamp(0.0, vec4(0.0), vec4(1.0));",
            "COLOR.a = float(vec2(0.0) < vec2(1.0));",
            "COLOR.a = clamp(-1.0, 1.0, 0.0) * 0.0;",
            "COLOR.a = smoothstep(1.0, 0.0, -1.0);",
            "float a = 1.0; a *= 0.0; COLOR.a = a;",
            "COLOR.a = 0.0; COLOR.a += 1.0;",
            "COLOR.a = float(false);",
        ] {
            assert!(!prove(body), "{body}");
        }
    }
    #[test]
    fn reviewer_integer_regressions() {
        for body in [
            "COLOR.a = step(float(1 / 2), 0.25);",
            "COLOR.a = float(1 / 2) - 0.5;",
        ] {
            assert!(!prove(body), "{body}");
        }
    }
}

#[cfg(test)]
#[path = "alpha_range_tests.rs"]
mod typed_tests;

/// Bounded FIFO caches of parsed code and binding proofs. Called only when the applier's
/// binding inputs change, never by a per-frame draw or by the cover walk.
#[derive(Default)]
pub(in crate::apply) struct Cache {
    shaders: HashMap<crate::state::Hash, Option<Shader>>,
    shader_order: std::collections::VecDeque<crate::state::Hash>,
    results: HashMap<crate::state::Hash, bool>,
    result_order: std::collections::VecDeque<crate::state::Hash>,
    #[cfg(test)]
    evaluations: usize,
}
impl Cache {
    const CAP: usize = 256;
    pub(in crate::apply) fn prove(
        &mut self,
        code_hash: crate::state::Hash,
        code: Option<&str>,
        binding: &Binding,
        formats: &[(String, Option<String>)],
    ) -> bool {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(code_hash.0);
        // Debug includes names, kinds, vector lengths and exact round-trippable f32 values.
        // The cache does not read texture ids or post-modulate (only uniform values and formats).
        h.update(format!("{:?}\n{:?}", binding.uniforms, formats));
        let key = crate::state::Hash(h.finalize().into());
        if let Some(&v) = self.results.get(&key) {
            return v;
        }
        if !self.shaders.contains_key(&code_hash) {
            let Some(code) = code else {
                return false;
            };
            if self.shaders.len() == Self::CAP {
                self.shaders.remove(&self.shader_order.pop_front().unwrap());
            }
            self.shaders.insert(code_hash, Shader::parse(code));
            self.shader_order.push_back(code_hash);
        }
        #[cfg(test)]
        {
            self.evaluations += 1;
        }
        let result = self.shaders[&code_hash].as_ref().is_some_and(|shader| {
            shader.zero_unorm(binding, |name| {
                formats
                    .iter()
                    .find(|(n, _)| n == name)
                    .and_then(|(_, f)| f.as_deref())
                    .is_some_and(unorm)
            })
        });
        if self.results.len() == Self::CAP {
            self.results.remove(&self.result_order.pop_front().unwrap());
        }
        self.results.insert(key, result);
        self.result_order.push_back(key);
        result
    }
}
fn unorm(format: &str) -> bool {
    matches!(
        format,
        "L8" | "LA8"
            | "R8"
            | "RG8"
            | "RGB8"
            | "RGBA8"
            | "RGBA4444"
            | "RGB565"
            | "DXT1"
            | "DXT3"
            | "DXT5"
            | "RGTC_R"
            | "RGTC_RG"
            | "BPTC_RGBA"
            | "ETC"
            | "ETC2_R11"
            | "ETC2_RG11"
            | "ETC2_RGB8"
            | "ETC2_RGBA8"
            | "ETC2_RGB8A1"
            | "ASTC_4x4"
            | "ASTC_8x8"
    )
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use crate::state::Hash;
    use gsw_canvas_draw_list::Uniform;
    #[test]
    fn keys_code_values_and_formats_and_stays_bounded() {
        let mut c = Cache::default();
        let code = include_str!("fixtures/transition.gdshader");
        let mut b = Binding {
            uniforms: vec![Uniform {
                name: "threshold".into(),
                value: UniformValue::Float(vec![0.0]),
            }],
            ..Binding::default()
        };
        let mut formats = vec![("transitionTex".into(), Some("RGBA8".into()))];
        let hash = Hash([1; 32]);
        assert!(c.prove(hash, Some(code), &b, &formats));
        assert!(c.prove(hash, Some(code), &b, &formats));
        assert_eq!(c.evaluations, 1);
        b.uniforms[0].value = UniformValue::Float(vec![0.5]);
        assert!(!c.prove(hash, Some(code), &b, &formats));
        b.uniforms[0].value = UniformValue::Float(vec![0.0]);
        assert!(c.prove(hash, Some(code), &b, &formats));
        formats[0].1 = Some("RGBAH".into());
        assert!(!c.prove(hash, Some(code), &b, &formats));
        formats[0].1 = None;
        assert!(!c.prove(hash, Some(code), &b, &formats));
        formats[0].1 = Some("RGBA8".into());
        assert!(!c.prove(
            Hash([2; 32]),
            Some("void fragment() { COLOR.a = 1.0; }"),
            &b,
            &formats
        ));
        for i in 0..1024u32 {
            let mut bytes = [0; 32];
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            b.uniforms[0].value = UniformValue::Float(vec![i as f32]);
            c.prove(Hash(bytes), Some(code), &b, &formats);
            assert!(c.shaders.len() <= Cache::CAP && c.results.len() <= Cache::CAP);
        }
    }
}
