# Feature Specification: TypeScript Pattern Generation Service

**Feature Branch**: `001-typescript-pattern-mcp`

**Created**: 2026-08-09

**Status**: Planned — plan, design artifacts, and tasks complete; cross-artifact analysis passed with
no remaining CRITICAL or HIGH findings

**Input**: User description: "A service that lets an AI coding agent request TypeScript
implementation patterns. The agent calls a tool with structured parameters that deterministically
shape the generated result, and receives back a fully fleshed-out, library-grade implementation it
can use immediately or adjust slightly. It is not a pattern example — it is a designed
implementation, complete with the other methods the caller will need later, such that reusing the
same pattern elsewhere in the codebase becomes significantly easier."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request a working pattern implementation (Priority: P1)

An AI coding agent is working in a TypeScript repository and needs a capability it would otherwise
hand-write — say a repository over an `Order` entity, or retry-with-backoff around a flaky call. It
asks the service for that pattern, supplying the domain names and the choices that matter (whether
errors are thrown or returned, whether the code is async, how cancellation is handled). It receives
a complete, ready-to-commit implementation: the working code, the types, a usage example, and tests,
along with confirmation that the code compiles and the tests pass.

**Why this priority**: This is the entire product. Every other story is discovery, economy, or
delivery around this one exchange. If only this works, the service is already useful.

**Independent Test**: Request one pattern with explicit options and confirm the returned files
compile, the returned tests pass, and the response states as much. Fully testable without any other
story existing.

**Acceptance Scenarios**:

1. **Given** a valid pattern name and a complete set of options, **When** the agent requests
   generation, **Then** it receives a multi-file result containing implementation, types, usage
   example, and tests, plus a verification record confirming compilation and test success.
2. **Given** the same pattern name and identical options, **When** the request is repeated any
   number of times, **Then** the returned file contents are byte-for-byte identical every time.
3. **Given** a valid pattern name with most options omitted, **When** the agent requests generation,
   **Then** defaults are applied, the result is complete and verified, and the response reports
   which values were used.
4. **Given** options that cannot coexist, **When** the agent requests generation, **Then** the
   request is refused with a message naming the offending option, stating the rule, and listing
   valid alternatives — and no code is returned.
5. **Given** an option value that would produce invalid code if interpolated (a reserved word, an
   illegal identifier), **When** the agent requests generation, **Then** the request is refused
   before generation begins.

---

### User Story 2 - Discover what is available and how to configure it (Priority: P2)

The agent does not know the catalog by heart. Before generating, it needs to find out which
patterns exist, which one fits the problem it is looking at, and what knobs that pattern accepts —
without burning a large amount of its context on documentation it will not use.

**Why this priority**: Without discovery the agent must guess pattern names and option values,
which converts most first attempts into failed calls. It ranks below generation only because a
hardcoded caller could work without it.

**Independent Test**: Ask for the catalog, pick a pattern from the response, ask for that pattern's
details, and confirm the returned option names and values are sufficient to construct a successful
generation request.

**Acceptance Scenarios**:

1. **Given** no prior knowledge, **When** the agent asks for the catalog, **Then** it receives every
   available pattern with a short intent, its category, and enough identity to request it, in a
   payload small enough to read cheaply.
2. **Given** a catalog entry, **When** the agent asks for that pattern's details, **Then** it
   receives the full option list with types, permitted values, defaults, legality rules, and
   available variants.
3. **Given** a category or capability filter, **When** the agent asks for the catalog, **Then** only
   matching patterns are returned.
4. **Given** an application or human user rather than a model, **When** the catalog is requested as
   attachable reference content, **Then** the same catalog is available that way and is marked as
   cacheable.

---

### User Story 3 - Reuse an installed pattern cheaply (Priority: P3)

The agent already generated this pattern into this repository earlier — the shared machinery is
sitting in a file. Now it needs the same pattern applied to a second domain type. It should get just
the small piece that binds the existing machinery to the new type, not a duplicate copy of
everything.

**Why this priority**: This is what makes the service compound in value rather than producing
near-duplicate files. It is P3 only because the first use must work before the second matters.

**Independent Test**: Generate a pattern in full, then request the same pattern for a different
domain type while pointing at the first result's shared module, and confirm the second response
contains only the binding and imports the existing machinery.

**Acceptance Scenarios**:

1. **Given** a pattern that separates shared machinery from per-type bindings, **When** the agent
   requests only the binding and identifies where the machinery already lives, **Then** the response
   contains only binding files that import from that location and compile against it.
2. **Given** the same request without identifying existing machinery, **When** generation runs,
   **Then** the complete set is returned, machinery included.
3. **Given** a pattern that has no meaningful binding layer, **When** a binding-only result is
   requested, **Then** the request is refused with an explanation of what that pattern does support.
4. **Given** a previously generated file, **When** a reader or agent inspects it, **Then** it can
   determine which pattern produced it and under which resolved options, without external records.
5. **Given** an existing result, **When** the same pattern is regenerated with one option changed,
   **Then** the differences are confined to the part of the output that option governs.

---

### User Story 4 - Be steered away from the wrong pattern (Priority: P4)

The agent asks for a pattern that TypeScript has made unnecessary. Rather than dutifully producing
an elaborate structure nobody should write, the service explains what to do instead and shows the
idiomatic form.

**Why this priority**: It prevents a category of actively harmful output and is a capability no
comparable service offers, but it improves quality rather than enabling the core job.

**Independent Test**: Request a pattern known to be obsolete in TypeScript and confirm the response
is advisory guidance with an idiomatic alternative, clearly marked as advice rather than a
generated implementation, and not an error.

**Acceptance Scenarios**:

1. **Given** a pattern the catalog marks as superseded by a language feature, **When** the agent
   requests it, **Then** the response is marked as advisory, contains the idiomatic replacement and
   the reasoning, and is not reported as a failure.
2. **Given** such a pattern, **When** the agent consults the catalog beforehand, **Then** the entry
   already indicates it is advisory, so the agent can skip the call.

---

### User Story 5 - Match the calling project's conventions (Priority: P4)

A repository has its own house style — strictness settings, module and import conventions, preferred
error handling, test framework, formatting rules. Generated code that ignores these arrives needing
cleanup, which erodes the benefit of not writing it by hand.

**Why this priority**: It is the difference between output that is committed as-is and output that
is edited on arrival. It shares P4 with advisory guidance as a quality multiplier on the core flow.

**Independent Test**: Submit the same pattern request twice with two different convention sets and
confirm each result conforms to, and is verified against, the conventions supplied with it.

**Acceptance Scenarios**:

1. **Given** caller-supplied conventions, **When** generation runs, **Then** the output follows them
   and verification is performed under those same settings rather than defaults.
2. **Given** no conventions supplied, **When** generation runs, **Then** the strictest reasonable
   defaults apply and are reported in the response.
3. **Given** conventions strictly stronger than the defaults, **When** generation runs, **Then**
   output that would fail under those stronger settings is never returned.

---

### User Story 6 - Use the generator without an agent (Priority: P5)

A developer wants the same generation from a terminal or a script — to try a pattern, to script bulk
generation, or to check output into a repository through normal review.

**Why this priority**: It hedges the main delivery risk (agent hosts becoming reluctant to carry
tool definitions) and costs little once generation is independent of the transport. It is last
because agents are the primary audience.

**Independent Test**: Generate the same pattern and options through both the agent-facing and
command-line surfaces and confirm byte-identical results.

**Acceptance Scenarios**:

1. **Given** identical pattern and options, **When** generation is invoked from the command line and
   from the agent-facing interface, **Then** the produced files are byte-identical.
2. **Given** a command-line invocation, **When** generation fails validation, **Then** the same
   explanatory message is produced as the agent-facing surface would give, with a non-zero exit
   status.

---

### Edge Cases

- A requested pattern name does not exist: refuse with the closest valid names, not a bare failure.
- A domain name collides with a language keyword or an emitted helper name: refuse before generating.
- A caller points at shared machinery that does not exist or does not match what the pattern
  expects: refuse with what was expected, rather than emitting code that cannot compile.
- A caller supplies conventions that are internally contradictory: refuse, naming the conflict.
- A result would exceed the response size budget: return a coherent subset plus an explicit
  statement of what was omitted and how to obtain it — never a silently truncated file.
- A generated bundle fails its own verification: refuse and report an internal defect with a
  correlation identifier; never return unverified code.
- Extremely long or deeply nested option values: reject on documented limits before generation.
- Two requests arrive concurrently: neither may influence the other's output.
- A pattern legitimately produces no tests: the response must state that rather than implying tests
  passed.

## Requirements *(mandatory)*

### Functional Requirements — Generation

- **FR-001**: The service MUST generate complete TypeScript implementations for a curated catalog of
  patterns, selected by name with structured options.
- **FR-002**: Generation MUST be deterministic — identical inputs MUST always produce byte-identical
  output.
- **FR-003**: Generated implementations MUST expose the full method surface a production caller
  needs, with documented extension points, rather than a minimal illustrative subset.
- **FR-004**: Results MUST be returned as multiple named files, each labelled with its role
  (shared machinery, binding, adapter, test, example).
- **FR-005**: The service MUST NOT return code that fails to compile, and MUST NOT return tests that
  fail.
- **FR-006**: Every successful response MUST include a verification record stating the compiler
  version, the exact options verified against, the diagnostic count, the test outcome, and a content
  hash.
- **FR-007**: Responses MUST report the fully resolved option set, including values that came from
  defaults.
- **FR-008**: The service MUST reject option combinations that cannot produce correct code, and MUST
  NOT emit a plausible-but-incorrect result in their place.
- **FR-009**: Rejections MUST name the offending option, state the governing rule, and enumerate
  valid alternatives.
- **FR-010**: Changing a single option MUST produce output whose differences are confined to that
  option's surface.

### Functional Requirements — Discovery

- **FR-011**: The service MUST provide a browsable catalog of available patterns, each with intent,
  category, and identity sufficient to request it.
- **FR-012**: The catalog MUST be filterable by at least category and by whether an entry is
  generative or advisory.
- **FR-013**: The service MUST provide per-pattern detail covering every option, its permitted
  values, its default, its legality rules, and available variants.
- **FR-014**: The catalog MUST also be obtainable as attachable reference content for applications
  and human users, marked as cacheable.
- **FR-015**: Pattern and option identifiers MUST be human-readable and stable; opaque generated
  identifiers MUST NOT be used.
- **FR-016**: Every option exposed to callers MUST carry a description.

### Functional Requirements — Reuse

- **FR-017**: For patterns that separate shared machinery from per-type bindings, callers MUST be
  able to request the complete set, the machinery alone, or a binding alone.
- **FR-018**: When requesting a binding alone, callers MUST be able to identify where the existing
  machinery lives, and the generated binding MUST reference that location.
- **FR-019**: The catalog MUST record, per pattern, whether it supports a machinery/binding split.
- **FR-020**: Generated files MUST carry a provenance marker identifying the producing pattern and a
  deterministic representation of the resolved options.
- **FR-021**: Provenance markers MUST NOT embed values that change between service releases without
  a change in caller input.

### Functional Requirements — Guidance

- **FR-022**: For patterns superseded by TypeScript language features, the service MUST return
  advisory guidance with an idiomatic alternative and its rationale, marked as advisory, and MUST
  NOT treat the request as a failure.
- **FR-023**: The catalog MUST identify advisory entries in advance so callers can avoid the call.

### Functional Requirements — Caller Conventions

- **FR-024**: Callers MUST be able to supply project conventions including compiler strictness,
  module and import style, error handling style, test framework, and formatting configuration.
- **FR-025**: Verification MUST be performed under the caller's supplied conventions when provided.
- **FR-026**: Absent caller conventions, the strictest reasonable defaults MUST apply and MUST be
  reported.

### Functional Requirements — Interface and Delivery

- **FR-027**: The agent-facing interface MUST expose a small number of operations and MUST NOT
  require callers to carry full option documentation for every pattern at all times.
- **FR-028**: Responses MUST respect a documented size budget, MUST support caller-controlled
  verbosity, and MUST state what to request next when content is omitted.
- **FR-029**: The generation engine MUST be usable independently of the agent-facing protocol, and
  all surfaces MUST produce identical results for identical inputs.
- **FR-030**: The service MUST support both local process-based and remote network-based agent
  connections.
- **FR-031**: The service MUST hold no state between requests; any cross-request continuity MUST be
  carried by explicit caller-supplied values.

### Functional Requirements — Safety

- **FR-032**: Every caller-supplied identifier MUST be validated against a strict pattern and a
  reserved-word denylist before it reaches generation, and every string MUST be length-limited.
- **FR-033**: Output file paths MUST be derived from validated inputs; the service MUST NOT accept
  caller-supplied paths.
- **FR-034**: The service MUST NOT execute caller-supplied content, and generated code MUST NOT
  contain network calls, credentials, or install-time hooks.
- **FR-035**: Caller-supplied values MUST be escaped or elided before appearing in any message
  returned to a caller.
- **FR-036**: Catalog content MUST be original or under terms permitting commercial redistribution
  and modification, and each entry MUST record its provenance.
- **FR-037**: Remote connections MUST validate the declared origin and target host of each request,
  MUST reject a request whose declared operation contradicts its content, MUST refuse superseded
  request forms rather than serving them, and MUST NOT create, echo, or read session identifiers.
- **FR-038**: Internal diagnostic detail — compiler output, stack traces, file system paths — MUST NOT
  be returned to callers; an internal failure MUST be reported as a short message plus a correlation
  identifier.
- **FR-039**: Schema validation MUST NOT resolve external references.

### Functional Requirements — Naming

- **FR-040**: Derivation of identifiers from caller-supplied names — plural forms, casing variants, and
  file-name stems — MUST be governed by a versioned table owned by the service, MUST NOT depend on a
  third-party library whose behaviour can change on upgrade, and MUST resolve any given name to exactly
  one documented result.
- **FR-041**: A name the derivation table cannot resolve confidently MUST be refused with the rule
  stated, rather than approximated.

### Functional Requirements — Caching

- **FR-042**: Every response MUST carry an explicit cacheability statement reflecting its actual
  reusability, rather than defaulting to the most conservative available value.

### Key Entities

- **Pattern**: A named, categorised capability the service can generate or advise on. Records its
  intent, whether it is generative or advisory, whether it supports a machinery/binding split, its
  variants, and its provenance and licence.
- **Option**: A single named knob on a pattern, with a type, permitted values, a default, a
  description, and legality rules relating it to other options.
- **Resolved Request**: The validated combination of a pattern and a complete option set, including
  defaults, that uniquely determines one output.
- **Bundle**: The multi-file result of a resolved request — the files, their roles, and accompanying
  notes and warnings.
- **File**: One generated artifact: its path, contents, role, and provenance marker.
- **Verification Record**: Evidence a bundle was checked — compiler version, options verified
  against, diagnostic count, test outcome, content hash.
- **Advisory**: The non-code response for a superseded pattern: the idiomatic alternative and the
  reasoning.
- **Conventions**: The caller's project settings that shape and are used to verify output.
- **Name Derivation Table**: The service-owned, versioned mapping from a caller-supplied domain name to
  the plural forms, casing variants, and file-name stems that generated code uses, including an explicit
  exception list for irregular forms.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of returned bundles compile, and 100% of returned bundles containing tests have
  passing tests — measured continuously, with zero tolerated exceptions.
- **SC-002**: Repeating any request produces byte-identical output 100% of the time, across process
  restarts and across machines.
- **SC-003**: Every documented option combination for every catalogued pattern is covered by a
  stored expected result that is verified on every change.
- **SC-004**: Applying a pattern to an additional domain type, where the machinery already exists,
  returns at most 20% of the content of the original full request.
- **SC-005**: Changing one option alters no more than the output that option governs, verified
  mechanically for every option.
- **SC-006**: A capable agent, given only the discovery operations and no prior knowledge, produces
  a valid generation request on its first attempt in at least 90% of trials across a held-out task
  set.
- **SC-007**: When a request is refused, an agent corrects it and succeeds on the next attempt in at
  least 90% of trials, without needing an additional discovery call.
- **SC-008**: A typical response fits within a documented budget well under the point at which
  common agent hosts truncate tool results.
- **SC-009**: Added latency from verification is a small fraction of total request time, and never
  the dominant cost.
- **SC-010**: Identical inputs produce identical output through every delivery surface, verified
  automatically.
- **SC-011**: The service satisfies the frozen conformance requirements for its target protocol
  revision, with any exception explicitly recorded and justified.
- **SC-012**: No catalogue entry carries terms forbidding commercial use or modification, verified
  in review.
- **SC-013**: At least 20 patterns are available at first release, weighted toward capabilities that
  agents demonstrably get wrong unaided rather than toward classical catalogue completeness.

## Assumptions

- The primary consumer is an AI coding agent operating inside an existing TypeScript project; human
  use through a command line is secondary but supported.
- Generation is template-driven and contains no language model, which is what makes determinism
  achievable; this is treated as settled rather than open.
- The pattern catalogue must be authored originally, because no existing catalogue carries terms
  permitting the commercial, modified redistribution this service performs.
- The project intends to permit commercial use, which is why NonCommercial and NoDerivatives content
  is excluded outright.
- Patterns worth generating are weighted toward those a capable model gets wrong unaided — type-level
  safety and asynchronous resilience — rather than toward classical patterns a model already writes
  correctly.
- Callers can inspect their own repository, so the service can rely on them to report existing
  machinery rather than remembering it.
- First release targets the current protocol revision only; superseded transports and deprecated
  protocol features are out of scope.
- Persistent storage, user accounts, and private per-customer pattern libraries are out of scope for
  first release; the service is a pure function over its inputs.
- The published package name is not yet chosen and is tracked as an open item; it does not affect
  scope.
