/**
 * What changed between two bundles, at the grain of a top-level declaration.
 *
 * The coarse question — did this option touch a file it has no business touching — is answerable by
 * comparing file contents, and the harness does that first. But it is a weak question. A pattern's core
 * is one file, so an option that legitimately changes anything in the core is licensed to change
 * everything in it, and "changing `jitter` rewrote the whole retry loop" passes.
 *
 * So the unit here is the declaration. Two bundles are reduced to a map from declaration to its text,
 * and the difference is the set of declarations the option actually moved. That set is recorded and
 * reviewed, which is what makes a widening visible: a reflowed function unrelated to the option appears
 * in the set, and the recorded expectation no longer matches (SC-005).
 *
 * Declarations are located with the parser. A regex over `export function ...` would work on today's
 * three patterns and break on the first one that emits an overload, a nested namespace, or a
 * declaration inside a template literal.
 */

import ts from "typescript-stable";

import { withoutHeader } from "../../src/engine/provenance/header.js";

import type { File } from "../../src/engine/generate/assemble.js";

/** A bundle reduced to what the comparison needs: path, role, and the declarations within. */
interface Reduced {
  readonly path: string;
  readonly role: string;
  readonly declarations: ReadonlyMap<string, string>;
}

export interface Delta {
  /** Paths present in one bundle and not the other. Empty unless the option changes which files exist. */
  readonly filesAdded: readonly string[];
  readonly filesRemoved: readonly string[];
  /** Roles whose same-path contents differ at all. The coarse claim `affects` is checked against. */
  readonly rolesChanged: readonly string[];
  /**
   * Per file, the declarations that appeared, vanished, or changed text. The fine claim, recorded rather
   * than declared, since the names depend on the identifiers a caller asks for.
   */
  readonly declarations: readonly string[];
}

export function delta(before: readonly File[], after: readonly File[]): Delta {
  const left = new Map(reduce(before).map((file) => [file.path, file]));
  const right = new Map(reduce(after).map((file) => [file.path, file]));

  const filesAdded = [...right.keys()].filter((path) => !left.has(path)).toSorted(compare);
  const filesRemoved = [...left.keys()].filter((path) => !right.has(path)).toSorted(compare);

  const rolesChanged = new Set<string>();
  const declarations: string[] = [];

  const shared = [...left.keys()].filter((candidate) => right.has(candidate)).toSorted(compare);

  for (const path of shared) {
    const from = left.get(path);
    const to = right.get(path);
    if (from === undefined || to === undefined) continue;

    const moved = movedDeclarations(from.declarations, to.declarations);
    if (moved.length > 0) {
      rolesChanged.add(from.role);
      declarations.push(...moved.map((entry) => `${path}: ${entry}`));
    }
  }

  // A file that exists on one side only is a change to that role as well as to the file set. Otherwise
  // an option that replaced one core file with another would report `files` and nothing else, and a
  // pattern could evade the role claim by renaming.
  for (const path of [...filesAdded, ...filesRemoved]) {
    const file = right.get(path) ?? left.get(path);
    if (file !== undefined) rolesChanged.add(file.role);
  }

  return {
    filesAdded,
    filesRemoved,
    rolesChanged: [...rolesChanged].toSorted(compare),
    declarations,
  };
}

/** Whether anything at all differs. Used to distinguish "no effect" from "an effect within bounds". */
export function isEmpty(value: Delta): boolean {
  return (
    value.filesAdded.length === 0 &&
    value.filesRemoved.length === 0 &&
    value.rolesChanged.length === 0 &&
    value.declarations.length === 0
  );
}

function reduce(files: readonly File[]): readonly Reduced[] {
  return files.map((file) => ({
    path: file.path,
    role: file.role,
    // The provenance header carries the options hash, so *every* option changes it. Left in, the harness
    // would report every option as affecting every file and would have nothing to say about the code.
    declarations: declarationsOf(withoutHeader(file.contents)),
  }));
}

/**
 * Top-level declarations, keyed by a label stable across bodies.
 *
 * The whole statement text is the value, including its leading comments, because a comment is output
 * too: a template that rewrote a doc comment when an unrelated option changed is churn a reader has to
 * read past, and it should show up here.
 */
function declarationsOf(source: string): ReadonlyMap<string, string> {
  const file = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, string>();

  file.statements.forEach((statement, index) => {
    const key = labelFor(statement, index);
    // Suffixed on collision rather than overwritten. Two same-named statements are legitimate — an
    // overload set, or a declaration merged with an interface — and dropping one would hide a change.
    let label = key;
    let ordinal = 2;
    while (declarations.has(label)) {
      label = `${key}#${String(ordinal)}`;
      ordinal += 1;
    }
    declarations.set(label, statement.getFullText(file).trim());
  });

  return declarations;
}

/**
 * A name for a statement that does not shift when the statements around it do.
 *
 * Position is deliberately not part of it: an option that inserts a function would otherwise renumber
 * everything below and report the whole file as changed. Only a statement with no name of its own falls
 * back to its index.
 */
function labelFor(statement: ts.Statement, index: number): string {
  if (ts.isImportDeclaration(statement)) {
    return `import ${statement.moduleSpecifier.getText()}`;
  }

  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return `${kindOf(statement)} ${statement.name.getText()}`;
  }

  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map((declaration) => declaration.name.getText())
      .join(", ");
    return `const ${names}`;
  }

  // A test file's top level is mostly `describe("…", …)`, which has no declared name but does have a
  // title. Without this they fall back to their index, and inserting one suite renumbers every suite
  // below it — the report then claims an option moved code it never touched, which is the same
  // unreadable diff this harness exists to prevent, one level up.
  const called = callWithTitle(statement);
  if (called !== undefined) {
    return called;
  }

  return `statement ${String(index)}`;
}

/** `describe("Order retry")` for a top-level call whose first argument is a literal title. */
function callWithTitle(statement: ts.Statement): string | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;

  const call = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;

  if (!ts.isCallExpression(call)) return undefined;

  const [first] = call.arguments;
  if (first === undefined || !ts.isStringLiteralLike(first)) return undefined;

  return `${call.expression.getText()}(${JSON.stringify(first.text)})`;
}

function kindOf(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement)) return "function";
  if (ts.isClassDeclaration(statement)) return "class";
  if (ts.isInterfaceDeclaration(statement)) return "interface";
  if (ts.isTypeAliasDeclaration(statement)) return "type";
  if (ts.isEnumDeclaration(statement)) return "enum";
  return "namespace";
}

function movedDeclarations(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly string[] {
  const moved: string[] = [];

  for (const [label, text] of [...before].toSorted(([a], [b]) => compare(a, b))) {
    const now = after.get(label);
    if (now === undefined) {
      moved.push(`- ${label}`);
    } else if (now !== text) {
      moved.push(`~ ${label}`);
    }
  }

  for (const [label] of [...after].toSorted(([a], [b]) => compare(a, b))) {
    if (!before.has(label)) moved.push(`+ ${label}`);
  }

  return moved;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
