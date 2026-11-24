#!/usr/bin/env python3
"""Summarize pacing-proof.sh output: <out> [--json|--by-connection], or --self-test.

Host sends are selected from live tap records in the client's measured window
(Linux CLOCK_MONOTONIC). Without taps, use counter deltas between timeline samples
inside that window and report their shorter coverage. Primary metrics combine all
connections; per-connection rates are contributions over the same measured window.
Content age comes from submitted ACK groups (one receiver timestamp per draw,
per connection), using the newest sequence's host ACK time minus its send time.
This includes the return one-way delay, constant within each RTT cell. All tap
metrics use the measured host window; w_eff and srtt use its timeline samples.
Missing evidence stays null, never an invented zero.
"""
import argparse
from collections import Counter
from contextlib import redirect_stdout
import io
import json
import shlex
from pathlib import Path
import tempfile
import unittest


def read_json(path):
    return json.loads(path.read_text())


def host_path(leg, name):
    for path in (leg / "host" / name, leg / "host" / "evidence" / name):
        if path.exists():
            return path
    return None


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def quantile(values, p):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(p * len(values)))]


def submitted_draws(records, start, end):
    """Keep full-file sends so a draw may reference a pre-window send.

    Group before windowing: folded ACKs may straddle a window boundary. Use the
    newest sequence's ACK to place the draw and measure age on the host clock.
    Receiver clocks identify groups only and are never subtracted from host time.
    """
    sends = {r["sent"]["seq"]: r["t_us"] for r in records if r.get("sent")}
    groups = {}
    for r in records:
        if r.get("event") == "ack" and r.get("stage") == "submitted" and r.get("receiver_t_us") is not None:
            groups.setdefault(r["receiver_t_us"], {})[r["seq"]] = r
    draws = []
    for seqs in groups.values():
        newest = max(seqs)
        t = seqs[newest]["t_us"]
        if start <= t < end:
            draws.append({"fold_count": len(seqs), "age_ms": (t - sends[newest]) / 1000 if newest in sends else None})
    return draws


def draw_metrics(draws, seconds):
    ages = [d["age_ms"] for d in draws if d["age_ms"] is not None] if draws is not None else []
    return {
        "draws": len(draws) if draws is not None else None,
        "draws_per_s": ratio(len(draws), seconds) if draws is not None else None,
        "age_ms": {"p50": quantile(ages, 0.5), "p95": quantile(ages, 0.95), "mean": sum(ages) / len(ages) if ages else None},
        "age_samples": len(ages) if draws is not None else None,
        "age_missing_sent": sum(d["age_ms"] is None for d in draws) if draws is not None else None,
        "fold_count_distribution": {str(n): count for n, count in sorted(Counter(d["fold_count"] for d in draws).items())} if draws is not None else {},
    }


def scene_profile(leg):
    path = leg / "scene-profile.json"
    scene = read_json(path) if path.exists() else {"profile": "default", "rs_scale_env": {}}
    # bench-live-scale starts its host with env -i; this is the exact host env.
    env_path = leg / "host/env.txt"
    if env_path.exists():
        scene["rs_scale_env"] = dict(line.split("=", 1) for line in env_path.read_text().splitlines() if line.startswith("RS_SCALE_"))
    return scene


def ratio(a, b):
    return a / b if a is not None and b is not None and b > 0 else None


def subtract(a, b):
    return a - b if a is not None and b is not None else None


def window_metrics(samples):
    windows = Counter(c["w_eff"] for c in samples if "w_eff" in c)
    total = sum(windows.values())
    return {
        "w_eff_share": {str(w): n / total for w, n in sorted(windows.items())},
        "w_eff_seconds": total,
        "srtt_p50_ms": quantile([c["srtt_us"] / 1000 for c in samples if c.get("srtt_us", 0) > 0], 0.5),
    }


def host_metrics(sent, draws, seconds):
    metrics = draw_metrics(draws, seconds)
    return {
        "sent": sent,
        "sends_per_s": ratio(sent, seconds),
        "host_draws": metrics["draws"],
        "host_draws_per_s": metrics["draws_per_s"],
        "sends_per_draw": ratio(sent, metrics["draws"]),
        "staleness_submitted_ms": metrics["age_ms"],
        "age_samples": metrics["age_samples"],
        "age_missing_sent": metrics["age_missing_sent"],
        "fold_count_distribution": metrics["fold_count_distribution"],
    }


def distribution(values):
    values = [v for v in values if v is not None]
    return {"p50": quantile(values, 0.5), "p95": quantile(values, 0.95),
            "mean": sum(values) / len(values) if values else None}


def host_settings(leg):
    env = leg / "host/env.txt"
    settings = dict(line.split("=", 1) for line in env.read_text().splitlines() if "=" in line) if env.exists() else {}
    host = settings.get("GRC_HOST_FPS")
    for name in ("argv.txt", "host-argv.txt", "command.txt", "argv.json"):
        path = leg / "host" / name
        if path.exists():
            argv = read_json(path) if path.suffix == ".json" else shlex.split(path.read_text())
            if isinstance(argv, list) and "--max-fps" in argv:
                host = argv[argv.index("--max-fps") + 1]
                break
    # Older proofs used bench-live-scale's fixed 60 fps host.
    publish = settings.get("GRC_PUBLISH_FPS", "")
    return {"host_fps": int(host) if host is not None else 60,
            "publish_fps": int(publish) if publish.isdecimal() else None}


def saver_metrics(leg, pacing):
    path = leg / "rx/saver-trace.jsonl"
    trace = jsonl(path) if path.exists() else None
    start, end = pacing.get("page_window_start_ms"), pacing.get("page_window_end_ms")
    def in_window(t):
        return t is not None and start is not None and end is not None and start <= t < end
    slots = [r for r in trace or [] if r.get("kind") == "slot"]
    # Capacity measurement presents every callback. Report paced slots separately from warmup.
    steady = {}
    for row in slots:
        if row["k"] >= 2:
            steady.setdefault(row.get("connection", 0), row["t"])
    paced = [r for r in slots if r["k"] >= 2 and in_window(r["t"])]
    draws = {}
    for row in trace or []:
        if row.get("kind") != "seq" or not in_window(row.get("presentMs")):
            continue
        connection = row.get("connection", 0)
        if pacing.get("preset") == "saver" and row["presentMs"] < steady.get(connection, float("inf")):
            continue
        key = (connection, row["presentMs"])
        if key not in draws or row["seq"] > draws[key]["seq"]:
            draws[key] = row
    return {
        "present_arrival_wait_ms": distribution([subtract(r.get("presentMs"), r.get("arrivalMs")) for r in draws.values()]),
        "fresh_slot_share": ratio(sum(not r["missed"] and not r["stale"] for r in paced), len(paced)),
        "stale_slot_share": ratio(sum(r["stale"] for r in paced), len(paced)),
        "missed_slot_share": ratio(sum(r["missed"] for r in paced), len(paced)),
        "final_k": (pacing.get("saver_summary") or {}).get("k"),
        "saver_warmup_slots": sum(r["k"] < 2 and in_window(r["t"]) for r in slots) if trace is not None else None,
    }


def summarize(leg, report):
    pacing = report["pacing"]
    start = pacing["host_window_start_us"]
    end = pacing["host_window_end_us"]
    measured_seconds = (end - start) / 1e6
    summary_path = host_path(leg, "live-summary.json")
    connections = read_json(summary_path).get("connections", []) if summary_path else []
    steady = connections[-1].get("connection") if connections else None
    timeline_path = host_path(leg, "perf-timeline.jsonl")
    timeline = []
    if timeline_path:
        rotated = Path(str(timeline_path) + ".1")
        timeline = (jsonl(rotated) if rotated.exists() else []) + jsonl(timeline_path)
    timeline = sorted((t for t in timeline if start <= t["t_us"] < end), key=lambda t: t["t_us"])
    taps = {int(tap.stem.split("-")[-1]): jsonl(tap) for tap in sorted((leg / "host" / "tap").glob("live-*.jsonl"))}
    ids = sorted({c["connection"] for c in connections} | taps.keys() |
                 {c["connection"] for t in timeline for c in t.get("connections", [])})
    seconds = measured_seconds
    rate_source = None
    counts, groups, opens, closes, byte_counts = {}, {}, {}, {}, {}
    if taps and seconds > 0:
        for cid, records in taps.items():
            opens[cid] = next((r["t_us"] for r in records if r.get("event") == "open"), None)
            closes[cid] = next((r["t_us"] for r in records if r.get("event") == "close"), None)
            groups[cid] = submitted_draws(records, start, end)
            sends = [r["sent"] for r in records if start <= r["t_us"] < end and r.get("sent")]
            byte_counts[cid] = sum(r["bytes"] for r in sends) if all("bytes" in r for r in sends) else None
            counts[cid] = sum(1 for r in records if start <= r["t_us"] < end and r.get("sent"))
        rate_source = "tap/client-window"
    elif len(timeline) >= 2:
        first, last = timeline[0], timeline[-1]
        seconds = (last["t_us"] - first["t_us"]) / 1e6
        a = {c["connection"]: c.get("sent", 0) for c in first.get("connections", [])}
        b = {c["connection"]: c.get("sent", 0) for c in last.get("connections", [])}
        counts = {cid: n - a.get(cid, 0) for cid, n in b.items()}
        rate_source = "timeline/inner-window"
    per_connection = []
    all_samples = []
    for cid in ids:
        # Timelines retain closed connections' final counters. Do not count their
        # frozen adaptive-window/srtt values after the close recorded in the tap.
        opened, closed = opens.get(cid), closes.get(cid)
        samples = [c for t in timeline for c in t.get("connections", [])
                   if c["connection"] == cid and (opened is None or t["t_us"] >= opened)
                   and (closed is None or t["t_us"] < closed)]
        all_samples.extend(samples)
        per_connection.append({
            "connection": cid,
            "open_us": opened,
            "close_us": closed,
            "window_s": measured_seconds,
            "host_rate_window_s": seconds if rate_source else None,
            "host_rate_source": rate_source,
            **host_metrics(counts.get(cid), groups.get(cid), measured_seconds if taps else seconds),
            **window_metrics(samples),
        })
    # Missing a connection's tap invalidates the aggregate, rather than presenting
    # partial evidence as a complete trial. Keep available per-connection rows.
    sent_all = sum(counts.values()) if ids and all(cid in counts for cid in ids) else None
    all_draws = [d for draws in groups.values() for d in draws] if ids and all(cid in groups for cid in ids) else None
    metrics = host_metrics(sent_all, all_draws, measured_seconds if taps else seconds)
    last_metrics = next((c for c in per_connection if c["connection"] == steady), {})
    first_opens = [opens.get(c["connection"]) for c in connections[:2]]
    per_second = next((m.get("per_second", []) for m in report.get("mounts", []) if m.get("mount") == 1), [])
    shares = [s["starvedCycleShare"] for s in per_second if s.get("starvedCycleShare") is not None]
    return {
        "preset": pacing["preset"],
        **host_settings(leg),
        **saver_metrics(leg, pacing),
        "bytes_per_s": ratio(sum(byte_counts.values()), measured_seconds)
            if ids and all(byte_counts.get(cid) is not None for cid in ids) else None,
        "gpu_load_mode": pacing.get("gpu_load", {}).get("mode", "always"),
        "scene": scene_profile(leg),
        "label": leg.name,
        "path": str(leg),
        "steady_connection": steady,
        "connections": len(ids),
        "per_connection": per_connection,
        "per_second": per_second,
        "starvedCycleShare_timeline": {"min": min(shares) if shares else None,
            "median": quantile(shares, 0.5), "max": max(shares) if shares else None, "samples": len(shares)},
        "sent_steady": counts.get(steady),
        "sent_all": sent_all,
        "sent_steady_total": connections[-1].get("sent") if connections else None,
        "sent_all_total": sum(c.get("sent", 0) for c in connections) if connections else None,
        **metrics,
        # Retain the explicit all-connection names used by earlier JSON consumers.
        "sends_all_per_s": metrics["sends_per_s"],
        "host_draws_all": metrics["host_draws"],
        "host_draws_all_per_s": metrics["host_draws_per_s"],
        "staleness_all_submitted_ms": metrics["staleness_submitted_ms"],
        "age_all_samples": metrics["age_samples"],
        "age_all_missing_sent": metrics["age_missing_sent"],
        "fold_count_all_distribution": metrics["fold_count_distribution"],
        "sends_steady_per_s": last_metrics.get("sends_per_s"),
        "host_rate_window_s": seconds if rate_source else None,
        "host_rate_source": rate_source,
        "draws_per_s": pacing.get("draws_per_s"),
        "trial": pacing.get("trial") if pacing["preset"] == "balanced" else None,
        "after_fallback": pacing.get("after_fallback") if pacing["preset"] == "balanced" else None,
        "staleness_scope": "tap/client-window/all-connections",
        "stutter_share": pacing.get("stutter_share"),
        **window_metrics(all_samples),
        "fallback_at_ms": pacing.get("fallback_at_ms"),
        "fallback_at_first_frame_ms": pacing.get("fallback_at_first_frame_ms", pacing.get("fallback_at_ms")),
        "fallback_at_mount_ms": pacing.get("fallback_at_mount_ms"),
        "second_connection_open_after_first_ms": (first_opens[1] - first_opens[0]) / 1000 if len(first_opens) == 2 and all(t is not None for t in first_opens) else None,
        "starvedCycleShare": pacing.get("starvedCycleShare"),
        "creditWindowGranted": pacing.get("creditWindowGranted"),
        "creditStage": pacing.get("creditStage"),
        "checks": report.get("checks", []),
    }


def collect(out):
    cells = {}
    all_rows = []
    for path in sorted(out.rglob("client-device.json")):
        report = read_json(path)
        pacing = report.get("pacing")
        if not pacing:
            continue
        row = summarize(path.parent.parent, report)
        base = (pacing["gpu_load"]["target_hz"], pacing["one_way_ms"], row["scene"]["profile"], row["gpu_load_mode"])
        key = (*base, row["host_fps"], row["publish_fps"])
        cells.setdefault(key, []).append(row)
        all_rows.append((base, row))
    result = []
    for (load, delay, profile, mode, host, publish), rows in sorted(cells.items(), key=lambda item: tuple("" if v is None else str(v) for v in item[0])):
        baseline = next((r for base, r in all_rows if base == (load, delay, profile, mode)
                         and r["host_fps"] == host and r["publish_fps"] is None
                         and r["preset"] == "fidelity" and not r["label"].endswith("-rep")), None)
        for row in rows:
            row["draws_vs_fidelity"] = ratio(row["draws_per_s"], baseline["draws_per_s"]) if baseline else None
            row["staleness_delta_ms"] = {
                q: subtract(row["staleness_submitted_ms"][q], baseline["staleness_submitted_ms"][q]) if baseline else None
                for q in ("p50", "p95", "mean")
            }
        result.append({"load_hz": load, "one_way_ms": delay, "scene_profile": profile, "gpu_load_mode": mode,
                       "host_fps": host, "publish_fps": publish, "rows": rows})
    return {"schema": "render-stream-pacing-proof/1", "cells": result}


def tables(result, by_connection=False):
    def f(value):
        return "-" if value is None else f"{value:.3f}"
    for cell in result["cells"]:
        print(f"\nHost {cell.get('host_fps', 60)} fps; publish {cell.get('publish_fps')}; scene {cell['scene_profile']}; load {cell['load_hz']} Hz ({cell['gpu_load_mode']}); one-way {cell['one_way_ms']} ms (added RTT {2 * cell['one_way_ms']} ms)")
        columns = ["preset"] + (["connection"] if by_connection else []) + [
            "sends/s host", "draws/s host", "draws/s client", "sends/draw host",
            "client draws/fidelity", "age p50/p95/mean ms", "age delta p50/p95/mean ms",
            "stutter share", "starved share min/median/max", "w_eff share (connection-seconds)",
            "srtt p50 ms", "fold count:draws", "balanced fallback mount/first ms",
            "balanced trial/after draws/s", "trial/after window s", "open2-open1 ms", "bytes/s", "present-arrival p50/p95 ms", "fresh/stale/missed slots", "final k"]
        print("| " + " | ".join(columns) + " |")
        print("|" + "---|" * len(columns))
        for row in cell["rows"]:
            for host in row["per_connection"] if by_connection else [row]:
                age = host["staleness_submitted_ms"]
                # A per-connection contribution has no matching fidelity connection.
                delta = {q: None for q in ("p50", "p95", "mean")} if by_connection else row["staleness_delta_ms"]
                windows = ", ".join(f"{w}:{share:.1%}" for w, share in host["w_eff_share"].items()) or "-"
                shares = row["starvedCycleShare_timeline"]
                print("| " + " | ".join([row["label"]] + ([str(host["connection"])] if by_connection else []) + [
                    f(host["sends_per_s"]), f(host["host_draws_per_s"]), f(row["draws_per_s"]),
                    f(host["sends_per_draw"]), f(row["draws_vs_fidelity"]),
                    "/".join(f(age[q]) for q in ("p50", "p95", "mean")), "/".join(f(delta[q]) for q in ("p50", "p95", "mean")),
                    f(row["stutter_share"]), "/".join(f(shares[q]) for q in ("min", "median", "max")),
                    f"{windows} ({host['w_eff_seconds']})", f(host["srtt_p50_ms"]),
                    ", ".join(f"{n}:{count}" for n, count in host["fold_count_distribution"].items()) or "-",
                    f"{f(row['fallback_at_mount_ms'])}/{f(row['fallback_at_first_frame_ms'])}",
                    "/".join(f((row[phase] or {}).get("draws_per_s")) for phase in ("trial", "after_fallback")),
                    "/".join(f((row[phase] or {}).get("window_s")) for phase in ("trial", "after_fallback")),
                    f(row["second_connection_open_after_first_ms"]), f(row["bytes_per_s"]),
                    "/".join(f(row["present_arrival_wait_ms"][q]) for q in ("p50", "p95")),
                    "/".join(f(row[key]) for key in ("fresh_slot_share", "stale_slot_share", "missed_slot_share")),
                    f(row["final_k"]),
                ]) + " |")
        for row in cell["rows"]:
            print(f"Scene env ({row['label']}): " + json.dumps(row["scene"]["rs_scale_env"], sort_keys=True))
        print("Age and host draws: measured-window submitted ACK groups across all connections, newest seq ACK minus send (host clock).")
        print("Wait and saver slot shares use the page window and exclude saver capacity warmup; age has no hold correction.")
        print("Age includes return one-way delay, constant per RTT cell. Folds = submitted seqs per draw; JSON includes per-connection metrics.")
        print("Client draws: mount recorder over the full measured window, including connections before fallback.")
        print("Window/srtt: measured-window 1 Hz samples of open connections (tap open/close). Fallback clocks: mount / first frame.")
        print("Per-connection host rates share the aggregate denominator; client/starved/fallback columns describe the trial.")
        print("Balanced -> fidelity: trial/after client draw rates split at the first observed fallback, clipped to the measured window; reconnect gaps count.")
        print("No fallback: trial covers the window, after is unavailable. A trial ending before the window has zero duration and no rate.")
        print("Starved share: min/median/max of non-null per-second mount-1 samples. Older reports have no timeline.")
        print("Sends: client-window tap counts when available; JSON reports source and coverage. '-' means unavailable.")


class SummaryTests(unittest.TestCase):
    def test_uncapped_publish_settings_share_a_cell(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for label, setting in [("omitted", None), ("empty", ""), ("explicit", "uncapped")]:
                leg = root / label
                (leg / "host").mkdir(parents=True)
                (leg / "rx").mkdir()
                (leg / "host/env.txt").write_text(f"GRC_PUBLISH_FPS={setting}\n" if setting is not None else "")
                (leg / "rx/client-device.json").write_text(json.dumps({"pacing": {
                    "preset": "saver", "gpu_load": {"target_hz": None}, "one_way_ms": 0,
                    "host_window_start_us": 1000000, "host_window_end_us": 3000000,
                }}))
            result = collect(root)
            self.assertEqual(len(result["cells"]), 1)
            cell = result["cells"][0]
            self.assertIsNone(cell["publish_fps"])
            self.assertEqual(len(cell["rows"]), 3)
            self.assertTrue(all(row["publish_fps"] is None for row in cell["rows"]))

    def test_saver_trace_axes_and_bytes(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for label, host, publish, preset in [("F60", 60, None, "fidelity"), ("F144", 144, None, "fidelity"),
                                                   ("Saver", 60, None, "saver"), ("Sunaligned", 60, 30, "saver")]:
                leg = root / label
                (leg / "host/tap").mkdir(parents=True)
                (leg / "rx").mkdir()
                (leg / "host/argv.txt").write_text(f"godot --headless --max-fps {host}")
                (leg / "host/env.txt").write_text(f"GRC_PUBLISH_FPS={publish}\n" if publish else "")
                pacing = {"preset": preset, "gpu_load": {"target_hz": None}, "one_way_ms": 0,
                          "host_window_start_us": 1000000, "host_window_end_us": 3000000,
                          "page_window_start_ms": 1000, "page_window_end_ms": 3000,
                          "draws_per_s": 30, "saver_summary": {"k": 2 if preset == "saver" else None}}
                (leg / "rx/client-device.json").write_text(json.dumps({"pacing": pacing}))
                slots = [{"kind": "slot", "t": t, "k": k, "missed": missed, "stale": stale}
                         for t, k, missed, stale in [(1100, 1, True, False), (1500, 2, False, False),
                                                    (1700, 2, False, True), (1900, 2, True, False), (3000, 2, True, False)]]
                seqs = [{"kind": "seq", "seq": seq, "arrivalMs": arrival, "presentMs": present}
                        for seq, arrival, present in [(1, 1200, 1300), (2, 1460, 1500), (3, 1480, 1500)]]
                (leg / "rx/saver-trace.jsonl").write_text("\n".join(map(json.dumps, slots + seqs)))
                taps = [{"t_us": 1500000, "sent": {"seq": 2, "bytes": 80}},
                        {"t_us": 1600000, "sent": {"seq": 3, "bytes": 120}}]
                (leg / "host/tap/live-1.jsonl").write_text("\n".join(map(json.dumps, taps)))
            result = collect(root)
            self.assertEqual(len(result["cells"]), 3)
            rows = {r["label"]: r for c in result["cells"] for r in c["rows"]}
            saver = rows["Saver"]
            self.assertEqual(saver["present_arrival_wait_ms"], {"p50": 20, "p95": 20, "mean": 20})
            self.assertEqual([saver[k] for k in ("fresh_slot_share", "stale_slot_share", "missed_slot_share")], [1/3]*3)
            self.assertEqual(saver["final_k"], 2)
            self.assertEqual(saver["saver_warmup_slots"], 1)
            self.assertEqual(saver["bytes_per_s"], 100)
            self.assertEqual(rows["F144"]["host_fps"], 144)
            self.assertEqual(rows["Sunaligned"]["publish_fps"], 30)
            self.assertNotIn("hold_corrected_age_ms", saver)
            # Missing trace and unknown send sizes must stay unavailable.
            leg = root / "Saver"
            (leg / "rx/saver-trace.jsonl").unlink()
            (leg / "host/tap/live-1.jsonl").write_text(json.dumps({"t_us": 1500000, "sent": {"seq": 1}}))
            report = read_json(leg / "rx/client-device.json")
            missing = summarize(leg, report)
            self.assertIsNone(missing["missed_slot_share"])
            self.assertIsNone(missing["present_arrival_wait_ms"]["p50"])
            self.assertIsNone(missing["bytes_per_s"])
            output = io.StringIO()
            with redirect_stdout(output):
                tables(result)
            self.assertIn("present-arrival", output.getvalue())
            self.assertIn("bytes/s", output.getvalue())

    def test_fixture(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for preset, draws, sample_age in [("fidelity", 40, 16000), ("balanced", 30, 24000), ("fidelity-rep", 38, 18000)]:
                leg = root / "30" / "24" / preset
                evidence = leg / "host" / "evidence"
                evidence.mkdir(parents=True)
                (leg / "rx").mkdir()
                (leg / "rx" / "client-device.json").write_text(json.dumps({"pacing": {
                    "preset": preset.split("-")[0], "gpu_load": {"target_hz": 30}, "one_way_ms": 24,
                    "host_window_start_us": 1000000, "host_window_end_us": 3000000,
                    "draws_per_s": draws, "stutter_share": 0.1, "fallback_at_ms": 1250 if preset == "balanced" else None,
                }}))
                (evidence / "live-summary.json").write_text(json.dumps({"connections": [{"connection": 1, "sent": 4}, {"connection": 2, "sent": 80}]}))
                timeline = [{"t_us": t, "connections": [{"connection": 1, "sent": 4}, {"connection": 2, "sent": n, "w_eff": w, "srtt_us": r}]} for t, n, w, r in [(0, 0, 8, 1000), (1000000, 10, 1, 48000), (2000000, 50, 3, 50000), (3000000, 90, 8, 1000)]]
                (evidence / "perf-timeline.jsonl").write_text("\n".join(map(json.dumps, timeline)))
                (evidence / "perf.json").write_text(json.dumps({"histograms": {"staleness_us": {"submitted": {"count": 0, "buckets": []}}}}))
                tap = leg / "host" / "tap"
                tap.mkdir()
                (tap / "live-1.jsonl").write_text(json.dumps({"t_us": 1100000, "sent": {"seq": 1}}))
                records = [{"t_us": t, "sent": {"seq": i}} for i, t in enumerate([900000, 1200000, 2200000, 3000000])]
                records += [{"event": "ack", "stage": "submitted", "seq": i, "receiver_t_us": i * 10000, "t_us": t + age} for i, t, age in [(1, 1200000, sample_age), (2, 2200000, 32000)]]
                (tap / "live-2.jsonl").write_text("\n".join(map(json.dumps, records)))
            result = collect(root)
            self.assertEqual(len(result["cells"]), 1)
            rows = {r["label"]: r for r in result["cells"][0]["rows"]}
            balanced = rows["balanced"]
            self.assertEqual(balanced["steady_connection"], 2)
            self.assertEqual(balanced["sends_per_s"], 1.5)
            self.assertEqual(balanced["sends_all_per_s"], 1.5)
            self.assertEqual(balanced["sent_all_total"], 84)
            self.assertEqual(balanced["draws_vs_fidelity"], 0.75)
            self.assertEqual(balanced["staleness_submitted_ms"], {"p50": 32, "p95": 32, "mean": 28})
            self.assertEqual(balanced["staleness_delta_ms"], {"p50": 0, "p95": 0, "mean": 4})
            self.assertEqual(balanced["w_eff_share"], {"1": 0.5, "3": 0.5})
            self.assertEqual(balanced["srtt_p50_ms"], 50)
            self.assertEqual(balanced["fallback_at_ms"], 1250)
            self.assertEqual(rows["fidelity-rep"]["draws_vs_fidelity"], 0.95)
            # Without taps, timeline counter deltas have their own explicit coverage.
            for path in (root / "30" / "24" / "balanced" / "host" / "tap").glob("*"):
                path.unlink()
            balanced = next(r for r in collect(root)["cells"][0]["rows"] if r["label"] == "balanced")
            self.assertEqual(balanced["sends_per_s"], 40)
            self.assertEqual(balanced["host_rate_window_s"], 1)
            self.assertEqual(balanced["host_rate_source"], "timeline/inner-window")
            self.assertIsNone(balanced["staleness_submitted_ms"]["p50"])
            self.assertIsNone(balanced["host_draws_per_s"])

    def test_submitted_tap_groups(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            leg = Path(tmp)
            (leg / "host/tap").mkdir(parents=True)
            (leg / "host/live-summary.json").write_text(json.dumps({"connections": [
                {"connection": 1}, {"connection": 2}]}))
            def sent(t, seq):
                return {"t_us": t, "sent": {"seq": seq}}
            def ack(t, seq, receiver, stage="submitted"):
                return {"t_us": t, "event": "ack", "stage": stage,
                        "seq": seq, "receiver_t_us": receiver}
            records = {
                1: [{"event": "open", "t_us": 500000}, sent(900000, 1), ack(1300000, 1, 10)],
                2: [{"event": "open", "t_us": 750000}, sent(900000, 1),
                    sent(1100000, 2), sent(2100000, 3), sent(3000000, 4),
                    # Older seq arrives later; age uses the NEWEST seq's ACK time.
                    ack(1224000, 2, 10), ack(1230000, 1, 10),
                    ack(2400000, 3, 20), ack(2500000, 3, 21, "applied"),
                    ack(3000000, 4, 30)],
            }
            for cid, rows in records.items():
                (leg / f"host/tap/live-{cid}.jsonl").write_text("\n".join(map(json.dumps, rows)))
            (leg / "scene-profile.json").write_text(json.dumps({
                "profile": "light", "rs_scale_env": {"RS_SCALE_MESH_UPDATES": "0", "RS_SCALE_PARAM_UPDATES": "0"}}))
            row = summarize(leg, {"pacing": {"host_window_start_us": 1000000,
                "host_window_end_us": 3000000, "preset": "balanced", "draws_per_s": 8,
                "fallback_at_ms": 10, "fallback_at_first_frame_ms": 10, "fallback_at_mount_ms": 30}})
            self.assertEqual(row["host_draws_per_s"], 1.5)
            self.assertEqual(row["host_draws_all_per_s"], 1.5)
            self.assertEqual(row["staleness_submitted_ms"], {"p50": 300, "p95": 400, "mean": 824 / 3})
            self.assertAlmostEqual(row["staleness_all_submitted_ms"]["mean"], 824 / 3)
            self.assertEqual(row["fold_count_distribution"], {"1": 2, "2": 1})
            self.assertEqual(row["fold_count_all_distribution"], {"1": 2, "2": 1})
            self.assertAlmostEqual(row["sends_per_draw"], 2 / 3)
            self.assertEqual([c["host_draws"] for c in row["per_connection"]], [1, 2])
            self.assertEqual([c["sends_per_s"] for c in row["per_connection"]], [0, 1])
            self.assertEqual(row["second_connection_open_after_first_ms"], 250)
            self.assertEqual(row["scene"]["profile"], "light")
            self.assertEqual(row["fallback_at_mount_ms"], 30)
            self.assertEqual(row["fallback_at_first_frame_ms"], 10)

    def test_window_boundaries_and_missing_sends(self):
        # One group straddles start, another straddles end; place by newest seq.
        records = [{"t_us": 50, "sent": {"seq": 2}}]
        records += [{"event": "ack", "stage": "submitted", "seq": seq,
                     "t_us": t, "receiver_t_us": receiver}
                    for seq, t, receiver in [(1, 99, 10), (2, 100, 10),
                                             (3, 110, 11), (4, 199, 12), (5, 200, 12)]]
        draws = submitted_draws(records, 100, 200)
        self.assertEqual(draws, [{"fold_count": 2, "age_ms": 0.05}, {"fold_count": 1, "age_ms": None}])
        metrics = draw_metrics(draws, 1)
        self.assertEqual(metrics["age_samples"], 1)
        self.assertEqual(metrics["age_missing_sent"], 1)
        self.assertEqual(metrics["draws"], 2)
        self.assertEqual(draw_metrics([], 1)["draws_per_s"], 0)
        self.assertIsNone(draw_metrics(None, 1)["draws_per_s"])

    def test_scene_cells(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for scene in ("light", "default"):
                leg = root / scene / "30/0/fidelity"
                (leg / "rx").mkdir(parents=True)
                (leg / "host").mkdir()
                (leg / "scene-profile.json").write_text(json.dumps({"profile": scene, "rs_scale_env": {}}))
                # Final host env is authoritative and ignores non-scale settings.
                (leg / "host/env.txt").write_text("GRC_MODE=arm\nRS_SCALE_REPORT=/output with spaces/report.json\n")
                (leg / "rx/client-device.json").write_text(json.dumps({"pacing": {
                    "preset": "fidelity", "host_window_start_us": 1, "host_window_end_us": 2,
                    "gpu_load": {"target_hz": 30}, "one_way_ms": 0, "draws_per_s": 10}}))
            cells = collect(root)["cells"]
            self.assertEqual([c["scene_profile"] for c in cells], ["default", "light"])
            for cell in cells:
                self.assertEqual(cell["rows"][0]["scene"]["rs_scale_env"], {"RS_SCALE_REPORT": "/output with spaces/report.json"})
                self.assertEqual(cell["rows"][0]["draws_vs_fidelity"], 1)

    def test_pacing_timeline_and_modes(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for mode in ("always", "coupled"):
                leg = root / mode / "30/0/fidelity"
                (leg / "rx").mkdir(parents=True)
                (leg / "rx/client-device.json").write_text(json.dumps({
                    "pacing": {"preset": "fidelity", "host_window_start_us": 1,
                        "host_window_end_us": 2, "draws_per_s": 10,
                        "gpu_load": {"target_hz": 30, "mode": mode}, "one_way_ms": 0},
                    "mounts": [{"mount": 1, "per_second": [
                        {"t": 0, "starvedCycleShare": 0.1},
                        {"t": 1000, "starvedCycleShare": None, "pacingFallback": True},
                        {"t": 2000, "starvedCycleShare": 0.6},
                        {"t": 3000, "starvedCycleShare": 0.3}]},
                        {"mount": 2, "per_second": [{"starvedCycleShare": 1}]}]}))
            cells = collect(root)["cells"]
            self.assertEqual([c["gpu_load_mode"] for c in cells], ["always", "coupled"])
            for cell in cells:
                row = cell["rows"][0]
                self.assertEqual(row["starvedCycleShare_timeline"], {"min": 0.1, "median": 0.3, "max": 0.6, "samples": 3})
                self.assertEqual(len(row["per_second"]), 4)
                self.assertTrue(row["per_second"][1]["pacingFallback"])
            text = io.StringIO()
            with redirect_stdout(text):
                tables({"cells": cells})
            self.assertIn("Hz (coupled)", text.getvalue())
            self.assertIn("0.100/0.300/0.600", text.getvalue())

    def test_active_connection_samples_and_missing_tap(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            leg = Path(tmp)
            (leg / "host/tap").mkdir(parents=True)
            (leg / "host/live-summary.json").write_text(json.dumps({"connections": [
                {"connection": 1}, {"connection": 2}]}))
            for cid, opened, closed in [(1, 50, 150), (2, 150, 300)]:
                records = [{"event": "open", "t_us": opened},
                    {"event": "close", "t_us": closed}]
                (leg / f"host/tap/live-{cid}.jsonl").write_text("\n".join(map(json.dumps, records)))
            (leg / "host/perf-timeline.jsonl").write_text("\n".join(json.dumps({"t_us": t,
                "connections": [{"connection": 1, "w_eff": 1, "srtt_us": 1000},
                    {"connection": 2, "w_eff": 3, "srtt_us": 3000}]}) for t in [100, 150, 200, 250]))
            row = summarize(leg, {"pacing": {"preset": "balanced", "host_window_start_us": 100, "host_window_end_us": 250}})
            self.assertEqual(row["w_eff_share"], {"1": 1/3, "3": 2/3})
            self.assertEqual(row["w_eff_seconds"], 3)
            self.assertEqual([c["w_eff_seconds"] for c in row["per_connection"]], [1, 2])
            self.assertEqual(row["host_draws"], 0)
            row["staleness_delta_ms"] = {q: None for q in ("p50", "p95", "mean")}
            row["draws_vs_fidelity"] = None
            text = io.StringIO()
            with redirect_stdout(text):
                tables({"cells": [{"scene_profile": "default", "load_hz": 30,
                    "one_way_ms": 0, "gpu_load_mode": "coupled", "rows": [row]}]}, True)
            self.assertIn("| preset | connection |", text.getvalue())
            self.assertIn(f"| {leg.name} | 1 |", text.getvalue())
            self.assertIn(f"| {leg.name} | 2 |", text.getvalue())
            # A missing tap must not turn partial evidence into a complete total.
            (leg / "host/tap/live-1.jsonl").unlink()
            row = summarize(leg, {"pacing": {"preset": "balanced", "host_window_start_us": 100, "host_window_end_us": 250}})
            self.assertIsNone(row["sends_per_s"])
            self.assertIsNone(row["host_draws"])
            self.assertIsNone(row["staleness_submitted_ms"]["mean"])
            self.assertEqual(row["per_connection"][1]["host_draws"], 0)

    def test_balanced_trial_rates(self):
        scratch = Path(__file__).resolve().parents[4] / ".local"
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            for preset in ("balanced", "balanced-rep", "fidelity", "w1", "w8"):
                leg = root / "30/24" / preset
                (leg / "rx").mkdir(parents=True)
                balanced = preset.startswith("balanced")
                (leg / "rx/client-device.json").write_text(json.dumps({"pacing": {
                    "preset": "balanced" if balanced else "fidelity" if preset == "fidelity" else None,
                    "gpu_load": {"target_hz": 30}, "one_way_ms": 24,
                    "host_window_start_us": 1000000, "host_window_end_us": 3000000,
                    "draws_per_s": 15, "fallback_at_mount_ms": 1500 if balanced else None,
                    "fallback_at_first_frame_ms": 1300 if balanced else None,
                    "trial": {"draws": 10, "window_s": 1, "draws_per_s": 10} if balanced else None,
                    "after_fallback": {"draws": 20, "window_s": 1, "draws_per_s": 20} if balanced else None,
                }, "mounts": [{"mount": 1, "per_second": [
                    {"t": 0, "starvedCycleShare": 0.8, "pacingFallback": False},
                    {"t": 1000, "starvedCycleShare": 0.1, "pacingFallback": True}]}]}))
            result = collect(root)
            rows = {r["label"]: r for r in result["cells"][0]["rows"]}
            for preset in ("balanced", "balanced-rep"):
                row = rows[preset]
                self.assertEqual(row["trial"], {"draws": 10, "window_s": 1, "draws_per_s": 10})
                self.assertEqual(row["after_fallback"], {"draws": 20, "window_s": 1, "draws_per_s": 20})
                self.assertEqual(row["fallback_at_mount_ms"], 1500)
                self.assertEqual(row["per_second"][0]["starvedCycleShare"], 0.8)
            for preset in ("fidelity", "w1", "w8"):
                self.assertIsNone(rows[preset]["trial"])
                self.assertIsNone(rows[preset]["after_fallback"])
            text = io.StringIO()
            with redirect_stdout(text):
                tables(result)
            self.assertIn("balanced trial/after draws/s", text.getvalue())
            self.assertIn("10.000/20.000", text.getvalue())
            self.assertIn("Balanced -> fidelity", text.getvalue())
            # Legacy reports cannot reconstruct exact draw rates from 1 Hz counters.
            legacy = summarize(root, {"pacing": {"preset": "balanced",
                "host_window_start_us": 1, "host_window_end_us": 2}})
            self.assertIsNone(legacy["trial"])
            self.assertIsNone(legacy["after_fallback"])

    def test_missing_and_zero(self):
        self.assertIsNone(ratio(5, 0))
        self.assertIsNone(subtract(None, 1))
        self.assertIsNone(quantile([], 0.5))
        scratch = Path(__file__).resolve().parents[4] / ".local"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            row = summarize(Path(tmp), {"pacing": {"host_window_start_us": 1, "host_window_end_us": 2, "preset": "balanced", "draws_per_s": 0}})
            for field in ("sends_per_s", "sent_all_total", "sends_per_draw", "srtt_p50_ms"):
                self.assertIsNone(row[field])
            self.assertEqual(row["w_eff_share"], {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, nargs="?")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true")
    output.add_argument("--by-connection", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(SummaryTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if not args.out:
        parser.error("out is required without --self-test")
    result = collect(args.out)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        tables(result, args.by_connection)
    if not result["cells"]:
        parser.exit(1, "pacing-proof-summary: no pacing reports found\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
