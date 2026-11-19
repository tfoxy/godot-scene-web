#!/usr/bin/env python3
"""Write independent positive and one-byte-changed identities for a signed test bundle."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from calibrate import MachO


def write_identities(binary, arch, prefix):
    image = MachO(str(binary), arch)
    identity = dict(platform=image.platform, pie=image.pie, **image.identity())
    prefix = Path(prefix)
    Path(str(prefix) + ".json").write_text(json.dumps(identity, indent=2) + "\n")
    changed = bytearray.fromhex(identity["sha256"])
    changed[0] ^= 1
    identity["sha256"] = changed.hex()
    Path(str(prefix) + ".bad.json").write_text(json.dumps(identity, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("arch", choices=MachO.CPUS)
    parser.add_argument("prefix", type=Path)
    args = parser.parse_args()
    write_identities(args.binary, args.arch, args.prefix)
