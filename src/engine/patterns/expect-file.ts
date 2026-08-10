/**
 * The `expect.ts` a bundle emits when the caller's runner is `node:test`.
 *
 * `node:test` ships a runner and `node:assert`, but no `expect(x).toBe(y)` surface. Without one, a
 * pattern would need two renderings of every test body — one per assertion style — and the two would
 * drift, so that the suite a Vitest caller receives and the suite a `node:test` caller receives would
 * stop testing the same thing. Emitting a local `expect` instead keeps a single rendering and leaves the
 * caller depending on nothing outside the standard library.
 *
 * Shared across patterns rather than written per pattern. It was written three times before this file
 * existed, in three slightly different forms, and the next seventeen patterns would each have made the
 * same choices again. Each pattern names the matchers its suite uses, because the emitted surface should
 * be the assertions the tests actually make: an unused matcher is unexercised code shipped to a caller,
 * and `toBeCloseTo` sitting unused in an emitted file is a small lie about what was verified.
 */

import { dedent, joinLines, when } from "../render/helpers.js";

/**
 * The matchers a generated suite may ask for.
 *
 * A closed set, so that a pattern reaching for a matcher that does not exist is a compile error in the
 * template rather than a `TypeError` inside a generated test. Deliberately narrow: this mirrors the
 * subset the verification sandbox's own Vitest shim supports, and the two must agree — a matcher
 * available here but not there would produce a bundle that typechecks and cannot be executed.
 */
export type Matcher =
  | "toBe"
  | "toEqual"
  | "toBeUndefined"
  | "toBeDefined"
  | "toBeInstanceOf"
  | "toThrow"
  | "toContain"
  | "toHaveLength"
  | "toBeGreaterThan"
  | "toBeLessThan";

interface Definition {
  readonly signature: string;
  readonly body: string;
}

/**
 * `actual` is `unknown`, so a matcher that needs a shape casts to it.
 *
 * The alternative — a generic `expect<T>` — reads better and asserts less: `toBe` would then only accept
 * a `T`, and a generated test comparing the wrong two things would fail to compile instead of failing at
 * runtime. It is not available, because this file has to accept whatever the Vitest rendering of the
 * same suite passes, and Vitest's own `expect` is variance-free in the same way.
 */
const DEFINITIONS: Readonly<Record<Matcher, Definition>> = {
  toBe: { signature: "toBe(expected: unknown): void", body: "assert.strictEqual(actual, expected);" },
  toEqual: {
    signature: "toEqual(expected: unknown): void",
    body: "assert.deepStrictEqual(actual, expected);",
  },
  toBeUndefined: { signature: "toBeUndefined(): void", body: "assert.strictEqual(actual, undefined);" },
  toBeDefined: { signature: "toBeDefined(): void", body: "assert.notStrictEqual(actual, undefined);" },
  toBeInstanceOf: {
    signature: "toBeInstanceOf(expected: Function): void",
    body: "assert.ok(actual instanceof expected);",
  },
  /**
   * The optional pattern is matched against the thrown error's message, which is what Vitest does with
   * a `RegExp` argument. Without it a suite could only assert that *something* threw, and "it threw the
   * wrong error" is the failure a test of an error path most needs to catch.
   */
  toThrow: {
    signature: "toThrow(expected?: RegExp): void",
    body: "assert.throws(actual as () => unknown, expected);",
  },
  toContain: {
    signature: "toContain(expected: unknown): void",
    body: "assert.ok((actual as readonly unknown[]).includes(expected));",
  },
  toHaveLength: {
    signature: "toHaveLength(expected: number): void",
    body: "assert.strictEqual((actual as { length: number }).length, expected);",
  },
  toBeGreaterThan: {
    signature: "toBeGreaterThan(expected: number): void",
    body: "assert.ok((actual as number) > expected);",
  },
  toBeLessThan: {
    signature: "toBeLessThan(expected: number): void",
    body: "assert.ok((actual as number) < expected);",
  },
};

/** The file name every pattern emits this as, so two patterns in one directory agree on it. */
export const EXPECT_FILE_PATH = "expect.ts";

export interface ExpectFileOptions {
  /**
   * Whether the suite asserts on rejected promises.
   *
   * Off by default because the surface is only worth emitting to a caller who uses it. A pattern whose
   * every method returns a promise needs it: the alternative is a `try`/`catch` around each error-path
   * assertion, and eight lines where one would do is how a suite stops being read.
   */
  readonly rejects?: boolean;
}

/**
 * Matchers are emitted in a fixed order rather than the order a pattern listed them, and duplicates
 * collapse. Otherwise two patterns asking for the same set in a different sequence would emit different
 * bytes for the same file (Principle I).
 */
export function expectFile(
  matchers: readonly Matcher[],
  options: ExpectFileOptions = {},
): string {
  const order = Object.keys(DEFINITIONS) as readonly Matcher[];
  const used = order.filter((matcher) => matchers.includes(matcher));
  const chosen = used.length > 0 ? used : (["toBe"] as const);

  // `toThrow` takes the call itself, so under `rejects` it would mean "the rejection reason is a
  // function that throws". Excluded rather than emitted and never used.
  const asynchronous = chosen.filter((matcher) => matcher !== "toThrow");
  const withRejects = options.rejects === true && asynchronous.length > 0;

  return dedent`
    /**
     * The slice of the \`expect\` surface these tests use, over \`node:assert\`.
     *
     * Here so that one rendering of the suite serves every framework.
     */

    import assert from "node:assert/strict";

    export interface Expectation {
    ${joinLines(chosen.map((matcher) => `  ${DEFINITIONS[matcher].signature};`))}
    ${when(withRejects, "  /** The same assertions, applied to the reason a promise rejected with. */\n  readonly rejects: Rejection;")}
    }
    ${when(
      withRejects,
      `\n${dedent`
        export interface Rejection {
        ${joinLines(asynchronous.map((matcher) => `  ${promised(DEFINITIONS[matcher].signature)};`))}
        }
      `}\n`,
    )}
    export function expect(actual: unknown): Expectation {
      return {
    ${joinLines(
      chosen.map((matcher) =>
        [
          `    ${DEFINITIONS[matcher].signature} {`,
          `      ${DEFINITIONS[matcher].body}`,
          `    },`,
        ].join("\n"),
      ),
    )}
    ${when(
      withRejects,
      joinLines(
        "    rejects: {",
        joinLines(
          asynchronous.map((matcher) =>
            [
              `      async ${promised(DEFINITIONS[matcher].signature)} {`,
              `        expect(await rejectionOf(actual)).${callOf(DEFINITIONS[matcher].signature)};`,
              `      },`,
            ].join("\n"),
          ),
        ),
        "    },",
      ),
    )}
      };
    }
    ${when(
      withRejects,
      `\n${dedent`
        /**
         * The reason \`value\` rejected with.
         *
         * A promise that resolves fails here rather than passing quietly: an assertion about an error
         * path that stops being reached is exactly the one that must not keep passing.
         */
        async function rejectionOf(value: unknown): Promise<unknown> {
          try {
            await value;
          } catch (error) {
            return error;
          }
          return assert.fail("Expected the promise to reject, but it resolved.");
        }
      `}`,
    )}
  `;
}

/** `toBe(expected: unknown): void` becomes `toBe(expected: unknown): Promise<void>`. */
function promised(signature: string): string {
  return signature.replace(/: void$/, ": Promise<void>");
}

/** `toBe(expected: unknown): void` becomes `toBe(expected)`, for forwarding. */
function callOf(signature: string): string {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  const parameters = signature
    .slice(open + 1, close)
    .split(",")
    .map((parameter) => parameter.split(":")[0]?.trim() ?? "")
    .filter((name) => name !== "")
    .map((name) => name.replace(/\?$/, ""));

  return `${signature.slice(0, open)}(${parameters.join(", ")})`;
}
