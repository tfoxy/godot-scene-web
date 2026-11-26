#!/usr/bin/env python3
"""Check payloads and dependency ordering in the rendered resident resource probe."""

import json
from pathlib import Path
import sys

from PIL import Image


def load(path):
    return json.loads(path.read_text())


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def check(root, baseline=False):
    result_path = root / "resources-result.json"
    result_path.unlink(missing_ok=True)
    checks = 0
    skipped_checks = 0
    adoption_reports = []
    arms = []
    cached_rids = jsonl(root / "cached-textures.jsonl")[0]["rids"]
    first_references = jsonl(root / "post-publish.jsonl")
    previous_decoded = set()

    def require(ok, reason):
        nonlocal checks
        checks += 1
        assert ok, reason

    require(len(cached_rids) == len(set(cached_rids)) == 226, "expected distinct cached textures")
    generations = jsonl(root / "resource-generations.jsonl")
    require([row["generation"] for row in generations] == [1], "resources persist across re-arm and detach")
    require(all(row["state"]["attachment_state"] == "detached"
                and row["state"]["table"] == "lean" for row in generations),
            "resources were not created in the lean detached table")
    attached = load(root / "size-attached.json")
    require(attached["round"] == 0 and attached["state"]["attachment_state"] == "attached",
            "logical-size carried texture must be created attached in round zero")
    updates = jsonl(root / "proxy-updates.jsonl")
    require([row["round"] for row in updates] == [0, 1, 2], "proxy did not switch after attach in every round")
    identity = load(root / "0-fingerprint.json")
    facts = load(root / "0-calibration-check.json")
    hooks = load(root / "evidence" / "counters.json")["hooks_planned"]
    if not baseline:
        require(identity["fingerprint_hash_count"] == 1, "identity hashed once at load")
    else:
        skipped_checks += 1
    for index in range(3):
        require(load(root / f"{index}-fingerprint.json") == identity,
                f"round {index} changed process identity or repeated hashing")
        require(load(root / f"{index}-calibration-check.json") == facts,
                f"round {index} changed calibration facts")
        ready = load(root / f"ready-{index}.json")["info"]
        if not baseline:
            require(ready["fingerprint_hash_count"] == 1
                    and ready["fingerprint_ns"] == identity["fingerprint_ns"],
                    f"round {index} arm identity counters disagree")
        else:
            skipped_checks += 1
        evidence = root / "evidence" if index == 0 else root / "evidence" / f"arm-{index + 1}"
        rows = jsonl(evidence / "resources.jsonl")
        gate = load(root / f"resource-result-{index}.json")["stream"]["gate8"]
        if "draw" in hooks:
            require(gate["shader_clock"]["source"] == "draw-hook",
                    f"round {index} planned draw hook must drive the shader clock")
        staged = gate["adopt_stats"].get("staged")
        browser = load(root / f"browser-{index}/applied.json")
        first_publish_frame = browser["transactions"][0]["frame"]
        late = first_references[index]
        require(late["round"] == index and late["frame"] > first_publish_frame,
                f"round {index} late texture was referenced before first publish")
        adopted = next(row for row in rows if row.get("kind") == "image"
                       and row.get("op") == "adopt" and str(row.get("rid")) == str(late["rid"]))
        require(adopted["status"] == "ok" and late["frame"] <= adopted["frame"] <= late["frame"] + 1,
                f"round {index} post-publish getter was held behind staged adoption")
        upload = next(row for row in browser["uploads"] if row["id"] == adopted["id"]
                      and row["op"] == "create")
        fetched = next(row for row in browser["fetches"] if row["hash"] == upload["hash"])
        require(fetched["verified"] and fetched["status"] == 200,
                f"round {index} post-publish payload not delivered")
        verification = load(root / f"browser-{index}/perf.json")["payload_verify"]
        require(verification["unverified_used"] == 0 and verification["still_staged"] == 0,
                f"round {index} receiver used an undelivered payload: {verification}")
        warm = load(evidence / "warm.json")
        decode = gate["decode_stats"]
        # The generated fixture is the only source of compressed images: 226 unique DXT1
        # textures, exactly 42 referenced. Keep this inference explicit in the report.
        require(decode["decoded_bytes"] == decode["decoded"] * 256,
                f"round {index} unexpected compressed population: {decode}")
        require(decode["decoded"] == 42,
                f"round {index} decoded cached-but-unreferenced textures: {decode}")
        require(warm["scanned"]["census_unregistered"] == 0 and warm["from_cache"] == 0,
                f"round {index} eagerly warmed a retained census: {warm}")
        decoded_rids = (cached_rids if decode["decoded"] == 226 else
                        cached_rids[:42] if decode["decoded"] == 42 else
                        [] if decode["decoded"] == 0 else None)
        arms.append({"round": index, "decoded": decode["decoded"],
                     "decoded_bytes": decode["decoded_bytes"],
                     "decoded_mb": decode["decoded_bytes"] / 1000000,
                     "queue_entries": warm["queued"], "warm_hits": warm["served"],
                     "staged_queue_entries": staged["queued"] if staged else None,
                     "staged_queue_at_arm": staged["queue_at_arm"] if staged else None,
                     "warm_from_cache": warm["from_cache"],
                     "dropped_unreferenced": warm["dropped_unreferenced"],
                     "texture_cache_hits": 0, "texture_cache_enabled": False,
                     "decoded_rids_basis": "unique fixture DXT1 population and decode counter",
                     "decoded_rids": decoded_rids,
                     "redecoded_rids": sorted(previous_decoded.intersection(decoded_rids))
                     if decoded_rids is not None else None,
                     "post_publish": {"rid": late["rid"], "first_publish_frame": first_publish_frame,
                                      "reference_frame": late["frame"], "adopt_frame": adopted["frame"],
                                      "fetch_us": fetched["end_us"] - fetched["start_us"],
                                      "unverified_used": verification["unverified_used"]}})
        if decoded_rids is not None:
            previous_decoded.update(decoded_rids)
        if staged is not None:
            require(staged["pending"] == 0 and staged["arm_to_first_publish_us"] > 0,
                    f"round {index} did not finish staged adoption before publication: {staged}")
            require(staged["max_frame_us"] < staged["budget_us"] + staged["max_texture_us"] + 1000,
                    f"round {index} exceeded its budget by more than one texture: {staged}")
        else:
            skipped_checks += 2
        trace_path = root / f"adoption-frames-{index}.json"
        if trace_path.exists():
            trace = load(trace_path)
            if trace["large_texture_bytes"]:
                require(trace["large_texture_bytes"] == 134217728, "expected eight pre-attach 2048² RGBA textures")
            adoption_reports.append({"round": index, "staged": staged, **trace})
        resources = gate["adopt_stats"]["resources"]
        if not baseline:
            require(resources["census_ns"] > 0 if index == 0 else resources["census_ns"] == 0,
                    f"round {index} census must run only on the first arm")
        else:
            skipped_checks += 1
        require(all(value == 0 for key, value in resources.items()
                    if key.startswith("refused_") or key.endswith("_refused")),
                f"round {index} resource refusals: {resources}")
        adoption = gate["particles"]["adoption"]
        require(all(value == 0 for key, value in adoption.items() if "refused" in key),
                f"round {index} particle refusals: {adoption}")
        material = gate["adopt_stats"]["material_adoption"]
        require(all(value == 0 for key, value in material.items() if key.endswith("_refused")),
                f"round {index} material refusals: {material}")
        # ParticleProcessMaterial's generated shader is keyed as a builtin, not canvas GLSL.
        bad = []
        for at, row in enumerate(rows):
            if row.get("status") not in ("unsupported", "refused"):
                continue
            if row.get("kind") == "shader" and row.get("reason") == "shader-mode":
                continue
            # A setter can temporarily point to an unread image. During staged adoption its
            # dependency may land on a later frame, but must resolve before the first snapshot.
            # After publication (and without staging), the same-frame rule still applies.
            if row.get("op") == "texture_proxy_update" and row.get("reason") == "proxy-unresolved":
                following = [later for later in rows[at + 1:] if later.get("rid") == row["rid"]]
                next_proxy = next((later for later in following
                                   if later.get("op") == "texture_proxy_update" or later.get("call") == "state"), {})
                deadline = first_publish_frame if staged and row["frame"] < first_publish_frame else row["frame"]
                require(next_proxy.get("op") == "texture_proxy_update" and next_proxy.get("status") == "ok"
                        and row["frame"] <= next_proxy.get("frame", -1) <= deadline,
                        f"round {index} proxy unresolved at publication")
                continue
            bad.append(row)
        require(not bad, f"round {index} unusable payloads: {bad[:1]}")
        require(adoption["ppm_builtin"] > 0 or gate["particles"]["builtin_resolved"] > 0,
                f"round {index} particle shader never keyed")
        require(any(row.get("kind") == "proxy" and row.get("op") == "adopt" and row.get("status") == "ok"
                    for row in rows), f"round {index} proxy identity lost at adoption")
        require(any(row.get("kind") == "proxy" and row.get("op") == "texture_proxy_update"
                    and row.get("status") == "ok" and row.get("version", 0) >= 2 for row in rows),
                f"round {index} proxy never followed the next frame")
        proxy_adopt = next(i for i, row in enumerate(rows)
                           if row.get("kind") == "proxy" and row.get("op") == "adopt" and row.get("status") == "ok")
        proxy_update = next(i for i, row in enumerate(rows)
                            if row.get("kind") == "proxy" and row.get("op") == "texture_proxy_update"
                            and row.get("status") == "ok" and row.get("version", 0) >= 2)
        require(proxy_adopt < proxy_update, f"round {index} proxy updated before adoption")
        require(any(row.get("kind") == "canvas" and row.get("op") == "canvas_texture_set_channel"
                    and row.get("status") == "ok" for row in rows), f"round {index} CanvasTexture")
        require(any(row.get("op") == "shader_set_default_texture_parameter" and row.get("param") == "paint"
                    and row.get("status") == "ok" for row in rows), f"round {index} shader default sampler")
        array_defaults = [row for row in rows if row.get("op") == "shader_set_default_texture_parameter"
                          and row.get("param") == "paints" and row.get("status") == "ok"]
        require(sorted(row["value"] for row in array_defaults) == [0, 1],
                f"round {index} indexed shader defaults missing or cleared index retained")
        require(any(row.get("kind") == "image" and row.get("source_format") == "DXT1"
                    and row.get("status") == "ok" for row in rows),
                f"round {index} compressed texture not adopted")
        for param, kind in (("tint", "color"), ("overlay", "rid")):
            require(any(row.get("op") == "material_set_param" and row.get("param") == param
                        and row.get("type") == kind and row.get("status") == "ok" for row in rows),
                    f"round {index} material parameter {param}")
        multimeshes = [row for row in rows if row.get("call") == "state" and row.get("kind") == "multimesh"]
        require(any(row["instances"] == 3 and row["visible"] == 2 and row["format"] == "2d"
                    and row["colors"] and row["custom"] and row["status"] == "ok"
                    and row["buffer_sha256"] for row in multimeshes), f"round {index} multimesh descriptor/buffer")
        require(any(row["instances"] == 4 and row["status"] == "ok" for row in multimeshes),
                f"round {index} CPUParticles2D multimesh")
        states = [row for row in rows if row.get("call") == "state" and row.get("kind") == "particles"]
        for seed in (123, 456, 789, 890):
            matching = [row for row in states if row["seed"] == seed]
            require(bool(matching), f"round {index} particle seed {seed} missing")
            require(all(row["status"] == "ok" for row in matching), f"round {index} particle seed {seed} unusable")
            first = matching[0]
            if seed in (456, 890):
                require(not first["emitting"] and first["restarts"] == 1,
                        f"round {index} stopped emitter {seed} restarted")
            else:
                require(first["emitting"] and first["restarts"] >= 2,
                        f"round {index} live emitter {seed} missing restart barrier")
            if seed == 789:
                require(first["subemitter"] is not None, f"round {index} subemitter missing at first publish")
                restart = next((i for i, row in enumerate(rows) if row.get("call") == "particles_restart"
                                and row.get("rid") == first["rid"] and row.get("accepted")), None)
                link = next((i for i, row in enumerate(rows) if row.get("call") == "particles_adopt_subemitter"
                             and row.get("rid") == first["rid"] and row.get("accepted")), None)
                require(link is not None and restart is not None, f"round {index} missing link/restart evidence")
                require(link < restart, f"round {index} parent restarted before subemitter link")
        image = Image.open(root / f"browser-{index}/shots/final.png").convert("RGBA")
        native = Image.open(root / f"native-{index}.png").convert("RGBA")
        first_image = Image.open(root / f"browser-{index}/shots/seq-1.png").convert("RGBA")
        require(first_image.getpixel((280, 320)) == first_image.getpixel((270, 320))
                and image.getpixel((280, 320)) != image.getpixel((270, 320)),
                f"round {index} post-publish texture did not appear after the first snapshot")
        require(image.tobytes() == native.tobytes(), f"round {index} native/browser differ")
        for point, color in [((428, 48), (255, 0, 0, 255)), ((468, 48), (255, 0, 0, 255)),
                             ((320, 40), (255, 255, 0, 255)), ((320, 80), (255, 0, 255, 255)),
                             ((300, 130), (0, 255, 0, 255)), ((320, 130), (0, 255, 0, 255)),
                             ((380, 40), (0, 0, 255, 255)), ((380, 80), (0, 255, 0, 255)),
                             ((320, 180), (0, 255, 255, 255)), ((380, 180), (0, 255, 0, 255)), ((320, 230), (255, 0, 0, 255))]:
            require(image.getpixel(point) == color, f"round {index} missing drawn resource at {point}")
        require(image.getpixel((340, 130)) == image.getpixel((380, 130)),
                f"round {index} hidden multimesh instance drawn")
        require(image.getpixel((360, 230)) == image.getpixel((380, 230)),
                f"round {index} completed one-shot revived")
    result = {"status": "pass", "checks": checks, "skipped": skipped_checks, "streams": 3, "cycles": 1, "rearms": 1}
    (root / "rearm-report.json").write_text(json.dumps(arms, indent=2) + "\n")
    (root / "adoption-report.json").write_text(json.dumps(adoption_reports, indent=2) + "\n")
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        check(Path(sys.argv[1]), "--baseline" in sys.argv[2:])
    except (AssertionError, KeyError, OSError, ValueError, StopIteration) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
