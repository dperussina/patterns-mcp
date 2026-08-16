/**
 * Splitting an identifier into words, and putting it back together in each casing a template needs.
 *
 * Separate from `names.ts` only so that both the deriver and the validator can reach it. The validator
 * has to compare a caller's name against the names a pattern writes, and those are written in one
 * casing while a caller may send another — `repository` and `Repository` are the same request. Comparing
 * the derived forms is the only comparison that answers that, and a second word-splitter written in the
 * validator to avoid the import is the drift that would make the two disagree.
 */

/**
 * Splits an identifier into words on case boundaries and underscores.
 *
 * Acronyms are kept whole: `HTTPServer` splits as `HTTP` and `Server`, not into one word per capital, so
 * the kebab stem is `http-server` rather than `h-t-t-p-server`.
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

export function toPascal(words: readonly string[]): string {
  return words.map((word) => capitalise(word)).join("");
}

export function toCamel(words: readonly string[]): string {
  return words
    .map((word, index) => (index === 0 ? word.toLowerCase() : capitalise(word)))
    .join("");
}

export function toKebab(words: readonly string[]): string {
  return words.map((word) => word.toLowerCase()).join("-");
}

export function toScreamingSnake(words: readonly string[]): string {
  return words.map((word) => word.toUpperCase()).join("_");
}

/**
 * The form a name takes where a template declares a type.
 *
 * Two names collide when this agrees, and not when their spellings do: `repository` reaches the code as
 * `Repository`, while `REPOSITORY` stays an acronym and reaches it as itself.
 */
export function pascalOf(identifier: string): string {
  return toPascal(splitWords(identifier));
}

export function capitalise(word: string): string {
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
