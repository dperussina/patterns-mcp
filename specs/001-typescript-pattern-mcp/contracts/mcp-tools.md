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
  message (FR-035). An error never echoes a raw caller string.

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
| `identifiers` | record of validated names | no | e.g. the domain type a binding is generated for. |
| `options` | record of pattern-specific values | no | Validated against the pattern's declared options. |
| `conventions` | Conventions object | no | Strictest reasonable defaults when absent (FR-026). |

`identifiers` values are validated against `^[A-Za-z_$][A-Za-z0-9_$]*$`, length-capped, and checked
against a reserved-word denylist before reaching generation (FR-032). Output paths are derived from
validated inputs; callers cannot supply paths (FR-033).

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
4. Every file carries a provenance header naming the pattern and the options hash (FR-020).
