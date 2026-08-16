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
it cites the source of the idea. Call `list_patterns` for the current list, which is the only copy
that cannot go stale.

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
