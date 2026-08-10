/**
 * The `circuit-breaker` pattern: refusing to call a dependency that is failing.
 *
 * A breaker is the one pattern here that is legitimately a class. The `result` pattern is standalone
 * functions because a discriminated union has no state to keep; a breaker is *nothing but* state — the
 * current arm, when it opened, how many failures have landed — shared by every call that goes through
 * it. Expressing that as functions over an explicit state object would leave the caller responsible for
 * threading it, and the first time they created two breakers for one dependency the pattern would be
 * silently defeated.
 *
 * The decision that makes the emitted tests possible is the same one as in `retry`: the clock is
 * injected. A breaker's whole behaviour is time-dependent — cooldown expiry, window expiry — so a suite
 * using the real clock would either sleep for the cooldown or assert nothing about it. With `now` as an
 * option the tests move time instead of spending it, and the state machine's edges become exactly
 * assertable, which is what Principle III demands of a generated suite.
 *
 * `halfOpen` is the option worth reading twice. A breaker that closes on a single successful probe is
 * cheap and wrong when a dependency is flapping: one lucky call re-admits the full load, which knocks
 * it over, and the breaker spends its life cycling. `sampled` requires a quota of successes before
 * closing, which is slower to recover and much harder to fool.
 */

import { siblingSpecifier } from "../../generate/imports.js";
import { expectFile } from "../expect-file.js";
import { dedent, doc, docAt, joinLines, sections, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

interface Shape {
  /** `failureCounting: "rolling-window"` — failures expire instead of being cleared by a success. */
  readonly rolling: boolean;
  /** `halfOpen: "sampled"` — several probes and a success quota, rather than one decisive call. */
  readonly sampled: boolean;
}

interface Names {
  readonly stem: string;
  readonly breaker: string;
  readonly policy: string;
  readonly options: string;
  readonly openError: string;
  readonly defaults: string;
}

export const circuitBreakerPattern: PatternModule = {
  name: "circuit-breaker",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      rolling: options.failureCounting === "rolling-window",
      sampled: options.halfOpen === "sampled",
    };
    const names = namesFor(context);

    const files: RenderedFile[] = [
      { path: `${names.stem}.ts`, role: "core", contents: core(names, shape) },
      { path: `${names.stem}-example.ts`, role: "example", contents: example(context, names) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${names.stem}.test.ts`,
        role: "test",
        contents: tests(context, names, shape),
      });

      if (conventions.testFramework === "node-test") {
        files.push({ path: "expect.ts", role: "test", contents: expectHelper() });
      }
    }

    return files;
  },
};

/**
 * Every emitted name derives from the identifier, so a caller generating breakers for two dependencies
 * gets `payment-circuit-breaker.ts` and `search-circuit-breaker.ts` rather than a collision.
 */
function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;

  if (entity === undefined) {
    return {
      stem: "circuit-breaker",
      breaker: "CircuitBreaker",
      policy: "BreakerPolicy",
      options: "BreakerOptions",
      openError: "BreakerOpenError",
      defaults: "DEFAULT_BREAKER_POLICY",
    };
  }

  return {
    stem: `${entity.kebab}-circuit-breaker`,
    breaker: `${entity.pascal}CircuitBreaker`,
    policy: `${entity.pascal}BreakerPolicy`,
    options: `${entity.pascal}BreakerOptions`,
    openError: `${entity.pascal}BreakerOpenError`,
    defaults: `DEFAULT_${entity.screamingSnake}_BREAKER_POLICY`,
  };
}

function core(names: Names, shape: Shape): string {
  return sections(
    header(shape),
    stateType(),
    policyType(names, shape),
    defaults(names, shape),
    stateChangeType(),
    optionsType(names),
    openErrorClass(names),
    breakerClass(names, shape),
  );
}

function header(shape: Shape): string {
  const counting = shape.rolling
    ? "Failures are counted inside a rolling window, so a fault that never lets a clean run build up still trips the breaker, and old failures expire rather than being forgiven by one success."
    : "Failures are counted consecutively: a single success anywhere in the run clears the count, so only a sustained failure opens the breaker.";
  const recovery = shape.sampled
    ? "Recovery is tested with several probes and a success quota, which is slower to close but will not re-admit full load on the strength of one lucky call."
    : "Recovery is tested with a single probe, which closes the breaker if it succeeds and re-opens it if it does not.";

  return doc(
    "A circuit breaker around a failing dependency.",
    counting,
    recovery,
    "The clock is injectable, which is what makes the behaviour testable: pass a `now` that you control and every edge of the state machine — cooldown expiry, window expiry — becomes an exact assertion rather than a sleep.",
  );
}

function stateType(): string {
  return joinLines(
    doc(
      "`closed` passes calls through, `open` refuses them, `half-open` admits a limited number to find out whether the dependency is back.",
    ),
    'export type BreakerState = "closed" | "open" | "half-open";',
  );
}

function policyType(names: Names, shape: Shape): string {
  return joinLines(
    `export interface ${names.policy} {`,
    "  /** Failures needed to open the breaker. */",
    "  readonly failureThreshold: number;",
    "  /** How long to refuse calls before admitting a probe, in milliseconds. */",
    "  readonly cooldownMs: number;",
    when(
      shape.rolling,
      joinLines(
        docAt(
          2,
          "How far back failures count. A failure older than this is forgotten, which is what stops a slow trickle of unrelated faults from eventually adding up to an open breaker.",
        ),
        "  readonly windowMs: number;",
      ),
    ),
    when(
      shape.sampled,
      joinLines(
        "  /** How many probes may be in flight at once while half-open. */",
        "  readonly probeLimit: number;",
        "  /** How many probes must succeed before the breaker closes. */",
        "  readonly successesToClose: number;",
      ),
    ),
    "}",
  );
}

function defaults(names: Names, shape: Shape): string {
  return joinLines(
    `export const ${names.defaults}: ${names.policy} = {`,
    "  failureThreshold: 5,",
    "  cooldownMs: 30_000,",
    when(shape.rolling, "  windowMs: 60_000,"),
    when(shape.sampled, joinLines("  probeLimit: 3,", "  successesToClose: 2,")),
    "};",
  );
}

function stateChangeType(): string {
  return joinLines(
    "/** A transition, as reported to `onStateChange`. */",
    "export interface BreakerStateChange {",
    "  readonly from: BreakerState;",
    "  readonly to: BreakerState;",
    "  /** The clock reading at which it happened. */",
    "  readonly at: number;",
    "}",
  );
}

function optionsType(names: Names): string {
  return joinLines(
    `export interface ${names.options} extends Partial<${names.policy}> {`,
    docAt(
      2,
      "The clock, in milliseconds. Replaceable so that tests can move time rather than spend it — the emitted suite drives every transition through one it controls.",
    ),
    "  readonly now?: () => number;",
    docAt(
      2,
      "Whether an error counts against the breaker. Defaults to counting every error, which is rarely right: a 404 says the dependency is healthy and the request was wrong, and counting it opens the breaker on a working service.",
    ),
    "  readonly isFailure?: (error: unknown) => boolean;",
    docAt(2, "Called on every transition. The place for a log line, a metric, or an alert."),
    "  readonly onStateChange?: (change: BreakerStateChange) => void;",
    "}",
    "",
    "/** What `snapshot` reports. Enough to render a dashboard, and nothing a caller can mutate. */",
    "export interface BreakerSnapshot {",
    "  readonly state: BreakerState;",
    "  /** Failures currently counting towards the threshold. */",
    "  readonly failures: number;",
    "  /** Milliseconds until a probe is admitted; 0 unless open. */",
    "  readonly retryAfterMs: number;",
    "}",
  );
}

function openErrorClass(names: Names): string {
  return joinLines(
    doc(
      "Thrown instead of calling the dependency while the breaker is open.",
      "Carries `retryAfterMs` so a caller can decide between failing fast, serving something stale, and queueing — none of which it can choose if all it knows is that something went wrong.",
    ),
    `export class ${names.openError} extends Error {`,
    "  readonly retryAfterMs: number;",
    "",
    "  constructor(retryAfterMs: number) {",
    "    super(`circuit is open; retry in ${String(retryAfterMs)}ms`);",
    `    this.name = "${names.openError}";`,
    "    this.retryAfterMs = retryAfterMs;",
    "  }",
    "}",
  );
}

function breakerClass(names: Names, shape: Shape): string {
  const probeLimit = shape.sampled ? "this.#policy.probeLimit" : "1";

  return dedent`
    export class ${names.breaker} {
      readonly #policy: ${names.policy};
      readonly #now: () => number;
      readonly #isFailure: (error: unknown) => boolean;
      readonly #onStateChange: ((change: BreakerStateChange) => void) | undefined;

      #state: BreakerState = "closed";
      /** The clock reading at which the breaker last opened. */
      #openedAt = 0;
      ${counterFields(shape)}
      /** Probes admitted and not yet settled. */
      #probesInFlight = 0;
    ${when(shape.sampled, "  #probeSuccesses = 0;\n")}
      constructor(options: ${names.options} = {}) {
        this.#policy = {
          failureThreshold: options.failureThreshold ?? ${names.defaults}.failureThreshold,
          cooldownMs: options.cooldownMs ?? ${names.defaults}.cooldownMs,${policyFields(names, shape)}
        };

        if (this.#policy.failureThreshold < 1) {
          throw new RangeError(
            \`failureThreshold must be at least 1, received \${String(this.#policy.failureThreshold)}\`,
          );
        }
    ${when(
      shape.sampled,
      dedent`
        if (this.#policy.successesToClose > this.#policy.probeLimit) {
          // Otherwise the breaker can never close: it would need more successes
          // than it will ever admit probes, and would sit half-open for good.
          throw new RangeError(
            "successesToClose must not exceed probeLimit, or the breaker can never close",
          );
        }
      `,
    )}
        this.#now = options.now ?? Date.now;
        this.#isFailure = options.isFailure ?? (() => true);
        this.#onStateChange = options.onStateChange;
      }

      /**
       * The current arm.
       *
       * Reading this can itself cause a transition: an open breaker whose cooldown has expired becomes
       * half-open the moment anyone looks, because there is no timer to do it. That keeps the state
       * machine driven entirely by the injected clock and leaves nothing running in the background.
       */
      get state(): BreakerState {
        this.#admitIfCooled();
        return this.#state;
      }

      /** Milliseconds until a probe is admitted. 0 whenever the breaker is not open. */
      get retryAfterMs(): number {
        this.#admitIfCooled();
        if (this.#state !== "open") {
          return 0;
        }
        return Math.max(0, this.#policy.cooldownMs - (this.#now() - this.#openedAt));
      }

      snapshot(): BreakerSnapshot {
        return { state: this.state, failures: this.#failureCount(), retryAfterMs: this.retryAfterMs };
      }

      /**
       * Runs \`operation\` unless the breaker forbids it.
       *
       * @throws ${names.openError} without calling \`operation\` when the breaker is open, or when it is
       * half-open and the probes are already taken.
       */
      async run<T>(operation: () => Promise<T>): Promise<T> {
        this.#admitIfCooled();

        if (!this.#admits()) {
          throw new ${names.openError}(this.retryAfterMs);
        }

        const probing = this.#state === "half-open";
        if (probing) {
          this.#probesInFlight += 1;
        }

        try {
          const value = await operation();
          this.#recordSuccess(probing);
          return value;
        } catch (error) {
          if (this.#isFailure(error)) {
            this.#recordFailure(probing);
          } else if (probing) {
            // Not the dependency's fault, so it neither closes the breaker nor re-opens it. The probe
            // slot is released, and the next caller gets to be the one that decides.
            this.#probesInFlight -= 1;
          }
          throw error;
        }
      }

      /** Forces the breaker open, for a caller that learned the dependency is down some other way. */
      trip(): void {
        this.#open();
      }

      /** Returns the breaker to closed and forgets every failure. */
      reset(): void {
        this.#enter("closed");
        this.#clearFailures();
        this.#probesInFlight = 0;
    ${when(shape.sampled, "    this.#probeSuccesses = 0;")}
      }

      #admits(): boolean {
        if (this.#state === "closed") {
          return true;
        }
        if (this.#state === "open") {
          return false;
        }
        return this.#probesInFlight < ${probeLimit};
      }

      /** Moves an open breaker to half-open once the cooldown has elapsed. */
      #admitIfCooled(): void {
        if (this.#state !== "open") {
          return;
        }
        if (this.#now() - this.#openedAt < this.#policy.cooldownMs) {
          return;
        }
        this.#enter("half-open");
        this.#probesInFlight = 0;
    ${when(shape.sampled, "    this.#probeSuccesses = 0;")}
      }

      #recordSuccess(probing: boolean): void {
        if (probing) {
          this.#probesInFlight -= 1;
          ${probeSuccessBody(shape)}
          return;
        }
        ${closedSuccessBody(shape)}
      }

      #recordFailure(probing: boolean): void {
        if (probing) {
          this.#probesInFlight -= 1;
          // One bad probe is enough: the dependency is not back, and admitting more would spend the
          // load the breaker exists to withhold.
          this.#open();
          return;
        }
        ${closedFailureBody(shape)}
      }

      ${counterMethods(shape)}

      #open(): void {
        this.#openedAt = this.#now();
        this.#enter("open");
        this.#clearFailures();
        this.#probesInFlight = 0;
    ${when(shape.sampled, "    this.#probeSuccesses = 0;")}
      }

      #close(): void {
        this.#enter("closed");
        this.#clearFailures();
      }

      /** Records the arm and reports the transition. A move to the arm already held is not a change. */
      #enter(to: BreakerState): void {
        const from = this.#state;
        this.#state = to;
        if (from !== to && this.#onStateChange !== undefined) {
          this.#onStateChange({ from, to, at: this.#now() });
        }
      }
    }
  `;
}

function counterFields(shape: Shape): string {
  return shape.rolling
    ? joinLines(
        doc(
          "Clock readings of the failures still inside the window, oldest first. Timestamps rather than a count, because a count cannot expire.",
        ),
        "#failureTimes: number[] = [];",
      )
    : joinLines("/** Failures since the last success. */", "#failures = 0;");
}

function policyFields(names: Names, shape: Shape): string {
  return joinLines(
    when(shape.rolling, `\n      windowMs: options.windowMs ?? ${names.defaults}.windowMs,`),
    when(
      shape.sampled,
      `\n      probeLimit: options.probeLimit ?? ${names.defaults}.probeLimit,` +
        `\n      successesToClose: options.successesToClose ?? ${names.defaults}.successesToClose,`,
    ),
  );
}

function probeSuccessBody(shape: Shape): string {
  return shape.sampled
    ? dedent`
        this.#probeSuccesses += 1;
        if (this.#probeSuccesses >= this.#policy.successesToClose) {
          this.#close();
        }
      `
    : "this.#close();";
}

function closedSuccessBody(shape: Shape): string {
  return shape.rolling
    ? joinLines(
        "// Deliberately not cleared. A success does not prove the earlier failures did not happen, and",
        "// forgiving them on one good call is precisely the behaviour a rolling window rejects.",
        "this.#forget(this.#now() - this.#policy.windowMs);",
      )
    : "this.#failures = 0;";
}

function closedFailureBody(shape: Shape): string {
  return shape.rolling
    ? dedent`
        const at = this.#now();
        this.#failureTimes.push(at);
        this.#forget(at - this.#policy.windowMs);

        if (this.#failureTimes.length >= this.#policy.failureThreshold) {
          this.#open();
        }
      `
    : dedent`
        this.#failures += 1;

        if (this.#failures >= this.#policy.failureThreshold) {
          this.#open();
        }
      `;
}

function counterMethods(shape: Shape): string {
  return shape.rolling
    ? dedent`
        #failureCount(): number {
          return this.#failureTimes.length;
        }

        #clearFailures(): void {
          this.#failureTimes = [];
        }

        /** Drops failures older than \`cutoff\`. */
        #forget(cutoff: number): void {
          this.#failureTimes = this.#failureTimes.filter((at) => at >= cutoff);
        }
      `
    : dedent`
        #failureCount(): number {
          return this.#failures;
        }

        #clearFailures(): void {
          this.#failures = 0;
        }
      `;
}

function example(context: RenderContext, names: Names): string {
  const specifier = importSpecifier(context, names.stem);

  return dedent`
    /**
     * Using the breaker.
     *
     * Two things worth copying: one breaker per dependency held outside the request
     * path, and an \`isFailure\` that only counts errors which actually say the
     * dependency is unwell.
     */

    import { ${names.breaker}, ${names.openError} } from "${specifier}";

    interface StatusError {
      readonly status: number;
    }

    function hasStatus(error: unknown): error is StatusError {
      return typeof error === "object" && error !== null && "status" in error;
    }

    /**
     * A 404 means the dependency is fine and the request was not. Counting it would
     * open the breaker on a perfectly healthy service, which is the most common way
     * this pattern is mis-wired.
     */
    function indictsTheDependency(error: unknown): boolean {
      if (!hasStatus(error)) {
        return true;
      }
      return error.status >= 500 || error.status === 429;
    }

    /**
     * Held at module scope on purpose. A breaker created per request has no history
     * to reason from and silently does nothing, which looks exactly like a breaker
     * that is working.
     */
    const breaker = new ${names.breaker}({
      failureThreshold: 5,
      cooldownMs: 10_000,
      isFailure: indictsTheDependency,
      onStateChange: ({ from, to }) => {
        report(\`breaker moved from \${from} to \${to}\`);
      },
    });

    export async function loadProfile(
      id: string,
      fetchProfile: (id: string) => Promise<string>,
      cached: (id: string) => string | undefined,
    ): Promise<string | undefined> {
      try {
        return await breaker.run(async () => await fetchProfile(id));
      } catch (error) {
        // The open arm is not an error to report but a decision to make: fail fast,
        // or serve stale.
        if (error instanceof ${names.openError}) {
          report(\`skipping the call for \${String(error.retryAfterMs)}ms\`);
          return cached(id);
        }
        throw error;
      }
    }

    function report(message: string): void {
      console.warn(message);
    }
  `;
}

function tests(context: RenderContext, names: Names, shape: Shape): string {
  const specifier = importSpecifier(context, names.stem);
  const framework = context.conventions.testFramework;

  return sections(
    testHeader(),
    joinLines(
      frameworkImport(framework),
      `import { ${names.breaker}, ${names.openError} } from "${specifier}";`,
      when(framework === "node-test", `import { expect } from "./expect.js";`),
    ),
    testHelpers(names, shape),
    describeBlock("opening", openingTests(names, shape)),
    describeBlock("the open arm", openArmTests(names)),
    describeBlock("probing for recovery", halfOpenTests(names, shape)),
    describeBlock("what counts as a failure", countingTests(names, shape)),
  );
}

function testHeader(): string {
  return doc(
    "Every transition is driven by a clock this suite controls, so nothing here sleeps and the cooldown is asserted exactly rather than approximately.",
  );
}

function testHelpers(names: Names, shape: Shape): string {
  const policy = joinLines(
    "  failureThreshold: 2,",
    "  cooldownMs: 1000,",
    when(shape.rolling, "  windowMs: 5000,"),
    when(shape.sampled, joinLines("  probeLimit: 2,", "  successesToClose: 2,")),
  );

  return dedent`
    /** A clock the test moves by hand. */
    function clock(): { now: () => number; advance: (ms: number) => void } {
      let reading = 1000;
      return {
        now: () => reading,
        advance: (ms: number) => {
          reading += ms;
        },
      };
    }

    /** A small policy, so a test can open the breaker in two lines. */
    const policy = {
    ${policy}
    };

    /** Runs an operation that fails, swallowing the error the breaker rethrows. */
    async function failOnce(
      breaker: ${names.breaker},
      error: unknown = new Error("dependency is down"),
    ): Promise<void> {
      try {
        await breaker.run(async () => {
          await Promise.resolve();
          throw error;
        });
      } catch {
        // The breaker rethrows what the operation threw; the test is about the
        // breaker's state.
      }
    }

    /** Runs an operation that succeeds. */
    async function succeedOnce(breaker: ${names.breaker}): Promise<string> {
      return await breaker.run(async () => await Promise.resolve("ok"));
    }

    /** Opens the breaker by failing up to its threshold. */
    async function open(breaker: ${names.breaker}): Promise<void> {
      await failOnce(breaker);
      await failOnce(breaker);
    }

    /** A promise the test settles, so a call can be held in flight. */
    function deferred(): { promise: Promise<string>; settle: () => void } {
      let resolve: ((value: string) => void) | undefined;
      const promise = new Promise<string>((it) => {
        resolve = it;
      });
      return {
        promise,
        settle: () => {
          if (resolve !== undefined) {
            resolve("ok");
          }
        },
      };
    }

    /** Catches whatever a call throws, so a test can assert on it. */
    async function thrownBy(action: () => Promise<unknown>): Promise<unknown> {
      try {
        await action();
        return undefined;
      } catch (error) {
        return error;
      }
    }
  `;
}

function openingTests(names: Names, shape: Shape): string {
  return sections(
    dedent`
      it("stays closed while the dependency works", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await succeedOnce(breaker);
        expect(breaker.state).toBe("closed");
      });
    `,
    "",
    dedent`
      it("stays closed until the threshold is reached", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await failOnce(breaker);
        expect(breaker.state).toBe("closed");
      });
    `,
    "",
    dedent`
      it("opens on the failure that reaches the threshold", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        expect(breaker.state).toBe("open");
      });
    `,
    "",
    dedent`
      it("reports the transition once, not on every call", async () => {
        const time = clock();
        const changes: string[] = [];
        const breaker = new ${names.breaker}({
          ...policy,
          now: time.now,
          onStateChange: ({ from, to }) => {
            changes.push(\`\${from}->\${to}\`);
          },
        });
        await open(breaker);
        await thrownBy(async () => await succeedOnce(breaker));
        expect(changes).toEqual(["closed->open"]);
      });
    `,
    "",
    dedent`
      it("can be opened by hand, for a caller who learned the bad news elsewhere", () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        breaker.trip();
        expect(breaker.state).toBe("open");
      });
    `,
    "",
    dedent`
      it("refuses a threshold it could never act on", () => {
        expect(() => new ${names.breaker}({ ...policy, failureThreshold: 0 })).toThrow();
      });
    `,
    when(
      shape.sampled,
      `\n${dedent`
        it("refuses a quota it could never fill", () => {
          // More successes required than probes admitted would leave the breaker
          // half-open for good.
          expect(
            () => new ${names.breaker}({ ...policy, probeLimit: 1, successesToClose: 2 }),
          ).toThrow();
        });
      `}`,
    ),
  );
}

function openArmTests(names: Names): string {
  return sections(
    dedent`
      it("refuses the call without making it", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);

        let called = false;
        const error = await thrownBy(
          async () =>
            await breaker.run(async () => {
              called = true;
              return await Promise.resolve("ok");
            }),
        );

        // The whole point: the dependency is not touched.
        expect(called).toBe(false);
        expect(error).toBeInstanceOf(${names.openError});
      });
    `,
    "",
    dedent`
      it("says how long the caller should wait", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        expect(breaker.retryAfterMs).toBe(1000);

        time.advance(400);
        expect(breaker.retryAfterMs).toBe(600);
      });
    `,
    "",
    dedent`
      it("carries that wait on the error, so a caller can act on it", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        time.advance(250);

        const error = await thrownBy(async () => await succeedOnce(breaker));
        expect((error as ${names.openError}).retryAfterMs).toBe(750);
      });
    `,
    "",
    dedent`
      it("can be closed by hand", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        breaker.reset();
        expect(breaker.state).toBe("closed");
        expect(await succeedOnce(breaker)).toBe("ok");
      });
    `,
  );
}

function halfOpenTests(names: Names, shape: Shape): string {
  const closesOnProbe = shape.sampled
    ? dedent`
        it("needs its quota of successful probes before closing", async () => {
          const time = clock();
          const breaker = new ${names.breaker}({ ...policy, now: time.now });
          await open(breaker);
          time.advance(1000);

          await succeedOnce(breaker);
          // One good call is not evidence enough; a flapping dependency produces those.
          expect(breaker.state).toBe("half-open");

          await succeedOnce(breaker);
          expect(breaker.state).toBe("closed");
        });
      `
    : dedent`
        it("closes on a single successful probe", async () => {
          const time = clock();
          const breaker = new ${names.breaker}({ ...policy, now: time.now });
          await open(breaker);
          time.advance(1000);

          await succeedOnce(breaker);
          expect(breaker.state).toBe("closed");
        });
      `;

  const admissionLimit = shape.sampled ? 2 : 1;

  return sections(
    dedent`
      it("starts probing once the cooldown has elapsed", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);

        time.advance(999);
        expect(breaker.state).toBe("open");

        time.advance(1);
        expect(breaker.state).toBe("half-open");
      });
    `,
    "",
    dedent`
      it("admits no more than its probe limit at once", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        time.advance(1000);

        // Held in flight, so the probe slots stay occupied while the next call is
        // attempted.
        const held = [];
        for (let index = 0; index < ${String(admissionLimit)}; index += 1) {
          const gate = deferred();
          held.push(gate);
          void breaker.run(async () => await gate.promise);
        }

        const error = await thrownBy(async () => await succeedOnce(breaker));
        expect(error).toBeInstanceOf(${names.openError});

        for (const gate of held) {
          gate.settle();
        }
      });
    `,
    "",
    closesOnProbe,
    "",
    dedent`
      it("re-opens on a failed probe and starts the cooldown again", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await open(breaker);
        time.advance(1000);
        expect(breaker.state).toBe("half-open");

        await failOnce(breaker);
        expect(breaker.state).toBe("open");
        // The cooldown restarts from the failed probe, rather than from when it first
        // opened.
        expect(breaker.retryAfterMs).toBe(1000);
      });
    `,
  );
}

function countingTests(names: Names, shape: Shape): string {
  const counting = shape.rolling
    ? sections(
        dedent`
          it("does not forgive earlier failures because of one success", async () => {
            const time = clock();
            const breaker = new ${names.breaker}({ ...policy, now: time.now });
            await failOnce(breaker);
            await succeedOnce(breaker);
            await failOnce(breaker);

            // Two failures inside the window, so the breaker opens despite the success
            // between them.
            expect(breaker.state).toBe("open");
          });
        `,
        "",
        dedent`
          it("forgets a failure that falls out of the window", async () => {
            const time = clock();
            const breaker = new ${names.breaker}({ ...policy, now: time.now });
            await failOnce(breaker);

            time.advance(5001);
            await failOnce(breaker);

            // The first failure has expired, so this is the only one that counts.
            expect(breaker.state).toBe("closed");
          });
        `,
      )
    : joinLines(
        dedent`
          it("forgets the run of failures on any success", async () => {
            const time = clock();
            const breaker = new ${names.breaker}({ ...policy, now: time.now });
            await failOnce(breaker);
            await succeedOnce(breaker);
            await failOnce(breaker);

            // The success broke the run, so this is the first failure again.
            expect(breaker.state).toBe("closed");
          });
        `,
      );

  return sections(
    counting,
    "",
    dedent`
      it("ignores an error that does not indict the dependency", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({
          ...policy,
          now: time.now,
          isFailure: () => false,
        });

        await failOnce(breaker);
        await failOnce(breaker);
        await failOnce(breaker);

        // A 404 says the request was wrong, not that the service is unwell.
        expect(breaker.state).toBe("closed");
      });
    `,
    "",
    dedent`
      it("reports what it is doing, for a dashboard to read", async () => {
        const time = clock();
        const breaker = new ${names.breaker}({ ...policy, now: time.now });
        await failOnce(breaker);

        const before = breaker.snapshot();
        expect(before.state).toBe("closed");
        expect(before.failures).toBe(1);
        expect(before.retryAfterMs).toBe(0);

        await failOnce(breaker);
        expect(breaker.snapshot().state).toBe("open");
      });
    `,
  );
}

function describeBlock(name: string, body: string): string {
  return dedent`
    describe("${name}", () => {
      ${body}
    });
  `;
}

function frameworkImport(framework: string): string {
  switch (framework) {
    case "vitest":
      return `import { describe, expect, it } from "vitest";`;
    case "jest":
      return `import { describe, expect, it } from "@jest/globals";`;
    case "node-test":
      return `import { describe, it } from "node:test";`;
    default:
      return "";
  }
}

/** The matchers this pattern's suite calls; the file itself is shared with every other pattern. */
function expectHelper(): string {
  return expectFile(["toBe", "toEqual", "toBeInstanceOf", "toThrow"]);
}

/** Import specifiers follow the caller's conventions, not ours (FR-030). */
function importSpecifier(context: RenderContext, stem: string): string {
  return siblingSpecifier(context.conventions, stem);
}
