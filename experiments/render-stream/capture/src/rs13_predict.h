// render-stream/13's predicted blocks (W13a, protocol/render-stream-13.md "As built (W13a): the
// wire"): the per-stream predictor that turns a /12 transaction record into its /13 record and
// back.
//
// /13 is /12 plus the GRSD magic, the transaction key `predict_check` and the three predicted
// blocks mesh_u8, mesh_f32 and mm_f32, sent as residuals against the stream's two previous
// transactions (H1 = R(T-1), H2 = R(T-2), reset by a full). This module works on records: the
// writer takes the /12 record rs2::encode_transaction() writes (at V13 it writes the /12 form),
// reads the few meta keys the prediction needs (meshes, multimeshes, removed_*, encoding, the
// block descriptors), codes the three blocks, inserts `predict_check` right before "blocks" and
// advances the history from the /12 blocks. The reader is the same predictor in reverse. The
// reference codec is protocol/golden-13/make_golden.py (`to13`, `to12`, `code_blocks`,
// `History`, `advance`); capture/test/rs13_codec_test.cpp checks this file against it byte for
// byte.
//
// State: a Predictor holds H1 and H2 as shared immutable states (copying a Predictor shares them),
// each a map of the predicted units' /12 values: per mesh id its dynamic surface bodies (shape and
// bytes) and its six mesh_f32 floats, per multimesh id its buffer. A body or buffer is a shared
// byte vector, so R(T) shares every unit T did not carry with R(T-1). Keep one Predictor per
// stream (a file sink, a live connection): both ends must see the same transactions in the same
// order. Pure: no I/O, no engine types, no global state.
#ifndef GRC_RS13_PREDICT_H
#define GRC_RS13_PREDICT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs13 {

// XXH64, seed 0 (the vendored zstd's xxHash).
std::uint64_t xxh64(const std::uint8_t *data, std::size_t size);

// `predict_check`'s spelling: 16 lowercase hex digits, big-endian.
std::string check_hex(std::uint64_t hash);

// One predicted (or raw) unit of a transaction, as make_golden.py's `predict_trace` lists them:
// mesh_u8 units (one per carried mesh entry), then mesh_f32, then mm_f32, each in entry order.
// order: 0 raw, 1 first order, 2 second order.
enum class UnitBlock : std::uint8_t { MeshU8, MeshF32, MmF32 };
const char *to_wire(UnitBlock block);
struct Unit {
  UnitBlock block = UnitBlock::MeshU8;
  std::int64_t id = 0;
  int order = 0;
};

// R(T): the prediction state after a transaction.
using SharedBytes = std::shared_ptr<const std::vector<std::uint8_t>>;
struct SurfaceShape {
  std::string primitive;  // the meta's `primitive` value (a JSON string's contents)
  std::int64_t format = 0;
  std::int64_t vertex_count = 0;
  std::int64_t index_count = 0;
  bool operator==(const SurfaceShape &o) const {
    return primitive == o.primitive && format == o.format && vertex_count == o.vertex_count &&
           index_count == o.index_count;
  }
  bool operator!=(const SurfaceShape &o) const { return !(*this == o); }
};
struct MeshBodies {
  std::vector<SurfaceShape> shape;
  std::vector<SharedBytes> surfaces;  // one /12 body per surface
};
struct MultimeshBuffer {
  std::int64_t instances = 0;
  std::int64_t stride = 0;  // floats per instance: 8 + 4 colors + 4 custom
  SharedBytes bytes;        // instances x stride float32 LE
};
struct PredictState {
  std::map<std::int64_t, MeshBodies> body;
  std::map<std::int64_t, std::array<std::uint8_t, 24>> aabb;  // six float32 LE
  std::map<std::int64_t, MultimeshBuffer> mm;
};

// W13p: the meta keys the predictor reads, typed. The writer builds it from the rs2::Transaction
// (predict_meta(), no JSON); the reader (and encode() of a bare record) from the meta JSON. Each
// field keeps what make_golden.py's rules can tell apart (a number that is an int, a float, null
// or something else; a list that is an array, missing or something else), so both sources code
// every record alike.
struct MetaNum {
  enum class Kind : std::uint8_t { Null, Int, Float, Other };  // Int includes a JSON bool
  Kind kind = Kind::Null;
  std::int64_t i = 0;
  double d = 0.0;
  static MetaNum of(std::int64_t v) {
    MetaNum n;
    n.kind = Kind::Int;
    n.i = v;
    return n;
  }
  bool is_null() const { return kind == Kind::Null; }
  bool as_int(std::int64_t *out) const {
    if (kind != Kind::Int) {
      return false;
    }
    *out = i;
    return true;
  }
  // `value == n` as Python compares (1.0 == 1).
  bool equals_int(std::int64_t n) const {
    return kind == Kind::Int ? i == n : kind == Kind::Float && d == static_cast<double>(n);
  }
  bool operator==(const MetaNum &o) const {
    return kind == o.kind && (kind != Kind::Int || i == o.i) && (kind != Kind::Float || d == o.d);
  }
};
enum class MetaList : std::uint8_t { Missing, Array, Other };  // Missing: absent or null
enum class BlockName : std::uint8_t { Other, MeshU8, MeshF32, MmF32 };
struct MetaSurface {
  bool object = true;
  bool hash_null = true;
  bool primitive_string = true;
  std::string primitive;
  MetaNum payload_bytes, format, vertex_count, index_count;
  bool operator==(const MetaSurface &o) const {
    return object == o.object && hash_null == o.hash_null &&
           primitive_string == o.primitive_string && primitive == o.primitive &&
           payload_bytes == o.payload_bytes && format == o.format &&
           vertex_count == o.vertex_count && index_count == o.index_count;
  }
};
struct MetaMesh {
  bool object = true;
  bool status_ok = false;
  bool surfaces_array = true;
  MetaNum id, f, u8;
  std::size_t first_surface = 0;  // into PredictMeta::surfaces
  std::size_t surface_count = 0;
  bool operator==(const MetaMesh &o) const {
    return object == o.object && status_ok == o.status_ok && surfaces_array == o.surfaces_array &&
           id == o.id && f == o.f && u8 == o.u8 && first_surface == o.first_surface &&
           surface_count == o.surface_count;
  }
};
struct MetaMultimesh {
  bool object = true;
  bool status_ok = false;
  bool colors = false;  // truthy
  bool custom = false;  // truthy
  MetaNum id, aabb_f, buffer_f, instances;
  bool operator==(const MetaMultimesh &o) const {
    return object == o.object && status_ok == o.status_ok && colors == o.colors &&
           custom == o.custom && id == o.id && aabb_f == o.aabb_f && buffer_f == o.buffer_f &&
           instances == o.instances;
  }
};
struct PredictMeta {
  bool transaction = false;  // "type" is "transaction"
  bool full = false;         // "encoding" is "full"
  MetaList meshes_list = MetaList::Missing;
  MetaList multimeshes_list = MetaList::Missing;
  std::vector<MetaMesh> meshes;
  std::vector<MetaSurface> surfaces;
  std::vector<MetaNum> removed_meshes;  // an array's elements (empty when not an array)
  std::vector<MetaMultimesh> multimeshes;
  std::vector<MetaNum> removed_multimeshes;
  std::vector<BlockName> blocks;  // the descriptors' names, in order
  void clear();                   // keeps the vectors' capacity
  bool operator==(const PredictMeta &o) const;
};

// What rs2::encode_transaction() writes for these keys, from the transaction itself (its version
// /11 or later, as a /13 stream's always is).
void predict_meta(const rs2::Transaction &transaction, PredictMeta *out);

// Tests: every encode() given a PredictMeta also parses the record's meta JSON and aborts unless
// both agree (predict_meta() against encode_transaction()). Off by default.
void set_verify_meta(bool on);

// What a record failed with. The codes are the wire's (render-stream-13.md "Decoding and check
// order"): framing before meta-json before meta-schema before predict-check.
enum class Status : std::uint8_t {
  Ok,
  NotTransaction,  // a well-formed record of another type: not the predictor's (passed through)
  Framing,         // the record's own framing (lengths) does not hold
  MetaJson,
  MetaSchema,      // a transaction meta without "blocks", or (reader) a bad `predict_check`
  PredictCheck,
};
const char *to_wire(Status status);

// The same keys read from a /12 record's meta JSON (what encode() of a bare record does): Ok,
// NotTransaction, or the record's framing / meta error.
Status record_meta(const std::uint8_t *record, std::size_t size, PredictMeta *out);

class Predictor {
 public:
  Predictor();
  ~Predictor();
  // Copies share H1 and H2 (no bytes copied) and the flags; each predictor keeps its own scratch.
  Predictor(const Predictor &other);
  Predictor &operator=(const Predictor &other);
  Predictor(Predictor &&other) noexcept;
  Predictor &operator=(Predictor &&other) noexcept;

  // Writer, W13p: `meta` is the record's meta keys (predict_meta() of the transaction that
  // encode_transaction() wrote as `record12`), so the meta JSON is not read again. Codes the blocks
  // straight into `out` (whose capacity it reuses). Same result as encode() of the bare record.
  Status encode(const PredictMeta &meta, const std::uint8_t *record12, std::size_t size,
                std::vector<std::uint8_t> *out, std::vector<Unit> *trace = nullptr);
  Status encode(const rs2::Transaction &transaction, const std::vector<std::uint8_t> &record12,
                std::vector<std::uint8_t> *out, std::vector<Unit> *trace = nullptr);

  // Writer: `record12` is one complete /12 transaction record (length prefix included), as
  // rs2::encode_transaction() writes it; `out` receives the /13 record. Advances the history.
  // Returns NotTransaction (out untouched, history unchanged) for any other record type.
  Status encode(const std::uint8_t *record12, std::size_t size, std::vector<std::uint8_t> *out,
                std::vector<Unit> *trace = nullptr);
  Status encode(const std::vector<std::uint8_t> &record12, std::vector<std::uint8_t> *out,
                std::vector<Unit> *trace = nullptr) {
    return encode(record12.data(), record12.size(), out, trace);
  }

  // Reader: un-predicts one /13 transaction record into its /12 record. On any failure `out` is
  // untouched and the history is unchanged (a receiver applies nothing and resyncs).
  Status decode(const std::uint8_t *record13, std::size_t size, std::vector<std::uint8_t> *out,
                std::vector<Unit> *trace = nullptr);
  Status decode(const std::vector<std::uint8_t> &record13, std::vector<std::uint8_t> *out,
                std::vector<Unit> *trace = nullptr) {
    return decode(record13.data(), record13.size(), out, trace);
  }

  // Forgets H1 and H2 (a full does this by itself; a new connection starts reset).
  void reset();

  const PredictState &h1() const { return *h1_; }
  const PredictState &h2() const { return *h2_; }

  // Encoder sabotage predict-stale (render-stream-13.md "Sabotages"): every patch predicts from
  // H2 as if it were H1, first order. The history itself still advances honestly.
  bool predict_stale = false;
  // Decoder sabotage no-predict-reset: a full is un-predicted against H1 and H2 like a patch and
  // does not reset the history.
  bool no_reset = false;

 private:
  struct Scratch;  // reused buffers (rs13_predict.cpp): layouts, decoded blocks, the hash state
  Status encode_typed(const PredictMeta &meta, const std::uint8_t *record, std::size_t size,
                      std::vector<std::uint8_t> *out, std::vector<Unit> *trace);
  Status decode_typed(const PredictMeta &meta, const std::uint8_t *record, std::size_t size,
                      std::vector<std::uint8_t> *out, std::vector<Unit> *trace);
  Scratch &scratch();
  std::shared_ptr<PredictState> next_state(bool full);

  std::unique_ptr<Scratch> scratch_;

  std::shared_ptr<const PredictState> h1_ = empty_state();
  std::shared_ptr<const PredictState> h2_ = empty_state();
  static std::shared_ptr<const PredictState> empty_state();
};

// W13b: whether two predictors code every transaction alike: their H1 and H2 are the same states
// or equal ones (every body, AABB and buffer the same bytes; shared units compare by pointer). A
// live host shares one /13 coding between connections only when this holds (render-stream-13.md
// "As built (W13b)").
bool same_state(const PredictState &a, const PredictState &b);
bool same_history(const Predictor &a, const Predictor &b);

// The /13 transaction writer: rs2::encode_transaction() of `transaction` (whose version is V13)
// coded by `predictor`, which advances. Use one predictor per stream, in transaction order.
std::vector<std::uint8_t> encode_transaction(const rs2::Transaction &transaction,
                                             Predictor *predictor);

}  // namespace rs13
}  // namespace grc

#endif  // GRC_RS13_PREDICT_H
