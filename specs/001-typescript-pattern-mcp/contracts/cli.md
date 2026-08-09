# Contract: CLI

The CLI exists because MCP-only delivery is a real adoption risk: a major toolchain deliberately
removed most of its MCP tools on the grounds that tool schemas tax context on every turn and that
modern agents drive a CLI as competently as humans. Since the generator is a pure function, offering
both costs almost nothing (Principle X).

**Parity requirement**: identical inputs produce identical output through the CLI and through MCP,
verified automatically (FR-029, SC-010). The CLI is a thin argument parser over
[the engine API](./engine-api.md) — it contains no generation logic of its own.

## Commands

```
patterns list [--category <c>] [--kind generative|advisory] [--tier 1|2|3] [--json]
patterns describe <pattern> [--json]
patterns generate <pattern> [options] [--out <dir>] [--json] [--dry-run]
```

### `generate` options

Every `generate_pattern` tool field has a flag counterpart with the same name and the same permitted
values, so knowledge transfers in both directions:

```
--variant <name>
--emit-scope full|core-only|binding-only
--core-module <specifier>
--error-mode result|throw
--async sync|async|both
--cancellation none|abort-signal
--no-tests
--identifier <key>=<value>          (repeatable)
--option <key>=<value>              (repeatable)
--conventions <path-to-json>
```

Conventions may also be discovered from the working directory — `tsconfig.json` and Prettier config —
which is the natural human ergonomic and satisfies FR-024 without extra typing. Discovery happens in
the **adapter**, not the engine: the CLI reads the files and passes explicit values inward, keeping
`generate` pure.

## Output modes

| Mode | Behavior |
|---|---|
| default | Writes files under `--out` (default `.`), prints a summary of paths and the verification record. |
| `--dry-run` | Prints what would be written; writes nothing. |
| `--json` | Emits the `GenerateResult` structure verbatim on `stdout`. This is the mode a script or agent uses, and it is byte-comparable against the MCP `structuredContent` — which is how the parity test is implemented. |

Existing files are never overwritten silently. A collision is an error naming the path, since
regenerating over hand-edited code is exactly the loss the provenance header is meant to prevent.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, including an advisory result — an advisory is a valid answer, not a failure (FR-022). |
| `1` | Caller-correctable error: unknown pattern or option, invalid value, illegal combination, invalid identifier, missing required option. |
| `2` | Usage error: unparseable arguments. |
| `70` | Internal error, including `VerificationError`. Distinguished from `1` because it means our defect, not the caller's. |

Human-readable errors go to `stderr`; `--json` output on `stdout` stays parseable even on failure.
