# Vendored wtransport 0.7.2, patched for render-stream-wt/1

`wtransport/` is the crates.io release **wtransport 0.7.2** (MIT OR Apache-2.0, by Biagio Festa,
<https://github.com/BiagioFesta/wtransport>, upstream commit `d022a6ad5f6260cb526e06d8ca42d09516ce6440`,
`.crate` sha256 `b4273ce3157a3262a68665f8d3f20a0ac0c5b8a69ffd67f05ae986832ebec036`), with the
changes in `wtransport.patch` (a `diff -ru` against the pristine crate). `rs-net/Cargo.toml` points
`[patch.crates-io]` at it. Everything else in the dependency graph comes from crates.io, pinned by
`rs-net/Cargo.lock`. `Cargo.lock`, `Cargo.toml.orig` and `.cargo_vcs_info.json` were dropped from
the copy; `tokio`'s `time` feature was added to its manifest.

What the patch adds, and why (protocol/carrier-design.md Q4.1, Q4.5, "As built (CAR3)"):

1. **`Connection::close_session(code, reason)`**: CLOSE_WEBTRANSPORT_SESSION on the CONNECT
   stream, then FIN, acknowledged; the QUIC connection closes after. Upstream's only close is a QUIC
   CONNECTION_CLOSE, which a browser reports as a failed `closed` (1006 to our client) instead of
   `{closeCode, reason}`, so every host close code would be lost (Q4.5: codes map 1:1).
2. **The CONNECT stream and the peer's control stream are read in tasks of their own.** Upstream
   polls both from futures re-created on every iteration of the driver loop, so a frame split
   across two reads can be lost half-read. Seen in the crate tests: a client close arriving as a
   clean FIN (1005 instead of 4001), and a SETTINGS frame read from its middle, which either
   closed the connection `H3_EXCESSIVE_LOAD` (0x107) at connect or, when the garbage length looked
   plausible, left the session request waiting for SETTINGS forever (a hung connect). A close
   request made before the session is registered waits for it.
3. **The capsule wins over a QUIC close seen first.** A peer that sends the capsule and then closes
   the connection can make another branch of the driver notice the close first; the driver then
   waits (500 ms at most) for the CONNECT task's verdict.
4. **`Connection::session_closed()`**: the session's close as `Some((code, reason))` when it ended
   with a capsule (either side) and `None` when only QUIC closed (`closed()` conflates both).
5. **`SessionRequest::reject_with_status(u16)`**: any HTTP status (Q4.1's 400 and 503); upstream
   offers 403, 404 and 429 only.
6. **`ConnectingError::SessionRejectedStatus(u16)`**: the client sees the status (the crate tests).

To refresh: unpack the new crate, re-apply `wtransport.patch` by hand, run
`scripts/build-rs-net.sh` (the crate tests cover every patched path) and
`scripts/test/wt-chromium-smoke.ts` (the browser's view of item 1).
