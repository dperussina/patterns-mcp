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

interface Measured {
  readonly text: number;
  readonly whole: number;
  readonly summarised: boolean;
}

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

  expect(result.isError, `${pattern} was refused, so its size is not what this measured`).not.toBe(true);

  const text = (result.content as readonly { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");

  return {
    text: estimateTokens(text),
    whole: estimateTokens(JSON.stringify(result)),
    summarised: text.includes("was summarised"),
  };
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

describe("a bundle too large to render in full", () => {
  it("says it was summarised, rather than quietly returning less", async () => {
    const session = await connect();

    try {
      // The largest pattern in the catalogue, and comfortably the wrong side of the budget in full.
      const measured = await measure(session, "chat-model-port");

      expect(measured.summarised, "the caller is told the contents are not here").toBe(true);
      expect(measured.text).toBeLessThanOrEqual(BUDGET_TOKENS);
    } finally {
      await session.close();
    }
  }, 300_000);

  it("still returns every byte, in the structured half", async () => {
    const session = await connect();

    try {
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: { pattern: "chat-model-port" },
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

  it("renders in full when a caller asks for full, because that is their call to make", async () => {
    const session = await connect();

    try {
      const result = await session.client.callTool({
        name: "generate_pattern",
        arguments: {
          pattern: "chat-model-port",
          verbosity: "full",
        },
      });

      const text = (result.content as readonly { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("\n");

      expect(text, "an explicit request is answered, not second-guessed").toContain("```ts");
      expect(text).not.toContain("was summarised");
    } finally {
      await session.close();
    }
  }, 300_000);
});

describe("the whole serialised response", () => {
  /**
   * Reported against the truncation point rather than the budget, and with an exception list.
   *
   * `structuredContent` carries every file whatever the text does, so the serialised result of the largest
   * patterns exceeds what a host that counts the entire payload would accept. Bounding it means returning
   * a coherent subset of the files with a statement of what was left out — which is a different piece of
   * work (T087), not a number to tighten here.
   *
   * The list exists so that overage cannot spread quietly. It may shrink; a pattern joining it is a
   * deliberate decision, and a pattern growing into it without one fails this.
   */
  const KNOWN_OVERSIZED = ["chat-model-port"] as const;

  it.each(patterns.map((pattern) => pattern.name))(
    "is either inside the truncation point or a known exception: %s",
    async (name) => {
      const session = await connect();

      try {
        const measured = await measure(session, name);
        const allowed = (KNOWN_OVERSIZED as readonly string[]).includes(name);

        if (allowed) {
          expect(
            measured.whole,
            `${name} is on the oversized list but now fits: take it off the list`,
          ).toBeGreaterThan(TRUNCATION_TOKENS);
        } else {
          expect(
            measured.whole,
            `${name} serialises to ${String(measured.whole)} tokens, past the ${String(TRUNCATION_TOKENS)} truncation point`,
          ).toBeLessThanOrEqual(TRUNCATION_TOKENS);
        }
      } finally {
        await session.close();
      }
    },
    300_000,
  );
});
