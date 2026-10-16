#!/usr/bin/env bash
# Build the web export's adapter over the shared Rust core as an emscripten dlink side module
# (gate7-design.md G7xw, Q14e, D34, fork F4): rs-core-capi (the same Rust staticlib G7xn's native
# GDExtension links) for wasm32-unknown-emscripten with the pinned nightly's -Zbuild-std and
# -C relocation-model=pic, linked with the same C++ shim receiver/ext/rs_core_ext.cpp by emcc
# 4.0.11 into receiver/ext/build/web/librs_core_ext.wasm, the library rs_core.gdextension names
# for `web.wasm32`. build-web-receiver.sh --core rust puts it in the `Web (rust core)` export.
#
# Usage: experiments/render-stream/scripts/build-rs-core-web.sh
#
# F4: the nightly (RS_CORE_WEB_NIGHTLY, below) is used for this build only; stable 1.95.0 stays
# the toolchain for everything else. Its rust-src builds std position-independent, with
# panic=abort (the main module has no C++ exception runtime, so a core panic aborts the page,
# where the native adapter reports `internal`). std's own crates come from rust-src's
# library/Cargo.lock, rs-core-capi's from its Cargo.lock (--locked). Writes
# receiver/ext/build/web/build.json: the nightly's rustc -vV and channel-manifest component
# hashes, emcc's version, and each artifact's sha256.
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's or build-web-receiver.sh's hold it nests).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "${HERE}/.." && pwd)"
CAPI="${RS}/rs-core-capi"
EXT="${RS}/receiver/ext"
OUT="${EXT}/build/web"
NIGHTLY="${RS_CORE_WEB_NIGHTLY:-nightly-2025-10-15}"
TRIPLE="wasm32-unknown-emscripten"
EMSDK="${EMSDK_DIR:-${HOME}/.cache/godot-render-stream/emsdk}"
EXPECTED_EMCC="4.0.11"
TOOLCHAIN_DIR="${RUSTUP_HOME:-${HOME}/.rustup}/toolchains/${NIGHTLY}-x86_64-unknown-linux-gnu"
TARGET_DIR="${CAPI}/target/web"

case "${1:-}" in
  "") ;;
  *) echo "usage: $0" >&2; exit 2 ;;
esac

if [ ! -d "${TOOLCHAIN_DIR}/lib/rustlib/src/rust/library" ]; then
  echo "build-rs-core-web: ${NIGHTLY} with rust-src is not installed (F4: rustup toolchain install ${NIGHTLY} --profile minimal --component rust-src)" >&2
  exit 1
fi
if [ ! -f "${EMSDK}/emsdk_env.sh" ]; then
  echo "build-rs-core-web: emsdk is missing at ${EMSDK} (gate7-design.md Q13e)" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1
emcc_version="$(emcc --version | head -1)"
case "${emcc_version}" in
  *" ${EXPECTED_EMCC} "*) ;;
  *) echo "build-rs-core-web: emcc is not ${EXPECTED_EMCC}: ${emcc_version}" >&2; exit 1 ;;
esac

# The Rust staticlib: std rebuilt from rust-src, position-independent, panic=abort.
RUSTFLAGS="-C relocation-model=pic -C panic=abort -Z default-visibility=hidden" \
CARGO_PROFILE_RELEASE_PANIC=abort \
  cargo "+${NIGHTLY}" build --locked --release --lib \
  -Zbuild-std=std,panic_abort \
  --target "${TRIPLE}" --target-dir "${TARGET_DIR}" \
  --manifest-path "${CAPI}/Cargo.toml"
STATICLIB="${TARGET_DIR}/${TRIPLE}/release/librs_core_capi.a"

mkdir -p "${OUT}"
# The shim, as for native (G7xn) but for wasm32: -fno-exceptions/-fno-rtti like the engine,
# -fPIC for the side module. SIDE_MODULE=2 exports only rs_core_ext_init (Godot's dlopen +
# dlsym); everything else the module needs (libc, libc++, the GL JS library) comes from the
# template's MAIN_MODULE=1/EXPORT_ALL main module at load time. WASM_BIGINT as the engine.
em++ -std=c++20 -O2 -fPIC -fno-exceptions -fvisibility=hidden -Wall -Wextra -Werror \
  -I "${RS}/capture/vendor" -I "${EXT}" \
  -c "${EXT}/rs_core_ext.cpp" -o "${OUT}/rs_core_ext.o"
em++ -O2 -sSIDE_MODULE=2 -sWASM_BIGINT -sEXPORTED_FUNCTIONS=_rs_core_ext_init \
  "${OUT}/rs_core_ext.o" "${STATICLIB}" \
  -o "${OUT}/librs_core_ext.wasm.tmp"
mv "${OUT}/librs_core_ext.wasm.tmp" "${OUT}/librs_core_ext.wasm"

node "${HERE}/lib/wasm-side-module-info.mjs" "${OUT}/librs_core_ext.wasm" >"${OUT}/module-info.json"
exports="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.functionExports.filter((n)=>!n.startsWith("__wasm_")).join(" "))' "${OUT}/module-info.json")"
if [ "${exports}" != "rs_core_ext_init" ]; then
  echo "build-rs-core-web: the side module exports functions other than rs_core_ext_init (and the linker's __wasm_* hooks): ${exports}" >&2
  exit 1
fi

manifest="${TOOLCHAIN_DIR}/lib/rustlib/multirust-channel-manifest.toml"
components_json="$(python3 - "${manifest}" "${TOOLCHAIN_DIR}/lib/rustlib/components" <<'PY'
import json, sys, tomllib
manifest = tomllib.load(open(sys.argv[1], "rb"))
out = {}
for line in open(sys.argv[2]):
    name = line.strip()
    if not name:
        continue
    pkg, target = (name, "*") if name == "rust-src" else name.split("-x86_64-", 1)
    target = target if target == "*" else "x86_64-" + target
    t = manifest["pkg"][pkg]["target"][target]
    out[name] = {"version": manifest["pkg"][pkg]["version"], "xz_hash": t.get("xz_hash"), "hash": t.get("hash")}
print(json.dumps({"date": manifest["date"], "components": out}))
PY
)"

python3 - "${OUT}/build.json" <<PY
import json, sys
json.dump({
  "schema": "rs-core-web-build/1",
  "nightly": "${NIGHTLY}",
  "nightly_rustc_vV": """$(rustc "+${NIGHTLY}" -vV)""".strip().split("\n"),
  "nightly_cargo": "$(cargo "+${NIGHTLY}" --version)",
  "nightly_manifest": json.loads('''${components_json}'''),
  "rustflags": "-C relocation-model=pic -C panic=abort -Z default-visibility=hidden",
  "build_std": "std,panic_abort",
  "target": "${TRIPLE}",
  "emcc": "${emcc_version}",
  "staticlib": "${STATICLIB}",
  "staticlib_sha256": "$(sha256sum "${STATICLIB}" | cut -d' ' -f1)",
  "shim_object_sha256": "$(sha256sum "${OUT}/rs_core_ext.o" | cut -d' ' -f1)",
  "side_module": "${OUT}/librs_core_ext.wasm",
  "side_module_sha256": "$(sha256sum "${OUT}/librs_core_ext.wasm" | cut -d' ' -f1)",
  "side_module_bytes": $(stat -c %s "${OUT}/librs_core_ext.wasm"),
  "module_info": json.load(open("${OUT}/module-info.json")),
  "gdextension": "${EXT}/rs_core.gdextension",
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
cat "${OUT}/build.json"
