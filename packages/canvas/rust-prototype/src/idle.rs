//! Idle animations evaluated in the renderer (`RIA1`).
//!
//! A caller that animates a few retained subtrees with periodic loops (a bob, a spin, a pulse) would otherwise
//! sample every loop, re-pose every command it owns, serialize a patch and have it parsed here, once per frame.
//! Instead it installs one descriptor set per committed scene revision and calls `present_idle(t)` per frame:
//! the renderer samples each loop at `t`, re-poses the commands it owns, and presents through the same patch
//! machinery (instance spans, damage plan, partial redraw) as an ordinary patch.
//!
//! EXACTNESS. Every pose is the f64 arithmetic of the caller's own patch path, operation for operation, so a
//! descriptor-driven frame commits the same command matrices (before the f32 conversion an ordinary patch's JSON
//! parse performs) as a patch computed by the caller at the same `t`. Trigonometry goes through the page's own
//! `Math.cos`/`Math.sin` in a browser build for the same reason. Native builds (tests) use Rust's.
//!
//! WHAT A DESCRIPTOR EXPRESSES. A root is a periodic curve (or the rest pose) composed into one subtree's placement:
//!
//! ```text
//! phase  = ((((t - origin + phaseMs) / periodMs) % 1) + 1) % 1
//! raw    = compose(base, wire, pre(phase), post(phase))
//! draw   = outer · [raw.linear, raw.tx + spreadDx, raw.ty]
//! delta  = draw · inverse
//! ```
//!
//! and a target is one command it re-poses: `group` (`m = (P·delta)·Q`, the command's group re-placed),
//! `primitive` (`m = C·Q` with `C` the root chain's composed delta) or `text` (`m = P·((C·Q)·R)`, a text carrier
//! whose inset `R` is fixed at install). Alpha curves are not expressible: a caller keeps those frames on its patch
//! path.
//!
//! WIRE FORMAT (little endian): ASCII `RIA1`, u32 version (1), u32 base revision low, u32 base revision high,
//! u32 root count, u32 target count; per root u32 curve, u32 flags (bit 0: has wire), f64 x 12 curve parameters
//! (amplitudeRad, amplitudePx, baselineUpPx, scaleFrom, scaleTo, alphaFrom, alphaTo, pivotX, pivotY, originMs,
//! phaseMs, periodMs), then f64 x 25 placement (base 6, wire 6, outer 6, spreadDx, inverse 6); per target u32
//! command index, u32 mode, u32 chain length, then per chain link u32 root index, u32 reserved, f64 spread offset,
//! then f64 x 18 (P, Q, R).

pub const IDLE_MAGIC: &[u8; 4] = b"RIA1";
pub const IDLE_VERSION: u32 = 1;

pub type Affine = [f64; 6];
const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    /// No loop: the root sits at its rest pose (it still composes into nested chains).
    Rest,
    /// `θ = 2πφ` about the pivot (node-local post).
    Rotate,
    /// `θ = −amp·cos 2πφ` about the pivot.
    Rock,
    /// Parent-space translate `dy = −(baseline + amp·cos 2πφ)` (pre).
    Bob,
    /// Uniform scale `k = from + (to − from)(1 − cos 2πφ)/2` about the pivot.
    PivotPulse,
    /// Uniform scale `k = from + (to − from)·easeOut(φ)` about the pivot (its alpha half must be constant 1).
    PulseScale,
}
impl Curve {
    fn from_u32(value: u32) -> Option<Self> {
        Some(match value {
            0 => Self::Rest,
            1 => Self::Rotate,
            2 => Self::Rock,
            3 => Self::Bob,
            4 => Self::PivotPulse,
            5 => Self::PulseScale,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdleRoot {
    pub curve: Curve,
    pub amplitude_rad: f64,
    pub amplitude_px: f64,
    pub baseline_up_px: f64,
    pub scale_from: f64,
    pub scale_to: f64,
    pub pivot_x: f64,
    pub pivot_y: f64,
    pub origin_ms: f64,
    pub phase_ms: f64,
    pub period_ms: f64,
    pub base: Affine,
    pub wire: Option<Affine>,
    pub outer: Affine,
    pub spread_dx: f64,
    pub inverse: Affine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetMode {
    Group,
    Primitive,
    Text,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdleTarget {
    pub command: usize,
    pub mode: TargetMode,
    /// Roots composing this command's delta, outermost first, each with the command's spread offset from it.
    pub chain: Vec<(usize, f64)>,
    pub p: Affine,
    pub q: Affine,
    pub r: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IdleSet {
    pub base_revision: u64,
    pub roots: Vec<IdleRoot>,
    pub targets: Vec<IdleTarget>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.at.checked_add(n).ok_or("RIA1 overflow")?;
        let slice = self.bytes.get(self.at..end).ok_or("RIA1 truncated")?;
        self.at = end;
        Ok(slice)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64, String> {
        let value = f64::from_le_bytes(self.take(8)?.try_into().unwrap());
        if value.is_finite() {
            Ok(value)
        } else {
            Err("RIA1 non-finite value".into())
        }
    }
    fn affine(&mut self) -> Result<Affine, String> {
        let mut m = [0.0; 6];
        for value in &mut m {
            *value = self.f64()?;
        }
        Ok(m)
    }
}

impl IdleSet {
    /// Decode an `RIA1` buffer. Structural checks only; the renderer checks command indexes and kinds.
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut r = Reader { bytes, at: 0 };
        if r.take(4)? != IDLE_MAGIC {
            return Err("RIA1 magic mismatch".into());
        }
        if r.u32()? != IDLE_VERSION {
            return Err("RIA1 version mismatch".into());
        }
        let low = u64::from(r.u32()?);
        let high = u64::from(r.u32()?);
        let base_revision = low | (high << 32);
        let root_count = r.u32()? as usize;
        let target_count = r.u32()? as usize;
        // Each root is at least 8 + 37 * 8 bytes; refuse a count the buffer cannot hold before allocating.
        if root_count > bytes.len() / 304 + 1 || target_count > bytes.len() / 168 + 1 {
            return Err("RIA1 counts exceed the buffer".into());
        }
        let mut roots = Vec::with_capacity(root_count);
        for _ in 0..root_count {
            let curve = Curve::from_u32(r.u32()?).ok_or("RIA1 unknown curve")?;
            let flags = r.u32()?;
            let amplitude_rad = r.f64()?;
            let amplitude_px = r.f64()?;
            let baseline_up_px = r.f64()?;
            let scale_from = r.f64()?;
            let scale_to = r.f64()?;
            let alpha_from = r.f64()?;
            let alpha_to = r.f64()?;
            let pivot_x = r.f64()?;
            let pivot_y = r.f64()?;
            let origin_ms = r.f64()?;
            let phase_ms = r.f64()?;
            let period_ms = r.f64()?;
            let base = r.affine()?;
            let wire = r.affine()?;
            let outer = r.affine()?;
            let spread_dx = r.f64()?;
            let inverse = r.affine()?;
            if curve != Curve::Rest && !(period_ms > 0.0) {
                return Err("RIA1 loop without a period".into());
            }
            // An alpha curve changes paint, not placement: it is not expressible here.
            if alpha_from != 1.0 || alpha_to != 1.0 {
                return Err("RIA1 alpha curves are not supported".into());
            }
            roots.push(IdleRoot {
                curve,
                amplitude_rad,
                amplitude_px,
                baseline_up_px,
                scale_from,
                scale_to,
                pivot_x,
                pivot_y,
                origin_ms,
                phase_ms,
                period_ms,
                base,
                wire: (flags & 1 != 0).then_some(wire),
                outer,
                spread_dx,
                inverse,
            });
        }
        let mut targets = Vec::with_capacity(target_count);
        for _ in 0..target_count {
            let command = r.u32()? as usize;
            let mode = match r.u32()? {
                0 => TargetMode::Group,
                1 => TargetMode::Primitive,
                2 => TargetMode::Text,
                _ => return Err("RIA1 unknown target mode".into()),
            };
            let links = r.u32()? as usize;
            if links == 0 || links > root_count {
                return Err("RIA1 target chain length".into());
            }
            if mode == TargetMode::Group && links != 1 {
                return Err("RIA1 group target must name one root".into());
            }
            let mut chain = Vec::with_capacity(links);
            for _ in 0..links {
                let root = r.u32()? as usize;
                r.u32()?;
                let offset = r.f64()?;
                if root >= root_count {
                    return Err("RIA1 target names an unknown root".into());
                }
                chain.push((root, offset));
            }
            let p = r.affine()?;
            let q = r.affine()?;
            let r_ = r.affine()?;
            targets.push(IdleTarget {
                command,
                mode,
                chain,
                p,
                q,
                r: r_,
            });
        }
        if r.at != bytes.len() {
            return Err("RIA1 trailing bytes".into());
        }
        Ok(Self {
            base_revision,
            roots,
            targets,
        })
    }

    /// Every target's command matrix at `t_ms`, in target order: the f64 values a caller's patch carries.
    pub fn evaluate(&self, t_ms: f64) -> Vec<Affine> {
        let poses: Vec<(Affine, f64, f64)> = self
            .roots
            .iter()
            .map(|root| root_delta(root, t_ms))
            .collect();
        self.targets
            .iter()
            .map(|target| {
                // The chain composes outermost first: `combined = previous · applied`.
                let mut combined: Option<Affine> = None;
                for &(root, offset) in &target.chain {
                    let (delta, vx, vy) = poses[root];
                    let applied = if target.mode == TargetMode::Group
                        || offset == 0.0
                        || (vx == 0.0 && vy == 0.0)
                    {
                        delta
                    } else {
                        [
                            delta[0],
                            delta[1],
                            delta[2],
                            delta[3],
                            delta[4] + offset * vx,
                            delta[5] + offset * vy,
                        ]
                    };
                    combined = Some(match combined {
                        Some(previous) => mul(&previous, &applied),
                        None => applied,
                    });
                }
                let c = combined.expect("decode checked a non-empty chain");
                match target.mode {
                    TargetMode::Group => mul(&mul(&target.p, &c), &target.q),
                    TargetMode::Primitive => mul(&c, &target.q),
                    TargetMode::Text => mul(&target.p, &mul(&mul(&c, &target.q), &target.r)),
                }
            })
            .collect()
    }
}

/// The affine product `a · b` with the caller's operation order (`(a·x + c·y) + e`).
pub fn mul(a: &Affine, b: &Affine) -> Affine {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

#[cfg(target_arch = "wasm32")]
fn cos(x: f64) -> f64 {
    js_sys::Math::cos(x)
}
#[cfg(target_arch = "wasm32")]
fn sin(x: f64) -> f64 {
    js_sys::Math::sin(x)
}
#[cfg(not(target_arch = "wasm32"))]
fn cos(x: f64) -> f64 {
    x.cos()
}
#[cfg(not(target_arch = "wasm32"))]
fn sin(x: f64) -> f64 {
    x.sin()
}

/// The loop's phase in [0, 1) at `t_ms` (the document- or apply-anchored origin is the caller's).
pub fn phase(root: &IdleRoot, t_ms: f64) -> f64 {
    let raw = (t_ms - root.origin_ms + root.phase_ms) / root.period_ms;
    ((raw % 1.0) + 1.0) % 1.0
}

/// CSS `ease-out` (`cubic-bezier(0, 0, 0.58, 1)`) at x = `phase`: Newton from `t = x`, as the caller solves it.
pub fn css_ease_out(phase: f64) -> f64 {
    let x = if phase <= 0.0 {
        0.0
    } else if phase >= 1.0 {
        1.0
    } else {
        phase
    };
    if x == 0.0 || x == 1.0 {
        return x;
    }
    let bx = 3.0 * 0.58;
    let ax = 1.0 - bx;
    let by = 3.0;
    let ay = 1.0 - by;
    let mut t = x;
    for _ in 0..5 {
        let fx = (ax * t + bx) * t * t - x;
        if fx > -1e-9 && fx < 1e-9 {
            break;
        }
        let dx = (3.0 * ax * t + 2.0 * bx) * t;
        if dx > -1e-6 && dx < 1e-6 {
            break;
        }
        t -= fx / dx;
    }
    (ay * t + by) * t * t
}

/// The pre (parent-space translate) and post (node-local) matrices of `root` at `phase`.
pub fn sample(root: &IdleRoot, phase: f64) -> (Option<Affine>, Option<Affine>) {
    let turn = std::f64::consts::TAU * phase;
    let rotate = |theta: f64| -> Affine {
        let c = cos(theta);
        let s = sin(theta);
        let (px, py) = (root.pivot_x, root.pivot_y);
        [c, s, -s, c, px - c * px + s * py, py - s * px - c * py]
    };
    let scale = |k: f64| -> Affine {
        [
            k,
            0.0,
            0.0,
            k,
            (1.0 - k) * root.pivot_x,
            (1.0 - k) * root.pivot_y,
        ]
    };
    match root.curve {
        Curve::Rest => (None, None),
        Curve::Rotate => (None, Some(rotate(turn))),
        Curve::Rock => (None, Some(rotate(-root.amplitude_rad * cos(turn)))),
        Curve::Bob => {
            let y = -(root.baseline_up_px + root.amplitude_px * cos(turn));
            (Some([1.0, 0.0, 0.0, 1.0, 0.0, y]), None)
        }
        Curve::PivotPulse => (
            None,
            Some(scale(
                root.scale_from + (root.scale_to - root.scale_from) * (1.0 - cos(turn)) / 2.0,
            )),
        ),
        Curve::PulseScale => {
            let t = css_ease_out(phase);
            (
                None,
                Some(scale(
                    root.scale_from + (root.scale_to - root.scale_from) * t,
                )),
            )
        }
    }
}

/// The node's rendered global under its local animation: `own` gets `pre` on the left, the parent composes, `post`
/// decorates the result.
pub fn compose(
    base: &Affine,
    own: Option<&Affine>,
    pre: Option<&Affine>,
    post: Option<&Affine>,
) -> Affine {
    let own_draw = match (pre, own) {
        (Some(pre), Some(own)) => Some(mul(pre, own)),
        (_, own) => own.copied(),
    };
    let raw = match own_draw {
        Some(own_draw) => mul(base, &own_draw),
        None => match pre {
            Some(pre) => mul(base, pre),
            None => *base,
        },
    };
    match post {
        Some(post) => mul(&raw, post),
        None => raw,
    }
}

/// A root's delta at `t_ms` (what the committed list holds becomes this pose) and its spread correction vector.
pub fn root_delta(root: &IdleRoot, t_ms: f64) -> (Affine, f64, f64) {
    let (pre, post) = if root.curve == Curve::Rest {
        (None, None)
    } else {
        sample(root, phase(root, t_ms))
    };
    let raw = compose(&root.base, root.wire.as_ref(), pre.as_ref(), post.as_ref());
    let outer = &root.outer;
    let draw = mul(
        outer,
        &[
            raw[0],
            raw[1],
            raw[2],
            raw[3],
            raw[4] + root.spread_dx,
            raw[5],
        ],
    );
    let delta = mul(&draw, &root.inverse);
    let vx = outer[0] - (delta[0] * outer[0] + delta[2] * outer[1]);
    let vy = outer[1] - (delta[1] * outer[0] + delta[3] * outer[1]);
    (delta, vx, vy)
}

/// The identity, for callers composing a target with no parent world.
pub const fn identity() -> Affine {
    IDENTITY
}

/// Encode an [`IdleSet`] (tests and native callers; browsers encode with `encodeRustIdleAnims`).
pub fn encode(set: &IdleSet) -> Vec<u8> {
    let mut out = IDLE_MAGIC.to_vec();
    let push_u32 = |out: &mut Vec<u8>, v: u32| out.extend(v.to_le_bytes());
    let push_f64 = |out: &mut Vec<u8>, v: f64| out.extend(v.to_le_bytes());
    push_u32(&mut out, IDLE_VERSION);
    push_u32(&mut out, set.base_revision as u32);
    push_u32(&mut out, (set.base_revision >> 32) as u32);
    push_u32(&mut out, set.roots.len() as u32);
    push_u32(&mut out, set.targets.len() as u32);
    for root in &set.roots {
        push_u32(
            &mut out,
            match root.curve {
                Curve::Rest => 0,
                Curve::Rotate => 1,
                Curve::Rock => 2,
                Curve::Bob => 3,
                Curve::PivotPulse => 4,
                Curve::PulseScale => 5,
            },
        );
        push_u32(&mut out, u32::from(root.wire.is_some()));
        for v in [
            root.amplitude_rad,
            root.amplitude_px,
            root.baseline_up_px,
            root.scale_from,
            root.scale_to,
            1.0,
            1.0,
            root.pivot_x,
            root.pivot_y,
            root.origin_ms,
            root.phase_ms,
            root.period_ms,
        ] {
            push_f64(&mut out, v);
        }
        for m in [&root.base, &root.wire.unwrap_or(IDENTITY), &root.outer] {
            for &v in m {
                push_f64(&mut out, v);
            }
        }
        push_f64(&mut out, root.spread_dx);
        for &v in &root.inverse {
            push_f64(&mut out, v);
        }
    }
    for target in &set.targets {
        push_u32(&mut out, target.command as u32);
        push_u32(
            &mut out,
            match target.mode {
                TargetMode::Group => 0,
                TargetMode::Primitive => 1,
                TargetMode::Text => 2,
            },
        );
        push_u32(&mut out, target.chain.len() as u32);
        for &(root, offset) in &target.chain {
            push_u32(&mut out, root as u32);
            push_u32(&mut out, 0);
            push_f64(&mut out, offset);
        }
        for m in [&target.p, &target.q, &target.r] {
            for &v in m {
                push_f64(&mut out, v);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(curve: Curve) -> IdleRoot {
        IdleRoot {
            curve,
            amplitude_rad: 0.12,
            amplitude_px: 10.0,
            baseline_up_px: 8.0,
            scale_from: 0.9,
            scale_to: 1.1,
            pivot_x: 12.0,
            pivot_y: 7.0,
            origin_ms: 1000.0,
            phase_ms: 250.0,
            period_ms: 2000.0,
            base: [2.0, 0.0, 0.0, 2.0, 100.0, 50.0],
            wire: Some([1.0, 0.0, 0.0, 1.0, 30.0, 40.0]),
            outer: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            spread_dx: 0.0,
            inverse: [0.5, 0.0, 0.0, 0.5, -80.0, -70.0],
        }
    }

    #[test]
    fn phase_wraps_like_the_loop_scheduler() {
        let r = root(Curve::Bob);
        assert_eq!(phase(&r, 1000.0), 0.125);
        assert_eq!(phase(&r, 2750.0), 0.0);
        // Before the origin the modulo wraps into [0, 1).
        assert_eq!(phase(&r, 0.0), 0.625);
    }

    #[test]
    fn bob_is_a_pre_translate_and_spin_a_pivot_conjugation() {
        let bob = root(Curve::Bob);
        let (pre, post) = sample(&bob, 0.0);
        assert_eq!(pre, Some([1.0, 0.0, 0.0, 1.0, 0.0, -18.0]));
        assert_eq!(post, None);
        let spin = root(Curve::Rotate);
        let (pre, post) = sample(&spin, 0.25);
        assert_eq!(pre, None);
        let m = post.unwrap();
        // A quarter turn maps the pivot to itself.
        let px = m[0] * 12.0 + m[2] * 7.0 + m[4];
        let py = m[1] * 12.0 + m[3] * 7.0 + m[5];
        assert!((px - 12.0).abs() < 1e-12 && (py - 7.0).abs() < 1e-12);
    }

    #[test]
    fn ease_out_matches_its_endpoints_and_is_monotone() {
        assert_eq!(css_ease_out(0.0), 0.0);
        assert_eq!(css_ease_out(1.0), 1.0);
        let mut last = 0.0;
        for i in 1..100 {
            let y = css_ease_out(f64::from(i) / 100.0);
            assert!(y > last);
            last = y;
        }
    }

    #[test]
    fn encode_decode_round_trips_and_rejects_alpha_and_garbage() {
        let set = IdleSet {
            base_revision: (7u64 << 32) | 3,
            roots: vec![root(Curve::Bob), root(Curve::Rest)],
            targets: vec![
                IdleTarget {
                    command: 4,
                    mode: TargetMode::Primitive,
                    chain: vec![(1, 0.0), (0, 2.5)],
                    p: IDENTITY,
                    q: [1.0, 0.0, 0.0, 1.0, 3.0, 4.0],
                    r: IDENTITY,
                },
                IdleTarget {
                    command: 5,
                    mode: TargetMode::Group,
                    chain: vec![(0, 0.0)],
                    p: IDENTITY,
                    q: IDENTITY,
                    r: IDENTITY,
                },
            ],
        };
        let bytes = encode(&set);
        assert_eq!(IdleSet::decode(&bytes).unwrap(), set);
        let mut truncated = bytes.clone();
        truncated.pop();
        assert!(IdleSet::decode(&truncated).is_err());
        let mut alpha = bytes.clone();
        // The first root's alphaFrom: magic + 5 u32 header + curve + flags + 5 f64.
        let at = 4 + 20 + 8 + 40;
        alpha[at..at + 8].copy_from_slice(&0.5f64.to_le_bytes());
        assert_eq!(
            IdleSet::decode(&alpha).unwrap_err(),
            "RIA1 alpha curves are not supported"
        );
    }

    #[test]
    fn a_rest_root_reproduces_the_committed_pose() {
        let mut r = root(Curve::Rest);
        // inverse = (outer · base · wire)^-1 makes the rest delta the identity.
        r.inverse = [0.5, 0.0, 0.0, 0.5, -80.0, -65.0];
        let (delta, vx, vy) = root_delta(&r, 12345.0);
        assert_eq!(delta, IDENTITY);
        assert_eq!((vx, vy), (0.0, 0.0));
    }

    #[test]
    fn chains_compose_outermost_first_with_spread_offsets() {
        let outer = root(Curve::Bob);
        let mut inner = root(Curve::Rotate);
        inner.outer = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
        let set = IdleSet {
            base_revision: 1,
            roots: vec![outer.clone(), inner.clone()],
            targets: vec![IdleTarget {
                command: 0,
                mode: TargetMode::Primitive,
                chain: vec![(0, 0.0), (1, 3.0)],
                p: IDENTITY,
                q: [1.0, 0.0, 0.0, 1.0, 2.0, 2.0],
                r: IDENTITY,
            }],
        };
        let t = 1789.0;
        let (d0, _, _) = root_delta(&outer, t);
        let (d1, vx, vy) = root_delta(&inner, t);
        let applied = [
            d1[0],
            d1[1],
            d1[2],
            d1[3],
            d1[4] + 3.0 * vx,
            d1[5] + 3.0 * vy,
        ];
        let expected = mul(&mul(&d0, &applied), &[1.0, 0.0, 0.0, 1.0, 2.0, 2.0]);
        assert_eq!(set.evaluate(t), vec![expected]);
    }
}
