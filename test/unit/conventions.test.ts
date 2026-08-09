import { describe, expect, it } from "vitest";

import { ConventionsSchema, DEFAULT_CONVENTIONS } from "../../src/engine/options/conventions.js";

describe("ConventionsSchema", () => {
  it("resolves a complete configuration when nothing is supplied", () => {
    expect(DEFAULT_CONVENTIONS).toEqual({
      strictness: "strict",
      moduleStyle: "esm",
      importExtensions: "js",
      typeImports: "separate",
      testFramework: "vitest",
      runtime: "neutral",
      prettierConfig: {},
    });
  });

  it("resolves the same configuration from an empty object as from undefined", () => {
    expect(ConventionsSchema.parse({})).toEqual(DEFAULT_CONVENTIONS);
  });

  it("keeps unsupplied fields at their defaults when some are supplied", () => {
    const resolved = ConventionsSchema.parse({ moduleStyle: "cjs" });
    expect(resolved.moduleStyle).toBe("cjs");
    expect(resolved.strictness).toBe("strict");
    expect(resolved.importExtensions).toBe("js");
  });

  it("rejects an unknown field rather than silently ignoring it", () => {
    expect(ConventionsSchema.safeParse({ strictnes: "strict" }).success).toBe(false);
  });

  it("rejects a value outside a field's enumeration", () => {
    expect(ConventionsSchema.safeParse({ strictness: "very" }).success).toBe(false);
  });
});
