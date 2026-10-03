#!/usr/bin/env python3
"""Populate an ignored, version-matched wgpu source and rustdoc reference bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CRATE_DIR = ROOT / "packages/canvas/rust-prototype"
LOCKFILE = CRATE_DIR / "Cargo.lock"
REFERENCE_DIR = ROOT / "artifacts/reference/wgpu"
TARGET = "wasm32-unknown-unknown"
FEATURES = ["webgl"]
REFERENCE_CRATES = {
    "wgpu": "wgpu",
    "wgpu-core": "wgpu_core",
    "wgpu-hal": "wgpu_hal",
    "wgpu-types": "wgpu_types",
    "naga": "naga",
}


def locked_reference_packages(lock: dict[str, Any]) -> list[dict[str, str]]:
    packages = lock.get("package", [])
    result: list[dict[str, str]] = []
    for name in REFERENCE_CRATES:
        matches = [
            package
            for package in packages
            if package.get("name") == name
            and str(package.get("source", "")).startswith("registry+")
        ]
        if len(matches) != 1:
            raise ValueError(
                f"Cargo.lock must contain exactly one registry entry for {name}; found {len(matches)}"
            )
        package = matches[0]
        checksum = package.get("checksum")
        if not checksum:
            raise ValueError(f"Cargo.lock has no registry checksum for {name}")
        result.append(
            {
                "name": name,
                "version": package["version"],
                "checksum": checksum,
                "source": package["source"],
            }
        )
    return result


def sha256_tree(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def reference_is_current(bundle: Path, packages: list[dict[str, str]]) -> tuple[bool, str]:
    manifest_path = bundle / "manifest.json"
    if not manifest_path.is_file():
        return False, "reference manifest is missing"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return False, f"reference manifest is unreadable: {error}"

    expected = [{key: package[key] for key in ("name", "version", "checksum", "source")} for package in packages]
    if manifest.get("packages") != expected:
        return False, "reference versions/checksums differ from Cargo.lock"
    if manifest.get("target") != TARGET or manifest.get("features") != FEATURES:
        return False, "reference target/features differ from the renderer build"
    source_records = {
        (record.get("name"), record.get("version")): record
        for record in manifest.get("sourcePackages", [])
    }
    for name, doc_crate in REFERENCE_CRATES.items():
        package = next(item for item in packages if item["name"] == name)
        source_dir = bundle / f"source/{name}-{package['version']}"
        if not (source_dir / "Cargo.toml").is_file():
            return False, f"local source for {name} is missing"
        record = source_records.get((name, package["version"]))
        if record is None or record.get("sourceSha256") != sha256_tree(source_dir):
            return False, f"local source checksum for {name} does not match the manifest"
        license_files = record.get("licenseFiles", [])
        if len(license_files) != 2:
            return False, f"MIT/Apache license provenance for {name} is missing"
        for license_file in license_files:
            if not (bundle / license_file).is_file():
                return False, f"license text for {name} is missing"
        if not (bundle / f"docs/{doc_crate}/index.html").is_file():
            return False, f"local API docs for {name} are missing"
    return True, ""


def cargo(*arguments: str, cwd: Path = ROOT, capture: bool = False) -> str:
    result = subprocess.run(
        ["cargo", *arguments],
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode:
        if capture:
            sys.stderr.write(result.stderr or "")
            sys.stderr.write(result.stdout or "")
        raise subprocess.CalledProcessError(result.returncode, result.args)
    return result.stdout or ""


def collect_source_packages(
    metadata: dict[str, Any], packages: list[dict[str, str]], source_root: Path
) -> list[dict[str, str]]:
    metadata_packages = metadata.get("packages", [])
    results: list[dict[str, str]] = []
    for locked in packages:
        matches = [
            package
            for package in metadata_packages
            if package.get("name") == locked["name"]
            and package.get("version") == locked["version"]
            and str(package.get("source", "")).startswith("registry+")
        ]
        if len(matches) != 1:
            raise ValueError(
                f"cargo metadata did not resolve one source directory for "
                f"{locked['name']} {locked['version']}"
            )
        package = matches[0]
        source = Path(package["manifest_path"]).parent
        if not (source / "Cargo.toml").is_file():
            raise ValueError(f"Cargo source is missing for {locked['name']} {locked['version']}")
        destination = source_root / f"{locked['name']}-{locked['version']}"
        shutil.copytree(source, destination)
        with (source / "Cargo.toml").open("rb") as manifest_file:
            cargo_manifest = tomllib.load(manifest_file)
        metadata_package = cargo_manifest.get("package", {})
        license_files = [
            f"source/{destination.name}/{name}"
            for name in ("LICENSE.MIT", "LICENSE.APACHE")
            if (destination / name).is_file()
        ]
        if len(license_files) != 2:
            raise ValueError(f"expected MIT and Apache license text for {locked['name']}")
        results.append(
            {
                **locked,
                "license": metadata_package.get("license", "unknown"),
                "repository": metadata_package.get("repository", ""),
                "versionedSourceUrl": (
                    f"https://github.com/gfx-rs/wgpu/tree/v{locked['version']}"
                    if metadata_package.get("repository", "").rstrip("/")
                    == "https://github.com/gfx-rs/wgpu"
                    else metadata_package.get("repository", "")
                ),
                "licenseFiles": license_files,
                "sourceSha256": sha256_tree(destination),
            }
        )
    return results


def build_reference() -> None:
    with LOCKFILE.open("rb") as lock_file:
        packages = locked_reference_packages(tomllib.load(lock_file))

    REFERENCE_DIR.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".wgpu-reference-", dir=REFERENCE_DIR.parent))
    backup = REFERENCE_DIR.parent / f".wgpu-reference-old-{os.getpid()}"
    try:
        print("Fetching locked Rust dependencies...", flush=True)
        cargo("fetch", "--locked", "--manifest-path", str(CRATE_DIR / "Cargo.toml"))
        metadata_json = cargo(
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--manifest-path",
            str(CRATE_DIR / "Cargo.toml"),
            "--features",
            "webgl",
            "--filter-platform",
            TARGET,
            capture=True,
        )
        metadata = json.loads(metadata_json)

        source_root = staging / "source"
        source_root.mkdir()
        source_records = collect_source_packages(metadata, packages, source_root)

        target_output = staging / "cargo-target"
        print(f"Building local Rust API docs for {TARGET} with feature {FEATURES[0]}...", flush=True)
        cargo(
            "doc",
            "--locked",
            "--manifest-path",
            str(CRATE_DIR / "Cargo.toml"),
            "--features",
            ",".join(FEATURES),
            "--target",
            TARGET,
            "--target-dir",
            str(target_output),
        )
        doc_root = target_output / TARGET / "doc"
        missing_docs = [
            crate
            for crate in REFERENCE_CRATES.values()
            if not (doc_root / crate / "index.html").is_file()
        ]
        if missing_docs:
            raise ValueError(f"cargo doc did not produce expected crate docs: {', '.join(missing_docs)}")
        shutil.move(str(doc_root), str(staging / "docs"))
        shutil.rmtree(target_output)

        manifest = {
            "schema": "gsw-wgpu-reference/1",
            "target": TARGET,
            "features": FEATURES,
            "cargoManifest": "packages/canvas/rust-prototype/Cargo.toml",
            "cargoLock": "packages/canvas/rust-prototype/Cargo.lock",
            "packages": [
                {key: package[key] for key in ("name", "version", "checksum", "source")}
                for package in packages
            ],
            "sourcePackages": source_records,
            "docs": {
                "siteRoot": "docs/",
                "wgpu": "docs/wgpu/index.html",
                "implementationCrates": {
                    name: f"docs/{doc_name}/index.html"
                    for name, doc_name in REFERENCE_CRATES.items()
                },
            },
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        if backup.exists():
            shutil.rmtree(backup)
        if REFERENCE_DIR.exists():
            REFERENCE_DIR.rename(backup)
        try:
            staging.rename(REFERENCE_DIR)
        except Exception:
            if backup.exists() and not REFERENCE_DIR.exists():
                backup.rename(REFERENCE_DIR)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        if backup.exists() and REFERENCE_DIR.exists():
            shutil.rmtree(backup)

    print(f"Reference bundle updated: {REFERENCE_DIR}")
    print("Check without rebuilding: bash scripts/update-wgpu-reference.sh --check")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a local wgpu source/API-doc bundle from the Rust renderer's Cargo.lock."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the existing bundle against Cargo.lock without fetching or rebuilding",
    )
    arguments = parser.parse_args()

    try:
        with LOCKFILE.open("rb") as lock_file:
            packages = locked_reference_packages(tomllib.load(lock_file))
        if arguments.check:
            current, reason = reference_is_current(REFERENCE_DIR, packages)
            if not current:
                print(f"wgpu reference is stale: {reason}", file=sys.stderr)
                print("Refresh it with: bash scripts/update-wgpu-reference.sh", file=sys.stderr)
                return 1
            wgpu = next(package for package in packages if package["name"] == "wgpu")
            print(f"wgpu reference is current: {wgpu['version']}")
            return 0
        build_reference()
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"wgpu reference update failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
