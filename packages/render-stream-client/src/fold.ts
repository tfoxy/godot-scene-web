// Pure fold decisions of the GSW live receiver (no DOM, so node self-tests import it).

/**
 * G7rf: the index of the last full transaction in a fold, or -1 when the wait for a resync full is
 * not over: the fold's newest is itself the full (the ordinary path tests it), or no entry in it is
 * a full. Entries before the returned index are the refused ones; it and the later ones apply.
 */
export function foldedFullIndex(
  folded: readonly { encoding: string }[],
  newestEncoding: string,
): number {
  if (newestEncoding === "full") return -1;
  let at = -1;
  for (let i = 0; i < folded.length; i++)
    if (folded[i].encoding === "full") at = i;
  return at;
}
