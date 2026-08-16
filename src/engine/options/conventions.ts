import { z } from "zod";

import { ContradictoryConventionsError } from "../errors.js";

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
    testFramework: z
      .enum(["vitest", "node-test", "jest", "none"])
      .default("vitest"),
    runtime: z.enum(["node", "browser", "neutral"]).default("neutral"),
    /**
     * Style options for Prettier. An open record here, but *not* passed through
     * unfiltered: `format/prettier.ts` validates it against an allowlist.
     *
     * A `plugins` entry in a Prettier options object is `import()`ed, so an
     * unfiltered pass-through would make this field an arbitrary-module-loading
     * surface rather than a style setting. Verified against the pinned version,
     * not assumed.
     */
    prettierConfig: z.record(z.string(), z.unknown()).default({}),
  })
  // `prefault`, not `default`: it substitutes on the input side, so an absent
  // conventions object still flows through each field's own default rather than
  // requiring a fully-formed object to be repeated here.
  .prefault({});

export type Conventions = z.infer<typeof ConventionsSchema>;

/** The fully resolved defaults, for reporting and for tests to assert against. */
export const DEFAULT_CONVENTIONS: Conventions =
  ConventionsSchema.parse(undefined);

/**
 * Refuses a set of conventions whose fields are individually valid and jointly impossible.
 *
 * Each axis validates alone, which is exactly why this is needed: `runtime: "browser"` is a fine answer
 * and `testFramework: "node-test"` is a fine answer, and together they ask for a suite that imports
 * `node:test` to run somewhere with no `node:` at all. Before this, that request was served — four files,
 * zero diagnostics, "tests passed" — because the suite is executed here under Node, where it does pass.
 * The caller would have discovered it in their own browser runner, holding output we told them was
 * verified. A refusal that names both settings costs one turn; that costs their trust in the record.
 *
 * Deliberately a short list. A convention pair is only listed where honouring both is *impossible*, not
 * where it is unusual: `moduleStyle: "cjs"` with `importExtensions: "js"` is unfashionable and works, and
 * refusing taste is how a generator becomes something callers work around.
 */
export function assertCoherent(conventions: Conventions): void {
  if (conventions.runtime === "browser" && conventions.testFramework === "node-test") {
    throw new ContradictoryConventionsError(
      ['runtime: "browser"', 'testFramework: "node-test"'],
      "the generated suite imports `node:test`, which a browser runtime cannot resolve, so the tests " +
        "would pass here and fail to load for you.",
      [
        'runtime: "node" or "neutral" to keep `node:test`',
        'testFramework: "vitest" to keep the browser runtime',
      ],
    );
  }
}
