import { z } from "zod";

/**
 * The caller's project settings. Every field is optional and every field has a
 * default, so a caller who supplies nothing still gets a fully determined
 * configuration that is reported back to them (FR-026, FR-007).
 *
 * Defaults are the strictest reasonable choice rather than the most permissive.
 * This is not cosmetic: `strictness` and `moduleStyle` become the compiler
 * options that verification actually runs under, so a loose default would mean
 * verifying weaker code than the caller compiles (FR-025, Principle IX).
 */
export const ConventionsSchema = z
  .strictObject({
    strictness: z.enum(["strict", "strictest", "loose"]).default("strict"),
    moduleStyle: z.enum(["esm", "cjs"]).default("esm"),
    importExtensions: z.enum(["none", "js", "ts"]).default("js"),
    typeImports: z.enum(["inline", "separate"]).default("separate"),
    testFramework: z.enum(["vitest", "node-test", "jest", "none"]).default("vitest"),
    runtime: z.enum(["node", "browser", "neutral"]).default("neutral"),
    /**
     * Passed through to Prettier rather than interpreted here. Left as an open
     * record because Prettier owns the validation of its own options, and
     * duplicating that surface would drift from whichever version is pinned.
     */
    prettierConfig: z.record(z.string(), z.unknown()).default({}),
  })
  // `prefault`, not `default`: it substitutes on the input side, so an absent
  // conventions object still flows through each field's own default rather than
  // requiring a fully-formed object to be repeated here.
  .prefault({});

export type Conventions = z.infer<typeof ConventionsSchema>;

/** The fully resolved defaults, for reporting and for tests to assert against. */
export const DEFAULT_CONVENTIONS: Conventions = ConventionsSchema.parse(undefined);
