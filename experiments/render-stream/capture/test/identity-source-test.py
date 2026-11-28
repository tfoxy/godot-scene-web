#!/usr/bin/env python3
"""Guard the main-thread identity barrier and the event/shutdown integration."""
import os
from pathlib import Path
import unittest

ROOT = Path(os.environ.get("GRC_IDENTITY_SOURCE_ROOT", Path(__file__).resolve().parents[1] / "src"))
ENTRY = (ROOT / "entry.cpp").read_text()


class IdentitySource(unittest.TestCase):
    def test_pending_attempt_never_reaches_calibrated_checks(self):
        attempt = ENTRY.split("bool attempt(const char *phase) {", 1)[1]
        self.assertLess(attempt.index("if (g_state.identity_pending) return false;"),
                        attempt.index("check_fingerprint("))
        self.assertLess(attempt.index('return false;\n        } catch'),
                        attempt.index("check_slot_mask("))

    def test_derived_waits_for_identity_and_consumes_worker_digest(self):
        attempt = ENTRY.split("bool attempt(const char *phase) {", 1)[1]
        self.assertLess(attempt.index("if (g_state.identity_pending) return false;"),
                        attempt.index("derive_live_calibration("))
        self.assertLess(attempt.index('return false;\n        } catch'),
                        attempt.index("derive_live_calibration("))
        self.assertIn("compute_windows_image_digest(path, derived)", attempt)
        self.assertIn("[path, derived]", attempt)
        self.assertIn("&error, g_state.fingerprint_async)", attempt)
        derive = attempt.split("if (!derive_live_calibration(", 1)[1].split("g_state.derived_record", 1)[0]
        self.assertIn('refuse("derive-failed");', derive)

    def test_async_pe_derivation_never_falls_back_to_file_hash(self):
        live = (ROOT / "calib_live.cpp").read_text().split("bool derive_live_calibration(", 1)[1]
        guard = 'if (pe && require_exe_sha256 && fp.exe_sha256.empty())'
        self.assertIn(guard, live)
        self.assertLess(live.index(guard), live.index("CalibLiveReader reader(fp)"))
        self.assertIn('return fail("whole-file PE digest unavailable after identity worker")', live)
        self.assertIn("if (identity.sha256.empty()) identity.sha256 = sha256_file(fp.exe_path);", live)
        self.assertLess(live.index(guard), live.index("sha256_file(fp.exe_path)"))

    def test_frames_skip_identity_attempts_without_polling_worker(self):
        frame = ENTRY.split("void on_frame() {", 1)[1].split("void rearm_kept_release()", 1)[0]
        self.assertIn("if (g_state.identity_pending) return;", frame)
        self.assertLess(frame.index("if (g_state.identity_pending) return;"), frame.index('attempt("frame")'))
        self.assertNotIn("g_identity_digest.", frame)

    def test_completion_resumes_attempt_by_event(self):
        self.assertIn('attempt("identity");', ENTRY)
        self.assertIn("g_identity_event.post();", ENTRY)
        completion = ENTRY.split("if (!g_identity_digest.result(&result)) return;", 1)[1]
        completion = completion.split('attempt("identity");', 1)[0]
        self.assertIn("resolve_windows_image_digest(&g_state.fp, result, &g_state.fingerprint_error)",
                      completion)

    def test_both_shutdown_paths_join_before_engine_cleanup(self):
        for signature in ("void on_shutdown() {", "void deinitialize("):
            shutdown = ENTRY.split(signature, 1)[1]
            self.assertLess(shutdown.index("g_identity_digest.shutdown();"), shutdown.index("audio::shutdown();"))
        deinit = ENTRY.split("void deinitialize(", 1)[1]
        self.assertLess(deinit.index("g_identity_event.clear();"), deinit.index("cap::gd_capture_unregister();"))

    def test_linux_collector_keeps_synchronous_path(self):
        collector = (ROOT / "calib.cpp").read_text().split("bool defer_windows_digest) {", 1)[1]
        native = collector.split("#else", 1)[1].split("#endif", 1)[0]
        self.assertIn("collect_engine_fingerprint(out, error)", native)
        self.assertNotIn("metadata", native)

    def test_only_detached_windows_defers_the_digest(self):
        self.assertIn('collect_fingerprint(&g_state.fp, &error, g_state.mode == "detached")', ENTRY)
        self.assertIn("async_identity_digest(g_state.fp.platform, g_state.mode)", ENTRY)

    def test_unrequested_detached_completion_releases_standby(self):
        self.assertTrue(
            'if (g_api->attachment() == cap::Attachment::Detached) attachment_detach();' in ENTRY,
            'unrequested identity completion must release its standby publication')

    def test_deferred_callable_has_engine_lifetime_owner(self):
        event = (ROOT / "rs_identity_event.h").read_text()
        self.assertIn('StringName>("call_deferred")', event)
        self.assertIn("info.object_id = g_iface.object_get_instance_id(owner_);", event)
        self.assertIn("g_iface.object_destroy(owner_);", event)
        self.assertIn("!self.digest_->stopped()", event)


if __name__ == "__main__":
    unittest.main()
