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
import type { Advisory, Bundle } from "../../engine/generate/index.js";
import { BUDGET_TOKENS, estimateTokens } from "../budget.js";
import { cacheHintMeta } from "../cache.js";
import { strictObject, toErrorResult } from "../errors.js";

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
export const generateInput = strictObject({
  pattern: z
    .string()
    .describe(
      'Catalog name of the pattern to generate, e.g. "result". Call list_patterns first.',
    ),
  variant: z
    .string()
    .optional()
    .describe("One of the pattern's declared variants. Omit for the default."),
  emitScope: z
    .enum(["full", "core-only", "binding-only"])
    .optional()
    .describe(
      "For a pattern that separates shared machinery from per-type bindings: `full` emits both, " +
        "`core-only` the machinery alone, `binding-only` just the glue for machinery you already " +
        "have. Only offered by patterns that split; the rest emit one module and reject this.",
    ),
  coreModule: z
    .string()
    .optional()
    .describe(
      "Import specifier of the already-installed core. Required when emitScope is binding-only.",
    ),
  includeTests: z
    .boolean()
    .optional()
    .describe(
      "Emit tests for the generated code. Defaults to true; they are executed before you see them.",
    ),
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
      'Names to generate around, e.g. { entity: "Order" }. Each is validated as a TypeScript ' +
        "identifier and rejected if reserved; output paths are derived from them and cannot be supplied directly.",
    ),
  options: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Pattern-specific options, validated against what the pattern declares. Call describe_pattern " +
        "for the list and the permitted values.",
    ),
  // Every field the engine accepts, with the same values, and a test holds it to that
  // (`test/unit/mcp-errors.test.ts`). Restated rather than derived because each one earns a description
  // here that the engine's schema has no reader for — and restating is exactly how `runtime` came to be
  // missing from this surface while the CLI could set it, so the test compares the two key sets in both
  // directions rather than only checking that this list is a subset.
  //
  // `testFramework` offers `jest` even though a suite cannot be executed under it: the engine refuses
  // that combination with a sentence explaining why and naming what does work, and narrowing the
  // enumeration here would replace that with a bare "invalid value" — worse advice for the caller it
  // concerns most, and it would hide `none` from a caller who wants no suite at all.
  conventions: strictObject(
    {
      strictness: z
        .enum(["strict", "strictest", "loose"])
        .optional()
        .describe(
          "How strictly generated code must typecheck. Verification runs under this, so it is the " +
            "setting that decides whether a bundle compiles in your repository.",
        ),
      moduleStyle: z.enum(["esm", "cjs"]).optional().describe("Module system for emitted imports."),
      importExtensions: z
        .enum(["none", "js", "ts"])
        .optional()
        .describe(
          "The extension a relative import carries. `js` is what an ESM project on Node needs.",
        ),
      typeImports: z
        .enum(["inline", "separate"])
        .optional()
        .describe("Whether types are imported with values or on their own `import type` line."),
      testFramework: z
        .enum(["vitest", "node-test", "jest", "none"])
        .optional()
        .describe(
          "The runner emitted suites are written for. `none` omits them. `jest` is declined when " +
            "tests are included, since a Jest suite cannot be executed in the verification sandbox.",
        ),
      runtime: z
        .enum(["node", "browser", "neutral"])
        .optional()
        .describe(
          "Where the code will run. `browser` verifies against the DOM library rather than " +
            "declaring timer and fetch globals itself.",
        ),
      prettierConfig: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Prettier style options, validated against an allowlist. `printWidth` below 40 is refused.",
        ),
    },
    "convention",
  )
    .optional()
    .describe(
      "Your project's conventions. Generated code is verified under these, not under ours, so " +
        "supplying them is how you get code that compiles in your repository.",
    ),
});

const fileOutput = z.object({
  path: z.string().describe("Path relative to where you place the bundle."),
  contents: z
    .string()
    .describe("Complete file contents, formatted and verified."),
  role: z
    .enum(["types", "core", "binding", "adapter", "example", "test"])
    .describe(
      "What this file is for. Files are ordered by role, so definitions precede uses.",
    ),
});

const verificationOutput = z.object({
  compilerVersion: z
    .string()
    .describe("The compiler that typechecked this bundle."),
  formatterVersion: z
    .string()
    .describe("The formatter that produced these bytes."),
  compilerOptions: z
    .record(z.string(), z.unknown())
    .describe(
      "The options actually verified against — yours, when you supplied conventions.",
    ),
  diagnosticCount: z
    .number()
    .describe("Always 0. A bundle with diagnostics is not returned at all."),
  testOutcome: z
    .enum(["passed", "skipped"])
    .describe(
      "`passed` means the emitted tests were executed and passed. `skipped` means there were none.",
    ),
  contentHash: z
    .string()
    .describe(
      "Hash of the bundle's contents. Identical inputs give an identical hash.",
    ),
});

const bundleOutput = z.object({
  kind: z
    .literal("bundle")
    .describe(
      "Discriminant. Advisory patterns answer with kind `advisory` instead.",
    ),
  pattern: z.string().describe("The pattern that was generated."),
  resolvedOptions: z
    .record(z.string(), z.unknown())
    .describe(
      "Every option after defaults, including the ones you did not set.",
    ),
  resolvedConventions: z
    .record(z.string(), z.unknown())
    .describe(
      "Every convention after defaults — what verification actually ran under.",
    ),
  files: z.array(fileOutput).describe("The bundle, ordered by role then path."),
  verification: verificationOutput.describe(
    "Evidence that this bundle compiles and its tests pass.",
  ),
  notes: z
    .array(z.string())
    .describe("Things worth knowing about what was generated."),
  warnings: z
    .array(z.string())
    .describe("Things that are legal but likely not what you wanted."),
  nextSteps: z.array(z.string()).describe("What to request next."),
});

/**
 * The answer for a pattern the language has superseded (FR-022).
 *
 * A success, and the schema has to say so plainly, because the shape alone would let a client conclude
 * otherwise: it has no `files`, and a tool result with no files looks like a failure to anything
 * skimming. Nothing is wrong — the request was answerable and this is the answer.
 */
const advisoryOutput = z.object({
  kind: z
    .literal("advisory")
    .describe(
      "Discriminant. This pattern generates nothing, and that is the answer rather than an error.",
    ),
  pattern: z.string().describe("The pattern that was asked for."),
  alternative: z
    .string()
    .describe("The idiomatic TypeScript construction to use instead."),
  rationale: z
    .string()
    .describe("Why the language made the pattern unnecessary."),
  example: z
    .string()
    .optional()
    .describe("Present where a few lines say it better than a paragraph."),
  relatedPatterns: z
    .array(z.string())
    .describe(
      "Catalog entries worth reaching for instead. Often the alternative is one of these, which is the call to make next.",
    ),
});

/**
 * Discriminated rather than one object with everything optional, so that a client reading the schema
 * learns that `files` and `verification` are guaranteed on the bundle case instead of merely usual.
 */
export const generateOutput = z.discriminatedUnion("kind", [
  bundleOutput,
  advisoryOutput,
]);

type GenerateInput = z.infer<typeof generateInput>;

/** Flat inputs that are options in the engine's vocabulary, mapped by name. */
const FLAT_OPTIONS = ["emitScope", "coreModule", "includeTests"] as const;

export async function handleGenerate(
  input: GenerateInput,
): Promise<CallToolResult> {
  try {
    const result = await generate({
      pattern: input.pattern,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
      ...(input.identifiers === undefined
        ? {}
        : { identifiers: input.identifiers }),
      ...(input.conventions === undefined
        ? {}
        : { conventions: input.conventions }),
      options: optionsFor(input),
    });

    return {
      content: [
        {
          type: "text",
          text:
            result.kind === "advisory"
              ? renderAdvisory(result)
              : render(result, input.verbosity),
        },
      ],
      structuredContent: result,
      _meta: cacheHintMeta(),
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

type Verbosity = "full" | "code-only" | "summary";

/**
 * Which rendering to use when the caller did not choose one.
 *
 * `full` unless the result of it would not survive the trip. A host that truncates an oversized tool
 * result cuts mid-file and marks nothing, so the caller receives most of a module, cannot tell it is
 * partial, and compiles it — the only silent failure in this product, and the largest patterns are big
 * enough to provoke it. Summarising instead makes the omission explicit and keeps every byte reachable
 * through a second call.
 *
 * An explicit `verbosity` is always honoured, including an explicit `full` on a bundle this would have
 * summarised. The default is ours to choose and belongs on the safe side; overriding a caller who named
 * their preference would just be a different way of not answering the question they asked.
 *
 * Deterministic, because size is a function of the bundle: the same request degrades the same way.
 */
function renderingFor(
  bundle: Bundle,
  requested: Verbosity | undefined,
): Verbosity {
  if (requested !== undefined) return requested;
  return estimateTokens(sectionsOf(bundle, "full").join("\n\n")) > BUDGET_TOKENS
    ? "summary"
    : "full";
}

/**
 * Renders the bundle for a reader.
 *
 * Whether Markdown or a serialized structure serves an agent better is an open question to settle with
 * an evaluation set rather than by preference (T094), so this stays deliberately plain: path-headed
 * fenced blocks, in bundle order.
 */
function render(bundle: Bundle, requested: Verbosity | undefined): string {
  const verbosity = renderingFor(bundle, requested);
  const sections = sectionsOf(bundle, verbosity);

  // Said only when *we* summarised. A caller who asked for a summary knows why they got one; a caller
  // who asked for nothing needs to know that this is not the whole bundle and what to do about it.
  if (requested === undefined && verbosity === "summary") {
    sections.push(
      "This response was summarised because the full rendering would risk being truncated in transit, " +
        "which would deliver a partial file with no indication that it was cut. Nothing was lost: ask " +
        "again with verbosity `full` for the contents, or narrow the request — `includeTests: false`, " +
        "or `emitScope: core-only` then `binding-only`, each of which returns a smaller whole.",
    );
  }

  return sections.join("\n\n");
}

/**
 * Renders advice for a reader.
 *
 * Leads by naming the pattern as superseded rather than by opening with the alternative, because the
 * reader asked for code and is about to not receive any: the first line has to account for that, or the
 * reply reads as an answer to a different question. `verbosity` is not consulted — there is no bundle to
 * be verbose about, and a summarised paragraph would be a paragraph.
 */
function renderAdvisory(advisory: Advisory): string {
  const sections = [
    `**${advisory.pattern} is superseded — nothing was generated, and that is the answer.**`,
    `Use ${advisory.alternative} instead. ${advisory.rationale}`,
  ];

  if (advisory.example !== undefined) {
    sections.push(`\`\`\`ts\n${advisory.example}\n\`\`\``);
  }

  if (advisory.relatedPatterns.length > 0) {
    sections.push(
      `### Next steps\n\n${advisory.relatedPatterns
        .map(
          (name) =>
            `- \`${name}\` is in this catalog and can be generated: describe_pattern for its options.`,
        )
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

function sectionsOf(bundle: Bundle, verbosity: Verbosity): string[] {
  const sections: string[] = [];

  if (verbosity === "summary") {
    // No diagnostic count: it is zero on every bundle that is returned at all, so reporting it as
    // though it varied would describe a state this response cannot be in.
    sections.push(
      `Generated ${bundle.pattern}: ${String(bundle.files.length)} files, verified with no ` +
        `diagnostics and tests ${bundle.verification.testOutcome}.`,
      bundle.files.map((file) => `- ${file.path} (${file.role})`).join("\n"),
      "File contents were omitted from this message. Request the same call with verbosity `full` to " +
        "receive them; nothing else about the result changes.",
    );
  } else {
    for (const file of bundle.files) {
      sections.push(`### ${file.path}\n\n\`\`\`ts\n${file.contents}\`\`\``);
    }
  }

  // `code-only` is the rendering that asked for nothing but the code, so the prose is what it omits.
  // `summary` omits file contents and not the guidance: a summarised `core-only` bundle whose next step
  // is "now request the binding" would otherwise hide the one thing its reader has to do.
  if (verbosity !== "code-only") {
    for (const [label, entries] of [
      ["Notes", bundle.notes],
      ["Warnings", bundle.warnings],
      ["Next steps", bundle.nextSteps],
    ] as const) {
      if (entries.length > 0) {
        sections.push(
          `### ${label}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`,
        );
      }
    }
  }

  return sections;
}
