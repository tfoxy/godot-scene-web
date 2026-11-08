/** WT preserves each stream's text order; uplink batches are delivered in batch order.
 * Later live texts and uplink texts may interleave. Payloads in this probe are distinct. */
export function trackPayloadsMatch(
  actual: readonly string[],
  live: readonly string[],
  batches: readonly (readonly string[])[],
): boolean {
  const uplink = batches.flat();
  const expected = [...live, ...uplink];
  if (new Set(expected).size !== expected.length)
    throw new Error("track probe payloads must be distinct");
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== expected.length ||
    actual.some((text) => !expected.includes(text))
  )
    return false;
  return [live, uplink].every((stream) => {
    const received = actual.filter((text) => stream.includes(text));
    return received.every((text, i) => text === stream[i]);
  });
}
