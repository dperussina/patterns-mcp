/**
 * SC-006's necessary condition: discovery carries what a request needs.
 *
 * The criterion is that a capable agent, given only the discovery operations and no prior knowledge,
 * constructs a valid generation request on its first attempt in at least 90% of trials. The half of that
 * which is ours is whether the information is *there* — an agent cannot succeed if `describe_pattern`
 * omits what the engine requires, and cannot be blamed for failing. So the reader here is confined to one
 * `describe_pattern` answer per pattern and may not read the catalogue, which is a strictly narrower view
 * than the golden suite's; the gap between the two views is the thing measured.
 *
 * Not a second coverage sweep. The golden suite already generates every documented combination and would
 * catch a pattern that stopped compiling. What only this file can catch is **drift between what a caller is
 * told and what the engine accepts**: a value `describe_pattern` prints that generation refuses, an option
 * the engine requires that discovery never mentions, an identifier role that is declared and unused. Every
 * one of those is invisible from either side alone, because the catalogue is the source of both.
 */

import { describe, expect, it } from "vitest";

import { describePattern, generate, listPatterns } from "../../src/index.js";
import { CorrectableError } from "../../src/engine/errors.js";
import { attemptsFrom, enumeratedValues } from "./reader.js";

/**
 * The choices a reader cannot make from discovery's structure alone, and why each is not a defect.
 *
 * A ledger rather than a filter, so that a new one has to be argued for here instead of quietly widening
 * the exemption. Each entry names a `pattern.option` whose requirement is carried in prose — which is the
 * right place for it, because the fact needed is about the caller's project and no enumeration could hold
 * it — and the recovery suite is what proves the refusal it earns is repairable.
 *
 * `coreModule` is the whole list, and it is the same fact three times: a binding imports the machinery from
 * wherever the caller installed it, so the value is a path only they know. `describe_pattern` says as much
 * in the option's description, and a model reads that; a mechanical reader correctly declines to invent a
 * module specifier. What it must not do is silently skip the scope, so the skip is recorded here and the
 * count is asserted below.
 */
const PROSE_ONLY = new Set([
  "chat-model-port.coreModule",
  "repository.coreModule",
  "unit-of-work.coreModule",
]);

const summaries = await listPatterns();
const generative = summaries.filter((summary) => summary.kind === "generative");

/** The words of an intent that could distinguish it, which short ones cannot. */
function distinguishingWords(intent: string): Set<string> {
  return new Set(
    intent
      .toLowerCase()
      .split(/[^a-z]+/u)
      .filter((word) => word.length > 4),
  );
}

describe("the catalogue a reader is handed", () => {
  it("offers a closed set of values for every choice but the ones prose has to carry", async () => {
    const open: string[] = [];

    for (const summary of generative) {
      const detail = await describePattern(summary.name);
      for (const option of detail.options) {
        if (enumeratedValues(option) === undefined) open.push(`${summary.name}.${option.name}`);
      }
    }

    // Equality rather than a subset check, in both directions. A new open-ended option appearing is a new
    // place a reader has to read English and is what this asserts against; an entry disappearing from the
    // ledger means the exemption has outlived its reason and should go.
    expect(open.toSorted()).toEqual([...PROSE_ONLY].toSorted());
  });

  it("tells every pattern's intent apart from every other", () => {
    // Selecting a pattern from a goal is the step this harness cannot measure, but its precondition is
    // checkable and is a property of the catalogue rather than of any reader: two entries whose intents
    // share all of their distinguishing vocabulary cannot be chosen between, however capable the chooser.
    const vocabularies = summaries.map((summary) => ({
      name: summary.name,
      words: distinguishingWords(summary.intent),
    }));

    const indistinct: string[] = [];

    for (const entry of vocabularies) {
      const elsewhere = new Set(
        vocabularies.filter((other) => other.name !== entry.name).flatMap((other) => [...other.words]),
      );
      const own = [...entry.words].filter((word) => !elsewhere.has(word));
      if (own.length === 0) indistinct.push(entry.name);
    }

    expect(indistinct).toEqual([]);
  });
});

describe.each(generative.map((summary) => ({ name: summary.name })))("%s", ({ name }) => {
  it(
    "accepts every request a reader can build from what it was told",
    async () => {
      const detail = await describePattern(name);
      const refused: string[] = [];

      for (const attempt of attemptsFrom(detail)) {
        // The scope whose companion value only the caller knows. Skipped rather than attempted, and the
        // ledger above is what stops the skip from being silent.
        if (
          attempt.request.options?.emitScope === "binding-only" &&
          PROSE_ONLY.has(`${name}.coreModule`)
        ) {
          continue;
        }

        try {
          const result = await generate(attempt.request);
          // A bundle or advice both count: the criterion is a *valid request*, and a pattern that answers
          // with "use a module instead" has answered one.
          expect(result.pattern).toBe(name);
        } catch (error) {
          if (!(error instanceof CorrectableError)) throw error;
          refused.push(`${attempt.choice}: ${error.code} — ${error.message}`);
        }
      }

      // Collected rather than thrown at the first, so one run reports every choice discovery got wrong.
      expect(refused).toEqual([]);
    },
    300_000,
  );
});
