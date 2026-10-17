# Worktree workflow

Run `scripts/create-worktree.sh <name>` from the clean main checkout. It creates
`.worktrees/<name>` on `worktree/<name>`, runs `install-agent-config.sh`, and installs pnpm
dependencies. The name must be unique and cannot replace one of the four shared dependency links.
The links in `.worktrees/` preserve `../godot-4.5.1-stable`, `../godot-docs-4.5`, `../spirectl`,
and `../sts2-couch-coop` from a flat worktree. Use this script instead of an agent's default
`.claude/worktrees/` checkout location.

From main, use `python3 scripts/worktree-admin.py inventory` to see every registered checkout.
`migrate <path> [--name <name>]` moves a checkout into `.worktrees/`, preserving tracked,
untracked, and ignored files. `prune <path> [<path> ...]` removes named checkouts but retains
their branches. Both commands preview by default; add `--apply` after reviewing the output.
Prune refuses dirty, locked, active, and unreviewed artifact-bearing worktrees. After preserving
useful ignored files, pass `--evidence-reviewed`; that flag is an operator attestation, so inspect
the evidence before using it. Never move or remove a checkout while another job reads its path.

Generated evidence stays ignored under the **main** checkout's `artifacts/` directory. Preserve
reports, provenance, inputs, final measurements, and necessary images at their documented relative
paths. Check available disk space before copying; moving selected files on the same filesystem
avoids a second large copy. Add the source commit, paths, and checksums to a committed index and
run its verifier before pruning the source. The October 2026 cleanup index is
[`worktree-evidence-2026-10-17.md`](worktree-evidence-2026-10-17.md).

The detached godot-scene-web checkouts inside CouchCoop's and card-recovery's snapshot folders
belong to those workflows and are outside this repository's cleanup commands. The main checkout
also stays at its existing path.
