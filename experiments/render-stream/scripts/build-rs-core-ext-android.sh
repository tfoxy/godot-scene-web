#!/usr/bin/env bash
# Cross-build the raw GDExtension adapter for Android arm64 (no godot-cpp).
set -euo pipefail
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi
[[ $# = 0 ]] || { echo "usage: $0" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
NDK="${ANDROID_NDK_HOME:-${HOME}/.local/android-sdk/ndk/27.2.12479018}"
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CXX="$BIN/aarch64-linux-android24-clang++"
CAPI="$RS/rs-core-capi"
OUT="$RS/receiver/ext/build/android/arm64"
[[ -x "$CXX" ]] || { echo "missing Android NDK compiler: $CXX" >&2; exit 1; }
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android24-clang"
CARGO_PROFILE_RELEASE_PANIC=abort cargo +stable build --offline --locked --release --lib \
  --target aarch64-linux-android --manifest-path "$CAPI/Cargo.toml"
mkdir -p "$OUT"
# Hide both Rust and static libc++ symbols. bionic supplies pthread and dl itself.
cat > "$OUT/exports.map" <<'MAP'
{ global: rs_core_ext_init; local: *; };
MAP
"$CXX" -std=c++20 -O2 -fPIC -shared -fvisibility=hidden -static-libstdc++ \
  -Wall -Wextra -Werror -I "$RS/capture/vendor" -I "$RS/receiver/ext" \
  "$RS/receiver/ext/rs_core_ext.cpp" \
  "$CAPI/target/aarch64-linux-android/release/librs_core_capi.a" \
  -Wl,--version-script="$OUT/exports.map" -Wl,--exclude-libs,ALL -Wl,-z,defs \
  -Wl,--gc-sections -Wl,-z,max-page-size=16384 -lm -o "$OUT/librs_core_ext.so.tmp"
mv "$OUT/librs_core_ext.so.tmp" "$OUT/librs_core_ext.so"
file "$OUT/librs_core_ext.so" | tee "$OUT/file.txt"
grep -q 'ELF 64-bit LSB shared object, ARM aarch64' "$OUT/file.txt"
"$BIN/llvm-nm" -D --defined-only "$OUT/librs_core_ext.so" | tee "$OUT/exports.txt"
[[ "$(awk '{print $3}' "$OUT/exports.txt")" = rs_core_ext_init ]]
"$BIN/llvm-readelf" -d "$OUT/librs_core_ext.so" | tee "$OUT/dynamic.txt"
while read -r needed; do
  case "$needed" in libc.so|libm.so|libdl.so|liblog.so) ;;
    *) echo "unexpected Android dependency: $needed" >&2; exit 1 ;;
  esac
done < <(sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p' "$OUT/dynamic.txt")
sha256sum "$OUT/librs_core_ext.so"
echo "android adapter: aarch64, sole export rs_core_ext_init, system libraries only"
