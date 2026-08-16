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
  machinery lives, and the generated binding MUST reference that location. Any specifier a project can
  legitimately write MUST be accepted, including one that climbs out of the binding's own directory — a
  binding in `src/orders` reaching machinery in `src/lib` has no other way to name it. Amended after a
  defect: a climb was refused, because verification writes the regenerated machinery at the path the
  specifier resolves to and a bundle placed at the sandbox root resolved it above the root. The layout the
  split exists to serve was therefore the one layout it could not serve, and the refusal listed only the
  shapes it did accept, so a caller reading it could not tell that their specifier was valid and their
  layout unsupported.
- **FR-019**: The catalog MUST record, per pattern, whether it supports a machinery/binding split.
- **FR-020**: Generated files MUST carry a provenance marker identifying the producing pattern and a
  deterministic representation of the resolved options. A *shared support file* — one whose content is
  byte-identical for every pattern and every option set, currently only the `node:test` assertion shim —
  MUST instead be marked as shared, and MUST NOT name a pattern or an options hash. Amended after a
  defect: attributing such a file to whichever request happened to emit it made its bytes vary per
  request, so two bundles unpacked into one directory overwrote each other's copy and the first bundle's
  suite stopped compiling. Each bundle was verified alone and each was correct alone.
- **FR-021**: Provenance markers MUST NOT embed values that change between service releases without
  a change in caller input.
- **FR-050**: A file's provenance marker MUST identify only inputs that can shape that file. Two inputs
  cannot: an option that selects which files a request gets back rather than what any of them says, and —
  for the shared machinery of a pattern that splits machinery from bindings — the caller's identifiers,
  which that half is defined not to know. Added after a defect of the same shape as FR-020, reached by a
  second *request* rather than a second pattern: the machinery comes back with every `full` request, so a
  project with two repositories was sent `repository-core.ts` twice, byte-different in the header alone
  because the hash covered the entity. Declining tests did the same to every file that survived. Beyond
  the overwriting, this disabled the check the marker exists for — the option-match check in research.md
  §11 compares an installed core's marker against what a new binding needs, and two cores generated under
  identical options did not agree. The marker MUST still distinguish machinery that genuinely differs: a
  hash that stopped moving would make every core look compatible with every binding, which is the same
  failure with the symptom hidden.
- **FR-048**: A file path MUST identify the pattern that produced it, so that no two patterns can emit
  the same path with different contents for any name a caller supplies. Where a pattern names a file
  after the caller's type, the pattern's own noun MUST remain in the name. Added after a defect of the
  same shape as FR-020, reached from the other direction: `typestate` named its file after the bare
  subject, and every pattern that appends a noun drops the repetition when the subject already ends in
  it (FR-046), so a `typestate` and a `branded-type` bundle for `OrderId` both claimed `order-id.ts`
  with different contents — as did `OrderRepository`, `OrderEmitter`, `Result` and `Event` against their
  patterns. Unpacked together, whichever was written last won. Keeping the noun also stops the service
  claiming `order.ts`, which is the name the caller's own type is most likely to already hold.

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
- **FR-049**: A convention the generated code cannot be verified under MUST be refused as the caller's to
  correct, naming the setting and why that value in particular, rather than attempted and reported as a
  pattern defect. Print width is the case this was added for: a type-level assertion applies to the line
  below it, so a width that wraps that line moves the assertion off the expression it was written for, and
  the directive is then reported unused while the error it suppressed escapes. Two patterns broke at 40,
  which is fixed; three more break below it, so 40 is the floor and narrower is refused. A refusal a
  caller can act on is the point: `Generated code failed to compile. This is a defect in the pattern` is
  true of every other cause of that failure and useless here, where the one thing that would fix it is
  the setting they chose.

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

- **FR-051**: A request naming a field the interface does not accept MUST be refused, and the refusal MUST
  say where the value belongs when it belongs somewhere. Added after a defect: options, identifiers and
  conventions are three families of caller-supplied value with three destinations, and a value written
  outside all three was *discarded* — so a caller who asked for offset pagination beside `options` rather
  than inside it received cursor pagination and a successful-looking response. An undeclared option is
  refused and a misplaced one was ignored, which is one question answered two ways, and the silent answer
  is the one that returns wrong code. The published schema MUST forbid unknown fields as well, so a client
  can catch the mistake before the call is sent. The refusal MUST offer only destinations the tool it came
  from actually has, and MUST treat a field name as a caller-supplied value under FR-035 — a key can carry
  an injected instruction as easily as a value can.

### Functional Requirements — Safety

- **FR-032**: Every caller-supplied identifier MUST be validated against a strict pattern and a
  reserved-word denylist before it reaches generation, and every string MUST be length-limited. The set
  of identifier *roles* a pattern accepts MUST be declared in the catalog, published through the
  describe tool, and closed: a role the pattern does not declare MUST be refused with the declared roles
  named, and a pattern declaring none MUST refuse any. Amended after a defect: an undeclared role was
  accepted and ignored, so a call that changed nothing read as success — and because the role still
  entered the options hash, the six patterns that read no identifier returned byte-different provenance
  headers over a name that appeared in none of their files, which is Principle I failing silently.
- **FR-033**: Output file paths MUST be derived from validated inputs; the service MUST NOT accept
  caller-supplied paths.
- **FR-034**: The service MUST NOT execute caller-supplied content. Generated code MUST NOT contain
  credentials or install-time hooks, and MUST NOT reach the network except where the requested pattern
  declares that reaching it is the pattern's subject. A declaring pattern MUST say so in its catalogue
  entry, MUST confine the call to a boundary the caller supplies or replaces — a `fetch`-shaped parameter,
  which may default to the platform's but must be a parameter — and MUST NOT contact a host the caller did
  not choose. A default host is permitted only where choosing it *is* the request: an adapter asked for in
  a named provider's wire format may default to that provider's documented endpoint, and MUST accept an
  override. What is forbidden is a host that appears in neither the caller's arguments nor their choice of
  provider. Amended after the
  original wording was read literally against the catalogue: `gateway` and `chat-model-port` exist to give
  a caller a typed edge around an HTTP call, so a blanket ban made the two patterns most in need of a
  reviewed shape the two the requirement said could not exist. What the ban was protecting against is
  code that calls out *without the caller knowing*, and that is what the narrower wording forbids. The
  practical difference is testable, and is tested: a declared boundary is injectable, so the emitted tests
  pass a fake transport rather than dialling, and the verification sandbox replaces every network entry
  point the runtime offers with one that throws — so a pattern whose tests only *appeared* to stay offline
  would fail verification rather than reach a host. That denial is a preload the sandbox installs, not a
  property of the runtime's permission model, which governs the filesystem, child processes, workers and
  addons and leaves sockets open; it was assumed otherwise until a probe under the real flags resolved a
  real hostname.
- **FR-035**: Caller-supplied values MUST be escaped or elided before appearing in any message
  returned to a caller.
- **FR-036**: Catalog content MUST be original or under terms permitting commercial redistribution
  and modification, and each entry MUST record its provenance. Emitted code MUST carry no licence
  condition of its own: the product is code a caller pastes into their own repository, and a notice
  obliged to travel with a file that is meant to be edited as the caller's own would make the pasting
  worse for no benefit to anyone. The licence therefore states this explicitly rather than leaving the
  tool's own terms to be inferred over the output, and the claim it makes about the catalogue MUST be
  checked against the catalogue rather than trusted, since a borrowed implementation is a permitted
  addition that would silently falsify it.
- **FR-037**: Remote connections MUST validate the declared origin and target host of each request,
  MUST reject a request whose declared operation contradicts its content, MUST refuse superseded
  request forms rather than serving them, and MUST NOT create, echo, or read session identifiers.
- **FR-038**: Internal diagnostic detail — compiler output, stack traces, file system paths — MUST NOT
  be returned to callers; an internal failure MUST be reported as a short message plus a correlation
  identifier.
- **FR-039**: Schema validation MUST NOT resolve external references.
- **FR-053**: The service MUST NOT serve on a runtime that cannot enforce the sandbox its own
  verification depends on, and MUST say what is required and what is running. Generated tests execute
  under the host runtime's permission model, which is what confines them to the filesystem they were given
  and denies them a child process — the network half of FR-034 is closed separately, because the permission
  model does not cover sockets. Where the flag enabling it is absent, the child process fails before
  reading the test file
  and the failure is indistinguishable, from inside, from a test that did not pass. Added after a
  defect: the runtime floor was declared as an installable range and enforced nowhere, so an older host
  answered every request carrying tests with "this is a defect in the pattern, not in your request" and
  a correlation identifier for a bug that did not exist — misattributing the operator's environment to
  the catalogue, and inviting a report nobody could act on. Refusing at startup is required over serving
  the subset that still works: a request without tests would succeed on such a host, and a service whose
  central guarantee silently does not hold is worse than one that is plainly absent. The floor MUST be
  stated in one place that the installable range, the startup check, and the engine all read.
- **FR-054**: Metadata the service attaches to its own results MUST be named under a namespace the
  publisher holds, and MUST NOT be named under one the protocol reserves for itself. The reserved
  namespaces are identified by structure rather than by a list — any prefix whose second label is
  `modelcontextprotocol` or `mcp` — and only the protocol and its official extensions allocate names
  there. Added after a defect: the service annotated results with a key in the reserved namespace, on the
  reasoning that borrowing the protocol's vocabulary would spare a client from learning a second one. The
  protocol defines no such key, so no client could recognise it, and a name sitting where a later revision
  is entitled to define its own meaning would not go on being ignored — it would be *misread*, which is
  the one outcome worse than silence. Conformance to the targeted revision MUST be observable in tests
  against the transport actually served, including the requests it requires, the fields it requires on
  every result, the error codes it retires, and the methods it removes; and where the service serves more
  than one protocol era, each era MUST be exercised as such, since the era is chosen by how a connection
  opens and a suite that only ever opened one of them proves nothing about the other.

### Functional Requirements — Naming

- **FR-040**: Derivation of identifiers from caller-supplied names — plural forms, casing variants, and
  file-name stems — MUST be governed by a versioned table owned by the service, MUST NOT depend on a
  third-party library whose behaviour can change on upgrade, and MUST resolve any given name to exactly
  one documented result.
- **FR-041**: A name the derivation table cannot resolve confidently MUST be refused with the rule
  stated, rather than approximated. The refusal MUST reach the caller. Amended after a defect: it was
  produced correctly and then discarded by the pipeline, which fell back to generic names — a request
  for a `Staff` repository returned an `EntityRepository`, with nothing said. An ending counts as
  doubtful only where English is genuinely doubtful, not merely where a Latin plural exists: treating
  every `-ion` noun as unresolvable refused thirteen of the commonest nouns a domain has, so making the
  refusal visible without narrowing the rule would have been a regression rather than a fix.
- **FR-044**: A noun whose plural equals its singular MUST be recognised as such rather than given an
  invented plural. Added after an audit prompted by one wrong answer, `Aircrafts`: the list of such
  words held seven entries and the class has scores, so nearly every candidate tried was pluralised
  confidently and wrongly — `Corps` became `Corpses`, `Middleware` became `Middlewares`, `Analytics`
  became `Analyticses`. This is the worse of the two failures, because a doubtful ending is refused and
  says why, whereas these returned working code carrying a word that is not English. The list cannot be
  complete, so two endings that are reliably mass nouns are covered as groups, `-ware` and `-craft`.
  Where an ending is genuinely both — `-ics` is a field name and also the plural of an `-ic` noun, so
  `Mechanics` is at once invariant and a plural — it MUST be treated as doubtful and refused, with the
  field names resolving from the table. Amended after the same audit reached names that are already
  plural: a bare `-s` cannot be told apart from a plural, so `Orders` — among the likeliest things
  anyone hands a repository — became `orderses`, as the collection name rather than only a type, and it
  MUST now be refused. A double `s` is exempt because nothing about `classes` or `addresses` is
  doubtful, and the genuine singulars that remain, `alias` and `lens` among them, resolve from the
  table like every other exception. A confidently wrong plural of the same kind MUST be fixed as a rule
  where English has one: a single `z` after a vowel doubles, so `Quiz` gives `Quizzes` and not the
  `Quizes` the `-s`/`-x`/`-z` rule produced.
- **FR-045**: An identifier MUST be cased from the words it is made of, never by changing a single
  character of it. Added after two defects found by sweeping names that differ from `Order` in shape
  rather than in length. Lowercasing the whole subject ran the words together, so a `WebhookEvent`
  request exported `webhookeventId` and titled a test "accepts a well-formed webhookevent";
  lowercasing only the leading character mangles every acronym, so an `APIKey` request exported a
  factory named `aPIKeyId`. Both compiled, both passed the generated tests, and neither is reachable
  with a single-word name whose every casing coincides — which is why the conformance sweep MUST
  include a multi-word name and an acronym, with the generated tests, rather than a length case alone.
- **FR-046**: Where a pattern appends its own noun to the caller's name, a repetition MUST be dropped
  wherever the two names meet, not only where the noun is the whole of the overlap. Amended after the
  rule that gave `OrderId` instead of `OrderIdId` was found to be too narrow: `Event` is the likeliest
  subject anyone gives an emitter, and it produced `EventEvents` and `EventEventName`. A noun matching
  the name's plural counts as the same word. The collapse MUST NOT be applied where the pattern needs
  both names to differ — `typestate` names a class after the subject and a union after its states, so
  a `State` subject keeps `StateState` rather than colliding.
- **FR-047**: A refused identifier MUST name the value that was refused, or say that it is withholding
  it, and state the rule once. Added after a defect: the caller-facing message was produced by
  stripping every quoted span out of the engine's sentence, which removed the value and left the role
  quoted where the value belonged — a request for an `Error` entity was answered "entity the supplied
  value is reserved and cannot be used as a generated name", with the opening clause repeated at the
  end and the offending name absent. A value MUST be echoed only when it is inert, which a value that
  passed the identifier charset always is, and described otherwise: the reason the stripping existed
  is real, since a value that fails that charset can carry prose and prose in a tool result is an
  instruction to whatever reads it next.
- **FR-052**: A name a pattern writes for itself MUST NOT be able to break a caller's request. Where the
  colliding name of ours belongs to an example or a suite, the generated file MUST step aside and say in
  the file why it is not called what was asked for; where it belongs to something the caller builds
  against, the request MUST be refused as a collision. Added after a sweep that fed every pattern the
  names it writes literally, and the nouns it appends, back to it as the caller's name: seven patterns
  produced a bundle that failed its own compiler, and three of the names were ordinary domain nouns.
  `branded-type` declares a second brand called `CustomerId` so its example can show that two brands do
  not interchange, so `Customer` was unusable; `unit-of-work` exports a seam called `Store`, so `Store`
  was unusable; the collapse of FR-046 derives the record type of an `AuditRecord` as `AuditRecord`, so
  an example declaring a stand-in beside it declared the same name twice, in that pattern and in
  `repository` both. Each was answered "this is a defect in the pattern, not in your request" — true,
  and no use to a caller holding a name they cannot use and no way to know why. A refusal MUST remain
  necessary: a name declared as emitted but no longer written is a request the service could serve and
  declines to. A collision MUST be judged on the name that reaches the code rather than on the spelling
  sent, since the two casings are one request: comparing spellings accepted `repository` where
  `Repository` was refused, and six of the thirteen refused names had a lowercase spelling that got
  through to a bundle that would not compile. An acronym is not the same name — `REPOSITORY` survives
  the derivation as itself — and MUST NOT be refused for resembling one. The names considered MUST include
  those a pattern writes only under a non-default option, since a branch writes a name as literally as the
  defaults do: reading one render at the defaults missed `specification`'s `RefinedBy`, written only under
  `composition=free`, and `unit-of-work`'s `KeyChangedError`, thrown only under `tracking=snapshot`. A name
  that stays refused MUST be discoverable before it is sent, since FR-009's reasoning applies here as much
  as to a legality rule: a caller who learns a name is taken by being refused for it has spent a turn on
  something the service knew before they asked. `describe_pattern` therefore states them, and the
  disclosure MUST agree with the refusal rather than merely exist.
- **FR-043**: Every pattern MUST generate correctly for the longest identifier the validator accepts,
  not only for a short one. Added after a defect: identifier length decides where generated code wraps,
  and a wrapped statement can carry a `@ts-expect-error` away from the error it asserts — the directive
  then suppresses nothing, the escaped error is reported, and the pattern fails its own verification for
  no reason but the caller's choice of noun. Three patterns did this, the first at seven characters.

### Functional Requirements — Caching

- **FR-042**: Every response MUST carry an explicit cacheability statement reflecting its actual
  reusability, rather than defaulting to the most conservative available value. A refusal is included:
  the request decides it, so the same request is refused identically, and leaving it unstated invites a
  caller to retry a call whose outcome cannot change. The single exception is a failure the service could
  not classify — a defect is not a fact about the request, the next attempt may well succeed, and marking
  it reusable would make one bad moment permanent for as long as the entry lives. Amended after a defect:
  the statement was carried on tool *descriptors* only, which a client reads once when discovering what
  exists, so a caller holding a generated bundle had nothing describing the answer in front of them and
  had to fall back on the transport's own conservative default — which describes a service whose answers
  vary by caller and expire at once, the opposite of this one.

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
