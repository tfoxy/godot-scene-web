// @vitest-environment jsdom
//
// The query-string round trip, which silently produced a wrong measurement once.
//
// `PerfServer.scenarioUrl` builds the query with `String(value)`, so EVERY parameter reaches the
// page as text. The node side coerces each one against its scenario's declared default; the page
// has no schema to coerce against, and used to coerce only numbers. So a boolean arrived as the
// string "false", every natural way of reading it (`!== false`, `if (flag)`) saw a truthy value,
// and `--param bakeRotation=false` produced a run byte-identical to `bakeRotation=true` — with
// `"bakeRotation": false` written in its own report. A silently-ignored parameter is the worst
// class of bug this harness can have: it does not fail, it produces a confident wrong answer.

import { describe, expect, it } from "vitest";
import { readParams } from "../src/browser/runtime";

function at(search: string): Record<string, unknown> {
  window.history.replaceState({}, "", `/?${search}`);
  return readParams();
}

describe("readParams", () => {
  it("coerces the boolean tokens, which is what the round trip loses", () => {
    expect(at("bakeRotation=false")).toEqual({ bakeRotation: false });
    expect(at("bakeRotation=true")).toEqual({ bakeRotation: true });
  });

  it("still coerces numbers, including negative and fractional", () => {
    expect(at("labels=24&fontSize=12.5&offset=-3")).toEqual({
      labels: 24,
      fontSize: 12.5,
      offset: -3,
    });
  });

  it("leaves every other value a string", () => {
    // Mechanism names and enum tags must survive untouched — coercing them would be a much louder
    // bug, but it is worth pinning that the rule is narrow.
    expect(
      at("mechanism=hb-atlas&bakeShaper=fillText&scenario=text-render"),
    ).toEqual({
      mechanism: "hb-atlas",
      bakeShaper: "fillText",
      scenario: "text-render",
    });
    // Not the bare tokens: "False" and "0" are a different value and stay as they arrived.
    expect(at("a=False&b=TRUE")).toEqual({ a: "False", b: "TRUE" });
  });

  it("reads no parameters from an empty query", () => {
    window.history.replaceState({}, "", "/");
    expect(readParams()).toEqual({});
  });
});
