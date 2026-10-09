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
         "\"value\":null,\"layer\":null,\"root_viewport\":null}");
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
  EXPECT(has(lines[0], "\"target\":\"300\",\"ref_id\":null,\"value\":2,\"layer\":null,\"root_viewport\":null}"));
  EXPECT(has(lines[1], "\"value\":3,"));
  EXPECT(has(lines[2], "\"op\":\"viewport_set_default_canvas_item_texture_filter\""));
  EXPECT(has(lines[2], "\"value\":2,\"layer\":null,\"root_viewport\":true}"));
  EXPECT(has(lines[3], "\"root_viewport\":false}"));

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
  EXPECT(lines.size() == 1 && has(lines[0], "\"root_viewport\":false}"));

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

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_resource_log_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_resource_log_test: ok\n");
  return 0;
}
