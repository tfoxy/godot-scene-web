#!/usr/bin/env bash
# Two-sided checks: enforce staged formatting on main without blocking legitimate commits.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${PRE_COMMIT_HOOK:-$ROOT/scripts/githooks/pre-commit}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
mkdir -p "$REPO" "$TMP/hooks"
cp "$HOOK" "$TMP/hooks/pre-commit"
chmod +x "$TMP/hooks/pre-commit"
git init --quiet -b main "$REPO"
git -C "$REPO" config user.name 'Hook test'
git -C "$REPO" config user.email 'hook@example.invalid'
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" config core.hooksPath "$TMP/hooks"
cp "$ROOT/biome.json" "$ROOT/.prettierignore" "$ROOT/.gitignore" "$REPO/"
printf '\nignored.md\n' >> "$REPO/.prettierignore"
printf 'node_modules\n' >> "$REPO/.git/info/exclude"
ln -s "$ROOT/node_modules" "$REPO/node_modules"
printf 'export const value = 1;\n' > "$REPO/clean.ts"
printf '# Title\n' > "$REPO/clean.md"
git -C "$REPO" add .
git -C "$REPO" -c core.hooksPath=/dev/null commit --quiet -m 'test: initial files'
cd "$REPO"
pass=0
fail=0
reset_case() { git reset --hard --quiet HEAD; git clean -fdq; }
run() { # run <description> <exit code> [message] [branch override]
  local rc=0
  env COMMIT_HOOK_BRANCH="${4:-main}" bash "$TMP/hooks/pre-commit" > "$TMP/output" 2>&1 || rc=$?
  if [ "$rc" = "$2" ] && { [ -z "${3:-}" ] || grep -qF "$3" "$TMP/output"; }; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s (exit %s, wanted %s)\n' "$1" "$rc" "$2"
    cat "$TMP/output"
  fi
}

printf 'export const value = 2;\n' > clean.ts
git add clean.ts
run 'clean staged TypeScript' 0
reset_case
printf '# Changed\n' > clean.md
git add clean.md
run 'clean staged Markdown' 0
reset_case
printf 'export const value={x:1}\n' > clean.ts
git add clean.ts
run 'misformatted staged TypeScript' 1 'biome check --write'
run 'misformatted TypeScript on a feature branch' 0 '' feature/hook-test
# A clean working copy must not conceal a bad staged blob.
printf 'export const value = 1;\n' > clean.ts
run 'bad index, clean working tree' 1 'biome check --write'
reset_case
printf '# Bad   \n\n\n' > clean.md
git add clean.md
run 'misformatted staged Markdown' 1 'prettier --write'
run 'misformatted Markdown on a feature branch' 0 '' feature/hook-test
printf '# Title\n' > clean.md
run 'bad Markdown index, clean working tree' 1 'prettier --write'
reset_case
printf 'export const value = 2;\n' > clean.ts
git add clean.ts
printf 'export const value={x:1}\n' > clean.ts
printf '# Bad   \n\n\n' > clean.md
run 'unstaged formatting drift' 0
reset_case
printf '# Bad   \n\n\n' > ignored.md
git add ignored.md
run 'staged Markdown excluded by Prettier' 0
# The staged ignore file, not its working copy, controls the check.
sed -i '/^ignored.md$/d' .prettierignore
run 'unstaged ignore edits do not affect staged checks' 0
git add .prettierignore
run 'staged ignore removal exposes bad Markdown' 1 'prettier --write'
reset_case
printf 'export const value={x:1}\n' > 'space name.ts'
git add 'space name.ts'
run 'filenames with spaces are checked' 1 'biome check --write'
reset_case
git rm --quiet clean.ts clean.md
run 'deleted files are skipped' 0
reset_case
printf 'export const value={x:1}\n' > clean.ts
git add clean.ts
rm node_modules
run 'missing node_modules' 0 'node_modules formatter tools missing'
ln -s "$ROOT/node_modules" node_modules
reset_case
printf 'export const value = 3;\n' > clean.ts
printf '# Changed title\n' > clean.md
git add clean.ts clean.md
# Exercise actual branch detection, without the self-test override.
git symbolic-ref HEAD refs/heads/feature/actual
if env -u COMMIT_HOOK_BRANCH bash "$TMP/hooks/pre-commit" > "$TMP/output" 2>&1; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
git symbolic-ref HEAD refs/heads/main
start="$EPOCHREALTIME"
if env -u COMMIT_HOOK_BRANCH git commit --quiet -m 'test: clean staged commit' > "$TMP/output" 2>&1; then pass=$((pass + 1)); else fail=$((fail + 1)); cat "$TMP/output"; fi
python3 - "$start" "$EPOCHREALTIME" <<'PY'
import sys
print(f"Typical clean commit wall_s: {float(sys.argv[2]) - float(sys.argv[1]):.3f}")
PY
printf 'pre-commit hook: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
