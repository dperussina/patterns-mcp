/**
 * Browsing the catalogue (FR-012, FR-027).
 *
 * A summary is not an abbreviated description, it is a different answer to a different question.
 * Browsing asks "what is here, and which of these do I want" — `intent` and `supportsSplit` answer
 * that. Every option, its value space, and its legality rules answer "how do I call this one", which is
 * `describePattern`'s job. Returning the second in response to the first would make the cost of finding
 * a pattern scale with the size of the whole catalogue, which is the thing FR-027 exists to prevent.
 *
 * The filters are conjunctive and each is optional, so no combination of them is an error: an empty
 * result is a fact about the catalogue, not a failure. A caller asking for `tier: 3` today gets nothing
 * and should be told nothing exists rather than that they asked wrongly.
 */

import type { Catalog } from "./load.js";
import type { Category, Pattern, PatternKind, Tier } from "./schema.js";

export interface PatternSummary {
  readonly name: string;
  readonly title: string;
  readonly category: Category;
  readonly kind: PatternKind;
  readonly intent: string;
  /**
   * Whether the pattern can emit its shared machinery and its per-type bindings separately. Part of the
   * summary because it decides whether `emitScope` is a question the caller gets to ask at all.
   */
  readonly supportsSplit: boolean;
  readonly tier: Tier;
}

export interface ListFilters {
  readonly category?: Category;
  readonly kind?: PatternKind;
  readonly tier?: Tier;
}

/** Matching patterns, ordered by name (contracts/engine-api.md). */
export function listPatterns(
  catalog: Catalog,
  filters: ListFilters = {},
): readonly PatternSummary[] {
  return catalog.patterns.filter((pattern) => matches(pattern, filters)).map(summarize);
}

function matches(pattern: Pattern, filters: ListFilters): boolean {
  if (filters.category !== undefined && pattern.category !== filters.category) return false;
  if (filters.kind !== undefined && pattern.kind !== filters.kind) return false;
  if (filters.tier !== undefined && pattern.tier !== filters.tier) return false;
  return true;
}

/**
 * An advisory pattern reports `supportsSplit: false`.
 *
 * It has nothing to split because it emits nothing at all, and the field is not optional in the summary
 * on purpose: a caller filtering or sorting on it should not have to handle an absent value for a
 * property whose answer is known.
 */
function summarize(pattern: Pattern): PatternSummary {
  return {
    name: pattern.name,
    title: pattern.title,
    category: pattern.category,
    kind: pattern.kind,
    intent: pattern.intent,
    supportsSplit: pattern.kind === "generative" ? pattern.supportsSplit : false,
    tier: pattern.tier,
  };
}
