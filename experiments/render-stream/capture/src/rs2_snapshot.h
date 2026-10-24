// render-stream/2 snapshot model: the values a /2 encoder (rs2_codec) and diff (rs2_diff) work
// over. render-stream/2 is render-stream/1 plus textures (render-stream-2.md).
//
// Plain C++17, no engine or GDExtension types, header-only, so the codec, the diff, their unit
// tests and (from G2b2) the mirror and publisher can share one definition. The wire format these
// structs encode to is specified in experiments/render-stream/protocol/render-stream-2.md; the
// gate-2 behaviour that fills them in production is protocol/gate2-design.md. Field order here
// follows the wire's JSON key order and block float order.
//
// Three structs matter, as in rs1_snapshot.h:
//   Snapshot    the mirror's complete captured state for one frame (every canvas/item/texture
//               present, every item's full `commands`, `unsupported`/`failures` already computed
//               -- by the mirror in production; by hand in golden/test code here). Never encoded
//               directly.
//   Transaction the wire-level transaction record: either a full copy of a Snapshot
//               (make_full(), rs2_diff.h) or a patch against a base Snapshot (make_patch()), with
//               items'/textures' `commands`/entries nullable or omitted per the inclusion rule.
//               encode_transaction() (rs2_codec.h) turns a Transaction into bytes.
//   ResourceRecord  a standalone "resource" record: a content-addressed payload (an already-built
//               render-stream-texture/1 byte sequence) and its hash. Not part of a Snapshot --
//               resource records are a delivery mechanism, not resolved state (render-stream-2.md
//               "Resource record"). This file holds no texture-payload codec: computing or
//               verifying a render-stream-texture/1 payload's bytes is rs_texture_payload's job
//               (capture/src/rs_texture_payload.*, G2a), out of scope for G2b1's pure codec.
//
// Ids are wire ids, never engine RIDs: one counter per kind (canvas, item, texture) per session,
// starting at 1, never reused. Texture ids share ONE counter across image, placeholder and canvas
// kinds (render-stream-2.md D2), distinct from the item/canvas counters.
#ifndef GRC_RS2_SNAPSHOT_H
#define GRC_RS2_SNAPSHOT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace grc {
namespace rs2 {

// ----------------------------------------------------------------------------------- constants

// "GRS2\r\n\x1a\n". A different byte 3 is a different major version.
inline constexpr std::array<std::uint8_t, 8> kMagic = {0x47, 0x52, 0x53, 0x32,
                                                       0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocol = "render-stream/2";
inline constexpr const char *kPublication = "snapshot-or-patch";
inline constexpr const char *kPayloadSchema = "render-stream-texture/1";

// render-stream/3 (G4e1, render-stream-3.md): /2 plus one draw command
// (AddMsdfTextureRectRegion) and one host sabotage kind (PerturbGlyph). Rather than fork this
// whole module the way rs1 forked from rs0, /3 is implemented AS a protocol-version switch on
// Session (Session::version) inside the same rs2_* modules (gate4-design.md G4e1: "Renaming files
// is not part of this contract"). encode_session() picks the magic/protocol string from
// Session::version; everything else -- the new CommandKind and SabotageKind values -- is always
// representable, since a /2 session simply never uses them.
inline constexpr std::array<std::uint8_t, 8> kMagicV3 = {0x47, 0x52, 0x53, 0x33,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV3 = "render-stream/3";

// render-stream/4 (G5w, render-stream-4.md): /3 plus eleven new draw/state commands, a mesh
// table, a new `i32` block (`cmd_i32`), a new `mesh_f32` transaction block and a new mesh payload
// format (`render-stream-mesh/1`). As with /3 (gate4-design.md G4e1), /4 is a protocol-version
// switch on Session, not a fork.
inline constexpr std::array<std::uint8_t, 8> kMagicV4 = {0x47, 0x52, 0x53, 0x34,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV4 = "render-stream/4";
inline constexpr const char *kMeshPayloadSchema = "render-stream-mesh/1";

// render-stream/5 (G55w, render-stream-5.md): /4 plus a shader table, a material table, canvas
// modulate, item material/use_parent_material/instance_params and a new `f64` block
// (`param_f64`). As with /3 and /4 (gate5_5-design.md D1), /5 is a protocol-version switch on
// Session, not a fork: the capture and the receiver keep speaking /4 until G55d.
inline constexpr std::array<std::uint8_t, 8> kMagicV5 = {0x47, 0x52, 0x53, 0x35,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV5 = "render-stream/5";
inline constexpr const char *kShaderPayloadSchema = "render-stream-shader/1";

// render-stream/6 (G6w, render-stream-6.md): a session-and-canvas delta on /5 (gate6-design.md
// D1): presentation stretch declarations (`presentation_size`, `font_oversampling`, `snap_2d`),
// a new session key `publication`, canvas `layer`/`sublayer`, and five new session-level
// unsupported reasons. Transactions, blocks, items, commands, payloads, HTTP and control messages
// are byte-identical to /5 apart from the magic/protocol/subprotocol strings. As with /3 to /5
// (memory: g4e1-rs3-version-switch-pattern), /6 is a protocol-version switch on Session, not a
// fork: the capture and the receiver keep speaking /5 until G6b.
inline constexpr std::array<std::uint8_t, 8> kMagicV6 = {0x47, 0x52, 0x53, 0x36,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV6 = "render-stream/6";

// render-stream/7 (G7w, render-stream-7.md): a live-transport delta on /6 (gate7-design.md D2):
// the hello gains receiver_kind/credit_window/token/manifest_sha256/presentation geometry, the
// session's new top-level `publication` key gains `credit_window`, `error.reason` gains
// `unauthorized`, and HTTP gains CORS. Records, transactions, payloads and HTTP routes are
// byte-identical to /6 apart from the magic/protocol/subprotocol strings. As with /3 to /6
// (memory: g4e1-rs3-version-switch-pattern), /7 is a protocol-version switch on Session, not a
// fork: the capture and the receiver keep speaking /6 until G7n.
inline constexpr std::array<std::uint8_t, 8> kMagicV7 = {0x47, 0x52, 0x53, 0x37,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV7 = "render-stream/7";

// render-stream/8 (G8w, render-stream-8.md, gate8-design.md D1/Q6): /7 plus the late-join and
// compressed-texture wire delta: the session keys `adoption` and `resources.decode`, "adopted"
// origins in the texture/mesh/shader/material tables, `adopted_content` on texture and mesh
// entries, `source_format` on texture entries, the eight float payload formats and seven sabotage
// kinds. As with /3 to /7 it is a protocol-version switch on Session, not a fork, and it is
// opt-in: file sinks and the live listener speak it only when asked (GRC_STREAM_VERSION=8, a
// gate 8 policy, or a client offering render-stream.8).
inline constexpr std::array<std::uint8_t, 8> kMagicV8 = {0x47, 0x52, 0x53, 0x38,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV8 = "render-stream/8";

// render-stream/9 (G8k9, render-stream-9.md, texture-delivery-design.md D4/Q5): /8 plus the
// texture-delivery wire delta: the session key `resources.texture_delivery`, texture-entry
// `variants`, `block` GRT1 payloads and `render-stream-texture/ktx2` payloads (as variants only),
// the texture reason `delivery-pending`, and the hello keys `texture_encodings` / `gpu_formats`.
// Same version-switch pattern as /3 to /8, and opt-in: file sinks speak it only with
// GRC_STREAM_VERSION=9, the live listener offers `render-stream.9` only then, and no receiver's
// hello offers it yet.
inline constexpr std::array<std::uint8_t, 8> kMagicV9 = {0x47, 0x52, 0x53, 0x39,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV9 = "render-stream/9";

enum class ProtocolVersion : std::uint8_t { V2, V3, V4, V5, V6, V7, V8, V9 };

// True for /7, /8 and /9, the versions whose live transport is the /7 one (token hello, credit
// window, CORS). /8 is /7 plus render-stream-8.md's list and /9 is /8 plus render-stream-9.md's,
// so every "V7" cascade means "V7 or later".
inline constexpr bool is_v7_or_later(ProtocolVersion v) {
  return v == ProtocolVersion::V7 || v == ProtocolVersion::V8 || v == ProtocolVersion::V9;
}

// True for /8 and /9: the versions that carry render-stream-8.md's keys.
inline constexpr bool is_v8_or_later(ProtocolVersion v) {
  return v == ProtocolVersion::V8 || v == ProtocolVersion::V9;
}

// Floats per entry in the transaction blocks (render-stream-2.md "Transaction record"). Item and
// canvas float layouts are unchanged from /1; texture entries carry no floats at all.
inline constexpr std::size_t kItemFloats = 18;    // xform 6, modulate 4, self_modulate 4, custom rect 4
inline constexpr std::size_t kCanvasFloats = 6;   // xform 6
inline constexpr std::size_t kAddRectFloats = 8;              // rect 4, colour 4
inline constexpr std::size_t kAddTextureRectFloats = 8;       // rect 4, modulate 4
inline constexpr std::size_t kAddTextureRectRegionFloats = 12;  // rect 4, src 4, modulate 4
// new at /3: rect 4, src 4, modulate 4, px_range 1, scale 1 (render-stream-3.md "Command").
inline constexpr std::size_t kAddMsdfTextureRectRegionFloats = 14;
// new at /4 (render-stream-4.md "Command"): fixed float counts; the variable-length ops
// (AddPolyline/AddMultiline/AddPrimitive/AddPolygon/AddTriangleArray) are computed from their
// points/colors/uvs vectors instead.
inline constexpr std::size_t kAddLineFloats = 9;        // from 2, to 2, colour 4, width 1
inline constexpr std::size_t kAddCircleFloats = 7;       // position 2, radius 1, colour 4
inline constexpr std::size_t kAddNinePatchFloats = 16;   // rect 4, source 4, margins 2+2, modulate 4
inline constexpr std::size_t kAddMeshFloats = 10;        // transform 6, modulate 4
inline constexpr std::size_t kAddSetTransformFloats = 6;  // transform 6
// render-stream-4.md "Mesh payload": the custom AABB occupies six floats in mesh_f32 per present
// (non-freed) mesh entry.
inline constexpr std::size_t kMeshAabbFloats = 6;

inline constexpr std::size_t kMaxLiveItems = 4096;
inline constexpr std::size_t kMaxCommandsPerItem = 1024;

inline constexpr std::uint64_t kMaxJsonInteger = 9007199254740991ULL;

inline constexpr std::uint32_t kRootCanvasId = 1;

using Xform = std::array<float, 6>;  // x.x, x.y, y.x, y.y, origin.x, origin.y (Transform2D columns)
using Color4 = std::array<float, 4>; // r, g, b, a
using Rect4 = std::array<float, 4>;  // position.x, position.y, size.x, size.y

inline constexpr Xform kIdentityXform = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f};
inline constexpr Color4 kWhite = {1.0f, 1.0f, 1.0f, 1.0f};
inline constexpr Rect4 kZeroRect = {0.0f, 0.0f, 0.0f, 0.0f};

// ----------------------------------------------------------------------------------- enums
//
// Enums unchanged from /1 (Origin, CanvasRole, ParentKind, TransactionStatus, FailureReason,
// EndReason, Transport, Encoding, StretchMode, StretchAspect, ScaleMode, RootSizePolicy,
// HostSizeStatus) are redeclared here rather than reused across namespaces: rs1 and rs2 are
// frozen-independent, as rs0 and rs1 were (render-stream-2.md D1, "/1... stay as frozen, still-
// verified history").

enum class Origin : std::uint8_t { Created, RootQuery, Adopted };

// render-stream-8.md "Resource tables": where an adopted texture's or mesh's content came from.
// None encodes as null (a created entry).
enum class AdoptedContent : std::uint8_t { None, Current, Creation };

// render-stream-8.md "Session": resources.decode, the declared host texture-decode policy.
enum class TextureDecode : std::uint8_t { Off, Engine };

enum class CanvasRole : std::uint8_t { None, Root };  // None -> JSON null

enum class ParentKind : std::uint8_t { None, Canvas, Item };  // None -> JSON null

// AddMsdfTextureRectRegion: new at /3 (render-stream-3.md "Command"). AddLine..AddClipIgnore: new
// at /4 (render-stream-4.md "Command").
enum class CommandKind : std::uint8_t {
  AddRect,
  AddTextureRect,
  AddTextureRectRegion,
  AddMsdfTextureRectRegion,
  AddLine,
  AddPolyline,
  AddMultiline,
  AddCircle,
  AddPrimitive,
  AddPolygon,
  AddTriangleArray,
  AddNinePatch,
  AddMesh,
  AddSetTransform,
  AddClipIgnore,
  Unsupported,
};

// CanvasTextureHeadless (G2d): a texture draw naming RID() on a headless host, whose dummy
// storage's canvas_texture_allocate() returns RID() (render-stream-2.md "Commands").
// UnknownMesh/SkinnedGeometry: new at /4 (render-stream-4.md "Command"; D16).
enum class UnsupportedCmdReason : std::uint8_t {
  UnsupportedOp,
  UnknownTexture,
  CanvasTextureHeadless,
  UnknownMesh,
  SkinnedGeometry,
};

enum class TransactionStatus : std::uint8_t { Ok, CaptureFailure };

enum class FailureReason : std::uint8_t {
  RootQueryFailed,
  PreExistingObject,
  MirrorCapacity,
  RootSizeEnforceFailed,
};

enum class UnsupportedReason : std::uint8_t {
  UnsupportedOp,
  UnsupportedState,
  NonRootViewport,
  ExtraCanvas,
  DrawIndexTie,
  DegenerateHostSize,
  UnknownTexture,       // new at /2: derived from an unsupported "unknown-texture" command
  UnsupportedTexture,   // new at /2: a texture-rect command naming an unsupported texture entry
  CanvasTextureHeadless,  // G2d: derived from an unsupported "canvas-texture-headless" command
  UnknownMesh,          // new at /4: derived from an unsupported "unknown-mesh" command
  SkinnedGeometry,      // new at /4: derived from an unsupported "skinned-geometry" command
  UnsupportedMesh,      // new at /4: an add_mesh command naming an unsupported mesh entry
  UnsupportedMaterial,  // new at /5: an item's effective material (or a texture it names) is unsupported
  UnknownMaterial,      // new at /5: canvas_item_set_material named a material RID the mirror never saw
  ParamType,            // new at /5: an instance shader parameter of an unsupported Variant type
  CanvasLight,          // new at /5: session-level, sticky -- canvas_light_attach_to_canvas observed
  // --- new at /6 (gate6-design.md Q4), all session-level ("item": null) -------------------------
  CanvasStackingTie,       // viewport_set_canvas_stacking: two attached canvases share (layer, sublayer)
  CanvasRepeat,             // canvas_set_item_mirroring/_repeat, sticky
  CanvasFollowViewport,     // canvas_set_parent, sticky
  GlobalCanvasTransform,    // viewport_set_global_canvas_transform differs from the arm-time stretch
  Snap2d,                   // viewport_set_snap_2d_transforms_to_pixel/_vertices_to_pixel
};

enum class SabotageKind : std::uint8_t {
  None,
  FreezeFrame,
  OmitUpdate,
  PerturbTransform,
  OmitOp,
  PatchDropItem,
  DropMessage,
  IgnoreCredit,
  StaleCoalesce,
  StaleTexture,            // new at /2
  WrongHash,               // new at /2
  SpuriousTextureUpdate,   // new at /2
  DropResource,            // new at /2 (G2c2)
  Unpin,                   // new at /2 (G2c2)
  PerturbGlyph,            // new at /3 (G4e1/G4e2, render-stream-3.md)
  PerturbVertex,           // new at /4 (G5w, render-stream-4.md)
  PerturbShader,           // new at /5 (G55w, render-stream-5.md; gate5_5-design.md Q3c)
  RetainSuperseded,        // G6s (gate6-design.md Q5, Q6h): ServedResources.retire() never retires
                           // a superseded hash, so the host's retained set grows unboundedly
  // New at /8 (G8w, gate8-design.md Q2-Q5; render-stream-8.md "Sabotage kinds"). Declared on the
  // wire only in a /8 session; the behaviours land with G8a/G8t/G8h/G8m.
  AdoptSkipState,          // Q2: adoption declares structure without transforms or modulate
  AdoptNoRedraw,           // Q2: adoption does not queue the items' redraw
  AdoptSkipLayers,         // Q2: adoption leaves canvas layers unknown
  PerturbDecode,           // Q3: one texel flipped after a host decode, before hashing
  SizeBeforeAdopt,         // Q4: the presentation size is applied before the adoption walk
  AdoptRawShaderCode,      // Q5: an adopted shader publishes get_code() unpreprocessed
  AdoptSkipParams,         // Q5: adopted materials/shaders publish without their parameters
};

enum class EndReason : std::uint8_t { Shutdown, Disarm };

enum class Transport : std::uint8_t { File, Websocket };

enum class Encoding : std::uint8_t { Full, Patch };

enum class StretchMode : std::uint8_t { Disabled, CanvasItems, Viewport };
enum class StretchAspect : std::uint8_t { Ignore, Keep, KeepWidth, KeepHeight, Expand };
enum class ScaleMode : std::uint8_t { Fractional, Integer };
// Presentation: new at /6 (gate6-design.md D2, Q3a): `GRC_ROOT_SIZE=presentation:<W>x<H>`.
enum class RootSizePolicy : std::uint8_t { Observe, EnforceMinSize, Presentation };
// protocol/unknown-item-skip.md: what the mirror does with a canvas or item RID it never saw
// created. Strict (the default) is gate 0's sticky `pre-existing-object` capture failure; Skip is
// the opt-in diagnostic mode (GRC_UNKNOWN_ITEM=skip) that withholds the affected subtrees instead.
enum class UnknownItemPolicy : std::uint8_t { Strict, Skip };
enum class HostSizeStatus : std::uint8_t { Match, DegenerateVisible, DegenerateWindow };

// --- new at /2: textures, filter/repeat, resource delivery -----------------------------------

enum class TextureKind : std::uint8_t { Image, Placeholder, Canvas };
enum class TextureStatus : std::uint8_t { Ok, Unsupported, Freed };
// new at /9 (render-stream-9.md "Texture entries"), in wire order.
enum class VariantEncoding : std::uint8_t { Block, Uastc, Etc1s };

enum class TextureReason : std::uint8_t {
  UnsupportedFormat,
  PayloadTooLarge,
  PayloadUnavailable,
  UpdateShapeMismatch,
  LayeredUpdate,
  UnknownTexture,
  CanvasTextureChannel,
  DeliveryPending,  // new at /9 (render-stream-9.md): the async worker path had no hash yet
};

// RenderingServer.CanvasItemTextureFilter / CanvasItemTextureRepeat order (servers/rendering_
// server.h:925-942), used both for an item's own fields and the transaction-level defaults.
enum class Filter : std::uint8_t {
  Default, Nearest, Linear, NearestMipmaps, LinearMipmaps, NearestMipmapsAnisotropic,
  LinearMipmapsAnisotropic,
};
enum class Repeat : std::uint8_t { Default, Disabled, Enabled, Mirror };

enum class Delivery : std::uint8_t { OutOfBand, Inline, Mixed };
enum class Fetch : std::uint8_t { Http, Directory, None };
enum class Auth : std::uint8_t { None, Bearer };

// --- new at /4: mesh table, add_nine_patch axis modes (render-stream-4.md) --------------------

enum class AxisStretchMode : std::uint8_t { Stretch, Tile, TileFit };

// render-stream-4.md "Mesh payload": the five RenderingServer 2D primitive types a surface may
// declare.
enum class Primitive : std::uint8_t { Points, Lines, LineStrip, Triangles, TriangleStrip };

enum class MeshStatus : std::uint8_t { Ok, Unsupported, Freed };
enum class MeshReason : std::uint8_t { MeshFormat, MeshBlendShapes, PayloadTooLarge };

// --- new at /5: shader table, material table, param_f64 (render-stream-5.md) ------------------

// gate5_5-design.md D8: the Variant type names a material or instance parameter may carry on the
// wire, plus the numeric packed array types. "As built" (G55w): wire spellings are this codec's
// own decision (snake_case, matching the engine's own type names) -- the design doc lists the
// scalar names and the packed-array component words without committing to one concrete array
// spelling; render-stream-5.md "As built" documents the choice.
enum class VariantType : std::uint8_t {
  Nil, Bool, Int, Float, Vector2, Vector2i, Rect2, Rect2i, Vector3, Vector3i,
  Transform2D, Vector4, Vector4i, Plane, Quaternion, Aabb, Basis, Transform3D,
  Projection, Color, Rid,
  PackedInt32Array, PackedInt64Array, PackedFloat32Array, PackedFloat64Array,
  PackedVector2Array, PackedVector3Array, PackedVector4Array, PackedColorArray,
};

// render-stream-5.md "Shader table".
enum class ShaderMode : std::uint8_t { CanvasItem, Spatial, Particles, Sky, Fog };
enum class ShaderStatus : std::uint8_t { Ok, Unsupported };
enum class ShaderReason : std::uint8_t {
  ShaderMode, ShaderScreenTexture, ShaderSdf, ShaderTime, ShaderGlobalUniform,
  ShaderExcluded, PayloadTooLarge, PayloadUnavailable,
};
// gate5_5-design.md D11/Q3a: listed in `uses`, for information only (never drives `reason` except
// in the priority order D11 states: time, screen-texture, sdf, global-uniform, mode).
enum class ShaderUse : std::uint8_t {
  GlobalUniform, InstanceUniform, Light, ScreenTexture, Sdf, Time,
};
// D4: whether a shader's code travels as a GRP1 payload, is withheld by policy, or (shader has no
// code yet) is null on the wire -- represented here by ShaderEntry::has_source.
enum class ShaderSource : std::uint8_t { Payload, Withheld };
// gate5_5-design.md D7: the CanvasItemMaterial-generated shader's recognized blend/light modes.
enum class BlendMode : std::uint8_t { Mix, Add, Sub, Mul, PremulAlpha, Disabled };
enum class LightMode : std::uint8_t { Normal, Unshaded, LightOnly };

// render-stream-5.md "Material table".
enum class MaterialStatus : std::uint8_t { Ok, Unsupported };
enum class MaterialReason : std::uint8_t { UnknownShader, UnknownTexture, ParamType, ParamRange };

// gate5_5-design.md D4: the session's declared shader-source policy.
enum class ShaderPolicy : std::uint8_t { Source, Params, Exclude };

// --- new at /6 (render-stream-6.md "Session"; gate6-design.md D8) -----------------------------

// The session's declared live-publication rate control: `GRC_PUBLISH_FPS=uncapped|<1..240>`. A
// `file` stream is always EveryFrame/null.
enum class PublicationMode : std::uint8_t { EveryFrame, Rate };

// Wire spellings (render-stream-2.md). Each returns a string literal.
inline const char *to_wire(Origin v) {
  switch (v) {
  case Origin::Created: return "created";
  case Origin::RootQuery: return "root-query";
  case Origin::Adopted: return "adopted";
  }
  return "created";
}
inline const char *to_wire(ParentKind v) {
  return v == ParentKind::Canvas ? "canvas" : "item";  // None is encoded as null, never spelled
}
inline const char *to_wire(TransactionStatus v) {
  return v == TransactionStatus::Ok ? "ok" : "capture-failure";
}
inline const char *to_wire(FailureReason v) {
  switch (v) {
  case FailureReason::RootQueryFailed: return "root-query-failed";
  case FailureReason::PreExistingObject: return "pre-existing-object";
  case FailureReason::MirrorCapacity: return "mirror-capacity";
  case FailureReason::RootSizeEnforceFailed: return "root-size-enforce-failed";
  }
  return "root-query-failed";
}
inline const char *to_wire(UnsupportedReason v) {
  switch (v) {
  case UnsupportedReason::UnsupportedOp: return "unsupported-op";
  case UnsupportedReason::UnsupportedState: return "unsupported-state";
  case UnsupportedReason::NonRootViewport: return "non-root-viewport";
  case UnsupportedReason::ExtraCanvas: return "extra-canvas";
  case UnsupportedReason::DrawIndexTie: return "draw-index-tie";
  case UnsupportedReason::DegenerateHostSize: return "degenerate-host-size";
  case UnsupportedReason::UnknownTexture: return "unknown-texture";
  case UnsupportedReason::UnsupportedTexture: return "unsupported-texture";
  case UnsupportedReason::CanvasTextureHeadless: return "canvas-texture-headless";
  case UnsupportedReason::UnknownMesh: return "unknown-mesh";
  case UnsupportedReason::SkinnedGeometry: return "skinned-geometry";
  case UnsupportedReason::UnsupportedMesh: return "unsupported-mesh";
  case UnsupportedReason::UnsupportedMaterial: return "unsupported-material";
  case UnsupportedReason::UnknownMaterial: return "unknown-material";
  case UnsupportedReason::ParamType: return "param-type";
  case UnsupportedReason::CanvasLight: return "canvas-light";
  case UnsupportedReason::CanvasStackingTie: return "canvas-stacking-tie";
  case UnsupportedReason::CanvasRepeat: return "canvas-repeat";
  case UnsupportedReason::CanvasFollowViewport: return "canvas-follow-viewport";
  case UnsupportedReason::GlobalCanvasTransform: return "global-canvas-transform";
  case UnsupportedReason::Snap2d: return "snap-2d";
  }
  return "unsupported-op";
}
inline const char *to_wire(UnsupportedCmdReason v) {
  switch (v) {
  case UnsupportedCmdReason::UnsupportedOp: return "unsupported-op";
  case UnsupportedCmdReason::UnknownTexture: return "unknown-texture";
  case UnsupportedCmdReason::CanvasTextureHeadless: return "canvas-texture-headless";
  case UnsupportedCmdReason::UnknownMesh: return "unknown-mesh";
  case UnsupportedCmdReason::SkinnedGeometry: return "skinned-geometry";
  }
  return "unsupported-op";
}
inline const char *to_wire(SabotageKind v) {
  switch (v) {
  case SabotageKind::None: return "";  // None is encoded as null
  case SabotageKind::FreezeFrame: return "freeze-frame";
  case SabotageKind::OmitUpdate: return "omit-update";
  case SabotageKind::PerturbTransform: return "perturb-transform";
  case SabotageKind::OmitOp: return "omit-op";
  case SabotageKind::PatchDropItem: return "patch-drop-item";
  case SabotageKind::DropMessage: return "drop-message";
  case SabotageKind::IgnoreCredit: return "ignore-credit";
  case SabotageKind::StaleCoalesce: return "stale-coalesce";
  case SabotageKind::StaleTexture: return "stale-texture";
  case SabotageKind::WrongHash: return "wrong-hash";
  case SabotageKind::SpuriousTextureUpdate: return "spurious-texture-update";
  case SabotageKind::DropResource: return "drop-resource";
  case SabotageKind::Unpin: return "unpin";
  case SabotageKind::PerturbGlyph: return "perturb-glyph";
  case SabotageKind::PerturbVertex: return "perturb-vertex";
  case SabotageKind::PerturbShader: return "perturb-shader";
  case SabotageKind::RetainSuperseded: return "retain-superseded";
  case SabotageKind::AdoptSkipState: return "adopt-skip-state";
  case SabotageKind::AdoptNoRedraw: return "adopt-no-redraw";
  case SabotageKind::AdoptSkipLayers: return "adopt-skip-layers";
  case SabotageKind::PerturbDecode: return "perturb-decode";
  case SabotageKind::SizeBeforeAdopt: return "size-before-adopt";
  case SabotageKind::AdoptRawShaderCode: return "adopt-raw-shader-code";
  case SabotageKind::AdoptSkipParams: return "adopt-skip-params";
  }
  return "";
}
inline const char *to_wire(EndReason v) { return v == EndReason::Shutdown ? "shutdown" : "disarm"; }
inline const char *to_wire(Transport v) { return v == Transport::File ? "file" : "websocket"; }
inline const char *to_wire(Encoding v) { return v == Encoding::Full ? "full" : "patch"; }
inline const char *to_wire(StretchMode v) {
  switch (v) {
  case StretchMode::Disabled: return "disabled";
  case StretchMode::CanvasItems: return "canvas_items";
  case StretchMode::Viewport: return "viewport";
  }
  return "disabled";
}
inline const char *to_wire(StretchAspect v) {
  switch (v) {
  case StretchAspect::Ignore: return "ignore";
  case StretchAspect::Keep: return "keep";
  case StretchAspect::KeepWidth: return "keep_width";
  case StretchAspect::KeepHeight: return "keep_height";
  case StretchAspect::Expand: return "expand";
  }
  return "ignore";
}
inline const char *to_wire(ScaleMode v) { return v == ScaleMode::Fractional ? "fractional" : "integer"; }
inline const char *to_wire(RootSizePolicy v) {
  switch (v) {
  case RootSizePolicy::Observe: return "observe";
  case RootSizePolicy::EnforceMinSize: return "enforce-min-size";
  case RootSizePolicy::Presentation: return "presentation";
  }
  return "observe";
}
inline const char *to_wire(HostSizeStatus v) {
  switch (v) {
  case HostSizeStatus::Match: return "match";
  case HostSizeStatus::DegenerateVisible: return "degenerate-visible";
  case HostSizeStatus::DegenerateWindow: return "degenerate-window";
  }
  return "match";
}
inline const char *to_wire(TextureKind v) {
  switch (v) {
  case TextureKind::Image: return "image";
  case TextureKind::Placeholder: return "placeholder";
  case TextureKind::Canvas: return "canvas";
  }
  return "image";
}
inline const char *to_wire(TextureStatus v) {
  switch (v) {
  case TextureStatus::Ok: return "ok";
  case TextureStatus::Unsupported: return "unsupported";
  case TextureStatus::Freed: return "freed";
  }
  return "ok";
}
inline const char *to_wire(TextureReason v) {
  switch (v) {
  case TextureReason::UnsupportedFormat: return "unsupported-format";
  case TextureReason::PayloadTooLarge: return "payload-too-large";
  case TextureReason::PayloadUnavailable: return "payload-unavailable";
  case TextureReason::UpdateShapeMismatch: return "update-shape-mismatch";
  case TextureReason::LayeredUpdate: return "layered-update";
  case TextureReason::UnknownTexture: return "unknown-texture";
  case TextureReason::CanvasTextureChannel: return "canvas-texture-channel";
  case TextureReason::DeliveryPending: return "delivery-pending";
  }
  return "unsupported-format";
}
inline const char *to_wire(VariantEncoding v) {
  switch (v) {
  case VariantEncoding::Block: return "block";
  case VariantEncoding::Uastc: return "uastc";
  case VariantEncoding::Etc1s: return "etc1s";
  }
  return "block";
}
inline const char *to_wire(Filter v) {
  switch (v) {
  case Filter::Default: return "default";
  case Filter::Nearest: return "nearest";
  case Filter::Linear: return "linear";
  case Filter::NearestMipmaps: return "nearest_mipmaps";
  case Filter::LinearMipmaps: return "linear_mipmaps";
  case Filter::NearestMipmapsAnisotropic: return "nearest_mipmaps_anisotropic";
  case Filter::LinearMipmapsAnisotropic: return "linear_mipmaps_anisotropic";
  }
  return "default";
}
inline const char *to_wire(Repeat v) {
  switch (v) {
  case Repeat::Default: return "default";
  case Repeat::Disabled: return "disabled";
  case Repeat::Enabled: return "enabled";
  case Repeat::Mirror: return "mirror";
  }
  return "default";
}
inline const char *to_wire(Delivery v) {
  switch (v) {
  case Delivery::OutOfBand: return "out-of-band";
  case Delivery::Inline: return "inline";
  case Delivery::Mixed: return "mixed";
  }
  return "out-of-band";
}
inline const char *to_wire(Fetch v) {
  switch (v) {
  case Fetch::Http: return "http";
  case Fetch::Directory: return "directory";
  case Fetch::None: return "none";
  }
  return "none";
}
inline const char *to_wire(Auth v) { return v == Auth::Bearer ? "bearer" : "none"; }
inline const char *to_wire(TextureDecode v) { return v == TextureDecode::Engine ? "engine" : "off"; }
inline const char *to_wire(AxisStretchMode v) {
  switch (v) {
  case AxisStretchMode::Stretch: return "stretch";
  case AxisStretchMode::Tile: return "tile";
  case AxisStretchMode::TileFit: return "tile_fit";
  }
  return "stretch";
}
inline const char *to_wire(Primitive v) {
  switch (v) {
  case Primitive::Points: return "points";
  case Primitive::Lines: return "lines";
  case Primitive::LineStrip: return "line_strip";
  case Primitive::Triangles: return "triangles";
  case Primitive::TriangleStrip: return "triangle_strip";
  }
  return "triangles";
}
inline const char *to_wire(MeshStatus v) {
  switch (v) {
  case MeshStatus::Ok: return "ok";
  case MeshStatus::Unsupported: return "unsupported";
  case MeshStatus::Freed: return "freed";
  }
  return "ok";
}
inline const char *to_wire(MeshReason v) {
  switch (v) {
  case MeshReason::MeshFormat: return "mesh-format";
  case MeshReason::MeshBlendShapes: return "mesh-blend-shapes";
  case MeshReason::PayloadTooLarge: return "payload-too-large";
  }
  return "mesh-format";
}

// --- new at /5 (render-stream-5.md) ------------------------------------------------------------

inline const char *to_wire(VariantType v) {
  switch (v) {
  case VariantType::Nil: return "nil";
  case VariantType::Bool: return "bool";
  case VariantType::Int: return "int";
  case VariantType::Float: return "float";
  case VariantType::Vector2: return "vector2";
  case VariantType::Vector2i: return "vector2i";
  case VariantType::Rect2: return "rect2";
  case VariantType::Rect2i: return "rect2i";
  case VariantType::Vector3: return "vector3";
  case VariantType::Vector3i: return "vector3i";
  case VariantType::Transform2D: return "transform2d";
  case VariantType::Vector4: return "vector4";
  case VariantType::Vector4i: return "vector4i";
  case VariantType::Plane: return "plane";
  case VariantType::Quaternion: return "quaternion";
  case VariantType::Aabb: return "aabb";
  case VariantType::Basis: return "basis";
  case VariantType::Transform3D: return "transform3d";
  case VariantType::Projection: return "projection";
  case VariantType::Color: return "color";
  case VariantType::Rid: return "rid";
  case VariantType::PackedInt32Array: return "packed_int32_array";
  case VariantType::PackedInt64Array: return "packed_int64_array";
  case VariantType::PackedFloat32Array: return "packed_float32_array";
  case VariantType::PackedFloat64Array: return "packed_float64_array";
  case VariantType::PackedVector2Array: return "packed_vector2_array";
  case VariantType::PackedVector3Array: return "packed_vector3_array";
  case VariantType::PackedVector4Array: return "packed_vector4_array";
  case VariantType::PackedColorArray: return "packed_color_array";
  }
  return "nil";
}

// gate5_5-design.md D8: the number of float64 components `param_f64` holds per element of this
// type (0 for nil/rid, which never contribute floats), in Godot's own member order.
inline int variant_components(VariantType v) {
  switch (v) {
  case VariantType::Nil: return 0;
  case VariantType::Bool: return 1;
  case VariantType::Int: return 1;
  case VariantType::Float: return 1;
  case VariantType::Vector2: return 2;
  case VariantType::Vector2i: return 2;
  case VariantType::Rect2: return 4;
  case VariantType::Rect2i: return 4;
  case VariantType::Vector3: return 3;
  case VariantType::Vector3i: return 3;
  case VariantType::Transform2D: return 6;
  case VariantType::Vector4: return 4;
  case VariantType::Vector4i: return 4;
  case VariantType::Plane: return 4;
  case VariantType::Quaternion: return 4;
  case VariantType::Aabb: return 6;
  case VariantType::Basis: return 9;
  case VariantType::Transform3D: return 12;
  case VariantType::Projection: return 16;
  case VariantType::Color: return 4;
  case VariantType::Rid: return 0;
  case VariantType::PackedInt32Array: return 1;
  case VariantType::PackedInt64Array: return 1;
  case VariantType::PackedFloat32Array: return 1;
  case VariantType::PackedFloat64Array: return 1;
  case VariantType::PackedVector2Array: return 2;
  case VariantType::PackedVector3Array: return 3;
  case VariantType::PackedVector4Array: return 4;
  case VariantType::PackedColorArray: return 4;
  }
  return 0;
}

inline const char *to_wire(ShaderMode v) {
  switch (v) {
  case ShaderMode::CanvasItem: return "canvas_item";
  case ShaderMode::Spatial: return "spatial";
  case ShaderMode::Particles: return "particles";
  case ShaderMode::Sky: return "sky";
  case ShaderMode::Fog: return "fog";
  }
  return "canvas_item";
}
inline const char *to_wire(ShaderStatus v) {
  return v == ShaderStatus::Ok ? "ok" : "unsupported";
}
inline const char *to_wire(ShaderReason v) {
  switch (v) {
  case ShaderReason::ShaderMode: return "shader-mode";
  case ShaderReason::ShaderScreenTexture: return "shader-screen-texture";
  case ShaderReason::ShaderSdf: return "shader-sdf";
  case ShaderReason::ShaderTime: return "shader-time";
  case ShaderReason::ShaderGlobalUniform: return "shader-global-uniform";
  case ShaderReason::ShaderExcluded: return "shader-excluded";
  case ShaderReason::PayloadTooLarge: return "payload-too-large";
  case ShaderReason::PayloadUnavailable: return "payload-unavailable";
  }
  return "shader-mode";
}
inline const char *to_wire(ShaderUse v) {
  switch (v) {
  case ShaderUse::GlobalUniform: return "global_uniform";
  case ShaderUse::InstanceUniform: return "instance_uniform";
  case ShaderUse::Light: return "light";
  case ShaderUse::ScreenTexture: return "screen_texture";
  case ShaderUse::Sdf: return "sdf";
  case ShaderUse::Time: return "time";
  }
  return "time";
}
inline const char *to_wire(ShaderSource v) {
  return v == ShaderSource::Payload ? "payload" : "withheld";
}
inline const char *to_wire(BlendMode v) {
  switch (v) {
  case BlendMode::Mix: return "mix";
  case BlendMode::Add: return "add";
  case BlendMode::Sub: return "sub";
  case BlendMode::Mul: return "mul";
  case BlendMode::PremulAlpha: return "premul_alpha";
  case BlendMode::Disabled: return "disabled";
  }
  return "mix";
}
inline const char *to_wire(LightMode v) {
  switch (v) {
  case LightMode::Normal: return "normal";
  case LightMode::Unshaded: return "unshaded";
  case LightMode::LightOnly: return "light_only";
  }
  return "normal";
}
inline const char *to_wire(MaterialStatus v) {
  return v == MaterialStatus::Ok ? "ok" : "unsupported";
}
inline const char *to_wire(MaterialReason v) {
  switch (v) {
  case MaterialReason::UnknownShader: return "unknown-shader";
  case MaterialReason::UnknownTexture: return "unknown-texture";
  case MaterialReason::ParamType: return "param-type";
  case MaterialReason::ParamRange: return "param-range";
  }
  return "unknown-shader";
}
inline const char *to_wire(ShaderPolicy v) {
  switch (v) {
  case ShaderPolicy::Source: return "source";
  case ShaderPolicy::Params: return "params";
  case ShaderPolicy::Exclude: return "exclude";
  }
  return "source";
}

inline const char *to_wire(PublicationMode v) {
  return v == PublicationMode::EveryFrame ? "every-frame" : "rate";
}

// ----------------------------------------------------------------------------------- session

struct EngineInfo {
  std::string version_string;
  std::string sha256;
  std::string display_server;
  std::string rendering_driver;
  std::string rendering_method;
};

struct CaptureInfo {
  std::uint32_t calibrator_version = 0;
  std::vector<std::string> hooks_planned;  // sorted ascending (byte order) by the encoder
  std::vector<std::string> hooks_omitted;  // sorted ascending (byte order) by the encoder
};

struct StreamInfo {
  std::string stream_id;
  bool has_connection = false;
  std::uint32_t connection = 0;
  Transport transport = Transport::File;
  Encoding encoding = Encoding::Full;
};

struct Stretch {
  StretchMode mode = StretchMode::Disabled;
  StretchAspect aspect = StretchAspect::Ignore;
  ScaleMode scale_mode = ScaleMode::Fractional;
};

// render-stream-6.md "Session": the root's snap-to-pixel settings (gate6-design.md D17), new at
// /6, read through Viewport method binds at arm.
struct Snap2DInfo {
  bool transforms = false;
  bool vertices = false;
};

struct ViewportInfo {
  std::uint32_t canvas_cull_mask = 0xFFFFFFFFu;
  std::uint32_t root_canvas = kRootCanvasId;
  std::array<std::int32_t, 2> logical_size = {0, 0};
  Stretch stretch;
  RootSizePolicy root_size_policy = RootSizePolicy::Observe;
  // new at /6 (gate6-design.md D2, Q3a): the policy's declared presentation size. Equals
  // logical_size unless root_size_policy is Presentation.
  std::array<std::int32_t, 2> presentation_size = {0, 0};
  HostSizeStatus host_size_status = HostSizeStatus::Match;
  std::array<std::int32_t, 2> host_window_size = {0, 0};
  // new at /6: Viewport.get_oversampling() (float32), always positive.
  float font_oversampling = 1.0f;
  // new at /6 (D17): the root's snap_2d_transforms_to_pixel/_vertices_to_pixel project settings.
  Snap2DInfo snap_2d;
};

// render-stream-6.md "Session": a new session key, right after `features` (gate6-design.md D8).
struct PublicationInfo {
  PublicationMode mode = PublicationMode::EveryFrame;
  bool has_target_fps = false;  // false -> "target_fps": null
  std::int32_t target_fps = 0;
  // render-stream-7.md "Session": the granted live credit window, 1 or 2 (gate7-design.md D4).
  // Encoded only at /7; always 1 on a file stream. Defaults to 1 so every /6 caller that never
  // sets this field is unaffected.
  std::int32_t credit_window = 1;
};

// render-stream-9.md "Session": resources.texture_delivery, {"mode":<D1 mode>,"encoder":null|<prefix>}.
struct TextureDeliveryDeclaration {
  std::string mode = "rgba";  // rgba|passthrough|basis-uastc|basis-etc1s
  bool has_encoder = false;   // false -> "encoder": null
  std::string encoder;        // the params_id prefix, e.g. "basisu-1.60"
};

// render-stream-2.md session "resources": the resource policy for this stream.
struct ResourcesInfo {
  Delivery delivery = Delivery::OutOfBand;
  std::uint64_t inline_max_bytes = 0;
  std::uint64_t max_payload_bytes = 1;
  std::vector<std::string> permitted_formats;  // sorted ascending (byte order) by the encoder
  Fetch fetch = Fetch::Directory;
  bool has_http_path = false;  // non-null exactly for fetch == Http
  std::string http_path;
  Auth auth = Auth::None;
  // render-stream-8.md "Session": the host's declared texture-decode policy (gate8-design.md D8),
  // encoded as resources.decode at /8 only; Off at every earlier version.
  TextureDecode decode = TextureDecode::Off;
  // render-stream-9.md "Session": the host's declared texture-delivery mode (texture-delivery-
  // design.md D1) and the encoder prefix, encoded as resources.texture_delivery at /9 only.
  TextureDeliveryDeclaration texture_delivery;
};

// render-stream-8.md "Session": adoption is null (off) or {"mode":"arm","frame":<int >= 1>}, the
// arm-time late-join adoption declaration (gate8-design.md D4). Encoded at /8 only.
struct AdoptionInfo {
  bool present = false;  // false -> "adoption": null
  std::int32_t frame = 1;
};

// render-stream-2.md session "features.unsupported_resources" (G2d): a resource kind this host
// refuses, and why -- canvas_texture on a headless host (canvas-texture-headless).
struct UnsupportedResource {
  std::string resource;
  std::string reason;
};

struct Features {
  std::vector<std::string> ops;
  std::vector<std::string> item_state;
  std::vector<std::string> resources;  // new at /2
  std::vector<UnsupportedResource> unsupported_resources;  // G2d; sorted by resource
  std::vector<std::string> observed_unsupported_ops;
  std::vector<std::string> unobserved;
  std::string publication = kPublication;
  // render-stream-5.md "Session": a new key, right after item_state, present only at /5
  // (gate5_5-design.md Q4: "A new features.canvas_state: [\"modulate\",\"transform\"]").
  std::vector<std::string> canvas_state;
};

struct Sabotage {
  SabotageKind kind = SabotageKind::None;  // None -> "sabotage": null
  std::uint64_t frame = 0;
  bool has_op = false;
  std::string op;
};

// render-stream-5.md "Session": the session's declared shader-source policy (gate5_5-design.md
// D4), new at /5, following `resources`.
struct MaterialsInfo {
  ShaderPolicy shader_policy = ShaderPolicy::Source;
};

struct Session {
  // Which wire format encode_session()/encode_transaction() produce (render-stream-3.md
  // "render-stream/3"). Defaults to V2, so existing /2 callers that never set this field are
  // unaffected -- golden-2/ must keep passing unchanged (gate4-design.md G4e1).
  ProtocolVersion version = ProtocolVersion::V2;
  std::string session_id;
  StreamInfo stream;
  EngineInfo engine;
  CaptureInfo capture;
  ViewportInfo viewport;
  ResourcesInfo resources;  // new at /2, between viewport and features
  MaterialsInfo materials;  // new at /5, between resources and features
  Features features;
  PublicationInfo publication;  // new at /6, between features and sabotage
  Sabotage sabotage;
  // protocol/unknown-item-skip.md: Skip adds `"unknown_item_policy":"skip"` after `sabotage` (at
  // /4 and /5 only); Strict adds nothing, so a strict session is byte-identical to one encoded
  // before the policy existed.
  UnknownItemPolicy unknown_item_policy = UnknownItemPolicy::Strict;
  // render-stream-8.md "Session": always encoded at /8, right after unknown_item_policy (or after
  // sabotage when that key is absent); never encoded below /8.
  AdoptionInfo adoption;
  Color4 clear_color = {0.0f, 0.0f, 0.0f, 1.0f};
  Xform root_canvas_xform = kIdentityXform;
  Rect4 host_visible_rect = kZeroRect;
  Xform host_final_xform = kIdentityXform;
  float content_scale_factor = 1.0f;
};

// ----------------------------------------------------------------------------------- shared item/canvas state

struct ParentRef {
  ParentKind kind = ParentKind::None;
  std::uint32_t id = 0;
};

using Point2 = std::array<float, 2>;
inline constexpr Point2 kZeroPoint2 = {0.0f, 0.0f};

// One command. Which fields are meaningful is determined by `kind` (render-stream-2.md
// "Commands"; render-stream-3.md "Command" for AddMsdfTextureRectRegion; render-stream-4.md
// "Command" for AddLine..AddClipIgnore):
//   AddRect                   antialiased, rect, color
//   AddTextureRect            tex, tile, transpose, rect, modulate
//   AddTextureRectRegion      tex, transpose, clip_uv, rect, src, modulate
//   AddMsdfTextureRectRegion  tex, msdf_outline, rect, src, modulate, msdf_px_range, msdf_scale
//   AddLine                   antialiased, line_from, line_to, color, width
//   AddPolyline               antialiased, width, points, colors (hold-last)
//   AddMultiline              antialiased, width, points, colors (hold-last)
//   AddCircle                 antialiased, circle_position, circle_radius, color
//   AddPrimitive              has_tex/tex, points, colors, uvs
//   AddPolygon                has_tex/tex, points, colors, uvs
//   AddTriangleArray          has_tex/tex, points, colors, uvs, indices, triangle_count
//   AddNinePatch              has_tex/tex, rect, src (source), np_margin_tl, np_margin_br,
//                             x_axis, y_axis, draw_center, modulate
//   AddMesh                   mesh, has_tex/tex, transform, modulate
//   AddSetTransform           transform
//   AddClipIgnore             clip_ignore
//   Unsupported               name, reason
struct Command {
  CommandKind kind = CommandKind::AddRect;
  bool antialiased = false;
  bool has_tex = false;  // false -> "tex": null (the engine's RID())
  std::uint32_t tex = 0;
  bool tile = false;
  bool transpose = false;
  bool clip_uv = false;
  Rect4 rect = kZeroRect;
  Rect4 src = kZeroRect;
  Color4 color = kWhite;     // AddRect, AddLine, AddCircle
  Color4 modulate = kWhite;  // AddTextureRect* / AddMsdf / AddNinePatch / AddMesh
  std::string name;          // Unsupported: the hooked RenderingServer method name
  UnsupportedCmdReason unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
  // new at /3 (AddMsdfTextureRectRegion only): the engine's int outline_size, px_range and
  // size/msdf_size scale (render-stream-3.md "Command"; gate4-design.md Q1g).
  std::int32_t msdf_outline = 0;
  float msdf_px_range = 0.0f;
  float msdf_scale = 0.0f;

  // --- new at /4 (render-stream-4.md "Command") ------------------------------------------------
  Point2 line_from = kZeroPoint2;   // AddLine
  Point2 line_to = kZeroPoint2;     // AddLine
  float width = 0.0f;               // AddLine, AddPolyline, AddMultiline
  std::vector<Point2> points;       // AddPolyline/AddMultiline/AddPrimitive/AddPolygon/AddTriangleArray
  std::vector<Color4> colors;       // same ops: 0, 1 or n entries (hold-last for poly/multiline)
  std::vector<Point2> uvs;          // AddPrimitive/AddPolygon/AddTriangleArray: 0 or n entries
  std::vector<std::int32_t> indices;  // AddTriangleArray
  std::int32_t triangle_count = -1;   // AddTriangleArray "count" (-1 = all indices)
  Point2 circle_position = kZeroPoint2;  // AddCircle
  float circle_radius = 0.0f;            // AddCircle
  Point2 np_margin_tl = kZeroPoint2;      // AddNinePatch: margin top-left
  Point2 np_margin_br = kZeroPoint2;      // AddNinePatch: margin bottom-right
  AxisStretchMode x_axis = AxisStretchMode::Stretch;  // AddNinePatch
  AxisStretchMode y_axis = AxisStretchMode::Stretch;  // AddNinePatch
  bool draw_center = true;                // AddNinePatch
  std::uint32_t mesh = 0;                 // AddMesh: the wire mesh id (always present for this kind)
  Xform transform = kIdentityXform;       // AddMesh, AddSetTransform
  bool clip_ignore = false;               // AddClipIgnore
};

// --- new at /5: a material or instance-shader-parameter value (render-stream-5.md "Material
// table", gate5_5-design.md D8) -----------------------------------------------------------------
//
// `floats` holds `n * variant_components(type)` values in Godot's own member order
// (transform2d as /0's xforms; basis row-major; projection by column); it is empty for `nil` and
// `rid`. `has_tex` is true exactly for `type == Rid`, naming an entry in the texture table. `n` is
// 1 for every non-array type and the element count for a packed array.
struct Param {
  std::string name;
  VariantType type = VariantType::Nil;
  std::int32_t n = 1;
  bool has_tex = false;
  std::uint32_t tex = 0;
  std::vector<double> floats;
};

// --- new at /5: the shader table (render-stream-5.md "Shader table") --------------------------

// gate5_5-design.md D7: a CanvasItemMaterial-recognized engine-generated shader, described rather
// than carried as a GRP1 payload-identified blob of unrecognized text.
struct BuiltinCanvasItemMaterial {
  BlendMode blend_mode = BlendMode::Mix;
  LightMode light_mode = LightMode::Normal;
  bool particles_animation = false;
};

// `shader_set_default_texture_parameter` entries, sorted by (name, index).
struct DefaultTextureRef {
  std::string name;
  std::int32_t index = 0;
  std::uint32_t tex = 0;
};

// One shader-table entry (render-stream-5.md "Shader table"). `mode`/`source`/`hash` are null
// (has_mode/has_source/has_hash false) exactly for a shader with no code yet (`shader_create`
// before any `shader_set_code`); `payload_bytes` is 0 in that case too.
struct ShaderEntry {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;  // new at /8: Created or Adopted
  ShaderStatus status = ShaderStatus::Ok;
  bool has_reason = false;
  ShaderReason reason = ShaderReason::ShaderMode;
  std::uint64_t version = 1;
  bool has_mode = false;
  ShaderMode mode = ShaderMode::CanvasItem;
  bool has_source = false;
  ShaderSource source = ShaderSource::Payload;
  bool has_hash = false;  // false -> "hash": null
  std::string hash;       // 64 lowercase hex, the sha256 of the whole GRP1 payload
  std::uint64_t payload_bytes = 0;
  bool has_builtin = false;  // false -> "builtin": null
  BuiltinCanvasItemMaterial builtin;
  std::vector<ShaderUse> uses;                      // sorted ascending by wire spelling (As built)
  std::vector<DefaultTextureRef> default_textures;  // sorted by (name, index)
};

// --- new at /5: the material table (render-stream-5.md "Material table") ----------------------

// One material-table entry. `shader` is null (has_shader false) exactly when the material has no
// shader bound (a fresh `material_create()`, or after `material_set_shader(RID())`).
struct MaterialEntry {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;  // new at /8: Created or Adopted
  MaterialStatus status = MaterialStatus::Ok;
  bool has_reason = false;
  MaterialReason reason = MaterialReason::UnknownShader;
  std::uint64_t version = 1;
  bool has_shader = false;
  std::uint32_t shader = 0;
  std::vector<Param> params;  // sorted by name (byte order)
};

// The mirror's full state for one item at one frame: always carries its complete `commands`.
// Never encoded directly -- see ItemEntry for the wire-level, possibly-null-commands form.
struct ItemState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  ParentRef parent;
  std::vector<std::uint32_t> children;
  Xform xform = kIdentityXform;
  Color4 modulate = kWhite;
  Color4 self_modulate = kWhite;
  bool visible = true;
  std::int32_t draw_index = 0;
  std::int32_t z_index = 0;
  bool z_relative = true;
  bool behind = false;
  bool clip = false;
  bool custom_rect = false;
  Rect4 custom_rect_rect = kZeroRect;
  std::uint32_t visibility_layer = 0xFFFFFFFFu;
  Filter texture_filter = Filter::Default;   // new at /2
  Repeat texture_repeat = Repeat::Default;   // new at /2
  std::uint64_t content_version = 0;
  std::vector<Command> commands;
  // --- new at /5 (render-stream-5.md "Item"): before content_version on the wire --------------
  bool has_material = false;  // false -> "material": null
  std::uint32_t material = 0;
  bool use_parent_material = false;
  std::vector<Param> instance_params;  // sorted by name (byte order; As built)
};

struct CanvasState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  CanvasRole role = CanvasRole::None;
  bool attached = false;
  // new at /6 (render-stream-6.md "Canvas"): RS defaults 0, 0; reset to (0,0) on attach
  // (gate6-design.md Q3b).
  std::int32_t layer = 0;
  std::int32_t sublayer = 0;
  Xform xform = kIdentityXform;
  std::vector<std::uint32_t> items;
  Color4 modulate = kWhite;  // new at /5 (render-stream-5.md "Canvas"): canvas_f32 grows 6 -> 10
};

// A canvas texture's own state (render-stream-2.md "Texture", G2d); null ("has_canvas = false")
// for `image` and `placeholder` kinds.
struct CanvasTextureInfo {
  bool has_diffuse = false;
  std::uint32_t diffuse = 0;
  Filter filter = Filter::Default;
  Repeat repeat = Repeat::Default;
};

// One texture-table entry (render-stream-2.md "Texture"). Field meaning by kind/status is the
// field table there; this struct can represent any legal combination, and an illegal one too
// (for building invalid golden vectors), since it performs no validation itself.
// new at /9 (render-stream-9.md "Texture entries"): one alternative payload of an ok image
// texture. The base entry stays the `decoded` variant (texture-delivery-design.md D5).
struct TextureVariant {
  VariantEncoding encoding = VariantEncoding::Block;
  std::string hash;  // 64 lowercase hex
  std::uint64_t payload_bytes = 0;
  bool has_format = false;  // block only
  std::string format;
  bool has_params = false;  // basis variants only
  std::string params;       // the params_id
};

struct TextureEntry {
  std::uint32_t id = 0;
  // new at /8 (render-stream-8.md "Resource tables"): origin is "created" below /8; adopted_content
  // is non-None exactly when origin is Adopted.
  Origin origin = Origin::Created;
  AdoptedContent adopted_content = AdoptedContent::None;
  TextureKind kind = TextureKind::Image;
  TextureStatus status = TextureStatus::Ok;
  bool has_reason = false;
  TextureReason reason = TextureReason::UnsupportedFormat;
  std::uint64_t version = 1;
  bool has_hash = false;  // false -> "hash": null
  std::string hash;       // 64 lowercase hex
  bool has_format = false;  // false -> "format": null
  std::string format;
  // new at /8: the format a host decode started from (gate8-design.md D8); null otherwise.
  bool has_source_format = false;
  std::string source_format;
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  std::uint64_t payload_bytes = 0;
  // new at /9: sorted by encoding (block, uastc, etc1s), at most one each; empty below /9.
  std::vector<TextureVariant> variants;
  bool has_canvas = false;  // false -> "canvas": null
  CanvasTextureInfo canvas;
};

// --- new at /4: the mesh table (render-stream-4.md "Mesh table") ------------------------------

// One surface of an "ok" mesh entry: the render-stream-mesh/1 payload's hash and whole-payload
// byte length, plus the shape fields a receiver needs before fetching that payload.
struct MeshSurface {
  std::string hash;  // 64 lowercase hex, the sha256 of the whole GRM1 payload
  std::uint64_t payload_bytes = 0;
  Primitive primitive = Primitive::Triangles;
  // The engine's raw ARRAY_FORMAT_* bitmask (gate5-design.md Q1e); format version bit 35 means
  // this can exceed 32 bits, so it is a signed 64-bit value, never interpreted by this codec.
  std::int64_t format = 0;
  std::int32_t vertex_count = 0;
  std::int32_t index_count = 0;
};

// One mesh-table entry (render-stream-4.md "Mesh table"). `has_aabb` is false exactly for
// `status == Freed` ("f": null); `custom_aabb` is six floats (position xyz, size xyz), all zero
// meaning "no custom AABB set".
struct MeshEntry {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;                         // new at /8: Created or Adopted
  AdoptedContent adopted_content = AdoptedContent::None;  // new at /8
  MeshStatus status = MeshStatus::Ok;
  bool has_reason = false;
  MeshReason reason = MeshReason::MeshFormat;
  std::uint64_t version = 1;
  bool has_aabb = true;
  std::array<float, 6> custom_aabb = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  std::vector<MeshSurface> surfaces;
};

struct Failure {
  FailureReason reason = FailureReason::RootQueryFailed;
  std::string detail;
};

struct UnsupportedRef {
  std::string op;
  bool has_item = false;
  std::uint32_t item = 0;
  UnsupportedReason reason = UnsupportedReason::UnsupportedOp;
};

// protocol/unknown-item-skip.md "Transaction": the per-transaction account of what an
// `unknown_item_policy: "skip"` session left out. `present` is true exactly in such a session
// (the key is then in every transaction, zeros included) and false otherwise (no key at all).
// Complete, never patched, like `failures` and `unsupported`.
struct UnknownItems {
  bool present = false;
  std::uint64_t unknown_rids = 0;       // unknown canvas/item RIDs named since arming, not freed
  std::uint64_t withheld_items = 0;     // known items whose parent chain reaches one of them
  std::uint64_t withheld_commands = 0;  // the commands those withheld items hold now
  std::uint64_t unknown_calls = 0;      // hook calls that named an unknown RID, since arming
};

// The mirror's complete captured state for one frame.
struct Snapshot {
  // Which wire format make_full()/make_patch() (rs2_diff.cpp) produce from this Snapshot, exactly
  // mirroring Transaction::version's reasoning: V2 and V3 are byte-identical here, so this only
  // ever needs to distinguish V4 (meshes) and V5 (shaders/materials) from everything before them.
  // Defaults to V2.
  ProtocolVersion version = ProtocolVersion::V2;
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  UnknownItems unknown_items;  // protocol/unknown-item-skip.md
  Filter default_texture_filter = Filter::Nearest;    // new at /2: never Default on the wire
  Repeat default_texture_repeat = Repeat::Disabled;   // new at /2: never Default on the wire
  std::vector<CanvasState> canvases;  // sorted by id ascending
  std::vector<ItemState> items;       // sorted by id ascending
  std::vector<TextureEntry> textures; // sorted by id ascending; new at /2
  std::vector<MeshEntry> meshes;      // sorted by id ascending; new at /4
  std::vector<ShaderEntry> shaders;      // sorted by id ascending; new at /5
  std::vector<MaterialEntry> materials;  // sorted by id ascending; new at /5

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------------- transaction (wire-level)

struct ItemEntry {
  ItemState state;
  bool commands_null = false;
};

// The wire-level transaction record: either a full copy of a Snapshot or a patch against a base
// Snapshot. `failures`/`unsupported`/`default_texture_filter`/`default_texture_repeat` are always
// complete, never patched (render-stream-2.md "Transaction record": "Both are present in full and
// in patch transactions").
struct Transaction {
  // Which wire format encode_transaction() produces (render-stream-5.md): V2 and V3 transactions
  // are byte-identical in shape (/3 added only a command kind and a sabotage kind, never touching
  // the transaction's own keys or blocks), so this only ever needs to distinguish V4 (the mesh
  // table, removed_meshes, cmd_i32, mesh_f32) and V5 (shader/material tables, removed_shaders,
  // removed_materials, param_f64, item material/use_parent_material/instance_params, canvas
  // modulate) from everything before them. Defaults to V2, so every existing /2 and /3 caller
  // that never sets this field is unaffected.
  ProtocolVersion version = ProtocolVersion::V2;
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  Encoding encoding = Encoding::Full;
  std::optional<std::uint64_t> base_seq;
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  UnknownItems unknown_items;  // protocol/unknown-item-skip.md; complete, never patched
  Filter default_texture_filter = Filter::Nearest;
  Repeat default_texture_repeat = Repeat::Disabled;
  std::vector<std::uint32_t> removed_canvases;  // ascending
  std::vector<std::uint32_t> removed_items;     // ascending
  std::vector<std::uint32_t> removed_textures;  // ascending; new at /2
  std::vector<std::uint32_t> removed_meshes;    // ascending; new at /4
  std::vector<std::uint32_t> removed_shaders;    // ascending; new at /5
  std::vector<std::uint32_t> removed_materials;  // ascending; new at /5
  std::vector<CanvasState> canvases;             // ascending by id; full entries
  std::vector<ItemEntry> items;                  // ascending by id
  std::vector<TextureEntry> textures;            // ascending by id; new at /2; full entries
  std::vector<MeshEntry> meshes;                 // ascending by id; new at /4; full entries
  std::vector<ShaderEntry> shaders;      // ascending by id; new at /5; full entries
  std::vector<MaterialEntry> materials;  // ascending by id; new at /5; full entries

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------------- resource record

// A standalone "resource" record (render-stream-2.md "Resource record"): `payload` is a complete
// render-stream-texture/1 byte sequence (built and hashed elsewhere -- rs_texture_payload, G2a).
// This codec only packages already-computed bytes; it performs no hashing of its own.
struct ResourceRecord {
  std::string hash;  // 64 lowercase hex, the sha256 of `payload`
  std::vector<std::uint8_t> payload;
};

// ----------------------------------------------------------------------------------- end

struct EndStats {
  std::uint64_t bytes_total = 0;
  std::uint64_t encode_ns_total = 0;
  std::uint64_t snapshot_ns_total = 0;
  std::uint64_t diff_ns_total = 0;
  std::uint64_t max_record_bytes = 0;
  std::uint64_t full_transactions = 0;
  std::uint64_t patch_transactions = 0;
  std::uint64_t resource_records = 0;  // new at /2
  std::uint64_t resource_bytes = 0;    // new at /2
};

struct End {
  std::uint64_t transactions = 0;
  EndReason reason = EndReason::Shutdown;
  EndStats stats;
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_SNAPSHOT_H
