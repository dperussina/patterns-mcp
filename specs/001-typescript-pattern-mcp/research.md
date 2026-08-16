# Phase 0 Research: TypeScript Pattern Generation Service

**Date**: 2026-08-09 | **Plan**: [plan.md](./plan.md)

All Technical Context items are resolved; no `NEEDS CLARIFICATION` markers remain. Findings below are
grounded in the current specification text, the v2 SDK documentation, and measurements taken on
Node 22.20 / darwin arm64 against a representative four-file bundle.

---

## 1. Protocol revision and SDK line

**Decision**: Target MCP revision `2026-07-28` using `@modelcontextprotocol/server` 2.0.0.

**Rationale**: `2026-07-28` is the current revision and it is stateless — the `initialize`/
`initialized` handshake and `Mcp-Session-Id` are gone, per-request `_meta` carries protocol version
and client capabilities, and `server/discover` is mandatory. A deterministic generator is inherently
stateless, so this revision costs us nothing while the same migration is significant work for
stateful servers. The v2 SDK line is the one that implements it.

**Alternatives considered**: `@modelcontextprotocol/sdk` 1.30.0 — still the npm `latest` tag, which
makes it the likely accidental choice, but it is the older monolith and does not target this revision.
Rejected.

**Revised**: supporting both eras was originally recorded here as rejected scope, and what ships serves
both. `serveStdio` owns the era decision and defaults to `legacy: 'serve'`, so an `initialize` request —
or any request carrying no version claim — opens a 2025-era session from the same factory, while a request
carrying the modern `_meta` envelope is served statelessly. That is the revision's own dual-era shape and
it costs nothing here, because the server holds no state for either era to keep: the same three tools
answer both. It is kept rather than switched off, since a legacy client has no fall-forward mechanism —
if `initialize` were refused it could not discover that a modern path existed.

**Consequences**: `clientInfo` is only a SHOULD, so handlers must tolerate its absence and must never
branch on client identity. Roots, sampling, and the `logging` capability are deprecated and will not
be adopted; diagnostics go to `stderr`.

**Two constants in this SDK invite a wrong conclusion, and both did.** `LATEST_PROTOCOL_VERSION` is
`2025-11-25` and `SUPPORTED_PROTOCOL_VERSIONS` does not contain `2026-07-28`: they enumerate the *legacy*
revisions, and the modern one is held separately as `FIRST_MODERN_PROTOCOL_VERSION`. Read as a ceiling,
they say the SDK cannot speak the revision — which is how a comment claiming exactly that came to sit in
`server.ts` above a declaration that was working, and how a test came to gate the wire assertions for the
revision's cache fields on a list that can never contain it. Separately, the SDK's *client* defaults to
`versionNegotiation: 'legacy'`, so a contract suite that connects a client without opting in exercises the
older protocol throughout while appearing to test the server as it is deployed. Anything asserting the
revision has to open the era deliberately — `{ pin: '2026-07-28' }`, which fails loudly, rather than
`'auto'`, which falls back to `initialize` and hands back a legacy session under a modern name.

---

## 2. Tool surface shape

**Decision**: Three tools — `list_patterns`, `describe_pattern`, `generate_pattern` — with `pattern`
as a closed enum, plus the catalog mirrored as a cacheable resource. Not one tool per pattern.

**Rationale**: Three independent lines of evidence converge. Twenty near-identical tool schemas would
occupy context on every turn, which is the documented failure mode behind large measured token
reductions when tool definitions are fetched on demand instead of loaded eagerly. A closed enum of
pattern names is more legible to a model than twenty tool names because every valid option is visible
at the moment of choice. And the pattern options are overwhelmingly *shared* — error mode, sync/async,
cancellation, runtime, dependency posture — so per-pattern tools would duplicate one schema twenty
times.

**Alternatives considered**: One tool per pattern — rejected for the reasons above. A single mega-tool
whose options are a precise discriminated union over patterns — rejected because it compiles to a
large `oneOf`, and the specification explicitly warns that composition keywords are expensive to
validate and directs implementations to bound schema depth and subschema count. Tools split by
category — rejected as a compromise that keeps the duplication without removing the union.

**Consequences**: The schema stays flat, so pattern-specific legality cannot be expressed in JSON
Schema and must be enforced in the handler. This raises the quality bar on error messages, which is
why Principle V mandates that rejections name the field, state the rule, and enumerate alternatives.

---

## 3. Template mechanism

**Decision**: Hand-authored tagged template literals in TypeScript, with a small helper set
(`dedent`, `indent`, `when`, `joinLines`, `sortBy`). No template engine.

**Rationale**: Two decisive reasons. First, every mainstream engine HTML-escapes by default, which
silently corrupts exactly the code we emit — `Map<string, Array<number>>` becomes
`Map&lt;string, Array&lt;number&gt;&gt;`, and Handlebars escapes `=` as well. That is a permanently
loaded footgun in a generics-heavy generator. Second, template literals are *typechecked*: renaming an
option breaks our build immediately, whereas an engine would interpolate `undefined` into output that
often still compiles, so the defect escapes.

Measured render latency was under 0.01ms for every engine, so performance is irrelevant to this choice
— it is roughly 200× cheaper than the verification that follows.

**Alternatives considered**: Eta 4.6 with `autoEscape: false` — the best engine option, TypeScript-
native, actively maintained, with a global rather than per-tag escape switch; retained as the fallback
if templates ever need to become swappable data or be contributed by non-TypeScript authors. EJS —
rejected for per-tag escaping with no global off switch, a broken ESM surface, and no first-party
types. Handlebars — best whitespace handling and genuinely sandboxed, but logic-less templates are a
poor fit and sandboxing is irrelevant for templates we author ourselves. Nunjucks — rejected as
abandoned (last published 2023, 358 open issues).

---

## 4. Verification: typechecking

**Decision**: `typescript/unstable/async` with a custom virtual file system, one long-lived API
instance warmed at startup, passing `fileChanges.changed` on every snapshot update. A TypeScript 6.x
`createProgram` path stays behind a flag as fallback.

**Rationale**: Widely repeated claims that TypeScript 7.0 has no programmatic API are misleading —
`typescript@7.0.2` ships one under an explicit `unstable/` namespace, exporting `API`, `Program`,
`Project`, `Checker`, and a virtual-filesystem factory. It caught 8/8 injected type errors with no
false positives across 32 clean bundles. Measured: 21ms cold, **1.8ms warm median** for the sync
variant and **2.4ms warm** for async, against 6.3ms for the stable 6.x path and 26ms for
`@typescript/vfs`. Warm reuse is the whole game — a 12× difference — so the API instance must be
long-lived.

**The async variant is mandatory, not a preference.** The sync variant is backed by a native
synchronous RPC module and completely pins the event loop: probing with a 1ms interval during 40
sequential checks recorded **zero** event-loop ticks across 48ms of work. A server using it could not
service concurrent requests. Paying ~1.7× per check to keep the loop responsive is obviously correct.

**Alternatives considered**: `@typescript/vfs` — rejected outright; its default lib-map helper fails
against TypeScript 7 because `lib.*.d.ts` files moved out of `node_modules/typescript/lib` into
platform binary packages, and it is also the slowest option by roughly 10×. `ts-morph` 28 — bound to
the 6.x compiler, 4–7ms warm only if the `Project` is reused (20.7ms if not), and worth adopting only
if we needed AST manipulation, which we do not. Stable 6.x `createProgram` — retained as the fallback,
not the primary.

**Consequences**: Verification is not truly in-process; the API spawns a compiler binary over IPC, so
we own a subprocess lifecycle including warm-up and restart-on-crash. One documented trap to encode:
the virtual FS `readFile` is tri-state, and returning `null` for unknown paths blocks lib resolution
and produces a cascade of misleading "Cannot find name" errors — lib paths must return `undefined` to
fall through to disk.

---

## 5. Verification: executing generated tests

**Decision**: Execute the tests in a generated bundle before returning it, and report the outcome in
the verification record.

**Rationale**: At roughly 570 typechecks per second, there is headroom to do more than compile. No
comparable service verifies its emitted TypeScript at all, so "it compiles and its tests pass,
deterministically" is a claim no competitor can currently make. It also directly protects the
edge-case behavior that motivates the highest-value patterns — half-open probe sampling, fairness
under cancellation, dropped-call semantics — which is precisely what a generator should be trusted on.

**Alternatives considered**: Typecheck only — cheaper but forfeits the strongest available trust
signal. Verifying only in CI across all combinations — necessary regardless (it is a required gate)
but insufficient, because caller-supplied conventions produce combinations CI never saw.

**Consequences**: Types of anything a generated test imports must be vendored or stubbed, or module
resolution fails. Test execution must be sandboxed and bounded by a timeout, and must never run
caller-supplied content.

---

## 6. Formatting

**Decision**: Prettier 3.9.6, pinned exactly, with optional caller-supplied configuration merged in.

**Rationale**: Prettier is what consumers already run, so output merges without reformat churn.
Measured at 1.57ms warm median — irrelevant beside a 2.4ms typecheck. Its programmatic API has been
stable since 3.0 in 2023. Accepting the caller's Prettier config is a differentiator no existing
codegen MCP server offers, and it follows directly from Principle IX.

**Alternatives considered**: Biome — fastest measured (0.51ms) and its formatter matched Prettier
byte-for-byte on the larger sample *once `indentStyle` was set*, but it **defaults to tabs**, which
would emit tabs into space-indented repositories; its JS API also shipped five majors between mid-2025
and mid-2026, on precisely the surface we would depend on. Rejected. dprint — fastest and clean, but
diverges from Prettier defaults (omits arrow parens, keeps constructor params inline) and has far less
ecosystem gravity. Rejected as primary.

**Consequences**: None of the three promise byte-stability across versions, and Prettier ships
formatting changes in minor releases. Hence exact pinning, formatter name and version in the response
metadata, and snapshot coverage of every combination so a bump surfaces as a reviewable diff.

---

## 7. Reuse model

**Decision**: Three artifact roles — core machinery, per-type binding, and adapter — selected by an
`emitScope` of `full`, `core-only`, or `binding-only`, with a `coreModule` specifier identifying where
existing machinery lives. Generated files carry a provenance header naming the pattern and a
deterministic hash of resolved options.

**Rationale**: This is what makes the fifth use of a pattern cheap rather than a near-duplicate file,
which is the project's central value claim. It also fits the protocol precisely: the specification
requires that state spanning requests be referenced by an explicit identifier the caller passes on each
request, so a caller-supplied `coreModule` is the sanctioned design rather than a workaround. The
provenance header lets a later agent discover what is already installed by reading the repository,
making the cheap path self-service.

**Amended**: the header is per-pattern except on a support file every pattern emits identically at one
path, which is marked shared and names neither pattern nor options. Reuse across patterns is part of
this decision and a per-pattern header defeated it: it made such a file differ per request, so two
bundles in one directory overwrote each other instead of coinciding. Discoverability is unaffected,
since a file shared by every pattern reveals nothing about which are installed.

**Alternatives considered**: Server-side memory of what a caller has installed — forbidden by
statelessness and impossible behind a load balancer. Always emitting everything — produces duplicate
machinery and, for larger patterns, risks the response budget. Embedding our generator version in the
header — rejected, because it would rewrite every previously generated file on every release and
destroy diff-stability; the header carries pattern identity and an options hash only, with toolchain
versions confined to response metadata.

---

## 8. Catalog sourcing and licensing

**Decision**: Author the catalog originally, stored as JSON shards validated against a published
schema, with per-entry provenance and license fields.

**Rationale**: There is no importable catalog. The most prominent TypeScript pattern implementations
are licensed CC BY-NC-**ND** — NonCommercial forbids a commercial product and NoDerivatives forbids
parameterizing them into templates, which is precisely what this project does. The largest
alternative repository (48k stars) carries no license at all, meaning all rights reserved. The one
MIT-licensed option has been unmaintained since 2023 and is classroom-grade. Authoring is therefore
unavoidable — and is also the most durable moat available, since it is the one component a competitor
cannot copy.

**Alternatives considered**: Importing or adapting existing pattern code — legally foreclosed.
Scraping prose descriptions — content-usage policies cap this at non-substantial excerpts with
attribution, and it would not yield the parameterized implementations we need.

**Consequences**: A structured-data catalog architecture is worth borrowing even though no content is:
JSON shards per category validated in CI, typed cross-pattern relationships, separate examples, and
per-entry verification status, with documentation generated from the data rather than hand-maintained.

---

## 9. Pattern selection for first release

**Decision**: 20 patterns weighted toward type-level safety and async resilience. Patterns that
TypeScript's own features supersede are catalogued as advisory-only.

**Rationale**: A frontier model writes a correct Strategy or Observer unaided, so classical catalog
completeness is a demo rather than a product. Roughly a third of the classical 23 collapse into
closures, discriminated unions, or built-in language features, and generating class hierarchies for
them would make agent output actively worse — emitting Java-in-TypeScript is a documented failure
mode. The value concentrates where implementations have a small variable surface, no runtime
dependencies, and fiddly edge cases: retry with jitter, circuit breaker, semaphore, async queue,
debounce, cancellation plumbing, `Result`, branded types, discriminated unions, typestate, repository.

**Alternatives considered**: All 23 classical patterns first — rejected as the least valuable thing we
could generate. The full ~95-pattern catalog at once — rejected as unshippable; tiering keeps the
first release verifiable end to end.

---

## 10. Delivery surfaces

**Decision**: One engine, three adapters — MCP server (stdio and stateless Streamable HTTP), CLI, and
an agent skill. Engine code may not import MCP; a lint boundary rule enforces this as a CI gate.

**Rationale**: A major toolchain deliberately removed most of its MCP tools, arguing that tool schemas
tax context on every turn and that modern agents can drive a CLI as competently as humans. Published
measurements show multi-server setups consuming tens of thousands of tokens before a conversation
starts. Our defense is that we return a *verified artifact* an agent cannot produce itself — but that
holds only if the MCP surface stays small and the capability is reachable another way. Since the
generator is a pure function, dual delivery is nearly free.

**Alternatives considered**: MCP-only — rejected as the single most likely reason this project fails to
get adopted. CLI-only — forfeits the agent-native ergonomics that motivate the project.

---

## 11. Verifying bundles that import code we do not emit

**Decision**: For a `binding-only` request, regenerate the core module deterministically into the
verification file system at the caller-supplied `coreModule` specifier, typecheck the binding against
it, then discard the stub from the emitted bundle.

**Rationale**: This is the one place where Principle III and Principle IV appear to collide — a binding
imports from the caller's repository, which the verifier cannot see, yet no bundle may be returned
unverified. Determinism resolves it: because the same options produce the same core bytes forever, we
can reconstruct exactly what the caller must already have. Verification then covers the *real* compiled
shape rather than the binding in isolation.

It also converts a hard edge case into a detected one. If the caller's installed core was generated
under different options, the regenerated stub differs and the binding fails to typecheck — which is
precisely the "caller points at machinery that does not match what the pattern expects" case the spec
requires be refused with an explanation rather than answered with uncompilable code.

That check has a cheaper counterpart the caller can run first, and for a while it did not work. The
machinery's provenance marker is meant to say which options it was generated under, so an agent can compare
an installed core against what a new binding needs without a compile. The marker hashed the whole request,
including the entity — so two cores generated under identical options disagreed whenever the entities
differed, and the comparison reported a mismatch that was not there. Worse, it made the machinery's bytes
vary per request, so a project's second repository rewrote the first's core with an identical file under a
different header. The marker now covers only what can shape the machinery (FR-050), which is what makes
both the cheap comparison and side-by-side installation work.

**Alternatives considered**: Typechecking the binding with the core import declared as `any` — rejected
because it verifies nothing about the seam that is most likely to be wrong. Requiring the caller to
paste their existing core module into the request — rejected as a large token cost for information we
can reconstruct, and it would make output depend on caller-supplied code we must not trust. Exempting
binding-only bundles from verification — rejected outright; Principle III is non-negotiable, and the
reuse path is the one we most want callers to trust.

**Consequences**: The core must be renderable without being emitted, so rendering and emission are
separate steps in the pipeline. `contentHash` covers emitted files only, never the discarded stub.

Placing the stub at the specifier's own resolution also decides where the *bundle* has to sit. Written at
the sandbox root, a specifier that climbs — `../lib/core.js`, which is what a binding in `src/orders`
writes to reach a core in `src/lib` — resolves above the root, where nothing may be written and the
compiler would find nothing to read. That was refused for a time, which quietly excluded the commonest
real layout: the split exists for a project that keeps machinery in one place and bindings in another, and
those are different directories. The bundle is therefore placed as many levels down as the specifier
climbs, so the climb resolves inside the root and needs no special case; the depth is bounded, since a
specifier climbing further than a few levels has left the project rather than described it. Placement is a
verification device and never reaches the caller: the emitted binding carries the specifier they gave,
which is the same invariant this section already rests on — the bytes verified are the bytes returned.

---

## 12. Linter

**Decision**: `oxlint`, pinned exactly. Not ESLint.

**Rationale**: Forced, not preferred. `typescript-eslint` requires `typescript >=4.8.4 <6.1.0` on both
`latest` and `canary`, and we are pinned to 7.0.2 — so there is no ESLint path to linting TypeScript in
this project. The cause is the same rewrite that shapes our verification design: TypeScript 7 is the
native compiler port, `typescript-eslint` needs the classic compiler API for type-aware rules, and the
API we exploit for fast verification is the API that broke it.

`oxlint` is Rust-based with no TypeScript dependency, so the conflict cannot recur, and it declares an
optional peer on `oxlint-tsgolint@7.0.2001` — a version tracking the TypeScript 7 toolchain — which is
where type-aware linting for this compiler appears to be heading.

Verified against deliberate violations before adopting:

| Rule | Result |
|---|---|
| `no-restricted-imports` scoped by `overrides.files` | Flags `src/engine/**`, leaves `src/mcp/**` alone — the Principle X boundary, correctly scoped |
| `no-restricted-globals` (`process`) | Flagged |
| `no-restricted-properties` (`Date.now`, `Math.random`) | Flagged, with custom messages |
| `no-restricted-syntax` | **Unsupported** — configuration fails to build |

**Alternatives considered**: Installing a second, older TypeScript purely to satisfy
`typescript-eslint` — rejected; two compilers in one tree is precisely the complexity the Toolchain
Pinning section exists to prevent, and it would leave lint checking a different language version than
the one we ship. Biome as linter alongside Prettier as formatter — workable, but Biome's JS API churn
was already grounds for rejecting it as our formatter, and adopting it for lint only would mean two
Rust toolchains where one suffices. Dropping the lint gate and enforcing the boundary purely by test —
rejected because Principle X's boundary is a structural guarantee that should fail at the earliest
possible moment, and the constitution names lint as a CI gate.

**Consequences**: `no-restricted-syntax` being unavailable means T024's determinism guard cannot express
structural checks as lint rules. This costs nothing: the three supported rules cover the outright bans,
and the check that never fit a lint rule anyway — unordered iteration reaching a template — belongs in
the test-based half of that task. Lint plugin choice is not output-affecting, but oxlint is pinned
exactly regardless, so a release that adds rules cannot redden the gate on an unrelated day.

---

## 13. The model seam for LLM patterns

**Decision**: LLM patterns generate against a minimal `ChatModel` port of our own, defined as the subset
common to every mainstream provider abstraction, with vendor shapes reached through generated adapter
files. No pattern imports a provider SDK, and no pattern reproduces a versioned vendor interface.

**Rationale**: Three independent findings point the same way.

The first is forced by Principle III. The verification file system resolves exactly one third-party
module — the `vitest` shim — plus a handful of `node:test` and `node:assert` declarations. A pattern
importing `openai`, `@anthropic-ai/sdk`, or `@ai-sdk/provider` could never typecheck, so it could never
be returned. Provider-agnosticism is not a design preference here; it is the only shape that can pass
the gate.

The second is that the leading TypeScript abstraction is a moving target. Vercel's provider
specification was `LanguageModelV2` in AI SDK 5, `V3` shortly after, and `V4` in AI SDK 7 — the current
middleware reference is titled `LanguageModelV4Middleware` while still served from a `…-v2-middleware`
URL, and `wrapLanguageModel` now accepts all three versions and up-converts. Cloning any one of those
would date every bundle we emit and, worse, would make a generator upgrade change generated bytes for
reasons the caller never asked for, which is precisely what SC-005 exists to prevent.

The third is that the *subset* is stable even though the specifications are not. What survives
unchanged across AI SDK V2/V3/V4, .NET's `IChatClient`, MCP's own sampling shape, and the
OpenAI-compatible wire format that LiteLLM normalises to is a short list: a message array with
`system`/`user`/`assistant`/`tool` roles; content as a discriminated union of text, tool call, and tool
result parts; tool definitions carrying a name and a JSON-Schema input shape; a tool-choice control
with `auto`/`none`/`required`/named-tool modes; a stop-or-finish reason; token usage as input, output,
and total counts; a cancellation signal; non-fatal warnings; the generate-versus-stream duality; and an
untyped bag for provider-specific options. That list is what the port declares. Everything a specific
vendor adds beyond it belongs in an adapter or in the options bag.

Adapters are therefore the version-tracking surface. When a vendor ships a new specification version,
we add or amend one adapter file and the core is untouched — the same core/binding division US3 already
built, applied to a different seam.

**MCP sampling is deliberately not the seam.** It is the closest thing to an official
provider-agnostic completion request, and the temptation is real given what this project is. But it is
deprecated as of protocol revision `2026-07-28` in favour of direct provider integration through the
multi-round-trip `input_required` pattern, and `includeContext` is deprecated alongside it. Building a
pattern catalogue on a deprecated capability would hand callers a migration.

Its normative rules are still worth mining, because they are the best-specified statement of the
agentic loop's invariants that exists in a standards document: cap the iteration count; pass
`toolChoice: {mode: "none"}` on the final iteration to force a terminal answer; answer every
`tool_use` with a `tool_result` carrying a matching id; and let a message bearing tool results carry
nothing else. Those become assertions in the tool-loop pattern's own tests rather than a dependency.

**Telemetry stays a seam.** The GenAI semantic conventions moved to a dedicated
`semantic-conventions-genai` repository in June 2026 and *no* `gen_ai.*` span, metric, event, or
attribute is marked Stable — the whole surface is Development, while the general attributes it borrows
(`error.type`, `server.address`) are Stable. So patterns accept an observer function and never emit
convention attribute names, which would otherwise bake a moving vocabulary into deterministic output.

**Provenance**: these are original implementations informed by public interface documentation. What is
shared with the sources is a naming convention for a handful of fields, not code, so the catalogue
entries are `license: original` with the influences named in `provenance`.

**Alternatives considered**: Reproduce `LanguageModelV4` verbatim — rejected on the churn above, and
impossible anyway without importing `@ai-sdk/provider` for the types. Adopt the OpenAI wire shape as
the port, since LiteLLM demonstrates everything normalises to it — rejected because a serialization
format is not a domain interface; `choices[0].message.content` and snake_case fields would leak
transport structure into every call site, though it remains the single most valuable adapter target.
Build on MCP sampling — rejected as deprecated. Ship no LLM patterns at all on the grounds that the
space moves too fast — rejected, because the churn is concentrated in the provider surface, and the
loop-shaped machinery around it (bounded repair, budgeted context, delta accumulation) has been stable
for years and is exactly the fiddly-edge-case work section 9 says the value concentrates in.

---

## Open items carried forward

1. **Header/body validation coverage** — the specification makes it a MUST that a server processing the
   request body validate `Mcp-Method`, `Mcp-Name`, and `MCP-Protocol-Version` against body values and
   reject mismatches with `400` and `-32020`. SDK documentation does not confirm whether the HTTP
   handler does this. Resolve empirically with a deliberately mismatched header before assuming
   coverage; implement it ourselves if absent.
2. **Published package name** — must be settled before first publish, because the registry's npm
   ownership check matches `package.json#mcpName` against `server.json#name` exactly. Scope-neutral.
3. **Response body rendering** — whether the human-readable `content` block is best as Markdown with
   path-headed fenced blocks or as a serialized structure measurably affects agent performance, with no
   universal winner. Decide with an evaluation set rather than by preference.
