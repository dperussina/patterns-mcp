# Phase 1 Data Model: TypeScript Pattern Generation Service

**Date**: 2026-08-09 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

There is no database. "Data model" here means two things: the versioned catalog data that ships with
the package, and the in-memory shapes that flow through a single request. Every shape below is defined
once in Zod and reused for tool schemas, catalog validation, and internal types — no hand-written
duplicate interfaces.

---

## Entity: Pattern

A named, categorized capability. Catalog data, stored in `data/patterns/{category}.json`.

| Field | Type | Rules |
|---|---|---|
| `name` | `string` | Primary key. `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, ≤ 48 chars. Human-readable and permanently stable (FR-015). |
| `title` | `string` | Display name, ≤ 64 chars. |
| `category` | enum | One of `type-safety`, `async-resilience`, `data-access`, `functional`, `creational`, `structural`, `behavioral`. |
| `kind` | enum | `generative` (emits code) or `advisory` (returns guidance only). Drives FR-022/FR-023. |
| `intent` | `string` | One sentence, ≤ 200 chars. What problem it solves. |
| `supportsSplit` | `boolean` | Whether it separates shared machinery from per-type bindings (FR-019). |
| `variants` | `string[]` | Named variants, empty if none. Each matches the identifier rule. |
| `options` | `Option[]` | Pattern-specific options, in declared order. |
| `legality` | `LegalityRule[]` | Cross-option constraints (FR-008). |
| `advisory` | `Advisory?` | Required when `kind` is `advisory`, forbidden otherwise. |
| `relatedPatterns` | `string[]` | Must resolve to existing `name` values. Validated as a closed reference set. |
| `provenance` | `string` | How the entry was authored (FR-036). |
| `license` | enum | `original` or an SPDX identifier permitting commercial modification. NC and ND terms are rejected in validation (FR-036, SC-012). |
| `tier` | `1 \| 2 \| 3` | Release tier. Tier 1 is the ≥ 20 patterns of first release (SC-013). |

**Invariants** (enforced by a CI catalog validator, not at runtime):

- `name` is unique across all shards.
- `supportsSplit: false` forbids `emitScope` values other than `full` for that pattern.
- `kind: "advisory"` implies `options` is empty and `advisory` is present.
- Every `relatedPatterns` entry resolves; the relation graph has no self-edges.

---

## Entity: Option

One knob. Defined per pattern, plus a shared base set every pattern inherits.

| Field | Type | Rules |
|---|---|---|
| `name` | `string` | `^[a-z][A-Za-z0-9]*$` (camelCase), ≤ 32 chars. Unique within a pattern. |
| `type` | enum | `enum`, `boolean`, `string`, `integer`. |
| `values` | `string[]?` | Required when `type` is `enum`; the closed value space. |
| `default` | scalar | Required. Every option has a default so that a bare pattern name is always a legal request (Principle V). |
| `description` | `string` | Required, non-empty (FR-016). |
| `affects` | `string[]` | Which output surfaces this option governs. Used by the diff-stability harness to assert changes stay confined (FR-010, SC-005). |

### Shared base options

Present on every generative pattern, so callers learn them once:

| Option | Values | Default |
|---|---|---|
| `emitScope` | `full`, `core-only`, `binding-only` | `full` |
| `coreModule` | string specifier | none — required when `emitScope` is `binding-only` (FR-018) |
| `errorMode` | `result`, `throw` | `result` |
| `async` | `sync`, `async`, `both` | `async` for async-resilience patterns, `sync` elsewhere |
| `cancellation` | `none`, `abort-signal` | `abort-signal` when `async` is not `sync` |
| `includeTests` | boolean | `true` |
| `verbosity` | `full`, `code-only`, `summary` | `full` (FR-028) |

---

## Entity: LegalityRule

Encodes what JSON Schema cannot, because the tool schema is deliberately flat (research §2).

| Field | Type | Rules |
|---|---|---|
| `when` | predicate over resolved options | Serializable — a field/operator/value triple, not a function, so rules are inspectable by `describe_pattern`. |
| `forbids` | `{ option, values }` | The combination being refused. |
| `rule` | `string` | The governing rule, stated in prose. Surfaced verbatim in errors (FR-009). |
| `alternatives` | `string[]` | Valid values to use instead. Surfaced verbatim (FR-009, SC-007). |

Rules are evaluated in declared order and the first match wins, so the error a caller sees for a given
input is deterministic.

---

## Entity: Conventions

Caller-supplied project settings. Optional; absent fields take the strictest reasonable default and
the resolved value is reported back (FR-024 – FR-026).

| Field | Type | Default |
|---|---|---|
| `strictness` | `strict`, `strictest`, `loose` | `strict` |
| `moduleStyle` | `esm`, `cjs` | `esm` |
| `importExtensions` | `none`, `js`, `ts` | `js` |
| `typeImports` | `inline`, `separate` | `separate` |
| `testFramework` | `vitest`, `node-test`, `jest`, `none` | `vitest` |
| `prettierConfig` | object | Prettier defaults |
| `runtime` | `node`, `browser`, `neutral` | `neutral` |

`strictness` and `moduleStyle` map onto the compiler options that verification actually runs under, so
this entity is not cosmetic — it *is* the verification configuration (FR-025).

---

## Entity: NameTransform

A pinned, table-driven mapping from a caller-supplied domain name to the derived identifiers a pattern
emits — plural forms, casing variants, and file-name stems. Ships as data, not as library calls.

| Field | Type | Rules |
|---|---|---|
| `singular` | `string` | The validated caller identifier, e.g. `Person`. |
| `plural` | `string` | The one documented plural. Irregular forms come from an explicit exception table; the default rule is applied only when no exception matches. |
| `camel` / `pascal` / `kebab` / `screamingSnake` | `string` | Derived casings, each produced by our own transform rather than a dependency. |

**Why this is data and not a dependency**: Principle I requires that `Person` resolve to *one*
documented plural forever. A pluralization library would make generated file names and member names a
function of whichever version resolved at install time, so a patch bump could silently rename members
across every consumer's regenerated output. The exception table is versioned with the catalog, and
additions to it are treated as output-affecting changes requiring a reviewable snapshot diff.

Unknown irregulars are not guessed. A caller identifier that the default rule cannot pluralize
confidently — and which has no exception entry — is refused with the rule stated, per Principle V,
rather than being approximated.

---

## Entity: ResolvedRequest

The validated pattern plus a complete option set, including defaults. Uniquely determines one output
(Principle I). Constructed once per request and never mutated.

| Field | Type | Notes |
|---|---|---|
| `pattern` | `string` | Resolved against the catalog. |
| `options` | `Record<string, scalar>` | Complete after defaults; key order normalized by sort. |
| `conventions` | `Conventions` | Fully resolved. |
| `identifiers` | `Record<string, string>` | Caller-supplied names, post-validation (FR-032). |
| `optionsHash` | `string` | Deterministic hash of the canonical serialization of `pattern` + `options` + `identifiers`. Excludes generator and toolchain versions (FR-021). |

**Validation order** — fixed, because it determines which error a caller receives:

1. Pattern exists and is `generative`; if `advisory`, short-circuit to an Advisory response.
2. Unknown option names rejected.
3. Each option value validated against its declared type and value space.
4. Identifiers validated against the strict pattern and reserved-word denylist; strings length-capped.
5. Defaults applied to unspecified options.
6. Legality rules evaluated in declared order.

---

## Entity: Bundle

The multi-file result. Returned as `structuredContent`; also rendered human-readably.

| Field | Type | Notes |
|---|---|---|
| `kind` | `"bundle"` | Discriminant against `advisory`. |
| `pattern` | `string` | Echo. |
| `resolvedOptions` | `Record<string, scalar>` | Complete, including defaults (FR-007). |
| `resolvedConventions` | `Conventions` | Complete (FR-026). |
| `files` | `File[]` | Ordered by `role`, then `path`. Never by iteration order. |
| `verification` | `VerificationRecord` | Always present on success (FR-006). |
| `notes` | `string[]` | Adoption guidance. |
| `warnings` | `string[]` | Non-fatal observations. |
| `nextSteps` | `string[]` | What to request next, especially when content was omitted for verbosity (FR-028). |

---

## Entity: File

| Field | Type | Rules |
|---|---|---|
| `path` | `string` | Derived from validated inputs only; never caller-supplied (FR-033). Relative, forward slashes, no `..`. |
| `contents` | `string` | Formatted output. |
| `role` | enum | `core`, `binding`, `adapter`, `test`, `example`, `types`. Drives ordering and `emitScope` filtering. `example` satisfies FR-004 and US1 acceptance scenario 1, which require a usage example in the bundle. |
| `provenance` | `string` | Header comment: pattern name and `optionsHash` (FR-020, FR-021). |

---

## Entity: VerificationRecord

Evidence, not decoration. A bundle that cannot produce this record is never returned (Principle III).

| Field | Type | Notes |
|---|---|---|
| `compilerVersion` | `string` | Exact, e.g. `7.0.2`. |
| `formatterVersion` | `string` | Exact, e.g. `prettier@3.9.6`. |
| `compilerOptions` | object | The options actually verified against — the caller's, when supplied. |
| `diagnosticCount` | `0` | Literal zero. A nonzero count is an internal defect, never a response. |
| `testOutcome` | `passed`, `skipped` | `skipped` only when the bundle contains no tests. `failed` is not a returnable state. |
| `contentHash` | `string` | Hash over the ordered `files`, enabling callers to detect drift. |

**Verifying a binding-only bundle.** A `binding-only` bundle imports from a `coreModule` that lives in
the caller's repository and is therefore invisible to us — yet Principle III admits no exception. The
resolution: because we generated that core ourselves, we can regenerate it deterministically into the
verification file system at the `coreModule` specifier, typecheck the binding against it, and then
**discard it** from the emitted bundle. The caller receives only the binding; the compiler saw the
whole picture.

This makes the `coreModule` specifier load-bearing rather than cosmetic, and it means a mismatch is
detectable: if the caller's installed core was generated under different options, the regenerated stub
will differ and the binding will fail to typecheck, which surfaces as a refusal naming what was
expected — exactly the edge case the spec calls for. `contentHash` covers only emitted files, never the
discarded stub.

---

## Entity: Advisory

The non-code response for a superseded pattern. Not an error (FR-022).

| Field | Type | Notes |
|---|---|---|
| `kind` | `"advisory"` | Discriminant against `bundle`. |
| `pattern` | `string` | The requested name. |
| `alternative` | `string` | The idiomatic TypeScript approach. |
| `rationale` | `string` | Why the classical form is not warranted here. |
| `example` | `string?` | Short illustration, not a bundle. |

---

## Response union and state

The generation result is a two-case discriminated union on `kind`: `bundle` or `advisory`. Refusals are
not part of it — they surface as tool results carrying an error flag with a self-correcting message,
which keeps the model in the loop rather than failing the turn.

There are no state transitions to model. The service holds nothing between requests (FR-031); the only
cross-request continuity is the caller-supplied `coreModule`, which is what makes the reuse path work
without server memory.
