#!/usr/bin/env python3
"""Check that every locked WASM dependency has a bundled licence text."""

import csv
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "licenses" / "manifest.tsv"
result = subprocess.run(
    [
        "cargo",
        "tree",
        "--locked",
        "--manifest-path",
        str(ROOT / "Cargo.toml"),
        "--target",
        "wasm32-unknown-unknown",
        "-e",
        "normal",
        "--prefix",
        "none",
        "--format",
        "{p}",
    ],
    check=True,
    capture_output=True,
    text=True,
)
packages = set()
for line in result.stdout.splitlines():
    name, version, *_ = line.split()
    if name != "godot-scene-web-msdf-generator":
        packages.add((name, version.removeprefix("v")))

with MANIFEST.open(newline="") as file:
    rows = list(csv.DictReader(file, delimiter="\t"))
manifest = {(row["crate"], row["version"]) for row in rows}
errors = []
if len(manifest) != len(rows):
    errors.append("duplicate crate/version rows in licence manifest")
if missing := sorted(packages - manifest):
    errors.append(f"missing licence rows: {missing}")
if extra := sorted(manifest - packages):
    errors.append(f"stale licence rows: {extra}")
for row in rows:
    filename = row["license_filename"]
    if Path(filename).name != filename or not filename.endswith(".txt"):
        errors.append(f"invalid one-level licence filename: {filename}")
    elif not (MANIFEST.parent / filename).is_file():
        errors.append(f"missing licence text: {filename}")
    if not row["chosen_spdx"].strip():
        errors.append(f"missing SPDX choice: {row['crate']} {row['version']}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"licence manifest covers {len(packages)} locked WASM dependency packages")
