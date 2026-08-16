/**
 * The `builder` pattern: a value assembled a field at a time, with the fields still owed in the type.
 *
 * The textbook builder is one of the patterns research §9 warns about — a frontier model writes
 * `setName`/`setEmail`/`build` unaided, and that version's defining property is that it cannot say
 * whether it is finished. `build()` returns the target type and throws, or worse returns an object
 * missing half its fields while claiming to be one. What is worth generating is the version where
 * being unfinished is a *compile* error, and the error names the fields that are missing.
 *
 * That is the `typestate` rendering: a phantom type parameter accumulating the keys supplied so far,
 * and a `build` member whose type is a non-callable interface named after what is still owed. Calling
 * it early reports `Type 'MissingRequired<"email" | "name">' has no call signatures`, which is a better
 * message than any runtime check could produce and arrives before the code runs.
 *
 * Three decisions are worth stating up front, because each rules out something a reader would expect.
 *
 * There is no `withName(value)` method, and there could not be one without a `Proxy`. The field names
 * belong to the caller's target type: the compiler knows them, and this module does not. A builder
 * offering per-field methods would have to invent them at call time, and invert `Capitalize` to recover
 * which field `withTotalCents` meant. `set("totalCents", …)` is one real method whose type parameter
 * carries the key, which buys the same narrowing with nothing to step through in a debugger.
 *
 * Steps return a new builder rather than `this`. That reads like a style choice and is not one: a
 * method that mutated in place could not widen its own type, so the accumulated-keys parameter — and
 * with it the whole compile-time guarantee — would be impossible. Immutability and the guarantee are
 * the same decision, and it happens to also fix the bug where two callers branch off one builder.
 *
 * Validation is deliberately absent. "Every required field was set" is what a type can express, and
 * this pattern exists to express it; "`endsAt` is after `startsAt`" is not, and belongs to
 * `parse-dont-validate` or `specification` rather than being folded in here so that `build` acquires a
 * failure mode in the one rendering that had none.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry } from "../expect-file.js";
import {
  dedent,
  doc,
  documented,
  documentedAt,
  joinLines,
  sections,
  when,
} from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const builderPattern: PatternModule = {
  name: "builder",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      typestate: options.completeness === "typestate",
      results: options.completeness === "result",
      collections: options.collections === true,
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
  /** `completeness: typestate`: the compiler tracks which fields have been supplied. */
  readonly typestate: boolean;
  /** `completeness: result`: `build` reports missing fields as a value. */
  readonly results: boolean;
  readonly collections: boolean;
  readonly names: Names;
}

/** True for both renderings that check at run time, which share every failure type. */
function checked(shape: Shape): boolean {
  return !shape.typestate;
}

/**
 * Every name the templates use, derived once.
 *
 * Two templates deriving `${entity.pascal}Builder` independently is how a rename ends up applied in one
 * file and not the other, so the derivation happens here and the templates only read.
 */
interface Names {
  readonly stem: string;
  /** The builder type: `OrderBuilder`, or `Builder` with no identifier. */
  readonly builder: string;
  /** Its constructor: `createOrderBuilder`. */
  readonly build: string;
  /** The constructor that seeds from a finished value: `createOrderBuilderFrom`. */
  readonly from: string;
  /** The string keys of the target: `OrderField`. */
  readonly field: string;
  /** The default for `Required`: `OrderRequiredKeys`. */
  readonly required: string;
  /** The array-valued keys of the target: `OrderCollectionKey`. */
  readonly collectionKey: string;
  /** One element of such a field: `OrderCollectionItem`. */
  readonly collectionItem: string;
  /** The step methods, under `completeness: typestate`: `OrderBuilderSteps`. */
  readonly steps: string;
  /** The conditional `build` member, under `completeness: typestate`: `OrderBuildStep`. */
  readonly buildStep: string;
  /** The un-callable stand-in that names what is owed: `OrderMissingRequired`. */
  readonly missing: string;
  /** The failure value, under the checked renderings: `OrderBuildFailure`. */
  readonly failure: string;
  /** Its message function: `describeOrderBuildFailure`. */
  readonly describe: string;
  /** Its thrown form, under `completeness: throw`: `OrderBuildError`. */
  readonly error: string;
  /** The outcome union, under `completeness: result`: `OrderBuildOutcome`. */
  readonly outcome: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const prefix = entity === undefined ? "" : entity.pascal;
  const builder = entity === undefined ? undefined : withNoun(entity, "Builder");
  const builderName = builder?.pascal ?? "Builder";

  return {
    stem: builder?.kebab ?? "builder",
    builder: builderName,
    build: `create${builderName}`,
    from: `create${builderName}From`,
    field: `${prefix}Field`,
    required: `${prefix}RequiredKeys`,
    collectionKey: `${prefix}CollectionKey`,
    collectionItem: `${prefix}CollectionItem`,
    steps: `${prefix}BuilderSteps`,
    buildStep: `${prefix}BuildStep`,
    missing: `${prefix}MissingRequired`,
    failure: `${prefix}BuildFailure`,
    describe: `describe${prefix}BuildFailure`,
    error: `${prefix}BuildError`,
    outcome: `${prefix}BuildOutcome`,
  };
}

/** Indents every line by `width`, leaving blank lines blank. */
function indentBy(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `${pad}${line}`))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The core module.

function core(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "A field of `Target`: its string keys.",
        "Narrowed to strings rather than being `keyof Target` because every name here ends up in a message or a required-field list, and a symbol-keyed field has no name to put in one. A target holding such a field can still be built — that field is simply not one this builder sets.",
      ],
      `export type ${n.field}<Target> = Extract<keyof Target, string>;`,
    ),
    when(shape.typestate, requiredKeysType(shape)),
    when(shape.collections, collectionTypes(shape)),
    when(shape.typestate, missingType(shape)),
    when(checked(shape), failureType(shape)),
    when(shape.results, outcomeType(shape)),
    when(checked(shape), describeFailure(shape)),
    when(checked(shape) && !shape.results, errorClass(shape)),
    shape.typestate ? typestateSurface(shape) : checkedInterface(shape),
    constructors(shape),
    internals(shape),
  );
}

function requiredKeysType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The fields `Target` does not mark optional, which is what `build` waits for by default.",
      `So \`${n.build}<Invoice>()\` requires exactly the fields \`Invoice\` declares without a \`?\`, and a caller who wants a different set says so with the second type argument.`,
      "Two pieces of it are worth reading. `-?` strips the optionality from the mapped type, so there is an entry for every key rather than an optional one that the lookup afterwards would fold into `undefined`. And `object extends Pick<Target, K>` is the test itself: the one-property object type picked out of an *optional* field is satisfied by `{}`, and the one picked out of a required field is not.",
    ],
    dedent`
      export type ${n.required}<Target> = Extract<
        { [K in keyof Target]-?: object extends Pick<Target, K> ? never : K }[keyof Target],
        ${n.field}<Target>
      >;
    `,
  );
}

function collectionTypes(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The fields of `Target` whose value is an array, which are the ones `add` accepts.",
        "The `Extract` around it is not decoration: without it the union is only known to be *some* subset of the keys, and every signature taking one of these would need a second constraint to say so. `Extract<X, Y>` is provably assignable to `Y`, which is what the constraint on `add` needs.",
      ],
      dedent`
        export type ${n.collectionKey}<Target> = Extract<
          { [K in keyof Target]-?: Target[K] extends readonly unknown[] ? K : never }[keyof Target],
          ${n.field}<Target>
        >;
      `,
    ),
    documented(
      ["One element of an array-valued field, so `add` takes items rather than an array."],
      `export type ${n.collectionItem}<Held> = Held extends readonly (infer Item)[] ? Item : never;`,
    ),
  );
}

function missingType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The stand-in `build` becomes while a required field is still owed.",
      `Nothing reads \`requires\` and nothing assigns it. This interface exists to be *named*: while fields are missing, \`build\` has this type instead of a function type, so calling it reports "This expression is not callable. Type '${n.missing}<"email" | "name">' has no call signatures" — a message that lists the fields the caller forgot.`,
      "Which is why `build` is a property here rather than being absent. Omitting the member would also be a compile error, but the error would be `Property 'build' does not exist on type …`, which says that something is wrong without saying what.",
    ],
    dedent`
      export interface ${n.missing}<Fields extends string> {
        readonly requires: Fields;
      }
    `,
  );
}

function failureType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The one thing that can go wrong: `build` was reached with required fields unset.",
      "`missing` is sorted, so two builders given the same required fields in different orders report them identically.",
    ],
    dedent`
      export interface ${n.failure} {
        readonly missing: readonly string[];
      }
    `,
  );
}

function outcomeType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The outcome of a build that could fail.",
      "Deliberately the same shape as the `result` pattern's type — a literal `ok` discriminant with `value` and `error` arms — so a caller who has generated that pattern can pass this straight into its combinators, and a caller who has not still gets something that narrows in an `if` without importing anything.",
      "Compare the discriminant, as in `if (outcome.ok === false)`, rather than testing it for truthiness. Both narrow under `strict`, but only the comparison narrows in a project with `strictNullChecks` off, where `if (!outcome.ok)` leaves the type unnarrowed and reading `error` off it is an error.",
    ],
    dedent`
      export type ${n.outcome}<T> =
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly error: ${n.failure} };
    `,
  );
}

function describeFailure(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The failure as a sentence, for a log line or a response body.",
      "Singular and plural are separated because a message reading “Missing required fields: recipient.” is the kind of detail that makes generated code look generated.",
    ],
    dedent`
      export function ${n.describe}(failure: ${n.failure}): string {
        const fields = failure.missing.join(", ");
        return failure.missing.length === 1
          ? \`Missing required field: \${fields}.\`
          : \`Missing required fields: \${fields}.\`;
      }
    `,
  );
}

function errorClass(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Raised by `build` when a required field was never set.",
      "The missing fields are a property as well as being in the message, because a handler that wants to report them should not have to parse its own error text.",
    ],
    dedent`
      export class ${n.error} extends Error {
        readonly missing: readonly string[];

        constructor(failure: ${n.failure}) {
          super(${n.describe}(failure));
          this.name = "${n.error}";
          this.missing = failure.missing;
        }
      }
    `,
  );
}

// ---------------------------------------------------------------------------
// The builder surface, in its two renderings.

/** The three declarations that make up the typestate builder: steps, the gated `build`, and the union. */
function typestateSurface(shape: Shape): string {
  const n = shape.names;
  const params = `<Target, Required extends ${n.field}<Target>, Provided extends ${n.field}<Target>>`;

  const members = [
    documentedAt(
      2,
      [
        "Sets a field, returning a builder that records having done so.",
        "`Provided | K` in the return type is the whole mechanism: each call widens the set of keys the type carries, and `build` compares that set against `Required`. The value is typed `Target[K]` rather than `unknown`, so the key and the value are checked against each other.",
      ],
      dedent`
        set<K extends ${n.field}<Target>>(
          key: K,
          value: Target[K],
        ): ${n.builder}<Target, Required, Provided | K>;
      `,
    ),
    ...(shape.collections
      ? [
          documentedAt(
            2,
            [
              "Appends to an array-valued field, which `set` would replace.",
              `The key is constrained to \`${n.collectionKey}<Target>\`, so \`add\` on a field that is not a collection is a compile error rather than an array quietly appearing where a string belonged.`,
              "Called with no items it still counts the field as provided, with an empty array — which is how a required collection is satisfied as empty rather than by a `set` that has to name the empty literal.",
            ],
            dedent`
              add<K extends ${n.collectionKey}<Target>>(
                key: K,
                ...items: readonly ${n.collectionItem}<Target[K]>[]
              ): ${n.builder}<Target, Required, Provided | K>;
            `,
          ),
        ]
      : []),
  ];

  return sections(
    joinLines(
      documented(
        [
          "The steps, which are the same whether or not the builder is finished.",
          "Separated from `build` because only `build` depends on what is still owed, and a conditional type has to be conditional over the whole declaration it appears in.",
        ],
        `export interface ${n.steps}${params} {`,
      ),
      members.join("\n\n"),
      "}",
    ),
    documented(
      [
        "`build`, present as a function only once every required field has been supplied.",
        "`[Exclude<Required, Provided>] extends [never]` rather than the unbracketed form, and the brackets are load-bearing: a bare conditional over a naked type parameter distributes across the union, so an unfinished builder with two fields owed would ask the question once per field and take the true branch for neither. Wrapping both sides in a tuple compares the union as one thing.",
      ],
      dedent`
        export type ${n.buildStep}${params} = [Exclude<Required, Provided>] extends [never]
          ? { build(): Target }
          : { readonly build: ${n.missing}<Exclude<Required, Provided>> };
      `,
    ),
    documented(
      [
        `\`${n.builder}\`: a value under construction, with the fields still owed in its type.`,
        "The type parameters are the design. `Target` is what is being built. `Required` is the set of fields `build` waits for, defaulting to the ones `Target` does not mark optional. `Provided` is what has been supplied so far, and a caller never writes it — it starts empty and each step adds to it:",
        dedent`
          \`\`\`ts
          const partial = ${n.build}<Invoice>().set("id", "inv-1");
          //    ^? ${n.builder}<Invoice, "id" | "total", "id">

          partial.build();
          //      ^ not callable: ${n.missing}<"total">
          \`\`\`
        `,
        `Narrowing \`Required\` below the non-optional keys is allowed, and is a promise the caller is making: \`${n.build}<Invoice, "id">()\` will hand back a value typed \`Invoice\` with \`total\` absent. That is occasionally what a caller wants for a partial update, and it is worth knowing it is not checked.`,
      ],
      dedent`
        export type ${n.builder}<
          Target,
          Required extends ${n.field}<Target> = ${n.required}<Target>,
          Provided extends ${n.field}<Target> = never,
        > = ${n.steps}<Target, Required, Provided> & ${n.buildStep}<Target, Required, Provided>;
      `,
    ),
  );
}

/** The checked builder: one interface, because nothing about it varies with what has been supplied. */
function checkedInterface(shape: Shape): string {
  const n = shape.names;

  const members = [
    documentedAt(
      2,
      [
        "Sets a field, returning a builder that has it.",
        "The value is typed `Target[K]`, so the key and the value are still checked against each other — that much a type can do here. What it cannot do is track *which* keys were set, which is what the typestate rendering is for and why this one takes the required fields as a value.",
      ],
      `set<K extends ${n.field}<Target>>(key: K, value: Target[K]): ${n.builder}<Target>;`,
    ),
    ...(shape.collections
      ? [
          documentedAt(
            2,
            [
              "Appends to an array-valued field, which `set` would replace.",
              "Called with no items it still counts the field as provided, with an empty array — which is how a required collection is satisfied as empty.",
            ],
            dedent`
              add<K extends ${n.collectionKey}<Target>>(
                key: K,
                ...items: readonly ${n.collectionItem}<Target[K]>[]
              ): ${n.builder}<Target>;
            `,
          ),
        ]
      : []),
    documentedAt(
      2,
      [
        "Assembles the value, checking that every required field was set.",
        shape.results
          ? "Returns the failure rather than raising it, so a boundary handed a half-filled form can answer with the fields it still needs instead of unwinding."
          : `Raises \`${n.error}\` naming the fields that were never set.`,
      ],
      `build(): ${shape.results ? `${n.outcome}<Target>` : "Target"};`,
    ),
  ];

  return joinLines(
    documented(
      [
        `\`${n.builder}\`: a value under construction, checked when it is built.`,
        "There is one type parameter rather than three, because nothing here is tracked in the type: the fields that must be present are a run-time list, and `build` compares it against what it has.",
        "Which is the rendering to reach for when the fields are not known statically — a form submission, a CSV header, a config file. The typestate rendering can prove more, and cannot help at all when the keys arrive as strings.",
      ],
      `export interface ${n.builder}<Target> {`,
    ),
    members.join("\n\n"),
    "}",
  );
}

// ---------------------------------------------------------------------------
// Constructors and the shared step.

function constructors(shape: Shape): string {
  return shape.typestate ? typestateConstructors(shape) : checkedConstructors(shape);
}

function typestateConstructors(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "An empty builder for `Target`.",
        `Nothing is passed, and nothing needs to be: the required fields are \`${n.required}<Target>\` by default and live only in the type. That is the difference the \`completeness\` option makes — under the checked renderings the same list has to be handed over as a value, because no type is tracking it.`,
      ],
      dedent`
        export function ${n.build}<
          Target,
          Required extends ${n.field}<Target> = ${n.required}<Target>,
        >(): ${n.builder}<Target, Required> {
          return step<Target, Required, never>({});
        }
      `,
    ),
    documented(
      [
        "A builder seeded from a value that is already complete, for editing one field of it.",
        "`Provided` is every field, so `build` is callable straight away and a caller changes what they came to change. The value is copied rather than held, so the original is unaffected by what follows.",
      ],
      dedent`
        export function ${n.from}<Target>(
          value: Target,
        ): ${n.builder}<Target, ${n.required}<Target>, ${n.field}<Target>> {
          return step({ ...(value as Readonly<Record<string, unknown>>) });
        }
      `,
    ),
  );
}

function checkedConstructors(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "An empty builder for `Target`, waiting on `required`.",
        "The list is a value here, which is the point of this rendering: the fields that will arrive are not known when this code is compiled, so the check cannot be either.",
        "Sorted once, on the copy this makes rather than on the caller's array, so every failure reports its fields in the same order however the list was written.",
      ],
      dedent`
        export function ${n.build}<Target>(
          required: readonly ${n.field}<Target>[],
        ): ${n.builder}<Target> {
          return step([...required].sort(), {});
        }
      `,
    ),
    documented(
      [
        "A builder seeded from a value that is already complete, for editing one field of it.",
        "No required list is needed: a value of type `Target` has every field `Target` requires, and no step can remove one, so `build` cannot fail here. It is still typed as though it could, since the type has no way to say that this builder is the one that started full.",
        "The value is copied rather than held, so the original is unaffected by what follows.",
      ],
      dedent`
        export function ${n.from}<Target>(value: Target): ${n.builder}<Target> {
          return step([], { ...(value as Readonly<Record<string, unknown>>) });
        }
      `,
    ),
  );
}

function internals(shape: Shape): string {
  return shape.typestate ? typestateStep(shape) : checkedStep(shape);
}

function typestateStep(shape: Shape): string {
  const n = shape.names;

  const methods = [
    dedent`
      set(key: string, value: unknown) {
        return step({ ...values, [key]: value });
      },
    `,
    ...(shape.collections
      ? [
          dedent`
            add(key: string, ...items: readonly unknown[]) {
              const held = values[key];
              const existing = Array.isArray(held) ? (held as readonly unknown[]) : [];
              return step({ ...values, [key]: [...existing, ...items] });
            },
          `,
        ]
      : []),
    dedent`
      build() {
        return { ...values } as Target;
      },
    `,
  ];

  return documented(
    [
      "One rung of the ladder: the accumulated fields, plus the methods that add to them.",
      "Every method returns a fresh call to this rather than mutating `values`, which is what makes two callers branching off one builder safe — and, more fundamentally, what makes the typestate possible at all: a method that mutated in place would have to return `this`, and `this` cannot widen its own type parameters.",
      "The cast on the way out is the one this file needs. The object below has a single concrete shape; the type it is returned as is an intersection of an interface and a conditional, and `build` in particular is a function here and a non-callable property in one arm of that conditional. No assignability check could pass, and none should — the conditional is a claim about the caller's key sets, which is exactly the thing this function is trusted to have got right.",
    ],
    dedent`
      function step<
        Target,
        Required extends ${n.field}<Target>,
        Provided extends ${n.field}<Target>,
      >(values: Readonly<Record<string, unknown>>): ${n.builder}<Target, Required, Provided> {
        const builder = {
      ${indentBy(methods.join("\n\n"), 4)}
        };

        return builder as unknown as ${n.builder}<Target, Required, Provided>;
      }
    `,
  );
}

function checkedStep(shape: Shape): string {
  const n = shape.names;

  const failure = shape.results
    ? `return { ok: false, error: { missing } };`
    : `throw new ${n.error}({ missing });`;
  const success = shape.results
    ? `return { ok: true, value: { ...values } as Target };`
    : `return { ...values } as Target;`;

  const methods = [
    dedent`
      set(key, value) {
        return step<Target>(required, { ...values, [key]: value });
      },
    `,
    ...(shape.collections
      ? [
          dedent`
            add(key, ...items) {
              const held = values[key];
              const existing = Array.isArray(held) ? (held as readonly unknown[]) : [];
              return step<Target>(required, { ...values, [key]: [...existing, ...items] });
            },
          `,
        ]
      : []),
    dedent`
      build() {
        const missing = required.filter((key) => !Object.hasOwn(values, key));

        if (missing.length > 0) {
          ${failure}
        }

        ${success}
      },
    `,
  ];

  return documented(
    [
      "One rung of the ladder: the required fields, the accumulated ones, and the methods between them.",
      "Every method returns a fresh call to this rather than mutating `values`, so two callers branching off one builder cannot interfere.",
      "`Object.hasOwn` rather than a check against `undefined`, for two reasons. A field explicitly set to `undefined` is a decision the caller made and the compiler already vetted, and reading it back as unset would quietly overrule both. And `key in values` — the other spelling that reaches for — walks the prototype chain, so a field named `toString` would count as provided by every object that ever existed.",
    ],
    dedent`
      function step<Target>(
        required: readonly string[],
        values: Readonly<Record<string, unknown>>,
      ): ${n.builder}<Target> {
        return {
      ${indentBy(methods.join("\n\n"), 4)}
        };
      }
    `,
  );
}

// ---------------------------------------------------------------------------
// The example.

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [
        n.build,
        n.from,
        ...(shape.results ? [n.describe] : []),
        ...(checked(shape) && !shape.results ? [n.error] : []),
      ],
      types: shape.results ? [n.outcome] : [],
    }),
    documented(
      [
        "The value being assembled.",
        shape.typestate
          ? "`note` being optional is load-bearing below: the fields `build` waits for are the ones declared without a `?`, so `note` is the one field it does not."
          : "`note` being optional is why it is absent from the required list below: the list says what `build` waits for, and an optional field is not that.",
      ],
      dedent`
        export interface ShipmentLabel {
          readonly trackingId: string;
          readonly recipient: string;${when(shape.collections, "\n  readonly parcels: readonly string[];")}
          readonly note?: string;
        }
      `,
    ),
    shape.typestate ? typestateExample(shape) : checkedExample(shape),
  );
}

function typestateExample(shape: Shape): string {
  const n = shape.names;
  const parcels = shape.collections ? `\n    .add("parcels", "box-1", "box-2")` : "";

  return sections(
    documented(
      ["Every required field set, so `build` is a function and returns the value."],
      dedent`
        export function label(): ShipmentLabel {
          return ${n.build}<ShipmentLabel>()
            .set("trackingId", "1Z999")
            .set("recipient", "Ada Lovelace")${parcels}
            .build();
        }
      `,
    ),
    documented(
      [
        "Changing one field of a finished value.",
        "Seeded complete, so `build` is available at once and the other fields carry over untouched.",
      ],
      dedent`
        export function readdressed(existing: ShipmentLabel, recipient: string): ShipmentLabel {
          return ${n.from}(existing).set("recipient", recipient).build();
        }
      `,
    ),
    documented(
      [
        "What the compiler refuses, kept here rather than described.",
        "Each `@ts-expect-error` below is an assertion, not an apology: the token under it must fail to compile, and if a change to the builder ever let one through, this file would stop compiling on the unused directive. So the guarantee the pattern exists for is checked every time this bundle is generated, which no run-time test could do — by the time anything runs, the question has been settled.",
        "Every directive sits on the line directly above the token that fails, which is why the calls below are broken across lines that would otherwise fit on one. A directive covers the next line and nothing further, and the compiler reports a bad argument at the argument rather than at the call — so a refusal written on one line would suppress nothing and report two errors instead of none.",
        "Delete a directive and hover over the expression to read the message.",
      ],
      sections(
        `const partial = ${n.build}<ShipmentLabel>().set("trackingId", "1Z999");`,
        joinLines(
          "export const tooEarly =",
          "  // `build` is not a function while a required field is still owed. Its type",
          "  // is named after the fields that are missing, so the message lists them.",
          "  // @ts-expect-error",
          "  partial.build();",
        ),
        joinLines(
          `export const wrongType = ${n.build}<ShipmentLabel>().set(`,
          `  "recipient",`,
          "  // A field's value has to have that field's type.",
          "  // @ts-expect-error",
          "  1,",
          ");",
        ),
        joinLines(
          `export const noSuchField = ${n.build}<ShipmentLabel>().set(`,
          "  // A name the target does not have is not a field of it.",
          "  // @ts-expect-error",
          `  "sender",`,
          `  "Ada",`,
          ");",
        ),
        when(
          shape.collections,
          joinLines(
            `export const notACollection = ${n.build}<ShipmentLabel>().add(`,
            "  // `add` takes only a field whose value is an array.",
            "  // @ts-expect-error",
            `  "recipient",`,
            `  "Ada",`,
            ");",
          ),
        ),
      ),
    ),
  );
}

function checkedExample(shape: Shape): string {
  const n = shape.names;
  const required = shape.collections
    ? `["parcels", "trackingId", "recipient"]`
    : `["trackingId", "recipient"]`;
  const returns = shape.results ? `${n.outcome}<ShipmentLabel>` : "ShipmentLabel";

  const loop = joinLines(
    dedent`
      if (key === "trackingId" || key === "recipient" || key === "note") {
        builder = builder.set(key, value);
      }
    `,
    when(
      shape.collections,
      dedent`
        if (key === "parcel") {
          builder = builder.add("parcels", value);
        }
      `,
    ),
  );

  return sections(
    documented(
      [
        "Fields arriving as strings, which is what the checked rendering is for.",
        "The keys here are `string` at run time — a form field, a CSV column, a config key — so no type could have tracked which of them turned up. The required fields are therefore a list, given in whatever order reads best, and `build` reports the ones that never arrived.",
        "The list is not in alphabetical order on purpose: the failure sorts it, so a message never depends on how this literal was written.",
      ],
      dedent`
        export function labelFrom(
          entries: readonly (readonly [string, string])[],
        ): ${returns} {
          let builder = ${n.build}<ShipmentLabel>(${required});

          for (const [key, value] of entries) {
        ${indentBy(loop, 4)}
          }

          return builder.build();
        }
      `,
    ),
    documented(
      [
        "The same entries, answered as a sentence.",
        shape.results
          ? "Nothing is thrown, so the caller decides what an incomplete label means: a 422 with the missing fields, a prompt, a retry."
          : `The error carries the missing fields as well as naming them, so a handler that wants to list them does not have to read its own message.`,
      ],
      dedent`
        export function describeLabel(entries: readonly (readonly [string, string])[]): string {
        ${indentBy(
          shape.results
            ? dedent`
                const outcome = labelFrom(entries);

                if (outcome.ok === false) {
                  return ${n.describe}(outcome.error);
                }

                return \`\${outcome.value.trackingId} for \${outcome.value.recipient}\`;
              `
            : dedent`
                try {
                  const label = labelFrom(entries);
                  return \`\${label.trackingId} for \${label.recipient}\`;
                } catch (error) {
                  if (error instanceof ${n.error}) {
                    return error.message;
                  }
                  throw error;
                }
              `,
          2,
        )}
        }
      `,
    ),
    documented(
      [
        "Changing one field of a finished value.",
        "Nothing can be missing from a value that already has the type, so this build cannot fail — though it is still shaped as though it could, since the type cannot say which builders started full.",
      ],
      dedent`
        export function readdressed(existing: ShipmentLabel, recipient: string): ${returns} {
          return ${n.from}(existing).set("recipient", recipient).build();
        }
      `,
    ),
  );
}

// ---------------------------------------------------------------------------
// The suite.

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
    doc(
      "What these assert, and why each is here rather than being obvious.",
      shape.typestate
        ? `The guarantee this rendering exists for is not asserted here, because it cannot be: that \`build\` is uncallable while a field is owed is settled when the bundle compiles, and \`${n.stem}-example.ts\` pins it with \`@ts-expect-error\`. What is left for a run-time suite is everything a type does not decide — that a later step wins, that a step leaves the builder it was called on alone, and what a collection does across several calls.`
        : "Every case here is about what the type could not decide, which in this rendering is most of it: which fields were set, which are still owed, and what a caller is told about them.",
    ),
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [
        n.build,
        n.from,
        ...(shape.results ? [n.describe] : []),
        ...(checked(shape) && !shape.results ? [n.error] : []),
      ],
      types: shape.results ? [n.outcome] : [],
    }),
    fixtures(shape),
    dedent`
      describe("${n.build}", () => {
      ${indentBy(cases(shape).join("\n\n"), 2)}
      });
    `,
  );
}

/** The target every case builds, plus the helpers that keep the cases readable. */
function fixtures(shape: Shape): string {
  const n = shape.names;
  const required = shape.collections ? `["tags", "id", "count"]` : `["id", "count"]`;

  return sections(
    dedent`
      interface Label {
        readonly id: string;
        readonly count: number;${when(shape.collections, "\n  readonly tags: readonly string[];")}
        readonly note?: string;
      }
    `,
    when(
      checked(shape),
      dedent`
        /**
         * Written out of alphabetical order deliberately: the failure is asserted to report its fields
         * sorted, and a list already in order could not tell the difference.
         *
         * \`as const\` because a bare array literal in a \`const\` widens to \`string[]\`, and the field
         * names have to stay literal for the builder to accept them as keys of \`Label\`.
         */
        const required = ${required} as const;
      `,
    ),
    dedent`
      /** A builder with \`id\` set, so each case decides for itself about the rest. */
      function started() {
        return ${n.build}<Label>(${when(checked(shape), "required")}).set("id", "L1");
      }
    `,
    when(
      shape.results,
      documented(
        [
          "The built value, or a failure loud enough to say which field was forgotten.",
          "A helper rather than an `if` in every case: a suite that unwrapped by hand would spend more lines narrowing than asserting.",
        ],
        dedent`
          function built(outcome: ${n.outcome}<Label>): Label {
            if (outcome.ok === false) {
              throw new Error(${n.describe}(outcome.error));
            }
            return outcome.value;
          }
        `,
      ),
    ),
  );
}

/**
 * The run-time cases.
 *
 * The first five hold in every rendering and are written once, with `value` papering over where the
 * built object is: behind an outcome under `completeness: result`, and in hand otherwise.
 */
function cases(shape: Shape): readonly string[] {
  const value = (expression: string): string =>
    shape.results ? `built(${expression}.build())` : `${expression}.build()`;

  // Everything but `count`, so a case can decide whether to supply it or to be refused for not.
  const withoutCount = shape.collections ? `started().add("tags", "a")` : "started()";
  const filled = `${withoutCount}.set("count", 2)`;
  const expected = shape.collections
    ? `{ id: "L1", count: 2, tags: ["a"] }`
    : `{ id: "L1", count: 2 }`;

  return [
    dedent`
      it("assembles the fields it was given and nothing else", () => {
        expect(${value(filled)}).toEqual(${expected});
      });
    `,
    dedent`
      it("lets a later step replace an earlier one", () => {
        expect(${value(`${filled}.set("count", 9)`)}.count).toBe(9);
      });
    `,
    dedent`
      it("leaves the builder a step was called on alone", () => {
        const base = ${filled};
        const changed = ${value('base.set("count", 9)')};

        expect(changed.count).toBe(9);
        // Sharing a half-built value is only safe because of this.
        expect(${value("base")}.count).toBe(2);
      });
    `,
    dedent`
      it("hands back a new object each time", () => {
        const base = ${filled};

        expect(${value("base")} === ${value("base")}).toBe(false);
      });
    `,
    dedent`
      it("omits an optional field that was never set", () => {
        expect(Object.hasOwn(${value(filled)}, "note")).toBe(false);
      });
    `,
    ...(shape.collections ? [collectionCases(value)] : []),
    seededCase(shape, value, filled),
    ...(checked(shape) ? checkedCases(shape, withoutCount) : []),
  ];
}

function collectionCases(value: (expression: string) => string): string {
  const base = `started().set("count", 2)`;

  return dedent`
    describe("add", () => {
      it("appends across calls rather than replacing", () => {
        expect(${value(`${base}.add("tags", "a").add("tags", "b", "c")`)}.tags).toEqual([
          "a",
          "b",
          "c",
        ]);
      });

      it("appends to a value that arrived through set", () => {
        expect(${value(`${base}.set("tags", ["a"]).add("tags", "b")`)}.tags).toEqual(["a", "b"]);
      });

      it("provides an empty array when given no items", () => {
        // Which is how a required collection is satisfied as empty.
        expect(${value(`${base}.add("tags")`)}.tags).toEqual([]);
      });
    });
  `;
}

function seededCase(shape: Shape, value: (expression: string) => string, filled: string): string {
  const n = shape.names;

  return dedent`
    describe("${n.from}", () => {
      it("changes the field it was told to and carries the rest over", () => {
        const original = ${value(filled)};
        const edited = ${value(`${n.from}(original).set("count", 9)`)};

        expect(edited).toEqual({ ...original, count: 9 });
        // The value it was seeded from is copied, so it is untouched.
        expect(original.count).toBe(2);
      });
    });
  `;
}

function checkedCases(shape: Shape, withoutCount: string): readonly string[] {
  const n = shape.names;
  const missing = shape.collections ? `["count", "id", "tags"]` : `["count", "id"]`;
  const empty = `${n.build}<Label>(required)`;

  return [
    shape.results
      ? dedent`
          describe("build", () => {
            it("reports every field still owed, sorted however the list was written", () => {
              const outcome = ${empty}.build();

              expect(outcome.ok).toBe(false);
              expect(outcome.ok === true ? [] : outcome.error.missing).toEqual(${missing});
            });

            it("names a single missing field in the singular", () => {
              const outcome = ${withoutCount}.build();

              expect(outcome.ok === true ? "built" : ${n.describe}(outcome.error)).toBe(
                "Missing required field: count.",
              );
            });

            it("counts a field set to a falsy value as set", () => {
              // The check is \`Object.hasOwn\`, not truthiness: zero is a total.
              const outcome = ${withoutCount}.set("count", 0).build();

              expect(outcome.ok).toBe(true);
              expect(outcome.ok === true ? outcome.value.count : -1).toBe(0);
            });
          });
        `
      : dedent`
          describe("build", () => {
            it("throws naming every field still owed", () => {
              expect(() => ${empty}.build()).toThrow(/count, id/);
            });

            it("carries the missing fields as a property, sorted", () => {
              let thrown: unknown;

              try {
                ${empty}.build();
              } catch (error) {
                thrown = error;
              }

              expect(thrown).toBeInstanceOf(${n.error});
              expect((thrown as ${n.error}).missing).toEqual(${missing});
            });

            it("names a single missing field in the singular", () => {
              expect(() => ${withoutCount}.build()).toThrow(/Missing required field: count\\./);
            });

            it("counts a field set to a falsy value as set", () => {
              // The check is \`Object.hasOwn\`, not truthiness: zero is a total.
              expect(${withoutCount}.set("count", 0).build().count).toBe(0);
            });
          });
        `,
  ];
}
