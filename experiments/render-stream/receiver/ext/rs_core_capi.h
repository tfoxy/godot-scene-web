// C ABI of experiments/render-stream/rs-core-capi (Rust staticlib), mirrored by hand from its
// src/lib.rs, src/ops.rs and src/vt.rs. gate7-design.md Q14e, G7xn.
//
// Every answer lands in one of three per-handle buffers the caller reads right after the call:
// rsc_vt (a Variant tree, vt.rs), rsc_text (bytes) and rsc_ops_words/rsc_ops_arena
// (RenderingServer calls, ops.rs). The buffers stay valid until the next call on the handle.

#pragma once

#include <cstddef>
#include <cstdint>

extern "C" {

struct RsCore;

RsCore *rsc_new();
void rsc_free(RsCore *h);
uint32_t rsc_op_count();
void rsc_set_sabotage(RsCore *h, const uint8_t *name, size_t len);
void rsc_set_full_scan(RsCore *h, int32_t on);
// G8kp (texture-delivery-design.md D3): the hello's texture_encodings and gpu_formats; 1, or 0
// with the error in text.
int32_t rsc_set_delivery(RsCore *h, const uint8_t *encodings, size_t encodings_len,
                         const uint8_t *gpu_formats, size_t gpu_formats_len);
// G8ku: D6 keep (0) or upgrade (1); and a SHA-256 hex (64 bytes, no NUL) of `len` bytes.
void rsc_set_variant_upgrade(RsCore *h, int32_t on);
void rsc_sha256_hex(const uint8_t *data, size_t len, uint8_t *out);
// G7o2 (D31): the next session defers the record digest; rsc_record_digest fills it later
// (text: the record at `offset`'s sha256 hex; 1, or 0 with the error in text).
void rsc_set_digest_deferred(RsCore *h, int32_t on);
int32_t rsc_record_digest(RsCore *h, const uint8_t *data, size_t len, size_t offset);
// 4 (session) or 0 (error); vt: {record, errors, kind}. `version` is the stream's wire version,
// 6 or 7 (G7xwl).
int32_t rsc_session(RsCore *h, const uint8_t *data, size_t len, size_t offset, uint32_t version);
// ops.
void rsc_begin_session(RsCore *h);
// 1 resource, 2 transaction, 3 end, 0 error; vt: {record, errors, kind}.
int32_t rsc_accept(RsCore *h, const uint8_t *data, size_t len, size_t offset);
// text: the last resource record's payload; 0 when there is none.
int32_t rsc_resource_payload(RsCore *h);
// vt: {hashes, ids, mesh_hashes, shader_hashes, library}.
void rsc_needed(RsCore *h);
// 1 kept, 0 with "<code>: <detail>" in text.
int32_t rsc_provide(RsCore *h, const uint8_t *hash, size_t hlen, const uint8_t *data, size_t len);
// G7o3: a payload as it arrives: 1 staged (verified, decoded), 0 with "<code>: <detail>" in text.
int32_t rsc_stage(RsCore *h, const uint8_t *hash, size_t hlen, const uint8_t *data, size_t len);
// G7o3: drops a staged payload (evicted by the receiver's memory cache).
void rsc_unstage(RsCore *h, const uint8_t *hash, size_t hlen);
void rsc_provide_library(RsCore *h, const uint8_t *hash, size_t hlen, int32_t ok,
                         const uint8_t *body, size_t blen);
// 1 with ops and the stats vt, 0 with "<code>: <detail>" in text.
int32_t rsc_apply(RsCore *h);
// ops; returns the RID count.
int64_t rsc_dispose(RsCore *h);
// text: JSON.
void rsc_state_json(RsCore *h);
// vt: Dictionary.
void rsc_counters(RsCore *h);
const uint8_t *rsc_vt(RsCore *h, size_t *n);
const uint8_t *rsc_text(RsCore *h, size_t *n);
const uint32_t *rsc_ops_words(RsCore *h, size_t *n);
const uint8_t *rsc_ops_arena(RsCore *h, size_t *n);

}  // extern "C"

namespace rsc {

// ops.rs: RidRef words (kind << 29 | handle).
constexpr uint32_t KIND_ITEM = 0;
constexpr uint32_t KIND_CANVAS = 1;
constexpr uint32_t KIND_TEXTURE = 2;
// G8ku: plan.rs KTX2_FORMAT, the image-format code of a KTX2 payload in a texture op.
constexpr int64_t KTX2_FORMAT = 1000;
constexpr uint32_t KIND_MESH = 3;
constexpr uint32_t KIND_SHADER = 4;
constexpr uint32_t KIND_MATERIAL = 5;
constexpr uint32_t KIND_SPECIAL = 6;
constexpr uint32_t KIND_NONE = 7;

// ops.rs: opcodes (operands documented there).
enum Op : uint32_t {
  SetDefaultClearColor = 1,
  ViewportSetCanvasTransform = 2,
  ViewportSetCanvasCullMask = 3,
  FreeRid = 4,
  Texture2dPlaceholderCreate = 5,
  TextureReplaceWithPlaceholder = 6,
  CanvasTextureCreate = 7,
  CanvasTextureSetChannel = 8,
  CanvasTextureSetFilter = 9,
  CanvasTextureSetRepeat = 10,
  Texture2dCreate = 11,
  Texture2dUpdate = 12,
  TextureReplaceWithImage = 13,
  MeshCreate = 14,
  MeshClear = 15,
  MeshAddSurface = 16,
  MeshSetCustomAabb = 17,
  MeshSurfaceUpdateRegion = 18,
  ShaderCreate = 19,
  ShaderSetCode = 20,
  ShaderSetDefaultTexture = 21,
  MaterialCreate = 22,
  MaterialSetShader = 23,
  MaterialSetParam = 24,
  CanvasCreate = 25,
  ViewportAttachCanvas = 26,
  ViewportRemoveCanvas = 27,
  ViewportSetCanvasStacking = 28,
  CanvasSetModulate = 29,
  ViewportSetDefaultFilter = 30,
  ViewportSetDefaultRepeat = 31,
  CanvasItemCreate = 32,
  ItemSetParent = 33,
  ItemSetTransform = 34,
  ItemSetModulate = 35,
  ItemSetSelfModulate = 36,
  ItemSetVisible = 37,
  ItemSetClip = 38,
  ItemSetCustomRect = 39,
  ItemSetVisibilityLayer = 40,
  ItemSetZIndex = 41,
  ItemSetZRelative = 42,
  ItemSetDrawBehindParent = 43,
  ItemSetDrawIndex = 44,
  ItemSetDefaultFilter = 45,
  ItemSetDefaultRepeat = 46,
  ItemSetMaterial = 47,
  ItemSetUseParentMaterial = 48,
  ItemSetInstanceParam = 49,
  ItemClear = 50,
  AddRect = 51,
  AddTextureRect = 52,
  AddTextureRectRegion = 53,
  AddMsdfTextureRectRegion = 54,
  AddLine = 55,
  AddPolyline = 56,
  AddMultiline = 57,
  AddCircle = 58,
  AddPrimitive = 59,
  AddPolygon = 60,
  AddTriangleArray = 61,
  AddNinePatch = 62,
  AddSetTransform = 63,
  AddClipIgnore = 64,
  AddMesh = 65,
  OP_COUNT = 66,
};

// vt.rs tags.
constexpr uint8_t T_NIL = 0;
constexpr uint8_t T_BOOL = 1;
constexpr uint8_t T_INT = 2;
constexpr uint8_t T_FLOAT = 3;
constexpr uint8_t T_STRING = 4;
constexpr uint8_t T_ARRAY = 5;
constexpr uint8_t T_DICT = 6;
constexpr uint8_t T_MATH = 7;
constexpr uint8_t T_PACKED = 8;
constexpr uint8_t T_RID = 9;
constexpr uint8_t T_PACKED_STRINGS = 10;

}  // namespace rsc
