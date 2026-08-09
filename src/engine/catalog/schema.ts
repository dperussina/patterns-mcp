import { z } from "zod";

/** Pattern names are permanently stable public identifiers (FR-015). */
export const PATTERN_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Option names are camelCase and appear verbatim in tool schemas. */
export const OPTION_NAME = /^[a-z][A-Za-z0-9]*$/;

const MAX_PATTERN_NAME = 48;
const MAX_TITLE = 64;
const MAX_INTENT = 200;
const MAX_OPTION_NAME = 32;

/**
 * Licences are an allowlist rather than a denylist of NonCommercial and
 * NoDerivatives terms. A denylist has to anticipate every spelling of a
 * forbidden term; an allowlist fails closed on anything unrecognised, which is
 * the correct default when a single NC-ND entry would poison commercial
 * redistribution of the whole catalogue (FR-036, SC-012).
 */
export const ALLOWED_LICENSES = [
  "original",
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
] as const;

export const CATEGORIES = [
  "type-safety",
  "async-resilience",
  "data-access",
  "functional",
  "creational",
  "structural",
  "behavioral",
] as const;

const patternName = z
  .string()
  .max(MAX_PATTERN_NAME)
  .regex(PATTERN_NAME, "must be lower-kebab-case, starting with a letter");

const optionName = z
  .string()
  .max(MAX_OPTION_NAME)
  .regex(OPTION_NAME, "must be camelCase, starting with a lowercase letter");

/** The value space an option or legality rule can hold. */
const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const CategorySchema = z.enum(CATEGORIES);

/**
 * Options are a union discriminated on `type` rather than a flat record with a
 * refinement. This makes two of the table's rules structural instead of
 * conditional: `values` can only exist on an enum option, and `default` is
 * typed to match the option's own type.
 */
export const OptionSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      name: optionName,
      type: z.literal("enum"),
      values: z.array(z.string().min(1)).min(2),
      default: z.string(),
      description: z.string().min(1),
      affects: z.array(z.string().min(1)),
    })
    .refine((o) => o.values.includes(o.default), {
      message: "default must be one of values",
      path: ["default"],
    }),
  z.strictObject({
    name: optionName,
    type: z.literal("boolean"),
    default: z.boolean(),
    description: z.string().min(1),
    affects: z.array(z.string().min(1)),
  }),
  z.strictObject({
    name: optionName,
    type: z.literal("string"),
    default: z.string(),
    description: z.string().min(1),
    affects: z.array(z.string().min(1)),
  }),
  z.strictObject({
    name: optionName,
    type: z.literal("integer"),
    default: z.number().int(),
    description: z.string().min(1),
    affects: z.array(z.string().min(1)),
  }),
]);

/**
 * A serialisable predicate over resolved options. Deliberately data rather than
 * a function, so `describe_pattern` can show a caller the rule that will be
 * applied to them before they call (FR-013).
 */
export const WhenClauseSchema = z.discriminatedUnion("operator", [
  z.strictObject({
    operator: z.literal("eq"),
    option: optionName,
    value: scalar,
  }),
  z.strictObject({
    operator: z.literal("neq"),
    option: optionName,
    value: scalar,
  }),
  z.strictObject({
    operator: z.literal("in"),
    option: optionName,
    values: z.array(scalar).min(1),
  }),
  z.strictObject({
    operator: z.literal("notIn"),
    option: optionName,
    values: z.array(scalar).min(1),
  }),
]);

/**
 * `rule` and `alternatives` are surfaced verbatim in refusals, which is what
 * lets a caller self-correct without a second discovery call (FR-009, SC-007).
 */
export const LegalityRuleSchema = z.strictObject({
  when: WhenClauseSchema,
  forbids: z.strictObject({
    option: optionName,
    values: z.array(scalar).min(1),
  }),
  rule: z.string().min(1),
  alternatives: z.array(z.string().min(1)).min(1),
});

export const AdvisoryContentSchema = z.strictObject({
  alternative: z.string().min(1),
  rationale: z.string().min(1),
  example: z.string().min(1).optional(),
});

const commonPatternFields = {
  name: patternName,
  title: z.string().min(1).max(MAX_TITLE),
  category: CategorySchema,
  intent: z.string().min(1).max(MAX_INTENT),
  relatedPatterns: z.array(patternName),
  provenance: z.string().min(1),
  license: z.enum(ALLOWED_LICENSES),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
};

/**
 * Patterns are a union discriminated on `kind`, which makes the advisory
 * invariants structural: an advisory entry cannot carry options, and a
 * generative entry cannot carry advisory content. The alternative — a flat
 * object plus refinements — permits both mistakes to be expressed and then
 * caught, which is strictly weaker.
 */
export const PatternSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      ...commonPatternFields,
      kind: z.literal("generative"),
      supportsSplit: z.boolean(),
      variants: z.array(patternName),
      options: z.array(OptionSchema),
      legality: z.array(LegalityRuleSchema),
    })
    .refine((p) => !p.relatedPatterns.includes(p.name), {
      message: "a pattern may not relate to itself",
      path: ["relatedPatterns"],
    }),
  z
    .strictObject({
      ...commonPatternFields,
      kind: z.literal("advisory"),
      advisory: AdvisoryContentSchema,
    })
    .refine((p) => !p.relatedPatterns.includes(p.name), {
      message: "a pattern may not relate to itself",
      path: ["relatedPatterns"],
    }),
]);

/** One catalogue shard, as stored in `data/patterns/{category}.json`. */
export const CatalogShardSchema = z.strictObject({
  /**
   * Permitted so a hand-authored shard can point at `data/schema.json` and get
   * editor completion. Without this allowance the strict object rejects the very
   * reference that makes the published schema usable. Not otherwise interpreted.
   */
  $schema: z.string().optional(),
  patterns: z.array(PatternSchema),
});

export type Category = z.infer<typeof CategorySchema>;
export type Option = z.infer<typeof OptionSchema>;
export type WhenClause = z.infer<typeof WhenClauseSchema>;
export type LegalityRule = z.infer<typeof LegalityRuleSchema>;
export type AdvisoryContent = z.infer<typeof AdvisoryContentSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type GenerativePattern = Extract<Pattern, { kind: "generative" }>;
export type AdvisoryPattern = Extract<Pattern, { kind: "advisory" }>;
export type CatalogShard = z.infer<typeof CatalogShardSchema>;
