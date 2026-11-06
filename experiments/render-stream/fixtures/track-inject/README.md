# track-inject fixture (TRK6)

A stock project: no script receiver, no `gsw_input` addon. With `GRC_LIVE_TRACK_INPUT_INJECT=reference`
the capture itself is the `input` track receiver (an embedded copy of the gsw-input/1 reference
injector, `../../protocol/tracks-design.md` Q6 and "As built (TRK6)") and adds a node named
`RsTrackInputInjector` under the root. This project only watches: `track_inject.gd` (autoload
`TrackInject`) finds the node, connects its `opened`, `received` and `closed` signals and logs them,
every change of the watched Input state (keys W, A, S, the left mouse button) and the test Control's
`gui_input`, in the same one-JSON-object-per-line format as `../track-input` (`RS_TRACK_INPUT_LOG`).
It never logs a payload.

The control file `unbind` frees the injector node (the receiver goes away: the no-receiver phase);
`quit` ends the run. `RS_FIXTURE_QUIT_FRAME` is the backstop. Gate 8's `g8l/inject` legs run it
(`scripts/run-gate8.sh run_g8l_inject`) under the TRK2 Node track client, and
`scripts/lib/gate8-track-checks.ts` judges them (`g8l-trk-inject-*`). `../track-inject-addon` is this
project beside the project's own copy of the addon.
