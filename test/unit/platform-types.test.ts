/**
 * Whether the sandbox knows about the host it is compiling for.
 *
 * Verification compiles with `lib: ["es2022"]` and no package types, which is what keeps it hermetic.
 * The consequence, discovered while authoring the first pattern that waits, is that `setTimeout` and
 * `AbortSignal` are undeclared — so any bundle that delays or that can be cancelled fails to compile,
 * and since an unverified bundle is never returned, the whole async-resilience category is unreachable.
 *
 * These go through the compiler rather than asserting on the declaration text, because the property
 * that matters is "generated code using this compiles", and only the compiler can answer that.
 */

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_CONVENTIONS, type Conventions } from "../../src/engine/options/conventions.js";
import { platformTypesFor } from "../../src/engine/verify/platform-types.js";
import { Typechecker } from "../../src/engine/verify/typecheck.js";

const checker = new Typechecker();

afterAll(async () => {
  await checker.dispose();
});

function conventions(overrides: Partial<Conventions> = {}): Conventions {
  return { ...DEFAULT_CONVENTIONS, ...overrides };
}

/** Compiles `source` the way `generate` does: the bundle plus the ambient declarations. */
async function diagnose(source: string, used: Conventions): Promise<readonly string[]> {
  const declarations = [...platformTypesFor(used)].map(([path, contents]) => ({ path, contents }));
  const outcome = await checker.check(
    [{ path: "index.ts", contents: source }, ...declarations],
    used,
  );
  return outcome.diagnostics.map((d) => `${d.path ?? "?"}: TS${String(d.code)} ${d.text}`);
}

const WAITS = `export function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, milliseconds);
  });
}
`;

const CANCELS = `export function cancellable(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
  const listener = (): void => {};
  signal.addEventListener("abort", listener, { once: true });
  signal.removeEventListener("abort", listener);
  signal.throwIfAborted();
}

export function controller(): AbortSignal {
  const abort = new AbortController();
  abort.abort(new Error("done"));
  return abort.signal;
}
`;

describe("code that waits", () => {
  it("compiles under the default conventions", async () => {
    expect(await diagnose(WAITS, conventions())).toEqual([]);
  });

  it("compiles for a node runtime", async () => {
    expect(await diagnose(WAITS, conventions({ runtime: "node" }))).toEqual([]);
  });

  it("compiles for a browser runtime, where the DOM lib declares the same names", async () => {
    // The declarations are withheld here precisely so they cannot collide with `lib.dom`. A duplicate
            // identifier would show up as a diagnostic on a file the caller never sees.
    expect(await diagnose(WAITS, conventions({ runtime: "browser" }))).toEqual([]);
  });
});

describe("code that can be cancelled", () => {
  it("compiles under the default conventions", async () => {
    expect(await diagnose(CANCELS, conventions())).toEqual([]);
  });

  it("compiles for a browser runtime", async () => {
    expect(await diagnose(CANCELS, conventions({ runtime: "browser" }))).toEqual([]);
  });
});

describe("a timer handle", () => {
  it("stays opaque, so generated code cannot assume a number or an object", async () => {
    // Node returns an object and browsers return a number. Code that treated the handle as either
    // would compile here and break in half the projects that adopted it, so the sandbox refuses it.
    const diagnostics = await diagnose(
      `const timer: number = setTimeout(() => {}, 1);\nexport default timer;\n`,
      conventions(),
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

describe("the browser runtime", () => {
  it("is given no declarations at all, because the DOM lib already has them", () => {
    expect([...platformTypesFor(conventions({ runtime: "browser" }))]).toEqual([]);
  });
});
