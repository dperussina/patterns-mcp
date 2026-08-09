---
description: "Task list for TypeScript Pattern Generation Service"
---

# Tasks: TypeScript Pattern Generation Service

**Input**: Design documents from `/specs/001-typescript-pattern-mcp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are included and are **not optional here**. Constitution Principle III makes
compile- and test-verification a non-negotiable product guarantee, and SC-001 through SC-003 are
stated as continuously measured with zero tolerated exceptions. Tests are the feature, not a wrapper
around it.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: Which user story the task serves (US1–US6)
- Exact file paths are given in every task

T001–T098 are numbered in execution order. T099 and above were added by the cross-artifact analysis
pass and are placed in the phase where they execute rather than appended at the end, so IDs remain
stable references while ordering stays readable.

## Path Conventions

Single published package with three entry points, per plan.md: `src/engine/` (pure generator),
`src/mcp/` (protocol adapter), `src/cli/` (terminal adapter), `data/` (catalog), `test/` (harnesses).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Get the toolchain, boundaries, and test topology in place. The scaffold from earlier work
(pnpm, tsdown, vitest, tsconfig) already exists — these tasks extend it rather than recreate it.

- [X] T001 Add runtime dependencies `@modelcontextprotocol/server@2.0.0` and `zod@4.4.3` to `package.json` — note the SDK is *not* `@modelcontextprotocol/sdk`, which is the older 1.x monolith still tagged `latest`
- [X] T002 Pin `typescript@7.0.2` and `prettier@3.9.6` with exact versions (no caret) in `package.json`, and set `engines.node` to `>=20` per the Toolchain Pinning section of the constitution
- [X] T003 [P] Create oxlint config `.oxlintrc.json` including the import-boundary rule that forbids any module under `src/engine/` or `src/index.ts` from importing MCP packages (Principle X), and add a `lint` script. Not ESLint — `typescript-eslint` caps at `typescript <6.1.0` against our pinned 7.0.2, per research.md §12
- [X] T004 [P] Create the source tree skeleton per plan.md: `src/engine/{catalog,patterns,options,render,format,verify,provenance}/`, `src/mcp/{tools,resources,transports}/`, `src/cli/`, `data/patterns/`
- [X] T005 [P] Configure Vitest projects for `unit`, `contract`, `golden`, `determinism`, and `parity` suites in `vitest.config.ts`, with matching directories under `test/`
- [X] T006 Add a composite `check` script to `package.json` chaining the stages that exist now — lint, typecheck, all five test projects, and build. Build is included because declaration emit can fail where `tsc --noEmit` passes, which is how the earlier tsup incompatibility surfaced. Catalog validation and conformance join in T011 and T083 respectively: a stage is wired into the gate by the task that creates the thing it checks, never before, or the gate is red from here to T083 and every rule that depends on it is unenforceable. This is the single gate referenced by quickstart.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The generation engine's shared machinery. Every user story depends on it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 [P] Define Zod schemas for `Option`, `LegalityRule`, and `Pattern` in `src/engine/catalog/schema.ts` per data-model.md, including the identifier and length rules
- [X] T008 [P] Define the `Conventions` schema with strictest-reasonable defaults in `src/engine/options/conventions.ts` per data-model.md
- [X] T009 Generate `data/schema.json` from the Zod schemas in `scripts/emit-catalog-schema.ts` so the published schema cannot drift from the runtime validator. `pnpm schema:check` joined the gate in this task. Note: JSON Schema cannot express the cross-field refinements (enum `default` ∈ `values`, no self-edge), so this artefact is necessary but not sufficient — T011 remains the authority on admissibility
- [X] T010 Implement catalog loading and shard merging with name-uniqueness and `relatedPatterns` reference checks in `src/engine/catalog/load.ts`. Split into a pure `buildCatalog(shards)` and an I/O `loadCatalog(dir)` that sorts `readdir` output, so merge rules are testable without fixtures and traversal order cannot leak from the filesystem
- [X] T011 [P] Write the catalog validator script `scripts/validate-catalog.ts` enforcing schema conformance, presence of `provenance`, rejection of NonCommercial and NoDerivatives license terms, and the advisory-entry invariants (FR-036, SC-012). Note: T007 made the licence allowlist, the advisory invariants, and self-edge rejection structural in `PatternSchema`, so this script enforces them by parsing rather than by re-checking them; its remaining own work is cross-shard name uniqueness and `relatedPatterns` resolution (T010) plus the `{category}.json` file-name convention, which relates a file's name to its contents and so cannot be expressed in any per-document schema. `pnpm catalog:check` joined the gate here. An empty catalogue passes on purpose; the tier-1 minimum count is asserted by the task that completes the tier, where it can actually be satisfied
- [X] T012 [P] Implement render helpers `dedent`, `indent`, `when`, `joinLines`, and `sortBy` in `src/engine/render/helpers.ts` — tagged template literals only, no template engine, so option renames break the build. Interpolation is indentation-aware: a multi-line value is re-indented to its placeholder's column, and CRLF is normalised so output does not vary with the checkout that built the generator
- [X] T013 [P] Implement identifier validation, the reserved-word denylist, and string length caps in `src/engine/options/identifiers.ts` (FR-032). The denylist must also cover identifiers the requested pattern itself emits, since a domain name colliding with a generated helper produces uncompilable output just as surely as a keyword does (spec edge case). Returns a result rather than throwing; mapping a broken rule onto a caller-correctable error belongs to T014. The accepted shape is an allowlist pattern, which also excludes path separators and traversal (FR-033)
- [X] T099 [P] Implement the name derivation table in `src/engine/options/names.ts` plus its data in `data/names.json`: plural forms with an explicit irregular-exception list, casing variants, and file-name stems. No pluralization library — a version bump in one would silently rename members across every consumer's regenerated output (FR-040, Principle I). Split like the catalogue: `deriveNames` is pure and takes a loaded table, `loadNameTable` holds the only I/O, so generation never reads the filesystem. Ambiguous suffixes are checked before the confident rules, since `-us` also ends in `-s`
- [X] T100 [P] Refuse names the derivation table cannot resolve confidently, stating the rule, rather than guessing a plural (FR-041)
- [X] T014 Define the error taxonomy from contracts/engine-api.md in `src/engine/errors.ts`, distinguishing caller-correctable errors from `VerificationError`. Adapters branch on a `correctable` flag and a stable `code` rather than on the concrete class or message text. `VerificationError` takes its correlation id rather than generating one, since generating it would need a clock or random source on the engine's own error path
- [X] T015 Implement option resolution — defaults applied, unknown option names rejected, key order normalized — in `src/engine/options/resolve.ts`, following the fixed validation order in data-model.md. The order is asserted by tests that break two rules at once, and all three ordering guarantees (unknown-option iteration, key normalisation, variant before identifiers) were mutation-tested. `variant` is checked at step 3b: it is a request field rather than a declared option, but it is a value-space check like the others
- [X] T101 Validate the `variant` input against the requested pattern's declared `variants` in `src/engine/options/resolve.ts`, refusing an undeclared variant with the declared list (FR-013)
- [X] T016 Implement the legality rule evaluator in `src/engine/options/legality.ts`, evaluating in declared order with first-match-wins so the error for a given input is deterministic. Exposes `findViolation` alongside `evaluateLegality` so discovery can report what a hypothetical option set would break without catching an error. A rule naming an option the pattern lacks does not fire: a miswritten catalogue entry must not become a refusal that blames the caller
- [X] T017 Implement canonical serialization and the deterministic `optionsHash` in `src/engine/provenance/hash.ts`, excluding generator and toolchain versions (FR-021). `variant` is included, since data-model.md's field list predates it and omitting it would give two materially different bundles the same provenance. Whether `conventions` should be covered is recorded as an open question in blockers.md and needs a decision before T057 emits headers
- [X] T018 Implement the Prettier wrapper with caller-config merge in `src/engine/format/prettier.ts`, warming the instance for reuse. Caller config is an allowlist, not a pass-through: a `plugins` entry is `import()`ed by Prettier (verified), and `endOfLine: "auto"` makes output depend on the input's line endings. `resolveConfig` is never called, since it walks the filesystem for a `.prettierrc`. Corrects the T008 comment that said Prettier should validate its own options
- [X] T019 Implement the verification virtual file system in `src/engine/verify/vfs.ts` — `readFile` must be tri-state and return `undefined` (not `null`) for lib paths, or lib resolution silently fails and produces a cascade of misleading "Cannot find name" diagnostics. Unknown non-lib paths return `null` rather than `undefined`, unlike `createVirtualFileSystem`; the measured consequence of the latter is that a real `tsconfig.json` on disk is opened and supplies the compiler options, so a bundle could be certified under settings we never chose. `fileExists` is tri-state for the same reason. Compiler-backed tests in `test/unit/vfs-compiler.test.ts` pin both the lib cascade (TS2583) and the tsconfig behaviour; both are mutation-verified. A `readThrough` seam is in place for T104/T105, where binding-only bundles need types for packages we do not emit
- [X] T020 Implement warm async typechecking via `typescript/unstable/async` in `src/engine/verify/typecheck.ts`: one long-lived API instance, `fileChanges.changed` on each snapshot, and restart-on-crash for the compiler subprocess. The async variant is mandatory — the sync variant pins the event loop completely (confirmed: 15 sequential checks left 148 event-loop ticks). Measured: ~130ms cold, ~13ms warm. Three findings drove the design. (1) Omitting the change summary makes the compiler serve a **stale verdict** — a broken bundle measured clean — so `createMutableVerificationFileSystem().replace()` derives the summary from the same tree the compiler reads rather than trusting a caller to describe it. (2) `invalidateAll` does **not** reload project configuration; only naming the tsconfig in `changed` does, which the mechanical diff does whenever its bytes differ. (3) A killed compiler does not reliably reject the request in flight, so there is a deadline, and failure abandons the compiler instead of closing it — closing ends the pipe under a queued write and produces an unhandled stream error from our own recovery path. Restart-on-crash verified for every crash except a same-tick write race, recorded in blockers.md. Also carries `compilerOptionsFor(conventions)`, verified against the real compiler across the whole moduleStyle × importExtensions × strictness matrix — a wrong mapping does not fail loudly, it reports "cannot find module" on every import of a good bundle. Corrects a note I left on this task last iteration: the *input* `fileChanges` is `{ changed, created, deleted }` as research.md says; `changedFiles`/`deletedFiles` is the per-project *output* shape
- [X] T021 Implement the stable TypeScript 6.x `createProgram` fallback behind a flag in `src/engine/verify/typecheck-fallback.ts`, so the verification gate survives an upstream break in the unstable API. `typescript@6.0.3` added as a runtime dependency aliased `typescript-stable`, pinned exactly, so it coexists with the 7.x compiler. Both paths implement a shared `Verifier` interface; `createVerifier({ engine })` in `src/engine/verify/index.ts` selects between them by **parameter, not environment variable** — `process.env` in the engine would make behaviour depend on ambient state and put the choice beyond a test's reach. Options reach the classic API through `convertCompilerOptionsFromJson`, which is load-bearing: passing the JSON form directly yields a program with no module resolution, and mutation-testing that line fails 14 assertions. Agreement with the fast path is asserted across the whole moduleStyle × importExtensions × strictness matrix, since a fallback that disagrees replaces the gate rather than preserving it. **Also corrects T002**: `typescript` was pinned into devDependencies, but `src/engine/verify/typecheck.ts` imports it at runtime, so a consumer install would have shipped without a compiler. Now a runtime dependency alongside the alias
- [X] T022 Implement the generated-test executor with a hard timeout and sandboxing in `src/engine/verify/run-tests.ts`; it must never execute caller-supplied content (FR-034). Sandboxing is Node's permission model (`--permission --allow-fs-read=<dir>`), which denies filesystem writes, child processes, and native addons; the environment passed to the child is empty, so no configuration or token reaches it. Each test file is invoked **directly rather than through `node --test`**, because `--test` spawns a child per file and would require `--allow-child-process` — handing the sandboxed code the ability to spawn anything. Two traps encoded: the permission model checks the *realpath*, and on macOS the temp directory is behind a symlink, so granting the unresolved path denies every read; and the bundle must be transpiled to CommonJS with `rewriteRelativeImportExtensions` before it can run, because the default `importExtensions: "js"` convention emits `./thing.js` against a `thing.ts` file — TypeScript resolves that, Node reports `ERR_MODULE_NOT_FOUND`. All three extension styles verified executable. Timeout uses SIGKILL, since a busy loop declines SIGTERM. The three sandbox assertions were mutation-verified by removing `--permission`. Two decisions escalated to blockers.md: execution costs ~60ms, which puts plan.md's 50ms p95 out of reach for any bundle with tests; and only `node:test` can currently be executed, so the `vitest` default needs a shim before the generator emits its first test
- [x] T023 [P] Write unit tests for every foundational module in `test/unit/` — options resolution, legality ordering, identifier rejection, hash stability, VFS lib fallthrough. Every module already had a test file, since each was built test-first, so this task became an audit for gaps rather than a writing exercise. `@vitest/coverage-v8` was added to answer that objectively (`pnpm test:coverage`); it moved from 96.8% to 97.5% of statements and 86.1% to 87.3% of branches, and found three things worth reporting.

  **A real defect in `names.ts`.** A single-word acronym lost its casing when pluralised: `ID` gave `Ids`, `URL` gave `Urls`, `API` gave `Apis`, `userID` gave `userIds`. `capitalise` preserved a word that was entirely uppercase, but a pluralised acronym is not — the appended `s` makes `IDs` mixed case — so it fell through to the branch that lower-cases the tail. Compound names were unaffected (`URLShortener` → `URLShorteners`) because only the final word is pluralised, which is why no existing test caught it. Fixed with an `ACRONYM_PLURAL` guard requiring two leading capitals, so `Status` still normalises. Reverting the guard fails seven assertions.

  Note the two pluralisation paths now disagree on all-caps input by design: the exception table upper-cases the whole entry (`CHILD` → `CHILDREN`, correct for a shouted word) while the default rule preserves the acronym and lowers only the suffix (`ID` → `IDs`, correct for an acronym). Nothing can distinguish an acronym from a shouted word, and each rule is right for the input that reaches it, so both are pinned by name in the tests.

  **A loose hermetic boundary in the fallback.** `directoryExists` delegated to the real filesystem for anything outside the bundle root, which is how module resolution walks for `node_modules`. Nothing leaked in practice only because the root `/verify` does not exist on disk — an accident, not a design. Tightened to answer for the bundle root and the compiler's lib directory only, matching the primary path's VFS. The new test imports `zod`, a real dependency of this repository with real published types, so a leak would resolve rather than merely fail for absence. Three independent layers now stop it; opening any one alone leaves the test passing, and opening all three makes it fail, which is why the test states the property rather than probing one layer.

  **What remains uncovered is interface plumbing.** The fallback's `writeFile`, `getDirectories`, and `realpath` are `ts.CompilerHost` members the compiler never calls under the options we generate. Reaching them would mean invoking the host directly, which would assert that a function returns what it was written to return. Left uncovered deliberately.

  Also pinned: `splitWords` dropping the empty run that doubled or leading separators produce, and `_user` deriving `user` — a caller's visibility convention on one declaration should not become part of every file name.
- [x] T024 [P] Add a determinism guard in `test/unit/determinism-guard.test.ts` plus oxlint rules on the `src/engine/**` override that fail on `Date.now`, `Math.random`, and `process` (`no-restricted-properties` and `no-restricted-globals`, both verified working). `no-restricted-syntax` is unsupported by oxlint, so structural checks — unordered iteration reaching a template, filesystem reads in the generation path — belong in the test half of this task rather than in lint (Principle I, research.md §12). Both rules landed as planned and were confirmed to fire against a planted module: `no-restricted-properties` covers `Date.now`, `Math.random`, `performance.now`, and `process.env`, and `no-restricted-globals` covers the `process` and `performance` globals so that aliasing (`const host = process`) cannot walk around the property rule. `src/engine/verify/**` turns both off, since spawning a compiler and a test runner is its purpose; its determinism is held by the two-engine parity tests instead.

  Two corrections to the plan. oxlint rejects unknown keys in an override, so the exemption's rationale could not live beside it as a `comment` field and is recorded in the test file instead. And no rule was needed to *remove* nondeterminism: the engine had no clock, randomness, or environment read anywhere, so both rules are regression guards rather than fixes.

  The test half carries what lint cannot see. It scans each generation-path module for the same hazards at source level, so the guard survives an edit to the lint config, and asserts none of them reaches the filesystem — including Prettier's `resolveConfig`, which walks upwards for a config file and would make output depend on the directory the server started in. It also asserts the lint rules are still configured, which is the failure mode a source scan alone would miss: a new module added after the rules were quietly dropped. Load-time readers (`catalog/load.ts`, `options/names.ts`) are excluded by name with their reasons, since both read once in sorted order before any request is served.

  Behaviourally it proves the property the source scan cannot: the same request with every object literal's keys reversed resolves to the same options *in the same key order* and hashes to the same bytes, and a partial request hashes identically to the explicit one that resolves to the same values — otherwise the same output would carry two different provenance lines. Removing the lint rules and planting `Date.now()` in `hash.ts` fails two assertions, so both halves bite.

**Checkpoint**: Engine machinery exists and is unit-tested. User story work can begin.

---

## Phase 3: User Story 1 - Request a working pattern implementation (Priority: P1) 🎯 MVP

**Goal**: A caller supplies a pattern name and options and receives a multi-file, compile- and
test-verified bundle, byte-identically on every repeat.

**Independent Test**: Request one pattern with explicit options; confirm the returned files compile,
the returned tests pass, and the response says so. Requires no other story.

### Tests for User Story 1

> Write these first and confirm they fail before implementing.

- [x] T025 [P] [US1] Contract test for the `generate_pattern` happy path via the SDK's in-process client in `test/contract/generate.test.ts`, asserting `diagnosticCount` is 0 and `testOutcome` is `passed`. The client and server share a process over `InMemoryTransport.createLinkedPair()`, driven through `test/contract/client.ts`. Going through the protocol rather than calling the handler is the point: schema validation of arguments, `structuredContent` against the declared `outputSchema`, and `isError` as a result rather than a throw only exist once a request has been serialised.
- [X] T026 [P] [US1] Golden snapshot harness in `test/golden/harness.ts` that stores one expected bundle per pattern × documented option combination (SC-003)
- [x] T027 [P] [US1] Byte-equality harness in `test/determinism/bytes.test.ts` comparing output across repeats **and across process restarts** — a same-process comparison would not catch an ambient dependency (SC-002). Restarts go through `test/determinism/emit.ts`, a separate entry point, since a same-process repeat would be satisfied by any cache. The suite also varies the environment between runs and asserts a differing request still differs, so it cannot be passed by a generator that returns a constant.
- [x] T028 [P] [US1] Refusal tests in `test/contract/refusals.test.ts` for illegal option combinations and invalid identifiers, asserting the message names the field, states the rule, lists alternatives, and returns no code. Covers the refusals reachable through the tool today — unknown pattern, undeclared option, out-of-space value, unusable identifier, and an injected string that must not be echoed. A true `IllegalCombinationError` is not among them because no pattern declares a legality rule yet; that path is held by `test/unit/legality.test.ts` at the engine layer and joins here with `retry` (T035), whose options actually constrain each other. This task also caught a defect: suggestions matched substrings only, so `reslt` returned no suggestion at all, and the fix is `src/engine/catalog/nearest.ts`.
- [x] T029 [P] [US1] Concurrency isolation test in `test/determinism/concurrency.test.ts` proving two simultaneous requests cannot influence each other's output. This one found a real defect rather than confirming a design. The warm compiler's file tree is swapped in place per check, so overlapping requests verified each other's files, and `Typechecker` now serialises checks internally — the guarantee belongs to the shared instance, not to whoever remembers to queue. Serialising costs nothing real: one compiler cannot check two bundles at once, and a queued check still gets the warm instance. The deadline starts when the turn arrives, so a queued request is not charged for the wait. Isolation is also pinned at the verify layer in `test/unit/typecheck.test.ts`, where the shared state actually lives.

### Implementation for User Story 1

- [x] T030 [US1] Define the pattern module interface — template, options, legality, metadata — in `src/engine/patterns/types.ts`. Landed as identity plus `render`, not the four things listed. plan.md's source-tree comment reads as though a module declares its own options, but data-model.md gives `options`, `legality`, `variants`, and metadata to the catalog entry in `data/patterns/{category}.json`, and it is the field-level authority. Declaring them in both places would create two sources of truth that drift silently — the catalog documenting one option set while generation honoured another — and would also defeat the catalog validator, which checks the corpus by parsing JSON rather than by importing generation code. A module therefore names the catalog entry it implements and receives options already resolved against it.

  `RenderContext` is closed on purpose: options, conventions, identifiers, derived names, variant, and nothing else. A template that wanted the clock or the filesystem cannot reach them, which is a stronger guarantee than a lint rule against reaching for them. Derived names are computed once and passed in, so two templates cannot disagree about how the same identifier pluralises.
- [x] T031 [US1] Implement bundle assembly with `File` roles — `core`, `binding`, `adapter`, `test`, `example`, `types` — ordered by role then path in `src/engine/generate/assemble.ts`; never emit in iteration order. `ROLE_ORDER` is `types, core, binding, adapter, example, test`, so a reader meets definitions before uses and tests last. The sequence is asserted by name in the tests because it is part of the output contract: reordering it later would change every bundle's file order and every content hash.

  Sorting is by code unit rather than `localeCompare`, which would order the same paths differently depending on the ICU data the host's Node was built with — the exact class of ambient dependency Principle I excludes. A test pins `B.ts, Z.ts, a.ts` to catch a later switch to locale-aware comparison.

  Scope filtering: `core-only` keeps types, core, example, and tests; `binding-only` keeps the binding and its adapter alone, since the caller already has the machinery and re-emitting it would overwrite a file they may have edited while re-emitting its tests would duplicate a suite they are already running. Assembly also refuses paths a template should never have built — absolute, traversing, drive-lettered, backslashed, directory-named — and refuses two files at one path rather than letting one silently replace the other. All of these are pattern-author defects, so they throw rather than being reported as correctable.

  Reverting the sort fails six assertions.
- [x] T102 [US1] Emit a usage `example` file for every generative pattern, which FR-004 and US1 acceptance scenario 1 both require and which is distinct from the test file. **Half done.** The enforcement landed with T031: assembly refuses any bundle whose scope includes the `example` role but which contains no such file, so the requirement is structural rather than a convention a pattern author has to remember. `binding-only` is exempt, since a binding is a fragment fitted to machinery the caller already has and an example of it in isolation would not run. What remains is the emission itself, which cannot exist before a pattern does — it lands with T034, and this task closes there. **Closed.** The `result` pattern emits `{stem}-example.ts`, separate from `{stem}.test.ts`, and `test/unit/generate.test.ts` asserts the two are distinct files with distinct roles rather than one file doing both jobs.
- [x] T032 [US1] Implement `VerificationRecord` construction in `src/engine/verify/record.ts`, recording compiler version, formatter version, the options actually verified against, and the content hash (FR-006). The builder refuses to construct a record stating something verification did not establish, rather than trusting its caller to only ask when it is true: diagnostics present, `passed` for a bundle with no test files, or `skipped` for a bundle that has them. That middle case is the one worth guarding — a bundle whose tests were never run reporting that they passed is precisely the claim Principle III exists to make unfalsifiable.

  `contentHash` covers each file's path and contents in return order and nothing else. The toolchain is excluded for the same reason it is excluded from the provenance header: folding the compiler version in would change the hash on every release and report drift no file experienced (FR-021). A test pins that a compiler and formatter bump leaves the hash untouched while a reordering of the same files changes it, since files arrive sorted and a different order is a different bundle.
- [x] T103 [US1] Assert in `test/contract/generate.test.ts` that a bundle containing no tests reports `testOutcome: "skipped"` and never a value implying tests passed (spec edge case). Asserted over the protocol, and paired with the absence of any file in the `test` role, so the claim and the bundle cannot disagree.
- [x] T033 [US1] Implement the `generate()` pipeline — resolve, render, format, verify, assemble — in `src/engine/generate/index.ts`. Formatting runs before verification, not after, so what compiles is what is returned. Verification covers the rendered set rather than the assembled one: a `core-only` request is still proven against the tests that exercise it, even though those are not handed back. Two things had to be built to make verification possible at all — declarations for the caller's test runner injected into the compiler's file system, and runtime shims injected into the sandbox — because a hermetic environment has no `node_modules` and `import "vitest"` would otherwise fail to resolve in both places.
- [x] T034 [P] [US1] Author the `result` pattern in `src/engine/patterns/result/` as the reference implementation, with the full method surface a caller needs later (map, mapErr, andThen, unwrapOr, combinators), not a minimal example (Principle IV). Two API decisions were forced by the compiler rather than chosen. `ok` and `err` return the whole union with `never` on the unused side, because a bare `Ok<T>` carries nothing about the error arm and every `andThen` chain would otherwise infer `unknown` and need a hand-written type argument. And every combinator narrows through the `isOk`/`isErr` predicates instead of reading `result.ok`: the discriminant narrows only when `strictNullChecks` is on, so under a `strict: false` project — which Principle IX obliges us to serve — `result.error` becomes an error on the success arm and the module does not compile.
- [ ] T112 [US1] Declare the shared base options on every generative pattern, so the flat tool inputs data-model.md §"Shared base options" documents actually resolve. `emitScope`, `coreModule`, and `includeTests` work today because `result` declares them; `errorMode`, `async`, and `cancellation` are declared by nothing, so `src/mcp/tools/generate.ts` deliberately omits them from `inputSchema` rather than advertising fields that can only ever be refused. Either option resolution grants every generative pattern the base set with the documented defaults, or each catalog entry declares it and the catalog validator enforces presence — data-model.md gives the fields to the catalog, which argues for the second. This blocks nothing until a pattern needs those options to mean something, which is T035.
- [ ] T035 [P] [US1] Author the `retry` pattern in `src/engine/patterns/retry/` including backoff, jitter, and cancellation plumbing
- [ ] T036 [P] [US1] Author the `circuit-breaker` pattern in `src/engine/patterns/circuit-breaker/` including half-open probe sampling, whose edge cases are exactly what generated tests must pin down
- [x] T037 [US1] Export the engine public API from `src/index.ts` per contracts/engine-api.md, with no MCP imports. `listPatterns` and `describePattern` are absent rather than stubbed, since they arrive with T046 and T047 and a placeholder is something a caller can bind to. `toolchain()` is also deferred: it reports a catalog version, and nothing yet defines what that version is.
- [x] T038 [US1] Construct the MCP server in `src/mcp/server.ts` with read-only annotations and cache hints per contracts/mcp-tools.md. All four annotations are true of generation rather than merely asserted about it — it writes nothing and consults nothing outside the request — and the cache hint is a consequence of Principle I: an identical request cannot produce a different bundle, so a cached response cannot be stale.
- [x] T039 [US1] Register the `generate_pattern` tool in `src/mcp/tools/generate.ts`, deriving `inputSchema` and `outputSchema` from the Zod schemas. `pattern` is a described string rather than the closed enum the contract asks for, and that is a deliberate trade recorded in the file: an enum is validated by the SDK before the handler runs, which would replace "no pattern named X, did you mean Y" with a schema violation and lose the nearest-match suggestion the same contract requires. It becomes the better trade once the catalog is public API (T046) and the description can enumerate the names.
- [x] T040 [US1] Map engine errors to `isError: true` results in `src/mcp/errors.ts`, escaping or eliding every caller-supplied value before it appears in a message (FR-035) — tool handlers in SDK v2 return results, not protocol errors. Messages are rebuilt from each error's structured fields rather than forwarded from `error.message`: the engine quotes the values it rejects, which is right for a library whose caller is a program and wrong here, where the message may be pasted into another prompt. A caller value is quoted back only when it is inert — identifier-shaped, no whitespace, length-capped — and described rather than echoed otherwise, since prose is what carries an instruction.
- [ ] T041 [US1] Implement the stdio transport entry point in `src/mcp/transports/stdio.ts`, routing all diagnostics to `stderr`
- [ ] T042 [US1] Implement the verification-failure path: throw `VerificationError` with a correlation identifier and never return an unverified bundle (Principle III, spec edge case)

**Checkpoint**: The product's core promise works end to end and is independently verifiable. This is the MVP.

---

## Phase 4: User Story 2 - Discover what is available and how to configure it (Priority: P2)

**Goal**: An agent with no prior knowledge can browse the catalog and learn one pattern's options well
enough to construct a valid request on the first attempt.

**Independent Test**: Ask for the catalog, pick a pattern, ask for its details, and confirm the option
names and values returned are sufficient to build a successful generation request.

### Tests for User Story 2

- [ ] T043 [P] [US2] Contract tests for `list_patterns` and `describe_pattern` in `test/contract/discovery.test.ts`, including every filter combination
- [ ] T044 [P] [US2] Drift test in `test/contract/catalog-parity.test.ts` asserting the resource payload and the tool output are generated from the same catalog data and cannot diverge

### Implementation for User Story 2

- [ ] T045 [US2] Author tier-1 catalog entries for the three US1 patterns in `data/patterns/type-safety.json` and `data/patterns/async-resilience.json`
- [ ] T046 [US2] Implement `listPatterns` with `category`, `kind`, and `tier` filters in `src/engine/catalog/list.ts`, returning summary fields only so the payload stays cheap (FR-027)
- [ ] T047 [US2] Implement `describePattern` in `src/engine/catalog/describe.ts`, returning every option with values, default, description, and the legality rule text verbatim
- [ ] T048 [P] [US2] Register the `list_patterns` tool in `src/mcp/tools/list.ts`
- [ ] T049 [P] [US2] Register the `describe_pattern` tool in `src/mcp/tools/describe.ts` with `pattern` as a closed enum
- [ ] T050 [US2] Register `pattern://catalog` and the `pattern://catalog/{name}` resource template in `src/mcp/resources/catalog.ts`, marked cacheable for the package version's lifetime (FR-014)
- [ ] T051 [US2] Declare `server/discover` capabilities in `src/mcp/server.ts` — `listChanged: false`, no `logging`, no sampling, no roots — with short `instructions` stating the list → describe → generate order
- [ ] T052 [US2] Implement nearest-match suggestions for unknown pattern names in `src/engine/catalog/suggest.ts` (spec edge case)

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Reuse an installed pattern cheaply (Priority: P3)

**Goal**: Applying a pattern to a second domain type returns only the binding, importing machinery the
caller already has.

**Independent Test**: Generate a pattern in full, then request it for a different domain type while
pointing at the first result's module; confirm the second response contains only binding files that
import from that location.

### Tests for User Story 3

- [ ] T053 [P] [US3] Reuse-economy test in `test/contract/reuse.test.ts` asserting a binding-only response is at most 20% of the full response's content (SC-004)
- [ ] T054 [P] [US3] Diff-stability harness in `test/determinism/diff-stability.test.ts` asserting, for every option of every pattern, that changes stay confined to the surfaces named in that option's `affects` field — a reflowed unrelated function fails even though it still compiles (SC-005)

### Implementation for User Story 3

- [ ] T055 [US3] Implement `emitScope` filtering by `File` role in `src/engine/generate/assemble.ts` (FR-017)
- [ ] T056 [US3] Implement the `coreModule` requirement and import rewriting for `binding-only` in `src/engine/generate/imports.ts` (FR-018)
- [ ] T104 [US3] Implement stub synthesis for binding-only verification in `src/engine/verify/synthesize-core.ts` per research.md §11: regenerate the core into the verification file system at the `coreModule` specifier, typecheck the binding against it, then discard it from the emitted bundle. Requires separating rendering from emission in the pipeline, and `contentHash` must cover emitted files only
- [ ] T105 [US3] Refuse a binding-only request whose regenerated core does not match what the pattern expects, explaining what was expected rather than returning code that cannot compile (spec edge case)
- [ ] T057 [US3] Implement provenance header emission in `src/engine/provenance/header.ts` carrying pattern identity and `optionsHash` only — embedding a generator version would rewrite every generated file on every release and destroy diff-stability (FR-020, FR-021)
- [ ] T058 [US3] Refuse `binding-only` for patterns whose catalog entry has `supportsSplit: false`, explaining what that pattern does support (US3 acceptance scenario 3)
- [ ] T059 [US3] Author the `repository` pattern with a genuine core/binding split in `src/engine/patterns/repository/`, plus its catalog entry in `data/patterns/data-access.json`
- [ ] T060 [P] [US3] Add golden snapshots covering `full`, `core-only`, and `binding-only` for every split-capable pattern

**Checkpoint**: Reuse compounds. US1–US3 all work independently.

---

## Phase 6: User Story 4 - Be steered away from the wrong pattern (Priority: P4)

**Goal**: Requesting a pattern TypeScript has made unnecessary returns idiomatic advice, as a success.

**Independent Test**: Request a known-obsolete pattern; confirm the response is advisory guidance with
an alternative and rationale, marked as advice, and not an error.

### Tests for User Story 4

- [ ] T061 [P] [US4] Advisory contract test in `test/contract/advisory.test.ts` asserting a success result with `kind: "advisory"`, a named alternative, a rationale, and no generated class hierarchy

### Implementation for User Story 4

- [ ] T062 [US4] Short-circuit advisory patterns in `src/engine/generate/index.ts` before option validation, per the validation order in data-model.md (FR-022)
- [ ] T063 [US4] Author advisory catalog entries — starting with `singleton` — across `data/patterns/*.json`, each with `alternative` and `rationale`
- [ ] T064 [US4] Extend `scripts/validate-catalog.ts` to enforce the advisory invariants: `kind: "advisory"` implies empty `options` and a present `advisory` block
- [ ] T065 [P] [US4] Surface `kind` in `list_patterns` output so an agent can skip the call entirely (FR-023)

**Checkpoint**: A category of actively harmful output is now impossible to request successfully.

---

## Phase 7: User Story 5 - Match the calling project's conventions (Priority: P4)

**Goal**: Output follows the caller's house style and is verified under the caller's own settings.

**Independent Test**: Submit the same request with two different convention sets; confirm each result
conforms to, and was verified against, the conventions supplied with it.

### Tests for User Story 5

- [ ] T066 [P] [US5] Conventions contract test in `test/contract/conventions.test.ts` asserting `verification.compilerOptions` reflects the caller's options, not ours
- [ ] T067 [P] [US5] Convention fixtures in `test/fixtures/conventions/` including `cjs-loose.json` and `esm-strictest.json`

### Implementation for User Story 5

- [ ] T068 [US5] Map `Conventions` onto compiler options in `src/engine/options/compiler-options.ts` — this mapping *is* the verification configuration, not decoration (FR-025)
- [ ] T069 [US5] Apply module style, import extensions, and type-import style in the render layer under `src/engine/render/`
- [ ] T070 [US5] Detect internally contradictory conventions and refuse, naming the conflict (spec edge case)
- [ ] T071 [US5] Verify under caller-supplied options and report the fully resolved conventions, including defaults, in the response (FR-007, FR-026)
- [ ] T072 [US5] Wire the caller's Prettier configuration into the format step in `src/engine/format/prettier.ts` (FR-024)

**Checkpoint**: Output arrives committable rather than needing cleanup.

---

## Phase 8: User Story 6 - Use the generator without an agent (Priority: P5)

**Goal**: The same generation from a terminal or script, byte-identical to the MCP surface.

**Independent Test**: Generate the same pattern and options through both surfaces and confirm
byte-identical results.

### Tests for User Story 6

- [ ] T073 [P] [US6] Parity test in `test/parity/surfaces.test.ts` comparing CLI `--json` output against MCP `structuredContent` byte-for-byte across a request matrix; divergence means generation logic leaked into an adapter (SC-010)

### Implementation for User Story 6

- [ ] T074 [US6] Implement `list`, `describe`, and `generate` argument parsing in `src/cli/index.ts` per contracts/cli.md, with one flag per tool field using identical names and values
- [ ] T075 [US6] Implement `--json` output mode emitting the `GenerateResult` structure verbatim on `stdout`
- [ ] T076 [US6] Implement file writing with `--out` and `--dry-run`, erroring on collision rather than overwriting silently
- [ ] T077 [US6] Implement exit codes 0, 1, 2, and 70, keeping `70` distinct because it means our defect rather than the caller's
- [ ] T078 [US6] Discover conventions from `tsconfig.json` and Prettier config in the **CLI adapter only**, passing explicit values inward so `generate()` stays pure
- [ ] T079 [US6] Add the `bin` entry to `package.json` and confirm the built binary runs from a clean install
- [ ] T080 [P] [US6] Document CLI usage in `README.md`

**Checkpoint**: All six user stories work independently. Delivery risk from MCP-only distribution is hedged.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T081 Implement the stateless Streamable HTTP transport in `src/mcp/transports/http.ts`, constructing a fresh server instance per request (FR-030, FR-031)
- [ ] T082 Resolve the open item on header validation: send a deliberately mismatched `Mcp-Method` and observe whether the SDK rejects it; if not, implement validation of `Mcp-Method`, `Mcp-Name`, and `MCP-Protocol-Version` against body values returning HTTP `400` with `-32020`. Assuming SDK coverage without testing it would be a conformance failure
- [ ] T106 Implement the remaining transport security requirements in `src/mcp/transports/http.ts`: validate `Origin` and `Host`, answer legacy `GET` and `DELETE` with `405`, and never mint, echo, or read a session identifier (FR-037). These are constitution MUSTs that the conformance suite alone will not necessarily catch
- [ ] T107 [P] Confirm external JSON Schema `$ref` resolution is disabled in the server's validator configuration and add a regression test in `test/contract/schema-refs.test.ts` (FR-039)
- [ ] T108 [P] Publish explicit cacheability on every result rather than relying on the SDK's conservative defaults, and assert it in `test/contract/cache-hints.test.ts` (FR-042)
- [ ] T109 [P] Assert in `test/contract/error-hygiene.test.ts` that no response ever contains compiler output, a stack trace, or a filesystem path, and that internal failures carry only a message plus a correlation identifier (FR-038)
- [ ] T110 [P] Add a `patterns` package script aliasing the built binary so the quickstart.md commands resolve before publication
- [ ] T083 [P] Add `conformance:stdio` and `conformance:http` scripts running `@modelcontextprotocol/conformance` against the frozen `2026-07-28` requirement set, and record any unmet requirement with an explicit justification (SC-011)
- [ ] T084 [P] Add a stdout-purity test in `test/contract/stdio-purity.test.ts` asserting `stdout` carries only well-formed protocol messages across a full session
- [ ] T085 [P] Add a response-budget test in `test/contract/budget.test.ts` asserting every pattern's `full` response stays within the budget documented in plan.md Performance Goals — 10,000 tokens typical, against the ~25,000-token point at which common agent hosts truncate. That figure lives in plan.md only; the test must read it from one place rather than restating it (SC-008)
- [ ] T086 Implement `verbosity` handling — `full`, `code-only`, `summary` — plus `nextSteps` stating what to request when content is omitted (FR-028)
- [ ] T087 Implement the oversized-result path: return a coherent subset plus an explicit statement of what was omitted and how to get it, never a silently truncated file (spec edge case)
- [ ] T088 [P] Author the remaining tier-1 patterns to reach at least 20, weighted toward type-level safety and async resilience — semaphore, async queue, debounce, branded types, discriminated unions, typestate, specification, unit of work, and others (SC-013)
- [ ] T089 [P] Add the agent skill surface under `skills/patterns/SKILL.md` driving the CLI, completing the third delivery surface (Principle X)
- [ ] T090 Resolve the published package name and add `server.json` with a `name` matching `package.json#mcpName`, since the registry's npm ownership check compares them exactly
- [ ] T091 [P] Generate pattern documentation from catalog data in `scripts/emit-docs.ts` rather than maintaining it by hand
- [ ] T092 [P] Add a CI workflow in `.github/workflows/ci.yml` running `pnpm check` on Node 20 and 22, with the engine/MCP boundary rule as a required gate
- [ ] T093 Build the agent evaluation set in `test/eval/` measuring first-attempt success (SC-006) and post-refusal recovery (SC-007) against a held-out task set, both targeting 90%
- [ ] T094 Settle the open item on response rendering: compare Markdown with path-headed fenced blocks against a serialized structure using the T093 evaluation set, and record the decision in research.md
- [ ] T095 Warm the compiler and formatter at startup and add a latency benchmark in `test/bench/` confirming verification is never the dominant request cost (SC-009)
- [ ] T096 Security review against FR-032 – FR-035: no `eval` or dynamic function construction, no network calls or credentials or install hooks in generated code, all paths derived from validated inputs, all caller values escaped in messages
- [ ] T097 [P] Add `LICENSE` and confirm every catalog entry's `license` field permits commercial modification (SC-012)
- [ ] T111 Remove `passWithNoTests` from `vitest.config.ts` once every suite has tests, so a suite that silently loses all of its tests fails the gate instead of passing it
- [ ] T098 Run all twelve quickstart.md scenarios end to end and record the results

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup; blocks every user story
- **US1 (Phase 3)**: depends on Foundational
- **US2 (Phase 4)**: depends on Foundational. Independently testable, but T045 authors catalog entries for the US1 patterns, so it is cheapest after US1
- **US3 (Phase 5)**: depends on Foundational. T053 measures a binding-only response against a full one, so a working full path (US1) must exist to compare against
- **US4 (Phase 6)**: depends on Foundational only. Genuinely independent — the advisory path short-circuits before generation
- **US5 (Phase 7)**: depends on Foundational. Independently testable, but its value is visible only once bundles are generated (US1)
- **US6 (Phase 8)**: depends on Foundational. T073 is a parity test, so it needs at least one working generation path
- **Polish (Phase 9)**: depends on the user stories being delivered. T106 depends on T081, since the transport must exist before its security requirements can be implemented against it
- **Transport note**: FR-030 requires both local and remote connections, but only stdio is delivered inside a user story; HTTP arrives in T081/T082/T106. That is deliberate — no user story's acceptance depends on the transport — but it means FR-030 is not satisfied until Phase 9, and the feature is not shippable before then

### Within Each User Story

Tests first and failing, then engine changes, then adapter changes. Never the reverse: an adapter
written before the engine is where generation logic leaks across the Principle X boundary.

### Parallel Opportunities

- T003, T004, T005 in Setup
- T007, T008, T011, T012, T013, T099, T100 in Foundational — different files, no shared state
- All US1 test tasks T025–T029
- The three pattern authoring tasks T034, T035, T036 — one directory each
- T048 and T049 in US2 — separate tool files
- Most Polish tasks marked [P], especially the pattern-authoring push in T088

---

## Parallel Example: User Story 1

```bash
# Write the failing tests together:
Task: "Contract test for generate_pattern happy path in test/contract/generate.test.ts"
Task: "Golden snapshot harness in test/golden/harness.ts"
Task: "Byte-equality harness in test/determinism/bytes.test.ts"
Task: "Refusal tests in test/contract/refusals.test.ts"
Task: "Concurrency isolation test in test/determinism/concurrency.test.ts"

# Then author the three patterns together:
Task: "result pattern in src/engine/patterns/result/"
Task: "retry pattern in src/engine/patterns/retry/"
Task: "circuit-breaker pattern in src/engine/patterns/circuit-breaker/"
```

---

## Implementation Strategy

### MVP: Phases 1–3

Setup, Foundational, then User Story 1. That yields three verified patterns reachable over stdio, with
determinism and golden coverage proven. Stop there and validate — if byte-identical, compile-verified,
test-passing output is not demonstrable at this point, no later phase rescues it.

### Incremental delivery

1. Phases 1–3 → MVP, demonstrable
2. Phase 4 (US2) → an agent can find and configure patterns unaided
3. Phase 5 (US3) → reuse compounds instead of duplicating
4. Phase 6 (US4) → harmful requests answered with advice
5. Phase 7 (US5) → output arrives committable
6. Phase 8 (US6) → CLI hedges the distribution risk
7. Phase 9 → conformance, budget, scale to 20+ patterns, publish

### Sequencing note

T088 — authoring the remaining patterns to reach 20 — sits in Polish deliberately. Pattern authoring
is the largest single body of work and the most parallelizable, but it is worth almost nothing until
the verification harness can prove each new pattern compiles and passes its own tests. Authoring first
would mean discovering systemic template problems 20 times instead of 3.

---

## Notes

- Tests are required here, not optional; Principle III makes verification the product
- Every task names its files; `[Story]` labels give traceability back to spec.md
- Commit per task or per logical group; stop at any checkpoint to validate a story independently
- The engine must never import MCP — if a task seems to require it, the design is wrong, not the rule
