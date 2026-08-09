# Quickstart: Validating the TypeScript Pattern Generation Service

**Date**: 2026-08-09 | **Plan**: [plan.md](./plan.md)

This is a validation guide, not an implementation guide. Each scenario below proves a specific
constitutional guarantee end to end, and each maps to a success criterion in
[spec.md](./spec.md). Implementation steps belong in `tasks.md`.

## Prerequisites

- Node.js 20 or newer (developed on 22.20)
- pnpm
- A clean checkout; verification spawns a compiler binary, so no sandbox that blocks subprocesses

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Full gate

The one command that must pass before anything is considered done:

```bash
pnpm check
```

Any failure is a stop.

The gate grows as implementation proceeds: a stage is wired in by the task that creates the thing it
checks, never in advance, because a gate that is red for structural reasons cannot enforce anything.

| Stage | Covers | Added by |
|---|---|---|
| `lint` | The engine/MCP import boundary (Principle X) and the determinism bans | T003, extended by T024 |
| `typecheck` | Our own sources under `strict` | scaffold |
| `test` | Five projects: unit, contract, golden, determinism, parity | T005 |
| `build` | Declaration emit, which can fail where `tsc --noEmit` passes | scaffold |
| catalog validation | Schema conformance, provenance, licence terms | T011 |
| conformance | The frozen `2026-07-28` requirement set, both transports | T083 |

---

## Scenario 1 — A bundle compiles and its tests pass

**Proves**: Principle III, SC-001.

```bash
pnpm patterns generate result --json
```

**Expect**: `kind: "bundle"`; `verification.diagnosticCount` is `0`; `verification.testOutcome` is
`"passed"`; `verification.compilerVersion` is `7.0.2`. A returned bundle that fails either check is not
a test failure — it is a broken core guarantee.

## Scenario 2 — Identical inputs, byte-identical output

**Proves**: Principle I, SC-002.

```bash
pnpm patterns generate circuit-breaker --json > /tmp/a.json
pnpm patterns generate circuit-breaker --json > /tmp/b.json
diff /tmp/a.json /tmp/b.json && echo IDENTICAL
```

**Expect**: no differences. The automated harness goes further and compares across process restarts and
across machines in CI, because a same-process comparison would not catch an ambient dependency.

## Scenario 3 — Changing one option changes only that option's surface

**Proves**: Principle II, FR-010, SC-005.

```bash
pnpm patterns generate retry --json > /tmp/base.json
pnpm patterns generate retry --cancellation none --json > /tmp/variant.json
```

**Expect**: differences confined to the surfaces the `cancellation` option declares in its `affects`
field. The harness asserts this mechanically for every option of every pattern — a reflowed unrelated
function is a failure even though the code still compiles.

## Scenario 4 — Reuse is cheap

**Proves**: Principle IV, FR-017/FR-018, SC-004.

```bash
# First use: everything
pnpm patterns generate repository --identifier entity=User --json > /tmp/full.json

# Second domain type, machinery already installed
pnpm patterns generate repository --identifier entity=Order \
  --emit-scope binding-only --core-module ./repository/core --json > /tmp/binding.json
```

**Expect**: the binding response is at most 20% of the size of the full response, contains no `core`
role files, and imports from the supplied `coreModule`. This is the difference between a generator and
a snippet library.

## Scenario 5 — An illegal combination is refused usefully

**Proves**: Principle V, FR-008/FR-009, SC-007.

```bash
pnpm patterns generate repository --emit-scope binding-only --json; echo "exit=$?"
```

**Expect**: exit `1`. The message names `coreModule`, states why it is required when `emitScope` is
`binding-only`, and lists what to do instead. It must not emit a plausible bundle with a guessed import
path, and it must contain no unescaped echo of caller input.

## Scenario 6 — A superseded pattern returns advice, not code

**Proves**: Principle VI, FR-022, and that advisories are successes.

```bash
pnpm patterns generate singleton --json; echo "exit=$?"
```

**Expect**: exit `0`, `kind: "advisory"`, a named idiomatic alternative, and a rationale. No class
hierarchy. Generating Java-in-TypeScript here would make the caller's codebase worse, which is why
refusal is a feature.

## Scenario 7 — Output honors caller conventions

**Proves**: Principle IX, FR-024 – FR-026.

```bash
pnpm patterns generate semaphore --conventions ./test/fixtures/conventions/cjs-loose.json --json
```

**Expect**: CommonJS module style and import extensions per the fixture; `resolvedConventions` echoes
every value including defaults; and critically, `verification.compilerOptions` reflects the **caller's**
options — verification ran under their configuration, not ours.

## Scenario 8 — Surface parity

**Proves**: Principle X, FR-029, SC-010.

```bash
pnpm test parity
```

**Expect**: for a matrix of requests, the CLI's `--json` output and the MCP `structuredContent` are
byte-identical. Any divergence means generation logic leaked into an adapter.

## Scenario 9 — Protocol conformance

**Proves**: FR-030, FR-031, SC-011.

```bash
pnpm conformance:stdio
pnpm conformance:http
```

**Expect**: the frozen `2026-07-28` requirement set passes on both transports. Two checks deserve
attention beyond a green result:

- **stdio**: `stdout` carries only well-formed protocol messages for a whole session. A stray log line
  corrupts the stream.
- **HTTP**: a request whose `Mcp-Method` contradicts its body is rejected with `400` and `-32020`. This
  is currently **unverified** in the SDK and is an open item — send the mismatch deliberately and
  observe, rather than assuming coverage.

## Scenario 10 — Discovery is enough on its own

**Proves**: Principle VIII, FR-027, SC-006.

```bash
pnpm patterns list --category async-resilience
pnpm patterns describe circuit-breaker
```

**Expect**: every option shows its permitted values, default, description, and legality rules — enough
for a capable agent with no prior knowledge to construct a valid `generate` call on the first attempt in
at least 90% of held-out trials. That figure is measured against an evaluation set, not asserted.

## Scenario 11 — Response size stays within budget

**Proves**: FR-028, SC-008.

```bash
pnpm test budget
```

**Expect**: every pattern's `full` response is within the documented token budget, comfortably below the
~25,000-token point at which common agent hosts truncate results. `verbosity: "summary"` omits file
contents and states how to obtain them, so a large bundle degrades gracefully instead of being silently
cut off.

## Scenario 12 — Catalog integrity

**Proves**: FR-036, SC-012, SC-013.

```bash
pnpm test catalog
```

**Expect**: every entry validates against `data/schema.json`; no entry carries NonCommercial or
NoDerivatives terms; every `relatedPatterns` reference resolves; every entry records provenance; and at
least 20 tier-1 patterns are present.
