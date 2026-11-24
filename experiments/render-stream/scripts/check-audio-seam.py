#!/usr/bin/env python3
"""Assert the fixture's command sequence, metadata and vptr restoration."""
import json
from pathlib import Path
import sys

root, mode = Path(sys.argv[1]), sys.argv[2]
evidence = root / "evidence"
checks = 0

def require(ok, name):
    global checks
    if not ok:
        raise SystemExit("FAIL: " + name)
    checks += 1

if mode == "off":
    require(not (evidence / "audio-probe.json").exists(), "unset writes no audio probe")
    require(not (evidence / "audio-commands.jsonl").exists(), "unset writes no audio commands")
    require("[grc-audio]" not in (root / "stdout.log").read_text(), "unset prints no audio output")
else:
    probe = json.loads((evidence / "audio-probe.json").read_text())
    require(probe["status"] == "found", "probe found: " + probe["reason"])
    require(probe["bound_driver"] == "Dummy" and probe["object_matches"] == 1, "unique Dummy object")
    require(len(probe["slots"]) == 38, "complete slot map")
    if mode == "log":
        events = [json.loads(line) for line in (evidence / "audio-commands.jsonl").read_text().splitlines()]
        require(all("refused" not in e for e in events), "all metadata layouts verified")
        times = [e["monotonic_us"] for e in events]
        require(times == sorted(times), "monotonic microseconds")
        require(events[0]["slot"] == "armed" and events[0]["setting_updated"], "ProjectSettings set after probe")
        require(events[-1]["slot"] == "disarm" and events[-1]["was_shadow"] and events[-1]["restored"], "disarm restores original vptr")
        bus_slots = [e["slot"] for e in events if e["slot"] in {
            "set_sample_bus_count", "set_sample_bus_send", "set_sample_bus_volume_db", "set_sample_bus_solo",
            "set_sample_bus_mute", "add_sample_bus", "move_sample_bus", "remove_sample_bus"}]
        require(bus_slots[:11] == ["set_sample_bus_count", "set_sample_bus_send", "set_sample_bus_volume_db",
                "set_sample_bus_solo", "set_sample_bus_solo", "set_sample_bus_mute", "set_sample_bus_mute",
                "add_sample_bus", "move_sample_bus", "remove_sample_bus", "set_sample_bus_count"], "bus command sequence")
        require(any(e["slot"] == "set_sample_bus_volume_db" and e["volume_db"] == -6 for e in events), "bus gain")
        require(any(e["slot"] == "set_sample_bus_send" and e["send"] == "Master" for e in events), "bus send StringName")
        require(any(e["slot"] == "get_sample_playback_position" for e in events), "position query forwards")
        starts = [e for e in events if e["slot"] == "start_sample_playback"]
        require(len(starts) == 6, "six voices, including two overlapping WAV voices and moving 2D player")
        require({e["stream_class"] for e in starts} == {"AudioStreamWAV", "AudioStreamMP3", "AudioStreamOggVorbis"}, "three sampled codecs")
        require(all(e["length_s"] == 0.1 for e in starts if e["stream_class"] == "AudioStreamWAV"), "bound double length retains precision")
        registered = set()
        active = set()
        max_active = 0
        for e in events:
            slot = e["slot"]
            if slot == "register_sample":
                registered.add(e["stream_id"])
            elif slot == "start_sample_playback":
                require(e["stream_id"] in registered, "register precedes start")
                require(e["length_s"] > 0 and e["object_id"] > 0, "stream length and object ID")
                active.add(e["object_id"])
                max_active = max(max_active, len(active))
            elif slot == "stop_sample_playback":
                require(e["object_id"] in active, "stop follows start")
                active.remove(e["object_id"])
        require(max_active >= 2 and not active, "overlapping voices explicitly stopped")
        loop = next(e for e in starts if e["loop_mode"] == 1)
        actions = [e for e in events if e.get("object_id") == loop["object_id"]]
        require([e["paused"] for e in actions if e["slot"] == "set_sample_playback_pause"] == [True, False], "loop pause then resume")
        require(any(e["slot"] == "update_sample_playback_pitch_scale" and e["new_pitch_scale"] == 1.5 for e in actions), "pitch change")
        require(any(e["stream_class"] == "AudioStreamMP3" and abs(e["offset_s"] - 0.025) < 1e-5 for e in starts), "MP3 start offset")
        spatial_id = starts[-1]["object_id"]
        volumes = [e["bus_volumes"] for e in events if e["slot"] == "set_sample_playback_bus_volumes_linear" and e["object_id"] == spatial_id]
        require(len(volumes) >= 2 and any(v != volumes[0] for v in volumes[1:]), "moving 2D player updates bus volumes")
        observation = json.loads((evidence / "audio-fixture.json").read_text())
        require(observation["cache_picked_up"] or observation["fallback_per_player"], "GLOBAL_GET_CACHED observed or per-player fallback")
        require(observation["one_shot_playing_after_end"] and observation["finished_count"] == 0, "Dummy sample voice remains active after nominal end")
        print(json.dumps(observation, sort_keys=True))
print(f"audio-seam {mode}: {checks} passed, 0 failed")
