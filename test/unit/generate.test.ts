/**
 * The pipeline: resolve, render, format, verify, assemble. Its contract is that it resolves only for a
 * bundle that compiled and whose tests ran (Principle III), and that it reads nothing but its request
 * (Principle I). Everything asserted here is a promise made in contracts/engine-api.md.
 */

import { describe, expect, it } from "vitest";

import { generate } from "../../src/engine/generate/index.js";
import { generateBundle } from "../bundle.js";
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

/**
 * A pattern the language superseded answers with advice, and the answer is a success (FR-022).
 *
 * The regression this guards is specific and was real: `generativeEntry` threw `UnknownPatternError` for
 * an advisory entry, with a comment saying such entries were "answered by a different path" — and no
 * such path existed. A caller asking for `singleton` was told the catalogue had no such pattern while
 * `list_patterns` was listing it, which is the catalogue contradicting itself.
 */
describe("a pattern TypeScript made obsolete", () => {
  it("answers with advice instead of code, and does not reject", async () => {
    const result = await generate({ pattern: "singleton" });

    expect(result.kind).toBe("advisory");
    if (result.kind !== "advisory") throw new Error("expected advice");
    expect(result.pattern).toBe("singleton");
    expect(result.alternative.length).toBeGreaterThan(0);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("names catalogue entries to reach for, where the alternative is one of them", async () => {
    const result = await generate({ pattern: "visitor" });
    if (result.kind !== "advisory") throw new Error("expected advice");

    // Not merely non-empty: the entry it names has to be one a caller can actually generate, or the
    // next step it recommends is a second dead end.
    expect(result.relatedPatterns).toContain("discriminated-union");
  });

  it("answers the same way when sent options it has none of", async () => {
    // Deliberate, and the one place this pipeline does not refuse an input it will not read: an
    // advisory entry declares no options, so the only correction available is the same call without
    // them — which returns this same answer. See `advisoryFor` for the reasoning.
    const bare = await generate({ pattern: "singleton" });
    const dressed = await generate({
      pattern: "singleton",
      identifiers: { entity: "Config" },
      options: { includeTests: false },
    });

    expect(dressed).toEqual(bare);
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
        options: { includeTests: "sideways" },
      }),
    ).rejects.toThrow(InvalidOptionValueError);
  });

  it("refuses an identifier that would not compile", async () => {
    await expect(
      generate({ pattern: "result", identifiers: { entity: "class" } }),
    ).rejects.toThrow(InvalidIdentifierError);
  });
});

/**
 * `jest` is recognised so that asking for it gets an answer naming the three frameworks that work,
 * rather than the generic message an unknown enum value would produce. It is refused rather than
 * served because the verification sandbox has no `node_modules` and Jest's globals cannot be supplied
 * by a resolvable package the way Vitest's can, so a Jest suite could be emitted but never executed.
 *
 * These two cases are load-bearing beyond their own subject. Every pattern module used to carry its
 * own `testFramework === "jest"` import arm, sixteen copies of a branch that `assertExecutableTests`
 * makes unreachable, and they were deleted on the strength of that. What follows is the reason the
 * deletion is sound, written as a test rather than as a comment: if the refusal below were ever
 * relaxed, sixteen modules would quietly emit Vitest imports for a caller who asked for Jest, which
 * is the convention-fidelity failure the refusal exists to prevent.
 */
describe("the one framework that is named but not served", () => {
  it("refuses jest when a suite would be emitted, naming what does work", async () => {
    await expect(
      generate({
        pattern: "result",
        identifiers: { entity: "Order" },
        conventions: { testFramework: "jest" },
      }),
    ).rejects.toThrow(InvalidOptionValueError);
  });

  it("accepts jest when no suite is emitted, since nothing then needs executing", async () => {
    // Not a curiosity: this is the combination the conformance suite exercises for this axis, and the
    // only one in which the value reaches a pattern module at all.
    const result = await generateBundle({
      pattern: "result",
      identifiers: { entity: "Order" },
      options: { includeTests: false },
      conventions: { testFramework: "jest" },
    });

    expect(result.files.every((file) => file.role !== "test")).toBe(true);
    expect(result.files.some((file) => file.contents.includes("@jest/globals"))).toBe(false);
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

/**
 * A binding is verified against the core wherever the caller keeps it (FR-018).
 *
 * Verification writes the regenerated core at the path the specifier resolves to, which for a while meant
 * a specifier that climbed was refused: from a bundle placed at the root, `../lib/core.js` resolves above
 * the root, where nothing may be written. What that cost was the ordinary layout — a binding in
 * `src/orders` reaching a core in `src/lib` has no other specifier to write — so the bundle is now placed
 * as deep as the specifier climbs and the climb resolves inside the root.
 *
 * Each case is a different route through placement, and each has to end in a bundle rather than a
 * refusal: generation only returns when the binding compiled against the core and its suite ran.
 */
describe("a binding verified against a core the caller already has", () => {
  it.each(["./lib/core.js", "../lib/core.js", "../../lib/core.js", "@acme/core"])(
    "compiles against a core at %s",
    async (coreModule) => {
      const result = await generate({
        pattern: "repository",
        identifiers: { entity: "Order" },
        options: { emitScope: "binding-only", coreModule },
      });

      if (result.kind !== "bundle") throw new Error("expected a bundle");
      expect(result.verification.diagnosticCount).toBe(0);
      // The specifier the caller gave, in the bytes they receive: placement is a verification device and
      // must not reach the output, or the binding would import a path only the sandbox had.
      expect(result.files.some((file) => file.contents.includes(`"${coreModule}"`))).toBe(true);
      expect(result.files.every((file) => !file.path.startsWith("level1/"))).toBe(true);
    },
    120_000,
  );

  it.each(["./a/../b/core.js", "../../../../../lib/core.js", "..", "node:fs"])(
    "refuses %s, which is not a layout",
    async (coreModule) => {
      await expect(
        generate({
          pattern: "repository",
          identifiers: { entity: "Order" },
          options: { emitScope: "binding-only", coreModule },
        }),
      ).rejects.toThrow(InvalidOptionValueError);
    },
  );
});
