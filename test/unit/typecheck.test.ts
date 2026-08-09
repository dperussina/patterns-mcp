/**
 * These drive the real compiler. They are the only way to know that a conventions-to-options mapping
 * is right: a wrong `moduleResolution` does not fail loudly, it reports "cannot find module" on every
 * import of a perfectly good bundle, which reads like a generation bug.
 */

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_CONVENTIONS } from "../../src/engine/options/conventions.js";
import type { Conventions } from "../../src/engine/options/conventions.js";
import { Typechecker, compilerOptionsFor } from "../../src/engine/verify/typecheck.js";
import type { BundleFile } from "../../src/engine/verify/typecheck.js";

const checker = new Typechecker();

afterAll(async () => {
  await checker.dispose();
});

const conventions = (overrides: Partial<Conventions> = {}): Conventions => ({
  ...DEFAULT_CONVENTIONS,
  ...overrides,
});

/** A multi-file bundle whose imports exercise whichever extension style is under test. */
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

const EXTENSION_FOR: Record<Conventions["importExtensions"], string> = {
  js: ".js",
  ts: ".ts",
  none: "",
};

describe("compilerOptionsFor", () => {
  it("always forbids emit, because verification asks a question rather than producing artefacts", () => {
    for (const strictness of ["strict", "strictest", "loose"] as const) {
      expect(compilerOptionsFor(conventions({ strictness })).noEmit).toBe(true);
    }
  });

  it("maps strictness to the options a caller would recognise", () => {
    expect(compilerOptionsFor(conventions({ strictness: "loose" })).strict).toBe(false);
    expect(compilerOptionsFor(conventions({ strictness: "strict" })).strict).toBe(true);

    const strictest = compilerOptionsFor(conventions({ strictness: "strictest" }));
    expect(strictest.strict).toBe(true);
    expect(strictest.noUncheckedIndexedAccess).toBe(true);
    expect(strictest.exactOptionalPropertyTypes).toBe(true);
  });

  it("adds the DOM libs only for a browser runtime", () => {
    expect(compilerOptionsFor(conventions({ runtime: "browser" })).lib).toContain("dom");
    expect(compilerOptionsFor(conventions({ runtime: "node" })).lib).not.toContain("dom");
    expect(compilerOptionsFor(conventions({ runtime: "neutral" })).lib).not.toContain("dom");
  });

  it("permits a .ts import specifier only where nothing is emitted", () => {
    const options = compilerOptionsFor(conventions({ importExtensions: "ts" }));
    expect(options.allowImportingTsExtensions).toBe(true);
    expect(options.noEmit).toBe(true);
  });

  it("is a pure function of its input", () => {
    const input = conventions({ strictness: "strictest" });
    expect(compilerOptionsFor(input)).toEqual(compilerOptionsFor(input));
  });
});

describe("checking a clean bundle under each convention", () => {
  // The matrix that matters: if any cell reports a diagnostic, the option mapping is wrong and every
  // bundle generated under that convention would be refused.
  for (const importExtensions of ["js", "ts", "none"] as const) {
    for (const moduleStyle of ["esm", "cjs"] as const) {
      it(`accepts a clean bundle with ${moduleStyle} and ${importExtensions} extensions`, async () => {
        const outcome = await checker.check(
          bundle(EXTENSION_FOR[importExtensions]),
          conventions({ importExtensions, moduleStyle }),
        );
        expect(outcome.diagnostics).toEqual([]);
      });
    }
  }

  for (const strictness of ["loose", "strict", "strictest"] as const) {
    it(`accepts a clean bundle under ${strictness}`, async () => {
      const outcome = await checker.check(bundle(".js"), conventions({ strictness }));
      expect(outcome.diagnostics).toEqual([]);
    });
  }

  it("accepts a bundle using DOM types when the runtime is the browser", async () => {
    const outcome = await checker.check(
      [{ path: "index.ts", contents: "export const has = (el: Element): string => el.tagName;\n" }],
      conventions({ runtime: "browser" }),
    );
    expect(outcome.diagnostics).toEqual([]);
  });
});

describe("reporting problems", () => {
  it("reports a type error with its code, message, and bundle-relative path", async () => {
    const outcome = await checker.check(
      [{ path: "broken.ts", contents: "export const x: string = 1;\n" }],
      conventions(),
    );

    expect(outcome.diagnostics).toHaveLength(1);
    const [diagnostic] = outcome.diagnostics;
    expect(diagnostic?.code).toBe(2322);
    expect(diagnostic?.text).toContain("not assignable");
    // Relative, so a diagnostic can be shown against the file the caller received.
    expect(diagnostic?.path).toBe("broken.ts");
  });

  it("enforces the caller's strictness rather than its own preference", async () => {
    // Fails under strictNullChecks, passes without it. If verification ignored conventions, one of
    // these two assertions would have to be wrong.
    const files = [
      {
        path: "index.ts",
        contents: "export function len(s: string | undefined): number {\n  return s.length;\n}\n",
      },
    ];

    expect(await checker.check(files, conventions({ strictness: "strict" }))).toMatchObject({
      diagnostics: [{ code: 18048 }],
    });
    expect((await checker.check(files, conventions({ strictness: "loose" }))).diagnostics).toEqual([]);
  });

  it("applies the extra strictest options, not merely strict", async () => {
    const files = [
      {
        path: "index.ts",
        contents: "export function first(xs: string[]): string {\n  return xs[0];\n}\n",
      },
    ];

    // noUncheckedIndexedAccess makes xs[0] possibly undefined.
    expect((await checker.check(files, conventions({ strictness: "strict" }))).diagnostics).toEqual([]);
    expect(
      (await checker.check(files, conventions({ strictness: "strictest" }))).diagnostics.length,
    ).toBeGreaterThan(0);
  });

  it("orders diagnostics by path so the same defect reports identically twice", async () => {
    const files = [
      { path: "c.ts", contents: "export const c: string = 1;\n" },
      { path: "a.ts", contents: "export const a: string = 1;\n" },
      { path: "b.ts", contents: "export const b: string = 1;\n" },
    ];

    const first = await checker.check(files, conventions());
    const second = await checker.check(files, conventions());
    expect(first.diagnostics.map((d) => d.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(second.diagnostics).toEqual(first.diagnostics);
  });
});

describe("warm reuse", () => {
  it("never serves a stale verdict when the bundle is swapped", async () => {
    // The trap this module exists to close. The compiler answers from cache when it is not told what
    // changed; a broken bundle measured clean that way. Alternating proves each answer is fresh.
    const clean: BundleFile[] = [{ path: "index.ts", contents: "export const x: number = 1;\n" }];
    const broken: BundleFile[] = [{ path: "index.ts", contents: "export const x: string = 1;\n" }];

    for (let i = 0; i < 3; i++) {
      expect((await checker.check(clean, conventions())).diagnostics).toEqual([]);
      expect((await checker.check(broken, conventions())).diagnostics).toHaveLength(1);
    }
  });

  it("notices a bundle that loses a file", async () => {
    const both: BundleFile[] = [
      { path: "index.ts", contents: 'export { helper } from "./helper.js";\n' },
      { path: "helper.ts", contents: "export const helper = 1;\n" },
    ];
    expect((await checker.check(both, conventions())).diagnostics).toEqual([]);

    // Dropping helper.ts must be seen, or the import would still appear to resolve.
    const orphaned = await checker.check([both[0]!], conventions());
    expect(orphaned.diagnostics.map((d) => d.code)).toEqual([2307]);
  });

  it("picks up a change of conventions between checks", async () => {
    // Configuration is the case invalidateAll does not cover: only naming the tsconfig as changed
    // reloads it. Since the summary is derived from the whole tree, this holds by construction.
    const files: BundleFile[] = [
      {
        path: "index.ts",
        contents: "export function len(s: string | undefined): number {\n  return s.length;\n}\n",
      },
    ];

    expect((await checker.check(files, conventions({ strictness: "loose" }))).diagnostics).toEqual([]);
    expect(
      (await checker.check(files, conventions({ strictness: "strict" }))).diagnostics.length,
    ).toBeGreaterThan(0);
    expect((await checker.check(files, conventions({ strictness: "loose" }))).diagnostics).toEqual([]);
  });

  it("reports the options and compiler version it actually used", async () => {
    const outcome = await checker.check(
      [{ path: "index.ts", contents: "export const x = 1;\n" }],
      conventions({ strictness: "strictest" }),
    );
    expect(outcome.compilerVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(outcome.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true });
  });

  it("can be disposed twice without complaint", async () => {
    const throwaway = new Typechecker();
    await throwaway.check([{ path: "index.ts", contents: "export const x = 1;\n" }], conventions());
    await throwaway.dispose();
    await expect(throwaway.dispose()).resolves.toBeUndefined();
  });

  it("warms without needing a bundle", async () => {
    const warmed = new Typechecker();
    try {
      await expect(warmed.warm()).resolves.toBeUndefined();
      expect((await warmed.check([{ path: "index.ts", contents: "export const x = 1;\n" }], conventions())).diagnostics).toEqual([]);
    } finally {
      await warmed.dispose();
    }
  });
});
