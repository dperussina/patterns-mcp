/**
 * Table-driven derivation of identifiers from a caller-supplied name (FR-040,
 * FR-041).
 *
 * No pluralization library. Principle I requires that `Person` resolve to one
 * documented plural forever, and a library makes that a function of whichever
 * version resolved at install time — so a patch bump could silently rename
 * members across every consumer's regenerated output.
 *
 * The module is split the same way the catalogue is: `deriveNames` is pure and
 * takes an already-loaded table, `loadNameTable` holds the only I/O. Generation
 * therefore never touches the filesystem.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { dataPath } from "../data-root.js";

import { checkIdentifier, type IdentifierCheckOptions } from "./identifiers.js";

export const NameTableSchema = z.strictObject({
  version: z.literal(1),
  note: z.string().optional(),
  irregular: z.record(z.string(), z.string()),
  invariant: z.strictObject({
    note: z.string().optional(),
    words: z.array(z.string()),
  }),
});

export type NameTable = z.infer<typeof NameTableSchema>;

export interface NameTransform {
  /** The validated caller identifier, unchanged. */
  readonly singular: string;
  /** The one documented plural, in the same casing style as `singular`. */
  readonly plural: string;
  readonly camel: string;
  readonly pascal: string;
  readonly kebab: string;
  readonly screamingSnake: string;
  /** File-name stems, derived from the kebab forms. */
  readonly stem: string;
  readonly pluralStem: string;
  /**
   * True when the word's plural equals its singular. Surfaced rather than hidden
   * because a pattern emitting both forms would otherwise emit one name twice.
   */
  readonly pluralEqualsSingular: boolean;
}

export type NameDerivation =
  | { readonly ok: true; readonly names: NameTransform }
  | { readonly ok: false; readonly problem: string };

/**
 * Suffixes English pluralises inconsistently. Each is refused unless the word
 * appears in the table, because the alternatives are equally common and picking
 * one silently would bake a coin-flip into a consumer's file names:
 * `leaf`/`leaves` against `roof`/`roofs`, `photo`/`photos` against
 * `potato`/`potatoes`, `radius`/`radii` against `status`/`statuses`.
 */
const AMBIGUOUS_SUFFIXES: readonly {
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  {
    pattern: /[^aeiou]o$/,
    why: "a consonant followed by -o (compare photos with potatoes)",
  },
  { pattern: /(?:fe|f)$/, why: "-f or -fe (compare roofs with leaves)" },
  {
    pattern: /(?:us|is|on|um|ex|ix)$/,
    why: "a Latin or Greek ending (compare statuses with radii)",
  },
];

/** Reads the exception table. Call once at startup, not per generation. */
export async function loadNameTable(path?: string): Promise<NameTable> {
  // Resolved here rather than in a module-level constant: the shipped location is found by walking up
  // to the package root, and doing that at import time would throw in a loader instead of at a caller.
  const resolved = path ?? dataPath("names.json");
  return NameTableSchema.parse(JSON.parse(await readFile(resolved, "utf8")));
}

/**
 * Derives every identifier form for `singular`, or refuses.
 *
 * Refusal states the rule that could not be applied (FR-041). An approximation
 * would be worse than a refusal here: the caller can rename, but they cannot
 * un-ship a member name that a hundred regenerated files already reference.
 */
export function deriveNames(
  singular: string,
  table: NameTable,
  options: IdentifierCheckOptions = {},
): NameDerivation {
  const checked = checkIdentifier(singular, options);
  if (!checked.ok) {
    return { ok: false, problem: checked.problem };
  }

  const words = splitWords(singular);
  const last = words.at(-1);

  if (last === undefined) {
    return { ok: false, problem: `cannot derive names from "${singular}"` };
  }

  const pluralised = pluraliseWord(last, table);
  if (!pluralised.ok) {
    return pluralised;
  }

  const pluralWords = [...words.slice(0, -1), pluralised.word];

  return {
    ok: true,
    names: {
      singular,
      plural: applyStyleOf(singular, pluralWords),
      camel: toCamel(words),
      pascal: toPascal(words),
      kebab: toKebab(words),
      screamingSnake: toScreamingSnake(words),
      stem: toKebab(words),
      pluralStem: toKebab(pluralWords),
      pluralEqualsSingular:
        pluralised.word.toLowerCase() === last.toLowerCase(),
    },
  };
}

type PluralResult = { ok: true; word: string } | { ok: false; problem: string };

function pluraliseWord(word: string, table: NameTable): PluralResult {
  const lower = word.toLowerCase();

  const irregular = table.irregular[lower];
  if (irregular !== undefined) {
    return { ok: true, word: matchCase(word, irregular) };
  }

  if (table.invariant.words.includes(lower)) {
    return { ok: true, word };
  }

  // Ambiguity is checked before the confident rules, because several ambiguous
  // endings would otherwise be swallowed by them — "-us" also ends in "-s".
  for (const { pattern, why } of AMBIGUOUS_SUFFIXES) {
    if (pattern.test(lower)) {
      return {
        ok: false,
        problem:
          `cannot derive a plural for "${word}" with confidence: it ends in ${why}. ` +
          `Words with this ending are only pluralised from the exception table, and ` +
          `"${lower}" is not in it. Supply a different name.`,
      };
    }
  }

  if (/(?:s|x|z|ch|sh)$/.test(lower)) {
    return { ok: true, word: `${word}es` };
  }

  if (/[^aeiou]y$/.test(lower)) {
    return { ok: true, word: `${word.slice(0, -1)}ies` };
  }

  return { ok: true, word: `${word}s` };
}

/**
 * Splits an identifier into words on case boundaries and underscores.
 *
 * Acronyms are kept whole: `HTTPServer` splits as `HTTP` and `Server`, not into
 * one word per capital, so the kebab stem is `http-server` rather than
 * `h-t-t-p-server`.
 */
export function splitWords(identifier: string): string[] {
  const words: string[] = [];

  for (const chunk of identifier.split(/[_$]+/)) {
    if (chunk === "") {
      continue;
    }
    const matches = chunk.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g);
    if (matches !== null) {
      words.push(...matches);
    }
  }

  return words;
}

function toPascal(words: readonly string[]): string {
  return words.map((word) => capitalise(word)).join("");
}

function toCamel(words: readonly string[]): string {
  return words
    .map((word, index) => (index === 0 ? word.toLowerCase() : capitalise(word)))
    .join("");
}

function toKebab(words: readonly string[]): string {
  return words.map((word) => word.toLowerCase()).join("-");
}

function toScreamingSnake(words: readonly string[]): string {
  return words.map((word) => word.toUpperCase()).join("_");
}

/**
 * Rebuilds the plural in whatever style the caller wrote the singular in, so a
 * request for `order_item` is answered with `order_items` rather than a form the
 * caller would have to re-case themselves.
 */
function applyStyleOf(singular: string, words: readonly string[]): string {
  if (singular.includes("_")) {
    const upper = singular === singular.toUpperCase();
    return upper
      ? toScreamingSnake(words)
      : words.map((w) => w.toLowerCase()).join("_");
  }
  if (/^[a-z]/.test(singular)) {
    return toCamel(words);
  }
  return toPascal(words);
}

function capitalise(word: string): string {
  // Preserve an all-caps acronym rather than turning HTTP into Http.
  if (word.length > 1 && word === word.toUpperCase()) {
    return word;
  }
  // An acronym carrying a pluralising suffix is no longer all-caps, so the
  // clause above misses it. Lowering its tail would answer ID with Ids.
  if (ACRONYM_PLURAL.test(word)) {
    return word;
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * An acronym followed by the suffix `pluraliseWord` appends: `IDs`, `BOXes`.
 * Two leading capitals are required so a normal capitalised word ending in -s,
 * like `Status`, still gets its tail normalised.
 */
const ACRONYM_PLURAL = /^[A-Z]{2,}(?:e?s|ies)$/;

/** Applies the casing of `source` to a table entry, which is stored lowercase. */
function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(source)) {
    return capitalise(replacement);
  }
  return replacement;
}
