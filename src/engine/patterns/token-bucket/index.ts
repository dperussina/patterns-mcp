/**
 * The `token-bucket` pattern: a burst up to a capacity, and a sustained rate beyond it.
 *
 * The algorithm is public knowledge and older than the web, so what earns generation is the handful of
 * choices around it that are each defensible-looking in the wrong direction. Every one below was
 * written as a defect and watched to fail.
 *
 * No timer refills the bucket. The level is a function of elapsed time, computed when someone asks, so
 * an idle bucket costs nothing and no tick quantises the rate. A refilling interval is the obvious
 * design and it is worse in three ways at once: it wakes while nothing is happening, it rounds the rate
 * to its own period, and it needs shutting down.
 *
 * That level is derived from a single anchor rather than accumulated. Adding a delta to a stored level
 * on every read compounds a floating-point error per read — so ten queries across a tenth of a second
 * each leave the level a hair short, and a bucket asked often refills measurably slower than its stated
 * rate. The symptom is a request refused at an exact boundary, which is unreproducible by inspection.
 *
 * Elapsed time is clamped at zero. `Date.now` goes backwards whenever the system clock is corrected,
 * and unclamped that *removes* tokens from a bucket nobody spent from.
 *
 * Order, in the waiting rendering, is protected twice over and deliberately so: the wakeup is scheduled
 * for what the head needs, and the serving loop stops at a head it cannot afford. Either alone keeps the
 * queue in order, which is why neither mutation fails a test by itself — but scheduling for the cheapest
 * waiter instead turns the bucket into a millisecond poll, and serving past the head breaks the order
 * outright when a wakeup arrives late. Both are asserted, one by counting wakeups.
 *
 * A wakeup that arrives late serves everyone it can afford, not one caller. Timers are a floor and not
 * a schedule; a busy runtime delivers them long after their deadline, and one grant per wakeup makes the
 * rest wait for timers they should never have needed.
 *
 * In the keyed rendering the map is swept, because the version without one is a leak whose growth is
 * chosen by whoever sends the traffic. The eviction is exact rather than heuristic: a bucket refilled to
 * capacity is indistinguishable from one that never existed, which is why reading an absent key reports
 * a full bucket rather than creating one.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import {
  dedent,
  documented,
  indent,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const tokenBucketPattern: PatternModule = {
  name: "token-bucket",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      waits: options.waiting === "wait",
      keyed: options.keyed === true,
      names: namesFor(context),
    };
    const n = shape.names;

    const files: RenderedFile[] = [
      { path: `${n.stem}.ts`, role: "core", contents: core(shape) },
      {
        path: `${n.stem}-example.ts`,
        role: "example",
        contents: example(context, shape),
      },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${n.stem}.test.ts`,
        role: "test",
        contents: tests(context, shape),
      });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  /** `waiting: "wait"` — callers queue instead of being refused. */
  readonly waits: boolean;
  readonly keyed: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The public class, which is the keyed façade when there is one. */
  readonly exported: string;
  /** The bucket itself, module-private when a façade wraps it. */
  readonly bucket: string;
  readonly clock: string;
  readonly systemClock: string;
  readonly options: string;
  readonly resolved: string;
  readonly aborted: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;
  const keyed = context.options.keyed === true;

  return {
    stem: entity === undefined ? "token-bucket" : `${entity.kebab}-token-bucket`,
    exported: keyed ? `${prefix}KeyedTokenBucket` : `${prefix}TokenBucket`,
    bucket: keyed ? "Bucket" : `${prefix}TokenBucket`,
    clock: `${prefix}TokenBucketClock`,
    systemClock: entity === undefined ? "systemClock" : `${entity.camel}SystemClock`,
    options: `${prefix}TokenBucketOptions`,
    resolved: "Resolved",
    aborted: `${prefix}TokenWaitAbortedError`,
  };
}

function core(shape: Shape): string {
  return sections(
    clockPort(shape),
    systemClock(shape),
    when(shape.waits, abortedError(shape)),
    optionsType(shape),
    resolvedType(shape),
    resolveFn(shape),
    when(shape.waits, waiterType()),
    bucketClass(shape),
    when(shape.keyed, keyedClass(shape)),
  );
}

function clockPort(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Where time comes from.",
      "A port rather than the ambient globals, so a test states what time it is instead of waiting for it. Two members and not one: this reads the clock as well as scheduling against it, because the level is derived from elapsed time rather than kept.",
      ...(shape.waits
        ? [
            "`delay` hands back a function that stops the timer rather than a handle to clear. The handle is a `number` in a browser and an object in Node, so a type naming it is wrong in one of the two.",
          ]
        : []),
    ],
    dedent`
      export interface ${n.clock} {
        readonly now: () => number;
      ${when(shape.waits, "  readonly delay: (ms: number, callback: () => void) => () => void;\n")}}
    `,
  );
}

function systemClock(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The port over the runtime's own clock.",
      "The default, so ordinary use needs no argument and only a test has to supply one.",
      ...(shape.waits
        ? []
        : [
            "`Date.now` and not a monotonic source, deliberately: a rate limit is stated in wall-clock terms, and a caller comparing it against a log or a header needs the same clock those use. The correction that a monotonic clock avoids is handled where it lands instead.",
          ]),
    ],
    dedent`
      export const ${n.systemClock}: ${n.clock} = {
        now: () => Date.now(),
      ${when(
        shape.waits,
        dedent`
          delay: (ms, callback) => {
              const handle = setTimeout(callback, ms);
              return () => {
                clearTimeout(handle);
              };
            },
        `,
      )}};
    `.replace("delay: (ms", "  delay: (ms"),
  );
}

function abortedError(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A wait abandoned before the tokens arrived.",
      "Rejected with this rather than resolved, because resolving would tell the caller it may proceed — and the whole point of the wait is that it may not.",
    ],
    dedent`
      export class ${n.aborted} extends Error {
        override readonly name = "${n.aborted}";

        constructor() {
          super("The wait for tokens was abandoned before they were granted.");
        }
      }
    `,
  );
}

function optionsType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The two numbers that define a limit, and the clock to measure it against.",
      "`capacity` is the burst: the most that can be spent at once after a quiet period. `refillPerSecond` is the sustained rate. They are independent, and that independence is the point of the algorithm — a limit of \"ten per second\" with a capacity of ten tolerates a browser opening ten connections at once, where a capacity of one would refuse nine of them for being early.",
      ...(shape.keyed ? ["Shared by every key. One limit, applied separately to each subject."] : []),
    ],
    dedent`
      export interface ${n.options} {
        /** The most that can be spent at once. */
        readonly capacity: number;
        /** The sustained rate, in tokens per second. */
        readonly refillPerSecond: number;
        /** Defaults to the runtime's own clock. */
        readonly clock?: ${n.clock};
      }
    `,
  );
}

function resolvedType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Options once checked, with the rate in the units the arithmetic uses.",
      "Milliseconds per token rather than tokens per second, converted once at construction. Converting at each use would put the same division in five places for no gain.",
    ],
    dedent`
      interface ${n.resolved} {
        readonly capacity: number;
        readonly perMs: number;
        readonly clock: ${n.clock};
      }
    `,
  );
}

function resolveFn(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Checks the numbers a limit is built from.",
      "Refused at construction rather than at use. A capacity of zero or a rate of zero describes a limit that can never grant anything, so every later call would fail — and the mistake belongs at the line that made it, not at the first request that met it.",
    ],
    dedent`
      function ${shape.keyed ? "resolve" : "resolve"}(options: ${n.options}): ${n.resolved} {
        const { capacity, refillPerSecond } = options;

        if (!Number.isFinite(capacity) || capacity <= 0) {
          throw new RangeError(
            \`capacity must be a positive finite number, received \${String(capacity)}\`,
          );
        }

        if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
          throw new RangeError(
            \`refillPerSecond must be a positive finite number, received \${String(refillPerSecond)}\`,
          );
        }

        return {
          capacity,
          perMs: refillPerSecond / 1000,
          clock: options.clock ?? ${n.systemClock},
        };
      }
    `,
  );
}

function waiterType(): string {
  return documented(
    [
      "One caller queued for tokens.",
      "`release` detaches the abort listener, and both settling paths call it. A listener left on a signal that outlives the wait keeps this closure — and the bucket — reachable for as long as the signal is.",
    ],
    dedent`
      interface Waiter {
        readonly cost: number;
        readonly grant: () => void;
        readonly refuse: (error: unknown) => void;
        readonly release: () => void;
      }
    `,
  );
}
function bucketClass(shape: Shape): string {
  const n = shape.names;

  const constructor = shape.keyed
    ? dedent`
        constructor(resolved: ${n.resolved}) {
          // Starts full, which is what makes a fresh bucket interchangeable with a forgotten one.
          this.#capacity = resolved.capacity;
          this.#perMs = resolved.perMs;
          this.#clock = resolved.clock;
          this.#stored = resolved.capacity;
          this.#at = resolved.clock.now();
        }
      `
    : dedent`
        constructor(options: ${n.options}) {
          const resolved = resolve(options);

          this.#capacity = resolved.capacity;
          this.#perMs = resolved.perMs;
          this.#clock = resolved.clock;

          // Starts full. A limiter that starts empty refuses the first caller it ever sees, which
          // is indistinguishable to them from being over a limit they have not used.
          this.#stored = resolved.capacity;
          this.#at = resolved.clock.now();
        }
      `;

  const body = sections(
    fields(shape),
    constructor,
    levelMethod(),
    spendMethod(),
    checkMethod(),
    takeMethod(shape),
    when(shape.waits, waitMethod(shape)),
    retryAfterMethod(shape),
    snapshotMethod(shape),
    when(shape.waits, waitMsMethod()),
    when(shape.waits, serveMethod()),
    when(shape.waits, scheduleMethod()),
    when(shape.keyed, evictableMethod(shape)),
  );

  return documented(
    [
      shape.keyed ? "One subject's bucket." : "A burst allowance that refills at a steady rate.",
      ...(shape.keyed
        ? ["Module-private: callers hold the keyed façade, which owns one of these per key."]
        : [
            "Holds no timer and no interval. The whole of its state is a level and the moment that level was true, which also means it needs no shutting down — there is nothing running to stop.",
          ]),
    ],
    dedent`
      ${when(shape.keyed, "", "export ")}class ${n.bucket} {
      ${indent(body, 2)}
      }
    `,
  );
}

function fields(shape: Shape): string {
  const n = shape.names;

  return sections(
    joinLines(
      "readonly #capacity: number;",
      "readonly #perMs: number;",
      `readonly #clock: ${n.clock};`,
    ),
    documented(
      [
        "Tokens held as of `#at`.",
        "Fractional on purpose. A rate is not a whole number of tokens per instant, so half a token has to be representable — an implementation storing whole ones either rounds a fraction up, which grants what it should not, or discards it, which never reaches the rate it advertises.",
      ],
      "#stored: number;",
    ),
    documented(
      ["When `#stored` was last true. Moved by spending, never by reading."],
      "#at: number;",
    ),
    when(shape.waits, joinLines("#waiters: Waiter[] = [];", "#stopTimer: (() => void) | undefined = undefined;")),
  );
}

function levelMethod(): string {
  return documented(
    [
      "The level, computed rather than kept.",
      "No timer refills this. The level is a function of elapsed time, so it is worked out when someone asks — which means an idle bucket costs nothing and no tick quantises the rate.",
      "Note what this does not do: move the anchor. Adding a delta to the stored level on every read compounds a rounding error per read, so a bucket that is asked often refills measurably slower than its stated rate and, at a boundary, refuses a request it should grant. Derived from one anchor instead, the error is a single multiplication that traffic does not compound.",
    ],
    dedent`
      #level(now: number): number {
        // Clamped rather than trusted. A clock going backwards is not hypothetical — \`Date.now\` does
        // it whenever the system time is corrected — and a negative elapsed *removes* tokens from a
        // bucket nobody spent from.
        const elapsed = Math.max(0, now - this.#at);

        return Math.min(this.#capacity, this.#stored + elapsed * this.#perMs);
      }
    `,
  );
}

function spendMethod(): string {
  return documented(
    ["Takes tokens and moves the anchor, which is the only thing that writes the level."],
    dedent`
      #spend(now: number, cost: number): void {
        this.#stored = this.#level(now) - cost;
        this.#at = now;
      }
    `,
  );
}

function checkMethod(): string {
  return documented(
    [
      "Refuses a cost that no amount of waiting could satisfy.",
      "A cost above the capacity is the interesting one. It is not a shortfall but a contradiction, and treating it as a shortfall is how a caller ends up waiting forever for a bucket that will never hold that much.",
    ],
    dedent`
      #check(cost: number): void {
        if (!Number.isFinite(cost) || cost <= 0) {
          throw new RangeError(\`cost must be a positive finite number, received \${String(cost)}\`);
        }

        if (cost > this.#capacity) {
          throw new RangeError(
            \`cost \${String(cost)} exceeds the capacity \${String(this.#capacity)}, so it could never be granted\`,
          );
        }
      }
    `,
  );
}

function takeMethod(shape: Shape): string {
  return documented(
    [
      "Takes tokens if they are there, and reports rather than waits.",
      ...(shape.waits
        ? [
            "Refused while anyone is queued, tokens or not. Granting here would let a caller that asks for less past one already waiting for more, and repeated arrivals would starve that caller for as long as traffic continues.",
          ]
        : []),
    ],
    dedent`
      take(cost = 1): boolean {
        this.#check(cost);

        const now = this.#clock.now();
      ${when(shape.waits, "\n  if (this.#waiters.length > 0) return false;\n")}
        if (this.#level(now) < cost) return false;

        this.#spend(now, cost);
        return true;
      }
    `,
  );
}
function waitMethod(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Waits for tokens, in the order asked.",
      "The fast path checks the queue as well as the level, for the same reason `take` does: a caller arriving to find tokens available must not take them while someone ahead is still waiting for more.",
      "`signal` is the only way out of a long wait. Without it a shutdown has to abandon the promise, which leaves the queue holding a reference to a caller that no longer exists.",
    ],
    dedent`
      async wait(cost = 1, signal?: AbortSignal): Promise<void> {
        this.#check(cost);

        if (signal?.aborted === true) throw new ${n.aborted}();

        const now = this.#clock.now();

        if (this.#waiters.length === 0 && this.#level(now) >= cost) {
          this.#spend(now, cost);
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            cost,
            grant: () => {
              waiter.release();
              resolve();
            },
            refuse: (error: unknown) => {
              waiter.release();
              reject(error);
            },
            release: () => {
              if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
            },
          };

          const onAbort =
            signal === undefined
              ? undefined
              : () => {
                  const index = this.#waiters.indexOf(waiter);
                  if (index >= 0) this.#waiters.splice(index, 1);

                  waiter.refuse(new ${n.aborted}());

                  // Rescheduled because the head may have just left, and the wakeup was set for what
                  // *it* needed. Skipped, a smaller waiter behind it sleeps until the larger one's
                  // deadline — served late, with nothing in the code to say why.
                  this.#schedule();
                };

          if (onAbort !== undefined) {
            signal?.addEventListener("abort", onAbort, { once: true });
          }

          this.#waiters.push(waiter);
          this.#schedule();
        });
      }
    `,
  );
}

function retryAfterMethod(shape: Shape): string {
  return documented(
    [
      "How long until `cost` tokens are the caller's. The number a 429 wants.",
      ...(shape.waits
        ? [
            "Counts the demand queued ahead of the caller, not only the shortfall. Reporting the shortfall alone is a plausible answer that is wrong whenever anyone is waiting, and wrong in the worst direction: it sends the caller back at a moment it is guaranteed to be refused again.",
          ]
        : [
            "Exact rather than a fixed backoff. A caller told to wait a second when it needed 120ms has had eight tenths of its throughput taken by the advice rather than by the limit.",
          ]),
    ],
    dedent`
      retryAfterMs(cost = 1): number {
      ${indent(
        sections(
          "this.#check(cost);",
          when(
            shape.waits,
            "const ahead = this.#waiters.reduce((total, waiter) => total + waiter.cost, 0);",
          ),
          joinLines(
            shape.waits
              ? joinLines(
                  "// Clamped, because zero is reachable and truthful: a wakeup can be overdue, leaving",
                  "// more tokens than the queue in front of the caller needs.",
                )
              : joinLines(
                  "// Clamped, because a bucket with room owes no wait. The shortfall is negative there",
                  "// and the honest answer is now, not the one millisecond a floor would invent.",
                ),
            "return Math.max(",
            `  0,`,
            `  Math.ceil((${when(shape.waits, "ahead + ")}cost - this.#level(this.#clock.now())) / this.#perMs),`,
            ");",
          ),
        ),
        2,
      )}
      }
    `
  );
}

function snapshotMethod(shape: Shape): string {
  return documented(
    [
      "What the bucket holds, for a test or a metric.",
      "A method rather than a getter per field, so one reading is internally consistent: two getters called in turn can be separated by enough elapsed time to disagree.",
    ],
    dedent`
      snapshot(): {
        readonly level: number;
        readonly capacity: number;
      ${when(shape.waits, "  readonly waiting: number;\n")}} {
        return {
          level: this.#level(this.#clock.now()),
          capacity: this.#capacity,
      ${when(shape.waits, "      waiting: this.#waiters.length,\n")}    };
      }
    `,
  );
}

function waitMsMethod(): string {
  return documented(
    [
      "Milliseconds until the level reaches `cost`.",
      "The floor is not currently reachable: this is only asked about a head that cannot be served, so the shortfall is positive and the ceiling of a positive number is already at least one. It is here for what happens if that stops being true — a delay of zero produces a timer that fires, finds the same shortfall, and schedules another, which is not a slow bucket but a pinned core.",
    ],
    dedent`
      #waitMs(now: number, cost: number): number {
        return Math.max(1, Math.ceil((cost - this.#level(now)) / this.#perMs));
      }
    `,
  );
}

function serveMethod(): string {
  return documented(
    [
      "Grants what the front of the queue can afford, in order.",
      "A loop and not a single grant. A wakeup can arrive with several tokens' worth — timers are a floor rather than a schedule, and a busy runtime delivers them late — and serving one caller per wakeup makes the rest wait for timers they should never have needed.",
    ],
    dedent`
      #serve(): void {
        const now = this.#clock.now();

        for (;;) {
          const head = this.#waiters[0];

          // Stops at the head it cannot afford rather than looking past it for one it can. Redundant
          // with scheduling for the head's need — either alone keeps the queue in order — but this is
          // the one that states the rule, and the one that holds when a wakeup arrives late.
          if (head === undefined || this.#level(now) < head.cost) break;

          this.#waiters.shift();
          this.#spend(now, head.cost);
          head.grant();
        }
      }
    `,
  );
}

function scheduleMethod(): string {
  return documented(
    [
      "One wakeup, set for exactly when the head can be served.",
      "For the head's need and not the cheapest waiter's. Scheduling for the cheapest still drains the queue in order, because serving stops at the head either way — but it wakes every millisecond until the head can afford its cost, which is a poll wearing a timer's clothes.",
    ],
    dedent`
      #schedule(): void {
        this.#stopTimer?.();
        this.#stopTimer = undefined;

        const head = this.#waiters[0];
        if (head === undefined) return;

        const now = this.#clock.now();

        this.#stopTimer = this.#clock.delay(this.#waitMs(now, head.cost), () => {
          this.#stopTimer = undefined;
          this.#serve();

          // Rescheduled whether or not anyone was served. A wakeup can arrive a fraction early —
          // the delay is rounded and the rate is not a whole number of tokens per millisecond — and
          // find the shortfall still there, so the wakeup that makes progress is the next one.
          this.#schedule();
        });
      }
    `,
  );
}

function evictableMethod(shape: Shape): string {
  return documented(
    [
      "Whether this bucket can be forgotten without changing any answer.",
      "True when it is full" +
        (shape.waits ? " and nobody is queued on it" : "") +
        ", which is exactly the state of a bucket that never existed. That equivalence is what makes eviction exact rather than a heuristic: dropping it costs the caller nothing, because a fresh one would give the same reply.",
    ],
    dedent`
      evictable(): boolean {
        ${when(shape.waits, "if (this.#waiters.length > 0) return false;\n\n    ")}return this.#level(this.#clock.now()) >= this.#capacity;
      }
    `,
  );
}
function keyedClass(shape: Shape): string {
  const n = shape.names;

  const body = sections(
    sections(
      joinLines(
        `readonly #resolved: ${n.resolved};`,
        `readonly #buckets = new Map<string, ${n.bucket}>();`,
      ),
      documented(
        ["The size at which the next sweep happens. Doubles, so sweeping costs a constant per key."],
        "#sweepAt = INITIAL_SWEEP_AT;",
      ),
    ),
    dedent`
      constructor(options: ${n.options}) {
        this.#resolved = resolve(options);
      }
    `,
    documented(
      [
        `Takes tokens from \`key\`'s bucket.`,
      ],
      dedent`
        take(key: string, cost = 1): boolean {
          return this.#bucket(key).take(cost);
        }
      `,
    ),
    when(
      shape.waits,
      documented(
        ["Waits for tokens from `key`'s bucket, in the order asked for that key."],
        dedent`
          async wait(key: string, cost = 1, signal?: AbortSignal): Promise<void> {
            await this.#bucket(key).wait(cost, signal);
          }
        `,
      ),
    ),
    documented(
      ["How long until `key` may spend `cost`."],
      dedent`
        retryAfterMs(key: string, cost = 1): number {
          return this.#bucket(key).retryAfterMs(cost);
        }
      `,
    ),
    documented(
      [
        "What `key` holds, without creating a bucket for it.",
        "An absent key is not an unknown one: it has spent nothing, which is the same state as a bucket refilled to capacity. Reading through that equivalence rather than creating a bucket matters — a monitoring loop over every key it has ever seen would otherwise repopulate everything the sweep just dropped.",
      ],
      dedent`
        snapshot(key: string): {
          readonly level: number;
          readonly capacity: number;
        ${when(shape.waits, "  readonly waiting: number;\n")}} {
          const bucket = this.#buckets.get(key);

          if (bucket === undefined) {
            return {
              level: this.#resolved.capacity,
              capacity: this.#resolved.capacity,
        ${when(shape.waits, "        waiting: 0,\n")}      };
          }

          return bucket.snapshot();
        }
      `,
    ),
    documented(
      [
        "How many buckets are held.",
        "Exposed because it is the number that decides whether this leaks. A limiter keyed by address is fed its keys by whoever is sending the traffic, so unbounded growth is not an edge case but a denial of service.",
      ],
      dedent`
        get tracked(): number {
          return this.#buckets.size;
        }
      `,
    ),
    documented(
      [
        `\`key\`'s bucket, created if this is the first time it has been seen.`,
        "The sweep happens here, before an insertion, because an insertion is the only thing that grows the map.",
      ],
      dedent`
        #bucket(key: string): ${n.bucket} {
          const existing = this.#buckets.get(key);
          if (existing !== undefined) return existing;

          if (this.#buckets.size >= this.#sweepAt) this.#sweep();

          const fresh = new ${n.bucket}(this.#resolved);
          this.#buckets.set(key, fresh);
          return fresh;
        }
      `,
    ),
    documented(
      [
        "Drops every bucket that has refilled to capacity.",
        "The walk is linear, and the threshold doubles after each one, so the cost per key is constant however many keys arrive. A sweep on every insertion would be quadratic; a sweep on a timer would need shutting down and would run while nothing was happening.",
        "What is left afterwards is the set of keys that have spent something recently, which is the smallest set that could answer correctly — so the memory this holds is a function of real traffic rather than of how many distinct keys have ever been seen.",
      ],
      dedent`
        #sweep(): void {
          for (const [key, bucket] of this.#buckets) {
            if (bucket.evictable()) this.#buckets.delete(key);
          }

          this.#sweepAt = Math.max(INITIAL_SWEEP_AT, this.#buckets.size * 2);
        }
      `,
    ),
  );

  return sections(
    documented(
      [
        "How many buckets may accumulate before the first sweep.",
        "Small, because the sweep is cheap and the point is to bound memory rather than to defer work.",
      ],
      "const INITIAL_SWEEP_AT = 8;",
    ),
    documented(
      [
        "One limit, applied separately to each subject.",
        "The map is swept rather than allowed to grow. Every limiter keyed by something a caller controls — an address, a token, a tenant — is fed its keys by the traffic, so a map that is never emptied is a leak whose rate is chosen by whoever is attacking it.",
      ],
      dedent`
        export class ${n.exported} {
        ${indent(body, 2)}
        }
      `,
    ),
  );
}
function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const key = shape.keyed ? `"${"$"}{caller}", ` : "";

  const decision = when(
    !shape.waits,
    documented(
      [
        "A verdict and the advice that goes with it.",
        "Both together, because they come from one reading of the bucket. Asked separately, the second reading is taken at a later instant and can contradict the first.",
      ],
      dedent`
        export interface Decision {
          readonly allowed: boolean;
          /** The value for a \`Retry-After\` header, in seconds, when refused. */
          readonly retryAfterSeconds: number;
        }
      `,
    ),
  );

  const body = shape.waits
    ? dedent`
        export function throttled(
          send: (path: string) => Promise<string>,
          ${when(shape.keyed, "capacityPerCaller = 20,\n  ", "capacity = 20,\n  ")}refillPerSecond = 5,
        ): (${when(shape.keyed, "caller: string, ")}path: string, signal?: AbortSignal) => Promise<string> {
          const limit = new ${n.exported}({
            ${when(shape.keyed, "capacity: capacityPerCaller", "capacity")},
            refillPerSecond,
          });

          return async (${when(shape.keyed, "caller: string, ")}path: string, signal?: AbortSignal): Promise<string> => {
            // Waits rather than refuses, because the work has to happen and the far end would answer
            // 429 anyway. Being told to slow down is cheaper here than being rejected there.
            await limit.wait(${key}1, signal);

            return await send(path);
          };
        }
      `
    : dedent`
        export function admit(
          ${when(shape.keyed, "capacityPerCaller = 20,\n  ", "capacity = 20,\n  ")}refillPerSecond = 5,
        ): (${when(shape.keyed, "caller: string")}) => Decision {
          const limit = new ${n.exported}({
            ${when(shape.keyed, "capacity: capacityPerCaller", "capacity")},
            refillPerSecond,
          });

          return (${when(shape.keyed, "caller: string")}): Decision => {
            if (limit.take(${when(shape.keyed, "caller")})) {
              return { allowed: true, retryAfterSeconds: 0 };
            }

            // Rounded up. \`Retry-After\` is whole seconds, and rounding down tells the caller to
            // return at a moment it is certain to be refused again — which doubles the traffic the
            // limit exists to reduce.
            return {
              allowed: false,
              retryAfterSeconds: Math.ceil(limit.retryAfterMs(${when(shape.keyed, "caller")}) / 1000),
            };
          };
        }
      `;

  return sections(
    dedent`
      /**
       * ${shape.waits ? "Calling someone else's rate-limited API." : "Deciding whether to answer a request."}
       *
       * ${
         shape.waits
           ? "The direction that wants waiting: the work has to happen, and there is a published limit to\n * stay under. Pacing the calls locally is strictly better than discovering the limit by being\n * refused, because a refusal still cost a request."
           : "The direction that wants refusing: a server cannot hold a request open until it is allowed,\n * and it has somewhere to put the answer — a 429 with the delay in a header."
       }
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.exported],
    }),
    decision,
    documented(
      shape.waits
        ? [
            "Wraps a sender so it stays under a published rate.",
            ...(shape.keyed
              ? ["One allowance per caller, so a busy tenant cannot spend a quiet tenant's share."]
              : []),
            "The signal is forwarded rather than swallowed. A request abandoned by whoever asked for it should not go on holding a place in the queue.",
          ]
        : [
            "Decides whether a request may proceed, and when to come back if not.",
            ...(shape.keyed
              ? ["One allowance per caller, which is what makes this a limit rather than a global tap."]
              : []),
            "Built once and closed over, so the allowance survives between requests. A limiter constructed per request is always full and therefore always permissive — the commonest way this is deployed without limiting anything.",
          ],
      body,
    ),
  );
}
function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const framework =
    conventions.testFramework === "node-test"
      ? joinLines(
          importsFrom(conventions, "node:test", { values: ["describe", "it"] }),
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), {
            values: ["expect"],
          }),
        )
      : importsFrom(
          conventions,
          "vitest",
          { values: ["describe", "expect", "it"] },
        );

  return sections(
    dedent`
      /**
       * What is asserted here, and why it is written this way.
       *
       * The clock is supplied, not waited on. Every case states what time it is, so the suite is exact
       * and costs no wall-clock time — where a rate limit tested against real time is both slow and
       * flaky, since 100ms elapses on an idle machine and does not on a loaded one.
       *
       * Levels are asserted as fractions where a fraction is the point. Half a token is not a token, and
       * an implementation that stores whole ones passes every case that only ever asks for one after a
       * full period.
       ${
         shape.waits
           ? "*\n       * The clock can also deliver a wakeup late and count how many it has delivered. Both are\n       * properties of real runtimes rather than test conveniences: timers are a floor and not a\n       * schedule, and the difference between a scheduled limiter and a millisecond poll is invisible\n       * to any assertion about *what* was served."
           : ""
       }
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.exported, ...(shape.waits ? [n.aborted] : [])],
      types: [n.clock],
    }),
    testHelpers(shape),
    levelCases(shape),
    when(shape.waits, orderCases(shape)),
    when(shape.waits, abortCases(shape)),
    retryAfterCases(shape),
    when(shape.keyed, keyedCases(shape)),
    refusalCases(shape),
  );
}

function testHelpers(shape: Shape): string {
  const n = shape.names;

  const clockBody = shape.waits
    ? dedent`
        interface Entry {
          at: number;
          fn: () => void;
          live: boolean;
        }

        let now = 0;
        let fired = 0;
        const entries: Entry[] = [];

        /** Runs what is due by \`limit\`, oldest first, including anything they schedule. */
        const runDue = (limit: number, onTime: boolean): void => {
          for (;;) {
            const due = entries
              .filter((entry) => entry.live && entry.at <= limit)
              .sort((first, second) => first.at - second.at)[0];
            if (due === undefined) break;

            due.live = false;
            fired += 1;

            // A wakeup delivered on time sees its own deadline as the current instant. One delivered
            // late sees the later instant it actually ran at, which is what gives it more tokens.
            if (onTime) now = due.at;

            due.fn();
          }
        };

        return {
          now: () => now,
          delay: (ms, fn) => {
            const entry: Entry = { at: now + ms, fn, live: true };
            entries.push(entry);
            return () => {
              entry.live = false;
            };
          },
          advance: (ms) => {
            const target = now + ms;
            runDue(target, true);
            now = target;
          },
          advanceLate: (ms) => {
            now += ms;
            runDue(now, false);
          },
          liveTimers: () => entries.filter((entry) => entry.live).length,
          firedTimers: () => fired,
        };
      `
    : dedent`
        let now = 0;

        return {
          now: () => now,
          advance: (ms) => {
            now += ms;
          },
        };
      `;

  const clockType = shape.waits
    ? dedent`
        interface TestClock extends ${n.clock} {
          readonly advance: (ms: number) => void;
          /** Moves the clock and *then* runs what came due, as a busy runtime does. */
          readonly advanceLate: (ms: number) => void;
          readonly liveTimers: () => number;
          /** How many wakeups have run. One per grant, not one per poll. */
          readonly firedTimers: () => number;
        }
      `
    : dedent`
        interface TestClock extends ${n.clock} {
          readonly advance: (ms: number) => void;
        }
      `;

  return sections(
    documented(
      [
        "A clock this file states rather than waits for.",
        ...(shape.waits
          ? [
              "Firing is a loop rather than one pass, because a wakeup schedules its successor and a case that advanced past both should see both.",
            ]
          : []),
      ],
      sections(
        clockType,
        dedent`
          function clock(): TestClock {
          ${indent(clockBody, 2)}
          }
        `,
      ),
    ),
    when(
      shape.waits,
      documented(
        [
          "Lets every microtask already scheduled run.",
          "Needed even with the clock under control: granting resolves a promise, and observing that is a later turn than the wakeup that caused it.",
        ],
        dedent`
          async function drain(): Promise<void> {
            for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
          }
        `,
      ),
    ),
    documented(
      [
        "A limit of ten per second with room for three at once.",
        "Ten per second is one token every hundred milliseconds, which makes every duration below a round number and every fraction an exact one.",
      ],
      dedent`
        function harness(capacity = 3, refillPerSecond = 10) {
          const time = clock();

          return {
            clock: time,
            limit: new ${n.exported}({ capacity, refillPerSecond, clock: time }),
          };
        }
      `,
    ),
  );
}

/** How a case spells a take, since the keyed façade needs a subject. */
function take(shape: Shape, cost?: string): string {
  const args = [...(shape.keyed ? ['"a"'] : []), ...(cost === undefined ? [] : [cost])];
  return `limit.take(${args.join(", ")})`;
}

/** How a case spells a wait. */
function waitFor(shape: Shape, cost: string, signal?: string): string {
  const args = [...(shape.keyed ? ['"a"'] : []), cost, ...(signal === undefined ? [] : [signal])];
  return `limit.wait(${args.join(", ")})`;
}

/** How a case spells a snapshot. */
function snap(shape: Shape): string {
  return shape.keyed ? 'limit.snapshot("a")' : "limit.snapshot()";
}

/** How a case spells a retry-after query. */
function retry(shape: Shape, cost?: string): string {
  const args = [...(shape.keyed ? ['"a"'] : []), ...(cost === undefined ? [] : [cost])];
  return `limit.retryAfterMs(${args.join(", ")})`;
}
function levelCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.exported}", () => {
      it("allows a burst up to the capacity and then refuses", () => {
        const { limit } = harness();

        expect([${take(shape)}, ${take(shape)}, ${take(shape)}]).toEqual([true, true, true]);
        expect(${take(shape)}).toBe(false);
      });

      it("counts a fraction of a token without granting one", () => {
        const { clock: time, limit } = harness();

        ${take(shape, "3")};
        time.advance(50);

        // Half a token is not a token, and it is not nothing either. An implementation storing whole
        // tokens has to choose: round up and grant what it should not, or discard and never reach the
        // rate it advertises.
        expect(${take(shape)}).toBe(false);
        expect(${snap(shape)}.level).toBe(0.5);

        time.advance(50);
        expect(${take(shape)}).toBe(true);
      });

      it("does not bank tokens beyond the capacity", () => {
        const { clock: time, limit } = harness();

        time.advance(10_000);

        // A day idle does not buy a day's worth. The capacity is the burst, and an unbounded level is
        // how a limiter that looked correct for a week lets through a hundred requests at once.
        expect(${snap(shape)}.level).toBe(3);
        expect([${take(shape, "3")}, ${take(shape)}]).toEqual([true, false]);
      });

      it("does not refill more slowly when asked more often", () => {
        const { clock: time, limit } = harness();

        ${take(shape, "3")};

        const granted: boolean[] = [];
        for (let tick = 0; tick < 10; tick += 1) {
          time.advance(10);
          granted.push(${take(shape)});
        }

        // Ten reads across one token's worth of time. An implementation that moves its anchor on every
        // read loses a rounding error each time, so the tenth tenth leaves the level a hair under one
        // and this last grant is refused — a bucket slower than its stated rate, for no visible reason.
        expect(granted[9]).toBe(true);
        expect(granted.filter((ok) => ok).length).toBe(1);
      });

      it("does not lose tokens when the clock is corrected backwards", () => {
        const time = clock();
        let offset = 0;
        const shifted: ${n.clock} = {
          now: () => time.now() + offset,
      ${when(shape.waits, "    delay: time.delay,\n")}    };
        const limit = new ${n.exported}({ capacity: 3, refillPerSecond: 10, clock: shifted });

        ${take(shape, "3")};
        offset = -5_000;

        // \`Date.now\` goes backwards whenever the system time is corrected, which on a fleet is a
        // routine event. Unclamped, the elapsed time is negative and *removes* tokens from a bucket
        // nobody spent from — so a correction silently tightens the limit.
        expect(${snap(shape)}.level).toBe(0);
      });
    });
  `;
}

function orderCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.exported} order", () => {
      it("serves waiters in the order they asked", async () => {
        const { clock: time, limit } = harness(1);
        const served: string[] = [];

        ${take(shape)};
        void ${waitFor(shape, "1")}.then(() => served.push("first"));
        void ${waitFor(shape, "1")}.then(() => served.push("second"));
        await drain();
        expect(served).toEqual([]);

        time.advance(100);
        await drain();
        expect(served).toEqual(["first"]);

        time.advance(100);
        await drain();
        expect(served).toEqual(["first", "second"]);

        // One wakeup per grant. A bucket scheduling for the cheapest waiter rather than the one in
        // front still serves them in order — the queue drains from its head either way — but it wakes
        // every millisecond until the head can afford its cost, which is a poll wearing a timer's
        // clothes and is invisible to any assertion about what was served.
        expect(time.firedTimers()).toBe(2);
      });

      it("does not let a smaller waiter past a larger one", async () => {
        const { clock: time, limit } = harness();
        const served: string[] = [];

        ${take(shape, "3")};
        void ${waitFor(shape, "3")}.then(() => served.push("large"));
        void ${waitFor(shape, "1")}.then(() => served.push("small"));

        // One token exists here: enough for the second waiter, not for the first. Serving it would
        // starve the larger one for as long as small requests keep arriving.
        time.advance(100);
        await drain();
        expect(served).toEqual([]);

        time.advance(200);
        await drain();
        expect(served).toEqual(["large"]);
      });

      it("does not let a waiter arriving with tokens available take them", async () => {
        const { clock: time, limit } = harness();
        const served: string[] = [];

        ${take(shape, "3")};
        void ${waitFor(shape, "3")}.then(() => served.push("large"));

        time.advance(100);
        void ${waitFor(shape, "1")}.then(() => served.push("small"));
        await drain();

        expect(served).toEqual([]);
      });

      it("refuses a take while anyone is waiting, tokens or not", async () => {
        const { clock: time, limit } = harness();
        const served: string[] = [];

        ${take(shape, "3")};
        void ${waitFor(shape, "2")}.then(() => served.push("waiter"));

        time.advance(100);
        expect(${take(shape)}).toBe(false);

        time.advance(100);
        await drain();
        expect(served).toEqual(["waiter"]);
      });

      it("serves everyone a late wakeup can afford", async () => {
        const { clock: time, limit } = harness(4);
        const served: string[] = [];

        ${take(shape, "4")};
        void ${waitFor(shape, "1")}.then(() => served.push("a"));
        void ${waitFor(shape, "1")}.then(() => served.push("b"));
        void ${waitFor(shape, "1")}.then(() => served.push("c"));

        // The wakeup was set for one token's worth and arrives with three, which is what happens
        // whenever the runtime is busy — a timer is a floor and not a schedule. Granting one caller
        // per wakeup makes the other two wait for timers they should never have needed.
        time.advanceLate(300);
        await drain();

        expect(served).toEqual(["a", "b", "c"]);
      });

      it("holds no timer while nobody is waiting", async () => {
        const { clock: time, limit } = harness(1);

        ${take(shape)};
        expect(time.liveTimers()).toBe(0);

        void ${waitFor(shape, "1")}.then(() => undefined);
        expect(time.liveTimers()).toBe(1);

        time.advance(100);
        await drain();
        expect(time.liveTimers()).toBe(0);
      });
    });
  `;
}

function abortCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.exported} cancellation", () => {
      it("removes an abandoned waiter and tells it why", async () => {
        const { clock: time, limit } = harness(1);
        const controller = new AbortController();
        const outcomes: unknown[] = [];

        ${take(shape)};
        void ${waitFor(shape, "1", "controller.signal")}.then(
          () => outcomes.push("granted"),
          (error: unknown) => outcomes.push(error),
        );
        await drain();
        expect(${snap(shape)}.waiting).toBe(1);

        controller.abort();
        await drain();

        expect(${snap(shape)}.waiting).toBe(0);
        expect(outcomes.length).toBe(1);
        expect(outcomes[0]).toBeInstanceOf(${n.aborted});

        // And no token was spent on them. A waiter left in the queue is granted tokens nobody is
        // waiting for, which is a limit quietly spending its allowance on nothing.
        time.advance(100);
        await drain();
        expect(${snap(shape)}.level).toBe(1);
      });

      it("does not hold the next waiter to an abandoned one's deadline", async () => {
        const { clock: time, limit } = harness();
        const controller = new AbortController();
        const served: string[] = [];

        ${take(shape, "3")};
        void ${waitFor(shape, "3", "controller.signal")}.then(
          () => served.push("large"),
          () => undefined,
        );
        void ${waitFor(shape, "1")}.then(() => served.push("small"));

        controller.abort();
        await drain();

        // The wakeup was set for the large waiter's three tokens. With it gone the small one needs
        // one, and is served now only if abandoning rescheduled — otherwise it sleeps until a
        // deadline computed for a caller that no longer exists.
        time.advance(100);
        await drain();
        expect(served).toEqual(["small"]);
      });

      it("refuses a wait whose signal has already fired", async () => {
        const { limit } = harness(1);
        const controller = new AbortController();
        controller.abort();

        ${take(shape)};

        let caught: unknown = undefined;
        try {
          await ${waitFor(shape, "1", "controller.signal")};
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(${n.aborted});
        expect(${snap(shape)}.waiting).toBe(0);
      });
    });
  `;
}

function retryAfterCases(shape: Shape): string {
  const n = shape.names;

  const queued = when(
    shape.waits,
    dedent`

      it("counts the demand queued ahead of the caller", async () => {
        const { clock: time, limit } = harness();

        ${take(shape, "3")};
        void ${waitFor(shape, "2")}.then(() => undefined);

        // Two tokens are owed to the waiter in front, so the answer is three tokens' worth and not
        // one. Reporting only this caller's own shortfall sends it back at 100ms to be refused again,
        // which turns a limit into a source of retries.
        expect(${retry(shape, "1")}).toBe(300);

        time.advance(200);
        await drain();
        expect(${retry(shape, "1")}).toBe(100);
      });
    `,
  );

  return dedent`
    describe("${n.exported} retry advice", () => {
      it("is zero while there is room", () => {
        const { limit } = harness();

        expect(${retry(shape)}).toBe(0);
      });

      it("is the exact shortfall, not a fixed backoff", () => {
        const { clock: time, limit } = harness();

        ${take(shape, "3")};
        expect(${retry(shape)}).toBe(100);
        expect(${retry(shape, "3")}).toBe(300);

        time.advance(50);
        expect(${retry(shape)}).toBe(50);
      });
    ${queued}});
  `;
}

function keyedCases(shape: Shape): string {
  const n = shape.names;

  const stranded = when(
    shape.waits,
    dedent`

      it("does not drop a key someone is waiting on", async () => {
        const { clock: time, limit } = harness();

        limit.take("busy", 3);
        void limit.wait("busy", 3).then(() => undefined);

        // Enough keys to provoke a sweep, each spending one so none of them is evictable yet.
        for (let index = 0; index < 40; index += 1) limit.take(\`k\${String(index)}\`, 1);

        // Long enough for those forty to refill, and not long enough for the waiter to be served.
        time.advance(100);
        for (let index = 0; index < 40; index += 1) limit.take(\`later\${String(index)}\`, 1);

        // A full bucket is safe to forget; one with a caller queued on it is not, because that queue
        // is where their grant is going to come from. Dropped, they wait on a bucket nothing holds.
        expect(limit.snapshot("busy").waiting).toBe(1);

        time.advance(200);
        await drain();
        expect(limit.snapshot("busy").waiting).toBe(0);
        expect(limit.snapshot("busy").level).toBe(0);
      });
    `,
  );

  return dedent`
    describe("${n.exported} keys", () => {
      it("gives each key its own allowance", () => {
        const { limit } = harness(1);

        expect(limit.take("first")).toBe(true);
        expect(limit.take("first")).toBe(false);

        // A busy subject must not spend a quiet one's share, which is the entire reason for keying.
        expect(limit.take("second")).toBe(true);
      });

      it("reports an unknown key without creating a bucket for it", () => {
        const { limit } = harness();

        expect(limit.snapshot("never-seen").level).toBe(3);
        expect(limit.tracked).toBe(0);
      });

      it("forgets keys that have refilled, and keeps those that have not", () => {
        const { clock: time, limit } = harness();

        for (let index = 0; index < 40; index += 1) limit.take(\`k\${String(index)}\`, 1);
        expect(limit.tracked > 8).toBe(true);

        // Long enough for every one of them to be full again, at which point each is
        // indistinguishable from a key never seen — so dropping them changes no answer.
        time.advance(10_000);
        limit.take("spent", 3);

        for (let index = 0; index < 40; index += 1) limit.take(\`later\${String(index)}\`, 1);

        expect(limit.snapshot("spent").level < 3).toBe(true);
        expect(limit.tracked < 60).toBe(true);
      });

      it("bounds what it holds to the keys with something to remember", () => {
        const { clock: time, limit } = harness();

        for (let round = 0; round < 20; round += 1) {
          for (let index = 0; index < 20; index += 1) {
            limit.take(\`round\${String(round)}-\${String(index)}\`, 1);
          }
          time.advance(1_000);
        }

        // Four hundred distinct keys have been seen and none recently, so what is held is a function
        // of live traffic rather than of history. Without a sweep this is four hundred and climbing,
        // and the climb is chosen by whoever is sending the keys.
        expect(limit.tracked < 60).toBe(true);
      });
    ${stranded}});
  `;
}

function refusalCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.exported} arguments", () => {
      it("refuses a cost that no wait could satisfy", () => {
        const { limit } = harness();

        for (const cost of [0, -1, Number.NaN]) {
          expect(() => ${take(shape, "cost")}).toThrow(/positive finite/);
        }

        // Not a shortfall but a contradiction: the bucket will never hold four. Treated as a
        // shortfall${when(shape.waits, ", a caller waits for it forever", ", a caller retries for it forever")}.
        expect(() => ${take(shape, "4")}).toThrow(/exceeds the capacity/);
      });

      it("refuses a limit that could never grant anything", () => {
        expect(() => new ${n.exported}({ capacity: 0, refillPerSecond: 1 })).toThrow(
          /capacity must be a positive/,
        );
        expect(() => new ${n.exported}({ capacity: 1, refillPerSecond: 0 })).toThrow(
          /refillPerSecond must be a positive/,
        );
        expect(
          () =>
            new ${n.exported}({ capacity: 1, refillPerSecond: Number.POSITIVE_INFINITY }),
        ).toThrow(/refillPerSecond must be a positive/);
      });
    });
  `;
}
