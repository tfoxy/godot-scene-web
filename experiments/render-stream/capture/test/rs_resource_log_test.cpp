// G2a: the texture hook log (rs_resource_log.h, gate2-design.md Q3 "Hook log"),
// driven through its taps with no engine: id assignment from one per-session
// counter, version bumps, update shape and layer rules, replace retiring the
// by-texture, free logging only known textures, the root-viewport flag, the
// exact line shape, and a fresh session restarting ids.
#include <cstdio>
#include <string>
#include <vector>

#include "rs_resource_log.h"

namespace {

int g_failures = 0;

#define EXPECT(cond)                                                     \
  do {                                                                   \
    if (!(cond)) {                                                       \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                                      \
    }                                                                    \
  } while (0)

std::vector<std::string> split_lines(const std::string &text) {
  std::vector<std::string> lines;
  std::size_t start = 0;
  while (start < text.size()) {
    const std::size_t end = text.find('\n', start);
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  return lines;
}

bool has(const std::string &line, const std::string &fragment) {
  return line.find(fragment) != std::string::npos;
}

grc::rs::PayloadCopy rgba8(std::int64_t w, std::int64_t h, const char *hash) {
  grc::rs::PayloadCopy copy;
  copy.status = "ok";
  copy.format = 5;
  copy.width = w;
  copy.height = h;
  copy.mipmaps_known = true;
  copy.mipmaps = false;
  copy.data_bytes = w * h * 4;
  copy.payload_bytes = copy.data_bytes + 111;
  copy.hash = hash;
  copy.copy_ns = 1200;
  copy.hash_ns = 3400;
  return copy;
}

}  // namespace

int main() {
  using grc::rs::PayloadCopy;
  using grc::rs::ResourceLog;
  using grc::rs::TapContext;

  ResourceLog log;
  const TapContext main_ctx{7, 5000000, true};
  const TapContext other_ctx{7, 5002000, false};

  // Inactive: nothing is logged.
  log.texture_2d_create(main_ctx, 100, rgba8(16, 16, "aa"));
  EXPECT(log.take_lines().empty());

  log.start(1000000, 900);
  log.texture_2d_create(main_ctx, 100, rgba8(16, 16, "aa"));       // id 1
  log.texture_2d_placeholder_create(main_ctx, 101);                // id 2
  PayloadCopy refused;
  refused.status = "unsupported";
  refused.reason = "unsupported-format";
  refused.format = 11;
  refused.width = 4;
  refused.height = 4;
  refused.mipmaps_known = true;
  refused.data_bytes = 256;
  log.texture_2d_create(other_ctx, 102, refused);                  // id 3
  std::vector<std::string> lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 3);
  EXPECT(lines[0] ==
         "{\"frame\":7,\"t_us\":4000,\"thread\":\"main\",\"op\":\"texture_2d_create\",\"id\":1,"
         "\"by_id\":null,\"rid\":\"100\",\"version\":1,\"kind\":\"image\",\"status\":\"ok\","
         "\"reason\":null,\"format\":\"RGBA8\",\"width\":16,\"height\":16,\"mipmaps\":false,"
         "\"data_bytes\":1024,\"payload_bytes\":1135,\"hash\":\"aa\",\"copy_ns\":1200,"
         "\"hash_ns\":3400,\"conn\":null,\"http_status\":null,\"target\":null,\"ref_id\":null,"
         "\"value\":null,\"layer\":null,\"root_viewport\":null,\"surface\":null,\"buffer\":null,"
         "\"offset\":null,\"bytes\":null,\"primitive\":null,\"vertex_count\":null,"
         "\"index_count\":null,\"outcome\":null,\"mode\":null,\"source\":null,\"builtin\":null,"
         "\"uses\":null,\"scan_ns\":null,\"param\":null,\"type\":null,\"n\":null,"
         "\"decode_ns\":null,\"sublayer\":null,\"transform\":null,\"parent\":null,"
         "\"mirroring\":null,\"repeat\":null}");
  EXPECT(has(lines[1], "\"op\":\"texture_2d_placeholder_create\",\"id\":2,"));
  EXPECT(has(lines[1], "\"kind\":\"placeholder\",\"status\":\"ok\",\"reason\":null,\"format\":null"));
  EXPECT(has(lines[2], "\"thread\":\"other\""));
  EXPECT(has(lines[2], "\"id\":3,"));
  EXPECT(has(lines[2], "\"status\":\"unsupported\",\"reason\":\"unsupported-format\",\"format\":\"RGBAF\""));
  EXPECT(has(lines[2], "\"payload_bytes\":0,\"hash\":null,\"copy_ns\":null,\"hash_ns\":null"));
  EXPECT(log.texture_id(100) == 1 && log.texture_id(101) == 2 && log.texture_id(999) == 0);

  // Updates: same shape bumps the version and takes the payload; another shape or
  // a layer is refused; an unknown RID is counted and logged with a null id.
  log.texture_2d_update(main_ctx, 100, rgba8(16, 16, "bb"), 0);
  log.texture_2d_update(main_ctx, 100, rgba8(8, 8, "cc"), 0);
  log.texture_2d_update(main_ctx, 100, rgba8(8, 8, "cc"), 1);
  log.texture_2d_update(main_ctx, 555, rgba8(8, 8, "dd"), 0);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 4);
  EXPECT(has(lines[0], "\"id\":1,\"by_id\":null,\"rid\":\"100\",\"version\":2,\"kind\":\"image\",\"status\":\"ok\""));
  EXPECT(has(lines[0], "\"hash\":\"bb\""));
  EXPECT(has(lines[0], "\"layer\":0,"));
  EXPECT(has(lines[1], "\"version\":3,\"kind\":\"image\",\"status\":\"unsupported\",\"reason\":\"update-shape-mismatch\""));
  EXPECT(has(lines[2], "\"version\":4,\"kind\":\"image\",\"status\":\"unsupported\",\"reason\":\"layered-update\""));
  EXPECT(has(lines[3], "\"id\":null,"));
  EXPECT(has(lines[3], "\"reason\":\"unknown-texture\""));
  EXPECT(log.update_unknown() == 1);

  // Replace: ImageTexture::set_image's create + replace. The target keeps its id,
  // takes the new content (version + 1), and the temporary id leaves the log.
  log.texture_2d_create(main_ctx, 103, rgba8(32, 32, "ee"));       // id 4
  log.texture_replace(main_ctx, 100, 103);
  EXPECT(log.texture_id(103) == 0);
  log.texture_replace(main_ctx, 101, 101);                         // t == b: no-op
  log.texture_replace(main_ctx, 101, 777);                         // b unknown
  log.texture_replace(main_ctx, 778, 102);                         // t unknown: b retired
  EXPECT(log.texture_id(102) == 0);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 5);
  EXPECT(has(lines[0], "\"id\":4,"));
  EXPECT(has(lines[1], "\"op\":\"texture_replace\",\"id\":1,\"by_id\":4,\"rid\":\"100\",\"version\":5,\"kind\":\"image\",\"status\":\"ok\",\"reason\":null,\"format\":\"RGBA8\",\"width\":32"));
  EXPECT(has(lines[1], "\"target\":\"103\",\"ref_id\":4,"));
  EXPECT(has(lines[2], "\"id\":2,\"by_id\":2,\"rid\":\"101\",\"version\":1,"));
  EXPECT(has(lines[3], "\"id\":2,\"by_id\":null,\"rid\":\"101\",\"version\":2,\"kind\":\"placeholder\",\"status\":\"unsupported\",\"reason\":\"unknown-texture\""));
  EXPECT(has(lines[4], "\"id\":null,\"by_id\":3,\"rid\":\"778\""));

  // Free: logged for a known texture only, which then leaves the log.
  log.free_rid(main_ctx, 100);
  log.free_rid(main_ctx, 4242);  // a canvas item, say
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1);
  EXPECT(has(lines[0], "\"op\":\"free\",\"id\":1,\"by_id\":null,\"rid\":\"100\",\"version\":5,\"kind\":\"image\",\"status\":\"freed\""));
  EXPECT(log.texture_id(100) == 0);

  // Canvas textures share the id counter; setters bump on change only.
  log.canvas_texture_create(main_ctx, 200);                        // id 5
  log.canvas_texture_set_channel(main_ctx, 200, 0, 101);
  log.canvas_texture_set_channel(main_ctx, 200, 0, 101);
  log.canvas_texture_set_filter(main_ctx, 200, 1);
  log.canvas_texture_set_repeat(main_ctx, 200, 2);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 5);
  EXPECT(has(lines[0], "\"op\":\"canvas_texture_create\",\"id\":5,"));
  EXPECT(has(lines[0], "\"kind\":\"canvas\""));
  EXPECT(has(lines[1], "\"version\":2,"));
  EXPECT(has(lines[1], "\"target\":\"101\",\"ref_id\":2,\"value\":0,"));
  EXPECT(has(lines[2], "\"version\":2,"));
  EXPECT(has(lines[3], "\"op\":\"canvas_texture_set_texture_filter\",\"id\":5,"));
  EXPECT(has(lines[3], "\"version\":3,"));
  EXPECT(has(lines[4], "\"version\":4,"));
  EXPECT(has(lines[4], "\"value\":2,"));

  // A headless host (protocol/canvas-texture-headless.md): canvas_texture_create returned RID()
  // and the setters name RID(): each line is a typed refusal with no id, and no id is spent.
  log.canvas_texture_create(main_ctx, 0);
  log.canvas_texture_set_channel(main_ctx, 0, 0, 101);
  log.canvas_texture_set_filter(main_ctx, 0, 1);
  log.canvas_texture_set_repeat(main_ctx, 0, 2);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 4);
  for (const std::string &l : lines) {
    EXPECT(has(l, "\"id\":null,\"by_id\":null,\"rid\":null,\"version\":null,\"kind\":\"canvas\","
                  "\"status\":\"unsupported\",\"reason\":\"canvas-texture-headless\""));
  }
  EXPECT(has(lines[1], "\"target\":\"101\",\"ref_id\":2,\"value\":0,"));
  log.canvas_texture_create(main_ctx, 201);  // a real one afterwards takes the next id, 6
  lines = split_lines(log.take_lines());
  EXPECT(has(lines[0], "\"op\":\"canvas_texture_create\",\"id\":6,"));

  // Item and viewport defaults: no id; the root flag compares the viewport RID.
  log.canvas_item_set_default_texture_filter(main_ctx, 300, 2);
  log.canvas_item_set_default_texture_repeat(main_ctx, 300, 3);
  log.viewport_set_default_texture_filter(main_ctx, 900, 2);
  log.viewport_set_default_texture_repeat(main_ctx, 901, 1);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 4);
  EXPECT(has(lines[0], "\"op\":\"canvas_item_set_default_texture_filter\",\"id\":null,"));
  EXPECT(has(lines[0], "\"target\":\"300\",\"ref_id\":null,\"value\":2,\"layer\":null,\"root_viewport\":null,"));
  EXPECT(has(lines[1], "\"value\":3,"));
  EXPECT(has(lines[2], "\"op\":\"viewport_set_default_canvas_item_texture_filter\""));
  EXPECT(has(lines[2], "\"value\":2,\"layer\":null,\"root_viewport\":true,"));
  EXPECT(has(lines[3], "\"root_viewport\":false,"));

  // A fresh session restarts ids and forgets every texture.
  log.stop();
  log.texture_2d_placeholder_create(main_ctx, 400);
  EXPECT(log.take_lines().empty());
  log.start(0, 0);
  EXPECT(log.texture_id(101) == 0);
  log.texture_2d_placeholder_create(main_ctx, 400);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1 && has(lines[0], "\"id\":1,"));
  log.viewport_set_default_texture_filter(main_ctx, 0, 1);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1 && has(lines[0], "\"root_viewport\":false,"));

  // G2b2: an op the omit-op sabotage dropped is logged, marked, and leaves the registry alone.
  log.texture_2d_create(main_ctx, 500, rgba8(4, 4, "f0"));          // id 2
  log.texture_2d_update(main_ctx, 500, rgba8(4, 4, "f1"), 0, true);
  log.texture_replace(main_ctx, 500, 400, true);
  log.free_rid(main_ctx, 400, true);
  log.texture_2d_create(main_ctx, 501, rgba8(4, 4, "f2"), true);
  log.texture_2d_placeholder_create(main_ctx, 502, true);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 6);
  EXPECT(has(lines[1], "\"id\":2,\"by_id\":null,\"rid\":\"500\",\"version\":1,") &&
         has(lines[1], "\"hash\":\"f1\"") && has(lines[1], ",\"sabotage\":true,\"omitted\":true}"));
  EXPECT(has(lines[2], "\"id\":2,\"by_id\":1,\"rid\":\"500\",\"version\":1,") &&
         has(lines[2], "\"omitted\":true}"));
  EXPECT(has(lines[3], "\"op\":\"free\",\"id\":1,") && has(lines[3], "\"status\":\"ok\"") &&
         has(lines[3], "\"omitted\":true}"));
  EXPECT(has(lines[4], "\"op\":\"texture_2d_create\",\"id\":null,") &&
         has(lines[4], "\"omitted\":true}"));
  EXPECT(has(lines[5], "\"op\":\"texture_2d_placeholder_create\",\"id\":null,"));
  EXPECT(log.texture_id(500) == 2 && log.texture_id(400) == 1 && log.texture_id(501) == 0 &&
         log.texture_id(502) == 0);
  EXPECT(!has(lines[0], "sabotage"));
  // spurious-texture-update: version + 1, the same payload, marked sabotage (not omitted).
  log.spurious_update(main_ctx, 500);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1 && has(lines[0], "\"op\":\"texture_2d_update\",\"id\":2,") &&
         has(lines[0], "\"version\":2,") && has(lines[0], "\"hash\":\"f0\"") &&
         has(lines[0], "\"layer\":0,") && has(lines[0], ",\"sabotage\":true}"));
  // Publisher events.
  log.resource_event(main_ctx, "store", "abcd", 1135, "ok");
  log.resource_event(main_ctx, "inline", "abcd", 1135, "ok", 3);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"store\",\"id\":null,") && has(lines[0], "\"status\":\"ok\"") &&
         has(lines[0], "\"format\":null,") && has(lines[0], "\"payload_bytes\":1135,\"hash\":\"abcd\"") &&
         has(lines[0], "\"conn\":null,"));
  EXPECT(has(lines[1], "\"op\":\"inline\"") && has(lines[1], "\"conn\":3,"));

  // G5a (gate5-design.md Q3d): meshes have their own id counter, independent of textures'.
  using grc::rs::MeshSurfaceCopy;
  const auto ok_surface = [](const char *hash) {
    MeshSurfaceCopy s;
    s.status = "ok";
    s.primitive = 3;  // triangles
    s.format = (1ull << 25) | 1;  // USE_2D_VERTICES | VERTEX
    s.vertex_count = 3;
    s.index_count = 0;
    s.hash = hash;
    s.copy_ns = 10;
    s.hash_ns = 20;
    return s;
  };
  log.mesh_create(main_ctx, 600);  // id 1
  log.mesh_add_surface(main_ctx, 600, ok_surface("m0"));
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"mesh_create\",") && has(lines[0], "\"id\":1,") &&
         has(lines[0], "\"rid\":\"600\",") && has(lines[0], "\"version\":1,") &&
         has(lines[0], "\"kind\":\"mesh\",\"status\":\"ok\"") &&
         has(lines[0], "\"outcome\":\"applied\""));
  EXPECT(has(lines[1], "\"op\":\"mesh_add_surface\",") && has(lines[1], "\"id\":1,") &&
         has(lines[1], "\"version\":2,\"kind\":\"mesh\",\"status\":\"ok\"") &&
         has(lines[1], "\"format\":33554433,\"width\":null,\"height\":null,\"mipmaps\":null,"
                       "\"data_bytes\":null,\"payload_bytes\":null,\"hash\":\"m0\","
                       "\"copy_ns\":10,\"hash_ns\":20,") &&
         has(lines[1], "\"surface\":0,\"buffer\":null,\"offset\":null,\"bytes\":null,"
                       "\"primitive\":\"triangles\",\"vertex_count\":3,\"index_count\":0,"
                       "\"outcome\":\"applied\""));
  EXPECT(log.mesh_id(600) == 1);

  // A refused surface makes the entry unsupported; a region update re-hashes it and bumps the
  // version; an update on an unknown mesh or out of range is "unknown" and changes nothing; a
  // rejected (out-of-bounds) update changes nothing either.
  MeshSurfaceCopy refused_surface;
  refused_surface.status = "unsupported";
  refused_surface.reason = "mesh-format";
  refused_surface.primitive = 3;
  log.mesh_add_surface(main_ctx, 600, refused_surface);  // surface 1, now unsupported
  log.take_lines();
  const MeshSurfaceCopy updated = ok_surface("m1");
  log.mesh_surface_update_region(main_ctx, 600, "vertex", 0, 0, 24, "applied", &updated);
  log.mesh_surface_update_region(main_ctx, 600, "vertex", 0, 0, 24, "rejected", nullptr);
  log.mesh_surface_update_region(main_ctx, 999, "vertex", 0, 0, 24, "unknown", nullptr);
  log.mesh_surface_update_region(main_ctx, 600, "attribute", 5, 0, 8, "unknown", nullptr);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 4);
  EXPECT(has(lines[0], "\"op\":\"mesh_surface_update_vertex_region\",") &&
         has(lines[0], "\"id\":1,") && has(lines[0], "\"version\":4,") &&
         has(lines[0], "\"status\":\"unsupported\",\"reason\":\"mesh-format\"") &&
         has(lines[0], "\"hash\":\"m1\",\"copy_ns\":10,\"hash_ns\":20,") &&
         has(lines[0], "\"surface\":0,\"buffer\":\"vertex\",\"offset\":0,\"bytes\":24,") &&
         has(lines[0], "\"outcome\":\"applied\""));
  EXPECT(has(lines[1], "\"version\":4,") && has(lines[1], "\"outcome\":\"rejected\""));
  EXPECT(has(lines[2], "\"id\":null,") && has(lines[2], "\"outcome\":\"unknown\""));
  EXPECT(has(lines[3], "\"id\":1,") && has(lines[3], "\"version\":4,") &&
         has(lines[3], "\"outcome\":\"unknown\""));

  // mesh_surface_remove renumbers; the remaining ok surface makes the entry ok again.
  log.mesh_surface_remove(main_ctx, 600, 1);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1);
  EXPECT(has(lines[0], "\"op\":\"mesh_surface_remove\",") && has(lines[0], "\"id\":1,") &&
         has(lines[0], "\"version\":5,\"kind\":\"mesh\",\"status\":\"ok\",\"reason\":null") &&
         has(lines[0], "\"surface\":1,") && has(lines[0], "\"outcome\":\"applied\""));

  // mesh_set_custom_aabb and mesh_clear bump the version; clear drops every surface.
  log.mesh_set_custom_aabb(main_ctx, 600);
  log.mesh_clear(main_ctx, 600);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"mesh_set_custom_aabb\",") && has(lines[0], "\"id\":1,") &&
         has(lines[0], "\"version\":6,"));
  EXPECT(has(lines[1], "\"op\":\"mesh_clear\",") && has(lines[1], "\"id\":1,") &&
         has(lines[1], "\"version\":7,\"kind\":\"mesh\",\"status\":\"ok\","));

  // free logs a known mesh and it leaves the registry; an unknown free (an item, say) is silent.
  log.free_rid(main_ctx, 600);
  log.free_rid(main_ctx, 4343);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1);
  EXPECT(has(lines[0], "\"op\":\"free\",") && has(lines[0], "\"id\":1,") &&
         has(lines[0], "\"rid\":\"600\",") && has(lines[0], "\"version\":7,") &&
         has(lines[0], "\"kind\":\"mesh\",\"status\":\"freed\""));
  EXPECT(log.mesh_id(600) == 0);

  // mesh_create_from_surfaces classifies every surface at once and spends one id.
  log.mesh_create_from_surfaces(main_ctx, 601, {ok_surface("a"), ok_surface("b")});  // id 2
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1);
  EXPECT(has(lines[0], "\"op\":\"mesh_create_from_surfaces\",") && has(lines[0], "\"id\":2,") &&
         has(lines[0], "\"rid\":\"601\",") && has(lines[0], "\"version\":1,") &&
         has(lines[0], "\"kind\":\"mesh\",\"status\":\"ok\""));
  EXPECT(log.mesh_id(601) == 2);
  // ... and with several surfaces the line names none of them.
  EXPECT(has(lines[0], "\"hash\":null,") && has(lines[0], "\"surface\":null,"));

  // G5c: a creation with exactly one surface carries it, as a mesh_add_surface line does.
  log.mesh_create_from_surfaces(main_ctx, 602, {ok_surface("d")});  // id 3
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1);
  EXPECT(has(lines[0], "\"op\":\"mesh_create_from_surfaces\",") && has(lines[0], "\"id\":3,") &&
         has(lines[0], "\"version\":1,") && has(lines[0], "\"hash\":\"d\",") &&
         has(lines[0], "\"surface\":0,") && has(lines[0], "\"outcome\":\"applied\""));

  // omit-op: the line is marked and the registry is left untouched.
  log.mesh_add_surface(main_ctx, 601, ok_surface("c"), true);
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 1 && has(lines[0], "\"id\":2,") && has(lines[0], "\"version\":1,") &&
         has(lines[0], ",\"sabotage\":true,\"omitted\":true}"));

  // G55a (gate5_5-design.md Q3d): shaders and materials have their own id counters,
  // independent of textures' and meshes'.
  using grc::rs::MaterialParamCopy;
  using grc::rs::ShaderCopy;
  const auto ok_shader = [](const char *hash, const char *mode) {
    ShaderCopy copy;
    copy.status = "ok";
    copy.mode = mode;
    copy.hash = hash;
    copy.payload_bytes = 64;
    copy.copy_ns = 11;
    copy.hash_ns = 22;
    copy.scan_ns = 33;
    return copy;
  };
  log.shader_create(main_ctx, 700);  // id 1, no code yet
  log.shader_create_from_code(main_ctx, 701, ok_shader("s0", "canvas_item"));  // id 2
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"shader_create\",\"id\":1,") &&
         has(lines[0], "\"rid\":\"700\",\"version\":1,\"kind\":\"shader\",\"status\":\"ok\"") &&
         has(lines[0], "\"mode\":null,\"source\":null,\"builtin\":null,\"uses\":null,"));
  EXPECT(has(lines[1], "\"op\":\"shader_create_from_code\",\"id\":2,") &&
         has(lines[1], "\"rid\":\"701\",\"version\":1,\"kind\":\"shader\",\"status\":\"ok\"") &&
         has(lines[1], "\"hash\":\"s0\",\"copy_ns\":11,\"hash_ns\":22,") &&
         has(lines[1], "\"mode\":\"canvas_item\",\"source\":\"payload\",\"builtin\":null,"
                       "\"uses\":[],\"scan_ns\":33,"));
  EXPECT(log.shader_id(700) == 1 && log.shader_id(701) == 2 && log.shader_id(9999) == 0);

  log.shader_set_code(main_ctx, 701, ok_shader("s1", "canvas_item"));
  log.shader_set_default_texture_parameter(main_ctx, 701, "pal", 950, 0);
  log.shader_set_code(main_ctx, 9999, ok_shader("s2", "canvas_item"));  // unknown shader
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 3);
  EXPECT(has(lines[0], "\"id\":2,") && has(lines[0], "\"version\":2,\"kind\":\"shader\"") &&
         has(lines[0], "\"hash\":\"s1\","));
  EXPECT(has(lines[1], "\"op\":\"shader_set_default_texture_parameter\",\"id\":2,") &&
         has(lines[1], "\"version\":3,\"kind\":\"shader\"") &&
         has(lines[1], "\"target\":\"950\",\"ref_id\":null,\"value\":0,") &&
         has(lines[1], "\"param\":\"pal\","));
  EXPECT(has(lines[2], "\"id\":null,") && has(lines[2], "\"outcome\":\"unknown\""));

  log.material_create(main_ctx, 800);  // id 1
  log.material_create_from_shader(main_ctx, 801, 701);  // id 2, shader known
  log.material_create_from_shader(main_ctx, 802, 12345);  // id 3, shader unknown
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 3);
  EXPECT(has(lines[0], "\"op\":\"material_create\",\"id\":1,") &&
         has(lines[0], "\"rid\":\"800\",\"version\":1,\"kind\":\"material\",\"status\":\"ok\""));
  EXPECT(has(lines[1], "\"op\":\"material_create_from_shader\",\"id\":2,") &&
         has(lines[1], "\"rid\":\"801\",\"version\":1,\"kind\":\"material\",\"status\":\"ok\"") &&
         has(lines[1], "\"target\":\"701\",\"ref_id\":2,"));
  EXPECT(has(lines[2], "\"id\":3,") &&
         has(lines[2], "\"rid\":\"802\",\"version\":1,\"kind\":\"material\","
                       "\"status\":\"unsupported\",\"reason\":\"unknown-shader\"") &&
         has(lines[2], "\"target\":\"12345\",\"ref_id\":null,"));
  EXPECT(log.material_id(800) == 1 && log.material_id(801) == 2 && log.material_id(802) == 3);

  log.material_set_shader(main_ctx, 800, 700);  // a known shader: ok
  log.material_set_shader(main_ctx, 999, 700);  // unknown material
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"material_set_shader\",\"id\":1,") &&
         has(lines[0], "\"version\":2,\"kind\":\"material\",\"status\":\"ok\"") &&
         has(lines[0], "\"target\":\"700\",\"ref_id\":1,"));
  EXPECT(has(lines[1], "\"id\":null,") && has(lines[1], "\"outcome\":\"unknown\""));

  MaterialParamCopy applied;
  applied.type = "color";
  applied.n = 1;
  applied.outcome = "applied";
  applied.decode_ns = 15;
  MaterialParamCopy rejected;
  rejected.type = "object";
  rejected.outcome = "rejected";
  rejected.decode_ns = 5;
  log.material_set_param(main_ctx, 800, "tint", applied);
  log.material_set_param(main_ctx, 800, "bad", rejected);  // D6: no change
  log.material_set_param(main_ctx, 999, "tint", applied);  // unknown material
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 3);
  EXPECT(has(lines[0], "\"op\":\"material_set_param\",\"id\":1,") &&
         has(lines[0], "\"version\":3,\"kind\":\"material\"") &&
         has(lines[0], "\"param\":\"tint\",\"type\":\"color\",\"n\":1,\"decode_ns\":15,") &&
         has(lines[0], "\"outcome\":\"applied\""));
  EXPECT(has(lines[1], "\"id\":1,") &&
         has(lines[1], "\"version\":3,\"kind\":\"material\"") &&  // unchanged: OBJECT is rejected
         has(lines[1], "\"param\":\"bad\",\"type\":\"object\",") &&
         has(lines[1], "\"outcome\":\"rejected\""));
  EXPECT(has(lines[2], "\"id\":null,\"by_id\":null,\"rid\":\"999\",\"version\":null,") &&
         has(lines[2], "\"outcome\":\"applied\""));

  log.canvas_item_set_use_parent_material(main_ctx, 900, true);
  log.canvas_item_set_instance_shader_parameter(main_ctx, 900, "inst_color", applied);
  log.canvas_set_modulate(main_ctx, 1);
  log.canvas_light_attach_to_canvas(main_ctx, 10, 1);
  log.canvas_light_attach_to_canvas(main_ctx, 11, 0);  // detached: not a refusal
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 5);
  EXPECT(has(lines[0], "\"op\":\"canvas_item_set_use_parent_material\",") &&
         has(lines[0], "\"rid\":\"900\",") &&
         has(lines[0], "\"kind\":\"item-material\",") && has(lines[0], "\"value\":1,") &&
         has(lines[0], "\"outcome\":\"applied\""));
  EXPECT(has(lines[1], "\"op\":\"canvas_item_set_instance_shader_parameter\",") &&
         has(lines[1], "\"rid\":\"900\",") &&
         has(lines[1], "\"param\":\"inst_color\",\"type\":\"color\","));
  EXPECT(has(lines[2], "\"op\":\"canvas_set_modulate\",") && has(lines[2], "\"rid\":\"1\",") &&
         has(lines[2], "\"kind\":\"item-material\","));
  EXPECT(has(lines[3], "\"op\":\"canvas_light_attach_to_canvas\",") &&
         has(lines[3], "\"rid\":\"10\",") &&
         has(lines[3], "\"kind\":\"item-material\",\"status\":\"unsupported\","
                       "\"reason\":\"canvas-light\",") &&
         has(lines[3], "\"target\":\"1\","));
  EXPECT(has(lines[4], "\"rid\":\"11\",\"version\":null,\"kind\":\"item-material\","
                       "\"status\":null,\"reason\":null,") &&
         has(lines[4], "\"target\":null,"));

  // G6k (gate6-design.md Q2, calibrator 9): canvas lines, decode only, no registry.
  const float global_transform[6] = {1.0f, 0.0f, 0.0f, 1.0f, 8.5f, 4.25f};
  const float mirroring[2] = {16.25f, 8.5f};
  const float repeat_size[2] = {32.5f, 24.25f};
  log.viewport_remove_canvas(main_ctx, 1000, 1001);
  log.viewport_remove_canvas(main_ctx, 0, 1002);  // null viewport: target absent
  log.viewport_set_global_canvas_transform(main_ctx, 1000, global_transform);
  log.viewport_set_canvas_stacking(main_ctx, 1000, 1001, 2, 0);
  log.canvas_set_item_mirroring(main_ctx, 1001, 1100, mirroring);
  log.canvas_set_item_repeat(main_ctx, 1100, repeat_size, 3);
  log.canvas_set_parent(main_ctx, 1001, 1003);
  log.canvas_set_parent(main_ctx, 1001, 0);  // RID(): parent absent
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 8);
  EXPECT(has(lines[0], "\"op\":\"viewport_remove_canvas\",") && has(lines[0], "\"rid\":\"1001\",") &&
         has(lines[0], "\"kind\":\"canvas\",") && has(lines[0], "\"target\":\"1000\","));
  EXPECT(has(lines[1], "\"rid\":\"1002\",") && has(lines[1], "\"target\":null,"));
  EXPECT(has(lines[2], "\"op\":\"viewport_set_global_canvas_transform\",") &&
         has(lines[2], "\"rid\":\"1000\",") &&
         has(lines[2], "\"transform\":[1,0,0,1,8.5,4.25],"));
  EXPECT(has(lines[3], "\"op\":\"viewport_set_canvas_stacking\",") &&
         has(lines[3], "\"rid\":\"1001\",") && has(lines[3], "\"target\":\"1000\",") &&
         has(lines[3], "\"layer\":2,") && has(lines[3], "\"sublayer\":0,"));
  EXPECT(has(lines[4], "\"op\":\"canvas_set_item_mirroring\",") &&
         has(lines[4], "\"rid\":\"1001\",") && has(lines[4], "\"target\":\"1100\",") &&
         has(lines[4], "\"mirroring\":[16.25,8.5],"));
  EXPECT(has(lines[5], "\"op\":\"canvas_set_item_repeat\",") && has(lines[5], "\"rid\":\"1100\",") &&
         has(lines[5], "\"repeat\":[32.5,24.25,3]}"));
  EXPECT(has(lines[6], "\"op\":\"canvas_set_parent\",") && has(lines[6], "\"rid\":\"1001\",") &&
         has(lines[6], "\"parent\":\"1003\","));
  EXPECT(has(lines[7], "\"rid\":\"1001\",") && has(lines[7], "\"parent\":null,"));
  for (const std::string &l : lines) {
    EXPECT(has(l, "\"kind\":\"canvas\",") && has(l, "\"status\":null,\"reason\":null,"));
  }

  // free: a known shader or material is logged and leaves the registry.
  log.free_rid(main_ctx, 700);
  log.free_rid(main_ctx, 800);
  log.free_rid(main_ctx, 54321);  // unknown: silent
  lines = split_lines(log.take_lines());
  EXPECT(lines.size() == 2);
  EXPECT(has(lines[0], "\"op\":\"free\",\"id\":1,") &&
         has(lines[0], "\"rid\":\"700\",\"version\":1,\"kind\":\"shader\",\"status\":\"freed\""));
  // G55d (D5): freeing shader 700 set material 800 (which named it) to no shader, version 3 -> 4,
  // with no line of its own; the material's own free then carries version 4.
  EXPECT(has(lines[1], "\"op\":\"free\",\"id\":1,") &&
         has(lines[1], "\"rid\":\"800\",\"version\":4,\"kind\":\"material\",\"status\":\"freed\""));
  EXPECT(log.shader_id(700) == 0 && log.material_id(800) == 0);

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_resource_log_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_resource_log_test: ok\n");
  return 0;
}
