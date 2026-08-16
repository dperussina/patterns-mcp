/**
 * The `specification` pattern: a business rule as a value that both tests a candidate and says what it is.
 *
 * The classical treatments stop at composability. What this emits adds the thing TypeScript can contribute,
 * which is that a specification carries the refinement it establishes: `orders.filter(paid.isSatisfiedBy)`
 * gives back a list whose element type records that the rule held, so a function downstream that requires a
 * paid order will take the result and will not take an unfiltered list.
 *
 * Four facts were established with the compiler at every strictness the engine generates for, and each one
 * changed what is emitted.
 *
 * Composition keeps the refinement. `and` intersects and `or` unions, through chains at least three deep,
 * and through a variadic form whose non-empty tuple constraint makes the meaningless empty call an error.
 *
 * Negation cannot keep it, and the type that looks as though it can is worse than no type at all.
 * `Exclude<Order, PaidOrder>` is not the complement — it is `Order`, because `Order` is not a union and
 * `Exclude` distributes over unions or does nothing. Since TypeScript checks no predicate's *logic*, a
 * `not` declared that way compiles, reads as though it computed a complement, and silently hands back the
 * unrefined type under a name that claims otherwise. So `not` gives the refinement up in its signature,
 * and the example asserts that a chain stops narrowing once it is used.
 *
 * A leaf declared as data still earns a refinement from its own value, so choosing translation costs
 * nothing in precision — `whereEquals("status", "paid")` refines exactly as a hand-written guard would,
 * while an impossible value, an unknown field, or a numeric comparison against a string field are each
 * refused.
 *
 * And the refinement survives only when a rule is given a name before being combined. Inferred inside a
 * nested call, the literal widens to the whole property type with `strictNullChecks` off, so the emitted
 * code binds every rule to a name first. That is what the pattern asks for anyway — the point of it is
 * that rules have names — but it is worth knowing that the idiomatic form is also the only one whose types
 * hold everywhere.
 */

import { importsFrom, siblingSpecifier } from "../../generate/imports.js";
import { expectFileEntry } from "../expect-file.js";
import { dedent, documented, sections, when } from "../../render/helpers.js";
import { TYPE_TEST_SUFFIX, typeAssertKit } from "../type-assert-file.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const specificationPattern: PatternModule = {
  name: "specification",

  /**
   * `NumericField` names the second field the example needs in order to show a numeric criterion
   * beside a string one, and the four that follow are the type-level assertions and the helpers they
   * are written with. None is a thing anyone names a domain type, which is why they are refused rather
   * than worked around: a caller who genuinely wants `Equal` is better served by one line telling them
   * it is taken than by a suite whose assertions have quietly become about their type.
   *
   * `RefinedBy` only exists under `composition=free`, where it accumulates the refinements a list of
   * specifications proves. It was missed by the first sweep of this class, which read one render at the
   * defaults: a name a branch writes is written just as literally as the rest.
   */
  emits: [
    "Equal",
    "Expect",
    "NegationErasesRefinement",
    "NotAssignable",
    "NumericField",
    "RefinedBy",
    "UnfilteredDoesNot",
  ],

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const shape: Shape = {
      fluent: options.composition !== "free",
      translation: options.translation === true,
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
  /** `composition: "fluent"` — the combinators hang off the specification itself. */
  readonly fluent: boolean;
  readonly translation: boolean;
  readonly names: Names;
}

interface Names {
  readonly stem: string;
  readonly subject: string;
  readonly lower: string;
  readonly spec: string;
  readonly criterion: string;
  readonly query: string;
  readonly sql: string;
}

function namesFor(context: RenderContext): Names {
  const entity = context.names.entity;
  const subject = entity?.pascal ?? "Candidate";
  const kebab = entity?.kebab ?? "candidate";

  return {
    stem: `${kebab}-specification`,
    subject,
    lower: entity?.camel ?? "candidate",
    spec: `${subject}Specification`,
    criterion: `${subject}Criterion`,
    query: `${subject}Query`,
    sql: `toSql`,
  };
}

function core(shape: Shape): string {
  return sections(
    subjectType(shape),
    when(shape.translation, queryTypes(shape)),
    specificationType(shape),
    factory(shape),
    leaves(shape),
    when(!shape.fluent, freeCombinators(shape)),
    when(shape.translation, sqlRenderer(shape)),
  );
}

function subjectType(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "What the rules are about.",
      "A concrete type rather than a type parameter, because a specification is only worth naming when it is a rule about something in particular. The `status` field is a literal union on purpose: it is what lets a rule refine, since narrowing to `\"paid\"` says something a `string` could not.",
    ],
    dedent`
      export interface ${n.subject} {
        readonly id: string;
        readonly total: number;
        readonly status: "draft" | "paid" | "cancelled";
      }
    `,
  );
}

function queryTypes(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "One comparison, as data.",
        "The reason the leaves are declarative rather than arbitrary functions: a closure can be run but not read, so a rule expressed as one cannot be handed to anything that does not already agree to call it. This can be read, and that is the whole of what translation needs.",
      ],
      dedent`
        export interface ${n.criterion} {
          readonly field: keyof ${n.subject};
          readonly operator: "equals" | "atLeast" | "atMost";
          readonly value: string | number;
        }
      `,
    ),
    documented(
      [
        "A rule, as a tree.",
        "The shape composition produces. Each combinator adds a node rather than closing over a function, which is what keeps a composite rule as legible to a translator as the leaves it was built from.",
      ],
      dedent`
        export type ${n.query} =
          | { readonly kind: "criterion"; readonly criterion: ${n.criterion} }
          | { readonly kind: "every"; readonly nodes: readonly ${n.query}[] }
          | { readonly kind: "some"; readonly nodes: readonly ${n.query}[] }
          | { readonly kind: "complement"; readonly node: ${n.query} };
      `,
    ),
  );
}

function specificationType(shape: Shape): string {
  const n = shape.names;

  const members = [
    ...(shape.translation
      ? [
          dedent`
            /** What this rule is, readable by anything that wants to push it down. */
            readonly query: ${n.query};
          `,
        ]
      : []),
    dedent`
      /**
       * Whether the candidate satisfies the rule — and, in the type, what satisfying it establishes.
       *
       * A type predicate rather than a \`boolean\`. The difference is the pattern's contribution here:
       * \`filter\` over this yields a list whose element type records that the rule held, so a function
       * requiring a paid ${n.lower} accepts the result and refuses an unfiltered list.
       *
       * Worth knowing before annotating a call site: writing \`: boolean\` on a predicate passed to
       * \`filter\` silently disables the inference that makes this work, so the narrowing is lost to a
       * change that looks like an improvement.
       */
      isSatisfiedBy(candidate: ${n.subject}): candidate is N;
    `,
    ...(shape.fluent
      ? [
          dedent`
            /** Both rules. The refinements intersect, so the result narrows by everything checked. */
            and<M extends ${n.subject}>(other: ${n.spec}<M>): ${n.spec}<N & M>;
          `,
          dedent`
            /** Either rule. The refinements union, which is the most that can honestly be claimed. */
            or<M extends ${n.subject}>(other: ${n.spec}<M>): ${n.spec}<N | M>;
          `,
          dedent`
            /**
             * The opposite rule, with the refinement given up.
             *
             * Not an oversight, and the reason is worth stating because the alternative looks better and
             * is wrong. \`Exclude<${n.subject}, N>\` appears to name the complement; it is \`${n.subject}\`
             * itself, since \`Exclude\` distributes over unions and \`${n.subject}\` is not one. Declaring
             * that as the result would compile — TypeScript checks no predicate's logic — and would hand
             * back the unrefined type under a name claiming otherwise. Giving it up says what is true.
             */
            not(): ${n.spec};
          `,
        ]
      : []),
  ];

  return documented(
    [
      "A named rule, and what satisfying it establishes.",
      "The type parameter is what a satisfied candidate is known to be, defaulting to no refinement so that a rule which establishes nothing beyond itself needs no annotation.",
    ],
    dedent`
      export interface ${n.spec}<N extends ${n.subject} = ${n.subject}> {
        ${members.join("\n\n  ")}
      }
    `,
  );
}

function factory(shape: Shape): string {
  const n = shape.names;
  const queryParameter = shape.translation ? `, query: ${n.query}` : "";
  const queryField = shape.translation ? "\n    query," : "";

  // Each method's second argument only exists when the rule carries a description of itself.
  const node = (kind: string, contents: string): string =>
    shape.translation ? `, { kind: "${kind}", ${contents} }` : "";

  const methods = shape.fluent
    ? [
        `and<M extends ${n.subject}>(other: ${n.spec}<M>): ${n.spec}<N & M> {`,
        `  return specification(`,
        `    (candidate): candidate is N & M => predicate(candidate) && other.isSatisfiedBy(candidate)`,
        `    ${node("every", "nodes: [query, other.query]")},`,
        `  );`,
        `},`,
        `or<M extends ${n.subject}>(other: ${n.spec}<M>): ${n.spec}<N | M> {`,
        `  return specification(`,
        `    (candidate): candidate is N | M => predicate(candidate) || other.isSatisfiedBy(candidate)`,
        `    ${node("some", "nodes: [query, other.query]")},`,
        `  );`,
        `},`,
        `not(): ${n.spec} {`,
        `  return specification(`,
        `    (candidate): candidate is ${n.subject} => !predicate(candidate)`,
        `    ${node("complement", "node: query")},`,
        `  );`,
        `},`,
      ].join("\n")
    : "";

  return documented(
    [
      `Builds a specification from a predicate${shape.translation ? " and its description." : "."}`,
      "Internal, because every rule should arrive through a named leaf below. A specification assembled inline at a call site is the unnamed condition this pattern exists to replace.",
    ],
    dedent`
      function specification<N extends ${n.subject}>(
        predicate: (candidate: ${n.subject}) => candidate is N${queryParameter},
      ): ${n.spec}<N> {
        return {
          isSatisfiedBy: predicate,${queryField}
      ${methods}
        };
      }
    `,
  );
}
function leaves(shape: Shape): string {
  return shape.translation ? declarativeLeaves(shape) : predicateLeaves(shape);
}

function declarativeLeaves(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "The fields a magnitude comparison makes sense on.",
        "Derived from the subject rather than listed, so a field that changes type is either still comparable or no longer offered, and never merely assumed.",
      ],
      dedent`
        type NumericField = {
          [K in keyof ${n.subject}]: ${n.subject}[K] extends number ? K : never;
        }[keyof ${n.subject}];
      `,
    ),
    documented(
      [
        "A rule that a field holds a particular value.",
        "The refinement is derived from the value rather than restated, which is what makes the declarative form free: `whereEquals(\"status\", \"paid\")` narrows exactly as a hand-written guard would, and there is no second place for the two to disagree.",
        "The signature also does the checking a hand-written rule would not. An unknown field is refused, and so is a value the field cannot hold — a rule that no candidate could ever satisfy is a mistake worth catching where it is written rather than in whatever fails to happen later.",
      ],
      dedent`
        export function whereEquals<K extends keyof ${n.subject}, V extends ${n.subject}[K]>(
          field: K,
          value: V,
        ): ${n.spec}<${n.subject} & Readonly<Record<K, V>>> {
          return specification(
            (candidate): candidate is ${n.subject} & Readonly<Record<K, V>> =>
              candidate[field] === value,
            { kind: "criterion", criterion: { field, operator: "equals", value } },
          );
        }
      `,
    ),
    documented(
      [
        "Rules about magnitude.",
        "No refinement, because there is none to have: that a total is at least a hundred is not something a type can record about it. Claiming one here would be the same error `not` avoids, and the honest signature is the unrefined one.",
      ],
      dedent`
        export function whereAtLeast<K extends NumericField>(field: K, value: number): ${n.spec} {
          return specification(
            (candidate): candidate is ${n.subject} => (candidate[field] as number) >= value,
            { kind: "criterion", criterion: { field, operator: "atLeast", value } },
          );
        }

        export function whereAtMost<K extends NumericField>(field: K, value: number): ${n.spec} {
          return specification(
            (candidate): candidate is ${n.subject} => (candidate[field] as number) <= value,
            { kind: "criterion", criterion: { field, operator: "atMost", value } },
          );
        }
      `,
    ),
  );
}

function predicateLeaves(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      [
        "Names an arbitrary rule.",
        "Anything computable, since nothing here has to be readable by a translator. The cost of that freedom is that a rule built this way cannot be pushed anywhere — it can only be applied to candidates already in hand.",
      ],
      dedent`
        export function specify(predicate: (candidate: ${n.subject}) => boolean): ${n.spec} {
          return specification((candidate): candidate is ${n.subject} => predicate(candidate));
        }
      `,
    ),
    documented(
      [
        "Names a rule that establishes something about what satisfies it.",
        "Separate from `specify` because the two cannot be one function: a predicate returning `boolean` is not accepted where a type predicate is wanted, so a single entry point would either refuse ordinary rules or refuse to carry a refinement. Two names, each honest about what it gives back.",
        "The guard is the caller's to get right. TypeScript checks that the refinement is assignable to the subject and nothing about whether the body establishes it, which is the one place this pattern rests on care rather than on the compiler.",
      ],
      dedent`
        export function refine<N extends ${n.subject}>(
          predicate: (candidate: ${n.subject}) => candidate is N,
        ): ${n.spec}<N> {
          return specification(predicate);
        }
      `,
    ),
  );
}

function freeCombinators(shape: Shape): string {
  const n = shape.names;
  const node = (kind: string, contents: string): string =>
    shape.translation ? `,\n    { kind: "${kind}", ${contents} }` : "";

  return sections(
    documented(
      [
        "Both rules, and either rule.",
        "Standalone rather than methods, so a specification stays a plain value with no behaviour attached, and so composing over a collection of rules is an ordinary fold.",
      ],
      dedent`
        export function and<A extends ${n.subject}, B extends ${n.subject}>(
          a: ${n.spec}<A>,
          b: ${n.spec}<B>,
        ): ${n.spec}<A & B> {
          return specification(
            (candidate): candidate is A & B => a.isSatisfiedBy(candidate) && b.isSatisfiedBy(candidate)${node("every", "nodes: [a.query, b.query]")},
          );
        }

        export function or<A extends ${n.subject}, B extends ${n.subject}>(
          a: ${n.spec}<A>,
          b: ${n.spec}<B>,
        ): ${n.spec}<A | B> {
          return specification(
            (candidate): candidate is A | B => a.isSatisfiedBy(candidate) || b.isSatisfiedBy(candidate)${node("some", "nodes: [a.query, b.query]")},
          );
        }
      `,
    ),
    documented(
      [
        "The opposite rule, with the refinement given up.",
        `Deliberate, and the tempting alternative is a trap: \`Exclude<${n.subject}, N>\` looks like the complement and is \`${n.subject}\` itself, because \`Exclude\` distributes over unions and \`${n.subject}\` is not one. Declared that way this would compile — TypeScript checks no predicate's logic — and would return the unrefined type under a name claiming otherwise.`,
      ],
      dedent`
        export function not(specificationToInvert: ${n.spec}): ${n.spec} {
          return specification(
            (candidate): candidate is ${n.subject} =>
              !specificationToInvert.isSatisfiedBy(candidate)${node("complement", "node: specificationToInvert.query")},
          );
        }
      `,
    ),
    documented(
      [
        "What every rule in the list establishes, intersected.",
        "The recursion walks the tuple the call site passed, so the refinement of a variadic combination is as precise as a chain of binary ones. It bottoms out at `unknown`, which intersects away to nothing.",
      ],
      dedent`
        type RefinedBy<S> = S extends readonly [${n.spec}<infer N>, ...infer Rest]
          ? Rest extends readonly ${n.spec}[]
            ? N & RefinedBy<Rest>
            : N
          : unknown;
      `,
    ),
    documented(
      [
        "All of them, or any of them.",
        "The parameter is a non-empty tuple rather than an array, which buys two things at once: the refinement of each member survives into the result, and the empty call is refused. That refusal matters more than it looks — `every()` would have to be vacuously true and `some()` vacuously false, and a rule that ignores its candidate is never what was meant.",
      ],
      dedent`
        export function every<S extends readonly [${n.spec}, ...${n.spec}[]]>(
          ...specifications: S
        ): ${n.spec}<${n.subject} & RefinedBy<S>> {
          return specification(
            (candidate): candidate is ${n.subject} & RefinedBy<S> =>
              specifications.every((rule) => rule.isSatisfiedBy(candidate))${node("every", "nodes: specifications.map((rule) => rule.query)")},
          );
        }

        export function some<S extends readonly [${n.spec}, ...${n.spec}[]]>(
          ...specifications: S
        ): ${n.spec} {
          return specification(
            (candidate): candidate is ${n.subject} =>
              specifications.some((rule) => rule.isSatisfiedBy(candidate))${node("some", "nodes: specifications.map((rule) => rule.query)")},
          );
        }
      `,
    ),
  );
}

function sqlRenderer(shape: Shape): string {
  const n = shape.names;

  return sections(
    documented(
      ["How each operator is spelled."],
      dedent`
        const OPERATORS: Readonly<Record<${n.criterion}["operator"], string>> = {
          equals: "=",
          atLeast: ">=",
          atMost: "<=",
        };
      `,
    ),
    documented(
      [
        "The rule as something a datastore can answer.",
        "The point of translation: without it, a rule can only be applied to rows already fetched, so the filter costs a full read however selective it is.",
        `Values become placeholders rather than text, so nothing a caller supplies is ever spliced into the statement. Field names *are* spliced, which would be the obvious hole — and is closed by the type rather than by escaping: \`field\` is \`keyof ${n.subject}\`, so the only strings that can reach it are property names of a type declared in this file. A caller cannot pass an arbitrary one because a caller cannot name one.`,
        "The empty forms render as constants rather than as empty parentheses, which keeps the output valid SQL for a tree the free combinators can build.",
      ],
      dedent`
        export function ${n.sql}(rule: ${n.spec}): {
          readonly text: string;
          readonly parameters: readonly (string | number)[];
        } {
          const parameters: (string | number)[] = [];
          const text = render(rule.query, parameters);

          return { text, parameters };
        }

        function render(node: ${n.query}, parameters: (string | number)[]): string {
          switch (node.kind) {
            case "criterion": {
              parameters.push(node.criterion.value);

              return \`\${node.criterion.field} \${OPERATORS[node.criterion.operator]} ?\`;
            }
            case "every": {
              if (node.nodes.length === 0) return "1 = 1";

              return \`(\${node.nodes.map((each) => render(each, parameters)).join(" AND ")})\`;
            }
            case "some": {
              if (node.nodes.length === 0) return "1 = 0";

              return \`(\${node.nodes.map((each) => render(each, parameters)).join(" OR ")})\`;
            }
            case "complement": {
              return \`NOT \${render(node.node, parameters)}\`;
            }
          }
        }
      `,
    ),
  );
}
/** How a composite is spelled, which is the whole of what `composition` changes at a call site. */
function combine(shape: Shape, left: string, right: string, operator: "and" | "or"): string {
  return shape.fluent ? `${left}.${operator}(${right})` : `${operator}(${left}, ${right})`;
}

function negate(shape: Shape, subject: string): string {
  return shape.fluent ? `${subject}.not()` : `not(${subject})`;
}

/** The named rules, shared by the example and both suites so they are declared once. */
function ruleDeclarations(shape: Shape): string {
  const n = shape.names;

  return shape.translation
    ? dedent`
        export const paid = whereEquals("status", "paid");
        export const cancelled = whereEquals("status", "cancelled");
        export const substantial = whereAtLeast("total", 100);
      `
    : dedent`
        export const paid = refine(
          (candidate: ${n.subject}): candidate is ${n.subject} & { readonly status: "paid" } =>
            candidate.status === "paid",
        );
        export const cancelled = refine(
          (candidate: ${n.subject}): candidate is ${n.subject} & { readonly status: "cancelled" } =>
            candidate.status === "cancelled",
        );
        export const substantial = specify((candidate) => candidate.total >= 100);
      `;
}

function importedNames(shape: Shape): readonly string[] {
  return shape.translation
    ? [
        "whereAtLeast",
        "whereAtMost",
        "whereEquals",
        ...(shape.fluent ? [] : ["and", "every", "not", "or", "some"]),
        shape.names.sql,
      ].toSorted()
    : [
        "refine",
        "specify",
        ...(shape.fluent ? [] : ["and", "every", "not", "or", "some"]),
      ].toSorted();
}

function example(context: RenderContext, shape: Shape): string {
  const { conventions } = context;
  const n = shape.names;

  return sections(
    dedent`
      /**
       * Rules with names, composed, and applied.
       *
       * The refusals at the end are assertions rather than illustrations: \`@ts-expect-error\` is satisfied
       * by an error and violated by silence, so each states that the line below it must not compile. They
       * are emitted whether or not tests were asked for, because a specification that has quietly stopped
       * refining behaves identically at run time to one that has not, and only the compiler can tell them
       * apart.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [...importedNames(shape)],
      types: [n.subject, ...(shape.translation ? [n.query] : [])],
    }),
    documented(
      [
        "The rules, each with a name.",
        "This is the pattern. A condition written inline at the place it is needed cannot be reused, cannot be composed, cannot be tested on its own, and cannot be discussed — and the name is what a reader of the composite below is actually reading.",
        ...(shape.translation
          ? [
              "Each is bound to a name before being combined for a second reason, which is a compiler detail rather than a matter of style: inferred inside a nested call the literal widens to the whole property type with `strictNullChecks` off, and the refinement is lost. The idiomatic form is also the one whose types hold everywhere.",
            ]
          : []),
      ],
      ruleDeclarations(shape),
    ),
    documented(
      [
        "Composites, which are rules too.",
        "Nothing distinguishes a combined rule from a leaf — it has a name, it tests a candidate, and it can be combined again. That closure is what makes the pattern worth having over a bag of helper functions.",
      ],
      dedent`
        export const collectable = ${combine(shape, "paid", "substantial", "and")};
        export const ignorable = ${combine(shape, "cancelled", negate(shape, "substantial"), "or")};
      `,
    ),
    documented(
      [
        "What the refinement is for.",
        "The parameter requires a paid ${lower}, and no cast, check, or comment gets a caller past it — only having filtered. That is the difference between a rule that returns `boolean` and one that returns a type predicate: the first leaves everyone downstream to be careful, the second makes carelessness fail to compile.",
      ].map((line) => line.replace("${lower}", n.lower)),
      dedent`
        export function receipt(${n.lower}: ${n.subject} & { readonly status: "paid" }): string {
          return \`\${${n.lower}.id}: \${String(${n.lower}.total)} paid\`;
        }

        export function receipts(${n.lower}s: readonly ${n.subject}[]): readonly string[] {
          // The filter is what changes the element type, so \`receipt\` is applicable here and would not be
          // on the unfiltered list.
          return ${n.lower}s.filter(paid.isSatisfiedBy).map(receipt);
        }
      `,
    ),
    when(shape.translation, translationUse(shape)),
    when(!shape.fluent, variadicUse(shape)),
    exampleRefusals(shape),
  );
}

function translationUse(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "The same rule, asked of the datastore instead.",
      "One declaration produced both of these, which is the property worth the constraint that leaves be declarative: there is no second expression of the rule to drift from the first, so the rows this selects and the candidates the predicate accepts cannot come apart.",
    ],
    dedent`
      export function collectableRows(): { readonly text: string; readonly parameters: readonly (string | number)[] } {
        return ${n.sql}(collectable);
      }

      export function describe(query: ${n.query}): string {
        return query.kind;
      }
    `,
  );
}

function variadicUse(shape: Shape): string {
  const n = shape.names;

  return documented(
    [
      "Rules gathered rather than chained.",
      "What the standalone form buys: a list of rules assembled elsewhere — from configuration, from a caller, from a loop — combined in one call, with the refinement of each member still in the result.",
    ],
    dedent`
      export const everything = every(paid, substantial);

      export function anyOf(${n.lower}s: readonly ${n.subject}[]): readonly ${n.subject}[] {
        return ${n.lower}s.filter(some(paid, cancelled).isSatisfiedBy);
      }
    `,
  );
}

function exampleRefusals(shape: Shape): string {
  const n = shape.names;

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
      export function refusesAnUnrefined${n.subject}(${n.lower}: ${n.subject}): void {
        // The guarantee, stated as a compile error: nothing here establishes that this one is paid, and
        // \`receipt\` says so rather than trusting its caller.
        //
        // Written as a direct call on purpose. The shorter spelling — passing \`receipt\` to \`map\` over an
        // unfiltered list — asserts nothing reliably, because \`strictFunctionTypes\` is part of \`strict\`
        // and without it function parameters are compared bivariantly, so a callback wanting the narrower
        // type is accepted where the wider one is expected. That version compiles under a loose config,
        // which makes the directive unused and the file stop building on the wrong thing. Argument
        // assignability at a direct call is invariant everywhere, so this holds at every strictness.
        // @ts-expect-error
        receipt(${n.lower});
      }
    `,
    dedent`
      export function refusesToNarrowThroughNegation(${n.lower}s: readonly ${n.subject}[]): void {
        const notPaid = ${negate(shape, "paid")};

        // \`not\` gives up the refinement, deliberately: the complement of a refinement is not expressible,
        // and the type that appears to name it — \`Exclude\` — silently returns the unrefined type. So the
        // chain stops narrowing here, and that is the honest outcome rather than a gap.
        //
        // Asserted as an assignment rather than a call for the same reason as above: array assignability
        // is covariant in the element type and unaffected by how function parameters are compared.
        // @ts-expect-error
        const paidOnly: readonly (${n.subject} & { readonly status: "paid" })[] = ${n.lower}s.filter(
          notPaid.isSatisfiedBy,
        );
        void paidOnly;
      }
    `,
    when(
      shape.translation,
      sections(
        dedent`
          export function refusesAnUnknownField(): void {
            // A field the subject does not have. Caught where the rule is written rather than wherever its
            // absence eventually shows.
            // @ts-expect-error
            whereEquals("nonesuch", 1);
          }
        `,
        dedent`
          export function refusesAnImpossibleValue(): void {
            // A value the field cannot hold. This is a rule no candidate could satisfy, which is always a
            // mistake and never a subtle one.
            // @ts-expect-error
            whereEquals("status", "shipped");
          }
        `,
        dedent`
          export function refusesAMagnitudeOnText(): void {
            // \`status\` is not a number, so there is no ordering to compare against.
            // @ts-expect-error
            whereAtLeast("status", 1);
          }
        `,
      ),
    ),
    when(
      !shape.fluent,
      dedent`
        export function refusesAnEmptyCombination(): void {
          // \`every()\` would have to be vacuously true and \`some()\` vacuously false, which is to say a rule
          // that ignores its candidate — never what was meant, and refused by the non-empty tuple.
          // @ts-expect-error
          every();
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
       * compiler, which is the only thing that can check these claims: a specification that has stopped
       * refining filters exactly the same candidates as one that has not, so no suite that executes could
       * tell the difference.
       *
       * No claim below concerns nullability. Bundles are verified at every strictness, and with
       * \`strictNullChecks\` off \`undefined\` is assignable to everything, so such an assertion would mean
       * one thing for one caller and the opposite for another.
       */
    `,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [...importedNames(shape)],
      types: [n.subject],
    }),
    typeAssertKit(["Equal", "Extends", "NotAssignable"]),
    documented(
      [
        "The rules under test, declared as the example declares them.",
        "Repeated here rather than imported so that this file states its own subject: a compile-time claim reads as an argument, and an argument whose premises are elsewhere is harder to check.",
      ],
      ruleDeclarations(shape).replace(/^export /gm, ""),
    ),
    dedent`
      declare const ${n.lower}s: readonly ${n.subject}[];
    `,
    dedent`
      /**
       * Filtering by a rule changes the element type.
       *
       * The pattern's contribution in one assertion. Everything else here is about what survives.
       */
      const filtered = ${n.lower}s.filter(paid.isSatisfiedBy);
      export type FilteringRefines = Expect<
        Extends<(typeof filtered)[number], { readonly status: "paid" }>
      >;
      export type UnfilteredDoesNot = Expect<
        NotAssignable<${n.subject}, { readonly status: "paid" }>
      >;
    `,
    dedent`
      /**
       * Composition keeps the refinement, however deep.
       *
       * Both of these, because a combinator that returned the unrefined type would still compile everywhere
       * and would quietly cost every call site downstream its guarantee. The three-deep case is separate
       * because preserving one level and losing the next is a plausible way to be wrong.
       */
      const bothFiltered = ${n.lower}s.filter(${combine(shape, "paid", "substantial", "and")}.isSatisfiedBy);
      export type CompositionRefines = Expect<
        Extends<(typeof bothFiltered)[number], { readonly status: "paid" }>
      >;

      const deeplyFiltered = ${n.lower}s.filter(
        ${combine(shape, combine(shape, "paid", "substantial", "and"), "substantial", "and")}.isSatisfiedBy,
      );
      export type DeepCompositionRefines = Expect<
        Extends<(typeof deeplyFiltered)[number], { readonly status: "paid" }>
      >;
    `,
    dedent`
      /**
       * Negation gives the refinement up, exactly.
       *
       * \`Equal\` rather than \`NotAssignable\`, because the claim is not merely that the refinement is weaker
       * — it is that the result is the plain subject. That is what rules out the tempting wrong version,
       * where \`Exclude\` produces something that reads as a complement and is the subject in disguise.
       */
      const negated = ${n.lower}s.filter(${negate(shape, "paid")}.isSatisfiedBy);
      export type NegationErasesRefinement = Expect<Equal<(typeof negated)[number], ${n.subject}>>;
    `,
    dedent`
      /**
       * A union is the most an alternative can claim.
       *
       * Neither side alone holds, so nothing narrower than the union would be true — and the union is worth
       * having, since a discriminated subject stays narrowable afterwards.
       */
      const either = ${n.lower}s.filter(${combine(shape, "paid", "cancelled", "or")}.isSatisfiedBy);
      export type AlternativeUnions = Expect<
        Extends<(typeof either)[number], { readonly status: "paid" | "cancelled" }>
      >;
    `,
    when(
      !shape.fluent,
      dedent`
        /**
         * The variadic form is as precise as a chain.
         *
         * Which is the point of walking the tuple rather than accepting an array: an array parameter would
         * have collapsed every member's refinement into the element type they share.
         */
        const gathered = ${n.lower}s.filter(every(paid, substantial).isSatisfiedBy);
        export type VariadicRefines = Expect<
          Extends<(typeof gathered)[number], { readonly status: "paid" }>
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
      : importsFrom(conventions, "vitest", { values: ["describe", "expect", "it"] });

  return sections(
    dedent`
      /**
       * What is left for a suite that runs.
       *
       * Not the refinements, which are settled before this file executes and asserted in
       * \`${n.stem}${TYPE_TEST_SUFFIX}\`. What remains is which candidates each rule actually accepts, and
       * whether composition means what it says — a rule that refined correctly and matched the wrong
       * candidates would satisfy every claim in that file.
       */
    `,
    framework,
    importsFrom(conventions, siblingSpecifier(conventions, n.stem), {
      values: [...importedNames(shape)],
      types: [n.subject],
    }),
    dedent`
      ${ruleDeclarations(shape).replace(/^export /gm, "")}

      // Three candidates, chosen so that no two rules select the same subset — otherwise a composite could
      // agree with its parts by accident and the composition assertions would prove nothing.
      const draft: ${n.subject} = { id: "A-1", total: 500, status: "draft" };
      const smallPaid: ${n.subject} = { id: "A-2", total: 10, status: "paid" };
      const largePaid: ${n.subject} = { id: "A-3", total: 500, status: "paid" };
      const ${n.lower}s: readonly ${n.subject}[] = [draft, smallPaid, largePaid];
    `,
    dedent`
      describe("a named rule", () => {
        it("selects what it describes and nothing else", () => {
          expect(${n.lower}s.filter(paid.isSatisfiedBy)).toEqual([smallPaid, largePaid]);
          expect(${n.lower}s.filter(substantial.isSatisfiedBy)).toEqual([draft, largePaid]);
        });

        it("answers about a single candidate", () => {
          expect(paid.isSatisfiedBy(largePaid)).toBe(true);
          expect(paid.isSatisfiedBy(draft)).toBe(false);
        });

        it("includes a candidate sitting exactly on the threshold", () => {
          // The one input that distinguishes an inclusive comparison from an exclusive one. Without it a
          // rule spelled \`>\` where \`>=\` was meant selects the same candidates as the correct version on
          // every other input, so the fixture above cannot see the difference and this case exists to.
          const atThreshold: ${n.subject} = { id: "A-4", total: 100, status: "paid" };

          expect(substantial.isSatisfiedBy(atThreshold)).toBe(true);
        });
      });
    `,
    dedent`
      describe("composition", () => {
        it("requires both rules, not either", () => {
          // \`largePaid\` alone satisfies both. Asserting the whole selection rather than its length is what
          // distinguishes an intersection from a union here, since the union has two members.
          const both = ${combine(shape, "paid", "substantial", "and")};

          expect(${n.lower}s.filter(both.isSatisfiedBy)).toEqual([largePaid]);
        });

        it("accepts either rule", () => {
          const either = ${combine(shape, "paid", "cancelled", "or")};

          expect(${n.lower}s.filter(either.isSatisfiedBy)).toEqual([smallPaid, largePaid]);
        });

        it("inverts a rule", () => {
          expect(${n.lower}s.filter(${negate(shape, "paid")}.isSatisfiedBy)).toEqual([draft]);
        });

        it("composes a composite", () => {
          const nested = ${combine(shape, combine(shape, "paid", "substantial", "and"), "cancelled", "or")};

          expect(${n.lower}s.filter(nested.isSatisfiedBy)).toEqual([largePaid]);
        });
      });
    `,
    when(!shape.fluent, variadicTests(shape)),
    when(shape.translation, translationTests(shape)),
  );
}

function variadicTests(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("gathering rules", () => {
      it("requires all of them", () => {
        expect(${n.lower}s.filter(every(paid, substantial).isSatisfiedBy)).toEqual([largePaid]);
      });

      it("requires any of them", () => {
        expect(${n.lower}s.filter(some(cancelled, substantial).isSatisfiedBy)).toEqual([
          draft,
          largePaid,
        ]);
      });

      it("accepts a single rule", () => {
        // The boundary of the non-empty tuple: one is the least it admits, and it must still behave as the
        // rule it was given rather than as a combination of nothing.
        expect(${n.lower}s.filter(every(paid).isSatisfiedBy)).toEqual([smallPaid, largePaid]);
      });
    });
  `;
}

function translationTests(shape: Shape): string {
  const n = shape.names;

  return dedent`
    describe("translation", () => {
      it("bounds a magnitude from either side, inclusively", () => {
        // \`whereAtMost\` is otherwise unreached by this suite, and both boundaries are inclusive, so both
        // are asserted at the value where inclusivity is the only thing being tested.
        const modest = whereAtMost("total", 100);
        const atThreshold: ${n.subject} = { id: "A-4", total: 100, status: "paid" };

        expect(modest.isSatisfiedBy(atThreshold)).toBe(true);
        expect(modest.isSatisfiedBy(largePaid)).toBe(false);
        expect(${n.sql}(modest).text).toBe("total <= ?");
      });

      it("renders a leaf with the value as a parameter", () => {
        const { text, parameters } = ${n.sql}(paid);

        // The value is a placeholder and the field is not, which is the one splice in the renderer and is
        // safe because \`keyof\` closes the set of strings that can reach it.
        expect(text).toBe("status = ?");
        expect(parameters).toEqual(["paid"]);
      });

      it("renders a composite, keeping the parameters in the order they appear", () => {
        const { text, parameters } = ${n.sql}(${combine(shape, "paid", "substantial", "and")});

        expect(text).toBe("(status = ? AND total >= ?)");
        expect(parameters).toEqual(["paid", 100]);
      });

      it("renders an alternative and a negation", () => {
        expect(${n.sql}(${combine(shape, "paid", "cancelled", "or")}).text).toBe(
          "(status = ? OR status = ?)",
        );
        expect(${n.sql}(${negate(shape, "paid")}).text).toBe("NOT status = ?");
      });

      it("keeps the predicate and the query answering the same question", () => {
        // Not provable by a test — one declaration produces both, so there is no second expression to
        // disagree — but the parameters a rule renders should be the values its predicate compares against,
        // and a leaf that translated one field while testing another would show up here.
        const { text, parameters } = ${n.sql}(substantial);

        expect(text).toBe("total >= ?");
        expect(parameters).toEqual([100]);
        expect(substantial.isSatisfiedBy(largePaid)).toBe(true);
        expect(substantial.isSatisfiedBy(smallPaid)).toBe(false);
      });
    });
  `;
}
