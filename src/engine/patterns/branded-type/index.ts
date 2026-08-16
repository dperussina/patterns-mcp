/**
 * The `branded-type` pattern: a primitive that will not be mistaken for another primitive.
 *
 * The whole guarantee here is a compile-time one, which changes how the bundle has to be verified. A
 * branded identifier that has stopped rejecting a raw string behaves identically at run time to one that
 * still rejects it, so no suite that runs can tell the two apart. The claims are therefore stated where
 * the compiler reads them: `@ts-expect-error` in the example, which is emitted whatever the caller asked
 * for, and a `*.test-d.ts` of named aliases when tests are wanted. Both are checked by the same typecheck
 * the engine already runs over every file it emits.
 *
 * Two decisions were verified rather than assumed.
 *
 * The carrier is a `unique symbol` and not the string tag the technique is usually shown with. Two tags
 * declared independently with the same string are structurally identical — two teams both reaching for
 * `"Id"` get types that interchange with no diagnostic anywhere — where distinct symbols cannot collide
 * however their labels read. That was checked both ways before it was written down.
 *
 * Every claim holds at every strictness, which is a constraint rather than an observation. A bundle is
 * verified under `loose` as well as `strict`, and with `strictNullChecks` off `undefined` is assignable to
 * everything, so any assertion about nullability would mean different things to different callers. The
 * claims here are all about nominal identity and missing members, which mean the same thing everywhere.
 *
 * The run-time suite asserts the complement: that the brand is *erased*. A caller needs to know the value
 * still works as a `Map` key, still compares with `===`, and still survives `JSON.stringify`, because a
 * brand that changed any of those would be a runtime cost disguised as a type.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import {
  dedent,
  documented,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const brandedTypePattern: PatternModule = {
  name: "branded-type",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      numeric: options.base === "number",
      construction: options.construction as Construction,
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
        path: `${n.stem}${TYPE_TEST_SUFFIX}`,
        role: "test",
        contents: typeTests(context, shape),
      });
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

type Construction = "assert" | "result" | "cast";

interface Shape {
  /** `base: "number"` — the rendering where arithmetic discards the brand. */
  readonly numeric: boolean;
  readonly construction: Construction;
  readonly names: Names;
}

interface Names {
  readonly stem: string;
  /** The branded type, and the noun every other name is built from. */
  readonly brand: string;
  readonly base: string;
  readonly guard: string;
  readonly make: string;
  readonly unsafe: string;
  readonly problem: string;
  readonly result: string;
  /** A second brand, declared in the assertions to show that two do not interchange. */
  readonly sibling: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const numeric = context.options.base === "number";
  const noun = numeric ? "Quantity" : "Id";
  const suffixed = entity === undefined ? undefined : withNoun(entity, noun);
  const brand = suffixed?.pascal ?? noun;
  const camel = suffixed?.camel ?? noun.toLowerCase();

  return {
    stem: suffixed?.kebab ?? noun.toLowerCase(),
    brand,
    base: numeric ? "number" : "string",
    guard: `is${brand}`,
    make: camel,
    unsafe: `unsafe${brand}`,
    problem: `${brand}Problem`,
    result: `${brand}Result`,
    sibling: entity === undefined ? `Other${noun}` : sibling(brand, noun),
  };
}

/**
 * The contrast brand, chosen so it cannot be the brand it contrasts with.
 *
 * `CustomerId` is the better teaching name — `lookup(customer, order)` reads as perfectly fine code,
 * which is the whole point being made — but it is also a name the caller can ask for. An entity of
 * `Customer` derives the brand `CustomerId`, and the example then imported that name and declared it,
 * so one of the most ordinary nouns in the language came back as a defect in the pattern.
 *
 * Two candidates and take the first that differs. The brand is a single name, the candidates differ
 * from each other, so one of them always survives — no search, and the same request keeps producing
 * the same name.
 */
function sibling(brand: string, noun: string): string {
  return [`Customer${noun}`, `Other${noun}`].find((candidate) => candidate !== brand) ?? `Other${noun}`;
}

function core(shape: Shape): string {
  const validating = shape.construction !== "cast";

  return sections(
    brandDeclaration(),
    brandType(shape),
    when(shape.construction === "result", problemType(shape)),
    when(shape.construction === "result", resultType(shape)),
    when(validating, guardFn(shape)),
    when(validating, constructorFn(shape)),
    unsafeFn(shape),
  );
}

function brandDeclaration(): string {
  return documented(
    [
      "The mark that makes the type nominal.",
      `A \`unique symbol\` rather than the string tag this technique is usually shown with. Two tags declared independently with the same text are structurally the same type, so two modules that both reach for \`"Id"\` produce identifiers that interchange with no diagnostic anywhere — where two symbols cannot collide however their labels read.`,
      "`declare` means no value is emitted. The mark exists for the compiler and costs nothing at run time, which is the point: the value stays exactly the primitive it was.",
    ],
    "declare const brand: unique symbol;",
  );
}

function brandType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      shape.numeric
        ? `A quantity that cannot be confused with any other ${n.base}.`
        : `An identifier that cannot be confused with any other ${n.base}.`,
      `An intersection, so \`${n.brand}\` is still accepted wherever \`${n.base}\` is — ${
        shape.numeric
          ? "`Math.max`, a comparison, anything expecting a number"
          : "`String.prototype` methods, a `Map` key, a template literal"
      } — while the reverse is refused. That asymmetry is the whole pattern: it costs nothing at the places a plain ${n.base} already works, and it costs a compile error exactly where a mistake was being made.`,
      ...(shape.numeric
        ? [
            "One consequence is worth knowing before relying on this: arithmetic discards the mark. Adding two of these produces a plain `number`, because that is what `+` is typed to return, so a derived quantity has to be sent back through the constructor rather than assigned. That is not a flaw to work around — it is the type refusing to assume that a sum of two valid quantities is itself valid.",
          ]
        : []),
    ],
    `export type ${n.brand} = ${n.base} & { readonly [brand]: "${n.brand}" };`,
  );
}

function problemType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      `Why a ${n.base} did not qualify as \`${n.brand}\`.`,
      "A shape rather than a message, so a caller can render it, count it, or match on it. A string would force every consumer to parse prose back into a decision.",
    ],
    dedent`
      export interface ${n.problem} {
        readonly reason: ${shape.numeric ? '"not-an-integer" | "negative"' : '"empty"'};
        readonly received: ${n.base};
      }
    `,
  );
}

function resultType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "A construction that either produced a value or explained why it could not.",
      "Discriminated on `ok`, so the compiler will not let a caller read `value` without having established it is there.",
    ],
    dedent`
      export type ${n.result} =
        | { readonly ok: true; readonly value: ${n.brand} }
        | { readonly ok: false; readonly error: ${n.problem} };
    `,
  );
}

/** The rule a value has to satisfy, and the sentence describing it. */
function rule(shape: Shape): { readonly test: string; readonly prose: string } {
  return shape.numeric
    ? {
        test: "Number.isInteger(value) && value >= 0",
        prose: "a non-negative integer",
      }
    : { test: "value.trim().length > 0", prose: "not blank" };
}

function guardFn(shape: Shape): string {
  const n = shape.names;
  const { test, prose } = rule(shape);

  return documented(
    [
      `Whether a ${n.base} is ${prose}, and so may be treated as \`${n.brand}\`.`,
      "A type predicate rather than a boolean, so a caller that checks gets the narrowing for free instead of needing a cast afterwards. Written as a boolean it would still work and would teach every call site to reach for `as`, which is the habit that dissolves the guarantee.",
      "This is the line to edit. The rule is deliberately the least a name like this can promise, because a rule invented here that does not match the domain is worse than no rule — it fails valid input in production and looks authoritative doing it.",
    ],
    dedent`
      export function ${n.guard}(value: ${n.base}): value is ${n.brand} {
        return ${test};
      }
    `,
  );
}

function constructorFn(shape: Shape): string {
  const n = shape.names;
  const { prose } = rule(shape);

  const body =
    shape.construction === "assert"
      ? dedent`
          export function ${n.make}(value: ${n.base}): ${n.brand} {
            if (!${n.guard}(value)) {
              throw new TypeError(
                \`expected ${prose} for ${n.brand}, received \${JSON.stringify(value)}\`,
              );
            }

            return value;
          }
        `
      : dedent`
          export function ${n.make}(value: ${n.base}): ${n.result} {
            if (!${n.guard}(value)) {
              return { ok: false, error: { reason: ${reasonExpression(shape)}, received: value } };
            }

            return { ok: true, value };
          }
        `;

  return documented(
    [
      shape.construction === "assert"
        ? `The way in, and the only one that checks.`
        : `The way in, reporting rather than raising.`,
      ...(shape.construction === "assert"
        ? [
            "Throws rather than returning a fallback. A brand asserts something about the value it carries, and a constructor that quietly substituted a default would hand back a value bearing a claim nothing checked.",
          ]
        : [
            "Returns the failure rather than throwing it, for a boundary that has to answer without unwinding — validating a form, or accumulating problems across several fields.",
          ]),
      "No cast in sight: the guard narrows `value`, so the return is the branded type by inference. That matters more than it looks — a constructor written with `as` compiles whether or not the check above it is correct, so the one place a cast would be excusable is the one place it hides a real mistake.",
    ],
    body,
  );
}

/** The `reason` a failed construction reports, chosen from the same rule the guard applies. */
function reasonExpression(shape: Shape): string {
  return shape.numeric ? '!Number.isInteger(value) ? "not-an-integer" : "negative"' : '"empty"';
}

function unsafeFn(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      `Marks a ${n.base} without checking it.`,
      shape.construction === "cast"
        ? "The only way in, deliberately. There is no rule to apply here: this rendering is for values already valid by construction somewhere else — a key read back from the store that wrote it — and a rule invented at this boundary would be theatre that fails valid input."
        : "For values already known good: a row read back from the store that wrote it, or a literal in a fixture. Re-validating those is not free and not always possible, so the escape exists.",
      "The name is the safeguard. This is the one hole in the guarantee, and it is spelled so that it cannot be used by accident and cannot be read past in review — where a helper called `to" +
        n.brand +
        "` would be reached for by everyone and would quietly turn the type back into a `" +
        n.base +
        "`.",
    ],
    dedent`
      export function ${n.unsafe}(value: ${n.base}): ${n.brand} {
        return value as ${n.brand};
      }
    `,
  );
}
function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const validating = shape.construction !== "cast";

  const imported = [...(validating ? [n.make] : []), n.unsafe];

  return sections(
    dedent`
      /**
       * Using the type, and the mistakes it refuses.
       *
       * The second half of this file is a set of assertions rather than a demonstration. Each
       * \`@ts-expect-error\` states that the line beneath it must *not* compile, so if the guarantee ever
       * lapsed the directive would go unused and this file would stop compiling on that instead. It lives
       * here rather than in the test suite because the suite is optional and the guarantee is not.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: imported,
      types: [n.brand, ...(shape.construction === "result" ? [n.result] : [])],
    }),
    siblingBrand(shape),
    consumer(shape),
    when(validating, boundary(shape)),
    trusted(shape),
    refusals(shape),
  );
}

/**
 * The escape hatch, shown at the one boundary it is for.
 *
 * Emitted for every rendering, and it was the `cast` one that made the omission obvious: with no
 * validating constructor to demonstrate, the example imported the unsafe one, used nothing, and so
 * never showed how a value of the type is made at all.
 */
function trusted(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The escape hatch, at the boundary it exists for.",
      shape.construction === "cast"
        ? `A row the store wrote is valid because something checked it before it went in, which is the only claim this rendering makes.`
        : `The store wrote this row after \`${n.make}\` had already accepted the value, so checking it again on the way back would cost something and prove nothing.`,
    ],
    dedent`
      export function fromStore(row: { readonly id: ${n.base} }): ${n.brand} {
        return ${n.unsafe}(row.id);
      }
    `,
  );
}

/** A second brand, so the example can show that two of them do not interchange. */
function siblingBrand(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      `A second brand, for the mistake that matters most.`,
      `Two arguments of the same primitive in the same signature is the shape of every id-swap bug: nothing about \`lookup(customer, order)\` reads as wrong, the arguments are the same type, and the test fixture that would catch it uses the same value for both.`,
    ],
    dedent`
      declare const other: unique symbol;

      export type ${n.sibling} = ${n.base} & { readonly [other]: "${n.sibling}" };
    `,
  );
}

function consumer(shape: Shape): string {
  const n = shape.names;

  const body = shape.numeric
    ? dedent`
        export function describeShipment(
          ${n.make === "orderQuantity" ? "ordered" : "ordered"}: ${n.brand},
          shipped: ${n.brand},
        ): string {
          // Both are still numbers, so every numeric operation is available unchanged.
          const outstanding = Math.max(ordered - shipped, 0);

          // \`outstanding\` is a plain \`number\` — subtraction discarded the mark, and it has to, since
          // nothing guarantees the difference of two valid quantities is itself one. Sent back through
          // the constructor rather than assigned, which is the discipline a branded number asks for.
          return \`\${String(shipped)} of \${String(ordered)}, \${String(outstanding)} to go\`;
        }
      `
    : dedent`
        export function lookup(customer: ${n.sibling}, order: ${n.brand}): string {
          // Both are still strings, so every string operation is available unchanged.
          return \`/customers/\${customer}/orders/\${order.toLowerCase()}\`;
        }
      `;

  return documented(
    [
      shape.numeric
        ? "Work that takes quantities."
        : "Work that takes two identifiers of different kinds.",
      shape.numeric
        ? "Nothing here is written differently from the unbranded version. That is the intended cost: the type is free at every point a plain number already worked."
        : "The signature is now impossible to call wrongly. Unbranded, swapping the two arguments compiles, runs, and returns a plausible URL for the wrong resource — the class of bug that reaches production because every layer it passes through agrees the types are fine.",
    ],
    body,
  );
}

function boundary(shape: Shape): string {
  const n = shape.names;

  const body =
    shape.construction === "assert"
      ? dedent`
          export function fromRequest(raw: unknown): ${n.brand} {
            if (typeof raw !== "${n.base}") {
              throw new TypeError("expected a ${n.base}");
            }

            // One check, at the edge. Nothing inside asks again, which is the saving the pattern is
            // actually for: validation stops being something every layer repeats because no layer can
            // tell whether an earlier one already did.
            return ${n.make}(raw);
          }
        `
      : dedent`
          export function fromRequest(raw: unknown): ${n.result} {
            if (typeof raw !== "${n.base}") {
              return {
                ok: false,
                error: { reason: ${shape.numeric ? '"not-an-integer"' : '"empty"'}, received: ${shape.numeric ? "Number.NaN" : '""'} },
              };
            }

            // One check, at the edge. Nothing inside asks again, which is the saving the pattern is
            // actually for: validation stops being something every layer repeats because no layer can
            // tell whether an earlier one already did.
            return ${n.make}(raw);
          }
        `;

  return documented(
    [
      "Where an outside value becomes an inside one.",
      "The only place a check belongs. A brand is worth having because it records that this happened — downstream code does not re-check and does not need to trust a comment saying someone else did.",
    ],
    body,
  );
}

function refusals(shape: Shape): string {
  const n = shape.names;
  const validating = shape.construction !== "cast";
  const raw = shape.numeric ? "42" : '"ORD-1"';

  return sections(
    dedent`
      /*
       * The refusals, asserted.
       *
       * Everything below must fail to compile. \`@ts-expect-error\` inverts the usual reading: it is
       * satisfied by an error and violated by silence, so these lines fail loudly if the type ever
       * stops doing its job.
       *
       * The directive sits alone on its line with the reason above it. Written as one long comment it
       * would be re-wrapped to the margin, and a directive only governs the line it begins on.
       */
    `,
    refusal(
      `refusesARaw${shape.numeric ? "Number" : "String"}(): void`,
      `A plain ${n.base} carries no evidence that anyone checked it.`,
      `const bad: ${n.brand} = ${raw};`,
    ),
    refusal(
      `refusesTheOtherBrand(value: ${n.brand}): void`,
      `Two brands over the same ${n.base} are still two types.`,
      `const bad: ${n.sibling} = value;`,
    ),
    when(
      shape.numeric,
      refusal(
        `refusesArithmetic(a: ${n.brand}, b: ${n.brand}): void`,
        "`+` is typed to return `number`, so the sum has lost the mark.",
        `const bad: ${n.brand} = a + b;`,
      ),
    ),
    when(
      !shape.numeric,
      refusal(
        `refusesConcatenation(value: ${n.brand}): void`,
        "A template literal produces a plain string, mark and all discarded.",
        "const bad: " + n.brand + " = `${value}-retry`;",
      ),
    ),
    when(
      validating,
      refusal(
        `refusesAnUncheckedValue(raw: ${n.base}): void`,
        `The value may be anything; \`${n.make}\` is the way in.`,
        `const bad: ${n.brand} = raw;`,
      ),
    ),
  );
}

/** One refusal: a named function whose single statement must not compile. */
function refusal(signature: string, reason: string, offending: string): string {
  return dedent`
    export function ${signature} {
      // ${reason}
      // @ts-expect-error
      ${offending}

      void bad;
    }
  `;
}


function typeTests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const validating = shape.construction !== "cast";

  const claims = sections(
    dedent`
      /** A raw \`${n.base}\` is refused where \`${n.brand}\` is wanted, which is the entire point. */
      export type RawIsRefused = Expect<NotAssignable<${n.base}, ${n.brand}>>;
    `,
    dedent`
      /** And the converse holds, so nothing that already accepted a \`${n.base}\` has to change. */
      export type BrandIsStillA${shape.numeric ? "Number" : "String"} = Expect<Extends<${n.brand}, ${n.base}>>;
    `,
    dedent`
      /**
       * Two brands over the same primitive do not interchange.
       *
       * Stated with a locally declared second symbol, because this is the claim that would silently
       * become false if the mark were a string tag: two tags reading \`"${n.brand}"\` and \`"${n.sibling}"\`
       * are different, but two modules that both reached for the same word would not be.
       */
      declare const other: unique symbol;
      type ${n.sibling} = ${n.base} & { readonly [other]: "${n.sibling}" };

      export type BrandsDoNotMix = Expect<NotAssignable<${n.brand}, ${n.sibling}>>;
    `,
    when(
      validating,
      dedent`
        /** The constructor's result is the branded type exactly, not something assignable to it. */
        export type Constructor${shape.construction === "result" ? "Carries" : "Returns"}TheBrand = Expect<
          Equal<${shape.construction === "result" ? `Extract<ReturnType<typeof ${n.make}>, { ok: true }>["value"]` : `ReturnType<typeof ${n.make}>`}, ${n.brand}>
        >;
      `,
    ),
    when(
      validating,
      dedent`
        /**
         * The guard narrows, rather than merely answering.
         *
         * Asserted through a function that relies on the narrowing: written to return \`boolean\`, the
         * guard would leave \`value\` a plain \`${n.base}\` here and this would not compile.
         */
        export function narrows(value: ${n.base}): ${n.brand} | undefined {
          return ${n.guard}(value) ? value : undefined;
        }

        export type GuardNarrows = Expect<
          Equal<ReturnType<typeof narrows>, ${n.brand} | undefined>
        >;
      `,
    ),
    when(
      shape.numeric,
      dedent`
        /**
         * Arithmetic discards the mark.
         *
         * Stated about the sum itself rather than about \`number\` in general, which would restate the
         * first claim on this page and prove nothing new. Not a defect to route around, either: the type
         * is declining to assume that a sum of two valid quantities is itself valid, which is why a
         * derived value has to go back through the constructor.
         */
        export function sum(a: ${n.brand}, b: ${n.brand}): number {
          return a + b;
        }

        export type SumIsUnbranded = Expect<Equal<ReturnType<typeof sum>, number>>;
      `,
    ),
  );

  return sections(
    dedent`
      /**
       * What the compiler is asked to prove.
       *
       * Nothing here runs, and nothing here should: this file's suffix keeps it out of every runner while
       * leaving it in front of the compiler, which is the only thing that can check a claim about a type.
       * A brand that had stopped working would behave identically at run time to one that still did.
       *
       * No claim below concerns nullability. With \`strictNullChecks\` off, \`undefined\` is assignable to
       * everything, so such a claim would mean one thing for one caller and the opposite for another —
       * and an assertion whose meaning depends on the reader's compiler options is not one.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: validating ? [n.guard, n.make] : [],
      types: [n.brand],
    }),
    typeAssertKit([
      "Equal",
      "Extends",
      "NotAssignable",
    ]),
    claims,
  );
}

function tests(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;
  const validating = shape.construction !== "cast";

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
       * What is left for a suite that runs.
       *
       * Not the guarantee — that is settled before this file executes, and \`${n.stem}${TYPE_TEST_SUFFIX}\`
       * is where it is asserted. What remains is the complement, and it is worth more than it sounds: that
       * the mark is *erased*. A caller has to know the value is still a plain ${n.base} at run time, or the
       * type would be a cost in disguise — breaking equality, \`Map\` keys, or a trip through JSON.
       ${validating ? "*\n       * And the rule itself, which is ordinary run-time behaviour and belongs here." : ""}
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [...(validating ? [n.guard, n.make] : []), n.unsafe],
      types: [n.brand],
    }),
    erasureCases(shape),
    when(validating, ruleCases(shape)),
  );
}

function erasureCases(shape: Shape): string {
  const n = shape.names;
  const good = shape.numeric ? "3" : '"ORD-1"';
  const other = shape.numeric ? "4" : '"ORD-2"';

  return dedent`
    describe("${n.brand} at run time", () => {
      it("is exactly the primitive it wraps", () => {
        // The annotation is half the assertion. A brand widens to its base with no cast, which is what
        // keeps the value usable in code that never heard of the type — and it is also what lets the
        // comparison below be written at all, since \`toBe\` is typed against whatever it was given.
        const erased: ${n.base} = ${n.unsafe}(${good});

        expect(typeof erased).toBe("${n.base}");
        expect(erased).toBe(${good});
      });

      it("compares and keys like the primitive", () => {
        const first = ${n.unsafe}(${good});
        const again = ${n.unsafe}(${good});

        // Identity has to be unchanged, or the type would have broken every \`Map\`, \`Set\` and \`===\`
        // it touches — a run-time cost for a compile-time guarantee, which is not the trade on offer.
        expect(first === again).toBe(true);

        const seen = new Map<${n.brand}, number>([[first, 1]]);
        expect(seen.get(again)).toBe(1);
        expect(seen.get(${n.unsafe}(${other}))).toBe(undefined);
      });

      it("survives a trip through JSON unchanged", () => {
        const value = ${n.unsafe}(${good});
        const round = JSON.parse(JSON.stringify({ value })) as { value: ${n.base} };

        // The value survives; the *evidence* does not. What comes back is a plain ${n.base}, which is why
        // a boundary reading it has to go through the constructor again rather than assert its way in.
        expect(round.value).toBe(${good});
      });
    });
  `;
}

function ruleCases(shape: Shape): string {
  const n = shape.names;
  const good = shape.numeric ? "3" : '"ORD-1"';
  const bad = shape.numeric ? "1.5" : '"   "';
  const worse = shape.numeric ? "-1" : '""';

  const accepted =
    shape.construction === "assert"
      ? dedent`
          it("returns the value it was given when the rule holds", () => {
            const made: ${n.base} = ${n.make}(${good});

            expect(made).toBe(${good});
          });

          it("throws on a value that breaks the rule", () => {
            expect(() => ${n.make}(${bad})).toThrow(/${n.brand}/);
            expect(() => ${n.make}(${worse})).toThrow(/${n.brand}/);
          });
        `
      : dedent`
          it("reports the value when the rule holds", () => {
            expect(${n.make}(${good})).toEqual({ ok: true, value: ${good} });
          });

          it("reports why, rather than throwing, when it does not", () => {
            const refused = ${n.make}(${bad});

            expect(refused.ok).toBe(false);
            expect(refused.ok === false ? refused.error.received : undefined).toBe(${bad});
          });
        `;

  return dedent`
    describe("${n.make}", () => {
    ${indentBlock(accepted)}

      it("agrees with the guard on every value", () => {
        // The two must not be able to disagree: a guard that accepted what the constructor rejected
        // would hand out narrowed values the constructor considers invalid.
        for (const candidate of [${good}, ${bad}, ${worse}]) {
          const guarded = ${n.guard}(candidate);
          ${
            shape.construction === "assert"
              ? dedent`
                  let constructed = true;
                    try {
                      ${n.make}(candidate);
                    } catch {
                      constructed = false;
                    }
                `
              : `const constructed = ${n.make}(candidate).ok;`
          }

          expect(guarded).toBe(constructed);
        }
      });
    });
  `;
}

/** Indents a block by two, for nesting inside a `describe`. */
function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `  ${line}`))
    .join("\n");
}
