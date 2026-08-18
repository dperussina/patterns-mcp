/**
 * A caller with nothing but what a surface told it.
 *
 * The evaluation set exists to measure SC-006 and SC-007, and both are stated about *an agent*: the first
 * says a capable one constructs a valid request from the discovery operations alone, the second that it
 * corrects a refused one without asking again. Neither can be measured by writing an agent here. If this
 * file decides what the agent knows, it also decides whether the agent succeeds, and a green suite would
 * report the author's intentions rather than the surface's quality — the same objection this project
 * raises against a golden file that records a broken pattern as its own expectation.
 *
 * So the thing under test is not the reader. It is **whether the surface carries what a reader needs**,
 * which is the necessary half of both criteria and the only half that lives in this repository. A model
 * supplies the sufficient half, and no offline harness can stand in for it.
 *
 * The reader is therefore deliberately mechanical, and its mechanism is the measurement: it may look only
 * at what one call returned, it may not consult the catalogue, and it may not read prose. Where a
 * mechanical reader succeeds, the surface is sufficient and the criterion rests on nothing else. Where it
 * fails, the fact needed was in English, and the suite says which fact and where — a real finding either
 * way, and one that cannot be arranged by making the reader cleverer.
 *
 * `errors.ts` states the contract this file tests, in its own header: "A correctable error names the
 * field, states the rule, and enumerates the alternatives, so an agent can fix its call without a second
 * discovery round trip (SC-007)." Nothing until now read that sentence back.
 */

import type { GenerateRequest, Option, PatternDetail } from "../../src/index.js";

export type OptionValue = string | number | boolean;

/** The domain noun every task generates around unless it names its own. */
export const DEFAULT_NOUN = "Order";

/**
 * The values discovery *enumerates* for an option, or nothing where it only names a default.
 *
 * The distinction is the whole of what the reader can and cannot do with an option. An enum or a boolean
 * has a closed space that `describe_pattern` prints in full, so a choice among them needs no judgement. A
 * string or an integer has an open one, and the default is the only value discovery can offer — so any
 * *other* value has to come from a fact about the caller's own project, which is exactly the kind of thing
 * a message cannot supply and a model can.
 */
export function enumeratedValues(option: Option): readonly OptionValue[] | undefined {
  switch (option.type) {
    case "enum":
      return option.values;
    case "boolean":
      return [true, false];
    case "string":
    case "integer":
      return undefined;
  }
}

export interface Attempt {
  readonly request: GenerateRequest;
  /** What this attempt varies from the defaults, for a failure message that says which choice broke. */
  readonly choice: string;
}

/**
 * Every request a reader can construct from one `describe_pattern` answer.
 *
 * The defaults, plus one attempt per enumerated value of every option — each varying a single option, so
 * a refusal names the choice that earned it rather than a combination. That is narrower than the golden
 * suite's cartesian product on purpose: this is not a second coverage sweep, it is the same sweep run
 * through a *narrower view of the catalogue*, and the difference between the two views is the thing being
 * measured. The golden harness reads the catalogue entry; this reads only what a caller was told about it.
 *
 * Identifiers are one noun per declared role, and none at all for the patterns that declare none —
 * supplying one there is refused rather than ignored, which is itself a fact discovery has to carry, and
 * it does: `identifiers` is empty for exactly those patterns.
 */
export function attemptsFrom(
  detail: PatternDetail,
  noun: string = DEFAULT_NOUN,
): readonly Attempt[] {
  const identifiers = Object.fromEntries(detail.identifiers.map((role) => [role.name, noun]));
  const base: GenerateRequest = { pattern: detail.name, identifiers };

  const attempts: Attempt[] = [{ request: base, choice: "defaults" }];

  for (const option of detail.options) {
    const values = enumeratedValues(option);
    if (values === undefined) continue;

    for (const value of values) {
      if (value === option.default) continue;
      attempts.push({
        request: { ...base, options: { [option.name]: value } },
        choice: `${option.name}=${String(value)}`,
      });
    }
  }

  return attempts;
}

/**
 * The subjects a refusal can name, and the shapes it names them in.
 *
 * Every entry is the wording a surface actually renders — `refusals.ts` for what a caller reads, and
 * `errors.ts` for the sentence the engine writes underneath. Matching both is deliberate: the two differ,
 * a library caller reads the second, and a repair that worked on only one would be reporting that one
 * surface is repairable while saying nothing about the other.
 */
const SUBJECT = {
  pattern: /No pattern named "([^"]+)"|Unknown pattern "([^"]+)"/u,
  option: /Option "([^"]+)"|Formatting option "([^"]+)"|Prettier option "([^"]+)"/u,
  identifier: /Identifier "([^"]+)"/u,
} as const;

/** The enumerations a refusal offers as candidates, in the order the vocabulary prefers them. */
const CANDIDATES: readonly RegExp[] = [
  /Did you mean: ([^?]+)\?/u,
  /Permitted values: ([^.]+)\./u,
  /Declared identifiers: ([^.]+)\./u,
  /Configurable options: ([^.]+)\./u,
];

/** The phrasings that say to take something out rather than to replace it. */
const WITHDRAW: readonly RegExp[] = [
  /without emitScope/u,
  /without identifiers/u,
  /Omit identifiers entirely/u,
  /is not declared for this pattern/u,
  /cannot be set here/u,
  /is not configurable here/u,
];

function firstMatch(text: string, expression: RegExp): string | undefined {
  const found = expression.exec(text);
  if (found === null) return undefined;
  return found.slice(1).find((group) => group !== undefined);
}

function candidatesIn(text: string): readonly string[] | undefined {
  for (const expression of CANDIDATES) {
    const found = firstMatch(text, expression);
    if (found !== undefined) {
      const values = found.split(",").map((value) => value.trim()).filter((value) => value !== "");
      if (values.length > 0 && values[0] !== "(none)") return values;
    }
  }
  return undefined;
}

/**
 * The request a reader would send next, derived from the refusal's text and nothing else.
 *
 * Two rules, because the vocabulary offers two kinds of remedy and no others. **Substitute:** the message
 * names a subject and enumerates what would have been accepted, so the subject takes the first candidate.
 * **Withdraw:** the message says the subject does not belong here, so it comes out. Which rule applies is
 * read off the text rather than off an error code, since a code is not what a caller reads and a repair
 * driven by one would prove nothing about the sentence.
 *
 * `undefined` where neither rule fits, which is not a failure of this function. It means the remedy was
 * written in English — a rule to satisfy, a path only the caller knows, a choice between two settings
 * either of which they may have meant — and a mechanical reader has correctly declined to guess. The
 * suite records those separately, and asserts instead that the fields such a remedy is built from are
 * present and non-empty, which is the checkable half of "states the rule and enumerates the
 * alternatives".
 *
 * Nothing here is allowed to look at the pattern's declaration. That is the point of the exercise: SC-007
 * says an agent recovers *without an additional discovery call*, so a repair that consulted the catalogue
 * would be measuring a claim nobody made.
 */
export function repair(
  request: GenerateRequest,
  refusal: string,
): GenerateRequest | undefined {
  const candidates = candidatesIn(refusal);
  const withdraw = WITHDRAW.some((expression) => expression.test(refusal));

  const badPattern = firstMatch(refusal, SUBJECT.pattern);
  if (badPattern !== undefined && candidates !== undefined) {
    return { ...request, pattern: candidates[0] ?? request.pattern };
  }

  const badIdentifier = firstMatch(refusal, SUBJECT.identifier);
  if (badIdentifier !== undefined) {
    const identifiers = { ...request.identifiers };
    const supplied = identifiers[badIdentifier];
    delete identifiers[badIdentifier];

    // A rename keeps the noun and moves it to the role the pattern does declare; a withdrawal drops it,
    // which is the answer for a pattern that names its module after itself and takes no role at all.
    if (candidates !== undefined && supplied !== undefined) {
      return { ...request, identifiers: { ...identifiers, [candidates[0] ?? ""]: supplied } };
    }
    if (withdraw) return { ...request, identifiers };
    return undefined;
  }

  const badOption = firstMatch(refusal, SUBJECT.option);
  if (badOption !== undefined) {
    const options = { ...request.options };
    const conventions = conventionsWithout(request, badOption);

    if (candidates !== undefined && badOption in options) {
      return { ...request, options: { ...options, [badOption]: candidates[0] } };
    }
    if (withdraw) {
      delete options[badOption];
      return { ...request, options, ...(conventions === undefined ? {} : { conventions }) };
    }
    return undefined;
  }

  // No subject named, so there is nothing to substitute or withdraw — except the one refusal that names
  // an option in the request without quoting it, which is a scope the pattern does not offer at all.
  if (withdraw && /no scope to select/u.test(refusal)) {
    const options = { ...request.options };
    delete options.emitScope;
    delete options.coreModule;
    return { ...request, options };
  }

  return undefined;
}

/**
 * A formatting option comes out of `prettierConfig` rather than out of `options`.
 *
 * The one place the two rules above need to know where a name lives, and it is knowable from the refusal:
 * only a formatting refusal says "cannot be set here", and only `prettierConfig` holds keys a caller chose
 * the names of. Returns nothing when the request carries no such config, so the caller falls through to
 * removing an ordinary option.
 */
function conventionsWithout(request: GenerateRequest, option: string): unknown {
  const conventions = request.conventions;
  if (typeof conventions !== "object" || conventions === null) return undefined;

  const record = conventions as Record<string, unknown>;
  const config = record.prettierConfig;
  if (typeof config !== "object" || config === null) return undefined;
  if (!(option in config)) return undefined;

  const remaining = { ...(config as Record<string, unknown>) };
  delete remaining[option];
  return { ...record, prettierConfig: remaining };
}
