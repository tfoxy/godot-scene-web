// Unit tests for render-stream/12 (src/rs2_codec.cpp's and rs2_diff.cpp's version == V12 path,
// PM5, protocol/render-stream-12.md).
//
// /12 is a protocol-version switch inside the SAME rs2_codec/rs2_diff modules /2-/11 use, so this
// file proves only /12's delta by matching protocol/golden-12/{full,patch,inline}.rs12 byte for
// byte: the GRSC magic and "render-stream/12", the session features, the particles table
// (`particles`, `removed_particles`), the emit list `particle_emits`, the add_particles command,
// the optional tenth block `pt_f32` and the `particle_process_material` shader builtin.
//
// The twenty-six states are golden-11's twenty-one (rs11_codec_test.cpp's state11(), included
// below with its main() renamed) plus the five of protocol/golden-12/make_golden.py
// (state22() ... state26()). It also proves the lowering a /11 (and /10) connection of a /12 host
// sees, and that the /12 additions never reach a /11 encode.

#define main rs11_codec_test_main
#include "rs11_codec_test.cpp"  // NOLINT(bugprone-suspicious-include)
#undef main

#ifndef GRC_GOLDEN12_DIR
#error "GRC_GOLDEN12_DIR must be defined by CMakeLists.txt"
#endif

namespace {

constexpr int kStates12 = 26;  // golden-12's states (make_golden.py STATES)

// make_golden.py HASH_PPM / len(PPM_PAYLOAD) (index.json "shader_payloads").
const std::string kHashPpm = "477a6be52f0d151257c48e814014c6dc0f0bfa4270151ed25322c44d18dda5c6";
constexpr std::uint64_t kPpmBytes = 486;

void check_against_golden12(const std::string &file,
                            const std::vector<std::vector<std::uint8_t>> &records) {
  const std::vector<std::uint8_t> expected = read_file(std::string(GRC_GOLDEN12_DIR) + "/" + file);
  check(!expected.empty(), ("golden-12/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                expected.begin() + static_cast<long>(offset));
    if (!matches) {
      std::fprintf(stderr, "  record %zu (%zu bytes) differs at offset %zu\n", i,
                   records[i].size(), offset);
    }
    check(matches, ("record " + std::to_string(i) + " matches golden-12/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-12/" + file + "'s length").c_str());
}

// make_golden.py xform3(): basis.rows[0..2] (xyz each), then origin.
std::vector<float> xform3(float ox, float oy, float oz, float dx = 1.0f, float dy = 1.0f,
                          float dz = 1.0f) {
  return {dx, 0.0f, 0.0f, 0.0f, dy, 0.0f, 0.0f, 0.0f, dz, ox, oy, oz};
}

// make_golden.py pt_floats() with its defaults.
struct PtFloats {
  float amount_ratio = 1.0f, lifetime = 1.0f, pre_process_time = 0.0f, explosiveness = 0.0f,
        randomness = 0.0f, speed_scale = 1.0f, collision_base_size = 1.0f, trail_length = 0.0f,
        interp_to_end = 0.0f, request_process_time = 0.0f;
  std::vector<float> custom_aabb = {-4.0f, -4.0f, -4.0f, 8.0f, 8.0f, 8.0f};
  std::vector<float> emission_transform = xform3(0.0f, 0.0f, 0.0f);
  std::vector<float> emitter_velocity = {0.0f, 0.0f, 0.0f};
  std::vector<std::vector<float>> trail_poses;

  std::shared_ptr<const std::vector<float>> build() const {
    auto out = std::make_shared<std::vector<float>>(std::vector<float>{
        amount_ratio, lifetime, pre_process_time, explosiveness, randomness, speed_scale,
        collision_base_size, trail_length, interp_to_end, request_process_time});
    out->insert(out->end(), custom_aabb.begin(), custom_aabb.end());
    out->insert(out->end(), emission_transform.begin(), emission_transform.end());
    out->insert(out->end(), emitter_velocity.begin(), emitter_velocity.end());
    for (const std::vector<float> &pose : trail_poses) {
      out->insert(out->end(), pose.begin(), pose.end());
    }
    return out;
  }
};

Command add_particles(std::uint32_t id, bool has_tex = false, std::uint32_t tex = 0) {
  Command c;
  c.kind = CommandKind::AddParticles;
  c.particles = id;
  c.has_tex = has_tex;
  c.tex = tex;
  return c;
}

UnsupportedRef pt_ref(std::uint32_t item, UnsupportedReason reason) {
  UnsupportedRef u;
  u.op = "canvas_item_add_particles";
  u.has_item = true;
  u.item = item;
  u.reason = reason;
  return u;
}

ParticlesEntry *find_pt(Snapshot &s, std::uint32_t id) {
  for (ParticlesEntry &p : s.particles) {
    if (p.id == id) {
      return &p;
    }
  }
  return nullptr;
}

// make_golden.py _sorted_unsupported(): by (item, op).
void sort_unsupported(Snapshot *s) {
  std::stable_sort(s->unsupported.begin(), s->unsupported.end(),
                   [](const UnsupportedRef &a, const UnsupportedRef &b) {
                     if (a.item != b.item) {
                       return a.item < b.item;
                     }
                     return a.op < b.op;
                   });
}

ShaderEntry ppm_shader() {
  ShaderEntry s = golden::shader_entry(ShaderStatus::Ok, 1, kHashPpm, kPpmBytes);
  s.id = 2;
  s.mode = ShaderMode::Particles;
  s.has_ppm = true;
  s.ppm.emission_shape = 3;   // box
  s.ppm.textures = 1u << 8;   // PARAM_SCALE
  s.ppm.color_ramp = true;
  // What /11 saw before PM5 (render-stream-12.md "Effect"): unsupported/shader-mode.
  ShaderEntry below = s;
  below.has_ppm = false;
  below.status = ShaderStatus::Unsupported;
  below.has_reason = true;
  below.reason = ShaderReason::ShaderMode;
  s.below_v12 = std::make_shared<const ShaderEntry>(below);
  return s;
}

MaterialEntry ppm_material() {
  MaterialEntry m = golden::material_entry(
      MaterialStatus::Ok, 1, true, 2,
      {golden::make_param("color_ramp", VariantType::Rid, {}, 1, true, 2),
       golden::make_param("emission_box_extents", VariantType::Vector3, {8.0, 8.0, 0.0}),
       golden::make_param("scale_curve", VariantType::Rid, {}, 1, true, 1)});
  m.id = 2;
  return m;
}

PtFloats e1_floats22() {
  PtFloats f;
  f.lifetime = 2.0f;
  f.explosiveness = 0.25f;
  f.randomness = 0.5f;
  f.custom_aabb = {-64.0f, -64.0f, 0.0f, 128.0f, 128.0f, 0.0f};
  return f;
}

PtFloats e2_floats(float origin_x) {
  PtFloats f;
  f.lifetime = 0.5f;
  f.emission_transform = xform3(origin_x, 50.0f, 0.0f);
  f.emitter_velocity = {4.0f, 0.0f, 0.0f};
  return f;
}

ParticleEmit make_emit(std::uint32_t particles, std::uint64_t restarts, std::uint32_t flags,
                       const std::vector<float> &transform, std::vector<float> velocity,
                       std::vector<float> color, std::vector<float> custom) {
  ParticleEmit e;
  e.particles = particles;
  e.restarts = restarts;
  e.flags = flags;
  std::vector<float> all = transform;
  all.insert(all.end(), velocity.begin(), velocity.end());
  all.insert(all.end(), color.begin(), color.end());
  all.insert(all.end(), custom.begin(), custom.end());
  std::copy(all.begin(), all.end(), e.floats.begin());
  return e;
}

// State 23's emits, the only chunk of the golden emit log (frame 23).
std::shared_ptr<const EmitTail> golden_tail() {
  auto chunk = std::make_shared<EmitChunk>();
  chunk->frame = 23;
  chunk->emits = {
      make_emit(1, 1, 5, xform3(8.0f, 4.0f, 0.0f), {0.0f, -16.0f, 0.0f}, {1.0f, 1.0f, 1.0f, 1.0f},
                {0.0f, 0.0f, 0.0f, 0.0f}),
      make_emit(1, 1, 31, xform3(-8.0f, 4.0f, 0.0f, 2.0f, 2.0f, 1.0f), {0.0f, -32.0f, 0.0f},
                {1.0f, 0.5f, 0.25f, 1.0f}, {0.5f, 0.0f, 0.0f, 1.0f})};
  auto tail = std::make_shared<EmitTail>();
  tail->push_back(chunk);
  return tail;
}

// The digest content_version stands in for (the golden carries small integers): the /11 view of
// items 18 and 19 must keep its own content versions, which make_golden.py's as_v11() recording
// never exercises, so the golden test sets no below_v12 and the lowering test sets its own.
Snapshot state12(int n) {
  Snapshot s = state11(n <= 21 ? n : 21);
  s.version = ProtocolVersion::V12;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  if (n <= 21) {
    return s;
  }
  // 22: shader 2, material 2, emitters 1 and 2, items 18 and 19.
  s.particles_commands = true;
  s.shaders.push_back(ppm_shader());
  s.materials.push_back(ppm_material());
  ParticlesEntry e1;
  e1.id = 1;
  e1.version = 14;
  e1.mode_2d = true;
  e1.emitting = true;
  e1.amount = 8;
  e1.fixed_fps = 30;
  e1.local = true;
  e1.seed = 1234;
  e1.process_material = 2;
  e1.draw_passes = {1};
  e1.floats = e1_floats22().build();
  ParticlesEntry e2;
  e2.id = 2;
  e2.version = 9;
  e2.mode_2d = true;
  e2.emitting = true;
  e2.amount = 4;
  e2.process_material = 2;
  e2.draw_passes = {0};
  e2.subemitter = 1;
  e2.floats = e2_floats(100.0f).build();
  s.particles = {e1, e2};
  s.items.push_back(bb_item(18, ParentRef{ParentKind::Canvas, 1}, {}, 224.0f, 14,
                            {add_particles(1, true, 1), add_particles(2)}));
  s.items.push_back(bb_item(19, ParentRef{ParentKind::Canvas, 1}, {}, 240.0f, 15,
                            {golden::unsupported_cmd("canvas_item_add_particles",
                                                     UnsupportedCmdReason::UnknownParticles)}));
  s.canvases.mut(0) = golden::root_canvas({1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19});
  s.unsupported.push_back(pt_ref(19, UnsupportedReason::UnknownParticles));
  sort_unsupported(&s);
  if (n >= 23) {
    // 23: emitter 2's emission origin moves; emitter 1 re-seeds, restarts and emits twice.
    ParticlesEntry *p2 = find_pt(s, 2);
    p2->version = 10;
    p2->floats = e2_floats(104.0f).build();
    ParticlesEntry *p1 = find_pt(s, 1);
    p1->version = 18;
    p1->seed = 4321;
    p1->restarts = 1;
    p1->emits = 2;
    s.emit_tail = golden_tail();
  }
  if (n >= 24) {
    // 24: emitter 1 gets trails (2 poses); emitter 3 (particles-3d) is new and drawn.
    ParticlesEntry *p1 = find_pt(s, 1);
    p1->version = 20;
    p1->trails = true;
    p1->trail_poses = 2;
    PtFloats f = e1_floats22();
    f.trail_length = 0.5f;
    f.trail_poses = {xform3(0.0f, 0.0f, 0.0f), xform3(0.0f, -4.0f, 0.0f)};
    p1->floats = f.build();
    ParticlesEntry e3;
    e3.id = 3;
    e3.status = ParticlesStatus::Unsupported;
    e3.has_reason = true;
    e3.reason = ParticlesReason::Particles3d;
    e3.version = 3;
    e3.emitting = true;
    e3.amount = 4;
    e3.floats = PtFloats().build();
    s.particles.push_back(e3);
    ItemState *it = find(s, 18);
    it->content_version = 2;
    it->commands = {add_particles(1, true, 1), add_particles(2), add_particles(3)};
    s.unsupported.push_back(pt_ref(18, UnsupportedReason::UnsupportedParticles));
    sort_unsupported(&s);
  }
  if (n >= 25) {
    // 25: emitter 3 freed while drawn (a tombstone); nothing names emitter 2 any more.
    ParticlesEntry *p3 = find_pt(s, 3);
    p3->status = ParticlesStatus::Freed;
    p3->has_reason = false;
    p3->version = 4;
    p3->process_material = 0;
    p3->draw_passes.clear();
    p3->subemitter = 0;
    p3->floats.reset();
    s.particles.erase(s.particles.begin() + 1);  // emitter 2
    ItemState *it = find(s, 18);
    it->content_version = 3;
    it->commands = {add_particles(1, true, 1), add_particles(3)};
    s.unsupported.erase(std::remove_if(s.unsupported.begin(), s.unsupported.end(),
                                       [](const UnsupportedRef &u) {
                                         return u.item == 18 &&
                                                u.op == "canvas_item_add_particles";
                                       }),
                        s.unsupported.end());
  }
  return s;
}

// golden-11's session at /12 with PM5's features.
Session session12(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                  Delivery delivery) {
  Session session = session11(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V12;
  observe_particles_features(&session.features);
  return session;
}

void test_matches_golden_full_rs12() {
  const Session session = session12(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId,
                                    Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V12));
  records.push_back(encode_session(session));
  for (int n = 1; n <= kStates12; ++n) {
    records.push_back(encode_transaction(make_full(state12(n))));
  }
  End end = make_end(kStates12, 0, 0, 0, 0, records);
  records.push_back(encode_end(end));
  check_against_golden12("full.rs12", records);
}

// seq 1, 5, 16, 21 and 26 full, every other seq a patch against its predecessor.
void test_matches_golden_patch_rs12() {
  const Session session = session12(Encoding::Patch, golden::kPatchStreamId,
                                    golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V12));
  records.push_back(encode_session(session));
  for (int n = 1; n <= kStates12; ++n) {
    if (n == 1 || n == 5 || n == 16 || n == 21 || n == 26) {
      records.push_back(encode_transaction(make_full(state12(n))));
    } else {
      records.push_back(encode_transaction(make_patch(state12(n - 1), state12(n))));
    }
  }
  End end = make_end(5, kStates12 - 5, 12345, 0, 0, records);
  records.push_back(encode_end(end));
  check_against_golden12("patch.rs12", records);
}

void test_matches_golden_inline_rs12() {
  const Session session = session12(Encoding::Full, std::string(32, '3'), std::string(32, '3'),
                                    Delivery::Inline);
  InlinePolicy policy;
  policy.inline_max_bytes = session.resources.inline_max_bytes;
  policy.inline_variants = true;
  RecordPlanner planner(ProtocolVersion::V12, policy);
  const std::string dir10 = std::string(GRC_GOLDEN10_DIR) + "/payloads/";
  const std::string dir12 = std::string(GRC_GOLDEN12_DIR) + "/payloads/";
  std::uint64_t resource_bytes = 0;
  std::uint64_t resource_count = 0;
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V12));
  records.push_back(encode_session(session));
  std::optional<Snapshot> prev;
  for (int n = 1; n <= kStates12; ++n) {
    const Snapshot cur = state12(n);
    for (const PayloadName &name : planner.next(prev ? &*prev : nullptr, cur)) {
      std::string path;
      if (name.hash == kHashPpm) {
        path = dir12 + "shader-ppm.grp";
      } else {
        const auto file = payload_files().find(name.hash);
        check(file != payload_files().end(), ("a payload file for " + name.hash).c_str());
        if (file == payload_files().end()) {
          continue;
        }
        path = dir10 + file->second;
      }
      const std::vector<std::uint8_t> payload = read_file(path);
      check(payload.size() == name.payload_bytes, (path + "'s length is payload_bytes").c_str());
      resource_bytes += payload.size();
      ++resource_count;
      records.push_back(encode_resource(ResourceRecord{name.hash, payload}));
    }
    records.push_back(encode_transaction(make_full(cur)));
    prev = cur;
  }
  End end = make_end(kStates12, 0, 0, resource_count, resource_bytes, records);
  records.push_back(encode_end(end));
  check_against_golden12("inline.rs12", records);
}

// Byte identity with /11 ("Byte identity with /11"): a /12 transaction of a state without
// particles is exactly the /11 one; the /12 session differs only in the protocol and features.
void test_byte_identity_with_v11() {
  for (int n = 1; n <= 21; ++n) {
    Snapshot s11 = state11(n);
    Snapshot s12 = state12(n);
    check(encode_transaction(make_full(s11)) == encode_transaction(make_full(s12)),
          ("seq " + std::to_string(n) + ": a /12 full without particles is /11's").c_str());
    if (n > 1) {
      check(encode_transaction(make_patch(state11(n - 1), s11)) ==
                encode_transaction(make_patch(state12(n - 1), s12)),
            ("seq " + std::to_string(n) + ": a /12 patch without particles is /11's").c_str());
    }
  }
  Session s11 = session11(Encoding::Full, std::string(32, '1'), std::string(32, 'a'),
                          Delivery::OutOfBand);
  Session s12 = s11;
  s12.version = ProtocolVersion::V12;
  const std::string t11 = text_of(encode_session(s11));
  std::string t12 = text_of(encode_session(s12));
  const std::size_t at = t12.find("render-stream/12");
  check(at != std::string::npos, "the /12 session names render-stream/12");
  t12.replace(at, 16, "render-stream/11");
  check(t11.substr(12) == t12.substr(12), "otherwise the /12 session record is /11's");
}

// A /11 (and /10) connection of a /12 host: the lowering.
void test_lowering_below_v12() {
  Snapshot s = state12(24);
  ItemState *it18 = find(s, 18);
  it18->content_version_below_v12 = 0xabc;
  it18->content_version_below_v11 = 0xabc;
  Snapshot v11 = s;
  v11.version = ProtocolVersion::V11;
  const std::string t11 = text_of(encode_transaction(make_full(v11)));
  check(t11.find(",\"particles\":[") == std::string::npos &&
            t11.find("particle_emits") == std::string::npos &&
            t11.find("\"op\":\"add_particles\"") == std::string::npos &&
            t11.find("pt_f32") == std::string::npos,
        "a /11 transaction of a /12 host carries no particles key, block or command");
  check(t11.find("{\"op\":\"unsupported\",\"name\":\"canvas_item_add_particles\",\"reason\":"
                 "\"unsupported-op\"}") != std::string::npos,
        "add_particles lowers to /11's unsupported-op command");
  check(t11.find("{\"op\":\"canvas_item_add_particles\",\"item\":18,\"reason\":\"unsupported-op\"}"
                 ",{\"op\":\"canvas_item_add_particles\",\"item\":19,\"reason\":\"unsupported-op\""
                 "}") != std::string::npos,
        "the item-level entries are one unsupported-op per drawing item");
  check(t11.find("\"content_version\":2748") != std::string::npos,
        "the lowered item carries its below_v12 content_version");
  check(t11.find("particle_process_material") == std::string::npos &&
            t11.find("\"reason\":\"shader-mode\"") != std::string::npos,
        "the process-material shader is /11's shader-mode below /12");
  // A /11 patch between two /12 states with particles changes carries no entry.
  Snapshot b = state12(22);
  b.version = ProtocolVersion::V11;
  Snapshot c = state12(23);
  c.version = ProtocolVersion::V11;
  const Transaction p = make_patch(b, c);
  check(p.particles.empty() && p.particle_emits.empty() && p.items.empty() && p.shaders.empty(),
        "a /11 patch over particles-only changes lists nothing");
  // /10: both lowered.
  Snapshot v10 = state12(22);
  v10.version = ProtocolVersion::V10;
  const std::string t10 = text_of(encode_transaction(make_full(v10)));
  check(t10.find("\"op\":\"add_multimesh\"") == std::string::npos &&
            t10.find("\"op\":\"add_particles\"") == std::string::npos,
        "a /10 transaction of a /12 host lowers both multimesh and particles");
}

// make_patch's (B, T] emit rule over a multi-frame gap and the full's own-frame rule.
void test_emit_windows() {
  Snapshot b = state12(22);
  Snapshot t = state12(24);
  t.frame = 30;
  const Transaction p = make_patch(b, t);
  check(p.particle_emits.size() == 2, "a patch from 22 to 30 lists frame 23's emits");
  const Transaction p2 = make_patch(state12(23), t);
  check(p2.particle_emits.empty(), "a patch from 23 lists no emit of frame 23");
  check(make_full(state12(23)).particle_emits.size() == 2 &&
            make_full(state12(24)).particle_emits.empty(),
        "a full lists the emits of its own frame only");
  Transaction f = make_full(state12(22));
  const std::string plain = text_of(encode_transaction(f));
  f.perturb_seed = true;
  const std::string perturbed = text_of(encode_transaction(f));
  check(plain.find("\"seed\":1234") != std::string::npos &&
            perturbed.find("\"seed\":1235") != std::string::npos &&
            perturbed.find("\"seed\":0,") != std::string::npos,
        "perturb-seed adds 1 to the first entry's seed only");
  check(magic(ProtocolVersion::V12)[3] == 'C' && std::string(kProtocolV12) == "render-stream/12",
        "GRSC and render-stream/12");
}

}  // namespace

// rs13_codec_test.cpp includes this file with its main() renamed (rs11's is renamed here).
#ifndef GRC_RS12_CODEC_TEST_MAIN
#define GRC_RS12_CODEC_TEST_MAIN main
#endif
int GRC_RS12_CODEC_TEST_MAIN() {
  test_matches_golden_full_rs12();
  test_matches_golden_patch_rs12();
  test_matches_golden_inline_rs12();
  test_byte_identity_with_v11();
  test_lowering_below_v12();
  test_emit_windows();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs12_codec_test: all checks passed\n");
  return 0;
}
