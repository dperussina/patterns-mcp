/**
 * The pipeline: resolve, render, format, verify, assemble. Its contract is that it resolves only for a
 * bundle that compiled and whose tests ran (Principle III), and that it reads nothing but its request
 * (Principle I). Everything asserted here is a promise made in contracts/engine-api.md.
 */

import { describe, expect, it } from "vitest";

import { generate } from "../../src/engine/generate/index.js";
import {
  InvalidIdentifierError,
  InvalidOptionValueError,
  UnknownOptionError,
  UnknownPatternError,
} from "../../src/engine/errors.js";
import type { Conventions } from "../../src/engine/options/conventions.js";

/**
 * Every value of a union, checked by the compiler rather than by hand: the `Record` cannot be built
 * without a key for each member, so widening the union breaks this file until the new value is
 * covered here too.
 */
function keysOf<T extends string>(all: Record<T, true>): readonly T[] {
  return Object.keys(all) as T[];
}

describe("a generated bundle", () => {
  it("returns files, resolved inputs, and evidence", async () => {
    const result = await generate({
      pattern: "result",
      identifiers: { entity: "Order" },
    });

    if (result.kind !== "bundle") throw new Error("expected a bundle");
    expect(result.pattern).toBe("result");
    expect(result.files.length).toBeGreaterThan(1);
    expect(result.verification).toMatchObject({
      diagnosticCount: 0,
      testOutcome: "passed",
    });
    expect(result.verification.compilerVersion).toMatch(/^\d+\./);
    expect(result.verification.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports every option and convention it resolved, including the ones defaulted", () => {
    return generate({ pattern: "result", identifiers: { entity: "Order" } }).then((result) => {
      if (result.kind !== "bundle") throw new Error("expected a bundle");
      // FR-007 and FR-026: a caller who supplied nothing still learns what was used.
      expect(Object.keys(result.resolvedOptions).length).toBeGreaterThan(0);
      expect(result.resolvedConventions).toMatchObject({
        strictness: "strict",
        moduleStyle: "esm",
      });
    });
  });

  it("emits a usage example distinct from its tests", async () => {
    const result = await generate({ pattern: "result", identifiers: { entity: "Order" } });
    if (result.kind !== "bundle") throw new Error("expected a bundle");

    const roles = result.files.map((file) => file.role);
    expect(roles).toContain("example");
    expect(roles).toContain("test");

    const example = result.files.find((file) => file.role === "example");
    const test = result.files.find((file) => file.role === "test");
    expect(example?.path).not.toBe(test?.path);
  });

  it("names files after the identifier it was given, not after the pattern", async () => {
    const result = await generate({ pattern: "result", identifiers: { entity: "Invoice" } });
    if (result.kind !== "bundle") throw new Error("expected a bundle");
    expect(result.files.some((file) => file.path.includes("invoice"))).toBe(true);
  });
});

describe("verification is not optional", () => {
  /**
   * Drawn from the schema rather than written out, because the gap this closes was a hand-written
   * list that omitted `loose`. Generated code compiled under the two strict settings and failed
   * under the third, and no test could see it. A new convention value now arrives here on its own.
   */
  const strictnesses = keysOf<Conventions["strictness"]>({
    strict: true,
    strictest: true,
    loose: true,
  });
  const extensions = keysOf<Conventions["importExtensions"]>({
    js: true,
    ts: true,
    none: true,
  });

  it("typechecks under the conventions the caller asked for", async () => {
    // Each of these produces materially different code — different import specifiers, different
    // strictness — and every one of them has to compile.
    for (const importExtensions of extensions) {
      for (const strictness of strictnesses) {
        const result = await generate({
          pattern: "result",
          identifiers: { entity: "Order" },
          conventions: { importExtensions, strictness },
        });
        if (result.kind !== "bundle") throw new Error("expected a bundle");
        expect(result.verification.diagnosticCount).toBe(0);
        // Asserted per setting, so a bundle cannot pass by being verified as stricter than asked.
        expect(result.verification.compilerOptions).toMatchObject({
          strict: strictness !== "loose",
        });
      }
    }
  }, 120_000);

  it("runs the tests it emits and says so", async () => {
    const result = await generate({
      pattern: "result",
      identifiers: { entity: "Order" },
      conventions: { testFramework: "node-test" },
    });
    if (result.kind !== "bundle") throw new Error("expected a bundle");
    expect(result.verification.testOutcome).toBe("passed");
  });

  it("reports skipped, never passed, when the caller declines tests", async () => {
    const result = await generate({
      pattern: "result",
      identifiers: { entity: "Order" },
      options: { includeTests: false },
    });
    if (result.kind !== "bundle") throw new Error("expected a bundle");
    expect(result.files.some((file) => file.role === "test")).toBe(false);
    expect(result.verification.testOutcome).toBe("skipped");
  });
});

describe("refusals name the field and the rule", () => {
  it("refuses an unknown pattern", async () => {
    await expect(generate({ pattern: "no-such-pattern" })).rejects.toThrow(UnknownPatternError);
  });

  it("refuses an unknown option rather than ignoring it", async () => {
    await expect(
      generate({
        pattern: "result",
        identifiers: { entity: "Order" },
        options: { nonesuch: true },
      }),
    ).rejects.toThrow(UnknownOptionError);
  });

  it("refuses a value outside the declared space", async () => {
    await expect(
      generate({
        pattern: "result",
        identifiers: { entity: "Order" },
        options: { emitScope: "sideways" },
      }),
    ).rejects.toThrow(InvalidOptionValueError);
  });

  it("refuses an identifier that would not compile", async () => {
    await expect(
      generate({ pattern: "result", identifiers: { entity: "class" } }),
    ).rejects.toThrow(InvalidIdentifierError);
  });
});

describe("the caller's formatting reaches the output", () => {
  it("honours an allowed style option", async () => {
    const semi = await generate({
      pattern: "result",
      identifiers: { entity: "Order" },
      conventions: { prettierConfig: { semi: true } },
    });
    const noSemi = await generate({
      pattern: "result",
      identifiers: { entity: "Order" },
      conventions: { prettierConfig: { semi: false } },
    });
    if (semi.kind !== "bundle" || noSemi.kind !== "bundle") throw new Error("expected bundles");
    expect(noSemi.files[0]?.contents).not.toBe(semi.files[0]?.contents);
    // Both still had to compile, which is the point of formatting before verifying rather than after.
    expect(noSemi.verification.diagnosticCount).toBe(0);
  });
});
