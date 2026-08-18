/**
 * The held-out task set: what callers actually arrive wanting.
 *
 * Held out from the catalogue rather than derived from it. Every goal below is written in the words of the
 * problem — a flaky upload, a half-applied transfer, a burst of keystrokes — and none of them names a
 * pattern, an option, or any phrase the catalogue uses. That is what makes them evidence about the
 * surface: a task written by paraphrasing an intent line would confirm that the intent line exists.
 *
 * The rest of the suite proves that generated code compiles, that its own tests pass, and that it is
 * byte-identical run to run. **None of that says the caller got what they asked for.** A bundle can be
 * flawless and answer a different question, and no snapshot would notice, because a snapshot's expectation
 * is whatever the generator last produced. `needs` is the missing assertion: the capability the goal named
 * has to be reachable in the emitted API, checked against the code rather than against a stored copy of it.
 *
 * `pattern` is the answer key and is never shown to the reader that constructs requests. Selecting a
 * pattern from a goal is the one step of SC-006 this harness cannot measure — a lexical stand-in for that
 * choice would be measuring the stand-in — so what is asserted here is everything after the choice: that
 * discovery carries enough to configure the pattern, and that the result does the thing.
 */

export interface Task {
  /** The caller's problem, in their words. Never mentions a pattern, an option, or catalogue phrasing. */
  readonly goal: string;
  /** The catalogue entry that answers it. The answer key, not an input. */
  readonly pattern: string;
  /** The domain noun the goal implies, for the patterns that generate around one. */
  readonly noun?: string;
  /** Options the goal *states* a need for, beyond the defaults. */
  readonly options?: Readonly<Record<string, string | number | boolean>>;
  /**
   * What has to be reachable for the goal to have been met, matched against the emitted source.
   *
   * Deliberately about the API rather than about the implementation: a caller's problem is solved by
   * something they can call, and an assertion on an internal would break every time the inside was
   * rewritten without the outside changing. Regexes rather than substrings so a name can be pinned to its
   * declaration — `export function x` and a mention of `x` in a comment are not the same claim.
   */
  readonly needs: readonly RegExp[];
}

export const TASKS: readonly Task[] = [
  {
    goal:
      "Uploads to our storage provider fail every so often for no reason we can see, and the request " +
      "in front of them dies with it. I want to give up eventually rather than hammer them, and stop " +
      "immediately if the user navigates away.",
    pattern: "retry",
    noun: "Upload",
    options: { cancellation: "abort-signal" },
    needs: [/AbortSignal/u, /readonly attempts: number/u, /export async function retryUpload/u],
  },
  {
    goal:
      "A transfer moves money between two accounts and updates a ledger row. If the third write throws " +
      "we currently leave the first two applied, and two people editing the same account overwrite each " +
      "other silently.",
    pattern: "unit-of-work",
    noun: "Account",
    needs: [/version/iu, /commit/u, /export/u],
  },
  {
    goal:
      "The search box fires a request on every keystroke. I want one request once the typing settles, " +
      "and I need to be able to test it without sleeping in the test.",
    pattern: "debounce",
    noun: "Search",
    needs: [/waitMs/u, /cancel/u, /Timers|setTimeout/u],
  },
  {
    goal:
      "Our billing service returns 200 with an error body, 404 for two different reasons, and " +
      "occasionally the socket just dies. Every call site is doing its own status-code archaeology.",
    pattern: "gateway",
    noun: "Invoice",
    needs: [/export/u, /status/iu],
  },
  {
    goal:
      "Two functions both take a string id — one wants the customer's, one wants the order's — and we " +
      "have shipped a bug twice now from passing the wrong one. They still need to work as strings " +
      "everywhere else.",
    pattern: "branded-type",
    needs: [/declare const|unique symbol|__brand/u, /export type/u],
  },
  {
    goal:
      "A webhook body arrives as unknown. Right now every function down the chain re-checks the same " +
      "three fields because none of them can tell the check already happened.",
    pattern: "parse-dont-validate",
    noun: "Webhook",
    needs: [/unknown/u, /export/u],
  },
  {
    goal:
      "We keep calling a partner API that has been down for ten minutes, and each call waits the full " +
      "timeout before failing. I want to stop trying and find out when it is back.",
    pattern: "circuit-breaker",
    noun: "Partner",
    needs: [/open|closed|half/iu, /export/u],
  },
  {
    goal:
      "An import job spawns one task per row and a large file takes the process down. I want a fixed " +
      "number running at once, and to know when the whole file is done.",
    pattern: "async-queue",
    noun: "Import",
    needs: [/concurrency|limit/iu, /drain|onIdle|settle/iu],
  },
  {
    goal:
      "A draft order can have items added; a submitted one cannot. Today that is a comment and a " +
      "run-time throw, and it gets ignored about once a quarter.",
    pattern: "typestate",
    noun: "Order",
    needs: [/export/u, /draft/iu, /submitted/iu],
  },
  {
    goal:
      "We are on one provider's SDK in forty files. I want to try a second provider without touching " +
      "any of them, and to test the wire handling against a body we captured from the real thing.",
    pattern: "chat-model-port",
    needs: [/export interface/u, /fetch|transport/iu],
  },
  {
    goal:
      "The conversation we send grows until the provider rejects it. I need to drop what we can afford " +
      "to lose, keep the system instructions, and leave room for the reply.",
    pattern: "context-budget",
    needs: [/contextWindow/u, /reserveForOutput/u],
  },
  {
    goal:
      "The model is supposed to answer with an object matching a schema and sometimes answers with " +
      "prose instead. I want a typed value or a clear failure, and one more go when it is malformed.",
    pattern: "structured-output",
    options: { onInvalid: "retry" },
    needs: [/schema/iu, /export/u],
  },
  {
    goal:
      'Every method on our ledger object needs timing added. I do not want to write "start a timer" ' +
      "forty times, and I do not want callers to see a different type afterwards.",
    pattern: "decorator",
    noun: "Ledger",
    needs: [/export function/u, /member/u],
  },
  {
    goal:
      "Deciding whether an order is collectable is written inline in six places with slightly " +
      "different conditions, and one of them is wrong. I also need the same rule against the database.",
    pattern: "specification",
    noun: "Order",
    options: { translation: true },
    needs: [/isSatisfiedBy/u, /export/u],
  },
  {
    goal:
      "Our event emitter takes a string and a payload, so a typo in the event name is a silent no-op " +
      "and a handler with the wrong arguments compiles fine.",
    pattern: "typed-emitter",
    noun: "Order",
    needs: [/export interface/u, /on\(/u],
  },
  {
    goal:
      "We need exactly one database connection pool for the process and a way for anything to reach it.",
    pattern: "singleton",
    needs: [],
  },
  {
    goal:
      "I want to walk the items of our own collection type in a for-of loop without callers knowing it " +
      "is backed by two arrays.",
    pattern: "iterator",
    needs: [],
  },
];

/** The tasks whose answer is advice rather than code, which is a valid answer to a valid request. */
export function isAdvisoryTask(task: Task): boolean {
  return task.needs.length === 0;
}
