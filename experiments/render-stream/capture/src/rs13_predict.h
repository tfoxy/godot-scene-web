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

class Predictor {
 public:
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
  Status code(const std::uint8_t *record, std::size_t size, bool inverse,
              std::vector<std::uint8_t> *out, std::vector<Unit> *trace);

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
