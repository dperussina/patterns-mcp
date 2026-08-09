import { describe, expect, it } from "vitest";

import {
  MAX_IDENTIFIER_LENGTH,
  checkIdentifier,
  isReservedIdentifier,
} from "../../src/engine/options/identifiers.js";

function problem(
  value: string,
  options?: Parameters<typeof checkIdentifier>[1],
): string {
  const result = checkIdentifier(value, options);
  if (result.ok) {
    throw new Error(`expected "${value}" to be refused`);
  }
  return result.problem;
}

describe("checkIdentifier", () => {
  it.each(["Person", "person", "_private", "$dollar", "Order2", "aB$_9"])(
    "accepts the valid identifier %s",
    (value) => {
      expect(checkIdentifier(value).ok).toBe(true);
    },
  );

  it("refuses an empty identifier", () => {
    expect(problem("")).toBe("identifier must not be empty");
  });

  it.each(["2fast", "has space", "has-hyphen", "has.dot", "emoji😀", "café"])(
    "refuses the malformed identifier %s",
    (value) => {
      expect(problem(value)).toContain("is not a valid identifier");
    },
  );

  it("refuses path separators and traversal, which is why the shape is an allowlist", () => {
    for (const value of ["../etc/passwd", "a/b", "a\\b", "..", "a\0b"]) {
      expect(problem(value)).toContain("is not a valid identifier");
    }
  });

  it.each([
    "class",
    "return",
    "await",
    "yield",
    "let",
    "static",
    "implements",
    "eval",
  ])("refuses the reserved word %s", (value) => {
    expect(problem(value)).toBe(
      `identifier "${value}" is reserved and cannot be used as a generated name`,
    );
  });

  it.each(["string", "number", "unknown", "never", "any"])(
    "refuses the built-in type name %s, which would shadow itself in every annotation",
    (value) => {
      expect(problem(value)).toContain("is reserved");
    },
  );

  it.each(["Promise", "Error", "Map", "Object", "globalThis"])(
    "refuses the shadowed global %s",
    (value) => {
      expect(problem(value)).toContain("is reserved");
    },
  );

  it("refuses a collision with an identifier the pattern itself emits", () => {
    expect(problem("PersonStore", { reserved: ["PersonStore"] })).toBe(
      'identifier "PersonStore" collides with an identifier this pattern emits; choose another name',
    );
  });

  it("accepts a name that only resembles an emitted identifier", () => {
    expect(
      checkIdentifier("PersonStores", { reserved: ["PersonStore"] }).ok,
    ).toBe(true);
  });

  it("enforces the length cap at the boundary", () => {
    const atLimit = "a".repeat(MAX_IDENTIFIER_LENGTH);
    expect(checkIdentifier(atLimit).ok).toBe(true);
    expect(problem(`${atLimit}a`)).toContain(
      `the limit is ${MAX_IDENTIFIER_LENGTH}`,
    );
  });

  it("accepts an explicit tighter cap", () => {
    expect(problem("abcdef", { maxLength: 3 })).toContain("the limit is 3");
  });

  it("truncates the echoed value, so a refusal cannot be used to amplify input", () => {
    const message = problem("z".repeat(500));
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(120);
  });

  it("uses the supplied label so a caller knows which input to fix", () => {
    expect(problem("class", { label: "entityName" })).toContain(
      'entityName "class"',
    );
  });

  it("applies rules in a fixed order, so a refusal message is stable", () => {
    // "class" is both reserved and, here, over a tight cap: length is reported
    // first because it is checked first, and it must stay that way.
    expect(problem("class", { maxLength: 2 })).toContain("the limit is 2");
  });
});

describe("isReservedIdentifier", () => {
  it("reports membership of the built-in denylist", () => {
    expect(isReservedIdentifier("class")).toBe(true);
    expect(isReservedIdentifier("Person")).toBe(false);
  });
});
