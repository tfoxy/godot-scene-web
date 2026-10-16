## Safety model

- **Refusing by default.** No `GRC_CALIBRATION`, no action. Default `GRC_MODE` is
  `validate`, which never writes.
- **Identity before anything else.** sha256 of `/proc/self/exe`, the GNU build-id
  (required absent when the record says `null`), the `get_godot_version2` version
  string, PIE flag and load bias must all match the record; a PIE binary's bias
  is taken from `dl_iterate_phdr` and added to the recorded addresses.
- **No call into an unidentified slot, ever.** The live checks only _read_ vtable
  words. The one behavioural call is `get_default_clear_color`, which the record
  names, compared byte for byte against the same method reached through
  `classdb_get_method_bind` + `object_method_bind_ptrcall`. This is what proves
  the derived indices are real and not just self-consistent.
- **One write.** A single aligned pointer-sized store with release ordering into
  heap memory the engine allocated for the singleton. Nothing else in the process
  is modified: the library imports neither `mprotect` nor `mmap` (checked with
  `nm -D --undefined-only`), and an `strace` of an armed run shows no `mprotect`
  from the arming thread after the `armed.marker` `openat`.
- **Verified restore.** Disarm compares the live vptr with our shadow address
  point before restoring, and re-reads it afterwards; both facts land in
  `disarm.json`.
- **Failure is refusal, not a crash.** A missing `Image` method bind downgrades
  texture captures to counts only; a failed check refuses with a reason; the
  hooks hold no locks across the forwarded call except the small capture mutex,
  and counters are atomics because calls arrive from loader threads too.

What this does **not** establish:

- that the shipped game's stripped fork has the same vtable layout. It needs its
  own record, which is exactly what the calibrator is for.
- that the capture is complete. 55 of the 565 `RenderingServer` virtuals are
  hooked.
- anything about performance.

