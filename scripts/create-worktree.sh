#!/usr/bin/env bash
# Create a configured, isolated checkout under .worktrees/.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
if [[ $# != 1 || "$1" == -h || "$1" == --help ]]; then
  echo 'usage: scripts/create-worktree.sh <name>'
  [[ $# == 1 ]] && exit 0 || exit 2
fi
name="$1"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die 'name must be 1-64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit'
case "$name" in godot-4.5.1-stable|godot-docs-4.5|spirectl|sts2-couch-coop) die "reserved name: $name";; esac

root="$(git rev-parse --show-toplevel)"
[[ "$PWD" == "$root" ]] || die 'run from the main checkout root'
[[ "$(git -C "$root" branch --show-current)" == main ]] || die 'run from main'
[[ "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)" == "$root/.git" ]] || die 'run from the main checkout'
[[ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ]] || die 'the main checkout has changes; finish them before creating a worktree'
branch="worktree/$name"
destination="$root/.worktrees/$name"
[[ ! -e "$destination" && ! -L "$destination" ]] || die "destination exists: $destination"
git -C "$root" show-ref --verify --quiet "refs/heads/$branch" && die "branch exists: $branch"

root_created=0
created_links=()
created_checkout=0
cleanup() {
  status=$?
  if (( status != 0 )); then
    if (( created_checkout )) || [[ -d "$destination" ]]; then
      git -C "$root" worktree remove --force "$destination" >/dev/null 2>&1 || true
    fi
    if git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$root" branch -D "$branch" >/dev/null 2>&1 || true
    fi
    for link in "${created_links[@]}"; do rm -f "$link"; done
    if (( root_created )); then rmdir "$root/.worktrees" 2>/dev/null || true; fi
  fi
}
trap cleanup EXIT

if [[ ! -e "$root/.worktrees" ]]; then mkdir "$root/.worktrees"; root_created=1; fi
[[ -d "$root/.worktrees" && ! -L "$root/.worktrees" ]] || die '.worktrees must be a real directory'
for dependency in godot-4.5.1-stable godot-docs-4.5 spirectl sts2-couch-coop; do
  source="$root/../$dependency"
  link="$root/.worktrees/$dependency"
  [[ -d "$source" ]] || die "missing sibling: $source"
  if [[ -L "$link" ]]; then
    [[ "$(realpath "$link")" == "$(realpath "$source")" ]] || die "unexpected link: $link"
  elif [[ -e "$link" ]]; then
    die "expected a symlink at $link"
  else
    ln -s "../../$dependency" "$link"
    created_links+=("$link")
  fi
done

git -C "$root" worktree add -b "$branch" "$destination" main
created_checkout=1
# Trust the new checkout's mise.toml first: every `mise exec` in it fails until it is trusted.
(cd "$destination" && mise trust mise.toml && bash scripts/install-agent-config.sh \
  && mise exec -- pnpm install --frozen-lockfile)
trap - EXIT
printf 'created %s on %s\n' "$destination" "$branch"
