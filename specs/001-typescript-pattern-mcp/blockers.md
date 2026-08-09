# Blockers and open questions

Recorded during implementation. Entries marked **open question** did not block the task that raised
them; the task shipped following the design as written, and the question is here for review.

---

## T017 — should `optionsHash` cover `conventions`? (open question)

**Status**: implemented as data-model.md specifies. Not blocking.

**What the design says**: `optionsHash` is a hash of `pattern` + `options` + `identifiers`
(data-model.md, ResolvedRequest). Conventions are not listed.

**The tension**: conventions change output bytes. `moduleStyle: "cjs"` versus `"esm"` produces
different imports and different file extensions. As implemented, two bundles that differ in those
bytes carry the *same* provenance header. FR-020's purpose is that a later agent can read a
repository and discover what is installed and how it was requested, and a hash that does not
distinguish two different outputs weakens that.

**The argument for leaving it out** (and why I did): FR-021 forbids embedding values that change
between service releases, because that rewrites every generated file's header on every release. A
caller's project-wide conventions are not a service release, but they are a project-wide setting —
changing `importExtensions` once would rewrite the header of every generated file in the repository,
which is the same diff-stability harm one step removed.

**What I did decide, and why it is not the same question**: `variant` *is* included, though
data-model.md's list predates that field. Variant is an option in everything but name and selects
materially different content, so omitting it would give two clearly different bundles an identical
hash — a defect rather than a trade-off.

**Recommendation**: include a `conventionsHash` as a *separate* field on the provenance header rather
than folding conventions into `optionsHash`. That keeps `optionsHash` stable for a given logical
request while still letting a reader tell that a file was generated under different project settings.
Needs a decision before T057 emits headers.

**Where it bites if unresolved**: T057 (header emission), and the diff-stability harness in T024/US1,
which will assert what does and does not change a header.

---

## T020 — a compiler killed mid-write takes the host process with it (open question)

**Status**: T020 shipped. Restart-on-crash works for every crash I could provoke except one narrow
race, described below. Not blocking, but it needs an owner's decision before the server ships.

**What happens**: kill the compiler subprocess and issue a request in the same tick, before Node has
processed the stream teardown, and the vendored JSON-RPC writer inside `typescript@7.0.2` calls
`write` on a destroyed stream. It throws from inside a promise executor that nothing awaits, so it
arrives as an unhandled rejection — fatal by default on Node 22. There is no seam for us to catch it:
the throw is in `vendor/vscode-jsonrpc/lib/node/ril.js`, not in our await chain.

**Measured**: at 0ms after the kill, the process dies. At 100ms, 500ms, and 1500ms, the retry recovers
in 35–58ms. So a compiler that dies on its own — the realistic case, since something must notice and
close the socket — is fully recoverable. Only a same-tick race is fatal.

**What I did**: added a deadline (a dead compiler does not reliably reject the request in flight, so
without one a crash could hold a request open forever) and made failure `#abandon` the compiler rather
than close it, because closing ends the pipe underneath a queued write and reproduces the same
unhandled error from our own recovery path. That one I could fix, and did.

**Recommendation**: the adapter that owns the process — MCP server or CLI, not the engine — installs a
`process.on("unhandledRejection")` handler that identifies `ERR_STREAM_DESTROYED` and
`ERR_STREAM_WRITE_AFTER_END` originating in the compiler transport and treats them as a compiler
restart rather than a fatal fault. A library installing a global handler would be overreach, which is
why the engine does not. Worth reporting upstream as well: the writer should guard `write` on a
destroyed stream.

**Where it bites if unresolved**: T088/T089 (server lifecycle) and T021, whose stable fallback is the
mitigation if the unstable transport proves too fragile under load.

---

## T020 — warm verification is ~13ms, not the ~5ms plan.md budgets (open question)

**Status**: T020 shipped. Does not threaten the end-to-end goal. Recorded because the number in
plan.md is now known to be wrong.

**Measured here**, async API, warm, median of 12 runs: 12.6ms for a seven-file bundle, ~9ms for two
files, ~130ms cold. plan.md's Performance Goals give "warm verification under 5ms per bundle
(typecheck measured at ~2.4ms via the async API)". The research figure was likely the diagnostics call
alone; the 12.6ms here covers `updateSnapshot` plus `getSemanticDiagnostics`, which is what a request
actually pays.

**Why it is not urgent**: the binding goal is end-to-end generation p95 under 50ms excluding transport.
At ~13ms, verification leaves ample room. The sub-budget is what is wrong, not the architecture.

**Recommendation**: amend plan.md's verification budget to 15ms warm and keep the 50ms end-to-end goal,
or accept the discrepancy explicitly. Do not chase 5ms by weakening verification. See the T022 entry
below, which makes the end-to-end number the more pressing of the two.

**Where it bites if unresolved**: T093 (performance validation) will measure against whichever number
plan.md states.

---

## T022 — executing tests costs ~60ms, so p95 under 50ms is unreachable for any bundle with tests

**Status**: T022 shipped and works. This is a conflict between two things plan.md asks for, and it
needs a decision rather than a code change.

**The conflict**: Principle III requires that a bundle containing tests has those tests executed
before it is returned, and `VerificationRecord.testOutcome` permits `skipped` *only* when the bundle
contains no tests. plan.md also sets "end-to-end generation p95 under 50ms excluding transport". A
sandboxed Node process costs 60–70ms to start and run a trivial test, measured five times with little
variance. Add ~13ms of typechecking and a request that includes tests cannot come in under ~75ms. The
floor is process startup, so no amount of tuning our code reaches 50ms.

**Options, in the order I would consider them**:

1. **Amend the budget** to something like "p95 under 100ms for bundles with tests, under 30ms
   without". Honest, costs nothing, and keeps Principle III intact.
2. **Cache verification by `contentHash`**. Identical bytes have already been proven to pass, and
   generation is deterministic, so a repeat request need not re-run anything. Turns the common case
   into a lookup and leaves the first request paying full price. Note this trades against the "no
   state between requests" constraint, though a pure function of content is a weak form of state.
3. **Execute tests only when asked**, with a `verifyTests` option defaulting to on. Fastest to
   implement and the worst of the three: it makes the guarantee conditional, and a caller optimising
   for latency would switch off the thing that makes the output trustworthy.

**Recommendation**: option 1 now, option 2 if measurement later shows it matters. Not option 3.

**Where it bites if unresolved**: T093 (performance validation) and T085 (token/latency budgets).

---

## T022 — which test framework can actually be executed (open question)

**Status**: T022 shipped against `node:test`. Nothing generates tests yet, so nothing is broken; this
needs settling before the generator emits its first test file.

**The problem**: `conventions.testFramework` offers `vitest` (the default), `node-test`, `jest`, and
`none`. The executor runs a transpiled bundle under Node's built-in runner, which resolves `node:test`
and `node:assert` because they ship with Node. A generated test that imports `vitest` cannot resolve
it inside the sandbox — vitest is not there, and putting it there would mean granting reads outside
the bundle and shipping vitest as a runtime dependency.

**Why it is not simply "generate node:test tests"**: FR-025 and the conventions contract promise output
that matches the caller's project, and a vitest user asking for a vitest test should not receive a
`node:test` file.

**Options**:

1. Emit the caller's framework, and for verification only, transpile with a small shim mapping the
   handful of API calls our templates use (`describe`, `it`/`test`, `expect`) onto `node:test` and
   `node:assert`. We control the vocabulary because we write the templates, so the shim is bounded and
   testable. Executed semantics differ slightly from the real framework.
2. Emit two files: the caller's test, plus an internal `node:test` equivalent that is executed and then
   discarded. Verifies something adjacent to what ships, which is weaker than it sounds.
3. Restrict the first release to `node-test` and treat other frameworks as a later feature. Honest but
   narrows the audience, since vitest is the default for a reason.

**Recommendation**: option 1. The shim is small, and its correctness is testable in its own right —
which is more than can be said for option 2, where the shipped file is never the file that ran.

**Where it bites if unresolved**: whichever task emits the test file (near T031/T102), and T066, which
asserts conventions are honoured.
