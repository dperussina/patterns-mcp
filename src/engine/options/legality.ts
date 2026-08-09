/**
 * Legality evaluation — step 6 of the fixed validation order.
 *
 * Encodes the cross-option constraints that the tool schema deliberately cannot
 * express (research §2). The schema is flat so that an agent can call the tool
 * without first learning a nested shape; the price is that "this option is only
 * meaningful when that one is set" has to live somewhere else, and this is it.
 *
 * Rules are data rather than functions, which is what lets `describe_pattern`
 * show a caller the constraint that will be applied to them before they call
 * (FR-013). It also means a rule cannot quietly depend on anything outside the
 * resolved option set.
 */
import { IllegalCombinationError } from "../errors.js";
import type {
  GenerativePattern,
  LegalityRule,
  WhenClause,
} from "../catalog/schema.js";
import type { OptionValue } from "./resolve.js";

export type ResolvedOptions = Readonly<Record<string, OptionValue>>;

/**
 * Throws on the first rule the options violate.
 *
 * First match wins, in the catalogue's declared order. Two rules can match the
 * same request, and without a pinned order the error a caller receives would
 * depend on evaluation order — which is exactly the kind of instability that
 * makes an agent loop between two refusals.
 */
export function evaluateLegality(
  pattern: GenerativePattern,
  options: ResolvedOptions,
): void {
  const violated = findViolation(pattern, options);

  if (violated !== undefined) {
    throw new IllegalCombinationError(violated.rule, violated.alternatives);
  }
}

/**
 * The first violated rule, or `undefined`. Separate from `evaluateLegality` so
 * that discovery can report which rules a hypothetical option set would break
 * without having to catch an error to find out.
 */
export function findViolation(
  pattern: GenerativePattern,
  options: ResolvedOptions,
): LegalityRule | undefined {
  for (const rule of pattern.legality) {
    if (matches(rule.when, options) && isForbidden(rule, options)) {
      return rule;
    }
  }

  return undefined;
}

/**
 * Whether the rule's precondition holds.
 *
 * A clause naming an option that does not exist evaluates to false rather than
 * throwing. Resolution has already rejected unknown option names from the
 * caller, so an unresolvable clause means the catalogue entry is wrong — and a
 * miswritten rule must not become a refusal that blames the caller. The catalogue
 * validator is where that surfaces.
 */
function matches(when: WhenClause, options: ResolvedOptions): boolean {
  const actual = options[when.option];

  if (actual === undefined) {
    return false;
  }

  switch (when.operator) {
    case "eq": {
      return actual === when.value;
    }
    case "neq": {
      return actual !== when.value;
    }
    case "in": {
      return when.values.includes(actual);
    }
    case "notIn": {
      return !when.values.includes(actual);
    }
  }
}

function isForbidden(rule: LegalityRule, options: ResolvedOptions): boolean {
  const actual = options[rule.forbids.option];

  if (actual === undefined) {
    return false;
  }

  return rule.forbids.values.includes(actual);
}
