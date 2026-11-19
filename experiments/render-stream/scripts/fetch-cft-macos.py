#!/usr/bin/env python3
"""Fetch macOS Chrome for Testing after checking archive and inner executable pins."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "148.0.7778.96"
# Official CfT archive and inner launcher pins; the archive covers the app framework.
PINS = {
    "arm64": {"platform": "mac-arm64", "zip_sha256": "fbab7ac5c63f72771a7cd79ab15ed6f198b0f9567ec927c9cf5ece3b1f08ffb1",
              "exe_sha256": "2447c7bdea8e8ad38b52594f1ba53e18821c05445e8a07ad1cf3b0f23931d89d"},
    "x86_64": {"platform": "mac-x64", "zip_sha256": "9d896b8c242652fe274b5ff7029853ac4b1471086ecfe48a675552783323108a",
               "exe_sha256": "efd53a32bd47d83a21c040be74714ad3ec6f254e746d439012b096ab33325c9c"},
}


def release(arch):
    pin = PINS[arch]
    name = pin["platform"]
    url = f"https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/{name}/chrome-{name}.zip"
    exe = f"chrome-{name}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    return pin, url, exe


def fetch(out, arch=None):
    arch = arch or platform.machine()
    if arch not in PINS:
        raise ValueError(f"unsupported macOS architecture: {arch}")
    pin, url, inner = release(arch)
    facts = {"arch": arch, "url": url, "version": VERSION, "expected": pin,
             "zip_sha256": "unavailable", "exe_sha256": "unavailable"}
    try:
        if not all(re.fullmatch(r"[a-f0-9]{64}", pin[k]) for k in ("zip_sha256", "exe_sha256")):
            raise ValueError(f"unmeasured macOS CfT digests for {arch}: {url}")
        out.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".cft-", dir=out) as stage:
            archive = Path(stage) / "chrome.zip"
            with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as dest:
                shutil.copyfileobj(response, dest)
            facts["zip_bytes"] = archive.stat().st_size
            with archive.open("rb") as stream:
                facts["zip_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
            with zipfile.ZipFile(archive) as zipped, zipped.open(inner) as stream:
                facts["exe_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
            for kind in ("zip", "exe"):
                if facts[f"{kind}_sha256"] != pin[f"{kind}_sha256"]:
                    raise ValueError(f"{kind}_sha256 mismatch")
            # ditto preserves the app's framework symlinks and executable modes.
            subprocess.run(["/usr/bin/ditto", "-x", "-k", str(archive), str(out)], check=True, timeout=120)
        exe = out / inner
        if hashlib.sha256(exe.read_bytes()).hexdigest() != pin["exe_sha256"]:
            raise ValueError("extracted exe_sha256 mismatch")
        exe.chmod(exe.stat().st_mode | 0o111)
        return exe
    finally:
        print("cft: " + json.dumps(facts, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--arch", choices=tuple(PINS), default=platform.machine())
    args = parser.parse_args()
    try:
        fetch(args.out.resolve(), args.arch)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as exc:
        print(f"fetch-cft-macos: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
