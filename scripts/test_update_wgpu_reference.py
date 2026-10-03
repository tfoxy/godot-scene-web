#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from update_wgpu_reference import locked_reference_packages, reference_is_current  # noqa: E402


CRATES = ("wgpu", "wgpu-core", "wgpu-hal", "wgpu-types", "naga")
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def lock_fixture(version: str) -> dict:
    return {
        "package": [
            {
                "name": name,
                "version": version,
                "source": REGISTRY,
                "checksum": f"checksum-{name}-{version}",
            }
            for name in CRATES
        ]
    }


class LockedVersionTests(unittest.TestCase):
    def test_reads_current_crate_versions_and_checksums(self) -> None:
        packages = locked_reference_packages(lock_fixture("30.0.1"))
        self.assertEqual([package["version"] for package in packages], ["30.0.1"] * len(CRATES))
        self.assertEqual(packages[0]["checksum"], "checksum-wgpu-30.0.1")

    def test_changed_lock_version_is_not_hard_coded(self) -> None:
        packages = locked_reference_packages(lock_fixture("31.2.0"))
        self.assertEqual([package["version"] for package in packages], ["31.2.0"] * len(CRATES))

    def test_missing_implementation_crate_fails_clearly(self) -> None:
        fixture = lock_fixture("30.0.1")
        fixture["package"] = [p for p in fixture["package"] if p["name"] != "wgpu-hal"]
        with self.assertRaisesRegex(ValueError, "wgpu-hal"):
            locked_reference_packages(fixture)

    def test_check_rejects_missing_bundle(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            current, reason = reference_is_current(Path(temporary) / "missing", locked_reference_packages(lock_fixture("30.0.1")))
        self.assertFalse(current)
        self.assertIn("missing", reason)


if __name__ == "__main__":
    unittest.main()
