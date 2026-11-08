#!/usr/bin/env bash
# The digest-pinned Linux-hosted llvm-mingw toolchain. May also be sourced by build scripts.
LLVM_MINGW_TAG=20250709
LLVM_MINGW_ASSET=llvm-mingw-20250709-ucrt-ubuntu-22.04-x86_64.tar.xz
LLVM_MINGW_SHA256=60cafae6474c7411174cff1d4ba21a8e46cadbaeb05a1bace306add301628337
LLVM_MINGW_URL="https://github.com/mstorsjo/llvm-mingw/releases/download/$LLVM_MINGW_TAG/$LLVM_MINGW_ASSET"
LLVM_MINGW_CLANG="clang version 20.1.8"

llvm_mingw_ensure() {
	if [ "$(uname -sm)" != 'Linux x86_64' ]; then
		echo 'llvm-mingw: requires Linux x86_64' >&2
		return 1
	fi
	local base="${GRC_LLVM_MINGW_CACHE:-$HOME/.cache/godot-render-stream/llvm-mingw}"
	local dir="$base/$LLVM_MINGW_TAG"
	local root="$dir/${LLVM_MINGW_ASSET%.tar.xz}"
	mkdir -p "$dir" || return 1
	(
		flock -x 9 || exit 1
		local tarball="$dir/$LLVM_MINGW_ASSET" state=cached got version
		if [ ! -f "$root/.grc-verified" ] || [ "$(cat "$root/.grc-verified")" != "$LLVM_MINGW_SHA256" ]; then
			if [ ! -f "$tarball" ]; then
				curl -fL --retry 3 --retry-delay 2 -o "$tarball.part" "$LLVM_MINGW_URL" || exit 1
				mv "$tarball.part" "$tarball" || exit 1
				state=downloaded
			fi
			got=$(sha256sum <"$tarball") || exit 1
			got=${got%% *}
			if [ "$got" != "$LLVM_MINGW_SHA256" ]; then
				rm -f "$tarball"
				echo "llvm-mingw: sha256 mismatch for $LLVM_MINGW_ASSET: got $got, want $LLVM_MINGW_SHA256" >&2
				exit 1
			fi
			rm -rf "$root" "$dir/x.tmp" || exit 1
			mkdir -p "$dir/x.tmp" || exit 1
			tar -xJf "$tarball" -C "$dir/x.tmp" || exit 1
			mv "$dir/x.tmp/${LLVM_MINGW_ASSET%.tar.xz}" "$root" || exit 1
			version=$("$root/bin/x86_64-w64-mingw32-clang++" --version) || exit 1
			version=${version%%$'\n'*}
			if [[ "$version" != *"$LLVM_MINGW_CLANG"* ]]; then
				echo "llvm-mingw: unexpected clang version: $version (want $LLVM_MINGW_CLANG)" >&2
				exit 1
			fi
			printf '%s\n' "$LLVM_MINGW_SHA256" >"$root/.grc-verified" || exit 1
		fi
		echo "llvm-mingw: $LLVM_MINGW_TAG sha256 $LLVM_MINGW_SHA256 at $root ($state)" >&2
	) 9>"$dir.lock" || return 1
	export LLVM_MINGW_ROOT="$root" LLVM_MINGW_TAG LLVM_MINGW_SHA256
}

llvm_mingw_record() {
	[ "$#" -eq 1 ] || return 2
	[ -n "${LLVM_MINGW_ROOT:-}" ] || llvm_mingw_ensure || return 1
	local version
	version=$("$LLVM_MINGW_ROOT/bin/x86_64-w64-mingw32-clang++" --version) || return 1
	python3 -I - "$1" "$LLVM_MINGW_TAG" "$LLVM_MINGW_ASSET" "$LLVM_MINGW_SHA256" "${version%%$'\n'*}" <<'PY'
import json, sys
path, tag, asset, sha, clang = sys.argv[1:]
with open(path, "w", encoding="utf-8") as f:
    json.dump(dict(schema="render-stream-toolchain/1", name="llvm-mingw", tag=tag,
                   asset=asset, sha256=sha, clang=clang), f, indent=2)
    f.write("\n")
PY
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	set -euo pipefail
	case "${1:-}" in
	--ensure)
		[ "$#" -eq 1 ] || exit 2
		llvm_mingw_ensure
		printf '%s\n' "$LLVM_MINGW_ROOT"
		;;
	--print-pin)
		[ "$#" -eq 1 ] || exit 2
		printf 'tag=%s\nasset=%s\nsha256=%s\ndir=%s\n' "$LLVM_MINGW_TAG" "$LLVM_MINGW_ASSET" \
			"$LLVM_MINGW_SHA256" "${GRC_LLVM_MINGW_CACHE:-$HOME/.cache/godot-render-stream/llvm-mingw}/$LLVM_MINGW_TAG"
		;;
	--record)
		[ "$#" -eq 2 ] || exit 2
		llvm_mingw_record "$2"
		;;
	*) echo 'usage: llvm-mingw.sh --ensure | --print-pin | --record FILE' >&2; exit 2 ;;
	esac
fi
