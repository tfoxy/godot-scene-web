# Unknown-item skip (`GRC_UNKNOWN_ITEM=skip`)

Status: implemented 2026-10-10 (branch `rs/unknown-item-skip`), approved by the user the same day as
an opt-in diagnostic. It lets a single capture of a host that arms late (STS2, armed at mod init)
publish a meaningful partial picture before real late join exists. Late join is gate 8's adoption
pass (binds + `queue_redraw`), and this mode does not replace it.

The default does not change. Without the opt-in, gate 0's unknown-RID policy
([gate0-design.md](gate0-design.md) "Unknown-RID policy") still applies: the first canvas or
item RID the mirror never saw created makes every later transaction `capture-failure` with
`pre-existing-object`.

## Opt-in

`GRC_UNKNOWN_ITEM` is read at arm, together with the other stream policies (`GRC_ROOT_SIZE`, the
resource policy). It takes these values:

- unset, empty or `strict`: the default, gate 0's sticky failure;
- `skip`: this document.

Any other value refuses to publish (`stream.status` `refused`, reason
`invalid GRC_UNKNOWN_ITEM=…`), as an invalid `GRC_ROOT_SIZE` does. Arming is unaffected.

## Semantics (the mirror, `capture/src/rs_mirror.*`)

An **unknown RID** is a canvas or item RID that a canvas, canvas-item or root-viewport hook names
(as its target, or as `canvas_item_set_parent`'s parent) and that the mirror never saw created.
An item left untracked because the live-item cap was hit is not one: it stays a
`mirror-capacity` failure. Under `skip`:

1. **Unknown target.** The call is counted in `unknown_calls` and not applied. The RID is
   remembered as unknown until it is freed. The first one is logged once, as
   `[grc] stream: unknown (skipped) rid=… op=… frame=…`. Nothing fails.
2. **Unknown parent.** `canvas_item_set_parent(known, unknown)` is applied as a link to the
   unknown RID. The item leaves its previous parent's child list, as the server does, and joins
   no published list. The RID cannot be told apart from a pre-arm canvas (a `CanvasLayer`), and
   it does not need to be: either way the item has no correct transform or draw order.
3. **Withheld items.** A known item is withheld while its parent chain reaches an unknown RID.
   An item created after arming whose parent is unknown is withheld too. The mirror keeps
   recording a withheld item's state, commands and `content_version`, but every snapshot leaves
   it out: its item entry, its item-level `unsupported` entries and its draw-index groups (a tie
   among withheld siblings is not declared). No published canvas or item lists a withheld
   child, because a withheld item's parent is unknown or withheld itself. So the published
   state is a closed, valid render-stream state with no dangling ids.
4. **Reparenting out** (a `set_parent` to something known, or to none) publishes the item and
   its subtree again, with everything recorded while it was withheld.
5. **Reparenting in.** If a published item (or any published item in its subtree) enters a
   withheld subtree, either by `set_parent` to an unknown RID or to a withheld item, it gets a
   fresh wire id first. When it later comes back, it comes back as an id no receiver has seen.
   Render-stream-0's `id-reused` rule ("an id absent from the previous transaction never
   reappears") therefore holds over the published stream. Items never published keep their ids.
6. **Free of an unknown RID.** It is dropped silently: it is not counted as `free_unknown`, and
   the RID stops being unknown. Known items linked to it become orphans (parent `null`), as the
   server orphans the children of a freed item, and they are published again under ids never
   shown before. Freeing a withheld known item works as it always has.
7. **Recycled RID values.** `canvas_item_create` or `canvas_create` naming a RID still remembered
   as unknown makes it a known, new object.
8. **Root-viewport hooks** (`viewport_attach_canvas`, `viewport_set_canvas_transform`) that name
   an unknown canvas are counted and not applied. Hooks on a non-root viewport keep their
   session-level `non-root-viewport` entry.
9. **Resources.** The texture (and mesh) tables are not filtered. A command held by a withheld
   item still counts as a reference for tombstone retention, so the table stays consistent when
   that item is published again. A payload that only withheld items draw is carried like any
   other table entry's payload. It needs no special pinning rule.
10. **Patch/full equivalence.** Withholding is a filter applied to the one snapshot taken per
    frame. The full sink, the patch sink and every live connection are all derived from that
    snapshot, so they agree by construction. The mirror's ctests resolve a patch chain against
    the full states, re-keys and orphanings included.

## Wire: render-stream/4 and /5, no version bump

**Session.** A `skip` session adds one key, right after `sabotage`:

```
…, "sabotage": null | {…}, "unknown_item_policy": "skip", "blocks": […]
```

A strict session has no such key. `"strict"` is not a legal value: an absent key is the only way
to spell strict.

**Transaction.** In a session that declares `skip`, every transaction (full and patch alike)
carries one object, right after `unsupported`:

```
…, "unsupported": […],
"unknown_items": {"unknown_rids": <int>=0>, "withheld_items": <int>=0>,
                  "withheld_commands": <int>=0>, "unknown_calls": <int>=0>},
"default_texture_filter": …
```

| field               | meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `unknown_rids`      | unknown canvas/item RIDs named since arming and not freed, at this transaction  |
| `withheld_items`    | known items withheld at this transaction (rule 3)                               |
| `withheld_commands` | the commands those withheld items hold                                          |
| `unknown_calls`     | hook calls that named an unknown RID since arming (cumulative, so coalescing-proof) |

It is complete and never patched, like `status`, `failures` and `unsupported`. In a transaction
of a session that does not declare `skip` it must be absent.

**Validation** (`scripts/lib/render-stream-2.ts`, `receiver/rs2_decoder.gd`). Each of the
following is `meta-schema`:

- either key at /2 or /3;
- a policy value other than `"skip"`;
- an `unknown_items` that is not exactly those four non-negative integers;
- `unknown_items` present when the session does not declare `skip`, or absent when it does.

**Why the version does not change.** Every strict recording stays byte-identical, so every golden
vector and every gate recording is unchanged and needs no regeneration. A /4 or /5 decoder that
predates this note checks exact key lists and refuses a skip session with `meta-schema`. That
fails closed: an old receiver never presents a partial picture as complete. The mode is also a
diagnostic, not a capability receivers must implement. A receiver only has to accept the two
keys, and the receiver's applier ignores the account (it draws exactly what is published). The
C++ encoder emits the keys only at /4 and /5 (`Session::unknown_item_policy`,
`Transaction::unknown_items.present`), and `make_full`/`make_patch`/`resolve` copy the account
verbatim.

## Classification

A transaction is **partial** when `unknown_rids + withheld_items > 0`, meaning its state is
missing something right now (`isPartialUnknownItems` in TypeScript,
`Rs2Decoder.is_partial_unknown_items` in GDScript). A leg with any partial transaction is
classified `partial-unknown-items`. In gate 0's `classifyLeg` that class ranks just above
`success`: a partial capture is never plain success, and every real failure (`capture-failure`,
`unsupported`, `replay-failure`, `pixel-mismatch`) still outranks it. The reasons list always
names it. A strict recording never carries the account, so no other gate's classification
changes.

## Evidence (gate 0)

`fixtures/gate0/preexisting.tscn` gives its `.tscn`-declared `Preexisting` `Node2D` a script
(`preexisting.gd`). That node is constructed before arming, so its RID is unknown. It draws a
64×64 rect at (32, 240) and recolours it at step 2. In `_ready` it adds a child, `PreChild`,
created after arming: a known item parented to the unknown one. `PreChild` draws a 48×48 rect at
(128, 240) and is recoloured at step 3. `expected.json` `preexisting` holds both rects and their
per-step colours. The `run-gate0.sh` legs are:

| leg                     | what                                                                       | expected                                  |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| `preexisting`           | headless capture of `preexisting.tscn`, default (strict) policy            | `capture-failure` / `pre-existing-object` |
| `preexisting-skip`      | the same capture with `GRC_UNKNOWN_ITEM=skip`, then a rendered receiver    | `partial-unknown-items`                   |
| `preexisting-reference` | `preexisting.tscn` rendered with the extension absent (support leg, shots) | —                                         |

The skip leg's checkpoints compare the receiver with `preexisting-reference` after blanking the
two pre-existing rects in both images, so its pixel rule covers exactly what the stream claims to
carry. The checks below use independent expectations synthesized from `expected.json`:

- `preexisting-skip-account`: the session and `result.json` declare `skip`, with one unknown RID
  named. Every transaction is `ok`, with `unknown_items` `{1, 1, 1, …}` and `unknown_calls`
  non-decreasing and growing across step 2. Each publishes exactly 2 items (Subject, Marker),
  and no published `add_rect` uses a pre-existing colour.
- `preexisting-skip-reference`: the reference shots equal `synthesizePreexistingReference(k)`.
- `preexisting-skip-receiver`: the receiver shots equal `synthesizeExpected(k)`. Nothing of
  either pre-existing rect is drawn; the clear colour shows through.
- `preexisting-skip-excluded-region`: at every step the receiver differs from the reference in
  exactly the two rects (every pixel of them) and nowhere else.

## What an STS2 capture with `GRC_UNKNOWN_ITEM=skip` can and cannot show

It **shows** canvas items created after arming whose parent chain never reaches a pre-arm object:
new top-level items on the root canvas, on canvases created after arming, and their subtrees,
with every draw command the capture supports. It also shows the account of what is missing,
per transaction (`unknown_items`) and at the end (`result.json` `stream.unknown_items`).

It **does not show** anything constructed before arming, nor anything under it. That includes
the UI and scene items built before mod init, every item in a `CanvasLayer` created before
arming (its canvas is an unknown RID), and new nodes added under pre-existing parents, which are
withheld. Textures created before arming stay `unknown-texture` commands, as they always have.
Everything this mode cannot show is a job for gate 8's adoption pass. The mode does not raise
the live-item cap (4096, withheld items included), and it does not make any command supported
that was unsupported before (for example `add_mesh` before G5e, materials, particles).
