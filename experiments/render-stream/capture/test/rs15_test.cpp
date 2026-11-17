// Unit tests for render-stream/15 on the host (protocol/render-stream-15.md):
//
// - the codec: the GRSF magic and protocol string; resource_hint / resource_unhint bytes in the
//   spec's key order; a texture entry's size_override (after variants, before canvas, /15 only);
//   a /15 transaction with no override is /14's byte for byte (plain and predicted);
// - the hint table (src/rs_hints.{h,cpp}): priority order, the budget walk (a strict priority
//   prefix; in-state entries free), the per-sink diff (unhints first, the per-frame bound, a late
//   sink after its first transaction gets the table in priority order), unhint on removal and on a
//   budget drop, the pins (kept until every sink unhinted), the path rule and the three sabotages.

#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rs13_predict.h"
#include "rs2_codec.h"
#include "rs_hints.h"

namespace {

using namespace grc;
namespace hints = grc::rs::hints;

int g_failures = 0;

void check(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
    ++g_failures;
  }
}

std::string text_of(const std::vector<std::uint8_t> &bytes) {
  return std::string(bytes.begin(), bytes.end());
}

std::string hex64(char c) { return std::string(64, c); }

rs::PayloadPtr body_of(std::size_t n) {
  return std::make_shared<rs::PayloadBytes>(std::vector<std::uint8_t>(n, 7));
}

// The JSON text of a record with no blocks (the record is its u32 length, then the JSON's u32
// length and text, then the blocks descriptor's empty payload area): located by its braces.
std::string json_of(const std::vector<std::uint8_t> &record) {
  const std::string text = text_of(record);
  const std::size_t open = text.find('{');
  const std::size_t close = text.rfind('}');
  return open == std::string::npos ? std::string() : text.substr(open, close - open + 1);
}

rs2::ResourceHint sample_hint() {
  rs2::ResourceHint h;
  h.hash = hex64('a');
  h.format = "RGBA8";
  h.has_source_format = true;
  h.source_format = "DXT5";
  h.width = 3368;
  h.height = 2048;
  h.mipmaps = false;
  h.payload_bytes = 27590721;
  rs2::TextureVariant v;
  v.encoding = rs2::VariantEncoding::Block;
  v.hash = hex64('b');
  v.payload_bytes = 6897729;
  v.has_format = true;
  v.format = "DXT5";
  h.variants.push_back(v);
  h.has_path = true;
  h.path = "res://atlas/a.png";
  h.cause = rs2::HintCause::Warm;
  h.priority = 3;
  return h;
}

void test_codec() {
  const std::vector<std::uint8_t> magic = rs2::magic(rs2::ProtocolVersion::V15);
  check(magic == std::vector<std::uint8_t>({0x47, 0x52, 0x53, 0x46, 0x0D, 0x0A, 0x1A, 0x0A}),
        "the /15 magic is GRSF");
  rs2::Session session;
  session.version = rs2::ProtocolVersion::V15;
  check(text_of(rs2::encode_session(session)).find("\"protocol\":\"render-stream/15\"") !=
            std::string::npos,
        "the /15 session names render-stream/15");

  const std::string hint = json_of(rs2::encode_resource_hint(sample_hint()));
  const std::string want =
      "{\"type\":\"resource_hint\",\"hash\":\"" + hex64('a') +
      "\",\"kind\":\"texture\",\"format\":\"RGBA8\",\"source_format\":\"DXT5\",\"width\":3368,"
      "\"height\":2048,\"mipmaps\":false,\"payload_bytes\":27590721,\"variants\":[{\"encoding\":"
      "\"block\",\"hash\":\"" + hex64('b') +
      "\",\"payload_bytes\":6897729,\"format\":\"DXT5\",\"params\":null}],\"path\":"
      "\"res://atlas/a.png\",\"cause\":\"warm\",\"priority\":3,\"blocks\":[]}";
  check(hint == want, "resource_hint bytes in the spec's key order:\n  " + hint + "\n  " + want);
  rs2::ResourceHint bare = sample_hint();
  bare.has_source_format = false;
  bare.has_path = false;
  bare.variants.clear();
  bare.cause = rs2::HintCause::Create;
  bare.priority = 0;
  const std::string bare_json = json_of(rs2::encode_resource_hint(bare));
  check(bare_json.find("\"source_format\":null") != std::string::npos &&
            bare_json.find("\"variants\":[],\"path\":null,\"cause\":\"create\",\"priority\":0,"
                           "\"blocks\":[]}") != std::string::npos,
        "a hint's null source_format and path, no variants: " + bare_json);
  check(json_of(rs2::encode_resource_unhint(hex64('c'))) ==
            "{\"type\":\"resource_unhint\",\"hash\":\"" + hex64('c') + "\",\"blocks\":[]}",
        "resource_unhint bytes");
  bool causes = true;
  const char *names[] = {"create", "warm", "predicted", "integrator"};
  for (int i = 0; i < 4; ++i) {
    causes = causes && std::string(rs2::to_wire(static_cast<rs2::HintCause>(i))) == names[i];
  }
  check(causes, "the cause enum's spelling order");

  // size_override: /15 only, right after variants and before canvas.
  rs2::TextureEntry t;
  t.id = 1;
  t.has_hash = true;
  t.hash = hex64('d');
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 3368;
  t.height = 2048;
  t.payload_bytes = 100;
  rs2::Transaction tx;
  tx.seq = 1;
  tx.frame = 1;
  tx.textures.push_back(t);
  tx.version = rs2::ProtocolVersion::V14;
  const std::vector<std::uint8_t> v14 = rs2::encode_transaction(tx);
  tx.version = rs2::ProtocolVersion::V15;
  const std::vector<std::uint8_t> v15 = rs2::encode_transaction(tx);
  check(v14 == v15, "a /15 transaction with no size_override is /14's byte for byte");
  {
    rs13::Predictor p14;
    rs13::Predictor p15;
    tx.version = rs2::ProtocolVersion::V14;
    const auto a = rs13::encode_transaction(tx, &p14);
    tx.version = rs2::ProtocolVersion::V15;
    const auto b = rs13::encode_transaction(tx, &p15);
    check(a == b, "the predicted /15 transaction with no size_override is /14's byte for byte");
  }
  tx.textures[0].size_override_w = 3366;
  tx.textures[0].size_override_h = 2048;
  const std::string with = text_of(rs2::encode_transaction(tx));
  check(with.find("\"variants\":[],\"size_override\":[3366,2048],\"canvas\":null") !=
            std::string::npos,
        "size_override sits after variants and before canvas at /15");
  tx.version = rs2::ProtocolVersion::V14;
  check(rs2::encode_transaction(tx) == v14, "below /15 size_override is never written");
}

hints::Source source(char c, std::size_t bytes, std::uint64_t rid = 1) {
  hints::Source s;
  s.hint.hash = hex64(c);
  s.hint.format = "RGBA8";
  s.hint.width = 4;
  s.hint.height = 4;
  s.hint.payload_bytes = bytes;
  s.rid = rid;
  s.body = body_of(bytes);
  return s;
}

std::vector<std::string> hashes(const hints::Diff &d) {
  std::vector<std::string> out;
  for (const hints::Entry *e : d.hinted) {
    out.push_back(e->hint.hash);
  }
  return out;
}

void test_payload_ready_table() {
  hints::Table table;
  table.configure(250);
  // Sources enter only when ready to serve: younger RID 20 completed before older RID 10.
  // The table must not reserve an earlier number for the older, previously unfinished job.
  check(table.add(source('1', 100, 20)) && table.add(source('2', 100, 10)) &&
            table.add(source('3', 100, 30)),
        "three hints added");
  check(!table.add(source('1', 100)), "a hash already in the table is refused");
  check(table.find(hex64('1'))->hint.priority == 0 && table.find(hex64('2'))->hint.priority == 1 &&
            table.find(hex64('3'))->hint.priority == 2,
        "priorities pin payload-ready order: a younger completed job precedes an older unfinished one");
  check(table.walk() == 0, "the first walk drops nothing that was admitted");
  check(table.find(hex64('1'))->admitted && table.find(hex64('2'))->admitted &&
            !table.find(hex64('3'))->admitted && table.admitted_bytes() == 200,
        "the budget admits a priority prefix");
  // A strict prefix: a small entry after a misfit stays out.
  table.add(source('4', 10));
  table.walk();
  check(!table.find(hex64('4'))->admitted, "nothing after the first misfit is admitted");
  // In the state: free, so the next ones fit.
  table.set_in_state([](const std::string &h) { return h == hex64('1'); });
  table.walk();
  check(table.find(hex64('3'))->admitted && table.find(hex64('4'))->admitted &&
            table.admitted_bytes() == 210,
        "an in-state entry costs nothing");

  // A sink: unhints first, then hints in priority order, bounded per frame.
  hints::Sent sink;
  hints::Diff d;
  hints::diff(table, &sink, 10, hints::Sabotage::None, 2, &d);
  check(d.records.size() == 2 && hashes(d) == std::vector<std::string>({hex64('2'), hex64('3')}),
        "at most `max` records a frame, in priority order, none the state names");
  hints::diff(table, &sink, 11, hints::Sabotage::None, 64, &d);
  check(hashes(d) == std::vector<std::string>({hex64('4')}) && d.unhinted.empty(),
        "the rest the next frame");
  hints::diff(table, &sink, 12, hints::Sabotage::None, 64, &d);
  check(d.records.empty(), "nothing new: no records");

  // Leaving the state puts '1' back under the budget: '4' (lowest priority) is dropped.
  table.set_in_state([](const std::string &) { return false; });
  check(table.walk() == 2, "leaving the state drops the tail (3 and 4)");
  hints::diff(table, &sink, 13, hints::Sabotage::None, 64, &d);
  check(d.unhinted == std::vector<std::string>({hex64('3'), hex64('4')}) &&
            hashes(d) == std::vector<std::string>({hex64('1')}),
        "a budget drop is unhinted; an entry that left the state is hinted");
  table.remove(hex64('2'));  // freed: 3 and 4 fit again
  table.walk();
  hints::diff(table, &sink, 14, hints::Sabotage::None, 64, &d);
  check(d.unhinted == std::vector<std::string>({hex64('2')}) &&
            hashes(d) == std::vector<std::string>({hex64('3'), hex64('4')}) &&
            text_of(*d.records[0]).find("resource_unhint") != std::string::npos,
        "unhints first (the freed hash), then the re-admitted hints");
  check(sink.contains(hex64('3')) && !sink.contains(hex64('2')), "the sink tracks what it hinted");

  // Pins: admitted entries, plus whatever a sink still has hinted.
  hints::Sent lagging;
  lagging.hinted[hex64('2')] = hints::Sent::Hinted{1, false};
  std::map<std::string, rs::PayloadPtr> pins;
  hints::pinned(table, {&sink, &lagging}, &pins);
  check(pins.count(hex64('1')) == 1 && pins.count(hex64('3')) == 1 && pins.count(hex64('2')) == 1,
        "a removed hash stays pinned while a sink has not unhinted it");
  table.collect([&lagging](const std::string &h) { return lagging.contains(h); });
  check(table.held(hex64('2')) != nullptr, "collect keeps a referenced removed entry");
  lagging.hinted.clear();
  table.collect([](const std::string &) { return false; });
  hints::pinned(table, {&sink}, &pins);
  check(table.held(hex64('2')) == nullptr && pins.count(hex64('2')) == 0,
        "collect drops it once no sink references it");

  // A late sink gets the hints in effect, in priority order.
  hints::Sent late;
  hints::diff(table, &late, 14, hints::Sabotage::None, 64, &d);
  bool ordered = d.hinted.size() >= 2;
  for (std::size_t i = 1; i < d.hinted.size(); ++i) {
    ordered = ordered && d.hinted[i - 1]->hint.priority < d.hinted[i]->hint.priority;
  }
  check(ordered && d.unhinted.empty(), "a late sink gets every hint in effect, priority order");

  // Content change: the old hash leaves, the new one may be hinted under its own hash.
  table.remove(hex64('3'));
  table.add(source('5', 50));
  table.walk();
  hints::diff(table, &late, 15, hints::Sabotage::None, 64, &d);
  check(!d.unhinted.empty() && d.unhinted[0] == hex64('3'), "a changed texture's hash is unhinted");

  table.clear();
  hints::diff(table, &late, 16, hints::Sabotage::None, 64, &d);
  check(d.hinted.empty() && late.hinted.empty(), "clear() unhints everything");
}

void test_sabotages() {
  hints::Sabotage s = hints::Sabotage::None;
  std::string why;
  check(hints::parse_sabotage(nullptr, &s, &why) && s == hints::Sabotage::None, "unset: none");
  check(hints::parse_sabotage("hint-unknown-hash", &s, &why) && s == hints::Sabotage::UnknownHash &&
            hints::parse_sabotage("hint-early-unhint", &s, &why) &&
            s == hints::Sabotage::EarlyUnhint &&
            hints::parse_sabotage("hint-edited-path", &s, &why) && s == hints::Sabotage::EditedPath,
        "the three sabotage names");
  check(!hints::parse_sabotage("hint-other", &s, &why) && why.find("GRC_HINT_SABOTAGE") == 0,
        "an unknown sabotage refuses");

  {
    hints::Table table;
    table.add(source('1', 10), hints::Sabotage::UnknownHash);
    table.add(source('2', 10), hints::Sabotage::UnknownHash);
    table.walk();
    check(table.size() == 3, "hint-unknown-hash adds one extra entry, once");
    const std::vector<const hints::Entry *> live = table.live();
    check(live[1]->body == nullptr && live[1]->rid == 0 && live[1]->hint.hash != hex64('1') &&
              live[1]->hint.hash.size() == 64,
          "the extra entry has a random hash and no body");
    std::map<std::string, rs::PayloadPtr> pins;
    hints::Sent sink;
    hints::Diff d;
    hints::diff(table, &sink, 1, hints::Sabotage::UnknownHash, 64, &d);
    hints::pinned(table, {&sink}, &pins);
    check(d.hinted.size() == 3 && pins.size() == 2, "it is hinted but never pinned");
  }
  {
    hints::Table table;
    table.add(source('1', 10));
    table.walk();
    hints::Sent sink;
    hints::Diff d;
    hints::diff(table, &sink, 5, hints::Sabotage::EarlyUnhint, 64, &d);
    check(d.hinted.size() == 1, "early-unhint: hinted at frame 5");
    hints::diff(table, &sink, 5, hints::Sabotage::EarlyUnhint, 64, &d);
    check(d.records.empty(), "early-unhint: not in the frame it was sent");
    hints::diff(table, &sink, 6, hints::Sabotage::EarlyUnhint, 64, &d);
    check(d.unhinted.size() == 1 && d.hinted.empty() && table.find(hex64('1')) != nullptr,
          "early-unhint: unhinted the next frame while the entry stays");
    hints::diff(table, &sink, 7, hints::Sabotage::EarlyUnhint, 64, &d);
    check(d.records.empty(), "early-unhint: never hinted again");
  }
}

void test_path_rule() {
  check(hints::keep_path(false, hints::Sabotage::None), "a pristine texture's path is sent");
  check(!hints::keep_path(true, hints::Sabotage::None), "an edited texture's path is not");
  check(hints::keep_path(true, hints::Sabotage::EditedPath), "hint-edited-path sends it anyway");
}

void test_at_rest_bytes() {
  hints::Entry e;
  e.body = body_of(100);
  e.variant_bodies.emplace_back(hex64('v'), body_of(30));
  check(hints::at_rest_bytes(e, nullptr) == 130, "body plus variants");
  check(hints::at_rest_bytes(e, [](const rs::PayloadPtr &) -> std::uint64_t { return 5; }) == 140,
        "plus each body's sibling once made");
}

}  // namespace

int main() {
  test_codec();
  test_payload_ready_table();
  test_sabotages();
  test_path_rule();
  test_at_rest_bytes();
  if (g_failures == 0) {
    std::printf("rs15: all checks passed\n");
  }
  return g_failures == 0 ? 0 : 1;
}
