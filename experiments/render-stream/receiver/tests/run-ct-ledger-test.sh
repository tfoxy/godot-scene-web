#!/usr/bin/env bash
# Godot-free test of the same ledger used by the executor, including a deliberately missing free.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../ext/build"
mkdir -p "$OUT"
"${CXX:-g++}" -std=c++20 -Wall -Wextra -Werror "$HERE/../ext/ct_ledger_test.cpp" -o "$OUT/ct-ledger-test"
"$OUT/ct-ledger-test"
