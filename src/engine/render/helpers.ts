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
 *
 * A part is dropped only if the whole of it is blank. Blank lines *inside* a
 * part are kept, which is the difference between this and the version that
 * shipped first — that one flattened every part to lines and filtered them, so
 * a function body assembled here arrived as a wall of statements with each
 * paragraph break silently removed. Prettier does not put them back: it
 * preserves blank lines rather than inserting them. Leading and trailing blank
 * lines are still stripped per part, since those are an artefact of how a
 * template literal was written rather than something an author asked for.
 */
export function joinLines(...parts: readonly Renderable[]): string {
  return flatten(parts)
    .map((part) => part.replace(/^\n+/, "").replace(/\n+$/, ""))
    .filter((part) => part.trim() !== "")
    .join("\n");
}

/**
 * A blank line an author asked for, as opposed to a part that rendered to nothing.
 *
 * `codeLines` needs to tell the two apart, and an empty string cannot: a disabled section and a
 * paragraph break are both `""`. This is a value no template would produce by accident, so a blank
 * line appears in generated output only where one was written.
 */
export const BLANK = "\u0000";

/**
 * Joins parts with newlines, keeping the blank lines `BLANK` asks for.
 *
 * For a body assembled line by line, which `joinLines` cannot do: it drops every blank part, so a
 * function built out of conditional lines arrives as a wall of statements with each paragraph break
 * silently removed. Prettier does not put them back — it preserves blank lines rather than inserting
 * them, so whatever a template emits is what a caller reads.
 *
 * `joinLines`'s protection against blank-line drift is kept rather than traded away. A part that
 * renders to nothing is still dropped; only `BLANK` produces a gap, runs of them collapse to one, and
 * the leading and trailing ones go — so turning an option off cannot leave a stray blank behind
 * (Principle I).
 */
export function codeLines(...parts: readonly Renderable[]): string {
  const out: string[] = [];

  for (const part of flatten(parts)) {
    // A part that rendered to nothing leaves no trace. `BLANK` survives this, since NUL is not
    // whitespace, which is the whole reason it is the marker.
    if (part.trim() === "") {
      continue;
    }

    for (const line of part.split("\n")) {
      const blank = line === BLANK || line.trim() === "";

      if (blank && (out.length === 0 || out.at(-1) === "")) {
        continue;
      }

      out.push(blank ? "" : line);
    }
  }

  while (out.length > 0 && out.at(-1) === "") {
    out.pop();
  }

  return out.join("\n");
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
  const words = normalizeNewlines(text)
    .split(/\s+/)
    .filter((word) => word !== "");
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
 *
 * One rule for prose that interpolates a caller's identifier: never put `a` or
 * `an` in front of it. Which one is right depends on how the word is *said* —
 * "an Order", "a User", "an hour", "a union" — so any rule this code could
 * apply is wrong for some name a caller will supply, and "A Order's key" is the
 * sentence that makes a generated file read as machine-written. Name the type in
 * backticks instead: "The key type for `Order`" needs no article and reads as
 * documentation either way. The same reasoning as `names.ts`: where English is
 * inconsistent, do not guess.
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
export function docAt(
  columns: number,
  ...paragraphs: readonly Renderable[]
): string {
  const blocks = paragraphs
    .map((paragraph) => stringify(paragraph).trim())
    .filter((paragraph) => paragraph !== "");

  if (blocks.length === 0) {
    return "";
  }

  const pad = " ".repeat(columns);
  const width = Math.max(MIN_PROSE_WIDTH, PROSE_WIDTH - columns);
  const body: string[] = [];

  // Tracked across paragraphs, not within one, since an example long enough to
  // need a blank line in the middle is still one fenced block.
  let fenced = false;

  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      body.push(`${pad} *`);
    }
    // A paragraph already broken into lines is respected: an author who wrote a
    // list or an `@throws` tag meant those line breaks.
    for (const line of block.split("\n")) {
      if (line.trim().startsWith("```")) {
        fenced = !fenced;
        body.push(`${pad} * ${line.trim()}`);
        continue;
      }

      // Inside a fence, the layout *is* the content. Wrapping collapses runs of
      // whitespace, so a wrapped example loses every level of indentation and
      // demonstrates the opposite of what it was written to show. The format
      // step already declines to reflow a comment containing a fence
      // (`format/reflow.ts`); this is the same rule one stage earlier, and
      // without it a pattern could only include an example by hand-writing the
      // whole comment.
      if (fenced) {
        body.push(
          line.trim() === "" ? `${pad} *` : `${pad} * ${line.trimEnd()}`,
        );
        continue;
      }

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
 * A declaration with its doc comment attached.
 *
 * The blank line matters and is easy to get wrong. `sections` separates its parts with one, so a
 * template that passes `doc(...)` and the declaration as two sections emits a comment with a gap under
 * it — which is no longer a doc comment at all. It documents nothing, editors do not show it on hover,
 * and the only symptom is prose that has quietly stopped being attached to anything. Every generated
 * comment in this codebase is load-bearing, so that failure is worth a named helper rather than a
 * convention each pattern author has to remember.
 */
export function documented(
  paragraphs: readonly Renderable[],
  code: Renderable,
): string {
  return joinLines(doc(...paragraphs), code);
}

/**
 * `documented`, for a declaration sitting `columns` deep. The code is indented too, since a comment at
 * one depth above a member at another is the same detachment in a different shape.
 */
export function documentedAt(
  columns: number,
  paragraphs: readonly Renderable[],
  code: Renderable,
): string {
  return joinLines(
    docAt(columns, ...paragraphs),
    indent(stringify(code), columns),
  );
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

/**
 * Each part as one string, with nested arrays inlined.
 *
 * Parts are kept whole rather than split into lines, which is what lets
 * `joinLines` tell a blank part from a blank line within one.
 */
function flatten(parts: readonly Renderable[]): string[] {
  const flat: string[] = [];
  for (const part of parts) {
    if (part === undefined || part === null) {
      continue;
    }
    if (Array.isArray(part)) {
      flat.push(...flatten(part as readonly Renderable[]));
      continue;
    }
    flat.push(normalizeNewlines(String(part)));
  }
  return flat;
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
