/**
 * The `describe_pattern` tool (contracts/mcp-tools.md).
 *
 * The step that makes a first-attempt-correct request possible (SC-006), so it withholds nothing: every
 * option with its full value space and default, and the legality rules in the same words the refusal
 * would use.
 *
 * `pattern` is a string rather than an enum of catalogue names, which is the one place this tool departs
 * from the contract's table. The contract asks for both a closed enum *and* an `isError` result naming
 * the nearest catalogue names for an unknown pattern, and those two cannot both hold: an enum is checked
 * before the handler runs, so the suggestion is unreachable. The rest of the contract settles which to
 * keep — it classifies an unknown pattern as a result error rather than a protocol error, which only
 * makes sense if the handler sees the value. Two further reasons point the same way: the enum would copy
 * the catalogue into the schema of every tool that names a pattern, which is the payload cost `list_patterns`
 * exists to avoid (FR-027), and it would grow with every release, churning a schema advertised as
 * cacheable.
 */

import { z } from "zod";

import {
  ALLOWED_LICENSES,
  CategorySchema,
  PatternKindSchema,
  TierSchema,
} from "../../engine/catalog/schema.js";
import { describePattern } from "../../index.js";
import type { PatternDetail } from "../../index.js";
import { cacheHintMeta } from "../cache.js";
import { strictObject, toErrorResult } from "../errors.js";

import type { CallToolResult } from "@modelcontextprotocol/server";

export const describeInput = strictObject({
  pattern: z
    .string()
    .describe("Catalog name of the pattern, e.g. \"result\". Call list_patterns for the names."),
});

/**
 * Options are described as a union discriminated on `type`, mirroring the catalogue: `values` exists only
 * where there is a closed set to choose from, and `default` is typed as whatever the option holds. A flat
 * shape with everything optional would let a caller read a `values` array on a boolean option and reason
 * about a value space that does not exist.
 */
const optionOutput = z.discriminatedUnion("type", [
  z.object({
    name: z.string().describe("Option name, as passed in `options`."),
    type: z.literal("enum").describe("Choose one of `values`."),
    values: z.array(z.string()).describe("The only permitted values."),
    default: z.string().describe("Used when you omit the option."),
    description: z.string().describe("What the option decides."),
    affects: z
      .array(z.string())
      .describe("Which parts of the generated code this option changes, and nothing else does."),
  }),
  z.object({
    name: z.string().describe("Option name, as passed in `options`."),
    type: z.literal("boolean").describe("True or false."),
    default: z.boolean().describe("Used when you omit the option."),
    description: z.string().describe("What the option decides."),
    affects: z.array(z.string()).describe("Which parts of the generated code this option changes."),
  }),
  z.object({
    name: z.string().describe("Option name, as passed in `options`."),
    type: z.literal("string").describe("Any string, validated where the pattern says so."),
    default: z.string().describe("Used when you omit the option."),
    description: z.string().describe("What the option decides."),
    affects: z.array(z.string()).describe("Which parts of the generated code this option changes."),
  }),
  z.object({
    name: z.string().describe("Option name, as passed in `options`."),
    type: z.literal("integer").describe("A whole number."),
    default: z.number().describe("Used when you omit the option."),
    description: z.string().describe("What the option decides."),
    affects: z.array(z.string()).describe("Which parts of the generated code this option changes."),
  }),
]);

/**
 * The names a caller supplies. Described alongside the options because they are the other half of a
 * request, and were the half a caller had to guess at.
 */
const identifierOutput = z.object({
  name: z
    .string()
    .describe("The key to use in `identifiers`, e.g. `entity` in `{ entity: \"Order\" }`."),
  description: z.string().describe("What the pattern names after it."),
});

/**
 * A legality rule is returned as its trigger *and* its prose, not one or the other. The prose is what a
 * caller reads; the `when`/`forbids` pair is what a caller can evaluate before calling, which is the
 * difference between documentation and a rule that can be checked.
 */
const legalityOutput = z.object({
  rule: z.string().describe("The rule, in the same words the refusal will use."),
  alternatives: z.array(z.string()).describe("What to do instead."),
  when: z
    .record(z.string(), z.unknown())
    .describe("The condition that activates the rule, as a checkable predicate over resolved options."),
  forbids: z
    .record(z.string(), z.unknown())
    .describe("The option and values the rule rules out while that condition holds."),
});

export const describeOutput = z.object({
  name: z.string().describe("Stable catalog name."),
  title: z.string().describe("Human-readable name."),
  category: CategorySchema.describe("Which family this pattern belongs to."),
  kind: PatternKindSchema.describe("`generative` emits code; `advisory` recommends something else."),
  intent: z.string().describe("What the pattern is for."),
  supportsSplit: z
    .boolean()
    .describe("Whether `emitScope` is available. False means this pattern emits one module."),
  variants: z.array(z.string()).describe("Named variants. Empty when there is only the default form."),
  identifiers: z
    .array(identifierOutput)
    .describe(
      "The names to pass in `identifiers`, and what each one names. Empty means this pattern " +
        "takes none and will refuse any you send. Each is optional: omit one and a generic name " +
        "is used instead.",
    ),
  reservedNames: z
    .array(z.string())
    .describe(
      "Names this pattern writes itself, so a name you send that reaches any of them is refused. " +
        "Compared after casing is applied, so `repository` is the same request as `Repository`. " +
        "Usually empty.",
    ),
  options: z.array(optionOutput).describe("Every option, with its permitted values and default."),
  legality: z
    .array(legalityOutput)
    .describe("Combinations that will be refused, and what to do instead. Read these before calling."),
  relatedPatterns: z.array(z.string()).describe("Patterns worth considering alongside this one."),
  tier: TierSchema.describe("Release tier."),
  advisory: z
    .object({
      alternative: z.string().describe("What to use instead."),
      rationale: z.string().describe("Why this pattern is not the answer here."),
      example: z.string().optional().describe("Illustration of the alternative."),
    })
    .optional()
    .describe("Present only on an advisory pattern. Its presence is why nothing will be generated."),
  network: z
    .object({
      boundary: z.string().describe("What to pass a stub to, so nothing is reached in a test."),
      reason: z.string().describe("Which emitted file calls out, under which options, and why."),
      defaultHost: z
        .string()
        .optional()
        .describe("Where it goes if you override nothing. Absent when you must supply the host."),
    })
    .optional()
    .describe(
      "Present only when the generated code can reach the network. Absent means it cannot, under any " +
        "option. Read before generating: this is the field that decides whether the output is something " +
        "you can drop into a codebase without a second review.",
    ),
  provenance: z.string().describe("Where the pattern's design came from."),
  license: z.enum(ALLOWED_LICENSES).describe("Licence the pattern's provenance permits."),
});

type DescribeInput = z.infer<typeof describeInput>;

/** Shared with the catalog resource template so the two cannot answer differently. */
export async function detail(name: string): Promise<PatternDetail> {
  return describePattern(name);
}

export async function handleDescribe(input: DescribeInput): Promise<CallToolResult> {
  try {
    const described = await detail(input.pattern);
    return {
      content: [{ type: "text", text: render(described) }],
      structuredContent: described,
      _meta: cacheHintMeta(),
    };
  } catch (error) {
    return toErrorResult(error);
  }
}

function render(pattern: PatternDetail): string {
  const sections = [`## ${pattern.title} (\`${pattern.name}\`)`, pattern.intent];

  if (pattern.advisory !== undefined) {
    sections.push(
      `**Advisory.** Use ${pattern.advisory.alternative} instead. ${pattern.advisory.rationale}`,
    );
    if (pattern.advisory.example !== undefined) {
      sections.push(`\`\`\`ts\n${pattern.advisory.example}\n\`\`\``);
    }
  }

  if (pattern.kind === "generative") {
    sections.push(
      pattern.identifiers.length > 0
        ? "### Identifiers\n\n" +
            pattern.identifiers
              .map((role) => `- \`${role.name}\` — ${role.description}`)
              .join("\n") +
            "\n\nPass a singular PascalCase domain noun, e.g. " +
            `\`{ ${pattern.identifiers[0]?.name ?? "entity"}: "Order" }\`. ` +
            "Each may be omitted, in which case a generic name is used. Any other key is refused."
        : "### Identifiers\n\nNone: this pattern emits one module named after itself. " +
            "Supplying any identifier is refused rather than ignored.",
    );

    // Said here rather than left to the refusal, which arrives a turn too late. The casing clause is not
    // pedantry: the comparison is on the derived name, so a caller reading `Repository` and sending
    // `repository` would otherwise think they had found a way round it.
    if (pattern.reservedNames.length > 0) {
      sections.push(
        `**Taken:** ${pattern.reservedNames.map((name) => `\`${name}\``).join(", ")} — ` +
          "this pattern writes these itself, and a name of yours that reaches one is refused, " +
          "whatever casing you send it in. Everything else it names around yours.",
      );
    }

    // Ahead of the options rather than after them, because it can decide whether the options matter.
    if (pattern.network !== undefined) {
      const host =
        pattern.network.defaultHost === undefined
          ? "It contacts only the host you configure."
          : `Default host: ${pattern.network.defaultHost}`;
      sections.push(
        `**Reaches the network.** ${pattern.network.reason} Pass your own \`${pattern.network.boundary}\` ` +
          `to keep it offline — the generated tests do exactly that, and are executed here before you ` +
          `receive them, so nothing dials during generation. ${host}`,
      );
    }
  }

  if (pattern.options.length > 0) {
    sections.push(
      "### Options\n\n" +
        pattern.options
          .map(
            (option) =>
              `- \`${option.name}\` — ${option.description} ` +
              `(${option.type === "enum" ? option.values.map((value) => `\`${value}\``).join(" | ") : option.type}` +
              `, default \`${String(option.default)}\`)`,
          )
          .join("\n"),
    );
  }

  if (pattern.legality.length > 0) {
    sections.push(
      "### Rules\n\n" +
        pattern.legality
          .map((rule) => `- ${rule.rule} Instead: ${rule.alternatives.join("; ")}.`)
          .join("\n"),
    );
  }

  if (pattern.variants.length > 0) {
    sections.push(`### Variants\n\n${pattern.variants.map((v) => `- \`${v}\``).join("\n")}`);
  }

  if (pattern.relatedPatterns.length > 0) {
    sections.push(`### Related\n\n${pattern.relatedPatterns.map((r) => `- \`${r}\``).join("\n")}`);
  }

  return sections.join("\n\n");
}
