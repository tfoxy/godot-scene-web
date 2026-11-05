# Chrome on Android: a WebTransport stream stops sending

A standalone repro for a Chrome on Android defect, filed upstream as a comment on
<https://issues.chromium.org/issues/473215415>. It is independent of the rest of this repository: a
single-file Rust server on the upstream [`wtransport`](https://crates.io/crates/wtransport) crate
(0.7.2, no patches) and one HTML page with inline JavaScript, which the server serves itself.

## The defect

A page opens a WebTransport session and one bidirectional stream, and writes short messages on it
for a long time. After a few seconds, the stream's send side stops putting data on the wire:

- every `writer.write()` still resolves, and `writer.desiredSize` stays positive (1);
- `writer.close()` never settles;
- the server never receives the bytes written after the wedge;
- the QUIC connection stays healthy, and a new bidirectional stream opened on the same session
  during the wedge works.

## What the repro does

The page opens the session with `serverCertificateHashes` and one bidirectional stream, and the
two sides run a lockstep on it. Every message, both ways, is framed `u8 kind (0 binary, 1 text) |
u32le length | bytes`.

- **Server:** sends a 2000-byte binary message every 16 ms while fewer than 2 are unanswered.
- **Page:** answers each message with short JSON texts (about 110 bytes framed), each one
  `writer.write()`. The server counts a message as answered by its `applied` text. The page's
  query string picks the pattern:
  - `?pattern=raf` (default): `received` and `applied` back to back as the message arrives, then
    `submitted` on the next animation frame. This is what the client this repro comes from does.
  - `?pattern=burst&writes=N`: N writes back to back as the message arrives.
  - `?pattern=spread&writes=N&gap=MS`: N writes, each in a task of its own, MS ms apart
    (default 4).
- **Stall:** the server reports a stall when no answer arrives for 5 s while one is owed. The page
  shows live counters: messages received, answers written, answers settled, `desiredSize`, and the
  time of the last message.
- **After a stall** (no message for 3 s), the page probes three fresh bidirectional streams. Each
  probe sends the page's counters to the server, which prints them and answers `probe-ok`. Then the
  page calls `writer.close()` on the lockstep stream and shows whether it settles. Buttons do the
  same by hand; `?auto=0` turns the automatic probes off.

The server prints QUIC statistics (quinn's) every second: RTT, lost packets, datagrams, and the
STREAM, ACK and PING frames received. `--trace FILE` writes quinn's frame-level trace.

## Run it

You need a Rust toolchain, `adb`, and an Android phone with USB debugging on, on the same Wi-Fi as
the host. The page is served over `adb reverse`, so it is a secure context at `http://localhost`.
The WebTransport session goes over Wi-Fi to the host's LAN address (adb reverse carries no UDP).

```
cargo build --release
./target/release/chromium-wt-send-wedge --lan <host LAN IP> --trace server-trace.txt
adb reverse tcp:8080 tcp:8080
# on the phone, in Chrome: http://localhost:8080/
```

Options: `--wt-port 4433` (UDP, on the LAN address), `--http-port 8080` (TCP, on 127.0.0.1),
`--size 2000`, `--interval-ms 16`, `--window 2`, `--stall-s 5`, `--hold-s 30` (how long to keep
the session after a stall, for probing by hand), `--seconds 120` (a run without a stall ends
there). The certificate is a fresh self-signed ECDSA P-256 one, valid 14 days; the server prints
its SHA-256 and puts it in the page. Exit status: 1 on a stall, 0 without one.

Afterwards: `adb reverse --remove tcp:8080`.

## Expected output

A stalled run prints, for example (abridged):

```
   1.430 lockstep stream 4 opened, hello {"hello":1,"pattern":"raf","writes":3,...}
   6.961 PROBE new stream 8 read to FIN, answered probe-ok (sent): {"probe":1,"page":{"received":134,"written":402,"settled":402,"rejected":0,"desiredSize":1,"close":"not called"}}
   8.536 STALL: no answer for 5 s while 2 of 134 messages are unanswered. Answers so far: 132 (texts 397, 43202 bytes). ...
   8.536 STALL quic: rtt=2ms lost_pkts=0 udp_rx=454 udp_tx=412 rx_frames[stream=357 ack=145 ping=10 ...] ...
  28.538 RESULT stall: 132/134 answered; the last answer came 2.1 s into the lockstep
```

The page had written 402 answers and all 402 had settled, with `desiredSize` 1, while the server
had received 397 of them. Three new streams on the same session worked during the stall, and the
page's `close()` stayed pending.

## Results

Moto g31, Chrome 156.0.8078.80, 2026-11-05, 14 runs. "Stalled at" is when the last answer
arrived, counted from the moment the lockstep stream opened.

| Page pattern | Writes per second | Runs | Stalled | Stalled at (s) | Answers written before the stall |
|---|---|---|---|---|---|
| `raf` (default: 2 writes back to back, 1 on the next frame) | about 187 | 6 | 6 | 2.1, 2.3, 2.5, 7.2, 11.0, 16.5 | 402 to 3,105 |
| `spread&writes=3` (3 writes, each in its own task, 4 ms apart) | about 187 | 3 | 3 | 4.4, 55.0, 82.5 | 840 to 15,465 |
| `burst&writes=1` (one write per message) | about 62 | 5 | 1 | 11.7 | 733 (the other four ran 120 s, 7,500 writes each) |

The same holds in all 10 stalled runs:

- **The writes resolve.** At the stall, every answer the page had written had settled, none had
  rejected, and `desiredSize` was 1. The server was missing the page's last 2 to 7 answers.
- **New streams work.** All 30 probe streams were answered, in 9 to 37 ms.
- **`close()` does not settle.** It was still pending 5 s after the call, and rejected only when
  the server closed the session.
- **The connection is healthy.** The server's quinn statistics show RTT 2 to 9 ms and 0 lost
  packets. After the last STREAM frame on the lockstep stream, the phone sends ACKs for the
  server's keep-alive PINGs, the probe streams, and no STREAM_DATA_BLOCKED or DATA_BLOCKED.

In the run with a `chrome://net-export` capture, the phone's own QUIC session logged its last
STREAM frame on the lockstep stream (QUIC stream 4) at 16.6 s, ending at byte offset 341,988. The
server received exactly that many bytes: the 3-byte WebTransport stream header, the 170-byte
hello and 341,815 bytes of answers. The
page's last 6 answers, all resolved, never reached Chrome's QUIC session.

Desktop Chromium 148 on Linux never stalled with the same server design (this repository's
`rs-net-lockstep`, `scripts/test/wt-impaired-chromium.ts`), including through a UDP impairment
proxy.

## Versions

- Phone: Motorola moto g31 (MediaTek MT6768), Android 12, Chrome 156.0.8078.80, on Wi-Fi.
- Host: Linux, Rust 1.95.0. `Cargo.lock` pins wtransport 0.7.2, quinn 0.11.12 (quinn-proto
  0.11.19), rustls 0.23.46, rcgen 0.14.10, tokio 1.54.1, all from crates.io.
