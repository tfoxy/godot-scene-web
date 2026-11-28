"""Check the pre-attach layered material parameter without executing its unsafe getter."""
import json
import sys
import struct
from pathlib import Path

out = Path(sys.argv[1])
gl = sys.argv[2] == "gl_compatibility"
source = json.loads((out / "source.json").read_text())
assert source["layers"] >= 3
log = (out / "host/stdout.log").read_text()
refusals = json.loads((out / "evidence/refusals.json").read_text())
records = refusals["records"]
matching = [r for r in records if str(r["rid"]) == source["rid"]]
attempts = log.count("GRC_GL_READBACK_PROBE attempted")
reasons = {}
for record in records:
    reasons[record["reason"]] = reasons.get(record["reason"], 0) + 1
result = {"attempts": attempts, "layers": source["layers"], "layer_bytes": source["layer_bytes"],
          "refusals": reasons}
(out / "dimensionality-check.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
assert not any(str(r["rid"]) == source["flat_rid"] for r in records), "2D texture refused"
rows = [json.loads(line) for line in (out / "evidence/resources.jsonl").read_text().splitlines()]
flat = [row for row in rows if str(row.get("rid")) == source["flat_rid"]
        and row.get("op") == "adopt" and row.get("status") == "ok"]
assert len(flat) == 1, "2D texture was not adopted"
payload = (out / "store/sha256" / (flat[0]["hash"] + ".grt")).read_bytes()
meta_bytes = struct.unpack_from("<I", payload, 8)[0]
assert payload[16 + meta_bytes:] == bytes.fromhex(source["flat_hex"]), "2D pixels changed"
if gl:
    assert attempts == 0, "non-2D texture reached texture_2d_get (safely intercepted)"
    assert len(matching) == 1 and matching[0]["reason"] == "not-2d-unproven"
else:
    assert attempts == 1, "RD readback path changed"
    assert not matching, "RD layered texture newly refused"
print("texture dimensionality: 6 checks passed")
