# Implementation Plan: TypeScript Pattern Generation Service

**Branch**: `001-typescript-pattern-mcp` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-typescript-pattern-mcp/spec.md`

## Summary

Build a deterministic generator that turns a pattern name plus structured options into a verified,
library-grade TypeScript bundle, and expose it to AI coding agents over MCP as well as to humans over
a CLI.

The technical approach is a pure generation engine with three thin adapters. Patterns are authored as
tagged template literals in TypeScript — not a template DSL — so that template parameters are
typechecked by the compiler and there is no HTML-escaping layer to silently corrupt generics. Output
is formatted by an exactly pinned Prettier, then verified in-process: every bundle is typechecked
against the caller's own compiler options, and any bundle containing tests has those tests executed,
before anything is returned. Verification is affordable because a warmed TypeScript 7 compiler API
checks a four-file bundle in single-digit milliseconds.

## Technical Context

**Language/Version**: TypeScript 7.0.2, pinned exactly. Node.js >= 20 (developed on 22.20).

**Primary Dependencies**:

- `@modelcontextprotocol/server` 2.0.0 — the v2 SDK line implementing spec revision `2026-07-28`.
  Note this is *not* `@modelcontextprotocol/sdk`, which is the 1.x monolith still tagged `latest`.
- `zod` 4.4.3 (`zod/v4` import surface) — the single source of truth for tool input/output schemas.
- `prettier` 3.9.6, pinned exactly — output formatting.
- `typescript` 7.0.2, pinned exactly — used both as our own build compiler and, via
  `typescript/unstable/async` plus `typescript/unstable/fs`, as the verification engine.
- `vitest` 4.1.10 — our test runner, and the default framework for generated tests.
- `tsdown` — build. Chosen during scaffolding because `tsup`'s declaration generator cannot run
  against TypeScript 7.

- `oxlint` 1.77.0, pinned exactly — linting. ESLint is not usable here: `typescript-eslint` caps at
  `typescript <6.1.0` and we are pinned to 7.0.2. See research.md §12.

Dev-only: `@modelcontextprotocol/conformance` (0.1.16) and `@modelcontextprotocol/inspector` (2.1.0).

**Storage**: None. The service is a pure function over its inputs and holds no cross-request state.
The pattern catalog is versioned JSON data in the repository, validated against a published schema.

**Testing**: Vitest, driven through the SDK's in-process MCP client for both transports; golden-file
snapshots covering every documented option combination; a determinism harness asserting byte
equality across repeated runs and process restarts; a diff-stability harness asserting single-option
changes produce bounded diffs; and the official MCP conformance suite against the frozen
`2026-07-28` requirement set.

**Target Platform**: Node.js 22.13+ for stdio (local agent hosts) and for stateless Streamable HTTP
(remote hosting). Verification requires a native compiler binary, so the HTTP surface targets Node
rather than edge runtimes.

**Project Type**: Single published package exposing three entry points — engine library, MCP server,
and CLI binary.

**Performance Goals**: Warm verification under 5ms per bundle (typecheck measured at ~2.4ms via the
async API); end-to-end generation p95 under 50ms excluding transport; typical response comfortably
under 10,000 tokens.

**Constraints**: Byte-identical output for identical inputs, permanently. No `eval`, dynamic function
construction, or subprocess execution of caller content. No state between requests. Responses budgeted
well below the ~25,000-token point at which common agent hosts truncate tool results.

**Scale/Scope**: 20 patterns at first release, drawn from the type-safety and async-resilience
families; roughly 95 catalogued over time, including advisory-only entries.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

Evaluated against constitution v1.1.0.

| # | Principle | Gate | Pre-design | Post-design |
|---|---|---|---|---|
| I | Determinism | No model, clock, or randomness in the generation path; explicit ordering everywhere; toolchain pinned exactly | PASS | PASS |
| II | Diff-Stability | Optional features emitted as additive sections; member order from a declared sort | PASS | PASS |
| III | Compile- and Test-Verified | Every bundle typechecked; bundles with tests executed; verification record returned | PASS | PASS |
| IV | Library-Grade, Reusable | Complete method surfaces; `emitScope` of full/core/binding; provenance header | PASS | PASS |
| V | Total Function | Flat schema plus explicit legality rules; illegal combinations refused with self-correcting messages | PASS | PASS |
| VI | Idiomatic, Including Refusal | Superseded patterns return `kind: "advisory"`, not code and not an error | PASS | PASS |
| VII | Stateless | Pure function; fresh server instance per HTTP request; continuity only via caller-supplied values | PASS | PASS |
| VIII | Agent-First | Three tools plus one resource; enums for closed value spaces; every field described; verbosity control | PASS | PASS |
| IX | Caller-Convention Conformance | Conventions accepted as input and used as the verification configuration | PASS | PASS |
| X | Dual Delivery, One Engine | Engine has no MCP import; MCP, CLI, and skill are adapters; parity enforced in CI | PASS | PASS |
| — | Content Licensing | Catalog authored originally; NC/ND material excluded; per-entry provenance and license fields | PASS | PASS |
| — | Toolchain Pinning | Compiler and formatter pinned exactly; unstable API used only behind a stable fallback | PASS (see Complexity Tracking) | PASS |

No unjustified violations. The single item requiring justification is recorded in Complexity
Tracking.

Two columns, and both say what was decided rather than what is built — this table is the design gate, not
a status board, and reading it as one is a mistake worth heading off. Where the two differ today:

- **Principle X** names three adapters. Two exist: the MCP server, and the CLI, whose `--json` output is
  compared byte-for-byte against `structuredContent` by `test/parity/`. The agent skill is not built
  (T089). The row is a PASS about a design that admits three adapters over one engine — which it does, and
  the CLI was written against the same engine entry points with no new ones added — not a claim that all
  three ship.
- **Principle VI** is satisfied as designed: advisory patterns return `kind: "advisory"`, and there are
  seven of them.

Anything else asserted here is checked by `pnpm check`, which is the only status board that cannot go
stale: lint, typecheck, the emitted catalogue schema, catalogue validation, every suite, the build, and a
smoke run of all three published entry points against the built artifact.

## Project Structure

### Documentation (this feature)

```text
specs/001-typescript-pattern-mcp/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions with rationale and alternatives
├── data-model.md        # Phase 1 output — entities, fields, validation, state
├── quickstart.md        # Phase 1 output — runnable validation scenarios
├── contracts/           # Phase 1 output — tool, resource, CLI, and engine contracts
│   ├── mcp-tools.md
│   ├── mcp-resources.md
│   ├── cli.md
│   └── engine-api.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (already complete)
└── tasks.md             # Phase 2 output — created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
src/
├── index.ts                  # Public engine API. MUST NOT import anything MCP-related.
├── engine/
│   ├── catalog/              # Load + validate catalog data; filter and lookup
│   ├── patterns/             # One directory per pattern: template, options, legality, metadata
│   ├── options/              # Shared base option schema, defaults, resolution, legality engine
│   ├── render/               # Tagged-template helpers: dedent, indent, when, joinLines, sortBy
│   ├── format/              # Prettier wrapper; caller config merge
│   ├── verify/               # Typecheck (unstable/async) + test execution + stable fallback
│   └── provenance/           # Deterministic options hash and header emission
├── mcp/
│   ├── server.ts             # McpServer construction, cache hints, tool + resource registration
│   ├── tools/                # list_patterns, describe_pattern, generate_pattern
│   ├── resources/            # pattern://catalog and pattern://catalog/{name}
│   └── transports/           # stdio and stateless Streamable HTTP entry points
└── cli/
    └── index.ts              # CLI adapter over the same engine

data/
├── schema.json               # Published catalog schema
└── patterns/                 # Catalog shards, one file per category

test/
├── unit/                     # Engine internals: options resolution, legality, provenance, render
├── contract/                 # Tool and resource contracts via in-process MCP client
├── golden/                   # Snapshot bundles per pattern × option combination
├── determinism/              # Byte-equality and diff-stability harnesses
└── parity/                   # CLI vs MCP equivalence
```

**Structure Decision**: A single published package with three entry points (`.` for the engine,
`./mcp` for the server, and a `bin` for the CLI) rather than a workspace of separate packages.

Rationale: one package means one npm name, which keeps the MCP registry's ownership check — which
matches `package.json#mcpName` against `server.json#name` — simple, and avoids workspace tooling
overhead at this size. The constitutional requirement that the engine not depend on MCP (Principle X)
is therefore enforced by a lint boundary rule rather than by package topology, and that rule is a
required CI gate rather than a convention. If the engine ever needs to ship independently, the
directory split above makes extraction mechanical.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Depending on an explicitly unstable compiler API (`typescript/unstable/async`) | Verification must be cheap enough to run on every request, including executing generated tests. The unstable API checks a four-file bundle in ~2.4ms warm versus ~6.3ms for the stable 6.x path — and the stable TypeScript 7 API does not ship until 7.1. | Staying on the 6.x `createProgram` API costs ~2.6× per check and requires a second compiler in the dependency tree alongside the 7.x one we already build with. The constitution's Toolchain Pinning section permits an unstable API only behind a stable fallback, which is exactly what is planned. |
| Two verification paths (unstable primary, stable fallback behind a flag) | The unstable API is expected to break; a fallback keeps the verification gate — which is non-negotiable under Principle III — available when it does. | A single path means any upstream break disables the project's core guarantee. The fallback is small because both paths reduce to "given files and options, return diagnostics." |
