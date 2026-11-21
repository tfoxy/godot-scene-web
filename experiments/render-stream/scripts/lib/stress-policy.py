#!/usr/bin/env python3
"""Shared opt-ins for planning and the local complement of remote validation."""
import json
import os
import sys

GPU_LEGS = ("gpu-heavy", "rate-uncapped")


def gpu_legs():
    selected = set((os.environ.get("G6C_LEGS", "") + "," + os.environ.get("G7R_LEGS", "")).split(","))
    return {leg: "run" if os.environ.get("RS_GPU_STRESS") == "1" or leg in selected
            else "gpu stress: opt-in" for leg in GPU_LEGS}


def device_allowed(run_id, only):
    return os.environ.get("RS_DEVICE_LEGS") == "1" or run_id in only


def annotate(plan, only):
    for run in plan["runs"]:
        if run.get("gate") == "gate6" or "g7-r" in run.get("groups", []):
            run["gpu_stress"] = gpu_legs()
        if run.get("kind") == "g7x" and not device_allowed(run["id"], only):
            run["skip_reason"] = "device legs: opt-in (RS_DEVICE_LEGS=1 or --only)"
    return plan


if __name__ == "__main__":
    mode, path, *rest = sys.argv[1:]
    only = set(filter(None, (rest[0] if rest else "").split(",")))
    if mode == "plan":
        with open(path) as f:
            plan = annotate(json.load(f), only)
        with open(path, "w") as f:
            json.dump(plan, f, indent=2)
            f.write("\n")
    elif mode == "local":
        # Print refusals before the wrapper starts any local work. Gate 6 retains its safe
        # legs; the runner enforces the GPU exclusions even when a whole run is selected.
        with open(path) as f:
            plan = json.load(f)
        ids = set(filter(None, (rest[1] if len(rest) > 1 else "").split(",")))
        keep = []
        for run in plan["runs"]:
            if run["id"] not in ids:
                continue
            if run.get("kind") == "g7x" and not device_allowed(run["id"], only):
                print(f"remote-validate: --and-local refuses {run['id']}: device legs: opt-in", file=sys.stderr)
                continue
            if run.get("gate") == "gate6" or "g7-r" in run.get("groups", []):
                for leg, state in gpu_legs().items():
                    if state != "run":
                        print(f"remote-validate: --and-local refuses {run['id']}/{leg}: {state}", file=sys.stderr)
            keep.append(run["id"])
        print(",".join(keep))
    else:
        raise SystemExit("unknown stress-policy mode")
