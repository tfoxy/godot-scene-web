#!/usr/bin/env bash
# Configure, build and unit-test the gate -1 capture library.
#
# Usage: experiments/render-stream/scripts/build-capture.sh [cmake build type]
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

BUILD_TYPE="${1:-RelWithDebInfo}"
CMAKE="${CMAKE:-/snap/bin/cmake}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$(cd "${HERE}/../capture" && pwd)"

"${CMAKE}" -S "${CAPTURE}" -B "${CAPTURE}/build" -DCMAKE_BUILD_TYPE="${BUILD_TYPE}"
"${CMAKE}" --build "${CAPTURE}/build" -j"$(nproc)"
(cd "${CAPTURE}/build" && ctest --output-on-failure)
# G8sha: which SHA-256 path this CPU dispatches to (payload hashes are bit-identical on both).
"${CAPTURE}/build/rs_sha256_bench" --which

echo
echo "library:      ${CAPTURE}/build/librender_stream_capture.so"
echo "gdextension:  ${CAPTURE}/build/render_stream_capture.gdextension"
