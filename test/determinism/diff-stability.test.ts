/**
 * Changing one option changes no more than that option governs, for every option of every pattern
 * (FR-010, SC-005).
 *
 * The property matters because of how these bundles are meant to be used: generated code is committed,
 * and a caller who flips one option and regenerates reads the diff to see what they did. An option that
 * quietly reflows an unrelated function makes that diff unreadable, and a reader who learns that the
 * diff is mostly noise stops reading it — at which point the real change hides in the noise. The code
 * still compiles and its tests still pass, so nothing else in this repository would notice.
 *
 * Two claims are checked, coarse and fine.
 *
 * The coarse one is `affects`, declared in the catalog and checked here: an option that changes a role's
 * contents must say so. This catches a whole class of error cheaply, and it is the claim
 * `describe_pattern` shows a caller, so it needs to be true.
 *
 * The fine one is recorded rather than declared. `affects` cannot name individual declarations — the
 * names depend on the identifiers a caller supplies — so each option's blast radius is stored as a
 * snapshot instead: the set of declarations it moves. A widening then shows up as a snapshot diff that
 * someone has to approve, which is the same bargain as the golden bundles.
 *
 * Only single-option deviations from the default are swept, matching the requirement's own wording. The
 * limitation is real: this does not cover an option pair that interacts only away from the defaults.
 * The alternative is the full cartesian product, which the golden suite already stores and which grows
 * multiplicatively with each option added.
 */

import { afterAll, describe, expect, it } from "vitest";

import { disposeEngine } from "../../src/engine/generate/index.js";
import { generateBundle } from "../bundle.js";
import { CorrectableError } from "../../src/engine/errors.js";
import { delta, isEmpty } from "./blast-radius.js";

import type { Bundle } from "../../src/engine/generate/index.js";
import type { GenerativePattern, Option } from "../../src/engine/catalog/schema.js";
import type { Delta } from "./blast-radius.js";
import { generativePatterns, goldenIdentifiers } from "../golden/harness.js";

const patterns = await generativePatterns();

/** Values an option can take other than its default. Open-ended types contribute none. */
function deviations(option: Option): readonly (string | boolean)[] {
  switch (option.type) {
    case "enum":
      return option.values.filter((value) => value !== option.default);
    case "boolean":
      return [!option.default];
    case "string":
    case "integer":
      return [];
  }
}

async function bundleFor(
  pattern: GenerativePattern,
  options: Readonly<Record<string, unknown>>,
): Promise<Bundle | CorrectableError> {
  try {
    return await generateBundle({
      pattern: pattern.name,
      identifiers: goldenIdentifiers(pattern),
      options,
    });
  } catch (error) {
    // A refusal is a legitimate answer for a deviation a legality rule forbids, and it has no diff to
    // examine. Anything that is not a refusal is a crash and must not be swallowed — `CorrectableError`
    // rather than `EngineError` because `VerificationError` is one of those too, and catching the
    // supertype here recorded a pattern that failed its own tests as a deviation "refused" by design.
    if (error instanceof CorrectableError) return error;
    throw error;
  }
}

function report(name: string, value: Delta): string {
  const lines = [`## ${name}`, ""];

  if (isEmpty(value)) {
    lines.push("(no change)");
  } else {
    if (value.rolesChanged.length > 0) lines.push(`roles: ${value.rolesChanged.join(", ")}`);
    for (const path of value.filesAdded) lines.push(`+file ${path}`);
    for (const path of value.filesRemoved) lines.push(`-file ${path}`);
    lines.push(...value.declarations);
  }

  return `${lines.join("\n")}\n`;
}

describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))(
  "$name",
  ({ pattern }) => {
    it(
      "confines each option's effect to the surfaces it declares, and records what it moves",
      async () => {
        const baseline = await bundleFor(pattern, {});
        if (baseline instanceof CorrectableError) {
          throw new Error(
            `pattern "${pattern.name}" refuses its own defaults: ${baseline.message}; ` +
              `there is nothing to compare deviations against`,
          );
        }

        const sections: string[] = [];
        const violations: string[] = [];

        for (const option of pattern.options) {
          for (const value of deviations(option)) {
            const name = `${option.name}=${String(value)}`;
            const variant = await bundleFor(pattern, { [option.name]: value });

            if (variant instanceof CorrectableError) {
              sections.push(`## ${name}\n\nrefused: ${variant.code}\n`);
              continue;
            }

            const moved = delta(baseline.files, variant.files);
            sections.push(report(name, moved));

            const declared = new Set<string>(option.affects);

            // An option that changes nothing is not a violation of `affects`, but it is a defect of its
            // own: it is documented as doing something and does not, so a caller setting it gets no
            // effect and no error.
            if (isEmpty(moved)) {
              violations.push(`${name} changed nothing, though it declares ${[...declared].join(", ")}`);
              continue;
            }

            const changedFiles = moved.filesAdded.length + moved.filesRemoved.length > 0;
            if (changedFiles && !declared.has("files")) {
              violations.push(
                `${name} changed which files exist (${[...moved.filesAdded, ...moved.filesRemoved].join(", ")}) ` +
                  `without declaring "files"; it declares ${[...declared].join(", ")}`,
              );
            }

            for (const role of moved.rolesChanged) {
              if (!declared.has(role)) {
                violations.push(
                  `${name} changed the "${role}" surface without declaring it; ` +
                    `it declares ${[...declared].join(", ")}`,
                );
              }
            }
          }
        }

        expect(violations).toEqual([]);

        await expect(`# ${pattern.name}\n\n${sections.join("\n")}`).toMatchFileSnapshot(
          `./__snapshots__/${pattern.name}.md`,
        );
      },
      600_000,
    );
  },
);

/**
 * The compiler instance outlives an individual test, so a suite that generates has to release it or the
 * subprocess survives the run (T028).
 */
afterAll(async () => {
  await disposeEngine();
});
