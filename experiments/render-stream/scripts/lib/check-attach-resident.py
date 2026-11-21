#!/usr/bin/env python3
"""Check resident attachment evidence; --offline samples the host's OS state while detached."""

import errno
import json
from pathlib import Path
import socket
import sys

from PIL import Image


def load(path):
    return json.loads(path.read_text())


def offline(root, index):
    state = load(root / f"detached-{index}.json")
    host, port = state["listen"].rsplit(":", 1)
    with socket.socket() as sock:
        sock.settimeout(1)
        rc = sock.connect_ex((host, int(port)))
    # ECONNREFUSED only: a timeout does not establish that the listener was closed.
    tasks = [p.read_text().strip() for p in Path(f'/proc/{state["pid"]}/task').glob("*/comm")]
    own = [name for name in tasks if name.startswith(("grc-", "rs-ws"))]
    maps = Path(f'/proc/{state["pid"]}/maps').read_text()
    result = {"connect_errno": rc, "capture_threads": own, "task_count": len(tasks),
              "library_mapped": "librender_stream_capture" in maps}
    (root / f"offline-{index}.json").write_text(json.dumps(result, indent=2) + "\n")
    assert rc == errno.ECONNREFUSED, f"detached listener: connect_ex={rc}"
    assert tasks and not own, f"detached capture threads: {own}"
    assert result["library_mapped"], "resident library unmapped"
    print(f"offline round {index}: listener refused, 0 capture threads, library mapped")


def check(root):
    (root / "resident-result.json").unlink(missing_ok=True)
    rows = [json.loads(line) for line in (root / "detached-samples.jsonl").read_text().splitlines()]
    results = []
    checks = 0

    def require(ok, reason):
        nonlocal checks
        checks += 1
        assert ok, reason

    require(not (root / "failure.json").exists(), "fixture failure.json exists")
    require((root / "finished.json").exists(), "host did not finish")
    require((root / "host/exit-code.txt").read_text().strip() == "0", "host failed")
    ready = [load(root / f"ready-{index}.json") for index in range(3)]
    require(len({r["pid"] for r in ready}) == 1, "host process changed")
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    require([r["round"] for r in events if r["event"] == "new-content"] == [0, 1, 2], "new-content events")
    first = None
    for index in range(3):
        state = ready[index]["state"]
        require(state["arm_count"] == index + 1 and state["attachment_state"] == "attached", f"round {index} arm identity")
        require(state["hub_active"] and state["listener_active"] and state["texture_workers_running"]
                and state["capture_threads"] > 0, f"round {index} workers/listener/hub never started")
        report = load(root / f"browser-{index}/applied.json")
        require((root / f"browser-{index}/exit-code.txt").read_text().strip() == "0", f"browser {index} failed")
        require(report["status"] == "ok" and report["failure"] is None, f"browser {index} report: {report['failure']}")
        require(len(report["transactions"]) > 0, f"browser {index} no transactions")
        require(not report["unsupported"], f"browser {index} unsupported: {report['unsupported']}")
        require(load(root / f"streamed-{index}.json")["state"]["hook_calls"] > ready[index]["state"]["hook_calls"],
                f"round {index} hooked calls did not grow while attached (dead counter)")
        require(load(root / f"streamed-{index}.json")["state"]["frame_callbacks"] > ready[index]["state"]["frame_callbacks"],
                f"round {index} frame callback counter not live")
        # The browser's own GPU readback, not a screenshot of an empty page.
        image = Image.open(root / f"browser-{index}/shots/final.png").convert("RGBA")
        require(image.size == (640, 360), f"round {index} browser dimensions {image.size}")
        native = Image.open(root / f"native-{index}.png").convert("RGBA")
        require(native.size == image.size and native.tobytes() == image.tobytes(),
                f"round {index} browser differs from native")
        stable = image.copy()
        stable.paste((0, 0, 0, 0), (400, 100, 464, 164))
        if first is None:
            first = stable
            # Both object interior and clear background must exist in the first frame.
            require(stable.getpixel((80, 80)) != stable.getpixel((0, 0)), "initial stream is blank")
        else:
            require(first.tobytes() == stable.tobytes(),
                    f"round {index} stable scene differs from first stream")
        color = [(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)][index]
        marker = image.crop((400, 100, 464, 164))
        require(all(pixel == color for pixel in marker.getdata()), f"round {index} new content missing")
        samples = [r for r in rows if r["round"] == index]
        require(len(samples) >= 121, f"round {index}: fewer than 120 busy detached frames")
        require(all(b["frame"] == a["frame"] + 1 for a, b in zip(samples, samples[1:])), f"round {index} sample gaps")
        require(all(b["t_us"] > a["t_us"] for a, b in zip(samples, samples[1:])), f"round {index} clock did not advance")
        for key, value in {"attachment_state": "detached", "engine_table": True,
                           "frame_callback_registered": False,
                           "texture_workers_running": False, "hub_active": False,
                           "listener_active": False, "capture_threads": 0, "clients": 0}.items():
            require(all(r["state"].get(key) == value for r in samples), f"round {index} detached {key} != {value}")
        require(all(all(v["entries"] == 0 for v in r["state"]["registry"].values()) for r in samples),
                f"round {index} registry not empty")
        for key in ("hook_calls", "hook_entries", "frame_callbacks"):
            values = [r["state"][key] for r in samples]
            require(max(values) == min(values), f"round {index}: {key} grew while detached")
        offline_state = load(root / f"offline-{index}.json")
        require(offline_state["connect_errno"] == errno.ECONNREFUSED,
                f"round {index} listener probe failed")
        require(offline_state["capture_threads"] == [] and offline_state["library_mapped"], f"round {index} OS state")
        results.append({"round": index, "detached_frames": len(samples) - 1,
                        "hook_calls_per_frame": 0, "frame_callbacks_per_frame": 0,
                        "transactions": len(report["transactions"]), "new_content_rgba": color})
    result = {"status": "pass", "checks": checks, "cycles": 2, "streams": 3, "rounds": results}
    (root / "resident-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "--offline":
            offline(Path(sys.argv[2]), int(sys.argv[3]))
        else:
            check(Path(sys.argv[1]))
    except (AssertionError, KeyError, OSError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
