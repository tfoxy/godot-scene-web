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
# 2. WARN: `git push`. The only sanctioned push path is scripts/remote-validate.sh, which pushes to
#    refs/heads/remote-run/* as a child process (so this guard never sees it); any literal
#    `git push` on the command line is therefore outside the wrapper. Warn, never block.
#    `git` in command position (a quoted `echo git push` also warns — acceptable for a warning),
#    then global options (-C dir, -c k=v, --git-dir=…, --no-pager, …), then `push` as a word.
#    `git stash push` and `git log --grep push` do not match: the subcommand must be `push`.
# ---------------------------------------------------------------------------------------------
git_opt='((-C|-c|--git-dir|--work-tree|--namespace|--exec-path)[[:space:]]+[^[:space:];&|()]+|--[A-Za-z-]+(=[^[:space:];&|()]+)?|-[pP])[[:space:]]+'
git_push_re="(^|[[:space:];&|(])git[[:space:]]+(${git_opt})*push([[:space:];&|)]|\$)"
if has "$git_push_re"; then
  # The push's own arguments: from `push` up to the next command separator.
  push_args="$(printf '%s' "$cmd" | grep -Eo "${git_push_re}[^;&|)]*" | head -n1 | sed -E 's/^.*[[:space:]]push//')"
  strong=0
  # main/master, tags, mirror/all, force, or a bare push (which pushes the current branch).
  printf '%s\n' "$push_args" | grep -Eq '(^|[[:space:]:/+])(main|master)([[:space:]]|$)' && strong=1
  printf '%s\n' "$push_args" | grep -Eq '(--tags|--follow-tags|refs/tags/|[[:space:]:]v[0-9])' && strong=1
  printf '%s\n' "$push_args" | grep -Eq '(--mirror|--all|--force|[[:space:]]-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)|[[:space:]]\+[^[:space:]])' && strong=1
  printf '%s\n' "$push_args" | grep -Eq '^([[:space:]]+-[^[:space:]]*)*([[:space:]]+[^[:space:]-][^[:space:]]*)?[[:space:]]*$' && strong=1
  if [ "$strong" -eq 1 ]; then
    warn "STOP: this \`git push\` may touch main, a tag, or force-update a ref (a bare \`git push\`/\`git push origin\` pushes the CURRENT branch, which may be main). A tag push fires the real GitHub Release plus npm/NuGet publish. Pushes go only through scripts/remote-validate.sh (to remote-run/*); never push main or tags unless the user asked for it in this session."
  fi
  warn "Pushes go only through scripts/remote-validate.sh (to remote-run/*). Never push main or tags unless the user asked for it in this session."
fi

# ---------------------------------------------------------------------------------------------
# 3. WARN: `tsx` without the `development` condition resolves packages to dist/, so you measure or
#    test a STALE BUILD instead of your edit. Every package.json script passes --conditions=development.
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])(npx[[:space:]]+)?tsx[[:space:]]' && ! has '\-\-conditions=development'; then
  warn "This \`tsx\` call has no --conditions=development, so @godot-scene-web/* imports resolve to dist/ — you would be running the last BUILT bundle, not your edit. The package.json scripts (perf, parity:fixture, text:*) all pass it. Add --conditions=development, or invoke via \`mise exec -- pnpm <script>\`."
fi

# ---------------------------------------------------------------------------------------------
# 4. WARN: package managers run from the repo root here (AGENTS.md → Tooling).
# ---------------------------------------------------------------------------------------------
if has '(^|[[:space:];&|])(pnpm|npm|yarn)[[:space:]]' && [ -n "$cwd" ]; then
  root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$root" ] && [ "$cwd" != "$root" ] && ! has 'cd[[:space:]]'; then
    warn "AGENTS.md: run package managers from the repo root ($root) unless a package-specific command requires it. You are in $cwd. Also prefer \`mise exec -- pnpm …\` so the pinned node/pnpm/godot versions apply."
  fi
fi

exit 0
