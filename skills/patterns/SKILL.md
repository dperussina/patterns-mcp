---
name: patterns
description: >-
  Generate verified TypeScript implementations of design patterns — Result types, repositories,
  circuit breakers, branded types, retry and rate limiting, LLM tool loops and streaming — through the
  `patterns` command. Every bundle is typechecked and its generated tests are executed before it is
  returned, so the code is known to compile rather than believed to. Use when a task calls for one of
  these patterns instead of writing it by hand, and when a hand-written version would have to be
  reviewed for the failure modes the generated one already handles.
---

# patterns

A catalogue of 26 generative patterns, each emitted as complete TypeScript files that have been
compiled and whose tests have been run. Identical requests return identical bytes.

Read this before writing one of these patterns from scratch. The generated version already handles the
failure modes a hand-written one gets wrong on the first attempt — a permit released outside a
`finally`, a timeout indistinguishable from a caller's cancellation, an offset pager that skips records
under insertion.

## Workflow

Three steps, in this order. Skipping the middle one is what causes refusals.

```
- [ ] 1. patterns list          — find the pattern
- [ ] 2. patterns describe <p>  — read its options, rules and reserved names
- [ ] 3. patterns generate <p>  — write the files
```

**1. Find it.**

```bash
patterns list
patterns list --category async-resilience
patterns list --json
```

Categories are `async-resilience`, `llm-orchestration`, `type-safety`, `structural`, `behavioral`,
`creational`, `data-access`.

**2. Read what it accepts.** This is not optional, and it is one turn:

```bash
patterns describe repository
```

The description carries every option with its permitted values and default, the rules that would
refuse a request, the identifiers to supply, and the names the pattern writes itself. Guessing an
option value costs the same turn and fails.

**3. Generate.**

```bash
patterns generate repository --identifier entity=Invoice --option pagination=offset --out src/data
```

Files are written relative to `--out`, defaulting to the working directory. Add `--dry-run` first if
the destination may already hold a file of that name.

## Reading the result

Default output is written for a person. Add `--json` to get the structure, which writes no files and
prints the same bytes the MCP server returns.

Every bundle carries a verification record: the compiler version, the diagnostic count, and whether
the generated tests passed. `diagnostics: 0, tests passed` is the guarantee — treat that code as
correct and integrate it rather than rewriting it. A bundle whose tests are `skipped` carries the
weaker claim; it compiled, but nothing executed it.

Read `nextSteps` when present. It appears only when the bundle is incomplete on its own terms, and it
names the completing call with its arguments already filled in.

## Exit codes

| Code | Meaning | What to do |
|-----:|---------|------------|
| 0 | Success. Advice counts as success. | Use the output. |
| 1 | The request needs changing. | Read the message; it names the fix. Correct and retry once. |
| 2 | The arguments could not be parsed. | Fix the flag spelling, then retry. |
| 70 | A defect in the tool. | Do not retry. Report the reference number in the message. |

A refusal on exit 1 is an interface rather than a failure: it names what was wrong and what to send
instead. Retrying the same request unchanged will be refused identically.

## Things that will otherwise cost a turn

**Reserved names.** Each pattern writes some names itself, and an identifier cannot be one of them —
`patterns generate repository --identifier entity=Repository` is refused. `describe` lists them under
`RESERVED NAMES`. Casing does not get around it: `repository` is refused for the same reason
`Repository` is.

**Advisory entries.** 7 catalogue entries are marked `(advisory)` and generate nothing on purpose,
because a language feature has superseded them. Asking for one returns what to write instead, and
exits `0`. That is the answer, not an error.

**Splitting a pattern across entities.** Where a pattern separates shared machinery from one entity's
binding, `--emit-scope core-only` emits the machinery once and `--emit-scope binding-only
--core-module ./repository-core.js` emits each binding against it. `--core-module` is required by
`binding-only` and meaningless otherwise.

**Boolean and numeric options** take the spellings `describe` lists — `--option includeTests=false`,
not `no` or `0`. `--no-tests` is the shorthand.

**Project conventions.** Nothing is inferred from the working directory. Pass `--conventions
conventions.json` to name the module system, runtime, test framework and strictness; without it the
strictest reasonable defaults apply. Some combinations are refused as contradictory — a `browser`
runtime with `node-test` suites — with both ways out named.

**Network access.** Two patterns emit code that can reach the network, and `describe` says so under
`NETWORK` along with the boundary to pass to keep it offline. No generated code contains a credential
or an install hook.

## Where the generated code goes

The emitted files are the caller's own, under no licence obligation, and are meant to be edited. Each
carries a provenance header naming the pattern and options it came from, which is what makes a later
regeneration comparable to what is on disk.

## Full reference

`patterns --help` lists every flag. `patterns describe <pattern>` is the authority on what a given
pattern accepts — it is generated from the same catalogue the engine validates against, so it cannot
drift from what will be accepted.
