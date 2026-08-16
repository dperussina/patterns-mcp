/**
 * These drive the real compiler. They are the only way to know that a conventions-to-options mapping
 * is right: a wrong `moduleResolution` does not fail loudly, it reports "cannot find module" on every
 * import of a perfectly good bundle, which reads like a generation bug.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/**
 * The compiler is replaced once it has served its quota, because the project it keeps open keeps every
 * file tree it has been shown — measured at ~3MB a check with no plateau, which filled a CI runner and
 * would eventually do the same to a long-running server.
 *
 * What is asserted here is that replacing it is invisible: a correct verdict either side of the boundary
 * and across it, and no leaked subprocess. The bound itself is measured by `scripts/measure-retention.ts`,
 * since a test cannot usefully assert a number that depends on the compiler's own internals.
 */
describe("a compiler replaced once it has served its quota", () => {
  it("keeps answering correctly across the boundary", async () => {
    // Two, so the run crosses several boundaries in a handful of checks rather than a hundred.
    const recycling = new Typechecker({ checksPerCompiler: 2 });
    try {
      const verdicts: boolean[] = [];
      // Sequential, deliberately: the replacement happens at the start of a turn, so overlapping calls
      // would not exercise the same path. Alternating clean and broken means a stale project serving a
      // previous bundle's files shows up as a wrong verdict rather than as an error.
      for (const index of Array.from({ length: 7 }, (_, at) => at)) {
        const files = index % 2 === 0 ? clean(`step${String(index)}`) : broken(`step${String(index)}`);
        const outcome = await recycling.check(files, conventions());
        verdicts.push(outcome.diagnostics.length > 0);
      }

      expect(verdicts).toEqual([false, true, false, true, false, true, false]);
    } finally {
      await recycling.dispose();
    }
  });

  it("really does replace it, one at a time", async () => {
    // Which compiler served each check, watched from outside because the handle is private. A quota of one
    // means every check after the first is served by a new subprocess, so the identities say whether the
    // replacement happened at all — the verdicts above would read the same either way, and so would a
    // count. Deleting the recycling fails here and nowhere else.
    // Everything already running belongs to this file's shared `checker`, which lives for the whole run
    // in the same worker; only what appears on top of it is ours.
    const theirs = new Set(await ownCompilers());
    const ours = async (): Promise<readonly number[]> =>
      (await ownCompilers()).filter((pid) => !theirs.has(pid));

    const served: number[] = [];
    const recycling = new Typechecker({ checksPerCompiler: 1 });
    try {
      for (const index of [0, 1, 2, 3]) {
        await recycling.check(clean(`only${String(index)}`), conventions());
        served.push(...(await ours()));
      }
    } finally {
      await recycling.dispose();
    }

    // Four checks, four compilers, and never two at once. The second half is the load-bearing one: were
    // the disposal not awaited, the outgoing subprocess would overlap the incoming one and the peak would
    // scale with the quota, which is the pressure being relieved rather than a tidiness point.
    expect(new Set(served).size).toBe(4);
    expect(served).toHaveLength(4);
    // Nothing outlives the instance that owns it.
    expect(await ours()).toEqual([]);
  });
});

/**
 * The process ids of the compiler subprocesses this worker owns.
 *
 * Scoped to our own children on purpose: the machine is running other test files that hold compilers of
 * their own, so a machine-wide reading would be measuring the neighbours' lifecycles as much as ours and
 * would move whenever one of them happened to start or finish inside our window.
 */
async function ownCompilers(): Promise<readonly number[]> {
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,args="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, parent]) => Number(parent) === process.pid)
    .filter((columns) => columns.includes("--api"))
    .map(([pid]) => Number(pid));
}

const clean = (name: string): BundleFile[] => [
  { path: "index.ts", contents: `export const ${name} = "${name}" as const;\n` },
];
const broken = (name: string): BundleFile[] => [
  { path: "index.ts", contents: `export const ${name}: number = "not a number";\n` },
];

/**
 * One instance holds one mutable file tree and one compiler subprocess, so overlapping checks are
 * the case most able to return a wrong answer: a bundle can be verified against another's files and
 * be reported clean. These run against a dedicated instance so a wedged compiler cannot take the
 * rest of the file down with it.
 */
describe("overlapping checks on one instance", () => {
  it("gives every caller a verdict about their own files", async () => {
    const shared = new Typechecker();
    try {
      const outcomes = await Promise.all([
        shared.check(clean("first"), conventions()),
        shared.check(broken("second"), conventions()),
        shared.check(clean("third"), conventions()),
        shared.check(broken("fourth"), conventions()),
        shared.check(clean("fifth"), conventions()),
      ]);

      // A failure that leaked the neighbouring bundle would show up here as the wrong verdict
      // rather than as an error, which is why the shape is asserted per position.
      expect(outcomes.map((outcome) => outcome.diagnostics.length > 0)).toEqual([
        false,
        true,
        false,
        true,
        false,
      ]);
    } finally {
      await shared.dispose();
    }
  });

  it("reports each caller's own compiler options, not the last writer's", async () => {
    const shared = new Typechecker();
    try {
      const [loose, strictest] = await Promise.all([
        shared.check(clean("loose"), conventions({ strictness: "loose" })),
        shared.check(clean("strictest"), conventions({ strictness: "strictest" })),
      ]);

      expect(loose.compilerOptions).toMatchObject({ strict: false });
      expect(strictest.compilerOptions).toMatchObject({ noUncheckedIndexedAccess: true });
    } finally {
      await shared.dispose();
    }
  });
});
