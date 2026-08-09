import { describe, expect, it } from "vitest";

import { IllegalCombinationError } from "../../src/engine/errors.js";
import {
  evaluateLegality,
  findViolation,
} from "../../src/engine/options/legality.js";
import {
  PatternSchema,
  type GenerativePattern,
} from "../../src/engine/catalog/schema.js";

function patternWith(legality: unknown[]): GenerativePattern {
  const parsed = PatternSchema.parse({
    name: "result-type",
    title: "Result Type",
    category: "type-safety",
    kind: "generative",
    intent: "Model failure as a value.",
    supportsSplit: true,
    variants: [],
    options: [
      {
        name: "emitScope",
        type: "enum",
        values: ["full", "core-only", "binding-only"],
        default: "full",
        description: "Which part of the bundle to emit.",
        affects: ["files"],
      },
      {
        name: "includeTests",
        type: "boolean",
        default: true,
        description: "Whether to emit tests.",
        affects: ["tests"],
      },
      {
        name: "retries",
        type: "integer",
        default: 3,
        description: "How many retries.",
        affects: ["core"],
      },
    ],
    legality,
    relatedPatterns: [],
    provenance: "original",
    license: "original",
    tier: 1,
  });

  if (parsed.kind !== "generative") {
    throw new Error("expected a generative pattern");
  }
  return parsed;
}

const bindingOnlyForbidsTests = {
  when: { operator: "eq", option: "emitScope", value: "binding-only" },
  forbids: { option: "includeTests", values: [true] },
  rule: "Binding-only bundles cannot carry tests for machinery they do not emit.",
  alternatives: ["full", "core-only"],
};

describe("evaluateLegality", () => {
  it("permits a combination no rule forbids", () => {
    const pattern = patternWith([bindingOnlyForbidsTests]);
    expect(() =>
      evaluateLegality(pattern, {
        emitScope: "full",
        includeTests: true,
        retries: 3,
      }),
    ).not.toThrow();
  });

  it("permits the forbidden value when the precondition does not hold", () => {
    const pattern = patternWith([bindingOnlyForbidsTests]);
    expect(() =>
      evaluateLegality(pattern, {
        emitScope: "core-only",
        includeTests: true,
        retries: 3,
      }),
    ).not.toThrow();
  });

  it("refuses when the precondition holds and the value is forbidden", () => {
    const pattern = patternWith([bindingOnlyForbidsTests]);
    expect(() =>
      evaluateLegality(pattern, {
        emitScope: "binding-only",
        includeTests: true,
        retries: 3,
      }),
    ).toThrow(IllegalCombinationError);
  });

  it("carries the rule text and alternatives verbatim", () => {
    const pattern = patternWith([bindingOnlyForbidsTests]);
    try {
      evaluateLegality(pattern, {
        emitScope: "binding-only",
        includeTests: true,
        retries: 3,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      const illegal = error as IllegalCombinationError;
      expect(illegal.rule).toBe(bindingOnlyForbidsTests.rule);
      expect(illegal.alternatives).toEqual(["full", "core-only"]);
      expect(illegal.message).toBe(
        `${bindingOnlyForbidsTests.rule} Valid alternatives: full, core-only.`,
      );
    }
  });

  it("does nothing when a pattern declares no rules", () => {
    expect(() =>
      evaluateLegality(patternWith([]), { emitScope: "full" }),
    ).not.toThrow();
  });
});

function ruleWith(when: unknown): unknown {
  return {
    when,
    forbids: { option: "includeTests", values: [true] },
    rule: "Rule.",
    alternatives: ["false"],
  };
}

describe("operators", () => {
  it("eq matches only the stated value", () => {
    const pattern = patternWith([
      ruleWith({ operator: "eq", option: "retries", value: 0 }),
    ]);
    expect(
      findViolation(pattern, { retries: 0, includeTests: true }),
    ).toBeDefined();
    expect(
      findViolation(pattern, { retries: 1, includeTests: true }),
    ).toBeUndefined();
  });

  it("neq matches everything but the stated value", () => {
    const pattern = patternWith([
      ruleWith({ operator: "neq", option: "retries", value: 0 }),
    ]);
    expect(
      findViolation(pattern, { retries: 1, includeTests: true }),
    ).toBeDefined();
    expect(
      findViolation(pattern, { retries: 0, includeTests: true }),
    ).toBeUndefined();
  });

  it("in matches set membership", () => {
    const pattern = patternWith([
      ruleWith({
        operator: "in",
        option: "emitScope",
        values: ["core-only", "binding-only"],
      }),
    ]);
    expect(
      findViolation(pattern, { emitScope: "binding-only", includeTests: true }),
    ).toBeDefined();
    expect(
      findViolation(pattern, { emitScope: "full", includeTests: true }),
    ).toBeUndefined();
  });

  it("notIn matches non-membership", () => {
    const pattern = patternWith([
      ruleWith({ operator: "notIn", option: "emitScope", values: ["full"] }),
    ]);
    expect(
      findViolation(pattern, { emitScope: "core-only", includeTests: true }),
    ).toBeDefined();
    expect(
      findViolation(pattern, { emitScope: "full", includeTests: true }),
    ).toBeUndefined();
  });

  it("distinguishes a boolean false from an absent value", () => {
    const pattern = patternWith([
      ruleWith({ operator: "eq", option: "includeTests", value: false }),
    ]);
    // includeTests is both the precondition subject and the forbidden option
    // here, so a false value satisfies the precondition but is not forbidden.
    expect(findViolation(pattern, { includeTests: false })).toBeUndefined();
  });

  it("does not treat 0 as absent", () => {
    const pattern = patternWith([
      {
        when: { operator: "eq", option: "retries", value: 0 },
        forbids: { option: "retries", values: [0] },
        rule: "Zero retries is not a retry policy.",
        alternatives: ["1"],
      },
    ]);
    expect(findViolation(pattern, { retries: 0 })).toBeDefined();
  });
});

describe("declared order and first match", () => {
  const firstRule = {
    when: { operator: "eq", option: "emitScope", value: "binding-only" },
    forbids: { option: "includeTests", values: [true] },
    rule: "First rule.",
    alternatives: ["a"],
  };
  const secondRule = {
    when: { operator: "notIn", option: "emitScope", values: ["full"] },
    forbids: { option: "includeTests", values: [true] },
    rule: "Second rule.",
    alternatives: ["b"],
  };

  const violating = { emitScope: "binding-only", includeTests: true } as const;

  it("returns the earlier rule when both match", () => {
    expect(
      findViolation(patternWith([firstRule, secondRule]), violating)?.rule,
    ).toBe("First rule.");
  });

  it("returns the other rule when the declared order is reversed", () => {
    // The same request, the same two rules, a different declared order, and so a
    // different refusal. That is the point: order is the catalogue's decision,
    // not an accident of evaluation.
    expect(
      findViolation(patternWith([secondRule, firstRule]), violating)?.rule,
    ).toBe("Second rule.");
  });

  it("is stable across repeated evaluation", () => {
    const pattern = patternWith([firstRule, secondRule]);
    expect(findViolation(pattern, violating)?.rule).toBe(
      findViolation(pattern, violating)?.rule,
    );
  });
});

describe("a rule that cannot be evaluated", () => {
  it("does not fire when its precondition names an option the pattern lacks", () => {
    // A miswritten catalogue entry must not become a refusal that blames the
    // caller. The catalogue validator is where this surfaces.
    const pattern = patternWith([
      {
        when: { operator: "eq", option: "absentOption", value: "x" },
        forbids: { option: "includeTests", values: [true] },
        rule: "Rule.",
        alternatives: ["a"],
      },
    ]);
    expect(findViolation(pattern, { includeTests: true })).toBeUndefined();
  });

  it("does not fire when the forbidden option is absent", () => {
    const pattern = patternWith([
      {
        when: { operator: "eq", option: "emitScope", value: "full" },
        forbids: { option: "absentOption", values: [true] },
        rule: "Rule.",
        alternatives: ["a"],
      },
    ]);
    expect(findViolation(pattern, { emitScope: "full" })).toBeUndefined();
  });
});
