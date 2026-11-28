#!/usr/bin/env python3
"""Prepare an isolated profiling library; summarize its rendered resources-probe traces.

prepare OUT emits copied sources and a CMake wrapper. Configure OUT/build and build only
render_stream_capture under quiet.sh shared. Pass OUT/build/render_stream_capture.gdextension
as probe-capture-attach.sh --resources --extension. The production sources stay untouched.
Run at least three fresh probes, recording load/GPU utilization alongside each run, then
report RUN... to summarize each resident arm. This diagnostic includes tracing overhead;
use its results as upper bounds under the recorded load, never as an idle timing budget.
census RUN... reads uninstrumented census/staging counters and API-call timings for three arms.
materials RUN... reads arm_ns and the exclusive phase counters from ordinary resource results.
The in-flight/default-texture times are subsets of the texture phases, not additional phases.
frames RUN... reports the worst three attached callbacks with inclusive phase timings and
the callback time outside those phases. In particular, hello-wait is fixture synchronization,
not adoption work. Frame numbers are capture callback numbers, not the fixture's process ticks.
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
parser.add_argument("mode", choices=("prepare", "report", "frames", "materials", "census"))
parser.add_argument("paths", nargs="+", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
cap = root / "experiments/render-stream/capture"
if args.mode == "census":
    # Ordinary, uninstrumented resource probes. Frame intervals include synchronization;
    # staged_max_frame_ms isolates the census/texture drain from the browser hello wait.
    runs = []
    for path in args.paths:
        resident = path / "resident"
        timing_path = resident / "api-timing.jsonl"
        timings = [json.loads(line) for line in timing_path.read_text().splitlines()] if timing_path.exists() else []
        for index in range(3):
            result = json.loads((resident / f"resource-result-{index}.json").read_text())
            adoption = result["stream"]["gate8"]["adopt_stats"]
            resources = adoption["resources"]
            stage = adoption["staged"]
            frames = json.loads((resident / f"adoption-frames-{index}.json").read_text())["frames"]
            calls = {row["method"]: row["elapsed_us"] / 1000 for row in timings if row["round"] == index}
            census_ns = resources["census_ns"]
            slices = resources.get("census_slices", int(census_ns > 0))
            runs.append(dict(run=str(path.resolve()), arm=index, api_ms=calls,
                             max_arming_interval_ms=max((f["interval_us"] / 1000 for f in frames
                                                        if f["phase"] == "arming"), default=0),
                             staged_max_frame_ms=stage["max_frame_us"] / 1000,
                             census_ms=census_ns / 1e6, census_slices=slices,
                             census_mean_slice_ms=census_ns / slices / 1e6 if slices else 0,
                             arm_to_first_publish_ms=stage["arm_to_first_publish_us"] / 1000))
    print(json.dumps({"label": "resource probe shape; frame intervals include synchronization", "arms": runs}, indent=2))
    raise SystemExit(0)

if args.mode == "materials":
    # Read ordinary result.json counters; no tracing library or profiling overhead is needed.
    # Baselines without phase counters still contribute arm_ns and their existing counts.
    phases = ("tag_node_map", "resolve_pending", "shader_cached", "shader_readback",
              "shader_preprocessed", "material_params", "instance_params", "texture_warm",
              "texture_queued", "texture_other")
    rows = []
    for path in args.paths:
        for index, kind in enumerate(("first-arm", "rearm", "reattach")):
            result = json.loads((path / f"resident/resource-result-{index}.json").read_text())
            stats = result["stream"]["gate8"]["adopt_stats"]["material_adoption"]
            row = dict(run=str(path.resolve()), arm=index, kind=kind, **stats)
            fields = [f"arm_{phase}_ns" for phase in phases]
            if all(field in stats for field in fields):
                total = sum(stats[field] for field in fields)
                assert abs(total - stats["arm_ns"]) <= stats["arm_ns"] * .05, (
                    f"{path}: arm {index} exclusive phase sum differs from arm_ns by over 5%")
                row["phase_sum_ns"] = total
            rows.append(row)
    print(json.dumps({"material_adoption": rows}, indent=2))
    raise SystemExit(0)

if args.mode in ("report", "frames"):
    def union_ns(spans):
        end = 0
        total = 0
        for lo, hi in sorted(spans):
            total += max(0, hi - max(lo, end))
            end = max(end, hi)
        return total

    runs = []
    for path in args.paths:
        if args.mode == "frames":
            rows = [json.loads(line.removeprefix("GRC_HITCH "))
                    for line in (path / "resident/host/stdout.log").read_text().splitlines()
                    if line.startswith("GRC_HITCH ")]
            frames = sorted((r for r in rows if r["kind"] == "callback"),
                            key=lambda r: r["end_ns"] - r["start_ns"], reverse=True)[:3]
            assert len(frames) == 3, f"{path}: expected at least three profiled callbacks"
            for frame in frames:
                children = [r for r in rows if r["kind"] not in ("callback", "first-publication")
                            and frame["start_ns"] <= r["start_ns"]
                            and r["end_ns"] <= frame["end_ns"]]
                spans = {}
                for row in children:
                    spans[row["kind"]] = spans.get(row["kind"], 0) + row["end_ns"] - row["start_ns"]
                total = frame["end_ns"] - frame["start_ns"]
                runs.append(dict(run=str(path.resolve()), frame=frame["frame"],
                                 callback_us=total / 1000,
                                 excluding_hello_us=(total - spans.get("hello-wait", 0)) / 1000,
                                 spans_us={key: value / 1000 for key, value in spans.items()},
                                 outside_spans_us=(total - union_ns(
                                     [(r["start_ns"], r["end_ns"]) for r in children])) / 1000))
            continue
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
    print(json.dumps({"label": "upper bound under recorded load",
                      "frames" if args.mode == "frames" else "arms": runs}, indent=2))
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
inline thread_local uint64_t frame = 0;
inline uint64_t now() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
inline void row(const char *kind, uint64_t start, uint64_t end, uint64_t bytes = 0) {
  std::fprintf(stderr, "GRC_HITCH {\"kind\":\"%s\",\"frame\":%llu,\"start_ns\":%llu,\"end_ns\":%llu,\"bytes\":%llu}\n", kind, (unsigned long long)frame, (unsigned long long)start, (unsigned long long)end, (unsigned long long)bytes);
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
  Frame(uint64_t f) { frame = f; }
  ~Frame() { if (active && published) { row("first-publication", span.start, now()); active = false; } }
};
template<class F> decltype(auto) call(const char *kind, F &&f) {
  Span span(kind);
  return f();
}
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
 ('void on_frame() {', 'void on_frame() {\n  hitch::Frame hitch_frame(g_state.frames_total + 1);'),
 ('void stream_publish(uint64_t frame) {', 'void stream_publish(uint64_t frame) {\n  hitch::Span hitch_publish("publish");'),
 ('    rs::adopt_frame_drain();', '    { hitch::Span span("adopt-drain"); rs::adopt_frame_drain(); }'),
 ('    if (rs::adopt_warm_poll()) {', '    if (hitch::call("warm-poll", [&] { return rs::adopt_warm_poll(); })) {'),
 ('  live_linger(false);', '  hitch::call("linger", [&] { live_linger(false); });'),
 ('  resources_drain();\n  live_drain(frame);', '  hitch::call("resources-drain", [&] { resources_drain(); });\n  hitch::call("live-drain", [&] { live_drain(frame); });'),
 ('    rs::mirror_instance().service_pending();', '    hitch::call("worker-delivery", [&] { rs::mirror_instance().service_pending(); });'),
 ('  hints_frame(frame);', '  hitch::call("hints", [&] { hints_frame(frame); });'),
 ('  rs::Captured snapshot = rs::mirror_snapshot(0, frame);', '  rs::Captured snapshot = hitch::call("snapshot", [&] { return rs::mirror_snapshot(0, frame); });'),
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
