#!/usr/bin/env python3
"""Summarize allocator and mapping evidence without equating RSS to live capture bytes."""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def mappings(path):
    groups = {}
    current = None
    for line in path.read_text().splitlines():
        header = re.match(r"^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+\S+\s*(.*)$", line)
        if header:
            name = header[1]
            current = ("main_heap" if name == "[heap]" else
                       "driver" if any(s in name.lower() for s in ("nvidia", "/dri/", "drm", "/dev/zero")) else
                       "anonymous" if not name or name.startswith("[anon") else "file_or_special")
            groups.setdefault(current, {"rss_bytes": 0, "anonymous_bytes": 0})
        elif current:
            for key, field in (("Rss:", "rss_bytes"), ("Anonymous:", "anonymous_bytes")):
                if line.startswith(key):
                    groups[current][field] += int(line.split()[1]) * 1024
    return groups


def snapshot(evidence, phase):
    prefix = evidence / ("memory-" + phase)
    row = json.loads(prefix.with_suffix(".json").read_text())
    if row.get("memory_dump_ok") is False:
        raise ValueError(f"incomplete native memory dump: {prefix}")
    row["mappings"] = mappings(prefix.with_suffix(".smaps"))
    heaps = ET.parse(prefix.with_suffix(".malloc.xml")).getroot().findall("heap")
    row["arenas"] = []
    for heap in heaps:
        system = int(heap.find("system[@type='current']").get("size"))
        free = sum(int(node.get("size")) for node in heap.findall("total")
                   if node.get("type") in ("fast", "rest"))
        row["arenas"].append({"index": int(heap.get("nr")), "system_bytes": system,
                              "free_bytes": free, "in_use_bytes": system - free})
    return row


def allocation_trace(path):
    """Attribute only intercepted >=8 MiB malloc/calloc/realloc, never all process bytes.

    The fixture sets each phase immediately before its explicit state snapshot. Events in
    `lean` are after that snapshot, and `detached` events belong to process shutdown.
    """
    if not path.exists():
        return None
    text = path.read_text()
    if "ERROR " in text:
        raise ValueError("allocation trace overflowed")
    events = []
    for block in re.split(r"(?=ALLOC pid=|FREE pid=)", text):
        match = re.match(r"(ALLOC|FREE) pid=(\d+) ptr=(\S+)([^\n]*)", block)
        if not match:
            continue
        phase = re.search(r"phase=(\S+)", match[4])[1]
        event = {"kind": match[1], "pointer": match[3], "phase": phase}
        if match[1] == "ALLOC":
            stack = block.splitlines()[1:]
            caller = next((frame for frame in stack[2:] if "libstdc++" not in frame), "unknown")
            owner = ("driver" if any(name in caller.lower() for name in
                                    ("nvidia", "libgl", "libvulkan", "/dri/")) else
                     "capture" if "librender_stream_capture" in caller else "engine_or_other")
            event.update(bytes=int(re.search(r"bytes=(\d+)", match[4])[1]),
                         owner=owner, stack=stack)
            thread = re.search(r"thread=(.*)", match[4])
            event["thread"] = thread[1] if thread else "unrecorded"
        events.append(event)
    samples = {}
    for phase, allowed in (("lean", {"initial"}), ("armed", {"initial", "lean"}),
                           ("detached", {"initial", "lean", "armed"})):
        live = {}
        for event in events:
            if event["phase"] not in allowed:
                continue
            if event["kind"] == "ALLOC":
                live[event["pointer"]] = event
            else:
                live.pop(event["pointer"], None)
        owners = {}
        for event in live.values():
            owner = owners.setdefault(event["owner"], {"bytes": 0, "allocations": 0,
                                                       "example_stack": event["stack"]})
            owner["bytes"] += event["bytes"]
            owner["allocations"] += 1
        samples[phase] = owners
    workers = [event for event in events if event["kind"] == "ALLOC" and event["thread"].startswith("grc-")]
    return {"threshold_bytes": 8 << 20, "samples": samples,
            "worker_allocations": [{key: event[key] for key in ("pointer", "bytes", "thread", "owner")}
                                   for event in workers],
            "note": "Direct allocator caller owns the allocation; a capture caller further down a driver stack does not transfer ownership."}


def worker_mappings(path, trace):
    if not trace:
        return None
    pointers = [int(event["pointer"], 16) for event in trace["worker_allocations"]]
    regions = []
    current = None
    for line in path.read_text().splitlines():
        header = re.match(r"^([0-9a-f]+)-([0-9a-f]+)\s+\S+\s+\S+\s+\S+\s+\S+\s*(.*)$", line)
        if header:
            start, end = int(header[1], 16), int(header[2], 16)
            current = None
            if not header[3] and any(start <= pointer < end for pointer in pointers):
                current = {"start": header[1], "end": header[2], "rss_bytes": 0}
                regions.append(current)
        elif current is not None and line.startswith("Rss:"):
            current["rss_bytes"] = int(line.split()[1]) * 1024
    return {"regions": regions, "rss_bytes": sum(region["rss_bytes"] for region in regions),
            "note": "Anonymous mappings containing past large capture-worker allocations; maps can also contain other allocations. Not an exact free-page census."}


def arena_delta(lean, detached):
    result = {}
    for name, index in (("main", 0), ("non_main", 1)):
        before = lean["arenas"][:1] if index == 0 else lean["arenas"][1:]
        after = detached["arenas"][:1] if index == 0 else detached["arenas"][1:]
        result[name] = {key: sum(a[key] for a in after) - sum(a[key] for a in before)
                        for key in ("system_bytes", "free_bytes", "in_use_bytes")}
    return result


def report(root):
    runs = {}
    compressed = (root / "compressed.txt").exists() and (root / "compressed.txt").read_text().strip() == "1"
    for trim in (0, 1):
        evidence = root / f"trim-{trim}" / "evidence"
        if not evidence.exists():
            continue
        samples = {p: snapshot(evidence, p) for p in ("lean", "armed", "detached")}
        lean, detached = samples["lean"], samples["detached"]
        if "detach_release_count" in detached:
            if lean["detach_release_count"] != 0 or detached["detach_release_count"] != 1:
                raise ValueError("expected no trim at initial lean load and exactly one final-detach release")
        at_rest = json.loads((evidence / "at-rest.json").read_text())
        if at_rest["in_bytes"] < 201326592:
            raise ValueError("fixture did not adopt the full 192 MiB texture payload")
        for key in ("adopt_held", "resource_log_held", "warm_cache_bytes", "served_bytes", "mesh_buffers"):
            if detached[key] != 0:
                raise ValueError(f"capture still holds {key}={detached[key]} after detach")
        delta = {key: detached[key] - lean[key] for key in ("rss_bytes", "rss_anon_bytes", "rss_file_bytes", "rss_shmem_bytes")}
        delta["malloc_in_use_bytes"] = detached["malloc"]["uordblks"] - lean["malloc"]["uordblks"]
        delta["malloc_mmap_bytes"] = detached["malloc"]["hblkhd"] - lean["malloc"]["hblkhd"]
        delta["allocator_free_bytes"] = detached["malloc"]["fordblks"] - lean["malloc"]["fordblks"]
        held = {k: detached[k] for k in ("adopt_held", "resource_log_held", "warm_cache_bytes", "served_bytes", "mesh_buffers")}
        held["mirror_bytes"] = detached["mirror"]["held_bytes"]
        held["registry_bytes_estimate"] = detached["registry"]["bytes_estimate"]
        held["hold_bytes"] = detached["hold_bytes"]
        trace = allocation_trace(root / f"trim-{trim}" / "alloc-trace.log")
        mapping_delta = {group: {key: value - lean["mappings"].get(group, {}).get(key, 0)
                                 for key, value in values.items()}
                         for group, values in detached["mappings"].items()}
        driver_delta = (trace["samples"]["detached"].get("driver", {}).get("bytes", 0) -
                        trace["samples"]["lean"].get("driver", {}).get("bytes", 0)) if trace else None
        resources = [json.loads(line) for line in (evidence / "resources.jsonl").read_text().splitlines()]
        adopted = [row for row in resources if row.get("op") == "adopt" and row.get("status") == "ok"]
        timing = {key + "_total_ms": sum(max(0, row.get(key) or 0) for row in adopted) / 1e6
                  for key in ("decode_ns", "copy_ns", "hash_ns")}
        timing["arm_to_armed_ms"] = json.loads((evidence / "arm-timing.json").read_text())["arm_to_armed_us"] / 1000 if (evidence / "arm-timing.json").exists() else None
        timing["code_at_rest_ms"] = at_rest["code_ns"] / 1e6
        timing["detach_release_ms"] = detached["detach_release_us"] / 1000 if "detach_release_us" in detached else None
        if compressed and timing["decode_ns_total_ms"] <= 0:
            raise ValueError("compressed fixture did not exercise engine decode")
        runs[str(trim)] = {"timing": timing, "samples": samples, "allocation_trace": trace,
                          "arena_delta": arena_delta(lean, detached),
                          "capture_worker_mappings_after_detach": worker_mappings(evidence / "memory-detached.smaps", trace),
                          "mapping_delta": mapping_delta,
                          "attribution": {"driver_owned_malloc_delta_bytes": driver_delta,
                                          "other_malloc_in_use_delta_bytes": delta["malloc_in_use_bytes"] - driver_delta if trace else None,
                                          "rss_delta_minus_malloc_system_delta_bytes": delta["rss_bytes"] - delta["malloc_in_use_bytes"] - delta["allocator_free_bytes"] - delta["malloc_mmap_bytes"],
                                          "stop_condition_driver_majority": driver_delta > 0 and delta["rss_bytes"] > 0 and driver_delta > delta["rss_bytes"] / 2 if trace else None}, "at_rest": at_rest, "post_detach_delta": delta,
                          "split": {"live_capture": held,
                                    "allocator_slack": {"free_bytes": detached["malloc"]["fordblks"],
                                                        "free_delta_bytes": delta["allocator_free_bytes"],
                                                        "main_arena_free_bytes": detached["arenas"][0]["free_bytes"],
                                                        "non_main_arena_free_bytes": sum(a["free_bytes"] for a in detached["arenas"][1:])},
                                    "non_malloc": {"anonymous_resident_lower_bound_bytes": max(0, detached["rss_anon_bytes"] - detached["malloc"]["arena"] - detached["malloc"]["hblkhd"]),
                                                   "mapping_groups": detached["mappings"],
                                                   "file_or_special_rss_delta_bytes": mapping_delta["file_or_special"]["rss_bytes"],
                                                   "driver_mapping_rss_delta_bytes": mapping_delta.get("driver", {}).get("rss_bytes", 0),
                                                   "process_malloc_mmap_delta_bytes": delta["malloc_mmap_bytes"],
                                                   "note": "Anonymous mmap includes malloc arenas and driver allocations; unassigned RSS is not proof of a capture leak."}}}
    if not runs:
        raise ValueError("no memory probe runs found")
    return {"schema": "capture-memory-attribution/1", "renderer": (root / "renderer.txt").read_text().strip() if (root / "renderer.txt").exists() else "gl", "units": {"memory": "bytes", "adopt_held": "entries", "resource_log_held": "entries", "mesh_buffers": "entries"}, "fixture_texture_bytes": 201326592, "fixture_compressed": compressed,
            "fixture_source_bytes": 50331648 if compressed else 201326592,
            "notes": ["mallinfo2 in-use is process-wide, not capture ownership.",
                      "Non-main arenas may belong to engine or capture threads; baseline and armed snapshots preserve the comparison.",
                      "Arena free bytes are virtual allocator slack, not necessarily resident.",
                      "Lean registry bytes are an estimate; shadow vtables, loaded net DSO and codec tables also survive detach.",
                      "Driver-owned malloc is reported separately from non-malloc; driver ownership does not imply an mmap allocation.",
                      "Large-allocation tracing excludes small/aligned allocations and calls bypassing the preload (including deep-bound DSOs). No trace entry is not proof of no allocation.",
                      "Godot loads extensions with RTLD_DEEPBIND on Linux; worker arena ownership is unresolved unless intercepted pointers identify it. Held counters exclude some lean descriptors and container capacity.",
                      "The legacy test trim runs at disarm, before final detach frees; release_recorded skips its second call. Production final-detach release, when present, is independent and recorded in samples.detached.detach_release_count.",
                      "Compressed means the DXT5 source-texture fixture (48 MiB, decoded to 192 MiB), not OS compressed memory. Its delta is detached minus its own lean snapshot."],
            "runs": runs}


if __name__ == "__main__":
    root = Path(sys.argv[1])
    result = report(root)
    (root / "evidence.json").write_text(json.dumps(result, indent=2) + "\n")
    for trim, run in result["runs"].items():
        print(f"trim={trim}: {json.dumps(run['post_detach_delta'])}")
        print(f"attribution: {json.dumps(run['attribution'])}")
