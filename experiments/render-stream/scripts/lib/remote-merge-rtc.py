#!/usr/bin/env python3
"""Attach both RTC platform artifacts to the merged run; absent or failed legs fail closed."""
import argparse
import json
from pathlib import Path


def fold(summary, jobs):
    rtc = next((r for r in summary["runs"] if r["id"] == "rtc"), None)
    if rtc is None:
        return summary
    rtc["rtc"] = {}
    errors = []
    for host, labels in [("linux", ["chromium", "chromium-negative", "webkit", "webkit-negative"]),
                         ("macos", ["safari", "safari-negative", "iphone-safari", "iphone-safari-negative"])]:
        paths = list(jobs.glob(f"*/rtc-{host}.json"))
        if len(paths) != 1:
            errors.append(f"rtc-{host}: expected one artifact, found {len(paths)}")
            continue
        try:
            value = json.loads(paths[0].read_text())
            rtc["rtc"][host] = value
            browser = value.get("browser") or {}
            if (value.get("platform") != host or value.get("ok") is not True
                    or browser.get("ok") is not True or browser.get("persistence") is not True
                    or any(browser.get("results", {}).get(label, {}).get("ok") is not True for label in labels)):
                errors.append(f"rtc-{host}: failed or missing browser leg")
            if host == "macos":
                sizes = (value.get("sizes") or {}).get("targets", {})
                for target in ["aarch64-apple-darwin", "x86_64-apple-darwin"]:
                    row = sizes.get(target, {})
                    if any(not isinstance(row.get(k), int) or row[k] <= 0 for k in ["default_bytes", "rtc_bytes"]):
                        errors.append(f"rtc-macos: missing sizes for {target}")
        except (OSError, ValueError, TypeError, AttributeError) as error:
            errors.append(f"rtc-{host}: invalid artifact: {error}")
    if errors:
        rtc["rc"] = "1"
        rtc.setdefault("failing", []).extend(errors)
    summary["failed"] = sum(r["rc"] != "0" for r in summary["runs"])
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--jobs", type=Path, required=True)
    args = parser.parse_args()
    summary = fold(json.loads(args.summary.read_text()), args.jobs)
    args.summary.write_text(json.dumps(summary, indent=2) + "\n")
