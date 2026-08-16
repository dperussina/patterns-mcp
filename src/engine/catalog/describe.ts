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
import { reservedNames } from "../patterns/registry.js";

import type { Catalog } from "./load.js";
import { nearestNames } from "./nearest.js";
import type {
  AdvisoryContent,
  Category,
  IdentifierRole,
  LegalityRule,
  NetworkAccess,
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
  /**
   * The names this pattern generates around, or empty when it emits one module named after itself.
   *
   * Here because a caller who has to guess this gets no signal when they guess wrong: an undeclared
   * role is refused, and the point of describing a pattern is that the next call succeeds.
   */
  readonly identifiers: readonly IdentifierRole[];
  /**
   * Names this pattern writes for itself, which a name supplied above therefore cannot be (FR-052).
   *
   * Here for the same reason the roles are: a caller who has to discover this by being refused has spent
   * a turn learning something we knew before they asked. Empty for most patterns — a name is only listed
   * where it belongs to something the caller builds against, since anything ours to rename steps aside
   * instead of refusing.
   */
  readonly reservedNames: readonly string[];
  readonly options: readonly Option[];
  readonly legality: readonly LegalityRule[];
  readonly relatedPatterns: readonly string[];
  readonly tier: Tier;
  /** Present only on an advisory pattern: what to do instead, and why. */
  readonly advisory?: AdvisoryContent;
  /**
   * Present only where the emitted code can reach the network (FR-034).
   *
   * Before generating, not after. A caller deciding whether this pattern belongs in their codebase is
   * deciding partly on this, and the answer arriving with the code is the answer arriving too late — a
   * reviewer who finds `fetch` in generated output they were not expecting is entitled to conclude the
   * generator is not trustworthy, which the disclosure costs nothing to prevent.
   */
  readonly network?: NetworkAccess;
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
      identifiers: [],
      reservedNames: [],
      options: [],
      legality: [],
      advisory: pattern.advisory,
    };
  }

  return {
    ...common,
    supportsSplit: pattern.supportsSplit,
    variants: pattern.variants,
    identifiers: pattern.identifiers,
    // Read from the module rather than the catalogue entry, because the module is where the names are
    // declared: a template that gains a helper changes them, and a second list in the data would not know.
    reservedNames: pattern.identifiers.length === 0 ? [] : reservedNames(pattern.name),
    options: pattern.options,
    legality: pattern.legality,
    // Spread conditionally rather than set to undefined, so a serialised detail for a pattern that stays
    // offline has no `network` key at all. `"network": null` reads like a claim; absence reads like one too,
    // but the true one.
    ...(pattern.network === undefined ? {} : { network: pattern.network }),
  };
}
