# patterns-mcp

An MCP server that writes TypeScript design-pattern implementations for you, and proves them before
handing them over. Every bundle it returns has been typechecked, and its generated tests have been
executed, under the conventions you asked for. The same request always returns the same bytes.

It exists because "how do I write a circuit breaker in TypeScript" is a question a model answers
plausibly and inconsistently. This answers it the same way every time, with code that compiled.

## Requirements

Node 22.13.0 or newer. Generated tests are executed inside Node's permission model, which is how a
bundle can be proved to work without being handed your filesystem, and the flag that enables it does
not exist under that name before 22.13. The server refuses to start on anything older rather than
reporting each request as a defect.

Any MCP client. It speaks the `2026-07-28` revision — stateless requests, `server/discover`, cache
hints on everything worth caching — and still answers a client that opens with the older handshake,
so the revision your editor happens to ship is not something you need to check.

## Use it from an editor

Add it to your MCP configuration — `.cursor/mcp.json`, or your client's equivalent:

```json
{
  "mcpServers": {
    "patterns": {
      "command": "npx",
      "args": ["-y", "patterns-mcp"]
    }
  }
}
```

Three tools, meant to be called in this order:

| Tool               | Answers                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `list_patterns`    | What exists, filtered by category or tier                            |
| `describe_pattern` | One pattern's options, the names it generates around, and its rules   |
| `generate_pattern` | The code, plus a record of how it was verified                        |

A request names a pattern, the identifiers to generate around, the pattern's own options, and your
project's conventions:

```json
{
  "pattern": "repository",
  "identifiers": { "entity": "Order" },
  "options": { "pagination": "cursor", "includeTests": true },
  "conventions": { "strictness": "strict", "importExtensions": "js", "testFramework": "node-test" }
}
```

What comes back is files with paths, and a verification record naming the compiler version, the
compiler options it was checked under, the diagnostic count, and whether the tests ran and passed.

## Use it from a shell

The same engine, same answers, no client needed. `patterns generate --json` prints exactly what
`generate_pattern` returns as `structuredContent`, byte for byte, which is enforced by a test.

```bash
npx -p patterns-mcp patterns list --kind generative
npx -p patterns-mcp patterns describe repository
npx -p patterns-mcp patterns generate repository \
  --identifier entity=Order --option pagination=cursor --out ./src/data
```

(`-p` because the package ships more than one binary and only the server shares its name.)

`--dry-run` shows the paths it would write without writing them, and a collision is refused rather
than overwritten. Exit codes are `0` for success, `1` for something to correct in the request, `2`
for a malformed command line, and `70` for a defect in the tool.

## Use it as an agent skill

For a coding agent that drives a shell rather than a tool list. The package ships
[`skills/patterns/SKILL.md`](./skills/patterns/SKILL.md), which teaches the workflow, the exit codes,
and the handful of things — reserved names, advisory entries, splitting a pattern across entities —
that otherwise cost a turn to discover. Copy it into your agent's skills directory, or point at it in
place:

```bash
cp -r node_modules/patterns-mcp/skills/patterns ~/.cursor/skills/
```

It is a third adapter over the same engine, not a summary of the other two, and every command it shows
is parsed by the CLI's own parser in the test suite so it cannot drift from what the CLI accepts.

## Serve it over the network

For a client that is not on this machine. The stdio binary above needs no port and is what an editor
should use; this one is for a shared deployment.

```bash
npx -p patterns-mcp patterns-mcp-http --port 3000
```

It binds `127.0.0.1` by default, so nothing off this machine can reach it until you say otherwise.
Going wider takes two flags, not one:

```bash
patterns-mcp-http --host 0.0.0.0 --port 3000 --allow-host patterns.internal
```

`--allow-host` is required rather than inferred from `--host`, and the reason is the attack it
defends against: a browser can be tricked into resolving someone else's name to your address, and the
only thing distinguishing that request from a legitimate one is the name it carries. A list the server
wrote for itself would match anything and stop nothing. Use `--allow-origin` likewise for browser
clients.

Each request is served by a fresh server instance holding no state, so there is nothing to scale
around and no session to lose. Two things surprise people writing a client by hand against it: every
modern request must carry an `Mcp-Method` header naming the method in its body, and a `tools/call`
must also carry `Mcp-Name` naming the tool — a mismatch or an omission is answered `400` with
`-32020`. Over stdio there are no headers, so a client that works locally can still fail here.

## What it guarantees

- **It compiled.** Not "should compile". The bundle is typechecked under your conventions before the
  response is assembled, and a bundle that fails is never returned.
- **The tests ran.** Generated tests execute in a sandbox with no filesystem, no subprocesses, and no
  environment, and a failure is reported as our defect rather than returned as code.
- **Identical requests return identical bytes.** No clock, no random source, no ambient state. Each
  file carries a provenance comment naming the pattern and a hash of the inputs that shaped it, so a
  later reader can regenerate it exactly.
- **A refusal tells you how to fix it.** An undeclared option, an illegal combination, or a name the
  pattern keeps for itself comes back naming the field, the rule, and the alternatives — not a stack
  trace.

## What it will not do

It will not guess. A name it cannot pluralise confidently, a formatter width too narrow to keep a
`@ts-expect-error` attached to its line, an option combination the pattern does not support — each is
refused with the reason, because a plausible guess is the expensive kind of wrong here.

## The catalogue

26 patterns across type safety, async resilience, data access, creational, structural, behavioural,
and LLM orchestration. Every one is an original implementation; where an entry cites a book or paper,
it cites the source of the idea.

[**docs/catalogue.md**](./docs/catalogue.md) lists all of them with their options, defaults, and the
names each generates around — every word of it emitted from the catalogue, so it cannot describe a
version of the tool that does not exist. `list_patterns` and `patterns describe` remain the
authoritative answers, being read out of the same data at the moment you ask.

Alongside them are 7 advisory entries — Singleton, Visitor, Observer, Strategy, Template Method,
Iterator and Prototype. Asking for one returns what to write instead and why, as a success rather
than an error, because TypeScript absorbed the problem each of them was solving and generating the
1994 shape would leave your codebase worse than the language already does.

## Development

```bash
pnpm install
pnpm check        # lint, typecheck, catalogue, tests, build, packaged smoke test
pnpm test:watch   # tests in watch mode
pnpm dev          # rebuild on change
```

## Licence

MIT for the tool. Code the generator emits is yours, with no notice to retain and no attribution
asked — see [LICENSE](./LICENSE), which says so explicitly.
