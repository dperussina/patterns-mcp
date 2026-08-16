# Contract: MCP Tools

**Protocol revision**: `2026-07-28` | **SDK**: `@modelcontextprotocol/server` 2.0.0

Three tools. All schemas are Zod (`zod/v4`) and serve as the single source of truth for
`inputSchema`, `outputSchema`, and internal types. Every field carries a `.describe()`; the schema is
the documentation an agent reads.

Shared conventions for all three:

- **Flat inputs.** No nested `oneOf`/`anyOf` composition — the specification directs implementations to
  bound schema depth and subschema count, and a flat schema is also easier for a model to fill.
- **Closed enums** wherever the value space is closed, so valid values are visible at the point of choice.
- **Read-only annotations.** All three tools are `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`. Generation writes nothing.
- **Cache hints.** `list_patterns` and `describe_pattern` are cacheable for the package version's
  lifetime, since the catalog ships with the build. `generate_pattern` results are cacheable keyed on
  the full input, because determinism guarantees the same answer.
- **`_meta` tolerance.** `clientInfo` is only a SHOULD in this revision. Handlers must work without it
  and must never branch on client identity.
- **Errors.** Tool handlers in SDK v2 return results, not protocol errors. Invalid input, unknown
  patterns, and illegal option combinations all return `isError: true` with a message that names the
  offending field, states the rule, and lists valid alternatives. Protocol-level errors are reserved for
  malformed requests.
- **Injection safety.** Caller-supplied values are escaped or elided before appearing in any returned
  message (FR-035). An error never echoes a raw caller string. Elided is the fallback, not the rule: a
  refusal that withholds the value it refused leaves the caller unable to tell which of the names they
  sent to change, which is what a refused identifier used to do. A value is quoted when it is inert —
  which anything passing the identifier charset is — and described when it is not. This covers field
  *names* as well as values: an object key is caller-supplied, and a request can name its keys freely.
- **Closed inputs.** Every input schema is strict: `additionalProperties: false`, and a field the tool does
  not accept is refused rather than dropped (FR-051). The refusal says where the value belongs — an option
  inside `options`, a name inside `identifiers`, a project setting inside `conventions` — and names only
  destinations the tool it came from has, since `describe_pattern` takes a pattern and nothing else. A
  misspelled key inside `conventions` is refused as "not a convention" with the settable ones listed, not as
  an unknown argument, because a caller told the latter would go looking for it at the top level.

---

## `list_patterns`

Browse the catalog. Cheap, cacheable, and the intended first call for an agent with no prior knowledge.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | enum of catalog categories | no | Filter (FR-012). |
| `kind` | `generative` \| `advisory` | no | Filter (FR-012). |
| `tier` | `1` \| `2` \| `3` | no | Release tier filter. |

**Output** (`structuredContent`)

```
{ patterns: Array<{ name, title, category, kind, intent, supportsSplit, tier }>, total: number }
```

Summary fields only. Full option documentation is deliberately excluded so this response stays small —
that is what `describe_pattern` is for (FR-027).

---

## `describe_pattern`

Full detail for one pattern: every option, permitted values, default, description, legality rules, and
variants (FR-013). The step that lets an agent construct a correct request on the first attempt (SC-006).

**Input**

| Field | Type | Required |
|---|---|---|
| `pattern` | enum of catalog names | yes |

**Output** (`structuredContent`)

```
{ name, title, category, kind, intent, supportsSplit, variants,
  options: Array<{ name, type, values?, default, description, affects }>,
  legality: Array<{ rule, alternatives }>,
  relatedPatterns, tier,
  advisory?: { alternative, rationale } }
```

An unknown `pattern` returns `isError: true` with the nearest catalog names suggested.

---

## `generate_pattern`

The tool that does the work: resolve options, render, format, verify, return.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `pattern` | enum of catalog names | yes | |
| `variant` | string | no | Must be one of the pattern's declared variants. |
| `emitScope` | `full` \| `core-only` \| `binding-only` | no | Default `full` (FR-017). |
| `coreModule` | string | conditional | Required when `emitScope` is `binding-only` (FR-018). |
| `errorMode` | `result` \| `throw` | no | Default `result`. |
| `async` | `sync` \| `async` \| `both` | no | Pattern-dependent default. |
| `cancellation` | `none` \| `abort-signal` | no | |
| `includeTests` | boolean | no | Default `true`. |
| `verbosity` | `full` \| `code-only` \| `summary` | no | Default `full` (FR-028). |
| `identifiers` | record of validated names | no | Keys must be roles the pattern declares; read them from `describe_pattern`. |
| `options` | record of pattern-specific values | no | Validated against the pattern's declared options. |
| `conventions` | Conventions object | no | Strictest reasonable defaults when absent (FR-026). |

`identifiers` values are validated against `^[A-Za-z_$][A-Za-z0-9_$]*$`, length-capped, and checked
against a reserved-word denylist before reaching generation (FR-032). Output paths are derived from
validated inputs; callers cannot supply paths (FR-033).

Its *keys* are closed, exactly as `options` keys are. A role the pattern does not declare is refused
with the declared roles named, and six patterns declare none at all — they emit one module named after
themselves, so `{ entity: "Order" }` is a refusal rather than a no-op. This is an amendment: such a
key was accepted and ignored, which read as success and was not, because it still entered the options
hash and so changed the provenance header of files that made no use of it. `describe_pattern` now
publishes the roles, and states explicitly when a pattern takes none.

Two further refusals are worth expecting even though the value passes validation:

- A name whose plural cannot be derived confidently (`Staff`) is refused with the rule stated. It is
  not silently replaced by a generic name, which is what used to happen.
- No name is refused for its *length* below the cap, and every pattern is checked at the cap. A long
  name changes where generated code wraps, which is not cosmetic: a wrapped statement can carry a
  `@ts-expect-error` away from the error it asserts, which fails verification.

**Output** (`structuredContent`) — a discriminated union on `kind`:

- `kind: "bundle"` — `{ pattern, resolvedOptions, resolvedConventions, files[], verification, notes, warnings, nextSteps }`
- `kind: "advisory"` — `{ pattern, alternative, rationale, example? }`

An advisory result is a **success**, not an error (FR-022).

**Content block.** Alongside `structuredContent`, a human-readable block renders the bundle as
path-headed fenced code blocks. `verbosity: "code-only"` omits notes and rationale; `summary` omits file
contents and states how to obtain them (FR-028). Whether Markdown or a serialized structure performs
better for agents is an open item to settle with an evaluation set, not a preference.

**Guarantees on every successful bundle response**

1. Byte-identical to any previous response for the same input (Principle I).
2. Typechecked under `resolvedConventions` with zero diagnostics (Principle III).
3. If it contains tests, those tests were executed and passed (Principle III).
4. Every file carries a provenance header naming the pattern and the options hash, except a shared
   support file, which is marked as shared and names neither (FR-020).
5. Two bundles may be unpacked into one directory: any path they both emit carries identical bytes in
   both, so the collision is a no-op rather than one bundle overwriting the other (FR-020).
