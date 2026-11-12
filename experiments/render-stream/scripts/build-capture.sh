#!/usr/bin/env bash
# Configure, build and unit-test the gate -1 capture library.
#
# Usage: experiments/render-stream/scripts/build-capture.sh [--target linux|windows|linux-libcxx] [cmake build type]
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

TARGET=linux
if [ "${1:-}" = --target ]; then
	[ "$#" -ge 2 ] || { echo 'build-capture: --target requires linux, windows or linux-libcxx' >&2; exit 2; }
	TARGET="$2"
	shift 2
fi
if [ "$#" -gt 1 ] || [[ "${1:-}" = --* ]] || [[ "$TARGET" != linux && "$TARGET" != windows && "$TARGET" != linux-libcxx ]]; then
	echo 'usage: build-capture.sh [--target linux|windows|linux-libcxx] [cmake build type]' >&2
	exit 2
fi
BUILD_TYPE="${1:-RelWithDebInfo}"
CMAKE="${CMAKE:-/snap/bin/cmake}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$(cd "${HERE}/../capture" && pwd)"

if [ "$TARGET" = linux-libcxx ]; then
	if ! command -v clang++-20 >/dev/null 2>&1; then
		echo 'build-capture: install clang-20 libc++-20-dev libc++abi-20-dev' >&2
		exit 2
	fi
	B="$CAPTURE/build-libcxx"
	"${CMAKE}" -S "$CAPTURE" -B "$B" \
		-DCMAKE_TOOLCHAIN_FILE="$CAPTURE/cmake/clang-libcxx-linux.cmake" \
		-DCMAKE_BUILD_TYPE="$BUILD_TYPE"
	"${CMAKE}" --build "$B" -j"$(nproc)"
	(cd "$B" && ctest --output-on-failure)
	exit 0
fi

if [ "$TARGET" = windows ]; then
	. "$HERE/lib/llvm-mingw.sh"
	llvm_mingw_ensure
	B="$CAPTURE/build-windows"
	"${CMAKE}" -S "$CAPTURE" -B "$B" \
		-DCMAKE_TOOLCHAIN_FILE="$CAPTURE/cmake/llvm-mingw-x86_64.cmake" \
		-DGRC_LLVM_MINGW_ROOT="$LLVM_MINGW_ROOT" \
		-DCMAKE_BUILD_TYPE="$BUILD_TYPE"
	"${CMAKE}" --build "$B" -j"$(nproc)"
	rm -rf "$B/bundle"
	python3 -I - "$B" "$HERE/.." "$LLVM_MINGW_ROOT/bin/llvm-strip" <<'PYBUNDLE'
import json, shutil, subprocess, sys
from pathlib import Path
build, rs = map(Path, sys.argv[1:3])
bundle = build / "bundle"
bundle.mkdir()
manifest = json.loads((build / "w-manifest.json").read_text())
exes = {entry["exe"] for key in ("tests", "imports_only", "sabotage") for entry in manifest[key]}
for exe in sorted(exes):
    if exe == "bin/calib_pe_self_test-rdata-sabotage.exe":
        continue
    dest = bundle / exe
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.argv[3], "--strip-debug", "-o", str(dest), str(build / exe)], check=True)
# Compute the identity on Ubuntu; Windows only collects and compares process facts.
tools = rs / "capture/tools"
identity = subprocess.check_output([sys.executable, "-I", str(tools / "calibrate.py"),
                                    "--pe-identity", str(bundle / "bin/calib_pe_self_test.exe")])
(bundle / "calib_pe_self_test.identity.json").write_bytes(identity)
sys.path.insert(0, str(tools))
from calibrate import Pe
image = Pe(str(bundle / "bin/calib_pe_self_test.exe"))
rdata = next(s for s in image.sections if s["name"] == ".rdata" and s["raw_size"])
sabotage = bytearray(image.data)
# Flip a raw padding byte so the program remains runnable; the image hash covers padding too.
if rdata["raw_size"] <= rdata["virtual_size"]:
    raise SystemExit("calib PE self-test has no .rdata padding byte for sabotage")
sabotage[rdata["offset"] + rdata["raw_size"] - 1] ^= 1
(bundle / "bin/calib_pe_self_test-rdata-sabotage.exe").write_bytes(sabotage)
for directory in manifest["data"]:
    shutil.copytree(rs / directory, bundle / directory)
shutil.copyfile(build / "w-manifest.json", bundle / "manifest.json")
shutil.copyfile(build / "render_stream_capture.gdextension", bundle / "render_stream_capture.gdextension")
PYBUNDLE
	llvm_mingw_record "$B/bundle/toolchain.json"
	python3 -I - "$B" "$HERE/w-imports.py" "$LLVM_MINGW_ROOT/bin/llvm-objdump" <<'PYIMPORTS'
import json, subprocess, sys
from pathlib import Path
build = Path(sys.argv[1])
bundle = build / "bundle"
m = json.loads((bundle / "manifest.json").read_text())
checker = [sys.executable, "-I", sys.argv[2], "--objdump", sys.argv[3]]
exes = [str(bundle / entry["exe"]) for key in ("tests", "imports_only") for entry in m[key]]
commands = [checker + ["--json", str(build / "w-imports.json"), *exes]]
for entry in m["imports_only"]:
    if "expect_exports" in entry:
        commands.append(checker + ["--expect-exports", ",".join(entry["expect_exports"]),
                                   str(bundle / entry["exe"])])
for entry in m["sabotage"]:
    commands.append(checker + ["--expect-disallowed", ",".join(entry["expect_disallowed"]),
                               str(bundle / entry["exe"])])
for command in commands:
    result = subprocess.run(command)
    if result.returncode:
        sys.exit(result.returncode)
PYIMPORTS
	python3 -I - "$B/bundle" <<'PYCOUNT'
import json, sys
from pathlib import Path
bundle = Path(sys.argv[1])
m = json.loads((bundle / "manifest.json").read_text())
print(f"windows bundle: {bundle}: {len(m['tests'])} tests, {len(m['imports_only'])} imports-only, {len(m['sabotage'])} imports sabotages")
PYCOUNT
	exit 0
fi

"${CMAKE}" -S "${CAPTURE}" -B "${CAPTURE}/build" -DCMAKE_BUILD_TYPE="${BUILD_TYPE}"
"${CMAKE}" --build "${CAPTURE}/build" -j"$(nproc)"
(cd "${CAPTURE}/build" && ctest --output-on-failure)
# G8sha: which SHA-256 path this CPU dispatches to (payload hashes are bit-identical on both).
"${CAPTURE}/build/rs_sha256_bench" --which

echo
echo "library:      ${CAPTURE}/build/librender_stream_capture.so"
echo "gdextension:  ${CAPTURE}/build/render_stream_capture.gdextension"
