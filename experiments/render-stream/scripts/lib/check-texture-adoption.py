"""Rendered adoption counts: strict GL refusal is explicit, RD keeps its prior account."""
import collections
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
renderer = sys.argv[2]
expected = json.loads(Path(sys.argv[3]).read_text())["rendered_expectations"][renderer]
refusals = json.loads((out / "evidence/refusals.json").read_text())
resources = json.loads((out / "evidence/result.json").read_text())["stream"]["gate8"]["adopt_stats"]["resources"]
reasons = dict(collections.Counter(row["reason"] for row in refusals["records"]))
summary = {"renderer": renderer, "refusals": reasons, "resources": resources}
(out / "adoption-check.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary))
for field in ("textures", "textures_current", "textures_creation", "textures_refused"):
    assert resources[field] == expected[field], f"{renderer}: {field} {resources[field]}, expected {expected[field]} (GL: a pre-load texture is read back only with 2D proof, e.g. its drawing node's texture property)"
assert reasons == expected["refusals_by_reason"], f"{renderer}: named refusals {reasons}, expected {expected['refusals_by_reason']}"
print("rendered texture adoption: 5 checks passed")
