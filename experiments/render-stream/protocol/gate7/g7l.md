### G7l — live in browsers: gates 1, 2, 5f, 5.5f (opus)

- **Files**: the browser live clients (web: the /7 hello in `rs_live_client.gd`; GSW: `live.ts`,
  `fetcher.ts`); live legs in `run-gate7.sh` reusing `legs.sh` host functions; the token through
  the fragment; `received.rs7`; the `g7-1`, `g7-2` live legs, plus g5f and g55f (gsw after G7t/G7s).
- **Checks**: gate 1/2/5f/55f live checks `@web`, `@gsw`; `live-vs-replay` (the file replay of
  `received.rs7` through the same browser equals the live shots); `hello-recorded`;
  `credit-from-paced-loop`; `token-not-logged`; the auth and origin legs of `g7-2`.
- **Sabotages**: the native live sabotages (`stale-coalesce` and others) with their native sets;
  `no-cors`, `no-token` and `bad-http-token` as `g7-2` states.
- *Amended 2026-10-15 (D29):* GSW's live client and fetcher stay TypeScript (WebSocket, `fetch`,
  credit). They feed the core through Q14c's single copy. The web export's live legs run on
  whichever core its build uses (GDScript until G7xw).

