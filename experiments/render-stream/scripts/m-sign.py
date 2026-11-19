#!/usr/bin/env python3
"""Verify strict code signatures on every architecture of each Mach-O output."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def verify(path, codesign):
    result = subprocess.run([codesign, "--verify", "--strict", "--all-architectures", str(path)],
                            capture_output=True, text=True, timeout=60)
    return {"path": str(path), "rc": result.returncode,
            "output": result.stdout + result.stderr}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", metavar="OUT")
    parser.add_argument("--codesign", default=shutil.which("codesign"), metavar="PATH")
    parser.add_argument("macho", nargs="+", metavar="MACHO")
    args = parser.parse_args()
    if not args.codesign:
        print("m-sign: codesign is required (run on macOS)", file=sys.stderr)
        return 2
    try:
        binaries = [verify(path, args.codesign) for path in args.macho]
        for binary in binaries:
            print(f"{'ok  ' if binary['rc'] == 0 else 'FAIL'} {binary['path']}: {binary['output'].strip()}")
        ok = all(binary["rc"] == 0 for binary in binaries)
        print(f"m-sign: {sum(b['rc'] == 0 for b in binaries)}/{len(binaries)} signatures verified")
        if args.json:
            Path(args.json).write_text(json.dumps({"schema": "render-stream-m-sign/1",
                "binaries": binaries, "ok": ok}, indent=2) + "\n", encoding="utf-8")
        return 0 if ok else 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"m-sign: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
