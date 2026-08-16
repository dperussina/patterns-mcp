/**
 * The `factory` pattern: construction dispatched on a key, with the key narrowing the return type.
 *
 * The classical factory is one of the patterns research §9 warns about — a frontier model writes the
 * textbook version unaided, and the textbook version in TypeScript is a class hierarchy nobody wants.
 * What is worth generating is the part the textbook does not have and a model reliably gets subtly
 * wrong: a product map whose lookup is *type-indexed*, so `create("express", input)` has type
 * `ExpressOrder` rather than the union of every product. That needs a mapped type over the string keys,
 * a generic method rather than a generic interface, and an `Extract<keyof M, string>` to keep symbol
 * keys out — individually small, and collectively why hand-written factories in TypeScript usually
 * return a union and cast at the call site.
 *
 * Two decisions worth stating, because both depart from what a caller might expect.
 *
 * There is no `async` option. A factory whose products are promises is `Factory<{ pdf: Promise<Pdf> }>`
 * — the product type is the caller's to choose and can already be a promise, so an async surface would
 * be a second spelling of something a type parameter expresses. This is the rare case where the shared
 * base vocabulary genuinely does not apply rather than applying awkwardly.
 *
 * Creation is split across two entry points instead of one, which is what keeps every option
 * meaningful. `create` takes a key the compiler has already checked, so it cannot fail. `from` takes a
 * `string` — a route parameter, a column, a field off a JSON body — and is the only place an unknown key
 * can arrive. Collapsing them into one method would mean either a failure arm on a call that cannot
 * fail, or a cast at every boundary; separating them is "parse, don't validate" applied to a lookup.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, documentedAt, joinLines, sections, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const factoryPattern: PatternModule = {
  name: "factory",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      dynamic: options.registration === "dynamic",
      results: options.errorMode === "result",
      context: options.context === true,
      names: namesFor(context),
    };
    const stem = shape.names.stem;

    const files: RenderedFile[] = [
      { path: `${stem}.ts`, role: "core", contents: core(shape) },
      { path: `${stem}-example.ts`, role: "example", contents: example(context, shape) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({ path: `${stem}.test.ts`, role: "test", contents: tests(context, shape) });

      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Shape {
  readonly dynamic: boolean;
  readonly results: boolean;
  readonly context: boolean;
  readonly names: Names;
}

/**
 * Every name the templates use, derived once.
 *
 * Two templates deriving `${entity.pascal}Factory` independently is how a rename ends up applied in one
 * file and not the other, so the derivation happens here and the templates only read.
 */
interface Names {
  readonly stem: string;
  /** The factory interface: `OrderFactory`, or `Factory` with no identifier. */
  readonly factory: string;
  /** Its constructor: `createOrderFactory`. */
  readonly build: string;
  /** The key union: `OrderKind`. */
  readonly kind: string;
  /** One creator: `OrderCreator`. */
  readonly creator: string;
  /** The full creator map: `OrderCreators`. */
  readonly creators: string;
  /** The failure value: `UnknownOrderKind`. */
  readonly failure: string;
  /** Its thrown form, under `errorMode: throw`. */
  readonly error: string;
  /** The outcome union, under `errorMode: result`: `OrderOutcome`. */
  readonly outcome: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;
  const factory = entity === undefined ? undefined : withNoun(entity, "Factory");

  return {
    stem: factory?.kebab ?? "factory",
    factory: factory?.pascal ?? "Factory",
    build: `create${factory?.pascal ?? "Factory"}`,
    kind: `${prefix}Kind`,
    creator: `${prefix}Creator`,
    creators: `${prefix}Creators`,
    failure: `Unknown${prefix}Kind`,
    error: `Unknown${prefix}KindError`,
    outcome: `${prefix}Outcome`,
  };
}

/** The type parameters every declaration in the file carries, plus any of its own. */
function typeParams(shape: Shape, own?: string): string {
  const list = [
    "M extends ProductMap",
    "I",
    ...(shape.context ? ["C"] : []),
    ...(own === undefined ? [] : [own]),
  ];
  return `<${list.join(", ")}>`;
}

/** The same list as arguments, for referring to an already-declared type. `first` replaces `M`. */
function typeArgs(shape: Shape, options: { first?: string; own?: string } = {}): string {
  const list = [
    options.first ?? "M",
    "I",
    ...(shape.context ? ["C"] : []),
    ...(options.own === undefined ? [] : [options.own]),
  ];
  return `<${list.join(", ")}>`;
}

/** Indents every line by `width`, leaving blank lines blank. */
function indentBy(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

function core(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "What a product map is allowed to be: any object type whose keys name products.",
        "`object` rather than the `Readonly<Record<string, unknown>>` this obviously wants to be, and the reason is a TypeScript rule that is easy to trip over. A *type alias* for an object gets an implicit index signature and satisfies `Record<string, unknown>`; an *interface* does not. So constraining to a record compiles until the first caller declares their product map the way almost everyone declares a type — as an interface — and then fails with a constraint error that says nothing about index signatures.",
        "Products can therefore be anything, which is correct here anyway: objects, functions, promises, primitives. Keys are narrowed to `Extract<keyof M, string>` wherever one is passed in, because a symbol key cannot arrive off a route parameter and admitting one would put a case in every signature below that no caller can reach.",
      ],
      "export type ProductMap = object;",
    ),
    documented(
      [
        "The keys of `M`, as the union of strings they are.",
        "Written with `Extract` rather than as `keyof M` so that it is the string keys and nothing else, which is what makes `supports` a usable type guard over a `string`.",
      ],
      `export type ${n.kind}<M extends ProductMap> = Extract<keyof M, string>;`,
    ),
    documented(
      [
        `One creator: given an input${shape.context ? " and the shared context" : ""}, it returns the product for its own key.`,
        "The key is a type parameter so that `M[K]` is the exact product type rather than the union, which is the property this whole file exists to preserve.",
      ],
      shape.context
        ? `export type ${n.creator}${typeParams(shape, "K extends keyof M")} = (input: I, context: C) => M[K];`
        : `export type ${n.creator}${typeParams(shape, "K extends keyof M")} = (input: I) => M[K];`,
    ),
    documented(
      [
        "The complete set of creators, one per key.",
        `A mapped type, so omitting a key is a compile error at the call to \`${n.build}\` rather than an \`undefined\` discovered the first time that key is requested.`,
      ],
      dedent`
        export type ${n.creators}${typeParams(shape)} = {
          readonly [K in ${n.kind}<M>]: ${n.creator}${typeArgs(shape, { own: "K" })};
        };
      `,
    ),
    documented(
      [
        "The one thing that can go wrong: a key that is not in the map.",
        '`known` is carried on the failure rather than left for the caller to look up, because the message a caller writes from this is almost always "expected one of …", and a failure value that cannot produce that message sends them back to the factory for it.',
      ],
      dedent`
        export interface ${n.failure} {
          readonly key: string;
          /** Every key the factory does recognise, sorted. */
          readonly known: readonly string[];
        }
      `,
    ),
    when(
      shape.results,
      documented(
        [
          "The outcome of a lookup that could fail.",
          "Deliberately the same shape as the `result` pattern's type — a literal `ok` discriminant with `value` and `error` arms — so a caller who has generated that pattern can pass this straight into its combinators, and a caller who has not still gets something that narrows in an `if` without importing anything.",
          "Compare the discriminant, as in `if (outcome.ok === false)`, rather than testing it for truthiness. Both narrow under `strict`, but only the comparison narrows in a project with `strictNullChecks` off, where `if (!outcome.ok)` leaves the type unnarrowed and reading `error` off it is an error.",
        ],
        dedent`
          export type ${n.outcome}<T> =
            | { readonly ok: true; readonly value: T }
            | { readonly ok: false; readonly error: ${n.failure} };
        `,
      ),
    ),
    factoryInterface(shape),
    builder(shape),
    when(!shape.results, errorClass(shape)),
  );
}

function factoryInterface(shape: Shape): string {
  const n = shape.names;
  const product = `M[${n.kind}<M>]`;

  const members = [
    documentedAt(
      2,
      [
        "Builds the product for a key the compiler has already checked.",
        "The return type is `M[K]`, so no cast is needed at the call site and passing a key outside the map is a compile error. This method has no failure mode; when the key is a `string` whose value is not yet known, use `from`.",
      ],
      `create<K extends ${n.kind}<M>>(kind: K, input: I): M[K];`,
    ),
    documentedAt(
      2,
      [
        "Builds the product for a key that arrived as a `string`.",
        shape.results
          ? "Returns the failure rather than raising it, so a boundary handed an unrecognised kind can answer with a 400 instead of unwinding."
          : `Raises \`${n.error}\` when the key is not recognised.`,
        "The product's type is the union of every product, which is the honest answer: the key was not known statically, so neither is what it builds. Narrow with `supports` first when the caller wants the key itself typed instead.",
      ],
      `from(key: string, input: I): ${shape.results ? `${n.outcome}<${product}>` : product};`,
    ),
    documentedAt(
      2,
      [
        "Whether this factory has a creator for `key`.",
        `A type guard, so a \`string\` that passes narrows to \`${n.kind}<M>\` and can then be handed to \`create\` — which is how a caller validates once at the edge and keeps a typed key from then on.`,
      ],
      `supports(key: string): key is ${n.kind}<M>;`,
    ),
    documentedAt(
      2,
      [
        "Every key this factory recognises, sorted.",
        "Sorted rather than in declaration order, so two factories built from the same keys report them identically however each literal was written.",
      ],
      `kinds(): readonly ${n.kind}<M>[];`,
    ),
    ...(shape.dynamic
      ? [
          documentedAt(
            2,
            [
              "A new factory that also knows `additions`, leaving this one untouched.",
              "The returned type is widened to `M & E`, so keys added at run time are as typed as the ones supplied at construction — which is what makes a plugin that registers a product usable without a cast.",
              "Immutable rather than a mutating `register`, because a method that added a key in place could not widen its own type, and its callers would be left asserting that a key exists. Adding is therefore composition: a plugin host folds `extend` over whatever it discovered.",
              "Keys already present are replaced, which is what lets a caller override one variant and keep the rest.",
            ],
            dedent`
              extend<E extends ProductMap>(
                additions: ${n.creators}${typeArgs(shape, { first: "E" })},
              ): ${n.factory}${typeArgs(shape, { first: "M & E" })};
            `,
          ),
        ]
      : []),
  ];

  return joinLines(
    documented(
      [
        `${n.factory}: construction dispatched on a key, typed so the key decides the product.`,
        "The type parameters are the whole design. `M` maps each key to the product that key builds, so a lookup narrows:",
        dedent`
          \`\`\`ts
          interface Shipments {
            readonly standard: StandardShipment;
            readonly express: ExpressShipment;
          }

          const factory = ${n.build}<Shipments, Request${when(shape.context, ", Rates")}>({
            standard: (request${when(shape.context, ", rates")}) => ({ method: "standard", ... }),
            express: (request${when(shape.context, ", rates")}) => ({ method: "express", ... }),
          }${when(shape.context, ", rates")});

          const express = factory.create("express", request);
          //    ^? ExpressShipment — not StandardShipment | ExpressShipment
          \`\`\`
        `,
        `\`I\` is the input every creator accepts${shape.context ? ", and `C` a context they all receive alongside it" : ""}. ${shape.context ? "Both are" : "It is a"} single type rather than a per-key one: a factory whose creators take unrelated arguments is a set of functions that happen to share a record, and is better written as that.`,
      ],
      `export interface ${n.factory}${typeParams(shape)} {`,
    ),
    members.join("\n\n"),
    "}",
  );
}

function builder(shape: Shape): string {
  const n = shape.names;
  const call = shape.context ? "(input, context)" : "(input)";

  const members = [
    dedent`
      create(kind, input) {
        return creators[kind]${call};
      },
    `,
    dedent`
      from(key, input) {
        if (!supports(key)) {
          ${
            shape.results
              ? "return { ok: false, error: { key, known } };"
              : `throw new ${n.error}({ key, known });`
          }
        }

        ${shape.results ? `return { ok: true, value: creators[key]${call} };` : `return creators[key]${call};`}
      },
    `,
    "supports,\n",
    dedent`
      kinds() {
        return known;
      },
    `,
    ...(shape.dynamic
      ? [
          dedent`
            // Both the type parameter and the argument are written out, unlike the methods above,
            // which take theirs from the interface. Contextual typing supplies a parameter's type but
            // does not put a type parameter's *name* in scope, so \`E\` has to be declared for the
            // assertion below to compile — and declaring it opts this method out of contextual typing,
            // which then leaves \`additions\` implicitly \`any\`. The two go together.
            extend<E extends ProductMap>(additions: ${n.creators}${typeArgs(shape, { first: "E" })}) {
              // Spread rather than mutate, so whoever else holds this factory keeps working. The cast
              // is the one this file needs: the compiler cannot see that a spread of two mapped types
              // satisfies the mapped type over their intersection, though every key of \`M & E\` is
              // present in one of them.
              return ${n.build}(
                { ...creators, ...additions } as ${n.creators}${typeArgs(shape, { first: "M & E" })},${when(shape.context, "\n    context,")}
              );
            },
          `,
        ]
      : []),
  ];

  return documented(
    [
      `Builds \`${n.factory}\` from a complete set of creators.`,
      "The creators are captured rather than copied, so a caller who mutates that object afterwards changes this factory's behaviour. Copying would be safer and is not what a factory should do: the map is nearly always a module-level constant, so a defensive copy per construction would be a cost paid by everyone to guard against something almost nobody does.",
    ],
    dedent`
      export function ${n.build}${typeParams(shape)}(
        creators: ${n.creators}${typeArgs(shape)},${when(shape.context, "\n  context: C,")}
      ): ${n.factory}${typeArgs(shape)} {
        // Sorted once here and shared by \`kinds\` and every failure value, since the creator map cannot
        // change afterwards. Sorting per call would turn what reads like a field access into a sort.
        //
        // Sorted in place, on the array \`Object.keys\` has just allocated, so nothing shared is
        // mutated. \`toSorted\` would say that more clearly and is ES2023, which would fail to compile
        // for a caller targeting ES2022. The cast is to the mutable array type rather than the
        // \`readonly\` one on purpose: \`Kind<M>[]\` is assignable to \`string[]\`, which makes the
        // assertion a legal narrowing, whereas a \`readonly\` target overlaps in neither direction and
        // would need a detour through \`unknown\`.
        const known: readonly ${n.kind}<M>[] = (Object.keys(creators) as ${n.kind}<M>[]).sort();

        // \`Object.hasOwn\`, not \`key in creators\`: \`in\` walks the prototype chain, so
        // \`supports("toString")\` would answer true and \`from("toString", input)\` would then call
        // whatever it found there.
        const supports = (key: string): key is ${n.kind}<M> => Object.hasOwn(creators, key);

        return {
      ${indentBy(members.join("\n\n"), 4)}
        };
      }
    `,
  );
}

function errorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Raised by `from` when the key is not one the factory knows.",
      "The unknown key and the known ones are properties as well as being in the message, because a handler that wants to report them should not have to parse its own error text.",
    ],
    dedent`
      export class ${n.error} extends Error {
        readonly key: string;
        readonly known: readonly string[];

        constructor(failure: ${n.failure}) {
          super(\`Unknown kind "\${failure.key}". Expected one of: \${failure.known.join(", ")}.\`);
          this.name = "${n.error}";
          this.key = failure.key;
          this.known = failure.known;
        }
      }
    `,
  );
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.build, ...(shape.results ? [] : [n.error])],
    }),
    dedent`
      /**
       * Two products with different fields, which is the case a factory is for. If every product had the
       * same shape, a record of partial values would do and no dispatch would be needed.
       */
      export interface StandardShipment {
        readonly method: "standard";
        readonly address: string;
        readonly estimatedDays: number;
      }

      export interface ExpressShipment {
        readonly method: "express";
        readonly address: string;
        readonly feeCents: number;
      }

      /** The map that gives the factory its type: one entry per kind. */
      export interface ShipmentProducts {
        readonly standard: StandardShipment;
        readonly express: ExpressShipment;
      }

      export interface ShipmentRequest {
        readonly address: string;
      }
    `,
    when(
      shape.context,
      dedent`
        /**
         * What every creator is given besides the request.
         *
         * A context rather than module state, so a test can build the factory with a fixed rate table
         * and nothing to stub.
         */
        export interface ShipmentRates {
          readonly standardDays: number;
          readonly expressFeeCents: number;
          readonly overnightCutoffHour: number;
        }
      `,
    ),
    dedent`
      export const shipments = ${n.build}<ShipmentProducts, ShipmentRequest${when(shape.context, ", ShipmentRates")}>(
        {
          standard: (request${when(shape.context, ", rates")}) => ({
            method: "standard",
            address: request.address,
            estimatedDays: ${shape.context ? "rates.standardDays" : "5"},
          }),
          express: (request${when(shape.context, ", rates")}) => ({
            method: "express",
            address: request.address,
            feeCents: ${shape.context ? "rates.expressFeeCents" : "1200"},
          }),
        }${when(shape.context, ",\n  { standardDays: 5, expressFeeCents: 1200, overnightCutoffHour: 18 }")},
      );

      /** A known key: the product type follows from it, with no cast and no union to narrow. */
      export function quoteExpress(request: ShipmentRequest): number {
        return shipments.create("express", request).feeCents;
      }
    `,
    dedent`
      /**
       * An unknown key, which is where a factory meets the outside world.
       *
       * ${
         shape.results
           ? "The failure carries what was asked for and what was available, so the message needs nothing else."
           : "The error carries what was asked for and what was available, so a handler needs nothing else."
       }
       */
      export function describe(method: string, request: ShipmentRequest): string {
      ${indentBy(
        shape.results
          ? dedent`
              const outcome = shipments.from(method, request);

              if (outcome.ok === false) {
                return \`No such method "\${outcome.error.key}". Try: \${outcome.error.known.join(", ")}.\`;
              }

              return \`Shipping to \${outcome.value.address} by \${outcome.value.method}.\`;
            `
          : dedent`
              try {
                const shipment = shipments.from(method, request);
                return \`Shipping to \${shipment.address} by \${shipment.method}.\`;
              } catch (error) {
                if (error instanceof ${n.error}) {
                  return \`No such method "\${error.key}". Try: \${error.known.join(", ")}.\`;
                }
                throw error;
              }
            `,
        2,
      )}
      }
    `,
    when(
      shape.dynamic,
      dedent`
        export interface OvernightShipment {
          readonly method: "overnight";
          readonly address: string;
          readonly cutoffHour: number;
        }

        /**
         * A kind added after the fact, still typed.
         *
         * \`overnight\` is not in \`ShipmentProducts\`, yet the call below returns \`OvernightShipment\`
         * rather than a union. That widening is what \`extend\` is for, and what a mutating
         * registration could not give.
         */
        export const withOvernight = shipments.extend<{ readonly overnight: OvernightShipment }>({
          overnight: (request${when(shape.context, ", rates")}) => ({
            method: "overnight",
            address: request.address,
            cutoffHour: ${shape.context ? "rates.overnightCutoffHour" : "18"},
          }),
        });

        export function cutoffHour(request: ShipmentRequest): number {
          return withOvernight.create("overnight", request).cutoffHour;
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
      : importsFrom(conventions, "vitest", {
          values: ["describe", "expect", "it"],
        });

  const cases = [
    dedent`
      it("builds the product for a checked key", () => {
        expect(build().create("alpha", { size: 2 }).label).toBe("${shape.context ? "ctx-2" : "size-2"}");
      });
    `,
    dedent`
      it("reports its kinds sorted rather than in declaration order", () => {
        expect(build().kinds()).toEqual(["alpha", "beta"]);
      });
    `,
    dedent`
      it("narrows a string it recognises", () => {
        const factory = build();
        const key: string = "beta";

        // The call inside the branch only compiles because \`supports\` narrowed \`key\` to a kind,
        // which is the guarantee this case exists to pin.
        expect(factory.supports(key) ? factory.create(key, { size: 1 }).tag : "none").toBe("beta");
      });
    `,
    dedent`
      it("does not treat an inherited property as a creator", () => {
        // \`toString\` exists on every object's prototype. A lookup written with \`in\` would find it
        // and then call it as a creator.
        expect(build().supports("toString")).toBe(false);
      });
    `,
    lookupCases(shape),
    ...(shape.dynamic ? [extendCases()] : []),
  ];

  return sections(
    dedent`
      /**
       * What these assert, and why each is here rather than being obvious.
       *
       * The type-level guarantee is the point of the pattern and cannot be asserted at run time: that
       * \`create("alpha", …)\` has the alpha product's type is settled when this file compiles. So the
       * suite's job is what a type cannot state — that an unrecognised key is reported together with
       * the keys that would have worked, that the key list is sorted rather than insertion-ordered, and
       * that an inherited property is not mistaken for a creator.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [n.build, ...(shape.results ? [] : [n.error])],
    }),
    dedent`
      interface Products {
        readonly alpha: { readonly tag: "alpha"; readonly label: string };
        readonly beta: { readonly tag: "beta"; readonly size: number };
      }

      interface Input {
        readonly size: number;
      }
    `,
    when(
      shape.context,
      dedent`
        interface Deps {
          readonly prefix: string;
        }
      `,
    ),
    dedent`
      function build() {
        return ${n.build}<Products, Input${when(shape.context, ", Deps")}>(
          {
            // Written out of alphabetical order deliberately: \`kinds()\` is asserted to come back
            // sorted, and a literal already in order could not tell the difference.
            beta: (input${when(shape.context, ", deps")}) => ({ tag: "beta", size: input.size${when(shape.context, " + deps.prefix.length")} }),
            alpha: (input${when(shape.context, ", deps")}) => ({
              tag: "alpha",
              label: ${shape.context ? "`${deps.prefix}-${input.size}`" : "`size-${input.size}`"},
            }),
          }${when(shape.context, ',\n    { prefix: "ctx" }')},
        );
      }
    `,
    dedent`
      describe("${n.build}", () => {
      ${indentBy(cases.join("\n\n"), 2)}
      });
    `,
  );
}

function lookupCases(shape: Shape): string {
  const n = shape.names;

  return shape.results
    ? dedent`
        describe("from", () => {
          it("returns the product for a known key", () => {
            const outcome = build().from("beta", { size: 3 });

            expect(outcome.ok).toBe(true);
            expect(outcome.ok === true ? outcome.value.tag : "missing").toBe("beta");
          });

          it("reports an unknown key with the keys that would have worked", () => {
            const outcome = build().from("gamma", { size: 3 });

            expect(outcome.ok).toBe(false);
            expect(outcome.ok === true ? "found" : outcome.error.key).toBe("gamma");
            expect(outcome.ok === true ? [] : outcome.error.known).toEqual(["alpha", "beta"]);
          });
        });
      `
    : dedent`
        describe("from", () => {
          it("returns the product for a known key", () => {
            expect(build().from("beta", { size: 3 }).tag).toBe("beta");
          });

          it("throws naming the keys that would have worked", () => {
            expect(() => build().from("gamma", { size: 3 })).toThrow(/gamma/);
          });

          it("carries the unknown key and the known ones as properties", () => {
            let thrown: unknown;

            try {
              build().from("gamma", { size: 3 });
            } catch (error) {
              thrown = error;
            }

            expect(thrown).toBeInstanceOf(${n.error});
            expect((thrown as ${n.error}).key).toBe("gamma");
            expect((thrown as ${n.error}).known).toEqual(["alpha", "beta"]);
          });
        });
      `;
}

/**
 * The `extend` block.
 *
 * The added creator takes no arguments in either form. A creator may declare fewer parameters than the
 * type allows, which keeps this case about widening rather than about the context option.
 */
function extendCases(): string {
  const gamma = '{ readonly gamma: { readonly tag: "gamma" } }';
  const creator = 'gamma: () => ({ tag: "gamma" }),';

  return dedent`
    describe("extend", () => {
      it("adds a kind without changing the factory it was called on", () => {
        const base = build();
        const extended = base.extend<${gamma}>({ ${creator} });

        expect(extended.create("gamma", { size: 1 }).tag).toBe("gamma");
        // The original is untouched, which is what makes sharing one safe.
        expect(base.supports("gamma")).toBe(false);
        expect(base.kinds()).toHaveLength(2);
      });

      it("keeps the kinds it did not replace reachable", () => {
        const extended = build().extend<${gamma}>({ ${creator} });

        expect(extended.create("alpha", { size: 4 }).tag).toBe("alpha");
        expect(extended.kinds()).toContain("beta");
        expect(extended.kinds()).toHaveLength(3);
      });

      it("replaces a kind that is already present", () => {
        const extended = build().extend<{
          readonly beta: { readonly tag: "beta"; readonly size: number };
        }>({
          beta: () => ({ tag: "beta", size: 99 }),
        });

        expect(extended.create("beta", { size: 1 }).size).toBe(99);
      });
    });
  `;
}
