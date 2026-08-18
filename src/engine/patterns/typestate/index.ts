/**
 * The `typestate` pattern: an object's state in its type, so the wrong operation is uncallable.
 *
 * Three findings from the compiler shaped what this emits, and each contradicted the version anyone would
 * write first.
 *
 * A state parameter that no member mentions is inert. `Thing<"idle">` and `Thing<"open">` are then
 * structurally identical, assign to each other in both directions, and every `this` constraint silently
 * stops applying — the pattern compiles, reads as though it works, and forbids nothing. So the state is
 * anchored by a real field rather than left phantom, which costs one readable property and removes the
 * failure mode entirely.
 *
 * Narrowing does not behave as it appears to. On a value typed `Order<OrderState>`, testing the state field
 * narrows the *field* and not the type argument, so the state-specific operations stay uncallable and a
 * caller has no way to reach them. On a union of instantiations the same test narrows properly. The two
 * types look interchangeable and are not, which is why the emitted `AnyOrder` is the union.
 *
 * And a `this`-constrained operation cannot be detached from its receiver — `const add = order.add` then
 * `add(...)` is an error — though it passes as a closure, so `map((order) => order.add(item))` is fine.
 *
 * The limit that cannot be closed is linearity. A transition consumes its input in the sense that the
 * result supersedes it, but TypeScript cannot stop the caller reaching for the original again, and
 * `order.submit()` twice type-checks perfectly. That is what `staleGuard` is for, and why it defaults on:
 * the compiler cannot express the constraint, so something at run time has to.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, sections, when } from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const typestatePattern: PatternModule = {
  name: "typestate",

  /** The type-level assertion helpers the `.test-d.ts` file is written with. See `specification`. */
  emits: ["Equal", "Expect", "NotAssignable"],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      parameterised: options.representation !== "distinct",
      staleGuard: options.staleGuard === true,
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
  /** `representation: "parameterised"` — one class carrying the state as a type argument. */
  readonly parameterised: boolean;
  readonly staleGuard: boolean;
  readonly names: Names;
}

interface State {
  readonly tag: string;
  /** The interface name in the distinct representation. */
  readonly type: string;
  /** The operation that arrives at this state. A verb, because `order.submitted()` reads as a question. */
  readonly verb: string;
  readonly doc: string;
}

interface Names {
  readonly stem: string;
  /** The class in the parameterised representation, and the name prefix in either. */
  readonly subject: string;
  readonly stateType: string;
  readonly anyType: string;
  readonly staleError: string;
  /**
   * The subject as a value name, for the transition parameters. Not
   * `subject.toLowerCase()`, which coincides with this only for a one-word
   * noun and otherwise runs the words together.
   */
  readonly camel: string;
  /** The subject as English, for the stale-transition message a caller reads. */
  readonly words: string;
  readonly states: readonly [State, State, State];
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const subject = entity?.pascal ?? "Workflow";
  const kebab = entity?.kebab ?? "workflow";

  return {
    // Carries this pattern's own noun, like every other pattern's stem does. It was the bare subject,
    // which is the one path any other pattern can also arrive at: every pattern that appends a noun
    // collapses it when the subject already ends in it, so a `typestate` `OrderId` and a `branded-type`
    // `OrderId` both wrote `order-id.ts` with different contents, and so did `OrderRepository`,
    // `OrderEmitter` and `Result` against their patterns. Unpacked into one directory, whichever
    // landed last won — the T130 failure, reached through the caller's noun rather than a shared file.
    // It also stops this pattern claiming `order.ts`, which is the name a caller's own domain type has.
    stem: entity === undefined ? kebab : withNoun(entity, "State").kebab,
    subject,
    camel: entity?.camel ?? "workflow",
    words: kebab.replaceAll("-", " "),
    // Not through `withNoun`, unlike its neighbours in other patterns. A `State` subject would
    // collapse to `State`, which is the name of the class in the parameterised representation: the
    // union and the class it ranges over cannot be the same name. `StateState` is the price of that,
    // and it compiles, which the collapse did not.
    stateType: `${subject}State`,
    anyType: `Any${subject}`,
    staleError: `Stale${subject}Error`,
    states: [
      {
        tag: "draft",
        type: `${subject}Draft`,
        verb: "draft",
        doc: "Still being assembled. Items can be added; nothing downstream can see it yet.",
      },
      {
        tag: "submitted",
        type: `${subject}Submitted`,
        verb: "submit",
        doc: "Fixed and awaiting payment. The contents are settled, so adding to it is no longer meaningful.",
      },
      {
        tag: "paid",
        type: `${subject}Paid`,
        verb: "pay",
        doc: "Settled. The only remaining operation is undoing it.",
      },
    ],
  };
}

/** A verb as the head of a type alias, which is PascalCase by convention. */
function capitalise(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function core(shape: Shape): string {
  return sections(
    stateType(shape),
    ...(shape.parameterised ? [] : shape.names.states.map((state) => stateInterface(shape, state))),
    anyType(shape),
    when(shape.staleGuard, staleErrorClass(shape)),
    when(shape.staleGuard, consumedRegistry(shape)),
    shape.parameterised ? subjectClass(shape) : distinctOperations(shape),
  );
}

function stateType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The states, and the order they occur in.",
      shape.parameterised
        ? "The bound on the class's parameter, so an instantiation with anything else is rejected at the point it is written rather than discovered when an operation is missing."
        : "Written out here as well as in each interface, because it is what the shared operations are keyed by.",
    ],
    `export type ${n.stateType} = ${n.states.map((state) => `"${state.tag}"`).join(" | ")};`,
  );
}

function stateInterface(shape: Shape, state: State): string {
  const n = shape.names;
  const isFirst = state === n.states[0];

  return documented(
    [
      state.doc,
      ...(isFirst
        ? [
            "The state field is a literal, which is what separates these types from one another and lets a value of unknown state be narrowed. It is also the pattern's weak point in this representation: an interface can be satisfied by any object literal, so nothing stops a caller writing a paid order into existence and skipping the workflow entirely. The parameterised representation closes that with a private constructor; here the operations are guarded and the states are not.",
          ]
        : []),
    ],
    dedent`
      export interface ${state.type} {
        readonly state: "${state.tag}";
        readonly items: readonly string[];
      }
    `,
  );
}

function anyType(shape: Shape): string {
  const n = shape.names;
  const members = shape.parameterised
    ? n.states.map((state) => `${n.subject}<"${state.tag}">`)
    : n.states.map((state) => state.type);

  return documented(
    shape.parameterised
      ? [
          `${n.subject} in any state, for the operations that do not care which.`,
          `A union of instantiations, and not \`${n.subject}<${n.stateType}>\` — which is what one would write, and which does not work. Testing the state field on a value of that type narrows the *field* and leaves the type argument alone, so every state-specific operation stays uncallable and a caller holding one has no route back to them. On this union the same test narrows the value, and the operations become available. The two spellings look interchangeable; only one of them can be narrowed.`,
        ]
      : [
          `${n.subject} in any state, for the operations that do not care which.`,
          "Narrowing by the state field works on this in the ordinary way, since it is an ordinary discriminated union.",
        ],
    `export type ${n.anyType} = ${members.join(" | ")};`,
  );
}

function staleErrorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A value whose transition has already been taken.",
      "Not a defensive check against a caller doing something absurd. It is the pattern's one genuine gap: a transition supersedes its input, and there is no way to say so in TypeScript, so this is where that constraint is enforced instead.",
    ],
    dedent`
      export class ${n.staleError} extends Error {
        readonly state: ${n.stateType};

        constructor(state: ${n.stateType}) {
          super(\`this ${n.words} has already left the "\${state}" state\`);
          this.name = "${n.staleError}";
          this.state = state;
        }
      }
    `,
  );
}

function consumedRegistry(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "Values that have already been transitioned.",
        "A `WeakSet` rather than a flag on the value, for two reasons that both matter. The types stay `readonly`, so nothing about the guard leaks into the shape a caller sees or has to serialise. And entries do not keep their keys alive, so a long-running process that transitions many values does not accumulate them here.",
      ],
      `const consumed = new WeakSet<object>();`,
    ),
    documented(
      [
        "Records that this value's transition has been taken, refusing a second one.",
        `Called by the transitions only. An operation that stays in its state derives a new value and leaves the original perfectly usable, which is ordinary value semantics and not something to guard against — what is guarded is a *state change* being taken twice.`,
      ],
      dedent`
        function take(subject: ${n.anyType}): void {
          if (consumed.has(subject)) {
            throw new ${n.staleError}(subject.state);
          }

          consumed.add(subject);
        }
      `,
    ),
  );
}
function subjectClass(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted, paid] = n.states;
  const self = n.subject;

  const take = (state: string): string =>
    shape.staleGuard ? `    take(this);\n\n    return new ${self}<"${state}">` : `    return new ${self}<"${state}">`;

  return documented(
    [
      `${n.subject}, with its state in its type.`,
      "The constructor is private, which is the half of this that is easy to leave out. Without it a caller can instantiate any state directly and the transitions become a suggestion; with it the only way to reach a state is to have come through the one before it.",
    ],
    dedent`
      export class ${self}<S extends ${n.stateType}> {
        /**
         * Anchors the type parameter.
         *
         * A parameter no member mentions is inert: the instantiations would be structurally identical,
         * assign to one another freely, and every \`this\` constraint below would stop applying — silently,
         * with everything still compiling. One readable field removes that entirely, and is worth having on
         * its own for logging and narrowing.
         */
        readonly state: S;
        readonly items: readonly string[];

        private constructor(state: S, items: readonly string[]) {
          this.state = state;
          this.items = items;
        }

        /** The only way in. */
        static ${draft.verb}(): ${self}<"${draft.tag}"> {
          return new ${self}<"${draft.tag}">("${draft.tag}", []);
        }

        /**
         * How many items, whatever the state.
         *
         * No \`this\` constraint, so this is callable on every instantiation and inside a function generic
         * over the state.
         */
        count(): number {
          return this.items.length;
        }

        /**
         * Adds an item, staying in ${draft.tag}.
         *
         * The \`this\` parameter is the constraint: it is not a runtime argument and callers never pass it,
         * it simply restricts what this method can be called on. Note that it derives a new value rather
         * than transitioning, so the receiver is not consumed.
         */
        add(this: ${self}<"${draft.tag}">, item: string): ${self}<"${draft.tag}"> {
          return new ${self}<"${draft.tag}">("${draft.tag}", [...this.items, item]);
        }

        /**
         * ${draft.tag} → ${submitted.tag}.
         *
         * A transition, so the result supersedes the receiver.${
           shape.staleGuard
             ? " `take` is what enforces that, since the type system cannot."
             : " Nothing enforces that the receiver is then abandoned — with `staleGuard` off, that is the caller's discipline."
         }
         */
        ${submitted.verb}(this: ${self}<"${draft.tag}">): ${self}<"${submitted.tag}"> {
      ${take(submitted.tag)}("${submitted.tag}", this.items);
        }

        /** ${submitted.tag} → ${paid.tag}. */
        ${paid.verb}(this: ${self}<"${submitted.tag}">): ${self}<"${paid.tag}"> {
      ${take(paid.tag)}("${paid.tag}", this.items);
        }

        /** Only once ${paid.tag}. */
        refund(this: ${self}<"${paid.tag}">): string {
          return \`refunded \${String(this.items.length)} items\`;
        }
      }
    `,
  );
}

function distinctOperations(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  const transition = (from: State, to: State): string =>
    documented(
      [
        `${from.tag} → ${to.tag}.`,
        ...(from === draft
          ? [
              shape.staleGuard
                ? "A transition, so the result supersedes the argument, and `take` enforces that because the type system cannot."
                : "A transition, so the result supersedes the argument — though nothing enforces that the argument is then abandoned, which with `staleGuard` off is the caller's discipline.",
            ]
          : []),
      ],
      dedent`
        export function ${to.verb}(${n.camel}: ${from.type}): ${to.type} {
        ${shape.staleGuard ? `  take(${n.camel});\n\n` : ""}  return { state: "${to.tag}", items: ${n.camel}.items };
        }
      `,
    );

  const subject = n.camel;

  return sections(
    documented(
      [
        "The only way in.",
        "A function rather than a literal at each call site, so that the initial state is written once. It is not a barrier, though — see the note on the first interface: an object literal can produce any of these states directly.",
      ],
      dedent`
        export function ${draft.verb}(): ${draft.type} {
          return { state: "${draft.tag}", items: [] };
        }
      `,
    ),
    documented(
      [
        "How many items, whatever the state.",
        `Takes \`${n.anyType}\`, which is what makes it callable on every state.`,
      ],
      dedent`
        export function count(${subject}: ${n.anyType}): number {
          return ${subject}.items.length;
        }
      `,
    ),
    documented(
      [
        `Adds an item, staying in ${draft.tag}.`,
        "The parameter type is the constraint. It derives a new value rather than transitioning, so the argument is not consumed.",
      ],
      dedent`
        export function add(${subject}: ${draft.type}, item: string): ${draft.type} {
          return { state: "${draft.tag}", items: [...${subject}.items, item] };
        }
      `,
    ),
    transition(draft, submitted),
    transition(submitted, paid),
    documented([`Only once ${paid.tag}.`], dedent`
      export function refund(${subject}: ${paid.type}): string {
        return \`refunded \${String(${subject}.items.length)} items\`;
      }
    `),
  );
}
function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  const imports = shape.parameterised
    ? importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: [n.subject],
        types: [n.anyType, n.stateType],
      })
    : importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: ["add", "count", draft.verb, paid.verb, "refund", submitted.verb],
        // Two of the four state types, because this file annotates almost nothing: every state below is
        // whatever the transition that produced it returns, which is the property being demonstrated. The
        // exception is the cross-state assignment among the refusals, where naming the target type is the
        // whole point of the case. All four were imported, and the two nobody writes were an import a
        // caller has to delete.
        types: [n.anyType, submitted.type],
      });

  return sections(
    dedent`
      /**
       * Working through the states, and the operations each one refuses.
       *
       * The refusals at the end are assertions, not illustrations: \`@ts-expect-error\` is satisfied by an
       * error and violated by silence, so each states that the line below it must not compile. This file is
       * emitted whether or not tests were asked for, because "the wrong operation is uncallable" is the
       * whole claim and an unasserted claim is a hope.
       *
       * A directive governs the line it begins on, so where the refused expression is an initialiser it
       * sits between the \`=\` and the expression rather than above the statement. Above the statement it
       * holds only while the statement fits one line: a long enough type name pushes the expression down,
       * the error is reported there, and the assertion inverts into two errors — the escaped mistake, and
       * a directive suppressing nothing.
       */
    `,
    imports,
    happyPath(shape),
    anyStateUse(shape),
    narrowing(shape),
    staleNote(shape),
    exampleRefusals(shape),
  );
}

function happyPath(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  return documented(
    shape.parameterised
      ? [
          "The whole workflow, in the order it has to happen.",
          "The chain reads as the state machine, and it cannot be written in any other order: each step's return type is the only thing the next step accepts.",
        ]
      : [
          "The whole workflow, in the order it has to happen.",
          "Each step's return type is the only thing the next accepts, so the order is forced. The cost of this representation is visible here — the steps nest or need naming, where methods would chain — and naming them is also what makes a stale value easy to reach for, since the earlier bindings stay in scope and stay valid.",
        ],
    shape.parameterised
      ? dedent`
          export function settle(): string {
            return ${n.subject}.${draft.verb}().add("widget").add("gasket").${submitted.verb}().${paid.verb}().refund();
          }
        `
      : dedent`
          export function settle(): string {
            const assembled = add(add(${draft.verb}(), "widget"), "gasket");
            const awaitingPayment = ${submitted.verb}(assembled);
            const settled = ${paid.verb}(awaitingPayment);

            return refund(settled);
          }
        `,
  );
}

function anyStateUse(shape: Shape): string {
  const n = shape.names;

  return documented(
    shape.parameterised
      ? [
          "An operation that does not care about the state.",
          `Generic in the state rather than taking \`${n.anyType}\`, which is the form to reach for when the return type depends on the argument's state — here it does not, but writing it this way keeps the caller's precise state rather than widening it away.`,
        ]
      : ["An operation that does not care about the state."],
    shape.parameterised
      ? dedent`
          export function describe<S extends ${n.stateType}>(subject: ${n.subject}<S>): string {
            return \`\${subject.state}: \${String(subject.count())} items\`;
          }
        `
      : dedent`
          export function describe(subject: ${n.anyType}): string {
            return \`\${subject.state}: \${String(count(subject))} items\`;
          }
        `,
  );
}

function narrowing(shape: Shape): string {
  const n = shape.names;
  const [draft, , paid] = n.states;

  return sections(
    documented(
    [
      "Recovering a specific state from a value that could be in any of them.",
      shape.parameterised
        ? `This is why \`${n.anyType}\` is a union of instantiations. Written as \`${n.subject}<${n.stateType}>\` the test below narrows the field and not the value, \`add\` stays uncallable, and there is no way from there back to a usable state — with nothing to indicate why.`
        : "An ordinary discriminated union, narrowed in the ordinary way.",
    ],
    shape.parameterised
      ? dedent`
          export function addIfStillOpen(subject: ${n.anyType}, item: string): ${n.anyType} {
            if (subject.state === "${draft.tag}") {
              return subject.add(item);
            }

            return subject;
          }
        `
      : dedent`
          export function addIfStillOpen(subject: ${n.anyType}, item: string): ${n.anyType} {
            if (subject.state === "${draft.tag}") {
              return add(subject, item);
            }

            return subject;
          }
        `,
    ),
    documented(
      [
        `Narrowing to the far end works the same way, which is what makes \`${paid.tag}\`-only operations reachable from a value of unknown state.`,
      ],
      shape.parameterised
        ? dedent`
            export function refundIfSettled(subject: ${n.anyType}): string | undefined {
              return subject.state === "${paid.tag}" ? subject.refund() : undefined;
            }
          `
        : dedent`
            export function refundIfSettled(subject: ${n.anyType}): string | undefined {
              return subject.state === "${paid.tag}" ? refund(subject) : undefined;
            }
          `,
    ),
  );
}

function staleNote(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted] = n.states;

  const call = shape.parameterised
    ? `first.${submitted.verb}()`
    : `${submitted.verb}(first)`;

  return documented(
    [
      "The limit, shown rather than asserted.",
      `Nothing here is a compile error, and that is the point: a transition supersedes its input, TypeScript has no way to say so, and both calls below are as valid to the compiler as any other. ${
        shape.staleGuard
          ? `The second one throws \`${n.staleError}\` at run time, which is the only place the constraint can live.`
          : "With `staleGuard` off nothing catches the second one, and it returns a second value derived from a state that has already been left."
      }`,
    ],
    dedent`
      export function theSameValueTwice(): void {
        const first = ${shape.parameterised ? `${n.subject}.${draft.verb}()` : `${draft.verb}()`};

        void ${call};
        void ${call};
      }
    `,
  );
}

function exampleRefusals(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted, paid] = n.states;
  const start = shape.parameterised ? `${n.subject}.${draft.verb}()` : `${draft.verb}()`;

  const op = (receiver: string, method: string, args = ""): string =>
    shape.parameterised ? `${receiver}.${method}(${args})` : `${method}(${receiver}${args === "" ? "" : `, ${args}`})`;

  const blocks: string[] = [
    dedent`
      export function refusesAddingAfterSubmission(): void {
        const fixed = ${op(start, submitted.verb)};

        // The contents are settled once submitted, so \`add\` is not part of that state.
        // @ts-expect-error
        void ${op("fixed", "add", '"late"')};
      }
    `,
    dedent`
      export function refusesSkippingAState(): void {
        // ${paid.verb} arrives from ${submitted.tag}, never from ${draft.tag}. The workflow's order is the type's.
        // @ts-expect-error
        void ${op(start, paid.verb)};
      }
    `,
    dedent`
      export function refusesRefundingBeforePayment(): void {
        const fixed = ${op(start, submitted.verb)};

        // @ts-expect-error there is nothing to refund yet
        void ${op("fixed", "refund")};
      }
    `,
    dedent`
      export function refusesCrossStateAssignment(): void {
        const open = ${start};

        // The states are separate types, not one type with a changing field. This is the assignment the
        // anchoring field exists to reject — without it the instantiations are identical and it succeeds.
        // @ts-expect-error
        const fixed: ${shape.parameterised ? `${n.subject}<"${submitted.tag}">` : submitted.type} = open;

        void fixed;
      }
    `,
  ];

  if (shape.parameterised) {
    blocks.push(
      dedent`
        export function refusesFabricatingAState(): void {
          // The constructor is private, so ${paid.tag} cannot be reached except by passing through ${submitted.tag}.
          // This is the assertion the distinct representation cannot make: an interface admits any literal.
          const settled =
            // @ts-expect-error
            new ${n.subject}<"${paid.tag}">("${paid.tag}", []);

          void settled;
        }
      `,
      dedent`
        export function refusesADetachedOperation(): void {
          const open = ${start};
          const detached = open.add;

          // A \`this\`-constrained operation cannot be separated from its receiver. It does pass as a
          // closure — \`map((subject) => subject.add(item))\` is fine — but not as a bare reference.
          // @ts-expect-error
          void detached("widget");
        }
      `,
    );
  }

  return sections(
    dedent`
      /*
       * The refusals, asserted.
       *
       * Each directive sits alone on its line with the reason above it, because a directive governs only
       * the line it begins on and a long comment gets re-wrapped by the formatter.
       */
    `,
    ...blocks,
  );
}
function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  const imports = shape.parameterised
    ? importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: [n.subject],
        types: [n.anyType],
      })
    : importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        // The two transitions whose return type is asserted. The first transition is named nowhere here:
        // what it returns is the *starting* state, and there is no earlier one to claim it arrives from.
        values: [paid.verb, submitted.verb],
        types: [n.anyType, draft.type, paid.type, submitted.type],
      });

  const instantiation = (state: State): string =>
    shape.parameterised ? `${n.subject}<"${state.tag}">` : state.type;

  return sections(
    dedent`
      /**
       * What the compiler is asked to prove.
       *
       * Nothing here runs. The suffix keeps the file out of every runner while leaving it in front of the
       * compiler, which is the only thing that can check a claim about a type — a workflow whose states had
       * quietly become interchangeable would behave identically at run time to one that had not.
       *
       * No claim below concerns nullability, since with \`strictNullChecks\` off \`undefined\` is assignable
       * to everything and such a claim would mean opposite things to two different callers.
       */
    `,
    imports,
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    dedent`
      /**
       * The states do not interchange.
       *
       * The claim the whole pattern rests on, and the one that fails silently: a state parameter that no
       * member mentions leaves these types structurally identical, and then every constraint on every
       * operation stops applying with nothing to report it.
       */
      export type ${draft.type}IsNot${submitted.type} = Expect<
        NotAssignable<${instantiation(draft)}, ${instantiation(submitted)}>
      >;
      export type ${submitted.type}IsNot${draft.type} = Expect<
        NotAssignable<${instantiation(submitted)}, ${instantiation(draft)}>
      >;
    `,
    dedent`
      /** Each state belongs to the any-state type, which is what makes the shared operations reachable. */
      export type EveryStateBelongsTo${n.anyType} = Expect<
        Extends<${n.states.map((state) => instantiation(state)).join(" | ")}, ${n.anyType}>
      >;
    `,
    dedent`
      /**
       * A transition's result is the next state exactly, not merely something assignable to it.
       *
       * \`Equal\` rather than \`Extends\`, so that a transition widened to return the any-state type — which
       * would leave the caller unable to do anything specific and is an easy accident — is caught.
       */
      export type ${capitalise(submitted.verb)}Arrives = Expect<
        Equal<ReturnType<typeof ${shape.parameterised ? `${n.subject}.prototype.${submitted.verb}` : submitted.verb}>, ${instantiation(submitted)}>
      >;
      export type ${capitalise(paid.verb)}Arrives = Expect<
        Equal<ReturnType<typeof ${shape.parameterised ? `${n.subject}.prototype.${paid.verb}` : paid.verb}>, ${instantiation(paid)}>
      >;
    `,
    when(
      shape.parameterised,
      dedent`
        /**
         * Narrowing the any-state union reaches the state-specific operations.
         *
         * This is the claim that pins \`${n.anyType}\` as a union rather than as
         * \`${n.subject}<${n.stateType}>\`. Under that spelling the body below does not compile at all,
         * because narrowing the field leaves the type argument untouched — so this function existing is the
         * assertion.
         */
        export function narrowingReachesTheOperations(subject: ${n.anyType}): number {
          if (subject.state === "${draft.tag}") {
            return subject.add("x").count();
          }

          return subject.count();
        }
      `,
    ),
  );
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  const framework =
    conventions.testFramework === "node-test"
      ? sections(
          importsFrom(conventions, "node:test", { values: ["describe", "it"] }),
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), { values: ["expect"] }),
        )
      : importsFrom(
          conventions,
          "vitest",
          { values: ["describe", "expect", "it"] },
        );

  const imports = shape.parameterised
    ? importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: [n.subject, ...(shape.staleGuard ? [n.staleError] : [])],
      })
    : importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        values: [
          "add",
          "count",
          draft.verb,
          paid.verb,
          "refund",
          submitted.verb,
          ...(shape.staleGuard ? [n.staleError] : []),
        ],
      });

  return sections(
    dedent`
      /**
       * What is left for a suite that runs.
       *
       * Not which operations each state forbids — that is settled before this file executes, and
       * \`${n.stem}${TYPE_TEST_SUFFIX}\` is where it is asserted. What remains is the behaviour the types say
       * nothing about: that items survive the transitions${
         shape.staleGuard ? ", and that reusing a superseded value is refused" : ", and that an operation staying in its state leaves its input intact"
       }.
       */
    `,
    framework,
    imports,
    behaviourCases(shape),
    shape.staleGuard ? staleCases(shape) : valueSemanticsCases(shape),
  );
}

function behaviourCases(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted, paid] = n.states;

  const build = shape.parameterised
    ? `${n.subject}.${draft.verb}().add("widget").add("gasket")`
    : `add(add(${draft.verb}(), "widget"), "gasket")`;
  const advance = (binding: string, verb: string): string =>
    shape.parameterised ? `${binding}.${verb}()` : `${verb}(${binding})`;
  const countOf = (binding: string): string =>
    shape.parameterised ? `${binding}.count()` : `count(${binding})`;

  return dedent`
    describe("the workflow", () => {
      it("carries the items through every transition", () => {
        // The transitions rebuild the value, so this is the assertion that they rebuild it faithfully —
        // an easy thing to get wrong in a way no type would notice, since every state has the same field.
        const assembled = ${build};
        const fixed = ${advance("assembled", submitted.verb)};
        const settled = ${advance("fixed", paid.verb)};

        expect(${countOf("assembled")}).toBe(2);
        expect(${countOf("fixed")}).toBe(2);
        expect(${countOf("settled")}).toBe(2);
        expect(settled.items).toEqual(["widget", "gasket"]);
      });

      it("records the state it has reached", () => {
        const assembled = ${build};

        expect(assembled.state).toBe("${draft.tag}");
        expect(${advance("assembled", submitted.verb)}.state).toBe("${submitted.tag}");
      });

      it("reaches the end", () => {
        const settled = ${advance(advance(build, submitted.verb), paid.verb)};

        expect(${shape.parameterised ? "settled.refund()" : "refund(settled)"}).toBe("refunded 2 items");
      });
    });
  `;
}

function staleCases(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted] = n.states;
  const start = shape.parameterised ? `${n.subject}.${draft.verb}()` : `${draft.verb}()`;
  const advance = (binding: string, verb: string): string =>
    shape.parameterised ? `${binding}.${verb}()` : `${verb}(${binding})`;

  return dedent`
    describe("a superseded value", () => {
      // The one thing here that types cannot express, so the only part of the pattern a run-time suite is
      // solely responsible for.
      it("is refused on a second transition", () => {
        const open = ${start};
        void ${advance("open", submitted.verb)};

        expect(() => ${advance("open", submitted.verb)}).toThrow(/already left/);
      });

      it("names the state it had already left", () => {
        const open = ${start};
        void ${advance("open", submitted.verb)};

        let caught: unknown;
        try {
          void ${advance("open", submitted.verb)};
        } catch (error) {
          caught = error;
        }

        expect(caught instanceof ${n.staleError}).toBe(true);
        expect((caught as ${n.staleError}).state).toBe("${draft.tag}");
      });

      it("does not refuse an operation that stays in its state", () => {
        // \`add\` derives a new value and does not transition, so neither the input nor the result is spent.
        // Guarding it would break ordinary immutable updates.
        const open = ${start};
        const withOne = ${shape.parameterised ? 'open.add("widget")' : 'add(open, "widget")'};

        expect(${shape.parameterised ? 'withOne.add("gasket").count()' : 'count(add(withOne, "gasket"))'}).toBe(2);

        // Asserted by reaching the next state rather than by the absence of a throw: it establishes the
        // same thing and says what happened instead of what did not.
        expect(${advance("withOne", submitted.verb)}.state).toBe("${submitted.tag}");
      });
    });
  `;
}

function valueSemanticsCases(shape: Shape): string {
  const n = shape.names;
  const [draft, submitted] = n.states;
  const start = shape.parameterised ? `${n.subject}.${draft.verb}()` : `${draft.verb}()`;
  const advance = (binding: string, verb: string): string =>
    shape.parameterised ? `${binding}.${verb}()` : `${verb}(${binding})`;

  return dedent`
    describe("without the stale guard", () => {
      it("leaves a superseded value usable, which is the gap being accepted", () => {
        // Asserted rather than left implicit: with the guard off this is the documented behaviour, and a
        // caller choosing this option should be able to see exactly what they are taking on.
        const open = ${start};
        const first = ${advance("open", submitted.verb)};
        const second = ${advance("open", submitted.verb)};

        expect(first.state).toBe("${submitted.tag}");
        expect(second.state).toBe("${submitted.tag}");
        expect(first === second).toBe(false);
      });

      it("leaves the input of a non-transitioning operation intact", () => {
        const open = ${start};
        const withOne = ${shape.parameterised ? 'open.add("widget")' : 'add(open, "widget")'};

        expect(${shape.parameterised ? "open.count()" : "count(open)"}).toBe(0);
        expect(${shape.parameterised ? "withOne.count()" : "count(withOne)"}).toBe(1);
      });
    });
  `;
}
