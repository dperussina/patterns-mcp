/**
 * The `async-queue` pattern: work handed over, run a few at a time.
 *
 * This overlaps `semaphore` on purpose, and the overlap is the interesting part. A semaphore gates work
 * the caller has already created and started; a queue is handed the work instead. Everything here that a
 * semaphore cannot express follows from that one difference — a backlog can only be bounded by whoever
 * holds it, a drain signal can only be given by whoever knows what is outstanding, and work can only be
 * reordered before it starts.
 *
 * Three defects were found by writing them and watching a test fail, and each shaped the code:
 *
 * Equal priorities lose their arrival order. Inserting by priority alone leaves ties at the mercy of
 * whatever the insertion does with equal elements, so an explicit sequence number is the second key. It
 * would work today without one — `Array.prototype.sort` has been required to be stable since ES2019 —
 * but the queue would then depend on a property of the sort that nothing in it states, and a later
 * rewrite to a heap would break arrival order silently.
 *
 * The space signal fires while the backlog is still full. Reachable exactly once: a completion starts a
 * task, that task synchronously submits another, and the slot just freed is taken again before the check
 * runs. Every other route has already freed a slot by the time it looks, which is why the guard appears
 * unnecessary and is not.
 *
 * A discarded failure terminates the process. Not a defect in the queue — it is what Node does with any
 * unhandled rejection — but it is a defect in a queue used as a background worker, where discarding the
 * returned promise is the natural spelling. That is the whole reason `failures` exists as an option
 * rather than a paragraph of documentation.
 *
 * One claim was withdrawn rather than shipped. Announcing idle before starting queued work and after it
 * are provably the same: if the queue was empty and nothing was running on entry, nothing starts, so both
 * checks see identical state. A comment explaining the ordering as significant would have been wrong, and
 * the real reason the check lives in the pump is duller — it is the one place every counter change
 * already passes through.
 *
 * The emitted suite uses no timers, and asserts on `snapshot()` rather than on awaited promises: every
 * bookkeeping defect here strands a promise, so a suite built around `await` reports the bug as a timeout
 * with nothing to point at. Where timing matters it records the state at the moment a signal arrives
 * instead of counting microtask turns — a turn count that is short by one reads as a pass.
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

export const asyncQueuePattern: PatternModule = {
  name: "async-queue",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      prioritised: options.ordering === "priority",
      bounded: options.bounded === true,
      sink: options.failures === "sink",
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
  readonly prioritised: boolean;
  readonly bounded: boolean;
  readonly sink: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The class: `OrderQueue`. */
  readonly queue: string;
  /** The observable counters: `OrderQueueSnapshot`. */
  readonly snapshot: string;
  /** The refusal, under `bounded`. */
  readonly full: string;
  /** The internal queue entry. */
  readonly entry: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;

  return {
    stem: entity === undefined ? "async-queue" : `${entity.kebab}-queue`,
    queue: `${prefix}Queue`,
    snapshot: `${prefix}QueueSnapshot`,
    full: `${prefix}QueueFullError`,
    entry: `${prefix}QueueEntry`,
  };
}

/** The `run` parameter list, and the arguments a caller forwards. */
function runParams(shape: Shape): string {
  return [
    "task: () => Promise<T> | T",
    ...(shape.prioritised ? ["priority = 0"] : []),
  ].join(", ");
}

function core(shape: Shape): string {
  return sections(
    when(shape.bounded, fullError(shape)),
    snapshotType(shape),
    entryType(shape),
    queueClass(shape),
  );
}

function fullError(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Work refused because the backlog is at its limit.",
      "Carries the limit rather than only reporting that one was hit, because the number is what a caller adjusts and what makes the log entry worth keeping.",
    ],
    dedent`
      export class ${n.full} extends Error {
        override readonly name = "${n.full}";

        constructor(readonly limit: number) {
          super(\`The queue already holds its limit of \${String(limit)} waiting tasks.\`);
        }
      }
    `,
  );
}

function snapshotType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The counters, read together.",
      "One value rather than several getters, so that what is logged or asserted is a coherent picture of one instant. Reading them separately invites a report in which the numbers do not add up because something moved in between.",
      "`idle` is derived rather than tracked. A second source of truth for the same fact is a second thing that can be wrong, and this one is the fact `onIdle` resolves on.",
    ],
    dedent`
      export interface ${n.snapshot} {
        /** How many run at once. Fixed for the life of the instance. */
        readonly concurrency: number;
        readonly running: number;
        /** Submitted and not yet started. */
        readonly pending: number;
      ${when(shape.bounded, "  /** The backlog limit, which `pending` is held below. */\n  readonly limit: number;\n")}  readonly idle: boolean;
      }
    `,
  );
}

function entryType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "One submission waiting to start.",
      ...(shape.prioritised
        ? [
            "`sequence` is the tie-break, and it is the reason equal priorities keep their arrival order. Ordering on priority alone would leave ties to whatever the insertion happens to do with equal elements — which today would be the right thing, since sorting has been required to be stable since ES2019, but a queue resting on a property it never states is one rewrite away from reordering work silently.",
          ]
        : []),
      "`start` is a closure rather than the task itself, because it carries the halves of the caller's promise with it. That is the whole mechanism: the backlog is a list of things that will settle a promise somebody else is holding.",
    ],
    dedent`
      interface ${n.entry} {
      ${when(shape.prioritised, "  readonly priority: number;\n  /** Submission order, ascending. Breaks ties within a priority. */\n  readonly sequence: number;\n")}  readonly start: () => void;
      }
    `,
  );
}

function queueClass(shape: Shape): string {
  const n = shape.names;

  const fields = [
    "  readonly #concurrency: number;",
    ...(shape.bounded ? ["  readonly #limit: number;"] : []),
    ...(shape.sink ? ["  readonly #onError: (error: unknown) => void;"] : []),
    `  readonly #backlog: ${n.entry}[] = [];`,
    "  #running = 0;",
    ...(shape.prioritised ? ["  #sequence = 0;"] : []),
    "  #idleWaiters: (() => void)[] = [];",
    ...(shape.bounded ? ["  #spaceWaiters: (() => void)[] = [];"] : []),
  ];

  return documented(
    [
      "Work submitted to be run a few at a time.",
      "Distinct from a semaphore in one respect that decides everything else: the queue holds the work rather than gating work the caller has already started. That is what makes a bounded backlog, a drain signal and ordering expressible here and not there.",
    ],
    // Assembled with `sections`, which is the only join that keeps a blank line between the
    // members. `joinLines` drops blank parts along with everything else blank, and Prettier will
    // not put them back — it preserves blank lines rather than inserting them — so a class built
    // the other way ships as a wall of methods.
    [
      `export class ${n.queue} {`,
      ...fields,
      "",
      sections(
        indent(constructorMethod(shape), 2),
        indent(snapshotMethod(shape), 2),
        indent(runMethod(shape), 2),
        indent(onIdleMethod(), 2),
        when(shape.bounded, indent(whenSpaceMethod(), 2)),
        indent(admitMethod(shape), 2),
        indent(pumpMethod(shape), 2),
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

function constructorMethod(shape: Shape): string {
  const params = [
    "concurrency: number",
    ...(shape.sink ? ["onError: (error: unknown) => void"] : []),
    ...(shape.bounded ? ["limit: number"] : []),
  ];

  // Assembled with `sections` rather than embedded in one template. A blank line at the end of a
  // `dedent` is trimmed, so a body built by concatenation arrives with its paragraph breaks gone —
  // and Prettier preserves blank lines rather than inserting them, so what is emitted is what ships.
  const body = sections(
    dedent`
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(
          \`concurrency must be a positive integer, received \${String(concurrency)}\`,
        );
      }
    `,
    when(
      shape.bounded,
      dedent`
        // A limit of zero would be a queue that refuses everything it cannot start immediately, and
        // whose \`whenSpace\` could never resolve — surface that exists and cannot work.
        if (!Number.isInteger(limit) || limit < 1) {
          throw new RangeError(\`limit must be a positive integer, received \${String(limit)}\`);
        }
      `,
    ),
    joinLines(
      "this.#concurrency = concurrency;",
      when(shape.bounded, "this.#limit = limit;"),
      when(shape.sink, "this.#onError = onError;"),
    ),
  );

  return documented(
    [
      "How many tasks run at once, and how much may wait.",
      "Validated rather than trusted, because these usually come from configuration and both failures are silent: a concurrency of zero starts nothing and presents as a hang, while a fraction makes every comparison against it behave in a way nobody predicted.",
      ...(shape.sink
        ? [
            "The handler is required, not optional. It is the only place a discarded failure can be seen, and a queue that accepted work while having nowhere to report its errors would lose them.",
          ]
        : []),
    ],
    dedent`
      constructor(${params.join(", ")}) {
      ${indent(body, 2)}
      }
    `,
  );
}

function snapshotMethod(shape: Shape): string {
  const n = shape.names;

  return documented(
    ["What the queue looks like right now."],
    dedent`
      snapshot(): ${n.snapshot} {
        return {
          concurrency: this.#concurrency,
          running: this.#running,
          pending: this.#backlog.length,
      ${when(shape.bounded, "      limit: this.#limit,\n")}      idle: this.#running === 0 && this.#backlog.length === 0,
        };
      }
    `,
  );
}

function runMethod(shape: Shape): string {
  const n = shape.names;

  const refusal = when(
    shape.bounded,
    dedent`
      // Thrown, not returned as a rejected promise, which is a deliberate exception to the rule
      // that a promise-returning function should not throw. Two reasons. It is decided about the
      // submission before any asynchronous work exists, so it belongs to the call rather than to
      // the result. And a rejected promise here would be lethal to exactly the code most likely
      // to meet it: fire-and-forget submission, where discarding the promise is the point and an
      // unhandled rejection ends the process. Overload is an expected outcome and must not be.
      if (this.#backlog.length >= this.#limit) {
        throw new ${n.full}(this.#limit);
      }
    `,
  );

  const entryFields = when(
    shape.prioritised,
    "      priority,\n        sequence: this.#sequence++,\n",
  );

  const sink = when(
    shape.sink,
    dedent`
      // Both halves of the sink contract, in two lines: every failure is reported exactly once
      // here, and attaching this handler is what marks \`settled\` as handled — which is why
      // discarding it does not take the process down.
      settled.catch((error: unknown) => {
        this.#onError(error);
      });
    `,
  );

  const body = dedent`
    const settled = new Promise<T>((resolve, reject) => {
      const entry: ${n.entry} = {
    ${entryFields}    start: () => {
          this.#running += 1;

          // The caller's promise and the bookkeeping are settled from the same place, so the
          // task's own promise is always handled and the queue never manufactures an unhandled
          // rejection of its own.
          void (async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            } finally {
              this.#running -= 1;
              this.#pump();
            }
          })();
        },
      };

      this.#admit(entry);
      this.#pump();
    });
  `;

  return documented(
    [
      "Submits one task, and returns it however it ends.",
      "The task is not called here. It is called when a worker is free, which is what separates this from running everything at once and limiting it afterwards: nothing the task holds is allocated until it starts, so a backlog of a million submissions costs a million closures rather than a million open connections.",
      ...(shape.prioritised
        ? [
            "Higher priorities start first, and equal priorities start in submission order. Note the cost of ordering strictly: low-priority work waits for as long as higher-priority work keeps arriving, which under sustained load is forever.",
          ]
        : []),
      ...(shape.bounded
        ? [
            "Throws once the backlog is at its limit, so overload is handled at the point of submission rather than becoming a heap that grows until the process is killed. Synchronously, unlike a task's own failure, which is the distinction worth keeping: a `try` around the submission handles being overloaded, while the returned promise carries what the work did. A producer that would rather wait than shed should await `whenSpace` first.",
          ]
        : []),
      ...(shape.sink
        ? [
            "Failures reach the handler given at construction as well as this promise, so discarding it is safe. A caller who awaits it sees the error too — the handler observes every failure, it does not intercept them.",
          ]
        : [
            "The returned promise is the only place a failure appears, which has a consequence worth being deliberate about: on Node a rejection nobody handles terminates the process, so submitting work fire-and-forget means one failing task ends the process. Await it, collect it with `Promise.allSettled`, or attach a handler.",
          ]),
    ],
    dedent`
      run<T>(${runParams(shape)}): Promise<T> {
      ${indent(sections(refusal, body, sink, "return settled;"), 2)}
      }
    `,
  );
}

function onIdleMethod(): string {
  return documented(
    [
      "Resolves when nothing is running and nothing is waiting.",
      "Never rejects, whatever the tasks did. A drain signal that failed with the first failing task would make \"wait for the work to finish\" and \"check the work succeeded\" the same call, and a caller wanting the first would have to swallow the second.",
      "It answers about the work submitted so far. A task that submits more after awaiting something has, for that moment, left the queue genuinely empty, and no queue can wait for work it has not been told about.",
    ],
    dedent`
      onIdle(): Promise<void> {
        if (this.#running === 0 && this.#backlog.length === 0) return Promise.resolve();

        return new Promise<void>((resolve) => {
          this.#idleWaiters.push(resolve);
        });
      }
    `,
  );
}

function whenSpaceMethod(): string {
  return documented(
    [
      "Resolves once the backlog is below its limit.",
      "For a producer that would rather slow down than shed — reading a file, draining a stream — where refusing work means losing it. With several producers, submitting and handling the refusal is the composable choice: this reports that there was room, not that the caller has claimed it.",
    ],
    dedent`
      whenSpace(): Promise<void> {
        if (this.#backlog.length < this.#limit) return Promise.resolve();

        return new Promise<void>((resolve) => {
          this.#spaceWaiters.push(resolve);
        });
      }
    `,
  );
}

function admitMethod(shape: Shape): string {
  const n = shape.names;

  if (!shape.prioritised) {
    return documented(
      ["Adds one submission to the back of the backlog."],
      dedent`
        #admit(entry: ${n.entry}): void {
          this.#backlog.push(entry);
        }
      `,
    );
  }

  return documented(
    [
      "Inserts one submission at its place in the order.",
      "Ordered by priority descending, then by sequence ascending. A binary search rather than a sort per submission, which makes admission logarithmic instead of linearithmic — worth having because the backlog is exactly the thing that gets long.",
      "The sequence comparison is what keeps equal priorities in arrival order, and it is written out rather than left to the insertion's treatment of equal elements. See the note on the entry type for why that matters more than it appears to.",
    ],
    dedent`
      #admit(entry: ${n.entry}): void {
        let low = 0;
        let high = this.#backlog.length;

        while (low < high) {
          const middle = (low + high) >>> 1;
          const at = this.#backlog[middle];
          if (at === undefined) break;

          const ahead =
            at.priority > entry.priority ||
            (at.priority === entry.priority && at.sequence < entry.sequence);

          if (ahead) low = middle + 1;
          else high = middle;
        }

        this.#backlog.splice(low, 0, entry);
      }
    `,
  );
}

function pumpMethod(shape: Shape): string {
  const space = when(
    shape.bounded,
    dedent`

      // The guard looks unnecessary and is not. It is reachable in exactly one way: a completion
      // starts a task, that task synchronously submits another, and the slot just freed is taken
      // again before this runs. Every other route here has already freed one.
      if (this.#backlog.length < this.#limit) {
        const waiting = this.#spaceWaiters;
        this.#spaceWaiters = [];
        for (const resolve of waiting) resolve();
      }
    `,
  );

  return documented(
    [
      "Starts whatever the free workers can take, then announces what that changed.",
      "Called after every change to either counter, and the only place the two signals are resolved from. Announcing them where the counters change instead would mean four places that each have to remember to, which is three more than can be checked by reading one method.",
    ],
    dedent`
      #pump(): void {
        while (this.#running < this.#concurrency && this.#backlog.length > 0) {
          const next = this.#backlog.shift();
          if (next === undefined) break;

          next.start();
        }
      ${indent(space, 2)}
        if (this.#running === 0 && this.#backlog.length === 0) {
          const waiting = this.#idleWaiters;
          this.#idleWaiters = [];
          for (const resolve of waiting) resolve();
        }
      }
    `,
  );
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const construction = [
    "concurrency",
    ...(shape.sink ? ["report"] : []),
    ...(shape.bounded ? ["backlog"] : []),
  ].join(", ");

  const signature = joinLines(
    "export async function indexAll(",
    "  files: AsyncIterable<string>,",
    "  index: (path: string) => Promise<void>,",
    "  concurrency: number,",
    when(shape.bounded, "  backlog: number,"),
    when(shape.sink, "  report: (error: unknown) => void,"),
    "): Promise<void> {",
  );

  const body = shape.bounded
    ? dedent`
        // Waiting rather than shedding, because the file has already been read and dropping it
        // here would lose it. The refusal is still handled: between the wait and the submission
        // another producer may have taken the slot.
        await queue.whenSpace();

        try {
      ${indent(submission(shape), 4)}
        } catch (error) {
          if (!(error instanceof ${n.full})) throw error;
          skipped += 1;
        }
      `
    : submission(shape);

  return sections(
    dedent`
      /**
       * Indexing a stream of files without reading them all into memory first.
       *
       * The case a queue is for and a semaphore is not: the work arrives over time rather than as a list,
       * so there is nothing to \`map\` over, and the producer is faster than the workers.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.queue, ...(shape.bounded ? [n.full] : [])],
    }),
    documented(
      [
        "Indexes every file, a few at a time, and returns once the last has finished.",
        ...(shape.bounded
          ? [
              "The backlog is what makes this safe on a stream that never ends. Unbounded, the loop reads faster than the workers index and the queue becomes the buffer — a heap that grows until the process is killed, with nothing to say which queue did it.",
            ]
          : [
              "Note what this does not bound: the loop submits as fast as it can read, so on a large stream the backlog is the memory ceiling. A bounded rendering of this pattern is the answer where the producer is faster than the workers.",
            ]),
        ...(shape.sink
          ? [
              "Nothing awaits an individual submission, which is only safe because failures have somewhere to go. Under the promise rendering the same loop would end the process on the first failing file.",
            ]
          : [
              "Each submission is awaited for its failure alone, not for its completion — dropping the promise instead would end the process on the first failing file, and awaiting it in the loop would run one file at a time and make the queue pointless.",
            ]),
        "`onIdle` is the wait, rather than keeping the promises and awaiting them together: the list of outstanding work is what the queue is already for.",
      ],
      dedent`
        ${signature}
          const queue = new ${n.queue}(${construction});
        ${when(shape.bounded, "  let skipped = 0;\n")}
          for await (const path of files) {
        ${indent(body, 4)}
          }

          await queue.onIdle();
        ${when(shape.bounded, '  if (skipped > 0) console.warn(`${String(skipped)} files skipped under load`);\n')}}
      `,
    ),
    documented(
      [
        "What the queue is doing, for whatever reports on it.",
        "`pending` is the number worth watching. Work arriving faster than it drains means the concurrency is now the bottleneck, and it is the difference between a system that is busy and one that is falling behind.",
      ],
      dedent`
        export function describeLoad(queue: ${n.queue}): string {
          const { running, concurrency, pending } = queue.snapshot();
          return \`\${String(running)}/\${String(concurrency)} indexing, \${String(pending)} waiting\`;
        }
      `,
    ),
  );
}

/** The example's submission, which differs only in what happens to a failure. */
function submission(shape: Shape): string {
  const call = shape.prioritised
    ? "queue.run(async () => await index(path), path.endsWith(\".md\") ? 1 : 0)"
    : "queue.run(async () => await index(path))";

  return shape.sink
    ? `void ${call};`
    : dedent`
        void ${call}.catch((error: unknown) => {
          console.error(\`indexing \${path} failed\`, error);
        });
      `;
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
       * No timers. Each case settles the promises it wants settled, so the order of events is decided
       * here rather than by a scheduler — a queue tested with \`setTimeout\` passes on a quiet machine and
       * fails on a loaded one.
       *
       * Assertions are on \`snapshot()\` and on counters, not on awaited promises. Every bookkeeping defect
       * here strands a promise, so a suite built around \`await\` reports the bug as a timeout minutes
       * later with nothing to point at. Where a promise is awaited it is only after something else has
       * established that it will arrive.
       *
       * Where timing is the subject, what is recorded is the state at the moment a signal arrived rather
       * than the state after a fixed number of microtask turns. A turn count that is one short reads as a
       * pass, which is how the ${shape.bounded ? "space" : "idle"} case was wrong the first time it was written.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.queue, ...(shape.bounded ? [n.full] : [])],
    }),
    helpers(shape),
    concurrencyCases(shape),
    orderingCases(shape),
    failureCases(shape),
    idleCases(shape),
    when(shape.bounded, boundedCases(shape)),
  );
}

/**
 * A backlog limit large enough that no case which is not about the limit can reach it.
 *
 * It was four, which the priority case exceeded by one: its last submission was refused, dropped
 * silently, and the case failed reporting a missing task rather than a full queue. Named here so
 * that the number and the snapshot asserting it cannot drift apart.
 */
const ROOMY_LIMIT = 8;

/** A construction with the given concurrency, since the parameter list varies. */
function construct(shape: Shape, concurrency: string, limit = String(ROOMY_LIMIT)): string {
  const args = [
    concurrency,
    ...(shape.sink ? ["sink"] : []),
    ...(shape.bounded ? [limit] : []),
  ];
  return `new ${shape.names.queue}(${args.join(", ")})`;
}

/** How a case submits a task, since `run` takes a priority under one rendering. */
function submit(shape: Shape, task: string, priority?: string): string {
  const args = [task, ...(shape.prioritised && priority !== undefined ? [priority] : [])];
  return `queue.run(${args.join(", ")})`;
}

function helpers(shape: Shape): string {
  return sections(
    documented(
      [
        "A promise this file settles itself.",
        "The whole timing mechanism. A task that waits on one of these occupies its worker until the case decides otherwise, which is what makes every sequence below exact rather than probable.",
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
        "A fixed number of turns rather than a timer, because everything here resolves through the microtask queue: starting a task, resuming it, and the `finally` that starts the next are each one turn, and a dozen is more than any single hand-off needs.",
      ],
      dedent`
        async function drain(): Promise<void> {
          for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        }
      `,
    ),
    when(
      shape.sink,
      documented(
        [
          "Every failure the queue reported, in order.",
          "Cleared by the cases that assert on it. A shared array rather than one per case, because the constructor takes the handler and a case that built its own would be establishing that the handler it passed is the handler that was called — which is not the thing worth pinning.",
        ],
        dedent`
          const reported: unknown[] = [];
          const sink = (error: unknown): void => {
            reported.push(error);
          };
        `,
      ),
    ),
  );
}

function concurrencyCases(shape: Shape): string {
  const n = shape.names;
  const limit = shape.bounded ? `, limit: ${String(ROOMY_LIMIT)}` : "";

  return dedent`
    describe("${n.queue}", () => {
      it("runs no more than the concurrency at once", async () => {
        const queue = ${construct(shape, "2")};
        const gates = [deferred(), deferred(), deferred(), deferred()];
        let running = 0;
        let peak = 0;
        let finished = 0;

        for (const gate of gates) {
          void ${submit(
            shape,
            dedent`
              async () => {
                running += 1;
                peak = Math.max(peak, running);
                await gate.promise;
                running -= 1;
              }
            `,
          )}.then(() => {
            finished += 1;
          });
        }

        await drain();
        expect(peak).toBe(2);
        expect(queue.snapshot()).toEqual({
          concurrency: 2,
          running: 2,
          pending: 2${limit},
          idle: false,
        });

        for (const gate of gates) {
          gate.settle();
          await drain();
        }

        // Counted rather than awaited: a task the queue failed to start would leave one of these
        // promises unsettled for good, and \`Promise.all\` would report that as a timeout instead of
        // as a number.
        expect(finished).toBe(4);
        expect(peak).toBe(2);
        expect(queue.snapshot().idle).toBe(true);
      });

      it("refuses a concurrency that runs nothing", () => {
        expect(() => ${construct(shape, "0")}).toThrow(/positive integer/);
        expect(() => ${construct(shape, "1.5")}).toThrow(/positive integer/);
      });
    ${when(shape.bounded, `
      it("refuses a backlog that could hold nothing", () => {
        expect(() => ${construct(shape, "1", "0")}).toThrow(/positive integer/);
      });
    `)}
      it("does not call the task until a worker is free", async () => {
        const queue = ${construct(shape, "1")};
        const gate = deferred();
        let called = false;

        void ${submit(shape, "async () => await gate.promise")};
        void ${submit(
          shape,
          dedent`
            () => {
              called = true;
            }
          `,
        )};

        await drain();

        // The submission is not the call. Everything the task holds — a connection, a buffer, a
        // file handle — stays unallocated while it waits, which is the difference between a
        // backlog of a million submissions and a million open sockets.
        expect(called).toBe(false);

        gate.settle();
        await drain();
        expect(called).toBe(true);
      });
    });
  `;
}

function orderingCases(shape: Shape): string {
  const n = shape.names;

  if (!shape.prioritised) {
    return dedent`
      describe("${n.queue} ordering", () => {
        it("starts waiting work in the order it was submitted", async () => {
          const queue = ${construct(shape, "1")};
          const gate = deferred();
          const started: string[] = [];

          void ${submit(shape, "async () => await gate.promise")};
          for (const name of ["a", "b", "c"]) {
            void ${submit(
              shape,
              dedent`
                () => {
                  started.push(name);
                }
              `,
            )};
          }

          gate.settle();
          await drain();

          // Taken from the head. A backlog drained from its tail passes every other case in this
          // file and starves its oldest submission for as long as work keeps arriving.
          expect(started).toEqual(["a", "b", "c"]);
        });
      });
    `;
  }

  return dedent`
    describe("${n.queue} ordering", () => {
      it("starts the highest priority first, and equal priorities in submission order", async () => {
        const queue = ${construct(shape, "1")};
        const gate = deferred();
        const started: string[] = [];
        const record = (name: string) => () => {
          started.push(name);
        };

        // One task occupying the only worker, so that everything below is ordered by the backlog
        // rather than by being submitted while a worker happened to be free.
        void queue.run(async () => await gate.promise, 0);

        void queue.run(record("low-first"), 0);
        void queue.run(record("high-first"), 10);
        void queue.run(record("low-second"), 0);
        void queue.run(record("high-second"), 10);
        void queue.run(record("middle"), 5);

        gate.settle();
        await drain();

        // The pairs are what matters: ordering on priority alone would satisfy the priorities and
        // could still emit \`high-second\` before \`high-first\`.
        expect(started).toEqual([
          "high-first",
          "high-second",
          "middle",
          "low-first",
          "low-second",
        ]);
      });

      it("gives work submitted at the default priority the order it arrived in", async () => {
        const queue = ${construct(shape, "1")};
        const gate = deferred();
        const started: string[] = [];

        void queue.run(async () => await gate.promise);
        for (const name of ["a", "b", "c"]) {
          void queue.run(() => {
            started.push(name);
          });
        }

        gate.settle();
        await drain();
        expect(started).toEqual(["a", "b", "c"]);
      });
    });
  `;
}

function failureCases(shape: Shape): string {
  const n = shape.names;

  const discarded = when(
    shape.sink,
    dedent`

      it("reports a failure whose promise was discarded", async () => {
        const queue = ${construct(shape, "1")};
        const boom = new Error("boom");
        reported.length = 0;

        // Discarded deliberately, which is the spelling this rendering exists to make safe. Under
        // the promise rendering the same two lines end the process.
        void ${submit(
          shape,
          dedent`
            () => {
              throw boom;
            }
          `,
        )};
        void ${submit(shape, "() => undefined")};

        await drain();
        expect(reported).toEqual([boom]);
        expect(queue.snapshot().idle).toBe(true);
      });
    `,
  );

  return dedent`
    describe("${n.queue} failures", () => {
      it("hands the task's own error to whoever submitted it", async () => {
        const queue = ${construct(shape, "1")};
        const boom = new Error("boom");
        ${when(shape.sink, "reported.length = 0;\n")}
        let caught: unknown = undefined;
        void ${submit(
          shape,
          dedent`
            () => {
              throw boom;
            }
          `,
        )}.catch((error: unknown) => {
          caught = error;
        });

        await drain();

        // Identity, not a message match: what matters is that the task's own error arrives
        // unwrapped, and a queue that replaced it with one of its own would pass the obvious
        // message assertion.
        expect(caught).toBe(boom);
      });

      it("keeps running the rest after one fails", async () => {
        const queue = ${construct(shape, "1")};
        const started: string[] = [];
        ${when(shape.sink, "reported.length = 0;\n")}
        void ${submit(
          shape,
          dedent`
            () => {
              throw new Error("boom");
            }
          `,
        )}${when(!shape.sink, ".catch(() => undefined)")};
        void ${submit(
          shape,
          dedent`
            () => {
              started.push("after");
            }
          `,
        )};

        await drain();
        expect(started).toEqual(["after"]);
        expect(queue.snapshot().idle).toBe(true);
      });
    ${discarded}});
  `;
}

function idleCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.queue} draining", () => {
      it("resolves at once when there is nothing outstanding", async () => {
        const queue = ${construct(shape, "1")};
        let resolved = false;

        void queue.onIdle().then(() => {
          resolved = true;
        });

        await drain();
        expect(resolved).toBe(true);
      });

      it("does not announce idle while work is outstanding", async () => {
        // Two tasks, each held open, so that idleness is asserted at two different moments: one
        // with work still waiting, and one with the last task started but not finished. A queue
        // announcing idle whenever its backlog is empty is wrong only at the second, and passes
        // every version of this case that does not reach it.
        const queue = ${construct(shape, "1")};
        const first = deferred();
        const second = deferred();
        let announced = "not yet";

        void ${submit(shape, "async () => await first.promise")};
        void queue.onIdle().then(() => {
          announced = "announced";
        });
        void ${submit(shape, "async () => await second.promise")};

        // One running, one waiting.
        await drain();
        expect(announced).toBe("not yet");

        // Nothing waiting, one still running. Recorded by ordering rather than by reading the
        // counters inside the callback: a \`then\` handler runs a microtask after the signal, and
        // whatever it reads may have moved in between.
        first.settle();
        await drain();
        expect(announced).toBe("not yet");

        second.settle();
        await drain();
        expect(announced).toBe("announced");
      });

      it("waits for work submitted by work", async () => {
        const queue = ${construct(shape, "1")};
        const started: string[] = [];
        let idleAfter = -1;

        void ${submit(
          shape,
          dedent`
            () => {
              started.push("first");
              // Submitted from inside a task, which is what a retry does.
              void ${submit(
                shape,
                dedent`
                  () => {
                    started.push("second");
                  }
                `,
              )};
            }
          `,
        )}${when(!shape.sink, "")};

        void queue.onIdle().then(() => {
          idleAfter = started.length;
        });

        await drain();
        expect(started).toEqual(["first", "second"]);

        // Recorded at the moment idle arrived rather than checked afterwards: announcing it early
        // and announcing it late both end with the same two entries in \`started\`, and only the
        // count taken at that instant tells them apart.
        expect(idleAfter).toBe(2);
      });

      it("resolves rather than rejecting when a task failed", async () => {
        const queue = ${construct(shape, "1")};
        ${when(shape.sink, "reported.length = 0;\n")}
        void ${submit(
          shape,
          dedent`
            () => {
              throw new Error("boom");
            }
          `,
        )}${when(!shape.sink, ".catch(() => undefined)")};

        let outcome = "neither";
        void queue.onIdle().then(
          () => {
            outcome = "resolved";
          },
          () => {
            outcome = "rejected";
          },
        );

        await drain();

        // A drain signal that failed with the first failing task would make "wait for the work to
        // finish" and "check the work succeeded" the same call.
        expect(outcome).toBe("resolved");
      });
    });
  `;
}

function boundedCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.queue} backlog", () => {
      it("refuses work once the backlog is at its limit", async () => {
        const queue = ${construct(shape, "1", "1")};
        const gate = deferred();

        void ${submit(shape, "async () => await gate.promise")};
        void ${submit(shape, "() => undefined")};
        expect(queue.snapshot().pending).toBe(1);

        // Caught here rather than off the promise. Under an off-by-one the submission is admitted
        // instead of refused, and nothing is thrown — so \`refusal\` stays undefined and the case
        // says so, where a version awaiting a promise that never settles would die reporting
        // nothing about the limit at all.
        let refusal: unknown = undefined;
        try {
          void ${submit(shape, "() => undefined")};
        } catch (error) {
          refusal = error;
        }

        expect(refusal).toBeInstanceOf(${n.full});
        expect(queue.snapshot().pending).toBe(1);

        gate.settle();
        await drain();
        expect(queue.snapshot().idle).toBe(true);
      });

      it("announces space only once the backlog is below its limit", async () => {
        // The one arrangement that can tell the guard from no guard at all: a completion starts a
        // task, and that task synchronously submits another, taking back the slot it just freed.
        // Every other route has already freed one by the time the check runs.
        const queue = ${construct(shape, "1", "2")};
        const gate = deferred();

        void ${submit(shape, "async () => await gate.promise")};
        void ${submit(
          shape,
          dedent`
            () => {
              void ${submit(shape, "() => undefined")};
            }
          `,
        )};
        void ${submit(shape, "() => undefined")};
        expect(queue.snapshot().pending).toBe(2);

        // The backlog as it stood when space was announced, rather than after a fixed number of
        // turns: a premature announcement and a correct one leave the same final state, and a turn
        // count one short of the refill reads as a pass. This handler runs a microtask after the
        // announcement, which is sound here only because nothing in between can shorten the
        // backlog — taking from it requires a completion, and that is a later microtask still.
        let announcedAt = -1;
        void queue.whenSpace().then(() => {
          announcedAt = queue.snapshot().pending;
        });

        gate.settle();
        await drain();
        expect(announcedAt).toBe(0);
      });

      it("resolves at once while there is room", async () => {
        const queue = ${construct(shape, "1", "2")};
        let free = false;

        void queue.whenSpace().then(() => {
          free = true;
        });

        await drain();
        expect(free).toBe(true);
      });
    });
  `;
}
