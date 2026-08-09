# circuit-breaker

## Resolved options

{
  "failureCounting": "rolling-window",
  "halfOpen": "sampled",
  "includeTests": true
}

## order-circuit-breaker.ts (core)

```ts
/**
 * A circuit breaker around a failing dependency.
 *
 * Failures are counted inside a rolling window, so a fault that never lets a
 * clean run build up still trips the breaker, and old failures expire rather
 * than being forgiven by one success.
 *
 * Recovery is tested with several probes and a success quota, which is slower
 * to close but will not re-admit full load on the strength of one lucky call.
 *
 * The clock is injectable, which is what makes the behaviour testable: pass a
 * `now` that you control and every edge of the state machine — cooldown expiry,
 * window expiry — becomes an exact assertion rather than a sleep.
 */

/**
 * `closed` passes calls through, `open` refuses them, `half-open` admits a
 * limited number to find out whether the dependency is back.
 */
export type BreakerState = "closed" | "open" | "half-open";

export interface OrderBreakerPolicy {
  /** Failures needed to open the breaker. */
  readonly failureThreshold: number;
  /** How long to refuse calls before admitting a probe, in milliseconds. */
  readonly cooldownMs: number;
  /**
   * How far back failures count. A failure older than this is forgotten, which
   * is what stops a slow trickle of unrelated faults from eventually adding up
   * to an open breaker.
   */
  readonly windowMs: number;
  /** How many probes may be in flight at once while half-open. */
  readonly probeLimit: number;
  /** How many probes must succeed before the breaker closes. */
  readonly successesToClose: number;
}

export const DEFAULT_ORDER_BREAKER_POLICY: OrderBreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  windowMs: 60_000,
  probeLimit: 3,
  successesToClose: 2,
};

/** A transition, as reported to `onStateChange`. */
export interface BreakerStateChange {
  readonly from: BreakerState;
  readonly to: BreakerState;
  /** The clock reading at which it happened. */
  readonly at: number;
}

export interface OrderBreakerOptions extends Partial<OrderBreakerPolicy> {
  /**
   * The clock, in milliseconds. Replaceable so that tests can move time rather
   * than spend it — the emitted suite drives every transition through one it
   * controls.
   */
  readonly now?: () => number;
  /**
   * Whether an error counts against the breaker. Defaults to counting every
   * error, which is rarely right: a 404 says the dependency is healthy and the
   * request was wrong, and counting it opens the breaker on a working service.
   */
  readonly isFailure?: (error: unknown) => boolean;
  /**
   * Called on every transition. The place for a log line, a metric, or an
   * alert.
   */
  readonly onStateChange?: (change: BreakerStateChange) => void;
}
/** What `snapshot` reports. Enough to render a dashboard, and nothing a caller can mutate. */
export interface BreakerSnapshot {
  readonly state: BreakerState;
  /** Failures currently counting towards the threshold. */
  readonly failures: number;
  /** Milliseconds until a probe is admitted; 0 unless open. */
  readonly retryAfterMs: number;
}

/**
 * Thrown instead of calling the dependency while the breaker is open.
 *
 * Carries `retryAfterMs` so a caller can decide between failing fast, serving
 * something stale, and queueing — none of which it can choose if all it knows
 * is that something went wrong.
 */
export class OrderBreakerOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`circuit is open; retry in ${String(retryAfterMs)}ms`);
    this.name = "OrderBreakerOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class OrderCircuitBreaker {
  readonly #policy: OrderBreakerPolicy;
  readonly #now: () => number;
  readonly #isFailure: (error: unknown) => boolean;
  readonly #onStateChange: ((change: BreakerStateChange) => void) | undefined;

  #state: BreakerState = "closed";
  /** The clock reading at which the breaker last opened. */
  #openedAt = 0;
  /**
   * Clock readings of the failures still inside the window, oldest first.
   * Timestamps rather than a count, because a count cannot expire.
   */
  #failureTimes: number[] = [];
  /** Probes admitted and not yet settled. */
  #probesInFlight = 0;
  #probeSuccesses = 0;

  constructor(options: OrderBreakerOptions = {}) {
    this.#policy = {
      failureThreshold:
        options.failureThreshold ??
        DEFAULT_ORDER_BREAKER_POLICY.failureThreshold,
      cooldownMs: options.cooldownMs ?? DEFAULT_ORDER_BREAKER_POLICY.cooldownMs,
      windowMs: options.windowMs ?? DEFAULT_ORDER_BREAKER_POLICY.windowMs,
      probeLimit: options.probeLimit ?? DEFAULT_ORDER_BREAKER_POLICY.probeLimit,
      successesToClose:
        options.successesToClose ??
        DEFAULT_ORDER_BREAKER_POLICY.successesToClose,
    };

    if (this.#policy.failureThreshold < 1) {
      throw new RangeError(
        `failureThreshold must be at least 1, received ${String(this.#policy.failureThreshold)}`,
      );
    }
    if (this.#policy.successesToClose > this.#policy.probeLimit) {
      // Otherwise the breaker can never close: it would need more successes
      // than it will ever admit probes, and would sit half-open for good.
      throw new RangeError(
        "successesToClose must not exceed probeLimit, or the breaker can never close",
      );
    }
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
    return Math.max(
      0,
      this.#policy.cooldownMs - (this.#now() - this.#openedAt),
    );
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      failures: this.#failureCount(),
      retryAfterMs: this.retryAfterMs,
    };
  }

  /**
   * Runs `operation` unless the breaker forbids it.
   *
   * @throws OrderBreakerOpenError without calling `operation` when the breaker is open, or when it is
   * half-open and the probes are already taken.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.#admitIfCooled();

    if (!this.#admits()) {
      throw new OrderBreakerOpenError(this.retryAfterMs);
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
    this.#probeSuccesses = 0;
  }

  #admits(): boolean {
    if (this.#state === "closed") {
      return true;
    }
    if (this.#state === "open") {
      return false;
    }
    return this.#probesInFlight < this.#policy.probeLimit;
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
    this.#probeSuccesses = 0;
  }

  #recordSuccess(probing: boolean): void {
    if (probing) {
      this.#probesInFlight -= 1;
      this.#probeSuccesses += 1;
      if (this.#probeSuccesses >= this.#policy.successesToClose) {
        this.#close();
      }
      return;
    }
    // Deliberately not cleared. A success does not prove the earlier failures did not happen, and
    // forgiving them on one good call is precisely the behaviour a rolling window rejects.
    this.#forget(this.#now() - this.#policy.windowMs);
  }

  #recordFailure(probing: boolean): void {
    if (probing) {
      this.#probesInFlight -= 1;
      // One bad probe is enough: the dependency is not back, and admitting more would spend the
      // load the breaker exists to withhold.
      this.#open();
      return;
    }
    const at = this.#now();
    this.#failureTimes.push(at);
    this.#forget(at - this.#policy.windowMs);

    if (this.#failureTimes.length >= this.#policy.failureThreshold) {
      this.#open();
    }
  }

  #failureCount(): number {
    return this.#failureTimes.length;
  }

  #clearFailures(): void {
    this.#failureTimes = [];
  }

  /** Drops failures older than `cutoff`. */
  #forget(cutoff: number): void {
    this.#failureTimes = this.#failureTimes.filter((at) => at >= cutoff);
  }

  #open(): void {
    this.#openedAt = this.#now();
    this.#enter("open");
    this.#clearFailures();
    this.#probesInFlight = 0;
    this.#probeSuccesses = 0;
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
```

## order-circuit-breaker-example.ts (example)

```ts
/**
 * Using the breaker.
 *
 * Two things worth copying: one breaker per dependency held outside the request
 * path, and an `isFailure` that only counts errors which actually say the
 * dependency is unwell.
 */

import {
  OrderCircuitBreaker,
  OrderBreakerOpenError,
} from "./order-circuit-breaker.js";

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
const breaker = new OrderCircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 10_000,
  isFailure: indictsTheDependency,
  onStateChange: ({ from, to }) => {
    report(`breaker moved from ${from} to ${to}`);
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
    if (error instanceof OrderBreakerOpenError) {
      report(`skipping the call for ${String(error.retryAfterMs)}ms`);
      return cached(id);
    }
    throw error;
  }
}

function report(message: string): void {
  console.warn(message);
}
```

## order-circuit-breaker.test.ts (test)

```ts
/**
 * Every transition is driven by a clock this suite controls, so nothing here
 * sleeps and the cooldown is asserted exactly rather than approximately.
 */

import { describe, expect, it } from "vitest";
import {
  OrderCircuitBreaker,
  OrderBreakerOpenError,
} from "./order-circuit-breaker.js";

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
  failureThreshold: 2,
  cooldownMs: 1000,
  windowMs: 5000,
  probeLimit: 2,
  successesToClose: 2,
};

/** Runs an operation that fails, swallowing the error the breaker rethrows. */
async function failOnce(
  breaker: OrderCircuitBreaker,
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
async function succeedOnce(breaker: OrderCircuitBreaker): Promise<string> {
  return await breaker.run(async () => await Promise.resolve("ok"));
}

/** Opens the breaker by failing up to its threshold. */
async function open(breaker: OrderCircuitBreaker): Promise<void> {
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

describe("opening", () => {
  it("stays closed while the dependency works", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await succeedOnce(breaker);
    expect(breaker.state).toBe("closed");
  });

  it("stays closed until the threshold is reached", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await failOnce(breaker);
    expect(breaker.state).toBe("closed");
  });

  it("opens on the failure that reaches the threshold", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    expect(breaker.state).toBe("open");
  });

  it("reports the transition once, not on every call", async () => {
    const time = clock();
    const changes: string[] = [];
    const breaker = new OrderCircuitBreaker({
      ...policy,
      now: time.now,
      onStateChange: ({ from, to }) => {
        changes.push(`${from}->${to}`);
      },
    });
    await open(breaker);
    await thrownBy(async () => await succeedOnce(breaker));
    expect(changes).toEqual(["closed->open"]);
  });

  it("can be opened by hand, for a caller who learned the bad news elsewhere", () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    breaker.trip();
    expect(breaker.state).toBe("open");
  });

  it("refuses a threshold it could never act on", () => {
    expect(
      () => new OrderCircuitBreaker({ ...policy, failureThreshold: 0 }),
    ).toThrow();
  });

  it("refuses a quota it could never fill", () => {
    // More successes required than probes admitted would leave the breaker
    // half-open for good.
    expect(
      () =>
        new OrderCircuitBreaker({
          ...policy,
          probeLimit: 1,
          successesToClose: 2,
        }),
    ).toThrow();
  });
});

describe("the open arm", () => {
  it("refuses the call without making it", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
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
    expect(error).toBeInstanceOf(OrderBreakerOpenError);
  });

  it("says how long the caller should wait", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    expect(breaker.retryAfterMs).toBe(1000);

    time.advance(400);
    expect(breaker.retryAfterMs).toBe(600);
  });

  it("carries that wait on the error, so a caller can act on it", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    time.advance(250);

    const error = await thrownBy(async () => await succeedOnce(breaker));
    expect((error as OrderBreakerOpenError).retryAfterMs).toBe(750);
  });

  it("can be closed by hand", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    breaker.reset();
    expect(breaker.state).toBe("closed");
    expect(await succeedOnce(breaker)).toBe("ok");
  });
});

describe("probing for recovery", () => {
  it("starts probing once the cooldown has elapsed", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);

    time.advance(999);
    expect(breaker.state).toBe("open");

    time.advance(1);
    expect(breaker.state).toBe("half-open");
  });

  it("admits no more than its probe limit at once", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    time.advance(1000);

    // Held in flight, so the probe slots stay occupied while the next call is
    // attempted.
    const held = [];
    for (let index = 0; index < 2; index += 1) {
      const gate = deferred();
      held.push(gate);
      void breaker.run(async () => await gate.promise);
    }

    const error = await thrownBy(async () => await succeedOnce(breaker));
    expect(error).toBeInstanceOf(OrderBreakerOpenError);

    for (const gate of held) {
      gate.settle();
    }
  });

  it("needs its quota of successful probes before closing", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    time.advance(1000);

    await succeedOnce(breaker);
    // One good call is not evidence enough; a flapping dependency produces those.
    expect(breaker.state).toBe("half-open");

    await succeedOnce(breaker);
    expect(breaker.state).toBe("closed");
  });

  it("re-opens on a failed probe and starts the cooldown again", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await open(breaker);
    time.advance(1000);
    expect(breaker.state).toBe("half-open");

    await failOnce(breaker);
    expect(breaker.state).toBe("open");
    // The cooldown restarts from the failed probe, rather than from when it first
    // opened.
    expect(breaker.retryAfterMs).toBe(1000);
  });
});

describe("what counts as a failure", () => {
  it("does not forgive earlier failures because of one success", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await failOnce(breaker);
    await succeedOnce(breaker);
    await failOnce(breaker);

    // Two failures inside the window, so the breaker opens despite the success
    // between them.
    expect(breaker.state).toBe("open");
  });

  it("forgets a failure that falls out of the window", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await failOnce(breaker);

    time.advance(5001);
    await failOnce(breaker);

    // The first failure has expired, so this is the only one that counts.
    expect(breaker.state).toBe("closed");
  });

  it("ignores an error that does not indict the dependency", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({
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

  it("reports what it is doing, for a dashboard to read", async () => {
    const time = clock();
    const breaker = new OrderCircuitBreaker({ ...policy, now: time.now });
    await failOnce(breaker);

    const before = breaker.snapshot();
    expect(before.state).toBe("closed");
    expect(before.failures).toBe(1);
    expect(before.retryAfterMs).toBe(0);

    await failOnce(breaker);
    expect(breaker.snapshot().state).toBe("open");
  });
});
```
