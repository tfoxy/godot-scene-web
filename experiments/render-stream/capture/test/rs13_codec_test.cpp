// Unit tests for render-stream/13 (W13a, protocol/render-stream-13.md "As built (W13a): the
// wire"): ProtocolVersion::V13 in rs2_codec/rs2_diff (/12's content, the GRSD magic and
// "render-stream/13") and the predictor of src/rs13_predict.{h,cpp}, matched byte for byte against
// protocol/golden-13 (make_golden.py is the reference codec).
//
// - golden-12's twenty-six states (rs12_codec_test.cpp's state12(), included below with its main()
//   renamed) written at V13 through the predictor are golden-13/{full,patch,inline}.rs13;
// - the prediction lane (make_golden.py predict_states(), built here as predict_state()) is
//   golden-13/predict.rs13 at V13 and predict.rs12 at V12, with index.json's predict_trace, and
//   with the predict-stale sabotage invalid/predict-stale.rs13;
// - the reader un-predicts every golden-13 file to its /12 twin, rejects the invalid vectors with
//   their code at their seq, and no-predict-reset fails where index.json says;
// - XXH64's vectors.

#define GRC_RS12_CODEC_TEST_MAIN rs12_codec_test_main
#include "rs12_codec_test.cpp"  // NOLINT(bugprone-suspicious-include)

#include <cstring>

#include "rs13_predict.h"

#ifndef GRC_GOLDEN13_DIR
#error "GRC_GOLDEN13_DIR must be defined by CMakeLists.txt"
#endif

namespace {

namespace rs13 = grc::rs13;

const std::string kG13 = std::string(GRC_GOLDEN13_DIR) + "/";
const std::string kG12 = std::string(GRC_GOLDEN12_DIR) + "/";

// --------------------------------------------------------------------------- record helpers

std::uint32_t u32_of(const std::uint8_t *p) {
  return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

void put32(std::vector<std::uint8_t> *out, std::uint32_t v) {
  for (int k = 0; k < 4; ++k) {
    out->push_back(static_cast<std::uint8_t>(v >> (8 * k)));
  }
}

// make_golden.py split_records() (the magic is not a record).
std::vector<std::vector<std::uint8_t>> split_records(const std::vector<std::uint8_t> &data) {
  std::vector<std::vector<std::uint8_t>> out;
  std::size_t p = 8;
  while (p + 4 <= data.size()) {
    const std::size_t n = u32_of(data.data() + p);
    if (p + 4 + n > data.size()) {
      break;
    }
    out.emplace_back(data.begin() + static_cast<long>(p),
                     data.begin() + static_cast<long>(p + 4 + n));
    p += 4 + n;
  }
  return out;
}

std::string meta_of(const std::vector<std::uint8_t> &rec) {
  const std::size_t n = u32_of(rec.data() + 4);
  return std::string(reinterpret_cast<const char *>(rec.data()) + 8, n);
}

bool is_type(const std::string &meta, const char *type) {
  return meta.rfind(std::string("{\"type\":\"") + type + "\"", 0) == 0;
}

// The transaction's `"seq":N` (canonical JSON puts it right after the type).
long seq_of(const std::string &meta) {
  const std::size_t at = meta.find("\"seq\":");
  return at == std::string::npos ? -1 : std::strtol(meta.c_str() + at + 6, nullptr, 10);
}

// A record whose meta is `meta` and whose blocks are `rec`'s (re-framed).
std::vector<std::uint8_t> with_meta(const std::vector<std::uint8_t> &rec, const std::string &meta) {
  const std::size_t old_meta = u32_of(rec.data() + 4);
  std::vector<std::uint8_t> body;
  put32(&body, static_cast<std::uint32_t>(meta.size()));
  body.insert(body.end(), meta.begin(), meta.end());
  body.insert(body.end(), rec.begin() + static_cast<long>(8 + old_meta), rec.end());
  std::vector<std::uint8_t> out;
  put32(&out, static_cast<std::uint32_t>(body.size()));
  out.insert(out.end(), body.begin(), body.end());
  return out;
}

std::uint64_t total_size(const std::vector<std::vector<std::uint8_t>> &recs) {
  std::uint64_t n = 0;
  for (const auto &r : recs) {
    n += r.size();
  }
  return n;
}
std::uint64_t max_size(const std::vector<std::vector<std::uint8_t>> &recs) {
  std::uint64_t n = 0;
  for (const auto &r : recs) {
    n = std::max<std::uint64_t>(n, r.size());
  }
  return n;
}

// Replaces the integer after `"key":` in a canonical meta.
bool replace_int(std::string *meta, const std::string &key, std::uint64_t value) {
  const std::string mark = "\"" + key + "\":";
  const std::size_t at = meta->find(mark);
  if (at == std::string::npos) {
    return false;
  }
  std::size_t end = at + mark.size();
  while (end < meta->size() && (*meta)[end] >= '0' && (*meta)[end] <= '9') {
    ++end;
  }
  meta->replace(at + mark.size(), end - at - mark.size(), std::to_string(value));
  return true;
}

// make_golden.py _fix_end(): bytes_total moves by the size change; max_record_bytes follows when
// the input's was its own maximum.
std::vector<std::uint8_t> fix_end(const std::vector<std::uint8_t> &rec,
                                  const std::vector<std::vector<std::uint8_t>> &before,
                                  const std::vector<std::vector<std::uint8_t>> &before_in) {
  std::string meta = meta_of(rec);
  const std::size_t bt = meta.find("\"bytes_total\":");
  const std::size_t mx = meta.find("\"max_record_bytes\":");
  if (bt == std::string::npos) {
    return rec;
  }
  const std::uint64_t bytes_total = std::strtoull(meta.c_str() + bt + 14, nullptr, 10);
  replace_int(&meta, "bytes_total", bytes_total + total_size(before) - total_size(before_in));
  if (mx != std::string::npos) {
    const std::size_t m2 = meta.find("\"max_record_bytes\":");
    const std::uint64_t max_in = std::strtoull(meta.c_str() + m2 + 19, nullptr, 10);
    if (!before.empty() && !before_in.empty() && max_in == max_size(before_in)) {
      replace_int(&meta, "max_record_bytes", max_size(before));
    }
  }
  return with_meta(rec, meta);
}

std::string swap_protocol(const std::string &meta, const char *from, const char *to) {
  std::string out = meta;
  const std::string a = std::string("\"protocol\":\"") + from + "\"";
  const std::size_t at = out.find(a);
  if (at != std::string::npos) {
    out.replace(at, a.size(), std::string("\"protocol\":\"") + to + "\"");
  }
  return out;
}

struct Transcoded {
  std::vector<std::uint8_t> bytes;
  rs13::Status status = rs13::Status::Ok;
  long seq = -1;               // the failing transaction's seq
  long record_index = -1;      // the failing record's index (session = 0)
  std::vector<std::string> traces;  // one per transaction: "block/id/order" joined by ','
};

std::string trace_text(const std::vector<rs13::Unit> &units) {
  std::string out;
  for (const rs13::Unit &u : units) {
    if (!out.empty()) {
      out += ",";
    }
    out += std::string("{\"block\":\"") + rs13::to_wire(u.block) + "\",\"id\":" +
           std::to_string(u.id) + ",\"order\":" + std::to_string(u.order) + "}";
  }
  return out;
}

// make_golden.py to12() (decode = true) and to13() through rs13::Predictor, record by record.
Transcoded transcode(const std::vector<std::uint8_t> &data, bool decode, bool stale = false,
                     bool no_reset = false, rs13::ZrSabotage zr = rs13::ZrSabotage::None) {
  Transcoded t;
  const std::vector<std::uint8_t> magic_in =
      grc::rs2::magic(decode ? ProtocolVersion::V13 : ProtocolVersion::V12);
  if (data.size() < 8 || !std::equal(magic_in.begin(), magic_in.end(), data.begin())) {
    t.status = rs13::Status::Framing;
    t.seq = -2;  // bad-magic
    return t;
  }
  rs13::Predictor predictor;
  predictor.predict_stale = stale;
  predictor.no_reset = no_reset;
  predictor.zr_overrun = zr == rs13::ZrSabotage::Overrun;
  predictor.zr_short_run = zr == rs13::ZrSabotage::ShortRun;
  const char *from = decode ? kProtocolV13 : kProtocolV12;
  const char *to = decode ? kProtocolV12 : kProtocolV13;
  std::vector<std::vector<std::uint8_t>> out;
  std::vector<std::vector<std::uint8_t>> seen;
  const std::vector<std::vector<std::uint8_t>> recs = split_records(data);
  for (std::size_t i = 0; i < recs.size(); ++i) {
    const std::vector<std::uint8_t> &rec = recs[i];
    const std::string meta = meta_of(rec);
    std::vector<std::uint8_t> coded;
    std::vector<rs13::Unit> units;
    const rs13::Status st = decode ? predictor.decode(rec, &coded, &units)
                                   : predictor.encode(rec, &coded, &units);
    if (st == rs13::Status::Ok) {
      out.push_back(coded);
      t.traces.push_back(trace_text(units));
    } else if (st == rs13::Status::NotTransaction) {
      if (is_type(meta, "session")) {
        out.push_back(with_meta(rec, swap_protocol(meta, from, to)));
      } else if (is_type(meta, "end")) {
        out.push_back(fix_end(rec, out, seen));
      } else {
        out.push_back(rec);
      }
    } else {
      t.status = st;
      t.seq = seq_of(meta);
      t.record_index = static_cast<long>(i);
      return t;
    }
    seen.push_back(rec);
  }
  t.bytes = grc::rs2::magic(decode ? ProtocolVersion::V12 : ProtocolVersion::V13);
  for (const auto &r : out) {
    t.bytes.insert(t.bytes.end(), r.begin(), r.end());
  }
  return t;
}

void check_file(const std::string &label, const std::vector<std::uint8_t> &expected,
                const std::vector<std::vector<std::uint8_t>> &records) {
  check(!expected.empty(), (label + " is readable").c_str());
  std::size_t offset = 0;
  int bad = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool matches = offset + records[i].size() <= expected.size() &&
                         std::equal(records[i].begin(), records[i].end(),
                                    expected.begin() + static_cast<long>(offset));
    if (!matches && bad++ < 3) {
      std::fprintf(stderr, "  %s: record %zu (%zu bytes) differs at offset %zu\n", label.c_str(), i,
                   records[i].size(), offset);
    }
    check(matches, ("record " + std::to_string(i) + " matches " + label).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("the recording is exactly " + label + "'s length").c_str());
}

// --------------------------------------------------------------------------- (a) golden-12 at /13

Snapshot state13(int n) {
  Snapshot s = state12(n);
  s.version = ProtocolVersion::V13;
  return s;
}

Session session13(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                  Delivery delivery) {
  Session session = session12(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V13;
  return session;
}

void test_golden12_states_at_v13() {
  {
    rs13::Predictor p;
    std::vector<std::vector<std::uint8_t>> records;
    records.push_back(magic(ProtocolVersion::V13));
    records.push_back(encode_session(session13(Encoding::Full, golden::kFullStreamId,
                                               golden::kFullSessionId, Delivery::OutOfBand)));
    for (int n = 1; n <= kStates12; ++n) {
      records.push_back(rs13::encode_transaction(make_full(state13(n)), &p));
    }
    records.push_back(encode_end(make_end(kStates12, 0, 0, 0, 0, records)));
    check_file("golden-13/full.rs13", read_file(kG13 + "full.rs13"), records);
  }
  {
    rs13::Predictor p;
    std::vector<std::vector<std::uint8_t>> records;
    records.push_back(magic(ProtocolVersion::V13));
    records.push_back(encode_session(session13(Encoding::Patch, golden::kPatchStreamId,
                                               golden::kPatchSessionId, Delivery::OutOfBand)));
    for (int n = 1; n <= kStates12; ++n) {
      const bool full = n == 1 || n == 5 || n == 16 || n == 21 || n == 26;
      records.push_back(rs13::encode_transaction(
          full ? make_full(state13(n)) : make_patch(state13(n - 1), state13(n)), &p));
    }
    records.push_back(encode_end(make_end(5, kStates12 - 5, 12345, 0, 0, records)));
    check_file("golden-13/patch.rs13", read_file(kG13 + "patch.rs13"), records);
  }
  {
    const Session session = session13(Encoding::Full, std::string(32, '3'), std::string(32, '3'),
                                      Delivery::Inline);
    InlinePolicy policy;
    policy.inline_max_bytes = session.resources.inline_max_bytes;
    policy.inline_variants = true;
    RecordPlanner planner(ProtocolVersion::V13, policy);
    const std::string dir10 = std::string(GRC_GOLDEN10_DIR) + "/payloads/";
    rs13::Predictor p;
    std::uint64_t resource_bytes = 0;
    std::uint64_t resource_count = 0;
    std::vector<std::vector<std::uint8_t>> records;
    records.push_back(magic(ProtocolVersion::V13));
    records.push_back(encode_session(session));
    std::optional<Snapshot> prev;
    for (int n = 1; n <= kStates12; ++n) {
      const Snapshot cur = state13(n);
      for (const PayloadName &name : planner.next(prev ? &*prev : nullptr, cur)) {
        std::string path;
        if (name.hash == kHashPpm) {
          path = kG12 + "payloads/shader-ppm.grp";
        } else {
          const auto file = payload_files().find(name.hash);
          check(file != payload_files().end(), ("a payload file for " + name.hash).c_str());
          if (file == payload_files().end()) {
            continue;
          }
          path = dir10 + file->second;
        }
        const std::vector<std::uint8_t> payload = read_file(path);
        resource_bytes += payload.size();
        ++resource_count;
        records.push_back(encode_resource(ResourceRecord{name.hash, payload}));
      }
      records.push_back(rs13::encode_transaction(make_full(cur), &p));
      prev = cur;
    }
    records.push_back(
        encode_end(make_end(kStates12, 0, 0, resource_count, resource_bytes, records)));
    check_file("golden-13/inline.rs13", read_file(kG13 + "inline.rs13"), records);
  }
  // A V13 transaction's /12 content is exactly V12's (encode_transaction writes the /12 form).
  for (int n = 1; n <= kStates12; ++n) {
    check(encode_transaction(make_full(state12(n))) == encode_transaction(make_full(state13(n))),
          ("seq " + std::to_string(n) + ": a V13 full's /12 form is V12's").c_str());
    if (n > 1) {
      check(encode_transaction(make_patch(state12(n - 1), state12(n))) ==
                encode_transaction(make_patch(state13(n - 1), state13(n))),
            ("seq " + std::to_string(n) + ": a V13 patch's /12 form is V12's").c_str());
    }
  }
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V13);
  check(m.size() == 8 && m[0] == 'G' && m[1] == 'R' && m[2] == 'S' && m[3] == 'D' &&
            std::string(kProtocolV13) == "render-stream/13",
        "GRSD and render-stream/13");
}

// --------------------------------------------------------------------------- (b) the prediction lane

constexpr std::uint32_t kNanQuiet = 0x7FC00000u;
constexpr std::uint32_t kNanPayload = 0xFFC00001u;
constexpr std::uint32_t kNegZero = 0x80000000u;
constexpr std::int64_t kArrayFormatBones = 1 << 10;
constexpr std::int64_t kArrayFormatWeights = 1 << 11;
constexpr std::int64_t kQuadFormat = golden::kArrayFormatColor | golden::kArrayFormatTexUv |
                                     golden::kArrayFormatIndex | golden::kArrayFlagUse2dVertices;
constexpr std::int64_t kTriFormat = golden::kArrayFormatTexUv | golden::kArrayFlagUse2dVertices;
constexpr std::int64_t kSkinFormat = golden::kArrayFormatTexUv | kArrayFormatBones |
                                     kArrayFormatWeights | golden::kArrayFormatIndex |
                                     golden::kArrayFlagUse2dVertices;

std::uint32_t f32_word(float v) {
  std::uint32_t w = 0;
  std::memcpy(&w, &v, 4);
  return w;
}

struct BodyWriter {
  std::vector<std::uint8_t> out;
  void w32(std::uint32_t v) { put32(&out, v); }
  void f(float v) { w32(f32_word(v)); }
  void u16(std::uint16_t v) {
    out.push_back(static_cast<std::uint8_t>(v));
    out.push_back(static_cast<std::uint8_t>(v >> 8));
  }
  // build_mesh_payload()'s 40-byte geometry block: the AABB, then uv_scale [1, 1, 0, 0].
  void geometry(std::array<float, 6> aabb) {
    for (float v : aabb) {
      f(v);
    }
    for (float v : {1.0f, 1.0f, 0.0f, 0.0f}) {
      f(v);
    }
  }
  std::shared_ptr<const std::vector<std::uint8_t>> done() {
    return std::make_shared<const std::vector<std::uint8_t>>(std::move(out));
  }
};

// make_golden.py _mesh1_quad().
MeshSurface mesh1_quad(float b, float y, std::array<std::uint8_t, 4> colour) {
  BodyWriter w;
  w.geometry({b, y, 0.0f, 16.0f, 16.0f, 0.0f});
  for (const auto &[x, yy] : std::vector<std::pair<float, float>>{
           {b, y}, {b + 16.0f, y}, {b + 16.0f, y + 16.0f}, {b, y + 16.0f}}) {
    w.f(x);
    w.f(yy);
  }
  for (const auto &[u, v] :
       std::vector<std::pair<float, float>>{{0.0f, 0.0f}, {1.0f, 0.0f}, {1.0f, 1.0f}, {0.0f, 1.0f}}) {
    w.out.insert(w.out.end(), colour.begin(), colour.end());
    w.f(u);
    w.f(v);
  }
  for (std::uint16_t i : {0, 1, 2, 0, 2, 3}) {
    w.u16(i);
  }
  return dynamic_surface(w.done(), kQuadFormat, 4, 6);
}

// make_golden.py _mesh1_tri().
MeshSurface mesh1_tri(float b) {
  BodyWriter w;
  w.geometry({b, 0.0f, 0.0f, 16.0f, 16.0f, 0.0f});
  for (float v : {b, 0.0f, b + 16.0f, 0.0f, b, 16.0f}) {
    w.f(v);
  }
  for (float v : {0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f}) {
    w.f(v);
  }
  return dynamic_surface(w.done(), kTriFormat, 3, 0);
}

// make_golden.py _m2_positions().
std::vector<std::uint32_t> m2_positions(int s) {
  if (s == 1) {
    return {f32_word(0.0f), f32_word(0.0f), f32_word(32.0f),
            f32_word(0.0f), f32_word(0.0f), f32_word(32.0f)};
  }
  const std::map<int, float> x1 = {{2, 34.0f}, {3, 36.0f}, {4, 38.0f},
                                   {5, 38.0f}, {6, 40.0f}, {7, 42.0f}};
  return {kNanQuiet, kNegZero, f32_word(x1.at(s)), f32_word(0.0f), kNanPayload, f32_word(32.0f)};
}

// make_golden.py _mesh2_skin(): bones and weights (16 skin bytes a vertex).
MeshSurface mesh2_skin(const std::vector<std::uint32_t> &positions, int bones) {
  BodyWriter w;
  w.geometry({0.0f, 0.0f, 0.0f, 32.0f, 32.0f, 0.0f});
  for (std::uint32_t p : positions) {
    w.w32(p);
  }
  for (float v : {0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f}) {
    w.f(v);
  }
  for (int k = 0; k < 3; ++k) {
    for (int v : {bones + k, 0, 0, 0, 65535, 0, 0, 0}) {
      w.u16(static_cast<std::uint16_t>(v));
    }
  }
  for (std::uint16_t i : {0, 1, 2}) {
    w.u16(i);
  }
  return dynamic_surface(w.done(), kSkinFormat, 3, 3);
}

const std::map<int, float> kM1B = {{1, 1.25f}, {2, 1.5f}, {3, 1.75f}, {4, 2.0f}, {5, 2.25f},
                                   {6, 2.5f},  {7, 3.0f}, {8, 3.5f},  {9, 4.0f}, {10, 4.0f}};
const std::map<int, int> kMm1N = {{1, 2}, {2, 2}, {3, 3}, {4, 3}, {5, 3},
                                  {6, 3}, {7, 3}, {8, 3}, {9, 3}, {10, 3}};
const std::map<int, int> kMm1S = {{1, 1}, {2, 2}, {3, 3}, {4, 4}, {5, 5},
                                  {6, 5}, {7, 7}, {8, 8}, {9, 9}, {10, 10}};

// make_golden.py predict_states()[s - 1]. Content and buffer serials move exactly where the
// bodies and buffers change (mesh 1 not at 10, mesh 2 not at 5, multimesh 1 not at 6).
Snapshot predict_state(int s, ProtocolVersion version) {
  Snapshot st;
  st.version = version;
  st.seq = static_cast<std::uint64_t>(s);
  st.frame = static_cast<std::uint64_t>(s);
  MeshSurface m1_surface;
  if (s <= 3) {
    const std::array<std::uint8_t, 4> colour =
        s == 1 ? std::array<std::uint8_t, 4>{255, 102, 0, 255}
               : std::array<std::uint8_t, 4>{255, 103, 0, 255};
    m1_surface = mesh1_quad(kM1B.at(s), 0.5f - 0.25f * static_cast<float>(s), colour);
  } else {
    m1_surface = mesh1_tri(kM1B.at(s));
  }
  MeshEntry m1 = golden::mesh_entry(MeshStatus::Ok, static_cast<std::uint64_t>(s), {m1_surface});
  m1.id = 1;
  m1.dynamic = true;
  m1.content_serial = static_cast<std::uint64_t>(s == 10 ? 9 : s);
  const float fs = static_cast<float>(s);
  m1.custom_aabb = {64.0f + 2.0f * fs, -(32.0f + fs), 0.0f, 16.0f + fs / 4.0f, 16.0f, 0.0f};
  st.meshes.push_back(m1);
  if (s <= 7) {
    const int m2_seq = s == 5 ? 4 : s;
    MeshEntry m2 = golden::mesh_entry(MeshStatus::Ok, static_cast<std::uint64_t>(m2_seq),
                                      {mesh2_skin(m2_positions(m2_seq), 3)});
    m2.id = 2;
    m2.dynamic = true;
    m2.content_serial = static_cast<std::uint64_t>(m2_seq);
    m2.custom_aabb = {0.0f, 0.0f, 0.0f, 32.0f, 32.0f, 0.0f};
    st.meshes.push_back(m2);
  }
  std::vector<Command> commands;
  for (const MeshEntry &m : st.meshes) {
    commands.push_back(golden::add_mesh(m.id, kIdentityXform));
  }
  commands.push_back(add_multimesh(1));
  const int s1 = kMm1S.at(s);
  st.multimeshes.push_back(multimesh(1, static_cast<std::uint64_t>(s1), kMm1N.at(s), true, true,
                                     mm1_buffer(s1, kMm1N.at(s)), static_cast<std::uint64_t>(s1)));
  if (s >= 8) {
    commands.push_back(add_multimesh(2));
    st.multimeshes.push_back(multimesh(2, static_cast<std::uint64_t>(s), 1, false, false,
                                       mm2_buffer(s, 1), static_cast<std::uint64_t>(s)));
  }
  st.multimesh_commands = true;
  ItemState item = bb_item(1, ParentRef{ParentKind::Canvas, 1}, {}, 0.0f, 0, commands);
  item.content_version = s < 8 ? 1 : 2;
  st.items.push_back(item);
  st.canvases.push_back(golden::root_canvas({1}));
  return st;
}

// make_golden.py predict_recording12() (at V12) and its /13 form through `predictor` (at V13).
std::vector<std::vector<std::uint8_t>> predict_recording(ProtocolVersion version,
                                                         rs13::Predictor *predictor,
                                                         std::vector<std::string> *traces) {
  Session session = session12(Encoding::Patch, std::string(32, 'e'), std::string(32, 'd'),
                              Delivery::OutOfBand);
  session.version = version;
  session.resources.decode = TextureDecode::Off;
  session.adoption.present = false;
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(version));
  records.push_back(encode_session(session));
  for (int s = 1; s <= 10; ++s) {
    const bool full = s == 1 || s == 7;
    const Transaction t = full ? make_full(predict_state(s, version))
                               : make_patch(predict_state(s - 1, version), predict_state(s, version));
    if (predictor == nullptr) {
      records.push_back(encode_transaction(t));
    } else {
      std::vector<std::uint8_t> out;
      std::vector<rs13::Unit> units;
      const rs13::Status st = predictor->encode(encode_transaction(t), &out, &units);
      check(st == rs13::Status::Ok, "the predictor codes every lane transaction");
      records.push_back(out);
      if (traces != nullptr) {
        traces->push_back(trace_text(units));
      }
    }
  }
  records.push_back(encode_end(make_end(2, 8, 0, 0, 0, records)));
  return records;
}

// index.json's predict_trace for `file`, whitespace removed, against ours.
void check_trace(const std::string &file, const std::vector<std::string> &traces) {
  const std::vector<std::uint8_t> raw = read_file(kG13 + "index.json");
  std::string index;
  for (std::uint8_t c : raw) {
    if (c != ' ' && c != '\n' && c != '\t' && c != '\r') {
      index.push_back(static_cast<char>(c));
    }
  }
  std::string ours = "\"" + file + "\":[";
  for (std::size_t i = 0; i < traces.size(); ++i) {
    if (i != 0) {
      ours += ",";
    }
    ours += "{\"seq\":" + std::to_string(i + 1) + ",\"units\":[" + traces[i] + "]}";
  }
  ours += "]";
  check(index.find(ours) != std::string::npos,
        ("every unit and order of " + file + " is index.json's predict_trace").c_str());
}

void test_prediction_lane() {
  check_file("golden-13/predict.rs12", read_file(kG13 + "predict.rs12"),
             predict_recording(ProtocolVersion::V12, nullptr, nullptr));
  rs13::Predictor p;
  std::vector<std::string> traces;
  check_file("golden-13/predict.rs13", read_file(kG13 + "predict.rs13"),
             predict_recording(ProtocolVersion::V13, &p, &traces));
  check_trace("predict.rs13", traces);
  // The history after seq 10: mesh 1's bodies and AABB, multimeshes 1 and 2; mesh 2 removed.
  check(p.h1().body.count(1) == 1 && p.h1().body.count(2) == 0 && p.h1().aabb.count(1) == 1 &&
            p.h1().mm.count(1) == 1 && p.h1().mm.count(2) == 1 && p.h2().mm.count(2) == 1,
        "the history after the lane holds mesh 1 and multimeshes 1 and 2");
  rs13::Predictor stale;
  stale.predict_stale = true;
  check_file("golden-13/invalid/predict-stale.rs13", read_file(kG13 + "invalid/predict-stale.rs13"),
             predict_recording(ProtocolVersion::V13, &stale, nullptr));
}

// --------------------------------------------------------------------------- (d) the reader

void test_reader() {
  for (const char *lane : {"full", "patch", "inline"}) {
    const Transcoded t = transcode(read_file(kG13 + lane + ".rs13"), true);
    check(t.status == rs13::Status::Ok, (std::string(lane) + ".rs13 un-predicts").c_str());
    check(t.bytes == read_file(kG12 + lane + ".rs12"),
          (std::string(lane) + ".rs13 un-predicts to golden-12/" + lane + ".rs12").c_str());
    // And the record-level writer over the /12 file (make_golden.py to13) is golden-13's file.
    const Transcoded w = transcode(read_file(kG12 + lane + ".rs12"), false);
    check(w.status == rs13::Status::Ok && w.bytes == read_file(kG13 + lane + ".rs13"),
          (std::string("golden-12/") + lane + ".rs12 transcodes to " + lane + ".rs13").c_str());
  }
  {
    const Transcoded t = transcode(read_file(kG13 + "predict.rs13"), true);
    check(t.status == rs13::Status::Ok && t.bytes == read_file(kG13 + "predict.rs12"),
          "predict.rs13 un-predicts to predict.rs12");
    check_trace("predict.rs13", t.traces);
    const Transcoded w = transcode(read_file(kG13 + "predict.rs12"), false);
    check(w.status == rs13::Status::Ok && w.bytes == read_file(kG13 + "predict.rs13"),
          "predict.rs12 transcodes to predict.rs13");
    const Transcoded st = transcode(read_file(kG13 + "predict.rs12"), false, true);
    check(st.bytes == read_file(kG13 + "invalid/predict-stale.rs13"),
          "the record-level predict-stale writer is invalid/predict-stale.rs13");
    // W13r: the writer sabotages are make_golden.py's.
    const Transcoded over =
        transcode(read_file(kG13 + "predict.rs12"), false, false, false, rs13::ZrSabotage::Overrun);
    check(over.status == rs13::Status::Ok &&
              over.bytes == read_file(kG13 + "invalid/zr-overrun.rs13"),
          "the zr-overrun writer is invalid/zr-overrun.rs13");
    const Transcoded shortr = transcode(read_file(kG13 + "predict.rs12"), false, false, false,
                                        rs13::ZrSabotage::ShortRun);
    check(shortr.status == rs13::Status::Ok &&
              shortr.bytes == read_file(kG13 + "invalid/zr-short-run.rs13"),
          "the zr-short-run writer is invalid/zr-short-run.rs13");
  }
  {
    const Transcoded p = transcode(read_file(kG13 + "patch.rs13"), true);
    check_trace("patch.rs13", p.traces);
  }
  // The invalid vectors: code and seq (index.json).
  struct Vector {
    const char *file;
    rs13::Status code;
    long seq;
  };
  for (const Vector &v : {Vector{"predict-check-u8", rs13::Status::PredictCheck, 3},
                          Vector{"predict-check-aabb", rs13::Status::PredictCheck, 2},
                          Vector{"predict-check-mm", rs13::Status::PredictCheck, 5},
                          Vector{"predict-check-raw", rs13::Status::PredictCheck, 1},
                          Vector{"predict-stale", rs13::Status::PredictCheck, 2},
                          Vector{"predict-check-missing", rs13::Status::MetaSchema, 2},
                          Vector{"predict-check-upper", rs13::Status::MetaSchema, 2},
                          Vector{"predict-check-short", rs13::Status::MetaSchema, 2},
                          // W13r: the zero runs (index.json).
                          Vector{"zr-overrun", rs13::Status::ZrLength, 1},
                          Vector{"zr-short-run", rs13::Status::ZrNoncanonical, 1},
                          Vector{"zr-truncated", rs13::Status::ZrLength, 2},
                          Vector{"zr-trailing", rs13::Status::ZrLength, 2},
                          Vector{"zr-overlong", rs13::Status::ZrNoncanonical, 2},
                          Vector{"zr-literal-run", rs13::Status::ZrNoncanonical, 2},
                          Vector{"zr-split-run", rs13::Status::ZrNoncanonical, 2}}) {
    const Transcoded t =
        transcode(read_file(kG13 + "invalid/" + v.file + ".rs13"), true);
    if (t.status != v.code || t.seq != v.seq) {
      std::fprintf(stderr, "  %s: %s at seq %ld\n", v.file, rs13::to_wire(t.status), t.seq);
    }
    check(t.status == v.code && t.seq == v.seq,
          (std::string("invalid/") + v.file + ".rs13 fails " + rs13::to_wire(v.code) + " at seq " +
           std::to_string(v.seq))
              .c_str());
  }
  // no-predict-reset: predict.rs13 at seq 7, patch.rs13 at seq 16.
  {
    const Transcoded a = transcode(read_file(kG13 + "predict.rs13"), true, false, true);
    const Transcoded b = transcode(read_file(kG13 + "patch.rs13"), true, false, true);
    check(a.status == rs13::Status::PredictCheck && a.seq == 7,
          "no-predict-reset fails predict.rs13 at seq 7");
    check(b.status == rs13::Status::PredictCheck && b.seq == 16,
          "no-predict-reset fails patch.rs13 at seq 16");
  }
  // Pass-through: the broken block travels as /12 carries it, so the predictor passes it and
  // /12's rule (not checked here) reports it.
  for (const char *name : {"pass-mesh-u8-offset", "pass-payload-size", "pass-mesh-offset",
                           "pass-mm-offset"}) {
    const Transcoded t = transcode(read_file(kG13 + "invalid/" + name + ".rs13"), true);
    check(t.status == rs13::Status::Ok,
          (std::string("invalid/") + name + ".rs13 un-predicts (the block passes through)").c_str());
  }
  // golden-12's invalid vectors transcoded: each un-predicts to golden-12's own file.
  for (const char *name :
       {"builtin-entry-canvas", "builtin-entry-list", "builtin-entry-order", "particle-emits-count",
        "particle-emits-empty-key", "particle-emits-restarts", "particle-emits-unknown",
        "particles-empty-key", "particles-entry-freed-floats", "particles-entry",
        "particles-entry-trails", "particles-feature", "particles-ref-command",
        "particles-ref-material", "particles-ref-mesh", "particles-ref-subemitter",
        "particles-removed-empty-key", "particles-removed-full", "particles-version-floats",
        "particles-version-json", "particles-version", "pt-offset-empty", "pt-offset-missing",
        "pt-offset-short", "pt-offset-wrong"}) {
    const std::vector<std::uint8_t> v13 = read_file(kG13 + "invalid/g12-" + name + ".rs13");
    const std::vector<std::uint8_t> v12 = read_file(kG12 + "invalid/" + name + ".rs12");
    const Transcoded t = transcode(v13, true);
    const Transcoded w = transcode(v12, false);
    check(!v12.empty() && t.status == rs13::Status::Ok && t.bytes == v12 && w.bytes == v13,
          (std::string("invalid/g12-") + name + ".rs13 transcodes to and from golden-12's").c_str());
  }
  {
    const Transcoded t = transcode(read_file(kG13 + "corrupt-meta.rs13"), true);
    check(t.status == rs13::Status::MetaJson && t.record_index == 3,
          "corrupt-meta.rs13 fails meta-json at record 3");
    const Transcoded m = transcode(read_file(kG13 + "invalid/bad-magic.rs13"), true);
    check(m.seq == -2, "invalid/bad-magic.rs13 is refused at the magic");
  }
}

// --------------------------------------------------------------------------- (f) zero runs (W13r)

std::vector<std::uint8_t> from_hex(const std::string &h) {
  std::vector<std::uint8_t> out;
  for (std::size_t i = 0; i + 1 < h.size(); i += 2) {
    out.push_back(static_cast<std::uint8_t>(std::stoi(h.substr(i, 2), nullptr, 16)));
  }
  return out;
}

std::vector<std::uint8_t> zr_of(const std::vector<std::uint8_t> &plain) {
  std::vector<std::uint8_t> out(rs13::zr_bound(plain.size()));
  out.resize(rs13::zr_encode(plain.data(), plain.size(), out.data()));
  return out;
}

// make_golden.py zr_encode() as plainly as it reads (min run 4), for the fuzz below.
std::vector<std::uint8_t> zr_reference(const std::vector<std::uint8_t> &c) {
  std::vector<std::uint8_t> out;
  auto uv = [&out](std::uint64_t v) {
    while (v >= 0x80) {
      out.push_back(static_cast<std::uint8_t>(v | 0x80));
      v >>= 7;
    }
    out.push_back(static_cast<std::uint8_t>(v));
  };
  std::size_t lit = 0, zeros = 0, k = 0;
  auto token = [&](std::size_t end) {
    uv(zeros);
    uv(end - lit);
    out.insert(out.end(), c.begin() + static_cast<long>(lit), c.begin() + static_cast<long>(end));
  };
  while (k < c.size()) {
    if (c[k] != 0) {
      ++k;
      continue;
    }
    std::size_t j = k;
    while (j < c.size() && c[j] == 0) {
      ++j;
    }
    if (j - k >= 4) {
      if (k > lit || zeros != 0) {
        token(k);
      }
      zeros = j - k;
      lit = j;
    }
    k = j;
  }
  if (c.size() > lit || zeros != 0) {
    token(c.size());
  }
  return out;
}

// The string value of `"key": "..."` on a line, or false when the line has no such key.
bool json_string_after(const std::string &line, const char *key, std::string *out) {
  const std::size_t i = line.find(std::string("\"") + key + "\": \"");
  if (i == std::string::npos) {
    return false;
  }
  const std::size_t a = i + std::strlen(key) + 5;
  *out = line.substr(a, line.find('"', a) - a);
  return true;
}

void test_zero_runs() {
  // zero-runs.json, read line by line (g6.pretty: one key a line; `valid` entries plain then
  // coded, `invalid` entries coded, length, code).
  const std::vector<std::uint8_t> raw = read_file(kG13 + "zero-runs.json");
  const std::string text(raw.begin(), raw.end());
  check(!text.empty(), "zero-runs.json is readable");
  std::string plain, coded, code;
  bool have_plain = false;
  long length = -1;
  int valid = 0, invalid = 0;
  std::size_t at = 0;
  while (at < text.size()) {
    const std::size_t nl = text.find('\n', at);
    const std::string line = text.substr(at, nl == std::string::npos ? std::string::npos : nl - at);
    at = nl == std::string::npos ? text.size() : nl + 1;
    if (json_string_after(line, "plain", &plain)) {
      have_plain = true;
      continue;
    }
    if (json_string_after(line, "coded", &coded)) {
      if (have_plain) {
        const std::vector<std::uint8_t> p = from_hex(plain), c = from_hex(coded);
        std::vector<std::uint8_t> back(p.size());
        const bool ok = zr_of(p) == c &&
                        rs13::zr_decode(c.data(), c.size(), back.data(), back.size()) ==
                            rs13::Status::Ok &&
                        back == p;
        if (!ok) {
          std::fprintf(stderr, "  zero-runs.json valid %d (plain %s)\n", valid, plain.c_str());
        }
        check(ok, "a zero-runs.json valid case codes and expands");
        ++valid;
        have_plain = false;
      }
      continue;
    }
    if (const std::size_t i = line.find("\"length\": "); i != std::string::npos) {
      length = std::stol(line.substr(i + 10));
      continue;
    }
    if (json_string_after(line, "code", &code)) {
      const std::vector<std::uint8_t> c = from_hex(coded);
      std::vector<std::uint8_t> back(static_cast<std::size_t>(length) + 1);
      const rs13::Status st =
          rs13::zr_decode(c.data(), c.size(), back.data(), static_cast<std::size_t>(length));
      if (code != rs13::to_wire(st)) {
        std::fprintf(stderr, "  zero-runs.json invalid %s/%ld: %s, expected %s\n", coded.c_str(),
                     length, rs13::to_wire(st), code.c_str());
      }
      check(code == rs13::to_wire(st), "a zero-runs.json invalid case fails with its code");
      ++invalid;
    }
  }
  check(valid >= 18 && invalid >= 20, "zero-runs.json lists its valid and invalid cases");
  // The SSE2 scan against the plain loop: random buffers of runs of 0-40 zeros between 1-40
  // nonzero bytes (every alignment of the 16- and 32-byte steps), and a few long ones.
  std::uint64_t rng = 0x9E3779B97F4A7C15ull;
  auto next = [&rng](std::uint64_t m) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng % m;
  };
  int bad = 0;
  for (int round = 0; round < 4000; ++round) {
    std::vector<std::uint8_t> b;
    const std::size_t target = next(round < 3990 ? 300 : 70000);
    while (b.size() < target) {
      b.insert(b.end(), next(round % 7 == 0 ? 600 : 41), 0);
      for (std::size_t k = next(41); k > 0; --k) {
        b.push_back(static_cast<std::uint8_t>(next(3) == 0 ? 0 : 1 + next(255)));
      }
    }
    const std::vector<std::uint8_t> c = zr_of(b);
    std::vector<std::uint8_t> back(b.size());
    if (c != zr_reference(b) || c.size() > rs13::zr_bound(b.size()) ||
        rs13::zr_decode(c.data(), c.size(), back.data(), back.size()) != rs13::Status::Ok ||
        back != b) {
      ++bad;
    }
  }
  check(bad == 0, "the zero-run scan equals the plain loop on 4000 random buffers");
}

// --------------------------------------------------------------------------- (e) XXH64

void test_xxh64() {
  check(rs13::xxh64(nullptr, 0) == 0xef46db3751d8e999ull, "XXH64(\"\") is ef46db3751d8e999");
  const std::uint8_t a = 'a';
  check(rs13::xxh64(&a, 1) == 0xd24ec4f1a98c6e5bull, "XXH64(\"a\") is d24ec4f1a98c6e5b");
  check(rs13::check_hex(0xd24ec4f1a98c6e5bull) == "d24ec4f1a98c6e5b" &&
            rs13::check_hex(0x1ull) == "0000000000000001",
        "predict_check spells 16 lowercase hex digits");
}

}  // namespace

int main() {
  test_xxh64();
  test_golden12_states_at_v13();
  test_prediction_lane();
  test_reader();
  test_zero_runs();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs13_codec_test: all checks passed\n");
  return 0;
}
