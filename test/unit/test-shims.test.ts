/**
 * The shim exists so that "these tests passed" stays true for a bundle written against the caller's
 * runner. Its danger is the mirror image: a shim that accepted everything would make the same sentence
 * meaningless. So the assertions that matter here are the negative ones — a failing suite must fail,
 * and an unsupported matcher must fail rather than be quietly ignored.
 */

import { describe, expect, it } from "vitest";

import { runGeneratedTests } from "../../src/engine/verify/run-tests.js";
import {
  SHIMMED_PACKAGES,
  SUPPORTED_MATCHERS,
  bareRequires,
  shimFilesFor,
} from "../../src/engine/verify/test-shims.js";

const subject = {
  path: "value.ts",
  contents: "export const double = (n: number): number => n * 2;\n",
};

async function run(testSource: string): Promise<string> {
  const result = await runGeneratedTests({
    files: [subject, { path: "value.test.ts", contents: testSource }],
    testPaths: ["value.test.ts"],
  });
  return result.outcome === "passed" ? "passed" : `${result.outcome}: ${result.detail ?? ""}`;
}

describe("collecting what a bundle imports", () => {
  it("finds bare specifiers and ignores the bundle's own files", () => {
    const contents = 'require("vitest"); require("./value.js"); require("node:assert");';
    expect(bareRequires(contents)).toEqual(["node:assert", "vitest"]);
  });

  it("writes a package only for what it can actually shim", () => {
    expect(shimFilesFor(["node:test"]).size).toBe(0);
    expect([...shimFilesFor(["vitest"]).keys()].toSorted()).toEqual([
      "node_modules/vitest/index.js",
      "node_modules/vitest/package.json",
    ]);
  });

  it("names the packages it shims, so a pattern author knows what may be imported", () => {
    expect(SHIMMED_PACKAGES).toEqual(["vitest"]);
  });
});

describe("running a suite written for vitest", () => {
  it("executes a passing suite", async () => {
    expect(
      await run(
        'import { describe, it, expect } from "vitest";\n' +
          'import { double } from "./value.js";\n' +
          'describe("double", () => {\n' +
          '  it("doubles", () => {\n' +
          "    expect(double(2)).toBe(4);\n" +
          "  });\n" +
          "});\n",
      ),
    ).toBe("passed");
  });

  it("reports a failing suite as failed, which is the assertion the shim exists to keep honest", async () => {
    const outcome = await run(
      'import { it, expect } from "vitest";\n' +
        'import { double } from "./value.js";\n' +
        'it("is wrong on purpose", () => {\n' +
        "  expect(double(2)).toBe(5);\n" +
        "});\n",
    );
    expect(outcome).toMatch(/^failed/);
  });

  it("fails on an unsupported matcher instead of pretending it checked", async () => {
    const outcome = await run(
      'import { it, expect } from "vitest";\n' +
        'it("uses a matcher we do not implement", () => {\n' +
        "  (expect(1) as unknown as { toBeWithin(n: number): void }).toBeWithin(3);\n" +
        "});\n",
    );
    expect(outcome).toMatch(/^failed/);
    expect(outcome).toContain("toBeWithin");
  });

  it("supports each matcher it advertises", async () => {
    // Every matcher in one suite, used the way a generated test would. If one is advertised but
    // missing, the guard throws and this fails.
    const outcome = await run(
      'import { it, expect } from "vitest";\n' +
        'it("exercises the surface", () => {\n' +
        "  expect(1).toBe(1);\n" +
        "  expect({ a: [1] }).toEqual({ a: [1] });\n" +
        "  expect(undefined).toBeUndefined();\n" +
        "  expect(1).toBeDefined();\n" +
        "  expect(null).toBeNull();\n" +
        "  expect(1).toBeTruthy();\n" +
        "  expect(0).toBeFalsy();\n" +
        "  expect(new Error('x')).toBeInstanceOf(Error);\n" +
        "  expect(() => { throw new Error('boom'); }).toThrow(/boom/);\n" +
        "  expect([1, 2]).toContain(2);\n" +
        "  expect([1, 2]).toHaveLength(2);\n" +
        "  expect(2).toBeGreaterThan(1);\n" +
        "  expect(1).toBeLessThan(2);\n" +
        "  expect(0.1 + 0.2).toBeCloseTo(0.3);\n" +
        "  expect(1).not.toBe(2);\n" +
        "});\n",
    );
    expect(outcome).toBe("passed");
    expect(SUPPORTED_MATCHERS.length).toBeGreaterThan(10);
  });

  it("honours negation, so not.toBe cannot pass by accident", async () => {
    expect(
      await run('import { it, expect } from "vitest";\nit("x", () => { expect(1).not.toBe(1); });\n'),
    ).toMatch(/^failed/);
  });

  it("still refuses to reach the network or the filesystem from a generated test", async () => {
    // The shim adds a resolvable package; it must not add capability.
    const outcome = await run(
      'import { it } from "vitest";\n' +
        'import { writeFileSync } from "node:fs";\n' +
        'it("writes", () => {\n' +
        '  writeFileSync("/tmp/pattern-escape", "x");\n' +
        "});\n",
    );
    expect(outcome).toMatch(/^failed/);
  });
});
