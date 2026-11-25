#!/usr/bin/env bash
# Check the public source tree and the built optional host module, without an SDK.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$ROOT/experiments/render-stream/fmod/build/libgrc_fmod.so"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --lib) LIB="$2"; shift 2 ;;
    *) echo "check-fmod-licence: unknown argument $1" >&2; exit 2 ;;
  esac
done
python3 - "$ROOT" "$LIB" <<'PY'
import fnmatch
import pathlib
import re
import subprocess
import sys

root, lib = map(pathlib.Path, sys.argv[1:])
files = subprocess.check_output(
    ['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']
).decode().split('\0')
failures = []
include = re.compile(r'#\s*include\s*[<"]' + r'fmod[^>"\n]*[>"]', re.I)
private_symbol = 'get' + 'Globals'
bank_literal = re.compile(r"[\"'`][^\"'`\n]*\.bank\b")
bank_sources = {
    'experiments/render-stream/fmod/src/banks.cpp',
    'experiments/render-stream/fmod/src/pck.cpp',
    'experiments/render-stream/scripts/check-fmod-licence.sh',
    'experiments/render-stream/scripts/test/test-fmod-licence.py',
}
for name in sorted(set(files) - {''}):
    path = root / name
    if not path.is_file():
        continue
    base = path.name.lower()
    if (fnmatch.fnmatch(base, 'fmod*.h') or base == 'fmod' + '.cs'
            or base.endswith('.bank')
            or re.match(r'(?:lib)?fmod.*\.(?:so(?:\..*)?|a|lib|dll|dylib)$', base)):
        failures.append(f'{name}: forbidden SDK/library/bank asset')
    try:
        content = path.read_text()
    except (UnicodeError, OSError):
        continue
    for line, text in enumerate(content.splitlines(), 1):
        if include.search(text) or private_symbol in text:
            failures.append(f'{name}:{line}: forbidden SDK include/private API')
        if path.suffix in {'.cpp', '.cc', '.c', '.h', '.hpp', '.ts', '.js', '.mjs', '.gd', '.rs', '.py'} and name not in bank_sources and not name.startswith('experiments/render-stream/fmod/test/') and bank_literal.search(text):
            failures.append(f'{name}:{line}: bank reference in served route')
if not lib.is_file():
    failures.append(f'{lib}: build the module before checking dynamic dependencies')
else:
    result = subprocess.run(['readelf', '-d', str(lib)], capture_output=True, text=True)
    if result.returncode:
        failures.append(f'{lib}: readelf failed: {result.stderr.strip()}')
    for line in result.stdout.splitlines():
        if '(NEEDED)' in line and re.search(r'\bfmod|libfmod', line, re.I):
            failures.append(f'{lib}: forbidden FMOD NEEDED: {line.strip()}')
if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print('PASS FMOD licence: no SDK, banks, private API, served bank route or FMOD NEEDED')
PY
