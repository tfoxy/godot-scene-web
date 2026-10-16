## G6p report regenerated (2026-10-15)

The G6p artifacts quoted above (`g6p-r1/`) were produced in a worktree that has since been removed
(memory `worktree-removal-loses-artifacts`), so this increment re-ran the matrix once to restore a
validated `render-stream-report/1` other sections can point at. Quiet machine (load average
0.96/1.23/1.26 just before the run, 1.70/1.58/1.57 just after; no other gate run on the box for
the run's first ~65 of its 73 minutes -- one other agent's lightweight `--plan-only` gate 7 run
started in the last few minutes), same box as the original (Ryzen 5 5500, RTX 2060, gamescope
3.16.19 headless). `pnpm render-stream:gate6 -- --legs g6p` is **6/6 on g6p's own checks** again
(`clean-exit`, `after-window-shots`, `deltas-input`, `report-valid`, `report-complete`,
`repeat-stability`), and `pnpm render-stream:report -- validate --repeats 5` confirms the rebuilt
`render-stream-report/1`: `artifacts/render-stream/gate6/20261015T061914Z/`.

**Agreement with the original run, within repeat noise:** bytes per transaction (19 744 B median
gate6-scene, 173 715 B gate6-hd native and half -- matches to the byte); cold-cache fetch counts
and bytes (gate6-scene 128 fetches / 1 525 360 B, identical; gate6-hd native 949 fetches /
5 264 867 B against the original 932 / 5 256 316, a ~2 % difference, plausible repeat variance);
receiver decode/apply/GPU costs (gate6-scene ≈2.0/1.3/0.37 ms, gate6-hd ≈16.1-16.2/12.9-13.0/1.8-2.5
ms, both inside the original's ranges); memory slopes (host 1.2-5.5 MB/min, receiver 49.7-86.1
MB/min, both inside the original's ranges); and D15's deltas/param-bytes analysis, which matches
exactly on three of four kinds (`image` 8 resources/51 ops/2 superseded/147 681 B delta 2 614 287 B;
`shader` 3/8/2/0 B delta 1 158 B; `material` 2/436/13/0 B delta 0 B; `param_bytes_per_frame` 419
frames/429 elements/1.0239 mean) and is off by one version-creating op on the fourth (`mesh`:
1676 ops / 214 144 B delta this run against the original's 1675 / 214 016 B, a 128 B difference) --
`scene-rate-60-hooklog` runs the realtime `rate` timeline (D6), not the deterministic `steps` one,
and `MS` updates its mesh surface every captured host frame, so a ~30 s measured window can
legitimately land one host frame short or long between two runs. Everything else above is
genuinely deterministic content (the fixture's per-step values), which is why it matches exactly.

**Genuine drift, not noise:** gate6-hd native's published-rate ceiling measured **15.0-15.7/s this
run against the original's 13.0-13.3/s** -- consistently higher across every one of rate-15,
rate-30, rate-60, rate-uncapped-host60 and rate-uncapped (each with CoV 2.5-4.6% over 5 repeats, so
not repeat noise within either run), and gate6-scene's uncapped-both-ends ceiling likewise rose
from 105.7/s to 136.0/s. Both point the same way -- a faster or less contended machine state on
this run than the original's -- rather than a behaviour change; nothing in this increment touches
the capture, the receiver or the fixtures. The hook-log cost pair moved too (`scene-rate-60-
hooklog` − `scene-rate-60`: +0.11 s/30 s this run against the original's +0.39 s/30 s), but both
scenarios' own `cpu.host_process_s` CoV is ≈9%, with overlapping min/max ranges across the two
scenarios in this run -- that one is noise, not drift, at five repeats.

