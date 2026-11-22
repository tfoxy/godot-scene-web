#!/usr/bin/env python3
"""Prepare an isolated profiling library; summarize its rendered resources-probe traces.

prepare OUT emits copied sources and a CMake wrapper. Configure OUT/build and build only
render_stream_capture under quiet.sh shared. Pass OUT/build/render_stream_capture.gdextension
as probe-capture-attach.sh --resources --extension. The production sources stay untouched.
Run at least three fresh probes, recording load/GPU utilization alongside each run, then
report RUN... to summarize each resident arm. This diagnostic includes tracing overhead;
use its results as upper bounds under the recorded load, never as an idle timing budget.
MB is decimal logical payload: image source data, multimesh floats, mesh buffers, shader UTF-8
and material Variant slots (24 bytes each). Descriptor metadata is excluded from the byte count.
The resources fixture uses inline material values/RIDs; heap payloads reject the measurement.
The total unions arm/callback/materialize wall spans through first publication and subtracts
the explicitly timed browser-hello wait. It includes tracing/descheduling and fixed setup cost;
ms/MB on these small resources is not a bandwidth or large-texture scaling estimate.
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=("prepare", "report"))
parser.add_argument("paths", nargs="+", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
cap = root / "experiments/render-stream/capture"
if args.mode == "report":
    def union_ns(spans):
        end = 0
        total = 0
        for lo, hi in sorted(spans):
            total += max(0, hi - max(lo, end))
            end = max(end, hi)
        return total

    runs = []
    for path in args.paths:
        for name in ("resident-result.json", "resources-result.json"):
            result = json.loads((path / "resident" / name).read_text())
            assert result["status"] == "pass", f"{path}: {name} failed"
        groups = []
        for line in (path / "resident/host/stdout.log").read_text().splitlines():
            if not line.startswith("GRC_HITCH "):
                continue
            row = json.loads(line.removeprefix("GRC_HITCH "))
            if row["kind"] == "arm-start":
                groups.append([])
            groups[-1].append(row)
        assert len(groups) == 3, f"{path}: expected three arms"
        for index, rows in enumerate(groups):
            assert not any(r["kind"] == "unsupported-material-payload" for r in rows), (
                f"{path}: unsupported material payload; extend byte accounting before measuring"
            )
            publication = [r for r in rows if r["kind"] == "first-publication"]
            assert len(publication) == 1, f"{path}: arm {index} did not publish"
            arm = [r for r in rows if r["kind"] == "arm"]
            assert len(arm) == 1
            readbacks = [r for r in rows if r["kind"].startswith("readback-")]
            assert any(r["kind"] == "readback-texture" for r in readbacks)
            parts = {}
            for row in readbacks + [r for r in rows if r["kind"] == "mesh-bytes"]:
                key = row["kind"].removeprefix("readback-")
                parts[key] = parts.get(key, 0) + row["bytes"]
            byte_count = sum(parts.values())
            # Spans nest (materialize can recurse or run inside arm/callback): count their union.
            spans = [(r["start_ns"], r["end_ns"]) for r in rows
                     if r["kind"] in ("arm", "callback", "materialize")]
            wait = sum(r["end_ns"] - r["start_ns"] for r in rows if r["kind"] == "hello-wait")
            total_ms = (union_ns(spans) - wait) / 1e6
            arm_ms = (arm[0]["end_ns"] - arm[0]["start_ns"]) / 1e6
            ready = json.loads((path / f"resident/ready-{index}.json").read_text())
            runs.append(dict(run=str(path.resolve()), arm=index, arm_ms=arm_ms,
                             api_arm_ms=ready["info"]["arm_ms"],
                             first_publish_adoption_ms=total_ms - arm_ms,
                             total_ms=total_ms, readback_bytes=byte_count,
                             readback_MB=byte_count / 1e6, bytes_by_kind=parts,
                             getter_ms=sum(r["end_ns"] - r["start_ns"] for r in readbacks) / 1e6,
                             hello_wait_ms=wait / 1e6,
                             ms_per_MB=total_ms / (byte_count / 1e6)))
    print(json.dumps({"label": "upper bound under recorded load", "arms": runs}, indent=2))
    raise SystemExit(0)

assert len(args.paths) == 1
out = args.paths[0].resolve()
out.mkdir(parents=True)
header = r'''#pragma once
#include <chrono>
#include <cstdio>
#include <thread>
#include <cstdint>
namespace hitch {
inline thread_local bool active = false, published = false;
inline uint64_t now() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
inline void row(const char *kind, uint64_t start, uint64_t end, uint64_t bytes = 0) {
  std::fprintf(stderr, "GRC_HITCH {\"kind\":\"%s\",\"start_ns\":%llu,\"end_ns\":%llu,\"bytes\":%llu}\n", kind, (unsigned long long)start, (unsigned long long)end, (unsigned long long)bytes);
}
struct Span {
  const char *kind;
  uint64_t start;
  bool enabled;
  Span(const char *k) : kind(k), start(now()), enabled(active) {}
  ~Span() { if (enabled) row(kind, start, now()); }
};
struct Frame {
  Span span{"callback"};
  ~Frame() { if (active && published) { row("first-publication", span.start, now()); active = false; } }
};
inline void arm() { active = true; published = false; row("arm-start", now(), now()); }
}
'''
(out/'hitch.h').write_text(header)
def source(name, edits):
    text = '#include "hitch.h"\n' + (cap/'src'/name).read_text()
    for old,new in edits:
        assert text.count(old) == 1, (name,old,text.count(old))
        text = text.replace(old,new)
    (out/name).write_text(text)
source('entry.cpp', [
 ('void arm_now(const char *source) {', 'void arm_now(const char *source) {\n  hitch::arm();\n  hitch::Span hitch_arm("arm");'),
 ('void on_frame() {', 'void on_frame() {\n  hitch::Frame hitch_frame;'),
 ('  live_await_first_hello(frame);  //', '  { hitch::Span hitch_hello("hello-wait"); live_await_first_hello(frame); }  //'),
 ('    g_live.hub->on_frame_shared(frame, monotonic_ns(), shared, publish_epoch, snapshot_ns);',
  '    g_live.hub->on_frame_shared(frame, monotonic_ns(), shared, publish_epoch, snapshot_ns);\n    if (shared) hitch::published = true;'),
])
source('rs_adopt.cpp', [
 ('bool materialize(std::uint64_t rid, RefKind ref) {', 'bool materialize(std::uint64_t rid, RefKind ref) {\n  hitch::Span hitch_materialize("materialize");'),
 ('  g_iface.object_method_bind_ptrcall(g_bind[id], instance, args, ret);', r'''  const bool measured = hitch::active &&
      (id == kRsTexture2dGet || id == kRsMultimeshGetBuffer || id == kRsMeshGetSurface || id == kRsShaderGetCode || id == kRsMaterialGetParam);
  const auto start = hitch::now();
  g_iface.object_method_bind_ptrcall(g_bind[id], instance, args, ret);
  const auto end = hitch::now();
  if (measured) {
    int64_t bytes = 0;
    if (id == kRsTexture2dGet) {
      void *image = g_iface.ref_get_object(ret);
      if (image) g_iface.object_method_bind_ptrcall(method_bind("Image", "get_data_size", 3905245786LL), image, nullptr, &bytes);
    } else if (id == kRsShaderGetCode) {
      bytes = g_iface.string_to_utf8_chars(ret, nullptr, 0);
    } else if (id == kRsMaterialGetParam) {
      const auto type = g_iface.variant_get_type(ret);
      // The resources fixture uses inline values and RID references, with no heap payload.
      if (type == GDEXTENSION_VARIANT_TYPE_STRING || type == GDEXTENSION_VARIANT_TYPE_ARRAY ||
          type == GDEXTENSION_VARIANT_TYPE_DICTIONARY || type >= GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)
        hitch::row("unsupported-material-payload", start, end);
      bytes = 24; // Returned Godot Variant slot, not the referenced texture's storage.
    } else if (id == kRsMultimeshGetBuffer) {
      const uint8_t *cow = nullptr;
      std::memcpy(&cow, static_cast<uint8_t *>(ret) + 8, sizeof(cow));
      if (cow) { int64_t count = 0; std::memcpy(&count, cow - 8, 8); bytes = count * 4; }
    }
    hitch::row(id == kRsTexture2dGet ? "readback-texture" : id == kRsMultimeshGetBuffer ? "readback-multimesh" : id == kRsShaderGetCode ? "readback-shader" : id == kRsMaterialGetParam ? "readback-material" : "readback-mesh", start, end, bytes > 0 ? bytes : 0);
  }'''),
 ('    surfaces.push_back(a);', '    surfaces.push_back(a);\n    if (hitch::active) hitch::row("mesh-bytes", hitch::now(), hitch::now(), a.vertex_bytes + a.attribute_bytes + a.skin_bytes + a.index_bytes);'),
])
cmake = f'''cmake_minimum_required(VERSION 3.22)
project(late_attach_hitch LANGUAGES C CXX)
add_subdirectory("{cap}" capture)
get_target_property(sources render_stream_capture SOURCES)
set(profile_sources)
foreach(source IN LISTS sources)
  if(source STREQUAL "src/entry.cpp")
    list(APPEND profile_sources "{out}/entry.cpp")
  elseif(source STREQUAL "src/rs_adopt.cpp")
    list(APPEND profile_sources "{out}/rs_adopt.cpp")
  else()
    list(APPEND profile_sources "{cap}/${{source}}")
  endif()
endforeach()
set_property(TARGET render_stream_capture PROPERTY SOURCES "${{profile_sources}}")
'''
(out/'CMakeLists.txt').write_text(cmake)
print(out)
