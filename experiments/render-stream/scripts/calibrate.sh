#!/usr/bin/env bash
# Re-derive the committed calibration records for the pinned 4.5.1 templates, and
# the uncommitted records for the other local templates.
#
# Usage: experiments/render-stream/scripts/calibrate.sh [--check]
#   --check  write the pinned records to temporary files and diff them against the
#            committed ones instead of overwriting them
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT="$(cd "${HERE}/.." && pwd)"
REPO="$(cd "${EXPERIMENT}/../.." && pwd)"
CALIBRATE="${EXPERIMENT}/capture/tools/calibrate.py"

# Sibling checkouts live beside the main checkout, which is not this directory
# when the script runs from a worktree.
MAIN_CHECKOUT="$(dirname "$(git -C "${REPO}" rev-parse --path-format=absolute --git-common-dir)")"
SIBLINGS="$(cd "${MAIN_CHECKOUT}/.." && pwd)"

PINNED_BINARY="${GRC_TEMPLATE:-${HOME}/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64}"
PINNED_HEADER="${GRC_HEADER:-${SIBLINGS}/godot-4.5.1-stable/servers/rendering_server.h}"
PINNED_RECORD="${EXPERIMENT}/calibration/godot-4.5.1-stable-linux-release.json"
PINNED_WINDOWS_BINARY="${GRC_WINDOWS_TEMPLATE:-${HOME}/.cache/godot-render-stream/templates/4.5.1-stable/windows_release_x86_64.exe}"
PINNED_WINDOWS_RECORD="${EXPERIMENT}/calibration/godot-4.5.1-stable-windows-release.json"
ARTIFACTS="${REPO}/artifacts/render-stream/calibration"

bash "${HERE}/fetch-windows-template.sh"

if [[ "${1:-}" == "--check" ]]; then
  TEMP="$(mktemp -d)"
  trap 'rm -rf "${TEMP}"' EXIT
  for platform in linux windows; do
    BINARY="${PINNED_BINARY}"
    RECORD="${PINNED_RECORD}"
    if [[ "$platform" == windows ]]; then
      BINARY="${PINNED_WINDOWS_BINARY}"
      RECORD="${PINNED_WINDOWS_RECORD}"
    fi
    python3 -I "${CALIBRATE}" --binary "${BINARY}" --header "${PINNED_HEADER}" --out "${TEMP}/${platform}.json"
    diff -u "${RECORD}" "${TEMP}/${platform}.json"
    echo "calibration record is up to date: ${RECORD}"
  done
  exit 0
fi

python3 -I "${CALIBRATE}" --binary "${PINNED_BINARY}" --header "${PINNED_HEADER}" --out "${PINNED_RECORD}"
python3 -I "${CALIBRATE}" --binary "${PINNED_WINDOWS_BINARY}" --header "${PINNED_HEADER}" --out "${PINNED_WINDOWS_RECORD}"

# Generalisation evidence. These records are not committed.
mkdir -p "${ARTIFACTS}"
TEMPLATES="${HOME}/.local/share/godot/export_templates"
if [[ -f "${TEMPLATES}/4.5.1.stable.mono/linux_debug.x86_64" ]]; then
  python3 -I "${CALIBRATE}" \
    --binary "${TEMPLATES}/4.5.1.stable.mono/linux_debug.x86_64" \
    --header "${PINNED_HEADER}" \
    --out "${ARTIFACTS}/godot-4.5.1-stable-mono-linux-debug.json"
fi
if [[ -f "${TEMPLATES}/4.6.2.stable/linux_release.x86_64" && -f "${SIBLINGS}/godot-4.6.2/servers/rendering/rendering_server.h" ]]; then
  python3 -I "${CALIBRATE}" \
    --binary "${TEMPLATES}/4.6.2.stable/linux_release.x86_64" \
    --header "${SIBLINGS}/godot-4.6.2/servers/rendering/rendering_server.h" \
    --out "${ARTIFACTS}/godot-4.6.2-stable-linux-release.json"
fi
# No 4.7 source is checked out locally, so only the measured mask is reported.
if [[ -f "${TEMPLATES}/4.7.2.stable/linux_release.x86_64" ]]; then
  python3 -I "${CALIBRATE}" --binary "${TEMPLATES}/4.7.2.stable/linux_release.x86_64" --mask-only \
    >"${ARTIFACTS}/godot-4.7.2-stable-linux-release.mask.txt"
  cat "${ARTIFACTS}/godot-4.7.2-stable-linux-release.mask.txt"
fi
