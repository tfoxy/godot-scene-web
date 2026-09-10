#!/usr/bin/env bash
# Self-test for scripts/claude-guard-bash.sh. Two-sided: the must-allow half replays the command
# lines in docs/, because a guard that blocks a documented workflow is worse than no guard.
#
# Every case runs twice, once per HARNESS: the Claude Code envelope, and the Codex CLI envelope
# (extra fields, no $CLAUDE_PROJECT_DIR, and a cwd one level down inside the repo, because Codex
# hooks run in the session cwd rather than at the repo root). The same guard file is registered
# with both CLIs, so an envelope-shape difference that changes a verdict is a bug.
#
# The cwd is NOT incidental here: rule 3 deliberately warns when a package manager runs outside the
# repo root, so cases that trip it have a different — and correct — verdict under the Codex
# harness. Those declare it with the 4th argument to `expect`; everything else must match.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
GUARD="$REPO/scripts/claude-guard-bash.sh"

pass=0; fail=0

verdict() { # verdict <cmd> [cwd] [claude|codex]
  local cmd="$1" cwd="${2:-$REPO}" harness="${3:-claude}" out
  if [ "$harness" = codex ]; then
    # Codex runs the hook in the session cwd, which is routinely a subdirectory.
    if [ -d "$cwd/packages" ]; then cwd="$cwd/packages"; fi
    out="$(jq -n --arg c "$cmd" --arg d "$cwd" \
            '{hook_event_name:"PreToolUse",tool_name:"Bash",cwd:$d,
              session_id:"0195f0de-0000-7000-8000-000000000000",
              turn_id:"turn_1",transcript_path:($d+"/.codex/transcript.jsonl"),
              permission_mode:"default",tool_use_id:"call_1",
              tool_input:{command:$c}}' \
          | env -u CLAUDE_PROJECT_DIR bash "$GUARD")"
  else
    out="$(jq -n --arg c "$cmd" --arg d "$cwd" \
            '{hook_event_name:"PreToolUse",tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' \
          | bash "$GUARD")"
  fi
  if   printf '%s' "$out" | grep -q '"permissionDecision":[[:space:]]*"deny"'; then echo deny
  elif printf '%s' "$out" | grep -q 'additionalContext'; then echo warn
  else echo allow; fi
}

expect() { # expect <want> <cmd> [cwd] [codex-want]  — asserted under BOTH harnesses
  local want="$1" cmd="$2" cwd="${3:-$REPO}" codex_want="${4:-$1}" got harness w
  for harness in claude codex; do
    w="$want"
    [ "$harness" = codex ] && w="$codex_want"
    got="$(verdict "$cmd" "$cwd" "$harness")"
    if [ "$got" = "$w" ]; then pass=$((pass+1)); else
      fail=$((fail+1)); printf 'FAIL  [%s] want=%-5s got=%-5s  %s\n' "$harness" "$w" "$got" "$cmd" >&2
    fi
  done
}

echo "== must block =="
expect deny 'xvfb-run -a pnpm test:webgpu-composite'
expect deny 'xvfb-run -a -s "-screen 0 2560x1440x24" pnpm bench:canvas-upload'
expect deny '../sts2-couch-coop/scripts/run-gpu.sh pnpm test:canvas-pixel'

echo "== must warn, not block =="
expect warn 'tsx packages/perf-harness/src/cli.ts run S1'
expect warn 'pnpm test' "$REPO/packages/canvas"

echo "== must allow =="
# `pnpm` cases warn under the Codex harness on purpose: its session cwd is a subdirectory, which is
# exactly what rule 3 (run package managers from the repo root) exists to catch.
expect allow 'mise exec -- pnpm test:webgpu-composite' "" warn
expect allow 'pnpm test:canvas-pixel' "" warn
expect allow 'xvfb-run -a npx vitest run packages/test-harness/test/webgpuCompositeXvfb.test.ts'
expect allow 'mise exec -- pnpm check' "" warn
expect allow 'mise exec -- pnpm build' "" warn
expect allow 'mise exec -- pnpm test' "" warn
expect allow 'mise exec -- pnpm test:parity' "" warn
expect allow 'tsx --conditions=development packages/perf-harness/src/cli.ts run S1'
expect allow 'mise exec -- pnpm perf -- validate-report artifacts/perf/run/report.json' "" warn
expect allow 'biome check .'
expect allow 'vitest run packages/tscn-parser'
expect allow 'bash scripts/install-agent-config.sh'

echo "== must allow: command lines in docs/ =="
expected_deny_re='xvfb-run.*(test:(webgpu-composite|webgl-composite|canvas-pixel)|bench:canvas-upload)'
harvested=0; flagged=0
while IFS= read -r line; do
  harvested=$((harvested+1))
  for harness in claude codex; do
    if [ "$(verdict "$line" "$REPO" "$harness")" = deny ] \
       && ! printf '%s' "$line" | grep -Eq "$expected_deny_re"; then
      flagged=$((flagged+1))
      printf 'FAIL  [%s] guard denies a documented command: %s\n' "$harness" "$line" >&2
    fi
  done
done < <(
  awk '/^```/{inblock=!inblock; next} inblock' docs/*.md README.md AGENTS.md 2>/dev/null \
  | sed 's/^[[:space:]]*//' \
  | grep -E '^(pnpm|npm|npx|mise|tsx|node|xvfb-run|vitest|biome|godot)' \
  | sort -u
)
fail=$((fail+flagged))
echo "  replayed $harvested documented command lines under 2 harnesses, $flagged false positives"

echo
if [ "$fail" -eq 0 ]; then echo "guard self-test: $pass checks passed, 0 failures"
else echo "guard self-test: $pass passed, $fail FAILED" >&2; exit 1; fi
