#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -I "$SCRIPT_DIR/../../capture/tools/test/test_calibrate.py" "$@"
python3 -I "$SCRIPT_DIR/../../capture/tools/test/test_census.py" "$@"
