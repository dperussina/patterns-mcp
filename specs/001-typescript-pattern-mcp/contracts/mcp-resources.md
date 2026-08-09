# Contract: MCP Resources, Discovery, and Transports

**Protocol revision**: `2026-07-28`

## Resources

The catalog is exposed as a resource in addition to a tool, because resources are attachable by
applications and readable by humans, whereas tools are for models (FR-014).

| URI | Content type | Description |
|---|---|---|
| `pattern://catalog` | `application/json` | The whole catalog: summary entries for every pattern. |
| `pattern://catalog/{name}` | `application/json` | Full detail for one pattern, mirroring `describe_pattern`. Registered as a resource template so `resources/templates/list` enumerates it. |

Both are marked cacheable for the lifetime of the package version. The catalog is build-time data, so
it cannot change without a new version — which makes an aggressive cache hint correct rather than
optimistic.

Resource content and the corresponding tool output are generated from the same catalog data by the
same code path. A CI test asserts they cannot drift.

## Discovery

`server/discover` is mandatory in this revision and is provided by the SDK. Declared capabilities:

- `tools` — with `listChanged: false`. The tool set is fixed at build time.
- `resources` — with `listChanged: false`, `subscribe: false`.
- No `logging` capability; it is deprecated in this revision. Diagnostics go to `stderr`.
- No sampling and no roots; both are deprecated and neither is needed by a pure function.

`instructions` is kept short and states the intended call order: list, describe, generate.

## Transports

### stdio

The default for local agent hosts. Anything written to `stdout` that is not a protocol message
corrupts the stream, so **all** diagnostics go to `stderr`. This is a test assertion, not a code
review note: a smoke test asserts `stdout` contains only well-formed messages across a full session.

### Streamable HTTP, stateless

For remote hosting. A fresh server instance is constructed per request; nothing is retained between
requests (FR-031, Principle VII).

Required header handling in this revision:

| Header | Requirement |
|---|---|
| `MCP-Protocol-Version` | Required on every request. |
| `Mcp-Method` | Required; must match the method in the body. |
| `Mcp-Name` | Required for `tools/call`, `resources/read`, and similar named operations; must match the body. |

A server that processes the body MUST validate these against body values and reject a mismatch with
HTTP `400` and JSON-RPC error `-32020`. Whether the SDK's HTTP handler performs this validation is
**unverified** and is tracked as an open item — it is to be settled by sending a deliberately
mismatched header and observing the response, and implemented in our handler if the SDK does not cover
it. Assuming coverage without testing it would be a conformance failure.

Because verification spawns a compiler binary, this surface targets Node rather than edge runtimes.

## Conformance

The `@modelcontextprotocol/conformance` suite runs in CI against the frozen `2026-07-28` requirement
set, for both transports (SC-011). Any unmet requirement is recorded with an explicit justification
rather than silently skipped.
