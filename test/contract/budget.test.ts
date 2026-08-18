/**
 * No response is large enough to be truncated on the way to a caller (plan.md Performance Goals).
 *
 * This guards the only silent failure the product has. Every other way a request can go wrong announces
 * itself: a refusal states the rule it broke, a verification failure says it is our defect. A response a
 * host truncates announces nothing — it cuts mid-file, marks nothing, and the model compiles most of a
 * module believing it has all of it. There is no assertion a caller can make to detect it, which is why
 * the bound has to hold here.
 *
 * The budget is 10,000 tokens for a typical response, against the ~25,000 point at which common hosts
 * truncate. It is checked with a deliberately pessimistic estimator (`src/mcp/budget.ts`), because the
 * safe direction for a ceiling is to over-count.
 *
 * Swept across every pattern rather than sampled. Response size is a property of an individual pattern's
 * templates, so a sample says nothing about the one that will be added next month, and the largest are
 * already the interesting ones: `chat-model-port` renders about 88,000 bytes of files in full.
 */

import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/engine/catalog/load.js";
import { BUDGET_TOKENS, TRUNCATION_TOKENS, estimateTokens } from "../../src/mcp/budget.js";
import { goldenIdentifiers } from "../golden/harness.js";
import type { GenerativePattern } from "../../src/engine/catalog/schema.js";
import { connect } from "./client.js";
import type { Session } from "./client.js";

const catalog = await loadCatalog();
const patterns = catalog.patterns.filter(
  (pattern): pattern is GenerativePattern => pattern.kind === "generative",
);

/**
 * A measured response, or the fact that there was none to measure.
 *
 * `refused` is a legitimate outcome rather than a failure since T087: a bundle that would arrive cut is
 * refused instead of sent, so the sweeps below have two correct answers and have to be able to tell them
 * apart. Reported as data rather than by throwing, because a thrown refusal has to be caught by message
 * and that swallows real failures alongside it.
 */
type Measured = { readonly refused: true } | { readonly refused: false; readonly text: number; readonly whole: number };

async function measure(session: Session, pattern: string): Promise<Measured> {
  const entry = patterns.find((candidate) => candidate.name === pattern);
  if (entry === undefined) throw new Error(`no catalog entry for ${pattern}`);

  // The largest response the pattern can produce, and the one a caller gets by default: tests included,
  // no verbosity named. Naming a verbosity would test a choice the caller made rather than ours.
  const result = await session.client.callTool({
    name: "generate_pattern",
    arguments: {
      pattern,
      // Only the roles this pattern declares. Sending `entity` to one that reads none is now refused,
      // and a sweep that refused a third of the catalogue would measure nothing.
      identifiers: goldenIdentifiers(entry),
      includeTests: true,
    },
  });

  if (result.isError === true) return { refused: true };

  const text = (result.content as readonly { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");

  return { refused: false, text: estimateTokens(text), whole: estimateTokens(JSON.stringify(result)) };
}

describe("the text a caller is handed", () => {
  /**
   * The half that lands in a model's context, and the half this can hold absolutely.
   *
   * It is bounded by choice rather than by luck: over the budget, the default rendering summarises and
   * says so. So there is no exception list here and there should never be one — a pattern that fails this
   * has escaped the degradation rather than merely grown.
   */
  it.each(patterns.map((pattern) => pattern.name))(
    "stays inside the budget: %s",
    async (name) => {
      const session = await connect();

      try {
        const measured = await measure(session, name);
        // A refusal's text is a paragraph, so there is nothing for this to hold; the refusal's own
        // properties are asserted further down.
        if (measured.refused) return;

        expect(
          measured.text,
          `${name} renders ${String(measured.text)} tokens of text, over the ${String(BUDGET_TOKENS)} budget`,
        ).toBeLessThanOrEqual(BUDGET_TOKENS);
      } finally {
        await session.close();
      }
    },
    300_000,
  );
});

/**
 * The pattern that is over the *text* budget and inside the truncation ceiling, which is the band where
 * summarising is the right answer.
 *
 * `chat-model-port` without its suite: about 18,000 tokens serialised, comfortably past the 10,000-token
 * text budget and comfortably inside the 25,000-token ceiling. In full with its suite it is past the
 * ceiling and is refused instead, which is the case below — so this arrangement is what keeps the two
 * behaviours from being tested through each other.
 */
const SUMMARISED = { pattern: "chat-model-port", includeTests: false } as const;

describe("a bundle too large to render in full", () => {
  it("says it was summarised, rather than quietly returning less", async () => {
    const session = await connect();

    try {
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: SUMMARISED,
      });
      expect(result.isError).toBeFalsy();

      const text = (result.content as readonly { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("\n");

      expect(text.includes("was summarised"), "the caller is told the contents are not here").toBe(true);
      expect(estimateTokens(text)).toBeLessThanOrEqual(BUDGET_TOKENS);
    } finally {
      await session.close();
    }
  }, 300_000);

  it("still returns every byte, in the structured half", async () => {
    const session = await connect();

    try {
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: SUMMARISED,
      });

      // Summarising is a rendering decision and must not become a data one: a caller reading
      // `structuredContent` has the whole bundle whatever the text says.
      const structured = result.structuredContent as { files?: readonly { contents?: string }[] };
      expect(structured.files?.length ?? 0).toBeGreaterThan(0);
      for (const file of structured.files ?? []) {
        expect(file.contents ?? "", "a file the text omitted and the structure should not").not.toBe("");
      }
    } finally {
      await session.close();
    }
  }, 300_000);

  it("renders in full when a caller asks for full and it fits, because that is their call to make", async () => {
    const session = await connect();

    try {
      // `repository`: about 12,000 tokens summarised and 23,000 rendered in full, so it is over the text
      // budget — summarised by default — and still inside the ceiling when a caller overrides that.
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: { pattern: "repository", verbosity: "full" },
      });

      const text = (result.content as readonly { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("\n");

      expect(text, "an explicit request is answered, not second-guessed").toContain("```ts");
      expect(text).not.toContain("was summarised");
      expect(text).not.toContain("replaced with a summary");
    } finally {
      await session.close();
    }
  }, 300_000);

  /**
   * The case that measuring found, and the reason the ceiling is not enforced by refusing.
   *
   * `verbosity: full` copies every file into the text beside the structured copy, so it roughly doubles
   * the response — enough to put six of the twenty-six patterns past the ceiling whose default rendering
   * fits comfortably. Refusing them would charge a caller their bundle for a presentation choice, when
   * shrinking the presentation costs nothing: every byte is in `structuredContent` either way.
   */
  it("replaces an explicit full that would not survive, rather than refusing the bundle", async () => {
    const session = await connect();

    try {
      // `tool-loop`: about 21,000 tokens summarised, so roughly 42,000 rendered in full.
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: { pattern: "tool-loop", verbosity: "full" },
      });

      expect(result.isError, "a rendering that does not fit is not a refusal").toBeFalsy();

      const text = (result.content as readonly { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("\n");

      expect(text, "the caller is told their rendering was not used").toContain(
        "replaced with a summary",
      );
      expect(text, "and told where the files are").toContain("complete in the structured result");
      expect(text, "the contents are not in the text, which is the whole point").not.toContain("```ts");

      const structured = result.structuredContent as { files?: readonly { contents?: string }[] };
      expect(structured.files?.length ?? 0).toBeGreaterThan(0);
      for (const file of structured.files ?? []) {
        expect(file.contents ?? "", "nothing was dropped from the data").not.toBe("");
      }

      expect(estimateTokens(JSON.stringify(result))).toBeLessThanOrEqual(TRUNCATION_TOKENS);
    } finally {
      await session.close();
    }
  }, 300_000);
});

describe("the whole serialised response", () => {
  /**
   * No exception list, and there should never be one again.
   *
   * There was one, holding `chat-model-port`, because `structuredContent` carries every file whatever the
   * text does and the largest bundle serialises past what a host will accept. T087 closed that by
   * refusing such a response rather than truncating or subsetting it, so the property this sweep asserts
   * is now absolute: whatever a caller receives fits, because anything that would not is refused instead.
   *
   * `measure` fails on a refusal, which is what makes this the check rather than a formality — a pattern
   * that grows past the ceiling starts being refused and is reported here by name.
   */
  it.each(patterns.map((pattern) => pattern.name))(
    "is inside the truncation point, or was refused rather than sent: %s",
    async (name) => {
      const session = await connect();

      try {
        const measured = await measure(session, name);
        // The other correct outcome, with its own assertions below.
        if (measured.refused) return;

        expect(
          measured.whole,
          `${name} serialises to ${String(measured.whole)} tokens, past the ${String(TRUNCATION_TOKENS)} truncation point`,
        ).toBeLessThanOrEqual(TRUNCATION_TOKENS);
      } finally {
        await session.close();
      }
    },
    300_000,
  );
});

/**
 * The one response shape that must never exist: a bundle sent past the ceiling.
 *
 * Refusing rather than subsetting was the decision (T087), and the reason is that `files` means *the
 * bundle*. A partial one would put a completeness check on every consumer of every pattern to
 * accommodate one, and would need noticing to be understood, where a refusal cannot be missed.
 */
describe("a bundle too large to send at all", () => {
  it("is refused, with the narrowings that fit named", async () => {
    const session = await connect();

    try {
      // The full bundle with its suite: about 29,000 tokens, past the ceiling. The only request in the
      // catalogue that is, which is why it is named rather than searched for.
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: { pattern: "chat-model-port", includeTests: true },
      });

      expect(result.isError, "a response that would arrive cut is not sent").toBe(true);
      expect(result.structuredContent, "no half-bundle wearing the shape of a success").toBeUndefined();

      const text = (result.content as readonly { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("\n");

      // Each clause is a thing the caller can act on, and the refusal is worth nothing without them.
      expect(text, "says the request is fine and the answer is what does not fit").toContain(
        "Nothing is wrong with the request",
      );
      expect(text, "names the lever that drops the suite").toContain("includeTests: false");
      expect(text, "names the two-call route for a pattern that splits").toContain("emitScope: core-only");
      expect(text, "names the surface with no ceiling").toContain("from a shell");

      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta?.["com.perussina.patterns/errorCode"]).toBe("response_too_large");
      expect(meta?.["com.perussina.patterns/correctable"], "the caller can fix this").toBe(true);
    } finally {
      await session.close();
    }
  }, 300_000);

  it("is answered when narrowed exactly as the refusal said", async () => {
    const session = await connect();

    try {
      // The advice is only advice if it works. Both narrowings, since a refusal naming one that fails
      // would be worse than a refusal naming none.
      for (const args of [
        { pattern: "chat-model-port", includeTests: false },
        { pattern: "chat-model-port", emitScope: "core-only" },
      ]) {
        const result = await session.client.callTool({ name: "generate_pattern", arguments: args });
        expect(result.isError, `${JSON.stringify(args)} was still refused`).toBeFalsy();
        expect(estimateTokens(JSON.stringify(result))).toBeLessThanOrEqual(TRUNCATION_TOKENS);
      }
    } finally {
      await session.close();
    }
  }, 300_000);
});
