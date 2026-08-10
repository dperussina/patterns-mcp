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
 * The kinds and tiers a caller can filter on.
 *
 * Declared once, as schemas, and reused by both the catalogue entries and the discovery tools. A tool
 * that spelled its filter's value space out again would be a second definition free to drift, and the
 * drift shows up as a filter accepting a value the catalogue can never hold — a request that is valid,
 * answerable, and always empty.
 */
export const PATTERN_KINDS = ["generative", "advisory"] as const;
export const TIERS = [1, 2, 3] as const;

export const PatternKindSchema = z.enum(PATTERN_KINDS);
export const TierSchema = z.union([
  z.literal(TIERS[0]),
  z.literal(TIERS[1]),
  z.literal(TIERS[2]),
]);

/**
 * The output surfaces an option is allowed to move.
 *
 * A closed vocabulary rather than free text, because the diff-stability harness
 * checks these claims mechanically and free text cannot be checked at all: an
 * option declaring `affects: ["behaviour"]` names nothing the harness can look
 * for, so the declaration passes by being unfalsifiable (SC-005).
 *
 * The values are the file roles, plus `files` for changing which files exist at
 * all. Roles are the right grain because they are already what `emitScope`
 * filters on and what ordering keys off, so a reader who knows what a bundle
 * contains already knows this vocabulary. Finer grain — naming individual
 * declarations — was considered and rejected: the names are identifier-dependent
 * (`OrderResult`, not `Result`), so a pattern could not state them without
 * knowing what a caller will ask it to generate. The harness reaches that grain
 * a different way, by recording each option's blast radius and requiring a
 * widening to be reviewed.
 */
export const AFFECTED_SURFACES = [
  "files",
  "types",
  "core",
  "binding",
  "adapter",
  "example",
  "test",
] as const;

export const AffectsSchema = z.array(z.enum(AFFECTED_SURFACES)).min(1);

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
      affects: AffectsSchema,
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
    affects: AffectsSchema,
  }),
  z.strictObject({
    name: optionName,
    type: z.literal("string"),
    default: z.string(),
    description: z.string().min(1),
    affects: AffectsSchema,
  }),
  z.strictObject({
    name: optionName,
    type: z.literal("integer"),
    default: z.number().int(),
    description: z.string().min(1),
    affects: AffectsSchema,
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
  tier: TierSchema,
};

/**
 * The value space each shared base option must use wherever it appears
 * (data-model.md §"Shared base options"). Sorted, because the comparison is on
 * the set rather than on the order a shard happened to list them in.
 *
 * Presence is a pattern's decision and the space is not: a pattern declares
 * only the base options it can honour, but one that offered
 * `cancellation: "polling"` would cost callers the "learn it once" guarantee
 * everywhere, not just in that pattern.
 */
const BASE_OPTION_VALUES: Readonly<Record<string, readonly string[]>> = {
  async: ["async", "both", "sync"],
  cancellation: ["abort-signal", "none"],
  emitScope: ["binding-only", "core-only", "full"],
  errorMode: ["result", "throw"],
};

function declares(options: readonly Option[], name: string): boolean {
  return options.some((option) => option.name === name);
}

/**
 * The first declared base option whose value space departs from the documented
 * one, or `undefined` when they all agree. A non-enum declaration counts as a
 * departure: these are closed vocabularies, and a `string` version of one is
 * not the same option.
 */
function offSpaceBaseOption(options: readonly Option[]): string | undefined {
  for (const option of options) {
    const expected = BASE_OPTION_VALUES[option.name];
    if (expected === undefined) continue;
    if (option.type !== "enum") return option.name;

    const actual = option.values.toSorted();
    if (actual.length !== expected.length) return option.name;
    if (actual.some((value, index) => value !== expected[index])) return option.name;
  }
  return undefined;
}

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
    })
    /**
     * A pattern that does not separate machinery from bindings has no scope to choose between, so
     * offering one is a promise it cannot keep: every value would produce the same bundle
     * (data-model.md §Pattern, FR-019). The golden snapshots caught exactly that — `core-only` and
     * `full` were byte-identical for such a pattern — which is why the invariant lives here now
     * rather than in a reviewer's memory.
     */
    .refine(
      (p) =>
        p.supportsSplit ||
        !p.options.some(
          (option) =>
            option.name === "emitScope" &&
            option.type === "enum" &&
            option.values.some((value) => value !== "full"),
        ),
      {
        message:
          "a pattern with supportsSplit false must not offer an emitScope beyond full; " +
          "every value would emit the same bundle",
        path: ["options"],
      },
    )
    /**
     * The other direction: a pattern that *can* split has to say so in its options, or the capability
     * is unreachable — `supportsSplit` alone is not something a caller can act on.
     */
    .refine((p) => !p.supportsSplit || declares(p.options, "emitScope"), {
      message: "a pattern with supportsSplit true must declare an emitScope option",
      path: ["options"],
    })
    /**
     * `coreModule` names the module holding machinery the caller already has, which only means
     * something when the pattern separates machinery from bindings in the first place (FR-018).
     */
    .refine((p) => p.supportsSplit || !declares(p.options, "coreModule"), {
      message:
        "coreModule is only meaningful for a pattern that splits; " +
        "a pattern with supportsSplit false must not declare it",
      path: ["options"],
    })
    /**
     * Every pattern can choose to emit a suite or not, and this is the one base option with no
     * pattern-specific caveat, so its absence is always an oversight rather than a decision.
     */
    .refine((p) => declares(p.options, "includeTests"), {
      message: "every generative pattern must declare includeTests",
      path: ["options"],
    })
    /**
     * `verbosity` selects how much of an unchanged bundle is rendered back (FR-028), so it belongs to
     * the response and not to the code. As a pattern option it would enter the resolved set and
     * therefore the provenance hash, and the byte-identical bundle would hash differently according
     * only to how verbosely it had been described — destroying the property the hash exists for.
     */
    .refine((p) => !declares(p.options, "verbosity"), {
      message:
        "verbosity governs the response, not the generated code, and must not be a pattern option; " +
        "declaring it would put it in the provenance hash",
      path: ["options"],
    })
    /**
     * A base option's *value space* is fixed even though its presence is not. "Learn it once" is the
     * entire benefit of a shared vocabulary, and a pattern offering `cancellation: "polling"` would
     * cost a caller that guarantee everywhere.
     */
    .refine((p) => offSpaceBaseOption(p.options) === undefined, {
      message:
        "a declared base option must use its documented value space exactly, " +
        "so that callers learn each one once",
      path: ["options"],
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
export type PatternKind = z.infer<typeof PatternKindSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type WhenClause = z.infer<typeof WhenClauseSchema>;
export type LegalityRule = z.infer<typeof LegalityRuleSchema>;
export type AdvisoryContent = z.infer<typeof AdvisoryContentSchema>;
export type Pattern = z.infer<typeof PatternSchema>;
export type GenerativePattern = Extract<Pattern, { kind: "generative" }>;
export type AdvisoryPattern = Extract<Pattern, { kind: "advisory" }>;
export type CatalogShard = z.infer<typeof CatalogShardSchema>;
