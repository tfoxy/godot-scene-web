#!/usr/bin/env python3
"""check-canvas-textures.py control branches, judged on synthetic evidence through the real judge().

The fixture's wrappers are unregistered pre-load RIDs. Forward+ resolves or refuses them in the
resolver (no-image / unresolved reasons); gl_compatibility refuses them as not-2d-unproven before
the resolver runs, so a GL control must see zero no-image refusals and an empty unresolved map.
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_canvas_textures", SCRIPTS / "lib" / "check-canvas-textures.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

ROWS = ["attached.json", "resolved.json", "rearmed.json", "reattached.json", "final.json"]
CANVASES = ["111", "222", "333"]
ARMS = ["evidence", "evidence/arm-2", "evidence/arm-3"]
LATE = ["resolved.json", "rearmed.json", "final.json"]
NO_SELFCHECK = {"runs": 0, "samples": 0, "passed": False}


def write(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def row_for(mode, renderer, name):
    row = {"enabled": True, "ready": True, "reason": "ready", "storage_source": "derived",
           "canvas_textures_resolved": 0, "cache_entries": 0, "canvas_textures_unresolved": {},
           "resolve_total_us": 0, "resolve_max_us": 0, "arm_resolve_total_us": 0, "arm_resolve_max_us": 0,
           "derivation_image_reads": 0, "derivation_storage_reads": 0, "owner_reads": 0,
           "resolver_selfcheck": NO_SELFCHECK}
    forward = renderer == "forward_plus"
    if mode == "negative":
        row.update(enabled=False, ready=False, reason="flag-off")
    elif mode == "mismatch":
        runs = 0 if name in ["reattached.json", "final.json"] else 1
        row.update(ready=False, reason="selfcheck-mismatch",
                   resolver_selfcheck={"runs": runs, "samples": 0, "passed": False})
        if forward and name in LATE:
            row["canvas_textures_unresolved"] = {
                "canvas-texture-unresolved:selfcheck-mismatch": 6 if name == "rearmed.json" else 3}
    elif mode == "bad-derivation":
        row.update(ready=False, reason="derive-create-pattern", derivation_image_reads=2)
        if forward and name in LATE:
            row["canvas_textures_unresolved"] = {
                "canvas-texture-unresolved:derive-create-pattern": 6 if name == "rearmed.json" else 3}
    return row


def build(root, mode, renderer):
    write(root, "finished.json", {})
    (root / "host").mkdir(parents=True)
    (root / "host/stdout.log").write_text("Forward+ Vulkan\n" if renderer == "forward_plus" else "OpenGL\n")
    write(root, "evidence/calibration-check.json", {"calibration_source": "derived"})
    write(root, "evidence/derived-calibration.json", {})
    write(root, "source.json", {"canvases": CANVASES})
    for name in ROWS:
        write(root, name, row_for(mode, renderer, name))
    for arm in ARMS:
        if renderer == "forward_plus":
            write(root, arm + "/refusals.json", {
                "counts": {"refused_no_image": 3},
                "records": [{"rid": int(rid), "reason": "no-image"} for rid in CANVASES]})
        else:
            write(root, arm + "/refusals.json", {
                "counts": {"refused_no_image": 0},
                "records": [{"rid": int(rid), "reason": "not-2d-unproven"} for rid in CANVASES]})


def judge(root, renderer, mode):
    # The runner pairs --bad-record-control (mismatch) with an exact calibration, never --derived.
    return checker.judge(root, renderer, negative=mode == "negative", mismatch=mode == "mismatch",
                         derived=mode != "mismatch", bad_derivation=mode == "bad-derivation")


class Case(unittest.TestCase):
    def evidence(self, mode, renderer, mutate=None):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        build(root, mode, renderer)
        if mutate:
            mutate(root)
        return root

    def passes(self, mode, renderer, mutate=None):
        self.assertTrue(judge(self.evidence(mode, renderer, mutate), renderer, mode))

    def fails(self, mode, renderer, mutate):
        with self.assertRaises(AssertionError):
            judge(self.evidence(mode, renderer, mutate), renderer, mode)


def wrapper_no_image(root):
    """One arm records a wrapper as no-image, as the pre-guard GL path did."""
    path = root / "evidence/refusals.json"
    data = json.loads(path.read_text())
    data["counts"]["refused_no_image"] = 1
    data["records"][0]["reason"] = "no-image"
    path.write_text(json.dumps(data))


def late_arm_no_image(root):
    path = root / "evidence/arm-3/refusals.json"
    data = json.loads(path.read_text())
    data["records"][2]["reason"] = "no-image"
    path.write_text(json.dumps(data))


def unresolved_row(reason):
    def mutate(root):
        path = root / "resolved.json"
        data = json.loads(path.read_text())
        data["canvas_textures_unresolved"] = {"canvas-texture-unresolved:" + reason: 3}
        path.write_text(json.dumps(data))
    return mutate


def legacy_refusals(root):
    """The Forward+ refusals: three no-image records per arm."""
    for arm in ARMS:
        write(root, arm + "/refusals.json", {
            "counts": {"refused_no_image": 3},
            "records": [{"rid": int(rid), "reason": "no-image"} for rid in CANVASES]})


def strict_refusals(root):
    for arm in ARMS:
        write(root, arm + "/refusals.json", {
            "counts": {"refused_no_image": 0},
            "records": [{"rid": int(rid), "reason": "not-2d-unproven"} for rid in CANVASES]})


UNRESOLVED_REASON = {"mismatch": "selfcheck-mismatch", "bad-derivation": "derive-create-pattern"}


def make_tests():
    for mode in ["negative", "mismatch", "bad-derivation"]:
        label = mode.replace("-", "_")

        def gl_pass(self, mode=mode):
            self.passes(mode, "gl_compatibility")

        def gl_no_image(self, mode=mode):
            self.fails(mode, "gl_compatibility", wrapper_no_image)

        def gl_late_no_image(self, mode=mode):
            self.fails(mode, "gl_compatibility", late_arm_no_image)

        def gl_legacy_counts(self, mode=mode):
            self.fails(mode, "gl_compatibility", legacy_refusals)

        def fp_pass(self, mode=mode):
            self.passes(mode, "forward_plus")

        def fp_strict_refusals_fail(self, mode=mode):
            self.fails(mode, "forward_plus", strict_refusals)

        setattr(Case, f"test_gl_{label}_passes_with_strict_guard_evidence", gl_pass)
        setattr(Case, f"test_gl_{label}_fails_on_no_image_wrapper", gl_no_image)
        setattr(Case, f"test_gl_{label}_fails_on_no_image_wrapper_in_a_later_arm", gl_late_no_image)
        setattr(Case, f"test_gl_{label}_rejects_the_forward_plus_no_image_counts", gl_legacy_counts)
        setattr(Case, f"test_forward_plus_{label}_expectations_unchanged", fp_pass)
        setattr(Case, f"test_forward_plus_{label}_still_requires_no_image_refusals", fp_strict_refusals_fail)
        if mode in UNRESOLVED_REASON:
            reason = UNRESOLVED_REASON[mode]

            def gl_unresolved(self, mode=mode, reason=reason):
                self.fails(mode, "gl_compatibility", unresolved_row(reason))

            def fp_missing_unresolved(self, mode=mode):
                self.fails(mode, "forward_plus", unresolved_row("some-other-reason"))

            setattr(Case, f"test_gl_{label}_fails_on_resolver_unresolved_counts", gl_unresolved)
            setattr(Case, f"test_forward_plus_{label}_still_counts_resolver_reasons", fp_missing_unresolved)


make_tests()

if __name__ == "__main__":
    unittest.main()
