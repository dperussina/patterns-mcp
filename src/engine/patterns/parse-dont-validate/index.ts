/**
 * The `parse-dont-validate` pattern: unknown input in, a type that proves the check ran out.
 *
 * The argument for this discipline is usually made in the abstract. In TypeScript it can be made
 * concretely, and the concrete version is stronger, so what this emits is built around two facts that were
 * checked at every strictness the engine generates for.
 *
 * A validator cannot hand its knowledge on. `if (items.length > 0)` does not refine `readonly string[]`
 * into `readonly [string, ...string[]]` — the comparison is not something the compiler tracks about the
 * value — so after the check the type is exactly what it was before, and the next function down has no way
 * to know a check happened. Rebuilding the value through a parser is the only route, which is the whole
 * claim reduced to one line of evidence.
 *
 * What that buys is the removal of a branch rather than the removal of a doubt. The first element of the
 * refined type is `string`, not `string | undefined`, even under `noUncheckedIndexedAccess` — so a function
 * over parsed input is total, and there is no empty case to write, forget, or test.
 *
 * Two limits are emitted as assertions rather than left for a caller to find: `map` and `filter` both widen
 * the refinement away, so a derived collection has to be parsed again. And two plausible claims are
 * deliberately *not* asserted, because they hold under `strict` and fail under `strictNullChecks: false`,
 * and an assertion that inverts between two callers is worse than no assertion — that `.at(0)` stays
 * partial, and that any element past the first does.
 *
 * One further note on narrowing, learned the hard way elsewhere in this catalogue: every check of the
 * result discriminant is written `outcome.ok === false` rather than `if (outcome.ok)` with an `else`. Both
 * narrow under `strict`; only the explicit comparison narrows with `strictNullChecks` off, where the `else`
 * branch keeps the full union and reading the failure arm off it is an error.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, sections, when } from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const parseDontValidatePattern: PatternModule = {
  name: "parse-dont-validate",

  /**
   * `FirstLine` is a helper the example reads a parsed value with. `Id` is the awkward one: the parsed
   * record has an `id` field, and the example binds a local of that name, so an entity of `Id` gives the
   * file two things called `id`. Refused rather than renamed because a parser named after `Id` alone is
   * asking for the branded-type pattern instead, and the refusal is one line either way.
   */
  emits: ["FirstLine", "Id"],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      accumulate: options.errors === "all",
      combinators: options.combinators === true,
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
  /** `errors: "all"` — every field is visited and the problems come back together. */
  readonly accumulate: boolean;
  readonly combinators: boolean;
  readonly names: Names;
}

interface Names {
  readonly stem: string;
  readonly subject: string;
  readonly parsed: string;
  readonly problem: string;
  readonly result: string;
  readonly parser: string;
  readonly id: string;
  readonly quantity: string;
  readonly parse: string;
  readonly shapeConst: string;
  /**
   * The subject as a value name, for parameters and for the leaf parsers'
   * prefix. Not `subject.toLowerCase()`, which is the same thing only for a
   * one-word noun: `WebhookEvent` lowercases to `webhookevent`, and that was
   * reaching callers as the exported `webhookeventId`.
   */
  readonly camel: string;
  /** The subject as English, for prose. `webhook event`, not `webhookEvent`. */
  readonly words: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const subject = entity?.pascal ?? "Input";
  const kebab = entity?.kebab ?? "input";
  const suffixed = (noun: string): string =>
    entity === undefined ? `${subject}${noun}` : withNoun(entity, noun).pascal;

  return {
    stem: `parse-${kebab}`,
    subject,
    camel: entity?.camel ?? "input",
    words: kebab.replaceAll("-", " "),
    parsed: `Parsed${subject}`,
    problem: suffixed("Problem"),
    result: suffixed("ParseResult"),
    // Through `withNoun`, so a `Parser` subject gives `Parser` rather than `ParserParser`.
    parser: suffixed("Parser"),
    id: suffixed("Id"),
    quantity: suffixed("Quantity"),
    parse: `parse${subject}`,
    shapeConst: `${entity?.camel ?? "input"}Fields`,
  };
}

function core(shape: Shape): string {
  return sections(
    nonEmptyType(),
    problemType(shape),
    resultType(shape),
    brandedScalars(shape),
    shape.combinators ? combinatorKit(shape) : straightLineParser(shape),
    totalConsumer(shape),
  );
}

function nonEmptyType(): string {
  return documented(
    [
      "An array known to hold at least one element.",
      "A tuple with a rest element, which is what makes the first index total: reading `[0]` gives `T` rather than `T | undefined`, and it does so even under `noUncheckedIndexedAccess`. That is the pattern's payoff in one line — a function over this type has no empty case to handle, so there is no branch to forget.",
      "It cannot be reached by checking. `items.length > 0` leaves a `readonly T[]` exactly as it was, because a comparison on a property is not something the compiler records about the value, so the only route in is to take the array apart and put it back together — which is what a parser is.",
      "Note that `map` and `filter` both give back an ordinary array. `filter` genuinely can empty it; `map` cannot, but the signature it inherits does not say so. Either way a derived collection needs parsing again, and both limits are asserted in the compile-time suite so that neither is discovered by accident.",
    ],
    `export type NonEmptyArray<T> = readonly [T, ...T[]];`,
  );
}

function problemType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Something wrong with the input, and where.",
      shape.combinators
        ? "The path is built up by the combinators as they descend, so a problem inside an array element arrives as `lines[1]` without any parser having been told where it sits. That is most of the argument for the kit."
        : "The path is passed in at each check. With straight-line parsing it is the one piece of bookkeeping done by hand, and the reason to reach for the combinator kit once a boundary has any nesting in it.",
    ],
    dedent`
      export interface ${n.problem} {
        readonly path: string;
        readonly message: string;
      }
    `,
  );
}

function resultType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Either the parsed value or what was wrong with the input.",
      "A returned value rather than an exception, because bad input at a boundary is an expected outcome and not an exceptional one — the caller has to answer for it either way, and a type that says so cannot be forgotten the way a `throw` can.",
      ...(shape.accumulate
        ? [
            `The failure carries a \`NonEmptyArray\`, which is this pattern applied to itself: a failure with no problems in it is not a state worth representing, and \`problems[0]\` is then total, so nothing downstream has to consider an empty list of reasons.`,
          ]
        : [
            "The failure carries one problem. Parsing stops at it, so there is never a second to report.",
          ]),
      "Compare the discriminant explicitly — `outcome.ok === false` — rather than testing it for truthiness with an `else`. Both narrow under `strict`; only the comparison narrows in a project with `strictNullChecks` off, where the `else` branch still holds the whole union.",
    ],
    dedent`
      export type ${n.result}<T> =
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly ${shape.accumulate ? `problems: NonEmptyArray<${n.problem}>` : `problem: ${n.problem}`} };
    `,
  );
}

function brandedScalars(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The marker that makes the scalars below nominal.",
        "A `unique symbol` rather than a string tag: two tags spelled the same are structurally identical, so two independently declared brands would silently interchange, where distinct symbols cannot.",
      ],
      `declare const brand: unique symbol;`,
    ),
    documented(
      [
        "An identifier, which is a `string` everywhere a string is wanted and nowhere else.",
        `The intersection is what keeps it usable — a \`Map\` key, a template literal, \`String.prototype\` — while a bare \`string\` is refused where this is wanted. Only \`${n.parse}\` can produce one, which is the same guarantee \`NonEmptyArray\` gives, expressed for a scalar.`,
      ],
      `export type ${n.id} = string & { readonly [brand]: "${n.id}" };`,
    ),
    documented(
      [
        "A positive whole number of items.",
        "Arithmetic discards the brand: adding two of these gives a plain `number`, because that is what `+` is typed to return. That is the type declining to assume a sum of two valid quantities is itself valid, and it means a derived quantity goes back through the parser rather than being assigned.",
      ],
      `export type ${n.quantity} = number & { readonly [brand]: "${n.quantity}" };`,
    ),
  );
}

function totalConsumer(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The first line, with no empty case.",
        `The signature is the point of everything above it. It returns \`string\` and not \`string | undefined\`, there is no branch inside it, and no caller has to handle a case that cannot arise — because a \`${n.parsed}\` could only have come from a parse that established there is a first line.`,
        "Written against unparsed input this function has to either return `string | undefined`, which pushes the same decision onto every caller, or throw, which moves it to run time. Both are the cost of having validated instead of parsed.",
      ],
      dedent`
        export function firstLine(${n.camel}: ${n.parsed}): string {
          return ${n.camel}.lines[0];
        }
      `,
    ),
    documented(
      [
        "A summary, likewise total.",
        "Nothing here checks anything. Every value read has already been established, so this reads as the description of a document rather than as a defence against one.",
      ],
      dedent`
        export function summarise(${n.camel}: ${n.parsed}): string {
          return \`\${${n.camel}.id}: \${String(${n.camel}.quantity)} x \${firstLine(${n.camel})}\`;
        }
      `,
    ),
  );
}
function combinatorKit(shape: Shape): string {
  const n = shape.names;
  const failure = shape.accumulate ? "problems: [{ path, message }]" : "problem: { path, message }";

  return sections(
    documented(
      [
        "A parser: unknown in, either a `T` or what was wrong with it.",
        "The path travels with the input rather than being remembered by the parser, which is what lets the same leaf parser be used at the top level and six levels down and report the right location either way.",
      ],
      `export type ${n.parser}<T> = (input: unknown, path: string) => ${n.result}<T>;`,
    ),
    documented(
      ["The two ways a parser ends."],
      dedent`
        function succeed<T>(value: T): ${n.result}<T> {
          return { ok: true, value };
        }

        function reject<T>(path: string, message: string): ${n.result}<T> {
          return { ok: false, ${failure} };
        }
      `,
    ),
    documented(
      [
        "The leaves.",
        `Each is the only place its type can be created, and the assertion inside it is the one place the brand is applied. That is the bargain: one \`as\` in a function whose entire body is the check that justifies it, in exchange for a type the rest of the program cannot forge.`,
      ],
      dedent`
        export const text: ${n.parser}<string> = (input, path) =>
          typeof input === "string" ? succeed(input) : reject(path, "expected a string");

        export const ${n.camel}Id: ${n.parser}<${n.id}> = (input, path) =>
          typeof input === "string" && input.trim() !== ""
            ? succeed(input as ${n.id})
            : reject(path, "expected a non-empty string");

        export const ${n.camel}Quantity: ${n.parser}<${n.quantity}> = (input, path) =>
          typeof input === "number" && Number.isInteger(input) && input > 0
            ? succeed(input as ${n.quantity})
            : reject(path, "expected a positive integer");
      `,
    ),
    nonEmptyCombinator(shape),
    recordCombinator(shape),
    fieldShape(shape),
  );
}

function nonEmptyCombinator(shape: Shape): string {
  const n = shape.names;

  const loop = shape.accumulate
    ? dedent`
        for (const [index, element] of input.entries()) {
            const parsed = item(element, \`\${path}[\${String(index)}]\`);

            if (parsed.ok === false) problems.push(...parsed.problems);
            else values.push(parsed.value);
          }

          const [firstProblem, ...rest] = problems;
          if (firstProblem !== undefined) return { ok: false, problems: [firstProblem, ...rest] };
      `
    : dedent`
        for (const [index, element] of input.entries()) {
            const parsed = item(element, \`\${path}[\${String(index)}]\`);

            if (parsed.ok === false) return parsed;

            values.push(parsed.value);
          }
      `;

  return documented(
    [
      "Lifts a parser for one element into a parser for at least one of them.",
      shape.accumulate
        ? "Every element is visited before anything is reported, so a caller fixing an array is told about all of it rather than about its first bad entry."
        : "Returns at the first bad element, so the array is only walked as far as the first problem.",
      "The rebuild at the end is the part worth reading: the values are collected into an ordinary array, then taken apart and reassembled as a tuple. There is no way to shortcut it, because no test on the array's length would give the compiler what it needs.",
    ],
    dedent`
      export function nonEmptyArrayOf<T>(item: ${n.parser}<T>): ${n.parser}<NonEmptyArray<T>> {
        return (input, path) => {
          if (!Array.isArray(input)) return reject(path, "expected an array");

          ${when(shape.accumulate, `const problems: ${n.problem}[] = [];\n        `)}const values: T[] = [];

          ${loop}

          const [head, ...tail] = values;
          if (head === undefined) return reject(path, "expected at least one element");

          return succeed([head, ...tail]);
        };
      }
    `,
  );
}

function recordCombinator(shape: Shape): string {
  const n = shape.names;

  const loop = shape.accumulate
    ? dedent`
        for (const [key, parser] of Object.entries(fields)) {
            const parsed = parser(source[key], path === "" ? key : \`\${path}.\${key}\`);

            if (parsed.ok === false) problems.push(...parsed.problems);
            else built[key] = parsed.value;
          }

          const [firstProblem, ...rest] = problems;
          if (firstProblem !== undefined) return { ok: false, problems: [firstProblem, ...rest] };
      `
    : dedent`
        for (const [key, parser] of Object.entries(fields)) {
            const parsed = parser(source[key], path === "" ? key : \`\${path}.\${key}\`);

            if (parsed.ok === false) return parsed;

            built[key] = parsed.value;
          }
      `;

  return sections(
    documented(
      [
        "The type a record of parsers produces.",
        "Derived from the parsers rather than declared beside them, which removes the one failure this pattern is otherwise prone to: a hand-written type and the parser that is supposed to produce it drifting apart, so that the type promises a field the parser never checks.",
      ],
      dedent`
        export type Parsed<F> = {
          readonly [K in keyof F]: F[K] extends ${n.parser}<infer T> ? T : never;
        };
      `,
    ),
    documented(
      [
        "Lifts a record of parsers into a parser for the record.",
          "The constraint is `Parser<unknown>` rather than `Parser<never>`, which is not interchangeable and fails in a way that reads like a defect in the caller. A parser is covariant in what it produces, so every parser is a `Parser<unknown>` and none is a `Parser<never>` — `never` is the bottom of that relation, so the constraint would accept nothing at all.",
        shape.accumulate
          ? "Every field is parsed before anything is reported, which is the only reason this cannot short-circuit."
          : "Returns at the first bad field.",
        "`Object.entries` rather than iterating the keys and indexing, which matters more than it looks: indexing would give a possibly-undefined parser, and the obvious response — skipping that key — would leave a field unparsed and make the assertion at the end untrue. Entries cannot produce a missing parser, so every field is certainly visited.",
        "The assertion on the way out is the one cast here, and it is worth stating what makes it sound rather than waving at it. A heterogeneous record filled one key at a time is beyond what the compiler tracks: nothing can express \"every key of this mapped type has now been assigned a value of its own type\". What justifies it is local and short — the loop visits every key of `fields`, and the only path that reaches this line is one where no field produced a problem.",
      ],
      dedent`
        export function record<F extends Readonly<Record<string, ${n.parser}<unknown>>>>(
          fields: F,
        ): ${n.parser}<Parsed<F>> {
          return (input, path) => {
            if (typeof input !== "object" || input === null || Array.isArray(input)) {
              return reject(path, "expected an object");
            }

            const source = input as Readonly<Record<string, unknown>>;
            ${when(shape.accumulate, `const problems: ${n.problem}[] = [];\n          `)}const built: Record<string, unknown> = {};

            ${loop}

            return succeed(built as Parsed<F>);
          };
        }
      `,
    ),
  );
}

function fieldShape(shape: Shape): string {
  const n = shape.names;
  const lower = n.camel;

  return sections(
    documented(
      [
        `The fields being parsed, and therefore the type of the result.`,
        "One declaration, read two ways. The parser is built from it and the type is derived from it, so there is nothing to keep in step.",
      ],
      dedent`
        const ${n.shapeConst} = {
          id: ${lower}Id,
          quantity: ${lower}Quantity,
          lines: nonEmptyArrayOf(text),
        };
      `,
    ),
    documented(
      [
        `Input that has been through the parser.`,
        `Every field carries its own guarantee: the id is not any string, the quantity is not any number, and \`lines\` is not any array. Nothing in the program can produce one of these except \`${n.parse}\`.`,
      ],
      `export type ${n.parsed} = Parsed<typeof ${n.shapeConst}>;`,
    ),
    documented(
      [
        "The boundary.",
        `The single place unknown input becomes a \`${n.parsed}\`. Everything past it is total.`,
      ],
      dedent`
        export function ${n.parse}(input: unknown): ${n.result}<${n.parsed}> {
          return record(${n.shapeConst})(input, "");
        }
      `,
    ),
  );
}
function straightLineParser(shape: Shape): string {
  const n = shape.names;
  const failure = shape.accumulate ? "problems: [{ path, message }]" : "problem: { path, message }";

  return sections(
    documented(
      [
        `Input that has been through the parser.`,
        `Declared here and produced by \`${n.parse}\` below, which is the one weakness of parsing without the combinator kit: these two have to agree, and nothing but the return type of \`${n.parse}\` is holding them together. Add a field here and forget it there and the compiler will say so; add a field to the parser and forget it here and it is silently dropped.`,
      ],
      dedent`
        export interface ${n.parsed} {
          readonly id: ${n.id};
          readonly quantity: ${n.quantity};
          readonly lines: NonEmptyArray<string>;
        }
      `,
    ),
    documented(
      ["The two ways a check ends."],
      dedent`
        function succeed<T>(value: T): ${n.result}<T> {
          return { ok: true, value };
        }

        function reject<T>(path: string, message: string): ${n.result}<T> {
          return { ok: false, ${failure} };
        }
      `,
    ),
    documented(
      [
        "The field checks.",
        "Each takes the path it sits at, because with straight-line parsing there is nothing to compose it for you. That bookkeeping is the cost being accepted here, and it is what the combinator kit exists to remove.",
      ],
      dedent`
        function parseId(input: unknown, path: string): ${n.result}<${n.id}> {
          return typeof input === "string" && input.trim() !== ""
            ? succeed(input as ${n.id})
            : reject(path, "expected a non-empty string");
        }

        function parseQuantity(input: unknown, path: string): ${n.result}<${n.quantity}> {
          return typeof input === "number" && Number.isInteger(input) && input > 0
            ? succeed(input as ${n.quantity})
            : reject(path, "expected a positive integer");
        }
      `,
    ),
    linesCheck(shape),
    when(shape.accumulate, othersHelper(shape)),
    boundaryFunction(shape),
  );
}

function linesCheck(shape: Shape): string {
  const n = shape.names;

  const loop = shape.accumulate
    ? dedent`
        for (const [index, element] of input.entries()) {
            if (typeof element === "string") values.push(element);
            else problems.push({ path: \`\${path}[\${String(index)}]\`, message: "expected a string" });
          }

          const [firstProblem, ...rest] = problems;
          if (firstProblem !== undefined) return { ok: false, problems: [firstProblem, ...rest] };
      `
    : dedent`
        for (const [index, element] of input.entries()) {
            if (typeof element !== "string") {
              return reject(\`\${path}[\${String(index)}]\`, "expected a string");
            }

            values.push(element);
          }
      `;

  return documented(
    [
      "The lines, rebuilt as a type that knows it has one.",
      "The last three lines are the pattern in miniature. The values are collected into an ordinary array, and then taken apart and put back together as a tuple — because no test on the array itself would give the compiler what it needs, and `values.length > 0` would leave the type exactly as it was.",
    ],
    dedent`
      function parseLines(input: unknown, path: string): ${n.result}<NonEmptyArray<string>> {
        if (!Array.isArray(input)) return reject(path, "expected an array");

        ${when(shape.accumulate, `const problems: ${n.problem}[] = [];\n      `)}const values: string[] = [];

        ${loop}

        const [head, ...tail] = values;
        if (head === undefined) return reject(path, "expected at least one element");

        return succeed([head, ...tail]);
      }
    `,
  );
}

function othersHelper(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The problems from whichever of these failed.",
      "Takes results of differing value types, which is why the parameter is `unknown`: only the failure arm is being read, and that arm is the same shape whatever the parser was going to produce.",
    ],
    dedent`
      function othersOf(...results: readonly ${n.result}<unknown>[]): readonly ${n.problem}[] {
        return results.flatMap((result) => (result.ok === false ? result.problems : []));
      }
    `,
  );
}

function boundaryFunction(shape: Shape): string {
  const n = shape.names;

  const body = shape.accumulate
    ? dedent`
        if (id.ok === false) {
            return { ok: false, problems: [...id.problems, ...othersOf(quantity, lines)] };
          }
          if (quantity.ok === false) {
            return { ok: false, problems: [...quantity.problems, ...othersOf(lines)] };
          }
          if (lines.ok === false) return lines;
      `
    : dedent`
        if (id.ok === false) return id;
          if (quantity.ok === false) return quantity;
          if (lines.ok === false) return lines;
      `;

  return documented(
    [
      "The boundary.",
      `The single place unknown input becomes a \`${n.parsed}\`. Everything past it is total.`,
      ...(shape.accumulate
        ? [
            "All three fields are parsed before any is reported on, which is what accumulating requires. The result of each is kept rather than unwrapped immediately, so the failures can be gathered while the successes stay available.",
            "The list built in the first branch is provably non-empty without a check, because it begins with the problems of a field already known to have failed — spreading a `NonEmptyArray` into a new tuple keeps the guarantee, so there is no impossible case to write an unreachable branch for.",
          ]
        : [
            "Each check returns at its own failure, and the failure arm carries no value, so a rejection from a field parser is returned directly however different the two value types are.",
          ]),
      "The chain of `=== false` returns is also what makes the assembly compile: with each failure returned, all three are narrowed to their success arm by the time the object is built, and no assertion is needed to get there.",
    ],
    dedent`
      export function ${n.parse}(input: unknown): ${n.result}<${n.parsed}> {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          return reject("", "expected an object");
        }

        const source = input as Readonly<Record<string, unknown>>;
        const id = parseId(source.id, "id");
        const quantity = parseQuantity(source.quantity, "quantity");
        const lines = parseLines(source.lines, "lines");

        ${body}

        return succeed({ id: id.value, quantity: quantity.value, lines: lines.value });
      }
    `,
  );
}
function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * Parsing at a boundary, and what a check cannot do instead.
       *
       * The refusals at the end are assertions rather than illustrations: \`@ts-expect-error\` is satisfied
       * by an error and violated by silence, so each states that the line below it must not compile. The
       * first of them is the whole argument for this pattern — a length check does not refine the type — and
       * this file is emitted whether or not tests were asked for because of it.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.parse, "firstLine", "summarise"],
      // `NonEmptyArray` is named by the refusals below, which are emitted in every rendering — and every
      // one of its uses there sits under a `@ts-expect-error`, so omitting it would not fail loudly. The
      // directive would absorb "cannot find name" and report success, leaving three assertions passing for
      // a reason that has nothing to do with what they claim. That is not hypothetical: it is what this
      // import being conditional actually did.
      types: ["NonEmptyArray", n.id, n.parsed, n.problem],
    }),
    boundaryUse(shape),
    reportingUse(shape),
    totalUse(shape),
    validateContrast(),
    exampleRefusals(shape),
  );
}

function boundaryUse(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The edge of the program.",
      `\`JSON.parse\` returns \`any\`, which is worth pausing on: it would flow into a typed parameter with no complaint at all, and a program that accepted it would be typed everywhere and checked nowhere. Passing it through \`${n.parse}\` is what converts that into a type that means something — and taking it as \`unknown\` here is what forces the parse rather than leaving it optional.`,
    ],
    dedent`
      export function handle(body: string): string {
        const decoded: unknown = JSON.parse(body);
        const parsed = ${n.parse}(decoded);

        if (parsed.ok === false) return report(parsed.${shape.accumulate ? "problems" : "problem"});

        return summarise(parsed.value);
      }
    `,
  );
}

function reportingUse(shape: Shape): string {
  const n = shape.names;

  return shape.accumulate
    ? documented(
        [
          "What the caller is told.",
          "Every problem at once, which is the reason to accumulate: a caller made to fix one field per round trip will make several of them, and a form can only mark up what it was told about.",
          "No empty case, because the failure carries a `NonEmptyArray`. A report with nothing in it is not a state this can be asked to render.",
        ],
        dedent`
          export function report(problems: NonEmptyArray<${n.problem}>): string {
            return problems.map((problem) => \`\${problem.path}: \${problem.message}\`).join("; ");
          }
        `,
      )
    : documented(
        [
          "What the caller is told.",
          "One problem, because parsing stopped there. A caller fixing input against this comes back once per problem, which is the trade this rendering makes for a simpler parser.",
        ],
        dedent`
          export function report(problem: ${n.problem}): string {
            return \`\${problem.path}: \${problem.message}\`;
          }
        `,
      );
}

function totalUse(shape: Shape): string {
  const n = shape.names;
  const lower = n.camel;

  return documented(
    [
      "Downstream, where the parse has already happened.",
      `Not one check in it, and not one \`undefined\` to consider. Both functions take \`${n.parsed}\`, so both are entitled to assume every guarantee the parser established — which is the difference between a program that has parsed its input and one that has merely looked at it.`,
    ],
    dedent`
      export function label(${lower}: ${n.parsed}): string {
        const id: ${n.id} = ${lower}.id;

        return \`\${id} starts with \${firstLine(${lower})}\`;
      }
    `,
  );
}

function validateContrast(): string {
  return documented(
    [
      "The shape this pattern replaces, kept for the comparison.",
      "A predicate that answers a question and throws the answer away. It is not wrong about anything — the check is correct, and a caller who runs it does learn something true — but the knowledge stops at the closing brace, so the function below still has to decide what to do about an empty list, and so does every other function that receives this value.",
      "The refusal directly beneath is the same point stated as a compile error rather than as an opinion.",
    ],
    dedent`
      export function looksUsable(input: { readonly lines: readonly string[] }): boolean {
        return input.lines.length > 0;
      }

      export function stillHasToCheck(input: { readonly lines: readonly string[] }): string | undefined {
        if (!looksUsable(input)) return undefined;

        // Reachable, and there is no way to write this function without it. \`looksUsable\` returning true
        // told the compiler nothing, so the first element is still possibly absent and this signature still
        // has to admit \`undefined\` — which every caller then has to handle in turn.
        return input.lines[0];
      }
    `,
  );
}

function exampleRefusals(shape: Shape): string {
  const n = shape.names;
  const lower = n.camel;

  return sections(
    dedent`
      /*
       * The refusals, asserted.
       *
       * Each directive sits alone on its line with the reason above it, because a directive governs only the
       * line it begins on and a long comment gets re-wrapped by the formatter.
       */
    `,
    dedent`
      export function refusesToTreatACheckAsAParse(input: { readonly lines: readonly string[] }): void {
        if (input.lines.length > 0) {
          // The claim the whole pattern rests on. Inside this branch the length is known to be positive and
          // the *type* is exactly what it was outside, because a comparison on a property is not something
          // the compiler records about the value. There is no way to check an array into this type.
          // @ts-expect-error
          const refined: NonEmptyArray<string> = input.lines;

          void refined;
        }
      }
    `,
    dedent`
      export function refusesAnUnparsedArray(lines: readonly string[]): void {
        // A plain array is not accepted where at least one element is required, which is what makes the
        // parse the only way to obtain the refined type.
        // @ts-expect-error
        const refined: NonEmptyArray<string> = lines;

        void refined;
      }
    `,
    dedent`
      export function refusesAForgedIdentifier(): void {
        // The brand cannot be applied from outside the parser, so a raw string is not an identifier however
        // plausible it looks. This is what makes the parsed type unforgeable rather than merely documented.
        // @ts-expect-error
        const id: ${n.id} = "${n.subject.slice(0, 1).toUpperCase()}-1";

        void id;
      }
    `,
    dedent`
      export function refusesADerivedCollection(${lower}: ${n.parsed}): void {
        // \`map\` cannot empty an array, but the signature it inherits does not say so, so the refinement is
        // gone and the result has to be parsed again. \`filter\` is the same and genuinely can empty it.
        // @ts-expect-error
        const trimmed: NonEmptyArray<string> = ${lower}.lines.map((line) => line.trim());

        void trimmed;
      }
    `,
    dedent`
      export function refusesToSkipTheParse(decoded: unknown): void {
        // The boundary cannot be walked around. Nothing but the parser produces this type, so unknown input
        // has exactly one way in.
        // @ts-expect-error
        const ${lower}: ${n.parsed} = decoded;

        void ${lower};
      }
    `,
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
       * compiler, which is the only thing that can check a claim about a type — and every claim this pattern
       * makes is one, since a refinement that had quietly stopped refining would behave identically at run
       * time to one that had not.
       *
       * No claim below concerns nullability, and that exclusion cost something here. Two true and tempting
       * assertions were left out because they hold under \`strict\` and fail with \`strictNullChecks\` off,
       * where \`undefined\` is assignable to everything: that \`.at(0)\` stays partial, and that any element
       * past the first does. An assertion that inverts between two callers is worse than no assertion.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.parse, "firstLine"],
      types: [
        "NonEmptyArray",
        n.id,
        n.parsed,
        n.quantity,
        ...(shape.accumulate ? [n.problem] : []),
      ],
    }),
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    dedent`
      /**
       * The first element is known to exist.
       *
       * The payoff, and the reason the refinement is a tuple rather than a nominal wrapper: the return type
       * is \`string\` with no branch behind it, and it stays \`string\` under \`noUncheckedIndexedAccess\`,
       * which is the setting that would otherwise make every index access partial.
       */
      export type FirstLineIsTotal = Expect<Equal<ReturnType<typeof firstLine>, string>>;
    `,
    dedent`
      /**
       * A plain array is not a non-empty one, and a non-empty one is a plain array.
       *
       * Both directions, because the pattern needs each. The refusal is what makes the parse unavoidable;
       * the acceptance is what keeps a parsed value usable everywhere an ordinary array is wanted, so that
       * refining costs nothing downstream.
       */
      export type PlainIsRefused = Expect<NotAssignable<readonly string[], NonEmptyArray<string>>>;
      export type RefinedIsAnArray = Expect<Extends<NonEmptyArray<string>, readonly string[]>>;
    `,
    dedent`
      /**
       * Mapping and filtering both discard the refinement.
       *
       * Asserted rather than mentioned, because the failure mode is a caller assuming otherwise and finding
       * out at the next boundary. \`filter\` can genuinely empty an array; \`map\` cannot, but nothing in its
       * signature says so, and the practical consequence is the same — a derived collection is parsed again.
       */
      export type MapWidens = Expect<
        NotAssignable<ReturnType<NonEmptyArray<string>["map"]>, NonEmptyArray<unknown>>
      >;
      export type FilterWidens = Expect<
        NotAssignable<ReturnType<NonEmptyArray<string>["filter"]>, NonEmptyArray<string>>
      >;
    `,
    dedent`
      /**
       * The parsed fields carry their own guarantees, exactly.
       *
       * \`Equal\` and not \`Extends\`, so that a field widened back to its underlying primitive — the most
       * likely way for this to rot, since it keeps compiling everywhere else — is caught here.
       */
      export type IdIsBranded = Expect<Equal<${n.parsed}["id"], ${n.id}>>;
      export type QuantityIsBranded = Expect<Equal<${n.parsed}["quantity"], ${n.quantity}>>;
      export type LinesAreRefined = Expect<Equal<${n.parsed}["lines"], NonEmptyArray<string>>>;
    `,
    dedent`
      /**
       * A raw primitive is refused where a parsed one is wanted, in both fields.
       *
       * This is what "only the parser can produce one" means as a checkable claim rather than a convention.
       */
      export type RawStringIsRefused = Expect<NotAssignable<string, ${n.id}>>;
      export type RawNumberIsRefused = Expect<NotAssignable<number, ${n.quantity}>>;
    `,
    dedent`
      /**
       * The boundary takes \`unknown\`, which is what makes it a boundary.
       *
       * Were the parameter typed, a caller would have to have parsed the input to call the parser, and
       * whatever they did to satisfy that is where the real boundary would have moved to.
       */
      export type ParseTakesUnknown = Expect<
        Extends<Parameters<typeof ${n.parse}>, readonly [unknown]>
      >;
    `,
    when(
      shape.accumulate,
      dedent`
        /**
         * A failure carries at least one problem.
         *
         * The pattern applied to its own error channel: a failure with an empty list of reasons is not worth
         * representing, so nothing reporting one has an empty case to handle.
         */
        export type FailureIsNonEmpty = Expect<
          Equal<
            Extract<ReturnType<typeof ${n.parse}>, { ok: false }>["problems"],
            NonEmptyArray<${n.problem}>
          >
        >;
      `,
    ),
  );
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

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

  return sections(
    dedent`
      /**
       * What is left for a suite that runs.
       *
       * Not the refinements — those are settled before this file executes, and
       * \`${n.stem}${TYPE_TEST_SUFFIX}\` is where they are asserted. What remains is everything the types
       * cannot decide: which inputs the parser accepts, what it says about the ones it does not, and where
       * it says the problem is.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.parse, "firstLine", "summarise"],
    }),
    acceptanceCases(shape),
    rejectionCases(shape),
    shape.accumulate ? accumulationCases(shape) : shortCircuitCases(shape),
  );
}

/** A well-formed input, as the tests write it. */
const GOOD_INPUT = `{ id: "A-1", quantity: 2, lines: ["widget", "gasket"] }`;

function acceptanceCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("${n.parse}", () => {
      it("accepts a well-formed ${n.words} and keeps every field", () => {
        const parsed = ${n.parse}(${GOOD_INPUT});

        // Asserted as an equality on the whole value rather than field by field, so that a field the parser
        // quietly stops copying is a failure here rather than something nobody was looking at.
        expect(parsed.ok).toBe(true);
        if (parsed.ok === false) return;

        expect(parsed.value).toEqual(${GOOD_INPUT});
        expect(firstLine(parsed.value)).toBe("widget");
        expect(summarise(parsed.value)).toBe("A-1: 2 x widget");
      });

      it("accepts the smallest acceptable ${n.words}", () => {
        // One line is the boundary the refinement is about, so it is worth an explicit case: the parser must
        // accept exactly one and reject exactly none.
        const parsed = ${n.parse}({ id: "A-2", quantity: 1, lines: ["only"] });

        expect(parsed.ok).toBe(true);
      });
    });
  `;
}

function rejectionCases(shape: Shape): string {
  const n = shape.names;
  const field = shape.accumulate ? "problems" : "problem";
  const firstProblem = shape.accumulate ? `parsed.problems[0]` : `parsed.problem`;

  return dedent`
    describe("what it refuses, and where it says the problem is", () => {
      // A table, so that a case added to the parser and left out here is a missing row next to the others
      // rather than an absence nobody notices.
      const cases: readonly { readonly name: string; readonly input: unknown; readonly path: string }[] = [
        { name: "not an object", input: "A-1", path: "" },
        { name: "null", input: null, path: "" },
        { name: "an array", input: [], path: "" },
        { name: "a missing id", input: { quantity: 1, lines: ["x"] }, path: "id" },
        { name: "a blank id", input: { id: "   ", quantity: 1, lines: ["x"] }, path: "id" },
        { name: "a fractional quantity", input: { id: "A-1", quantity: 1.5, lines: ["x"] }, path: "quantity" },
        { name: "a quantity of zero", input: { id: "A-1", quantity: 0, lines: ["x"] }, path: "quantity" },
        { name: "lines that are not an array", input: { id: "A-1", quantity: 1, lines: "x" }, path: "lines" },
        { name: "no lines at all", input: { id: "A-1", quantity: 1, lines: [] }, path: "lines" },
        { name: "a non-string line", input: { id: "A-1", quantity: 1, lines: [7] }, path: "lines[0]" },
      ];

      it("refuses each of them, naming the path", () => {
        expect(cases).toHaveLength(10);

        for (const { input, path } of cases) {
          const parsed = ${n.parse}(input);

          expect(parsed.ok).toBe(false);
          if (parsed.ok === true) continue;

          // The path is the part worth asserting. A parser that refuses everything would pass a test that
          // only checked \`ok\`, and a caller cannot act on a refusal that does not say where it applies.
          expect(${firstProblem}.path).toBe(path);
        }
      });

      it("reports a nested position, not just the field", () => {
        const parsed = ${n.parse}({ id: "A-1", quantity: 1, lines: ["fine", 7] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(${firstProblem}.path).toBe("lines[1]");
      });

      it("carries a message alongside the path", () => {
        const parsed = ${n.parse}({ id: "A-1", quantity: 0, lines: ["x"] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(${firstProblem}.message).toBe("expected a positive integer");
        expect(typeof parsed.${field}).toBe("object");
      });
    });
  `;
}

function accumulationCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("accumulating", () => {
      it("reports every bad field at once", () => {
        // The behaviour this rendering exists for, and the one a caller cannot get from the \`first\`
        // rendering: three bad fields produce three problems rather than the earliest one.
        const parsed = ${n.parse}({ id: "", quantity: -1, lines: [] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(parsed.problems).toHaveLength(3);
        expect(parsed.problems.map((problem) => problem.path)).toEqual(["id", "quantity", "lines"]);
      });

      it("reports every bad element of an array at once", () => {
        const parsed = ${n.parse}({ id: "A-1", quantity: 1, lines: [1, "fine", 2] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(parsed.problems.map((problem) => problem.path)).toEqual(["lines[0]", "lines[2]"]);
      });

      it("still parses the fields that were sound", () => {
        // Worth asserting because the failure mode is subtle: a parser that short-circuits on the first bad
        // field would report one problem here and look correct to a test that only counted problems.
        const parsed = ${n.parse}({ id: "", quantity: 2, lines: ["ok"] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(parsed.problems).toHaveLength(1);
        expect(parsed.problems[0].path).toBe("id");
      });
    });
  `;
}

function shortCircuitCases(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("stopping at the first problem", () => {
      it("reports the earliest bad field and no other", () => {
        // The behaviour this rendering exists for, asserted so that a caller choosing it can see exactly
        // what they are giving up: two bad fields produce one problem, and it is the first.
        const parsed = ${n.parse}({ id: "", quantity: -1, lines: [] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(parsed.problem.path).toBe("id");
      });

      it("reports the earliest bad element of an array", () => {
        const parsed = ${n.parse}({ id: "A-1", quantity: 1, lines: [1, "fine", 2] });

        expect(parsed.ok).toBe(false);
        if (parsed.ok === true) return;

        expect(parsed.problem.path).toBe("lines[0]");
      });
    });
  `;
}
