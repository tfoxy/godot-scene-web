//! A schema-directed fast path for transaction metas: it reads canonical JSON straight into
//! [`TxMeta`] by matching each key literally in its fixed order, with no intermediate document.
//!
//! It only ever accepts a meta that the general path (`Doc::parse` + `check_transaction` +
//! canonical form) accepts too, and then fills `TxMeta` identically: every key list, value rule and
//! ordering rule below is `check_transaction`'s, and anything it does not recognise (whitespace,
//! an escape, a number that is not a plain canonical integer, an unknown key or op, any value the
//! schema would refuse) makes it return `None`, and the caller runs the general path, which then
//! reports exactly what the TypeScript reports. Canonical form is implied: the literals have no
//! whitespace, integers are matched in their canonical spelling only, and strings may hold only
//! printable ASCII other than `"` and `\`, so the meta is also printable ASCII.

use super::*;

struct Cur<'a> {
    s: &'a [u8],
    p: usize,
}

type O<T> = Option<T>;

impl<'a> Cur<'a> {
    #[inline(always)]
    fn lit(&mut self, l: &[u8]) -> O<()> {
        let end = self.p + l.len();
        if end <= self.s.len() && &self.s[self.p..end] == l {
            self.p = end;
            Some(())
        } else {
            None
        }
    }
    #[inline(always)]
    fn peek(&self) -> u8 {
        self.s.get(self.p).copied().unwrap_or(0)
    }
    #[inline(always)]
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == c {
            self.p += 1;
            true
        } else {
            false
        }
    }
    #[inline(always)]
    fn null(&mut self) -> bool {
        if self.s[self.p..].starts_with(b"null") {
            self.p += 4;
            true
        } else {
            false
        }
    }
    /// A canonical integer (`0` or `-?[1-9][0-9]*`, at most 15 digits, never `-0`).
    #[inline(always)]
    fn int(&mut self) -> O<i64> {
        let s = self.s;
        let mut i = self.p;
        let neg = s.get(i) == Some(&b'-');
        if neg {
            i += 1;
        }
        let start = i;
        let first = *s.get(i)?;
        if !first.is_ascii_digit() {
            return None;
        }
        let mut v = (first - b'0') as i64;
        i += 1;
        if first == b'0' {
            if neg
                || s.get(i)
                    .is_some_and(|c| c.is_ascii_digit() || *c == b'.' || *c == b'e' || *c == b'E')
            {
                return None;
            }
        } else {
            while let Some(&c) = s.get(i) {
                if !c.is_ascii_digit() {
                    break;
                }
                v = v * 10 + (c - b'0') as i64;
                i += 1;
                if i - start > 16 {
                    return None;
                }
            }
            if matches!(s.get(i), Some(b'.' | b'e' | b'E')) {
                return None;
            }
            // W11c: 16 digits reach /11's 53-bit `content_version` digests (WB, "As built
            // (W11b)" 1). The general path reads a number as an f64, so only a value it holds
            // exactly (|v| <= 2^53) is read here; anything above is the general path's.
            if v > 1 << 53 {
                return None;
            }
        }
        self.p = i;
        Some(if neg { -v } else { v })
    }
    #[inline(always)]
    fn int_ge(&mut self, min: i64) -> O<i64> {
        self.int().filter(|&v| v >= min)
    }
    #[inline(always)]
    fn uint(&mut self) -> O<u64> {
        self.int_ge(0).map(|v| v as u64)
    }
    #[inline(always)]
    fn id(&mut self) -> O<Id> {
        self.int().and_then(|v| u32::try_from(v).ok())
    }
    #[inline(always)]
    fn id1(&mut self) -> O<Id> {
        self.id().filter(|&v| v >= 1)
    }
    #[inline(always)]
    fn opt_id1(&mut self) -> O<Option<Id>> {
        if self.null() {
            Some(None)
        } else {
            self.id1().map(Some)
        }
    }
    #[inline(always)]
    fn boolean(&mut self) -> O<bool> {
        if self.s[self.p..].starts_with(b"true") {
            self.p += 4;
            Some(true)
        } else if self.s[self.p..].starts_with(b"false") {
            self.p += 5;
            Some(false)
        } else {
            None
        }
    }
    /// A string of printable ASCII without `"` or `\` (anything else: the general path).
    #[inline(always)]
    fn str(&mut self) -> O<&'a [u8]> {
        if !self.eat(b'"') {
            return None;
        }
        let start = self.p;
        let s = self.s;
        let mut i = start;
        loop {
            let c = *s.get(i)?;
            if c == b'"' {
                break;
            }
            if c == b'\\' || !(0x20..=0x7e).contains(&c) {
                return None;
            }
            i += 1;
        }
        self.p = i + 1;
        Some(&s[start..i])
    }
    #[inline(always)]
    fn owned(&mut self) -> O<Box<str>> {
        // Printable ASCII is valid UTF-8.
        self.str()
            .and_then(|b| std::str::from_utf8(b).ok())
            .map(Box::from)
    }
    #[inline(always)]
    fn one_of(&mut self, options: &[&'static str]) -> O<&'static str> {
        let s = self.str()?;
        options.iter().copied().find(|o| o.as_bytes() == s)
    }
    fn enum_of<T: Copy>(&mut self, all: &[T], name: fn(T) -> &'static str) -> O<T> {
        let s = self.str()?;
        all.iter().copied().find(|&t| name(t).as_bytes() == s)
    }
    fn hash(&mut self) -> O<Hash> {
        let s = self.str()?;
        if s.len() != 64 {
            return None;
        }
        Hash::from_hex(std::str::from_utf8(s).ok()?)
    }
    /// `[` elements `]`, each read by `f`.
    #[inline(always)]
    fn list(&mut self, mut f: impl FnMut(&mut Self) -> O<()>) -> O<()> {
        if !self.eat(b'[') {
            return None;
        }
        if self.eat(b']') {
            return Some(());
        }
        loop {
            f(self)?;
            if self.eat(b',') {
                continue;
            }
            return self.eat(b']').then_some(());
        }
    }
}

fn filter(c: &mut Cur) -> O<Filter> {
    c.enum_of(Filter::ALL, Filter::as_str)
}
fn repeat(c: &mut Cur) -> O<Repeat> {
    c.enum_of(Repeat::ALL, Repeat::as_str)
}
fn origin(c: &mut Cur) -> O<Origin> {
    c.enum_of(Origin::ALL, Origin::as_str)
}

fn param(c: &mut Cur, params: &mut Vec<ParamMeta>, start: usize) -> O<()> {
    c.lit(b"{\"name\":")?;
    let name = c.owned()?;
    c.lit(b",\"type\":")?;
    let ty = c.enum_of(VariantType::ALL, VariantType::as_str)?;
    c.lit(b",\"n\":")?;
    let n = c.int_ge(1)?;
    c.lit(b",\"tex\":")?;
    let tex = c.opt_id1()?;
    if (ty == VariantType::Rid) != tex.is_some() {
        return None;
    }
    c.lit(b",\"f\":")?;
    let f = c.uint()?;
    c.lit(b"}")?;
    if params.len() > start
        && js_cmp(params.last().unwrap().name.as_bytes(), name.as_bytes()) != Ordering::Less
    {
        return None;
    }
    params.push(ParamMeta {
        name,
        ty,
        n: n as u64,
        tex,
        f,
    });
    Some(())
}

fn command(c: &mut Cur, out: &mut Vec<CmdMeta>, version: u8) -> O<()> {
    c.lit(b"{\"op\":")?;
    // PM1: `add_multimesh` is an op from /11 only (the general path's unknown op below).
    let op = Op::parse(c.str()?).filter(|&op| version >= 11 || op != Op::Multimesh)?;
    let mut m = CmdMeta::new(op);
    match op {
        Op::Rect | Op::Line | Op::Circle => {
            c.lit(b",\"aa\":")?;
            m.b1 = c.boolean()?;
        }
        Op::TextureRect => {
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b",\"tile\":")?;
            m.b1 = c.boolean()?;
            c.lit(b",\"transpose\":")?;
            m.b2 = c.boolean()?;
        }
        Op::TextureRectRegion => {
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b",\"transpose\":")?;
            m.b1 = c.boolean()?;
            c.lit(b",\"clip_uv\":")?;
            m.b2 = c.boolean()?;
        }
        Op::Msdf => {
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b",\"outline\":")?;
            m.outline = c.int_ge(0)?;
        }
        Op::Polyline | Op::Multiline => {
            c.lit(b",\"aa\":")?;
            m.b1 = c.boolean()?;
            c.lit(b",\"n\":")?;
            m.n = c.uint()?;
            c.lit(b",\"colors\":")?;
            m.colors = c.uint()?;
        }
        Op::Primitive | Op::Polygon | Op::TriangleArray => {
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b",\"n\":")?;
            m.n = c.uint()?;
            c.lit(b",\"colors\":")?;
            m.colors = c.uint()?;
            c.lit(b",\"uvs\":")?;
            m.uvs = c.uint()?;
            if op == Op::TriangleArray {
                c.lit(b",\"indices\":")?;
                m.indices = c.uint()?;
                c.lit(b",\"count\":")?;
                m.count = c.int()?;
                c.lit(b",\"i\":")?;
                m.i = c.uint()?;
            }
        }
        Op::NinePatch => {
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b",\"x_axis\":")?;
            m.x_axis = c.enum_of(Axis::ALL, Axis::as_str)?;
            c.lit(b",\"y_axis\":")?;
            m.y_axis = c.enum_of(Axis::ALL, Axis::as_str)?;
            c.lit(b",\"draw_center\":")?;
            m.b1 = c.boolean()?;
        }
        Op::Mesh => {
            c.lit(b",\"mesh\":")?;
            m.mesh = c.id1()?;
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
        }
        Op::SetTransform => {}
        Op::ClipIgnore => {
            c.lit(b",\"ignore\":")?;
            m.b1 = c.boolean()?;
            c.lit(b"}")?;
            out.push(m);
            return Some(());
        }
        Op::Multimesh => {
            c.lit(b",\"multimesh\":")?;
            m.mesh = c.id1()?;
            c.lit(b",\"tex\":")?;
            m.tex = c.opt_id1()?;
            c.lit(b"}")?;
            out.push(m);
            return Some(());
        }
        Op::Unsupported => {
            c.lit(b",\"name\":")?;
            m.name = Some(c.owned()?);
            c.lit(b",\"reason\":")?;
            m.reason = c
                .enum_of(UnsupportedCmdReason::ALL, UnsupportedCmdReason::as_str)
                .filter(|&r| version >= 11 || r != UnsupportedCmdReason::UnknownMultimesh)?;
            c.lit(b"}")?;
            out.push(m);
            return Some(());
        }
    }
    c.lit(b",\"f\":")?;
    m.f = c.uint()?;
    c.lit(b"}")?;
    out.push(m);
    Some(())
}

fn ids(c: &mut Cur, out: &mut Vec<Id>) -> O<Rng> {
    let start = out.len() as u32;
    c.list(|c| {
        out.push(c.id()?);
        Some(())
    })?;
    Some(Rng {
        start,
        end: out.len() as u32,
    })
}

fn ints(c: &mut Cur, out: &mut Vec<i64>) -> O<()> {
    out.clear();
    c.list(|c| {
        out.push(c.int()?);
        Some(())
    })
}

fn texture(c: &mut Cur) -> O<Texture> {
    c.lit(b"{\"id\":")?;
    let id = c.id1()?;
    c.lit(b",\"origin\":\"created\",\"kind\":")?;
    let kind = c.enum_of(TextureKind::ALL, TextureKind::as_str)?;
    c.lit(b",\"status\":")?;
    let status = c.enum_of(EntryStatus::ALL, EntryStatus::as_str)?;
    c.lit(b",\"reason\":")?;
    let reason = if c.null() {
        None
    } else {
        Some(c.one_of(TEXTURE_REASONS)?)
    };
    c.lit(b",\"version\":")?;
    let version = c.int_ge(1)?;
    c.lit(b",\"hash\":")?;
    let hash = if c.null() { None } else { Some(c.hash()?) };
    c.lit(b",\"format\":")?;
    let format = if c.null() { None } else { Some(c.owned()?) };
    c.lit(b",\"width\":")?;
    let width = c.int_ge(0)?;
    c.lit(b",\"height\":")?;
    let height = c.int_ge(0)?;
    c.lit(b",\"mipmaps\":")?;
    let mipmaps = c.boolean()?;
    c.lit(b",\"payload_bytes\":")?;
    let payload_bytes = c.int_ge(0)?;
    c.lit(b",\"canvas\":")?;
    let canvas = if c.null() {
        None
    } else {
        c.lit(b"{\"diffuse\":")?;
        let diffuse = c.opt_id1()?;
        c.lit(b",\"filter\":")?;
        let filter = filter(c)?;
        c.lit(b",\"repeat\":")?;
        let repeat = repeat(c)?;
        c.lit(b"}")?;
        Some(CanvasTexture {
            diffuse,
            filter,
            repeat,
        })
    };
    c.lit(b"}")?;
    Some(Texture {
        id,
        origin: Origin::Created,
        adopted_content: None,
        kind,
        status,
        reason,
        version,
        hash,
        format,
        source_format: None,
        width,
        height,
        mipmaps,
        payload_bytes,
        variants: Vec::new(),
        canvas,
    })
}

/// W11c: from /8 a created mesh carries `"adopted_content":null` (an adopted one is the general
/// path's), and from /11 `"u8"` after `"f"` and a dynamic surface's null `"hash"`; the
/// `mesh-dynamic` rules over them are the validator's, as on the general path.
fn mesh(c: &mut Cur, version: u8) -> O<MeshMeta> {
    let v11 = version >= 11;
    c.lit(b"{\"id\":")?;
    let id = c.id1()?;
    if version >= 8 {
        c.lit(b",\"origin\":\"created\",\"adopted_content\":null,\"status\":")?;
    } else {
        c.lit(b",\"origin\":\"created\",\"status\":")?;
    }
    let status = c.enum_of(EntryStatus::ALL, EntryStatus::as_str)?;
    c.lit(b",\"reason\":")?;
    let reason = if c.null() {
        None
    } else {
        Some(c.one_of(MESH_REASONS)?)
    };
    c.lit(b",\"version\":")?;
    let version = c.int_ge(1)?;
    c.lit(b",\"f\":")?;
    let f = if c.null() { None } else { Some(c.uint()?) };
    let u8_offset = if v11 {
        c.lit(b",\"u8\":")?;
        if c.null() {
            None
        } else {
            Some(c.uint()?)
        }
    } else {
        None
    };
    c.lit(b",\"surfaces\":")?;
    let mut surfaces = Vec::new();
    c.list(|c| {
        c.lit(b"{\"hash\":")?;
        let hash = if v11 && c.null() {
            None
        } else {
            Some(c.hash()?)
        };
        c.lit(b",\"payload_bytes\":")?;
        let payload_bytes = c.int_ge(1)?;
        c.lit(b",\"primitive\":")?;
        let primitive = c.enum_of(Primitive::ALL, Primitive::as_str)?;
        c.lit(b",\"format\":")?;
        let format = c.int()?;
        c.lit(b",\"vertex_count\":")?;
        let vertex_count = c.int_ge(0)?;
        c.lit(b",\"index_count\":")?;
        let index_count = c.int_ge(0)?;
        c.lit(b"}")?;
        surfaces.push(MeshSurface {
            hash,
            body_sha256: None,
            payload_bytes,
            primitive,
            format,
            vertex_count,
            index_count,
        });
        Some(())
    })?;
    c.lit(b"}")?;
    Some(MeshMeta {
        id,
        origin: Origin::Created,
        adopted_content: None,
        status,
        reason,
        version,
        f,
        u8: u8_offset,
        surfaces,
    })
}

fn shader(c: &mut Cur) -> O<Shader> {
    c.lit(b"{\"id\":")?;
    let id = c.id1()?;
    c.lit(b",\"origin\":\"created\",\"status\":")?;
    let status = match c.one_of(&["ok", "unsupported"])? {
        "ok" => EntryStatus::Ok,
        _ => EntryStatus::Unsupported,
    };
    c.lit(b",\"reason\":")?;
    let reason = if c.null() {
        None
    } else {
        Some(c.one_of(SHADER_REASONS)?)
    };
    if (status == EntryStatus::Ok) != reason.is_none() {
        return None;
    }
    c.lit(b",\"version\":")?;
    let version = c.int_ge(1)?;
    c.lit(b",\"mode\":")?;
    let mode = if c.null() {
        None
    } else {
        Some(c.enum_of(ShaderMode::ALL, ShaderMode::as_str)?)
    };
    c.lit(b",\"source\":")?;
    let source = if c.null() {
        None
    } else {
        Some(c.enum_of(ShaderSource::ALL, ShaderSource::as_str)?)
    };
    if mode.is_none() != source.is_none() {
        return None;
    }
    c.lit(b",\"hash\":")?;
    let hash = if c.null() { None } else { Some(c.hash()?) };
    c.lit(b",\"payload_bytes\":")?;
    let payload_bytes = c.int_ge(0)?;
    c.lit(b",\"builtin\":")?;
    let builtin = if c.null() {
        None
    } else {
        c.lit(b"{\"kind\":\"canvas_item_material\",\"blend_mode\":")?;
        let blend_mode = c.enum_of(BlendMode::ALL, BlendMode::as_str)?;
        c.lit(b",\"light_mode\":")?;
        let light_mode = c.enum_of(LightMode::ALL, LightMode::as_str)?;
        c.lit(b",\"particles_animation\":")?;
        let particles_animation = c.boolean()?;
        c.lit(b"}")?;
        Some(Builtin {
            blend_mode,
            light_mode,
            particles_animation,
        })
    };
    c.lit(b",\"uses\":")?;
    let mut uses: Vec<ShaderUse> = Vec::new();
    c.list(|c| {
        uses.push(c.enum_of(ShaderUse::ALL, ShaderUse::as_str)?);
        Some(())
    })?;
    if uses.windows(2).any(|w| w[0].as_str() > w[1].as_str()) {
        return None;
    }
    c.lit(b",\"default_textures\":")?;
    let mut default_textures: Vec<DefaultTexture> = Vec::new();
    c.list(|c| {
        c.lit(b"{\"name\":")?;
        let name = c.owned()?;
        c.lit(b",\"index\":")?;
        let index = c.int_ge(0)?;
        c.lit(b",\"tex\":")?;
        let tex = c.id1()?;
        c.lit(b"}")?;
        if let Some(l) = default_textures.last() {
            let o = js_cmp(l.name.as_bytes(), name.as_bytes());
            if !(o == Ordering::Less || (o == Ordering::Equal && l.index < index)) {
                return None;
            }
        }
        default_textures.push(DefaultTexture { name, index, tex });
        Some(())
    })?;
    c.lit(b"}")?;
    Some(Shader {
        id,
        origin: Origin::Created,
        status,
        reason,
        version,
        mode,
        source,
        hash,
        payload_bytes,
        builtin,
        uses,
        default_textures,
    })
}

fn material(c: &mut Cur, params: &mut Vec<ParamMeta>) -> O<MaterialMeta> {
    c.lit(b"{\"id\":")?;
    let id = c.id1()?;
    c.lit(b",\"origin\":\"created\",\"status\":")?;
    let status = match c.one_of(&["ok", "unsupported"])? {
        "ok" => EntryStatus::Ok,
        _ => EntryStatus::Unsupported,
    };
    c.lit(b",\"reason\":")?;
    let reason = if c.null() {
        None
    } else {
        Some(c.one_of(MATERIAL_REASONS)?)
    };
    if (status == EntryStatus::Ok) != reason.is_none() {
        return None;
    }
    c.lit(b",\"version\":")?;
    let version = c.int_ge(1)?;
    c.lit(b",\"shader\":")?;
    let shader = c.opt_id1()?;
    c.lit(b",\"params\":")?;
    let start = params.len();
    c.list(|c| param(c, params, start))?;
    c.lit(b"}")?;
    Some(MaterialMeta {
        id,
        origin: Origin::Created,
        status,
        reason,
        version,
        shader,
        params: Rng {
            start: start as u32,
            end: params.len() as u32,
        },
    })
}

/// The fast path for a whole transaction meta: `Some(())` with `tx` filled exactly as
/// `check_transaction` fills it, or `None` (then `tx` is garbage and the caller runs the general
/// path, which clears it).
/// /11: one `multimeshes[]` entry (`check_multimesh`'s schema).
fn multimesh(c: &mut Cur) -> O<MultimeshMeta> {
    c.lit(b"{\"id\":")?;
    let id = c.id1()?;
    c.lit(b",\"origin\":")?;
    let origin = Origin::parse(c.one_of(MULTIMESH_ORIGINS)?)?;
    c.lit(b",\"status\":")?;
    let status = c.enum_of(EntryStatus::ALL, EntryStatus::as_str)?;
    c.lit(b",\"reason\":")?;
    let reason = if c.null() {
        None
    } else {
        Some(c.one_of(MULTIMESH_REASONS)?)
    };
    c.lit(b",\"version\":")?;
    let version = c.int_ge(1)?;
    c.lit(b",\"mesh\":")?;
    let mesh = c.opt_id1()?;
    c.lit(b",\"format\":")?;
    let format = c.enum_of(MultimeshFormat::ALL, MultimeshFormat::as_str)?;
    c.lit(b",\"colors\":")?;
    let colors = c.boolean()?;
    c.lit(b",\"custom\":")?;
    let custom = c.boolean()?;
    c.lit(b",\"instances\":")?;
    let instances = c.int_ge(0)?;
    c.lit(b",\"visible\":")?;
    let visible = c.int_ge(-1)?;
    c.lit(b",\"aabb_f\":")?;
    let aabb_f = if c.null() { None } else { Some(c.uint()?) };
    c.lit(b",\"buffer_f\":")?;
    let buffer_f = if c.null() { None } else { Some(c.uint()?) };
    c.lit(b"}")?;
    Some(MultimeshMeta {
        id,
        origin,
        status,
        reason,
        version,
        mesh,
        format,
        colors,
        custom,
        instances,
        visible,
        aabb_f,
        buffer_f,
    })
}

pub(super) fn transaction(meta: &[u8], version: u8, tx: &mut TxMeta) -> O<()> {
    tx.clear();
    let v4 = version >= 4;
    let v5 = version >= 5;
    let v6 = version >= 6;
    let v10 = version >= 10;
    let c = &mut Cur { s: meta, p: 0 };
    c.lit(b"{\"type\":\"transaction\",\"seq\":")?;
    tx.seq = c.int_ge(1)?;
    c.lit(b",\"frame\":")?;
    tx.frame = c.int_ge(1)?;
    c.lit(b",\"encoding\":")?;
    tx.encoding = Some(c.enum_of(Encoding::ALL, Encoding::as_str)?);
    c.lit(b",\"base_seq\":")?;
    tx.base_seq = if c.null() { None } else { Some(c.int_ge(1)?) };
    c.lit(b",\"status\":")?;
    tx.status = Some(c.enum_of(TxStatus::ALL, TxStatus::as_str)?);
    c.lit(b",\"failures\":")?;
    let failures = &mut tx.failures;
    c.list(|c| {
        c.lit(b"{\"reason\":")?;
        let reason = c.one_of(FAILURE_REASONS)?;
        c.lit(b",\"detail\":")?;
        let detail = c.owned()?;
        c.lit(b"}")?;
        failures.push(Failure { reason, detail });
        Some(())
    })?;
    c.lit(b",\"unsupported\":")?;
    // WB (/11): a patch's null `unsupported` ("as the base"); a full's is the general path's
    // `meta-schema`.
    let unsupported_null = version >= 11 && c.null();
    if unsupported_null && tx.encoding != Some(Encoding::Patch) {
        return None;
    }
    tx.unsupported_null = unsupported_null;
    let unsupported = &mut tx.unsupported;
    if !unsupported_null {
        c.list(|c| {
            c.lit(b"{\"op\":")?;
            let op = c.owned()?;
            c.lit(b",\"item\":")?;
            let item = if c.null() { None } else { Some(c.int()?) };
            c.lit(b",\"reason\":")?;
            let allowed = if v6 {
                if item.is_none() {
                    SESSION_UNSUPPORTED_REASONS_V6
                } else if version >= 11 {
                    ITEM_UNSUPPORTED_REASONS_V11
                } else {
                    ITEM_UNSUPPORTED_REASONS_V5
                }
            } else if v5 {
                if item.is_none() {
                    SESSION_UNSUPPORTED_REASONS_V5
                } else {
                    ITEM_UNSUPPORTED_REASONS_V5
                }
            } else if item.is_none() {
                SESSION_UNSUPPORTED_REASONS
            } else {
                ITEM_UNSUPPORTED_REASONS
            };
            let reason = c.one_of(allowed)?;
            c.lit(b"}")?;
            unsupported.push(UnsupportedMeta { op, item, reason });
            Some(())
        })?;
    }
    if v4 && c.lit(b",\"unknown_items\":{\"unknown_rids\":").is_some() {
        let unknown_rids = c.int_ge(0)?;
        c.lit(b",\"withheld_items\":")?;
        let withheld_items = c.int_ge(0)?;
        c.lit(b",\"withheld_commands\":")?;
        let withheld_commands = c.int_ge(0)?;
        c.lit(b",\"unknown_calls\":")?;
        let unknown_calls = c.int_ge(0)?;
        c.lit(b"}")?;
        tx.unknown_items = Some(UnknownItems {
            unknown_rids,
            withheld_items,
            withheld_commands,
            unknown_calls,
        });
    }
    c.lit(b",\"default_texture_filter\":")?;
    tx.default_texture_filter = Some(filter(c).filter(|&f| f != Filter::Default)?);
    c.lit(b",\"default_texture_repeat\":")?;
    tx.default_texture_repeat = Some(repeat(c).filter(|&r| r != Repeat::Default)?);
    c.lit(b",\"removed_canvases\":")?;
    ints(c, &mut tx.removed_canvases)?;
    c.lit(b",\"removed_items\":")?;
    ints(c, &mut tx.removed_items)?;
    c.lit(b",\"removed_textures\":")?;
    ints(c, &mut tx.removed_textures)?;
    if v4 {
        c.lit(b",\"removed_meshes\":")?;
        ints(c, &mut tx.removed_meshes)?;
    }
    if v5 {
        c.lit(b",\"removed_shaders\":")?;
        ints(c, &mut tx.removed_shaders)?;
        c.lit(b",\"removed_materials\":")?;
        ints(c, &mut tx.removed_materials)?;
    }

    c.lit(b",\"canvases\":")?;
    let (canvases, ids_buf) = (&mut tx.canvases, &mut tx.ids);
    c.list(|c| {
        c.lit(b"{\"id\":")?;
        let id = c.id()?;
        c.lit(b",\"origin\":")?;
        let origin = origin(c)?;
        c.lit(b",\"role\":")?;
        let root = if c.null() {
            false
        } else {
            c.lit(b"\"root\"")?;
            true
        };
        c.lit(b",\"attached\":")?;
        let attached = c.boolean()?;
        let layer = if v6 {
            c.lit(b",\"layer\":")?;
            let l = c.int()?;
            c.lit(b",\"sublayer\":")?;
            Some((l, c.int()?))
        } else {
            None
        };
        c.lit(b",\"items\":")?;
        let items = ids(c, ids_buf)?;
        c.lit(b"}")?;
        canvases.push(CanvasMeta {
            id,
            origin,
            root,
            attached,
            layer,
            items,
        });
        Some(())
    })?;

    c.lit(b",\"items\":")?;
    let (items, ids_buf, params, cmds) = (&mut tx.items, &mut tx.ids, &mut tx.params, &mut tx.cmds);
    c.list(|c| {
        c.lit(b"{\"id\":")?;
        let id = c.id()?;
        c.lit(b",\"origin\":")?;
        let origin = origin(c)?;
        c.lit(b",\"parent\":")?;
        let parent = if c.null() {
            None
        } else {
            c.lit(b"{\"kind\":")?;
            let kind = c.enum_of(ParentKind::ALL, ParentKind::as_str)?;
            c.lit(b",\"id\":")?;
            let pid = c.id()?;
            c.lit(b"}")?;
            Some(Parent { kind, id: pid })
        };
        c.lit(b",\"children\":")?;
        let children = ids(c, ids_buf)?;
        c.lit(b",\"visible\":")?;
        let visible = c.boolean()?;
        c.lit(b",\"draw_index\":")?;
        let draw_index = c.int()?;
        c.lit(b",\"z_index\":")?;
        let z_index = c.int()?;
        c.lit(b",\"z_relative\":")?;
        let z_relative = c.boolean()?;
        c.lit(b",\"behind\":")?;
        let behind = c.boolean()?;
        c.lit(b",\"clip\":")?;
        let clip = c.boolean()?;
        c.lit(b",\"custom_rect\":")?;
        let custom_rect = c.boolean()?;
        c.lit(b",\"visibility_layer\":")?;
        let visibility_layer = u32::try_from(c.int()?).ok()?;
        c.lit(b",\"texture_filter\":")?;
        let texture_filter = filter(c)?;
        c.lit(b",\"texture_repeat\":")?;
        let texture_repeat = repeat(c)?;
        let (mut material, mut use_parent_material, mut instance_params) =
            (None, false, Rng::default());
        if v5 {
            c.lit(b",\"material\":")?;
            material = c.opt_id1()?;
            c.lit(b",\"use_parent_material\":")?;
            use_parent_material = c.boolean()?;
            c.lit(b",\"instance_params\":")?;
            let start = params.len();
            c.list(|c| param(c, params, start))?;
            instance_params = Rng {
                start: start as u32,
                end: params.len() as u32,
            };
        }
        let (mut canvas_group, mut copy_to_backbuffer) = (None, None);
        if v10 {
            c.lit(b",\"canvas_group\":")?;
            if !c.null() {
                c.lit(b"{\"mode\":")?;
                let mode = c.enum_of(CanvasGroupMode::ALL, CanvasGroupMode::as_str)?;
                c.lit(b",\"fit_empty\":")?;
                let fit_empty = c.boolean()?;
                c.lit(b",\"blur_mipmaps\":")?;
                let blur_mipmaps = c.boolean()?;
                c.lit(b",\"f\":")?;
                let f = c.uint()?;
                c.lit(b"}")?;
                canvas_group = Some(CanvasGroupMeta {
                    mode,
                    fit_empty,
                    blur_mipmaps,
                    f,
                });
            }
            c.lit(b",\"copy_to_backbuffer\":")?;
            if !c.null() {
                c.lit(b"{\"f\":")?;
                copy_to_backbuffer = Some(c.uint()?);
                c.lit(b"}")?;
            }
        }
        c.lit(b",\"content_version\":")?;
        let content_version = c.int()?;
        c.lit(b",\"commands\":")?;
        let commands = if c.null() {
            None
        } else {
            let start = cmds.len() as u32;
            c.list(|c| command(c, cmds, version))?;
            Some(Rng {
                start,
                end: cmds.len() as u32,
            })
        };
        c.lit(b"}")?;
        items.push(ItemMeta {
            id,
            origin,
            parent,
            children,
            visible,
            draw_index,
            z_index,
            z_relative,
            behind,
            clip,
            custom_rect,
            visibility_layer,
            texture_filter,
            texture_repeat,
            material,
            use_parent_material,
            instance_params,
            canvas_group,
            copy_to_backbuffer,
            content_version,
            commands,
        });
        Some(())
    })?;

    c.lit(b",\"textures\":")?;
    let textures = &mut tx.textures;
    c.list(|c| {
        textures.push(texture(c)?);
        Some(())
    })?;
    if v4 {
        c.lit(b",\"meshes\":")?;
        let meshes = &mut tx.meshes;
        c.list(|c| {
            meshes.push(mesh(c, version)?);
            Some(())
        })?;
    }
    if v5 {
        c.lit(b",\"shaders\":")?;
        let shaders = &mut tx.shaders;
        c.list(|c| {
            shaders.push(shader(c)?);
            Some(())
        })?;
        c.lit(b",\"materials\":")?;
        let (materials, params) = (&mut tx.materials, &mut tx.params);
        c.list(|c| {
            materials.push(material(c, params)?);
            Some(())
        })?;
    }
    // PM1 (render-stream-11.md "As built (PM1)" rule 1): /11's optional `multimeshes` and
    // `removed_multimeshes`, each non-empty when present (an empty list is the general path's
    // `meta-schema`).
    if version >= 11 && c.lit(b",\"multimeshes\":").is_some() {
        let mms = &mut tx.multimeshes;
        c.list(|c| {
            mms.push(multimesh(c)?);
            Some(())
        })?;
        if tx.multimeshes.is_empty() {
            return None;
        }
    }
    if version >= 11 && c.lit(b",\"removed_multimeshes\":").is_some() {
        ints(c, &mut tx.removed_multimeshes)?;
        if tx.removed_multimeshes.is_empty() {
            return None;
        }
    }
    // P3-TM: /10's optional `shader_time` (render-stream-10.md "Shader time").
    if v10 && c.lit(b",\"shader_time\":{\"f\":").is_some() {
        tx.shader_time_f = Some(c.int_ge(0)? as u64);
        c.lit(b"}")?;
    }
    c.lit(b",\"blocks\":[")?;
    let n = transaction_block_count(version);
    for i in 0..n {
        if i > 0 {
            c.lit(b",")?;
        }
        c.lit(b"{\"name\":\"")?;
        c.lit(TRANSACTION_BLOCK_NAMES[i].as_bytes())?;
        c.lit(b"\",\"type\":\"")?;
        let ty = if v4 {
            TRANSACTION_BLOCK_TYPES[i]
        } else {
            BlockType::F32
        };
        c.lit(ty.as_str().as_bytes())?;
        c.lit(b"\",\"count\":")?;
        let count = c.uint()?;
        c.lit(b"}")?;
        tx.blocks.push(BlockDesc { ty, count });
    }
    c.lit(b"]}")?;
    (c.p == meta.len()).then_some(())
}

#[cfg(test)]
mod tests {
    use super::super::{decode_record_with, DecodeBufs, Decoded, TxMeta};
    use crate::wire;
    use std::path::PathBuf;

    fn equivalent(data: &[u8], version: u8) -> usize {
        let mut fast_hits = 0;
        for r in &wire::split_records(data, version).unwrap() {
            let rec = r.bytes(data);
            let (mut b1, mut b2) = (DecodeBufs::default(), DecodeBufs::default());
            let (mut t1, mut t2) = (TxMeta::default(), TxMeta::default());
            let fast = decode_record_with(rec, r.offset, version, &mut b1, &mut t1, true);
            let slow = decode_record_with(rec, r.offset, version, &mut b2, &mut t2, false);
            assert_eq!(fast.is_ok(), slow.is_ok());
            if let (Ok(Decoded::Transaction), Ok(_)) = (&fast, &slow) {
                assert_eq!(
                    format!("{t1:?}"),
                    format!("{t2:?}"),
                    "record at {}",
                    r.offset
                );
                assert_eq!(b1.blocks, b2.blocks);
                assert_eq!(b1.descs, b2.descs);
                fast_hits += 1;
            }
            if let (Err(a), Err(b)) = (&fast, &slow) {
                assert_eq!(a.code, b.code);
            }
        }
        fast_hits
    }

    #[test]
    fn integers_up_to_2_pow_53_match_the_general_path() {
        // W11c: /11's content_version digests have 16 digits; the general path reads an f64.
        for (text, want) in [
            ("123456789012345", Some(123456789012345i64)),
            ("1984125798402717", Some(1984125798402717)),
            ("9007199254740992", Some(9007199254740992)),
            ("9007199254740993", None),
            ("9999999999999999", None),
            ("10000000000000000", None),
        ] {
            let mut c = super::Cur {
                s: text.as_bytes(),
                p: 0,
            };
            assert_eq!(c.int(), want, "{text}");
        }
    }

    /// W11c: the equivalence on any recording, `W11C_REC=<file> W11C_VERSION=<v> cargo test
    /// --release fast_path_matches_on_a_recording -- --ignored --nocapture` (an STS2 /11 capture:
    /// every transaction takes the fast path).
    #[test]
    #[ignore]
    fn fast_path_matches_on_a_recording() {
        let data = std::fs::read(std::env::var("W11C_REC").unwrap()).unwrap();
        let v: u8 = std::env::var("W11C_VERSION").map_or(11, |v| v.parse().unwrap());
        let hits = equivalent(&data, v);
        eprintln!("fast-path hits: {hits}");
    }

    #[test]
    fn fast_path_matches_the_general_path() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut hits = 0;
        for v in 2..=11u8 {
            let dir = base.join(format!("../protocol/golden-{v}"));
            for f in [
                "full",
                "patch",
                "inline",
                "params",
                "presentation",
                "snap",
                "rate",
            ] {
                if let Ok(data) = std::fs::read(dir.join(format!("{f}.rs{v}"))) {
                    hits += equivalent(&data, v);
                }
            }
        }
        assert!(hits > 50, "{hits}");
        let inputs = base.join("../../../artifacts/render-stream/gate7/g7x/inputs");
        for p in [
            "pace/capture/recording-patch.rs2",
            "scene/capture/recording-patch.rs2",
            "hd/capture/recording-patch.rs2",
        ] {
            if let Ok(data) = std::fs::read(inputs.join(p)) {
                assert!(equivalent(&data, wire::version_of_magic(&data).unwrap()) > 100);
            }
        }
    }
}
