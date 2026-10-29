#!/usr/bin/env python3
"""HC4a shadow-oracle account of one validate run (host-cost-design.md "Byte-identity proof method").

    python3 lib/hc-shadow-scan.py <run dir>

Reads every evidence counters.json under <run dir> (each armed host writes one) and prints, as JSON,
how many hosts ran the oracle (`hc_shadow.enabled`), how many snapshots it compared and every host
whose snapshots differed from the full walk. Exits 1 when any did, 0 otherwise (a run with no
armed host, or hosts from before HC4a, reports zeros and passes: the runner's own checks judge it).
A host running an HC4a sabotage (`hc_shadow.sabotage`, run-hc1.sh's oracle legs) is meant to
mismatch: it is listed under `sabotaged` and judged by its runner's checks, not here.
"""
import json
import os
import sys


def main() -> int:
    root = sys.argv[1]
    hosts = enabled = checked = 0
    mismatched = []
    sabotaged = []
    for dirpath, _dirs, files in os.walk(root):
        if "counters.json" not in files:
            continue
        try:
            with open(os.path.join(dirpath, "counters.json")) as f:
                shadow = json.load(f).get("hc_shadow")
        except (OSError, ValueError):
            continue
        if not isinstance(shadow, dict):
            continue
        hosts += 1
        if shadow.get("enabled"):
            enabled += 1
        checked += int(shadow.get("checked", 0))
        if shadow.get("sabotage"):
            sabotaged.append({"dir": os.path.relpath(dirpath, root), "sabotage": shadow["sabotage"],
                              "mismatches": shadow.get("mismatches", 0)})
            continue
        if int(shadow.get("mismatches", 0)) > 0:
            mismatched.append({"dir": os.path.relpath(dirpath, root),
                               "mismatches": shadow["mismatches"], "first": shadow.get("first", "")})
    print(json.dumps({"schema": "hc-shadow-scan/1", "hosts": hosts, "hosts_shadow_on": enabled,
                      "snapshots_checked": checked, "hosts_mismatched": len(mismatched),
                      "mismatched": mismatched, "sabotaged": sabotaged}, indent=1))
    return 1 if mismatched else 0


if __name__ == "__main__":
    sys.exit(main())
