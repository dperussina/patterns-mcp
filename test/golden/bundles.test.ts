/**
 * One stored expected result per pattern × documented option combination, verified on every change
 * (SC-003).
 *
 * A failure here is not automatically a bug — it means output changed. Either the change is wrong, or
 * it is intended and the updated snapshot is the reviewed evidence of what it did. What this suite
 * removes is the third possibility: output changing without anyone seeing it.
 */

import { describe, expect, it } from "vitest";

import {
  documentedCombinations,
  generativePatterns,
  goldenFor,
  goldenPath,
  label,
  overWideComments,
} from "./harness.js";

const patterns = await generativePatterns();

describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))(
  "$name",
  ({ pattern }) => {
    const combinations = documentedCombinations(pattern);

    it("documents at least one combination to cover", () => {
      // Guards the enumeration itself. A change that made `documentedCombinations` return nothing
      // would otherwise turn this whole file into a suite that asserts nothing and still passes.
      expect(combinations.length).toBeGreaterThan(0);
    });

    it.each(combinations.map((combination) => ({ combination, case: label(combination) })))(
      "$case",
      async ({ combination }) => {
        const golden = await goldenFor(pattern, combination);

        // Prettier never reflows comments, so before T114 a template's prose arrived at whatever width
        // it happened to be written at — up to 172 columns in a file formatted to 80. Asserted here
        // rather than trusted, because the format step is the only place that knows a comment's final
        // column, and a regression would be invisible in every other test: the bundle still compiles
        // and its suite still passes.
        expect(overWideComments(golden)).toEqual([]);

        await expect(golden).toMatchFileSnapshot(goldenPath(pattern.name, combination));
      },
      180_000,
    );
  },
);
