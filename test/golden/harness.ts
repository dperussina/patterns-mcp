/**
 * Stored expected results, one per documented option combination (SC-003).
 *
 * The combinations are enumerated from the catalog rather than written out here. That is the whole
 * point: a hand-maintained list drifts the moment someone adds an option, and it drifts silently —
 * the suite still passes, having simply stopped testing the new thing. Deriving the list means adding
 * an option adds cases, and a snapshot file appearing in a diff is how the author learns what their
 * option changed.
 *
 * A refusal is a stored result too. Some combinations are illegal by design, and recording "this is
 * refused, with this message" pins behaviour that would otherwise only be covered by whichever
 * refusals someone remembered to write a test for.
 */

import { generate } from "../../src/engine/generate/index.js";
import type { Bundle } from "../../src/engine/generate/index.js";
import { loadCatalog } from "../../src/engine/catalog/load.js";
import type { GenerativePattern, Option } from "../../src/engine/catalog/schema.js";
import { EngineError } from "../../src/engine/errors.js";

/** The name every snapshot generates around, so a diff shows an option's effect and nothing else. */
export const GOLDEN_ENTITY = "Order";

/**
 * Prettier's default `printWidth`, which is what generated code is formatted to unless a caller says
 * otherwise. Comments have to respect it too, and Prettier will not reflow them, which is what the
 * format step's own reflow pass exists for.
 */
const PRINT_WIDTH = 80;

/**
 * The comment lines in `text` that exceed the print width.
 *
 * Restricted to comments on purpose. A code line can legitimately overflow — a template literal or a
 * long string has nowhere to break, and Prettier has already made that judgement — whereas a comment
 * is prose that something upstream controls completely.
 */
export function overWideComments(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((line) => line.length > PRINT_WIDTH)
    .filter((line) => /^\s*(?:\/\/|\/\*|\*)/.test(line));
}

export type OptionValue = string | number | boolean;
export type Combination = Readonly<Record<string, OptionValue>>;

export async function generativePatterns(): Promise<readonly GenerativePattern[]> {
  const catalog = await loadCatalog();
  return catalog.patterns
    .filter((entry): entry is GenerativePattern => entry.kind === "generative")
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Every value of an option that has a closed value space.
 *
 * `string` and `integer` options contribute their default alone, because their spaces are open and
 * "every documented combination" of an open space is not a finite thing. An option whose values
 * genuinely matter belongs in the catalog as an enum, where they can be enumerated and described.
 */
function valuesOf(option: Option): readonly OptionValue[] {
  switch (option.type) {
    case "enum":
      return option.values;
    case "boolean":
      return [true, false];
    case "string":
    case "integer":
      return [option.default];
  }
}

/**
 * The cartesian product of every option's values, in declared order.
 *
 * Declared order rather than sorted order, because it is the order the catalog presents to a reader
 * and the order `describe_pattern` will list. Either would be deterministic; this one also makes the
 * generated case labels read in the same sequence as the documentation.
 */
export function documentedCombinations(pattern: GenerativePattern): readonly Combination[] {
  let combinations: Combination[] = [{}];

  for (const option of pattern.options) {
    const expanded: Combination[] = [];
    for (const partial of combinations) {
      for (const value of valuesOf(option)) {
        expanded.push({ ...partial, [option.name]: value });
      }
    }
    combinations = expanded;
  }

  return combinations;
}

/**
 * The two `binding-only` cases the cartesian product cannot reach (T060).
 *
 * `coreModule` is a string option, so `valuesOf` contributes its default alone — and its default is
 * empty, which `binding-only` refuses. Every `binding-only` combination above is therefore a snapshot of
 * that refusal, and the scope's actual output goes uncovered.
 *
 * Both specifier kinds are pinned because they take different routes through verification: a relative one
 * has the synthesised core written at the path it resolves to, and a bare one has it written as a package
 * under `node_modules` (see `synthesize-core.ts`). They are the same bundle apart from one string, which
 * is exactly why a diff in only one of them is worth seeing.
 */
export function splitCombinations(pattern: GenerativePattern): readonly Combination[] {
  if (!pattern.supportsSplit) return [];

  return ["./lib/core.js", "@acme/core"].map((coreModule) => ({
    emitScope: "binding-only",
    coreModule,
  }));
}

/** A stable, filesystem-safe label. Doubles as the snapshot's file name and its heading. */
export function label(combination: Combination): string {
  const entries = Object.entries(combination);
  if (entries.length === 0) return "defaults";
  return entries
    // A specifier is part of what distinguishes a case and also contains separators no file name can
    // carry, so it is spelled with them replaced rather than left out of the label.
    .map(([name, value]) => `${name}=${String(value).replaceAll(/[/@.]/g, "_")}`)
    .join(",");
}

/**
 * Serialises what a reviewer needs to judge a diff: the resolved options, and every file in order.
 *
 * Verification evidence is deliberately absent. The compiler and formatter versions and the content
 * hash all change when the toolchain is upgraded, which would rewrite every snapshot in the repository
 * for a reason unrelated to the generated code — the same argument that keeps toolchain versions out
 * of the provenance header (FR-021). That the bundle verified at all is not in question here: it could
 * not have been returned otherwise.
 */
function serialize(bundle: Bundle): string {
  const sections = [
    `# ${bundle.pattern}`,
    `## Resolved options\n\n${JSON.stringify(bundle.resolvedOptions, undefined, 2)}`,
    ...bundle.files.map(
      (file) => `## ${file.path} (${file.role})\n\n\`\`\`ts\n${file.contents}\`\`\``,
    ),
  ];
  return `${sections.join("\n\n")}\n`;
}

/**
 * The stored result for one combination: the bundle, or the refusal it earns.
 *
 * Only an `EngineError` is treated as an expected outcome. Anything else is a crash rather than a
 * decision, and recording it as the expectation would freeze a bug into the suite.
 */
export async function goldenFor(
  pattern: GenerativePattern,
  combination: Combination,
): Promise<string> {
  try {
    const bundle = await generate({
      pattern: pattern.name,
      identifiers: { entity: GOLDEN_ENTITY },
      options: combination,
    });
    return serialize(bundle);
  } catch (error) {
    if (error instanceof EngineError) {
      return `# ${pattern.name}\n\n## Refused\n\n${error.code}\n\n${error.message}\n`;
    }
    throw error;
  }
}

export function goldenPath(patternName: string, combination: Combination): string {
  return `./__snapshots__/${patternName}/${label(combination)}.md`;
}
