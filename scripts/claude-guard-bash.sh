#!/usr/bin/env bash
# PreToolUse(Bash) guard for godot-scene-web.
#
# Contract (https://code.claude.com/docs/en/hooks.md):
#   stdin = hook JSON, bash command at .tool_input.command
#   deny  = exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#                     "permissionDecision":"deny","permissionDecisionReason":"..."}}
#   warn  = exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}
# PreToolUse hooks fire in ALL permission modes, including bypassPermissions.
#
# Self-test: scripts/test-claude-guard.sh

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // ""')"
[ -n "$cmd" ] || exit 0

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
warn() {
  jq -n --arg c "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
  exit 0
}
has() { printf '%s' "$cmd" | grep -Eq "$1"; }

# ---------------------------------------------------------------------------------------------
# 1. Nested xvfb deadlocks. These four scripts already wrap themselves in `xvfb-run -a`, and so
#    does sts2-couch-coop's scripts/run-gpu.sh.
# ---------------------------------------------------------------------------------------------
if { has 'xvfb-run' || has 'run-gpu\.sh'; } \
   && has '(test:(webgpu-composite|webgl-composite|canvas-pixel)|bench:canvas-upload)'; then
  deny "test:webgpu-composite, test:webgl-composite, test:canvas-pixel and bench:canvas-upload ALREADY run under \`xvfb-run -a\`. Wrapping another xvfb around one deadlocks.

Run the script bare:
  mise exec -- pnpm test:webgpu-composite
Or, if you need a different display setup, put the wrapper around the INNER vitest:
  xvfb-run -a npx vitest run packages/test-harness/test/webgpuCompositeXvfb.test.ts"
fi

# ---------------------------------------------------------------------------------------------
# 2. WARN: `tsx` without the `development` condition resolves packages to dist/, so you measure or
#    test a STALE BUILD instead of your edit. Every package.json script passes --conditions=development.
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])(npx[[:space:]]+)?tsx[[:space:]]' && ! has '\-\-conditions=development'; then
  warn "This \`tsx\` call has no --conditions=development, so @godot-scene-web/* imports resolve to dist/ — you would be running the last BUILT bundle, not your edit. The package.json scripts (perf, parity:fixture, text:*) all pass it. Add --conditions=development, or invoke via \`mise exec -- pnpm <script>\`."
fi

# ---------------------------------------------------------------------------------------------
# 3. WARN: package managers run from the repo root here (AGENTS.md → Tooling).
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])(pnpm|npm|yarn)[[:space:]]' && [ -n "$cwd" ]; then
  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ] && [ "$cwd" != "$root" ] && ! has 'cd[[:space:]]'; then
    warn "AGENTS.md: run package managers from the repo root ($root) unless a package-specific command requires it. You are in $cwd. Also prefer \`mise exec -- pnpm …\` so the pinned node/pnpm/godot versions apply."
  fi
fi

exit 0
