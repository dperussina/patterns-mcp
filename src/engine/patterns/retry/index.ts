/**
 * The `retry` pattern: re-attempting an operation that fails transiently.
 *
 * Principle IV governs the surface. The retry loop everyone writes by hand is four lines and wrong in
 * three ways — it retries failures that will never succeed, it retries in lockstep with every other
 * client, and it cannot be abandoned. So what this emits is the loop plus the things that make it
 * usable in production: a predicate for deciding what is worth retrying, a jittered schedule, a hook
 * for observability, and cancellation.
 *
 * The decision that shapes everything else is that the delay and the randomness are *injectable*. A
 * retry test that waits for real backoff is slow, and one that uses real randomness is flaky, so the
 * generated suite would be either useless or a liability — and Principle III says the suite has to
 * actually run and pass. Taking `sleep` and `random` as options makes the schedule assertable to the
 * millisecond, which is why the emitted tests can pin the backoff maths exactly rather than checking
 * that "roughly a delay happened".
 *
 * `delayFor` is exported for the same reason: the interesting arithmetic is worth testing, and worth
 * reusing, without driving a whole retry loop to observe it.
 */

import { siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import { dedent, joinLines, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

type Backoff = "exponential" | "linear" | "constant";
type Jitter = "full" | "equal" | "none";

interface Shape {
  readonly backoff: Backoff;
  readonly jitter: Jitter;
  /** Whether the loop accepts an AbortSignal. */
  readonly cancellable: boolean;
  /** True unless jitter is `none`; governs whether a random source is threaded through at all. */
  readonly random: boolean;
}

export const retryPattern: PatternModule = {
  name: "retry",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const jitter = options.jitter as Jitter;
    const shape: Shape = {
      backoff: options.backoff as Backoff,
      jitter,
      cancellable: options.cancellation === "abort-signal",
      random: jitter !== "none",
    };
    const stem = stemFor(context);

    const files: RenderedFile[] = [
      { path: `${stem}.ts`, role: "core", contents: core(context, shape) },
      { path: `${stem}-example.ts`, role: "example", contents: example(context, stem, shape) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${stem}.test.ts`,
        role: "test",
        contents: tests(context, stem, shape),
      });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

/** File names follow the identifier when one is given, so a caller gets `payment-retry.ts`. */
function stemFor(context: RenderContext): string {
  const entity = context.names.entity;
  return entity === undefined ? "retry" : `${entity.kebab}-retry`;
}

/** The exported function name, matching the file. */
function functionNameFor(context: RenderContext): string {
  const entity = context.names.entity;
  return entity === undefined ? "retry" : `retry${entity.pascal}`;
}

function policyNameFor(context: RenderContext): string {
  const entity = context.names.entity;
  return entity === undefined
    ? "RetryPolicy"
    : withNoun(entity, "RetryPolicy").pascal;
}

function core(context: RenderContext, shape: Shape): string {
  const fn = functionNameFor(context);
  const Policy = policyNameFor(context);
  const Options = `${Policy.replace(/Policy$/, "")}Options`;
  const Attempt = `${Policy.replace(/Policy$/, "")}Attempt`;
  const Overrides = `${Policy}Overrides`;
  const Exhausted = `${Policy.replace(/RetryPolicy$/, "")}RetryExhaustedError`;
  const DEFAULTS = defaultsNameFor(Policy);
  const signalParam = when(shape.cancellable, ", signal?: AbortSignal");

  return dedent`
    ${docComment(shape)}

    export interface ${Policy} {
      /** Total attempts, including the first. Must be a positive integer. */
      readonly attempts: number;
      /** The delay before the second attempt, in milliseconds. */
      readonly baseDelayMs: number;
      /**
       * The ceiling applied before jitter, so a long schedule cannot grow without
       * bound.
       */
      readonly maxDelayMs: number;
    ${when(
      shape.backoff === "exponential",
      `  /** What each successive delay is multiplied by. */\n  readonly factor: number;`,
    )}
    }

    export const ${DEFAULTS}: ${Policy} = {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 30_000,${when(shape.backoff === "exponential", "\n  factor: 2,")}
    };

    /** An attempt that failed and is about to be retried. */
    export interface ${Attempt} {
      /** 1 for the first attempt. */
      readonly attempt: number;
      /** How long the loop will wait before the next one. */
      readonly delayMs: number;
      readonly error: unknown;
    }

    /**
     * The policy, field by field, for a caller who wants to change part of it.
     *
     * \`Partial<${Policy}>\` in all but one respect, and the respect matters: \`Partial\` makes each field
     * optional without making it accept \`undefined\`, so under \`exactOptionalPropertyTypes\` a caller
     * forwarding a value they may not have — \`attempts: config.attempts\` where that is
     * \`number | undefined\` — is rejected, and has to build the object conditionally to say the thing
     * this type exists to let them say.
     */
    export type ${Overrides} = {
      readonly [K in keyof ${Policy}]?: ${Policy}[K] | undefined;
    };

    export interface ${Options} extends ${Overrides} {
      /**
       * Whether \`error\` is worth another attempt. Defaults to retrying every failure, which is the
       * wrong default for most callers: a 400 will still be a 400 on the fourth try. Narrow it.
       */
      readonly shouldRetry?: ((error: unknown, attempt: number) => boolean) | undefined;
      /** Called before each wait. The place to put a log line or a metric. */
      readonly onRetry?: ((attempt: ${Attempt}) => void) | undefined;
      /**
       * How to wait. Replaceable so tests can assert the schedule without spending it — the emitted
       * suite passes one that records its arguments and returns immediately.
       */
      readonly sleep?: ((milliseconds: number${signalParam}) => Promise<void>) | undefined;
    ${when(shape.random, randomOptionDoc())}
    ${when(
      shape.cancellable,
      joinLines(
        "/** Abandons the loop, including mid-wait. The signal's reason is what gets thrown. */",
        "readonly signal?: AbortSignal | undefined;",
      ),
    )}
    }

    /**
     * Thrown when every attempt failed.
     *
     * Distinct from the failure it wraps, because "this call failed" and "this call failed every time
     * we tried" call for different responses. A failure the predicate declined to retry is rethrown
     * unchanged instead, so a \`catch\` testing for a specific error type still works.
     */
    export class ${Exhausted} extends Error {
      readonly attempts: number;
      /** The failure from the final attempt. */
      readonly lastError: unknown;

      constructor(attempts: number, lastError: unknown) {
        super(\`gave up after \${String(attempts)} attempt(s)\`);
        this.name = "${Exhausted}";
        this.attempts = attempts;
        this.lastError = lastError;
      }
    }

    ${delayForDoc(shape)}
    export function delayFor(
      attempt: number,
      policy: ${Policy},
    ${when(shape.random, "  random: () => number = Math.random,")}
    ): number {
      const raw = ${rawDelay(shape.backoff)};
      const capped = Math.min(raw, policy.maxDelayMs);
      return Math.round(${jittered(shape.jitter)});
    }

    ${loopDoc(shape)}
    export async function ${fn}<T>(
      operation: (attempt: number) => Promise<T>,
      options: ${Options} = {},
    ): Promise<T> {
      const policy: ${Policy} = {
        attempts: options.attempts ?? ${DEFAULTS}.attempts,
        baseDelayMs: options.baseDelayMs ?? ${DEFAULTS}.baseDelayMs,
        maxDelayMs: options.maxDelayMs ?? ${DEFAULTS}.maxDelayMs,${when(
          shape.backoff === "exponential",
          `\n    factor: options.factor ?? ${DEFAULTS}.factor,`,
        )}
      };

      if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
        throw new RangeError(
          \`attempts must be a positive integer, received \${String(policy.attempts)}\`,
        );
      }

      const shouldRetry = options.shouldRetry ?? (() => true);
      const sleep = options.sleep ?? delay;
    ${when(shape.random, "  const random = options.random ?? Math.random;")}

      let lastError: unknown;

      for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    ${when(shape.cancellable, "    options.signal?.throwIfAborted();\n")}
        try {
          return await operation(attempt);
        } catch (error) {
          lastError = error;

          // The caller's own error, not an exhaustion: rethrow it as it came.
          if (!shouldRetry(error, attempt)) {
            throw error;
          }

          if (attempt === policy.attempts) {
            break;
          }

          const delayMs = delayFor(attempt, policy${when(shape.random, ", random")});
          options.onRetry?.({ attempt, delayMs, error });
          await sleep(delayMs${when(shape.cancellable, ", options.signal")});
        }
      }

      throw new ${Exhausted}(policy.attempts, lastError);
    }

    ${delayDoc(shape)}
    function delay(milliseconds: number${signalParam}): Promise<void> {
      ${delayBody(shape)}
    }
  `;
}

/**
 * Written with `joinLines` rather than a nested template literal: the backticks this comment wants
 * around `sleep` and `Math.random` have to survive two levels of template, and escaping them by hand
 * put literal backslashes in the emitted doc comment the first time round.
 */
function randomOptionDoc(): string {
  return joinLines(
    "/**",
    " * Where jitter comes from. Replaceable for the same reason as `sleep`: a schedule that draws on",
    " * `Math.random` cannot be asserted, so the emitted tests supply a fixed sequence.",
    " *",
    " * Must return a value in [0, 1).",
    " */",
    "readonly random?: (() => number) | undefined;",
  );
}

function defaultsNameFor(policy: string): string {
  return policy === "RetryPolicy"
    ? "DEFAULT_RETRY_POLICY"
    : `DEFAULT_${policy.replace(/([a-z\d])([A-Z])/g, "$1_$2").toUpperCase()}`;
}

function docComment(shape: Shape): string {
  const schedule =
    shape.backoff === "exponential"
      ? "The delay grows by a factor each attempt"
      : shape.backoff === "linear"
        ? "The delay grows by the base delay each attempt"
        : "The delay is the same every attempt";
  const jitter =
    shape.jitter === "none"
      ? "and is used exactly as computed"
      : shape.jitter === "full"
        ? "and is then randomised across its whole range, so clients failing together do not retry together"
        : "and is then randomised across its upper half, keeping a floor under each wait";

  // The injectability note is conditional because it would otherwise promise a `random` option that a
  // jitter-free schedule does not have — a header describing a different file than the one below it.
  const testable = shape.random
    ? [
        " * Waiting and randomness are both injectable, which is what makes the schedule testable: pass a",
        " * `sleep` that records its argument and a `random` that returns a fixed sequence, and the delays",
        " * become exact values you can assert rather than time you have to spend.",
      ]
    : [
        " * Waiting is injectable, which is what makes the schedule testable: pass a `sleep` that records",
        " * its argument instead of spending it, and the delays become values you can assert.",
      ];

  return joinLines(
    "/**",
    " * Retrying an operation that fails transiently.",
    " *",
    ` * ${schedule}, capped at \`maxDelayMs\`, ${jitter}.`,
    " *",
    testable,
    " */",
  );
}

function delayForDoc(shape: Shape): string {
  return joinLines(
    "/**",
    " * How long to wait after `attempt` failed.",
    " *",
    " * Exported because it is the part with arithmetic in it: worth testing directly, and worth reusing",
    " * if you need to show a caller when the next attempt will happen.",
    shape.random ? " *\n * `random` must return a value in [0, 1)." : "",
    " */",
  );
}

function loopDoc(shape: Shape): string {
  return joinLines(
    "/**",
    " * Runs `operation` until it succeeds, the predicate declines, or the attempts run out.",
    " *",
    " * The attempt number is passed to `operation` so it can vary what it does — logging the try, or",
    " * widening a timeout as the schedule stretches.",
    shape.cancellable
      ? " *\n * Aborting the signal ends the loop promptly, including part-way through a wait, by throwing the\n * signal's reason. An operation already in flight is not itself cancelled: pass the signal into it if\n * it supports one."
      : "",
    " *",
    " * @throws the operation's own error, unchanged, when `shouldRetry` declines it.",
    " */",
  );
}

function rawDelay(backoff: Backoff): string {
  switch (backoff) {
    case "exponential":
      return "policy.baseDelayMs * policy.factor ** (attempt - 1)";
    case "linear":
      return "policy.baseDelayMs * attempt";
    case "constant":
      return "policy.baseDelayMs";
  }
}

function jittered(jitter: Jitter): string {
  switch (jitter) {
    case "none":
      return "capped";
    case "full":
      return "random() * capped";
    case "equal":
      return "capped / 2 + random() * (capped / 2)";
  }
}

function delayDoc(shape: Shape): string {
  return joinLines(
    "/**",
    " * The default wait.",
    shape.cancellable
      ? " *\n * The abort listener is removed on the normal path so that a long-lived signal does not accumulate\n * one listener per retry, which is the leak this kind of helper usually ships with."
      : "",
    " */",
  );
}

function delayBody(shape: Shape): string {
  if (!shape.cancellable) {
    return dedent`
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, milliseconds);
      });
    `;
  }

  return dedent`
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }

      let onAbort: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
        resolve();
      }, milliseconds);

      onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  `;
}

function example(context: RenderContext, stem: string, shape: Shape): string {
  const fn = functionNameFor(context);
  const Policy = policyNameFor(context);
  const Exhausted = `${Policy.replace(/RetryPolicy$/, "")}RetryExhaustedError`;
  const specifier = importSpecifier(context, stem);

  return dedent`
    /**
     * Using the retry loop.
     *
     * The two things worth copying from here: a \`shouldRetry\` that names what is
     * actually transient, and a caller that distinguishes exhaustion from an error
     * it was never going to survive.
     */

    import { ${fn}, ${Exhausted} } from "${specifier}";

    /** A failure with a status, of the kind an HTTP client throws. */
    interface StatusError {
      readonly status: number;
    }

    function hasStatus(error: unknown): error is StatusError {
      return typeof error === "object" && error !== null && "status" in error;
    }

    /**
     * Retryable means "might succeed unchanged next time": a timeout, a rate limit,
     * a server fault. A 400 is not retryable, and retrying it three times turns one
     * wasted call into four.
     */
    function isTransient(error: unknown): boolean {
      if (!hasStatus(error)) {
        return true;
      }
      return error.status === 429 || error.status >= 500;
    }

    export async function loadProfile(
      id: string,
      fetchProfile: (id: string) => Promise<string>,
    ${when(shape.cancellable, "  signal?: AbortSignal,")}
    ): Promise<string | undefined> {
      try {
        return await ${fn}(async () => await fetchProfile(id), {
          attempts: 4,
          baseDelayMs: 50,
          shouldRetry: isTransient,
          onRetry: ({ attempt, delayMs }) => {
            report(\`attempt \${String(attempt)} failed; waiting \${String(delayMs)}ms\`);
          },${when(shape.cancellable, "\n      signal,")}
        });
      } catch (error) {
        // Exhaustion is worth reporting differently: the service was failing, not
        // the request.
        if (error instanceof ${Exhausted}) {
          report(\`gave up on \${id} after \${String(error.attempts)} attempts\`);
          return undefined;
        }
        throw error;
      }
    }

    function report(message: string): void {
      console.warn(message);
    }
  `;
}

function tests(context: RenderContext, stem: string, shape: Shape): string {
  const fn = functionNameFor(context);
  const Policy = policyNameFor(context);
  const Exhausted = `${Policy.replace(/RetryPolicy$/, "")}RetryExhaustedError`;
  const DEFAULTS = defaultsNameFor(Policy);
  const specifier = importSpecifier(context, stem);

  return dedent`
    /**
     * The schedule is asserted to the millisecond, which is only possible because
     * waiting and randomness are injected. Nothing here sleeps, so the suite runs
     * in microseconds.
     */

    ${frameworkImports(context.conventions)}
    import {
      ${DEFAULTS},
      ${Exhausted},
      delayFor,
      ${fn},
    } from "${specifier}";

    /** A sleep that spends nothing and remembers everything. */
    function recorder(): { readonly waits: number[]; readonly sleep: (ms: number) => Promise<void> } {
      const waits: number[] = [];
      return {
        waits,
        sleep: async (ms: number): Promise<void> => {
          waits.push(ms);
          await Promise.resolve();
        },
      };
    }
    ${when(
      shape.random,
      `
      /** A fixed sequence, so a jittered delay has one right answer. */
      function sequence(values: readonly number[]): () => number {
        let index = 0;
        return () => {
          const value = values[index % values.length] ?? 0;
          index += 1;
          return value;
        };
      }
      `,
    )}
    /** Fails \`times\` times, then succeeds. */
    function flaky(times: number): (attempt: number) => Promise<string> {
      let failures = 0;
      return async (attempt: number): Promise<string> => {
        await Promise.resolve();
        if (failures < times) {
          failures += 1;
          throw new Error(\`attempt \${String(attempt)} failed\`);
        }
        return "ok";
      };
    }

    ${describeBlock("the delay schedule", scheduleTests(shape, DEFAULTS))}

    ${describeBlock("the loop", loopTests(shape, fn, Exhausted))}
    ${when(shape.cancellable, `\n${describeBlock("cancellation", cancellationTests(fn))}`)}
  `;
}

function describeBlock(name: string, body: string): string {
  return dedent`
    describe("${name}", () => {
      ${body}
    });
  `;
}

/**
 * The delays each backoff produces for attempts 1..3 with the default policy, before jitter. Written
 * out rather than computed so the test states an expectation instead of reimplementing the code it
 * is testing.
 */
function scheduleTests(shape: Shape, DEFAULTS: string): string {
  const base = shape.backoff === "exponential" ? [100, 200, 400] : shape.backoff === "linear" ? [100, 200, 300] : [100, 100, 100];

  const expected = base.map((delay) =>
    shape.jitter === "none" ? delay : shape.jitter === "full" ? delay / 2 : delay * 0.75,
  );

  const withRandom = when(shape.random, ", sequence([0.5])");

  return joinLines(
    dedent`
      it("grows the wait as attempts fail", () => {
        const policy = ${DEFAULTS};
        ${expected
          .map(
            (value, index) =>
              `expect(delayFor(${String(index + 1)}, policy${withRandom})).toBe(${String(value)});`,
          )
          .join("\n  ")}
      });
    `,
    "",
    dedent`
      it("never waits longer than the ceiling", () => {
        const policy = { ...${DEFAULTS}, attempts: 20, maxDelayMs: 250 };
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          expect(delayFor(attempt, policy${when(shape.random, ", sequence([1])")})).toBeLessThan(251);
        }
      });
    `,
    when(
      shape.jitter === "full",
      `\n${dedent`
        it("can wait no time at all, which is the point of full jitter", () => {
          expect(delayFor(3, ${DEFAULTS}, sequence([0]))).toBe(0);
        });
      `}`,
    ),
    when(
      shape.jitter === "equal",
      `\n${dedent`
        it("keeps a floor under the wait, which is the point of equal jitter", () => {
          const policy = ${DEFAULTS};
          expect(delayFor(1, policy, sequence([0]))).toBe(policy.baseDelayMs / 2);
        });
      `}`,
    ),
  );
}

function loopTests(shape: Shape, fn: string, Exhausted: string): string {
  const withRandom = when(shape.random, "\n    random: sequence([0.5]),");

  return joinLines(
    dedent`
      it("does not retry an operation that works", async () => {
        const clock = recorder();
        const result = await ${fn}(async () => await Promise.resolve("ok"), { sleep: clock.sleep });
        expect(result).toBe("ok");
        expect(clock.waits).toHaveLength(0);
      });
    `,
    "",
    dedent`
      it("retries until it succeeds, waiting the scheduled amount between tries", async () => {
        const clock = recorder();
        const result = await ${fn}(flaky(2), {
          attempts: 4,
          sleep: clock.sleep,${withRandom}
        });
        expect(result).toBe("ok");
        expect(clock.waits).toHaveLength(2);
      });
    `,
    "",
    dedent`
      it("gives up after the last attempt and says how many it made", async () => {
        const clock = recorder();
        let thrown: unknown;
        try {
          await ${fn}(flaky(99), { attempts: 3, sleep: clock.sleep,${withRandom} });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(${Exhausted});
        expect((thrown as ${Exhausted}).attempts).toBe(3);
        expect((thrown as ${Exhausted}).lastError).toBeInstanceOf(Error);
        // Two waits for three attempts: the loop does not sleep after the final
        // failure.
        expect(clock.waits).toHaveLength(2);
      });
    `,
    "",
    dedent`
      it("rethrows an error the predicate declines, unchanged", async () => {
        const clock = recorder();
        const refused = new Error("not worth retrying");
        let thrown: unknown;
        try {
          await ${fn}(
            async () => {
              await Promise.resolve();
              throw refused;
            },
            { attempts: 5, shouldRetry: () => false, sleep: clock.sleep },
          );
        } catch (error) {
          thrown = error;
        }
        // The caller's own error, not ours: a \`catch\` testing for a specific type
        // still works.
        expect(thrown).toBe(refused);
        expect(clock.waits).toHaveLength(0);
      });
    `,
    "",
    dedent`
      it("reports each retry, with the delay it is about to spend", async () => {
        const clock = recorder();
        const reported: number[] = [];
        const seen: number[] = [];
        await ${fn}(flaky(2), {
          attempts: 3,
          sleep: clock.sleep,${withRandom}
          onRetry: ({ attempt, delayMs }) => {
            seen.push(attempt);
            reported.push(delayMs);
          },
        });
        expect(seen).toEqual([1, 2]);
        // The hook is told the same wait the loop then takes, so a log line cannot
        // disagree with reality.
        expect(reported).toEqual(clock.waits);
      });
    `,
    "",
    dedent`
      it("refuses a policy that could never run", async () => {
        let thrown: unknown;
        try {
          await ${fn}(async () => await Promise.resolve("ok"), { attempts: 0 });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(RangeError);
      });
    `,
  );
}

function cancellationTests(fn: string): string {
  return joinLines(
    dedent`
      it("does not start when the signal is already aborted", async () => {
        const clock = recorder();
        const controller = new AbortController();
        controller.abort(new Error("too late"));
        let attempts = 0;
        let thrown: unknown;
        try {
          await ${fn}(
            async () => {
              attempts += 1;
              return await Promise.resolve("ok");
            },
            { sleep: clock.sleep, signal: controller.signal },
          );
        } catch (error) {
          thrown = error;
        }
        expect(attempts).toBe(0);
        expect(thrown).toBeInstanceOf(Error);
      });
    `,
    "",
    dedent`
      it("stops between attempts once aborted", async () => {
        const controller = new AbortController();
        let attempts = 0;
        let thrown: unknown;
        try {
          await ${fn}(
            async () => {
              attempts += 1;
              await Promise.resolve();
              throw new Error("failing");
            },
            {
              attempts: 5,
              sleep: async () => {
                controller.abort(new Error("caller left"));
                await Promise.resolve();
              },
              signal: controller.signal,
            },
          );
        } catch (error) {
          thrown = error;
        }
        // One attempt, one wait, then the abort is observed at the top of the second
        // pass.
        expect(attempts).toBe(1);
        expect(thrown).toBeInstanceOf(Error);
      });
    `,
  );
}

/** Import specifiers follow the caller's conventions, not ours (FR-030). */
function importSpecifier(context: RenderContext, stem: string): string {
  return siblingSpecifier(context.conventions, stem);
}
