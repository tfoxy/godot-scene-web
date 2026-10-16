### G7p — measurement matrix, report/2 (sonnet)

- **Files**: `render-stream-report.ts` (/2, including `provenance.env` and the device rows),
  `report-gate7.ts`, and the `g7-p` matrix driver.
- **Checks**: `report-valid`, `report-complete` and `repeat-stability` (CoV > 10 % named), as G6p;
  `after-window-shots` per receiver; `device-rows-present` (Q12's device rows for both phones,
  the g31 first, each with its `device_id`, its `env.device` block, its build sha equal to the
  report's, and its desktop control row). If one phone's rows come from an older build, they are
  omitted and named, never shown as current (D28). The g31's rows are re-run unattended if it is
  attached; the g86's only in an attended session.

