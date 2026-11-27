#!/usr/bin/env bash
# Cross-build the same script-pack shell as Android, using the official Windows template.
set -euo pipefail
ulimit -c 0
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi
[[ $# = 0 ]] || { echo "usage: $0" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
SHELL_SRC="$RS/android-shell"
OUT="$SHELL_SRC/build/windows"
EDITOR="$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64"
version="$("$EDITOR" --version)"
[[ "$version" = 4.5.1.stable.official.* ]] || { echo 'non-mono Godot 4.5.1 required' >&2; exit 1; }
bash "$HERE/fetch-windows-template.sh"
bash "$HERE/build-rs-core-ext-windows.sh"
template="${GRC_WINDOWS_TEMPLATE:-$HOME/.cache/godot-render-stream/templates/4.5.1-stable/windows_release_x86_64.exe}"
mkdir -p "$OUT"
rm -f "$OUT/shell.exe" "$OUT/shell.pck" "$OUT/rs_core_ext.dll" "$OUT/build.json"
# Isolated staging leaves the Android build and its served packs untouched.
python3 - "$RS" "$OUT" "$template" <<'PY'
from pathlib import Path
import shutil, sys
rs, out, template = map(Path, sys.argv[1:])
for name in ['shell', 'pack']:
    shutil.rmtree(out / name, ignore_errors=True)
    (out / name).mkdir()
for name in ['project.godot', 'shell.gd', 'shell.tscn', 'export_presets.cfg']:
    shutil.copy2(rs / 'android-shell' / name, out / 'shell' / name)
presets = out / 'shell/export_presets.cfg'
presets.write_text(presets.read_text().replace('[preset.1.options]',
    '[preset.1.options]\ncustom_template/release="' + template.as_posix() + '"'))
shutil.copytree(rs / 'android-shell/pack-demo', out / 'pack', dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('.godot', '*.uid', '*.import'))
receiver = out / 'pack/demo/receiver'
receiver.mkdir()
for path in sorted((rs / 'receiver').glob('*.gd')):
    shutil.copy2(path, receiver / path.name)
shutil.copy2(rs / 'protocol/golden-8/inline.rs8', out / 'pack/demo/recording.rs8')
ext = out / 'shell/ext'
(ext / 'build/windows/x86_64').mkdir(parents=True)
# A Windows-only descriptor avoids loading the runtime adapter into the Linux
# editor (its shutdown is incompatible with this runtime-only extension).
descriptor = (rs / 'receiver/ext/rs_core.gdextension').read_text()
(ext / 'rs_core.gdextension').write_text('\n'.join(
    line for line in descriptor.splitlines() if not line.startswith(('linux.', 'android.', 'web.'))
) + '\n')
shutil.copy2(rs / 'receiver/ext/build/windows/x86_64/rs_core_ext.dll',
             ext / 'build/windows/x86_64/rs_core_ext.dll')
PY
run_editor() {
  local project="$1" log="$2"
  shift 2
  if ! env -u DISPLAY -u WAYLAND_DISPLAY timeout 300 "$EDITOR" --headless --path "$project" "$@" > "$OUT/$log" 2>&1; then
    tail -n 50 "$OUT/$log" >&2
    return 1
  fi
  if grep -E 'SCRIPT ERROR:|Parse Error:|Failed to load script' "$OUT/$log"; then return 1; fi
}
run_editor "$OUT/pack" pack-import.log --import
run_editor "$OUT/pack" pack-export.log --export-pack Pack "$OUT/demo.pck"
mise exec -- node --conditions=development "$SHELL_SRC/inspect-pack.mjs" "$OUT/demo.pck" > "$OUT/pack-files.json"
sha="$(sha256sum "$OUT/demo.pck" | cut -d ' ' -f1)"
mkdir -p "$OUT/client-pack"
mv "$OUT/demo.pck" "$OUT/client-pack/$sha.pck"
python3 - "$OUT/client-pack/manifest.json" "$sha" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({'packVersion': 'demo-1', 'sha256': sys.argv[2], 'entry': 'res://demo/entry.tscn'}, f, indent=2)
    f.write('\n')
PY
run_editor "$OUT/shell" shell-import.log --import
run_editor "$OUT/shell" windows-export.log --export-release 'Windows Desktop' "$OUT/shell.exe"
mise exec -- node --conditions=development "$SHELL_SRC/inspect-windows-shell.mjs" "$OUT/shell.pck" > "$OUT/shell-files.json"
run_editor "$OUT/shell" windows-settings.log --main-pack "$OUT/shell.pck" \
  --script "$SHELL_SRC/check-windows-settings.gd"
cmp "$OUT/rs_core_ext.dll" "$RS/receiver/ext/build/windows/x86_64/rs_core_ext.dll"
python3 - "$OUT" "$template" "$version" <<'PY'
from pathlib import Path
import hashlib, json, sys
out, template = map(Path, sys.argv[1:3])
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
assert (out / 'shell.exe').read_bytes() == template.read_bytes(), 'engine differs from official template'
assert (out / 'shell.pck').stat().st_size > 0
metadata = {
    'schema': 'windows-shell-build/1', 'godot_version': sys.argv[3],
    'template': str(template), 'template_sha256': digest(template),
    'shell_sha256': digest(out / 'shell.exe'), 'pck_sha256': digest(out / 'shell.pck'),
    'adapter_sha256': digest(out / 'rs_core_ext.dll'),
    'renderer': 'forward_plus', 'driver': 'vulkan', 'fullscreen': 'borderless',
    # The official archive contains the D3D12-enabled engine, but no Agility DLLs.
    # The unscored driver switch uses that same engine; Windows validation is separate.
    'd3d12_variant': {'present': True, 'argument': '--rendering-driver d3d12',
                       'agility_sdk_bundled': False, 'validated_on_windows': False},
    'files': sorted(str(p.relative_to(out)) for p in out.glob('*') if p.is_file()),
}
(out / 'build.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata, indent=2))
PY
echo "windows shell: $OUT/shell.exe"
echo "script pack manifest: $OUT/client-pack/manifest.json"
