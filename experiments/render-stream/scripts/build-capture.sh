#!/usr/bin/env bash
# Configure, build and unit-test the gate -1 capture library.
#
# Usage: experiments/render-stream/scripts/build-capture.sh [cmake build type]
set -euo pipefail

BUILD_TYPE="${1:-RelWithDebInfo}"
CMAKE="${CMAKE:-/snap/bin/cmake}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE="$(cd "${HERE}/../capture" && pwd)"

"${CMAKE}" -S "${CAPTURE}" -B "${CAPTURE}/build" -DCMAKE_BUILD_TYPE="${BUILD_TYPE}"
"${CMAKE}" --build "${CAPTURE}/build" -j"$(nproc)"
(cd "${CAPTURE}/build" && ctest --output-on-failure)

echo
echo "library:      ${CAPTURE}/build/librender_stream_capture.so"
echo "gdextension:  ${CAPTURE}/build/render_stream_capture.gdextension"
