# retry

## Resolved options

{
  "backoff": "linear",
  "cancellation": "none",
  "includeTests": true,
  "jitter": "none"
}

## order-retry.ts (core)

```ts
/**
 * Retrying an operation that fails transiently.
 *
 * The delay grows by the base delay each attempt, capped at `maxDelayMs`, and is used exactly as computed.
 *
 * Waiting is injectable, which is what makes the schedule testable: pass a `sleep` that records
 * its argument instead of spending it, and the delays become values you can assert.
 */

export interface OrderRetryPolicy {
  /** Total attempts, including the first. Must be a positive integer. */
  readonly attempts: number;
  /** The delay before the second attempt, in milliseconds. */
  readonly baseDelayMs: number;
  /**
   * The ceiling applied before jitter, so a long schedule cannot grow without bound.
   */
  readonly maxDelayMs: number;
}

export const DEFAULT_ORDER_RETRY_POLICY: OrderRetryPolicy = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
};

/** An attempt that failed and is about to be retried. */
export interface OrderRetryAttempt {
  /** 1 for the first attempt. */
  readonly attempt: number;
  /** How long the loop will wait before the next one. */
  readonly delayMs: number;
  readonly error: unknown;
}

export interface OrderRetryOptions extends Partial<OrderRetryPolicy> {
  /**
   * Whether `error` is worth another attempt. Defaults to retrying every failure, which is the
   * wrong default for most callers: a 400 will still be a 400 on the fourth try. Narrow it.
   */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each wait. The place to put a log line or a metric. */
  readonly onRetry?: (attempt: OrderRetryAttempt) => void;
  /**
   * How to wait. Replaceable so tests can assert the schedule without spending it — the emitted
   * suite passes one that records its arguments and returns immediately.
   */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Thrown when every attempt failed.
 *
 * Distinct from the failure it wraps, because "this call failed" and "this call failed every time
 * we tried" call for different responses. A failure the predicate declined to retry is rethrown
 * unchanged instead, so a `catch` testing for a specific error type still works.
 */
export class OrderRetryExhaustedError extends Error {
  readonly attempts: number;
  /** The failure from the final attempt. */
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(`gave up after ${String(attempts)} attempt(s)`);
    this.name = "OrderRetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * How long to wait after `attempt` failed.
 *
 * Exported because it is the part with arithmetic in it: worth testing directly, and worth reusing
 * if you need to show a caller when the next attempt will happen.
 */
export function delayFor(attempt: number, policy: OrderRetryPolicy): number {
  const raw = policy.baseDelayMs * attempt;
  const capped = Math.min(raw, policy.maxDelayMs);
  return Math.round(capped);
}

/**
 * Runs `operation` until it succeeds, the predicate declines, or the attempts run out.
 *
 * The attempt number is passed to `operation` so it can vary what it does — logging the try, or
 * widening a timeout as the schedule stretches.
 *
 * @throws the operation's own error, unchanged, when `shouldRetry` declines it.
 */
export async function retryOrder<T>(
  operation: (attempt: number) => Promise<T>,
  options: OrderRetryOptions = {},
): Promise<T> {
  const policy: OrderRetryPolicy = {
    attempts: options.attempts ?? DEFAULT_ORDER_RETRY_POLICY.attempts,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_ORDER_RETRY_POLICY.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_ORDER_RETRY_POLICY.maxDelayMs,
  };

  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new RangeError(
      `attempts must be a positive integer, received ${String(policy.attempts)}`,
    );
  }

  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? delay;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
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

      const delayMs = delayFor(attempt, policy);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new OrderRetryExhaustedError(policy.attempts, lastError);
}

/**
 * The default wait.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, milliseconds);
  });
}
```

## order-retry-example.ts (example)

```ts
/**
 * Using the retry loop.
 *
 * The two things worth copying from here: a `shouldRetry` that names what is actually transient,
 * and a caller that distinguishes exhaustion from an error it was never going to survive.
 */

import { retryOrder, OrderRetryExhaustedError } from "./order-retry.js";

/** A failure with a status, of the kind an HTTP client throws. */
interface StatusError {
  readonly status: number;
}

function hasStatus(error: unknown): error is StatusError {
  return typeof error === "object" && error !== null && "status" in error;
}

/**
 * Retryable means "might succeed unchanged next time": a timeout, a rate limit, a server fault. A
 * 400 is not retryable, and retrying it three times turns one wasted call into four.
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
): Promise<string | undefined> {
  try {
    return await retryOrder(async () => await fetchProfile(id), {
      attempts: 4,
      baseDelayMs: 50,
      shouldRetry: isTransient,
      onRetry: ({ attempt, delayMs }) => {
        report(
          `attempt ${String(attempt)} failed; waiting ${String(delayMs)}ms`,
        );
      },
    });
  } catch (error) {
    // Exhaustion is worth reporting differently: the service was failing, not the request.
    if (error instanceof OrderRetryExhaustedError) {
      report(`gave up on ${id} after ${String(error.attempts)} attempts`);
      return undefined;
    }
    throw error;
  }
}

function report(message: string): void {
  console.warn(message);
}
```

## order-retry.test.ts (test)

```ts
/**
 * The schedule is asserted to the millisecond, which is only possible because waiting and
 * randomness are injected. Nothing here sleeps, so the suite runs in microseconds.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORDER_RETRY_POLICY,
  OrderRetryExhaustedError,
  delayFor,
  retryOrder,
} from "./order-retry.js";

/** A sleep that spends nothing and remembers everything. */
function recorder(): {
  readonly waits: number[];
  readonly sleep: (ms: number) => Promise<void>;
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
      await Promise.resolve();
    },
  };
}

/** Fails `times` times, then succeeds. */
function flaky(times: number): (attempt: number) => Promise<string> {
  let failures = 0;
  return async (attempt: number): Promise<string> => {
    await Promise.resolve();
    if (failures < times) {
      failures += 1;
      throw new Error(`attempt ${String(attempt)} failed`);
    }
    return "ok";
  };
}

describe("the delay schedule", () => {
  it("grows the wait as attempts fail", () => {
    const policy = DEFAULT_ORDER_RETRY_POLICY;
    expect(delayFor(1, policy)).toBe(100);
    expect(delayFor(2, policy)).toBe(200);
    expect(delayFor(3, policy)).toBe(300);
  });
  it("never waits longer than the ceiling", () => {
    const policy = {
      ...DEFAULT_ORDER_RETRY_POLICY,
      attempts: 20,
      maxDelayMs: 250,
    };
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect(delayFor(attempt, policy)).toBeLessThan(251);
    }
  });
});

describe("the loop", () => {
  it("does not retry an operation that works", async () => {
    const clock = recorder();
    const result = await retryOrder(async () => await Promise.resolve("ok"), {
      sleep: clock.sleep,
    });
    expect(result).toBe("ok");
    expect(clock.waits).toHaveLength(0);
  });
  it("retries until it succeeds, waiting the scheduled amount between tries", async () => {
    const clock = recorder();
    const result = await retryOrder(flaky(2), {
      attempts: 4,
      sleep: clock.sleep,
    });
    expect(result).toBe("ok");
    expect(clock.waits).toHaveLength(2);
  });
  it("gives up after the last attempt and says how many it made", async () => {
    const clock = recorder();
    let thrown: unknown;
    try {
      await retryOrder(flaky(99), { attempts: 3, sleep: clock.sleep });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrderRetryExhaustedError);
    expect((thrown as OrderRetryExhaustedError).attempts).toBe(3);
    expect((thrown as OrderRetryExhaustedError).lastError).toBeInstanceOf(
      Error,
    );
    // Two waits for three attempts: the loop does not sleep after the final failure.
    expect(clock.waits).toHaveLength(2);
  });
  it("rethrows an error the predicate declines, unchanged", async () => {
    const clock = recorder();
    const refused = new Error("not worth retrying");
    let thrown: unknown;
    try {
      await retryOrder(
        async () => {
          await Promise.resolve();
          throw refused;
        },
        { attempts: 5, shouldRetry: () => false, sleep: clock.sleep },
      );
    } catch (error) {
      thrown = error;
    }
    // The caller's own error, not ours: a `catch` testing for a specific type still works.
    expect(thrown).toBe(refused);
    expect(clock.waits).toHaveLength(0);
  });
  it("reports each retry, with the delay it is about to spend", async () => {
    const clock = recorder();
    const reported: number[] = [];
    const seen: number[] = [];
    await retryOrder(flaky(2), {
      attempts: 3,
      sleep: clock.sleep,
      onRetry: ({ attempt, delayMs }) => {
        seen.push(attempt);
        reported.push(delayMs);
      },
    });
    expect(seen).toEqual([1, 2]);
    // The hook is told the same wait the loop then takes, so a log line cannot disagree with reality.
    expect(reported).toEqual(clock.waits);
  });
  it("refuses a policy that could never run", async () => {
    let thrown: unknown;
    try {
      await retryOrder(async () => await Promise.resolve("ok"), {
        attempts: 0,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
  });
});
```
