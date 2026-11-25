#!/usr/bin/env python3
"""Check worker-produced assets against native Godot playback of self-made tones."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import wave

root, project = map(Path, sys.argv[1:3])
remux_fail = len(sys.argv) > 3 and sys.argv[3] == "1"
messages = [json.loads(line) for line in (root / "audio-messages.jsonl").read_text().splitlines()]
samples = list({m["id"]: m for m in messages if m["type"] == "sample"}.values())
assert len(samples) == 7, len(samples)
with wave.open(str(project / "tone.wav")) as source:
    channels = source.getnchannels()
variants = {m["id"]: list(m["variants"]) for m in samples}
for m in messages:
    if m["type"] == "sample-variant":
        variants[m["id"]].append(m)
passed = 0
for index, sample in enumerate(samples):
    assert sample["rate"] == 22050 and sample["channels"] == channels, sample
    for variant in variants[sample["id"]]:
        asset = root / variant["hash"]
        data = asset.read_bytes()
        assert len(data) == variant["bytes"] and hashlib.sha256(data).hexdigest() == variant["hash"]
        if variant["codec"] == "mp3":
            assert data == (project / "tone.mp3").read_bytes()
        if variant["codec"] == "wav":
            assert data[:4] == b"RIFF" and struct.unpack_from("<I", data, 24)[0] == 22050
            assert struct.unpack_from("<H", data, 22)[0] == channels
            assert data[44:] == (root / f"reference-{index}.pcm").read_bytes(), f"native PCM mismatch: sample {index}"
        else:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(asset), "-f", "null", "-"], check=True)
        passed += 1
assert samples[-1]["loop"]["begin"] == (5513 if remux_fail else .25) and not samples[-1]["store"], samples[-1]
first_start = next(i for i, m in enumerate(messages) if m["type"] == "start")
assert messages[first_start]["bus"] == 1
assert any(m["type"] == "sample" and m["id"] == messages[first_start]["sample"] and not m["store"]
           for m in messages[:first_start]), "private bus class must be published before start"
starts = [m["voice"] for m in messages if m["type"] == "start"]
stops = [m["voice"] for m in messages if m["type"] == "stop"]
assert len(starts) == 7 and sorted(starts) == sorted(stops) and len(set(stops)) == 7
assert json.loads((root / "audio-fixture.json").read_text())["finished"] == 6
print(f"audio-assets: {passed} {channels}-channel variants passed; 7 voices stopped exactly once; 6 natural finished; private bus no-store precedes start; 0 failed/skipped")
