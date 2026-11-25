#!/usr/bin/env bash
# Real-time, official-template ABAB clock measurement; never downloads tools.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(realpath "$HERE/../../..")"
OUT="$ROOT/.local/aud3-bench"
CHECK=0
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; OUT="$ROOT/.local/aud3-bench-check"; shift ;;
    --out) OUT="$(realpath -m "$2")"; shift 2 ;;
    --binary) BINARY="$(realpath "$2")"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT/project"
uptime > "$OUT/uptime.txt"
bash "$HERE/lib/quiet.sh" status > "$OUT/quiet-status.txt"
check_load() {
  python3 - "$OUT" <<'PY'
import json, os, platform, sys
from pathlib import Path
out = Path(sys.argv[1]); load = os.getloadavg()[0]
if load >= 4:
    (out / 'voice-clock-cost.json').write_text(json.dumps({
        'schema': 'audio-voice-clock-cost/1', 'status': 'skipped:load',
        'load_1m': load, 'maximum_load_1m': 4, 'unit': 'ns', 'rounds_required': 5,
        'frames_per_round': 10000, 'voices': [0, 8, 128], 'machine': platform.platform(),
    }, indent=2) + '\n')
    (out / 'summary.md').write_text(f'Playback/media-clock CPU bench skipped: 1-minute load {load:.2f} >= 4.\nNo timing results were collected. Run this script again when quiet.\n')
    print(f'audio-clock-bench: skipped, 1-minute load {load:.2f} >= 4')
    sys.exit(77)
PY
}
[ "$CHECK" = 1 ] || check_load
[ -x "$BINARY" ] || { echo 'cached official template missing' >&2; exit 77; }
cp "$HERE/../fixtures/audio-samples/project.godot" "$OUT/project/"
cp "$HERE/../fixtures/audio-samples/main.tscn" "$OUT/project/"
cat > "$OUT/project/main.gd" <<'GD'
extends Node2D
func _ready() -> void:
	GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
func _process(_dt: float) -> void:
	if Engine.get_process_frames() >= (30 if OS.get_environment("GRC_AUDIO_TEST_BENCH_VALIDATE") == "1" else 10300):
		get_tree().quit()
GD
LEGS_LOG=audio-clock-bench
HEADLESS_TIMEOUT_S=300
RENDERED_TIMEOUT_S=300
RS_FAST_FRAMES=off
export RS_FAST_FRAMES
: > "$OUT/quiet-lock.jsonl"
source "$HERE/lib/gamescope.sh"
source "$HERE/lib/legs.sh"
trap 'if [ -n "$CURRENT_CHILD_PID" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; fi; quiet_release' EXIT
LEG_ENV=()
run_headless "$OUT/import" none -- mise exec -- godot --headless --path "$OUT/project" --editor --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
ROUNDS=(1 2 3 4 5)
[ "$CHECK" = 0 ] || ROUNDS=(1)
for round in "${ROUNDS[@]}"; do
  for voices in 0 8 128; do
    for grant in off on; do
      [ "$CHECK" = 1 ] || check_load
      leg="$OUT/round-$round-$voices-$grant"
      mkdir -p "$leg/evidence"
      LEG_ENV=(GRC_EXTENSION="$ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
        GRC_EVIDENCE_DIR="$leg/evidence" GRC_AUDIO_TEST_BENCH_VOICES="$voices"
        GRC_AUDIO_ABI_TABLE="$HERE/../calibration/abi/godot-4.5.1-audio-driver.json")
      [ "$CHECK" = 0 ] || LEG_ENV+=(GRC_AUDIO_TEST_BENCH_VALIDATE=1)
      if [ "$grant" = on ]; then LEG_ENV+=(GRC_LIVE_TRACKS=audio GRC_AUDIO=sample)
      else LEG_ENV+=(GRC_LIVE_TRACKS= GRC_AUDIO=); fi
      run_headless "$leg" none -- "$BINARY" --headless --path "$OUT/project"
      [ "$(cat "$leg/exit-code.txt")" = 0 ]
      if grep -En 'SCRIPT ERROR|Parse Error|ERROR:' "$leg/stdout.log"; then exit 1; fi
      [ -f "$leg/evidence/voice-clock-round.json" ]
    done
  done
done
legs_quiet_summary
python3 - "$OUT" "$ROOT" "$BINARY" "$CHECK" <<'PY'
import json, math, platform, subprocess, sys
from pathlib import Path
out, root, binary = map(Path, sys.argv[1:4])
if sys.argv[4] == '1':
    for voices in (0,8,128):
        for grant in ('off','on'):
            r = json.loads((out / f'round-1-{voices}-{grant}/evidence/voice-clock-round.json').read_text())
            assert r['validation_only'] and 'check_ns' not in r and 'frame_ns' not in r and 'end_ns' not in r, r
            assert r['granted'] == (grant == 'on'), r
            assert r['finished'] == (voices if grant == 'on' else 0), r
    print('audio-clock-bench: 6 correctness arms passed; 0 timing samples collected')
    sys.exit(0)
def percentiles(xs):
    xs = sorted(xs)
    return {f'p{p}': xs[min(len(xs)-1, math.ceil(len(xs)*p/100)-1)] for p in (50,95,99)} if xs else None
rows = []
for voices in (0,8,128):
    arms = {}
    for grant in ('off','on'):
        runs = [json.loads((out / f'round-{r}-{voices}-{grant}/evidence/voice-clock-round.json').read_text()) for r in range(1,6)]
        assert all(len(r['check_ns']) == len(r['frame_ns']) == 10000 for r in runs)
        assert all(r['granted'] == (grant == 'on') for r in runs)
        if grant == 'on':
            assert all(r['finished'] == voices and len(r['end_ns']) == voices for r in runs), runs
        arms[grant] = {'rounds': 5, 'frames': 50000,
            'check_ns': percentiles([v for r in runs for v in r['check_ns']]),
            'whole_frame_ns': percentiles([v for r in runs for v in r['frame_ns']]),
            'ended_voice_ns': percentiles([v for r in runs for v in r['end_ns']])}
    rows.append({'voices': voices, 'arms': arms})
method = ('steady_clock around the frame playback check only; whole-frame intervals between callbacks; '
          'ended-voice CPU cost is the native stop entry plus Godot internal-process notification on an owned benchmark player, '
          'including its natural finished callback, with no next-frame scheduling wait')
report = {'schema': 'audio-voice-clock-cost/1', 'status': 'complete', 'unit': 'ns',
          'machine': platform.platform(), 'build': subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
          'binary': str(binary), 'method': method, 'order': 'five rounds; voices 0/8/128; off/on ABAB', 'rows': rows}
(out / 'voice-clock-cost.json').write_text(json.dumps(report, indent=2)+'\n')
lines = ['Playback/media-clock CPU cost (ns)', '', '| Voices | Check p50/p95/p99 | End p50/p95 | Frame off/on p50 |', '|---|---|---|---|']
for row in rows:
    on, off = row['arms']['on'], row['arms']['off']; c, e = on['check_ns'], on['ended_voice_ns']
    lines.append(f"| {row['voices']} | {c['p50']}/{c['p95']}/{c['p99']} | " + (f"{e['p50']}/{e['p95']}" if e else 'n/a') + f" | {off['whole_frame_ns']['p50']}/{on['whole_frame_ns']['p50']} |")
lines += ['', report['machine'], 'Build: '+report['build'], '', method]
(out / 'summary.md').write_text('\n'.join(lines)+'\n')
PY
