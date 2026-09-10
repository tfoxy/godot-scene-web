import { describe, expect, it } from "vitest";
import {
  asNumber,
  asResourceRef,
  asVector2,
  decodeFromNativeValue,
  isColorValue,
} from "../src/index";

describe("core value helpers", () => {
  it("keeps helpers narrow and Godot-like", () => {
    expect(asNumber(3)).toBe(3);
    expect(asVector2({ type: "Vector2", args: [4, 5] })).toEqual({
      x: 4,
      y: 5,
    });
    expect(isColorValue({ type: "Color", args: [1, 0, 0, 1] })).toBe(true);
    expect(asResourceRef({ type: "ExtResource", id: "1" })).toEqual({
      type: "ExtResource",
      id: "1",
    });
  });
});

describe("decodeFromNativeValue", () => {
  it("decodes from_native tagged scalars to the canonical contract", () => {
    expect(decodeFromNativeValue("i:3")).toBe(3);
    expect(decodeFromNativeValue("f:1.5")).toBe(1.5);
    expect(decodeFromNativeValue("s:hello")).toBe("hello");
    expect(decodeFromNativeValue("sn:Group")).toBe("Group");
    expect(decodeFromNativeValue("np:Panel/Label")).toEqual({
      type: "NodePath",
      args: ["Panel/Label"],
    });
    expect(decodeFromNativeValue(null)).toBe(null);
    expect(decodeFromNativeValue(true)).toBe(true);
  });

  it("handles the non-finite float spellings", () => {
    expect(decodeFromNativeValue("f:inf")).toBe(Infinity);
    expect(decodeFromNativeValue("f:-inf")).toBe(-Infinity);
    expect(decodeFromNativeValue("f:nan")).toBeNaN();
  });

  it("recurses through plain arrays and Array/Dictionary wrappers", () => {
    expect(decodeFromNativeValue(["i:1", "s:two"])).toEqual([1, "two"]);
    expect(
      decodeFromNativeValue({ type: "Dictionary", args: ["s:key", "i:7"] }),
    ).toEqual({ type: "Dictionary", args: ["key", 7] });
    expect(
      decodeFromNativeValue({ type: "Array", args: ["i:1", "i:2"] }),
    ).toEqual({ type: "Array", args: [1, 2] });
  });

  it("leaves math, packed-array, and resource-ref wrappers untouched", () => {
    expect(decodeFromNativeValue({ type: "Vector2", args: [1, 2] })).toEqual({
      type: "Vector2",
      args: [1, 2],
    });
    // Packed-array elements are raw, never tagged — a literal "i:3" must survive.
    expect(
      decodeFromNativeValue({
        type: "PackedStringArray",
        args: ["i:3", "raw"],
      }),
    ).toEqual({ type: "PackedStringArray", args: ["i:3", "raw"] });
    expect(
      decodeFromNativeValue({ type: "ExtResource", path: "res://a.png" }),
    ).toEqual({ type: "ExtResource", path: "res://a.png" });
  });

  it("keeps an unparseable tag verbatim rather than stripping its prefix", () => {
    // Malformed from_native input: not a real string (that would be "s:f:stop").
    // The decoder must not silently turn it into "stop".
    expect(decodeFromNativeValue("f:stop")).toBe("f:stop");
  });
});
