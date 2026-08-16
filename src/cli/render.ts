/**
 * What the CLI prints for a person (contracts/cli.md, "Output modes").
 *
 * Only the default mode. `--json` prints the engine's result verbatim and does not come through here at
 * all, which is the property the parity test rests on: the JSON a script reads is the structure the
 * engine returned, not a rendering of it, so there is nothing in this file for the MCP surface to
 * disagree with.
 *
 * Written for a terminal rather than for a model — plain columns, no Markdown fences, nothing that
 * assumes a proportional font. The MCP adapter renders the same results as Markdown because its reader
 * is a model inside a chat transcript; sharing one renderer between them would mean serving fenced code
 * blocks to a shell and losing alignment in a transcript, so they are deliberately separate.
 */

import type { Advisory, Bundle } from "../engine/generate/index.js";
import type { PatternDetail } from "../engine/catalog/describe.js";
import type { PatternSummary } from "../engine/catalog/list.js";
import type { Option } from "../engine/catalog/schema.js";

/** Where the terminal rendering wraps prose. Narrow enough for a split window. */
const WIDTH = 88;

export function renderList(patterns: readonly PatternSummary[]): string {
  if (patterns.length === 0) {
    // A filter matching nothing is a fact about the catalogue rather than an error (see list.ts), so it
    // is reported as one, and the way back is named because an empty list gives a reader nowhere to go.
    return "No patterns match those filters. Run `patterns list` with none to see everything.\n";
  }

  const width = Math.max(...patterns.map((pattern) => pattern.name.length));
  const lines = patterns.map((pattern) => {
    // Marked, because asking to generate one of these returns advice instead of code, and a caller who
    // learns that only after the call has spent a turn on it (FR-023).
    const mark = pattern.kind === "advisory" ? " (advisory)" : "";
    return `${pattern.name.padEnd(width)}  ${pattern.title}${mark}`;
  });

  const advisory = patterns.filter((pattern) => pattern.kind === "advisory").length;
  const summary =
    advisory === 0
      ? `${String(patterns.length)} patterns.`
      : `${String(patterns.length - advisory)} patterns, and ${String(advisory)} advisory entries ` +
        `that answer with what to write instead.`;

  return `${lines.join("\n")}\n\n${summary}\n`;
}

export function renderDetail(detail: PatternDetail): string {
  const sections: string[] = [
    `${detail.name} — ${detail.title}`,
    wrap(detail.intent),
    `category: ${detail.category}    tier: ${String(detail.tier)}    kind: ${detail.kind}`,
  ];

  if (detail.advisory !== undefined) {
    sections.push(
      `ADVISORY — this pattern generates nothing.\n\n` +
        `${wrap(`Use ${detail.advisory.alternative} instead. ${detail.advisory.rationale}`)}`,
    );
    if (detail.advisory.example !== undefined) {
      sections.push(indent(detail.advisory.example));
    }
  }

  if (detail.variants.length > 0) {
    sections.push(`VARIANTS\n${detail.variants.map((name) => `  ${name}`).join("\n")}`);
  }

  if (detail.identifiers.length > 0) {
    sections.push(
      `IDENTIFIERS  (--identifier name=Value)\n${detail.identifiers
        .map((role) => `  ${role.name}\n${wrap(role.description, 6)}`)
        .join("\n")}`,
    );
  }

  if (detail.reservedNames.length > 0) {
    // Before the options rather than after, because it changes what an identifier may be — a caller who
    // reads it after choosing a name has already chosen the one that will be refused (FR-052).
    sections.push(
      `RESERVED NAMES  (this pattern writes these itself, so an identifier cannot be one)\n` +
        wrap(detail.reservedNames.join(", "), 2),
    );
  }

  if (detail.network !== undefined) {
    // Same placement argument as the reserved names above: this can decide whether the pattern is wanted
    // at all, so it goes before the options rather than after them.
    sections.push(
      `NETWORK  (this pattern's generated code can reach the network)\n` +
        `${wrap(detail.network.reason, 2)}\n` +
        `${wrap(`pass your own ${detail.network.boundary} to keep it offline`, 4)}\n` +
        wrap(
          detail.network.defaultHost === undefined
            ? "contacts only the host you configure"
            : `default host: ${detail.network.defaultHost}`,
          4,
        ),
    );
  }

  if (detail.options.length > 0) {
    sections.push(`OPTIONS\n${detail.options.map(renderOption).join("\n\n")}`);
  }

  if (detail.legality.length > 0) {
    sections.push(
      `RULES  (a request breaking one of these is refused, not guessed at)\n${detail.legality
        .map((rule) => `${wrap(rule.rule, 2)}\n${wrap(`instead: ${rule.alternatives.join(", ")}`, 4)}`)
        .join("\n\n")}`,
    );
  }

  if (detail.relatedPatterns.length > 0) {
    sections.push(`RELATED\n  ${detail.relatedPatterns.join(", ")}`);
  }

  sections.push(`PROVENANCE\n${wrap(detail.provenance, 2)}\n\n  licence: ${detail.license}`);

  return `${sections.join("\n\n")}\n`;
}

function renderOption(option: Option): string {
  const space =
    option.type === "enum"
      ? option.values.join(" | ")
      : option.type === "boolean"
        ? "true | false"
        : option.type;

  const shown = typeof option.default === "string" ? option.default : String(option.default);

  return `  ${option.name}: ${space}    (default ${shown})\n${wrap(option.description, 6)}`;
}

/**
 * What was written, and the evidence it works.
 *
 * The verification record is printed rather than summarised as "ok" because it is the product's central
 * claim and the one thing a caller cannot check for themselves without redoing the work: which compiler,
 * under whose options, with what result.
 */
export function renderBundle(bundle: Bundle, written: readonly string[], dryRun: boolean): string {
  const verb = dryRun ? "Would write" : "Wrote";
  const files = bundle.files
    .map((file, index) => `  ${written[index] ?? file.path}  (${file.role})`)
    .join("\n");

  const sections = [
    `${verb} ${String(bundle.files.length)} files for ${bundle.pattern}:`,
    files,
    `Verified with ${bundle.verification.compilerVersion}: ` +
      `${String(bundle.verification.diagnosticCount)} diagnostics, ` +
      `tests ${bundle.verification.testOutcome}. ` +
      `Formatted with ${bundle.verification.formatterVersion}.`,
  ];

  for (const [label, entries] of [
    ["NOTES", bundle.notes],
    ["WARNINGS", bundle.warnings],
    ["NEXT STEPS", bundle.nextSteps],
  ] as const) {
    if (entries.length > 0) {
      sections.push(`${label}\n${entries.map((entry) => wrap(`- ${entry}`, 2)).join("\n")}`);
    }
  }

  return `${sections.join("\n\n")}\n`;
}

export function renderAdvisory(advisory: Advisory): string {
  const sections = [
    `${advisory.pattern} is superseded. Nothing was generated, and that is the answer.`,
    wrap(`Use ${advisory.alternative} instead. ${advisory.rationale}`),
  ];

  if (advisory.example !== undefined) sections.push(indent(advisory.example));

  if (advisory.relatedPatterns.length > 0) {
    sections.push(
      `In this catalogue, and generatable:\n${advisory.relatedPatterns
        .map((name) => `  patterns describe ${name}`)
        .join("\n")}`,
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export const HELP = `patterns — generate verified TypeScript pattern implementations

  patterns list [--category <c>] [--kind generative|advisory] [--tier 1|2|3] [--json]
  patterns describe <pattern> [--json]
  patterns generate <pattern> [options] [--out <dir>] [--json] [--dry-run]

generate options
  --variant <name>              A named variant, where the pattern has them.
  --identifier <key>=<value>    A name to generate around. Repeatable.
  --option <key>=<value>        Any pattern option. Repeatable.
  --emit-scope full|core-only|binding-only
  --core-module <specifier>     Where the shared machinery already lives.
  --error-mode result|throw
  --async sync|async|both
  --cancellation none|abort-signal
  --no-tests                    Omit the generated test suite.
  --conventions <path>          A JSON file of project conventions.
  --out <dir>                   Where to write. Default is the working directory.
  --dry-run                     Print what would be written, write nothing.
  --json                        Print the result structure instead of writing.

Run \`patterns describe <pattern>\` before generating: it lists every option with its
permitted values and the rules that would refuse a request.

Exit codes: 0 success (advice counts as success), 1 your request needs changing,
2 unparseable arguments, 70 our defect.
`;

/** Wraps prose to `WIDTH`, indented. Deliberately simple: no hyphenation, no reflow of code. */
function wrap(text: string, indentBy = 0): string {
  const prefix = " ".repeat(indentBy);
  const lines: string[] = [];
  let line = prefix;

  for (const word of text.split(/\s+/u)) {
    if (word === "") continue;
    if (line.length > prefix.length && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = prefix + word;
    } else {
      line = line.length > prefix.length ? `${line} ${word}` : prefix + word;
    }
  }

  if (line.trim() !== "") lines.push(line);
  return lines.join("\n");
}

/** Indents a block without touching its internal line breaks, for code that has to stay as written. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}
