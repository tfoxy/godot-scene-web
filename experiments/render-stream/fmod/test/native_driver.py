#!/usr/bin/env python3
"""Synthetic packages stay in the build tree; each ABI test gets a fresh process."""
import os
from pathlib import Path
import struct
import subprocess
import sys

exe, module, fake, scratch, mode = sys.argv[1:]
v = bytearray(struct.pack('<6IQQ', 0x43504447, 3, 4, 5, 1, 0, 512, 100))
v.extend(bytes(100 - len(v)))
v.extend(struct.pack('<I', 2))
for name in [b'res://audio/Master.strings.bank', b'res://audio/Master.bank']:
    v.extend(struct.pack('<I', len(name)) + name)
    v.extend(struct.pack('<QQ', 0, 8) + bytes(range(16)) + struct.pack('<I', 0))
v.extend(bytes(512 - len(v)) + b'abcdefgh')
pck = Path(scratch) / (mode + '.pck')
pck.write_bytes(v)
env = dict(os.environ)
env.pop('GRC_FAKE_MODE', None)
env.pop('GRC_FAKE_VERSION', None)
reason = ''
if mode.startswith('source-') and mode not in ('source-ok', 'source-late'):
    reason = 'bank-load'
elif mode == 'not-loaded':
    reason = 'fmod-not-loaded'
elif mode == 'patch':
    env['GRC_FAKE_VERSION'] = '00020309'
elif mode == 'outside':
    env['GRC_FAKE_MODE'] = 'outside'
    env['GRC_FAKE_VERSION'] = '00020400'
    reason = 'version'
elif mode == 'retry':
    env['GRC_FAKE_MODE'] = 'retry'
    env['GRC_FAKE_VERSION'] = '00020309'
    reason = 'version'
elif mode in ('create', 'bank'):
    env['GRC_FAKE_MODE'] = mode
    reason = 'create' if mode == 'create' else 'bank-load'
args = ([exe, module, "fake", scratch, fake, str(pck)] if mode == "endpoint"
        else [exe, module, mode, fake, fake, str(pck), reason])
result = subprocess.run(args, env=env)
pck.unlink()
sys.exit(result.returncode)
