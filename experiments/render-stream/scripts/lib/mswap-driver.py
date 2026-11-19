#!/usr/bin/env python3
"""Run macOS swap legs through the portable swap driver and shared TypeScript judges."""
import importlib.util
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('wswap_driver', Path(__file__).with_name('wswap-driver.py'))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)


if __name__ == '__main__':
    try:
        sys.exit(portable.main(label='mswap', repo_env='MSWAP_REPO_ROOT', artifact_env='M_RUN_ARTIFACT_DIR'))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(f'FAIL mswap: {exc}', flush=True)
        sys.exit(1)
