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


def check(root):
    result_path = root / "resources-result.json"
    result_path.unlink(missing_ok=True)
    checks = 0

    def require(ok, reason):
        nonlocal checks
        checks += 1
        assert ok, reason

    generations = jsonl(root / "resource-generations.jsonl")
    require([row["generation"] for row in generations] == [1, 2, 3], "three resource generations")
    require(all(row["state"]["attachment_state"] == "detached"
                and row["state"]["table"] == "lean" for row in generations),
            "resources were not created in the lean detached table")
    attached = load(root / "size-attached.json")
    require(attached["round"] == 0 and attached["state"]["attachment_state"] == "attached",
            "logical-size carried texture must be created attached in round zero")
    updates = jsonl(root / "proxy-updates.jsonl")
    require([row["round"] for row in updates] == [0, 1, 2], "proxy did not switch after attach in every round")
    for index in range(3):
        evidence = root / "evidence" if index == 0 else root / "evidence" / f"arm-{index + 1}"
        rows = jsonl(evidence / "resources.jsonl")
        gate = load(root / f"resource-result-{index}.json")["stream"]["gate8"]
        resources = gate["adopt_stats"]["resources"]
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
            # A setter can temporarily point to an unread image. The main-thread resolver must
            # recover it in the same frame, before any state for that proxy is published.
            if row.get("op") == "texture_proxy_update" and row.get("reason") == "proxy-unresolved":
                following = [later for later in rows[at + 1:] if later.get("rid") == row["rid"]]
                next_proxy = next((later for later in following
                                   if later.get("op") == "texture_proxy_update" or later.get("call") == "state"), {})
                require(next_proxy.get("op") == "texture_proxy_update" and next_proxy.get("status") == "ok"
                        and next_proxy.get("frame") == row["frame"],
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
    result = {"status": "pass", "checks": checks, "streams": 3, "cycles": 2}
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        check(Path(sys.argv[1]))
    except (AssertionError, KeyError, OSError, ValueError, StopIteration) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
