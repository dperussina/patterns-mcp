/**
 * The `typed-emitter` pattern: an emitter whose event map is enforced.
 *
 * The type-level result worth reporting here is a negative one. Nearly every published typed emitter
 * carries an internal cast — usually `as never` — at the point of dispatch, because the handler registry
 * is a `Map` keyed by the union of event names and the compiler cannot see that the handlers found under
 * one key belong to that key. Keying a *mapped type* by the event name instead keeps the correspondence,
 * so an indexed lookup at `K extends keyof E` yields exactly that event's handler type, and no cast
 * appears anywhere in what this emits. Verified at every strictness the engine generates for.
 *
 * The rest of the type story was checked rather than assumed. An unknown event name, a payload of the
 * wrong type, and too few arguments are each refused; so is a handler whose parameters disagree with the
 * payload. A handler that *ignores* part of the payload is accepted, which is ordinary function
 * assignability rather than an oversight, and is worth knowing before someone tries to forbid it.
 * Payloads are variadic tuples with named elements, which puts parameter names at the call site and lets
 * a zero-argument event emit with no arguments.
 *
 * Three run-time decisions were settled with a prototype, each a place emitters are commonly wrong.
 * The handler list is snapshotted before dispatch, so a handler registered by another handler does not
 * run in the dispatch that registered it — the alternative is a loop that feeds itself. A handler removed
 * during dispatch does not run either, which takes a membership check on top of the snapshot and is worth
 * it, because a subscriber tearing itself down mid-dispatch has said it wants no more events and the
 * copied-array implementations deliver one anyway. And `once` is a flag on the registration rather than a
 * wrapper around the handler: a wrapper has an identity the caller never saw, so `off` with the original
 * function would find nothing and silently do nothing at all.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, sections, when } from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const typedEmitterPattern: PatternModule = {
  name: "typed-emitter",

  /**
   * The emitter class itself. An entity of `TypedEmitter` derives the same name by collapse — the noun
   * is already there — so the caller would be asking for a class that declares and extends itself.
   */
  emits: ["TypedEmitter"],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      asynchronous: options.dispatch === "async",
      isolate: options.errors !== "propagate",
      names: namesFor(context),
    };
    const n = shape.names;

    const files: RenderedFile[] = [
      { path: `${n.stem}.ts`, role: "core", contents: core(shape) },
      { path: `${n.stem}-example.ts`, role: "example", contents: example(context, shape) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${n.stem}${TYPE_TEST_SUFFIX}`,
        role: "test",
        contents: typeTests(context, shape),
      });
      files.push({ path: `${n.stem}.test.ts`, role: "test", contents: tests(context, shape) });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  /** `dispatch: "async"` — `emit` returns a promise that settles once every handler has. */
  readonly asynchronous: boolean;
  /** `errors: "isolate"` — every handler runs, and failures go to the caller's sink. */
  readonly isolate: boolean;
  readonly names: Names;
}

interface Names {
  readonly stem: string;
  readonly subject: string;
  readonly lower: string;
  readonly events: string;
  readonly emitter: string;
  readonly generic: string;
  readonly handler: string;
  readonly name: string;
  readonly options: string;
  /** The constraint an event map has to satisfy, spelled once and used in four places. */
  readonly bound: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const subject = entity?.pascal ?? "Subject";
  const kebab = entity?.kebab ?? "subject";

  // Through `withNoun`, because `Event` is the likeliest subject anyone asks an emitter to carry and
  // appending these nouns to it gave `EventEvents` and `EventEventName`.
  const suffixed = (noun: string): string =>
    entity === undefined ? `${subject}${noun}` : withNoun(entity, noun).pascal;

  return {
    stem: entity === undefined ? `${kebab}-emitter` : withNoun(entity, "Emitter").kebab,
    subject,
    lower: entity?.camel ?? "subject",
    events: suffixed("Events"),
    emitter: suffixed("Emitter"),
    generic: "TypedEmitter",
    handler: "EventHandler",
    name: suffixed("EventName"),
    options: "EmitterOptions",
    bound: "Record<keyof E, readonly unknown[]>",
  };
}

/** `void` or `Promise<void>`, which is the difference `dispatch` makes to every signature. */
function returned(shape: Shape, type: string): string {
  return shape.asynchronous ? `Promise<${type}>` : type;
}

function core(shape: Shape): string {
  return sections(
    eventMap(shape),
    handlerType(shape),
    registryType(shape),
    when(shape.isolate, optionsType(shape)),
    emitterClass(shape),
  );
}

function eventMap(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "Every event, and what it carries.",
        "The one declaration everything else is derived from. Adding an event here is enough to make it emittable and subscribable; nothing needs to be registered anywhere, and no string is written twice.",
        "Payloads are tuples rather than single objects, because a tuple is the general case — a single payload is a tuple of one — and because naming the elements puts those names in front of a caller writing the handler. A tuple may be empty, and an event declared that way emits with no arguments at all.",
      ],
      dedent`
        export interface ${n.events} {
          readonly opened: [];
          readonly paid: [id: string, amount: number];
          readonly cancelled: [id: string, reason: string];
        }
      `,
    ),
    documented(
      ["The names, derived rather than repeated."],
      dedent`
        export type ${n.name} = keyof ${n.events};
      `,
    ),
  );
}

function handlerType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "What a subscriber looks like.",
      ...(shape.asynchronous
        ? [
            "The return type admits a promise, which is the point of asynchronous dispatch: a handler that does asynchronous work can say so, and `emit` will wait for it.",
            "It has one consequence worth knowing before it is met, because the error is puzzling otherwise. A bare `void` return type accepts a function returning *anything* — a special rule, and the reason `() => array.push(x)` is ordinarily a legal handler. A union return type does not get that rule, so under asynchronous dispatch the same concise handler is refused for returning a number, and so is `async () => array.push(x)`. Braces around the body fix both, and the restriction is kept rather than widened to `unknown` because a handler is called for its effects and should not look as though it computes something the emitter will use.",
          ]
        : [
            "The return type is `void`, which accepts a function returning anything — including a promise. That is worth being explicit about, because it is the one hole in synchronous dispatch: an `async` handler will run, `emit` will not wait for it, and a rejection inside it will go unobserved. Asynchronous dispatch exists for that case.",
          ]),
      "A handler may declare fewer parameters than the event carries, which is ordinary function assignability rather than an oversight — a subscriber that only needs the first field should not have to name the rest.",
    ],
    dedent`
      export type ${n.handler}<Payload extends readonly unknown[]> = (
        ...payload: Payload
      ) => ${shape.asynchronous ? "void | Promise<void>" : "void"};
    `,
  );
}

function registryType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Where the subscriptions live.",
      `The load-bearing choice in this file, and the reason nothing here contains a cast. A \`Map\` keyed by the union of event names would lose the correspondence between a key and its payload, so the handlers found under one name would have the handler type of *every* name and dispatch would need an \`as never\` to call one — which is how most implementations of this are written. A mapped type keeps the pairing, so an index at \`K extends keyof E\` yields exactly that event's handler type and the call typechecks on its own.`,
      "Being generic in the event map is part of what makes that work, and it is not obvious: specialise this to one map and *reading* still checks, while *writing* stops, because at a generic key the compiler has to satisfy every member the key could name at once. That is the version most emitters cast their way out of. Keeping the map a parameter and fixing it in a subclass below costs one declaration and removes the need.",
      "The value is a `Map` from handler to whether it was registered for a single delivery. That is what makes `once` a property of the registration rather than a wrapper around the function: a wrapper would have an identity the caller never saw, and `off` with the original function would find nothing and silently succeed. Insertion order is preserved, so registration order is dispatch order.",
    ],
    dedent`
      type Registry<E extends ${n.bound}> = {
        [K in keyof E]?: Map<${n.handler}<E[K]>, boolean>;
      };
    `,
  );
}

function optionsType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Where isolated failures go.",
      "Required rather than optional, and that is deliberate: isolation means a subscriber can fail without the emitter or the other subscribers noticing, which is only safe if the failure is reported somewhere. A default would make the silence the easy path.",
    ],
    dedent`
      export interface ${n.options}<E extends ${n.bound}> {
        readonly onError: (error: unknown, event: keyof E) => void;
      }
    `,
  );
}

function emitterClass(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The emitter.",
        "Generic in its event map rather than tied to one, which is what keeps the registry free of casts, and reusable as a side effect: a second set of events needs another subclass and nothing else.",
        "The surface is deliberately small: subscribe, subscribe once, unsubscribe, emit, and count. Anything else an emitter is sometimes given — wildcards, event inheritance, removing every listener at once — either cannot be typed without giving up what the event map buys, or is a convenience that hides which subscriptions were dropped.",
      ],
      emitterBody(shape),
    ),
    documented(
      [
        `The emitter for ${n.events}.`,
        "A subclass rather than a type alias, so that it can be constructed by name. This is the only place the event map is named, and the only type a caller needs.",
      ],
      dedent`
        export class ${n.emitter} extends ${n.generic}<${n.events}> {}
      `,
    ),
  );
}

function emitterBody(shape: Shape): string {
  const n = shape.names;

  const call = shape.isolate
    ? dedent`
        try {
                ${shape.asynchronous ? "await " : ""}handler(...payload);
              } catch (error) {
                this.onError(error, event);
              }
      `
    : `${shape.asynchronous ? "await " : ""}handler(...payload);`;

  return dedent`
      export class ${n.generic}<E extends ${n.bound}> {
        private readonly registry: Registry<E> = {};
      ${
        shape.isolate
          ? `  private readonly onError: (error: unknown, event: keyof E) => void;\n\n    constructor(options: ${n.options}<E>) {\n      this.onError = options.onError;\n    }\n`
          : ""
      }
        /**
         * Subscribes, and returns the way to stop.
         *
         * The returned function is the reliable way to unsubscribe, because it closes over both the event
         * and the handler and so cannot be called with the wrong pair. \`off\` exists for the case where the
         * subscription and the teardown are too far apart to share a closure.
         */
        on<K extends keyof E>(event: K, handler: ${n.handler}<E[K]>): () => void {
          return this.add(event, handler, false);
        }

        /** Subscribes for one delivery. Removed before it is called, so it runs once even if it throws. */
        once<K extends keyof E>(event: K, handler: ${n.handler}<E[K]>): () => void {
          return this.add(event, handler, true);
        }

        /** Unsubscribes. Silent when the handler was not subscribed, which is the useful behaviour for teardown. */
        off<K extends keyof E>(event: K, handler: ${n.handler}<E[K]>): void {
          this.registry[event]?.delete(handler);
        }

        /** How many handlers would run. Mostly for tests, where it is the only way to see a removal happened. */
        listenerCount(event: keyof E): number {
          return this.registry[event]?.size ?? 0;
        }

        /**
         * Announces an event to everyone subscribed to it.
         *
         * ${
           shape.asynchronous
             ? "Handlers are awaited one at a time, in registration order, so that order means what it appears to and a handler can rely on the ones before it having finished. `Promise.all` over the snapshot would be faster and would give up both of those; it belongs here if throughput matters more than sequence."
             : "Returns nothing, so the emitting code is not coupled to what its subscribers do. That is the usual reason to reach for an emitter, and the cost is that an asynchronous handler's work is not waited for."
         }
         */
        ${shape.asynchronous ? "async " : ""}emit<K extends keyof E>(
          event: K,
          ...payload: E[K]
        ): ${returned(shape, "void")} {
          const registered = this.registry[event];
          if (registered === undefined) return;

          // Snapshotted before anything is called, so a handler that subscribes during dispatch is not
          // called by the dispatch that created it — which would otherwise be a loop that feeds itself.
          const snapshot = [...registered];

          // Single-delivery registrations are dropped up front rather than after being called, so \`once\`
          // means at most once even if the handler throws.
          for (const [handler, once] of snapshot) if (once) registered.delete(handler);

          for (const [handler, once] of snapshot) {
            // A handler removed during this dispatch does not run. The snapshot alone would deliver to it,
            // which is what the copied-array implementations do; a subscriber that has torn itself down has
            // said it wants no more events, and an emit already under way is no exception. The entries
            // removed just above are exempt, since they are meant to be called exactly here.
            if (!once && !registered.has(handler)) continue;

            ${call}
          }
        }

        private add<K extends keyof E>(
          event: K,
          handler: ${n.handler}<E[K]>,
          once: boolean,
        ): () => void {
          const handlers = this.registry[event] ?? new Map<${n.handler}<E[K]>, boolean>();
          handlers.set(handler, once);
          this.registry[event] = handlers;

          return () => {
            handlers.delete(handler);
          };
        }
      }
  `;
}

/** How an emitter is built, which is the whole of what `errors` changes at a call site. */
function construction(shape: Shape): string {
  return shape.isolate
    ? `new ${shape.names.emitter}({ onError: report })`
    : `new ${shape.names.emitter}()`;
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const awaited = shape.asynchronous ? "await " : "";

  return sections(
    dedent`
      /**
       * Subscribing, emitting, and the things that will not compile.
       *
       * The refusals at the end are assertions rather than illustrations: \`@ts-expect-error\` is satisfied by
       * an error and violated by silence, so each states that the line below it must not compile. They are
       * emitted whether or not tests were asked for, because they are the entire reason to reach for a typed
       * emitter over an untyped one and no suite that runs can check any of them.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.emitter],
      types: [n.name],
    }),
    when(
      shape.isolate,
      documented(
        [
          "Where a subscriber's failure is reported.",
          "Isolation is only defensible if this exists. A handler that throws is not the emitter's fault and must not become the emitting code's problem, but it is still a fault, and somewhere has to hear about it.",
        ],
        dedent`
          function report(error: unknown, event: ${n.name}): void {
            console.error(\`handler for \${event} failed\`, error);
          }
        `,
      ),
    ),
    documented(
      [
        "Subscribing.",
        "The handler's parameters are named and typed from the event map, with nothing annotated here: `id` is a `string` and `amount` is a `number` because the map says so, and a handler that expected otherwise would not compile.",
      ],
      dedent`
        export const ${n.lower}s = ${construction(shape)};

        export const stopWatchingPayments = ${n.lower}s.on("paid", (id, amount) => {
          console.log(\`\${id} paid \${String(amount)}\`);
        });

        // A handler is free to ignore what it does not need, including all of it.
        export const stopWatchingOpens = ${n.lower}s.on("opened", () => {
          console.log("opened");
        });
      `,
    ),
    documented(
      [
        "Emitting.",
        ...(shape.asynchronous
          ? [
              "`emit` returns a promise, so it must be awaited — an un-awaited call is a floating promise, and with isolated errors it is also the only thing that knows the handlers finished.",
            ]
          : [
              "`emit` returns nothing, so the emitting code neither waits for its subscribers nor learns what they did.",
            ]),
      ],
      dedent`
        export ${shape.asynchronous ? "async " : ""}function record(
          id: string,
          amount: number,
        ): ${returned(shape, "void")} {
          ${awaited}${n.lower}s.emit("paid", id, amount);

          // A zero-argument event takes no arguments at all.
          ${awaited}${n.lower}s.emit("opened");
        }
      `,
    ),
    documented(
      [
        "Unsubscribing.",
        "Two ways, for two situations. The function returned by `on` cannot be called with the wrong event or the wrong handler, because it closes over both, and is what to use where the subscription and its teardown are near each other. `off` is for where they are not.",
      ],
      dedent`
        export function stopEverything(handler: (id: string, reason: string) => void): void {
          stopWatchingPayments();
          stopWatchingOpens();
          ${n.lower}s.off("cancelled", handler);
        }
      `,
    ),
    exampleRefusals(shape),
  );
}

function exampleRefusals(shape: Shape): string {
  const n = shape.names;
  const awaited = shape.asynchronous ? "await " : "";

  return sections(
    dedent`
      /*
       * The refusals, asserted.
       *
       * Each directive sits alone on its line with the reason above it, because a directive governs only the
       * line it begins on and a long comment gets re-wrapped by the formatter.
       *
       * Where the mistake is one argument of a call, the directive sits inside the argument list, above
       * that argument. Above the whole call it would hold only until the call grew wide enough to wrap —
       * which a long enough type name is sufficient to cause — and then the error is reported against the
       * argument's own line while the directive governs the receiver's, so the assertion inverts into two
       * errors: the escaped mistake, and a directive with nothing to suppress. A comment among arguments
       * also keeps the formatter from collapsing them, so the shape holds for a short name too.
       */
    `,
    dedent`
      export ${shape.asynchronous ? "async " : ""}function refusesAnUnknownEvent(): ${returned(shape, "void")} {
        // The typo that an untyped emitter accepts in silence, subscribing to or announcing something no
        // one will ever hear. Here it is a compile error at the line that has it.
        ${awaited}${n.lower}s.emit(
          // @ts-expect-error
          "payed",
          "A-1",
          100,
        );
      }
    `,
    dedent`
      export ${shape.asynchronous ? "async " : ""}function refusesAMistypedPayload(): ${returned(shape, "void")} {
        // The amount is a number, and a string that looks like one is not it.
        ${awaited}${n.lower}s.emit(
          "paid",
          "A-1",
          // @ts-expect-error
          "100",
        );
      }
    `,
    dedent`
      export ${shape.asynchronous ? "async " : ""}function refusesAnIncompletePayload(): ${returned(shape, "void")} {
        // Every element the tuple declares is required. An emitter that let this through would call its
        // handlers with \`undefined\` where they were promised a number.
        // @ts-expect-error
        ${awaited}${n.lower}s.emit("paid", "A-1");
      }
    `,
    dedent`
      export function refusesAMismatchedHandler(): void {
        // The first element of the payload is a string. A handler declaring it otherwise is refused here
        // rather than at the moment the event is announced.
        ${n.lower}s.on(
          "paid",
          // @ts-expect-error
          (id: number) => {
            console.log(id);
          },
        );
      }
    `,
    dedent`
      export function refusesASurplusParameter(): void {
        // Fewer parameters than the payload is fine; more is not, since there would be nothing to pass.
        ${n.lower}s.on(
          "cancelled",
          // @ts-expect-error
          (id: string, reason: string, extra: string) => {
            console.log(id, reason, extra);
          },
        );
      }
    `,
    when(
      !shape.isolate,
      dedent`
        export function refusesAnErrorSink(): void {
          // Errors propagate in this rendering, so there is nowhere for a sink to go. Asserted rather than
          // left implicit, because passing one and having it ignored is the failure worth preventing.
          // @ts-expect-error
          new ${n.emitter}({ onError: () => undefined });
        }
      `,
    ),
    when(
      shape.isolate,
      dedent`
        export function refusesAMissingErrorSink(): void {
          // Isolation without a sink is silence, so the sink is required rather than defaulted.
          // @ts-expect-error
          new ${n.emitter}();
        }
      `,
    ),
  );
}
function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * What the compiler is asked to prove.
       *
       * Nothing here runs. The suffix keeps the file out of every runner while leaving it in front of the
       * compiler, which is the only thing that can check these claims — an emitter whose payload types had
       * quietly widened to \`unknown\` would deliver exactly the same values at run time.
       *
       * No claim below concerns nullability. Bundles are verified at every strictness, and with
       * \`strictNullChecks\` off \`undefined\` is assignable to everything, so such an assertion would mean one
       * thing for one caller and the opposite for another.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.emitter],
      types: [n.events, n.handler, n.name],
    }),
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    dedent`
      /**
       * The payload types reach the handler's parameters.
       *
       * The claim the whole pattern rests on, stated where it can be checked: the tuple in the event map is
       * exactly what a handler for that event receives.
       */
      export type PaidPayload = Expect<Equal<${n.events}["paid"], [id: string, amount: number]>>;
      export type OpenedPayloadIsEmpty = Expect<Equal<${n.events}["opened"], []>>;
    `,
    dedent`
      /**
       * The event names are closed.
       *
       * \`NotAssignable\` rather than a directive, because this states something about the type itself rather
       * than about one line that uses it: no string outside the map is a name, so nothing can subscribe to
       * an event that does not exist.
       */
      export type NamesAreClosed = Expect<Equal<${n.name}, "opened" | "paid" | "cancelled">>;
      export type ArbitraryStringIsNotAName = Expect<NotAssignable<"payed", ${n.name}>>;
    `,
    dedent`
      /**
       * A handler may take fewer parameters than the event carries, and not more.
       *
       * Both directions, because the permissive half is often mistaken for a defect and the restrictive half
       * is what actually protects the handler: there would be nothing to pass a fourth parameter.
       */
      export type FewerParametersAccepted = Expect<
        Extends<() => void, ${n.handler}<${n.events}["paid"]>>
      >;
      export type SurplusParametersRefused = Expect<
        NotAssignable<
          (id: string, amount: number, extra: string) => void,
          ${n.handler}<${n.events}["paid"]>
        >
      >;
    `,
    dedent`
      /**
       * Unsubscribing is returned, not described.
       *
       * A small claim with a practical point: the value \`on\` hands back is callable with no arguments, so a
       * caller cannot get the event or the handler wrong when tearing the subscription down.
       */
      declare const ${n.lower}s: ${n.emitter};
      export type SubscribingReturnsATeardown = Expect<
        Equal<ReturnType<${n.emitter}["on"]>, () => void>
      >;
    `,
    dedent`
      /**
       * ${
         shape.asynchronous
           ? "Emitting is awaitable, and a handler may be asynchronous."
           : "Emitting returns nothing, and a handler's return value is discarded."
       }
       *
       * ${
         shape.asynchronous
           ? "The second half is what asynchronous dispatch is for: without it a promise-returning handler would be accepted and never waited for."
           : "Stated because it is the one hole in this rendering — an `async` handler is accepted here, and `emit` will not wait for it, so a rejection inside it goes unobserved. Asynchronous dispatch is the rendering that closes it."
       }
       */
      export type EmitReturns = Expect<
        Equal<ReturnType<${n.emitter}["emit"]>, ${returned(shape, "void")}>
      >;
      export type AsyncHandlerAccepted = Expect<
        Extends<() => Promise<void>, ${n.handler}<${n.events}["opened"]>>
      >;
      void ${n.lower}s;
    `,
  );
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const awaited = shape.asynchronous ? "await " : "";
  const asyncTest = shape.asynchronous ? "async " : "";

  const framework =
    conventions.testFramework === "node-test"
      ? sections(
          importsFrom(conventions, "node:test", { values: ["describe", "it"] }),
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), { values: ["expect"] }),
        )
      : importsFrom(conventions, "vitest", { values: ["describe", "expect", "it"] });

  return sections(
    dedent`
      /**
       * What is left for a suite that runs.
       *
       * Not the payload types, which are settled before this file executes and asserted in
       * \`${n.stem}${TYPE_TEST_SUFFIX}\`. What remains is the behaviour no type can describe: who is called,
       * in what order, exactly once, and what happens to the rest when one of them fails.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), { values: [n.emitter] }),
    dedent`
      /**
       * A recorder for what handlers saw.
       *
       * \`note\` returns \`void\`, which is why every handler below can be a concise arrow: pushing to the
       * array directly would return its new length, and under asynchronous dispatch the handler type does
       * not accept a returned value. See the note on that type.
       */
      function recorder(): { readonly seen: string[]; readonly note: (line: string) => void } {
        const lines: string[] = [];

        return {
          seen: lines,
          note: (line) => {
            lines.push(line);
          },
        };
      }
    `,
    dedent`
      /**
       * An emitter for the cases that are not about failure.
       *
       * ${
         shape.isolate
           ? "The sink rethrows rather than ignoring, because a handler failing in a test about delivery order is a fact that test needs to hear. Swallowing it would turn a broken handler into a mysteriously short list."
           : "Failures propagate in this rendering, so there is nothing to configure."
       }
       */
      function emitter(): ${n.emitter} {
        return new ${n.emitter}(${
          shape.isolate
            ? `{
          onError: (error) => {
            throw error;
          },
        }`
            : ""
        });
      }
    `,
    when(
      shape.isolate,
      dedent`
        /** A sink that records rather than reports, so a test can assert what reached it. */
        function collector(): {
          readonly failures: unknown[];
          readonly onError: (error: unknown) => void;
        } {
          const failures: unknown[] = [];

          return { failures, onError: (error) => failures.push(error) };
        }
      `,
    ),
    dedent`
      describe("subscribing and emitting", () => {
        it("delivers the payload to every subscriber", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();

          ${n.lower}s.on("paid", (id, amount) => note(\`a:\${id}:\${String(amount)}\`));
          ${n.lower}s.on("paid", (id) => note(\`b:\${id}\`));
          ${awaited}${n.lower}s.emit("paid", "A-1", 100);

          expect(seen).toEqual(["a:A-1:100", "b:A-1"]);
        });

        it("delivers in registration order", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();

          for (const label of ["first", "second", "third"]) {
            ${n.lower}s.on("opened", () => note(label));
          }
          ${awaited}${n.lower}s.emit("opened");

          expect(seen).toEqual(["first", "second", "third"]);
        });

        it("does nothing for an event with no subscribers", ${asyncTest}() => {
          const ${n.lower}s = emitter();

          ${awaited}${n.lower}s.emit("opened");

          expect(${n.lower}s.listenerCount("opened")).toBe(0);
        });

        it("registers a handler once, however many times it is added", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();
          const handler = (): void => note("x");

          ${n.lower}s.on("opened", handler);
          ${n.lower}s.on("opened", handler);
          ${awaited}${n.lower}s.emit("opened");

          expect(seen).toEqual(["x"]);
          expect(${n.lower}s.listenerCount("opened")).toBe(1);
        });
      });
    `,
    dedent`
      describe("unsubscribing", () => {
        it("stops delivery through the returned teardown", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();
          const stop = ${n.lower}s.on("opened", () => note("x"));

          stop();
          ${awaited}${n.lower}s.emit("opened");

          expect(seen).toEqual([]);
          expect(${n.lower}s.listenerCount("opened")).toBe(0);
        });

        it("stops delivery through off", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();
          const handler = (): void => note("x");

          ${n.lower}s.on("opened", handler);
          ${n.lower}s.off("opened", handler);
          ${awaited}${n.lower}s.emit("opened");

          expect(seen).toEqual([]);
        });

        it("is silent about a handler that was never subscribed", () => {
          // Silence rather than a throw, because teardown often runs on a path that is not sure whether the
          // subscription happened, and an emitter that punished that would make every caller check first.
          const ${n.lower}s = emitter();

          ${n.lower}s.off("opened", () => undefined);

          expect(${n.lower}s.listenerCount("opened")).toBe(0);
        });
      });
    `,
    dedent`
      describe("once", () => {
        it("delivers exactly one time", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();

          ${n.lower}s.once("paid", (id) => note(id));
          ${n.lower}s.on("paid", (id) => note(\`always:\${id}\`));
          ${awaited}${n.lower}s.emit("paid", "A-1", 100);
          ${awaited}${n.lower}s.emit("paid", "A-2", 200);

          expect(seen).toEqual(["A-1", "always:A-1", "always:A-2"]);
        });

        it("can be cancelled before it ever fires", ${asyncTest}() => {
          const ${n.lower}s = emitter();
          const { seen, note } = recorder();
          const stop = ${n.lower}s.once("opened", () => note("x"));

          stop();
          ${awaited}${n.lower}s.emit("opened");

          expect(seen).toEqual([]);
        });
      });
    `,
    dispatchMutationTests(shape),
    errorTests(shape),
  );
}

function dispatchMutationTests(shape: Shape): string {
  const n = shape.names;
  const awaited = shape.asynchronous ? "await " : "";
  const asyncTest = shape.asynchronous ? "async " : "";

  return dedent`
    describe("a registry changed while it is being read", () => {
      it("does not deliver to a handler subscribed during the dispatch", ${asyncTest}() => {
        // The snapshot, asserted. Without it this dispatch would call the handler it just created, and a
        // handler that subscribes unconditionally would never stop.
        const ${n.lower}s = emitter();
        const { seen, note } = recorder();

        ${n.lower}s.on("opened", () => {
          note("first");
          ${n.lower}s.on("opened", () => note("added"));
        });
        ${n.lower}s.on("opened", () => note("second"));
        ${awaited}${n.lower}s.emit("opened");

        expect(seen).toEqual(["first", "second"]);

        // It is subscribed, though — the next dispatch reaches it.
        ${awaited}${n.lower}s.emit("opened");

        expect(seen).toEqual(["first", "second", "first", "second", "added"]);
      });

      it("does not deliver to a handler unsubscribed during the dispatch", ${asyncTest}() => {
        // The membership check, asserted. The snapshot alone would deliver here, which is what the
        // copied-array implementations do and is wrong: this handler has said it wants no more events.
        const ${n.lower}s = emitter();
        const { seen, note } = recorder();
        const doomed = (): void => note("doomed");

        ${n.lower}s.on("opened", () => {
          note("first");
          ${n.lower}s.off("opened", doomed);
        });
        ${n.lower}s.on("opened", doomed);
        ${awaited}${n.lower}s.emit("opened");

        expect(seen).toEqual(["first"]);
      });
    });
  `;
}

function errorTests(shape: Shape): string {
  const n = shape.names;
  const awaited = shape.asynchronous ? "await " : "";
  const asyncTest = shape.asynchronous ? "async " : "";
  const failing = shape.asynchronous
    ? `${n.lower}s.on("opened", async () => {\n          await Promise.resolve();\n          throw new Error("boom");\n        });`
    : `${n.lower}s.on("opened", () => {\n          throw new Error("boom");\n        });`;

  return shape.isolate
    ? dedent`
        describe("a failing subscriber", () => {
          it("does not stop the others, and is reported", ${asyncTest}() => {
            const sink = collector();
            const ${n.lower}s = new ${n.emitter}({ onError: sink.onError });
            const { seen, note } = recorder();

            ${n.lower}s.on("opened", () => note("before"));
            ${failing}
            ${n.lower}s.on("opened", () => note("after"));
            ${awaited}${n.lower}s.emit("opened");

            // The subscriber after the failure is the one that matters: it had nothing to do with the fault
            // and would have silently lost the event.
            expect(seen).toEqual(["before", "after"]);
            expect(sink.failures).toHaveLength(1);
          });

          it("does not become the emitting code's problem", ${asyncTest}() => {
            const sink = collector();
            const ${n.lower}s = new ${n.emitter}({ onError: sink.onError });

            ${failing}

            // Isolation means this returns normally. The failure is in the sink, not here.
            ${awaited}${n.lower}s.emit("opened");

            expect(sink.failures).toHaveLength(1);
          });

          it("is still removed when it was registered for one delivery", ${asyncTest}() => {
            const sink = collector();
            const ${n.lower}s = new ${n.emitter}({ onError: sink.onError });

            ${n.lower}s.once("opened", () => {
              throw new Error("boom");
            });
            ${awaited}${n.lower}s.emit("opened");

            // Removed before being called, so a throwing handler does not get a second chance.
            expect(${n.lower}s.listenerCount("opened")).toBe(0);
            expect(sink.failures).toHaveLength(1);
          });
        });
      `
    : sections(
        dedent`
          /**
           * The reason a call failed, or \`undefined\` if it did not.
           *
           * Written out rather than asserted with a matcher, for two reasons that happen to agree. The
           * verification sandbox's \`toThrow\` takes a \`RegExp\`, so a message would be matched loosely where
           * it can just as easily be compared; and that matcher is unavailable through the \`rejects\`
           * surface at all, since applied to a rejection reason it would mean "the reason is a function that
           * throws". Capturing keeps both dispatch renderings asserting the same thing the same way.
           */
          ${shape.asynchronous ? "async " : ""}function failureOf(
            run: () => ${returned(shape, "void")},
          ): ${returned(shape, "unknown")} {
            try {
              ${shape.asynchronous ? "await " : ""}run();

              return undefined;
            } catch (error) {
              return error;
            }
          }
        `,
        dedent`
          describe("a failing subscriber", () => {
            it("stops the dispatch and reaches the emitting code", ${asyncTest}() => {
              const ${n.lower}s = emitter();
              const { seen, note } = recorder();

              ${n.lower}s.on("opened", () => note("before"));
              ${failing}
              ${n.lower}s.on("opened", () => note("after"));

              const failure = ${shape.asynchronous ? "await " : ""}failureOf(() =>
                ${n.lower}s.emit("opened"),
              );

              expect((failure as Error).message).toBe("boom");

              // The subscriber after the failure did not run. That is the cost of propagation, and the
              // reason isolation exists.
              expect(seen).toEqual(["before"]);
            });

            it("is still removed when it was registered for one delivery", ${asyncTest}() => {
              const ${n.lower}s = emitter();

              ${n.lower}s.once("opened", () => {
                throw new Error("boom");
              });

              const failure = ${shape.asynchronous ? "await " : ""}failureOf(() =>
                ${n.lower}s.emit("opened"),
              );

              expect((failure as Error).message).toBe("boom");

              // Removed before being called, so a throwing handler does not get a second chance.
              expect(${n.lower}s.listenerCount("opened")).toBe(0);
            });
          });
        `,
      );
}
