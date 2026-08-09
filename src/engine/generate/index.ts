/**
 * The pipeline: resolve, render, format, verify, assemble.
 *
 * The order is not arbitrary. Formatting happens *before* verification so that what typechecks is the
 * bytes the caller receives, rather than a pre-formatted draft that Prettier then rewrites. And
 * assembly happens last, so ordering and scope filtering apply to files that have already been proven
 * to compile together — filtering first would let a `core-only` bundle be verified without the binding
 * that exercises it.
 *
 * Nothing here reads a clock, the environment, or the filesystem beyond loading the catalog and name
 * table, both of which happen once and are cached for the process (Principle I).
 */

import { loadCatalog } from "../catalog/load.js";
import type { Catalog } from "../catalog/load.js";
import { nearestNames } from "../catalog/nearest.js";
import type { GenerativePattern } from "../catalog/schema.js";
import { UnknownPatternError, InvalidOptionValueError, VerificationError } from "../errors.js";
import { formatSource, formatterVersion } from "../format/prettier.js";
import { deriveNames, loadNameTable } from "../options/names.js";
import type { NameTable, NameTransform } from "../options/names.js";
import { resolveOptions } from "../options/resolve.js";
import type { ResolvedRequest } from "../options/resolve.js";
import { circuitBreakerPattern } from "../patterns/circuit-breaker/index.js";
import { resultPattern } from "../patterns/result/index.js";
import { retryPattern } from "../patterns/retry/index.js";
import type { PatternModule, RenderedFile } from "../patterns/types.js";
import { createVerifier, compilerOptionsFor } from "../verify/index.js";
import type { Verifier } from "../verify/index.js";
import { buildVerificationRecord } from "../verify/record.js";
import type { VerificationRecord } from "../verify/record.js";
import { runGeneratedTests } from "../verify/run-tests.js";
import { platformTypesFor } from "../verify/platform-types.js";
import { bareImports, shimTypesFor } from "../verify/test-shims.js";
import { assembleBundle } from "./assemble.js";
import type { EmitScope, File } from "./assemble.js";

export interface GenerateRequest {
  readonly pattern: string;
  readonly variant?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly identifiers?: Readonly<Record<string, string>>;
  readonly conventions?: unknown;
}

export interface Bundle {
  readonly kind: "bundle";
  readonly pattern: string;
  readonly resolvedOptions: ResolvedRequest["options"];
  readonly resolvedConventions: ResolvedRequest["conventions"];
  readonly files: readonly File[];
  readonly verification: VerificationRecord;
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly nextSteps: readonly string[];
}

export type GenerateResult = Bundle;

/** Registered pattern modules, keyed by the catalog name each implements. */
const MODULES: readonly PatternModule[] = [circuitBreakerPattern, resultPattern, retryPattern];

export async function generate(request: GenerateRequest): Promise<GenerateResult> {
  const [catalog, names] = await Promise.all([catalogOnce(), nameTableOnce()]);
  const pattern = generativeEntry(catalog, request.pattern);
  const module = moduleFor(pattern.name);

  const resolved = resolveOptions(pattern, {
    ...(request.options === undefined ? {} : { options: request.options }),
    ...(request.identifiers === undefined ? {} : { identifiers: request.identifiers }),
    ...(request.conventions === undefined ? {} : { conventions: request.conventions }),
    ...(request.variant === undefined ? {} : { variant: request.variant }),
  });

  assertExecutableTests(resolved);

  const rendered = module.render({
    options: resolved.options,
    conventions: resolved.conventions,
    identifiers: resolved.identifiers,
    names: derivedNames(resolved.identifiers, names),
    variant: resolved.variant,
  });

  const formatted = await Promise.all(
    rendered.map(async (file) => ({
      ...file,
      contents: await formatSource(file.contents, resolved.conventions.prettierConfig),
    })),
  );

  const verification = await verify(formatted, resolved);

  const files = assembleBundle({
    pattern: pattern.name,
    files: formatted,
    emitScope: emitScopeOf(resolved),
  });

  return {
    kind: "bundle",
    pattern: pattern.name,
    resolvedOptions: resolved.options,
    resolvedConventions: resolved.conventions,
    files,
    verification: buildVerificationRecord({
      files,
      compilerVersion: verification.compilerVersion,
      formatterVersion: formatterVersion(),
      compilerOptions: compilerOptionsFor(resolved.conventions),
      diagnostics: [],
      testOutcome: files.some((file) => file.role === "test") ? "passed" : "skipped",
    }),
    notes: [],
    warnings: [],
    nextSteps: [],
  };
}

/**
 * Verification runs over the rendered set rather than the assembled one: a `core-only` request still
 * has to be proven correct together with the tests that exercise it, even though those are not all
 * returned.
 */
async function verify(
  files: readonly RenderedFile[],
  resolved: ResolvedRequest,
): Promise<{ readonly compilerVersion: string }> {
  const verifier = verifierOnce();

  // Declarations for the caller's test runner, present for the compiler and absent from the bundle.
  const imported = new Set<string>();
  for (const file of files) {
    for (const specifier of bareImports(file.contents)) imported.add(specifier);
  }
  // Host facilities — timers, AbortSignal — are declared unconditionally rather than per import, since
  // they are globals a bundle uses without importing anything.
  const declarations = [
    ...shimTypesFor([...imported]),
    ...platformTypesFor(resolved.conventions),
  ].map(([path, contents]) => ({ path, contents }));

  const outcome = await verifier.check(
    [
      ...files.map((file) => ({ path: file.path, contents: file.contents })),
      ...declarations,
    ],
    resolved.conventions,
  );

  if (outcome.diagnostics.length > 0) {
    throw new VerificationError(
      "typecheck",
      hashOf(resolved),
      outcome.diagnostics.map((d) => `${d.path ?? "?"}: TS${String(d.code)} ${d.text}`),
    );
  }

  const testPaths = files.filter((file) => file.role === "test").map((file) => file.path);
  const entryPoints = testPaths.filter((path) => path.endsWith(".test.ts"));

  if (entryPoints.length > 0) {
    const run = await runGeneratedTests({
      files: files.map((file) => ({ path: file.path, contents: file.contents })),
      testPaths: entryPoints,
    });

    if (run.outcome !== "passed") {
      throw new VerificationError("tests", hashOf(resolved), [run.detail ?? run.outcome]);
    }
  }

  return { compilerVersion: outcome.compilerVersion };
}

/**
 * Jest suites cannot be executed in the verification sandbox yet — it has no node_modules, and unlike
 * Vitest's import surface, Jest's globals cannot be supplied by a resolvable package. Emitting an
 * unexecuted suite would break Principle III, and emitting a Vitest suite for a Jest caller would
 * break Principle IX, so the combination is refused with the two conventions that do work. Tracked as
 * a task rather than left as a silent gap.
 */
function assertExecutableTests(resolved: ResolvedRequest): void {
  if (resolved.conventions.testFramework === "jest" && resolved.options.includeTests !== false) {
    throw new InvalidOptionValueError("conventions.testFramework", "jest", [
      "vitest",
      "node-test",
      "none",
    ]);
  }
}

function emitScopeOf(resolved: ResolvedRequest): EmitScope {
  const scope = resolved.options.emitScope;
  return scope === "core-only" || scope === "binding-only" ? scope : "full";
}

function derivedNames(
  identifiers: Readonly<Record<string, string>>,
  table: NameTable,
): Readonly<Record<string, NameTransform>> {
  const derived: Record<string, NameTransform> = {};

  // Sorted, so a failure is reported for the same identifier every time.
  for (const field of Object.keys(identifiers).toSorted()) {
    const result = deriveNames(identifiers[field] ?? "", table);
    if (result.ok) {
      derived[field] = result.names;
    }
  }

  return derived;
}

function generativeEntry(catalog: Catalog, name: string): GenerativePattern {
  const entry = catalog.patterns.find((candidate) => candidate.name === name);

  if (entry === undefined) {
    throw new UnknownPatternError(name, nearest(catalog, name));
  }

  if (entry.kind !== "generative") {
    // Advisory entries are answered by a different path; reaching here means a caller asked to
    // generate from one, which is not a thing that can succeed.
    throw new UnknownPatternError(name, nearest(catalog, name));
  }

  return entry;
}

/** Names closest to the request, so a typo costs one retry rather than a round trip (SC-007). */
function nearest(catalog: Catalog, name: string): readonly string[] {
  return nearestNames(catalog.patterns, name);
}

function moduleFor(name: string): PatternModule {
  const module = MODULES.find((candidate) => candidate.name === name);

  if (module === undefined) {
    // The catalog advertises a pattern with no implementation behind it. That is our defect, and it
    // must not be reported as though the caller asked for something invalid.
    throw new Error(
      `catalog advertises pattern "${name}" but no module implements it; ` +
        `the catalog entry and src/engine/patterns/ have diverged`,
    );
  }

  return module;
}

function hashOf(resolved: ResolvedRequest): string {
  return `${resolved.pattern}:${String(Object.keys(resolved.options).length)}`;
}

let catalogPromise: Promise<Catalog> | undefined;
let namePromise: Promise<NameTable> | undefined;
let verifier: Verifier | undefined;

/**
 * The catalog and name table are process-wide caches, not state: each is loaded once and never
 * mutated. The compiler instance *is* stateful — its file tree is swapped per check — so it
 * serialises overlapping checks internally, and every check supplies a complete file set and
 * complete compiler options. Reuse therefore carries nothing between requests, concurrent or not
 * (contracts/engine-api.md §5).
 */
function catalogOnce(): Promise<Catalog> {
  catalogPromise ??= loadCatalog();
  return catalogPromise;
}

function nameTableOnce(): Promise<NameTable> {
  namePromise ??= loadNameTable();
  return namePromise;
}

function verifierOnce(): Verifier {
  verifier ??= createVerifier();
  return verifier;
}

/** Releases the cached compiler. Adapters call this on shutdown; tests call it between suites. */
export async function disposeEngine(): Promise<void> {
  const held = verifier;
  verifier = undefined;
  await held?.dispose();
}
