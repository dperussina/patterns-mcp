/**
 * The fallback only earns its place if it agrees with the primary path. A fallback that accepts what
 * the fast path rejects, or rejects what it accepts, does not preserve the verification gate — it
 * replaces it with a different one, and the day it is switched on becomes the day the guarantee
 * quietly changes meaning.
 *
 * So most of this file runs both engines over the same inputs and compares.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONVENTIONS } from "../../src/engine/options/conventions.js";
import type { Conventions } from "../../src/engine/options/conventions.js";
import { createVerifier } from "../../src/engine/verify/index.js";
import { FallbackTypechecker } from "../../src/engine/verify/typecheck-fallback.js";
import { Typechecker } from "../../src/engine/verify/typecheck.js";
import type { BundleFile } from "../../src/engine/verify/typecheck.js";

/**
 * The fallback builds a fresh program per check — that is the whole point of it, since it trades the
 * warm instance's speed for not depending on an unstable API. A single check therefore costs a second
 * or two, and the 5s default starts timing out once this file shares a machine with the golden sweep.
 * A timeout that reflects what the code actually costs is worth more than a gate that fails on load.
 */
vi.setConfig({ testTimeout: 60_000 });

const fast = new Typechecker();
const stable = new FallbackTypechecker();

afterAll(async () => {
  await Promise.all([fast.dispose(), stable.dispose()]);
});

const conventions = (overrides: Partial<Conventions> = {}): Conventions => ({
  ...DEFAULT_CONVENTIONS,
  ...overrides,
});

function bundle(extension: string): BundleFile[] {
  const specifier = (name: string) => `./${name}${extension}`;
  return [
    { path: "types.ts", contents: "export interface Shape {\n  id: string;\n  size: number;\n}\n" },
    {
      path: "shape.ts",
      contents:
        `import type { Shape } from "${specifier("types")}";\n` +
        "export function grow(shape: Shape, by: number): Shape {\n" +
        "  return { ...shape, size: shape.size + by };\n}\n",
    },
    {
      path: "index.ts",
      contents:
        `export type { Shape } from "${specifier("types")}";\n` +
        `export { grow } from "${specifier("shape")}";\n`,
    },
  ];
}

/** Both engines' verdicts on the same input, for direct comparison. */
async function bothVerdicts(files: readonly BundleFile[], settings: Conventions) {
  const [a, b] = await Promise.all([fast.check(files, settings), stable.check(files, settings)]);
  return {
    fast: a.diagnostics.map((d) => ({ code: d.code, path: d.path })),
    stable: b.diagnostics.map((d) => ({ code: d.code, path: d.path })),
  };
}

describe("selecting an engine", () => {
  it("defaults to the fast path and returns the stable one on request", async () => {
    const byDefault = createVerifier();
    const explicit = createVerifier({ engine: "fast" });
    const fallback = createVerifier({ engine: "stable" });
    try {
      expect(byDefault).toBeInstanceOf(Typechecker);
      expect(explicit).toBeInstanceOf(Typechecker);
      expect(fallback).toBeInstanceOf(FallbackTypechecker);
    } finally {
      await Promise.all([byDefault.dispose(), explicit.dispose(), fallback.dispose()]);
    }
  });

  it("reports a stable compiler version distinct from the primary one", async () => {
    const outcome = await stable.check([{ path: "index.ts", contents: "export const x = 1;\n" }], conventions());
    expect(outcome.compilerVersion).toMatch(/^6\./);

    const primary = await fast.check([{ path: "index.ts", contents: "export const x = 1;\n" }], conventions());
    expect(primary.compilerVersion).toMatch(/^7\./);
  });

  it("satisfies the interface without holding anything to release", async () => {
    const throwaway = new FallbackTypechecker();
    await expect(throwaway.warm()).resolves.toBeUndefined();
    await expect(throwaway.dispose()).resolves.toBeUndefined();
    await expect(throwaway.dispose()).resolves.toBeUndefined();
  });
});

describe("agreement between the two paths", () => {
  const extensionFor: Record<Conventions["importExtensions"], string> = { js: ".js", ts: ".ts", none: "" };

  for (const importExtensions of ["js", "ts", "none"] as const) {
    for (const moduleStyle of ["esm", "cjs"] as const) {
      it(`both accept a clean bundle with ${moduleStyle} and ${importExtensions} extensions`, async () => {
        const verdicts = await bothVerdicts(
          bundle(extensionFor[importExtensions]),
          conventions({ importExtensions, moduleStyle }),
        );
        expect(verdicts.stable).toEqual([]);
        expect(verdicts.fast).toEqual(verdicts.stable);
      });
    }
  }

  it("both reject the same type error, with the same code and file", async () => {
    const verdicts = await bothVerdicts(
      [{ path: "broken.ts", contents: "export const x: string = 1;\n" }],
      conventions(),
    );
    expect(verdicts.stable).toEqual([{ code: 2322, path: "broken.ts" }]);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("both honour the caller's strictness identically", async () => {
    const files: BundleFile[] = [
      {
        path: "index.ts",
        contents: "export function len(s: string | undefined): number {\n  return s.length;\n}\n",
      },
    ];

    const strict = await bothVerdicts(files, conventions({ strictness: "strict" }));
    expect(strict.stable.length).toBeGreaterThan(0);
    expect(strict.fast).toEqual(strict.stable);

    const loose = await bothVerdicts(files, conventions({ strictness: "loose" }));
    expect(loose.stable).toEqual([]);
    expect(loose.fast).toEqual(loose.stable);
  });

  it("both apply the extra strictest options", async () => {
    const files: BundleFile[] = [
      { path: "index.ts", contents: "export function first(xs: string[]): string {\n  return xs[0];\n}\n" },
    ];
    const verdicts = await bothVerdicts(files, conventions({ strictness: "strictest" }));
    expect(verdicts.stable.length).toBeGreaterThan(0);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("both resolve DOM types under a browser runtime", async () => {
    const verdicts = await bothVerdicts(
      [{ path: "index.ts", contents: "export const tag = (el: Element): string => el.tagName;\n" }],
      conventions({ runtime: "browser" }),
    );
    expect(verdicts.stable).toEqual([]);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("both notice a missing module", async () => {
    const verdicts = await bothVerdicts(
      [{ path: "index.ts", contents: 'export { gone } from "./gone.js";\n' }],
      conventions(),
    );
    expect(verdicts.stable).toEqual([{ code: 2307, path: "index.ts" }]);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("both order diagnostics the same way across several files", async () => {
    const files: BundleFile[] = [
      { path: "c.ts", contents: "export const c: string = 1;\n" },
      { path: "a.ts", contents: "export const a: string = 1;\n" },
      { path: "b.ts", contents: "export const b: string = 1;\n" },
    ];
    const verdicts = await bothVerdicts(files, conventions());
    expect(verdicts.stable.map((d) => d.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("both order several diagnostics within one file by code", async () => {
    // Ordering by path alone leaves the order inside a file to whatever the compiler emits, which
    // is the sort of detail that shifts between versions and would churn a caller's output.
    const files: BundleFile[] = [
      {
        path: "index.ts",
        contents: "export const a: string = 1;\nexport const b: number = missing;\n",
      },
    ];
    const verdicts = await bothVerdicts(files, conventions());
    const codes = verdicts.stable.map((d) => d.code);
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toEqual(codes.toSorted((x, y) => x - y));
    expect(verdicts.fast).toEqual(verdicts.stable);
  });
});

describe("hermetic boundary", () => {
  it("does not resolve a module that exists only on the real filesystem", async () => {
    // The fallback reaches the same boundary through a different interface, so it needs its own
    // proof. The target is a real file with a real export, so a leak would resolve rather than
    // merely fail for absence — which is what makes this stronger than importing a path that is
    // missing either way.
    const real = `${process.cwd()}/src/engine/verify/typecheck.ts`;
    const outcome = await stable.check(
      [
        {
          path: "index.ts",
          contents: `import { compilerOptionsFor } from "${real}";\nexport const y = compilerOptionsFor;\n`,
        },
      ],
      conventions(),
    );
    expect(outcome.diagnostics.map((d) => d.code)).toEqual([2307]);
  });

  it("does not resolve a bare specifier from the host's node_modules", async () => {
    // zod is a real dependency of this repository with real published types, so a bundle that could
    // reach the host's node_modules would typecheck against a package the consumer may not have.
    // Three separate layers stop it: the bundle root is not a real directory, directory questions
    // are answered for the root and the lib directory only, and non-lib files are never read from
    // disk. Opening any one of them alone leaves this passing; opening all three makes it fail,
    // which is the point of stating the property rather than testing one layer.
    const files: BundleFile[] = [
      { path: "index.ts", contents: 'import { z } from "zod";\nexport const s = z.string();\n' },
    ];
    const verdicts = await bothVerdicts(files, conventions());
    expect(verdicts.stable.map((d) => d.code)).toEqual([2307]);
    expect(verdicts.fast).toEqual(verdicts.stable);
  });

  it("reads lib files, so globals resolve", async () => {
    const outcome = await stable.check(
      [
        {
          path: "index.ts",
          contents: "export const p: Promise<number> = Promise.resolve(1);\nexport const m = new Map<string, number>();\n",
        },
      ],
      conventions(),
    );
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("repeatability", () => {
  it("gives the same verdict twice, since it builds a fresh program each time", async () => {
    const files: BundleFile[] = [{ path: "index.ts", contents: "export const x: string = 1;\n" }];
    const first = await stable.check(files, conventions());
    const second = await stable.check(files, conventions());
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it("never serves a stale verdict when the bundle changes", async () => {
    const clean: BundleFile[] = [{ path: "index.ts", contents: "export const x: number = 1;\n" }];
    const broken: BundleFile[] = [{ path: "index.ts", contents: "export const x: string = 1;\n" }];
    for (let i = 0; i < 2; i++) {
      expect((await stable.check(clean, conventions())).diagnostics).toEqual([]);
      expect((await stable.check(broken, conventions())).diagnostics).toHaveLength(1);
    }
  });
});
