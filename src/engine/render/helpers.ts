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
 * Joins parts with exactly one blank line between them, dropping blank parts.
 *
 * `joinLines` cannot serve here: it drops the blank separators along with
 * everything else blank, so a template assembled from sections came out as an
 * unreadable wall of declarations. Prettier does not help — it preserves blank
 * lines rather than inserting them, so whatever a template emits is what ships.
 *
 * Dropping blank parts is what makes conditional sections safe. A section that
 * renders to nothing leaves no trace, so turning an option off cannot leave a
 * double blank line behind, which is the usual way conditional templates lose
 * byte-identical output.
 */
export function sections(...parts: readonly Renderable[]): string {
  return parts
    .map((part) => normalizeNewlines(stringify(part)).trim())
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * The prose width for a generated doc comment: 80, less the three columns
 * `" * "` occupies.
 *
 * Fixed rather than derived from the caller's `printWidth`, because Prettier
 * reflows code and never comments — so a template that does not wrap its own
 * prose emits a 200-column line that no formatter will ever fix. Narrower than
 * a wide project would choose, which is the harmless direction to be wrong in.
 */
const PROSE_WIDTH = 77;

/**
 * A floor, so that a deeply nested comment degrades to narrow rather than to one
 * word per line.
 */
const MIN_PROSE_WIDTH = 40;

/**
 * Greedy word wrap. Words longer than `width` are left alone rather than
 * broken, since the only things that long are identifiers and URLs, and
 * hyphenating either makes it wrong.
 */
export function wrapProse(text: string, width = PROSE_WIDTH): string[] {
  const words = normalizeNewlines(text).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }

  lines.push(line);
  return lines;
}

/**
 * A JSDoc block from paragraphs of prose, each wrapped to `PROSE_WIDTH`.
 *
 * Templates assemble doc comments from conditional pieces, and doing that by
 * hand means every author re-derives the ` * ` prefixes and the blank-line
 * conventions. Blank paragraphs are dropped, so a paragraph that only applies
 * under one option can be interpolated unconditionally.
 *
 * The wrapping here is a convenience, not the guarantee: the format step
 * reflows every generated comment to the caller's `printWidth`, which is the
 * only place that knows what column a composed fragment finally lands at
 * (`format/reflow.ts`). What this buys is a template whose own source reads
 * like the file it produces.
 */
export function doc(...paragraphs: readonly Renderable[]): string {
  return docAt(0, ...paragraphs);
}

/**
 * `doc`, for a comment that will sit `columns` deep — on an interface member,
 * say, or a class field.
 *
 * The indentation has to be applied here rather than by wrapping `doc` in
 * `indent`, because the prefix consumes width that the wrapping must know
 * about. Indenting afterwards pushed every line two columns past the limit,
 * which is exactly the kind of miss no one notices in a template literal and
 * everyone notices in the generated file.
 */
export function docAt(columns: number, ...paragraphs: readonly Renderable[]): string {
  const blocks = paragraphs
    .map((paragraph) => stringify(paragraph).trim())
    .filter((paragraph) => paragraph !== "");

  if (blocks.length === 0) {
    return "";
  }

  const pad = " ".repeat(columns);
  const width = Math.max(MIN_PROSE_WIDTH, PROSE_WIDTH - columns);
  const body: string[] = [];

  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      body.push(`${pad} *`);
    }
    // A paragraph already broken into lines is respected: an author who wrote a
    // list or an `@throws` tag meant those line breaks.
    for (const line of block.split("\n")) {
      const wrapped = wrapProse(line, width);
      body.push(
        ...(wrapped.length === 0
          ? [`${pad} *`]
          : wrapped.map((text) => `${pad} * ${text}`)),
      );
    }
  }

  return [`${pad}/**`, ...body, `${pad} */`].join("\n");
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
