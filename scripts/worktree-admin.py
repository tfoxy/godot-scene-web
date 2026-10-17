#!/usr/bin/env python3
"""Inspect, move, and remove this repository's linked worktrees safely."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


class AdminError(Exception):
    pass


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True
    )
    if check and result.returncode:
        raise AdminError(result.stderr.strip() or result.stdout.strip())
    return result


@dataclass
class Worktree:
    path: Path
    head: str = ""
    branch: str = ""
    locked: bool = False
    prunable: bool = False


def worktrees(root: Path) -> list[Worktree]:
    result = []
    current = None
    for line in [*git(root, "worktree", "list", "--porcelain").stdout.splitlines(), ""]:
        if not line:
            if current is not None:
                result.append(current)
                current = None
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = Worktree(Path(value).absolute())
        elif current is not None:
            if key == "HEAD":
                current.head = value
            elif key == "branch":
                current.branch = value.removeprefix("refs/heads/")
            elif key == "locked":
                current.locked = True
            elif key == "prunable":
                current.prunable = True
    return result


def active_processes(path: Path) -> list[int]:
    """Find local processes whose cwd, executable, or arguments use a checkout."""
    own = set()
    pid = os.getpid()
    while pid > 1 and pid not in own:
        own.add(pid)
        try:
            pid = int(Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            break
    prefix = os.fsencode(str(path)) + b"/"
    found = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) in own:
            continue
        try:
            links = [os.fsencode(os.readlink(proc / key)) for key in ("cwd", "exe")]
            args = (proc / "cmdline").read_bytes().split(b"\0")
        except (OSError, PermissionError):
            continue
        # adb's long-lived fork server can inherit a worktree cwd for days. It opens no worktree
        # files and uses no worktree arguments; moving that checkout does not interrupt the server.
        if (Path(os.fsdecode(links[1])).name == "adb" and b"fork-server" in args
            and b"server" in args and not any(prefix in item for item in args)):
            try:
                held = any(prefix in os.fsencode(os.readlink(fd)) for fd in (proc / "fd").iterdir())
            except (OSError, PermissionError):
                held = True
            if not held:
                continue
        if any(item == os.fsencode(str(path)) or item.startswith(prefix) for item in links) or any(
            prefix in item or item == os.fsencode(str(path)) for item in args
        ):
            found.append(int(proc.name))
    return sorted(found)


def state(root: Path, wt: Worktree) -> list[str]:
    reasons = []
    if wt.path == root:
        reasons.append("main checkout")
    elif not (wt.path.is_relative_to(root) or wt.path.parent == root.parent):
        reasons.append("owned by another snapshot workflow")
    if wt.locked:
        reasons.append("locked")
    if wt.prunable or not wt.path.is_dir():
        reasons.append("missing/prunable")
        return reasons
    if git(wt.path, "status", "--porcelain", "--untracked-files=all").stdout:
        reasons.append("dirty")
    pids = active_processes(wt.path)
    if pids:
        reasons.append("active PID " + ",".join(map(str, pids[:8])))
    return reasons


def registered(root: Path, path: str) -> Worktree:
    candidate = Path(os.path.abspath(path))
    for wt in worktrees(root):
        if wt.path == candidate:
            return wt
    raise AdminError(f"not a registered worktree: {candidate}")


def ensure_links(root: Path) -> None:
    base = root / ".worktrees"
    if base.is_symlink() or (base.exists() and not base.is_dir()):
        raise AdminError(f"expected a real directory: {base}")
    dependencies = ("godot-4.5.1-stable", "godot-docs-4.5", "spirectl", "sts2-couch-coop")
    for name in dependencies:
        source = root.parent / name
        link = base / name
        if not source.is_dir():
            raise AdminError(f"missing sibling: {source}")
        if link.is_symlink() and link.resolve() == source.resolve():
            continue
        if link.exists() or link.is_symlink():
            raise AdminError(f"unexpected link or directory: {link}")
    base.mkdir(exist_ok=True)
    for name in dependencies:
        link = base / name
        if not link.is_symlink():
            link.symlink_to(Path("../..") / name)


def command_inventory(root: Path) -> None:
    for wt in worktrees(root):
        reasons = state(root, wt)
        branch = wt.branch or f"detached@{wt.head[:12]}"
        print(f"{wt.path}\t{branch}\t{', '.join(reasons) or 'clean'}")


def command_migrate(root: Path, args: argparse.Namespace) -> None:
    wt = registered(root, args.path)
    name = args.name or wt.path.name
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) or name in {
        "godot-4.5.1-stable", "godot-docs-4.5", "spirectl", "sts2-couch-coop"
    }:
        raise AdminError(f"invalid destination name: {name}")
    dest = root / ".worktrees" / name
    reasons = [reason for reason in state(root, wt) if reason != "dirty"]
    if dest.exists() or dest.is_symlink():
        reasons.append("destination exists")
    print(f"MOVE {wt.path} -> {dest}: {', '.join(reasons) or 'eligible'}")
    if not args.apply or reasons:
        return
    # Recheck immediately before changing registration; dirty files move with the worktree.
    fresh = registered(root, str(wt.path))
    if [reason for reason in state(root, fresh) if reason != "dirty"]:
        raise AdminError(f"state changed: {fresh.path}")
    ensure_links(root)
    git(root, "worktree", "move", str(wt.path), str(dest))
    print(f"moved {dest}")


def artifact_fingerprint(directory: Path) -> list[tuple[str, int, int]]:
    if not directory.is_dir():
        return []
    return sorted(
        (str(file.relative_to(directory)), file.lstat().st_size, file.lstat().st_mtime_ns)
        for file in directory.rglob("*")
        if file.is_file() or file.is_symlink()
    )


def command_prune(root: Path, args: argparse.Namespace) -> None:
    for path in args.paths:
        wt = registered(root, path)
        reasons = state(root, wt)
        artifact_dir = wt.path / "artifacts"
        original_artifacts = artifact_fingerprint(artifact_dir)
        has_artifacts = bool(original_artifacts)
        if has_artifacts and not args.evidence_reviewed:
            reasons.append("ignored artifacts need review")
        print(f"REMOVE {wt.path}: {', '.join(reasons) or 'eligible'}")
        if not args.apply or reasons:
            continue
        fresh = registered(root, path)
        if state(root, fresh):
            raise AdminError(f"state changed: {fresh.path}")
        if artifact_fingerprint(artifact_dir) != original_artifacts:
            raise AdminError(f"artifacts changed since review: {fresh.path}")
        git(root, "worktree", "remove", "--force", str(fresh.path))
        print(f"removed {fresh.path}; branch retained: {fresh.branch or '(detached)'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inventory")
    migrate = commands.add_parser("migrate")
    migrate.add_argument("path")
    migrate.add_argument("--name")
    migrate.add_argument("--apply", action="store_true")
    prune = commands.add_parser("prune")
    prune.add_argument("paths", nargs="+")
    prune.add_argument("--evidence-reviewed", action="store_true")
    prune.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip()).absolute()
        if git(root, "branch", "--show-current").stdout.strip() != "main":
            raise AdminError("run from the main checkout")
        if Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()) != root / ".git":
            raise AdminError("run from the main checkout")
        if args.command == "inventory":
            command_inventory(root)
        elif args.command == "migrate":
            command_migrate(root, args)
        else:
            command_prune(root, args)
    except AdminError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
