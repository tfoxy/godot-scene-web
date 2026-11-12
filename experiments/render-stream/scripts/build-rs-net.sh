#!/usr/bin/env bash
# Build render-stream's net module: rs-net, a Rust cdylib on
# the stable toolchain (every crate from the local registry, pinned by rs-net/Cargo.lock; the
# patched wtransport is vendored in rs-net/vendor/), installed as
# capture/build/librender_stream_net.so -- beside librender_stream_capture.so, where the capture
# looks for it when GRC_LIVE_CARRIERS lists `wt` or GRC_LIVE_TLS_CERT is set (wss, CAR4; else
# GRC_LIVE_NET_MODULE). It exports grc_net_module_v1 and grc_net_tls_v1, nothing else. Also builds the
# wtransport probe client rs-net/target/release/rs-net-probe (scripts/test/self-test-wt-interop.ts)
# and, unless --no-test, runs the crate's tests (a wtransport client against an in-crate fake host).
#
# Usage: experiments/render-stream/scripts/build-rs-net.sh [--target linux|windows] [--no-test]
# Windows cross-builds the DLL and test executables (never runs them on the Linux host), writing
# capture/build-windows/rs-net/rs-net-build.json with their paths and the DLL's exports/imports.
# --target windows --manifest-template FILE also installs the test executables and merges them
# into w-manifest.json beside the capture manifest template for the Windows bundle builder.
# Honors CARGO_BUILD_JOBS. Writes capture/build/rs-net-build.json (toolchain, sha256, exports).
# Run it after build-capture.sh (which creates capture/build/); the capture does not need it unless
# a run lists `wt` or sets a TLS pair. Then rs_ws_test's wss cases run too (ctest skips them before).
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "${HERE}/.." && pwd)"
NET="${RS}/rs-net"
OUT="${RS}/capture/build"

test=1
target=linux
manifest_template=""
if [ "${1:-}" = --target ]; then
  [ "$#" -ge 2 ] || { echo 'build-rs-net: --target requires linux or windows' >&2; exit 2; }
  target="$2"
  shift 2
fi
if [ "$target" = windows ] && [ "${1:-}" = --manifest-template ]; then
  [ "$#" -eq 2 ] || { echo 'build-rs-net: --manifest-template requires a file' >&2; exit 2; }
  manifest_template="$2"
  shift 2
fi
if [ "$#" -gt 1 ] || [[ "$target" != linux && "$target" != windows ]]; then
  echo "usage: $0 [--target linux|windows] [--no-test]" >&2
  exit 2
fi
case "${1:-}" in
  --no-test) test=0 ;;
  "") ;;
  *) echo "usage: $0 [--target linux|windows] [--no-test]" >&2; exit 2 ;;
esac

if [ "$target" = windows ]; then
  . "$HERE/lib/llvm-mingw.sh"
  llvm_mingw_ensure
  OUT="$RS/capture/build-windows/rs-net"
  mkdir -p "$OUT"
  triple=x86_64-pc-windows-gnullvm
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER="$LLVM_MINGW_ROOT/bin/x86_64-w64-mingw32-clang"
  export CC_x86_64_pc_windows_gnullvm="$CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER"
  export AR_x86_64_pc_windows_gnullvm="$LLVM_MINGW_ROOT/bin/llvm-ar"
  # Keep the cross flags local to this invocation. -static also covers llvm-mingw's unwind and
  # compiler runtime; the PE import gate below proves that no runtime DLL escaped the link.
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_RUSTFLAGS='-C target-feature=+crt-static -C link-arg=-static'
  cargo build --offline --locked --release --target "$triple" --manifest-path "$NET/Cargo.toml"
  cargo test --offline --locked --release --no-run --target "$triple" \
    --manifest-path "$NET/Cargo.toml" --message-format=json >"$OUT/test-artifacts.jsonl"
  lib="$NET/target/$triple/release/render_stream_net.dll"
  python3 -I "$HERE/w-imports.py" --objdump "$LLVM_MINGW_ROOT/bin/llvm-objdump" \
    --expect-exports grc_net_module_v1,grc_net_tls_v1 --json "$OUT/w-imports.json" "$lib"
  install_tmp="$(mktemp "$OUT/render_stream_net.dll.XXXXXX")"
  trap 'rm -f "${install_tmp}"' EXIT
  cp "$lib" "$install_tmp"
  mv -f "$install_tmp" "$OUT/render_stream_net.dll"
  llvm_mingw_record "$OUT/toolchain.json"
  python3 -I - "$OUT" "$triple" "$(rustc --version)" "$(cargo --version)" "$manifest_template" <<'PYWINDOWS'
import hashlib, json, shutil, sys
from pathlib import Path
out = Path(sys.argv[1])
tests = {}
for line in (out / "test-artifacts.jsonl").read_text().splitlines():
    artifact = json.loads(line)
    if (artifact.get("reason") == "compiler-artifact" and
            artifact.get("profile", {}).get("test") and artifact.get("executable")):
        tests[artifact["executable"]] = dict(name=artifact["target"]["name"],
                                            path=artifact["executable"],
                                            kind=artifact["target"]["kind"])
if not tests:
    sys.exit("build-rs-net: cargo reported no Windows test executables")
library = out / "render_stream_net.dll"
imports = json.loads((out / "w-imports.json").read_text())["binaries"][0]
report = dict(schema="rs-net-build/1", target=sys.argv[2], rustc=sys.argv[3], cargo=sys.argv[4],
              toolchain=json.loads((out / "toolchain.json").read_text()), library=str(library),
              library_sha256=hashlib.sha256(library.read_bytes()).hexdigest(),
              library_bytes=library.stat().st_size, exports=imports["exports"],
              imports=imports["imports"], delay_imports=imports["delay_imports"],
              tests=sorted(tests.values(), key=lambda t: t["path"]))
(out / "rs-net-build.json").write_text(json.dumps(report, indent=2) + "\n")
if sys.argv[5]:
    template = Path(sys.argv[5])
    manifest = json.loads(template.read_text())
    # These are Cargo's test harnesses, including the loopback fake-host QUIC/TLS tests.
    # They need the same empty args/env as cargo test, with no browser or capture process.
    test_dir = out / "tests"
    test_dir.mkdir(exist_ok=True)
    for test in report["tests"]:
        dest = test_dir / Path(test["path"]).name
        shutil.copyfile(test["path"], dest)
        manifest["tests"].append(dict(name="rs-net-" + test["name"],
            exe=dest.relative_to(template.parent).as_posix(), args=[], env={}))
    manifest["imports_only"].append(dict(exe=library.relative_to(template.parent).as_posix(),
        why="Runtime-loaded net module.",
        expect_exports=["grc_net_module_v1", "grc_net_tls_v1"]))
    (template.parent / "w-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(report, indent=2))
PYWINDOWS
  exit 0
fi

cargo build --offline --locked --release --manifest-path "${NET}/Cargo.toml"
if [ "${test}" = 1 ]; then
  cargo test --offline --locked --release --manifest-path "${NET}/Cargo.toml"
fi

lib="${NET}/target/release/librender_stream_net.so"
# D17: the module exports only grc_net_* (rustc's cdylib version script exports the #[no_mangle]
# items alone; this keeps it that way, so it cannot collide with rs_core's Rust symbols).
exported="$(nm -D --defined-only "${lib}" | awk '{print $3}' | sort | tr '\n' ' ')"
for sym in ${exported}; do
  case "${sym}" in
    grc_net_*) ;;
    *) echo "build-rs-net: the module exports ${sym} (only grc_net_* allowed): ${exported}" >&2; exit 1 ;;
  esac
done
if [ "${exported}" != "grc_net_module_v1 grc_net_tls_v1 " ]; then
  echo "build-rs-net: unexpected export list: ${exported}" >&2
  exit 1
fi

mkdir -p "${OUT}"
install_tmp="$(mktemp "${OUT}/librender_stream_net.so.XXXXXX")"
trap 'rm -f "${install_tmp}"' EXIT
cp "${lib}" "${install_tmp}"
mv -f "${install_tmp}" "${OUT}/librender_stream_net.so"

cat >"${OUT}/rs-net-build.json" <<JSON
{
  "schema": "rs-net-build/1",
  "rustc": "$(rustc --version)",
  "cargo": "$(cargo --version)",
  "library": "${OUT}/librender_stream_net.so",
  "library_sha256": "$(sha256sum "${OUT}/librender_stream_net.so" | cut -d' ' -f1)",
  "library_bytes": $(stat -c %s "${OUT}/librender_stream_net.so"),
  "exports": "${exported% }",
  "probe": "${NET}/target/release/rs-net-probe"
}
JSON
cat "${OUT}/rs-net-build.json"
