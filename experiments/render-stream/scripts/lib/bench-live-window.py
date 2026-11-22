#!/usr/bin/env python3
"""Engine-free bench-live-scale leg: production hub, optional TCP shaper and page or arrival-ack receiver.

Invoke through bench-live-scale.sh --engine-free HOST --receiver host-only --rx-cmd CMD.
Page commands require a prebuilt --core. --receiver null uses no browser or core.
"""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def metrics(lines, warmup_s=5):
    frames = [r for r in lines if r.get("state") == "streaming"]
    if not frames:
        raise ValueError("no streaming frame rows")
    start = frames[0]["t_us"] + warmup_s * 1e6
    end = frames[-1]["t_us"] - 100_000  # exclude acks still in transit at dispose
    rows = [r for r in frames if start <= r["t_us"] <= end]
    if len(rows) < 2:
        raise ValueError("not enough settled streaming frames")
    dt = (rows[-1]["t_us"] - rows[0]["t_us"]) / 1e6
    sends = {r["sent"]["seq"]: r["t_us"] for r in rows if r.get("sent")}
    acks = {(r["seq"], r["stage"]): r for r in lines if r.get("event") == "ack"}
    draws = Counter(acks[(s, "submitted")]["receiver_t_us"] for s in sends
                    if (s, "submitted") in acks)
    stage = next((r["credit_stage"] for r in lines if r.get("event") == "hello"), "applied")
    rtt = sorted((acks[(s, stage)]["t_us"] - t) / 1000 for s, t in sends.items()
                 if (s, stage) in acks)
    return {"settled_s": dt, "offered": len(rows), "sent": len(sends),
            "sent_offered": len(sends) / len(rows),
            "host_hz": (len(rows) - 1) / dt, "sent_per_s": len(sends) / dt,
            "draws_per_s": len(draws) / dt,
            "coalesced_share": sum(n >= 2 for n in draws.values()) / max(1, len(draws)),
            "credit_rtt_ms_p50": rtt[len(rtt) // 2] if rtt else None,
            "credit_rtt_ms_p95": rtt[min(len(rtt) - 1, int(len(rtt) * .95))] if rtt else None}


def null_receiver_argv(url, origin, out, protocol, window, token_file, timeout_s):
    return ["exec", "mise", "exec", "--", "node",
            str(HERE / "null-window-receiver.mjs"),
            "--url", url, "--origin", origin, "--out", str(out),
            "--protocol", str(protocol), "--window", str(window),
            "--token-file", token_file, "--timeout-s", str(timeout_s)]


def receiver_timeout_s(frames):
    return frames / 60 + 30


def self_test():
    lines = [{"state": "streaming", "t_us": n * 10_000, "sent": {"seq": n + 1}}
             for n in range(40)]
    lines += [{"event": "ack", "seq": n + 1, "stage": stage,
               "t_us": n * 10_000 + 48_000, "receiver_t_us": (n // 2) * 20_000}
              for n in range(40) for stage in ("applied", "submitted")]
    m = metrics(lines, 0)
    assert m["sent_offered"] == 1
    assert m["credit_rtt_ms_p50"] == 48
    assert m["coalesced_share"] == 1
    assert m["offered"] == 30  # last 100 ms excluded, inclusive boundary
    assert m["draws_per_s"] == 15 / .29
    for frames, expected_s in ((60, 31), (3600, 90), (7200, 150)):
        timeout_s = receiver_timeout_s(frames)
        argv = null_receiver_argv("ws://127.0.0.1:1/render-stream",
                                 "http://127.0.0.1:13832", Path("rx"), 18, 8, "", timeout_s)
        assert float(argv[argv.index("--timeout-s") + 1]) == expected_s
    print("bench-live-window: 8 passed, 0 failed")


def wait_for(path, predicate, proc):
    until = time.monotonic() + 20
    while time.monotonic() < until:
        if path.exists():
            value = predicate(path.read_text())
            if value is not None:
                return value
        if proc.poll() is not None:
            raise RuntimeError(f"process exited {proc.returncode}; read {path}")
        time.sleep(.05)
    raise TimeoutError(f"readiness timeout: {path}")


def stop(proc):
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engine-free", required=True, type=Path)
    ap.add_argument("--receiver", choices=["host-only", "null"], required=True)
    ap.add_argument("--rx-cmd")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--protocol", type=int, choices=[16, 18], default=18)
    ap.add_argument("--window", type=int, choices=range(1, 9), default=8)
    ap.add_argument("--frames", type=int, default=3600)
    ap.add_argument("--items", type=int, default=1024)
    ap.add_argument("--delay-ms", type=float, default=24)
    ap.add_argument("--direct", action="store_true", help="bypass the TCP proxy (requires --delay-ms 0)")
    ap.add_argument("--token-auth", action="store_true", help="require a fresh per-leg hello token")
    ap.add_argument("--page-port", type=int, default=13832)
    ap.add_argument("--wait-load-s", type=float, default=0)
    ap.add_argument("--min-rate", type=float, default=15)
    ap.add_argument("--max-credit-rtt-ms", type=float, default=100)
    a = ap.parse_args()
    if a.protocol < 18 and a.window > 2:
        ap.error("below /18 --window must be 1 or 2")
    if not a.engine_free.is_file() or not os.access(a.engine_free, os.X_OK):
        ap.error("--engine-free must name a built rs_live_host executable")
    if a.receiver == "host-only" and (not a.rx_cmd or "--core " not in a.rx_cmd):
        ap.error("--rx-cmd must use a prebuilt --core (no build during a timing leg)")
    if a.direct and a.delay_ms != 0:
        ap.error("--direct requires --delay-ms 0")
    if a.receiver == "null" and a.rx_cmd:
        ap.error("--receiver null does not accept --rx-cmd")
    if a.frames <= 0 or not 1 <= a.items <= 32768 or a.delay_ms < 0:
        ap.error("positive frames, items 1..32768 and nonnegative delay required")
    a.out = a.out.resolve()
    a.out.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("RS_BENCH_WINDOW_INSIDE"):
        env = dict(os.environ, RS_BENCH_WINDOW_INSIDE="1",
                   QUIET_LOG=str(a.out / "quiet-lock.jsonl"))
        return subprocess.call(["bash", str(HERE / "quiet.sh"), "exclusive", "--label",
                                f"bench-live-window:/{a.protocol}-w{a.window}", "--",
                                sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
    preflight = subprocess.check_output(["uptime"], text=True)
    preflight += subprocess.check_output(["bash", str(HERE / "quiet.sh"), "status"], text=True)
    (a.out / "preflight.txt").write_text(preflight)
    print(preflight, flush=True)
    load_started = time.monotonic()
    while os.getloadavg()[0] > 4 and time.monotonic() - load_started < a.wait_load_s:
        print(f"preflight waiting for load: {os.getloadavg()[0]:.2f} > 4", flush=True)
        time.sleep(1)
    load_wait_s = time.monotonic() - load_started
    if load_wait_s >= 1:
        ready = subprocess.check_output(["uptime"], text=True)
        ready += subprocess.check_output(["bash", str(HERE / "quiet.sh"), "status"], text=True)
        with (a.out / "preflight.txt").open("a") as log:
            log.write("After load wait:\n" + ready)
        print(ready, flush=True)
    load = os.getloadavg()
    if load[0] > 4:
        raise RuntimeError(f"timing refused: load {load[0]:.2f} > 4")
    started = time.monotonic()
    host = proxy = receiver = None
    host_dir, rx_dir = a.out / "host", a.out / "rx"
    host_dir.mkdir(exist_ok=True)
    rx_dir.mkdir(exist_ok=True)
    env = dict(os.environ, GRC_LIVE_ALLOWED_ORIGINS=f"http://127.0.0.1:{a.page_port}")
    host_cmd = [str(a.engine_free.resolve()), f"--benchmark={a.protocol}",
                f"--frames={a.frames}", f"--items={a.items}",
                f"--tap-dir={host_dir / 'tap'}", f"--summary={host_dir / 'live-summary.json'}"]
    token_file = host_dir / "live-token"
    if a.token_auth:
        token = secrets.token_hex(32)
        token_file.write_text(token + "\n")
        token_file.chmod(0o600)
        host_cmd.append(f"--token={token}")
    (a.out / "command.json").write_text(json.dumps({"argv": sys.argv, "host": ["--token=<redacted>" if c.startswith("--token=") else c for c in host_cmd], "load": load}, indent=2))
    try:
        with (host_dir / "stdout.log").open("w") as log:
            host = subprocess.Popen(host_cmd, stdout=log, stderr=subprocess.STDOUT, env=env)
        def port(text):
            return next((int(s.split()[1]) for s in text.splitlines()
                         if s.startswith("RS_LIVE_HOST_PORT ")), None)
        host_port = wait_for(host_dir / "stdout.log", port, host)
        shaped_port = host_port
        if not a.direct:
            proxy_cmd = ["mise", "exec", "--", "pnpm", "exec", "tsx", "--conditions=development",
                         str(HERE.parent / "throttle-proxy.ts"), "--target-port", str(host_port),
                         "--profile", "unlimited", "--delay-ms", str(a.delay_ms),
                         "--stats-out", str(a.out / "proxy-stats.json")]
            with (a.out / "proxy.log").open("w") as log:
                proxy = subprocess.Popen(proxy_cmd, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT,
                                         start_new_session=True)
            def proxy_port(text):
                return next((json.loads(s)["listening_port"] for s in text.splitlines()
                             if s.startswith('{"listening_port"')), None)
            shaped_port = wait_for(a.out / "proxy.log", proxy_port, proxy)
        rx_env = dict(os.environ, RS_BENCH_WS_URL=f"ws://127.0.0.1:{shaped_port}/render-stream",
                      RS_BENCH_HTTP_ORIGIN=f"http://127.0.0.1:{shaped_port}",
                      RS_BENCH_PAGE_PORT=str(a.page_port), RS_BENCH_RX_DIR=str(rx_dir),
                      RS_BENCH_PROTOCOL=str(a.protocol), RS_BENCH_WINDOW=str(a.window),
                      RS_BENCH_TOKEN_FILE=str(token_file) if a.token_auth else "")
        timeout_s = receiver_timeout_s(a.frames)
        rx_cmd = a.rx_cmd
        if a.receiver == "null":
            rx_cmd = shlex.join(null_receiver_argv(
                rx_env["RS_BENCH_WS_URL"], f"http://127.0.0.1:{a.page_port}",
                rx_dir, a.protocol, a.window, rx_env["RS_BENCH_TOKEN_FILE"], timeout_s))
        (rx_dir / "command.txt").write_text(rx_cmd + "\n")
        with (rx_dir / "launcher.out").open("w") as log:
            receiver = subprocess.Popen(["bash", "-c", rx_cmd], cwd=ROOT, env=rx_env,
                                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + timeout_s
        with (a.out / "load.jsonl").open("w") as log:
            while receiver.poll() is None:
                log.write(json.dumps({"t_s": time.monotonic() - started, "load": os.getloadavg()}) + "\n")
                log.flush()
                if time.monotonic() >= deadline:
                    raise TimeoutError("receiver exceeded host frame budget")
                time.sleep(1)
        rc = receiver.returncode
        (rx_dir / "exit.txt").write_text(str(rc))
    finally:
        import signal
        for proc in (receiver, proxy):
            if proc is not None and proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        stop(receiver)
        stop(proxy)
        stop(host)
        if host is not None:
            (host_dir / "exit.txt").write_text(str(host.returncode))
    lines = [json.loads(s) for s in (host_dir / "tap/live-1.jsonl").read_text().splitlines()]
    measured = metrics(lines)
    measured.update(wall_s=time.monotonic() - started, load=load, load_wait_s=load_wait_s)
    (a.out / "window-metrics.json").write_text(json.dumps(measured, indent=2) + "\n")
    print(json.dumps(measured))
    verdict_rc = subprocess.call([sys.executable, str(HERE / "bench-live-scale.py"), "verdict", str(a.out),
                                  "--min-rate", str(a.min_rate), "--max-credit-rtt-ms", str(a.max_credit_rtt_ms)])
    return rc or verdict_rc


if __name__ == "__main__":
    sys.exit(main())
