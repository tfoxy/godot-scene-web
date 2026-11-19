#!/usr/bin/env bash
# Configure, build and unit-test the gate -1 capture library.
#
# Usage: experiments/render-stream/scripts/build-capture.sh [--target linux|windows|linux-libcxx|macos] [cmake build type]
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
# quiet.sh uses Linux procfs; native macOS CI builds need no workstation timing lock.
if [ "${2:-}" != macos ] && [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

TARGET=linux
if [ "${1:-}" = --target ]; then
	[ "$#" -ge 2 ] || { echo 'build-capture: --target requires linux, windows, linux-libcxx or macos' >&2; exit 2; }
	TARGET="$2"
	shift 2
fi
if [ "$#" -gt 1 ] || [[ "${1:-}" = --* ]] || [[ "$TARGET" != linux && "$TARGET" != windows && "$TARGET" != linux-libcxx && "$TARGET" != macos ]]; then
	echo 'usage: build-capture.sh [--target linux|windows|linux-libcxx|macos] [cmake build type]' >&2
	exit 2
fi
BUILD_TYPE="${1:-RelWithDebInfo}"
CMAKE="${CMAKE:-/snap/bin/cmake}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$(cd "${HERE}/../capture" && pwd)"

if [ "$TARGET" = macos ]; then
	if [ "$(uname -s)" != Darwin ]; then
		echo 'build-capture: --target macos requires a macOS host with Apple clang and the Xcode SDK; cross-building is not supported' >&2
		exit 2
	fi
	CMAKE="${CMAKE:-cmake}"
	# The Linux default above is intentionally unchanged.
	[ "$CMAKE" != /snap/bin/cmake ] || CMAKE=cmake
	B="$CAPTURE/build/macos"
	JOBS="$(sysctl -n hw.ncpu)"
	for arch in arm64 x86_64; do
		minimum=10.15
		[ "$arch" != arm64 ] || minimum=11.0
		"${CMAKE}" -S "$CAPTURE" -B "$B/$arch" \
			-DCMAKE_C_COMPILER="$(xcrun --find clang)" \
			-DCMAKE_CXX_COMPILER="$(xcrun --find clang++)" \
			-DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET="$minimum" \
			-DCMAKE_BUILD_TYPE="$BUILD_TYPE"
		"${CMAKE}" --build "$B/$arch" -j"$JOBS" -- -k
	done
	# Run the native slice only: an Intel runner cannot execute arm64, and a Rosetta run on an
	# arm64 runner is not evidence for the native Intel calling convention.
	native_arch="$(uname -m)"
	mkdir -p "$B/bundle/bin"
	for thin in "$B/arm64/bin/"*; do
		name="$(basename "$thin")"
		lipo -create "$thin" "$B/x86_64/bin/$name" -output "$B/bundle/bin/$name"
		lipo "$B/bundle/bin/$name" -verify_arch arm64 x86_64
		codesign -s - --force "$B/bundle/bin/$name"
		codesign --verify --strict "$B/bundle/bin/$name"
	done
	# Use the native slice's expectations (including the ABI sabotage), but exercise the signed
	# universal executables that ship in the bundle. Golden inputs remain in this checkout.
	python3 - "$B/$native_arch/CTestTestfile.cmake" "$B/bundle/CTestTestfile.cmake" \
		"$B/$native_arch/bin/" "$B/bundle/bin/" <<'PYCTEST'
from pathlib import Path
import sys
source, destination, thin, universal = sys.argv[1:]
Path(destination).write_text(Path(source).read_text().replace(thin, universal))
PYCTEST
	ctest --test-dir "$B/bundle" --output-on-failure --output-junit "$B/bundle/ctest.xml"
	lipo -create "$B/arm64/librender_stream_capture.dylib" \
		"$B/x86_64/librender_stream_capture.dylib" -output "$B/bundle/librender_stream_capture.dylib"
	lipo "$B/bundle/librender_stream_capture.dylib" -verify_arch arm64 x86_64
	codesign -s - --force "$B/bundle/librender_stream_capture.dylib"
	codesign --verify --strict "$B/bundle/librender_stream_capture.dylib"
	cp "$B/$native_arch/render_stream_capture.gdextension" "$B/bundle/"
	{
		xcodebuild -version
		xcrun --show-sdk-version
		xcrun clang++ --version
		printf 'runner_image=%s\nrunner_image_version=%s\n' "${ImageOS:-local}" "${ImageVersion:-local}"
	} >"$B/bundle/build-info.txt"
	echo "macos bundle: $B/bundle"
	exit 0
fi

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
import hashlib, json, shutil, subprocess, sys
from pathlib import Path
build, rs = map(Path, sys.argv[1:3])
bundle = build / "bundle"
bundle.mkdir()
manifest = json.loads((build / "w-manifest.json").read_text())
exes = {entry["exe"] for key in ("tests", "imports_only", "sabotage") for entry in manifest[key]
        if "interpreter" not in entry}
for exe in sorted(exes):
    if exe == "bin/calib_pe_self_test-rdata-sabotage.exe":
        continue
    dest = bundle / exe
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.argv[3], "--strip-debug", "-o", str(dest), str(build / exe)], check=True)
for entry in manifest.get("files", []):
    dest = bundle / entry["path"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(build / entry["path"], dest)
# The runtime module lives beside the capture DLL and test hosts in the product layout.
net = bundle / "rs-net/render_stream_net.dll"
beside = bundle / "bin/render_stream_net.dll"
shutil.copyfile(net, beside)
assert hashlib.sha256(net.read_bytes()).digest() == hashlib.sha256(beside.read_bytes()).digest()
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
	bash "$HERE/fetch-windows-template.sh"
	python3 -I "$HERE/lib/w1-bundle.py" --target windows --out "$B/bundle"
	python3 -I "$HERE/lib/wfile-bundle.py" --target windows --out "$B/bundle"
	python3 -I "$HERE/lib/wlive-bundle.py" --target windows --out "$B/bundle"
	python3 -I "$HERE/lib/wswap-bundle.py" --target windows --out "$B/bundle"
	# The Python-only hosted probe fetches Chrome on Windows; never put Chrome in the bundle.
	python3 -I - "$B/bundle" "$HERE" <<'PYPROBE'
import json, shutil, sys
from pathlib import Path
bundle, scripts = map(Path, sys.argv[1:])
probe = bundle / "wlive"
probe.mkdir(exist_ok=True)
shutil.copyfile(scripts / "fetch-cft-windows.py", probe / "fetch-cft-windows.py")
shutil.copyfile(scripts / "lib/wlive-probe.html", probe / "wlive-probe.html")
manifest_path = bundle / "manifest.json"
manifest = json.loads(manifest_path.read_text())
manifest["tests"].append({"name": "wlive-probe", "exe": "wlive/fetch-cft-windows.py",
                          "interpreter": "python", "args": ["--probe", "wlive/wlive-probe.html"], "env": {}})
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
size = sum(p.stat().st_size for p in bundle.rglob("*") if p.is_file())
if size > 300_000_000:
    raise ValueError(f"bundle exceeds 300 MB: {size} bytes")
print(f"wlive-probe bundle: total bundle bytes={size}")
PYPROBE
	python3 -I - "$B" "$HERE/w-imports.py" "$LLVM_MINGW_ROOT/bin/llvm-objdump" <<'PYIMPORTS'
import json, subprocess, sys
from pathlib import Path
build = Path(sys.argv[1])
bundle = build / "bundle"
m = json.loads((bundle / "manifest.json").read_text())
checker = [sys.executable, "-I", sys.argv[2], "--objdump", sys.argv[3]]
exes = [str(bundle / entry["exe"]) for key in ("tests", "imports_only") for entry in m[key]
        if "interpreter" not in entry]
commands = [checker + ["--json", str(build / "w-imports.json"), *exes]]
for entry in m["imports_only"]:
    if "interpreter" not in entry and "expect_exports" in entry:
        commands.append(checker + ["--expect-exports", ",".join(entry["expect_exports"]),
                                   str(bundle / entry["exe"])])
for entry in m["sabotage"]:
    if "interpreter" in entry:
        continue
    commands.append(checker + ["--expect-disallowed", ",".join(entry["expect_disallowed"]),
                               str(bundle / entry["exe"])])
for command in commands:
    print("w-imports argv: " + json.dumps(command), flush=True)
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
print(f"windows bundle: {sum('interpreter' in entry for entry in m['tests'])} interpreter tests")
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
