/**
 * Import specifiers: how a bundle's files refer to each other, and how a binding refers to machinery
 * the caller already has (FR-018).
 *
 * Two jobs that look separate and are not. Every file in a bundle imports its siblings in the caller's
 * extension convention — `./order-result.js`, `./order-result`, or `./order-result.ts` — and a
 * `binding-only` bundle contains no sibling to import: the machinery is already in the caller's
 * repository, at a path only they know. So the same specifier that points at a sibling in a full bundle
 * has to point at `coreModule` in a binding-only one.
 *
 * That is done here, after rendering, rather than by giving templates a specifier to interpolate. The
 * reason is that a template which forgot to use such a specifier would emit a binding importing a file
 * the caller does not have, and nothing would notice: it typechecks, because verification synthesises
 * the core (T104), and it fails only in the caller's repository. Rewriting after the fact means a
 * template cannot forget — it always imports its siblings, and there is one place that knows a sibling
 * is not going to be there.
 *
 * Specifiers are located with the parser and matched exactly. A textual substitution would also rewrite
 * the same string inside a template literal or an example in a doc comment, which is how a "fix" to an
 * import silently corrupts prose.
 */

import ts from "typescript-stable";

import { InvalidOptionValueError } from "../errors.js";

import type { Conventions } from "../options/conventions.js";
import type { RenderedFile } from "../patterns/types.js";

/** The specifier a sibling file uses to import `stem`, in the caller's convention (FR-024, FR-030). */
export function siblingSpecifier(conventions: Conventions, stem: string): string {
  switch (conventions.importExtensions) {
    case "js":
      return `./${stem}.js`;
    case "ts":
      return `./${stem}.ts`;
    case "none":
      return `./${stem}`;
  }
}

export interface ImportNames {
  /** Imported for their runtime value. */
  readonly values?: readonly string[];
  /** Imported for their type only, and therefore subject to `typeImports` (FR-024). */
  readonly types?: readonly string[];
}

/**
 * One import statement per specifier, in the caller's `typeImports` convention.
 *
 * Every pattern needs this and each was writing it out again, with a `separateTypes` ternary and a
 * second `when(!separateTypes, …)` line beside it — six chances per file to emit an `import type` to a
 * project that spells it inline. Composing the statement from names instead means a template says what it
 * needs and not how the caller writes it.
 *
 * Names are sorted, since a template listing them in the order it happens to think of them would make
 * the emitted line depend on an author's typing rather than on the request (Principle I).
 */
export function importsFrom(
  conventions: Conventions,
  specifier: string,
  names: ImportNames,
): string {
  const values = [...(names.values ?? [])].toSorted();
  const types = [...(names.types ?? [])].toSorted();

  if (values.length === 0 && types.length === 0) return "";

  if (types.length === 0) {
    return `import { ${values.join(", ")} } from "${specifier}";`;
  }

  if (conventions.typeImports === "separate") {
    const typeOnly = `import type { ${types.join(", ")} } from "${specifier}";`;
    return values.length === 0
      ? typeOnly
      : `import { ${values.join(", ")} } from "${specifier}";\n${typeOnly}`;
  }

  const inline = [...values, ...types.map((name) => `type ${name}`)];
  return `import { ${inline.join(", ")} } from "${specifier}";`;
}

/**
 * The file stem of a rendered path: `nested/order-result.ts` is `order-result`.
 *
 * `.js` is stripped as well as `.ts`, which is what lets a path and a specifier be compared: under the
 * default conventions the file is `order-result.ts` and the import that reaches it is
 * `./order-result.js`, so the stem is the only form in which the two are the same thing.
 */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * A caller-supplied module specifier, checked before it reaches generated code.
 *
 * `coreModule` is the one caller-supplied value that is *written into* output rather than compared
 * against a value space, so it is the one place a caller could put arbitrary text in a file we claim to
 * have generated. It is constrained to what a module specifier can be: a relative path or a package
 * name, no quotes, no newlines, nothing that could close the import and continue with something else
 * (FR-032, FR-033).
 */
const SPECIFIER = /^(?:\.{1,2}\/[\w.\-/]+|@[\w.-]+\/[\w.\-/]+|[\w.-]+(?:\/[\w.\-/]+)?)$/;

export function checkCoreModule(value: string): string {
  const trimmed = value.trim();

  if (
    trimmed === "" ||
    trimmed.length > 200 ||
    !SPECIFIER.test(trimmed) ||
    trimmed.split("/").includes("..")
  ) {
    throw new InvalidOptionValueError("coreModule", value, [
      'a relative specifier such as "./lib/repository-core.js"',
      'a package specifier such as "@acme/data/repository-core.js"',
    ]);
  }

  return trimmed;
}

export interface RewriteInput {
  readonly files: readonly RenderedFile[];
  /** Specifiers that currently resolve to a file this bundle will not emit. */
  readonly from: readonly string[];
  readonly to: string;
}

/**
 * Repoints every import of `from` at `to`, in every file.
 *
 * Applied to all files rather than only the ones that survive scoping, because the same set is what
 * verification typechecks: a test that still imported the sibling would be checked against a module the
 * emitted binding no longer refers to.
 */
export function repointImports(input: RewriteInput): readonly RenderedFile[] {
  const targets = new Set(input.from);
  if (targets.size === 0) {
    return input.files;
  }

  return input.files.map((file) => ({
    ...file,
    contents: rewrite(file.contents, targets, input.to),
  }));
}

/**
 * The specifiers in `contents` that point at a sibling file, as written.
 *
 * Used to check that a scoped bundle does not import something it no longer carries. Bare specifiers
 * are excluded: they name packages, which are the caller's business and not ours to resolve.
 */
export function siblingImports(contents: string): readonly string[] {
  return specifiers(contents)
    .map((node) => node.text)
    .filter((text) => text.startsWith("./") || text.startsWith("../"));
}

function rewrite(contents: string, from: ReadonlySet<string>, to: string): string {
  const matches = specifiers(contents).filter((node) => from.has(node.text));
  if (matches.length === 0) {
    return contents;
  }

  let result = contents;

  // Last to first, so each replacement leaves the offsets of the ones before it intact.
  for (const node of matches.toReversed()) {
    // The quote style is taken from the node rather than chosen, since the file has already been
    // written in one style and Prettier has not run yet.
    const quote = contents.charAt(node.getStart()) === "'" ? "'" : '"';
    result =
      result.slice(0, node.getStart()) + quote + to + quote + result.slice(node.getEnd());
  }

  return result;
}

/**
 * Every module specifier in a file, as parsed nodes.
 *
 * Covers `import`, `export … from`, and `import type`, which is the whole static surface a generated
 * module uses. `import()` expressions are deliberately not covered: nothing generated here uses one,
 * and rewriting a dynamic specifier means rewriting an arbitrary expression.
 */
function specifiers(contents: string): readonly ts.StringLiteralLike[] {
  const file = ts.createSourceFile("generated.ts", contents, ts.ScriptTarget.Latest, true);
  const found: ts.StringLiteralLike[] = [];

  for (const statement of file.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;

    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
      found.push(specifier);
    }
  }

  return found;
}
