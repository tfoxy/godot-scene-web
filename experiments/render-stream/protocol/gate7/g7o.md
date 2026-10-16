### G7o — decode/apply optimization (restructured 2026-10-15; lands nothing)

G7m recorded `device-decode-over-budget` for GSW on the g31 (scene-full and hd-patch), so G7o was
triggered. D33 splits it:

- **TypeScript tier 1**:
  - Item 1, the record SHA-256 off the decode path, is **G7o1**.
  - Delta-driven validation and resolve are built into `render-stream-core` (D29).
  - Typed-array blocks, the native ASCII check and a wasm SHA-256 are dropped, because Rust has no
    equivalent cost.
  - A decode Worker is deferred until G7v shows a main-thread miss after G7a. It would then host
    the Rust core.
  - If G7x loses (D32), items 2 to 4 of Q13e's GSW list come back as the TypeScript plan, with the
    checks below.
- **GDScript tier 1** is dropped for the web export, because the decode profile projects it to
  miss on the g31. It comes back only by D33's condition.
- **Tier 2** is the plan: G7x, G7a, G7xn and G7xw.
- **The closing bench** belongs to G7x (GSW) and G7xw (the web export). For each, D27's rule still
  applies: a remaining miss is recorded as that receiver's standing `device-decode-over-budget`,
  with numbers, and the budget is unchanged.
- **Checks that carry over** to every increment that changes a decode path: golden-2 to golden-7
  identical in all three languages; gates 0 to 6 natively unchanged; every `g7-*` group already
  landed still green. The sabotage that skips a payload hash check must fail golden
  `resource-hash`.

