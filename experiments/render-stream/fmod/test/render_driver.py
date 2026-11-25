"""Separate-process install parity; no proprietary input is copied or bundled."""
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys


def main():
    game = os.environ.get("GRC_FMOD_TEST_GAME_DIR")
    reference = os.environ.get("GRC_FMOD_TEST_REFERENCE")
    if not game or not reference:
        print("SKIP render parity: set GRC_FMOD_TEST_GAME_DIR and GRC_FMOD_TEST_REFERENCE")
        return 0
    manifest = json.loads((Path(reference) / "manifest.json").read_text())
    output = Path(sys.argv[2]) / "parity"
    output.mkdir(exist_ok=True)
    keys = output / "keys.txt"
    keys.write_text("".join(t["canonical"] + "\n" for t in manifest["takes"]))
    timing = os.environ.get("GRC_FMOD_TEST_TIMING") == "1"
    if timing and os.getloadavg()[0] > 4:
        raise ValueError("timing refused: host load exceeds 4")
    process = subprocess.run([sys.argv[1], game, str(keys), str(output), str(output / "mix-us.txt")], capture_output=True, text=True)
    print(process.stdout, end="")
    print(process.stderr, end="", file=sys.stderr)
    if process.returncode:
        return process.returncode
    results = []
    for take in manifest["takes"]:
        expected = (Path(reference) / take["file"]).read_bytes()
        actual = (output / (str(take["index"]) + ".pcm")).read_bytes()
        if hashlib.sha256(expected).hexdigest() != take["sha256"]:
            raise ValueError("reference digest mismatch")
        if take["stable"]:
            passed = actual == expected
        else:
            prefix = take["stable_prefix_frames"] * 4
            passed = actual[:prefix] == expected[:prefix] and len(actual) >= prefix and 1 <= len(actual) // 4 <= 480000 and any(actual)
        result = {"index": take["index"], "key": take["canonical"], "passed": passed, "frames": len(actual) // 4}
        if not passed:
            count = min(len(actual), len(expected)) // 2
            a = struct.unpack("<" + "h" * count, actual[:count * 2])
            b = struct.unpack("<" + "h" * count, expected[:count * 2])
            delta = [x - y for x, y in zip(a, b)]
            result.update(first_differing_frame=next((i // 2 for i, d in enumerate(delta) if d), count // 2), max_abs_diff=max(map(abs, delta), default=0), rms_diff=math.sqrt(sum(d * d for d in delta) / max(1, count)))
            print("FAIL parity " + json.dumps(result))
        results.append(result)
    (output / "comparison.json").write_text(json.dumps(results, indent=2) + "\n")
    failed = sum(not r["passed"] for r in results)
    print(f"parity: {len(results) - failed} passed, {failed} failed; stable={sum(t['stable'] for t in manifest['takes'])}")
    if timing:
        times = sorted(map(int, (output / "mix-us.txt").read_text().split()))
        print(f"first mix p50={times[14]} us p95={times[28]} us")
        if times[14] > 1000 or times[28] > 3000:
            return 1
    else:
        (output / "mix-us.txt").unlink()
        print("DEFERRED first-mix timing acceptance (set GRC_FMOD_TEST_TIMING=1 on quiet host)")
    return int(failed != 0)


if __name__ == "__main__":
    sys.exit(main())
