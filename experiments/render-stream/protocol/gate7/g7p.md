### G7p — measurement matrix, report/2 (sonnet)

- **Files**: `render-stream-report.ts` (/2, including `provenance.env` and the device rows),
  `report-gate7.ts`, and the `g7-p` matrix driver.
- **Checks**: `report-valid`, `report-complete` and `repeat-stability` (CoV > 10 % named), as G6p;
  `after-window-shots` per receiver; `device-rows-present` (Q12's device rows for the g31, each with its
  `device_id`, its `env.device` block, its build sha equal to the report's, and its desktop control
  row). A row from an older build is omitted and named, never shown as current (D28). The g31's rows
  come from G7v's run when it is the report's build, and are re-run unattended if it is attached
  when the build has moved. **The g86 is descoped (user, 2026-10-22: "Moto G86 arms are not needed.
  Moto G31 is enough."): no g86 rows are required, none are pending, and nothing waits for an
  attended session.**

**As built (G7p).** See [results/gate7/g7p.md](../../results/gate7/g7p.md) for the numbers.

- `render-stream-report/2` lives in `scripts/lib/render-stream-report.ts` beside /1 (`validate`
  accepts both); `scripts/report-gate7.ts` builds and validates it (`pnpm render-stream:report2`).
  There is one report per receiver kind (`provenance.receiver.kind`), so the three kinds are three
  files, `<out>/render-stream-report-<native|web|gsw>.json`.
- The matrix driver is `run-gate7.sh --live --legs g7-p`: G6p's group, unforked, with
  `G7P_MATRIX=1` (`lib/gate6p-legs.sh` `run_g7p`), once per kind and credit window, into
  `<out>/gate6/matrix-<kind>-w<window>/`. `lib/gate7p-checks.ts` judges it.
- **Not run, and named:** `fetch_concurrency` 4 for `gsw-canvas` (Q12). GSW's fetcher is one `fetch`
  at a time and has no concurrency option; adding one changes the bundle the g31 rows were
  measured on (D28). Every scenario carries `fetch_concurrency: 1`.
- **Not in the report:** the `recv_*_rss`, `recv_js_heap`, `recv_wasm_heap` and device PSS memory
  fields and the `repeats[].startup` block are not filled by the matrix legs, which run no browser
  memory sampler; they are G7k's soak and startup runs, and the g31's startup rows come from
  G7v's. `startup` is `null` on a matrix repeat; the g31 startup summaries ride in `device_startup`.
- The device rows' desktop control row is G7v's `ctl:` run (`pace` and `scene` only); an `hd` row
  has none, and `device-rows-present` requires a control row for `pace` and `scene`.
