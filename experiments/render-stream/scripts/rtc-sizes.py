#!/usr/bin/env python3
"""Measure stripped release cdylibs; never install into capture's shared build outputs."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
NET = ROOT / "experiments/render-stream/rs-net"
QUIET = ROOT / "experiments/render-stream/scripts/lib/quiet.sh"


def measure(targets, out):
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for target in targets:
        env = dict(os.environ)
        suffix = "dylib" if "apple" in target else "dll" if "windows" in target else "so"
        name = "render_stream_net.dll" if suffix == "dll" else f"librender_stream_net.{suffix}"
        strip = shutil.which("strip")
        if "windows" in target:
            cache = Path(env.get("GRC_LLVM_MINGW_CACHE", str(Path.home() / ".cache/godot-render-stream/llvm-mingw")))
            tool = cache / "20250709/llvm-mingw-20250709-ucrt-ubuntu-22.04-x86_64"
            if not (tool / ".grc-verified").is_file():
                raise RuntimeError(f"verified llvm-mingw toolchain missing: {tool}; no download attempted")
            env.update(CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER=str(tool / "bin/x86_64-w64-mingw32-clang"),
                       CC_x86_64_pc_windows_gnullvm=str(tool / "bin/x86_64-w64-mingw32-clang"),
                       AR_x86_64_pc_windows_gnullvm=str(tool / "bin/llvm-ar"),
                       CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-static")
            strip = str(tool / "bin/llvm-strip")
        elif "apple" in target:
            env["MACOSX_DEPLOYMENT_TARGET"] = "11.0" if target.startswith("aarch64") else "10.15"
        row = {}
        for feature in [None, "rtc"]:
            label = "rtc" if feature else "default"
            log = out.with_name(f"sizes-{target}-{label}.log")
            command = ["cargo", "build", "--offline", "--locked", "--release", "--lib", "--target", target, "--manifest-path", str(NET / "Cargo.toml")]
            if feature:
                command += ["--features", feature]
            if platform.system() != "Darwin":
                command = [str(QUIET), "shared", "--", *command]
            with log.open("w") as stream:
                completed = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
            if completed.returncode:
                with log.open("rb") as stream:
                    stream.seek(max(0, log.stat().st_size - 8192))
                    tail = stream.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"{target} {label} build exited {completed.returncode}; see {log}\n{tail}")
            copy = out.with_name(f"size-{target}-{label}.{suffix}")
            shutil.copyfile(NET / "target" / target / "release" / name, copy)
            subprocess.run([strip, "-x" if suffix == "dylib" else "--strip-unneeded", str(copy)], check=True)
            row[f"{label}_bytes"] = copy.stat().st_size
            copy.unlink()
        row["delta_bytes"] = row["rtc_bytes"] - row["default_bytes"]
        sizes[target] = row
        out.write_text(json.dumps({"targets": sizes}, indent=2) + "\n")
    for package in ["aws-lc-sys", "openssl-sys"]:
        result = subprocess.run(["cargo", "tree", "--offline", "-i", package, "--features", "rtc", "--target", "all", "--manifest-path", str(NET / "Cargo.toml")], cwd=ROOT, text=True, capture_output=True)
        out.with_name(f"{package}.txt").write_text(result.stdout + result.stderr)
        if result.stdout.strip() or (result.returncode and "did not match any packages" not in result.stderr):
            raise RuntimeError(f"unexpected dependency graph for {package}: {result.stdout}{result.stderr}")
    return sizes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", default="x86_64-unknown-linux-gnu,x86_64-pc-windows-gnullvm")
    parser.add_argument("--out", type=Path, default=ROOT / ".local/rtc-g0/sizes.json")
    args = parser.parse_args()
    print(json.dumps(measure(args.targets.split(","), args.out), indent=2))
