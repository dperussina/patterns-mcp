/**
 * Executing a generated test suite written for someone else's test runner.
 *
 * Principle III says a returned bundle's tests were run. Principle IX says the bundle follows the
 * caller's conventions, and the default convention is Vitest. Those two together are a problem: the
 * verification sandbox has no `node_modules` and cannot be given one without opening the hermetic
 * boundary, so `import { describe } from "vitest"` cannot resolve.
 *
 * The resolution is to satisfy the import from inside the sandbox. A minimal `vitest` package is
 * written into the temporary directory, implemented on `node:test` and `node:assert`, so CommonJS
 * resolution finds it by walking up from the test file. The caller's test bytes execute unmodified —
 * we are not rewriting their imports or substituting a different suite, only supplying the runner.
 *
 * The shim's one hard requirement is that it never passes something it did not check. An unknown
 * matcher throws, because a shim that silently accepted `expect(x).toBeWithin(y)` would turn "these
 * tests passed" into a claim about nothing, which is worse than being unable to run them at all.
 */

/** The matchers a generated test may use. Anything outside this set fails loudly. */
export const SUPPORTED_MATCHERS: readonly string[] = [
  "toBe",
  "toEqual",
  "toBeUndefined",
  "toBeDefined",
  "toBeNull",
  "toBeTruthy",
  "toBeFalsy",
  "toBeInstanceOf",
  "toThrow",
  "toContain",
  "toHaveLength",
  "toBeGreaterThan",
  "toBeLessThan",
  "toBeCloseTo",
];

/**
 * Bare specifiers a generated suite might import, mapped to the shim. `node:test` is absent on
 * purpose: it is real inside the sandbox and needs no help.
 */
export const SHIMMED_PACKAGES: readonly string[] = ["vitest"];

/**
 * `expect` is a function carrying matchers, and `not` inverts them. Deep equality comes from
 * `assert.deepStrictEqual`, so `toEqual` means structural equality with exact types — the same reading
 * Vitest gives it for plain data, which is all a generated test asserts over.
 */
const SHIM_SOURCE = `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const SUPPORTED = ${JSON.stringify(SUPPORTED_MATCHERS)};

function fail(message) {
  throw new assert.AssertionError({ message });
}

function callThrew(received) {
  if (typeof received !== "function") {
    fail("toThrow expects a function to call");
  }
  try {
    received();
  } catch (error) {
    return error;
  }
  return undefined;
}

function matches(error, expected) {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "string") return message.includes(expected);
  if (typeof expected === "function") return error instanceof expected;
  return false;
}

function matchers(received, negated) {
  const check = (ok, describe) => {
    if (ok === !negated) return;
    fail(negated ? "expected not " + describe : "expected " + describe);
  };
  const show = (value) => {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };

  return {
    toBe: (expected) => check(Object.is(received, expected), show(received) + " to be " + show(expected)),
    toEqual: (expected) => {
      let equal = true;
      try {
        assert.deepStrictEqual(received, expected);
      } catch {
        equal = false;
      }
      check(equal, show(received) + " to equal " + show(expected));
    },
    toBeUndefined: () => check(received === undefined, show(received) + " to be undefined"),
    toBeDefined: () => check(received !== undefined, "a defined value"),
    toBeNull: () => check(received === null, show(received) + " to be null"),
    toBeTruthy: () => check(Boolean(received), show(received) + " to be truthy"),
    toBeFalsy: () => check(!received, show(received) + " to be falsy"),
    toBeInstanceOf: (expected) =>
      check(received instanceof expected, show(received) + " to be an instance of " + expected.name),
    toThrow: (expected) => {
      const error = callThrew(received);
      check(error !== undefined && matches(error, expected), "the call to throw");
    },
    toContain: (expected) => {
      const ok =
        typeof received === "string"
          ? received.includes(expected)
          : Array.isArray(received) && received.some((item) => Object.is(item, expected));
      check(ok, show(received) + " to contain " + show(expected));
    },
    toHaveLength: (expected) =>
      check(received != null && received.length === expected, "length " + show(expected)),
    toBeGreaterThan: (expected) => check(received > expected, show(received) + " > " + show(expected)),
    toBeLessThan: (expected) => check(received < expected, show(received) + " < " + show(expected)),
    toBeCloseTo: (expected, digits) =>
      check(
        Math.abs(received - expected) < Math.pow(10, -(digits ?? 2)) / 2,
        show(received) + " to be close to " + show(expected),
      ),
  };
}

/**
 * Unknown matchers throw. A shim that quietly accepted one would report a suite as passing without
 * having checked what it claims to check.
 */
function guard(target) {
  return new Proxy(target, {
    get(object, name) {
      if (typeof name === "string" && !(name in object) && name !== "then") {
        throw new Error(
          "expect(...)." + name + " is not available in the verification shim. Supported: " +
            SUPPORTED.join(", ") + ". Use one of those in a generated test.",
        );
      }
      return object[name];
    },
  });
}

function expect(received) {
  const base = matchers(received, false);
  return guard(Object.assign(base, { not: guard(matchers(received, true)) }));
}

expect.fail = (message) => fail(message ?? "expect.fail()");

module.exports = {
  expect,
  describe: test.describe,
  it: test.it,
  test: test.it,
  suite: test.describe,
  beforeAll: test.before,
  afterAll: test.after,
  beforeEach: test.beforeEach,
  afterEach: test.afterEach,
};
`;

/**
 * The files to write into the sandbox so a bare `vitest` import resolves, keyed by path relative to
 * the sandbox root. Returned as data so the executor stays the only thing that touches a filesystem.
 */
export function shimFilesFor(packages: readonly string[]): ReadonlyMap<string, string> {
  const files = new Map<string, string>();

  for (const name of packages.toSorted()) {
    if (!SHIMMED_PACKAGES.includes(name)) continue;
    files.set(`node_modules/${name}/package.json`, `${JSON.stringify({ name, main: "index.js" })}\n`);
    files.set(`node_modules/${name}/index.js`, SHIM_SOURCE);
  }

  return files;
}

/**
 * Ambient declarations so a suite written against the caller's runner also *typechecks* hermetically.
 * The same reasoning as the runtime shim, one stage earlier: the verification file system has no
 * `node_modules`, so `import { it } from "vitest"` is an unresolved module without this.
 *
 * These files go into the verification file system and are discarded from the emitted bundle — the
 * same device data-model.md describes for verifying a binding against a core the caller already has.
 *
 * The declarations are precise on purpose. Typing `expect` as `any` would make the import resolve and
 * simultaneously stop every assertion in the suite from being typechecked, which is how a generated
 * test comes to compare a number against an array and nobody notices.
 */
export function shimTypesFor(packages: readonly string[]): ReadonlyMap<string, string> {
  const files = new Map<string, string>();

  for (const name of packages.toSorted()) {
    if (SHIMMED_PACKAGES.includes(name)) {
      files.set(`${name}-shim.d.ts`, declarationFor(name));
      continue;
    }

    const builtin = NODE_BUILTIN_TYPES[name];
    if (builtin !== undefined) {
      files.set(`${name.replace(/[:/]/g, "-")}.d.ts`, builtin);
    }
  }

  return files;
}

/**
 * Ambient declarations for the Node builtins our patterns emit.
 *
 * `@types/node` is deliberately not read from disk. Doing so would make verification depend on which
 * version happened to be installed beside the server, so a bundle could typecheck on one machine and
 * not another — the same ambient dependency the whole verification file system exists to exclude.
 *
 * These are hand-written and narrow: only the members a generated file uses, typed accurately enough
 * that a wrong call still fails. Expect this set to grow one entry at a time as patterns reach for
 * more builtins, which is the intended cost of staying hermetic.
 */
const NODE_BUILTIN_TYPES: Readonly<Record<string, string>> = {
  "node:test": `declare module "node:test" {
  export function describe(name: string, body: () => void): void;
  export function it(name: string, body: () => void | Promise<void>): void;
  export function test(name: string, body: () => void | Promise<void>): void;
  export function before(body: () => void | Promise<void>): void;
  export function after(body: () => void | Promise<void>): void;
  export function beforeEach(body: () => void | Promise<void>): void;
  export function afterEach(body: () => void | Promise<void>): void;
}
`,
  "node:assert/strict": `declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    strictEqual<T>(actual: unknown, expected: T, message?: string): void;
    deepStrictEqual<T>(actual: unknown, expected: T, message?: string): void;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      block: () => unknown,
      expected?: RegExp | (abstract new (...args: never[]) => Error),
      message?: string,
    ): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
`,
};

function declarationFor(name: string): string {
  return `declare module "${name}" {
  export function describe(name: string, body: () => void): void;
  export function it(name: string, body: () => void | Promise<void>): void;
  export function test(name: string, body: () => void | Promise<void>): void;
  export function beforeAll(body: () => void | Promise<void>): void;
  export function afterAll(body: () => void | Promise<void>): void;
  export function beforeEach(body: () => void | Promise<void>): void;
  export function afterEach(body: () => void | Promise<void>): void;

  export interface Expectation<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
    toThrow(expected?: RegExp | string): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeCloseTo(expected: number, digits?: number): void;
    readonly not: Expectation<T>;
  }

  export function expect<T>(received: T): Expectation<T>;
}
`;
}

/** Bare specifiers a bundle imports, for deciding which shims are needed before transpilation. */
export function bareImports(contents: string): readonly string[] {
  const found = new Set<string>();
  for (const match of contents.matchAll(/from\s*["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (specifier !== "" && !specifier.startsWith(".")) {
      found.add(specifier);
    }
  }
  return [...found].toSorted();
}

/** Bare specifiers a transpiled bundle requires. Relative requires are the bundle's own files. */
export function bareRequires(contents: string): readonly string[] {
  const found = new Set<string>();
  for (const match of contents.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const specifier = match[1] ?? "";
    if (specifier !== "" && !specifier.startsWith(".")) found.add(specifier);
  }
  return [...found].toSorted();
}
