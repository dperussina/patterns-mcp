/**
 * The `semaphore` pattern: a fixed number of operations allowed to run at once.
 *
 * The counting semaphore is sixty years old and four lines long — a counter, a queue, and two
 * operations on them. What makes it worth generating is that on a single-threaded event loop almost
 * every way of getting it wrong fails *silently*, and the failure arrives as a process that has stopped
 * doing anything rather than as an exception anyone can trace.
 *
 * Each of these was verified by writing the mistake and watching a test catch it, not by reasoning:
 *
 * A permit is not returned. The obvious spelling — release after the work — leaks one whenever the work
 * throws, and the limiter admits one fewer operation for the rest of the process until it admits none.
 * So the wrapper that runs a task releases in a `finally`, and the raw `acquire` is documented as owing
 * one.
 *
 * A permit is returned twice. Then the counter climbs past the capacity and the limit quietly stops
 * being a limit, which is worse than a leak because nothing appears wrong. The releaser is idempotent.
 *
 * A waiter is served out of order. Taking a free permit while somebody waits, or serving the queue from
 * its tail, both look harmless and both starve a waiter indefinitely under sustained arrival.
 *
 * A wait cannot be satisfied. Asking for more than the capacity is a request no release can ever grant,
 * so it is refused where it is made rather than queued into a deadlock.
 *
 * Two subtleties are worth naming because they are invisible until they bite. With weights, a lighter
 * waiter behind a heavier one must *not* be served first, or the heavy one starves whenever light work
 * keeps arriving — the queue head has to block, leaving capacity deliberately idle. And a permit is
 * granted synchronously inside `release`, while the caller waiting for it does not resume until a
 * microtask later, so a signal that fires in between finds a caller who already holds a permit and has
 * already left the queue. That window is the one the acquire-side cancellation cannot cover, and it is
 * why the task wrapper checks the signal a second time after acquiring.
 *
 * The emitted suite drives all of this with promises it settles itself rather than with timers. Not only
 * for determinism: a leaked permit manifests as a promise that never settles, so a suite written around
 * `await` would report it as a timeout minutes later instead of as a failed assertion about a counter.
 * Every case therefore asserts on the snapshot, and only awaits what it has already proven will arrive.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import {
  dedent,
  documented,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const semaphorePattern: PatternModule = {
  name: "semaphore",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      cancellable: options.cancellation === "abort-signal",
      weighted: options.weighted === true,
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
  readonly cancellable: boolean;
  readonly weighted: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The class: `OrderSemaphore`. */
  readonly semaphore: string;
  /** What `acquire` hands back: `OrderRelease`. */
  readonly release: string;
  /** The observable counters: `OrderSemaphoreSnapshot`. */
  readonly snapshot: string;
  /** The refusal, under `cancellation: abort-signal`. */
  readonly aborted: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;

  return {
    stem: entity === undefined ? "semaphore" : `${entity.kebab}-semaphore`,
    semaphore: `${prefix}Semaphore`,
    release: `${prefix}Release`,
    snapshot: `${prefix}SemaphoreSnapshot`,
    aborted: `${prefix}SemaphoreAbortedError`,
  };
}

/** The parameter list of `acquire`, which varies on both options. */
function acquireParams(shape: Shape): string {
  const parts = [
    ...(shape.weighted ? ["weight = 1"] : []),
    ...(shape.cancellable ? ["signal?: AbortSignal"] : []),
  ];
  return parts.join(", ");
}

/** An `acquire` with the default weight and no signal, as every case that only needs one spells it. */
function plainAcquire(shape: Shape): string {
  return shape.weighted ? "acquire(1)" : "acquire()";
}

/** What a caller passes on, forwarding whatever `acquire` takes. */
function acquireArgs(shape: Shape): string {
  const parts = [
    ...(shape.weighted ? ["weight"] : []),
    ...(shape.cancellable ? ["signal"] : []),
  ];
  return parts.join(", ");
}

function core(shape: Shape): string {
  return sections(
    releaseType(shape),
    snapshotType(shape),
    when(shape.cancellable, abortedError(shape)),
    waiterType(shape),
    semaphoreClass(shape),
  );
}

function releaseType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Returns the permits one acquisition took.",
      "Idempotent, and that is a guarantee rather than a convenience. Calling it twice must not raise the count above the capacity, because a semaphore that has quietly gained a permit no longer limits anything and nothing about it looks wrong. Ignoring the second call is the safe direction: a duplicate release is harmless, while over-admission is the failure the whole type exists to prevent.",
      "Owed by whoever acquired. `run` discharges it in a `finally`, which is why it should be preferred to `acquire` wherever the work fits inside a callback.",
    ],
    `export type ${n.release} = () => void;`,
  );
}

function snapshotType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The counters, read together.",
      "One value rather than three getters, so that what is logged or asserted is a coherent picture of one instant. Reading them separately invites a report in which the numbers do not add up because something moved in between.",
      "`inFlight` is `capacity - available` and is derived rather than tracked, because a second counter is a second thing that can be wrong. It is named because it is the number worth graphing.",
    ],
    dedent`
      export interface ${n.snapshot} {
        readonly capacity: number;
        readonly available: number;
        readonly inFlight: number;
        /** Callers queued and not yet granted anything. */
        readonly waiting: number;
      }
    `,
  );
}

function abortedError(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A wait abandoned before a permit arrived.",
      "A named class rather than the signal's own `reason`, which is `any` and may be anything at all — including `undefined`, which would leave a caller with nothing to test. The reason is kept as `cause`, so nothing is lost and the type stays worth narrowing on.",
    ],
    dedent`
      export class ${n.aborted} extends Error {
        override readonly name = "${n.aborted}";

        constructor(cause: unknown) {
          super("Waiting for a permit was abandoned before one became available.", { cause });
        }
      }
    `,
  );
}

function waiterType(shape: Shape): string {
  return documented(
    [
      "One queued caller.",
      "`grant` and `refuse` are the halves of its promise, held so that a release can settle it from outside. That is the whole mechanism: the queue is a list of promises somebody else will resolve.",
    ],
    dedent`
      interface Waiter {
      ${when(shape.weighted, "  readonly weight: number;\n")}  readonly grant: (release: ${shape.names.release}) => void;
      ${when(shape.cancellable, "  readonly refuse: (error: unknown) => void;\n  /** Detaches the abort listener, so a granted waiter leaves nothing behind. */\n  readonly detach: () => void;\n")}}
    `,
  );
}

function semaphoreClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A limit on how many operations run at once.",
      "The queue is FIFO and is served from the head, which is not a preference. Serving the tail, or letting a new arrival take a free permit while somebody is queued, both starve a waiter for as long as work keeps arriving — and neither shows up as an error, only as one caller that never returns.",
    ],
    // Assembled with `sections`, which is the only join that keeps a blank line between the
    // members. `joinLines` drops blank parts along with everything else blank, and Prettier will
    // not put them back — it preserves blank lines rather than inserting them — so a class built
    // the other way ships as a wall of methods.
    [
      `export class ${n.semaphore} {`,
      "  readonly #capacity: number;",
      "  #available: number;",
      "  readonly #queue: Waiter[] = [];",
      "",
      sections(
        indent(constructorMethod(), 2),
        indent(snapshotMethod(shape), 2),
        indent(acquireMethod(shape), 2),
        indent(runMethod(shape), 2),
        indent(releaserMethod(shape), 2),
        indent(dispatchMethod(shape), 2),
      ),
      "}",
    ].join("\n"),
  );
}

/** Indents every line by `width`, leaving blank lines blank. */
function indent(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

function constructorMethod(): string {
  return documented(
    [
      "How many permits exist. Fixed for the life of the instance.",
      "Validated rather than trusted, because the value usually comes from configuration and the failure modes are both silent: zero admits nothing and looks like a hang, while a fraction makes every comparison against it behave in a way nobody predicted.",
    ],
    dedent`
      constructor(permits: number) {
        if (!Number.isInteger(permits) || permits < 1) {
          throw new RangeError(\`permits must be a positive integer, received \${String(permits)}\`);
        }

        this.#capacity = permits;
        this.#available = permits;
      }
    `,
  );
}

function snapshotMethod(shape: Shape): string {
  const n = shape.names;

  return documented(
    ["What the limiter looks like right now."],
    dedent`
      snapshot(): ${n.snapshot} {
        return {
          capacity: this.#capacity,
          available: this.#available,
          inFlight: this.#capacity - this.#available,
          waiting: this.#queue.length,
        };
      }
    `,
  );
}

function acquireMethod(shape: Shape): string {
  const n = shape.names;

  const weightChecks = when(
    shape.weighted,
    dedent`
      if (!Number.isInteger(weight) || weight < 1) {
        return Promise.reject(
          new RangeError(\`weight must be a positive integer, received \${String(weight)}\`),
        );
      }

      if (weight > this.#capacity) {
        return Promise.reject(
          new RangeError(
            \`weight \${String(weight)} exceeds the capacity of \${String(this.#capacity)}, so no release can ever grant it\`,
          ),
        );
      }

    `,
  );

  const alreadyAborted = when(
    shape.cancellable,
    dedent`
      if (signal?.aborted === true) {
        return Promise.reject(new ${n.aborted}(signal.reason));
      }

    `,
  );

  const enqueue = shape.cancellable
    ? dedent`
        return new Promise<${n.release}>((resolve, reject) => {
          const onAbort = (): void => {
            const at = this.#queue.indexOf(waiter);

            // Absent means already granted: the permit is held by a caller who is about to see the
            // signal for themselves. Removing nothing and refusing nothing is correct here — the
            // second check inside \`run\` is what returns that permit.
            if (at === -1) return;

            this.#queue.splice(at, 1);
            reject(new ${n.aborted}(signal?.reason));
          };

          const waiter: Waiter = {
      ${when(shape.weighted, "      weight,\n")}      grant: resolve,
            refuse: reject,
            detach: () => {
              signal?.removeEventListener("abort", onAbort);
            },
          };

          signal?.addEventListener("abort", onAbort, { once: true });
          this.#queue.push(waiter);
        });
      `
    : dedent`
        return new Promise<${n.release}>((resolve) => {
          this.#queue.push({${when(shape.weighted, " weight,")} grant: resolve });
        });
      `;

  const fastPath = shape.weighted
    ? dedent`
        // The queue has to be empty as well as the capacity free. Taking a permit past a waiting
        // caller is barging, and under sustained arrival it starves them for good. Reachable only
        // with weights, where a blocked head leaves capacity idle on purpose — but stated the same
        // way regardless, because the invariant is the same one.
        if (this.#queue.length === 0 && this.#available >= weight) {
          this.#available -= weight;
          return Promise.resolve(this.#releaser(weight));
        }
      `
    : dedent`
        // The queue has to be empty as well as the capacity free. Taking a permit past a waiting
        // caller is barging, which starves them for as long as work keeps arriving. With every
        // waiter taking one permit the dispatch loop drains the queue completely, so this can only
        // be true when the queue really is empty — the check is what keeps that true if the limiter
        // ever gains weights.
        if (this.#queue.length === 0 && this.#available >= 1) {
          this.#available -= 1;
          return Promise.resolve(this.#releaser());
        }
      `;

  return documented(
    [
      "Waits for a permit, and hands back the means to return it.",
      "The caller owes exactly one call to what it resolves with, on every path out including the failing ones. Prefer `run`, which owes it for them.",
      ...(shape.weighted
        ? [
            "A weight above the capacity is refused rather than queued. Queueing it would be a wait that no release can ever satisfy, which presents as a process that has stopped rather than as an error, and takes a heap dump to find.",
          ]
        : []),
      ...(shape.cancellable
        ? [
            "A signal already aborted is refused without joining the queue, and one that fires while queued withdraws the waiter. What it cannot cover is the gap between a permit being granted — which happens synchronously, inside a release — and the waiting caller resuming a microtask later. `run` closes that gap; a caller using `acquire` directly should check the signal once more after it resolves.",
          ]
        : []),
    ],
    dedent`
      acquire(${acquireParams(shape)}): Promise<${n.release}> {
      ${indent(sections(weightChecks, alreadyAborted, fastPath, enqueue), 2)}
      }
    `,
  );
}

function runMethod(shape: Shape): string {
  const n = shape.names;
  const params = [
    "task: () => Promise<T> | T",
    ...(shape.weighted ? ["weight = 1"] : []),
    ...(shape.cancellable ? ["signal?: AbortSignal"] : []),
  ];

  return documented(
    [
      "Runs one task under a permit, and returns it however the task ended.",
      "The `finally` is the whole point of preferring this to `acquire`. A permit released after the work instead of regardless of it leaks on every thrown error, and each leak lowers the limit permanently until nothing is admitted at all — a shutdown that looks like a hang and dates from an exception nobody caught.",
      ...(shape.cancellable
        ? [
            "The second look at the signal covers the window described on `acquire`: a permit granted synchronously, an abort landing before the caller resumes. Without it the task runs for a caller who has already gone, which for anything that writes is worse than wasted work.",
          ]
        : []),
    ],
    dedent`
      async run<T>(${params.join(", ")}): Promise<T> {
        const release = await this.acquire(${acquireArgs(shape)});

        try {
      ${when(shape.cancellable, `    if (signal?.aborted === true) throw new ${n.aborted}(signal.reason);\n\n`)}    return await task();
        } finally {
          release();
        }
      }
    `,
  );
}

function releaserMethod(shape: Shape): string {
  const n = shape.names;
  const params = shape.weighted ? "weight: number" : "";
  const amount = shape.weighted ? "weight" : "1";

  return documented(
    [
      "One permit's return, spendable once.",
      "A closure rather than a method taking the amount back, because that signature would let a caller return permits they never took. The count it restores is fixed when it is created, and the flag makes a repeat call a no-op.",
    ],
    dedent`
      #releaser(${params}): ${n.release} {
        let spent = false;

        return () => {
          if (spent) return;
          spent = true;

          this.#available += ${amount};
          this.#dispatch();
        };
      }
    `,
  );
}

function dispatchMethod(shape: Shape): string {
  const grant = shape.weighted
    ? dedent`
        // Head-of-line, deliberately. A waiter behind the head that would fit is *not* served: doing
        // so starves a heavy waiter for as long as lighter work keeps arriving, so capacity is left
        // idle until the head can be granted. Observable only when some capacity is free and the
        // head needs more than that.
        if (this.#available < head.weight) return;

        this.#queue.shift();
      ${when(shape.cancellable, "  head.detach();\n")}  this.#available -= head.weight;
        head.grant(this.#releaser(head.weight));
      `
    : dedent`
        if (this.#available < 1) return;

        this.#queue.shift();
      ${when(shape.cancellable, "  head.detach();\n")}  this.#available -= 1;
        head.grant(this.#releaser());
      `;

  return documented(
    [
      "Hands the free capacity to the front of the queue.",
      "Runs synchronously inside a release, which is what makes the bookkeeping safe: the count is lowered in the same turn as the grant, so there is no window in which two callers can both see the same permit as free.",
      ...(shape.cancellable
        ? [
            "No check here for a waiter whose signal has fired. An abort listener runs synchronously and removes its waiter from the queue, so a cancelled waiter cannot still be in it by the time this looks — a check would be unreachable, and unreachable code that appears to handle something is worse than none.",
          ]
        : []),
    ],
    dedent`
      #dispatch(): void {
        while (this.#queue.length > 0) {
          const head = this.#queue[0];
          if (head === undefined) return;

      ${indent(grant, 4)}
        }
      }
    `,
  );
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const uploadCall = shape.weighted
    ? `limit.run(async () => await send(file), file.bytes${when(shape.cancellable, ", signal")})`
    : `limit.run(async () => await send(file)${when(shape.cancellable, ", signal")})`;

  return sections(
    dedent`
      /**
       * Holding a burst of work to a fixed width.
       *
       * The case the limiter is for: a list arrives all at once, every item starts an asynchronous call,
       * and issuing them together is what exhausts the connection pool or earns a rate-limit response.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.semaphore],
    }),
    dedent`
      interface Upload {
        readonly path: string;
      ${when(shape.weighted, "  /** What it costs against the budget, which here is bytes in flight. */\n  readonly bytes: number;\n")}}
    `,
    documented(
      [
        shape.weighted
          ? "Uploading a batch without holding more than a fixed number of bytes in flight."
          : "Uploading a batch without holding more than a fixed number of calls in flight.",
        "Every task is started at once and the limiter decides when each proceeds, which is the arrangement worth copying. Chunking the list into batches and awaiting each batch is the usual alternative, and it is slower for a reason that is easy to miss: a batch takes as long as its slowest member, and nothing starts while the stragglers finish.",
        ...(shape.weighted
          ? [
              "A file larger than the whole budget is refused where it is submitted rather than queued forever, so this reports it alongside the ordinary failures instead of stalling the batch.",
            ]
          : []),
      ],
      dedent`
        export async function uploadAll(
          files: readonly Upload[],
          send: (file: Upload) => Promise<string>,
          concurrency: number,
        ${when(shape.cancellable, "  signal?: AbortSignal,\n")}): Promise<readonly PromiseSettledResult<string>[]> {
          const limit = new ${n.semaphore}(concurrency);

          return await Promise.allSettled(
            files.map(async (file) => await ${uploadCall}),
          );
        }
      `,
    ),
    documented(
      [
        "What the limiter is doing, for whatever reports on it.",
        "`waiting` is the number worth watching. Work queueing faster than it drains means the limit is now the bottleneck, and it is the difference between a system that is busy and one that is falling behind.",
      ],
      dedent`
        export function describeLoad(limit: ${n.semaphore}): string {
          const { inFlight, capacity, waiting } = limit.snapshot();
          return \`\${String(inFlight)}/\${String(capacity)} running, \${String(waiting)} queued\`;
        }
      `,
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
          {
            values: ["describe", "expect", "it"],
          },
        );

  return sections(
    dedent`
      /**
       * What is asserted here, and why it is written this way.
       *
       * No timers. Each case holds the permits it wants held and settles the promises it wants settled,
       * so the order of events is decided by the test rather than by a scheduler — a limiter tested with
       * \`setTimeout\` passes on a quiet machine and fails on a loaded one.
       *
       * Assertions are on \`snapshot()\`, not on awaited promises, and that is more than a style. Every
       * bookkeeping defect here strands a promise: a leaked permit means a caller who is never granted
       * one, so a suite built around \`await\` reports the bug as a timeout minutes later with nothing to
       * point at. Asserting the counters names the broken invariant immediately. Where a promise is
       * awaited, it is only after something has established that it will arrive.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.semaphore, ...(shape.cancellable ? [n.aborted] : [])],
    }),
    helpers(),
    limitCases(shape),
    orderCases(shape),
    bookkeepingCases(shape),
    when(shape.cancellable, cancellationCases(shape)),
    when(shape.weighted, weightCases(n)),
  );
}

function helpers(): string {
  return sections(
    documented(
      [
        "A promise this file settles itself.",
        "The whole timing mechanism. A task that waits on one of these occupies its permit until the case decides otherwise, which is what makes every sequence below exact rather than probable.",
      ],
      dedent`
        function deferred(): { readonly promise: Promise<void>; readonly settle: () => void } {
          let settle!: () => void;
          const promise = new Promise<void>((resolve) => {
            settle = resolve;
          });
          return { promise, settle };
        }
      `,
    ),
    documented(
      [
        "Lets every microtask already scheduled run.",
        "A fixed number of turns rather than a timer, because everything here resolves through the microtask queue: granting a permit, resuming a waiter, and the `finally` that returns it are each one turn, and a few of them is more than any single hand-off needs.",
      ],
      dedent`
        async function drain(): Promise<void> {
          for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        }
      `,
    ),
  );
}

function limitCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.semaphore}", () => {
      it("runs no more than the capacity at once", async () => {
        const limit = new ${n.semaphore}(2);
        const gates = [deferred(), deferred(), deferred()];
        let running = 0;
        let peak = 0;
        let finished = 0;

        for (const gate of gates) {
          void limit
            .run(async () => {
              running += 1;
              peak = Math.max(peak, running);
              await gate.promise;
              running -= 1;
            })
            .then(() => {
              finished += 1;
            });
        }

        await drain();
        expect(peak).toBe(2);
        expect(limit.snapshot()).toEqual({ capacity: 2, available: 0, inFlight: 2, waiting: 1 });

        for (const gate of gates) {
          gate.settle();
          await drain();
        }

        // Counted rather than awaited: a leaked permit would leave one of these promises unsettled
        // for good, and \`Promise.all\` would report that as a timeout instead of as a number.
        expect(finished).toBe(3);
        expect(limit.snapshot()).toEqual({ capacity: 2, available: 2, inFlight: 0, waiting: 0 });
        expect(peak).toBe(2);
      });

      it("refuses a capacity that admits nothing", () => {
        expect(() => new ${n.semaphore}(0)).toThrow(/positive integer/);
        expect(() => new ${n.semaphore}(1.5)).toThrow(/positive integer/);
      });

      it("grants immediately while capacity is free", async () => {
        const limit = new ${n.semaphore}(1);
        const release = await limit.${plainAcquire(shape)};

        expect(limit.snapshot().inFlight).toBe(1);
        release();
        expect(limit.snapshot().inFlight).toBe(0);
      });
    });
  `;
}

function orderCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.semaphore} ordering", () => {
      it("serves waiters in the order they arrived", async () => {
        const limit = new ${n.semaphore}(1);
        const hold = await limit.${plainAcquire(shape)};
        const served: string[] = [];

        for (const name of ["a", "b", "c", "d"]) {
          void limit.run(() => {
            served.push(name);
          });
        }

        await drain();
        expect(limit.snapshot().waiting).toBe(4);

        hold();
        await drain();

        // Served from the head. A queue drained from its tail passes every other case in this file
        // and starves its oldest waiter for as long as work keeps arriving.
        expect(served).toEqual(["a", "b", "c", "d"]);
      });
    });
  `;
}

function bookkeepingCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.semaphore} permits", () => {
      it("returns the permit when the task throws", async () => {
        const limit = new ${n.semaphore}(1);

        const boom = new Error("boom");

        // Identity, not a message match: what matters is that the task's own error arrives at the
        // caller unwrapped, and a semaphore that replaced it with one of its own would pass a
        // message assertion written the obvious way.
        await expect(
          limit.run(() => {
            throw boom;
          }),
        ).rejects.toBe(boom);

        expect(limit.snapshot()).toEqual({ capacity: 1, available: 1, inFlight: 0, waiting: 0 });
      });

      it("ignores a repeated release", async () => {
        // A fresh instance at full capacity, so this acquire takes the synchronous path and cannot
        // be stranded by a defect somewhere else in the file.
        const limit = new ${n.semaphore}(1);
        const release = await limit.${plainAcquire(shape)};

        release();
        release();
        release();

        // Over-admission is the failure worth pinning: a count above the capacity means the limit
        // has silently stopped being one, and nothing about the instance looks wrong.
        expect(limit.snapshot()).toEqual({ capacity: 1, available: 1, inFlight: 0, waiting: 0 });
      });
    });
  `;
}

function cancellationCases(shape: Shape): string {
  const n = shape.names;
  const cancellable = (signal: string): string =>
    shape.weighted ? `acquire(1, ${signal})` : `acquire(${signal})`;

  return dedent`
    describe("${n.semaphore} cancellation", () => {
      it("refuses a signal that has already fired", async () => {
        const limit = new ${n.semaphore}(1);
        const controller = new AbortController();
        controller.abort(new Error("gone"));

        await expect(limit.${cancellable("controller.signal")}).rejects.toBeInstanceOf(${n.aborted});
        expect(limit.snapshot().waiting).toBe(0);
      });

      it("withdraws a waiter whose signal fires", async () => {
        const limit = new ${n.semaphore}(1);
        const hold = await limit.${plainAcquire(shape)};
        const controller = new AbortController();

        const abandoned = limit.${cancellable("controller.signal")};
        void limit.${plainAcquire(shape)};
        await drain();
        expect(limit.snapshot().waiting).toBe(2);

        controller.abort(new Error("gone"));
        await expect(abandoned).rejects.toBeInstanceOf(${n.aborted});

        // Asserted before anything is awaited. A waiter left in the queue would be handed the
        // permit that the release below frees, and that permit would never come back — which the
        // next expectation would report as a timeout rather than as a queue one waiter too long.
        expect(limit.snapshot().waiting).toBe(1);

        hold();
        await drain();
        expect(limit.snapshot().inFlight).toBe(1);
      });

      it("does not lose a permit to a waiter that left", async () => {
        const limit = new ${n.semaphore}(1);
        const hold = await limit.${plainAcquire(shape)};
        const controller = new AbortController();

        const abandoned = limit.${cancellable("controller.signal")};
        await drain();

        controller.abort(new Error("gone"));
        hold();
        await abandoned.catch(() => undefined);
        await drain();

        expect(limit.snapshot()).toEqual({ capacity: 1, available: 1, inFlight: 0, waiting: 0 });
      });

      it("does not start work for a caller who has already gone", async () => {
        // The window \`acquire\` cannot close: the permit is granted synchronously inside \`hold()\`,
        // and the abort lands before the waiting caller resumes a microtask later.
        const limit = new ${n.semaphore}(1);
        const controller = new AbortController();
        const hold = await limit.${plainAcquire(shape)};
        let started = false;

        const pending = limit.run(
          () => {
            started = true;
          },
      ${when(shape.weighted, "      1,\n")}      controller.signal,
        );

        await drain();
        hold();
        controller.abort(new Error("gone"));

        await expect(pending).rejects.toBeInstanceOf(${n.aborted});
        expect(started).toBe(false);
        expect(limit.snapshot()).toEqual({ capacity: 1, available: 1, inFlight: 0, waiting: 0 });
      });
    });
  `;
}

function weightCases(n: Names): string {
  return dedent`
    describe("${n.semaphore} weights", () => {
      it("refuses a weight no release could satisfy", async () => {
        const limit = new ${n.semaphore}(2);

        await expect(limit.acquire(5)).rejects.toBeInstanceOf(RangeError);
        await expect(limit.acquire(0)).rejects.toBeInstanceOf(RangeError);
        expect(limit.snapshot()).toEqual({ capacity: 2, available: 2, inFlight: 0, waiting: 0 });
      });

      it("does not serve a lighter waiter past a blocked head", async () => {
        // Two holders, so that releasing one leaves capacity free but less than the head needs.
        // With a single holder the release frees everything and the head fits regardless of the
        // rule, which is why the obvious version of this case proves nothing.
        const limit = new ${n.semaphore}(3);
        const first = await limit.acquire(1);
        const second = await limit.acquire(1);
        const served: string[] = [];

        const heavy = limit.acquire(3).then((release) => {
          served.push("heavy");
          return release;
        });
        void limit.acquire(1).then((release) => {
          served.push("light");
          release();
        });

        await drain();
        expect(served).toEqual([]);

        first();
        await drain();

        // Two free, the head needs three, and the waiter behind it needs one. Serving it here is
        // what starves the heavy waiter whenever light work keeps arriving, so the capacity is left
        // idle on purpose.
        expect(served).toEqual([]);
        expect(limit.snapshot()).toEqual({ capacity: 3, available: 2, inFlight: 1, waiting: 2 });

        second();
        const release = await heavy;
        expect(served).toEqual(["heavy"]);

        release();
        await drain();
        expect(served).toEqual(["heavy", "light"]);
        expect(limit.snapshot().available).toBe(3);
      });

      it("counts a weighted permit back exactly once", async () => {
        const limit = new ${n.semaphore}(4);
        const release = await limit.acquire(3);

        expect(limit.snapshot().available).toBe(1);
        release();
        release();
        expect(limit.snapshot().available).toBe(4);
      });
    });
  `;
}
