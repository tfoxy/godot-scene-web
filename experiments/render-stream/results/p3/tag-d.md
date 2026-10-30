# TAG-D: client extensions design (2026-10-30)

**Design landed:** [protocol/client-extensions-design.md](../../protocol/client-extensions-design.md).
It covers:
- the 17 forced mirror rows, classified;
- TAG, the opt-in identity layer: a hello key, a JSON `item_meta` side record and the host's
  resolution through Godot groups, metadata and instance scene/path;
- the client extension API and its override table;
- the /13-freeze recommendation;
- the increments TAG1, TAG2, INP1, PRES-A, TAG3, REC1, OMIT1 and PRES-Q.

This increment is docs plus one read-only tool. It changes no product code and no wire, launches
no game and uses no phone.

## Inventory result

| class | rows |
| ----- | ---- |
| (a) generic, GSW or capture config | `stretchEnabled` (PRES-A: seat at the viewer's aspect, Godot's own `expand`), `reproRecorder` (REC1); `quality`, `shaderMode`, `particleMode` (PRES-Q, deferred) |
| (c) couch module on (b) TAG | `raiseHandCards`, `uiScaling` (no reflow); `raiseHeldCard`, `tapToFocus`, `confirmTap`, `unfocusOnRelease` (these also need INP1 and an input channel) |
| (r) retire under the stream | `backstopOcclusion`, `tweenReplay`, `freezeParticles`, `freezeSpines`, `freezeDecor`, `staticBgEnabled` |

## Measurement: item creation on the kept STS2 recordings

Tool: `experiments/render-stream/scripts/item-census.py <recording>`. It reads the transaction
metas only, through `wire-budget.py`'s reader, and prints a JSON summary.

| | `pm7-a12-1` (/12) | `pm-a11-1` (/11) |
| - | -: | -: |
| frames / transactions | 5,000 / 4,955 | 5,000 / 4,947 |
| items in the opening full | 1,137 | 1,137 |
| peak live items | 4,202 | 4,202 |
| new items after the opening full | 7,288 | 7,288 |
| transactions with any new item | 13 (0.26 %) | 12 (0.24 %) |
| largest burst (items; record bytes) | 1,689; 1,065,304 B | 1,689; 1,065,815 B |
| removed items | 4,229 | 4,229 |
| lifetime p50 / items living ≤ 30 frames | 751 frames / 0 % | 758 frames / 0 % |

pm7's bursts, as frame: new items:
- three screen loads: 17: 1,341; 1,499: 1,193; 1,503: 1,689; 2,250: 1,193; 2,252: 1,310;
  2,258: 515;
- then one burst of 24 and six of 3 or 4.

The six screen-load bursts hold 7,241 of the 7,288 new items. So `item_meta` would be absent from
99.7 % of transactions.

The estimates below are TAG1's to measure. Neither recording carries node identity, so strings
cannot be sized offline.
- **Bytes.** About 21 B a row raw, so the largest burst is ≤ ~60 KB raw with its strings. That is
  ≤ 6 % of the 1.07 MB transaction it precedes.
- **Host time.** At 2–10 µs an item, that burst is 3–17 ms. The design's 2 ms frame budget
  spreads it over 2–9 frames.

## Checks run

- `validate-increment.sh --plan`: the diff (docs, the tool, one smoke-map rule) reaches only the
  pure self-tests.
- `--tier full` was run on that.
- The tool was run on both recordings, with the results above.
