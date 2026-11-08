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
# Usage: experiments/render-stream/scripts/build-rs-net.sh [--no-test]
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
case "${1:-}" in
  --no-test) test=0 ;;
  "") ;;
  *) echo "usage: $0 [--no-test]" >&2; exit 2 ;;
esac

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
