/**
 * The `adapter` pattern: a foreign representation turned into one the caller owns.
 *
 * The textbook adapter is a class that implements one interface by delegating to another, and in
 * TypeScript most of it is unnecessary. Structural typing means a foreign object whose shape already
 * fits a port *is* the port, with nothing written. Generating the textbook version would therefore
 * produce a class whose whole body is forwarding, which is the failure research §9 describes: a model
 * writes that unaided, and it was never the part that was hard.
 *
 * What structural typing does not help with is the case where the shapes genuinely differ — `order_id`
 * against `id`, an amount as `"12.50"` against cents as `1250`, a date as ISO text against a `Date`, a
 * status as `string` against a union of three literals. That mapping is where boundaries rot, and it
 * rots in two specific ways.
 *
 * A field gets forgotten. Someone adds `currency` to the domain type, the mapping is an object literal,
 * and nothing says the literal is now incomplete: it compiles, and the field arrives `undefined` in
 * production. So the mapping here is a mapped type over the *target's* keys with `-?` applied, which
 * makes an unmapped field a compile error and an optional field a decision rather than an omission.
 *
 * A conversion fails and takes the rest with it. Hand-written mapping throws on the first bad value, so
 * a payload wrong in four places is discovered one deploy at a time, and the exception says what went
 * wrong without saying *where*. Every mapper here runs, failures are collected, and each carries the
 * field it came from — with an index when a collection is being mapped, so a bad element in a page of
 * fifty is `[37].placedAt` rather than `Invalid Date`.
 *
 * The per-field `try` that buys the second of those is the one cost worth stating plainly: this is a
 * boundary conversion that runs once per payload, not an inner loop, and the alternative is a mapping
 * whose failures cannot be reported together.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, documentedAt, joinLines, sections, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const adapterPattern: PatternModule = {
  name: "adapter",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      reversible: options.direction === "two-way",
      results: options.errorMode === "result",
      names: namesFor(context),
    };
    const n = shape.names;

    const files: RenderedFile[] = [
      { path: `${n.stem}.ts`, role: "core", contents: core(shape) },
      { path: `${n.stem}-example.ts`, role: "example", contents: example(context, shape) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({ path: `${n.stem}.test.ts`, role: "test", contents: tests(context, shape) });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  readonly reversible: boolean;
  readonly results: boolean;
  readonly names: Names;
}

/** Every name the templates use, derived once so two files cannot disagree about one. */
interface Names {
  readonly stem: string;
  /** The adapter interface: `OrderAdapter`. */
  readonly adapter: string;
  /** Its constructor: `createOrderAdapter`. */
  readonly build: string;
  /** The mapping type: `OrderFieldMap`. */
  readonly fieldMap: string;
  /** One field that could not be produced: `OrderAdaptProblem`. */
  readonly problem: string;
  /** All of them at once: `OrderAdaptFailure`. */
  readonly failure: string;
  /** Its prose form: `describeOrderAdaptFailure`. */
  readonly describe: string;
  /** Its thrown form, under `errorMode: throw`. */
  readonly error: string;
  /** The outcome union, under `errorMode: result`. */
  readonly outcome: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;

  return {
    stem: entity === undefined ? "adapter" : `${entity.kebab}-adapter`,
    adapter: `${prefix}Adapter`,
    build: `create${prefix}Adapter`,
    fieldMap: `${prefix}FieldMap`,
    problem: `${prefix}AdaptProblem`,
    failure: `${prefix}AdaptFailure`,
    describe: `describe${prefix}AdaptFailure`,
    error: `${prefix}AdaptError`,
    outcome: `${prefix}AdaptOutcome`,
  };
}

/** What a conversion produces: the outcome union, or the value itself when failures are thrown. */
function returned(shape: Shape, type: string): string {
  return shape.results ? `${shape.names.outcome}<${type}>` : type;
}

/** Indents every line by `width`, leaving blank lines blank. */
function indentBy(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

/** A call to the constructor, which takes a second mapping only when there is a reverse direction. */
function construct(shape: Shape, forward: string, reverse: string, typeArgs = ""): string {
  const args = shape.reversible ? `${forward}, ${reverse}` : forward;
  return `${shape.names.build}${typeArgs}(${args})`;
}

function core(shape: Shape): string {
  return sections(
    mappingType(shape),
    failureTypes(shape),
    shape.results ? outcomeType(shape) : errorClass(shape),
    describeFailure(shape),
    adapterInterface(shape),
    builder(shape),
    internals(shape),
  );
}

function mappingType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "How each field of the target is produced.",
      "One function per field, each given the whole source rather than one field of it — because a target field is often two source fields, or one source field reinterpreted, and a mapping that could only rename would not cover the cases worth having a mapping for.",
      "`-?` is the load-bearing character. It strips optionality from the mapped keys, so *every* field of the target needs a mapper, including the optional ones. Without it an optional field could be left out and would silently arrive absent; with it, leaving it out is a compile error and producing `undefined` has to be written down. Adding a field to the target likewise breaks every mapping that does not yet handle it, which is the whole reason this is a type rather than a convention.",
      "The return type is `Target[K]`, so a mapper that produces the wrong thing is caught where it is written rather than where the value is eventually read.",
      "A mapper reports failure by throwing. That is unusual in this catalog and deliberate here: the overwhelming majority of field mappers cannot fail — a rename, a default, a field copied across — and making all of them return a wrapper so that the few fallible ones can would be the 90% paying for the 10%. It is also what the conversions a caller already owns do, `JSON.parse` and `BigInt` and a schema's `parse` among them. Every mapper call is guarded, so a throw becomes one entry in the failure report rather than an escaping exception.",
    ],
    dedent`
      export type ${n.fieldMap}<Source, Target> = {
        readonly [K in keyof Target]-?: (source: Source) => Target[K];
      };
    `,
  );
}

function failureTypes(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "One field that could not be produced.",
        "The field name is what makes this worth returning rather than rethrowing. An exception from a date parser says `Invalid Date`; this says `placedAt`, and for a collection it says `[37].placedAt` — the difference between a report someone can act on and one that starts by reproducing the payload.",
        "`cause` is `unknown` because a mapper may throw anything, and narrowing it here would mean guessing.",
      ],
      dedent`
        export interface ${n.problem} {
          /** The target field, prefixed with \`[index].\` when a collection was being mapped. */
          readonly field: string;
          readonly cause: unknown;
        }
      `,
    ),
    documented(
      [
        "Every field that could not be produced, rather than the first.",
        "Collected on purpose. A mapping that stops at the first bad field turns a payload wrong in four places into four rounds of discovery, and which of the four is found first would depend on the order someone happened to write the literal in.",
      ],
      dedent`
        export interface ${n.failure} {
          /** In a fixed order: by element index, then by field name. */
          readonly problems: readonly ${n.problem}[];
        }
      `,
    ),
  );
}

function outcomeType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "What one conversion produced.",
      "The same shape as the `result` pattern's type — a literal `ok` discriminant with `value` and `error` arms — so a caller who has generated that pattern can pass this into its combinators, and one who has not still narrows it with an `if`.",
      "Compare the discriminant, as in `if (outcome.ok === false)`, rather than testing it for truthiness. Both narrow under `strict`, but only the comparison narrows in a project with `strictNullChecks` off, where `if (!outcome.ok)` leaves the type unnarrowed and reading `error` off it is an error.",
    ],
    dedent`
      export type ${n.outcome}<T> =
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly error: ${n.failure} };
    `,
  );
}

function errorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Raised when a source cannot be mapped.",
      "`problems` is a property as well as part of the message, because a handler that wants to answer with the failing fields — as a validation response, say — should not have to parse its own error text to find them.",
    ],
    dedent`
      export class ${n.error} extends Error {
        readonly problems: readonly ${n.problem}[];

        constructor(failure: ${n.failure}) {
          super(${n.describe}(failure));
          this.name = "${n.error}";
          this.problems = failure.problems;
        }
      }
    `,
  );
}

function describeFailure(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "One sentence naming every field that failed, and why.",
        `Exported rather than kept private, because a boundary that refuses a payload has to say something to somebody${shape.results ? "" : ", and this is what the thrown error's message already is"}.`,
      ],
      dedent`
        export function ${n.describe}(failure: ${n.failure}): string {
          const parts = failure.problems.map(
            (problem) => \`\${problem.field} (\${reasonOf(problem.cause)})\`,
          );

          return \`Could not map: \${parts.join(", ")}.\`;
        }
      `,
    ),
    documented(
      [
        "A thrown value as text.",
        "`Error` is the common case and its message is the useful part. Anything else is stringified rather than dropped, since a mapper that threw a string still had something to say.",
      ],
      dedent`
        function reasonOf(cause: unknown): string {
          return cause instanceof Error ? cause.message : String(cause);
        }
      `,
    ),
  );
}

function adapterInterface(shape: Shape): string {
  const n = shape.names;

  const members = [
    documentedAt(
      2,
      [
        "Converts one source.",
        shape.results
          ? "Never throws for a source it could not map: the failing fields come back as the error arm. Nothing a mapper throws escapes, because every mapper call is guarded."
          : `Raises \`${n.error}\`, carrying every field that failed rather than the first.`,
      ],
      `adapt(source: Source): ${returned(shape, "Target")};`,
    ),
    documentedAt(
      2,
      [
        "Converts many, in order.",
        "All or nothing. One bad element fails the whole call, and the failure carries the problems from *every* bad element with its index in the field name. Returning the elements that worked would hand the caller a shorter array than they passed with nothing to say which rows were dropped, which is worse than refusing.",
      ],
      `adaptAll(sources: readonly Source[]): ${returned(shape, "readonly Target[]")};`,
    ),
    ...(shape.reversible
      ? [
          documentedAt(
            2,
            [
              "Converts back, for a boundary that writes as well as reads.",
              "Not derived from the forward mapping, and could not be: `(cents) => cents / 100` has no inverse a compiler can find, and a mapper that joined two source fields into one has no inverse at all. The reverse direction is declared separately for the same reason it is worth having — someone has to decide what `1250` becomes.",
            ],
            `back(target: Target): ${returned(shape, "Source")};`,
          ),
          documentedAt(
            2,
            ["Converts many back, in order, with the same all-or-nothing rule as `adaptAll`."],
            `backAll(targets: readonly Target[]): ${returned(shape, "readonly Source[]")};`,
          ),
        ]
      : []),
    documentedAt(
      2,
      [
        "Two stages as one adapter, for a boundary that arrives in more than one hop.",
        dedent`
          \`\`\`ts
          const rowToDomain = rowToDto.andThen(dtoToDomain);
          \`\`\`
        `,
        "A failure names the field in whichever stage produced it, and the stages are not labelled: prefixing every field with a stage number would be noise in the ordinary case, where the two mappings share no field names anyway.",
        "Named `andThen` rather than `then` deliberately. An object with a `then` method is a thenable, so returning an adapter from an `async` function — or `await`ing anything that resolved to one — would have the promise machinery call that method with two callbacks, build an adapter out of them, and never settle. A hang with no error message is a high price for a shorter name.",
      ],
      `andThen<Next>(next: ${n.adapter}<Target, Next>): ${n.adapter}<Source, Next>;`,
    ),
  ];

  return joinLines(
    documented(
      [
        `${n.adapter}: one representation converted to another, totally and with attribution.`,
        "`Source` is the shape that arrives — a wire payload, a database row, a vendor SDK's type — and `Target` is the one this codebase owns. Neither is constrained, because the useful cases include converting *from* a domain type as well as to one.",
        "Nothing here uses `this`, so a caller can pull `adapt` off an adapter and pass it around as a function.",
      ],
      `export interface ${n.adapter}<Source, Target> {`,
    ),
    members.join("\n\n"),
    "}",
  );
}

function builder(shape: Shape): string {
  const n = shape.names;

  const parameters = shape.reversible
    ? dedent`
        forward: ${n.fieldMap}<Source, Target>,
        reverse: ${n.fieldMap}<Target, Source>,
      `
    : `mapping: ${n.fieldMap}<Source, Target>,`;

  const forwardArgument = shape.reversible ? "forward" : "mapping";
  const forwardFields = shape.reversible ? "forwardFields" : "fields";

  const members = [
    dedent`
      adapt(source) {
        return one<Source, Target>(${forwardFields}, source);
      },
    `,
    dedent`
      adaptAll(sources) {
        return many<Source, Target>(${forwardFields}, sources);
      },
    `,
    ...(shape.reversible
      ? [
          dedent`
            back(target) {
              return one<Target, Source>(reverseFields, target);
            },
          `,
          dedent`
            backAll(targets) {
              return many<Target, Source>(reverseFields, targets);
            },
          `,
        ]
      : []),
    dedent`
      andThen(next) {
        return chain(adapter, next);
      },
    `,
  ];

  return documented(
    [
      `Builds \`${n.adapter}\` from ${shape.reversible ? "a mapping in each direction" : "a mapping"}.`,
      `Type arguments have to be supplied when the ${shape.reversible ? "mappings are" : "mapping is"} written inline as ${shape.reversible ? "literals" : "a literal"}: a mapped type over \`keyof Target\` gives the compiler nothing to infer \`Target\` *from*, which is the point — the target is the shape you are claiming to produce, so it is named rather than guessed. ${shape.reversible ? "Mappings" : "A mapping"} declared separately with the \`${n.fieldMap}\` type ${shape.reversible ? "carry" : "carries"} the arguments already, and then the call needs none.`,
      `The ${shape.reversible ? "mappings are" : "mapping is"} read once, at construction, and not held. Whatever a caller does to the object afterwards changes nothing here, and nothing is copied either, because the fields are extracted immediately.`,
    ],
    dedent`
      export function ${n.build}<Source, Target>(
      ${indentBy(parameters, 2)}
      ): ${n.adapter}<Source, Target> {
        const ${forwardFields} = fieldsOf<Source, Target>(${forwardArgument});${when(
          shape.reversible,
          "\n  const reverseFields = fieldsOf<Target, Source>(reverse);",
        )}

        // Named rather than returned directly, because \`andThen\` needs the adapter it is a method of.
        // \`this\` would say that in fewer characters and would stop being true the moment a caller
        // pulled a method off the object, which the doc above invites them to do.
        const adapter: ${n.adapter}<Source, Target> = {
      ${indentBy(members.join("\n\n"), 4)}
        };

        return adapter;
      }
    `,
  );
}

/**
 * The machinery, below the constructor.
 *
 * Module-scoped and generic over both types rather than closures inside the constructor, because the
 * reverse direction needs the same logic with `Source` and `Target` the other way round — and a closure
 * over the constructor's own type parameters could not be reused for it.
 */
function internals(shape: Shape): string {
  const n = shape.names;

  const fail = shape.results ? "{ ok: false, error: { problems } }" : "raise({ problems })";

  return sections(
    documented(
      [
        "One field's mapper, with the target type erased.",
        "Erased because the machinery below is generic over the source and the target as wholes, and there is no way to keep a per-key relationship between a `string` taken from `Object.entries` and the field it names. The relationship is checked where it matters — at the mapping, against `Target[K]` — and only then dropped.",
      ],
      dedent`
        type Mapper<Source> = (source: Source) => unknown;

        interface Field<Source> {
          readonly name: string;
          readonly map: Mapper<Source>;
        }
      `,
    ),
    documented(
      [
        "A mapping as a list of fields, sorted.",
        "Sorted so that a failure report reads the same however the mapping's literal was written; without it, the order of the problems would be an artefact of someone's typing. The comparison is on code units rather than through `localeCompare`, which varies with the host's ICU data and would make the report depend on where it ran.",
        "The cast is the one place a mapping is treated as an index signature, and it is safe for the reason that makes it necessary: the keys come from the object being cast, so every value read back is a mapper that was checked against the target when it was written.",
      ],
      dedent`
        function fieldsOf<Source, Target>(
          mapping: ${n.fieldMap}<Source, Target>,
        ): readonly Field<Source>[] {
          const mappers = mapping as Readonly<Record<string, Mapper<Source>>>;

          return Object.entries(mappers)
            .map(([name, map]) => ({ name, map }))
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        }
      `,
    ),
    documented(
      ["One source, with every mapper run and every failure kept."],
      dedent`
        function one<A, B>(fields: readonly Field<A>[], source: A): ${returned(shape, "B")} {
          const { mapped, problems } = run<A, B>(fields, source, "");
          return problems.length > 0 ? ${fail} : ${shape.results ? "{ ok: true, value: mapped }" : "mapped"};
        }
      `,
    ),
    documented(
      [
        "Many sources, failing as a whole and reporting every element that broke.",
        "The loop does not stop at the first bad element, for the same reason `run` does not stop at the first bad field: a page of fifty rows with two unreadable dates should name both, and stopping early puts the second one a deploy away.",
      ],
      dedent`
        function many<A, B>(
          fields: readonly Field<A>[],
          sources: readonly A[],
        ): ${returned(shape, "readonly B[]")} {
          const values: B[] = [];
          const problems: ${n.problem}[] = [];

          for (const [index, source] of sources.entries()) {
            const attempt = run<A, B>(fields, source, \`[\${String(index)}].\`);

            if (attempt.problems.length > 0) problems.push(...attempt.problems);
            else values.push(attempt.mapped);
          }

          return problems.length > 0 ? ${fail} : ${shape.results ? "{ ok: true, value: values }" : "values"};
        }
      `,
    ),
    documented(
      [
        "Every mapper, each under its own `try`.",
        "The guard is per field rather than around the loop, which is the only way to reach the fields after a bad one. It costs a `try` per field on a conversion that happens once per payload, and buys a report naming all four broken fields instead of whichever came first.",
        "`prefix` is what puts an element index in front of a field name, so nothing else has to know whether it is mapping one value or the thirty-eighth of fifty.",
        "The accumulator is a record until the end because there is no point at which a half-built target is a `B`. A mapper that produced `undefined` leaves the key present and holding `undefined` rather than absent — a distinction that matters to a project using `exactOptionalPropertyTypes`, and one the compiler cannot check through the cast.",
      ],
      dedent`
        function run<A, B>(
          fields: readonly Field<A>[],
          source: A,
          prefix: string,
        ): { readonly mapped: B; readonly problems: readonly ${n.problem}[] } {
          const mapped: Record<string, unknown> = {};
          const problems: ${n.problem}[] = [];

          for (const field of fields) {
            try {
              mapped[field.name] = field.map(source);
            } catch (cause) {
              problems.push({ field: \`\${prefix}\${field.name}\`, cause });
            }
          }

          return { mapped: mapped as B, problems };
        }
      `,
    ),
    when(
      !shape.results,
      documented(
        [
          "Throws, and says so in its type.",
          "Written as a function returning `never` so that the two callers above can each be one expression: `problems.length > 0 ? raise(…) : value` typechecks, where an inline `throw` in the same position would not.",
        ],
        dedent`
          function raise(failure: ${n.failure}): never {
            throw new ${n.error}(failure);
          }
        `,
      ),
    ),
    documented(
      [
        "Two adapters as one.",
        shape.results
          ? "A failure in the first stage is returned as it stands rather than re-wrapped, so the fields it names are the ones the caller's mapping declared. The second stage does not run, which is not a policy so much as a fact: there is no value to give it."
          : "The first stage throwing means the second never runs, which is not a policy so much as a fact: there is no value to give it.",
      ],
      dedent`
        function chain<A, B, C>(first: ${n.adapter}<A, B>, second: ${n.adapter}<B, C>): ${n.adapter}<A, C> {
          const composed: ${n.adapter}<A, C> = {
        ${indentBy(chainMembers(shape), 4)}
          };

          return composed;
        }
      `,
    ),
  );
}

function chainMembers(shape: Shape): string {
  const forward = shape.results
    ? [
        dedent`
          adapt(source) {
            const step = first.adapt(source);
            return step.ok === true ? second.adapt(step.value) : step;
          },
        `,
        dedent`
          adaptAll(sources) {
            const step = first.adaptAll(sources);
            return step.ok === true ? second.adaptAll(step.value) : step;
          },
        `,
      ]
    : [
        dedent`
          adapt(source) {
            return second.adapt(first.adapt(source));
          },
        `,
        dedent`
          adaptAll(sources) {
            return second.adaptAll(first.adaptAll(sources));
          },
        `,
      ];

  // The reverse direction runs the stages the other way round, which is the whole of what makes a
  // composed two-way adapter more than a pair of one-way ones.
  const backward = shape.results
    ? [
        dedent`
          back(target) {
            const step = second.back(target);
            return step.ok === true ? first.back(step.value) : step;
          },
        `,
        dedent`
          backAll(targets) {
            const step = second.backAll(targets);
            return step.ok === true ? first.backAll(step.value) : step;
          },
        `,
      ]
    : [
        dedent`
          back(target) {
            return first.back(second.back(target));
          },
        `,
        dedent`
          backAll(targets) {
            return first.backAll(second.backAll(targets));
          },
        `,
      ];

  return joinLines(
    [
      ...forward,
      ...(shape.reversible ? backward : []),
      dedent`
        andThen(next) {
          return chain(composed, next);
        },
      `,
    ].join("\n\n"),
  );
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * One boundary, as a caller writes it.
       *
       * The service sends snake case, amounts as decimal text, dates as ISO strings, and \`null\` for
       * absence. None of that reaches past this file, and none of the conversions are written twice.
       */
    `,
    joinLines(
      importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
        // The describer is only reached by the write path below, so a one-way adapter that returns
        // results would otherwise import it and never call it.
        values: [
          n.build,
          ...(shape.results ? (shape.reversible ? [n.describe] : []) : [n.error]),
        ],
        types: [n.fieldMap],
      }),
    ),
    documented(
      ["What arrives from the service."],
      dedent`
        export interface InvoiceRow {
          readonly invoice_id: string;
          readonly issued_at: string;
          readonly total: string;
          readonly state: string;
          readonly memo: string | null;
        }
      `,
    ),
    documented(
      ["The states this codebase recognises, closed so that a fourth one cannot arrive unnoticed."],
      `export type InvoiceStatus = "draft" | "sent" | "paid";`,
    ),
    documented(
      [
        "What the rest of this codebase works with.",
        "Every difference from the row above is a conversion that would otherwise be written at each call site, and written differently at one of them.",
      ],
      dedent`
        export interface Invoice {
          readonly id: string;
          readonly issuedAt: Date;
          readonly totalCents: number;
          readonly status: InvoiceStatus;
          readonly memo: string | undefined;
        }
      `,
    ),
    documented(
      [
        "The three conversions that can fail, each throwing when it cannot answer.",
        "Throwing is how a mapper reports a bad value, and each of these guards something that fails quietly otherwise: `new Date` returns a `Date` whose time is `NaN`, `Number` returns `NaN`, and a widened `string` becomes a status nobody checked.",
      ],
      dedent`
        const STATUSES: readonly InvoiceStatus[] = ["draft", "sent", "paid"];

        function statusOf(text: string): InvoiceStatus {
          const found = STATUSES.find((status) => status === text);
          if (found === undefined) throw new Error(\`\${text} is not an invoice status\`);
          return found;
        }

        function centsOf(text: string): number {
          const amount = Number(text);
          if (!Number.isFinite(amount)) throw new Error(\`\${text} is not an amount\`);
          // Rounded because 12.10 * 100 is 1209.9999999999998, and a cent lost per invoice is a
          // reconciliation someone spends a day on.
          return Math.round(amount * 100);
        }

        function dateOf(text: string): Date {
          const at = new Date(text);
          if (Number.isNaN(at.getTime())) throw new Error(\`\${text} is not a date\`);
          return at;
        }
      `,
    ),
    documented(
      [
        "Every field of `Invoice`, and the compile error waiting for whoever adds another.",
        `Declared with the \`${n.fieldMap}\` type rather than passed inline, which is worth doing for two reasons: the type arguments then follow from the annotation instead of being repeated at the call, and a field that goes missing is reported here, at the mapping, rather than at the constructor.`,
      ],
      dedent`
        const fromRow: ${n.fieldMap}<InvoiceRow, Invoice> = {
          id: (row) => row.invoice_id,
          issuedAt: (row) => dateOf(row.issued_at),
          totalCents: (row) => centsOf(row.total),
          status: (row) => statusOf(row.state),
          // \`null\` is the wire's way of saying nothing, \`undefined\` is this codebase's, and picking
          // one is the sort of decision that otherwise gets made four times.
          memo: (row) => row.memo ?? undefined,
        };
      `,
    ),
    when(
      shape.reversible,
      documented(
        [
          "The same boundary in the direction that writes.",
          "Lossless against the mapping above, which is what makes the round trip worth asserting in a test — and what a reader should check first when one of these two is changed.",
        ],
        dedent`
          const toRow: ${n.fieldMap}<Invoice, InvoiceRow> = {
            invoice_id: (invoice) => invoice.id,
            issued_at: (invoice) => invoice.issuedAt.toISOString(),
            total: (invoice) => (invoice.totalCents / 100).toFixed(2),
            state: (invoice) => invoice.status,
            memo: (invoice) => invoice.memo ?? null,
          };
        `,
      ),
    ),
    `export const invoices = ${construct(shape, "fromRow", "toRow")};`,
    documented(
      [
        "One row, or nothing.",
        "What a caller wants when a single record either reads or does not, and where the failing fields are not worth reporting because there is nowhere to report them to.",
      ],
      shape.results
        ? dedent`
            export function readInvoice(row: InvoiceRow): Invoice | undefined {
              const outcome = invoices.adapt(row);
              return outcome.ok === true ? outcome.value : undefined;
            }
          `
        : dedent`
            export function readInvoice(row: InvoiceRow): Invoice | undefined {
              try {
                return invoices.adapt(row);
              } catch (error) {
                if (error instanceof ${n.error}) return undefined;
                throw error;
              }
            }
          `,
    ),
    documented(
      [
        "What a boundary answers with, whichever way the payload went.",
        "`unreadable` is empty on success rather than absent, so a caller reads one shape either way.",
      ],
      dedent`
        export interface Report {
          readonly invoices: readonly Invoice[];
          readonly unreadable: readonly string[];
        }
      `,
    ),
    documented(
      [
        "A page of rows, or the fields that stopped it being read.",
        "This is what a boundary actually needs: a 422 naming `[3].issuedAt` and `[7].total` lets whoever sent the payload fix both, where one that says `Invalid Date` sends them looking.",
      ],
      joinLines(
        shape.results
          ? dedent`
              export function readInvoices(rows: readonly InvoiceRow[]): Report {
                const outcome = invoices.adaptAll(rows);

                return outcome.ok === true
                  ? { invoices: outcome.value, unreadable: [] }
                  : {
                      invoices: [],
                      unreadable: outcome.error.problems.map((problem) => problem.field),
                    };
              }
            `
          : dedent`
              export function readInvoices(rows: readonly InvoiceRow[]): Report {
                try {
                  return { invoices: invoices.adaptAll(rows), unreadable: [] };
                } catch (error) {
                  if (error instanceof ${n.error}) {
                    return {
                      invoices: [],
                      unreadable: error.problems.map((problem) => problem.field),
                    };
                  }

                  throw error;
                }
              }
            `,
      ),
    ),
    when(
      shape.reversible,
      documented(
        [
          "The write path.",
          shape.results
            ? "A value this codebase built should always convert back, so a failure here is a bug rather than bad input — which is why this one is raised instead of returned. `readInvoices` above is the opposite case, and the difference is who supplied the value."
            : "A value this codebase built should always convert back, so the raised error is a bug report rather than a rejected payload.",
        ],
        shape.results
          ? dedent`
              export function rowFor(invoice: Invoice): InvoiceRow {
                const outcome = invoices.back(invoice);
                if (outcome.ok === true) return outcome.value;

                throw new Error(${n.describe}(outcome.error));
              }
            `
          : dedent`
              export function rowFor(invoice: Invoice): InvoiceRow {
                return invoices.back(invoice);
              }
            `,
      ),
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
      : importsFrom(conventions, "vitest", {
          values: ["describe", "expect", "it"],
        });

  return sections(
    dedent`
      /**
       * What is asserted here, and why the suite is shaped this way.
       *
       * Two helpers — \`valueOf\` and \`problemsOf\` — are the only place this suite knows how a failure
       * is reported. Everything after them is written once, so the returning rendering and the throwing
       * one are asserted to behave identically rather than being tested twice by hand.
       *
       * The cases are about the two things a hand-written mapping gets wrong: which fields a failure
       * names, and how many of them it names.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.build, n.describe, ...(shape.results ? [] : [n.error])],
      types: [n.fieldMap, n.problem, ...(shape.results ? [n.outcome] : [])],
    }),
    dedent`
      interface Row {
        readonly widget_id: string;
        readonly made_at: string;
        readonly price: string;
      }

      interface Widget {
        readonly id: string;
        readonly madeAt: Date;
        readonly priceCents: number;
      }

      const MADE_AT = "2024-03-01T00:00:00.000Z";

      const row: Row = { widget_id: "w1", made_at: MADE_AT, price: "12.50" };
      const second: Row = { widget_id: "w2", made_at: MADE_AT, price: "0.99" };

      // Wrong in two fields at once, which is the case a mapping that stops at the first one hides.
      const broken: Row = { widget_id: "w3", made_at: "yesterday", price: "free" };

      function dateOf(text: string): Date {
        const at = new Date(text);
        if (Number.isNaN(at.getTime())) throw new Error(\`\${text} is not a date\`);
        return at;
      }

      function centsOf(text: string): number {
        const amount = Number(text);
        if (!Number.isFinite(amount)) throw new Error(\`\${text} is not an amount\`);
        return Math.round(amount * 100);
      }

      const fromRow: ${n.fieldMap}<Row, Widget> = {
        id: (source) => source.widget_id,
        madeAt: (source) => dateOf(source.made_at),
        priceCents: (source) => centsOf(source.price),
      };
    `,
    when(
      shape.reversible,
      dedent`
        const toRow: ${n.fieldMap}<Widget, Row> = {
          widget_id: (source) => source.id,
          made_at: (source) => source.madeAt.toISOString(),
          price: (source) => (source.priceCents / 100).toFixed(2),
        };
      `,
    ),
    `const widgets = ${construct(shape, "fromRow", "toRow")};`,
    dedent`
      // A second representation, lossless against \`Widget\`, so that composing the two is a thing worth
      // doing rather than an exercise.
      interface Packed {
        readonly ref: string;
        readonly at: string;
        readonly cents: number;
      }

      const fromWidget: ${n.fieldMap}<Widget, Packed> = {
        ref: (source) => source.id,
        at: (source) => source.madeAt.toISOString(),
        cents: (source) => source.priceCents,
      };
    `,
    when(
      shape.reversible,
      dedent`
        const toWidget: ${n.fieldMap}<Packed, Widget> = {
          id: (source) => source.ref,
          madeAt: (source) => dateOf(source.at),
          priceCents: (source) => source.cents,
        };
      `,
    ),
    joinLines(
      `const packing = ${construct(shape, "fromWidget", "toWidget")};`,
      "const rowToPacked = widgets.andThen(packing);",
    ),
    shape.results
      ? dedent`
          /** The value a conversion produced, failing the test rather than the type check if it did not. */
          function valueOf<T>(outcome: ${n.outcome}<T>): T {
            if (outcome.ok === false) {
              throw new Error(\`Expected a value: \${${n.describe}(outcome.error)}\`);
            }

            return outcome.value;
          }

          function problemsOf(attempt: () => ${n.outcome}<unknown>): readonly ${n.problem}[] {
            const outcome = attempt();

            if (outcome.ok === true) {
              throw new Error("Expected the mapping to fail; it succeeded.");
            }

            return outcome.error.problems;
          }
        `
      : dedent`
          /**
           * A pass-through in this rendering.
           *
           * It exists so that every case below is written once and reads the same whether a failure is
           * returned or thrown.
           */
          function valueOf<T>(value: T): T {
            return value;
          }

          function problemsOf(attempt: () => unknown): readonly ${n.problem}[] {
            try {
              attempt();
            } catch (error) {
              if (error instanceof ${n.error}) return error.problems;
              throw error;
            }

            throw new Error("Expected the mapping to fail; it succeeded.");
          }
        `,
    dedent`
      /** The fields a failed conversion named, which is what nearly every case here is about. */
      function failedFields(
        attempt: () => ${shape.results ? `${n.outcome}<unknown>` : "unknown"},
      ): readonly string[] {
        return problemsOf(attempt).map((problem) => problem.field);
      }
    `,
    dedent`
      describe("${n.build}", () => {
        it("renames and converts every field of the target", () => {
          expect(valueOf(widgets.adapt(row))).toEqual({
            id: "w1",
            madeAt: new Date(MADE_AT),
            priceCents: 1250,
          });
        });

        it("reports every field that could not be produced, not the first", () => {
          expect(failedFields(() => widgets.adapt(broken))).toEqual(["madeAt", "priceCents"]);
        });

        it("keeps the field a failure came from, along with what went wrong", () => {
          const problems = problemsOf(() => widgets.adapt(broken));

          expect(problems).toHaveLength(2);
          expect(problems.map((problem) => String(problem.cause))).toEqual([
            "Error: yesterday is not a date",
            "Error: free is not an amount",
          ]);
        });

        it("names fields in a fixed order, whatever order the mapping used", () => {
          // The same three mappers, declared backwards. A report that followed the literal would
          // depend on how someone typed it, and two adapters over the same fields would disagree.
          const reversed = ${construct(
            shape,
            dedent`
              {
                priceCents: (source: Row) => centsOf(source.price),
                madeAt: (source: Row) => dateOf(source.made_at),
                id: (source: Row) => source.widget_id,
              }
            `,
            "toRow",
            "<Row, Widget>",
          )};

          expect(failedFields(() => reversed.adapt(broken))).toEqual(["madeAt", "priceCents"]);
        });
      });
    `,
    dedent`
      describe("adaptAll", () => {
        it("converts a collection in the order it was given", () => {
          const converted = valueOf(widgets.adaptAll([row, second]));

          expect(converted).toHaveLength(2);
          expect(converted.map((widget) => widget.id)).toEqual(["w1", "w2"]);
        });

        it("says which element a failing field belonged to", () => {
          expect(failedFields(() => widgets.adaptAll([row, broken]))).toEqual([
            "[1].madeAt",
            "[1].priceCents",
          ]);
        });

        it("refuses the whole collection, reporting every element that broke", () => {
          // Not just the first bad element: a page with two unreadable rows should name both, so that
          // fixing it takes one round trip rather than two.
          expect(failedFields(() => widgets.adaptAll([broken, row, broken]))).toEqual([
            "[0].madeAt",
            "[0].priceCents",
            "[2].madeAt",
            "[2].priceCents",
          ]);
        });
      });
    `,
    when(
      shape.reversible,
      dedent`
        describe("back", () => {
          it("returns a value to the shape it came from", () => {
            expect(valueOf(widgets.back(valueOf(widgets.adapt(row))))).toEqual(row);
          });

          it("attributes the reverse mapping's own field names", () => {
            // \`toISOString\` throws on a date that is not one, which is this direction's version of
            // unreadable input — and the field it is reported under is the row's, not the domain's.
            const impossible = { id: "w1", madeAt: new Date(Number.NaN), priceCents: 1250 };

            expect(failedFields(() => widgets.back(impossible))).toEqual(["made_at"]);
          });
        });
      `,
    ),
    joinLines(
      'describe("andThen", () => {',
      indentBy(composedCases(shape), 2),
      "});",
    ),
    dedent`
      describe("${n.describe}", () => {
        it("names every field and what went wrong with it", () => {
          const problems: readonly ${n.problem}[] = [
            { field: "madeAt", cause: new Error("yesterday is not a date") },
            { field: "priceCents", cause: new Error("free is not an amount") },
          ];

          expect(${n.describe}({ problems })).toBe(
            "Could not map: madeAt (yesterday is not a date), " +
              "priceCents (free is not an amount).",
          );
        });
      });
    `,
    when(
      !shape.results,
      dedent`
        describe("${n.error}", () => {
          it("is raised for a source that cannot be mapped", () => {
            expect(() => widgets.adapt(broken)).toThrow(/Could not map/);
          });
        });
      `,
    ),
  );
}

/**
 * The cases about the composed adapter.
 *
 * Assembled with `sections` rather than written as one template, for the reason `interfaceOf` records
 * in the `gateway` pattern: a conditional block interpolated into a template literal loses the blank
 * line above it, because `dedent` strips leading blank lines from what it is given. The case then lands
 * flush against the one before it, in one option combination only.
 */
function composedCases(shape: Shape): string {
  return sections(
    dedent`
      it("maps through both stages", () => {
        expect(valueOf(rowToPacked.adapt(row))).toEqual({
          ref: "w1",
          at: MADE_AT,
          cents: 1250,
        });
      });
    `,
    dedent`
      it("stops at the stage that failed, and names that stage's fields", () => {
        expect(failedFields(() => rowToPacked.adapt(broken))).toEqual(["madeAt", "priceCents"]);
      });
    `,
    when(
      shape.reversible,
      dedent`
        it("runs the stages in reverse for the reverse direction", () => {
          // Composition is what makes this worth having: neither adapter knows about the other's far
          // side, and the round trip still holds.
          const packed = { ref: "w1", at: MADE_AT, cents: 1250 };

          expect(valueOf(rowToPacked.back(packed))).toEqual(row);
        });
      `,
    ),
  );
}
