/**
 * The `list_patterns` tool (contracts/mcp-tools.md).
 *
 * The intended first call: cheap, cacheable, and enough to choose a pattern without knowing anything
 * beforehand. Its filters are declared from the catalogue's own value spaces, so a filter cannot offer a
 * category the catalogue does not have.
 *
 * The handler holds no logic of its own. `listPatterns` decides what a summary is, which is what lets the
 * `pattern://catalog` resource return the same bytes rather than its own opinion of them (FR-014).
 */

import { z } from "zod";

import { CategorySchema, PatternKindSchema, TierSchema } from "../../engine/catalog/schema.js";
import { listCatalogue } from "../../index.js";
import type { Listing } from "../../index.js";
import { cacheHintMeta } from "../cache.js";
import { strictObject, toErrorResult } from "../errors.js";

import type { CallToolResult } from "@modelcontextprotocol/server";

export const listInput = strictObject({
  category: CategorySchema.optional().describe(
    "Only patterns in this category. Omit for every category.",
  ),
  kind: PatternKindSchema.optional().describe(
    "`generative` patterns emit code; `advisory` ones explain what to use instead and emit nothing. " +
      "Omit for both.",
  ),
  tier: TierSchema.optional().describe(
    "Release tier. Tier 1 is the settled core; higher tiers are newer. Omit for every tier.",
  ),
});

const summaryOutput = z.object({
  name: z.string().describe("Stable catalog name. Pass this to describe_pattern or generate_pattern."),
  title: z.string().describe("Human-readable name."),
  category: CategorySchema.describe("Which family this pattern belongs to."),
  kind: PatternKindSchema.describe("`generative` emits code; `advisory` recommends something else."),
  intent: z.string().describe("What the pattern is for, in one sentence. Enough to choose between patterns."),
  supportsSplit: z
    .boolean()
    .describe("Whether shared machinery and per-type bindings can be emitted separately."),
  tier: TierSchema.describe("Release tier."),
});

export const listOutput = z.object({
  patterns: z
    .array(summaryOutput)
    .describe(
      "Matching patterns, ordered by name. Summaries only — call describe_pattern for options and rules.",
    ),
  total: z.number().describe("How many patterns matched."),
});

type ListInput = z.infer<typeof listInput>;

/**
 * Shared with the catalog resource and with the CLI, so no two surfaces answer differently
 * (contracts/mcp-resources.md, contracts/cli.md). The envelope itself is `listCatalogue` in the engine's
 * public API; what this adds is the translation from a validated tool input to the engine's filters.
 *
 * Absent filters are dropped rather than passed as `undefined`. "Filter by no category" and "do not
 * filter by category" are the same intention here, and the engine's type says so by not admitting the
 * first spelling.
 */
export async function listing(filters: ListInput = {}): Promise<Listing> {
  return await listCatalogue({
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.tier === undefined ? {} : { tier: filters.tier }),
  });
}

export async function handleList(input: ListInput): Promise<CallToolResult> {
  try {
    const result = await listing(input);
    return {
      content: [{ type: "text", text: render(result) }],
      structuredContent: result,
      _meta: cacheHintMeta(),
    };
  } catch (error) {
    return toErrorResult(error);
  }
}

/**
 * An empty result says so in words.
 *
 * A caller whose filters matched nothing has to be able to tell that from a call that failed, and an
 * empty list rendered as an empty string is indistinguishable from both a failure and a lost response.
 */
function render(result: Listing): string {
  if (result.total === 0) {
    return "No patterns match those filters. Call list_patterns without filters to see everything.";
  }

  const rows = result.patterns.map(
    (pattern) =>
      `- **${pattern.name}** (${pattern.category}, ${pattern.kind}, tier ${String(pattern.tier)}) — ` +
      pattern.intent,
  );

  return [
    `${String(result.total)} pattern${result.total === 1 ? "" : "s"}:`,
    rows.join("\n"),
    "Call describe_pattern with a name for its options, permitted values, and rules.",
  ].join("\n\n");
}
