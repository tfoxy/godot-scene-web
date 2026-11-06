# track-input fixture (TRK2)

A GDScript receiver of the `input` track kind (`track_input.gd`, autoload `TrackInput`) binds the
kind through the capture's `RenderStreamTrack` class before the capture arms, and wires it to the
gsw-input/1 reference injector (`GswInputInjectorNode`) exactly as
`../../protocol/tracks-design.md` Q6 shows: `message` goes to `injector.receive(source, text)`,
`closed` to `injector.close_channel(source)`. The main scene holds one test Control (`Target`,
120x60 at 100,80). Gate 8's `g8l/trk` legs run it (`scripts/run-gate8.sh run_g8l_trk`) under the
Node track client `scripts/lib/track-input-client.ts`, and `scripts/lib/gate8-track-checks.ts`
judges them (`g8l-trk-*`). See the design's "As built (TRK2)".

`addons/gsw_input` is a symbolic link to `packages/input/godot/addons/gsw_input`, so the fixture
always runs the reference injector as committed. Import once with the editor (`--import`) before a
run; the leg does.

Environment (set by the leg): `GRC_LIVE_TRACKS=input`, `GRC_LIVE_TRACK_KEEPALIVE_MS=250` (the idle
close after 750 ms), `GRC_ARM_DEFER_FRAMES=2` (the bind happens while the receiver is `waiting`),
`RS_TRACK_INPUT_LOG=<file>` (one JSON object per line: the class contract, every signal and every
change of the watched Input state, each with its process frame; never a payload),
`RS_TRACK_INPUT_CONTROL=<dir>` (the client writes `unbind`, then `quit`), `RS_FIXTURE_QUIT_FRAME`
(the backstop, 3600), and for a sabotage leg `RS_TRACK_INPUT_SABOTAGE=drop-messages`, `keep-held`
or `stay-bound` (or the capture's `GRC_SABOTAGE=track-no-release`).
