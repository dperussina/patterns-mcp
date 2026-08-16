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
| `identifiers` | `IdentifierRole[]` | The identifier roles this pattern generates around, empty if none. Names must be unique. Each is optional to supply; a role the pattern does not declare is refused. |
| `options` | `Option[]` | Pattern-specific options, in declared order. |
| `legality` | `LegalityRule[]` | Cross-option constraints (FR-008). |
| `advisory` | `Advisory?` | Required when `kind` is `advisory`, forbidden otherwise. |
| `relatedPatterns` | `string[]` | Must resolve to existing `name` values. Validated as a closed reference set. |
| `provenance` | `string` | How the entry was authored (FR-036). |
| `license` | enum | `original` or an SPDX identifier permitting commercial modification. NC and ND terms are rejected in validation (FR-036, SC-012). |
| `tier` | `1 \| 2 \| 3` | Release tier. Tier 1 is the ≥ 20 patterns of first release (SC-013). |

**Invariants** (enforced by a CI catalog validator, not at runtime):

- `name` is unique across all shards.
- `supportsSplit: false` forbids `emitScope` values other than `full` for that pattern, and forbids
  `coreModule` outright.
- `supportsSplit: true` requires `emitScope`, since a pattern that can split must say so in its options.
- Every generative pattern declares `includeTests`.
- No pattern declares `verbosity`; it governs the response, not the code.
- A declared base option uses the documented value space exactly, so a caller learns each one once.
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

What "shared" fixes is the *vocabulary*, not the presence. A caller learns each of these once and can
rely on its name, its value space, and its meaning being identical wherever it appears — but a pattern
declares only the ones it can honour, because an option that resolves to the same output for every
value advertises a choice that does not exist (FR-019), and one that contradicts the pattern's purpose
is worse than absent.

This was originally specified as "present on every generative pattern". Authoring the second pattern
showed that three of the seven cannot be, and the invariants below are the corrected form.

| Option | Values | Default | Declared when |
|---|---|---|---|
| `includeTests` | boolean | `true` | Always. Every pattern can emit a suite or not. |
| `emitScope` | `full`, `core-only`, `binding-only` | `full` | `supportsSplit` only. Without a split every value emits the same bundle. |
| `coreModule` | string specifier | none — required when `emitScope` is `binding-only` (FR-018) | `supportsSplit` only, for the same reason. |
| `errorMode` | `result`, `throw` | pattern's choice | Where both arms are coherent. `throw` negates the `result` pattern, and `result` needs a Result type in scope, which is cross-pattern composition (unspecified). |
| `async` | `sync`, `async`, `both` | pattern's choice | Where the pattern has a meaningful synchronous form. |
| `cancellation` | `none`, `abort-signal` | `abort-signal` where the pattern is asynchronous | Where the pattern waits or is long-running. |
| `verbosity` | `full`, `code-only`, `summary` | `full` (FR-028) | **Never.** See below. |

`verbosity` is a property of the *response*, not of the code: it selects how much of an unchanged
bundle is rendered back (FR-028). Declaring it as a pattern option would put it in `resolvedOptions`
and therefore in the provenance hash, so the byte-identical bundle would carry a different hash
depending only on how verbosely it had been described — which breaks the property the hash exists to
provide (Principle I). It is an input to the tool, handled at the MCP layer, and the catalog validator
rejects any entry that declares it.

Defaults are the pattern's to choose where the table says so, because the right default follows from
what the pattern is: `cancellation` defaults to `abort-signal` on an async pattern and would be
meaningless on a synchronous one. The *value space* is never the pattern's to choose — a pattern that
declared `cancellation` with a third value would break the "learn it once" guarantee, and validation
refuses it.

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
rather than being approximated. The refusal must reach the caller: dropping it and using a generic
name instead is the failure this is meant to prevent, wearing a different hat.

**A doubtful ending has to be doubtful in English, not merely in Latin.** The rule for `-on` was
written for `criterion` and `phenomenon` and matched every `-ion` noun, which refused `Subscription`,
`Transaction`, `Session`, `Notification`, `Permission`, `Version`, `Connection`, `Collection`,
`Region`, `Option`, `Action`, `Question` and `Division` — a seventh of a realistic domain vocabulary,
and none of them genuinely ambiguous. `-ion` is now excluded from the doubt, which costs nothing:
the words the rule was aimed at are all exception-table entries, and the table is consulted first.

**A confident wrong answer is worse than a refusal, and the invariant list is where they came from.**
Words whose plural equals their singular have no rule to find them, only a list, and that list held
seven entries against a class with scores. So `Aircraft` became `Aircrafts` — the one that prompted the
audit — and so did every other candidate tried: `Corps`/`Corpses`, `Middleware`/`Middlewares`,
`Analytics`/`Analyticses`, `Headquarters`/`Headquarterses`. None was refused, because the default rule
is confident about a `-t` or an `-s` ending and has no way to know the word is a collective. The list is
now forty-nine entries covering the groups a software domain reaches for: the `-ware` compounds, the
`-craft` compounds, the `-ics` field names, the singular collectives ending in `-s`, and the mass nouns.

It still cannot be complete, and it is deliberately not exhaustive: `Bandwidth` pluralises legitimately,
and `Feedback` is split by usage, so both are left to the default rule.

**A bare `-s` is now a doubt, which the same audit had rejected on a false premise.** The earlier
reasoning was that widening `-s` would refuse `Address`, `Class`, `Process` and `Status`; three of those
end in a double `s`, about which nothing is doubtful, and the fourth is `-us` and already belongs to the
Latin rule. What the ending actually cannot distinguish is a singular from a plural, and the case that
matters is not a collective but a caller writing what they mean: `Orders` is among the likeliest things
anyone hands a repository, and it produced `orderses` — used as the collection name, so the invented
word would have reached a schema and not merely a type. `-ss` is exempt, `-us` and `-is` keep the Latin
rule's better explanation, and the genuine singulars left over — `alias`, `lens`, `canvas`, `gas`,
`bias`, `atlas` — are exception-table entries like every other word with one right answer.

**Where English has a rule, the fix is the rule and not a refusal.** `Quiz` was answered `Quizes`,
because the `-s`/`-x`/`-z` clause appends `-es` without noticing that a single `z` after a vowel
doubles. That is not a doubt to be refused but a missing case, now handled: `Quizzes`, while `Waltz` and
`Buzz` — a consonant and a second `z` in that position — are untouched.

Where an ending is *both*, it belongs in the doubt rather than either table. `-ics` names a field, which
is invariant, and is also how an `-ic` noun pluralises, so `Mechanics` and `Graphics` are one word doing
two jobs while `Topics` and `Metrics` are only plurals. Refusing tells a caller who sent a plural by
mistake what they did; the previous answer was `Topicses`.

**Every casing comes from the words, and never from a character.** The forms above are derived by
splitting the name on case boundaries, which is what keeps `HTTPServer` from becoming `h-t-t-p-server`.
Two templates cased names themselves instead and were wrong in the two ways available: lowercasing the
whole subject ran the words together, so `WebhookEvent` produced the exported `webhookeventId`, and
lowercasing the first character alone mangles an acronym, so `APIKey` produced a factory named
`aPIKeyId`. Both compiled and both passed the generated tests. Neither is reachable with `Order`, where
every casing coincides, which is why the value form is now derived here rather than at a call site, and
why a spaced form exists for the prose that reaches test titles and error messages.

**Appending a pattern's own noun collapses the overlap wherever the two names meet.** The rule that
turned `OrderId` + `Id` into `OrderId` rather than `OrderIdId` compared the noun against the whole tail,
so it missed every partial overlap: `Event` — the likeliest subject for an emitter — gave `EventEvents`
and `EventEventName`. The longest overlap now wins, and a noun matching the name's plural counts as the
same word, with the plural's spelling surviving because that is the form the call site asked for. The
entity's spelling wins everywhere else, so a caller who writes `OrderID` keeps their acronym. One
pattern is deliberately excluded: `typestate` names a class after the subject and a union after its
states, and collapsing a `State` subject made the two collide, so it keeps `StateState` — which
compiles, where the tidier name did not.

**A file stem keeps its pattern's noun even when a type name loses it.** The collapse above is right for
a type — a caller asking for `OrderId` wants `OrderId`, not `OrderIdId` — but a stem has a second job a
type name does not: distinguishing one pattern's output from another's in a directory holding both. So
the collapse makes stems converge, and a stem that was already the bare subject converges with all of
them. `typestate` was that stem, and it collided with `branded-type` at `order-id.ts`, `repository` at
`order-repository.ts`, `typed-emitter` at `order-emitter.ts`, `result` at `result.ts` and
`discriminated-union` at `event.ts` — five pairs, all of them the FR-020 failure reached through the
caller's noun instead of a shared file, and none of them visible under `Order`, which is nobody's noun.
Every stem now carries its pattern's noun, so `typestate` writes `order-state.ts` rather than `order.ts`;
the second reading of that rename is that the service no longer claims the caller's own file name.

**A name of ours can be in the caller's way, and whose name it is decides the answer (FR-052).** A
template writes some names whatever it is asked for, and the collapse above makes others equal to the
name they were derived from, so a module can end up declaring one name twice. Feeding every pattern its
own written names, and the nouns it appends, produced a bundle that failed its own compiler in seven of
them — including for `Customer`, `Store` and `AuditRecord`, which are the sort of thing anyone would
send. The distinction is what the colliding name belongs to:

- **An example or a suite**: ours to name, so the stand-in steps aside — `SampleStore` beside the core's
  `Store` — and the file says why in a sentence, because a name silently different from the one that was
  asked for is its own small betrayal. `standIn` is a single helper rather than a habit at each call
  site, since the mistake it prevents was made independently in two patterns.
- **Something the caller builds against**: not ours to rename, so the request is refused as a collision.
  `unit-of-work` exports the binding's record type; an entity of `NewRecord` derives that exact name from
  the core's, and only the caller can resolve it.

**A collision is between derived names, not between spellings.** The refusal compared the string the
caller sent, so `repository` was accepted where `Repository` was refused — the same request in the casing
someone would more likely type, derived back to `Repository` at the declaration site and reported as our
defect. Six of the thirteen refused names had such a spelling. Both sides are now compared as their
Pascal forms, which is why the word-splitting and the casings sit in `casing.ts` below both the deriver
and the validator: a second splitter written in the validator to avoid the import is exactly the drift
that would let the two disagree again. `REPOSITORY` stays an acronym through the derivation, so it stays
a different name and is not refused for looking like one.

The names in the second group are declared by the pattern that writes them, next to the template rather
than in the catalog, because a list kept anywhere else drifts the first time a template gains a helper.
`describe_pattern` reads them from there and states them, so a caller learns a name is taken before
spending a turn on it — the same reasoning that makes legality rules data a caller can read rather than
behaviour they discover. That is what moved the module list into `patterns/registry.ts`: a description of
the catalogue reaching through the generation pipeline to read a declaration would put the two the wrong
way round.
The conformance sweep reads the real names out of a rendered bundle, so a drifted list is reported rather
than discovered by whoever asks for the name first — and it checks the reverse too, since a name refused
but no longer written is a request the service could serve and declines to.

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
4. Identifier *roles* checked against the pattern's `identifiers`; an undeclared role is rejected.
5. Identifier *values* validated against the strict pattern and reserved-word denylist; length-capped.
6. Defaults applied to unspecified options.
7. Legality rules evaluated in declared order.

Steps 4 and 5 are separate and ordered, for the same reason 2 precedes 3: a caller told their role is
wrong has no use for a complaint about the string they gave it. Step 4 is an amendment — an undeclared
role used to be accepted and ignored, which is the more expensive half of the mistake, since it still
entered `optionsHash` and so returned byte-different headers over a name no generated file used.

Plural derivation happens after this, during rendering, and can also refuse (see `NameTransform`). Its
refusal reaches the caller rather than being absorbed: a name whose plural cannot be derived was
previously dropped and the pattern fell back to generic names, so a request for a `Staff` repository
returned an `EntityRepository` with nothing said.

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
| `provenance` | `string` | Header comment: pattern name and `optionsHash` (FR-020, FR-021, FR-050). |

**What a file's marker identifies (FR-050).** Not the request, but the inputs that can shape *that file*.
Three attributions, and the two beyond the ordinary one exist for one reason: a path two requests both
emit must carry identical bytes, or the second request rewrites the first caller's file.

A **shared support file** names nothing, per FR-020.

The **machinery of a pattern that splits** — the `core` and `types` roles of a pattern offering
`emitScope` — is attributed without the caller's identifiers, because that half is by construction the one
that does not know the caller's type. That is what lets a second entity's request reuse it. Keying this on
the role alone would be wrong: nearly every pattern calls its principal module `core`, and for the
twenty-three that do not split, that module *is* the caller's type written out, so dropping the identifiers
there would claim two different files came from one request.

**Every** file's marker omits `includeTests`, which decides whether a suite exists rather than what any
file says. A suite that exists was asked for, and one that does not cannot be described; including it meant
a caller who regenerated without tests found every file they kept re-attributed, identical code under a new
hash. `emitScope` and `coreModule` are omitted from the machinery's marker only — a `core-only` example
declares a sample binding inline and a binding embeds the specifier verbatim, so both can reach those
files' text.

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
