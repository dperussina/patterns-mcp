/**
 * The `discriminated-union` pattern: a value that is exactly one of several shapes.
 *
 * The guarantee is a compile-time one, so it is asserted where the compiler reads it — `@ts-expect-error`
 * in the example, which is emitted whatever the caller asked for, and a `*.test-d.ts` of named claims when
 * tests are wanted. What a run-time suite is left with is the dispatch's answers and the one case types
 * cannot cover: a value arriving from outside with a discriminant nobody declared.
 *
 * Three things here were established by running the compiler rather than by reasoning, and two of them
 * contradicted the obvious answer.
 *
 * The record dispatch needs no cast. Indexing the handler map with the value's own discriminant collapses
 * the parameter type to an intersection of every member — which reduces to `never`, because the
 * discriminant conflicts — and that is why this technique is nearly always shown with an internal
 * `as never`. Making the function generic in the discriminant preserves the correspondence between the
 * key and the member, and then the plain call typechecks. A missing key, a surplus key, and a handler
 * reading another member's field are all still rejected, which was checked one at a time. The comment on
 * `match` originally claimed more than that — that the cast also weakened checking for callers — and a
 * mutation to the conventional form verified cleanly, which is how the overclaim was found. The
 * difference is real and internal.
 *
 * Named predicates are not justified by the usual claim. `filter((event) => event.kind === "shipped")`
 * does narrow, because the compiler infers a type predicate from a body that does nothing but narrow. What
 * destroys it is an explicit `: boolean` return annotation — precisely what an explicit-return-type lint
 * rule requires — so the conflict is between two things a codebase wants, and the silent loser is
 * narrowing. An explicit `event is OrderShipped` satisfies both.
 *
 * Every claim holds identically under `loose` and `strict`. That is a requirement rather than a
 * coincidence: bundles are verified at every strictness a caller may ask for, so an assertion that only
 * errors under one of them would fail as an unused directive under the other.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, joinLines, sections, when } from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const discriminatedUnionPattern: PatternModule = {
  name: "discriminated-union",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      record: options.dispatch === "record",
      guards: options.guards === true,
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
  /** `dispatch: "record"` — exhaustiveness enforced by the shape of the handler map. */
  readonly record: boolean;
  readonly guards: boolean;
  readonly names: Names;
}

/**
 * One member of the union.
 *
 * Three of them, with payloads that genuinely differ. Two members carrying the same fields would let a
 * reader believe the discriminant is decoration, and the emitted example could not then show a handler
 * reading a field that its case does not have.
 */
interface Member {
  /** The discriminant's value, and the handler key. */
  readonly tag: string;
  /** The member's interface name. */
  readonly type: string;
  /** The extra field this member carries, beyond the shared ones. */
  readonly field: { readonly name: string; readonly type: string; readonly example: string };
  readonly doc: string;
  /** How the constructor's doc describes what it records. */
  readonly builds: string;
}

interface Names {
  readonly stem: string;
  readonly union: string;
  readonly kind: string;
  readonly handlers: string;
  readonly match: string;
  readonly summarise: string;
  readonly assertNever: string;
  readonly unknownError: string;
  readonly members: readonly Member[];
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity?.pascal ?? "Domain";
  // Through `withNoun`, so an `Event` entity gives `Event` rather than `EventEvent`.
  const suffixed = entity === undefined ? undefined : withNoun(entity, "Event");
  const union = suffixed?.pascal ?? `${prefix}Event`;

  return {
    stem: suffixed?.kebab ?? "domain-event",
    union,
    kind: `${union}Kind`,
    handlers: `${union}Handlers`,
    match: "match",
    summarise: "summarise",
    assertNever: "assertNever",
    unknownError: `Unknown${union}Error`,
    members: [
      {
        tag: "placed",
        type: `${prefix}Placed`,
        field: { name: "total", type: "number", example: "2500" },
        doc: "The order exists and has been costed.",
        builds: "Records that the order exists and has been costed.",
      },
      {
        tag: "shipped",
        type: `${prefix}Shipped`,
        field: { name: "carrier", type: "string", example: '"royal-mail"' },
        doc: "It has left, and something outside now has custody of it.",
        builds: "Records that it has left, and who has custody of it.",
      },
      {
        tag: "cancelled",
        type: `${prefix}Cancelled`,
        field: { name: "reason", type: "string", example: '"out-of-stock"' },
        doc: "It will not happen, and the reason is part of the record rather than a log line.",
        builds: "Records that it will not happen, and why.",
      },
    ],
  };
}

function core(shape: Shape): string {
  const n = shape.names;

  return sections(
    ...n.members.map((member) => memberInterface(shape, member)),
    unionType(shape),
    kindType(shape),
    ...n.members.map((member) => constructor(shape, member)),
    when(shape.guards, sections(...n.members.map((member) => guard(shape, member)))),
    unknownErrorClass(shape),
    shape.record ? handlersType(shape) : "",
    shape.record ? matchFn(shape) : assertNeverFn(shape),
    shape.record ? "" : summariseSwitch(shape),
    shape.record ? summariseRecord(shape) : "",
  );
}

function memberInterface(shape: Shape, member: Member): string {
  const n = shape.names;

  return documented(
    [
      member.doc,
      ...(member === n.members[0]
        ? [
            "The discriminant is a literal type rather than a `string`, which is the whole mechanism. `kind: string` would compile everywhere this does and narrow nowhere, leaving every branch in every consumer looking at the union — an ordinary interface with one field nobody can use.",
          ]
        : []),
    ],
    dedent`
      export interface ${member.type} {
        readonly kind: "${member.tag}";
        readonly id: string;
        readonly ${member.field.name}: ${member.field.type};
      }
    `,
  );
}

function unionType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      `Exactly one of the shapes above — never two, and never a blend of them.`,
      `The alternative most codebases reach for first is one interface with optional fields: \`{ kind: string; total?: number; carrier?: string }\`. It costs nothing to write and it makes every illegal combination representable — shipped with a cancellation reason, placed with no total — so every reader downstream has to decide what those mean, and each decides differently. The union removes the question by removing the states.`,
    ],
    `export type ${n.union} = ${n.members.map((member) => member.type).join(" | ")};`,
  );
}

function kindType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Every discriminant value, derived rather than restated.",
      `Written out by hand it would be a second list to keep in step with the first, and the failure is silent: a member added to the union and forgotten here leaves ${
        shape.record ? "a handler map that no longer has to cover it" : "a name for something the type no longer describes"
      }.`,
    ],
    `export type ${n.kind} = ${n.union}["kind"];`,
  );
}

function constructor(shape: Shape, member: Member): string {
  const n = shape.names;
  const isFirst = member === n.members[0];

  return documented(
    isFirst
      ? [
          member.builds,
          "The declared return type is doing work. Without it the inferred `kind` widens to `string`, and a value built here would not be assignable to the union — or worse, in a wider context, would be assignable and then narrow to nothing.",
        ]
      : [member.builds],
    dedent`
      export function ${member.tag}(id: string, ${member.field.name}: ${member.field.type}): ${member.type} {
        return { kind: "${member.tag}", id, ${member.field.name} };
      }
    `,
  );
}

function guard(shape: Shape, member: Member): string {
  const n = shape.names;
  const isFirst = member === n.members[0];

  return documented(
    isFirst
      ? [
          `Whether an event is ${member.type}.`,
          "Explicit rather than inferred, for a reason that is easy to miss. The compiler will infer a predicate from an unannotated body that does nothing but narrow, so `filter((event) => event.kind === \"placed\")` narrows on its own — but annotating that function `: boolean`, which an explicit-return-type lint rule requires, opts out silently and leaves the elements as the full union. Stating the predicate satisfies both, and can be passed by name.",
        ]
      : [`Whether an event is ${member.type}.`],
    dedent`
      export function is${member.type}(event: ${n.union}): event is ${member.type} {
        return event.kind === "${member.tag}";
      }
    `,
  );
}

function unknownErrorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A discriminant nobody declared.",
      `Unreachable from typed code, and reachable from everywhere else: a value parsed from JSON, a message from an older producer, a caller who is not using TypeScript at all. The types stop at the module boundary and the data does not, so the case that "cannot happen" gets a name and a value attached rather than a crash somewhere further on.`,
    ],
    dedent`
      export class ${n.unknownError} extends Error {
        readonly received: unknown;

        constructor(received: unknown) {
          super(\`unhandled ${n.union}: \${JSON.stringify(received)}\`);
          this.name = "${n.unknownError}";
          this.received = received;
        }
      }
    `,
  );
}

function assertNeverFn(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Establishes that every case has been handled.",
      "The parameter is `never`, so this is callable only where the compiler has narrowed the value away to nothing. Add a member to the union and every `switch` that reaches here stops compiling, naming the member it does not handle — which is the entire reason the default branch is not simply a thrown error.",
      "It throws as well, because the compiler's proof covers typed callers only.",
    ],
    dedent`
      export function ${n.assertNever}(value: never): never {
        throw new ${n.unknownError}(value);
      }
    `,
  );
}

function handlersType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "One handler per case, keyed by the discriminant.",
      "`Extract` is what gives each handler the narrowed member rather than the union, so a handler reading a field belonging to a different case does not compile. Mapped over the discriminant rather than written out, so a member added to the union adds a required key here — and every handler map in the program stops compiling until it is covered.",
    ],
    dedent`
      export type ${n.handlers}<R> = {
        readonly [K in ${n.kind}]: (event: Extract<${n.union}, { kind: K }>) => R;
      };
    `,
  );
}

function matchFn(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Applies the handler for whichever case arrived.",
      "Generic in the discriminant, which is what makes the body cast-free. Written as `(event: " +
        n.union +
        ")` instead, `handlers[event.kind]` is a union of all three handler types, so its parameter is their intersection — `never`, since the discriminants conflict — and the call has to be forced through with `as never`. Keeping the key and the member related by a type parameter means the compiler can see they match.",
      "The gain is smaller than it first looks, and worth stating exactly rather than generously. A caller cannot tell the two versions apart: the handler map's own type constrains every handler at the call site either way, and swapping this body for the `as never` one breaks no assertion in this bundle — which was checked, not assumed. What changes is inside. With the cast, that the key used to find the handler matches the event handed to it is asserted by whoever wrote the line, and `never` would have accepted any event at all; here it is checked.",
    ],
    dedent`
      export function ${n.match}<R, K extends ${n.kind}>(
        event: Extract<${n.union}, { kind: K }>,
        handlers: ${n.handlers}<R>,
      ): R {
        const handler = handlers[event.kind];

        // Unreachable from typed code, for the reason \`${n.unknownError}\` describes: a value from
        // outside can carry a discriminant no handler has a key for, and \`handler\` is then \`undefined\`.
        // Without this the failure is a \`TypeError\` about calling undefined, which names neither the
        // value nor the union it failed to match.
        if (handler === undefined) {
          throw new ${n.unknownError}(event);
        }

        return handler(event);
      }
    `,
  );
}

function summariseSwitch(shape: Shape): string {
  const n = shape.names;

  const cases = n.members
    .map(
      (member) =>
        `    case "${member.tag}":\n      return \`\${event.id} ${member.tag} (\${${rendered("event", member)}})\`;`,
    )
    .join("\n");

  return documented(
    [
      "One answer per case.",
      "The default branch is not error handling. It is where the compiler is asked to confirm nothing is left, and it is the only part of this function that has to be remembered — which is the honest weakness of the flow-based form, since a `switch` written without it compiles perfectly well and silently returns `undefined` for a member added later.",
    ],
    dedent`
      export function ${n.summarise}(event: ${n.union}): string {
        switch (event.kind) {
      ${cases}
          default:
            return ${n.assertNever}(event);
        }
      }
    `,
  );
}

function summariseRecord(shape: Shape): string {
  const n = shape.names;

  const handlers = n.members
    .map(
      (member) =>
        `    ${member.tag}: (only) => \`\${only.id} ${member.tag} (\${${rendered("only", member)}})\`,`,
    )
    .join("\n");

  return documented(
    [
      "One answer per case.",
      "Nothing here asserts completeness, because nothing has to: the map's type requires every key, so this function could not have been written with a case missing. That is the difference from the `switch` form, where completeness depends on each author remembering a default branch.",
    ],
    dedent`
      export function ${n.summarise}(event: ${n.union}): string {
        return ${n.match}(event, {
      ${handlers}
        });
      }
    `,
  );
}
function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const [placed, shipped, cancelled] = n.members as readonly [Member, Member, Member];

  const values = [
    ...n.members.map((member) => member.tag),
    ...(shape.record ? [n.match] : [n.assertNever]),
    // Only the guard `filtering` narrows with. A guard per member left two of the three imported and
    // never called, which is an error rather than a shrug in a project compiling with
    // `noUnusedLocals` — and this file is emitted whether or not the caller wanted tests.
    ...(shape.guards ? [`is${shipped.type}`] : []),
  ];

  return sections(
    dedent`
      /**
       * Using the union, and the mistakes it refuses.
       *
       * The refusals at the end are assertions rather than a demonstration: each \`@ts-expect-error\`
       * states that the line under it must *not* compile. The guarantee this pattern exists for is that a
       * case cannot be quietly left out, and a guarantee nothing asserts is a hope — so it is pinned here,
       * in a file emitted whether or not the caller wanted tests.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values,
      types: [n.union, n.kind, placed.type],
    }),
    building(shape),
    routing(shape),
    when(shape.guards, filtering(shape)),
    tallying(shape),
    reducing(shape),
    exampleRefusals(shape, placed, shipped, cancelled),
  );
}

function building(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A history, built through the constructors.",
      "The annotation is load-bearing rather than decorative. Each constructor declares its return type, so `kind` stays a literal and these values belong to the union; were those annotations dropped, `kind` would be inferred as `string` and this array — which looks like the most ordinary line in the file — would stop compiling.",
    ],
    dedent`
      export const history: readonly ${n.union}[] = [
        ${n.members
          .map((member) => `${member.tag}("A-1", ${member.field.example}),`)
          .join("\n        ")}
      ];
    `,
  );
}

function tallying(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Counting by case.",
      `A second place completeness is enforced structurally, and it works in either dispatch style: \`Record<${n.kind}, number>\` requires every key, so the initialiser cannot omit a case and cannot invent one. Add a member to the union and this stops compiling too.`,
    ],
    dedent`
      export function tally(events: readonly ${n.union}[]): Record<${n.kind}, number> {
        const counts: Record<${n.kind}, number> = {
          ${n.members.map((member) => `${member.tag}: 0,`).join("\n          ")}
        };

        for (const event of events) {
          counts[event.kind] += 1;
        }

        return counts;
      }
    `,
  );
}

function routing(shape: Shape): string {
  const n = shape.names;

  const body = shape.record
    ? dedent`
        export function notify(event: ${n.union}): string {
          return ${n.match}(event, {
            placed: (placedEvent) => \`invoice \${placedEvent.id} for \${String(placedEvent.total)}\`,
            shipped: (shippedEvent) => \`tracking for \${shippedEvent.id} via \${shippedEvent.carrier}\`,
            cancelled: (cancelledEvent) => \`refund \${cancelledEvent.id}: \${cancelledEvent.reason}\`,
          });
        }
      `
    : dedent`
        export function notify(event: ${n.union}): string {
          switch (event.kind) {
            case "placed":
              return \`invoice \${event.id} for \${String(event.total)}\`;
            case "shipped":
              return \`tracking for \${event.id} via \${event.carrier}\`;
            case "cancelled":
              return \`refund \${event.id}: \${event.reason}\`;
            default:
              return ${n.assertNever}(event);
          }
        }
      `;

  return documented(
    [
      "A second consumer, written the same way as the first.",
      shape.record
        ? "The point of the record form is what happens to this function when a fourth member is added: it stops compiling, here, naming the key it is missing. Nobody has to have anticipated that."
        : "Every consumer needs its own default branch. That is the cost of the flow-based form — the guarantee is per function, and a function written without one still compiles.",
    ],
    body,
  );
}

function filtering(shape: Shape): string {
  const n = shape.names;
  const shipped = n.members[1] as Member;

  return documented(
    [
      "Narrowing outside a dispatch.",
      `Passing the predicate by name is what narrows the result to \`readonly ${shipped.type}[]\`. An inline arrow would also narrow, since the compiler infers a predicate from a body that only narrows — but a named helper annotated \`: boolean\` would not, and that annotation is exactly what an explicit-return-type lint rule asks for.`,
    ],
    dedent`
      export function carriers(events: readonly ${n.union}[]): readonly string[] {
        return events.filter(is${shipped.type}).map((event) => event.carrier);
      }
    `,
  );
}

function reducing(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Folding a history into a state.",
      "The reason to model events this way rather than mutating a record: the state is a function of the events, so it can be recomputed, and a state that was never reachable through these transitions cannot be represented.",
    ],
    dedent`
      export function outcome(events: readonly ${n.union}[]): "open" | "shipped" | "cancelled" {
        return events.reduce<"open" | "shipped" | "cancelled">((state, event) => {
          if (event.kind === "shipped") return "shipped";
          if (event.kind === "cancelled") return "cancelled";

          return state;
        }, "open");
      }
    `,
  );
}

function exampleRefusals(
  shape: Shape,
  placed: Member,
  shipped: Member,
  cancelled: Member,
): string {
  const n = shape.names;

  const incomplete = shape.record
    ? dedent`
        export function refusesAnIncompleteDispatch(event: ${n.union}): string {
          // A handler map missing a case is not a valid map, so this cannot be written.
          // @ts-expect-error
          return ${n.match}(event, {
            placed: (placedEvent) => placedEvent.id,
            shipped: (shippedEvent) => shippedEvent.id,
          });
        }
      `
    : dedent`
        export function refusesAnIncompleteSwitch(event: ${n.union}): string {
          switch (event.kind) {
            case "placed":
              return event.id;
            case "shipped":
              return event.id;
            default:
              // "${cancelled.tag}" has not been handled, so the value is not \`never\` here.
              // @ts-expect-error
              return ${n.assertNever}(event);
          }
        }
      `;

  return sections(
    dedent`
      /*
       * The refusals, asserted.
       *
       * \`@ts-expect-error\` inverts the usual reading: it is satisfied by an error and violated by
       * silence. Each directive sits alone on its line with the reason above it, because a directive only
       * governs the line it begins on and a long comment gets re-wrapped.
       *
       * Where the error is a property of an object, the directive sits inside the object, on the line
       * above that property. Above the whole statement it would break for a long enough type name: the
       * literal then wraps, the error is reported against the property's own line, and the directive
       * governs only the \`const\` — so the assertion silently inverts into two errors, one for the
       * escaped mistake and one for a directive with nothing left to suppress. A comment inside a
       * literal also stops the formatter collapsing it, so the shape does not depend on the name.
       */
    `,
    incomplete,
    dedent`
      export function refusesABlendedValue(): void {
        // "${placed.tag}" carries a ${placed.field.name} and not a ${shipped.field.name}. In one interface with
        // optional fields this would be an ordinary value, and every reader would have to decide what it meant.
        const bad: ${placed.type} = {
          kind: "${placed.tag}",
          id: "A-1",
          // @ts-expect-error
          ${shipped.field.name}: ${shipped.field.example},
        };

        void bad;
      }
    `,
    dedent`
      export function refusesTheWrongField(event: ${n.union}): void {
        if (event.kind === "${placed.tag}") {
          // Narrowed to ${placed.type}, which has no ${shipped.field.name}.
          // @ts-expect-error
          const bad: ${shipped.field.type} = event.${shipped.field.name};

          void bad;
        }
      }
    `,
    dedent`
      export function refusesAnUndeclaredKind(): void {
        // The set of cases is closed. A discriminant nobody declared is not a member of the union, which
        // is why the run-time check for one exists only for values arriving from outside the type system.
        const bad: ${n.union} = {
          // @ts-expect-error
          kind: "refunded",
          id: "A-1",
          ${placed.field.name}: ${placed.field.example},
        };

        void bad;
      }
    `,
  );
}
function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const [placed, shipped] = n.members as readonly [Member, Member, Member];

  return sections(
    dedent`
      /**
       * What the compiler is asked to prove.
       *
       * Nothing here runs, and nothing should: the suffix keeps this file out of every runner while leaving
       * it in front of the compiler, which is the only thing that can check a claim about a type. A union
       * that had stopped discriminating would behave identically at run time to one that still did.
       *
       * No claim below concerns nullability. With \`strictNullChecks\` off \`undefined\` is assignable to
       * everything, so such a claim would mean one thing for one caller and the opposite for another.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [placed.tag, ...(shape.record ? [n.match] : []), ...(shape.guards ? [`is${shipped.type}`] : [])],
      // Exactly the members this rendering names. The record form's handler-parameter claim mentions all
      // three; the others mention two, and an import for a type the file never uses is a small untruth
      // about what was checked.
      types: [
        n.union,
        n.kind,
        placed.type,
        shipped.type,
        ...(shape.record ? [(n.members[2] as Member).type] : []),
      ],
    }),
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    dedent`
      /**
       * The discriminant's values are exactly the tags, derived from the union rather than restated.
       *
       * This is the claim that keeps the two lists in step: a member added to the union widens \`${n.kind}\`
       * with no edit, and if it ever stopped doing so, ${
         shape.record ? "handler maps would stop being required to cover the new case" : "nothing would report the omission"
       }.
       */
      export type KindsAreTheTags = Expect<
        Equal<${n.kind}, ${n.members.map((member) => `"${member.tag}"`).join(" | ")}>
      >;
    `,
    dedent`
      /** Narrowing by the discriminant yields the member exactly, not something assignable to it. */
      export type ExtractIsExact = Expect<
        Equal<Extract<${n.union}, { kind: "${shipped.tag}" }>, ${shipped.type}>
      >;
    `,
    dedent`
      /**
       * A member is not the union.
       *
       * The direction that matters: a function taking one case cannot be handed the whole union by
       * accident, which is what makes the narrowing in a dispatch worth anything.
       */
      export type UnionIsNotAMember = Expect<NotAssignable<${n.union}, ${placed.type}>>;
      export type MemberIsTheUnion = Expect<Extends<${placed.type}, ${n.union}>>;
    `,
    dedent`
      /**
       * The constructor pins the literal, rather than widening it.
       *
       * Without the declared return type the inferred \`kind\` would be \`string\`, and this claim is the
       * one that notices — the value would still build, still run, and narrow nowhere.
       */
      export type ConstructorKeepsTheLiteral = Expect<
        Equal<ReturnType<typeof ${placed.tag}>, ${placed.type}>
      >;
    `,
    when(
      shape.guards,
      dedent`
        /**
         * The predicate narrows an array, which is the case it exists for.
         *
         * Worth stating because the alternative nearly works: an inline arrow narrows too, through an
         * inferred predicate, and the moment that arrow is extracted into a helper annotated \`: boolean\`
         * the narrowing disappears with no diagnostic anywhere.
         */
        export function shippedOnly(events: readonly ${n.union}[]): readonly ${shipped.type}[] {
          return events.filter(is${shipped.type});
        }

        export type PredicateNarrowsAnArray = Expect<
          Equal<ReturnType<typeof shippedOnly>, readonly ${shipped.type}[]>
        >;
      `,
    ),
    when(
      shape.record,
      dedent`
        /**
         * Each handler receives its own member, and the dispatch needs no cast to arrange it.
         *
         * The parameter types are the claim. Were \`${n.match}\` written over the whole union instead of
         * generic in the discriminant, the handler map would still typecheck here — the failure would be
         * inside \`${n.match}\`, and the usual repair for it, \`as never\`, would accept a handler given the
         * wrong member.
         */
        export function handlerParameters(event: ${n.union}): string {
          return ${n.match}(event, {
            ${n.members
              .map((member) => `${member.tag}: (only: ${member.type}) => String(only.${member.field.name}),`)
              .join("\n            ")}
          });
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
          importsFrom(conventions, siblingSpecifier(conventions, "expect"), { values: ["expect"] }),
        )
      : importsFrom(
          conventions,
          "vitest",
          { values: ["describe", "expect", "it"] },
        );

  return sections(
    dedent`
      /**
       * What is left for a suite that runs.
       *
       * Not exhaustiveness — that is settled before this file executes, and \`${n.stem}${TYPE_TEST_SUFFIX}\`
       * is where it is asserted. What remains is what the types do not decide: the answer each case
       * produces, and the one case typed code cannot reach — a value from outside carrying a discriminant
       * nobody declared, which is the only reason the run-time check exists at all.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [
        ...n.members.map((member) => member.tag),
        n.summarise,
        n.unknownError,
        ...(shape.record ? [n.match] : []),
        ...(shape.guards ? n.members.map((member) => `is${member.type}`) : []),
      ],
      types: [n.union],
    }),
    dispatchCases(shape),
    when(shape.guards, guardCases(shape)),
    unknownCases(shape),
  );
}

function dispatchCases(shape: Shape): string {
  const n = shape.names;

  const rows = n.members
    .map(
      (member) =>
        `      { event: ${member.tag}("A-1", ${member.field.example}), expected: "A-1 ${member.tag} (${expected(member)})" },`,
    )
    .join("\n");

  return dedent`
    describe("${n.summarise}", () => {
      // A table rather than three cases, so that a member added to the union and left out of the table is
      // visible as a missing row next to the others.
      const cases: readonly { event: ${n.union}; expected: string }[] = [
    ${rows}
      ];

      it("answers for every case", () => {
        expect(cases).toHaveLength(${String(n.members.length)});

        for (const { event, expected } of cases) {
          expect(${n.summarise}(event)).toBe(expected);
        }
      });
    });
  `;
}

/**
 * A member's payload, interpolated.
 *
 * `String` only where it is needed. Wrapping a value that is already a string is noise, and the emitted
 * file is read by someone deciding whether to trust it.
 */
function rendered(binding: string, member: Member): string {
  const access = `${binding}.${member.field.name}`;

  return member.field.type === "number" ? `String(${access})` : access;
}

/** What the interpolation above produces for a member's example payload. */
function expected(member: Member): string {
  return member.field.type === "number"
    ? member.field.example
    : member.field.example.replaceAll('"', "");
}

function guardCases(shape: Shape): string {
  const n = shape.names;
  const [placed, shipped, cancelled] = n.members as readonly [Member, Member, Member];

  return dedent`
    describe("the predicates", () => {
      const history: readonly ${n.union}[] = [
        ${placed.tag}("A-1", ${placed.field.example}),
        ${shipped.tag}("A-1", ${shipped.field.example}),
        ${cancelled.tag}("A-2", ${cancelled.field.example}),
      ];

      it("each admits its own case and no other", () => {
        expect(history.filter(is${placed.type})).toHaveLength(1);
        expect(history.filter(is${shipped.type})).toHaveLength(1);
        expect(history.filter(is${cancelled.type})).toHaveLength(1);
      });

      it("partition the history exactly", () => {
        // Every event belongs to one predicate and one only. Overlapping predicates would make a filtered
        // list narrower than its contents, which no type would report.
        const counted =
          history.filter(is${placed.type}).length +
          history.filter(is${shipped.type}).length +
          history.filter(is${cancelled.type}).length;

        expect(counted).toBe(history.length);
      });
    });
  `;
}

function unknownCases(shape: Shape): string {
  const n = shape.names;

  const call = shape.record
    ? dedent`
        ${n.match}(outside, {
              placed: () => "?",
              shipped: () => "?",
              cancelled: () => "?",
            })
      `.trim()
    : `${n.summarise}(outside)`;

  return dedent`
    describe("a value from outside the type system", () => {
      // Constructed through \`unknown\` rather than with a cast to the union, because that is how it
      // actually arrives: parsed from JSON, or handed over by a caller not using TypeScript. A cast would
      // be asserting the very thing under test.
      const outside = JSON.parse('{"kind":"refunded","id":"A-9"}') as ${n.union};

      it("is reported with the value that caused it", () => {
        // Matched on the message rather than the class, because the next case establishes the class and
        // this one is about what a reader is told: the union that failed to match, not \`undefined is not
        // a function\`.
        expect(() => ${call}).toThrow(/unhandled ${n.union}/);
      });

      it("names the union and the value, not the mechanism", () => {
        // A \`TypeError\` about calling undefined, or about reading a property of undefined, would be true
        // and useless. What a reader needs is which value failed and what it failed to match.
        let caught: unknown;
        try {
          ${call};
        } catch (error) {
          caught = error;
        }

        expect(caught instanceof ${n.unknownError}).toBe(true);
        expect((caught as ${n.unknownError}).received).toEqual(outside);
      });
    });
  `;
}
