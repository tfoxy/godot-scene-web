//! The resolved render-stream state, as `render-stream-2.ts`'s `ResolvedState` and
//! `ResolvedTransaction.state` hold it (render-stream-2.md to -6.md, "Decoded and resolved forms").
//!
//! This module is the contract between the decoder (`wire`, `meta`, `validate`) and its consumers
//! (`canon` for the cross-checks, `apply` for D7's applier). The decoder fills it; nothing else
//! writes it. Every float is the wire's float32 (or float64 for params) exactly; every list keeps
//! the wire's order; maps are keyed by wire id, so iteration is ascending id order, which is the
//! order the resolved form lists entries in.

pub use crate::idtable::IdTable;

pub type Id = u32;

/// SHA-256 digest bytes. Hex is lowercase on the wire and in every resolved form.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct Hash(pub [u8; 32]);

/// G7o3: a hash table keyed by a SHA-256 digest hashes its first 8 bytes (equal digests hash
/// equally; the table's own hasher still mixes them), not all 32 plus a length.
impl std::hash::Hash for Hash {
    #[inline]
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.0[..8]);
        state.write_u64(u64::from_le_bytes(b));
    }
}

impl Hash {
    pub fn to_hex(&self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(64);
        for b in self.0 {
            out.push(DIGITS[(b >> 4) as usize] as char);
            out.push(DIGITS[(b & 15) as usize] as char);
        }
        out
    }
    /// 64 lowercase hex digits, or None.
    pub fn from_hex(text: &str) -> Option<Hash> {
        let bytes = text.as_bytes();
        if bytes.len() != 64 {
            return None;
        }
        let digit = |c: u8| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        };
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = (digit(bytes[2 * i])? << 4) | digit(bytes[2 * i + 1])?;
        }
        Some(Hash(out))
    }
}

macro_rules! wire_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<$name> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

wire_enum!(Origin { Created = "created", RootQuery = "root-query", Adopted = "adopted" });
// render-stream-8.md "Resource tables": where an adopted texture's or mesh's content came from.
wire_enum!(AdoptedContent { Current = "current", Creation = "creation" });
// render-stream-9.md "Texture entries": the encoding of a texture variant, in wire (sorted) order.
wire_enum!(VariantEncoding { Block = "block", Uastc = "uastc", Etc1s = "etc1s" });
wire_enum!(ParentKind { Canvas = "canvas", Item = "item" });
wire_enum!(Encoding { Full = "full", Patch = "patch" });
wire_enum!(TxStatus { Ok = "ok", CaptureFailure = "capture-failure" });
wire_enum!(Filter {
    Default = "default",
    Nearest = "nearest",
    Linear = "linear",
    NearestMipmaps = "nearest_mipmaps",
    LinearMipmaps = "linear_mipmaps",
    NearestMipmapsAnisotropic = "nearest_mipmaps_anisotropic",
    LinearMipmapsAnisotropic = "linear_mipmaps_anisotropic",
});
// render-stream-10.md "Item": RS `CanvasGroupMode` 1, 2, 3 (0, disabled, is a null `canvas_group`).
wire_enum!(CanvasGroupMode {
    ClipOnly = "clip_only",
    ClipAndDraw = "clip_and_draw",
    Transparent = "transparent",
});
wire_enum!(Repeat { Default = "default", Disabled = "disabled", Enabled = "enabled", Mirror = "mirror" });
wire_enum!(Axis { Stretch = "stretch", Tile = "tile", TileFit = "tile_fit" });
wire_enum!(TextureKind { Image = "image", Placeholder = "placeholder", Canvas = "canvas" });
wire_enum!(EntryStatus { Ok = "ok", Unsupported = "unsupported", Freed = "freed" });
wire_enum!(Primitive {
    Points = "points",
    Lines = "lines",
    LineStrip = "line_strip",
    Triangles = "triangles",
    TriangleStrip = "triangle_strip",
});
wire_enum!(ShaderMode {
    CanvasItem = "canvas_item",
    Spatial = "spatial",
    Particles = "particles",
    Sky = "sky",
    Fog = "fog",
});
wire_enum!(ShaderSource { Payload = "payload", Withheld = "withheld" });
wire_enum!(BlendMode {
    Mix = "mix",
    Add = "add",
    Sub = "sub",
    Mul = "mul",
    PremulAlpha = "premul_alpha",
    Disabled = "disabled",
});
wire_enum!(LightMode { Normal = "normal", Unshaded = "unshaded", LightOnly = "light_only" });
wire_enum!(ShaderUse {
    GlobalUniform = "global_uniform",
    InstanceUniform = "instance_uniform",
    Light = "light",
    ScreenTexture = "screen_texture",
    Sdf = "sdf",
    Time = "time",
});
wire_enum!(UnsupportedCmdReason {
    UnsupportedOp = "unsupported-op",
    UnknownTexture = "unknown-texture",
    CanvasTextureHeadless = "canvas-texture-headless",
    UnknownMesh = "unknown-mesh",
    SkinnedGeometry = "skinned-geometry",
});
wire_enum!(VariantType {
    Nil = "nil",
    Bool = "bool",
    Int = "int",
    Float = "float",
    Vector2 = "vector2",
    Vector2i = "vector2i",
    Rect2 = "rect2",
    Rect2i = "rect2i",
    Vector3 = "vector3",
    Vector3i = "vector3i",
    Transform2d = "transform2d",
    Vector4 = "vector4",
    Vector4i = "vector4i",
    Plane = "plane",
    Quaternion = "quaternion",
    Aabb = "aabb",
    Basis = "basis",
    Transform3d = "transform3d",
    Projection = "projection",
    Color = "color",
    Rid = "rid",
    PackedInt32Array = "packed_int32_array",
    PackedInt64Array = "packed_int64_array",
    PackedFloat32Array = "packed_float32_array",
    PackedFloat64Array = "packed_float64_array",
    PackedVector2Array = "packed_vector2_array",
    PackedVector3Array = "packed_vector3_array",
    PackedVector4Array = "packed_vector4_array",
    PackedColorArray = "packed_color_array",
});

impl VariantType {
    /// gate5_5-design.md D8: float64 components per element (0 for nil and rid).
    pub fn components(self) -> u32 {
        use VariantType::*;
        match self {
            Nil | Rid => 0,
            Bool | Int | Float => 1,
            Vector2 | Vector2i => 2,
            Vector3 | Vector3i => 3,
            Rect2 | Rect2i | Vector4 | Vector4i | Plane | Quaternion | Color => 4,
            Transform2d | Aabb => 6,
            Basis => 9,
            Transform3d => 12,
            Projection => 16,
            PackedInt32Array | PackedInt64Array | PackedFloat32Array | PackedFloat64Array => 1,
            PackedVector2Array => 2,
            PackedVector3Array => 3,
            PackedVector4Array | PackedColorArray => 4,
        }
    }
    pub fn is_packed(self) -> bool {
        self.as_str().starts_with("packed_")
    }
}

/// `[x, y]` pairs, `[r, g, b, a]` quads or ints, as a span of a [`Commands`] arena.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Span {
    /// Index of the first FLOAT (or int) in the arena, not of the first element.
    pub start: u32,
    /// Number of elements (pairs for points/uvs, quads for colours, ints for indices).
    pub len: u32,
}

/// One resolved command (render-stream-2.md to -4.md "Decoded and resolved forms"). Variable-length
/// data lives in the owning [`Commands`] arenas and is addressed by [`Span`].
#[derive(Clone, PartialEq, Debug)]
pub enum Command {
    Rect {
        aa: bool,
        rect: [f32; 4],
        color: [f32; 4],
    },
    TextureRect {
        tex: Option<Id>,
        tile: bool,
        transpose: bool,
        rect: [f32; 4],
        modulate: [f32; 4],
    },
    TextureRectRegion {
        tex: Option<Id>,
        transpose: bool,
        clip_uv: bool,
        rect: [f32; 4],
        src: [f32; 4],
        modulate: [f32; 4],
    },
    MsdfTextureRectRegion {
        tex: Option<Id>,
        outline: i64,
        rect: [f32; 4],
        src: [f32; 4],
        modulate: [f32; 4],
        px_range: f32,
        scale: f32,
    },
    Line {
        aa: bool,
        from: [f32; 2],
        to: [f32; 2],
        colour: [f32; 4],
        width: f32,
    },
    /// `points`: pairs in `f32s`; `colors`: quads in `f32s`.
    Polyline {
        aa: bool,
        width: f32,
        points: Span,
        colors: Span,
    },
    Multiline {
        aa: bool,
        width: f32,
        points: Span,
        colors: Span,
    },
    Circle {
        aa: bool,
        position: [f32; 2],
        radius: f32,
        colour: [f32; 4],
    },
    Primitive {
        tex: Option<Id>,
        points: Span,
        colors: Span,
        uvs: Span,
    },
    Polygon {
        tex: Option<Id>,
        points: Span,
        colors: Span,
        uvs: Span,
    },
    /// `indices`: ints in `i32s`.
    TriangleArray {
        tex: Option<Id>,
        count: i64,
        points: Span,
        colors: Span,
        uvs: Span,
        indices: Span,
    },
    NinePatch {
        tex: Option<Id>,
        rect: [f32; 4],
        source: [f32; 4],
        margins: [f32; 4],
        x_axis: Axis,
        y_axis: Axis,
        draw_center: bool,
        modulate: [f32; 4],
    },
    Mesh {
        mesh: Id,
        tex: Option<Id>,
        transform: [f32; 6],
        modulate: [f32; 4],
    },
    SetTransform {
        transform: [f32; 6],
    },
    ClipIgnore {
        ignore: bool,
    },
    Unsupported {
        name: Box<str>,
        reason: UnsupportedCmdReason,
    },
}

impl Command {
    /// The wire op spelling (`add_rect`, ..., `unsupported`).
    pub fn op(&self) -> &'static str {
        match self {
            Command::Rect { .. } => "add_rect",
            Command::TextureRect { .. } => "add_texture_rect",
            Command::TextureRectRegion { .. } => "add_texture_rect_region",
            Command::MsdfTextureRectRegion { .. } => "add_msdf_texture_rect_region",
            Command::Line { .. } => "add_line",
            Command::Polyline { .. } => "add_polyline",
            Command::Multiline { .. } => "add_multiline",
            Command::Circle { .. } => "add_circle",
            Command::Primitive { .. } => "add_primitive",
            Command::Polygon { .. } => "add_polygon",
            Command::TriangleArray { .. } => "add_triangle_array",
            Command::NinePatch { .. } => "add_nine_patch",
            Command::Mesh { .. } => "add_mesh",
            Command::SetTransform { .. } => "add_set_transform",
            Command::ClipIgnore { .. } => "add_clip_ignore",
            Command::Unsupported { .. } => "unsupported",
        }
    }
    /// The command's `tex`, for every tex-bearing op.
    pub fn tex(&self) -> Option<Id> {
        match self {
            Command::TextureRect { tex, .. }
            | Command::TextureRectRegion { tex, .. }
            | Command::MsdfTextureRectRegion { tex, .. }
            | Command::Primitive { tex, .. }
            | Command::Polygon { tex, .. }
            | Command::TriangleArray { tex, .. }
            | Command::NinePatch { tex, .. }
            | Command::Mesh { tex, .. } => *tex,
            _ => None,
        }
    }
}

/// An item's command list with its variable-length data.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Commands {
    pub list: Vec<Command>,
    pub f32s: Vec<f32>,
    pub i32s: Vec<i32>,
}

impl Commands {
    pub fn pairs(&self, span: Span) -> &[f32] {
        &self.f32s[span.start as usize..span.start as usize + 2 * span.len as usize]
    }
    pub fn quads(&self, span: Span) -> &[f32] {
        &self.f32s[span.start as usize..span.start as usize + 4 * span.len as usize]
    }
    pub fn ints(&self, span: Span) -> &[i32] {
        &self.i32s[span.start as usize..span.start as usize + span.len as usize]
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Parent {
    pub kind: ParentKind,
    pub id: Id,
}

/// render-stream-5.md "Decoded and resolved forms": a resolved `<param>`.
#[derive(Clone, PartialEq, Debug)]
pub enum ParamValue {
    /// `"nil"`: JSON null.
    Nil,
    /// `"rid"`: `{"tex": id}`.
    Tex(Id),
    /// A non-packed type of one component: a JSON number.
    Scalar(f64),
    /// A non-packed compound type, or a one-component packed array: a flat JSON array.
    Flat(Vec<f64>),
    /// A multi-component packed array: an array of arrays of `components` numbers.
    Nested { components: u32, values: Vec<f64> },
}

#[derive(Clone, PartialEq, Debug)]
pub struct Param {
    pub name: Box<str>,
    pub ty: VariantType,
    pub value: ParamValue,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Canvas {
    pub id: Id,
    pub origin: Origin,
    /// `role: "root"` (else null).
    pub root: bool,
    pub attached: bool,
    /// /6 only (0 before).
    pub layer: i64,
    pub sublayer: i64,
    pub items: Vec<Id>,
    pub xform: [f32; 6],
    /// /5 and later (white before).
    pub modulate: [f32; 4],
}

#[derive(Clone, PartialEq, Debug)]
pub struct Item {
    pub id: Id,
    pub origin: Origin,
    pub parent: Option<Parent>,
    pub children: Vec<Id>,
    pub visible: bool,
    pub draw_index: i64,
    pub z_index: i64,
    pub z_relative: bool,
    pub behind: bool,
    pub clip: bool,
    pub custom_rect: bool,
    pub visibility_layer: u32,
    pub texture_filter: Filter,
    pub texture_repeat: Repeat,
    /// /5 and later.
    pub material: Option<Id>,
    pub use_parent_material: bool,
    pub instance_params: Vec<Param>,
    /// /10 only (render-stream-10.md "Item"): `None` is `CANVAS_GROUP_MODE_DISABLED`.
    pub canvas_group: Option<CanvasGroup>,
    /// /10 only: the `canvas_item_set_copy_to_backbuffer` rect (x, y, w, h) while enabled.
    pub copy_to_backbuffer: Option<[f32; 4]>,
    pub content_version: i64,
    pub xform: [f32; 6],
    pub modulate: [f32; 4],
    pub self_modulate: [f32; 4],
    pub custom_rect_rect: [f32; 4],
    pub commands: Commands,
}

/// An item's `canvas_item_set_canvas_group_mode` state, in the setter's argument order
/// (render-stream-10.md "Decoded and resolved forms").
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CanvasGroup {
    pub mode: CanvasGroupMode,
    pub clear_margin: f32,
    pub fit_empty: bool,
    pub fit_margin: f32,
    pub blur_mipmaps: bool,
}

impl CanvasGroup {
    /// RS's `CanvasGroupMode` value (1, 2 or 3).
    pub fn mode_value(&self) -> i64 {
        match self.mode {
            CanvasGroupMode::ClipOnly => 1,
            CanvasGroupMode::ClipAndDraw => 2,
            CanvasGroupMode::Transparent => 3,
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct CanvasTexture {
    pub diffuse: Option<Id>,
    pub filter: Filter,
    pub repeat: Repeat,
}

/// A texture-table entry, exactly as on the wire (render-stream-2.md "Texture").
#[derive(Clone, PartialEq, Debug)]
pub struct Texture {
    pub id: Id,
    /// `created` below /8; `created` or `adopted` at /8 (render-stream-8.md "Resource tables").
    pub origin: Origin,
    /// /8 only: non-null exactly when `origin` is `adopted`.
    pub adopted_content: Option<AdoptedContent>,
    pub kind: TextureKind,
    pub status: EntryStatus,
    /// The wire's texture reason spelling (render-stream-2.md "Texture reasons").
    pub reason: Option<&'static str>,
    pub version: i64,
    pub hash: Option<Hash>,
    /// An `Image.Format` name (any string the wire carried).
    pub format: Option<Box<str>>,
    /// /8 only: the format a host decode started from; non-null exactly for a host decode.
    pub source_format: Option<Box<str>>,
    pub width: i64,
    pub height: i64,
    pub mipmaps: bool,
    pub payload_bytes: i64,
    /// /9 only (render-stream-9.md "Texture entries"): the alternative payloads, sorted by
    /// encoding, at most one each; empty below /9.
    pub variants: Vec<TextureVariant>,
    pub canvas: Option<CanvasTexture>,
}

/// One alternative payload of an ok image texture (render-stream-9.md "Texture entries").
#[derive(Clone, PartialEq, Debug)]
pub struct TextureVariant {
    pub encoding: VariantEncoding,
    pub hash: Hash,
    pub payload_bytes: i64,
    /// `block` only: the source block format.
    pub format: Option<Box<str>>,
    /// Basis encodings only: the params_id.
    pub params: Option<Box<str>>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct MeshSurface {
    pub hash: Hash,
    pub payload_bytes: i64,
    pub primitive: Primitive,
    /// The engine's raw `ARRAY_FORMAT_*` mask (may exceed 32 bits).
    pub format: i64,
    pub vertex_count: i64,
    pub index_count: i64,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Mesh {
    pub id: Id,
    pub origin: Origin,
    /// /8 only: non-null exactly when `origin` is `adopted`.
    pub adopted_content: Option<AdoptedContent>,
    pub status: EntryStatus,
    /// The wire's mesh reason spelling.
    pub reason: Option<&'static str>,
    pub version: i64,
    pub custom_aabb: [f32; 6],
    pub surfaces: Vec<MeshSurface>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Builtin {
    pub blend_mode: BlendMode,
    pub light_mode: LightMode,
    pub particles_animation: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub struct DefaultTexture {
    pub name: Box<str>,
    pub index: i64,
    pub tex: Id,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Shader {
    pub id: Id,
    pub origin: Origin,
    /// `Ok` or `Unsupported` (no tombstones).
    pub status: EntryStatus,
    pub reason: Option<&'static str>,
    pub version: i64,
    pub mode: Option<ShaderMode>,
    pub source: Option<ShaderSource>,
    pub hash: Option<Hash>,
    pub payload_bytes: i64,
    pub builtin: Option<Builtin>,
    pub uses: Vec<ShaderUse>,
    pub default_textures: Vec<DefaultTexture>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Material {
    pub id: Id,
    pub origin: Origin,
    pub status: EntryStatus,
    pub reason: Option<&'static str>,
    pub version: i64,
    pub shader: Option<Id>,
    pub params: Vec<Param>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Failure {
    pub reason: &'static str,
    pub detail: Box<str>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnsupportedEntry {
    pub op: Box<str>,
    pub item: Option<Id>,
    /// The wire's reason spelling.
    pub reason: &'static str,
}

/// protocol/unknown-item-skip.md: the per-transaction account of a skip session.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct UnknownItems {
    pub unknown_rids: i64,
    pub withheld_items: i64,
    pub withheld_commands: i64,
    pub unknown_calls: i64,
}

/// The resolved state after the last accepted transaction (`state(seq)`), plus that
/// transaction's complete, never-patched fields.
#[derive(Clone, PartialEq, Debug)]
pub struct ResolvedState {
    /// The protocol version the state was decoded at (2 to 8): it selects which keys the resolved
    /// form carries (meshes from 4, shaders/materials/canvas modulate/item material from 5, canvas
    /// layer from 6).
    pub version: u8,
    pub seq: i64,
    pub frame: i64,
    pub encoding: Encoding,
    pub status: TxStatus,
    pub failures: Vec<Failure>,
    pub unsupported: Vec<UnsupportedEntry>,
    pub unknown_items: Option<UnknownItems>,
    /// P3-TM (render-stream/10): the host's shader time for this transaction (Godot's
    /// `RasterizerGLES3::time_total`), present exactly when the state holds an `ok` shader whose
    /// `uses` names `time`. `None` below /10 and on a TIME-free state.
    pub shader_time: Option<f64>,
    pub default_texture_filter: Filter,
    pub default_texture_repeat: Repeat,
    pub canvases: IdTable<Canvas>,
    pub items: IdTable<Item>,
    pub textures: IdTable<Texture>,
    pub meshes: IdTable<Mesh>,
    pub shaders: IdTable<Shader>,
    pub materials: IdTable<Material>,
}

impl ResolvedState {
    pub fn empty(version: u8) -> Self {
        ResolvedState {
            version,
            seq: 0,
            frame: 0,
            encoding: Encoding::Full,
            status: TxStatus::Ok,
            failures: Vec::new(),
            unsupported: Vec::new(),
            unknown_items: None,
            shader_time: None,
            default_texture_filter: Filter::Nearest,
            default_texture_repeat: Repeat::Disabled,
            canvases: IdTable::new(),
            items: IdTable::new(),
            textures: IdTable::new(),
            meshes: IdTable::new(),
            shaders: IdTable::new(),
            materials: IdTable::new(),
        }
    }
}

/// What the last accepted transaction changed, for consumers that work in O(changed) (D29): the
/// applier re-lowers only `items_commands`, re-walks only what an upsert or removal touched, and
/// moves item rows for the rest. Ids are ascending in every list. For a full transaction every
/// entry it carries counts as upserted, and `*_removed` lists every id of the previous state it
/// omitted.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct TxDelta {
    pub seq: i64,
    pub full: bool,
    pub canvases_upserted: Vec<Id>,
    pub canvases_removed: Vec<Id>,
    pub items_upserted: Vec<Id>,
    pub items_removed: Vec<Id>,
    /// Upserted items whose transaction carried a non-null `commands` (a new item or a changed
    /// `content_version`, or any item of a full transaction).
    pub items_commands: Vec<Id>,
    pub textures_upserted: Vec<Id>,
    pub textures_removed: Vec<Id>,
    pub meshes_upserted: Vec<Id>,
    pub meshes_removed: Vec<Id>,
    pub shaders_upserted: Vec<Id>,
    pub shaders_removed: Vec<Id>,
    pub materials_upserted: Vec<Id>,
    pub materials_removed: Vec<Id>,
    /// `default_texture_filter` or `default_texture_repeat` differs from the previous state's.
    pub defaults_changed: bool,
}

impl TxDelta {
    pub fn clear(&mut self) {
        *self = TxDelta::default();
    }

    /// G7q (credit window 2): folds a later transaction's delta into this one, so one apply of
    /// the later resolved state does what applying both in sequence would. Every list becomes
    /// the ascending union. An id both removed and upserted (removed by one transaction and
    /// re-created by a later one, or the reverse) stays in both: the applier removes first and
    /// then upserts only what the resolved state still holds, which is the sequential result.
    pub fn merge(&mut self, later: &TxDelta) {
        fn union(a: &mut Vec<Id>, b: &[Id]) {
            if b.is_empty() {
                return;
            }
            let mut out: Vec<Id> = Vec::with_capacity(a.len() + b.len());
            let (mut i, mut j) = (0, 0);
            while i < a.len() || j < b.len() {
                let next = if j >= b.len() || (i < a.len() && a[i] <= b[j]) {
                    let v = a[i];
                    i += 1;
                    if j < b.len() && b[j] == v {
                        j += 1;
                    }
                    v
                } else {
                    let v = b[j];
                    j += 1;
                    v
                };
                out.push(next);
            }
            *a = out;
        }
        self.seq = later.seq;
        self.full |= later.full;
        union(&mut self.canvases_upserted, &later.canvases_upserted);
        union(&mut self.canvases_removed, &later.canvases_removed);
        union(&mut self.items_upserted, &later.items_upserted);
        union(&mut self.items_removed, &later.items_removed);
        union(&mut self.items_commands, &later.items_commands);
        union(&mut self.textures_upserted, &later.textures_upserted);
        union(&mut self.textures_removed, &later.textures_removed);
        union(&mut self.meshes_upserted, &later.meshes_upserted);
        union(&mut self.meshes_removed, &later.meshes_removed);
        union(&mut self.shaders_upserted, &later.shaders_upserted);
        union(&mut self.shaders_removed, &later.shaders_removed);
        union(&mut self.materials_upserted, &later.materials_upserted);
        union(&mut self.materials_removed, &later.materials_removed);
        self.defaults_changed |= later.defaults_changed;
    }
}
