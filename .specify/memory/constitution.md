<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (MINOR: new principles + materially expanded guidance)
- Modified principles:
  - III. Compile-Verified Output → III. Compile- and Test-Verified Output
    (generated tests must now execute and pass, not merely compile)
  - I. Determinism Above All (clarified: toolchain versions belong in response
    metadata, never in generated file content)
- Added principles: IX. Caller-Convention Conformance, X. Dual Delivery, One Engine
- Added sections: Content Licensing & Catalog Integrity, Toolchain Pinning
- Removed sections: none
- Deferred TODOs:
  - TODO(PUBLISHED_PACKAGE_NAME): the npm package name and reverse-DNS registry
    name are not yet chosen. The repository currently uses the placeholder
    `patterns`. Must be resolved before first publish because the MCP registry's
    npm ownership check requires `package.json#mcpName` to match
    `server.json#name` exactly.
-->

# Patterns MCP Constitution

An MCP server that generates deterministic, compile-verified, library-grade TypeScript
pattern implementations on request from AI coding agents.

## Core Principles

### I. Determinism Above All (NON-NEGOTIABLE)

Identical inputs MUST produce byte-identical output, forever.

- No language model, network call, or clock reading MAY participate in the generation path.
- Generated output MUST NOT contain timestamps, random values, UUIDs, hostnames, absolute
  paths, or the generator's own version string.
- Any iteration over an unordered collection MUST be given an explicit total ordering before
  it reaches a template. Relying on object key order is a defect.
- Identifier transforms (casing, pluralization) MUST be table-driven and pinned. `Person` MUST
  resolve to one documented plural, not whichever the library of the day prefers.
- The formatter and its configuration MUST be version-pinned, and formatting MUST be the final
  step of generation so whitespace can never vary by input path.
- Toolchain versions MUST be reported in response metadata so callers can audit what produced a
  bundle, and MUST NOT appear inside generated file content. Putting them in the files would make
  every dependency bump rewrite every previously generated file, destroying Principle II.

*Rationale*: Determinism is the product. It is what makes output cacheable, auditable,
reviewable in a diff, and trustworthy enough to commit. Any nondeterminism is a defect that
MUST fail loudly rather than degrade quietly.

### II. Diff-Stability

Regeneration MUST produce a reviewable diff.

- Changing one option MUST change only the code that option governs. Unrelated members MUST NOT
  reorder, reflow, or churn.
- Member ordering MUST be derived from a declared sort, never from the order options happened to
  be supplied.
- Optional features MUST be emitted as additive sections rather than by restructuring shared code.

*Rationale*: Determinism alone is insufficient. If enabling pagination rewrites an entire file,
reviewers stop reading the diff and users stop regenerating — which forfeits every downstream
benefit of the generator.

### III. Compile- and Test-Verified Output (NON-NEGOTIABLE)

The server MUST NOT return TypeScript that does not compile, nor tests that do not pass.

- Every generated bundle MUST typecheck before it leaves the process.
- When a bundle includes tests, those tests MUST execute and pass before the bundle is returned.
- Every response MUST carry a machine-readable verification record: compiler version, the exact
  compiler options used, diagnostic count, test outcome, and a content hash.
- A bundle that fails verification is a defect in this project, never the caller's problem. It
  MUST surface as an error result carrying a short message and a log correlation identifier.
- Raw compiler diagnostics and stack traces MUST NOT be returned to the caller.

*Rationale*: Verification is the moat. No comparable server verifies its emitted TypeScript at
all, and measured warm typecheck latency is low enough (single-digit milliseconds) that both
checking and running tests are effectively free relative to transport and agent round-trip cost.
"It compiles and its tests pass, deterministically" is a claim competitors cannot currently make.
Leaking diagnostics for code the agent did not write sends it off patching our bug instead.

### IV. Library-Grade, Reusable Implementations

Output is a module the caller adopts, not an example they read.

- Generated implementations MUST expose the complete method surface a production caller needs,
  with documented extension points — not a minimal illustrative subset.
- Every pattern that admits a core/instance split MUST be emittable as core machinery, as a thin
  binding against existing core machinery, or as both.
- The cost of the Nth use of a pattern in one codebase MUST approach the cost of the binding
  alone.
- Generated files MUST carry a provenance header naming the pattern and a deterministic hash of
  the resolved options, so later readers and agents can discover what is already installed.

*Rationale*: The value is not in producing a pattern once; it is in making that pattern cheap to
reuse for the rest of the codebase's life. A generator that emits a fresh copy per call is a
snippet service with extra steps.

### V. Total Function Over the Parameter Space

Every accepted input MUST map to exactly one valid output.

- Option combinations that cannot produce correct code MUST be rejected at the boundary.
- Rejections MUST name the offending field, state the governing rule as a general fact, and
  enumerate valid alternatives, so a caller can self-correct in one retry without a second
  discovery call.
- Silently accepting a nonsensical combination and emitting plausible-but-wrong code is the worst
  available outcome and MUST be treated as a defect.

*Rationale*: An agent ships what we hand it. A rejection costs one retry; broken accepted output
costs a production incident.

### VI. Idiomatic TypeScript, Including Refusal

Serving the right answer sometimes means serving no code.

- Patterns obviated by TypeScript's own features MUST return advisory guidance — the idiomatic
  replacement plus the reasoning — rather than a generated class hierarchy.
- Generated code MUST read as TypeScript written by a TypeScript engineer, not as a transliteration
  from another language.

*Rationale*: Emitting Java-in-TypeScript on request would make agent output measurably worse.
Declining, with a concrete alternative, is the higher-value response and is a capability no
comparable server currently offers.

### VII. Stateless by Construction

The server MUST hold no state between requests.

- No behavior MAY depend on a prior request, connection identity, or process lifetime.
- Any continuity across requests MUST be carried by an explicit identifier the caller passes on
  every call.
- Generation MUST remain a pure function of its validated inputs.

*Rationale*: This is both an MCP `2026-07-28` requirement and a free consequence of Principle I.
A pure generator scales behind a round-robin load balancer with no shared storage.

### VIII. Agent-First Interface

The primary consumer is a model with a finite context budget.

- Prefer few parameterized tools over many near-identical ones.
- Closed value spaces MUST be expressed as enums; identifiers exposed to callers MUST be
  human-readable, never opaque.
- Every schema field MUST carry a description, as that is the only documentation a model receives.
- Responses MUST respect a documented size budget, MUST offer caller-controlled verbosity, and MUST
  state what to call next when truncated.

*Rationale*: Tool ergonomics determine whether a capable generator is used correctly or ignored.
Description quality alone has been shown to move agent task performance materially.

### IX. Caller-Convention Conformance

Generated code MUST look like it belongs in the caller's repository.

- Callers MUST be able to supply their own conventions — compiler strictness flags, module and
  import-extension style, error handling style, test framework, and formatter configuration.
- Verification under Principle III MUST run against the caller's supplied options, not only our
  defaults. Code that compiles under `strict` but breaks under `noUncheckedIndexedAccess` is a
  defect we are capable of eliminating.
- Where the caller supplies nothing, defaults MUST be the strictest reasonable configuration.

*Rationale*: Output that must be reformatted or repaired on arrival is a tax that erodes the whole
value proposition. Because we already typecheck, we can verify against the caller's exact settings
— something competitors structurally cannot do, since they do not verify at all.

### X. Dual Delivery, One Engine

The generator MUST be usable without MCP.

- The generation engine MUST be a pure library with no MCP dependency.
- MCP server, command-line interface, and agent-skill surfaces MUST all be thin adapters over that
  one engine, and MUST NOT diverge in behavior.
- The MCP tool surface MUST stay small, returning a compact index and fetching detail on demand
  rather than advertising every option on every turn.

*Rationale*: Tool schemas consume context on every turn, and at least one major toolchain has
already removed most of its MCP tools for exactly this reason, arguing agents can drive a CLI as
well as humans can. Our defense is that we return a verified artifact an agent cannot produce
itself — but that defense only holds if the MCP surface stays cheap and the capability is reachable
by other means.

## Content Licensing & Catalog Integrity

Catalog content MUST be original or provably compatible with commercial redistribution and
modification.

- Content under NonCommercial or NoDerivatives terms MUST NOT enter this repository in any form.
  The most prominent pattern reference implementations are licensed NC-ND, which forbids exactly
  the parameterization this project performs.
- Unlicensed sources ("all rights reserved" by default) MUST NOT be copied or adapted.
- Every catalog entry MUST record its provenance, and license compatibility MUST be auditable in
  review.
- The catalog MUST be maintained as validated structured data with a published schema, not as prose
  embedded in code, so entries can be checked mechanically and contributed independently.

*Rationale*: There is no importable, license-compatible TypeScript pattern catalog, so authoring is
unavoidable. That cost is also the most durable moat available here — but only if the catalog stays
clean, since a single NC-ND import would poison commercial redistribution.

## Toolchain Pinning

Determinism holds only for a pinned toolchain, so pinning is a correctness requirement rather than
a preference.

- The compiler and formatter MUST be pinned to exact versions, never to a range.
- Any dependency capable of changing generated bytes MUST be treated as part of the public
  contract, and upgrading it MUST produce a reviewable snapshot diff.
- Pre-release or explicitly unstable compiler APIs MAY be used for speed, but only behind a stable
  fallback path, and the choice MUST be revisited when a stable API ships.

## Protocol & Security Requirements

**Protocol conformance.** The server targets MCP revision `2026-07-28` and the v2 TypeScript SDK.
It MUST implement `server/discover`; MUST publish real cache hints rather than accepting the SDK's
conservative defaults; MUST validate `Origin` and `Host`; MUST reject header/body mismatches on
Streamable HTTP; MUST answer legacy `GET`/`DELETE` with `405`; and MUST NOT mint, echo, or read
session identifiers. Deprecated primitives — Roots, Sampling, and the `logging` capability — MUST
NOT be adopted. Diagnostics on stdio MUST go to `stderr`, never `stdout`.

**Error discipline.** Tool handlers MUST return error results explicitly rather than throwing, since
the SDK converts every thrown exception into a tool error and throwing forfeits control of the
message.

**Generation security.** Generated output is written to the caller's disk and read into a model's
context, so both are treated as attack surfaces:

- Every caller-supplied identifier MUST be validated against a strict pattern and a reserved-word
  denylist at the schema boundary, and every string MUST be length-capped.
- File paths MUST be derived from validated identifiers by a pure function. Path-shaped arguments
  MUST NOT be accepted.
- The generation path MUST NOT use `eval`, dynamic function construction, subprocesses, or any
  template feature permitting arbitrary expression evaluation.
- Generated code MUST NOT contain network calls, credentials, or install-time hooks.
- Caller-supplied values MUST be escaped or elided before appearing in error messages.
- External JSON Schema `$ref` resolution MUST remain disabled.

## Development Workflow & Quality Gates

Work follows spec-driven development: specification and plan precede implementation, and material
scope changes return to the spec rather than accumulating in code.

Every change MUST pass, in CI:

1. **Typecheck and lint** under `strict`.
2. **Unit and contract tests**, driven through an in-process MCP client so both transports are
   covered without sockets or subprocesses.
3. **Determinism tests** — generating the same inputs twice MUST yield byte-identical output, and
   golden-file snapshots MUST cover every documented option combination.
4. **Diff-stability tests** — toggling a single option MUST produce a diff bounded to that option's
   surface.
5. **Compile and test verification** — every golden bundle MUST typecheck, and every golden bundle
   containing tests MUST have those tests pass.
6. **Protocol conformance** — the official MCP conformance suite MUST pass against the frozen
   `2026-07-28` requirement set. Known gaps MUST be explicitly baselined, never ignored.
7. **Catalog validation** — every catalog entry MUST validate against the published schema and
   carry provenance and license fields.
8. **Surface parity** — the CLI and MCP surfaces MUST be exercised against the same engine and
   MUST agree.

A pattern is not "done" until it has golden coverage across its documented option combinations, a
passing compile-and-test check, documented options with stated legality rules, recorded provenance,
and — where applicable — a working binding-only emit path.

## Governance

This constitution supersedes ad-hoc practice. Where a decision conflicts with a principle above,
the principle wins or the constitution is amended first.

**Amendment procedure.** Amendments require a written rationale, a version bump under the policy
below, and an update to any gate the amendment affects. Principles marked NON-NEGOTIABLE MUST NOT
be relaxed by amendment; they may only be removed by explicitly redefining the project's purpose,
which is a MAJOR change.

**Versioning policy.** MAJOR for backward-incompatible removals or redefinitions of principles or
governance; MINOR for a new principle or materially expanded guidance; PATCH for clarification and
wording.

**Compliance review.** Every pull request MUST be reviewable against these principles, and the CI
gates above are the enforcement mechanism. Any complexity that appears to violate a principle MUST
carry a written justification in the pull request or be removed.

**Version**: 1.1.0 | **Ratified**: 2026-08-09 | **Last Amended**: 2026-08-09
