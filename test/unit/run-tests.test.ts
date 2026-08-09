/**
 * These actually spawn processes, which is the point: the sandbox and the timeout are only real if
 * something has tried to escape them.
 */

import { describe, expect, it } from "vitest";

import { runGeneratedTests } from "../../src/engine/verify/run-tests.js";
import type { BundleFile } from "../../src/engine/verify/typecheck.js";

const PASSING = [
  { path: "lib.ts", contents: "export const two = 2;\n" },
  {
    path: "lib.test.ts",
    contents:
      'import { test } from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { two } from "./lib.js";\n' +
      'test("adds", () => {\n  assert.equal(two + two, 4);\n});\n',
  },
] satisfies BundleFile[];

/** A file that tries to do the thing the sandbox is supposed to prevent. */
function escapeAttempt(body: string): BundleFile[] {
  return [
    {
      path: "escape.test.ts",
      contents:
        'import { test } from "node:test";\n' +
        `test("attempts an escape", () => {\n${body}\n});\n`,
    },
  ];
}

describe("nothing to run", () => {
  it("skips when there are no test entry points", async () => {
    expect(await runGeneratedTests({ files: PASSING, testPaths: [] })).toEqual({
      outcome: "skipped",
      detail: undefined,
    });
  });

  it("refuses an entry point that is not in the bundle, rather than calling it a failure", async () => {
    // This is our assembly being wrong, and reporting it as a test failure would send the reader
    // looking at the wrong thing entirely.
    await expect(
      runGeneratedTests({ files: PASSING, testPaths: ["absent.test.ts"] }),
    ).rejects.toThrow(/absent\.test\.ts/);
  });
});

describe("running tests", () => {
  it("passes a bundle whose tests pass", async () => {
    expect(await runGeneratedTests({ files: PASSING, testPaths: ["lib.test.ts"] })).toEqual({
      outcome: "passed",
      detail: undefined,
    });
  });

  it("fails a bundle whose assertion fails, and says which file", async () => {
    const files: BundleFile[] = [
      {
        path: "wrong.test.ts",
        contents:
          'import { test } from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'test("wrong", () => {\n  assert.equal(1, 2);\n});\n',
      },
    ];
    const result = await runGeneratedTests({ files, testPaths: ["wrong.test.ts"] });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("wrong.test.ts");
  });

  it("fails when a test file throws while being imported", async () => {
    const files: BundleFile[] = [
      { path: "boom.test.ts", contents: 'throw new Error("import-time boom");\n' },
    ];
    const result = await runGeneratedTests({ files, testPaths: ["boom.test.ts"] });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("boom");
  });

  it("runs every entry point, not just the first", async () => {
    const files: BundleFile[] = [
      {
        path: "a.test.ts",
        contents: 'import { test } from "node:test";\ntest("a", () => {});\n',
      },
      {
        path: "b.test.ts",
        contents:
          'import { test } from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'test("b", () => {\n  assert.fail("second file ran");\n});\n',
      },
    ];
    const result = await runGeneratedTests({ files, testPaths: ["a.test.ts", "b.test.ts"] });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("b.test.ts");
  });

  it("reports the same failure regardless of the order entry points are given in", async () => {
    const files: BundleFile[] = [
      {
        path: "z.test.ts",
        contents:
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("z", () => {\n  assert.fail("z failed");\n});\n',
      },
      {
        path: "m.test.ts",
        contents:
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("m", () => {\n  assert.fail("m failed");\n});\n',
      },
    ];
    const forwards = await runGeneratedTests({ files, testPaths: ["z.test.ts", "m.test.ts"] });
    const backwards = await runGeneratedTests({ files, testPaths: ["m.test.ts", "z.test.ts"] });
    expect(forwards.detail).toContain("m.test.ts");
    expect(backwards.detail).toContain("m.test.ts");
  });
});

describe("import styles", () => {
  // A bundle that typechecks but cannot be executed would make the gate unenforceable for whichever
  // convention produced it, and `.js` specifiers are the default.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["js extension", "./lib.js"],
    ["ts extension", "./lib.ts"],
    ["extensionless", "./lib"],
  ];

  for (const [label, specifier] of cases) {
    it(`executes a bundle importing with a ${label}`, async () => {
      const files: BundleFile[] = [
        { path: "lib.ts", contents: "export const value = 7;\n" },
        {
          path: "main.test.ts",
          contents:
            'import { test } from "node:test";\n' +
            'import assert from "node:assert/strict";\n' +
            `import { value } from "${specifier}";\n` +
            'test("resolves", () => {\n  assert.equal(value, 7);\n});\n',
        },
      ];
      expect((await runGeneratedTests({ files, testPaths: ["main.test.ts"] })).outcome).toBe("passed");
    });
  }

  it("executes a test in a subdirectory", async () => {
    const files: BundleFile[] = [
      { path: "src/lib.ts", contents: "export const value = 3;\n" },
      {
        path: "src/lib.test.ts",
        contents:
          'import { test } from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { value } from "./lib.js";\n' +
          'test("nested", () => {\n  assert.equal(value, 3);\n});\n',
      },
    ];
    expect((await runGeneratedTests({ files, testPaths: ["src/lib.test.ts"] })).outcome).toBe("passed");
  });
});

describe("the timeout is hard", () => {
  it("kills a test that will not finish", async () => {
    const files: BundleFile[] = [
      {
        path: "spin.test.ts",
        contents:
          'import { test } from "node:test";\ntest("spins", () => {\n  while (true) {}\n});\n',
      },
    ];
    const result = await runGeneratedTests({ files, testPaths: ["spin.test.ts"], timeoutMs: 700 });
    expect(result.outcome).toBe("failed");
    // A busy loop cannot be asked politely, so this also proves the signal is not SIGTERM.
    expect(result.detail).toContain("timed out");
  }, 20_000);
});

describe("the sandbox holds", () => {
  it("denies reading a file outside the bundle", async () => {
    const result = await runGeneratedTests({
      files: escapeAttempt(
        '  const fs = require("node:fs");\n  fs.readFileSync("/etc/hosts", "utf8");',
      ),
      testPaths: ["escape.test.ts"],
    });
    expect(result.outcome).toBe("failed");
  });

  it("denies writing to the filesystem", async () => {
    const result = await runGeneratedTests({
      files: escapeAttempt('  require("node:fs").writeFileSync("/tmp/should-not-exist.txt", "x");'),
      testPaths: ["escape.test.ts"],
    });
    expect(result.outcome).toBe("failed");
  });

  it("denies spawning a subprocess", async () => {
    // This is why each file is run directly rather than through `node --test`, which would need the
    // permission this asserts is absent.
    const result = await runGeneratedTests({
      files: escapeAttempt('  require("node:child_process").execSync("echo escaped");'),
      testPaths: ["escape.test.ts"],
    });
    expect(result.outcome).toBe("failed");
  });

  it("does not hand the sandbox this process's environment", async () => {
    const files: BundleFile[] = [
      {
        path: "env.test.ts",
        contents:
          'import { test } from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'test("env is bare", () => {\n' +
          "  assert.equal(process.env.PATTERNS_SECRET, undefined);\n" +
          // Not an assertion of emptiness: macOS injects __CF_USER_TEXT_ENCODING regardless of what
          // is passed. What matters is that nothing resembling a real environment came through.
          "  assert.equal(process.env.PATH, undefined);\n" +
          "  assert.equal(process.env.HOME, undefined);\n" +
          "  assert.equal(process.env.NODE_OPTIONS, undefined);\n" +
          "});\n",
      },
    ];
    // Set on this process, and expected not to reach the child.
    process.env.PATTERNS_SECRET = "must-not-leak";
    try {
      expect((await runGeneratedTests({ files, testPaths: ["env.test.ts"] })).outcome).toBe("passed");
    } finally {
      delete process.env.PATTERNS_SECRET;
    }
  });

  it("refuses a bundle path that would escape the directory", async () => {
    for (const path of ["../escape.ts", "/etc/passwd.ts", "a/../../b.ts"]) {
      await expect(
        runGeneratedTests({
          files: [{ path, contents: "export const x = 1;\n" }, ...PASSING],
          testPaths: ["lib.test.ts"],
        }),
      ).rejects.toThrow(/Unsafe bundle path/);
    }
  });
});
