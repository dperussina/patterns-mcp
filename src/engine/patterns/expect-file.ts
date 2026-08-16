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
 * same choices again.
 *
 * **The surface is fixed, not tailored per pattern, and that is the whole point.** Each pattern used to
 * name the matchers its suite used, on the reasoning that an unused matcher is unexercised code shipped
 * to a caller. The reasoning was sound and the consequence was a broken product: every pattern emits
 * this at the same path, so a caller who asks for two patterns gets two different files written to
 * `expect.ts`, and the second silently overwrites the first. Whichever suite lost then fails to compile
 * against a shim missing half its matchers. Nothing caught it, because a bundle is verified alone and
 * each of them is correct alone — it took generating a repository, a retry and a branded type into one
 * directory and running `tsc` to see 18 errors.
 *
 * So the shim is one canonical file: the full matcher set, the rejection mirror always, and a header
 * naming no pattern. Two bundles now write identical bytes, which makes the collision a no-op. The cost
 * is a handful of matchers a given suite does not call, which is worth paying — an unused method on a
 * test helper is a far smaller lie than a suite that cannot compile.
 */

import { importsFrom, siblingSpecifier } from "../generate/imports.js";
import { dedent, joinLines } from "../render/helpers.js";

import type { Conventions } from "../options/conventions.js";
import type { RenderedFile } from "./types.js";

/** The stem every pattern emits this under, so a file and the import that reaches it agree. */
const EXPECT_STEM = "expect";

/**
 * The import lines a generated suite needs to reach its runner and its assertions.
 *
 * Here rather than in each pattern because getting it wrong is invisible: the verification sandbox
 * shims `vitest` so that a bundle can be executed at all (see `verify/test-shims.ts`), which means a
 * suite that imports from `"vitest"` in a `node:test` project passes verification and then fails in
 * the caller's repository, where nothing shims anything. Two patterns shipped that way before this
 * existed.
 *
 * `expect` comes from the emitted shim under `node:test` and from the framework otherwise, so a
 * pattern asks for its runner and gets whichever pair is right.
 */
export function frameworkImports(conventions: Conventions): string {
  if (conventions.testFramework === "node-test") {
    return joinLines(
      importsFrom(conventions, "node:test", { values: ["describe", "it"] }),
      importsFrom(conventions, siblingSpecifier(conventions, EXPECT_STEM), { values: ["expect"] }),
    );
  }

  return conventions.testFramework === "vitest"
    ? importsFrom(conventions, "vitest", { values: ["describe", "expect", "it"] })
    : "";
}

/**
 * The matchers this shim offers, and so the matchers a generated suite may use.
 *
 * A closed set, so that a suite reaching for a matcher that does not exist is a compile error in the
 * caller's project rather than a `TypeError` inside a generated test. Deliberately narrow: this mirrors
 * the subset the verification sandbox's own Vitest shim supports, and the two must agree — a matcher
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
   *
   * The absent pattern is a separate call rather than one forwarding `expected` straight through:
   * `assert.throws`'s matcher parameter is required in the overload that takes one, so passing a
   * `RegExp | undefined` matches neither overload and does not compile in the caller's project.
   */
  toThrow: {
    signature: "toThrow(expected?: RegExp): void",
    body: joinLines(
      "const call = actual as () => unknown;",
      "if (expected === undefined) {",
      "  assert.throws(call);",
      "  return;",
      "}",
      "assert.throws(call, expected);",
    ),
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
export const EXPECT_FILE_PATH = `${EXPECT_STEM}.ts`;

/**
 * The shim as a bundle entry, marked shared so it is attributed to no single pattern.
 *
 * Patterns call this rather than assembling the entry themselves. Twenty-six of them used to repeat the
 * path, the role and their own matcher list, which is twenty-six chances to spell the path differently
 * or to forget the marker — and either mistake reappears as a collision in a caller's directory rather
 * than as a failure here.
 */
export function expectFileEntry(): RenderedFile {
  return { path: EXPECT_FILE_PATH, role: "test", contents: expectFile(), provenance: "shared" };
}

/**
 * The shim's contents: every matcher, in a fixed order, with the rejection mirror.
 *
 * Takes no arguments by design. Anything that varied the bytes per caller would put us back where this
 * started, since every bundle writes them to the same path.
 */
export function expectFile(): string {
  const chosen = Object.keys(DEFINITIONS) as readonly Matcher[];

  // `toThrow` takes the call itself, so under `rejects` it would mean "the rejection reason is a
  // function that throws". Excluded rather than emitted and never used.
  const asynchronous = chosen.filter((matcher) => matcher !== "toThrow");

  return dedent`
    /**
     * The \`expect\` surface a generated suite uses, over \`node:assert\`.
     *
     * Here so that one rendering of the suite serves every framework. Identical in every bundle, so a
     * second pattern writing it over this one changes nothing.
     */

    import assert from "node:assert/strict";

    export interface Expectation {
    ${joinLines(chosen.map((matcher) => `  ${DEFINITIONS[matcher].signature};`))}
      /** The same assertions, applied to the reason a promise rejected with. */
      readonly rejects: Rejection;
    }

    export interface Rejection {
    ${joinLines(asynchronous.map((matcher) => `  ${promised(DEFINITIONS[matcher].signature)};`))}
    }

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
        rejects: {
    ${joinLines(
      asynchronous.map((matcher) =>
        [
          `      async ${promised(DEFINITIONS[matcher].signature)} {`,
          `        expect(await rejectionOf(actual)).${callOf(DEFINITIONS[matcher].signature)};`,
          `      },`,
        ].join("\n"),
      ),
    )}
        },
      };
    }

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
