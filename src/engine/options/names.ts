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

import {
  capitalise,
  splitWords,
  toCamel,
  toKebab,
  toPascal,
  toScreamingSnake,
} from "./casing.js";
import { checkIdentifier, type IdentifierCheckOptions } from "./identifiers.js";

export { splitWords } from "./casing.js";

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
  | { readonly ok: false; readonly problem: string; readonly rule: string };

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
    // `-on` excludes `-ion`. The Latin and Greek doubt is real for `criterion`, `phenomenon` and
    // `automaton`, but an English `-ion` noun formed from a verb — every `-tion`, `-sion` and
    // `-ssion` — takes `-s` without exception, and those are among the commonest nouns a domain
    // has. Treating the whole ending as doubtful refused `Subscription`, `Transaction`, `Session`,
    // `Notification`, `Permission`, `Version`, `Connection`, `Collection`, `Region`, `Option`,
    // `Action`, `Question` and `Division`, which is not a conservative rule so much as a broken
    // one. The three words the doubt was aimed at are all in the exception table, and the table is
    // consulted before this list, so narrowing costs none of them.
    pattern: /(?<!i)on$|(?:us|is|um|ex|ix)$/,
    why: "a Latin or Greek ending (compare statuses with radii)",
  },
  {
    // A field name is invariant — `analytics`, `logistics`, `diagnostics` — and the plural of an
    // `-ic` noun is spelled identically: `topics`, `metrics`, `tactics`, `mechanics`. `Mechanics` is
    // both at once, which is what makes this a doubt rather than a rule. The field names resolve from
    // the table, and a plural reaching here as a "singular" is a caller mistake worth naming: the
    // alternative was `Topicses`, which is confident, wrong, and reads as ours rather than theirs.
    pattern: /ics$/,
    why: "-ics, which is both a field name and the plural of an -ic noun (compare analytics with topics)",
  },
  {
    // A bare `-s` is as likely to be a plural already as a singular. `Orders` is among the likeliest
    // things anyone hands a repository, and pluralising it again gave `orderses` — as the collection
    // name, so the mistake would have reached a schema rather than only a type.
    //
    // `-ss` is excluded because it is not in doubt: `classes`, `addresses`, `processes`. `-us` and
    // `-is` belong to the Latin rule above, which is listed first so it keeps them and its own
    // explanation. Genuine singulars that survive all of that — `alias`, `lens`, `canvas` — resolve
    // from the table, which is the escape hatch every ending here relies on.
    pattern: /(?<!s)s$/,
    why: "-s, which is as likely to be a plural already as a singular (compare orders with lenses)",
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
    return { ok: false, problem: checked.problem, rule: checked.rule };
  }

  const words = splitWords(singular);
  const last = words.at(-1);

  if (last === undefined) {
    return {
      ok: false,
      problem: `cannot derive names from "${singular}"`,
      rule: "No words could be read out of that name.",
    };
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

/** The forms a call site needs when it appends a noun of its own. */
export interface NounSuffixed {
  readonly pascal: string;
  readonly kebab: string;
  /**
   * The value-name form, for a factory or a variable named after the type.
   *
   * Here for the same reason `kebab` is: two call sites derived it themselves by
   * lowercasing the first character of `pascal`, which is right for `OrderId`
   * and wrong for every acronym — `APIKeyId` came back as `aPIKeyId`, in an
   * exported name. Deriving it from the words cannot make that mistake.
   */
  readonly camel: string;
}

/**
 * A pattern's own noun appended to the caller's name, unless the name already
 * ends with it.
 *
 * `branded-type` emits `${entity}Id`, so a caller asking it for a branded
 * `OrderId` — the most likely thing anyone asks that pattern for — was answered
 * with `OrderIdId`, in a file called `order-id-id.ts`. Six other patterns append
 * a literal noun the same way and are reachable the same way, which is why this
 * is here rather than in the one that was caught.
 *
 * Collapsing rather than refusing, against this module's usual preference for a
 * refusal over an approximation. That preference is about *ambiguity* — a plural
 * this cannot derive with confidence has two equally common answers, so guessing
 * bakes in a coin flip. There is no coin flip here: a name already ending in the
 * noun was written by someone naming the thing the pattern generates, and the
 * only question is whether they are told so or served.
 *
 * The comparison is by word rather than by suffix, so `OrderID` collapses too —
 * it is the same name and the same intent, and a caller who writes the acronym
 * in caps should not be the one who gets `OrderIDId`. Splitting also keeps
 * `Paid` and `Grid` from reading as though they end in `Id`, which a plain
 * `endsWith` on the lowercased forms would not.
 *
 * The repetition is removed wherever the two names meet, not only when the noun
 * is the whole of it. `typed-emitter` emits `${entity}EventName` and
 * `${entity}Events`, and `Event` is the likeliest thing anyone asks an emitter to
 * carry, so the same caller who would have got `OrderIdId` got `EventEventName`
 * and `EventEvents`. An overlap of one word is as much a repetition as an overlap
 * of all of them.
 *
 * A noun matching the entity's plural counts as an overlap too, and is the one
 * case where the noun's spelling survives rather than the entity's: `Event` and
 * `Events` name the same thing, and the plural is the form the call site asked
 * for. Everywhere else the entity's spelling wins, so a caller who writes
 * `OrderID` keeps their acronym.
 *
 * All three forms come back together because the identifier and the file stem
 * have to agree, and deriving the stem separately at each call site is how they
 * came apart in the first place.
 */
export function withNoun(entity: NameTransform, noun: string): NounSuffixed {
  const nounWords = splitWords(noun);
  const entityWords = splitWords(entity.pascal);
  const seam = overlapAt(entityWords, nounWords, entity.plural);

  const kept =
    seam.pluralised && seam.words > 0
      ? [...entityWords.slice(0, -1), nounWords[seam.words - 1] ?? ""]
      : entityWords;
  const words = [...kept, ...nounWords.slice(seam.words)];

  // Rebuilt from the words rather than concatenated, so an overlap is dropped from every form at
  // once. Concatenating `pascal` was what let the identifier and the stem disagree.
  return { pascal: toPascal(words), kebab: toKebab(words), camel: toCamel(words) };
}

/**
 * A name for something a template declares alongside the caller's, kept clear of names already spoken
 * for in the same module.
 *
 * The direct consequence of the collapse above. `withNoun` makes `AuditRecord` derive the record type
 * `AuditRecord` rather than `AuditRecordRecord`, which is what a caller wants — and an example that
 * declares its own stand-in for the caller's type then declares a second thing by that one name, so
 * `interface AuditRecord extends AuditRecord`, and a bundle reported as our defect over an entirely
 * ordinary domain name. The same happens without any collapse when a name is simply taken already: a
 * `Store` is a thing a shop has and also the seam `unit-of-work` exports.
 *
 * Stepping aside rather than refusing, because the name in the way is one we chose. A refusal spends
 * the caller's turn and offers them nothing they did wrong. The stand-in is only ever a name inside an
 * example or a suite — never an export the caller builds against — so the cost is a longer name in a
 * file that exists to be read once.
 *
 * Both candidates cannot be taken at once: a template's fixed names are known to it, and a derived one
 * comes from the caller's, so `Sample` in front of it is only ever taken if the caller's own name began
 * that way, in which case the second candidate answers.
 */
export function standIn(preferred: string, taken: Iterable<string>): string {
  const spoken = new Set(taken);

  return (
    [preferred, `Sample${preferred}`, `Own${preferred}`].find((candidate) => !spoken.has(candidate)) ??
    `Own${preferred}`
  );
}

/**
 * How many of the noun's leading words repeat the entity's trailing words.
 *
 * The longest overlap wins, so `OrderId` and `Id` meet at one word rather than none. A plural is
 * only accepted at the end of the run, which is the only place the entity's own final word can
 * stand: `Event` overlaps `Events` and `EventsLog` by that word, and neither wants it twice.
 */
function overlapAt(
  entityWords: readonly string[],
  nounWords: readonly string[],
  plural: string,
): { readonly words: number; readonly pluralised: boolean } {
  const pluralOfLast = splitWords(plural).at(-1)?.toLowerCase();

  for (let width = Math.min(entityWords.length, nounWords.length); width >= 1; width -= 1) {
    const tail = entityWords.slice(-width);
    const head = nounWords.slice(0, width);

    const leadingMatch = tail
      .slice(0, -1)
      .every((word, index) => same(word, head[index]));
    if (!leadingMatch) {
      continue;
    }

    if (same(tail.at(-1), head.at(-1))) {
      return { words: width, pluralised: false };
    }
    if (same(head.at(-1), pluralOfLast)) {
      return { words: width, pluralised: true };
    }
  }

  return { words: 0, pluralised: false };
}

function same(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && left.toLowerCase() === right?.toLowerCase();
}

type PluralResult =
  | { ok: true; word: string }
  | { ok: false; problem: string; rule: string };

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
        rule:
          `Its plural cannot be derived with confidence, because it ends in ${why}. ` +
          `Words with this ending are pluralised only from the exception table, and ` +
          `this one is not in it. Supply a different name.`,
      };
    }
  }

  // A single `z` after a vowel doubles: `quizzes`, `fezzes`, `whizzes`. Without this the rule below
  // answered `Quizes`, which is confidently wrong rather than doubtful — `waltz` and `buzz` have a
  // consonant and a second `z` in that position, so neither is affected.
  if (/[aeiou]z$/.test(lower)) {
    return { ok: true, word: `${word}zes` };
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
