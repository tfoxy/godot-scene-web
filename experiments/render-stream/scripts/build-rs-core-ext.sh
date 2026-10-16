#!/usr/bin/env bash
# Build the native receiver's GDExtension adapter over the shared Rust core (gate7-design.md G7xn,
# Q14e, D34): rs-core-capi (a Rust staticlib on the stable toolchain, every crate from the local
# registry) linked with the C++ shim receiver/ext/rs_core_ext.cpp (raw gdextension_interface.h,
# the capture's vendored copy; no godot-cpp) into receiver/ext/build/librs_core_ext.so, the
# library receiver/ext/rs_core.gdextension names. Also builds rs-core-capi-check, the
# Godot-free leg replay (rs-core-capi/src/bin/), and runs the crate's tests.
#
# Usage: experiments/render-stream/scripts/build-rs-core-ext.sh [--no-test]
# Honors CARGO_BUILD_JOBS and CXX. Writes receiver/ext/build/build.json (toolchains, sha256s).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "${HERE}/.." && pwd)"
CAPI="${RS}/rs-core-capi"
EXT="${RS}/receiver/ext"
OUT="${EXT}/build"
CXX="${CXX:-g++}"

test=1
case "${1:-}" in
  --no-test) test=0 ;;
  "") ;;
  *) echo "usage: $0 [--no-test]" >&2; exit 2 ;;
esac

cargo build --offline --release --manifest-path "${CAPI}/Cargo.toml"
if [ "${test}" = 1 ]; then
  cargo test --offline --release --manifest-path "${CAPI}/Cargo.toml"
fi

mkdir -p "${OUT}"
"${CXX}" -std=c++20 -O2 -fPIC -shared -fvisibility=hidden -fno-omit-frame-pointer \
  -Wall -Wextra -Werror \
  -I "${RS}/capture/vendor" -I "${EXT}" \
  "${EXT}/rs_core_ext.cpp" "${CAPI}/target/release/librs_core_capi.a" \
  -o "${OUT}/librs_core_ext.so.tmp" \
  -Wl,--exclude-libs,ALL -Wl,-z,defs -Wl,--gc-sections -lpthread -ldl -lm
mv "${OUT}/librs_core_ext.so.tmp" "${OUT}/librs_core_ext.so"

exported="$(nm -D --defined-only "${OUT}/librs_core_ext.so" | awk '{print $3}' | grep -v '^_' | sort | tr '\n' ' ')"
if [ "${exported}" != "rs_core_ext_init " ]; then
  echo "build-rs-core-ext: the library exports more than rs_core_ext_init: ${exported}" >&2
  exit 1
fi

cat >"${OUT}/build.json" <<EOF
{
  "schema": "rs-core-ext-build/1",
  "rustc": "$(rustc --version)",
  "cargo": "$(cargo --version)",
  "cxx": "$("${CXX}" --version | head -1)",
  "staticlib_sha256": "$(sha256sum "${CAPI}/target/release/librs_core_capi.a" | cut -d' ' -f1)",
  "library": "${OUT}/librs_core_ext.so",
  "library_sha256": "$(sha256sum "${OUT}/librs_core_ext.so" | cut -d' ' -f1)",
  "gdextension": "${EXT}/rs_core.gdextension"
}
EOF
cat "${OUT}/build.json"
