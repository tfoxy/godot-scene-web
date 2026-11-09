#!/usr/bin/env python3
"""Calibration self-tests; --update rewrites the deterministic record goldens."""

import argparse
import copy
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth

calibrate = synth.calibrate
HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / "calibrate.py"


def invoke(*args, tool=TOOL):
    return subprocess.run([sys.executable, "-I", str(tool), *map(str, args)],
                          cwd=HERE.parents[4], capture_output=True, text=True)


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def safe_values(value):
    require(not isinstance(value, float), "float in record")
    if isinstance(value, int):
        require(0 <= value < 2 ** 53, "out-of-range integer")
    elif isinstance(value, dict):
        for child in value.values():
            safe_values(child)
    elif isinstance(value, list):
        for child in value:
            safe_values(child)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--tool", type=Path, default=TOOL, help=argparse.SUPPRESS)
    args = parser.parse_args()
    passed = failed = 0

    def test(name, function):
        nonlocal passed, failed
        try:
            function()
            print(f"ok {name}")
            passed += 1
        except Exception as exc:
            print(f"FAIL {name}: {exc}")
            failed += 1

    with tempfile.TemporaryDirectory(prefix="calibrate-test-") as temp:
        root = Path(temp)
        header = root / "fixture.h"
        synth.fixture_header(header)
        for variant in ("elf", "elf-pie", "pe-null", "pe-code"):
            binary = root / variant
            facts = synth.build(binary, variant)
            result = invoke("--binary", binary, "--header", header, tool=args.tool)
            record = None

            def golden():
                nonlocal record
                require(result.returncode == 0, result.stderr)
                record = json.loads(result.stdout)
                path = HERE / "golden" / f"synth-{variant}.json"
                if args.update:
                    path.write_text(result.stdout)
                require(result.stdout.encode() == path.read_bytes(), f"golden differs: {path}")
                safe_values(record)
                require(list(record) == ["schema", "engine", "rendering_server", "slots", "anchors"] + ([] if variant.startswith("elf") else ["devirtualized_slots", "dropped_families"]) + ["calibrator"], "record key order")
                if variant.startswith("elf"):
                    require(list(record["engine"]) == ["version_string", "build_id", "sha256", "platform", "flavor", "pie"], "ELF engine keys changed")
                    require(list(record["rendering_server"]) == ["abstract_vtable_vaddr", "concrete_class", "concrete_vtable_vaddr", "object_prefix", "slot_count", "anchors_total", "anchors_matched"], "ELF server keys changed")
                else:
                    require(list(record["engine"]) == ["version_string", "sha256", "image_sha256", "codeview_id", "time_date_stamp", "size_of_image", "image_base", "dynamic_base", "platform", "flavor"], "PE engine keys/order")
                    require(record["rendering_server"]["placeholder_kind"] == ("code" if variant == "pe-code" else "null"), "placeholder kind")
                require(record["rendering_server"]["slot_count"] == 140, "walk ran into adjacent vtable")
                require(record["rendering_server"]["object_prefix"] == 5, "prefix")

            test(f"golden-{variant}", golden)
            if record is None:
                continue
            record_path = root / "record.json"
            record_path.write_text(json.dumps(record))

            def verify():
                run = invoke("--verify-record", record_path, "--binary", binary, "--header", header, tool=args.tool)
                require(run.returncode == 0 and "verified: 14/14" in run.stdout, run.stdout + run.stderr)
                require(sum(line.startswith("check ") for line in run.stdout.splitlines()) == 14, "check count")
                no_header = invoke("--verify-record", record_path, "--binary", binary, tool=args.tool)
                require(no_header.returncode == 2 and "--header is required for the devirtualized check" in no_header.stderr,
                        no_header.stdout + no_header.stderr)
            test(f"verify-{variant}", verify)

            rebranded = root / f"rebranded-{variant}"
            rebranded.write_bytes(binary.read_bytes().replace(b"Godot Engine v", b"Synth Engine v"))

            def cross_brand(version_name=None):
                options = ("--version-name", version_name) if version_name else ()
                run = invoke("--verify-record", record_path, "--binary", rebranded,
                             *options, tool=args.tool)
                require(run.returncode == 3, f"exit {run.returncode}: {run.stdout}{run.stderr}")
                live = record["engine"]["version_string"].replace("Godot Engine", "Synth Engine") if version_name else ""
                require(f"check version_string FAIL live '{live}' record '{record['engine']['version_string']}'"
                        in run.stdout, run.stdout + run.stderr)
                require(sum(line.startswith("check ") for line in run.stdout.splitlines()) == 5,
                        run.stdout + run.stderr)
                require(run.stdout.endswith("refused: fingerprint-mismatch\n"), run.stdout + run.stderr)
            test(f"cross-brand-explicit-{variant}", lambda: cross_brand("Synth Engine"))
            test(f"cross-brand-default-{variant}", cross_brand)

            def record_brand_fallback():
                run = invoke("--binary", rebranded, "--header", header,
                             "--version-name", "Synth Engine", tool=args.tool)
                require(run.returncode == 0, run.stdout + run.stderr)
                branded_record = root / "branded-record.json"
                branded_record.write_text(run.stdout)
                run = invoke("--verify-record", branded_record, "--binary", rebranded,
                             "--header", header, tool=args.tool)
                require(run.returncode == 0 and "verified: 14/14" in run.stdout, run.stdout + run.stderr)
            test(f"record-brand-fallback-{variant}", record_brand_fallback)

            def prefix_tamper():
                tampered = copy.deepcopy(record)
                # An older record may omit optional hooks. Omit the final slot so
                # the prefix sabotage reaches anchors rather than the range guard.
                tampered["slots"] = {key: index for key, index in tampered["slots"].items()
                                     if index + 1 < tampered["rendering_server"]["slot_count"]}
                tampered["rendering_server"]["object_prefix"] += 1
                for group in ("anchors", "slots"):
                    tampered[group] = {key: value + 1 for key, value in tampered[group].items()}
                record_path.write_text(json.dumps(tampered))
                run = invoke("--verify-record", record_path, "--binary", binary, "--header", header, tool=args.tool)
                require(run.returncode == 3 and "check anchors_implemented FAIL" in run.stdout and "refused: slot-mask-mismatch" in run.stdout, run.stdout + run.stderr)
                if variant == "pe-code":
                    checks = calibrate.slot_mask_checks(tampered, calibrate.open_image(str(binary)), exclude_placeholder=False)
                    require(next(ok for name, ok, _ in checks if name == "anchors_implemented"), "old anchors rule did not pass")
            test(f"prefix-tamper-{variant}", prefix_tamper)

            def mismatch_order():
                tampered = copy.deepcopy(record)
                tampered["anchors"] = {key: index + 1 for key, index in
                                       reversed(list(record["anchors"].items()))}
                record_path.write_text(json.dumps(tampered))
                run = invoke("--verify-record", record_path, "--binary", binary, "--header", header, tool=args.tool)
                require(run.returncode == 3 and "first mismatch synth_anchor_40@46" in run.stdout,
                        run.stdout + run.stderr)
            test(f"first-mismatch-order-{variant}", mismatch_order)

            def fingerprint_stop():
                tampered = copy.deepcopy(record)
                tampered["engine"]["image_sha256" if variant.startswith("pe") else "sha256"] = "0" * 64
                record_path.write_text(json.dumps(tampered))
                run = invoke("--verify-record", record_path, "--binary", binary, tool=args.tool)
                require(run.returncode == 3 and "refused: fingerprint-mismatch" in run.stdout, run.stdout + run.stderr)
                require("singleton_available" not in run.stdout, "mask ran after bad fingerprint")
                require(sum(line.startswith("check ") for line in run.stdout.splitlines()) == 5, "fingerprint check count")
            test(f"fingerprint-stop-{variant}", fingerprint_stop)

            if variant.startswith("pe"):
                def identity():
                    run = invoke("--pe-identity", binary, tool=args.tool)
                    require(run.returncode == 0, run.stderr)
                    expected = dict(facts["expected"])
                    data = binary.read_bytes()
                    expected["sha256"] = hashlib.sha256(data).hexdigest()
                    expected["image_sha256"] = hashlib.sha256(b"".join(data[o:o + n] for o, n in facts["image_ranges"])).hexdigest()
                    require(json.loads(run.stdout) == expected, run.stdout)
                    require(list(json.loads(run.stdout)) == sorted(expected), "identity key order")
                test(f"identity-{variant}", identity)
            else:
                def reject_identity():
                    run = invoke("--pe-identity", binary, tool=args.tool)
                    require(run.returncode == 2 and "requires a PE" in run.stderr, run.stdout + run.stderr)
                test(f"identity-refuses-{variant}", reject_identity)

        refusals = {"pe32": "Magic", "machine-arm64": "Machine", "msvc-rtti": "MSVC-ABI RTTI",
                    "placeholder-tie": "placeholder ambiguous", "unrelocated-word": "is not relocated: not a pointer",
                    "mixed-placeholder": "header/binary mask mismatch"}
        for variant, message in refusals.items():
            def refusal():
                binary = root / variant
                synth.build(binary, variant)
                out = root / "preserve.json"
                out.write_text("preserve me")
                run = invoke("--binary", binary, "--header", header, "--out", out, tool=args.tool)
                require(run.returncode == 2 and message in run.stderr, run.stdout + run.stderr)
                require(out.read_text() == "preserve me", "refusal overwrote existing output")
            test(f"refuse-{variant}", refusal)

        def mixed_null():
            image = calibrate.open_image(str(root / "elf"))
            try:
                calibrate.discover_placeholder(image, [None, 0], [], "RenderingServer")
            except calibrate.CalibrationError as exc:
                require(str(exc) == "RenderingServer: pure-virtual slots are not uniform: [0, None]", str(exc))
            else:
                raise AssertionError("mixed unresolved/null placeholders accepted")
        test("mixed-null-uniformity", mixed_null)

        def pe_boundaries():
            binary = root / "pe-null"
            image = calibrate.open_image(str(binary))
            section = image.alloc[0]
            end = section["addr"] + section["size"]
            require(image.read_u64(end - 8) is not None, "last backed word")
            require(image.read_u64(end - 7) is None, "word crossed readable extent")
            require(image.section_of(end) is None, "section end was inclusive")
            require(all(s["name"] != ".reloc" for s in image.alloc), "relocations allocated")
        test("pe-readable-boundaries", pe_boundaries)

        def long_debug_section():
            data = bytearray((root / "pe-null").read_bytes())
            raw = len(data)
            debug = b"\0" + b"15RenderingServer\0Godot Engine v9.9.debug\0"
            data.extend(debug.ljust(0x200, b"\0"))
            symbols = len(data)
            name = b".debug_str\0"
            data.extend(struct.pack("<I", 4 + len(name)) + name)
            struct.pack_into("<H", data, 0x86, 4)
            struct.pack_into("<II", data, 0x8C, symbols, 0)
            struct.pack_into("<8sIIIIIIHHI", data, 0x98 + 240 + 3 * 40,
                             b"/4", len(debug), 0x8000, 0x200, raw, 0, 0, 0, 0, 0x42000040)
            binary = root / "long-debug"
            binary.write_bytes(data)
            image = calibrate.open_image(str(binary))
            require(image.sections[-1]["name"] == ".debug_str", "COFF name not resolved")
            require(len(image.find_bytes(b"15RenderingServer\0")) == 1, "debug RTTI searched")
            run = invoke("--binary", binary, "--header", header, tool=args.tool)
            require(run.returncode == 0, run.stdout + run.stderr)
        test("pe-long-discardable-debug", long_debug_section)

        def codeview_entries(conflict=False, rsds=True):
            data = bytearray((root / "pe-code").read_bytes())
            payload = data[0x3820:0x3840 + 32]
            size = struct.unpack_from("<I", data, 0x3800 + 16)[0]
            data[0x3840:0x3840 + len(payload)] = payload
            struct.pack_into("<II", data, 0x3800 + 20, 0x7040, 0x3840)
            data[0x381C:0x3838] = data[0x3800:0x381C]
            struct.pack_into("<I", data, 0x98 + 112 + 6 * 8 + 4, 56)
            if conflict:
                data[0x3880:0x3880 + size] = data[0x3840:0x3840 + size]
                data[0x3880 + (24 if conflict == "path" else 4)] ^= 1
                struct.pack_into("<II", data, 0x381C + 20, 0x7080, 0x3880)
            if not rsds:
                data[0x3840:0x3844] = b"NB10"
            binary = root / "multi-codeview"
            binary.write_bytes(data)
            run = invoke("--pe-identity", binary, tool=args.tool)
            if conflict:
                require(run.returncode == 2 and "conflicting RSDS entries" in run.stderr, run.stdout + run.stderr)
            else:
                require(run.returncode == 0, run.stdout + run.stderr)
                expected = synth.GUID.hex() + ":3" if rsds else None
                require(json.loads(run.stdout)["codeview_id"] == expected, run.stdout)
        test("pe-codeview-duplicate", codeview_entries)
        test("pe-codeview-conflict", lambda: codeview_entries(conflict=True))
        test("pe-codeview-path-conflict", lambda: codeview_entries(conflict="path"))
        test("pe-codeview-non-rsds", lambda: codeview_entries(rsds=False))

        for name, offset, fmt, value, message in (
            ("lfanew", 0x3C, "<I", 0xFFFFFF00, "range past EOF"),
            ("signature", 0x80, "<I", 0, "invalid PE signature"),
            ("directories", 0x98 + 108, "<I", 6, "NumberOfRvaAndSizes"),
            ("headers-eof", 0x98 + 60, "<I", 0xFFFFFF00, "range past EOF"),
            ("section-eof", 0x98 + 240 + 20, "<I", 0xFFFFFF00, "range past EOF"),
            ("no-exec", 0x98 + 240 + 36, "<I", 0x40000020, "requires executable sections"),
            ("no-rdata", 0x98 + 240 + 40, "<8s", b".other", "and .rdata"),
        ):
            def malformed():
                data = bytearray((root / "pe-null").read_bytes())
                struct.pack_into(fmt, data, offset, value)
                binary = root / "malformed"
                binary.write_bytes(data)
                run = invoke("--pe-identity", binary, tool=args.tool)
                require(run.returncode == 2 and message in run.stderr, run.stdout + run.stderr)
            test(f"pe-refuse-{name}", malformed)

    print(f"calibrate self-test: {passed} passed, {failed} failed")
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(main())
