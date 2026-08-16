/**
 * Every bundle compiles and runs in a project that is not this one.
 *
 * Verification is hermetic by design: it compiles with `lib: ["es2022"]`, no `node_modules`, and
 * hand-written declarations for `node:test`, `node:assert/strict`, and the platform globals
 * (`verify/test-shims.ts`, `verify/platform-types.ts`). That is what makes "these tests passed" mean
 * the same thing on every machine. It also means a bundle is only ever proven against *our* account of
 * the world, and a declaration looser than the real one lets through exactly the defects the gate
 * exists to catch.
 *
 * That is not hypothetical. `assert.throws`'s matcher parameter was declared optional, where
 * `@types/node` requires it in the overload that takes one, so the emitted `expect` shim forwarded a
 * `RegExp | undefined` — clean here, `TS2769` in the caller's repository. Every pattern that emits a
 * `node:test` suite shipped that way, green.
 *
 * So this suite is the opposite bargain, deliberately: real `@types/node`, a `tsconfig.json` written
 * from scratch rather than the one verification synthesises, a directory outside the repository, and
 * the suite executed by Node's own resolver instead of a transpiled copy in a sandbox. It is slower
 * and it is not hermetic, which is why it checks one convention pair per pattern rather than the grid
 * that `conventions.test.ts` sweeps. What it buys is the only evidence nothing else here can give:
 * that the code we hand a caller compiles where they will compile it.
 *
 * `node-test` with `ts` extensions, because that pair is where the two hermetic fictions live — the
 * shim is only emitted for `node:test`, and `ts` specifiers are the only ones Node resolves directly
 * from source, so the suite can be run without a build step or an install.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, describe, expect, it } from "vitest";

import { generateBundle } from "../bundle.js";
import { headerOf, withoutHeader } from "../../src/engine/provenance/header.js";
import { generativePatterns, goldenIdentifiers } from "../golden/harness.js";

const require = createRequire(import.meta.url);

/** The pinned compiler, as a caller invokes it. */
const TSC = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsc");

/**
 * The compiler options a caller plausibly has, and stricter than the ones verification uses.
 *
 * `noImplicitReturns` is switched on nowhere in the engine, so it is only ever exercised here.
 */
const BASE_OPTIONS = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  target: "es2022",
  lib: ["es2022"],
  module: "preserve",
  moduleResolution: "bundler",
  allowImportingTsExtensions: true,
  types: ["node"],
  noEmit: true,
} as const;

/**
 * The unused-symbol checks, applied to the modules a caller integrates and not to the rest.
 *
 * The line is drawn by role rather than by taste. A `core` or `binding` file is library code that
 * lands in the caller's build, where an unused local is an error under a flag many projects set — and
 * it is a defect on its own terms, since it means the emitted code carries state nothing reads.
 * `debounce` shipped a burst flag that was assigned twice and read never in its trailing-edge
 * rendering, which is how this pair earned its place here.
 *
 * An example and a type-level test are held to the looser standard deliberately. A `.test-d.ts` file
 * declares types in order to assert things *about* them, so a declaration nothing reads is what the
 * file is for, and satisfying the flag would mean adding `void` references that say nothing to a
 * reader. Applying it there would buy noise, so what remains uncovered is left uncovered on purpose
 * rather than by omission.
 */
const INTEGRATED_ROLES: ReadonlySet<string> = new Set(["types", "core", "binding", "adapter"]);

const UNUSED_OPTIONS = { noUnusedLocals: true, noUnusedParameters: true } as const;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A bundle written into a fresh directory outside the repository, with real `@types/node` beside it.
 *
 * The types are linked rather than installed so the suite needs no network, and linked from whatever
 * version this repository resolves rather than a pinned copy: the point is to be checked against the
 * `@types/node` the world actually has, so it tracking upstream is the feature.
 */
function project(
  files: readonly { readonly path: string; readonly contents: string; readonly role: string }[],
): string {
  const root = mkdtempSync(join(tmpdir(), "patterns-foreign-"));
  roots.push(root);

  for (const file of files) writeFileSync(join(root, file.path), file.contents, "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf8");

  writeConfig(root, "tsconfig.json", BASE_OPTIONS, ["*.ts"]);

  // The stricter pass names its files rather than globbing, because the point is to exclude some.
  // Sorted, so the config a failure is diagnosed from does not depend on bundle order.
  const integrated = files
    .filter((file) => INTEGRATED_ROLES.has(file.role))
    .map((file) => file.path)
    .toSorted();

  writeConfig(root, "tsconfig.integrated.json", { ...BASE_OPTIONS, ...UNUSED_OPTIONS }, integrated);

  mkdirSync(join(root, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    dirname(require.resolve("@types/node/package.json")),
    join(root, "node_modules", "@types", "node"),
    "dir",
  );

  return root;
}

function writeConfig(
  root: string,
  name: string,
  compilerOptions: Readonly<Record<string, unknown>>,
  include: readonly string[],
): void {
  writeFileSync(
    join(root, name),
    JSON.stringify({ compilerOptions, include }, null, 2),
    "utf8",
  );
}

/**
 * Diagnostics from compiling `root` under its own `tsconfig.json`, as a caller's build would.
 *
 * The compiler is invoked as a command rather than through its API because the pinned one has no
 * in-process JavaScript API to invoke — the engine drives the same binary the same way. Running the
 * CLI is also closer to the thing being claimed: this is the command a caller types.
 */
function compile(root: string, config = "tsconfig.json"): readonly string[] {
  const result = spawnSync(TSC, ["--project", join(root, config)], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });

  if (result.status === 0) return [];

  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("error TS"));
}

/**
 * The bundle's own suite, run by Node.
 *
 * Node's own type handling rather than a build step, so what executes is the emitted bytes and what
 * resolves the imports is Node's resolver reading the specifiers as written. That is the half the
 * sandbox cannot reproduce: it transpiles to `.js` before running, so a suite importing `./expect.js`
 * from a project that spells its imports `./expect.ts` resolves there and does not resolve here.
 *
 * `--experimental-transform-types`, not `--experimental-strip-types`: strip-only mode rejects
 * parameter properties and enums, which are ordinary TypeScript that a caller's build compiles
 * happily. Under stripping this suite failed eight patterns for using a `constructor(private readonly
 * store: Store)` — a limit of the runner, reported as a defect in the code.
 */
function run(root: string, testFile: string): string | undefined {
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--test", testFile],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );

  if (result.status === 0) return undefined;

  return `${result.stdout}\n${result.stderr}`.trim().slice(0, 2000);
}

const patterns = await generativePatterns();

/**
 * The one convention pair this suite covers, applied to whatever pattern is being composed.
 *
 * `entity` overrides the golden noun, and only for a pattern that declares one — supplying a role a
 * pattern does not declare is refused, which is the correct behaviour and would fail every other
 * pattern here for the wrong reason.
 */
async function filesOf(
  pattern: string,
  entity?: string,
  options?: Readonly<Record<string, unknown>>,
) {
  const entry = patterns.find((candidate) => candidate.name === pattern);
  if (entry === undefined) throw new Error(`no catalog entry for ${pattern}`);

  const golden = goldenIdentifiers(entry);
  const bundle = await generateBundle({
    pattern,
    identifiers: entity !== undefined && "entity" in golden ? { ...golden, entity } : golden,
    ...(options === undefined ? {} : { options }),
    conventions: { testFramework: "node-test", importExtensions: "ts" },
  });
  return bundle.files;
}

/**
 * Patterns whose bundles a caller plausibly wants together, chosen to collide.
 *
 * All four emit the `node:test` assertion shim, and they used to emit four different versions of it —
 * `repository` with the rejection surface, `retry` with `toBeLessThan`, `result` with `toThrow`,
 * `branded-type` with neither. They also span the roles a project mixes: machinery, a binding over a
 * caller's own type, and two standalone modules.
 */
const TOGETHER = ["repository", "retry", "result", "branded-type"] as const;

/**
 * Nouns to sweep agreement under, beyond the golden one.
 *
 * The golden noun cannot reach the collision it needs to: patterns derive their file stem by appending
 * their own noun to the caller's, and collapse the repetition when the caller's noun already ends in
 * theirs, so two stems only meet when the *caller's* noun is one a pattern appends. `Order` is nobody's
 * noun. Each of these is, and `typestate` — which named its file after the bare subject — met all of
 * them: `order-id.ts` against `branded-type`, `order-repository.ts` against `repository`,
 * `order-emitter.ts` against `typed-emitter`, `result.ts` against `result`, `event.ts` against
 * `discriminated-union`. Five different pairs of one mistake, none of them visible under `Order`.
 */
const COLLIDING_NOUNS = ["OrderId", "OrderRepository", "OrderEmitter", "Result", "Event"] as const;

/**
 * Bundles that are each correct alone are not necessarily correct together.
 *
 * Every other case here verifies one bundle in one directory, which is how a real defect shipped: each
 * pattern emitted `expect.ts` tailored to its own suite's matchers, so unpacking two bundles into one
 * directory left the second overwriting the first, and whichever suite lost no longer compiled against
 * the shim that survived. Nothing was wrong with either bundle. What was wrong only existed in the
 * composition, and only a test that composes them can see it.
 *
 * Two cases, because the invariant and the demonstration have different natural scopes. Agreement on
 * shared paths is checked across *every* pattern and under several nouns, since the rule is about any
 * two of them and a hand-picked list would leave a pattern added later unguarded — generation is cheap
 * enough to sweep. Compiling and running is checked on four, since that costs compiler and Node
 * processes and the fifth pair proves nothing the first four did not.
 */
describe("bundles installed side by side", () => {
  /**
   * The invariant, rather than a re-enactment of the symptom: a path two patterns both emit must carry
   * identical bytes, so the second write is a no-op instead of a theft. Stated this way it fails for any
   * future shared file carrying something request-specific — a provenance header naming the pattern
   * being the case that actually happened — which is the general form of the mistake.
   *
   * Swept over nouns as well as patterns, because a path can be shared by coincidence of naming rather
   * than by design: see `COLLIDING_NOUNS` for the five pairs that reached it that way.
   */
  it.each(["the golden noun", ...COLLIDING_NOUNS])(
    "agree on every path that two of them emit, for %s",
    async (noun) => {
      const entity = noun === "the golden noun" ? undefined : noun;

      // Which patterns emitted each path, and how many distinct versions of it they produced. One
      // entity for all of them on purpose: sharing a noun is what makes two patterns derive the same
      // file stem, so this is the arrangement most likely to collide rather than a fair one.
      const byPath = new Map<string, { readonly patterns: string[]; readonly contents: Set<string> }>();

      for (const pattern of patterns) {
        for (const file of await filesOf(pattern.name, entity)) {
          const entry = byPath.get(file.path) ?? { patterns: [], contents: new Set<string>() };
          entry.patterns.push(pattern.name);
          entry.contents.add(file.contents);
          byPath.set(file.path, entry);
        }
      }

      const shared = [...byPath].filter(([, entry]) => entry.patterns.length > 1);

      expect(
        shared
          .filter(([, entry]) => entry.contents.size > 1)
          .map(([path, entry]) => `${path} (${entry.patterns.join(", ")})`),
        "two patterns emitting one path with different bytes: whichever is written second wins",
      ).toEqual([]);

      expect(
        shared.map(([path]) => path),
        "no two patterns share a path, so this case has stopped testing what it was written for",
      ).not.toEqual([]);
    },
    300_000,
  );

  /**
   * The same collision reached by a second *request* rather than a second pattern.
   *
   * A split pattern hands back its machinery with every `full` request, so a project with two repositories
   * has been sent `repository-core.ts` twice — and it shipped byte-different both times, because the header
   * hashed the whole request, including the entity the machinery is defined not to know. The code was
   * identical; only the attribution differed. That is the FR-020 failure exactly, and the cross-pattern
   * case above cannot see it, because there is only one pattern involved.
   *
   * Two pairings and an inequality, because agreement alone is satisfiable by a header that says nothing:
   *
   *   - Two entities, and the same request asked two ways, must leave the machinery identical.
   *   - An option that shapes the machinery must leave it *different*, header included, since a caller
   *     comparing an installed core against what a new binding needs (research.md §11) is comparing this
   *     hash. A hash that no longer moved would make every core look compatible with every binding.
   */
  it.each([
    { pattern: "repository", option: "pagination", left: "cursor", right: "offset" },
    { pattern: "unit-of-work", option: "concurrency", left: "version", right: "none" },
  ])("share machinery across requests to $pattern", async ({ pattern, option, left, right }) => {
    const full = { emitScope: "full", [option]: left };
    const installed = await filesOf(pattern, "Order", full);

    /** Paths this request emits too, and where its bytes differ from what is already installed. */
    const rewritten = async (what: string, entity: string, options: Readonly<Record<string, unknown>>) => {
      const files = await filesOf(pattern, entity, options);
      const differing = files
        .filter((file) => {
          const already = installed.find((candidate) => candidate.path === file.path);
          return already !== undefined && already.contents !== file.contents;
        })
        .map((file) => file.path);
      return { what, differing };
    };

    // Every shared path, not just the core: `includeTests` reached the binding and the example too, which
    // is the same mistake one file further out — a caller who regenerates without a suite should not find
    // their binding rewritten.
    for (const request of [
      await rewritten("a second entity", "Invoice", full),
      await rewritten("the machinery alone", "Order", { ...full, emitScope: "core-only" }),
      await rewritten("no suite", "Order", { ...full, includeTests: false }),
    ]) {
      expect(
        request.differing,
        `asking for ${request.what} rewrites files the previous request installed`,
      ).toEqual([]);
    }

    // And the header still distinguishes machinery that genuinely differs. Compared as headers rather
    // than as whole files, because the bodies differ here whatever the header says — which is how a
    // header that had stopped identifying anything would pass unnoticed.
    const coreOf = (files: readonly { path: string; contents: string }[]) => {
      const core = files.find((file) => file.path.endsWith("-core.ts"));
      if (core === undefined) throw new Error(`${pattern} emitted no core file`);
      return { header: headerOf(core.contents), body: withoutHeader(core.contents) };
    };

    const before = coreOf(installed);
    const after = coreOf(await filesOf(pattern, "Order", { ...full, [option]: right }));

    expect(after.body, `${option} is meant to shape the machinery, so this case tests nothing`).not.toBe(
      before.body,
    );
    expect(
      after.header,
      `machinery differing by ${option} is attributed identically, so an installed core cannot be told apart`,
    ).not.toBe(before.header);
  });

  it(
    "compile and run together",
    async () => {
      const bundles = await Promise.all(
        TOGETHER.map(async (name) => ({ name, files: await filesOf(name) })),
      );

      const root = project(bundles.flatMap((bundle) => bundle.files));

      expect(compile(root), "compiling every bundle together").toEqual([]);
      expect(
        compile(root, "tsconfig.integrated.json"),
        "compiling the integrated modules together with the unused-symbol checks on",
      ).toEqual([]);

      // Every executable suite, not just one: the failure this guards against is asymmetric, and hits
      // whichever bundle was written first. `.test-d.ts` files are excluded because nothing in them
      // runs — the compiler is their whole audience, and both passes above have already read them.
      for (const bundle of bundles) {
        for (const file of bundle.files.filter((candidate) => candidate.path.endsWith(".test.ts"))) {
          expect(run(root, file.path), `running ${file.path} beside the other bundles`).toBeUndefined();
        }
      }
    },
    600_000,
  );
});

describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))("$name", ({ pattern }) => {
  it(
    "compiles and runs in a project of its own",
    async () => {
      const bundle = await generateBundle({
        pattern: pattern.name,
        identifiers: goldenIdentifiers(pattern),
        conventions: { testFramework: "node-test", importExtensions: "ts" },
      });

      const root = project(bundle.files);

      expect(compile(root), "compiling against real @types/node").toEqual([]);
      expect(
        compile(root, "tsconfig.integrated.json"),
        "compiling the integrated modules with the unused-symbol checks on",
      ).toEqual([]);

      const suite = bundle.files.find((file) => file.path.includes(".test."));
      expect(suite, "a bundle carrying no suite would pass this vacuously").toBeDefined();

      expect(run(root, suite?.path ?? ""), "running the emitted suite under Node").toBeUndefined();
    },
    300_000,
  );
});
