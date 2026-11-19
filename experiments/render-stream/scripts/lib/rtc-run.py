#!/usr/bin/env python3
"""Run the local RTC platform leg and preserve results even when provisioning fails."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[4]
RTC = ROOT / "experiments/render-stream/rtc"
SCRIPTS = ROOT / "experiments/render-stream/scripts"


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def result_ok(browser, labels):
    return (isinstance(browser, dict) and browser.get("ok") is True
            and browser.get("persistence") is True
            and all(browser.get("results", {}).get(label, {}).get("ok") is True for label in labels))


def row(result):
    failures = [f"{command['name']}: {command['error']}"
                for command in result.get("commands", []) if command.get("error")]
    if result.get("error"):
        failures.append(result["error"])
    return {"id": "rtc", "phase": "setup", "rc": "0" if result["ok"] else "1",
            "wall_s": result["wall_s"], "lock_wait_s": result.get("lock_wait_s", 0),
            "lock_hold_s": 0, "lock": {}, "lock_summaries": 0, "skipped_by_tier": 0,
            "unavailable": [], "known_flakes": [], "failing": [] if result["ok"] else failures or ["RTC platform leg failed; see browser results"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--summary", action="store_true", help="emit a standalone job summary (macOS)")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    host = "macos" if platform.system() == "Darwin" else "linux"
    result = {"platform": host, "ok": False, "commands": [], "deferred_legs": [] if host == "macos" else ["desktop Safari and iPhone Simulator require the hosted macOS leg"]}

    def shared(command):
        # The quiet lock uses Linux procfs; hosted macOS jobs run directly.
        return command if host == "macos" else [str(SCRIPTS / "lib/quiet.sh"), "shared", "--", *command]

    def run(label, command, timeout=1200):
        path = out / f"{label}.log"
        record = {"name": label, "argv": command, "log": str(path)}
        with path.open("w") as log:
            try:
                rc = subprocess.run(command, cwd=ROOT, env=dict(os.environ, QUIET_LOG=str(out / f"{label}.quiet.jsonl")), stdout=log, stderr=subprocess.STDOUT, timeout=timeout).returncode
                if rc:
                    record["error"] = f"command exited with exit status {rc}"
            except (OSError, subprocess.TimeoutExpired) as error:
                log.write(str(error))
                record["error"] = str(error)
                rc = 1
        record["rc"] = rc
        if rc:
            with path.open("rb") as log:
                log.seek(max(0, path.stat().st_size - 8192))
                record["log_tail"] = log.read().decode("utf-8", errors="replace")
        result["commands"].append(record)
        return rc == 0

    for previous in list(out.glob("*.quiet.jsonl")) + list(out.glob("quiet-lock*.json*")):
        previous.unlink()
    for name in ["browsers.json", "sizes.json"]:
        (out / name).unlink(missing_ok=True)
    try:
        rust_passed = run("feature-tests", shared(["cargo", "test", "--offline", "--locked", "--release", "--features", "rtc", "--manifest-path", str(ROOT / "experiments/render-stream/rs-net/Cargo.toml")]))
        if not run("address", ["node", str(RTC / "lan.mjs")]):
            raise RuntimeError("LAN address discovery failed; see address command")
        address = read(out / "address.log")
        result["address"] = address
        browser_path = out / "browsers.json"
        if host == "linux":
            command = ["mise", "exec", "--", "pnpm", "exec", "tsx", "--conditions=development", str(RTC / "run-browsers.ts"), "--ip", address["ip"], "--out", str(browser_path)]
            if os.environ.get("RTC_WEBKIT_EXECUTABLE"):
                command += ["--webkit-executable", os.environ["RTC_WEBKIT_EXECUTABLE"]]
            passed = run("browsers", command)
            labels = ["chromium", "chromium-negative", "webkit", "webkit-negative"]
        else:
            passed = run("build", shared(["cargo", "build", "--offline", "--locked", "--release", "--manifest-path", str(ROOT / "experiments/render-stream/rs-net/Cargo.toml"), "--features", "rtc", "--bin", "rs-net-rtc-probe"]))
            if passed:
                passed = run("browsers", ["mise", "exec", "--", "pnpm", "exec", "tsx", "--conditions=development", str(RTC / "run-safari.ts"), "--ip", address["ip"], "--out", str(browser_path)])
            labels = ["safari", "safari-negative", "iphone-safari", "iphone-safari-negative"]
            sizes_passed = run("sizes", [sys.executable, "-I", str(SCRIPTS / "rtc-sizes.py"), "--targets", "aarch64-apple-darwin,x86_64-apple-darwin", "--out", str(out / "sizes.json")], timeout=1800)
            result["sizes"] = read(out / "sizes.json")
            passed &= sizes_passed and bool(result["sizes"]) and len(result["sizes"].get("targets", {})) == 2
        result["browser"] = read(browser_path)
        result["ok"] = rust_passed and passed and result_ok(result["browser"], labels)
    except Exception as error:
        result["error"] = str(error)
    finally:
        # Match validate-summary's lock collector and retain the runner's measured wait.
        logs = list(out.glob("*.quiet.jsonl")) if host == "linux" else []
        if logs:
            combined = out / "quiet-lock.jsonl"
            combined.write_text("".join(p.read_text() for p in logs))
            if not run("quiet-summary", [str(SCRIPTS / "lib/quiet.sh"), "summary", str(combined), "--out", str(out / "quiet-lock-summary.json")]):
                result["ok"] = False
        locks = read(out / "quiet-lock-summary.json") or {}
        result["lock_wait_s"] = sum(m.get("wait_s_total", 0) for m in locks.get("modes", {}).values())
        result["wall_s"] = round(time.monotonic() - start, 3)
        (out / f"rtc-{host}.json").write_text(json.dumps(result, indent=2) + "\n")
        if args.summary:
            summary = {"schema": "render-stream-validate-summary/2", "wall_s": result["wall_s"], "runs": [row(result)], "failed": int(not result["ok"])}
            (out / "validate-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("platform", "ok", "wall_s", "lock_wait_s")}))
    return int(not result["ok"])


if __name__ == "__main__":
    raise SystemExit(main())
