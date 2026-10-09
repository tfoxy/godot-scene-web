#!/usr/bin/env bash
# Re-derive the committed calibration record for the pinned 4.5.1 template, and
# the uncommitted records for the other local templates.
#
# Usage: experiments/render-stream/scripts/calibrate.sh [--check]
#   --check  write the pinned record to a temporary file and diff it against the
#            committed one instead of overwriting it
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
ARTIFACTS="${REPO}/artifacts/render-stream/calibration"

if [[ "${1:-}" == "--check" ]]; then
  TEMP="$(mktemp)"
  trap 'rm -f "${TEMP}"' EXIT
  python3 "${CALIBRATE}" --binary "${PINNED_BINARY}" --header "${PINNED_HEADER}" --out "${TEMP}"
  diff -u "${PINNED_RECORD}" "${TEMP}" && echo "calibration record is up to date"
  exit $?
fi

python3 "${CALIBRATE}" --binary "${PINNED_BINARY}" --header "${PINNED_HEADER}" --out "${PINNED_RECORD}"

# Generalisation evidence. These records are not committed.
mkdir -p "${ARTIFACTS}"
TEMPLATES="${HOME}/.local/share/godot/export_templates"
if [[ -f "${TEMPLATES}/4.5.1.stable.mono/linux_debug.x86_64" ]]; then
  python3 "${CALIBRATE}" \
    --binary "${TEMPLATES}/4.5.1.stable.mono/linux_debug.x86_64" \
    --header "${PINNED_HEADER}" \
    --out "${ARTIFACTS}/godot-4.5.1-stable-mono-linux-debug.json"
fi
if [[ -f "${TEMPLATES}/4.6.2.stable/linux_release.x86_64" && -f "${SIBLINGS}/godot-4.6.2/servers/rendering/rendering_server.h" ]]; then
  python3 "${CALIBRATE}" \
    --binary "${TEMPLATES}/4.6.2.stable/linux_release.x86_64" \
    --header "${SIBLINGS}/godot-4.6.2/servers/rendering/rendering_server.h" \
    --out "${ARTIFACTS}/godot-4.6.2-stable-linux-release.json"
fi
# No 4.7 source is checked out locally, so only the measured mask is reported.
if [[ -f "${TEMPLATES}/4.7.2.stable/linux_release.x86_64" ]]; then
  python3 "${CALIBRATE}" --binary "${TEMPLATES}/4.7.2.stable/linux_release.x86_64" --mask-only \
    >"${ARTIFACTS}/godot-4.7.2-stable-linux-release.mask.txt"
  cat "${ARTIFACTS}/godot-4.7.2-stable-linux-release.mask.txt"
fi
