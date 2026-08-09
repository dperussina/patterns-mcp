# Implementation Loop

Operating instructions for the agent loop implementing this feature. Re-run until the work is
finished. Stateless by design — everything needed to resume is in the repository.

## Authority

- `.specify/memory/constitution.md` is binding. Principles I, III, and V are non-negotiable.
- `specs/001-typescript-pattern-mcp/tasks.md` is the work list and the ONLY record of progress.
- plan.md, research.md, data-model.md, contracts/*, quickstart.md are the design. Read the ones your
  current batch touches. Do not re-derive decisions already recorded there.

## Each iteration

1. Run `git status`. If the tree is dirty, finish or revert that work before starting anything new.
2. Read tasks.md. The first `- [ ]` task in file order is the head of this batch.
3. Read the constitution, plus the design artifacts this batch touches.
4. Choose the batch: the smallest coherent set of tasks that can reach a green gate together.
   - One sequential task, or one group of adjacent [P] tasks.
   - Never cross a phase boundary.
   - Never begin a Phase 3+ story until every Phase 2 task is [X].
5. From Phase 3 onward, write the batch's tests first and run them. Confirm they fail, and fail for
   the reason you intended, before writing any implementation.
6. Implement the batch.
7. Run the gate. It must be green.
8. Mark each finished task [X] in tasks.md.
9. Commit — subject says what changed, body lists the task IDs.
10. Report: tasks completed, gate result, the next batch, and any blocker.

## The gate

- Once `pnpm check` exists (T006), it is the gate. Before then, use whichever of
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build` exist.
- A stage joins `pnpm check` in the same task that creates it. Never wire a stage into the gate before
  the thing it checks exists; a permanently red gate makes every rule below unenforceable.

## Never

- Never mark a task [X] unless the gate passed with that task's work included.
- Never weaken a check to get green: no deleted or loosened assertions, no `.skip` or `.only`, no
  relaxed compiler or lint settings, no `any`, no `@ts-expect-error`, and never regenerate a golden
  snapshot to match new output. If output changed, either the change is wrong, or the snapshot update
  is intentional and must be called out explicitly in the commit message as a reviewed diff.
- Never let anything under `src/engine/` or `src/index.ts` import an MCP package.
- Never put a clock read, random value, `process.env`, or unordered iteration in the generation path.
- Never return a bundle that has not typechecked, or whose tests have not been executed.
- Never invent a decision the design left open. Never guess the published package name.
- Never commit with a red gate. Never push.

## When blocked

Blocked means the task needs a human decision, a credential, or information you cannot get by reading
the repo or running a command.

- Append to `specs/001-typescript-pattern-mcp/blockers.md`: task ID, what is needed, what you tried,
  what you recommend.
- Mark the task `- [!]`, not `- [X]`.
- Move to the next eligible task. Do not stall, and do not substitute a guess.
- Likely blockers: T090 (package name — needs the owner) and T094 (depends on T093's results).
  T082 is NOT a blocker: send the mismatched header and observe what happens.

## Stop and hand back when

- Every task is [X] or [!] → run all twelve quickstart.md scenarios, report results, stop.
- The same task has failed the gate three times → stop. Report what you tried and your best
  hypothesis. Do not keep retrying.
- The design turns out to be wrong rather than merely incomplete → stop and say so. Material scope
  changes return to the spec; they are not absorbed silently into code.
- Any destructive git operation seems necessary → stop and ask.
