#!/usr/bin/env bash
# Cross-build the raw GDExtension adapter for Windows x86_64 (no godot-cpp).
set -euo pipefail
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi
[[ $# = 0 ]] || { echo "usage: $0" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
source "$HERE/lib/llvm-mingw.sh"
# This build is offline except for the separately fetched official Godot template.
tool="$HOME/.cache/godot-render-stream/llvm-mingw"
tool="${GRC_LLVM_MINGW_CACHE:-$tool}/$LLVM_MINGW_TAG/${LLVM_MINGW_ASSET%.tar.xz}"
[[ -f "$tool/.grc-verified" && "$(cat "$tool/.grc-verified")" = "$LLVM_MINGW_SHA256" ]] || {
  echo 'missing verified llvm-mingw toolchain; install it before this build' >&2; exit 1;
}
llvm_mingw_ensure
BIN="$LLVM_MINGW_ROOT/bin"
CAPI="$RS/rs-core-capi"
OUT="$RS/receiver/ext/build/windows/x86_64"
# gnullvm uses llvm-mingw's UCRT and LLVM runtime rather than mixing GCC's
# libstdc++/libgcc with the adapter's libc++. Statically link libc++/libunwind
# so the installed client needs only Windows system DLLs, with no runtime bundle.
export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER="$BIN/x86_64-w64-mingw32-clang"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_RUSTFLAGS='-C target-feature=+crt-static'
CARGO_PROFILE_RELEASE_PANIC=abort cargo +stable build --offline --locked --release --lib \
  --target x86_64-pc-windows-gnullvm --manifest-path "$CAPI/Cargo.toml"
mkdir -p "$OUT"
# An explicit PE export avoids changing the shared adapter source for __declspec.
printf 'EXPORTS\nrs_core_ext_init\n' > "$OUT/exports.def"
"$BIN/x86_64-w64-mingw32-clang++" -std=c++20 -O2 -shared -static \
  -Wall -Wextra -Werror -I "$RS/capture/vendor" -I "$RS/receiver/ext" \
  "$RS/receiver/ext/rs_core_ext.cpp" "$OUT/exports.def" \
  "$CAPI/target/x86_64-pc-windows-gnullvm/release/librs_core_capi.a" \
  -Wl,--exclude-all-symbols -Wl,--gc-sections -Wl,--no-insert-timestamp \
  -lws2_32 -luserenv -lbcrypt -lntdll -o "$OUT/rs_core_ext.dll.tmp"
"$BIN/llvm-strip" --strip-all "$OUT/rs_core_ext.dll.tmp"
"$BIN/llvm-readobj" --coff-exports --coff-imports "$OUT/rs_core_ext.dll.tmp" > "$OUT/pe.txt"
python3 - "$OUT/pe.txt" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
exports = re.findall(r'Export \{.*?\n  Name: (\S+)', text, re.S)
assert exports == ['rs_core_ext_init'], exports
imports = re.findall(r'Import \{\n  Name: (\S+)', text)
assert imports, 'no PE imports inspected'
for name in imports:
    assert name.lower() in {'kernel32.dll', 'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'ntdll.dll',
                            'userenv.dll', 'ws2_32.dll', 'ucrtbase.dll',
                            'api-ms-win-core-synch-l1-2-0.dll'} or re.fullmatch(
                                r'api-ms-win-crt-[\w-]+\.dll', name.lower()), name
print('windows adapter: sole export rs_core_ext_init; imports: ' + ', '.join(imports))
PY
mv "$OUT/rs_core_ext.dll.tmp" "$OUT/rs_core_ext.dll"
llvm_mingw_record "$OUT/toolchain.json"
sha256sum "$OUT/rs_core_ext.dll"
