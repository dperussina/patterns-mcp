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
