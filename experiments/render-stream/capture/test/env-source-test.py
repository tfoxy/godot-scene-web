#!/usr/bin/env python3
"""Capture sources read the environment through rs_platform only.

On Windows the C runtime's getenv and _environ are a copy taken at process start. A host that
sets a GRC_* setting in-process (SetEnvironmentVariableW, .NET's Environment) is visible only to
rs::env and rs::env_any_with_prefix, which read the process block. A raw read silently ignores
such a setting there while working on Linux.
"""
from pathlib import Path
import re
import unittest

SRC = Path(__file__).resolve().parents[1] / 'src'
RAW = re.compile(r'(?<![\w:])(?:std::)?(?:getenv|_wgetenv|secure_getenv)\s*\(|\b_?environ\b|_NSGetEnviron')


def stripped(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'//[^\n]*', '', text)
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', text)


class EnvSource(unittest.TestCase):
    def test_no_raw_environment_reads_outside_rs_platform(self):
        offenders = []
        for path in sorted(SRC.rglob('*')):
            if path.suffix not in ('.h', '.hpp', '.cpp', '.cc') or path.name.startswith('rs_platform'):
                continue
            for number, line in enumerate(stripped(path.read_text(errors='replace')).splitlines(), 1):
                if RAW.search(line):
                    offenders.append(f'{path.relative_to(SRC)}:{number}: {line.strip()}')
        self.assertEqual(offenders, [], 'read the environment through rs::env / rs::env_any_with_prefix')

    def test_pattern_catches_the_known_shapes(self):
        for line in ('const char *v = std::getenv("X");', 'getenv("X")', 'char **e = _environ;',
                     'char **e = environ;', 'char **e = *_NSGetEnviron();'):
            self.assertRegex(stripped(line), RAW)
        for line in ('rs::env("X")', 'env_utf8(name, &v)', '// std::getenv("X")', 'log("getenv(")'):
            self.assertNotRegex(stripped(line), RAW)


if __name__ == '__main__':
    unittest.main()
