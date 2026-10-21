// GRT4b: `JSON.stringify(a, negZero) === JSON.stringify(b, negZero)` without building either
// string. The checkers compared resolved states by their JSON (gate1-checks.ts stateKey: numbers
// bit-exact, -0 written as "-0"), and that replacer-driven stringify of two whole states per
// frame was the largest single cost of gate 6's checker and most of its garbage
// (results/grt.md "Part 4b"). This walks both values once, in JSON.stringify's own order, and
// stops at the first token that differs; test/self-test-json-key-equal.ts fuzzes it against the
// string comparison.

/** The replacer stateKey uses: -0 serializes as the string "-0", everything else unchanged. */
export function negZeroReplacer(_key: string, value: unknown): unknown {
  return Object.is(value, -0) ? "-0" : value;
}

/** The JSON text of a leaf after negZeroReplacer, or null for an object or array (walked), or
 * undefined for a value JSON.stringify omits (undefined, a function, a symbol). */
function leafToken(v: unknown): string | null | undefined {
  switch (typeof v) {
    case "number":
      return Object.is(v, -0)
        ? '"-0"'
        : Number.isFinite(v)
          ? String(v)
          : "null";
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      // JSON.stringify throws on a bigint; so does this.
      throw new TypeError("Do not know how to serialize a BigInt");
    default:
      return v === null ? "null" : null;
  }
}

class Fallback extends Error {}

function walk(a: unknown, b: unknown): boolean {
  // Fast paths, no token built: two numbers (-0 only equals -0; NaN and the infinities all write
  // null; finite numbers write equal text exactly when equal), two strings.
  if (typeof a === "number" && typeof b === "number") {
    const za = Object.is(a, -0);
    if (za || Object.is(b, -0)) return za && Object.is(b, -0);
    const fa = Number.isFinite(a);
    if (!fa || !Number.isFinite(b)) return !fa && !Number.isFinite(b);
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") return a === b;
  const ta = leafToken(a);
  const tb = leafToken(b);
  if (ta !== null || tb !== null) return ta === tb;
  const oa = a as object;
  const ob = b as object;
  // toJSON (a Date, say) changes what is serialized: leave it to JSON.stringify.
  if (
    typeof (oa as { toJSON?: unknown }).toJSON === "function" ||
    typeof (ob as { toJSON?: unknown }).toJSON === "function"
  )
    throw new Fallback();
  const aa = Array.isArray(oa);
  if (aa !== Array.isArray(ob)) return false;
  if (aa) {
    const xa = oa as unknown[];
    const xb = ob as unknown[];
    if (xa.length !== xb.length) return false;
    for (let i = 0; i < xa.length; i++) {
      // An omitted value is written as null inside an array.
      const ea = leafToken(xa[i]) === undefined ? null : xa[i];
      const eb = leafToken(xb[i]) === undefined ? null : xb[i];
      if (!walk(ea, eb)) return false;
    }
    return true;
  }
  const ra = oa as Record<string, unknown>;
  const rb = ob as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  // Pair the written keys in order, skipping the omitted ones on either side.
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < ka.length && omitted(ra[ka[i]])) i++;
    while (j < kb.length && omitted(rb[kb[j]])) j++;
    if (i === ka.length || j === kb.length)
      return i === ka.length && j === kb.length;
    if (ka[i] !== kb[j] || !walk(ra[ka[i]], rb[kb[j]])) return false;
    i++;
    j++;
  }
}

/** JSON.stringify leaves an object member with this value out. */
function omitted(v: unknown): boolean {
  const t = typeof v;
  return t === "undefined" || t === "function" || t === "symbol";
}

/** Exactly `JSON.stringify(a, negZeroReplacer) === JSON.stringify(b, negZeroReplacer)`. */
export function jsonKeyEqual(a: unknown, b: unknown): boolean {
  try {
    return walk(a, b);
  } catch (e) {
    if (!(e instanceof Fallback)) throw e;
    return (
      JSON.stringify(a, negZeroReplacer) === JSON.stringify(b, negZeroReplacer)
    );
  }
}
