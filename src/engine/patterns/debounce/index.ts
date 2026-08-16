/**
 * The `debounce` pattern: a burst of calls collapsed into one.
 *
 * The first pattern here where time is the subject rather than an inconvenience, and that decides the
 * shape. The timer is a constructor argument, not the ambient `setTimeout`, for two reasons that both
 * matter more than the small amount of ceremony it costs. A test can drive the clock instead of waiting
 * on it, so the emitted suite is exact and takes no wall-clock time — the alternative is fake timers,
 * whose API differs across every framework this generates for, in a file that also has to work under a
 * hand-written `expect` shim. And the port hands back a *cancel function* rather than a handle, which
 * sidesteps the oldest portability trap in this area: `setTimeout` returns `number` in a browser and a
 * `Timeout` object in Node, so any type written for one is wrong in the other.
 *
 * Fourteen defects were written and watched to fail. Four of them needed the test rewritten first, and
 * those are the ones worth recording:
 *
 * The ceiling must not be restarted by a later call. Resetting it alongside the quiet timer is the whole
 * failure it exists to prevent — under continuous calls neither expires and nothing is ever invoked.
 *
 * The ceiling must be re-armed from its own expiry, not from the next call. Both versions invoke the
 * same number of times, so a test counting invocations cannot tell them apart; only their *timing*
 * differs, by the gap between calls. The suite therefore records when each invocation happened and
 * asserts the interval.
 *
 * `active` tracks the burst, not the pending call, and they genuinely differ: a ceiling invocation
 * empties the pending call while the burst continues, so treating the next call as a fresh leading edge
 * would invoke twice in a row.
 *
 * The waiting callers must be read *before* the function is called. Read after, a call made from inside
 * the function joins the batch already settling and is told the wrong result — which leaves the list of
 * invocations identical, so only an assertion on what each caller was told catches it.
 *
 * Two more were the test's own fault rather than the code's, and both were the same mistake: checking
 * for a leftover timer *after* advancing the clock, which fires the very timer under examination. A
 * timer left behind is not only a stray callback — in Node it keeps the process alive.
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

export const debouncePattern: PatternModule = {
  name: "debounce",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const edge = options.edge === "leading" || options.edge === "both" ? options.edge : "trailing";
    const shape: Shape = {
      edge,
      leadingEdge: edge !== "trailing",
      trailingEdge: edge !== "leading",
      awaited: options.result !== "void",
      ceiling: options.maxWait === true,
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
  readonly edge: "trailing" | "leading" | "both";
  readonly leadingEdge: boolean;
  readonly trailingEdge: boolean;
  /** `result: "promise"` — callers are handed the invocation's outcome. */
  readonly awaited: boolean;
  readonly ceiling: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The factory: `debounceOrder`. */
  readonly debounce: string;
  /** What it returns: `OrderDebounced`. */
  readonly debounced: string;
  /** The timer port: `OrderDebounceTimers`. */
  readonly timers: string;
  /** The default port over the ambient timers. */
  readonly systemTimers: string;
  readonly options: string;
  /** The refusal handed to a caller whose pending call was cancelled. */
  readonly cancelled: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;

  return {
    stem: entity === undefined ? "debounce" : `${entity.kebab}-debounce`,
    debounce: entity === undefined ? "debounce" : `debounce${entity.pascal}`,
    debounced: `${prefix}Debounced`,
    timers: `${prefix}DebounceTimers`,
    systemTimers: entity === undefined ? "systemTimers" : `${entity.camel}SystemTimers`,
    options: `${prefix}DebounceOptions`,
    cancelled: `${prefix}DebounceCancelledError`,
  };
}

/** What the debounced function returns, which is the whole of the `result` axis. */
function returns(shape: Shape): string {
  return shape.awaited ? "Promise<R>" : "void";
}

function core(shape: Shape): string {
  return sections(
    timersPort(shape),
    systemTimers(shape),
    when(shape.awaited, cancelledError(shape)),
    optionsType(shape),
    debouncedType(shape),
    when(shape.awaited, settlerType()),
    factory(shape),
  );
}

function timersPort(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Where the delay comes from.",
      "A port rather than a direct call to `setTimeout`, which is what lets a test drive the clock instead of waiting on it. The alternative is the framework's fake timers, and those are a different API in each one — a poor dependency for a file that is also expected to run under a hand-written assertion shim.",
      "It hands back a function that stops the timer, rather than a handle to pass to a clearing function. That is deliberate: the handle is a `number` in a browser and an object in Node, so a type naming it is wrong in one of the two, and every implementation of this port already knows how to cancel its own.",
    ],
    dedent`
      export interface ${n.timers} {
        readonly delay: (ms: number, callback: () => void) => () => void;
      }
    `,
  );
}

function systemTimers(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The port over whatever timers the runtime provides.",
      "The default, so that ordinary use needs no argument and only a test has to supply one.",
    ],
    dedent`
      export const ${n.systemTimers}: ${n.timers} = {
        delay: (ms, callback) => {
          const handle = setTimeout(callback, ms);
          return () => {
            clearTimeout(handle);
          };
        },
      };
    `,
  );
}

function cancelledError(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A pending call abandoned before it ran.",
      "Callers waiting on a cancelled call are rejected with this rather than resolved with nothing. Resolving would require a value of the function's own return type, and there is none — inventing `undefined` for it is a lie the type would have to be widened to permit.",
    ],
    dedent`
      export class ${n.cancelled} extends Error {
        override readonly name = "${n.cancelled}";

        constructor() {
          super("The pending call was cancelled before it ran.");
        }
      }
    `,
  );
}

function optionsType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "How long to wait, and what to wait with.",
      ...(shape.ceiling
        ? [
            "`maxWaitMs` is the ceiling on the delay, and it is what keeps a caller who never goes quiet from never being served. It is validated against `waitMs` rather than merely documented, because a ceiling below the wait can never take effect and is therefore always a mistake.",
          ]
        : []),
      ...(shape.awaited
        ? []
        : [
            "`onError` is required, not optional. Nothing here returns the failure to a caller, so this is the only place one can go — and a discarded rejection ends a Node process rather than being ignored.",
          ]),
    ],
    dedent`
      export interface ${n.options} {
        readonly waitMs: number;
      ${when(shape.ceiling, "  /** The longest a call may be held, however many arrive. */\n  readonly maxWaitMs: number;\n")}${when(!shape.awaited, "  readonly onError: (error: unknown) => void;\n")}  /** Defaults to the runtime's own timers. */
        readonly timers?: ${n.timers};
      }
    `,
  );
}

function debouncedType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The debounced function, and the three things worth being able to do to it.",
      "`cancel` is what an interface element needs when it goes away with a call outstanding; `flush` is what one needs when it goes away and the call should still happen — a draft saved on close. Both are the difference between a debounce that is usable in a component lifecycle and one that is not.",
      "`pending` reports whether a call is waiting. Worth having for the same reason: \"is there unsaved work\" is a question the caller cannot otherwise answer.",
    ],
    dedent`
      export interface ${n.debounced}<A extends readonly unknown[], R> {
        (...args: A): ${returns(shape)};
      ${when(shape.awaited, "  /** Drops the pending call. Anyone waiting on it is rejected. */\n", "  /** Drops the pending call. */\n")}  readonly cancel: () => void;
        /** Runs the pending call now, if there is one. */
        readonly flush: () => void;
        readonly pending: () => boolean;
      }
    `,
  );
}

function settlerType(): string {
  return documented(
    [
      "One caller waiting for the invocation their call caused.",
      "The halves of their promise, held so that the invocation can settle it from outside. Every caller in a burst is settled from the same outcome, which is the honest answer: they asked for one thing to happen and one thing happened.",
    ],
    dedent`
      interface Settler<R> {
        readonly resolve: (value: R) => void;
        readonly reject: (error: unknown) => void;
      }
    `,
  );
}

function factory(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Wraps a function so that a burst of calls becomes one call.",
      ...(shape.edge === "trailing"
        ? [
            "Invoked once the calls stop for `waitMs`, with the arguments of the last one. Nothing happens while they keep coming, which is what a search-as-you-type wants and what makes a ceiling worth considering if the calls might never stop.",
          ]
        : []),
      ...(shape.edge === "leading"
        ? [
            "Invoked on the first call of a burst, and the rest of the burst is dropped. What a submit button wants: the response to a click cannot wait for the user to stop clicking.",
          ]
        : []),
      ...(shape.edge === "both"
        ? [
            "Invoked on the first call of a burst and again at the end if any others arrived. A single call invokes exactly once — the trailing invocation is skipped when nothing was suppressed, which is the defect that separates a correct implementation of this edge from the obvious one.",
          ]
        : []),
      ...(shape.awaited
        ? [
            "Every caller is handed the outcome of the invocation their own call caused. Note what that is not: the result of the *previous* invocation, which is what an implementation that returns a value synchronously has to give, and which is stale by construction.",
          ]
        : [
            "Nothing is returned. A caller who needs the result wants the promise rendering of this pattern; this one is for a handler whose only job is the side effect.",
          ]),
    ],
    dedent`
      export function ${n.debounce}<A extends readonly unknown[], R>(
        fn: (...args: A) => Promise<R> | R,
        options: ${n.options},
      ): ${n.debounced}<A, R> {
      ${indent(factoryBody(shape), 2)}
      }
    `,
  );
}

function factoryBody(shape: Shape): string {
  return sections(
    validation(shape),
    state(shape),
    invokeFn(shape),
    endBurstFn(shape),
    onQuietFn(shape),
    when(shape.ceiling, onCeilingFn(shape)),
    debouncedFn(shape),
    controls(shape),
  );
}

function validation(shape: Shape): string {
  const n = shape.names;

  return sections(
    dedent`
      const { waitMs${when(shape.ceiling, ", maxWaitMs")} } = options;
      const timers = options.timers ?? ${n.systemTimers};
    `,
    dedent`
      if (!Number.isFinite(waitMs) || waitMs < 0) {
        throw new RangeError(
          \`waitMs must be a non-negative finite number, received \${String(waitMs)}\`,
        );
      }
    `,
    when(
      shape.ceiling,
      dedent`
        // Refused rather than documented. A ceiling below the wait can never take effect, so it is
        // always a mistake, and one whose only symptom is an option that appears to do nothing.
        if (!Number.isFinite(maxWaitMs) || maxWaitMs < waitMs) {
          throw new RangeError(
            \`maxWaitMs \${String(maxWaitMs)} must be a finite number at least as large as waitMs \${String(waitMs)}\`,
          );
        }
      `,
    ),
  );
}

function state(shape: Shape): string {
  return joinLines(
    // Only a leading edge asks whether a burst is already under way; a purely trailing debounce
    // restarts its timer and cares about nothing else. Emitted unconditionally, the flag was assigned
    // in two places and read in none, which a caller compiling with `noUnusedLocals` sees as an error
    // in code we told them was verified.
    when(
      shape.leadingEdge,
      joinLines(
        "// `active` is the burst, not the pending call, and the difference is load-bearing" +
          (shape.ceiling
            ? ": a ceiling invocation empties the pending call while the burst continues, and treating\n    // the next call as a fresh leading edge would then invoke twice in a row."
            : " once a ceiling is in play.\n    // Kept as its own flag here so that the two never have to be inferred from one another."),
        "let active = false;",
      ),
    ),
    "/** Calls received since the last invocation. Not since the burst began. */",
    "let pendingCalls = 0;",
    "let latest: A | undefined = undefined;",
    "let stopQuiet: (() => void) | undefined = undefined;",
    when(shape.ceiling, "let stopCeiling: (() => void) | undefined = undefined;"),
    when(shape.awaited, "let settlers: Settler<R>[] = [];"),
    when(
      shape.awaited && shape.edge === "leading",
      "/** What the burst's one invocation produced, for the calls it suppressed. */\n    let burstOutcome: Promise<R> | undefined = undefined;",
    ),
  );
}

function invokeFn(shape: Shape): string {
  const settle = when(
    shape.awaited,
    dedent`

      outcome.then(
        (value) => {
          for (const settler of waiting) settler.resolve(value);
        },
        (error: unknown) => {
          for (const settler of waiting) settler.reject(error);
        },
      );
    `,
    dedent`

      // Reported rather than dropped. Without a caller to reject there is nowhere else for it to go,
      // and an unhandled rejection is fatal to a Node process rather than merely untidy.
      outcome.catch((error: unknown) => {
        options.onError(error);
      });
    `,
  );

  const params = shape.awaited
    ? "(args: A, waiting: readonly Settler<R>[]): Promise<R>"
    : "(args: A): Promise<R>";

  const body = sections(
    dedent`
      pendingCalls = 0;
    `,
    dedent`
      // Started here, synchronously, before anything is awaited. Two consequences, both wanted: a
      // call made from inside \`fn\` belongs to the next burst rather than this one, and${when(shape.awaited, " the callers\n// settled below are the ones read before it ran, so such a call is not told this result.", " a\n// failure is attached to below rather than escaping.")}
      const outcome = (async () => await fn(...args))();
    `,
    settle.trim(),
    "return outcome;",
  );

  return dedent`
    const invoke = ${params} => {
    ${indent(body, 2)}
    };
  `;
}

function endBurstFn(shape: Shape): string {
  return dedent`
    const endBurst = (): void => {
    ${when(shape.leadingEdge, "  active = false;\n")}  stopQuiet = undefined;
    ${when(shape.ceiling, "  stopCeiling?.();\n    stopCeiling = undefined;\n")}};
  `;
}

function onQuietFn(shape: Shape): string {
  if (shape.edge === "leading") {
    return dedent`
      const onQuiet = (): void => {
        // Nothing trails under this edge, so the timer's only job is to end the burst — which is
        // what makes the next call a leading edge again.
        endBurst();
      };
    `;
  }

  const body = sections(
    dedent`
      const args = latest;

      // ${
        shape.edge === "both"
          ? "`pendingCalls` is what stops a single call invoking twice under this edge: the leading\n// invocation cleared it, so a burst of one arrives here with nothing suppressed to run."
          : "A burst with nothing pending is one already served by the ceiling, which leaves the quiet\n// timer running so that it can close the burst rather than invoke again."
      }
      const due = pendingCalls > 0 && args !== undefined;
    `,
    when(
      shape.awaited,
      dedent`
        const waiting = settlers;
        settlers = [];
      `,
    ),
    "endBurst();",
    `if (due) void invoke(args${when(shape.awaited, ", waiting")});`,
  );

  return dedent`
    const onQuiet = (): void => {
    ${indent(body, 2)}
    };
  `;
}

function onCeilingFn(shape: Shape): string {
  const body = shape.edge === "leading"
    ? dedent`
        // Nothing trails under this edge, so the ceiling has nothing to release: the burst's one
        // invocation already happened at its first call.
        stopCeiling = undefined;
      `
    : sections(
        dedent`
          stopCeiling = undefined;
          const args = latest;

          if (pendingCalls === 0 || args === undefined) return;
        `,
        when(
          shape.awaited,
          dedent`
            const waiting = settlers;
            settlers = [];
          `,
        ),
        `void invoke(args${when(shape.awaited, ", waiting")});`,
        dedent`
          // The burst is not over, so the quiet timer is left alone and a fresh ceiling is started
          // from *this* expiry rather than from the next call. Armed from the next call instead, the
          // interval drifts by the gap between calls and the guarantee quietly weakens.
          stopCeiling = timers.delay(maxWaitMs, onCeiling);
        `,
      );

  return dedent`
    const onCeiling = (): void => {
    ${indent(body, 2)}
    };
  `;
}

function debouncedFn(shape: Shape): string {
  const leading = when(
    shape.leadingEdge,
    shape.awaited
      ? shape.edge === "leading"
        ? dedent`
            if (leadingEdge) {
              // Filled by the executor, which the language guarantees runs before \`new Promise\`
              // returns. A list rather than one variable only to say so without an assertion.
              const waiting: Settler<R>[] = [];
              const outcome = new Promise<R>((resolve, reject) => {
                waiting.push({ resolve, reject });
              });

              // Recorded *before* invoking, which is not fussiness. \`fn\` runs synchronously inside
              // \`invoke\`, so it can call back in — and such a call is suppressed by the very
              // invocation it is running inside. Recorded after, it would find nothing here and
              // invoke a second time, defeating the edge from inside the function it wraps.
              burstOutcome = outcome;
              void invoke(args, waiting);
              return outcome;
            }

            const suppressed = burstOutcome;

            // Suppressed, and no further invocation is coming under this edge, so the burst's own
            // outcome is the nearest truth there is.
            if (suppressed !== undefined) return suppressed;

            // Unreachable: suppression requires an active burst, and a burst begins with a leading
            // edge, which sets the outcome above. Present because the function has to be total, and
            // written as an invocation rather than a throw only so that it cannot strand a caller.
            return invoke(args, []);
          `
        : dedent`
            // The caller that opened the burst is settled from the leading invocation, because that
            // is the invocation its call caused. The ones after it are settled from the trailing.
            if (leadingEdge) return invoke(args, []);
          `
      : dedent`
          if (leadingEdge) {
            void invoke(args);
            return;
          }
        `,
  );

  const tail = when(
    shape.awaited && shape.edge !== "leading",
    dedent`
      return new Promise<R>((resolve, reject) => {
        settlers.push({ resolve, reject });
      });
    `,
  );

  const body = sections(
    joinLines(
      "latest = args;",
      "pendingCalls += 1;",
      when(shape.leadingEdge, "const leadingEdge = !active;"),
      when(shape.leadingEdge, "active = true;"),
    ),
    dedent`
      stopQuiet?.();
      stopQuiet = timers.delay(waitMs, onQuiet);
    `,
    when(
      shape.ceiling,
      dedent`
        // Not restarted if one is already running, and that guard is the point of the option. Reset
        // alongside the quiet timer, neither would ever expire under continuous calls and the
        // ceiling would silently do nothing at all.
        if (stopCeiling === undefined) {
          stopCeiling = timers.delay(maxWaitMs, onCeiling);
        }
      `,
    ),
    leading,
    tail,
  );

  return dedent`
    const debounced = (...args: A): ${returns(shape)} => {
    ${indent(body, 2)}
    };
  `;
}

function controls(shape: Shape): string {
  const n = shape.names;

  const cancelBody = shape.awaited
    ? dedent`
        const waiting = settlers;
        settlers = [];
        pendingCalls = 0;
        latest = undefined;
        stopQuiet?.();
        endBurst();

        for (const settler of waiting) settler.reject(new ${n.cancelled}());
      `
    : dedent`
        pendingCalls = 0;
        latest = undefined;
        stopQuiet?.();
        endBurst();
      `;

  return dedent`
    return Object.assign(debounced, {
      cancel: (): void => {
    ${indent(cancelBody, 4)}
      },

      flush: (): void => {
        if (stopQuiet === undefined) return;

        // Cancelled before it is run by hand. \`onQuiet\` cannot do it — it is normally reached *by*
        // that timer — so a flush that skipped this leaves a timer scheduled, which in Node holds
        // the process open long after the work is done.
        stopQuiet();
        onQuiet();
      },

      pending: (): boolean => pendingCalls > 0,
    });
  `;
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  const optionFields = joinLines(
    "  waitMs: 300,",
    when(shape.ceiling, "  maxWaitMs: 2_000,"),
    when(!shape.awaited, "  onError: (error: unknown) => {\n    console.error(\"search failed\", error);\n  },"),
  );

  const body = shape.awaited
    ? dedent`
        export function searchAsYouType(
          search: (term: string) => Promise<readonly string[]>,
          show: (results: readonly string[]) => void,
        ): ${n.debounced}<[string], readonly string[]> {
          const debounced = ${n.debounce}(search, {
        ${optionFields}
          });

          return Object.assign(
            (term: string) => {
              const results = debounced(term);

              void results.then(show, (error: unknown) => {
                // Rejected for two different reasons, and only one is a failure: a cancelled call is
                // an ordinary outcome of the user carrying on typing.
                if (error instanceof ${n.cancelled}) return;
                console.error("search failed", error);
              });

              return results;
            },
            {
              cancel: debounced.cancel,
              flush: debounced.flush,
              pending: debounced.pending,
            },
          );
        }
      `
    : dedent`
        export function searchAsYouType(
          search: (term: string) => Promise<readonly string[]>,
          show: (results: readonly string[]) => void,
        ): ${n.debounced}<[string], void> {
          return ${n.debounce}(
            async (term: string) => {
              show(await search(term));
            },
            {
        ${indent(optionFields, 4)}
            },
          );
        }
      `;

  return sections(
    dedent`
      /**
       * Search as the user types.
       *
       * The case that names the pattern: a keystroke is not a request, and issuing one per keystroke
       * spends a request on every prefix of what the user meant to type.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.debounce, ...(shape.awaited ? [n.cancelled] : [])],
      types: [n.debounced],
    }),
    documented(
      [
        "Searches once the typing settles, and shows what came back.",
        ...(shape.ceiling
          ? [
              "The ceiling matters more here than it appears to. Someone typing steadily for ten seconds never pauses for the full wait, and without it they would see nothing at all until they stopped.",
            ]
          : []),
        ...(shape.awaited
          ? [
              "The promise is returned as well as consumed, so a caller that wants to await the search — a test, or a route that must not render until results exist — can, without a second code path.",
            ]
          : [
              "Nothing is returned, so the failure handler given at construction is the only place an error can go. A caller needing to await the search wants the promise rendering instead.",
            ]),
        "`cancel` and `flush` are forwarded rather than hidden, because the component holding this is the thing that knows when it is going away.",
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
          {
            values: ["describe", "expect", "it"],
          },
        );

  return sections(
    dedent`
      /**
       * What is asserted here, and why it is written this way.
       *
       * The clock is supplied, not waited on. Every case advances time by hand, so the suite is exact
       * and costs no wall-clock time at all — where a debounce tested against real timers is both slow
       * and flaky, since a wait of 100ms passes on an idle machine and fails on a loaded one.
       *
       * The clock also reports how many timers are still scheduled, which is asserted after \`cancel\`
       * and \`flush\`. A timer left behind is not only a stray callback: in Node it keeps the event loop
       * alive, so a component that has gone away can hold a process open. Note the ordering — that
       * assertion comes *before* the clock is advanced, because advancing it fires the very timer the
       * case is looking for.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.debounce, ...(shape.awaited ? [n.cancelled] : [])],
      types: [n.timers],
    }),
    helpers(shape),
    collapseCases(shape),
    when(shape.awaited, resultCases(shape)),
    when(!shape.awaited, errorSinkCases(shape)),
    when(shape.ceiling, ceilingCases(shape)),
    controlCases(shape),
    validationCases(shape),
  );
}

function helpers(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "A clock this file advances by hand.",
        "Firing is a loop rather than one pass, so a callback that schedules another timer inside the same advance is served by it. That is not hypothetical here: the ceiling arms its successor from its own expiry.",
      ],
      dedent`
        interface Clock {
          readonly timers: ${n.timers};
          readonly advance: (ms: number) => void;
          readonly now: () => number;
          /** How many timers are still scheduled. */
          readonly liveTimers: () => number;
        }

        function clock(): Clock {
          interface Entry {
            at: number;
            fn: () => void;
            live: boolean;
          }

          let now = 0;
          const entries: Entry[] = [];

          return {
            timers: {
              delay: (ms, fn) => {
                const entry: Entry = { at: now + ms, fn, live: true };
                entries.push(entry);
                return () => {
                  entry.live = false;
                };
              },
            },
            advance: (ms) => {
              const target = now + ms;

              for (;;) {
                const due = entries
                  .filter((entry) => entry.live && entry.at <= target)
                  .sort((first, second) => first.at - second.at)[0];
                if (due === undefined) break;

                due.live = false;
                now = due.at;
                due.fn();
              }

              now = target;
            },
            now: () => now,
            liveTimers: () => entries.filter((entry) => entry.live).length,
          };
        }
      `,
    ),
    documented(
      [
        "Lets every microtask already scheduled run.",
        "Needed even with the clock under control, because the invocation itself resolves through the microtask queue: advancing time runs the timer, and settling what it produced is a separate turn.",
      ],
      dedent`
        async function drain(): Promise<void> {
          for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        }
      `,
    ),
    documented(
      [
        "A function that records what it was called with, and when.",
        "The times are what the ceiling's guarantee is about. Two implementations of it invoke the same number of times and differ only in when, so a count cannot tell them apart.",
      ],
      dedent`
        function recorder(now: () => number): {
          readonly calls: string[];
          readonly times: number[];
          readonly fn: (value: string) => string;
        } {
          const calls: string[] = [];
          const times: number[] = [];

          return {
            calls,
            times,
            fn: (value: string): string => {
              calls.push(value);
              times.push(now());
              return \`did \${value}\`;
            },
          };
        }
      `,
    ),
    when(
      shape.awaited,
      documented(
        [
          "Discards a promise this file does not examine.",
          "Not `void`, which would leave the rejection unhandled — and a cancelled call *does* reject, so a case that cancels one and discards it with `void` ends the process rather than failing an assertion. The same trap a caller of this pattern has, which is why it is spelled out here rather than avoided.",
        ],
        dedent`
          function ignore(promise: Promise<unknown>): void {
            void promise.catch(() => undefined);
          }
        `,
      ),
    ),
    documented(
      ["One debounced recorder over a clock this file drives."],
      dedent`
        function harness(waitMs = 100${when(shape.ceiling, ", maxWaitMs = 250")}) {
          const time = clock();
          const recorded = recorder(time.now);
        ${when(!shape.awaited, "  const failures: unknown[] = [];\n")}
          return {
            clock: time,
            recorded,
        ${when(!shape.awaited, "    failures,\n")}    run: ${shape.names.debounce}(recorded.fn, {
              waitMs,
        ${when(shape.ceiling, "      maxWaitMs,\n")}${when(!shape.awaited, "      onError: (error: unknown) => {\n        failures.push(error);\n      },\n")}      timers: time.timers,
            }),
          };
        }
      `,
    ),
  );
}

/** How a case spells a call whose result it does not examine. */
function call(shape: Shape, args: string): string {
  return shape.awaited ? `ignore(run(${args}))` : `run(${args})`;
}

/**
 * An options object written out, for a case that needs its own function rather than the harness.
 *
 * Assembled here rather than at each site because it varies on two axes at once. Written out at each
 * one, a rendering that needs a ceiling or a failure handler is a compile error in a file nothing but
 * the whole matrix would have exercised.
 */
function inlineOptions(shape: Shape, onError = "() => undefined"): string {
  return joinLines(
    "{",
    "  waitMs: 100,",
    when(shape.ceiling, "  maxWaitMs: 250,"),
    when(!shape.awaited, `  onError: ${onError},`),
    "  timers: time.timers,",
    "}",
  );
}

function collapseCases(shape: Shape): string {
  const n = shape.names;

  const trailingOnly = when(
    shape.edge === "trailing",
    dedent`

      it("does not invoke before the wait has elapsed", () => {
        const { clock: time, recorded, run } = harness();

        ${call(shape, '"a"')};
        ${call(shape, '"b"')};
        time.advance(99);

        expect(recorded.calls).toEqual([]);
        expect(run.pending()).toBe(true);
      });
    `,
  );

  const leadingCase = when(
    shape.leadingEdge,
    dedent`

      it("invokes on the first call of a burst", async () => {
        const { recorded, run } = harness();

        ${call(shape, '"a"')};
        await drain();

        expect(recorded.calls).toEqual(["a"]);
      });

      it("treats a call after the burst as a new leading edge", async () => {
        const { clock: time, recorded, run } = harness();

        ${call(shape, '"a"')};
        time.advance(100);
        await drain();

        ${call(shape, '"b"')};
        await drain();

        // Both bursts, because the point is that the second one fired at all: a leading edge keyed
        // on the call count rather than on the burst being over would drop it.
        expect(recorded.calls).toEqual(["a", "b"]);
      });
    `,
  );

  const single = shape.edge === "both"
    ? dedent`

        it("invokes exactly once for a single call", async () => {
          const { clock: time, recorded, run } = harness();

          ${call(shape, '"only"')};
          time.advance(100);
          await drain();

          // The defect this edge is generated for. Invoking the leading edge and then the trailing
          // one regardless gives a caller who called once two invocations, and the second is a
          // repeat of the first — silent, and wrong in exactly the way that matters for a write.
          expect(recorded.calls).toEqual(["only"]);
        });

        it("invokes twice when the burst had more than one call", async () => {
          const { clock: time, recorded, run } = harness();

          ${call(shape, '"a"')};
          ${call(shape, '"b"')};
          ${call(shape, '"c"')};
          await drain();
          expect(recorded.calls).toEqual(["a"]);

          time.advance(100);
          await drain();
          expect(recorded.calls).toEqual(["a", "c"]);
        });
      `
    : shape.edge === "leading"
      ? dedent`

          it("drops the rest of the burst", async () => {
            const { clock: time, recorded, run } = harness();

            ${call(shape, '"a"')};
            ${call(shape, '"b"')};
            ${call(shape, '"c"')};
            time.advance(100);
            await drain();

            expect(recorded.calls).toEqual(["a"]);
          });
        `
      : dedent`

          it("collapses a burst into one call, with the last arguments", async () => {
            const { clock: time, recorded, run } = harness();

            ${call(shape, '"a"')};
            ${call(shape, '"b"')};
            ${call(shape, '"c"')};
            time.advance(100);
            await drain();

            // The *last* arguments, not the first. Keeping the first is a defect that passes every
            // case counting invocations, and means the search runs on a prefix of what was typed.
            expect(recorded.calls).toEqual(["c"]);
            expect(run.pending()).toBe(false);
          });
        `;

  return dedent`
    describe("${n.debounce}", () => {${single}${trailingOnly}${leadingCase}
      it("leaves no timer behind once it has run", async () => {
        const { clock: time, run } = harness();

        ${call(shape, '"a"')};
        time.advance(100);
        await drain();

        expect(time.liveTimers()).toBe(0);
      });
    });
  `;
}

function resultCases(shape: Shape): string {
  const n = shape.names;

  // What each caller is told, which is the whole of this axis and differs on every edge. The rule
  // is one sentence — a caller receives the outcome of the invocation their own call caused — and
  // the three expectations below are that sentence applied, not three separate conventions.
  const routing = {
    trailing: {
      title: "gives every caller in a burst the same result",
      expected: '["1:did b", "2:did b"]',
      note: dedent`
        // One invocation happened, so one result is what there is to report. An implementation
        // handing back the *previous* invocation's value would satisfy the types and be stale.
      `,
    },
    leading: {
      title: "gives a suppressed caller the burst's own result",
      expected: '["1:did a", "2:did a"]',
      note: dedent`
        // The second call was dropped, so there is no invocation of its own to report. The burst's
        // is the nearest truth available, and the alternative is a promise that never settles.
      `,
    },
    both: {
      title: "gives each caller the result of the invocation it caused",
      expected: '["1:did a", "2:did b"]',
      note: dedent`
        // Different results for the two callers, which is correct rather than untidy: the first
        // call caused the leading invocation and the second caused the trailing one, so those are
        // what they are told. Handing both the trailing result would mean telling the first caller
        // about work that happened after it, and it is the only edge where the distinction exists.
      `,
    },
  }[shape.edge];

  // A call made from inside the wrapped function, whose right answer is different on each edge and
  // interesting on all three. Under a trailing edge it is the batching rule: the waiting callers are
  // read before the function runs, so the inner call belongs to the next burst rather than to the one
  // already settling. Under a leading edge it is suppression: the inner call is suppressed by the very
  // invocation it is running inside, which only works because the burst's outcome is recorded before
  // the function is called.
  const reentrancy = {
    trailing: {
      title: "does not fold a call made from inside the function into the batch",
      firstCalls: '["outer"]',
      finalCalls: '["outer", "inner"]',
      told: '{ outer: "outer", inner: "inner" }',
      note: dedent`
        // The routing, not only the invocations. Reading the waiting callers *after* calling the
        // function folds the inner call into the batch already settling, which leaves the list of
        // invocations above identical and tells the inner caller the outer call's result.
      `,
    },
    leading: {
      title: "suppresses a call made from inside the function",
      firstCalls: '["outer"]',
      finalCalls: '["outer"]',
      told: '{ outer: "outer", inner: "outer" }',
      note: dedent`
        // The inner call arrives while the burst is active, so it is suppressed like any other and is
        // told the burst's outcome — which is the invocation it is running inside. Recording that
        // outcome only after the call returned would leave nothing here to hand back, and the
        // fallback would invoke a second time: the edge defeated from inside its own function.
      `,
    },
    both: {
      title: "leaves a call made from inside the function to the trailing edge",
      firstCalls: '["outer", "inner"]',
      finalCalls: '["outer", "inner"]',
      told: '{ outer: "outer", inner: "inner" }',
      note: dedent`
        // Suppressed at the leading edge and then run by the trailing one, so it is the inner call
        // that makes this burst invoke twice — and each caller is told its own invocation's result.
      `,
    },
  }[shape.edge];

  const shared = dedent`
    it("${routing.title}", async () => {
      const { clock: time, run } = harness();
      const results: string[] = [];

      void run("a").then((value) => results.push(\`1:\${value}\`));
      void run("b").then((value) => results.push(\`2:\${value}\`));
      time.advance(100);
      await drain();

    ${indent(routing.note, 2)}
      expect(results).toEqual(${routing.expected});
    });
  `;

  return dedent`
    describe("${n.debounce} results", () => {
      ${indent(shared, 0).trim()}

      it("hands the function's own failure to every caller", async () => {
        const time = clock();
        const boom = new Error("boom");
        const run = ${n.debounce}(
          () => {
            throw boom;
          },
        ${indent(inlineOptions(shape), 2)},
        );
        const seen: unknown[] = [];

        void run().catch((error: unknown) => seen.push(error));
        void run().catch((error: unknown) => seen.push(error));
        time.advance(100);
        await drain();

        // Identity, not a message match: what matters is that the function's own error arrives
        // unwrapped, and one replaced by an error of the wrapper's own would pass the obvious test.
        expect(seen).toEqual([boom, boom]);
      });

      it("${reentrancy.title}", async () => {
        const time = clock();
        const calls: string[] = [];
        const told: Record<string, string> = {};
        let reentered = false;

        const run: (value: string) => Promise<string> = ${n.debounce}(
          (value: string): string => {
            calls.push(value);

            // A call from inside the function it wraps. Contrived-looking and not rare: any
            // invocation that touches the state the caller is reacting to reaches here.
            if (!reentered) {
              reentered = true;
              void run("inner").then((result) => {
                told["inner"] = result;
              });
            }

            return value;
          },
        ${indent(inlineOptions(shape), 2)},
        );

        void run("outer").then((result) => {
          told["outer"] = result;
        });
        time.advance(100);
        await drain();
        expect(calls).toEqual(${reentrancy.firstCalls});

        time.advance(100);
        await drain();
        expect(calls).toEqual(${reentrancy.finalCalls});

      ${indent(reentrancy.note, 2)}
        // Keyed rather than listed, because two callers settling from one promise settle in the
        // order their handlers were attached, which is not the order worth asserting.
        expect(told).toEqual(${reentrancy.told});
      });
    });
  `;
}

function errorSinkCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.debounce} failures", () => {
      it("reports a failure to the handler", async () => {
        const time = clock();
        const boom = new Error("boom");
        const failures: unknown[] = [];
        const run = ${n.debounce}(
          () => {
            throw boom;
          },
        ${indent(inlineOptions(shape, "(error: unknown) => {\n    failures.push(error);\n  }"), 2)},
        );

        run();
        time.advance(100);
        await drain();

        // Nothing is returned here, so this is the only route a failure has. Dropped instead, it
        // would be an unhandled rejection — which on Node ends the process rather than being
        // ignored, and does so far from the call that caused it.
        expect(failures).toEqual([boom]);
      });
    });
  `;
}

function ceilingCases(shape: Shape): string {
  const n = shape.names;

  const leadingNote = when(
    shape.edge === "leading",
    dedent`

      it("has nothing to release under a leading edge", async () => {
        const { clock: time, recorded, run } = harness(100, 250);

        for (let tick = 0; tick < 10; tick += 1) {
          ${call(shape, '`t${String(tick)}`')};
          time.advance(60);
        }
        await drain();

        // The burst's one invocation already happened at its first call, so the ceiling has no
        // suppressed call to let through. Asserted rather than assumed: a ceiling that invoked here
        // would turn this edge into a throttle without anyone asking for one.
        expect(recorded.calls).toEqual(["t0"]);
      });
    `,
  );

  const serving = when(
    shape.trailingEdge,
    dedent`

      it("invokes a caller who never goes quiet", async () => {
        const { clock: time, recorded, run } = harness(100, 250);

        // Never quiet for a whole wait, which is the case a plain debounce never serves at all.
        for (let tick = 0; tick < 5; tick += 1) {
          ${call(shape, '`t${String(tick)}`')};
          time.advance(60);
        }
        await drain();

        expect(recorded.calls.length > ${shape.edge === "both" ? "1" : "0"}).toBe(true);
      });

      it("invokes at the ceiling interval, repeatedly", async () => {
        const { clock: time, recorded, run } = harness(100, 250);

        for (let tick = 0; tick < 13; tick += 1) {
          ${call(shape, '`t${String(tick)}`')};
          time.advance(60);
        }
        await drain();

        // Ticks that do not divide the ceiling, deliberately. With calls landing exactly on it, a
        // ceiling re-armed from the next call and one re-armed from its own expiry agree — which is
        // how the first version of this case passed against an implementation that drifted.
        expect(recorded.times).toEqual([${shape.edge === "both" ? "0, 250, 500, 750" : "250, 500, 750"}]);
      });
    `,
  );

  return dedent`
    describe("${n.debounce} ceiling", () => {${serving}${leadingNote}
      it("refuses a ceiling below the wait", () => {
        expect(() =>
          ${n.debounce}(() => undefined, {
            waitMs: 100,
            maxWaitMs: 50,
        ${when(!shape.awaited, "      onError: () => undefined,\n")}      }),
        ).toThrow(/at least as large/);
      });
    });
  `;
}

function controlCases(shape: Shape): string {
  const n = shape.names;

  const rejection = when(
    shape.awaited && shape.trailingEdge,
    dedent`

      it("tells a waiting caller that their call was cancelled", async () => {
        const { run } = harness();
        const seen: unknown[] = [];

      ${when(
        shape.edge === "both",
        dedent`
          // The first call is invoked by the leading edge and settled from it, so it is the *second*
            // that is left waiting and therefore the only one a cancellation has anything to tell.
            ${call(shape, '"a"')};
        `,
      )}  void run("b").catch((error: unknown) => seen.push(error));
        run.cancel();
        await drain();

        // Rejected, not resolved. Resolving would need a value of the function's own return type,
        // and there is none to give.
        expect(seen.length).toBe(1);
        expect(seen[0]).toBeInstanceOf(${n.cancelled});
      });
    `,
  );

  const flushCase = when(
    shape.trailingEdge,
    dedent`

      it("runs the pending call now when flushed", async () => {
        const { clock: time, recorded, run } = harness();

      ${when(
        shape.edge === "both",
        dedent`
          // Two calls, because under this edge the first one has already been invoked by the leading
          // edge and there would be nothing pending for a flush to run.
            ${call(shape, '"a"')};
            await drain();
            const before = recorded.calls.length;
            ${call(shape, '"b"')};
        `,
        `  ${call(shape, '"a"')};`,
      )}
        run.flush();
        await drain();

        expect(recorded.calls${shape.edge === "both" ? ".length" : ""}).toEqual(${shape.edge === "both" ? "before + 1" : '["a"]'});

        // Before advancing, because advancing fires the very timer this is looking for. A flush
        // that ran the call without stopping the timer leaves one scheduled, and in Node that keeps
        // the process alive long after the work is done.
        expect(time.liveTimers()).toBe(0);

        time.advance(100);
        await drain();
        expect(recorded.calls.length).toBe(${shape.edge === "both" ? "before + 1" : "1"});
      });
    `,
  );

  return dedent`
    describe("${n.debounce} controls", () => {
      it("drops the pending call when cancelled", async () => {
        const { clock: time, recorded, run } = harness();
        ${when(shape.leadingEdge, "const before = recorded.calls.length;\n      ")}${call(shape, '"a"')};
        run.cancel();

        expect(time.liveTimers()).toBe(0);
        expect(run.pending()).toBe(false);

        time.advance(100);
        await drain();
        expect(recorded.calls.length).toBe(${shape.leadingEdge ? "before + 1" : "0"});
      });
    ${rejection}${flushCase}
      it("is harmless to flush with nothing pending", async () => {
        const { recorded, run } = harness();

        run.flush();
        await drain();

        expect(recorded.calls).toEqual([]);
      });
    });
  `;
}

function validationCases(shape: Shape): string {
  const n = shape.names;
  const extras = joinLines(
    when(shape.ceiling, "      maxWaitMs: 500,"),
    when(!shape.awaited, "      onError: () => undefined,"),
  );

  return dedent`
    describe("${n.debounce} arguments", () => {
      it("refuses a wait that is not a duration", () => {
        for (const waitMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(() =>
            ${n.debounce}(() => undefined, {
              waitMs,
    ${extras}
            }),
          ).toThrow(/non-negative finite/);
        }
      });
    });
  `;
}
