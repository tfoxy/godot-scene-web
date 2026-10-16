//! The RenderingServer call stream the planner (`plan.rs`) writes and the C++ shim
//! (`receiver/ext/rs_core_ext.cpp`) executes as ptrcalls, in order, right after the planner returns.
//!
//! One op is a `u32` opcode followed by its operands, all `u32` words: an f32 is its bits, an i64
//! is two words (low, high), a bool is 0 or 1, a byte string is (offset, length) into the op
//! buffer's arena, and a RID is a [`RidRef`]. Variable-length float and int arrays are a count
//! word then the values. The opcode numbers and operand layouts are mirrored by hand in
//! `receiver/ext/rs_core_capi.h`; `OP_COUNT` is checked at session start on both sides.
//!
//! Resources are never named by RID here: every RID the shim creates goes into a per-kind table at
//! the handle the planner chose, so the planner never needs a RID value back.

/// What a RID operand names: a handle in one of the shim's per-kind tables, or a fixed RID.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RidRef {
    /// `RID()`.
    None,
    /// The root viewport (the receiver's own).
    Viewport,
    /// The root viewport's World2D canvas (wire canvas 1).
    RootCanvas,
    Item(u32),
    Canvas(u32),
    Texture(u32),
    Mesh(u32),
    Shader(u32),
    Material(u32),
}

pub const KIND_ITEM: u32 = 0;
pub const KIND_CANVAS: u32 = 1;
pub const KIND_TEXTURE: u32 = 2;
pub const KIND_MESH: u32 = 3;
pub const KIND_SHADER: u32 = 4;
pub const KIND_MATERIAL: u32 = 5;
pub const KIND_SPECIAL: u32 = 6;
pub const KIND_NONE: u32 = 7;

impl RidRef {
    /// kind in the top 3 bits, handle in the low 29 (special: 0 viewport, 1 root canvas).
    pub fn word(self) -> u32 {
        let (kind, handle) = match self {
            RidRef::None => (KIND_NONE, 0),
            RidRef::Viewport => (KIND_SPECIAL, 0),
            RidRef::RootCanvas => (KIND_SPECIAL, 1),
            RidRef::Item(h) => (KIND_ITEM, h),
            RidRef::Canvas(h) => (KIND_CANVAS, h),
            RidRef::Texture(h) => (KIND_TEXTURE, h),
            RidRef::Mesh(h) => (KIND_MESH, h),
            RidRef::Shader(h) => (KIND_SHADER, h),
            RidRef::Material(h) => (KIND_MATERIAL, h),
        };
        assert!(handle < (1 << 29), "handle space exhausted");
        (kind << 29) | handle
    }
}

macro_rules! opcodes {
    ($($name:ident = $n:literal),+ $(,)?) => {
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        #[repr(u32)]
        pub enum Op { $($name = $n),+ }
        pub const OP_COUNT: u32 = [$($n),+].len() as u32 + 1;
    };
}

// Operands per op, in order (see receiver/ext/rs_core_capi.h for the executor's view).
opcodes! {
    // color4
    SetDefaultClearColor = 1,
    // canvas, xform6 (viewport implicit)
    ViewportSetCanvasTransform = 2,
    // i64
    ViewportSetCanvasCullMask = 3,
    // rid
    FreeRid = 4,
    // texture handle
    Texture2dPlaceholderCreate = 5,
    // texture: texture_2d_placeholder_create() + texture_replace(texture, it) (2 RS calls)
    TextureReplaceWithPlaceholder = 6,
    // texture handle
    CanvasTextureCreate = 7,
    // texture, u32 channel, rid
    CanvasTextureSetChannel = 8,
    // texture, u32
    CanvasTextureSetFilter = 9,
    // texture, u32
    CanvasTextureSetRepeat = 10,
    // texture handle, image (format i32 (-1: not one of the six), w, h, mipmaps, bytes)
    Texture2dCreate = 11,
    // texture, image: texture_2d_update(texture, image, 0)
    Texture2dUpdate = 12,
    // texture, image: texture_replace(texture, texture_2d_create(image)) (2 RS calls)
    TextureReplaceWithImage = 13,
    // mesh handle
    MeshCreate = 14,
    // mesh
    MeshClear = 15,
    // mesh, u32 primitive, i64 format, i64 vertex_count, i64 index_count, aabb6, uv_scale4,
    // bytes vertex, bytes attribute, bytes skin, bytes index
    MeshAddSurface = 16,
    // mesh, aabb6
    MeshSetCustomAabb = 17,
    // mesh, u32 buffer (0 vertex, 1 attribute, 2 skin, 3 index), u32 surface, bytes
    MeshSurfaceUpdateRegion = 18,
    // shader handle
    ShaderCreate = 19,
    // shader, bytes (UTF-8 code)
    ShaderSetCode = 20,
    // shader, bytes name, rid texture, i64 index
    ShaderSetDefaultTexture = 21,
    // material handle
    MaterialCreate = 22,
    // material, rid shader
    MaterialSetShader = 23,
    // material, bytes name, bytes variant (vt.rs)
    MaterialSetParam = 24,
    // canvas handle
    CanvasCreate = 25,
    // canvas
    ViewportAttachCanvas = 26,
    // canvas
    ViewportRemoveCanvas = 27,
    // canvas, i64 layer, i64 sublayer
    ViewportSetCanvasStacking = 28,
    // canvas, color4
    CanvasSetModulate = 29,
    // u32
    ViewportSetDefaultFilter = 30,
    // u32
    ViewportSetDefaultRepeat = 31,
    // item handle
    CanvasItemCreate = 32,
    // item, rid parent
    ItemSetParent = 33,
    // item, xform6
    ItemSetTransform = 34,
    // item, color4
    ItemSetModulate = 35,
    // item, color4
    ItemSetSelfModulate = 36,
    // item, bool
    ItemSetVisible = 37,
    // item, bool
    ItemSetClip = 38,
    // item, bool, rect4
    ItemSetCustomRect = 39,
    // item, i64
    ItemSetVisibilityLayer = 40,
    // item, i64
    ItemSetZIndex = 41,
    // item, bool
    ItemSetZRelative = 42,
    // item, bool
    ItemSetDrawBehindParent = 43,
    // item, i64
    ItemSetDrawIndex = 44,
    // item, u32
    ItemSetDefaultFilter = 45,
    // item, u32
    ItemSetDefaultRepeat = 46,
    // item, rid material
    ItemSetMaterial = 47,
    // item, bool
    ItemSetUseParentMaterial = 48,
    // item, bytes name, bytes variant
    ItemSetInstanceParam = 49,
    // item
    ItemClear = 50,
    // item, rect4, color4, bool aa
    AddRect = 51,
    // item, rect4, rid tex, bool tile, color4, bool transpose
    AddTextureRect = 52,
    // item, rect4, rid tex, rect4 src, color4, bool transpose, bool clip_uv
    AddTextureRectRegion = 53,
    // item, rect4, rid tex, rect4 src, color4, i64 outline, f32 px_range, f32 scale
    AddMsdfTextureRectRegion = 54,
    // item, vec2 from, vec2 to, color4, f32 width, bool aa
    AddLine = 55,
    // item, points(n, 2n f32), colors(n, 4n f32), f32 width, bool aa
    AddPolyline = 56,
    // item, points, colors, f32 width, bool aa
    AddMultiline = 57,
    // item, vec2, f32 radius, color4, bool aa
    AddCircle = 58,
    // item, points, colors, uvs, rid tex
    AddPrimitive = 59,
    // item, points, colors, uvs, rid tex
    AddPolygon = 60,
    // item, indices(n, n i32), points, colors, uvs, rid tex, i64 count
    AddTriangleArray = 61,
    // item, rect4, rect4 source, rid tex, margins4, u32 x_axis, u32 y_axis, bool draw_center, color4
    AddNinePatch = 62,
    // item, xform6
    AddSetTransform = 63,
    // item, bool
    AddClipIgnore = 64,
    // item, rid mesh, xform6, color4, rid tex
    AddMesh = 65,
}

/// The planner's output for one call: the op words and the arena their byte operands point into.
#[derive(Default, Debug)]
pub struct OpBuf {
    pub words: Vec<u32>,
    pub arena: Vec<u8>,
    /// RenderingServer calls these ops make (some ops are two calls).
    pub rs_calls: u64,
}

impl OpBuf {
    pub fn clear(&mut self) {
        self.words.clear();
        self.arena.clear();
        self.rs_calls = 0;
    }
    #[inline]
    pub fn op(&mut self, op: Op, calls: u64) {
        self.words.push(op as u32);
        self.rs_calls += calls;
    }
    #[inline]
    pub fn u(&mut self, v: u32) {
        self.words.push(v);
    }
    #[inline]
    pub fn b(&mut self, v: bool) {
        self.words.push(v as u32);
    }
    #[inline]
    pub fn i64(&mut self, v: i64) {
        self.words.push(v as u64 as u32);
        self.words.push(((v as u64) >> 32) as u32);
    }
    #[inline]
    pub fn f(&mut self, v: f32) {
        self.words.push(v.to_bits());
    }
    #[inline]
    pub fn fs(&mut self, v: &[f32]) {
        self.words.extend(v.iter().map(|x| x.to_bits()));
    }
    #[inline]
    pub fn rid(&mut self, r: RidRef) {
        self.words.push(r.word());
    }
    /// A length-prefixed float array: `n` elements of `per` floats each.
    pub fn farray(&mut self, values: &[f32], per: usize) {
        debug_assert_eq!(values.len() % per, 0);
        self.words.push((values.len() / per) as u32);
        self.fs(values);
    }
    pub fn iarray(&mut self, values: &[i32]) {
        self.words.push(values.len() as u32);
        self.words.extend(values.iter().map(|&x| x as u32));
    }
    pub fn bytes(&mut self, data: &[u8]) {
        let at = self.arena.len();
        assert!(at + data.len() <= u32::MAX as usize, "op arena past 4 GiB");
        self.arena.extend_from_slice(data);
        self.words.push(at as u32);
        self.words.push(data.len() as u32);
    }
}
