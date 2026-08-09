import { describe, expect, it } from "vitest";

import {
  LegalityRuleSchema,
  OptionSchema,
  PatternSchema,
} from "../../src/engine/catalog/schema.js";

const enumOption = {
  name: "errorMode",
  type: "enum",
  values: ["result", "throw"],
  default: "result",
  description: "How failures surface to the caller.",
  affects: ["core"],
};

const patternBase = {
  name: "result-type",
  title: "Result Type",
  category: "type-safety",
  intent: "Model failure as a value rather than a thrown exception.",
  relatedPatterns: [],
  provenance: "original",
  license: "original",
  tier: 1,
};

const generativePattern = {
  ...patternBase,
  kind: "generative",
  supportsSplit: true,
  variants: [],
  options: [enumOption],
  legality: [],
};

const advisoryPattern = {
  ...patternBase,
  kind: "advisory",
  advisory: {
    alternative: "Use a discriminated union.",
    rationale: "Narrowing is structural, so no runtime tag check is needed.",
  },
};

describe("OptionSchema", () => {
  it("accepts a well-formed enum option", () => {
    expect(OptionSchema.safeParse(enumOption).success).toBe(true);
  });

  it("rejects a default outside the declared value space", () => {
    expect(OptionSchema.safeParse({ ...enumOption, default: "panic" }).success).toBe(false);
  });

  it("rejects `values` on a non-enum option", () => {
    const result = OptionSchema.safeParse({
      name: "includeTests",
      type: "boolean",
      default: true,
      description: "Whether to emit tests.",
      affects: ["tests"],
      values: ["yes", "no"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an option name that is not camelCase", () => {
    expect(OptionSchema.safeParse({ ...enumOption, name: "ErrorMode" }).success).toBe(false);
  });

  it("rejects an empty description, since descriptions are the caller's only guide", () => {
    expect(OptionSchema.safeParse({ ...enumOption, description: "" }).success).toBe(false);
  });
});

describe("LegalityRuleSchema", () => {
  it("accepts a set-membership rule", () => {
    const result = LegalityRuleSchema.safeParse({
      when: { operator: "in", option: "emitScope", values: ["binding-only"] },
      forbids: { option: "includeTests", values: [true] },
      rule: "Binding-only bundles cannot carry tests for machinery they do not emit.",
      alternatives: ["full"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a rule with no alternatives, which would leave a caller stuck", () => {
    const result = LegalityRuleSchema.safeParse({
      when: { operator: "eq", option: "emitScope", value: "full" },
      forbids: { option: "includeTests", values: [true] },
      rule: "Some rule.",
      alternatives: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an array payload on a scalar operator", () => {
    const result = LegalityRuleSchema.safeParse({
      when: { operator: "eq", option: "emitScope", values: ["full"] },
      forbids: { option: "includeTests", values: [true] },
      rule: "Some rule.",
      alternatives: ["core-only"],
    });
    expect(result.success).toBe(false);
  });
});

describe("PatternSchema", () => {
  it("accepts a well-formed generative pattern", () => {
    expect(PatternSchema.safeParse(generativePattern).success).toBe(true);
  });

  it("accepts a well-formed advisory pattern", () => {
    expect(PatternSchema.safeParse(advisoryPattern).success).toBe(true);
  });

  it("rejects a generative pattern carrying advisory content", () => {
    const result = PatternSchema.safeParse({
      ...generativePattern,
      advisory: { alternative: "a", rationale: "r" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an advisory pattern carrying options", () => {
    expect(PatternSchema.safeParse({ ...advisoryPattern, options: [] }).success).toBe(false);
  });

  it("rejects an advisory pattern with no advisory content", () => {
    expect(PatternSchema.safeParse({ ...patternBase, kind: "advisory" }).success).toBe(false);
  });

  it("rejects a self-edge in the relation graph", () => {
    const result = PatternSchema.safeParse({
      ...generativePattern,
      relatedPatterns: ["result-type"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an emitScope offered by a pattern that cannot split", () => {
    // Every value would emit the same bundle, so the option advertises a choice that does not
    // exist. Caught in practice by two golden snapshots coming out byte-identical.
    const result = PatternSchema.safeParse({
      ...generativePattern,
      supportsSplit: false,
      options: [
        {
          name: "emitScope",
          type: "enum",
          values: ["full", "core-only"],
          default: "full",
          description: "Which part of the bundle to emit.",
          affects: ["files"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a pattern that cannot split and offers no scope at all", () => {
    const result = PatternSchema.safeParse({
      ...generativePattern,
      supportsSplit: false,
      options: [],
    });
    expect(result.success).toBe(true);
  });

  it.each(["CC-BY-NC-ND-4.0", "CC-BY-ND-4.0", "Weird-1.0"])(
    "rejects the unallowed licence %s",
    (license) => {
      expect(PatternSchema.safeParse({ ...generativePattern, license }).success).toBe(false);
    },
  );

  it("rejects a pattern name that is not lower-kebab-case", () => {
    expect(PatternSchema.safeParse({ ...generativePattern, name: "ResultType" }).success).toBe(
      false,
    );
  });

  it("rejects an over-length intent", () => {
    const result = PatternSchema.safeParse({ ...generativePattern, intent: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects a tier outside 1-3", () => {
    expect(PatternSchema.safeParse({ ...generativePattern, tier: 4 }).success).toBe(false);
  });
});
