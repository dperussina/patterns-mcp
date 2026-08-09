/**
 * What happens when our own output fails its own verification (Principle III, FR-038).
 *
 * This is the one failure mode the caller is not responsible for, and the only one where the engine
 * has something worth hiding: compiler diagnostics name sandbox paths for files the caller never
 * received, and a stack trace names ours. So the refusal is deliberately thin — a statement that the
 * defect is ours, plus an identifier — while the detail stays on the error object for a log the
 * operator can read.
 *
 * The pattern module is replaced rather than a real one broken, because the interesting case is a
 * pattern that renders code which does not compile, and no pattern in the catalog does that. If one
 * ever did, this path is what would catch it.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { VerificationError } from "../../src/engine/errors.js";
import { generate, disposeEngine } from "../../src/engine/generate/index.js";
import type { PatternModule, RenderedFile } from "../../src/engine/patterns/types.js";

/** Set per test, so one mock can stand in for a pattern that is broken in different ways. */
let rendered: readonly RenderedFile[] = [];

/**
 * The factory only closes over `rendered`; it does not read it. That matters because `vi.mock` is
 * hoisted above the declaration, so a factory that read the value eagerly would hit the temporal dead
 * zone the moment the engine imported this module.
 */
vi.mock("../../src/engine/patterns/result/index.js", () => ({
  resultPattern: {
    name: "result",
    render: () => rendered,
  } satisfies PatternModule,
}));

/** A bundle that satisfies assembly — a core and an example — so verification is what rejects it. */
function bundle(core: string, example: string, test?: string): readonly RenderedFile[] {
  return [
    { path: "order-result.ts", contents: core, role: "core" },
    { path: "order-result-example.ts", contents: example, role: "example" },
    ...(test === undefined
      ? []
      : ([{ path: "order-result.test.ts", contents: test, role: "test" }] as const)),
  ];
}

const request = { pattern: "result", identifiers: { entity: "Order" } } as const;

async function failureFrom(request_: Parameters<typeof generate>[0]): Promise<VerificationError> {
  try {
    await generate(request_);
  } catch (error) {
    if (error instanceof VerificationError) return error;
    throw error;
  }
  throw new Error("expected verification to fail, but a bundle was returned");
}

beforeEach(() => {
  rendered = [];
});

// The compiler runs in a child process; without this it outlives the suite.
afterAll(async () => {
  await disposeEngine();
});

describe("a pattern whose code does not compile", () => {
  beforeEach(() => {
    rendered = bundle(
      "export const answer: number = \"not a number\";\n",
      "export const unused = 1;\n",
    );
  });

  it("refuses rather than returning the bundle", async () => {
    // The bundle exists in memory at this point and is perfectly returnable. Not returning it is the
    // entire promise: nothing unverified reaches a caller, including when the fault is ours.
    await expect(generate({ ...request, options: { includeTests: false } })).rejects.toThrow(
      VerificationError,
    );
  });

  it("blames itself, not the caller", async () => {
    const failure = await failureFrom({ ...request, options: { includeTests: false } });

    expect(failure.stage).toBe("typecheck");
    expect(failure.correctable).toBe(false);
    expect(failure.message).toContain("defect in the pattern, not in your request");
  });

  it("carries an identifier the caller can quote back", async () => {
    const failure = await failureFrom({ ...request, options: { includeTests: false } });

    expect(failure.correlationId).not.toBe("");
    expect(failure.message).toContain(failure.correlationId);
  });

  it("gives the same identifier for the same request, so two reports of one bug agree", async () => {
    const first = await failureFrom({ ...request, options: { includeTests: false } });
    const second = await failureFrom({ ...request, options: { includeTests: false } });

    expect(second.correlationId).toBe(first.correlationId);
  });

  it("keeps the diagnostics off the message and on the error", async () => {
    const failure = await failureFrom({ ...request, options: { includeTests: false } });

    // Available for a log the operator reads.
    expect(failure.diagnostics.join("\n")).toContain("TS");
    // Absent from what a caller is shown: no codes, no paths, no compiler prose.
    expect(failure.message).not.toContain("TS");
    expect(failure.message).not.toContain(".ts");
  });
});

describe("a pattern whose tests fail", () => {
  beforeEach(() => {
    rendered = bundle(
      "export const two = 2;\n",
      "export const unused = 1;\n",
      "import { test } from \"node:test\";\n" +
        "import assert from \"node:assert/strict\";\n" +
        "import { two } from \"./order-result.js\";\n" +
        "test(\"two is three\", () => {\n  assert.equal(two, 3);\n});\n",
    );
  });

  it("refuses, and says the tests were what failed", async () => {
    const failure = await failureFrom({
      ...request,
      conventions: { testFramework: "node-test" },
    });

    expect(failure.stage).toBe("tests");
    expect(failure.message).toContain("failed its tests");
    expect(failure.message).not.toContain(".ts");
  }, 120_000);
});
