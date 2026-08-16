/**
 * The `result` pattern: an operation's failure expressed in its return type.
 *
 * Principle IV governs what this emits. A caller adopting it should not have to write the combinator
 * they need on their second day, so the surface is the one a production module actually uses —
 * construction, inspection, transformation of both arms, extraction with and without a fallback, and
 * the async and collection combinators that are the whole reason a value-typed error is pleasant to
 * work with. That is a larger file than an illustration would be, which is the point.
 *
 * Two decisions worth stating. The type is a discriminated union on a literal `ok`, not a class: it
 * survives structural typing across module boundaries, serialises, and narrows in a `switch` without
 * `instanceof`. And every function is standalone rather than a method, so a caller can import the three
 * they use and let a bundler drop the rest.
 */

import { siblingSpecifier } from "../../generate/imports.js";
import { withNoun } from "../../options/names.js";
import { expectFileEntry, frameworkImports } from "../expect-file.js";
import { dedent, joinLines, when } from "../../render/helpers.js";
import type { PatternModule, RenderContext, RenderedFile } from "../types.js";

export const resultPattern: PatternModule = {
  name: "result",

  render(context: RenderContext): readonly RenderedFile[] {
    const { conventions, options } = context;
    const async = options.includeAsync === true;
    const collections = options.includeCollections === true;
    const stem = stemFor(context);

    const files: RenderedFile[] = [
      { path: `${stem}.ts`, role: "core", contents: core(context, { async, collections }) },
      { path: `${stem}-example.ts`, role: "example", contents: example(context, stem) },
    ];

    if (options.includeTests === true && conventions.testFramework !== "none") {
      files.push({
        path: `${stem}.test.ts`,
        role: "test",
        contents: tests(context, stem, { async, collections }),
      });

      // node:test ships a runner but no assertion surface of the shape these suites are written in.
      // Emitting a small local helper keeps one rendering of the test body and leaves the caller with
      // a suite that depends on nothing outside the standard library.
      if (conventions.testFramework === "node-test") {
        files.push(expectFileEntry());
      }
    }

    return files;
  },
};

interface Surface {
  readonly async: boolean;
  readonly collections: boolean;
}

/**
 * File names come from the identifier when one is supplied, so a caller generating a result type for
 * their own domain gets `order-result.ts` rather than a second `result.ts` to disambiguate by hand.
 */
function stemFor(context: RenderContext): string {
  const entity = context.names.entity;
  return entity === undefined ? "result" : withNoun(entity, "Result").kebab;
}

/** The exported type name, matching the file. */
function typeNameFor(context: RenderContext): string {
  const entity = context.names.entity;
  return entity === undefined ? "Result" : withNoun(entity, "Result").pascal;
}

function core(context: RenderContext, surface: Surface): string {
  const name = typeNameFor(context);
  const ok = `Ok`;
  const err = `Err`;

  return joinLines(
    dedent`
      /**
       * ${name}: the outcome of an operation that can fail, as a value.
       *
       * Narrow with \`isOk\` or \`isErr\` to reach either arm:
       *
       * \`\`\`ts
       * const outcome = parse(input);
       * if (isOk(outcome)) {
       *   use(outcome.value);
       * } else {
       *   report(outcome.error);
       * }
       * \`\`\`
       *
       * Testing \`outcome.ok\` directly reads the same way and works in a project
       * with \`strictNullChecks\` on. The predicates additionally narrow without it,
       * so they are what the combinators below use and what this module recommends.
       */
      export type ${name}<T, E = Error> = ${ok}<T> | ${err}<E>;

      export interface ${ok}<T> {
        readonly ok: true;
        readonly value: T;
      }

      export interface ${err}<E> {
        readonly ok: false;
        readonly error: E;
      }

      /**
       * Wraps a successful value.
       *
       * The return type is the whole union with \`never\` on the failure side, not
       * \`${ok}<T>\` alone. That is what lets \`andThen(result, (n) => ok(n + 1))\`
       * infer: a bare \`${ok}<T>\` carries no information about the error arm, so the
       * error type would infer as \`unknown\` and every call site would need a type
       * argument written by hand.
       */
      export function ok<T>(value: T): ${name}<T, never> {
        return { ok: true, value };
      }

      /** Wraps a failure. Mirrors \`ok\`, with \`never\` on the success side for the same reason. */
      export function err<E>(error: E): ${name}<never, E> {
        return { ok: false, error };
      }

      /**
       * Narrowing helpers, used by every combinator below as well as by callers.
       *
       * They are not a convenience here, they are load-bearing. Reading \`result.ok\`
       * narrows the union only when \`strictNullChecks\` is on; under a \`strict:
       * false\` project the discriminant stops narrowing and \`result.error\` becomes
       * an error on the success arm. A type predicate narrows the same way under
       * every configuration, so the module compiles for every caller.
       */
      export function isOk<T, E>(result: ${name}<T, E>): result is ${ok}<T> {
        return result.ok;
      }

      export function isErr<T, E>(result: ${name}<T, E>): result is ${err}<E> {
        return !result.ok;
      }

      /** Transforms the success arm, leaving a failure untouched. */
      export function map<T, U, E>(
        result: ${name}<T, E>,
        transform: (value: T) => U,
      ): ${name}<U, E> {
        return isOk(result) ? ok(transform(result.value)) : err(result.error);
      }

      /** Transforms the failure arm, leaving a success untouched. */
      export function mapErr<T, E, F>(
        result: ${name}<T, E>,
        transform: (error: E) => F,
      ): ${name}<T, F> {
        return isErr(result) ? err(transform(result.error)) : ok(result.value);
      }

      /** Chains an operation that can itself fail, without nesting the results. */
      export function andThen<T, U, E>(
        result: ${name}<T, E>,
        next: (value: T) => ${name}<U, E>,
      ): ${name}<U, E> {
        return isOk(result) ? next(result.value) : err(result.error);
      }

      /** Supplies a replacement for a failure, for recovery paths. */
      export function orElse<T, E, F>(
        result: ${name}<T, E>,
        recover: (error: E) => ${name}<T, F>,
      ): ${name}<T, F> {
        return isErr(result) ? recover(result.error) : ok(result.value);
      }

      /** Extracts the value, or returns \`fallback\` for a failure. */
      export function unwrapOr<T, E>(result: ${name}<T, E>, fallback: T): T {
        return isOk(result) ? result.value : fallback;
      }

      /** Extracts the value, computing a fallback from the error only when needed. */
      export function unwrapOrElse<T, E>(
        result: ${name}<T, E>,
        fallback: (error: E) => T,
      ): T {
        return isOk(result) ? result.value : fallback(result.error);
      }

      /**
       * Extracts the value or throws.
       *
       * Provided for the boundary where a value-typed error has to become an
       * exception again — a test assertion, or a framework that reports thrown
       * errors. Prefer the combinators inside your own code; this exists so the
       * escape hatch is explicit rather than improvised.
       */
      export function unwrap<T, E>(result: ${name}<T, E>): T {
        if (isOk(result)) {
          return result.value;
        }
        throw result.error instanceof Error
          ? result.error
          : new Error(String(result.error));
      }

      /** Collapses both arms to one type, so a caller can render either outcome in one expression. */
      export function match<T, E, U>(
        result: ${name}<T, E>,
        cases: { readonly ok: (value: T) => U; readonly err: (error: E) => U },
      ): U {
        return isOk(result) ? cases.ok(result.value) : cases.err(result.error);
      }

      /** Runs a throwing function and captures its exception as a failure. */
      export function attempt<T>(operation: () => T): ${name}<T, Error> {
        try {
          return ok(operation());
        } catch (cause) {
          return err(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    `,
    when(
      surface.async,
      dedent`

        /** Awaits a promise, capturing a rejection as a failure. */
        export async function fromPromise<T>(
          promise: Promise<T>,
        ): Promise<${name}<T, Error>> {
          try {
            return ok(await promise);
          } catch (cause) {
            return err(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }

        /** \`map\` for an asynchronous transform. */
        export async function mapAsync<T, U, E>(
          result: ${name}<T, E>,
          transform: (value: T) => Promise<U>,
        ): Promise<${name}<U, E>> {
          return isOk(result) ? ok(await transform(result.value)) : err(result.error);
        }

        /** \`andThen\` for an asynchronous step. */
        export async function andThenAsync<T, U, E>(
          result: ${name}<T, E>,
          next: (value: T) => Promise<${name}<U, E>>,
        ): Promise<${name}<U, E>> {
          return isOk(result) ? await next(result.value) : err(result.error);
        }
      `,
    ),
    when(
      surface.collections,
      dedent`

        /**
         * Collects many results into one. Returns the first failure in order, so the
         * outcome does not depend on which operation happened to finish first.
         */
        export function all<T, E>(
          results: Iterable<${name}<T, E>>,
        ): ${name}<T[], E> {
          const values: T[] = [];
          for (const result of results) {
            if (isErr(result)) {
              return err(result.error);
            }
            values.push(result.value);
          }
          return ok(values);
        }

        /** Splits results into successes and failures, preserving order within each. */
        export function partition<T, E>(
          results: Iterable<${name}<T, E>>,
        ): { readonly values: T[]; readonly errors: E[] } {
          const values: T[] = [];
          const errors: E[] = [];
          for (const result of results) {
            if (isOk(result)) {
              values.push(result.value);
            } else {
              errors.push(result.error);
            }
          }
          return { values, errors };
        }
      `,
    ),
  );
}

function example(context: RenderContext, stem: string): string {
  const name = typeNameFor(context);
  const specifier = importSpecifier(context, stem);

  return dedent`
    /**
     * How to adopt ${name}.
     *
     * A parser is the shortest honest example: it has a real failure case, and the
     * failure carries information the caller needs rather than being a bare null.
     */

    import { andThen, err, map, match, ok, unwrapOr } from "${specifier}";
    import type { ${name} } from "${specifier}";

    interface Config {
      readonly port: number;
    }

    function parsePort(raw: string): ${name}<number, string> {
      const port = Number(raw);
      if (!Number.isInteger(port)) {
        return err(\`port must be an integer, received \${JSON.stringify(raw)}\`);
      }
      if (port < 1 || port > 65535) {
        return err(\`port must be between 1 and 65535, received \${String(port)}\`);
      }
      return ok(port);
    }

    export function readConfig(raw: string): ${name}<Config, string> {
      return map(parsePort(raw), (port) => ({ port }));
    }

    /** Chaining: each step runs only if the one before it succeeded. */
    export function describeConfig(raw: string): string {
      const described = andThen(readConfig(raw), (config) =>
        ok(\`listening on \${String(config.port)}\`),
      );

      return match(described, {
        ok: (message) => message,
        err: (problem) => \`configuration rejected: \${problem}\`,
      });
    }

    /** Falling back without branching, where a default is genuinely acceptable. */
    export function portOrDefault(raw: string): number {
      return unwrapOr(parsePort(raw), 8080);
    }
  `;
}

function tests(context: RenderContext, stem: string, surface: Surface): string {
  const name = typeNameFor(context);
  const specifier = importSpecifier(context, stem);

  const imported = [
    "all",
    "andThen",
    "attempt",
    "err",
    "isErr",
    "isOk",
    "map",
    "mapErr",
    "match",
    "ok",
    "orElse",
    "partition",
    "unwrap",
    "unwrapOr",
    "unwrapOrElse",
  ].filter((symbol) => surface.collections || (symbol !== "all" && symbol !== "partition"));

  return joinLines(
    dedent`
      ${frameworkImports(context.conventions)}
      import { ${imported.join(", ")} } from "${specifier}";
      import type { ${name} } from "${specifier}";

      describe("${name} construction", () => {
        it("distinguishes the two arms", () => {
          expect(isOk(ok(1))).toBe(true);
          expect(isErr(ok(1))).toBe(false);
          expect(isOk(err("bad"))).toBe(false);
          expect(isErr(err("bad"))).toBe(true);
        });

        it("carries the value and the error", () => {
          const success: ${name}<number, string> = ok(2);
          const failure: ${name}<number, string> = err("bad");
          expect(unwrapOr(success, 0)).toBe(2);
          expect(unwrapOr(failure, 0)).toBe(0);
        });
      });

      describe("${name} transformation", () => {
        it("maps only the success arm", () => {
          expect(unwrapOr(map(ok(2), (n) => n * 2), 0)).toBe(4);
          const failure: ${name}<number, string> = err("bad");
          expect(unwrapOr(map(failure, (n) => n * 2), 0)).toBe(0);
        });

        it("maps only the failure arm", () => {
          const mapped = mapErr(err("bad"), (problem) => problem.toUpperCase());
          expect(unwrapOrElse(mapped, (problem) => problem)).toBe("BAD");
          expect(unwrapOrElse(mapErr(ok("kept"), () => "unused"), () => "")).toBe("kept");
        });

        it("chains without nesting", () => {
          const start: ${name}<number, string> = ok(2);
          const chained = andThen(start, (n) => ok(n + 1));
          expect(unwrapOr(chained, 0)).toBe(3);

          const failed: ${name}<number, string> = err("bad");
          const shortCircuited = andThen(failed, (n) => ok(n + 1));
          expect(unwrapOr(shortCircuited, 0)).toBe(0);
        });

        it("recovers through orElse", () => {
          expect(unwrapOr(orElse(err("bad"), () => ok(9)), 0)).toBe(9);
          expect(unwrapOr(orElse(ok(1), () => ok(9)), 0)).toBe(1);
        });

        it("collapses both arms with match", () => {
          const render = (result: ${name}<number, string>): string =>
            match(result, { ok: (n) => \`ok:\${String(n)}\`, err: (e) => \`err:\${e}\` });
          expect(render(ok(1))).toBe("ok:1");
          expect(render(err("bad"))).toBe("err:bad");
        });
      });

      describe("${name} extraction", () => {
        it("throws only where a caller asked it to", () => {
          expect(unwrap(ok(1))).toBe(1);
          expect(() => unwrap(err(new Error("boom")))).toThrow(/boom/);
        });

        it("wraps a non-error failure rather than throwing a bare value", () => {
          expect(() => unwrap(err("plain"))).toThrow(/plain/);
        });

        it("captures a thrown exception as a failure", () => {
          const captured = attempt<number>(() => {
            throw new Error("inner");
          });
          expect(isErr(captured)).toBe(true);
          expect(unwrapOr(captured, 0)).toBe(0);
          expect(unwrapOr(attempt(() => 5), 0)).toBe(5);
        });
      });
    `,
    when(
      surface.collections,
      dedent`

        describe("${name} collections", () => {
          it("returns the first failure in order, not the first encountered by chance", () => {
            const results: ${name}<number, string>[] = [ok(1), err("first"), err("second")];
            const collected = all(results);
            expect(isErr(collected)).toBe(true);
            expect(match(collected, { ok: () => "none", err: (problem) => problem })).toBe("first");
          });

          it("collects every value when all succeed", () => {
            const collected = all<number, string>([ok(1), ok(2)]);
            expect(match(collected, { ok: (values) => values, err: () => [] })).toEqual([1, 2]);
          });

          it("splits successes from failures, preserving order", () => {
            const split = partition<number, string>([ok(1), err("a"), ok(2), err("b")]);
            expect(split.values).toEqual([1, 2]);
            expect(split.errors).toEqual(["a", "b"]);
          });
        });
      `,
    ),
  );
}

/**
 * The specifier a sibling file uses to import the core module, in the caller's extension convention
 * (FR-025). This is why the same bundle is verified three times in tests — each convention produces
 * different bytes and each has to compile.
 *
 * A sibling every time, even for a split pattern requested as `binding-only`. What a binding imports
 * when the machinery is not beside it is decided once, in `generate/imports.ts`, by repointing this
 * specifier — so a template cannot get it wrong by forgetting that the case exists.
 */
function importSpecifier(context: RenderContext, stem: string): string {
  return siblingSpecifier(context.conventions, stem);
}
