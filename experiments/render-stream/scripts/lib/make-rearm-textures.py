#!/usr/bin/env python3
"""Create deterministic Godot 4.5 CompressedTexture2D inputs without an importer."""

from pathlib import Path
import struct
import sys


def generate(project):
    directory = project / "rearm-textures"
    directory.mkdir()
    for index in range(226):
        # GST2 v1 header, then DATA_FORMAT_IMAGE, dimensions, mipmaps, Image.FORMAT_DXT1.
        header = b"GST2" + struct.pack("<8I", 1, 8, 8, 0, 0, 0, 0, 0)
        image = struct.pack("<IHHII", 0, 8, 8, 0, 17)
        block = struct.pack("<HHI", 31 + index * 32, 31 + index * 32, 0)
        (directory / f"texture-{index:03d}.ctex").write_bytes(header + image + block * 4)


if __name__ == "__main__":
    generate(Path(sys.argv[1]))
