/**
 * Turns what a template rendered into the bundle a caller receives.
 *
 * Assembly is the last place iteration order could reach the output, so nothing here preserves the
 * order files arrived in. Files are sorted by role and then by path, both by explicit comparison, and
 * the roles that survive are decided by `emitScope` (Principle I, FR-004, FR-017).
 */

import { siblingImports, stemOf } from "./imports.js";

import type { FileRole, RenderedFile } from "../patterns/types.js";

/**
 * Declared emission order. Types precede the machinery that uses them and tests come last, so a reader
 * scanning a response meets definitions before uses. This sequence is part of the output contract: a
 * later release that reorders it changes every bundle's file order and every content hash.
 */
export const ROLE_ORDER: readonly FileRole[] = [
  "types",
  "core",
  "binding",
  "adapter",
  "example",
  "test",
];

export type EmitScope = "full" | "core-only" | "binding-only";

/**
 * Which roles each scope keeps.
 *
 * `core-only` drops the per-type binding and its adapter but keeps tests and the example, because the
 * machinery is what the caller is adopting and it should arrive with both. `binding-only` keeps the
 * binding and its adapter alone: the caller already has the machinery, so re-emitting it would
 * overwrite a file they may have edited, and re-emitting its tests would duplicate a suite they are
 * already running (FR-017, FR-018).
 */
const SCOPE_ROLES: Readonly<Record<EmitScope, readonly FileRole[]>> = {
  full: ROLE_ORDER,
  "core-only": ["types", "core", "example", "test"],
  "binding-only": ["binding", "adapter"],
};

export interface File {
  readonly path: string;
  readonly contents: string;
  readonly role: FileRole;
}

export interface AssembleInput {
  readonly pattern: string;
  readonly files: readonly RenderedFile[];
  readonly emitScope: EmitScope;
  /**
   * Where a `binding-only` bundle's core already lives (FR-018).
   *
   * Needed because it may be relative — `./lib/repository-core.js` names a file in the caller's project,
   * and a relative specifier is otherwise indistinguishable from a sibling this bundle failed to include.
   * It is the one module a bundle is *meant* to import without carrying.
   */
  readonly coreModule?: string;
}

/**
 * A rendered file set that breaks any of these rules is a defect in the pattern module, not a caller
 * error, so every failure here throws rather than being reported as correctable.
 */
export function assembleBundle(input: AssembleInput): readonly File[] {
  const keep = new Set(SCOPE_ROLES[input.emitScope]);
  const kept: File[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    assertEmittablePath(input.pattern, file.path);

    if (seen.has(file.path)) {
      throw new AssemblyError(
        `pattern "${input.pattern}" rendered two files at "${file.path}"; ` +
          `one would silently replace the other`,
      );
    }
    seen.add(file.path);

    if (keep.has(file.role)) {
      kept.push({ path: file.path, contents: file.contents, role: file.role });
    }
  }

  if (kept.length === 0) {
    throw new AssemblyError(
      `pattern "${input.pattern}" rendered nothing for emitScope "${input.emitScope}"; ` +
        `an empty bundle is never a valid answer`,
    );
  }

  // Only where a caller has something to adopt. A binding-only bundle is a fragment fitted to
  // machinery they already have, and an example of it in isolation would not run (FR-004).
  if (keep.has("example") && !kept.some((file) => file.role === "example")) {
    throw new AssemblyError(
      `pattern "${input.pattern}" rendered no example file; every generative pattern owes a caller ` +
        `a usage example distinct from its tests`,
    );
  }

  assertSelfContained(input.pattern, input.emitScope, kept, input.coreModule);

  return kept.toSorted(byRoleThenPath);
}

/**
 * Every sibling a bundle imports has to be in the bundle.
 *
 * Verification cannot catch this, and that is the whole reason it exists here. Typechecking runs over the
 * *rendered* set on purpose — a `core-only` request is still proven against the suite that exercises it —
 * so a file importing a sibling that this scope drops compiles perfectly during verification and arrives
 * at the caller referring to a module they were never sent. That is how `core-only` came to emit an
 * example and a suite importing a binding it does not include: both halves were individually correct.
 *
 * A scope's job is to select whole subsets, not to cut files loose from their imports, so this is a
 * defect in the scope table or in the pattern rather than anything a caller did — hence a throw.
 *
 * Only relative specifiers are checked, and `coreModule` is exempt whichever form it takes. A bare
 * specifier names something the caller installs; `coreModule` names something they already have. Both are
 * meant to be absent, which is the difference between an external dependency and a missing file.
 */
function assertSelfContained(
  pattern: string,
  scope: EmitScope,
  kept: readonly File[],
  coreModule: string | undefined,
): void {
  const present = new Set(kept.map((file) => stemOf(file.path)));

  for (const file of kept) {
    for (const specifier of siblingImports(file.contents)) {
      if (specifier === coreModule) continue;
      if (present.has(stemOf(specifier))) continue;

      throw new AssemblyError(
        `pattern "${pattern}" at emitScope "${scope}" emits "${file.path}", which imports ` +
          `"${specifier}" — a file this scope does not emit. Either the scope must keep it or the ` +
          `pattern must not render that import at this scope.`,
      );
    }
  }
}


export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

/**
 * Paths are derived from validated inputs, never supplied (FR-033), so anything rejected here means a
 * template built a path from something it should not have.
 */
function assertEmittablePath(pattern: string, path: string): void {
  const refuse = (why: string): never => {
    throw new AssemblyError(`pattern "${pattern}" rendered an unemittable path "${path}": ${why}`);
  };

  if (path === "") refuse("empty");
  if (path.startsWith("/")) refuse("absolute");
  if (/^[A-Za-z]:/.test(path)) refuse("carries a drive letter");
  if (path.includes("\\")) refuse("uses backslashes, which are not path separators here");
  if (path.split("/").includes("..")) refuse("escapes the bundle with ..");
  if (path.split("/").includes(".")) refuse("contains a . segment");
  if (path.endsWith("/")) refuse("names a directory");
}

function byRoleThenPath(a: File, b: File): number {
  const left = ROLE_ORDER.indexOf(a.role);
  const right = ROLE_ORDER.indexOf(b.role);
  if (left !== right) return left - right;
  return compare(a.path, b.path);
}

/**
 * Code-unit comparison. `localeCompare` would order the same paths differently depending on the ICU
 * data the host's Node was built with, which is exactly the kind of ambient dependency Principle I
 * exists to exclude.
 */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
