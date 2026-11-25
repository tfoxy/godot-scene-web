#!/usr/bin/env python3
"""Regression checks for allocation ownership and snapshot boundaries."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

source = Path(os.environ.get("MEMORY_REPORT_SOURCE", Path(__file__).with_name("capture-memory-report.py")))
spec = importlib.util.spec_from_file_location("memory_report", source)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class AllocationReportTest(unittest.TestCase):
    def trace(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.log"
            path.write_text(text)
            return report.allocation_trace(path)

    def test_driver_caller_owns_malloc_even_with_capture_in_stack(self):
        result = self.trace("""ALLOC pid=1 ptr=0x100 bytes=16777216 phase=lean tid=2 thread=main
tracer(allocated)
tracer(malloc)
libnvidia-glcore.so(copy)
librender_stream_capture.so(readback)
""")
        self.assertEqual(result["samples"]["detached"]["driver"]["bytes"], 16777216)
        self.assertNotIn("capture", result["samples"]["detached"])

    def test_shutdown_free_does_not_erase_detached_snapshot(self):
        result = self.trace("""ALLOC pid=1 ptr=0x100 bytes=16777216 phase=lean tid=2 thread=main
tracer(allocated)
tracer(malloc)
libnvidia-glcore.so(copy)
FREE pid=1 ptr=0x100 phase=detached
""")
        self.assertEqual(result["samples"]["detached"]["driver"]["allocations"], 1)
        self.assertEqual(result["samples"]["lean"], {})

    def test_freed_capture_buffer_and_worker_identity(self):
        result = self.trace("""ALLOC pid=1 ptr=0x100 bytes=16777216 phase=lean tid=2 thread=grc-tex
tracer(allocated)
tracer(malloc)
libstdc++.so(operator new)
librender_stream_capture.so(decode)
FREE pid=1 ptr=0x100 phase=armed
""")
        self.assertEqual(result["samples"]["armed"]["capture"]["bytes"], 16777216)
        self.assertEqual(result["samples"]["detached"], {})
        self.assertEqual(result["worker_allocations"][0]["thread"], "grc-tex")

    def test_overflow_is_not_silently_incomplete_evidence(self):
        with self.assertRaisesRegex(ValueError, "overflowed"):
            self.trace("ERROR allocation trace capacity exceeded\n")

    def test_main_and_secondary_arena_deltas_stay_separate(self):
        lean = {"arenas": [{"system_bytes": 100, "free_bytes": 20, "in_use_bytes": 80}]}
        detached = {"arenas": [dict(lean["arenas"][0]),
                              {"system_bytes": 200, "free_bytes": 190, "in_use_bytes": 10}]}
        result = report.arena_delta(lean, detached)
        self.assertEqual(result["main"]["free_bytes"], 0)
        self.assertEqual(result["non_main"]["free_bytes"], 190)


if __name__ == "__main__":
    unittest.main()
