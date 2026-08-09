# retry

## Resolved options

{
  "backoff": "linear",
  "cancellation": "none",
  "includeTests": false,
  "jitter": "full"
}

## order-retry.ts (core)

```ts
/**
 * Retrying an operation that fails transiently.
 *
 * The delay grows by the base delay each attempt, capped at `maxDelayMs`, and is then randomised across its whole range, so clients failing together do not retry together.
 *
 * Waiting and randomness are both injectable, which is what makes the schedule testable: pass a
 * `sleep` that records its argument and a `random` that returns a fixed sequence, and the delays
 * become exact values you can assert rather than time you have to spend.
 */

export interface OrderRetryPolicy {
  /** Total attempts, including the first. Must be a positive integer. */
  readonly attempts: number;
  /** The delay before the second attempt, in milliseconds. */
  readonly baseDelayMs: number;
  /**
   * The ceiling applied before jitter, so a long schedule cannot grow without
   * bound.
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
  /**
   * Where jitter comes from. Replaceable for the same reason as `sleep`: a schedule that draws on
   * `Math.random` cannot be asserted, so the emitted tests supply a fixed sequence.
   *
   * Must return a value in [0, 1).
   */
  readonly random?: () => number;
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
 *
 * `random` must return a value in [0, 1).
 */
export function delayFor(
  attempt: number,
  policy: OrderRetryPolicy,
  random: () => number = Math.random,
): number {
  const raw = policy.baseDelayMs * attempt;
  const capped = Math.min(raw, policy.maxDelayMs);
  return Math.round(random() * capped);
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
  const random = options.random ?? Math.random;

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

      const delayMs = delayFor(attempt, policy, random);
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
 * The two things worth copying from here: a `shouldRetry` that names what is
 * actually transient, and a caller that distinguishes exhaustion from an error
 * it was never going to survive.
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
    // Exhaustion is worth reporting differently: the service was failing, not
    // the request.
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
