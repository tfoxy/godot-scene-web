/** Resource GETs in flight at once, also bounding the live client's worker hashing slots.
 * The host serves at most 8 HTTP connections and a seat may have 2 viewers,
 * so 4 each never queues behind the other viewer. */
export const FETCH_PARALLEL = 4;
