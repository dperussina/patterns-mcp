/**
 * Rendering helpers. Tagged template literals only — there is no template
 * engine here on purpose (research §3): templates are ordinary TypeScript, so
 * renaming an option is a compile error at every interpolation site instead of a
 * silent blank in generated output.
 */

/** Values a template may interpolate. Arrays are joined as lines. */
export type Renderable =
  string | number | boolean | readonly Renderable[] | undefined | null;

/**
 * Strips the common leading indentation from a template literal, so a template
 * can be written at its natural indentation in source without that indentation
 * reaching the generated file.
 *
 * Interpolated multi-line values are re-indented to their placeholder's column.
 * Without this, injecting a rendered block into an indented placeholder aligns
 * only its first line and leaves the rest hanging at column zero — which
 * compiles, but produces output no one would accept in review.
 */
export function dedent(
  strings: TemplateStringsArray,
  ...values: readonly Renderable[]
): string {
  let out = "";

  for (const [index, literal] of strings.entries()) {
    out += literal;

    if (index < values.length) {
      out += reindent(stringify(values[index]), trailingIndentOf(out));
    }
  }

  return stripCommonIndent(normalizeNewlines(out));
}

/** Prefixes every non-blank line with `width` spaces. Blank lines stay blank. */
export function indent(text: string, width = 2): string {
  const prefix = " ".repeat(width);
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => (line.trim() === "" ? line : `${prefix}${line}`))
    .join("\n");
}

/**
 * Emits `text` when `condition` holds, otherwise `otherwise`.
 *
 * Returning the empty string rather than `undefined` is what lets `joinLines`
 * drop the branch entirely instead of leaving a blank line where a disabled
 * section used to be — blank-line drift is the most common way conditional
 * templates break byte-identical output.
 */
export function when(
  condition: boolean,
  text: Renderable,
  otherwise: Renderable = "",
): string {
  return stringify(condition ? text : otherwise);
}

/**
 * Joins parts with newlines, dropping blank ones. Nested arrays are flattened,
 * so a caller can pass the result of a `map` without spreading it.
 */
export function joinLines(...parts: readonly Renderable[]): string {
  return flatten(parts)
    .filter((part) => part.trim() !== "")
    .join("\n");
}

/**
 * Non-mutating sort by a derived key, with a pinned comparator.
 *
 * Every ordering that reaches a template must come from a declared sort rather
 * than from the order members happened to be written in (Principle I). Strings
 * compare by code unit, not by locale: `localeCompare` varies with ICU data, so
 * member order would become a function of the host.
 */
export function sortBy<T>(
  items: Iterable<T>,
  key: (item: T) => string | number,
): T[] {
  return [...items].toSorted((a, b) => compare(key(a), key(b)));
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringify(value: Renderable): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return joinLines(...(value as readonly Renderable[]));
  }
  return String(value);
}

function flatten(parts: readonly Renderable[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    if (part === undefined || part === null) {
      continue;
    }
    if (Array.isArray(part)) {
      lines.push(...flatten(part as readonly Renderable[]));
      continue;
    }
    lines.push(...normalizeNewlines(String(part)).split("\n"));
  }
  return lines;
}

/**
 * CRLF is normalised on the way in. A template literal carries whatever line
 * endings its source file has, so without this the same request would emit
 * different bytes depending on the checkout that built the generator.
 */
function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** The whitespace prefix of the final line written so far. */
function trailingIndentOf(text: string): string {
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  return /^[ \t]*/.exec(lastLine)?.[0] ?? "";
}

function reindent(value: string, prefix: string): string {
  if (prefix === "" || !value.includes("\n")) {
    return value;
  }
  return normalizeNewlines(value)
    .split("\n")
    .map((line, index) =>
      index === 0 || line.trim() === "" ? line : `${prefix}${line}`,
    )
    .join("\n");
}

function stripCommonIndent(text: string): string {
  const lines = text.split("\n");

  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
    lines.pop();
  }

  let common: number | undefined;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const width = (/^[ \t]*/.exec(line)?.[0] ?? "").length;
    common = common === undefined ? width : Math.min(common, width);
  }

  if (common === undefined || common === 0) {
    return lines.join("\n");
  }

  return lines
    .map((line) => (line.trim() === "" ? "" : line.slice(common)))
    .join("\n");
}
