#!/usr/bin/env python3
"""Generate a short self-made tone and transcode it using an installed ffmpeg."""
import math
from pathlib import Path
import struct
import subprocess
import sys
import wave

root = Path(__file__).resolve().parent
channels = 2 if "--stereo" in sys.argv[1:] else 1
with wave.open(str(root / "tone.wav"), "wb") as out:
    out.setparams((channels, 2, 22050, 0, "NONE", "not compressed"))
    out.writeframes(b"".join(struct.pack("<h", round(2000 * math.sin(i * 2 * math.pi * hz / 22050)))
                             for i in range(22050) for hz in (440, 660)[:channels]))
for extension, codec in (("mp3", "libmp3lame"), ("ogg", "libvorbis")):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(root / "tone.wav"),
                    "-c:a", codec, str(root / ("tone." + extension))], check=True)
