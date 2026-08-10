/**
 * The pipeline: resolve, render, attribute, format, verify, assemble.
 *
 * The order is not arbitrary. Provenance headers go on before formatting and therefore before
 * verification, so the bytes that typecheck are the bytes the caller receives — a header added afterwards
 * would mean returning a file in a form nothing had checked. Formatting happens *before* verification so that what typechecks is the
 * bytes the caller receives, rather than a pre-formatted draft that Prettier then rewrites. And
 * assembly happens last, so ordering and scope filtering apply to files that have already been proven
 * to compile together — filtering first would let a `core-only` bundle be verified without the binding
 * that exercises it.
 *
 * Nothing here reads a clock, the environment, or the filesystem beyond loading the catalog and name
 * table, both of which happen once and are cached for the process (Principle I).
 */

import { catalogOnce } from "../catalog/load.js";
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
import { factoryPattern } from "../patterns/factory/index.js";
import { repositoryPattern } from "../patterns/repository/index.js";
import { resultPattern } from "../patterns/result/index.js";
import { retryPattern } from "../patterns/retry/index.js";
import type { PatternModule, RenderedFile } from "../patterns/types.js";
import { withProvenance } from "../provenance/header.js";
import { hashResolvedRequest } from "../provenance/hash.js";
import { createVerifier, compilerOptionsFor } from "../verify/index.js";
import type { Verifier } from "../verify/index.js";
import { buildVerificationRecord } from "../verify/record.js";
import type { VerificationRecord } from "../verify/record.js";
import { runGeneratedTests } from "../verify/run-tests.js";
import { platformTypesFor } from "../verify/platform-types.js";
import { bareImports, shimTypesFor } from "../verify/test-shims.js";
import { synthesizeCore } from "../verify/synthesize-core.js";
import { assembleBundle } from "./assemble.js";
import type { EmitScope, File } from "./assemble.js";
import { checkCoreModule, repointImports, stemOf } from "./imports.js";

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
const MODULES: readonly PatternModule[] = [
  circuitBreakerPattern,
  factoryPattern,
  repositoryPattern,
  resultPattern,
  retryPattern,
];

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

  const scope = emitScopeOf(resolved);
  const repointed = repointToCoreModule(rendered, resolved, scope);

  const attributed = withProvenance(repointed, {
    pattern: pattern.name,
    options: resolved.options,
    identifiers: resolved.identifiers,
    variant: resolved.variant,
  });

  const formatted = await Promise.all(
    attributed.map(async (file) => ({
      ...file,
      contents: await formatSource(file.contents, resolved.conventions.prettierConfig),
    })),
  );

  const verification = await verify(formatted, resolved, scope);

  const files = assembleBundle({
    pattern: pattern.name,
    files: formatted,
    emitScope: scope,
    ...(scope === "binding-only"
      ? { coreModule: checkCoreModule(String(resolved.options.coreModule ?? "")) }
      : {}),
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
      // What verification did, not what the bundle contains: a binding-only bundle emits no suite but
      // was still executed against one, and reporting `skipped` there would understate the evidence.
      testOutcome: verification.testOutcome,
      executedTestFiles: verification.executedTestFiles,
    }),
    notes: coreFitNotes(pattern, resolved, scope),
    warnings: [],
    nextSteps: [],
  };
}

/**
 * Points a binding-only bundle's imports at the core the caller already has (FR-018, T056).
 *
 * Templates always import their siblings, so a binding in a full bundle reads `./repository-core.js`.
 * In a binding-only bundle that file is not emitted, and this is the one place that knows it. Doing it
 * here rather than handing templates a specifier to interpolate means a template cannot forget: a
 * template that forgot would emit a binding importing a file the caller does not have, and it would
 * still typecheck, because verification synthesises the core.
 *
 * Every rendered file is rewritten, not only the ones this scope emits, since the whole rendered set is
 * what gets typechecked — a test still importing the sibling would be checked against a module the
 * emitted binding no longer refers to.
 */
function repointToCoreModule(
  rendered: readonly RenderedFile[],
  resolved: ResolvedRequest,
  scope: EmitScope,
): readonly RenderedFile[] {
  if (scope !== "binding-only") {
    return rendered;
  }

  const coreModule = checkCoreModule(String(resolved.options.coreModule ?? ""));
  const cores = rendered.filter((file) => file.role === "core" || file.role === "types");

  // Every spelling of a sibling import of the core, because the specifier a template wrote depends on
  // the caller's extension convention and there is no reason for this to re-derive which one it chose.
  const from = cores.flatMap((file) => [
    `./${stemOf(file.path)}`,
    `./${stemOf(file.path)}.js`,
    `./${stemOf(file.path)}.ts`,
  ]);

  return repointImports({ files: rendered, from, to: coreModule });
}

/**
 * What a binding-only caller is told about the core it has to fit (T105).
 *
 * The mismatch this addresses cannot be detected here: the core regenerated for verification is the one
 * *this request* describes, and the file in the caller's repository is invisible to us. A binding built
 * for cursor paging and a core installed with offset paging are each internally consistent, so there is
 * no diagnostic to raise — only an expectation to state.
 *
 * So the note names the options the core depends on, taken from the `affects` metadata rather than a
 * hand-written list, which is what keeps it true when an option is added. A caller compares them against
 * the `@options` header in their installed core, and a mismatch is a glance rather than a compiler
 * error in a file they did not generate.
 */
function coreFitNotes(
  pattern: GenerativePattern,
  resolved: ResolvedRequest,
  scope: EmitScope,
): readonly string[] {
  if (scope !== "binding-only") {
    return [];
  }

  const shared = pattern.options
    .filter((option) => option.affects.includes("core") || option.affects.includes("types"))
    .map((option) => `${option.name}=${String(resolved.options[option.name])}`);

  if (shared.length === 0) {
    return [];
  }

  return [
    `This binding fits a core generated with ${shared.join(", ")}. Nothing here can read the core ` +
      `at "${String(resolved.options.coreModule)}", so if it was generated with different values the ` +
      `two will not fit — check the @options line in its provenance header before adopting this.`,
  ];
}

/**
 * Verification runs over the rendered set rather than the assembled one: a `core-only` request still
 * has to be proven correct together with the tests that exercise it, even though those are not all
 * returned.
 */
async function verify(
  rendered: readonly RenderedFile[],
  resolved: ResolvedRequest,
  scope: EmitScope,
): Promise<{
  readonly compilerVersion: string;
  readonly testOutcome: "passed" | "skipped";
  readonly executedTestFiles: number;
}> {
  const verifier = verifierOnce();

  // A binding-only bundle imports a module this process has never seen, so the core is regenerated
  // into the verification file system under the caller's specifier and discarded afterwards (T104).
  const synthesis =
    scope === "binding-only"
      ? synthesizeCore({
          files: rendered,
          coreModule: checkCoreModule(String(resolved.options.coreModule ?? "")),
        })
      : { verbatim: [], files: rendered };
  const files = synthesis.files;

  // Declarations for the caller's test runner, present for the compiler and absent from the bundle.
  const imported = new Set<string>();
  for (const file of files) {
    for (const specifier of bareImports(file.contents)) imported.add(specifier);
  }
  // The core's own specifier is satisfied by the synthesised module, not by a runner shim.
  if (scope === "binding-only") {
    imported.delete(String(resolved.options.coreModule ?? ""));
  }
  // Host facilities — timers, AbortSignal — are declared unconditionally rather than per import, since
  // they are globals a bundle uses without importing anything.
  const declarations = [
    ...[...shimTypesFor([...imported]), ...platformTypesFor(resolved.conventions)].map(
      ([path, contents]) => ({ path, contents }),
    ),
    ...synthesis.verbatim,
  ];

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

  // `failed` is absent by construction: a failure throws below rather than being reported.
  let run: "passed" | "skipped" = "skipped";
  if (entryPoints.length > 0) {
    const result = await runGeneratedTests({
      files: files.map((file) => ({ path: file.path, contents: file.contents })),
      testPaths: entryPoints,
      // A synthesised core behind a package specifier needs its `package.json` written as-is; it is
      // not TypeScript, so it must not go through transpilation with the rest.
      verbatimFiles: synthesis.verbatim,
    });

    if (result.outcome === "failed") {
      throw new VerificationError("tests", hashOf(resolved), [result.detail ?? result.outcome]);
    }
    run = result.outcome;
  }

  return {
    compilerVersion: outcome.compilerVersion,
    testOutcome: run,
    executedTestFiles: run === "passed" ? entryPoints.length : 0,
  };
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

/**
 * The correlation identifier a verification failure is reported under.
 *
 * The request's own options hash, which makes it reproducible: an operator reading it off a caller's
 * error can regenerate exactly the bundle that failed. An arbitrary identifier would be unique and
 * useless, and a counter would differ between processes handling the same request.
 */
function hashOf(resolved: ResolvedRequest): string {
  return hashResolvedRequest(resolved);
}

let namePromise: Promise<NameTable> | undefined;
let verifier: Verifier | undefined;

/**
 * The catalog and name table are process-wide caches, not state: each is loaded once and never
 * mutated. The compiler instance *is* stateful — its file tree is swapped per check — so it
 * serialises overlapping checks internally, and every check supplies a complete file set and
 * complete compiler options. Reuse therefore carries nothing between requests, concurrent or not
 * (contracts/engine-api.md §5).
 *
 * The catalog's cache lives in `catalog/load.ts` rather than here, because discovery reads it too and
 * two caches of one file are two chances to disagree about what the catalogue contains.
 */
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
