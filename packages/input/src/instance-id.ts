/** A nonzero Godot ObjectID, kept as decimal text to preserve all 64 bits. */
export function isInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 20 &&
    value[0] !== "0" &&
    !/[^0-9]/.test(value) &&
    (value.length < 20 || value <= "18446744073709551615")
  );
}
