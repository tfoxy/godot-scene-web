# carrier-ext fixture

A GDScript consumer carrier (`carrier_peer.gd`, autoload `CarrierPeer`) registers carrier `gdpeer`
through the capture's `RenderStreamCarrier` class, before the capture arms, and carries one live
session of a small animated scene (`carrier_ext.gd`). Gate 8's `g8l/ext` legs run it
(`scripts/run-gate8.sh run_g8l_ext`), and `g8l-ext-carried` compares the peer's `received.bin`
with the hub's tap of its connection.

Environment (set by the leg): `GRC_LIVE_CARRIERS=ws,gdpeer`, `GRC_ARM_DEFER_FRAMES=2` (the arm,
and so live start, after the peer registered), `GRC_DISARM_AFTER_FRAMES=60` (the stream ends while
the scene tree lives, so the peer gets the `end` record and the hub's close),
`RS_FIXTURE_QUIT_FRAME=300`, `RS_CARRIER_PEER_OUT=<dir>`, and for the sabotage leg
`RS_CARRIER_PEER_SABOTAGE=drop-one`. Import once with the editor (`--import`) before a run.
