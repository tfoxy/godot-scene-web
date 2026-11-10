"""Compare the portable reader with the offline identity oracle."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

exe, tools = sys.argv[1:]
tools = Path(tools)
checks = 0

def compare(path):
    global checks
    expected = json.loads(subprocess.check_output([sys.executable, "-I", str(tools / "calibrate.py"), "--pe-identity", str(path)]))
    actual = json.loads(subprocess.check_output([exe, str(path)]))
    assert actual == {k: expected[k] for k in actual}, (actual, expected)
    checks += 1

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "synth.exe"
    subprocess.run([sys.executable, "-I", str(tools / "test/synth.py"), "--write-pe", str(path)], check=True)
    original = path.read_bytes()
    compare(path)
    # Raw sizes, section order and excluded bytes are independently observable.
    for offset, value in ((0x98 + 240 + 8, 0x1000), (0x3500, 17)):
        data = bytearray(original)
        if offset == 0x3500:
            data[offset] = value
        else:
            struct.pack_into("<I", data, offset, value)
        path.write_bytes(data)
        compare(path)
    data = bytearray(original)
    struct.pack_into("<II", data, 0x80 + 12, 0x3600, 0)
    struct.pack_into("<I", data, 0x3600, 11)
    data[0x3604:0x360b] = b".rdata\0"
    data[0x98 + 280:0x98 + 288] = b"/4\0\0\0\0\0\0"
    path.write_bytes(data)
    compare(path)
    data = bytearray(original)
    first, second = 0x98 + 240, 0x98 + 280
    data[first:first + 40], data[second:second + 40] = data[second:second + 40], data[first:first + 40]
    path.write_bytes(data)
    compare(path)
    data = bytearray(original)
    struct.pack_into("<II", data, 0x98 + 160, 0, 0)
    path.write_bytes(data)
    compare(path)
    assert json.loads(subprocess.check_output([exe, str(path)]))["codeview_id"] is None
    data = bytearray(original)
    struct.pack_into("<I", data, 0x98 + 164, 56)
    data[0x381c:0x3838] = data[0x3800:0x381c]
    # Move both records away from the enlarged directory.
    payload = original[0x3820:0x3846]
    for entry, raw, rva in ((0x3800, 0x3880, 0x7080), (0x381c, 0x38c0, 0x70c0)):
        struct.pack_into("<III", data, entry + 16, len(payload), rva, raw)
        data[raw:raw + len(payload)] = payload
    path.write_bytes(data)
    compare(path)
    data[0x38c4] ^= 1
    path.write_bytes(data)
    result = subprocess.run([exe, str(path)], capture_output=True, text=True)
    assert result.returncode != 0 and "conflicting RSDS entries" in result.stderr
    checks += 1
    for offset, value in ((0x3C, 0xFFFFFFF0), (0x98, 0x10B), (0x98 + 240 + 20, 0xFFFFFFF0)):
        data = bytearray(original)
        struct.pack_into("<I", data, offset, value)
        path.write_bytes(data)
        result = subprocess.run([exe, str(path)], capture_output=True, text=True)
        assert result.returncode != 0, result.stdout
        checks += 1
    if os.environ.get("W462") and Path(os.environ["W462"]).is_file():
        compare(os.environ["W462"])
        print("W462 covered")
    else:
        print("W462 skipped: environment variable does not name a file")
print(f"pe_image: {checks} passed, 0 failed")
