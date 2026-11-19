//! The oracle builds typed expressions and evaluates the generated AST directly. It never
//! reads the range evaluator's AST, parser, arithmetic, or builtin implementations.
use super::*;
use gsw_canvas_draw_list::Uniform as BoundUniform;

#[derive(Clone, Debug)]
enum FloatExpr {
    Literal(f32),
    Uniform,
    Texel,
    Neg(Box<Self>),
    Arithmetic(char, Box<Self>, Box<Self>),
    Unary(&'static str, Box<Self>),
    Pair(&'static str, Box<Self>, Box<Self>),
    Triple(&'static str, Box<Self>, Box<Self>, Box<Self>),
    FromInt(IntExpr),
    FromBool(Box<BoolExpr>),
}
#[derive(Clone, Debug)]
enum IntExpr {
    Literal(i32),
    Neg(Box<Self>),
    Add(Box<Self>, Box<Self>),
    Div(Box<Self>, i32),
}
#[derive(Clone, Debug)]
enum BoolExpr {
    Uniform,
    Compare(&'static str, FloatExpr, FloatExpr),
}
impl IntExpr {
    fn source(&self) -> String {
        match self {
            Self::Literal(n) => n.to_string(),
            Self::Neg(a) => format!("(-({}))", a.source()),
            Self::Add(a, b) => format!("({} + {})", a.source(), b.source()),
            Self::Div(a, b) => format!("({} / {b})", a.source()),
        }
    }
    fn sample(&self) -> i32 {
        match self {
            Self::Literal(n) => *n,
            Self::Neg(a) => -a.sample(),
            Self::Add(a, b) => a.sample() + b.sample(),
            Self::Div(a, b) => a.sample() / b, // GLSL integer division truncates toward zero.
        }
    }
}
impl BoolExpr {
    fn source(&self) -> String {
        match self {
            Self::Uniform => "flag".into(),
            Self::Compare(op, a, b) => format!("({} {op} {})", a.source(), b.source()),
        }
    }
    fn sample(&self, u: f32, tex: f32, flag: bool) -> bool {
        match self {
            Self::Uniform => flag,
            Self::Compare(op, a, b) => {
                let (a, b) = (a.sample(u, tex, flag), b.sample(u, tex, flag));
                match *op {
                    "<" => a < b,
                    "<=" => a <= b,
                    ">" => a > b,
                    ">=" => a >= b,
                    _ => unreachable!(),
                }
            }
        }
    }
}
impl FloatExpr {
    fn source(&self) -> String {
        match self {
            Self::Literal(v) => format!("{v:?}"),
            Self::Uniform => "u".into(),
            Self::Texel => "texture(TEXTURE, UV).r".into(),
            Self::Neg(a) => format!("(-({}))", a.source()),
            Self::Arithmetic(op, a, b) => format!("({} {op} {})", a.source(), b.source()),
            Self::Unary(op, a) => format!("{op}({})", a.source()),
            Self::Pair(op, a, b) => format!("{op}({}, {})", a.source(), b.source()),
            Self::Triple(op, a, b, c) => {
                format!("{op}({}, {}, {})", a.source(), b.source(), c.source())
            }
            Self::FromInt(a) => format!("float({})", a.source()),
            Self::FromBool(a) => format!("float({})", a.source()),
        }
    }
    fn sample(&self, u: f32, tex: f32, flag: bool) -> f32 {
        let get = |x: &Self| x.sample(u, tex, flag);
        match self {
            Self::Literal(v) => *v,
            Self::Uniform => u,
            Self::Texel => tex,
            Self::Neg(a) => -get(a),
            Self::Arithmetic(op, a, b) => {
                let (a, b) = (get(a), get(b));
                match op {
                    '+' => a + b,
                    '-' => a - b,
                    '*' => a * b,
                    '/' => a / b,
                    _ => unreachable!(),
                }
            }
            Self::Unary(op, a) => {
                let a = get(a);
                match *op {
                    "abs" => a.abs(),
                    "fract" => a - a.floor(),
                    "sin" => a.sin(),
                    "cos" => a.cos(),
                    _ => unreachable!(),
                }
            }
            Self::Pair(op, a, b) => {
                let (a, b) = (get(a), get(b));
                match *op {
                    "min" => a.min(b),
                    "max" => a.max(b),
                    "step" => {
                        if b < a {
                            0.0
                        } else {
                            1.0
                        }
                    }
                    _ => unreachable!(),
                }
            }
            Self::Triple(op, a, b, c) => {
                let (a, b, c) = (get(a), get(b), get(c));
                match *op {
                    "mix" => a * (1.0 - c) + b * c,
                    "clamp" => {
                        assert!(b <= c);
                        a.max(b).min(c)
                    }
                    "smoothstep" => {
                        assert!(a < b);
                        let t = ((c - a) / (b - a)).clamp(0.0, 1.0);
                        t * t * (3.0 - 2.0 * t)
                    }
                    _ => unreachable!(),
                }
            }
            Self::FromInt(a) => a.sample() as f32,
            Self::FromBool(a) => {
                if a.sample(u, tex, flag) {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}
struct Random(u64);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 as u32
    }
    fn unit(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }
    fn int(&mut self, depth: u32) -> IntExpr {
        if depth == 0 {
            return IntExpr::Literal((self.next() % 8) as i32);
        }
        match self.next() % 4 {
            0 => IntExpr::Literal((self.next() % 8) as i32),
            1 => IntExpr::Neg(Box::new(self.int(depth - 1))),
            2 => IntExpr::Add(Box::new(self.int(depth - 1)), Box::new(self.int(depth - 1))),
            _ => IntExpr::Div(Box::new(self.int(depth - 1)), (self.next() % 4 + 1) as i32),
        }
    }
    fn boolean(&mut self, depth: u32) -> BoolExpr {
        if self.next() % 3 == 0 {
            return BoolExpr::Uniform;
        }
        BoolExpr::Compare(
            ["<", "<=", ">", ">="][self.next() as usize % 4],
            self.float(depth),
            self.float(depth),
        )
    }
    fn float(&mut self, depth: u32) -> FloatExpr {
        use FloatExpr::*;
        if depth == 0 {
            return match self.next() % 3 {
                0 => Literal([-1.0, -0.1, 0.0, 0.08, 0.5, 1.0, 1.1][self.next() as usize % 7]),
                1 => Uniform,
                _ => Texel,
            };
        }
        let d = depth - 1;
        match self.next() % 17 {
            0 => Neg(Box::new(self.float(d))),
            1..=3 => Arithmetic(
                ['+', '-', '*'][self.next() as usize % 3],
                Box::new(self.float(d)),
                Box::new(self.float(d)),
            ),
            4 => Arithmetic(
                '/',
                Box::new(self.float(d)),
                Box::new(Literal(0.25 + self.unit())),
            ),
            5 => Unary(
                ["abs", "fract", "sin", "cos"][self.next() as usize % 4],
                Box::new(self.float(d)),
            ),
            6 => Pair(
                ["min", "max", "step"][self.next() as usize % 3],
                Box::new(self.float(d)),
                Box::new(self.float(d)),
            ),
            7 => Triple(
                "mix",
                Box::new(self.float(d)),
                Box::new(self.float(d)),
                Box::new(self.float(d)),
            ),
            8 => Triple(
                "clamp",
                Box::new(self.float(d)),
                Box::new(Literal(0.0)),
                Box::new(Literal(1.0)),
            ),
            9 => Triple(
                "smoothstep",
                Box::new(Literal(0.1)),
                Box::new(Literal(0.9)),
                Box::new(self.float(d)),
            ),
            10 => FromInt(self.int(d)),
            11 => FromBool(Box::new(self.boolean(d))),
            // Include exact zero identities and useful range proofs, as well as live alphas.
            12 => Arithmetic('*', Box::new(Literal(0.0)), Box::new(self.float(d))),
            13 => Pair(
                "step",
                Box::new(Literal(2.0)),
                Box::new(Unary("fract", Box::new(self.float(d)))),
            ),
            14 => FromBool(Box::new(BoolExpr::Compare(
                "<",
                self.float(d),
                self.float(d),
            ))),
            _ => self.float(d),
        }
    }
}

#[test]
fn typed_generated_expressions_have_no_false_zero_proofs() {
    let mut rng = Random(0x1f00dcafe);
    let (mut proofs, mut refusals) = (0, 0);
    for i in 0..4096 {
        let e = rng.float(3);
        let source = e.source();
        let body = match i % 4 {
            0 => format!("COLOR.a = {source};"),
            1 => format!("COLOR = vec4(vec2(0.25, 0.5), 0.75, {source});"),
            2 => format!("vec4 c = vec4({source}); COLOR = mix(c, vec4(1.0), vec4(0.0));"),
            _ => format!("COLOR = vec4({source}); COLOR.rgb = vec3(1.0);"),
        };
        let shader = Shader::parse(&format!(
            "uniform float u; uniform bool flag; void fragment() {{ {body} }}"
        ))
        .unwrap_or_else(|| panic!("generated shader failed to parse: {body}"));
        for _ in 0..16 {
            let (u, flag) = (rng.unit() * 4.0 - 2.0, rng.next() % 2 != 0);
            let b = Binding {
                uniforms: vec![
                    BoundUniform {
                        name: "u".into(),
                        value: UniformValue::Float(vec![u]),
                    },
                    BoundUniform {
                        name: "flag".into(),
                        value: UniformValue::Int(vec![i32::from(flag)]),
                    },
                ],
                ..Binding::default()
            };
            if shader.zero_unorm(&b, |_| true) {
                proofs += 1;
                for tex in [0.0, 1.0, rng.unit(), rng.unit()] {
                    assert_eq!(
                        e.sample(u, tex, flag),
                        0.0,
                        "{body}; u={u}, flag={flag}, tex={tex}"
                    );
                }
            } else {
                refusals += 1;
            }
        }
    }
    assert!(
        proofs > 8000 && refusals > 8000,
        "proofs={proofs}, refusals={refusals}"
    );
}

#[test]
fn typed_oracle_distinguishes_integer_division_and_boolean_comparison() {
    let e = FloatExpr::FromInt(IntExpr::Div(Box::new(IntExpr::Literal(1)), 2));
    assert_eq!(e.sample(0.0, 0.0, false), 0.0);
    let b = BoolExpr::Compare(">", FloatExpr::Literal(2.0), FloatExpr::Literal(1.0));
    assert!(b.sample(0.0, 0.0, false));
}

fn prove(body: &str) -> bool {
    Shader::parse(&format!("void fragment() {{ {body} }}"))
        .is_some_and(|s| s.zero_unorm(&Binding::default(), |_| true))
}

#[test]
fn accepted_operator_precedence_and_associativity_match_godot() {
    for expr in [
        "float(2.0 + 3.0 * 4.0 < 10.0)",
        "float(8.0 / 2.0 / 2.0 < 1.5)",
        "float(5.0 - 3.0 - 1.0 < 0.5)",
        "float(-2.0 * -3.0 < 5.0)",
        "float(-(2.0 + 1.0) * -2.0 < 5.0)",
        "float(-vec4(1.0).a > 0.0)",
        "float(1.0 > 1.0)",
        "float(1.0 < 1.0)",
    ] {
        assert!(prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
    for expr in ["float(1.0 >= 1.0)", "float(1.0 <= 1.0)"] {
        assert!(!prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
    for expr in [
        "0.0 == 0.0",
        "0.0 != 0.0",
        "0.0 && 0.0",
        "0.0 || 0.0",
        "0.0 ^^ 0.0",
        "0.0 ? 0.0 : 0.0",
        "0.0 & 0.0",
        "0.0 | 0.0",
        "0.0 ^ 0.0",
        "0.0 % 1.0",
        "0.0 << 1.0",
        "0.0 >> 1.0",
        "!0.0",
        "~0.0",
        "++0.0",
        "--0.0",
    ] {
        assert!(!prove(&format!("COLOR.a = ({expr}) * 0.0;")), "{expr}");
    }
    for op in ["*=", "/=", "+=", "-=", "%=", "&=", "|=", "^=", "<<=", ">>="] {
        assert!(
            !prove(&format!("float a = 0.0; a {op} 1.0; COLOR.a = 0.0;")),
            "{op}"
        );
    }
}

#[test]
fn integers_only_convert_from_exact_unsigned_decimal_literals() {
    for expr in [
        "float(0)",
        "float(1) * 0.0",
        "float(16777216) * 0.0",
        "1e0 * 0.0",
        "1.0 * 0.0",
    ] {
        assert!(prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
    for expr in [
        "1 * 0.0",
        "float(16777217) * 0.0",
        "float(-1) * 0.0",
        "float(1 / 2) * 0.0",
        "float(1 + 1) * 0.0",
        "float(1 < 2) * 0.0",
        "min(0, 1) * 0.0",
        "vec4(0).a",
        "float(0x0)",
        "float(0u)",
        "float(2147483648)",
        "float(1.0 < 2) * 0.0",
    ] {
        assert!(!prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
    assert!(!prove("int n = 0; COLOR.a = float(n);"));
    assert!(!prove("float n = 0; COLOR.a = n;"));
}

#[test]
fn booleans_require_comparison_or_bool_uniform_and_explicit_conversion() {
    let s = Shader::parse("uniform bool flag = false; void fragment() { COLOR.a = float(flag); }")
        .unwrap();
    assert!(!s.zero_unorm(&Binding::default(), |_| true));
    for (value, zero) in [(0, true), (1, false), (-1, false)] {
        let b = Binding {
            uniforms: vec![BoundUniform {
                name: "flag".into(),
                value: UniformValue::Int(vec![value]),
            }],
            ..Binding::default()
        };
        assert_eq!(s.zero_unorm(&b, |_| true), zero);
    }
    let wrong = Binding {
        uniforms: vec![BoundUniform {
            name: "flag".into(),
            value: UniformValue::Float(vec![0.0]),
        }],
        ..Binding::default()
    };
    assert!(!s.zero_unorm(&wrong, |_| true));
    let float_shader = Shader::parse("uniform float u; void fragment() { COLOR.a = u; }").unwrap();
    let wrong = Binding {
        uniforms: vec![BoundUniform {
            name: "u".into(),
            value: UniformValue::Int(vec![0]),
        }],
        ..Binding::default()
    };
    assert!(!float_shader.zero_unorm(&wrong, |_| true));
    assert!(prove("bool b = 1.0 > 2.0; COLOR.a = float(b);"));
    for expr in [
        "false",
        "float(false)",
        "float(true == 2.0 > 1.0)",
        "(1.0 > 2.0) * 0.0",
        "abs(1.0 > 2.0)",
        "mix(0.0, 1.0, 1.0 > 2.0)",
    ] {
        assert!(!prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
}

#[test]
fn swizzles_component_writes_and_constructor_shapes() {
    for body in [
        "vec4 c = vec4(vec2(1.0), 1.0, 0.0); COLOR = c;",
        "vec4 c = vec4(vec3(1.0), 0.0); COLOR = c; COLOR.rgb = vec3(1.0);",
        "vec4 c = vec4(vec2(1.0), vec2(1.0, 0.0)); COLOR = c;",
        "COLOR = vec4(1.0); COLOR.ar = vec2(0.0, 1.0);",
        "COLOR.a = vec4(0.0).xxxx.w;",
        "COLOR.a = 1.0; COLOR.a = 0.0;",
    ] {
        assert!(prove(body), "{body}");
    }
    for body in [
        "float a = 0.0; COLOR.a = a.x;",
        "float a = 1.0; a.x = 0.0; COLOR.a = a;",
        "COLOR = vec4(vec2(0.0), 0.0);",
        "COLOR = vec4(vec4(0.0), 0.0);",
        "COLOR = vec4(vec3(0.0), 0);",
        "COLOR = vec4(vec3(0.0), 1.0 > 2.0);",
        "COLOR.a = vec4(0.0).xr.x;",
        "COLOR.a = vec2(0.0).z;",
        "COLOR.a = vec4(0.0).xxxxx.x;",
        "COLOR.aa = vec2(0.0);",
        "COLOR.rgb = 0.0; COLOR.a = 0.0;",
        "COLOR.a = 0.0; COLOR = vec4(1.0);",
    ] {
        assert!(!prove(body), "{body}");
    }
}

#[test]
fn builtin_widths_clamp_order_and_step_equality() {
    for expr in [
        "mix(vec4(0.0), vec4(1.0), 0.0).a",
        "mix(vec4(0.0), vec4(1.0), vec4(0.0)).a",
        "step(1.0, vec4(0.0)).a",
        "min(vec4(0.0), 1.0).a",
        "clamp(vec4(-1.0), 0.0, 1.0).a",
        "clamp(-1.0, 0.0, 0.0)",
        "smoothstep(0.0, 1.0, vec4(-1.0)).a",
        "smoothstep(0.0, 1.0, 0.0)",
        "step(0.0, -0.000001)",
    ] {
        assert!(prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
    for expr in [
        "mix(vec4(0.0), 0.0, vec4(0.0)).a",
        "mix(0.0, 0.0, vec4(0.0)).a",
        "step(vec4(1.0), 0.0).a",
        "min(0.0, vec4(0.0)).a",
        "max(0.0, vec4(0.0)).a",
        "clamp(0.0, vec4(0.0), vec4(1.0)).a",
        "clamp(vec4(0.0), 0.0, vec4(1.0)).a",
        "smoothstep(vec4(0.0), vec4(1.0), 0.0).a",
        "clamp(-1.0, 1.0, 0.0) * 0.0",
        "smoothstep(0.0, 0.0, -1.0)",
        "smoothstep(1.0, 0.0, -1.0)",
        "step(0.0, 0.0)",
        "step(0.0, 0.000001)",
    ] {
        assert!(!prove(&format!("COLOR.a = {expr};")), "{expr}");
    }
}

#[test]
fn finite_unknown_zero_products_and_boundary_ranges_stay_conservative() {
    assert!(prove("COLOR.a = 0.0 * COLOR.a;"));
    assert!(prove("COLOR.a = 0.0 * TIME;"));
    assert!(prove("COLOR.a = 0.0 * texture(TEXTURE, UV).a;"));
    assert!(!prove("COLOR.a = 0.0 / sin(TIME);"));
    assert!(!prove("COLOR.a = 0.0 / (texture(TEXTURE, UV).r - 0.5);"));
    let frac = Shader::parse("uniform float u; void fragment() { COLOR.a = step(1.0, fract(u)); }")
        .unwrap();
    // A tiny negative float can produce exactly 1 in x-floor(x), so [0, 1) is unsafe.
    for u in [
        -f32::from_bits(1),
        -1.0,
        -0.99999994,
        0.99999994,
        1.0,
        1.0000001,
        16777216.0,
    ] {
        let b = Binding {
            uniforms: vec![BoundUniform {
                name: "u".into(),
                value: UniformValue::Float(vec![u]),
            }],
            ..Binding::default()
        };
        assert!(!frac.zero_unorm(&b, |_| true));
        assert!((0.0..=1.0).contains(&(u - u.floor())));
    }
    assert!(prove("COLOR.a = step(2.0, fract(TIME));"));
    for (a, b) in [
        (f32::from_bits(1), 2.0),
        (-f32::from_bits(1), 2.0),
        (1.0, f32::MAX),
        (-1.0, f32::MAX),
    ] {
        let r = Range::point(a)
            .unwrap()
            .op("/", Range::point(b).unwrap())
            .unwrap();
        assert!(r.lo <= a / b && r.hi >= a / b);
    }
}

#[test]
fn overlay_samples_use_independent_typed_oracle() {
    use FloatExpr::*;
    let expr = Pair(
        "step",
        Box::new(Arithmetic('-', Box::new(Literal(1.0)), Box::new(Texel))),
        Box::new(Triple(
            "mix",
            Box::new(Literal(-0.1)),
            Box::new(Literal(1.1)),
            Box::new(Uniform),
        )),
    );
    let shader = Shader::parse(include_str!("fixtures/transition.gdshader")).unwrap();
    let mut rng = Random(0x1231f00dcafe);
    let mut proved = 0;
    for _ in 0..4096 {
        let t = rng.unit() * 2.0 - 0.5;
        let b = Binding {
            uniforms: vec![BoundUniform {
                name: "threshold".into(),
                value: UniformValue::Float(vec![t]),
            }],
            ..Binding::default()
        };
        if shader.zero_unorm(&b, |_| true) {
            proved += 1;
            for tex in [0.0, 1.0, rng.unit(), rng.unit()] {
                assert_eq!(
                    expr.sample(t, tex, false),
                    0.0,
                    "threshold={t}, texel={tex}"
                );
            }
        }
    }
    assert!(proved > 1000);
}

#[test]
fn lower_precision_uniforms_refuse_instead_of_assuming_f32_values() {
    for precision in ["lowp", "mediump"] {
        assert!(Shader::parse(&format!(
            "uniform {precision} float u; void fragment() {{ COLOR.a = step(0.50001, u); }}"
        ))
        .is_none());
    }
    let s = Shader::parse("uniform highp float u; void fragment() { COLOR.a = u; }").unwrap();
    assert!(!s.zero_unorm(&Binding::default(), |_| true));
    let b = Binding {
        uniforms: vec![BoundUniform {
            name: "u".into(),
            value: UniformValue::Float(vec![0.0]),
        }],
        ..Binding::default()
    };
    assert!(s.zero_unorm(&b, |_| true));
}

#[test]
fn division_keeps_the_glsl_two_and_a_half_ulp_error_bound() {
    // GLSL ES 3.00 lets highp `a / b` be 2.5 ULP off, while `+ - *` are correctly rounded: 1/3 may come back as
    // 0x3EAAAAAD (0.3333334), which a 1-ULP interval around rn(1/3) would exclude.
    let s = Shader::parse("uniform float d; void fragment() { COLOR.a = step(0.3333334, 1.0 / d); }").unwrap();
    let b = Binding {
        uniforms: vec![BoundUniform {
            name: "d".into(),
            value: UniformValue::Float(vec![3.0]),
        }],
        ..Binding::default()
    };
    assert!(!s.zero_unorm(&b, |_| true));
    // A quotient far below the edge is still proven, and an exact-zero numerator stays exact.
    assert!(prove("COLOR.a = step(0.5, 1.0 / 3.0);"));
    assert!(prove("COLOR.a = 0.0 / 2.0;"));
}
