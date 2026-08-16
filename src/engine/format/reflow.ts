/**
 * Wrapping generated comments to the width the code is formatted to.
 *
 * Prettier reflows code and deliberately never reflows comments, so a comment is exactly as wide as
 * whoever wrote it made it. For generated code that is a defect rather than a preference: a pattern
 * template composes fragments, and the column a comment finally lands at is not knowable where the
 * comment is written, so a template cannot wrap its own prose correctly no matter how careful the
 * author is. Measured on the first three patterns, prose written at this repository's own width
 * arrived in files formatted at 80 columns as lines of up to 172.
 *
 * It is also a property a caller can ask for. `printWidth` is a configurable formatting option, and a
 * caller who sets 60 currently gets 60-column code carrying 80-column comments. Doing this in the
 * format step means one answer for every pattern, present and future, at whatever width was asked
 * for.
 *
 * The hazard is mistaking something for a comment. `// ` inside a template literal, `/*` inside a
 * regex, and `//` inside a URL are all common in generated code, and rewriting any of them corrupts
 * the output — which is why this locates comments with the parser rather than by scanning text. A bare
 * scanner is not enough either: without a parser driving it, a template literal with a substitution is
 * mis-lexed, and it reports the contents of one as a comment.
 *
 * Only comments with a line over the limit are touched. Everything else is returned byte-identical, so
 * this cannot become a source of diff churn for output it has nothing to say about (SC-005).
 */

import ts from "typescript-stable";

import { wrapProse } from "../render/helpers.js";

/** Prettier's default, which is the width unless the caller chose another. */
export const DEFAULT_PRINT_WIDTH = 80;

interface OwnLineComment {
  readonly kind: ts.CommentKind;
  readonly pos: number;
  readonly end: number;
  /** Columns of spaces before the opening token. */
  readonly indent: number;
}

export function reflowComments(source: string, printWidth = DEFAULT_PRINT_WIDTH): string {
  const comments = ownLineComments(source);
  if (comments.length === 0) {
    return source;
  }

  const runs = groupLineComments(source, comments);
  let result = source;

  // Applied last-first so that every replacement's offsets are still the ones measured above.
  for (const run of runs.toReversed()) {
    const replacement = rewrite(source, run, printWidth);
    if (replacement === undefined) {
      continue;
    }
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }
    result = result.slice(0, first.pos) + replacement + result.slice(last.end);
  }

  return result;
}

/**
 * The comments that sit alone on their lines, in source order.
 *
 * A trailing comment — one following code on the same line — is left out. Wrapping it would move its
 * continuation below the code it annotates, which reads as a comment about the next line instead.
 *
 * Tab-indented comments are left out too. Their width depends on `tabWidth`, and a wrong guess there
 * produces exactly the overflow this is meant to remove.
 */
function ownLineComments(source: string): readonly OwnLineComment[] {
  const file = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, ts.CommentRange>();

  const collect = (position: number): void => {
    for (const range of ts.getLeadingCommentRanges(source, position) ?? []) {
      ranges.set(range.pos, range);
    }
    for (const range of ts.getTrailingCommentRanges(source, position) ?? []) {
      ranges.set(range.pos, range);
    }
  };

  const walk = (node: ts.Node): void => {
    collect(node.getFullStart());
    collect(node.getEnd());
    // A comment alone between a pair of braces belongs to no node: there is no statement for it to
    // lead and no code on its line for it to trail, so neither position above reaches it. Scanning
    // from just inside the brace does. An empty `catch` is where these actually occur, and one
    // arrived over the limit and unwrapped before this was here.
    if (source.charAt(node.getStart()) === "{") {
      collect(node.getStart() + 1);
    }
    node.forEachChild(walk);
  };

  walk(file);
  collect(file.getEnd());

  const own: OwnLineComment[] = [];

  for (const range of [...ranges.values()].toSorted((a, b) => a.pos - b.pos)) {
    const lineStart = source.lastIndexOf("\n", range.pos - 1) + 1;
    const before = source.slice(lineStart, range.pos);
    if (!/^ *$/.test(before)) {
      continue;
    }
    own.push({ kind: range.kind, pos: range.pos, end: range.end, indent: before.length });
  }

  return own;
}

/**
 * Consecutive `//` lines at one indent, treated as a single paragraph.
 *
 * Without this, a two-line note wrapped line by line stays two lines — the first still over the limit,
 * the second still short. The unit that needs rewrapping is the run, not the line.
 */
function groupLineComments(
  source: string,
  comments: readonly OwnLineComment[],
): readonly (readonly OwnLineComment[])[] {
  const runs: OwnLineComment[][] = [];

  for (const comment of comments) {
    if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) {
      runs.push([comment]);
      continue;
    }

    const previous = runs[runs.length - 1];
    const last = previous?.[previous.length - 1];

    const adjacent =
      last !== undefined &&
      last.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      last.indent === comment.indent &&
      // Nothing but the newline between them, so no code slipped in.
      /^\r?\n *$/.test(source.slice(last.end, comment.pos));

    if (adjacent && previous !== undefined) {
      previous.push(comment);
      continue;
    }

    runs.push([comment]);
  }

  return runs;
}

/** The replacement text for one run, or `undefined` when it already fits. */
function rewrite(
  source: string,
  run: readonly OwnLineComment[],
  printWidth: number,
): string | undefined {
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }

  const text = source.slice(first.pos, last.end);
  const { indent } = first;
  const overflows = text
    .split("\n")
    .some((line, index) => (index === 0 ? indent + line.length : line.length) > printWidth);

  if (!overflows) {
    return undefined;
  }

  // A fenced example is laid out on purpose, and rewrapping it destroys the thing it demonstrates.
  if (text.includes("```")) {
    return undefined;
  }

  const paragraphs = extractParagraphs(text, first.kind);
  if (paragraphs.length === 0) {
    return undefined;
  }

  return first.kind === ts.SyntaxKind.SingleLineCommentTrivia
    ? renderLineComment(paragraphs, indent, printWidth)
    : renderBlockComment(paragraphs, indent, printWidth);
}

/**
 * A comment's prose, split into paragraphs.
 *
 * A blank line is a paragraph break, and so is a line opening with `@` or a list marker: those breaks
 * were the author's decision, and joining them would turn a tag list into a sentence.
 */
function extractParagraphs(text: string, kind: ts.CommentKind): readonly string[] {
  const lines =
    kind === ts.SyntaxKind.SingleLineCommentTrivia
      ? text.split("\n").map((line) => line.trim().replace(/^\/\/ ?/, ""))
      : blockBody(text);

  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^(?:@|[-*] |\d+\. )/.test(line.trim()) && current.length > 0) {
      flush();
    }
    current.push(line.trim());
  }

  flush();
  return paragraphs;
}

/** The inside of a `/* ... *\/` comment, with the leading `*` of each line removed. */
function blockBody(text: string): readonly string[] {
  const inner = text
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n");

  return inner.map((line) => line.trim().replace(/^\* ?/, ""));
}

function renderLineComment(
  paragraphs: readonly string[],
  indent: number,
  printWidth: number,
): string {
  const pad = " ".repeat(indent);
  const width = available(printWidth, indent, "// ".length);
  const lines: string[] = [];

  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) {
      lines.push(`${pad}//`);
    }
    for (const line of wrapProse(paragraph, width)) {
      lines.push(`${pad}// ${line}`);
    }
  }

  return lines.join("\n").slice(indent);
}

function renderBlockComment(
  paragraphs: readonly string[],
  indent: number,
  printWidth: number,
): string {
  const pad = " ".repeat(indent);
  const width = available(printWidth, indent, " * ".length);

  // A one-liner is kept a one-liner when the prose fits, since expanding a short comment to three
  // lines is a worse outcome than the overflow this is fixing.
  const single = paragraphs[0];
  if (paragraphs.length === 1 && single !== undefined) {
    const oneLine = `/** ${single} */`;
    if (indent + oneLine.length <= printWidth) {
      return oneLine;
    }
  }

  // Every line carries the indent, and the first one's is sliced off at the end: the replacement
  // begins after the indentation that is already in the source.
  const lines: string[] = [`${pad}/**`];

  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) {
      lines.push(`${pad} *`);
    }
    for (const line of wrapProse(paragraph, width)) {
      lines.push(`${pad} * ${line}`);
    }
  }

  lines.push(`${pad} */`);
  return lines.join("\n").slice(indent);
}

/**
 * The prose width left after the indent and the comment marker.
 *
 * Floored, so that a deeply nested comment under a narrow `printWidth` degrades to a narrow column
 * rather than to one word per line.
 */
function available(printWidth: number, indent: number, marker: number): number {
  return Math.max(24, printWidth - indent - marker);
}
