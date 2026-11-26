#!/usr/bin/env python3
"""Judge lazy pre-load CanvasTexture resolution and canonical adopted image bytes."""

import hashlib
import json
import struct
import sys
from pathlib import Path


def judge(root, renderer, negative=False, mismatch=False, derived=False, bad_derivation=False):
    checks = []

    def require(ok, name):
        checks.append({"name": name, "passed": bool(ok)})
        if not ok:
            raise AssertionError(name)

    def load(name):
        return json.loads((root / name).read_text())

    require((root / "finished.json").exists() and not (root / "failure.json").exists(), "fixture completed")
    log = (root / "host/stdout.log").read_text()
    require("SCRIPT ERROR" not in log and "Parse Error" not in log, "no script failures")
    require(("Forward+" in log and "Vulkan" in log) if renderer == "forward_plus" else "OpenGL" in log,
            "requested renderer actually used")
    if derived:
        calibration = load("evidence/calibration-check.json")
        require(calibration["calibration_source"] == "derived", "RenderingServer calibration is DERIVED")
        record = load("evidence/derived-calibration.json")
        require("canvas_texture_storage" not in record, "no exact storage record supplied")
    if bad_derivation:
        for name in ["attached.json", "resolved.json", "rearmed.json", "reattached.json", "final.json"]:
            row = load(name)
            require(row["enabled"] and not row["ready"] and row["reason"] == "derive-create-pattern",
                    name + ": bad instruction bytes refused")
            require(row["storage_source"] == "derived" and row["derivation_image_reads"] == 2,
                    name + ": derivation reached slot and instruction copy only")
            require(row["derivation_storage_reads"] == row["owner_reads"] == 0,
                    name + ": no storage or owner reads after failed decode")
            require(row["resolver_selfcheck"] == {"runs": 0, "samples": 0, "passed": False},
                    name + ": no sentinel reads after failed decode")
            if name in ["resolved.json", "rearmed.json", "final.json"]:
                require(row["canvas_textures_unresolved"] == {
                            "canvas-texture-unresolved:derive-create-pattern": 6 if name == "rearmed.json" else 3},
                        name + ": counted derivation refusal per RID per arm")
        for directory in [root / "evidence", root / "evidence/arm-2", root / "evidence/arm-3"]:
            refusals = json.loads((directory / "refusals.json").read_text())
            require(refusals["counts"]["refused_no_image"] == 3,
                    directory.name + ": three no-image refusals after bad derivation")
        return checks
    if derived and not negative:
        for name in ["attached.json", "reattached.json"]:
            row = load(name)
            require(row.get("storage_source") == "derived" and row["derivation_storage_reads"] == 1
                    and row["derivation_image_reads"] > 2, name + ": runtime storage derivation proven")
    if negative or mismatch:
        for name in ["attached.json", "resolved.json", "rearmed.json", "reattached.json", "final.json"]:
            row = load(name)
            if mismatch:
                require(row["enabled"] and not row["ready"] and row["reason"] == "selfcheck-mismatch",
                        name + ": swapped sampling layout disables resolution")
                require(row["resolver_selfcheck"] == {"runs": 0 if name in ["reattached.json", "final.json"] else 1,
                                                      "samples": 0, "passed": False},
                        name + ": mismatch latches across attachments")
                require(row["canvas_textures_resolved"] == 0, name + ": mismatched record resolves nothing")
                if name in ["resolved.json", "rearmed.json", "final.json"]:
                    require(row["canvas_textures_unresolved"] == {
                                "canvas-texture-unresolved:selfcheck-mismatch": 6 if name == "rearmed.json" else 3},
                            name + ": unresolved reason counted once per RID per arm")
            else:
                require(not row["enabled"] and not row["ready"] and row["reason"] == "flag-off",
                        name + ": resolver default-off path")
                require(row["resolver_selfcheck"] == {"runs": 0, "samples": 0, "passed": False},
                        name + ": no self-check while flag off")
                require(row["canvas_textures_resolved"] == row["cache_entries"] == 0
                        and row["resolve_total_us"] == row["resolve_max_us"] == 0
                        and row["arm_resolve_total_us"] == row["arm_resolve_max_us"] == 0,
                        name + ": no resolver reads while flag off")
                require(row["derivation_image_reads"] == row["derivation_storage_reads"] == row["owner_reads"] == 0,
                        name + ": feature-off performs zero memory reads")
        for directory in [root / "evidence", root / "evidence/arm-2", root / "evidence/arm-3"]:
            refusals = json.loads((directory / "refusals.json").read_text())
            require(refusals["counts"]["refused_no_image"] == 3,
                    directory.name + ": three pre-load no-image refusals without resolver")
        return checks
    if renderer == "gl_compatibility":
        for name in ["attached.json", "reattached.json"]:
            row = load(name)
            require(row["ready"] and row["resolver_selfcheck"] == {"runs": 1, "samples": 2, "passed": True},
                    name + ": GLES3 owner-layout sentinel check passes")
            require(row["cache_entries"] == row["canvas_textures_resolved"] == 0,
                    name + ": no eager resolution")
        for name in ["resolved.json", "rearmed.json", "final.json"]:
            row = load(name)
            count = 6 if name == "rearmed.json" else 3
            require(row["canvas_textures_resolved"] == 0 and row["cache_entries"] == 3,
                    name + ": untyped GLES3 resolves nothing")
            require(row["canvas_textures_unresolved"] == {"canvas-texture-unresolved:gles-untyped": count},
                    name + ": counted GLES3 type refusal per RID per arm")
            attached = load("reattached.json" if name == "final.json" else "attached.json")
            require(row["owner_reads"] == attached["owner_reads"] + 2 * count
                    and row["channel_type_checks"] == 0,
                    name + ": refusal reads backend only, never channel owner or type")
            require(row["resolver_selfcheck"] == {"runs": 1, "samples": 2, "passed": True},
                    name + ": type refusal preserves owner self-check")
        source = load("source.json")
        for arm, directory in enumerate([root / "evidence", root / "evidence/arm-2", root / "evidence/arm-3"], 1):
            refusals = json.loads((directory / "refusals.json").read_text())
            require(refusals["counts"]["refused_no_image"] == 3,
                    directory.name + ": three no-image refusals for untyped GLES3")
            stage = load("arm-" + str(arm) + "-result.json")["stream"]["gate8"]["adopt_stats"]["staged"]
            require(stage["readback_bytes"] == 0, directory.name + ": zero channel image readback bytes")
            rows = [json.loads(line) for line in (directory / "resources.jsonl").read_text().splitlines()]
            rids = set(source["canvases"] + [image["rid"] for image in source["sources"]])
            # The fixture's deliberate setter mutation can emit a dummy image through the
            # existing general hook path. It does not read the refused channel's pixels.
            require(not any(row.get("rid") in rids and
                            (row.get("op") == "canvas_texture_create" or
                             (row.get("op") == "adopt" and row.get("adopt_source") != "dummy"))
                            for row in rows), directory.name + ": no wrapper adoption or channel image read")
        return checks
    for name in ["attached.json", "reattached.json"]:
        row = load(name)
        require(row["ready"] and row["resolver_selfcheck"] == {"runs": 1, "samples": 2, "passed": True},
                name + ": non-vacuous sentinel check")
        require(row["cache_entries"] == row["canvas_textures_resolved"] == 0,
                name + ": no eager resolution, fresh attachment cache")
    for name in ["resolved.json", "rearmed.json", "final.json"]:
        row = load(name)
        require(row["canvas_textures_resolved"] >= (6 if name == "rearmed.json" else 3)
                and row["cache_entries"] == 3, name + ": three pre-load RIDs resolved per arm")
        require(row["canvas_textures_unresolved"] == {}, name + ": no unresolved RIDs")
        require(row["channel_type_checks"] >= row["canvas_textures_resolved"],
                name + ": RD type checked before resolved channels enter readback")
        require(row["resolver_selfcheck"]["runs"] == 1 and row["resolver_selfcheck"]["passed"],
                name + ": self-check remains once per attach")
        require(row["resolve_total_us"] >= row["resolve_max_us"] > 0, name + ": wall microseconds recorded")
        require(row["arm_resolve_total_us"] >= row["arm_resolve_max_us"] > 0
                and row["resolve_total_us"] >= row["arm_resolve_total_us"]
                and row["resolve_max_us"] >= row["arm_resolve_max_us"], name + ": per-arm wall microseconds recorded")
    require(load("rearmed.json")["canvas_textures_resolved"] > load("resolved.json")["canvas_textures_resolved"],
            "rearm refreshes attachment bindings")
    source = load("source.json")
    mutation = load("pending-mutation.json")
    require(mutation["canvas"] == source["canvases"][1]
            and mutation["diffuse"] == source["sources"][0]["rid"]
            and mutation["filter"] == source["rearm_filter"], "pending mutation changes diffuse and filter")
    for arm, directory in enumerate([root / "evidence", root / "evidence/arm-2", root / "evidence/arm-3"], 1):
        refusals = json.loads((directory / "refusals.json").read_text())
        stage = load("arm-" + str(arm) + "-result.json")["stream"]["gate8"]["adopt_stats"]["staged"]
        require(stage["budget_us"] == 1 and stage["queue_at_arm"] >= 2,
                directory.name + ": unknown CanvasTextures enter staged adoption")
        require(stage["queued"] >= stage["queue_at_arm"] + 4 and stage["frames_to_drain"] >= 4,
                directory.name + ": channel dependencies queue and retry across frames")
        require(stage["pending"] == 0 and stage["arm_to_first_publish_us"] > 0,
                directory.name + ": pending channels finish before first publication")
        require(stage["readback_bytes"] == 2 * 8 * 8 * 4,
                directory.name + ": diffuse readbacks stay in the staged drain")
        require("no-image" not in json.dumps(refusals), directory.name + ": zero no-image refusals")
        rows = [json.loads(line) for line in (directory / "resources.jsonl").read_text().splitlines()]
        if arm == 1:
            created = next(row for row in rows if row.get("rid") == mutation["canvas"]
                           and row.get("op") == "canvas_texture_create")
            require(mutation["fixture_frame"] == 23 and mutation["capture_frame_upper"] < created["frame"],
                    "mutation precedes pending wrapper adoption")
        for index, canvas in enumerate(source["canvases"]):
            target = source["sources"][0 if index == 1 else 1 if arm >= 2 and index == 0 else index % 2]["rid"]
            created_index = next(i for i, row in enumerate(rows) if row.get("rid") == canvas
                                 and row.get("op") == "canvas_texture_create")
            adopted_rows = rows[created_index + 1:]
            binding = next((row for row in adopted_rows if row.get("rid") == canvas
                            and row.get("op") == "canvas_texture_set_channel"
                            and row.get("value") == 0 and row.get("target") == target), {})
            require(bool(binding), directory.name + ": diffuse binding " + str(index))
            expected_filter = source["rearm_filter"] if index == 1 or (arm >= 2 and index == 0) else source["initial_filter"]
            require(any(row.get("rid") == canvas and row.get("op") == "canvas_texture_set_texture_filter"
                        and row.get("value") == expected_filter for row in adopted_rows),
                    directory.name + ": current texture filter " + str(index))
            if arm == 1:
                require(binding["frame"] >= 44 if index == 2 else binding["frame"] < 44,
                        "first reference adopts at arm redraw or later draw: " + str(index))
        for image in source["sources"]:
            adopted = next((row for row in rows if row.get("rid") == image["rid"]
                            and row.get("op") == "adopt" and row.get("status") == "ok"), {})
            require(bool(adopted.get("hash")), directory.name + ": diffuse adopted")
            store = root / ("store" if arm == 1 else "store.arm-" + str(arm))
            payload = (store / "sha256" / (adopted["hash"] + ".grt")).read_bytes()
            require(hashlib.sha256(payload).hexdigest() == adopted["hash"], "adopted payload content address")
            require(payload[:8] == b"GRT1\r\n\x1a\n", "canonical image payload")
            length = struct.unpack_from("<I", payload, 8)[0]
            meta = json.loads(payload[12:12 + length])
            pixels = payload[16 + length:]
            require(meta["width"] == meta["height"] == 8 and meta["format"] == "RGBA8", "source image dimensions/format")
            require(hashlib.sha256(pixels).hexdigest() == image["pixel_sha256"]
                    and pixels == bytes.fromhex(image["hex"]), "adopted diffuse equals source pixels")
        snapshot = load(["resolved.json", "rearmed.json", "final.json"][arm - 1])
        previous = load("resolved.json")["canvas_textures_resolved"] if arm == 2 else 0
        retries = snapshot["canvas_textures_resolved"] - previous - len(source["canvases"])
        require(retries >= (2 if arm == 1 else 3), directory.name + ": successful retry rereads counted")
    return checks


if __name__ == "__main__":
    root = Path(sys.argv[1])
    try:
        checks = judge(root, sys.argv[2], "--negative-control" in sys.argv[3:],
                       "--selfcheck-mismatch" in sys.argv[3:], "--derived" in sys.argv[3:],
                       "--bad-derivation" in sys.argv[3:])
    except (AssertionError, KeyError, OSError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
    report = {"passed": len(checks), "failed": 0, "skipped": 0, "checks": checks}
    (root / "checks.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"{len(checks)} passed, 0 failed, 0 skipped; {root / 'checks.json'}")
