# Evidence retained during the October 2026 worktree cleanup

The file-level [index](worktree-evidence-2026-10-17.json) records each source worktree, source
commit, retained relative path, file count, and SHA-256 digest. A group digest hashes the sorted
lines `relative/path  file-sha256` with a final newline. Run
`python3 scripts/verify-worktree-evidence.py` from this checkout to verify every indexed file.
The evidence itself is ignored and remains local to this machine.

| Evidence | Main checkout location | Source worktree |
| --- | --- | --- |
| G7e final run and native verdicts | `artifacts/render-stream/gate7/g7e-r3/`, `artifacts/render-stream/g7e-native/r1/` | `agent-ad735ed664d846469` at `9388a787cc9a` |
| G7o1 inputs, desktop comparisons, and device result | `artifacts/render-stream/gate7/g7o1-*` | `agent-a211e459fff86811d` at `534095d6f4c9` |
| G7d desktop inputs and device smoke | `artifacts/render-stream/gate7/g7d-r1/`, `g7d-g31-smoke/`, `g7d-smoke/` | `agent-afcc2e9f03924d8ff` at `7138cb8e06d5` |
| G7m GSW device result and inputs | `artifacts/render-stream/gate7/g7m-g31/`, `g7m-inputs/` | `agent-ae96a73e819b37908` at `c30e96dc0210` |
| G7m web device, desktop, and rebase verdicts | `artifacts/render-stream/gate7/g7m-g31-web*`, `rebase-regress/` | `agent-adf9823f9b2ddd65d` at `6db4c1ade8f4` |
| Gate 6 scene and compact matrix evidence; Gate 5 and 5.5 baselines | `artifacts/render-stream/gate6/20261015T050313Z/`, `gate6/20261015T061914Z/`, `gate5/20261015T073315Z/`, `gate55/20261015T074834Z/` | `agent-a74dbe38bee856063` at `f97d7e2f800e` |
| September Rust canvas and WebGL profiles | `artifacts/perf/canvas-rust/` | `gsw-profile-sol-sep29` at `698339aa6a75`; `gsw-rust-webgl-phase-sep28` at `e2760120eee9` |

Gate 6 keeps the complete scene visual run and final matrix shots, JSON summaries, and logs; large
repeated native recordings were discarded. The G7e native rerun keeps verdicts and logs. The
canonical Gate 6 `render-stream-report.json` was already present in main with identical bytes.
Absolute symlinks within moved run directories were changed to relative links to their moved
targets. G7d, G7m, and G7o1 `inputs.json` now point to recordings and stores in the main checkout;
`inputs.source.json` preserves each original input manifest byte for byte. The linked G7d inputs,
G7o2 work, and locked G7r worktree were still in use at the time of this inventory. G7d's source
checkout must stay until G7o2 stops reading it; G7o2 and G7r evidence must be reviewed when their
jobs finish.
