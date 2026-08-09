/**
 * Suggestions exist so a typo costs one retry (SC-007), so the cases worth asserting are the typos a
 * caller actually makes — not the ones convenient to implement. The predecessor to this code matched
 * substrings only, which silently suggested nothing for a single dropped character.
 */

import { describe, expect, it } from "vitest";

import { nearestNames } from "../../src/engine/catalog/nearest.js";

const catalog = [
  { name: "result" },
  { name: "retry" },
  { name: "circuit-breaker" },
  { name: "builder" },
];

describe("suggesting a name", () => {
  it("recovers a dropped character", () => {
    expect(nearestNames(catalog, "reslt")).toContain("result");
  });

  it("recovers a doubled character", () => {
    expect(nearestNames(catalog, "ressult")).toContain("result");
  });

  it("recovers two swapped characters", () => {
    expect(nearestNames(catalog, "reuslt")).toContain("result");
  });

  it("recovers a wrong character", () => {
    expect(nearestNames(catalog, "resalt")).toContain("result");
  });

  it("still matches a caller who named a family rather than an entry", () => {
    expect(nearestNames(catalog, "circuit")).toContain("circuit-breaker");
  });

  it("offers the closest candidate first", () => {
    // `retry` is one edit from `retr`; `result` is three. Order is the whole value of a suggestion
    // list when a caller retries with the first entry.
    expect(nearestNames(catalog, "retr")[0]).toBe("retry");
  });

  it("says nothing rather than guessing at a name with no near match", () => {
    expect(nearestNames(catalog, "kubernetes-operator")).toEqual([]);
  });

  it("ignores case, because a caller capitalising a name has not made a different mistake", () => {
    expect(nearestNames(catalog, "Result")).toContain("result");
  });

  it("is stable for equally distant candidates", () => {
    // Both are two edits away. Without a total order the message would vary between runs.
    const first = nearestNames([{ name: "aaa" }, { name: "bbb" }], "ab");
    const second = nearestNames([{ name: "bbb" }, { name: "aaa" }], "ab");
    expect(second).toEqual(first);
  });

  it("caps the list so a short name cannot return the whole catalog", () => {
    const many = Array.from({ length: 20 }, (_unused, index) => ({ name: `ab${String(index)}` }));
    expect(nearestNames(many, "ab").length).toBeLessThanOrEqual(5);
  });
});
