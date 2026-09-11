---
name: release-notes
description: Draft or update the CHANGELOG.md section for a release from the Changelog trailers on commits, in the voice the readers of that repo actually have. Use when cutting a release, when asked what changed since a tag, or when a release section needs rewriting.
---

# Writing the release notes

The notes are assembled from the `Changelog:` trailers people wrote at commit time, not from commit
subjects. A release spans hundreds of commits whose subjects are correct and unreadable
(`fix(mirror): bound raised visual provenance to hitbox`), so the subject is never the note.

Convention and release runbook: [`docs/commit-and-release.md`](../../docs/commit-and-release.md).

## 1. Collect

```bash
scripts/collect-changelog.sh              # since the most recent tag
scripts/collect-changelog.sh v0.1.0 v0.1.1  # or an explicit range
```

Two blocks come back. The first is the trailers, grouped under Keep a Changelog headings. The second
is every `feat`/`fix`/`perf` commit that carries **no** trailer.

**Do not skip the second block.** Each line there is a change someone thought was user-visible
enough to type `feat`/`fix`/`perf` and then never wrote a note for. For each one, read the commit
(`git show <sha>`) and decide: write a line for it, or conclude it is invisible to users. Report
what you decided rather than silently dropping them.

## 2. Write

Rewrite the raw trailers — they were written by whoever landed the change, in a hurry, mid-round.

- **Write for an integrator rendering a scene**, not for the reviewer of the diff. Technical is
  fine, scannable is mandatory. What changes in *their* output, call site, or build? Name the
  package, the export, the Godot property.
  - Good: `Stretched Controls using anchors_preset now match Godot geometry.`
  - Bad: `Rework offset computation in resolveAnchors().`
- **Breaking changes lead the section** and say what the reader has to do about it. Every package
  in packages/ publishes on the same tag, so a break is somebody's build.
- Merge duplicates: five commits fixing one bug are one line.
- Drop pure churn. If a whole group amounts to "we reorganised things", it is not a note.
- Keep it to a screen. A reader scanning a GitHub Release decides in seconds whether to update.

Headings: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security` — only those that have
entries.

## 3. Land it

Put the section in `CHANGELOG.md` above the previous version, dated, and leave `[Unreleased]` empty
above it:

```markdown
## [Unreleased]

## [0.2.0] - 2026-09-20

### Fixed

- …
```

Update the link-reference block at the foot of the file too — `[Unreleased]` compares against the
new tag.

Verify the release path can read what you wrote — `publish.yml` runs the same script and fails the
publish when the section is missing. This repo creates no GitHub Release, so CHANGELOG.md in the
repo is the published record:

```bash
scripts/changelog-section.sh 0.2.0
```

Then the version bump — every publishable package in `packages/` moves together, and
`pnpm release:check-tag` refuses the tag otherwise — and `chore(release): v0.2.0` are step 3 of the
runbook in `docs/commit-and-release.md`. **Do not tag and do not push** — both are the maintainer's
call.
