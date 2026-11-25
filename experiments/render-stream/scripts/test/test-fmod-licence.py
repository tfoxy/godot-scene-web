#!/usr/bin/env python3
"""Prove each licence scanner guard rejects a synthetic violation."""
from pathlib import Path
import subprocess
import sys
import tempfile

script, lib, scratch = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='licence-', dir=scratch) as temp:
    root = Path(temp)
    subprocess.run(['git', 'init', '-q', str(root)], check=True)

    def run(ok):
        result = subprocess.run([script, '--root', str(root), '--lib', lib],
                                capture_output=True, text=True)
        if (result.returncode == 0) != ok:
            raise AssertionError(result.stdout + result.stderr)

    run(True)
    positive = root / 'packages/x/src/values.ts'
    positive.parent.mkdir(parents=True, exist_ok=True)
    positive.write_text('bank.values();\n')
    run(True)
    cases = {
        'experiments/render-stream/capture/src/entry.cpp': 'serve("/audio.bank");\n',
        'packages/x/src/a.ts': "fetch('x.bank');\n",
        'fmod_test.h': '',
        'fmod.cs': '',
        'libfmod.so.14': '',
        'assets/example.bank': '',
        'source.cpp': '#' + 'include <' + 'fmod_studio.h>\n',
        'private.cpp': 'get' + 'Globals();\n',
        'server/routes.ts': "serve('asset" + ".bank');\n",
    }
    for name, text in cases.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        run(False)
        path.unlink()
    result = subprocess.run([script, '--root', str(root), '--lib', str(root / 'missing.so')],
                            capture_output=True, text=True)
    assert result.returncode != 0 and 'build the module' in result.stderr
    print(f'PASS licence scanner: clean tree + {len(cases)} violations + missing module')
