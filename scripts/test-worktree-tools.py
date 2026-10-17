#!/usr/bin/env python3
"""Isolated fixture checks for the worktree creator and administrator."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent


class WorktreeToolsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        parent = Path(self.temp.name)
        self.root = parent / "godot-scene-web"
        self.root.mkdir()
        for name in ("godot-4.5.1-stable", "godot-docs-4.5", "spirectl", "sts2-couch-coop"):
            (parent / name).mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.root / ".gitignore").write_text(".worktrees/\nartifacts/\n")
        (self.root / "tracked.txt").write_text("base\n")
        installer = self.root / "scripts" / "install-agent-config.sh"
        installer.parent.mkdir()
        installer.write_text("#!/bin/sh\nexit 0\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.bin = parent / "bin"
        self.bin.mkdir()
        mise = self.bin / "mise"
        mise.write_text("#!/bin/sh\nexit 0\n")
        mise.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}")

    def run_cmd(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True)
        if check and result.returncode:
            self.fail(f"{args}: {result.stdout}\n{result.stderr}")
        return result

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True)

    def create(self, name: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return self.run_cmd("bash", str(SCRIPTS / "create-worktree.sh"), name, check=check)

    def admin(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return self.run_cmd("python3", str(SCRIPTS / "worktree-admin.py"), *args, check=check)

    def test_creation_collision_and_rollback(self) -> None:
        self.create("first")
        wt = self.root / ".worktrees" / "first"
        self.assertTrue(wt.is_dir())
        self.assertEqual((wt / "../godot-docs-4.5").resolve(), self.root.parent / "godot-docs-4.5")
        self.assertNotEqual(self.create("first", check=False).returncode, 0)
        self.assertNotEqual(self.create("spirectl", check=False).returncode, 0)
        (self.bin / "mise").write_text("#!/bin/sh\nexit 9\n")
        self.assertNotEqual(self.create("broken", check=False).returncode, 0)
        self.assertFalse((self.root / ".worktrees" / "broken").exists())
        self.assertNotIn("worktree/broken", self.git("branch", "--list").stdout)

    def test_dirty_migration_and_prune_guards(self) -> None:
        source = self.root.parent / "old-checkout"
        self.git("worktree", "add", "-b", "old", str(source), "main")
        (source / "tracked.txt").write_text("dirty\n")
        (source / "untracked.txt").write_text("keep\n")
        (source / "artifacts").mkdir()
        (source / "artifacts" / "result.json").write_text("{}\n")
        self.assertIn("MOVE", self.admin("migrate", str(source)).stdout)
        self.assertTrue(source.exists())
        self.admin("migrate", str(source), "--apply")
        moved = self.root / ".worktrees" / "old-checkout"
        self.assertFalse(source.exists())
        self.assertEqual((moved / "untracked.txt").read_text(), "keep\n")
        self.assertEqual((moved / "artifacts" / "result.json").read_text(), "{}\n")
        self.assertIn("dirty", self.admin("prune", str(moved), "--apply", "--evidence-reviewed").stdout)
        (moved / "tracked.txt").write_text("base\n")
        (moved / "untracked.txt").unlink()
        self.assertIn("ignored artifacts need review", self.admin("prune", str(moved), "--apply").stdout)
        self.git("worktree", "lock", str(moved))
        self.assertIn("locked", self.admin("prune", str(moved), "--apply", "--evidence-reviewed").stdout)
        self.git("worktree", "unlock", str(moved))
        sleeper = subprocess.Popen(["sleep", "20"], cwd=moved)
        try:
            self.assertIn("active PID", self.admin("prune", str(moved), "--apply", "--evidence-reviewed").stdout)
        finally:
            sleeper.terminate()
            sleeper.wait()
        self.admin("prune", str(moved), "--apply", "--evidence-reviewed")
        self.assertFalse(moved.exists())
        self.assertIn("old", self.git("branch", "--list").stdout)

    def test_nested_snapshot_is_excluded(self) -> None:
        snapshot = self.root.parent / "consumer" / ".worktrees" / "baseline" / "godot-scene-web"
        snapshot.parent.mkdir(parents=True)
        self.git("worktree", "add", "--detach", str(snapshot), "main")
        output = self.admin("prune", str(snapshot), "--apply").stdout
        self.assertIn("owned by another snapshot workflow", output)
        self.assertTrue(snapshot.exists())


if __name__ == "__main__":
    unittest.main()
