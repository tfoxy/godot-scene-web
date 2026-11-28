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
        consumer = attempt.index("const auto &scan = result.scan;")
        self.assertLess(attempt.index("if (g_state.identity_pending) return false;"), consumer)
        self.assertLess(consumer, attempt.index("check_slot_mask("))
        worker = attempt.split("auto result = compute_windows_image_digest(path, derived);", 1)[1]
        worker = worker.split("return result;", 1)[0]
        for forbidden in ("singleton_object", "check_behaviour", "check_slot_mask"):
            self.assertNotIn(forbidden, worker)
        self.assertIn("derive_live_identity(", worker)
        self.assertIn("CalibLiveReader reader(copy)", worker)
        self.assertIn("derive_live_scan(", worker)
        self.assertIn("g_identity_digest.stop_flag()", worker)
        self.assertLess(attempt.index("if (g_state.identity_pending) return false;"),
                        attempt.index("derive_live_calibration("))
        self.assertLess(attempt.index('return false;\n        } catch'),
                        attempt.index("derive_live_calibration("))
        self.assertIn("compute_windows_image_digest(path, derived)", attempt)
        self.assertIn("&error, g_state.fingerprint_async, &derive_times)", attempt)
        derive = attempt.split("if (!derive_ok)", 1)[1].split("g_state.derived_record", 1)[0]
        self.assertIn('refuse("derive-failed");', derive)

    def test_async_scan_has_no_synchronous_fallback_and_checks_vptr(self):
        attempt = ENTRY.split("bool attempt(const char *phase) {", 1)[1]
        consumer = attempt.split("const auto &scan = result.scan;", 1)[1]
        consumer = consumer.split("} else if (!load_abi_table(", 1)[0]
        self.assertNotIn("derive_live_calibration(", consumer)
        self.assertIn("vptr != result.derive_vptr", consumer)
        self.assertIn('fail("derive_vptr", "RenderingServer vptr changed during identity worker scan")', consumer)
        self.assertLess(consumer.index("vptr != result.derive_vptr"), consumer.index("g_state.calib = scan.calib"))

    def test_async_pe_derivation_never_falls_back_to_file_hash(self):
        live = (ROOT / "calib_live.cpp").read_text()
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

    def test_shutdown_latch_avoids_macos_11_atomic_wait_apis(self):
        digest = (ROOT / "rs_identity_digest.h").read_text()
        self.assertNotRegex(digest, r"stopped_\.(?:notify_all|notify_one|wait)\s*\(")

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
