/**
 * The type-level assertion kit a bundle inlines into its `*.test-d.ts`.
 *
 * Patterns whose guarantee is a *type* cannot be checked by a suite that runs, because by the time
 * anything runs the question has been settled — a branded identifier that has stopped rejecting a raw
 * string behaves identically at run time to one that still rejects it. What checks such a claim is the
 * compiler, and the file carrying the claim has to be one the compiler reads.
 *
 * Two vehicles, for two different jobs.
 *
 * `@ts-expect-error` states that a line must *not* compile, and it belongs on code a caller would
 * plausibly write. It is an assertion rather than an apology: if the guarantee lapses, the directive
 * becomes unused and the file stops compiling on that.
 *
 * The aliases below state what a type *is*, which no directive can. They are inlined rather than emitted
 * as a separate file: unlike the run-time `expect` shim, only one file in a bundle needs them.
 *
 * Shared here rather than written per pattern, for the reason `expect-file.ts` gives — the patterns in
 * the type-safety group need the same three aliases, and `Equal` is subtle enough that four hand-written
 * copies would not all have been correct.
 *
 * One rule governs every assertion built on these, and it is not obvious. Never assert about
 * nullability. A bundle is verified at every strictness a caller may ask for, and with `strictNullChecks`
 * off `undefined` is assignable to everything — so `Equal<string | undefined, string>` is `false` under
 * `strict` and `true` under `loose`. An assertion whose meaning depends on the reader's compiler options
 * is not an assertion. Assert about missing members and incompatible nominal identities, which mean the
 * same thing everywhere.
 */

import { documented, sections, when } from "../render/helpers.js";

/**
 * The aliases a `*.test-d.ts` may ask for.
 *
 * A closed set for the same reason the matcher list is closed: a pattern reaching for an alias that does
 * not exist should be a compile error in the template, not a puzzling diagnostic inside a generated file.
 * `Expect` is not listed because it is the driver every assertion passes through, so it is always
 * emitted.
 */
export type TypeAssertion = "Equal" | "Extends" | "NotAssignable";

/** The conventional suffix for a file the compiler reads and no runner executes. */
export const TYPE_TEST_SUFFIX = ".test-d.ts";

/**
 * The kit's source: `Expect`, plus whichever aliases were named.
 *
 * Ordered by this function rather than by the caller's list, so two patterns naming the same aliases in a
 * different sequence still emit byte-identical text.
 */
export function typeAssertKit(assertions: readonly TypeAssertion[]): string {
  const wanted = new Set(assertions);

  return sections(
    documented(
      [
        "Forces its argument to be `true`, and fails to compile when it is not.",
        "Each assertion below is written as a named alias rather than a bare one, so that it reads as a stated claim about the code and cannot be mistaken for a leftover.",
      ],
      "export type Expect<T extends true> = T;",
    ),
    when(
      wanted.has("Equal"),
      documented(
        [
          "Whether two types are identical, rather than merely assignable in both directions.",
          "The two-function form looks like a trick because it is one: it compares the types in a position the compiler checks by identity instead of by assignability. The obvious alternative — asking whether each extends the other — answers a different question, and answers it wrongly in two common cases. It reports `true` for `any` against anything at all, and it distributes over unions, so a union compared against one of its own members can come back true.",
        ],
        "export type Equal<X, Y> =\n  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;",
      ),
    ),
    when(
      wanted.has("Extends"),
      documented(
        [
          "Whether `X` is assignable to `Y`.",
          "Both sides are wrapped in a tuple to stop the union distribution a bare conditional performs. Undistributed is the question that was meant: whether the whole of `X` is acceptable as a `Y`, rather than whether each member of it is on its own.",
        ],
        "export type Extends<X, Y> = [X] extends [Y] ? true : false;",
      ),
    ),
    when(
      wanted.has("NotAssignable"),
      documented(
        [
          "Whether `X` is rejected where a `Y` is wanted.",
          "The type-level counterpart to `@ts-expect-error`, and preferable wherever the claim is about a relationship rather than about a particular line: a directive suppresses whichever error occurs, so it can be satisfied by an unrelated mistake on the same line, where this cannot.",
        ],
        "export type NotAssignable<X, Y> = [X] extends [Y] ? false : true;",
      ),
    ),
  );
}
