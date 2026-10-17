#!/usr/bin/env python3
"""Verify the ignored evidence listed in the committed worktree evidence index."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "docs" / "worktree-evidence-2026-10-17.json"


def verify() -> None:
    groups = json.loads(INDEX.read_text())
    failures = []
    for group in groups:
        digest = hashlib.sha256()
        for entry in group["paths"]:
            relative = Path(entry)
            if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "artifacts":
                failures.append(f"unsafe path: {entry}")
                continue
            path = ROOT / relative
            if not path.is_file():
                failures.append(f"missing: {entry}")
                continue
            with path.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            digest.update(f"{relative.as_posix()}  {checksum}\n".encode())
        actual = digest.hexdigest()
        if actual != group["sha256"]:
            failures.append(f"digest mismatch: {group['label']}")
        else:
            print(f"OK {group['label']} ({len(group['paths'])} files)")
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    verify()
