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

import { generateBundle } from "../bundle.js";
import type { Bundle } from "../../src/engine/generate/index.js";
import { loadCatalog } from "../../src/engine/catalog/load.js";
import type { GenerativePattern, Option } from "../../src/engine/catalog/schema.js";
import { CorrectableError } from "../../src/engine/errors.js";

/** The name every snapshot generates around, so a diff shows an option's effect and nothing else. */
export const GOLDEN_ENTITY = "Order";

/**
 * `GOLDEN_ENTITY` for the roles a pattern declares, and nothing for the six that declare none.
 *
 * Sending `entity` unconditionally used to work, which was the problem: the six patterns that emit a
 * module named after themselves ignored it while it still entered the provenance hash, so the golden
 * files recorded a name that appears nowhere in them. Now such a name is refused, and this keeps the
 * request honest rather than keeping the old behaviour alive behind a harness.
 */
export function goldenIdentifiers(
  pattern: GenerativePattern,
): Readonly<Record<string, string>> {
  return Object.fromEntries(pattern.identifiers.map((role) => [role.name, GOLDEN_ENTITY]));
}

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
 * All three specifier kinds are pinned because each takes a different route through verification: a
 * relative one has the synthesised core written at the path it resolves to, a climbing one has the bundle
 * placed as deep as it climbs so that path is inside the root, and a bare one has the core written as a
 * package under `node_modules` (see `synthesize-core.ts`). They are the same bundle apart from one
 * string, which is exactly why a diff in only one of them is worth seeing.
 *
 * The climbing case is the one that was missing rather than merely uncovered: `../lib/core.js` is what a
 * binding in `src/orders` has to write to reach a core in `src/lib`, and it was refused outright, so the
 * layout the split exists to serve was the layout that could not be verified.
 */
export function splitCombinations(pattern: GenerativePattern): readonly Combination[] {
  if (!pattern.supportsSplit) return [];

  return ["./lib/core.js", "../lib/core.js", "@acme/core"].map((coreModule) => ({
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
 * Only a `CorrectableError` is treated as an expected outcome. Anything else is a crash rather than a
 * decision, and recording it as the expectation would freeze a bug into the suite.
 *
 * The distinction is narrower than it looks and was originally got wrong here, with real cost.
 * `VerificationError` is an `EngineError` too, so catching that supertype meant a pattern whose own
 * generated tests failed was written down as "refused" and the suite went green — which is how
 * `repository` at `pagination: offset` sat in the repository for a while returning a duplicate row
 * across consecutive pages, with twelve snapshots recording the failure as the expectation. A
 * refusal is a judgement about the request. A verification failure is a defect in us, and the only
 * correct thing to do with it is let it out.
 */
export async function goldenFor(
  pattern: GenerativePattern,
  combination: Combination,
): Promise<string> {
  try {
    const bundle = await generateBundle({
      pattern: pattern.name,
      identifiers: goldenIdentifiers(pattern),
      options: combination,
    });
    return serialize(bundle);
  } catch (error) {
    if (error instanceof CorrectableError) {
      return `# ${pattern.name}\n\n## Refused\n\n${error.code}\n\n${error.message}\n`;
    }
    throw error;
  }
}

export function goldenPath(patternName: string, combination: Combination): string {
  return `./__snapshots__/${patternName}/${label(combination)}.md`;
}
