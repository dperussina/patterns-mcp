# Quickstart: Validating the TypeScript Pattern Generation Service

**Date**: 2026-08-09 | **Plan**: [plan.md](./plan.md)

This is a validation guide, not an implementation guide. Each scenario below proves a specific
constitutional guarantee end to end, and each maps to a success criterion in
[spec.md](./spec.md). Implementation steps belong in `tasks.md`.

## Prerequisites

- Node.js 22.13.0 or newer (developed on 22.20). The floor is where `--permission` reached its current
  name, which is what executes generated tests without handing them the filesystem; the server refuses
  to start below it rather than reporting every request as a defect (FR-053)
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
| `schema:check` | That `data/schema.json` still matches the Zod schema it is derived from | T009 |
| `catalog:check` | Schema conformance, provenance, licence terms, and the `{category}.json` file-name convention | T011 |
| `test` | Six projects: unit, contract, golden, determinism, parity, conformance | T005 |
| `build` | Declaration emit, which can fail where `tsc --noEmit` passes | scaffold |
| `smoke` | The three things the manifest publishes: the server binary, the CLI binary, and the entry under `require` | T152 |

Protocol conformance is a suite inside `test` rather than a stage of its own — see Scenario 9 for why the
official runner is not one of these rows.

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
pnpm test --project parity
```

**Expect**: for a matrix of requests, the CLI's `--json` output and the MCP `structuredContent` are
byte-identical. Any divergence means generation logic leaked into an adapter. Refusals are compared too,
with one licensed difference: each surface names the command a caller can actually run.

## Scenario 9 — Protocol conformance

**Proves**: FR-030, FR-031, SC-011.

```bash
pnpm test --project contract
```

**Expect**: the `2026-07-28` requirement set is asserted against stdio, which is the only transport this
server ships. `test/contract/revision.test.ts` exercises it at the frame level — `server/discover`, a
`tools/call` with no handshake, `resultType` on every result, the reserved error-code ranges, and the
methods the revision removed — alongside the older revision, on the same server, because a client that
has not migrated is the common case. Two checks deserve attention beyond a green result:

- **stdio**: `stdout` carries only well-formed protocol messages for a whole session. A stray log line
  corrupts the stream, and one `console.log` left in a handler is all it takes.
- Every `_meta` key the server mints sits under a prefix we own, since the `io.modelcontextprotocol/`
  namespace is reserved for keys the specification defines (FR-054).

The official `@modelcontextprotocol/conformance` runner is **not** used, and this is the reason rather
than an omission: it reaches an implementation over `--url`, so it has no stdio target. Standing up the
SDK's HTTP transport to satisfy it would test a transport we do not serve, and most of what it then
measured would be header and subscription requirements the SDK answers on our behalf. Revisit when the
runner gains a stdio target, or when FR-037's remote transport exists to be tested.

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

---

## Last run

Every scenario above, run by hand on 2026-08-15 (Node 22.20, macOS) rather than inferred from the suites.
Two of them had never been run as written, and that is what the exercise was for: Scenario 8's command
also matched an unrelated contract file, and Scenario 9's two commands did not exist at all.

| # | Result |
|---|---|
| 1 | `kind: "bundle"`, 3 files, `diagnosticCount: 0`, `testOutcome: "passed"`, `compilerVersion: "7.0.2"` |
| 2 | Identical across two processes |
| 3 | Changes confined to what `cancellation` declares: the `signal` parameter and the delay it threads through. The unrelated exports are byte-identical |
| 4 | Binding is 11.8% of the full response, one `binding` file, no `core` role, imports the supplied module |
| 5 | Exit `1`. **Fixed during the run**: the message named `coreModule` and the condition but never said what to do, so it now carries both ways out — set it, or ask for `full` |
| 6 | Exit `0`, `kind: "advisory"`, names the module-export alternative, no class |
| 7 | `resolvedConventions` echoes all seven fields including defaults; `verification.compilerOptions` is the caller's (`strict: false`, `module: "commonjs"`); specifiers are extensionless and single-quoted per the fixture |
| 8 | 23 comparisons pass. **Command corrected**: `pnpm test parity` is a filename filter that also ran `test/contract/catalog-parity.test.ts` |
| 9 | 2026-07-28 asserted against stdio. **Commands corrected**: `conformance:stdio` and `conformance:http` never existed, and the runner has no stdio target — see above |
| 10 | Six async-resilience entries; `describe` gives every option its values, default and description, and discloses reserved names and network reach where a pattern has them |
| 11 | 55 budget assertions pass |
| 12 | 70 catalog assertions pass across four files |
