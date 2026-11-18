#!/usr/bin/env python3
"""Mach-O reader and record refusals, without a native compiler or executable fixture."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth

calibrate = synth.calibrate


def main():
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

    with tempfile.TemporaryDirectory(prefix="macho-test-") as temp:
        root = Path(temp)
        header = root / "fixture.h"
        synth.fixture_header(header)
        binary = root / "universal"
        synth.macho(binary)
        records = {}

        def args(arch):
            return argparse.Namespace(binary=str(binary), arch=arch, header=str(header),
                                      abstract_class="RenderingServer", concrete_class="RenderingServerDefault",
                                      define=[], version_name="Godot Engine", flavor="auto")

        def record(arch):
            image = calibrate.open_image(str(binary), arch)
            require(image.platform == "macos-" + arch, "platform")
            require(not image.symbols, "fixture must have no symbols")
            result, derived = calibrate.build_record(args(arch), census=False)
            records[arch] = result
            require(derived["slot_count"] == synth.SLOT_COUNT, "slot count")
            require(derived["prefix"] == synth.PREFIX, "prefix")
            require(result["rendering_server"]["placeholder_kind"] == "bind", "placeholder kind")
            require(result["rendering_server"]["pure_placeholder_symbol"] == "___cxa_pure_virtual", "symbol")
            require(result["engine"]["sha256"] == hashlib.sha256(image.data).hexdigest(), "slice digest")
            require(result["engine"]["file_sha256"] == hashlib.sha256(binary.read_bytes()).hexdigest(), "whole digest")
            require(all(ok for _, ok, _ in calibrate.slot_mask_checks(result, image)), "mask checks")
            return result, image

        for arch in ("x86_64", "arm64"):
            test(f"macho-stripped-rtti-{'opcodes' if arch == 'x86_64' else 'chained'}", lambda a=arch: record(a))

        def report_mask():
            from contextlib import redirect_stdout
            import io
            for arch in ("x86_64", "arm64"):
                output = io.StringIO()
                with redirect_stdout(output):
                    status = calibrate.report_mask(args(arch))
                require(status == 0 and "placeholder bind null" in output.getvalue(), output.getvalue())
                require(f"slots {synth.SLOT_COUNT}" in output.getvalue(), output.getvalue())
        test("macho-mask-report-both-slices", report_mask)

        def verify(result, image, expected, marker):
            from contextlib import redirect_stdout
            import io
            output = io.StringIO()
            # Step 1 tests the reader/mask and identity. Step 2 covers the live census separately.
            with patch.object(calibrate, "devirtualized_check", return_value=(True, "test census")):
                with redirect_stdout(output):
                    status = calibrate.verify_record(result, image, header=str(header))
            require(status == expected and marker in output.getvalue(), output.getvalue())

        def shifted():
            result = copy.deepcopy(records["x86_64"])
            result["slots"] = {k: v + 1 for k, v in result["slots"].items() if v + 1 < synth.SLOT_COUNT}
            result["anchors"] = {k: v + 1 for k, v in result["anchors"].items()}
            result["rendering_server"]["object_prefix"] += 1
            verify(result, calibrate.open_image(str(binary), "x86_64"), 3, "refused: slot-mask-mismatch")
        test("macho-refuse-shifted-slot", shifted)

        def wrong_cpu():
            result = copy.deepcopy(records["x86_64"])
            image = calibrate.open_image(str(binary), "arm64")
            # Isolate the CPU check from the digest, UUID and platform guards.
            result["engine"].update(sha256=image.identity()["sha256"], uuid=image.uuid, platform=image.platform)
            verify(result, image, 3, "check cputype FAIL")
        test("macho-refuse-wrong-cputype", wrong_cpu)

        def wrong_uuid():
            result = copy.deepcopy(records["x86_64"])
            data = bytearray(binary.read_bytes())
            image = calibrate.open_image(str(binary), "x86_64")
            uuid_at = data.index(bytes.fromhex(image.uuid), image.slice_offset)
            data[uuid_at] ^= 0xFF
            changed = root / "different-uuid"
            changed.write_bytes(data)
            image = calibrate.open_image(str(changed), "x86_64")
            result["engine"]["sha256"] = image.identity()["sha256"]
            verify(result, image, 3, "check uuid FAIL")
        test("macho-refuse-wrong-uuid", wrong_uuid)

        def other_slice():
            result = records["x86_64"]
            data = bytearray(binary.read_bytes())
            arm = calibrate.open_image(str(binary), "arm64")
            data[arm.slice_offset + 0x1000] ^= 1
            changed = root / "changed-other-slice"
            changed.write_bytes(data)
            image = calibrate.open_image(str(changed), "x86_64")
            require(result["engine"]["file_sha256"] != image.file_sha256, "whole digest did not change")
            verify(result, image, 0, "verified:")
        test("macho-whole-digest-informational", other_slice)

        for fmt in (2, 6):
            def thin_chain():
                path = root / "thin"
                synth.macho(path, chained=True, fat=False, pointer_format=fmt)
                image = calibrate.open_image(str(path))
                result = calibrate.derive(image, str(header), "RenderingServer", "RenderingServerDefault", set())
                require(result["slot_count"] == synth.SLOT_COUNT, "chain pointer format walk")
            test(f"macho-thin-chained-format-{fmt}", thin_chain)

        def opcode_runs(bind):
            image = calibrate.open_image(str(binary), "x86_64")
            image.binds.clear()
            image.relocations.clear()
            # Exercise repeat, skip, immediate-scaled, ULEB and lazy-DONE state.
            if bind:
                stream = bytes.fromhex("305140") + b"symbol\0" + bytes.fromhex("6020718002a008b1c0020890")
                expected = [0x100, 0x110, 0x120, 0x130, 0x140]
            else:
                stream = bytes.fromhex("1121800252426002700880020830085100")
                expected = [0x100, 0x108, 0x120, 0x128, 0x130, 0x140, 0x150, 0x168]
            off = len(image.data)
            image.data += stream
            image._dyld_stream(off, len(stream), bind)
            require(sorted(image.relocations) == [image.segments[1]["vaddr"] + n for n in expected],
                    f"opcode targets: {[hex(n - image.segments[1]['vaddr']) for n in image.relocations]}")
            if bind:
                require(set(image.bind_addends[addr] for addr in image.binds) == {32}, "bind addend")
        test("macho-rebase-opcode-runs", lambda: opcode_runs(False))
        test("macho-bind-opcode-runs", lambda: opcode_runs(True))

        def wrapped_skip():
            image = calibrate.open_image(str(binary), "x86_64")
            stream = b"\x51\x40symbol\0\x71\x88\x02\xa0" + b"\xf0" + b"\xff" * 8 + b"\x01\x90\0"
            off = len(image.data)
            image.data += stream
            image.binds.clear()
            image._dyld_stream(off, len(stream), True)
            base = image.segments[1]["vaddr"]
            require(sorted(image.binds) == [base + 0x100, base + 0x108], "unsigned address skip did not wrap")
        test("macho-dyld-unsigned-skip-wrap", wrapped_skip)

        def refuse_no_arch():
            try:
                calibrate.open_image(str(binary))
            except calibrate.CalibrationError as exc:
                require("requires --arch" in str(exc), str(exc))
            else:
                raise AssertionError("universal image accepted without slice selection")
        test("macho-refuse-ambiguous-slice", refuse_no_arch)

        def bind_symbol():
            image = calibrate.open_image(str(binary), "x86_64")
            image.binds = {addr: "wrong_symbol" for addr in image.binds}
            checks = calibrate.slot_mask_checks(records["x86_64"], image)
            require(not next(ok for name, ok, _ in checks if name == "hooked_slots_pure_in_abstract"), "wrong bind accepted")
            try:
                calibrate.derive(image, str(header), "RenderingServer", "RenderingServerDefault", set())
            except calibrate.CalibrationError as exc:
                require("expected uniform" in str(exc), str(exc))
            else:
                raise AssertionError("wrong bind derived")
        test("macho-refuse-wrong-bind-symbol", bind_symbol)

        def wrong_kind():
            result = copy.deepcopy(records["x86_64"])
            result["rendering_server"]["placeholder_kind"] = "null"
            verify(result, calibrate.open_image(str(binary), "x86_64"), 3, "refused: slot-mask-mismatch")
        test("macho-refuse-wrong-placeholder-kind", wrong_kind)

        for label, offset, fmt, value in (("fat-range", 16, ">I", 0xFFFFFF00),
                                          ("thin-magic", 0x1000, "<I", 0),
                                          ("load-command-size", 0x1000 + 36, "<I", 0),
                                          ("arm64e", None, "<I", 2)):
            def malformed():
                data = bytearray(binary.read_bytes())
                at = offset
                arch = "x86_64"
                if at is None:
                    arch = "arm64"
                    at = calibrate.open_image(str(binary), arch).slice_offset + 8
                struct.pack_into(fmt, data, at, value)
                path = root / "malformed"
                path.write_bytes(data)
                try:
                    calibrate.open_image(str(path), arch)
                except calibrate.CalibrationError:
                    return
                raise AssertionError("malformed Mach-O accepted")
            test(f"macho-refuse-{label}", malformed)

    print(f"macho self-test: {passed} passed, {failed} failed")
    return bool(failed)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


if __name__ == "__main__":
    raise SystemExit(main())
