/**
 * Every bundle survives every convention the tool offers (FR-025, Principle IX).
 *
 * The golden suite generates each documented combination under the *default* conventions and nothing
 * else, which left five of the six settings entirely unchecked and the sixth checked at one value out
 * of three. The gap was not theoretical. Covering `strictness` alone found four patterns emitting
 * narrowing that a project with `strictNullChecks` off rejects, and two more that fail under
 * `strictest` — six defects in eight patterns, in code that had been passing a green suite for weeks.
 * A setting the output does not survive is worse than one not offered, because the caller is told it
 * is supported.
 *
 * One axis at a time, with every other axis left at its default. The full cross-product is around
 * four hundred settings per option combination and is not worth its runtime; a defect that needs two
 * non-default conventions *together* to appear will escape this, which is the known limit of the
 * bargain rather than an oversight.
 *
 * Each case goes through `generate()` rather than the typechecker directly, so it is checked the way
 * a caller's request is checked — core synthesis for a split bundle, runner shims, platform
 * declarations, and the bundle's own test suite actually executed. Several of these axes only bite at
 * run time: `moduleStyle` decides how the emitted files import each other, and `testFramework`
 * decides what the suite calls, neither of which a typecheck alone would settle.
 */

import { describe, expect, it } from "vitest";

import { generateBundle } from "../bundle.js";
import { siblingImports } from "../../src/engine/generate/imports.js";
import { ConventionsSchema } from "../../src/engine/options/conventions.js";
import type { Conventions } from "../../src/engine/options/conventions.js";
import { CorrectableError } from "../../src/engine/errors.js";
import {
  documentedCombinations,
  generativePatterns,
  goldenIdentifiers,
  label,
  splitCombinations,
} from "../golden/harness.js";
import type { Combination } from "../golden/harness.js";
import type { GenerativePattern } from "../../src/engine/catalog/schema.js";

/**
 * Conventions fields that are deliberately not axes, because their value space is open.
 *
 * Listed rather than inferred so that a new open-ended field has to be considered: `axes()` below
 * fails if it meets a field that is neither enumerable nor named here, which is the difference
 * between a setting that was thought about and one that quietly went uncovered.
 */
const NOT_AN_AXIS = new Set<keyof Conventions>(["prettierConfig"]);

/**
 * The values of one enumerable Zod field, or nothing if it is not one.
 *
 * Written against the shape of the schema object rather than its types because Zod's wrapper classes
 * are an implementation detail that changes between versions, and a cast to `any` would let this
 * return nonsense silently. Every step is checked, so an unrecognised field yields `undefined` and is
 * reported as uncovered instead of being skipped.
 */
function valuesOf(field: unknown): readonly string[] | undefined {
  if (typeof field !== "object" || field === null) return undefined;

  const unwrap: unknown = (field as { unwrap?: unknown }).unwrap;
  if (typeof unwrap !== "function") return undefined;

  const inner: unknown = (unwrap as () => unknown).call(field);
  if (typeof inner !== "object" || inner === null) return undefined;

  const values: unknown = (inner as { options?: unknown }).options;
  if (!Array.isArray(values)) return undefined;
  if (!values.every((value): value is string => typeof value === "string")) return undefined;

  return values;
}

interface Axis {
  readonly name: keyof Conventions;
  readonly values: readonly string[];
}

/**
 * Every enumerable conventions field, read off the schema rather than listed here.
 *
 * The same argument as the golden suite enumerating combinations from the catalog: a hand-written
 * list drifts the moment someone adds a setting, and it drifts *silently* — the suite still passes,
 * having simply stopped testing the new thing.
 */
function axes(): readonly Axis[] {
  const shape: Readonly<Record<string, unknown>> = ConventionsSchema.unwrap().shape;
  const found: Axis[] = [];

  for (const name of Object.keys(shape).toSorted()) {
    const field = name as keyof Conventions;
    const values = valuesOf(shape[name]);

    if (values === undefined) {
      if (NOT_AN_AXIS.has(field)) continue;
      throw new Error(
        `conventions field "${name}" is neither enumerable nor listed in NOT_AN_AXIS, so it would ` +
          `go uncovered; add it to one or the other`,
      );
    }

    found.push({ name: field, values });
  }

  return found;
}

/**
 * Whether one request generates or is refused.
 *
 * Only a `CorrectableError` counts as a refusal. The distinction is the whole safety of this file:
 * `VerificationError` is an `EngineError` too, so catching that supertype would swallow precisely the
 * failures the suite exists to find — which is how the golden harness spent weeks recording a broken
 * pattern as its own expectation.
 */
async function attempt(
  pattern: GenerativePattern,
  combination: Combination,
  conventions: Partial<Conventions>,
): Promise<"generated" | "refused"> {
  try {
    const bundle = await generateBundle({
      pattern: pattern.name,
      // Takes the pattern rather than its name so the identifiers can be the declared ones. With
      // `entity` sent unconditionally the six patterns that read none would be refused, and this
      // function reports a refusal as an outcome — so every convention would have looked inapplicable
      // to them rather than untested.
      identifiers: goldenIdentifiers(pattern),
      options: combination,
      conventions,
    });

    const problem = contentProblem(bundle.files, combination, conventions);
    if (problem !== undefined) throw new Error(problem);

    return "generated";
  } catch (error) {
    if (error instanceof CorrectableError) return "refused";
    throw error;
  }
}

/**
 * Invariants about what a bundle *says*, for the ones verification cannot see.
 *
 * Executing the suite is what normally settles a convention, and for `testFramework` it cannot:
 * the sandbox shims `vitest` so that any bundle can be run at all, so a suite importing from
 * `"vitest"` in a `node:test` project passes here and fails in the caller's repository. Two patterns
 * shipped that way, both green, until this was checked.
 */
function contentProblem(
  files: readonly { readonly path: string; readonly contents: string }[],
  combination: Combination,
  conventions: Partial<Conventions>,
): string | undefined {
  return frameworkLeak(files, conventions) ?? specifierDrift(files, combination, conventions);
}

function frameworkLeak(
  files: readonly { readonly path: string; readonly contents: string }[],
  conventions: Partial<Conventions>,
): string | undefined {
  if (conventions.testFramework !== "node-test") return undefined;

  const leaking = files.filter((file) => file.contents.includes('from "vitest"'));

  return leaking.length === 0
    ? undefined
    : `imports from "vitest" under testFramework=node-test: ${leaking
        .map((file) => file.path)
        .join(", ")}`;
}

/**
 * Every sibling import spells its extension the way the caller does (FR-024, FR-030).
 *
 * Invisible to verification for the same reason as the one above, one layer deeper: the sandbox
 * transpiles the bundle and runs the emitted `.js`, so a suite that hardcodes `./expect.js` in a
 * project spelling its imports `./expect.ts` resolves there and raises `ERR_MODULE_NOT_FOUND` in the
 * caller's. Seven patterns hardcoded exactly that, each having rewritten by hand the helper that
 * exists to get it right, and every one of them was green under all six axes.
 *
 * `coreModule` is exempt: it is the caller's own path to machinery they already have, and imposing our
 * extension convention on it would rewrite the one specifier they told us verbatim.
 */
function specifierDrift(
  files: readonly { readonly path: string; readonly contents: string }[],
  combination: Combination,
  conventions: Partial<Conventions>,
): string | undefined {
  const extension = conventions.importExtensions ?? "js";
  const core = typeof combination.coreModule === "string" ? combination.coreModule : undefined;
  const wrong: string[] = [];

  for (const file of files) {
    for (const specifier of siblingImports(file.contents)) {
      if (specifier === core) continue;

      const spelled = /\.[jt]s$/.exec(specifier)?.[0];
      const expected = extension === "none" ? undefined : `.${extension}`;

      if (spelled !== expected) wrong.push(`${file.path} imports "${specifier}"`);
    }
  }

  return wrong.length === 0
    ? undefined
    : `importExtensions=${extension} but ${wrong.join(", ")}`;
}

const patterns = await generativePatterns();

/**
 * Print widths a caller plausibly configures.
 *
 * `prettierConfig` is excluded from the enumerated axes above because its value space is open, and that
 * exclusion is the argument this file makes about itself playing out: an untested setting looks
 * supported. Print width is the field within it that changes every emitted line, and it reaches a defect
 * nothing else here can. A `@ts-expect-error` asserts about the line below it, so a width that wraps
 * that line moves the assertion off the token that errors: the directive is then reported unused *and*
 * the error it was suppressing escapes, two failures from one displacement, in a file the caller reads
 * as ours to get right. `chat-model-port` and `model-middleware` both broke at 40, on directives that
 * were correctly placed at every width the suite had tried.
 *
 * 80 is Prettier's own default and the commonest setting; 120 is the commonest widening; 40 is narrower
 * than a real project and is here as the margin. Below it the same displacement returns in three more
 * patterns, which is a floor this suite states rather than hides.
 */
const PRINT_WIDTHS = [40, 80, 120] as const;

describe("printWidth", () => {
  describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))(
    "$name",
    ({ pattern }) => {
      it(
        "holds at every print width a caller sets",
        async () => {
          // The default combination alone: width interacts with the *text* a template emits, which the
          // option combinations vary far less than they vary its structure, and sweeping both crosses
          // into the runtime the file already declines to spend.
          const [combination] = [...documentedCombinations(pattern)];
          if (combination === undefined) throw new Error(`${pattern.name} documents no combination`);

          const failures: string[] = [];

          for (const printWidth of PRINT_WIDTHS) {
            try {
              await attempt(pattern, combination, { prettierConfig: { printWidth } });
            } catch (error) {
              failures.push(
                `printWidth=${String(printWidth)}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          expect(failures).toEqual([]);
        },
        300_000,
      );
    },
  );
});

/**
 * Two settings that are each valid and jointly impossible (T070).
 *
 * The sweep below varies one axis at a time from the defaults, which is why this needs saying separately —
 * and why the contradiction survived until someone tried it. `runtime` was swept against the default
 * `testFramework` and `testFramework` against the default `runtime`, so the pair that cannot coexist was
 * never formed. It was served: four files, zero diagnostics, "tests passed", and a suite importing
 * `node:test` for a caller whose runtime has no `node:`.
 */
describe("conventions that contradict each other", () => {
  const CONTRADICTION = { runtime: "browser", testFramework: "node-test" } as const;

  it("are refused, naming both settings and a way out of each", async () => {
    const refusal = await generateBundle({
      pattern: "result",
      identifiers: { entity: "Invoice" },
      conventions: CONTRADICTION,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CorrectableError);
    const message = (refusal as Error).message;
    // Both, because there is no fact about which one the caller meant.
    expect(message).toContain("browser");
    expect(message).toContain("node-test");
    expect(message).toContain("vitest");
  });

  it.each([
    ["the browser half alone", { runtime: CONTRADICTION.runtime }],
    ["the node-test half alone", { testFramework: CONTRADICTION.testFramework }],
  ])("is not refused for %s, which is the point of calling it a contradiction", async (_, conventions) => {
    const bundle = await generateBundle({
      pattern: "result",
      identifiers: { entity: "Invoice" },
      conventions,
    });

    expect(bundle.files.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.each(axes().map((axis) => ({ axis, name: axis.name })))("$name", ({ axis }) => {
  describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))(
    "$name",
    ({ pattern }) => {
      const combinations = [...documentedCombinations(pattern), ...splitCombinations(pattern)];

      it(
        `holds at every ${axis.name}`,
        async () => {
          const failures: string[] = [];
          const generated = new Set<string>();

          for (const combination of combinations) {
            // Concurrent across the axis's values, which the engine supports and asserts elsewhere:
            // conventions become compiler options in a *shared* mutable file system, and
            // `test/determinism/concurrency.test.ts` pins that two requests carrying different ones
            // cannot be answered under each other's configuration.
            const outcomes = await Promise.all(
              axis.values.map(async (value) => {
                try {
                  return {
                    value,
                    outcome: await attempt(pattern, combination, { [axis.name]: value }),
                  };
                } catch (error) {
                  return {
                    value,
                    outcome: "failed" as const,
                    detail: error instanceof Error ? error.message : String(error),
                  };
                }
              }),
            );

            for (const result of outcomes) {
              if (result.outcome === "failed") {
                // Collected rather than thrown, so one run reports every broken setting instead of
                // the first. A generator's defects come in families — the same template mistake
                // across eight combinations — and seeing the family is what identifies the cause.
                failures.push(
                  `${axis.name}=${result.value} ${label(combination)}: ${
                    "detail" in result ? result.detail : ""
                  }`,
                );
                continue;
              }

              if (result.outcome === "generated") generated.add(result.value);
            }
          }

          expect(failures).toEqual([]);

          // A value every combination refuses covers nothing, and would sit here looking like
          // coverage. `testFramework: jest` is the live example: it is refused whenever tests are
          // emitted, because the sandbox cannot execute them, so its only real cases are the
          // `includeTests: false` ones — and if those stopped generating, this is what would say so.
          expect([...generated].toSorted(), `no combination generated under some ${axis.name}`).toEqual(
            [...axis.values].toSorted(),
          );
        },
        300_000,
      );
    },
  );
});
