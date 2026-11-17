// Unit tests for render-stream/16 on the host (protocol/render-stream-16.md):
//
// - the GRSG magic, the protocol string and the session's `viewports` key (last before blocks);
// - a full and a patch built from snapshots through make_full / make_patch and written through the
//   /13 predictor, exactly as the host does: key order (shader_time, removed_viewports, viewports,
//   predict_check, blocks), the block descriptors (viewport_f32 last, after pt_f32) and the float
//   layout;
// - nested viewports, a canvas shared by the root and a viewport, viewport / proxy / unresolved-proxy
//   textures, a resize, a new viewport and a removed one in the patch;
// - a /15 encode of the same snapshots carries none of the /16 keys, blocks or kinds.
//
// RS16_TEST_OUT=<path> also writes the resulting .rs16 recording (session, full, patch, end) so it
// can be cross-validated with the TypeScript and Rust checkers.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "rs13_predict.h"
#include "rs2_codec.h"
#include "rs2_diff.h"

namespace {

using namespace grc::rs2;

int g_failures = 0;

void check(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
    ++g_failures;
  }
}

std::string hex64(char c) { return std::string(64, c); }

std::uint32_t u32_at(const std::vector<std::uint8_t> &b, std::size_t p) {
  return static_cast<std::uint32_t>(b[p]) | static_cast<std::uint32_t>(b[p + 1]) << 8 |
         static_cast<std::uint32_t>(b[p + 2]) << 16 | static_cast<std::uint32_t>(b[p + 3]) << 24;
}

// A parsed record: the meta JSON and each block's bytes (the record is u32 length, u32 meta
// length, the meta, u32 block count, then u32 length + bytes per block).
struct Parsed {
  std::string meta;
  std::vector<std::vector<std::uint8_t>> blocks;
};

Parsed parse(const std::vector<std::uint8_t> &rec) {
  Parsed out;
  const std::uint32_t meta_len = u32_at(rec, 4);
  out.meta.assign(rec.begin() + 8, rec.begin() + 8 + meta_len);
  std::size_t p = 8 + meta_len;
  const std::uint32_t count = u32_at(rec, p);
  p += 4;
  for (std::uint32_t i = 0; i < count; ++i) {
    const std::uint32_t n = u32_at(rec, p);
    p += 4;
    out.blocks.emplace_back(rec.begin() + p, rec.begin() + p + n);
    p += n;
  }
  return out;
}

float float_at(const std::vector<std::uint8_t> &b, std::size_t index) {
  const std::uint32_t u = u32_at(b, index * 4);
  float f;
  std::memcpy(&f, &u, sizeof f);
  return f;
}

bool has(const std::string &text, const std::string &needle) {
  return text.find(needle) != std::string::npos;
}

// The order of `a` before `b` in `text`.
bool before(const std::string &text, const std::string &a, const std::string &b) {
  const std::size_t i = text.find(a);
  const std::size_t j = text.find(b);
  return i != std::string::npos && j != std::string::npos && i < j;
}

// --------------------------------------------------------------------------- the states

CanvasState canvas(std::uint32_t id, bool root, bool attached) {
  CanvasState c;
  c.id = id;
  c.role = root ? CanvasRole::Root : CanvasRole::None;
  c.attached = attached;
  return c;
}

ItemState item_on(std::uint32_t id, std::uint32_t canvas_id) {
  ItemState it;
  it.id = id;
  it.parent = ParentRef{ParentKind::Canvas, canvas_id};
  return it;
}

TextureEntry image_texture() {
  TextureEntry t;
  t.id = 1;
  t.has_hash = true;
  t.hash = hex64('a');
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 4;
  t.height = 4;
  t.payload_bytes = 64;
  return t;
}

TextureEntry viewport_texture(std::uint32_t id, std::uint32_t viewport) {
  TextureEntry t;
  t.id = id;
  t.kind = TextureKind::Viewport;
  t.viewport = viewport;
  return t;
}

TextureEntry proxy_texture(std::uint32_t id, std::uint32_t target) {
  TextureEntry t;
  t.id = id;
  t.kind = TextureKind::Proxy;
  t.has_target = true;
  t.target = target;
  return t;
}

TextureEntry unresolved_proxy(std::uint32_t id) {
  TextureEntry t;
  t.id = id;
  t.kind = TextureKind::Proxy;
  t.status = TextureStatus::Unsupported;
  t.has_reason = true;
  t.reason = TextureReason::ProxyUnresolved;
  return t;
}

TextureEntry freed_viewport_texture(std::uint32_t id, std::uint32_t viewport) {
  TextureEntry t = viewport_texture(id, viewport);
  t.status = TextureStatus::Freed;
  return t;
}

ViewportEntry viewport(std::uint32_t id, bool has_parent, std::uint32_t parent, int w, int h,
                       std::vector<ViewportCanvasRow> rows, float seed) {
  ViewportEntry v;
  v.id = id;
  v.has_parent = has_parent;
  v.parent = parent;
  v.active = true;
  v.active_seq = id;
  v.size_w = w;
  v.size_h = h;
  v.canvases = std::move(rows);
  v.global_xform = {1.0f, 0.0f, 0.0f, 1.0f, seed, seed + 0.5f};
  return v;
}

ViewportCanvasRow row(std::uint32_t canvas_id, int layer, int sublayer, float seed) {
  ViewportCanvasRow r;
  r.canvas = canvas_id;
  r.layer = layer;
  r.sublayer = sublayer;
  r.xform = {1.0f, 0.0f, 0.0f, 1.0f, seed, -seed};
  return r;
}

// Snapshot A: canvas 1 (root) is shared with viewport 1; canvas 2 is attached only to viewports.
// Viewport 1 sits under the root (parent 0), 2 under viewport 1, 3 under the root; 4 and 5 are
// the viewport render targets' proxies.
Snapshot state_a(ProtocolVersion version) {
  Snapshot s;
  s.version = version;
  s.seq = 1;
  s.frame = 1;
  CanvasState root = canvas(1, true, true);
  root.items = {1};
  CanvasState surface_only = canvas(2, false, false);
  surface_only.items = {2};
  s.canvases = {root, surface_only};
  s.items = {item_on(1, 1), item_on(2, 2)};
  std::vector<TextureEntry> textures = {
      image_texture(),
      viewport_texture(2, 1),
      viewport_texture(3, 2),
      viewport_texture(4, 3),
      proxy_texture(5, 2),
      unresolved_proxy(6),
  };
  TextureEntry canvas_tex;  // a canvas texture whose diffuse names a proxy
  canvas_tex.id = 7;
  canvas_tex.kind = TextureKind::Canvas;
  canvas_tex.has_canvas = true;
  canvas_tex.canvas.has_diffuse = true;
  canvas_tex.canvas.diffuse = 5;
  textures.push_back(canvas_tex);
  s.textures = textures;
  s.viewports = {
      viewport(1, true, 0, 256, 256, {row(1, 0, 0, 3.0f), row(2, 1, 0, 4.0f)}, 1.0f),
      viewport(2, true, 1, 64, 32, {row(2, 0, 0, 5.0f)}, 2.0f),
      viewport(3, true, 0, 16, 16, {}, 6.0f),
  };
  return s;
}

// Snapshot B: viewport 1 is resized (and its transforms move), viewport 2 is untouched, viewport 3
// is removed (its texture freed, keeping its key), viewport 4 is new under viewport 2.
Snapshot state_b(ProtocolVersion version) {
  Snapshot s = state_a(version);
  s.seq = 2;
  s.frame = 2;
  std::vector<TextureEntry> textures = s.textures.vector();
  textures[3] = freed_viewport_texture(4, 3);
  textures.push_back(viewport_texture(8, 4));
  s.textures = textures;
  s.viewports = {
      viewport(1, true, 0, 512, 384, {row(1, 0, 0, 3.0f), row(2, 1, 0, 4.5f)}, 1.0f),
      viewport(2, true, 1, 64, 32, {row(2, 0, 0, 5.0f)}, 2.0f),
      viewport(4, true, 2, 8, 8, {}, 7.0f),
  };
  return s;
}

Session session_at(ProtocolVersion version, ViewportsMode mode) {
  Session s;
  s.version = version;
  s.session_id = std::string(32, '1');
  s.stream.stream_id = std::string(32, '2');
  s.stream.encoding = Encoding::Patch;  // the recording carries a patch
  s.viewports = mode;
  return s;
}

End make_end(std::uint64_t full_count, std::uint64_t patch_count,
             const std::vector<std::vector<std::uint8_t>> &records) {
  End end;
  end.transactions = full_count + patch_count;
  end.reason = EndReason::Shutdown;
  end.stats.full_transactions = full_count;
  end.stats.patch_transactions = patch_count;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) {
      max_len = std::max<std::uint64_t>(max_len, records[i].size());
    }
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;
  return end;
}

// --------------------------------------------------------------------------- the tests

void test_session_and_magic() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V16);
  check(m == std::vector<std::uint8_t>({0x47, 0x52, 0x53, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}),
        "the /16 magic is GRSG");
  check(std::string(kProtocolV16) == "render-stream/16", "the /16 protocol string");
  const Parsed on = parse(encode_session(session_at(ProtocolVersion::V16, ViewportsMode::On)));
  check(has(on.meta, "\"protocol\":\"render-stream/16\""), "the /16 session names render-stream/16");
  check(has(on.meta, "\"adoption\":null,\"viewports\":\"on\",\"blocks\":["),
        "viewports is the last key before blocks, after adoption: " + on.meta);
  check(has(parse(encode_session(session_at(ProtocolVersion::V16, ViewportsMode::Off))).meta,
            "\"viewports\":\"off\",\"blocks\":["),
        "viewports off");
  check(has(parse(encode_session(session_at(ProtocolVersion::V16, ViewportsMode::Unavailable))).meta,
            "\"viewports\":\"unavailable\",\"blocks\":["),
        "viewports unavailable");
  const Parsed v15 = parse(encode_session(session_at(ProtocolVersion::V15, ViewportsMode::On)));
  check(!has(v15.meta, "viewports"), "a /15 session has no viewports key");
  // /16 is /15 plus the key: the session bytes differ only by the protocol string and the key.
  std::string stripped = on.meta;
  const std::string key = ",\"viewports\":\"on\"";
  stripped.erase(stripped.find(key), key.size());
  stripped.replace(stripped.find("render-stream/16"), 16, "render-stream/15");
  check(stripped == v15.meta, "a /16 session is /15's plus the viewports key");
}

const char *kViewport1A =
    "{\"id\":1,\"origin\":\"created\",\"parent\":0,\"active\":true,\"active_seq\":1,"
    "\"size\":[256,256],\"transparent\":false,\"update\":\"disabled\",\"once_seq\":0,"
    "\"clear\":\"always\",\"clear_seq\":0,\"disable_2d\":false,\"renders_3d\":false,"
    "\"hdr_2d\":false,\"msaa_2d\":0,\"canvas_cull_mask\":4294967295,"
    "\"default_texture_filter\":\"nearest\",\"default_texture_repeat\":\"disabled\","
    "\"snap_2d\":[false,false],\"canvases\":[[1,0,0],[2,1,0]],\"f\":0}";

void check_viewport_floats(const std::vector<std::uint8_t> &block, std::size_t at,
                           const ViewportEntry &v, const std::string &what) {
  std::size_t i = at;
  for (float f : v.global_xform) {
    check(float_at(block, i++) == f, what + ": global xform float");
  }
  for (const ViewportCanvasRow &r : v.canvases) {
    for (float f : r.xform) {
      check(float_at(block, i++) == f, what + ": canvas row float");
    }
  }
}

void test_full_and_patch(const char *out_path) {
  const Session session = session_at(ProtocolVersion::V16, ViewportsMode::On);
  const Snapshot a = state_a(ProtocolVersion::V16);
  const Snapshot b = state_b(ProtocolVersion::V16);
  grc::rs13::Predictor predictor;

  // --- the full ---
  const Transaction full = make_full(a);
  check(full.viewports.size() == 3 && full.removed_viewports.empty(),
        "a full lists every viewport and removes none");
  const std::vector<std::uint8_t> full_rec = grc::rs13::encode_transaction(full, &predictor);
  const Parsed pf = parse(full_rec);
  check(has(pf.meta, std::string("\"viewports\":[") + kViewport1A + ",{\"id\":2,"),
        "the full's first viewport entry, in spec key order: " + pf.meta);
  check(has(pf.meta, "{\"id\":2,\"origin\":\"created\",\"parent\":1,\"active\":true,\"active_seq\":2,"
                     "\"size\":[64,32],"),
        "viewport 2 nests under viewport 1");
  check(has(pf.meta, "\"canvases\":[[2,0,0]],\"f\":18}"), "viewport 2's row and f 18");
  check(has(pf.meta, "\"canvases\":[],\"f\":30}],\"predict_check\":\""),
        "viewport 3 is last at f 30, then predict_check");
  check(!has(pf.meta, "removed_viewports"), "a full has no removed_viewports");
  check(before(pf.meta, "\"viewports\":[", "\"predict_check\":\"") &&
            before(pf.meta, "\"predict_check\":\"", "\"blocks\":["),
        "viewports, then predict_check, then blocks");
  check(before(pf.meta, "\"items\":[", "\"viewports\":["), "viewports follow the /15 tables");
  // textures
  check(has(pf.meta, "\"payload_bytes\":0,\"variants\":[],\"viewport\":1,\"canvas\":null"),
        "a viewport texture's kind key sits after variants, before canvas");
  check(has(pf.meta, "\"kind\":\"proxy\",\"status\":\"ok\",\"reason\":null,\"version\":1,\"hash\":null,"
                     "\"format\":null,\"source_format\":null,\"width\":0,\"height\":0,"
                     "\"mipmaps\":false,\"payload_bytes\":0,\"variants\":[],\"target\":2,"
                     "\"canvas\":null"),
        "an ok proxy texture's target");
  check(has(pf.meta, "\"kind\":\"proxy\",\"status\":\"unsupported\",\"reason\":\"proxy-unresolved\"") &&
            has(pf.meta, "\"variants\":[],\"target\":null,\"canvas\":null"),
        "an unresolved proxy is unsupported with a null target");
  check(has(pf.meta, "\"kind\":\"canvas\"") && has(pf.meta, "\"diffuse\":5"),
        "a canvas texture naming a proxy");
  check(has(pf.meta, "\"kind\":\"image\",\"status\":\"ok\"") && !has(pf.meta, "size_override"),
        "the image entry is /15's");
  // blocks
  const std::string tail_full =
      "{\"name\":\"mm_f32\",\"type\":\"f32\",\"count\":0},"
      "{\"name\":\"viewport_f32\",\"type\":\"f32\",\"count\":36}]}";
  check(pf.meta.size() >= tail_full.size() &&
            pf.meta.compare(pf.meta.size() - tail_full.size(), tail_full.size(), tail_full) == 0,
        "the full's descriptors end with viewport_f32 (36 floats): " + pf.meta);
  check(pf.blocks.size() == 10 && pf.blocks[9].size() == 36 * 4,
        "the full carries viewport_f32 as a tenth block in place");
  if (pf.blocks.size() == 10) {
    check_viewport_floats(pf.blocks[9], 0, a.viewports[0], "full v1");
    check_viewport_floats(pf.blocks[9], 18, a.viewports[1], "full v2");
    check_viewport_floats(pf.blocks[9], 30, a.viewports[2], "full v3");
  }

  // --- the patch ---
  const Transaction patch = make_patch(a, b);
  check(patch.removed_viewports == std::vector<std::uint32_t>({3}),
        "the patch removes viewport 3");
  check(patch.viewports.size() == 2 && patch.viewports[0].id == 1 && patch.viewports[1].id == 4,
        "the patch lists the resized viewport 1 and the new viewport 4, not the unchanged 2");
  const std::vector<std::uint8_t> patch_rec = grc::rs13::encode_transaction(patch, &predictor);
  const Parsed pp = parse(patch_rec);
  check(has(pp.meta, "\"removed_viewports\":[3],\"viewports\":[{\"id\":1,"),
        "removed_viewports, then viewports: " + pp.meta);
  check(has(pp.meta, "\"size\":[512,384]") && !has(pp.meta, "\"size\":[256,256]"),
        "the resize is in the patch");
  check(has(pp.meta, "\"canvases\":[[1,0,0],[2,1,0]],\"f\":0},{\"id\":4,"),
        "viewport 1 at f 0, then viewport 4");
  check(has(pp.meta, "{\"id\":4,\"origin\":\"created\",\"parent\":2,") &&
            has(pp.meta, "\"canvases\":[],\"f\":18}],\"predict_check\":\""),
        "viewport 4 nests under viewport 2 at f 18");
  check(!has(pp.meta, "{\"id\":2,\"origin\""), "the unchanged viewport 2 is not listed");
  check(before(pp.meta, "\"removed_viewports\"", "\"viewports\":[") &&
            before(pp.meta, "\"viewports\":[", "\"predict_check\":\"") &&
            before(pp.meta, "\"predict_check\":\"", "\"blocks\":["),
        "removed_viewports, viewports, predict_check, blocks");
  check(has(pp.meta, "\"variants\":[],\"viewport\":3,\"canvas\":null"),
        "a freed viewport texture keeps its viewport value");
  check(has(pp.meta, "\"variants\":[],\"viewport\":4,\"canvas\":null"),
        "the new viewport's texture");
  const std::string tail_patch =
      "{\"name\":\"viewport_f32\",\"type\":\"f32\",\"count\":24}]}";
  check(pp.meta.size() >= tail_patch.size() &&
            pp.meta.compare(pp.meta.size() - tail_patch.size(), tail_patch.size(), tail_patch) == 0,
        "the patch's descriptors end with viewport_f32 (24 floats)");
  check(pp.blocks.size() == 10 && pp.blocks[9].size() == 24 * 4, "the patch's viewport_f32 block");
  if (pp.blocks.size() == 10) {
    check_viewport_floats(pp.blocks[9], 0, b.viewports[0], "patch v1");
    check_viewport_floats(pp.blocks[9], 18, b.viewports[2], "patch v4");
  }

  // resolve(base, patch) reproduces the target's viewport table.
  const Snapshot resolved = resolve(a, patch);
  check(resolved.viewports.size() == 3 && resolved.viewports[0].size_w == 512 &&
            resolved.viewports[1].id == 2 && resolved.viewports[2].id == 4,
        "resolve applies removed_viewports and the listed entries");

  // A patch against itself lists nothing and carries no viewport block.
  grc::rs13::Predictor idle;
  const Transaction same = make_patch(b, b);
  check(same.viewports.empty() && same.removed_viewports.empty(), "an unchanged table is not listed");
  const Parsed ps = parse(grc::rs13::encode_transaction(same, &idle));
  check(!has(ps.meta, "viewport_f32") && !has(ps.meta, "\"viewports\"") &&
            !has(ps.meta, "removed_viewports"),
        "no viewport keys or block when nothing changed");

  // The bit pattern, not the value: -0.0 differs from 0.0.
  Snapshot z = b;
  std::vector<ViewportEntry> vps = z.viewports;
  vps[1].global_xform[4] = 0.0f;
  Snapshot z0 = b;
  z0.viewports = vps;
  vps[1].global_xform[4] = -0.0f;
  z.viewports = vps;
  check(make_patch(z0, z).viewports.size() == 1, "float changes compare by bit pattern");

  // --- /15: the same snapshots carry nothing of /16 ---
  const Snapshot a15 = state_a(ProtocolVersion::V15);
  const Snapshot b15 = state_b(ProtocolVersion::V15);
  grc::rs13::Predictor p15;
  for (const Transaction &t : {make_full(a15), make_patch(a15, b15)}) {
    const Parsed p = parse(grc::rs13::encode_transaction(t, &p15));
    // The kind spellings stay (the codec writes a snapshot's kind verbatim; the host never builds
    // such a snapshot at /15), but no /16 key or block is written.
    check(!has(p.meta, "\"viewports\"") && !has(p.meta, "removed_viewports") &&
              !has(p.meta, "viewport_f32") && !has(p.meta, "\"viewport\":") &&
              !has(p.meta, "\"target\":"),
          "a /15 encode carries no viewport key, kind key or block: " + p.meta);
    check(p.blocks.size() == 9, "a /15 transaction keeps its nine blocks");
  }

  // viewport_f32 follows pt_f32 when both are present.
  {
    Snapshot s = a;
    ParticlesEntry e;
    e.id = 1;
    e.floats = std::make_shared<const std::vector<float>>(std::vector<float>{1.0f, 2.0f});
    s.particles = {e};
    const Parsed pt = parse(encode_transaction(make_full(s)));
    check(has(pt.meta, "{\"name\":\"pt_f32\",\"type\":\"f32\",\"count\":2},"
                       "{\"name\":\"viewport_f32\",\"type\":\"f32\",\"count\":36}]}"),
          "viewport_f32 comes after pt_f32: " + pt.meta);
  }

  if (out_path != nullptr) {
    std::vector<std::vector<std::uint8_t>> records;
    records.push_back(magic(ProtocolVersion::V16));
    records.push_back(encode_session(session));
    records.push_back(full_rec);
    records.push_back(patch_rec);
    records.push_back(encode_end(make_end(1, 1, records)));
    std::ofstream f(out_path, std::ios::binary);
    for (const auto &r : records) {
      f.write(reinterpret_cast<const char *>(r.data()), static_cast<std::streamsize>(r.size()));
    }
    check(f.good(), std::string("wrote ") + out_path);
  }
}

void test_plain_encode_and_unsupported() {
  // The unpredicted /12 form carries the same keys; a /16 transaction with no viewport keys and no
  // viewport or proxy texture is /15's byte for byte.
  Snapshot a = state_a(ProtocolVersion::V16);
  a.viewports.clear();
  a.textures = {image_texture()};
  Snapshot a15 = a;
  a15.version = ProtocolVersion::V15;
  check(encode_transaction(make_full(a)) == encode_transaction(make_full(a15)),
        "a /16 transaction with no viewport state is /15's byte for byte");
  check(std::string(to_wire(UnsupportedReason::Viewport3d)) == "viewport-3d" &&
            std::string(to_wire(UnsupportedReason::ViewportHdr2d)) == "viewport-hdr-2d" &&
            std::string(to_wire(UnsupportedReason::ViewportMsaa2d)) == "viewport-msaa-2d",
        "the three session-level viewport reasons");
  check(std::string(to_wire(TextureKind::Viewport)) == "viewport" &&
            std::string(to_wire(TextureKind::Proxy)) == "proxy" &&
            std::string(to_wire(TextureReason::ProxyUnresolved)) == "proxy-unresolved",
        "the new texture kind and reason spellings");
  check(is_v15_or_later(ProtocolVersion::V16) && is_v14_or_later(ProtocolVersion::V16) &&
            is_v13_or_later(ProtocolVersion::V16) && is_v12_or_later(ProtocolVersion::V16) &&
            is_v7_or_later(ProtocolVersion::V16) && is_v16(ProtocolVersion::V16) &&
            !is_v16(ProtocolVersion::V15),
        "every is_vN_or_later cascade includes V16");
}

}  // namespace

int main() {
  test_session_and_magic();
  test_full_and_patch(std::getenv("RS16_TEST_OUT"));
  test_plain_encode_and_unsupported();
  if (g_failures != 0) {
    std::fprintf(stderr, "rs16: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs16: ok\n");
  return 0;
}
