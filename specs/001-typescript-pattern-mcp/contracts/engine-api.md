# Contract: Engine API

The engine is the whole product; MCP, the CLI, and the agent skill are adapters over it (Principle X).
This contract is what all three consume, and it is exported from the package root.

**Hard rule**: no module under `src/engine/` or `src/index.ts` may import anything MCP-related. This is
enforced by a lint boundary rule that is a required CI gate, not a convention.

## Surface

```ts
// Catalog
listPatterns(filter?: {
  category?: Category;
  kind?: "generative" | "advisory";
  tier?: 1 | 2 | 3;
}): PatternSummary[];

describePattern(name: string): PatternDetail;          // throws UnknownPatternError

// Generation
generate(request: GenerateRequest): Promise<GenerateResult>;

// Introspection — what the adapters report in metadata
toolchain(): { compilerVersion: string; formatterVersion: string; catalogVersion: string };
```

`GenerateResult` is the same discriminated union the MCP tool returns:
`{ kind: "bundle", ... } | { kind: "advisory", ... }`. See
[data-model.md](../data-model.md) for field-level detail.

## Behavioral contract

1. **Pure over its inputs.** `generate` reads no ambient configuration, environment variables, clock,
   or randomness. Every value that shapes output arrives in the request (Principle I).
2. **Total.** Every accepted input maps to exactly one valid output. Inputs that cannot produce correct
   code are refused before rendering, never approximated (Principle V).
3. **Verified before returning.** `generate` resolves only after the bundle typechecks with zero
   diagnostics and, if it contains tests, those tests pass. A bundle that fails verification is an
   internal defect and surfaces as a thrown error, never as a returned bundle (Principle III).
4. **Async is not optional.** `generate` is `async` because verification uses the async compiler API.
   The sync compiler variant pins the event loop completely — measured at zero ticks across 48ms of
   sequential checks — so it cannot be used by a server.
5. **Warm state is a cache, not state.** The compiler API instance and Prettier are warmed and reused
   for performance. They must not carry information between requests; each verification supplies a
   complete file set and complete compiler options. Reuse that changed output would violate
   Principle I.

## Error taxonomy

Thrown, and mapped by each adapter to its own idiom — `isError: true` results for MCP, exit codes for
the CLI:

| Error | Meaning | Caller-correctable |
|---|---|---|
| `UnknownPatternError` | Name not in catalog. Carries nearest matches. | yes |
| `UnknownOptionError` | Option not declared for this pattern. Carries the valid option names. | yes |
| `InvalidOptionValueError` | Value outside the declared space. Carries permitted values. | yes |
| `IllegalCombinationError` | A legality rule matched. Carries the rule text and alternatives verbatim (FR-009). | yes |
| `InvalidIdentifierError` | Failed the identifier pattern, length cap, or reserved-word denylist. | yes |
| `MissingRequiredOptionError` | e.g. `coreModule` absent when `emitScope` is `binding-only`. | yes |
| `VerificationError` | Generated bundle failed to compile or its tests failed. **Always our defect.** Carries diagnostics for our logs, not for the caller. | no |

Correctable errors are the interesting ones: their messages must let an agent fix the call without an
additional discovery round trip (SC-007). Every one therefore names the field, states the rule, and
enumerates alternatives.

## Determinism obligations on engine internals

These are the concrete rules that make Principle I hold, and each has a corresponding test:

- No `Date`, `Math.random`, `process.env`, or filesystem reads in the generation path.
- No iteration over unordered collections without an explicit sort. Object key order is normalized.
- Emitted member order comes from a declared sort, not from source order or insertion order.
- Optional features are emitted as additive sections so enabling one does not reflow unrelated output
  (Principle II).
- The provenance header contains pattern identity and the options hash only. Generator and toolchain
  versions live in response metadata, because embedding them would rewrite every generated file on
  every release and destroy diff-stability (FR-021).
