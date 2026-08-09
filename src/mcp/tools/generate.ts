/**
 * The `generate_pattern` tool (contracts/mcp-tools.md).
 *
 * The schemas below are the only description of this tool that exists: the SDK derives `inputSchema`
 * and `outputSchema` from them, and they are what an agent reads to construct a call. So every field
 * carries a `.describe()`, and the input is flat — no nested unions — because the specification directs
 * implementations to bound schema depth and because a flat shape is easier for a model to fill.
 *
 * The handler is thin on purpose. It maps a request onto the engine, maps the result back, and holds
 * no generation logic of its own; anything it decided for itself would be a decision the CLI could not
 * make the same way (Principle X).
 */

import { z } from "zod";

import { generate } from "../../engine/generate/index.js";
import type { Bundle } from "../../engine/generate/index.js";
import { toErrorResult } from "../errors.js";

import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * `pattern` is a string rather than an enum of catalog names.
 *
 * The contract asks for closed enums wherever the value space is closed, and this one is. But an enum
 * is validated by the SDK before the handler runs, which would replace "no pattern named X, did you
 * mean Y" with a schema violation — losing the nearest-match suggestion the contract requires for an
 * unknown name. The enum becomes the better trade once the catalog is public API (T046) and the
 * description can enumerate the names; until then this keeps the more useful refusal.
 */
export const generateInput = z.object({
  pattern: z
    .string()
    .describe("Catalog name of the pattern to generate, e.g. \"result\". Call list_patterns first."),
  variant: z
    .string()
    .optional()
    .describe("One of the pattern's declared variants. Omit for the default."),
  emitScope: z
    .enum(["full", "core-only", "binding-only"])
    .optional()
    .describe(
      "How much to emit. `full` is the reusable module with its example and tests; `core-only` omits " +
        "the example and tests; `binding-only` emits just the glue for a core you already have.",
    ),
  coreModule: z
    .string()
    .optional()
    .describe("Import specifier of the already-installed core. Required when emitScope is binding-only."),
  includeTests: z
    .boolean()
    .optional()
    .describe("Emit tests for the generated code. Defaults to true; they are executed before you see them."),
  verbosity: z
    .enum(["full", "code-only", "summary"])
    .optional()
    .describe(
      "How much of the response to render as text. `code-only` omits notes; `summary` omits file " +
        "contents and tells you how to get them. Does not change the generated code or the structured result.",
    ),
  identifiers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Names to generate around, e.g. { entity: \"Order\" }. Each is validated as a TypeScript " +
        "identifier and rejected if reserved; output paths are derived from them and cannot be supplied directly.",
    ),
  options: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Pattern-specific options, validated against what the pattern declares. Call describe_pattern " +
        "for the list and the permitted values.",
    ),
  conventions: z
    .object({
      strictness: z.enum(["strict", "strictest", "loose"]).optional(),
      moduleStyle: z.enum(["esm", "cjs"]).optional(),
      importExtensions: z.enum(["none", "js", "ts"]).optional(),
      typeImports: z.enum(["inline", "separate"]).optional(),
      testFramework: z.enum(["vitest", "node-test"]).optional(),
      prettierConfig: z.record(z.string(), z.unknown()).optional(),
    })
    .optional()
    .describe(
      "Your project's conventions. Generated code is verified under these, not under ours, so " +
        "supplying them is how you get code that compiles in your repository.",
    ),
});

const fileOutput = z.object({
  path: z.string().describe("Path relative to where you place the bundle."),
  contents: z.string().describe("Complete file contents, formatted and verified."),
  role: z
    .enum(["types", "core", "binding", "adapter", "example", "test"])
    .describe("What this file is for. Files are ordered by role, so definitions precede uses."),
});

const verificationOutput = z.object({
  compilerVersion: z.string().describe("The compiler that typechecked this bundle."),
  formatterVersion: z.string().describe("The formatter that produced these bytes."),
  compilerOptions: z
    .record(z.string(), z.unknown())
    .describe("The options actually verified against — yours, when you supplied conventions."),
  diagnosticCount: z.number().describe("Always 0. A bundle with diagnostics is not returned at all."),
  testOutcome: z
    .enum(["passed", "skipped"])
    .describe("`passed` means the emitted tests were executed and passed. `skipped` means there were none."),
  contentHash: z.string().describe("Hash of the bundle's contents. Identical inputs give an identical hash."),
});

export const generateOutput = z.object({
  kind: z.literal("bundle").describe("Discriminant. Advisory patterns answer with kind `advisory` instead."),
  pattern: z.string().describe("The pattern that was generated."),
  resolvedOptions: z
    .record(z.string(), z.unknown())
    .describe("Every option after defaults, including the ones you did not set."),
  resolvedConventions: z
    .record(z.string(), z.unknown())
    .describe("Every convention after defaults — what verification actually ran under."),
  files: z.array(fileOutput).describe("The bundle, ordered by role then path."),
  verification: verificationOutput.describe("Evidence that this bundle compiles and its tests pass."),
  notes: z.array(z.string()).describe("Things worth knowing about what was generated."),
  warnings: z.array(z.string()).describe("Things that are legal but likely not what you wanted."),
  nextSteps: z.array(z.string()).describe("What to request next."),
});

type GenerateInput = z.infer<typeof generateInput>;

/** Flat inputs that are options in the engine's vocabulary, mapped by name. */
const FLAT_OPTIONS = ["emitScope", "coreModule", "includeTests"] as const;

export async function handleGenerate(input: GenerateInput): Promise<CallToolResult> {
  try {
    const bundle = await generate({
      pattern: input.pattern,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
      ...(input.identifiers === undefined ? {} : { identifiers: input.identifiers }),
      ...(input.conventions === undefined ? {} : { conventions: input.conventions }),
      options: optionsFor(input),
    });

    return {
      content: [{ type: "text", text: render(bundle, input.verbosity ?? "full") }],
      structuredContent: bundle,
    };
  } catch (error) {
    return toErrorResult(error);
  }
}

/**
 * Folds the flat inputs into the single options record the engine validates.
 *
 * A flat field and an `options` entry naming the same thing are the same option arriving twice. Rather
 * than pick a winner, the explicit record wins and nothing is silently dropped: it is the more specific
 * of the two, and a caller who sends both has expressed one intention.
 */
function optionsFor(input: GenerateInput): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const name of FLAT_OPTIONS) {
    const value = input[name];
    if (value !== undefined) options[name] = value;
  }
  return { ...options, ...input.options };
}

/**
 * Renders the bundle for a reader.
 *
 * Whether Markdown or a serialized structure serves an agent better is an open question to settle with
 * an evaluation set rather than by preference (T094), so this stays deliberately plain: path-headed
 * fenced blocks, in bundle order.
 */
function render(bundle: Bundle, verbosity: "full" | "code-only" | "summary"): string {
  const sections: string[] = [];

  if (verbosity === "summary") {
    sections.push(
      `Generated ${bundle.pattern}: ${String(bundle.files.length)} files, ` +
        `verified with ${bundle.verification.diagnosticCount === 0 ? "no" : "some"} diagnostics ` +
        `and tests ${bundle.verification.testOutcome}.`,
      bundle.files.map((file) => `- ${file.path} (${file.role})`).join("\n"),
      "Request again with verbosity `full` for the file contents.",
    );
    return sections.join("\n\n");
  }

  for (const file of bundle.files) {
    sections.push(`### ${file.path}\n\n\`\`\`ts\n${file.contents}\`\`\``);
  }

  if (verbosity === "full") {
    for (const [label, entries] of [
      ["Notes", bundle.notes],
      ["Warnings", bundle.warnings],
      ["Next steps", bundle.nextSteps],
    ] as const) {
      if (entries.length > 0) {
        sections.push(`### ${label}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`);
      }
    }
  }

  return sections.join("\n\n");
}
