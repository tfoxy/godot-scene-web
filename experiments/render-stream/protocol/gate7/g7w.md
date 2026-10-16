### G7w — render-stream/7 delta, codecs, golden-7 (sonnet)

- **Files**: `protocol/render-stream-7.md` (Q2); `version: … | 7` in `rs2_codec.*`, `rs2_diff.*`,
  `scripts/lib/render-stream-2.ts` and `receiver/rs2_decoder.gd`; hello/error parsing for /7 in the
  C++ control parser (`rs_live.cpp`'s parser only, with no behaviour) and in the GDScript and
  TypeScript self-test helpers; `protocol/golden-7/` (`make_golden.py`, `rate.rs7`, `window2.rs7`,
  `resolved-rate.json`, `invalid/`, `control/`).
- **Checks**: golden-7 `--check`, byte for byte and state for state in all three languages; every
  `control/valid` vector accepted and every `invalid` vector refused with its named code;
  `golden-2/` to `golden-6/` unchanged.
- **Sabotage**: a golden with `credit_window` 2 on a file stream must fail `publication-entry`, and
  a hello with an extra key must fail parsing (both in `invalid/`).

