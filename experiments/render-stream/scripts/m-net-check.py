#!/usr/bin/env python3
"""Check the universal net module's identity, exports, system imports and signatures."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


EXPECTED = ["grc_net_module_v1", "grc_net_rtc_v1", "grc_net_tls_v1"]
IDENTITY = "@rpath/librender_stream_net.dylib"


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inspect(path):
    imports = sibling("m-imports")
    binary = imports.inspect(path, "otool")
    if {image["arch"] for image in binary["slices"]} != {"arm64", "x86_64"}:
        raise ValueError("net module must contain exactly arm64 and x86_64 slices")
    for image in binary["slices"]:
        if image["identity"] != IDENTITY:
            raise ValueError(f"{image['arch']}: expected install name {IDENTITY}, got {image['identity']}")
        if image["disallowed"]:
            raise ValueError(f"{image['arch']}: non-system imports: {image['disallowed']}")
        names = subprocess.check_output(["nm", "-arch", image["arch"], "-gUj", str(path)],
                                        text=True, timeout=60).splitlines()
        # Mach-O prefixes C ABI symbols with one underscore.
        exports = sorted(name.removeprefix("_") for name in names if name)
        if exports != EXPECTED:
            raise ValueError(f"{image['arch']}: expected exports {EXPECTED}, got {exports}")
        image["exports"] = exports
    signature = sibling("m-sign").verify(path, "codesign")
    if signature["rc"]:
        raise ValueError(f"invalid net module signature: {signature['output']}")
    binary["signature"] = signature
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", required=True, type=Path)
    parser.add_argument("library", type=Path)
    args = parser.parse_args()
    try:
        binary = inspect(args.library)
        args.json.write_text(json.dumps(binary, indent=2) + "\n", encoding="utf-8")
        print(f"m-net-check: PASS {args.library} (2 slices, exact exports, system imports, signature)")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"m-net-check: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
