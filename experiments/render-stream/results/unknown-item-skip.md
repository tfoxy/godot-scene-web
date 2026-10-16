## Unknown-item skip (2026-10-10)

`GRC_UNKNOWN_ITEM=skip` is an opt-in diagnostic capture mode, approved by the user on 2026-10-10.
It lets one approved STS2 capture produce a meaningful partial picture before real late join
(gate 8's adoption pass) exists. The default is unchanged: an unknown canvas or item RID is still
gate 0's sticky `capture-failure` / `pre-existing-object`. The contract, the wire keys and the
reason the version does not change are in
[protocol/unknown-item-skip.md](../protocol/unknown-item-skip.md). This mode is implemented in the
mirror's unknown-RID path (`capture/src/rs_mirror.*`), the session/transaction keys (C++ encoder,
TypeScript and GDScript decoders) and gate 0's `preexisting` legs. The receiver's applier is
unchanged: it draws exactly what is published.

### Semantics as built

- **Unknown target.** A call naming an unknown canvas or item RID as its target is counted
  (`unknown_calls`) and not applied. The RID stays remembered until it is freed.
- **Unknown parent.** A known item parented to an unknown RID is linked to it. That item and its
  whole subtree are **withheld**: they are still recorded, but left out of every snapshot (item
  entries, item-level `unsupported` entries, draw-index groups). No published container lists a
  withheld item, so the published state stays a valid, closed render-stream state.
- **Reparenting.** Reparenting a withheld item out publishes it again. A published item that
  enters a withheld subtree is first given a fresh wire id, so it never reappears under an old id
  (`id-reused`).
- **Freeing.** Freeing an unknown RID drops it silently and orphans the known items linked to it,
  which are then published.
- **Resources.** Texture and mesh tables are not filtered.
- **Wire.** The session declares `"unknown_item_policy":"skip"` after `sabotage`. Every
  transaction carries
  `"unknown_items":{"unknown_rids","withheld_items","withheld_commands","unknown_calls"}` after
  `unsupported`, complete in full and patch transactions. Both keys exist only in a skip session,
  at /4 and /5. Strict recordings and every golden vector are byte-identical to before, and a
  decoder that predates this note refuses a skip session (`meta-schema`): it fails closed.
- **Classification.** A transaction with `unknown_rids + withheld_items > 0` is partial. Gate 0's
  `classifyLeg` gives such a leg the new class `partial-unknown-items`, ranked just above
  `success`, so it is never plain success and every real failure still outranks it.
- **Opt-in values.** `GRC_UNKNOWN_ITEM` other than `strict` or `skip` refuses to publish.
  `result.json` `stream` gains `unknown_item_policy` and, under skip, the final mirror counters
  (`unknown_items`).

### Evidence

`fixtures/gate0/preexisting.tscn` now draws. Its `.tscn`-declared `Preexisting` node is
constructed before arming, so its RID is unknown. It draws a 64×64 rect, recoloured at step 2. A
`PreChild` it creates in `_ready` (after arming) is a known item withheld under it; it draws a
48×48 rect, recoloured at step 3. Gate 0 gained the `preexisting-skip` leg (skip capture and a
rendered receiver) and the `preexisting-reference` support leg. The strict `preexisting` leg is
unchanged in shape and still classifies `capture-failure` / `pre-existing-object` (`rid=… op=canvas_item_set_parent frame=1`,
all 52 transactions).

| check                              | result                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `leg-class-preexisting-skip`       | `partial-unknown-items`: 52 of 52 transactions account for 1 unknown RID and 1 withheld item holding 1 command                            |
| `preexisting-skip-account`         | session and `result.json` declare skip; every transaction `ok`, exactly 2 published items, no pre-existing colour; `unknown_calls` 9 → 11 across step 2 |
| `preexisting-skip-reference`       | the 5 `preexisting-reference` shots equal `synthesizePreexistingReference(k)` exactly                                                     |
| `preexisting-skip-receiver`        | the 5 skip-receiver shots equal `synthesizeExpected(k)` exactly                                                                          |
| `preexisting-skip-excluded-region` | at every step the receiver differs from the reference in exactly 6400 px, every pixel of the two pre-existing rects, and nowhere else      |
| `leg-class-preexisting`            | `capture-failure` (`pre-existing-object`), as before                                                                                     |

Mirror ctests cover each exclusion rule (`rs_mirror_test`, 409 checks in all): an unknown target, an
unknown parent, reparenting into and out of a withheld subtree (including into a withheld *known*
item, and a same-frame round trip), freeing an unknown RID (orphaning, silence, recycled RID
values), and patch/full equivalence with no reappearing id over a six-state sequence.
`rs4_codec_test` pins the two keys' placement, and that they are absent from strict, /2 and /3
encodings. `self-test-rs2.ts` covers the TypeScript validator's acceptance and its three
`meta-schema` refusals. `self-test-gate0.ts` covers the new class's precedence against every
other class and five evidence scenarios. The GDScript decoder is exercised by the skip receiver
itself and by the unchanged golden self-test.

### What an STS2 run with `GRC_UNKNOWN_ITEM=skip` will and will not show

It **shows** canvas items created after arming whose parent chain never reaches a pre-arm object:
new top-level items on the root canvas or on canvases created after arming, and their subtrees.
It also says exactly how much is missing, per transaction and in `result.json`. It **does not
show**:

- the UI and scene items built before mod init, or anything parented under them, even if created
  later;
- every item in a `CanvasLayer` created before arming (that canvas is an unknown RID);
- textures created before arming (still `unknown-texture` commands).

It does not raise the 4096 live-item cap, which counts withheld items, and it supports no command
that was unsupported before. Its class is `partial-unknown-items`, or a worse one: on STS2 most
likely `unsupported`, with `partial-unknown-items` among the reasons. Late join is still gate 8.

