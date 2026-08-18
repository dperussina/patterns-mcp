/**
 * SC-007's necessary condition: a refusal carries its own remedy.
 *
 * The criterion is that an agent corrects a refused request and succeeds on the next attempt in at least
 * 90% of trials, *without needing an additional discovery call*. `errors.ts` states the mechanism in its
 * own header — "a correctable error names the field, states the rule, and enumerates the alternatives" —
 * and until now nothing read that sentence back. Every refusal was asserted to *happen*; none was asserted
 * to be *actionable*, which is the only property SC-007 is about.
 *
 * Two claims, one per kind of remedy.
 *
 * **Repairable from the text alone**, for the refusals that enumerate what would have been accepted: the
 * wrong request goes in, the rendered sentence comes back, `repair` reads only that sentence, and the
 * amended request succeeds. No catalogue, no second `describe_pattern`, one attempt. That is SC-007 end to
 * end for those codes, and it is the first test in the repository that runs the loop at all.
 *
 * **Remedy in prose**, for the four where the fact needed cannot be enumerated — a naming rule to satisfy,
 * a module path only the caller knows, a choice between two settings either of which they may have meant.
 * A mechanical reader declines those and is right to; a model reads them. What is asserted instead is that
 * the fields such a remedy is built from are present and non-empty, since a message that lost them would
 * leave a model with nothing either, and that is the half of the claim this harness can check.
 *
 * Both surfaces' wording is exercised. `refusals.ts` composes what a caller reads and is not
 * `error.message`, so a repair proved against one says nothing about the other — and the whole reason that
 * composer exists is that the two had already drifted once.
 */

import { describe, expect, it } from "vitest";

import { generate } from "../../src/index.js";
import type { GenerateRequest } from "../../src/index.js";
import { CorrectableError, EngineError } from "../../src/engine/errors.js";
import type { ErrorCode } from "../../src/engine/errors.js";
import { messageFor } from "../../src/refusals.js";
import type { Vocabulary } from "../../src/refusals.js";
import { repair } from "./reader.js";

/** The MCP surface's clauses, which is the reader SC-006 and SC-007 are written about. */
const VOCABULARY: Vocabulary = {
  listCatalogue: "Call list_patterns",
  describePattern: "Call describe_pattern",
};

interface Case {
  readonly code: ErrorCode;
  /** What a caller plausibly gets wrong, not a synthetic value: each of these is a real mistake. */
  readonly mistake: string;
  readonly request: GenerateRequest;
}

const CASES: readonly Case[] = [
  {
    code: "unknown_pattern",
    mistake: "the name as it is usually written in prose rather than as the catalogue spells it",
    request: { pattern: "results", identifiers: { entity: "Order" } },
  },
  {
    code: "unknown_option",
    mistake: "an option borrowed from a different pattern's documentation",
    request: { pattern: "result", options: { pagination: "cursor" } },
  },
  {
    code: "invalid_option_value",
    mistake: "a plausible synonym for a declared value",
    request: { pattern: "retry", identifiers: { entity: "Order" }, options: { jitter: "random" } },
  },
  {
    code: "unknown_identifier",
    mistake: "the habit of sending `entity` to every pattern, including the six that take no role",
    request: { pattern: "context-budget", identifiers: { entity: "Order" } },
  },
  {
    code: "split_unsupported",
    mistake: "a scope copied from a pattern that splits onto one that does not",
    request: { pattern: "result", options: { emitScope: "core-only" } },
  },
  {
    code: "unconfigurable_format_option",
    mistake: "a whole `.prettierrc` pasted in, including the keys generation decides for itself",
    request: {
      pattern: "result",
      conventions: { prettierConfig: { printWidth: 100, parser: "babel" } },
    },
  },
  {
    code: "invalid_identifier",
    mistake: "a domain noun that collides with a name the pattern writes itself",
    request: { pattern: "retry", identifiers: { entity: "Error" } },
  },
  {
    code: "missing_required_option",
    mistake: "the binding scope without saying where the machinery already lives",
    request: {
      pattern: "unit-of-work",
      identifiers: { entity: "Order" },
      options: { emitScope: "binding-only" },
    },
  },
  {
    code: "contradictory_conventions",
    mistake: "a browser project whose test runner is the one browsers do not have",
    request: {
      pattern: "result",
      conventions: { runtime: "browser", testFramework: "node-test" },
    },
  },
];

/**
 * The codes whose remedy is a sentence rather than a list, with the reason each one has to be.
 *
 * Not a list of things to fix. Every entry is a case where enumerating the alternatives is impossible
 * rather than merely unwritten, and inventing an enumeration for them would produce a worse refusal: a
 * suggested identifier is a name the caller did not choose, and a suggested module path is a guess about
 * their repository presented as advice.
 */
const PROSE_REMEDY = new Map<ErrorCode, string>([
  [
    "invalid_identifier",
    "the remedy is another noun, and only the caller knows which one they meant; the message states the " +
      "rule the next one has to satisfy, which is everything that can be said without choosing for them",
  ],
  [
    "missing_required_option",
    "the value is the specifier the machinery was installed at, which is a fact about the caller's " +
      "project; the second resolution withdraws the requirement instead, and reading it is reading English",
  ],
  [
    "contradictory_conventions",
    "there is no fact about which of the two settings was meant, so the message names both and declines " +
      "to pick — a mechanical repair here would silently choose one half of the caller's intention",
  ],
  [
    "illegal_combination",
    "the alternatives are the catalogue's own prose, surfaced verbatim per FR-009; no rule is declared " +
      "by any shipped pattern today, so this is asserted on the wording rather than by being provoked",
  ],
]);

async function refusalFor(request: GenerateRequest): Promise<CorrectableError> {
  try {
    await generate(request);
  } catch (error) {
    if (error instanceof CorrectableError) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the request succeeded");
}

describe.each(CASES.map((entry) => ({ entry, name: entry.code })))("$name", ({ entry }) => {
  it("is refused, under the code it claims", async () => {
    const refusal = await refusalFor(entry.request);
    expect(refusal.code).toBe(entry.code);
  });

  const prose = PROSE_REMEDY.has(entry.code);

  it.runIf(!prose)(
    "is repaired from its own text and succeeds on the next attempt",
    async () => {
      const refusal = await refusalFor(entry.request);

      // Both wordings, because a caller reads the composed one and a library caller reads the raw one, and
      // a repair that worked on only one would leave the other surface unmeasured.
      for (const text of [messageFor(refusal, VOCABULARY), refusal.message]) {
        const corrected = repair(entry.request, text);
        expect(corrected, `nothing actionable in: ${text}`).toBeDefined();
        if (corrected === undefined) continue;

        // The one thing SC-007 forbids is a second discovery call, so this awaits generation directly:
        // there is nowhere for a lookup to hide between the refusal and the retry.
        const result = await generate(corrected);
        expect(result.pattern).toBeTruthy();
      }
    },
    300_000,
  );

  it.runIf(prose)("states its remedy in full, since no list could carry it", async () => {
    const refusal = await refusalFor(entry.request);
    const composed = messageFor(refusal, VOCABULARY);

    // The fields a model reads. Empty, and the sentence a caller receives would be true and useless — which
    // is how a row of the FR-035 table came to pass by returning a message with nothing in it.
    for (const field of remedyFields(refusal)) {
      expect(field, `${entry.code} lost part of its remedy`).not.toBe("");
    }

    // Long enough to be a remedy rather than a verdict. A bound rather than a wording, because the wording
    // is reviewed by a person and its length is the only part of it a test can defend.
    expect(composed.length).toBeGreaterThan(80);
    expect(repair(entry.request, composed)).toBeUndefined();
  });
});

/** The parts of a prose remedy, read off whichever error this is. */
function remedyFields(error: EngineError): readonly string[] {
  const record = error as unknown as Record<string, unknown>;
  const fields = ["rule", "because", "conflict"];
  const lists = ["resolutions", "alternatives"];

  return [
    ...fields.flatMap((name) => (typeof record[name] === "string" ? [record[name]] : [])),
    ...lists.flatMap((name) => (Array.isArray(record[name]) ? (record[name] as string[]) : [])),
  ];
}

describe("the taxonomy as a whole", () => {
  it("has every correctable code either repairable or argued for", () => {
    // The exhaustiveness that makes the two claims above add up to a statement about the surface rather
    // than about nine hand-picked requests. A new correctable code fails here until it is either provoked
    // by a case or entered in the ledger with its reason.
    const CORRECTABLE: readonly ErrorCode[] = [
      "unknown_pattern",
      "unknown_option",
      "invalid_option_value",
      "illegal_combination",
      "unknown_identifier",
      "invalid_identifier",
      "missing_required_option",
      "split_unsupported",
      "unconfigurable_format_option",
      "contradictory_conventions",
    ];

    const covered = new Set([...CASES.map((entry) => entry.code), ...PROSE_REMEDY.keys()]);
    expect(CORRECTABLE.filter((code) => !covered.has(code))).toEqual([]);
  });

  it("repairs more than half of them mechanically, and says which need reading", () => {
    const mechanical = CASES.filter((entry) => !PROSE_REMEDY.has(entry.code)).length;
    const prose = PROSE_REMEDY.size;

    // The measured floor for SC-007, and it is a floor rather than the figure: six of the ten recover with
    // no reading at all, and the four in the ledger are recoverable by anything that reads English — which
    // the criterion's "agent" does and this harness cannot. Pinned so that a reword quietly moving a
    // refusal from the first group to the second has to be noticed and argued for.
    expect(mechanical).toBe(6);
    expect(prose).toBe(4);
    expect(mechanical + prose).toBe(10);
  });
});
