/**
 * Everything a caller needs to construct a correct request on the first attempt (FR-013, SC-006).
 *
 * The measure of this function is whether a caller who reads its output never has to guess. So it
 * returns every option with its full value space, its default, and what it affects — and the legality
 * rules **verbatim**, in the same words the refusal would use. That last point is the reason legality
 * rules are data in the catalogue rather than code: a rule a caller can read before calling is worth
 * more than the same rule discovered by being refused (FR-009).
 *
 * Nothing is summarised, abbreviated, or reworded here. `listPatterns` is the cheap answer; this is the
 * complete one, and a caller who asked for one pattern by name has already paid the cost of choosing.
 */

import { UnknownPatternError } from "../errors.js";

import type { Catalog } from "./load.js";
import { nearestNames } from "./nearest.js";
import type {
  AdvisoryContent,
  Category,
  LegalityRule,
  Option,
  PatternKind,
  Tier,
} from "./schema.js";

export interface PatternDetail {
  readonly name: string;
  readonly title: string;
  readonly category: Category;
  readonly kind: PatternKind;
  readonly intent: string;
  readonly supportsSplit: boolean;
  /** Named variants, or empty when the pattern has only its default form. */
  readonly variants: readonly string[];
  readonly options: readonly Option[];
  readonly legality: readonly LegalityRule[];
  readonly relatedPatterns: readonly string[];
  readonly tier: Tier;
  /** Present only on an advisory pattern: what to do instead, and why. */
  readonly advisory?: AdvisoryContent;
  /**
   * Where the pattern came from, and under what licence. Surfaced because a caller pasting generated
   * code into their repository has a legitimate interest in its provenance (FR-036).
   */
  readonly provenance: string;
  readonly license: string;
}

/**
 * @throws UnknownPatternError with the nearest catalogue names, so a typo costs one retry rather than a
 * discovery round trip (SC-007). Thrown rather than returned as an empty result because asking about a
 * pattern that does not exist is a mistake, and a caller who cannot tell the difference between "no such
 * pattern" and "a pattern with nothing to say" will write the second case's code for the first.
 */
export function describePattern(catalog: Catalog, name: string): PatternDetail {
  const pattern = catalog.get(name);

  if (pattern === undefined) {
    throw new UnknownPatternError(name, nearestNames(catalog.patterns, name));
  }

  const common = {
    name: pattern.name,
    title: pattern.title,
    category: pattern.category,
    kind: pattern.kind,
    intent: pattern.intent,
    relatedPatterns: pattern.relatedPatterns,
    tier: pattern.tier,
    provenance: pattern.provenance,
    license: pattern.license,
  };

  // An advisory pattern is described with the same empty collections a generative one would have, rather
  // than with those fields absent. A caller iterating options should not need to know which kind they
  // asked about to know whether iterating is safe.
  if (pattern.kind === "advisory") {
    return {
      ...common,
      supportsSplit: false,
      variants: [],
      options: [],
      legality: [],
      advisory: pattern.advisory,
    };
  }

  return {
    ...common,
    supportsSplit: pattern.supportsSplit,
    variants: pattern.variants,
    options: pattern.options,
    legality: pattern.legality,
  };
}
