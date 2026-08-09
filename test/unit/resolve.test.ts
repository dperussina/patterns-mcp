import { describe, expect, it } from "vitest";

import {
  InvalidIdentifierError,
  InvalidOptionValueError,
  MissingRequiredOptionError,
  UnknownOptionError,
} from "../../src/engine/errors.js";
import { resolveOptions } from "../../src/engine/options/resolve.js";
import {
  PatternSchema,
  type GenerativePattern,
} from "../../src/engine/catalog/schema.js";

function makePattern(
  overrides: Record<string, unknown> = {},
): GenerativePattern {
  const parsed = PatternSchema.parse({
    name: "result-type",
    title: "Result Type",
    category: "type-safety",
    kind: "generative",
    intent: "Model failure as a value.",
    supportsSplit: true,
    variants: ["tagged", "nested"],
    options: [
      {
        name: "emitScope",
        type: "enum",
        values: ["full", "core-only", "binding-only"],
        default: "full",
        description: "Which part of the bundle to emit.",
        affects: ["files"],
      },
      {
        name: "coreModule",
        type: "string",
        default: "",
        description: "Specifier of the already-emitted core module.",
        affects: ["imports"],
      },
      {
        name: "includeTests",
        type: "boolean",
        default: true,
        description: "Whether to emit tests.",
        affects: ["tests"],
      },
      {
        name: "retries",
        type: "integer",
        default: 3,
        description: "How many times to retry.",
        affects: ["core"],
      },
    ],
    legality: [],
    relatedPatterns: [],
    provenance: "original",
    license: "original",
    tier: 1,
    ...overrides,
  });

  if (parsed.kind !== "generative") {
    throw new Error("expected a generative pattern");
  }
  return parsed;
}

const pattern = makePattern();

describe("defaults", () => {
  it("returns a complete option set from an empty request", () => {
    expect(resolveOptions(pattern).options).toEqual({
      coreModule: "",
      emitScope: "full",
      includeTests: true,
      retries: 3,
    });
  });

  it("keeps supplied values and defaults the rest", () => {
    const resolved = resolveOptions(pattern, {
      options: { includeTests: false },
    });
    expect(resolved.options.includeTests).toBe(false);
    expect(resolved.options.emitScope).toBe("full");
  });

  it("resolves conventions completely, even when none are supplied", () => {
    expect(resolveOptions(pattern).conventions.strictness).toBe("strict");
    expect(
      resolveOptions(pattern, { conventions: { moduleStyle: "cjs" } })
        .conventions,
    ).toMatchObject({ moduleStyle: "cjs", strictness: "strict" });
  });

  it("echoes the pattern name it resolved against", () => {
    expect(resolveOptions(pattern).pattern).toBe("result-type");
  });
});

describe("key order normalisation", () => {
  it("produces sorted keys regardless of the order the caller wrote them", () => {
    const a = resolveOptions(pattern, {
      options: { retries: 1, emitScope: "full" },
    });
    const b = resolveOptions(pattern, {
      options: { emitScope: "full", retries: 1 },
    });

    expect(Object.keys(a.options)).toEqual([
      "coreModule",
      "emitScope",
      "includeTests",
      "retries",
    ]);
    expect(Object.keys(a.options)).toEqual(Object.keys(b.options));
    // The serialisation behind optionsHash depends on this, so the two requests
    // must be indistinguishable, not merely equal field by field.
    expect(JSON.stringify(a.options)).toBe(JSON.stringify(b.options));
  });

  it("sorts identifier keys too", () => {
    const resolved = resolveOptions(pattern, {
      identifiers: { zebra: "Zebra", alpha: "Alpha" },
    });
    expect(Object.keys(resolved.identifiers)).toEqual(["alpha", "zebra"]);
  });
});

describe("unknown options", () => {
  it("rejects an unknown option rather than ignoring it", () => {
    expect(() => resolveOptions(pattern, { options: { nope: 1 } })).toThrow(
      UnknownOptionError,
    );
  });

  it("lists the declared options so the caller can correct without another call", () => {
    try {
      resolveOptions(pattern, { options: { erorMode: 1 } });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as UnknownOptionError).message).toContain(
        "coreModule, includeTests, retries",
      );
    }
  });

  it("reports the same unknown option first regardless of key order", () => {
    const first = () =>
      resolveOptions(pattern, { options: { zzz: 1, aaa: 2 } });
    const second = () =>
      resolveOptions(pattern, { options: { aaa: 2, zzz: 1 } });

    expect(first).toThrow(/"aaa"/);
    expect(second).toThrow(/"aaa"/);
  });
});

describe("value spaces", () => {
  it("rejects a value outside an enum and lists the permitted ones", () => {
    expect(() =>
      resolveOptions(pattern, { options: { emitScope: "partial" } }),
    ).toThrow(/Permitted values: full, core-only, binding-only/);
  });

  it.each([
    ["includeTests", "yes"],
    ["retries", "3"],
    ["retries", 1.5],
    ["coreModule", 42],
    ["emitScope", true],
  ])("rejects %s given a value of the wrong type", (option, value) => {
    expect(() =>
      resolveOptions(pattern, { options: { [option]: value } }),
    ).toThrow(InvalidOptionValueError);
  });

  it("accepts a valid value of each declared type", () => {
    const resolved = resolveOptions(pattern, {
      options: {
        emitScope: "core-only",
        includeTests: false,
        retries: 0,
        coreModule: "./core.js",
      },
    });
    expect(resolved.options).toEqual({
      coreModule: "./core.js",
      emitScope: "core-only",
      includeTests: false,
      retries: 0,
    });
  });

  it("reports the offending option in the pattern's declared order, not the caller's", () => {
    // emitScope is declared before retries, so it is the one reported even
    // though the caller wrote retries first.
    expect(() =>
      resolveOptions(pattern, {
        options: { retries: "bad", emitScope: "bad" },
      }),
    ).toThrow(/"emitScope"/);
  });
});

describe("variant", () => {
  it("accepts a declared variant", () => {
    expect(resolveOptions(pattern, { variant: "tagged" }).variant).toBe(
      "tagged",
    );
  });

  it("is absent when not requested", () => {
    expect(resolveOptions(pattern).variant).toBeUndefined();
  });

  it("refuses an undeclared variant and lists the declared ones", () => {
    expect(() => resolveOptions(pattern, { variant: "flat" })).toThrow(
      /Option "variant" does not accept "flat"\. Permitted values: tagged, nested\./,
    );
  });

  it("refuses any variant when the pattern declares none", () => {
    const noVariants = makePattern({ variants: [] });
    expect(() => resolveOptions(noVariants, { variant: "tagged" })).toThrow(
      InvalidOptionValueError,
    );
  });
});

describe("identifiers", () => {
  it("accepts valid identifiers and echoes them", () => {
    expect(
      resolveOptions(pattern, { identifiers: { entityName: "Person" } })
        .identifiers,
    ).toEqual({
      entityName: "Person",
    });
  });

  it("refuses a reserved word, naming the field", () => {
    try {
      resolveOptions(pattern, { identifiers: { entityName: "class" } });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidIdentifierError);
      expect((error as InvalidIdentifierError).field).toBe("entityName");
      expect((error as InvalidIdentifierError).message).toContain(
        'entityName "class"',
      );
    }
  });

  it("refuses a path traversal attempt", () => {
    expect(() =>
      resolveOptions(pattern, {
        identifiers: { entityName: "../../etc/passwd" },
      }),
    ).toThrow(InvalidIdentifierError);
  });
});

describe("coreModule dependency", () => {
  it("requires coreModule once emitScope is binding-only", () => {
    expect(() =>
      resolveOptions(pattern, { options: { emitScope: "binding-only" } }),
    ).toThrow(MissingRequiredOptionError);
  });

  it("says why it is required", () => {
    expect(() =>
      resolveOptions(pattern, { options: { emitScope: "binding-only" } }),
    ).toThrow(/required when emitScope is "binding-only"/);
  });

  it("rejects whitespace as a supplied specifier", () => {
    expect(() =>
      resolveOptions(pattern, {
        options: { emitScope: "binding-only", coreModule: "   " },
      }),
    ).toThrow(MissingRequiredOptionError);
  });

  it("accepts a supplied specifier", () => {
    const resolved = resolveOptions(pattern, {
      options: { emitScope: "binding-only", coreModule: "./core.js" },
    });
    expect(resolved.options.coreModule).toBe("./core.js");
  });

  it("does not require coreModule for other scopes", () => {
    expect(
      resolveOptions(pattern, { options: { emitScope: "full" } }).options
        .coreModule,
    ).toBe("");
  });
});

describe("validation order", () => {
  // Each case breaks two rules at once. The rule that wins is fixed by
  // data-model.md, because a caller fixing one complaint must not see it change.
  it("reports an unknown option before a bad value", () => {
    expect(() =>
      resolveOptions(pattern, { options: { unknownOne: 1, emitScope: "bad" } }),
    ).toThrow(UnknownOptionError);
  });

  it("reports a bad option value before an undeclared variant", () => {
    expect(() =>
      resolveOptions(pattern, {
        options: { emitScope: "bad" },
        variant: "flat",
      }),
    ).toThrow(/"emitScope"/);
  });

  it("reports an undeclared variant before a bad identifier", () => {
    expect(() =>
      resolveOptions(pattern, {
        variant: "flat",
        identifiers: { entityName: "class" },
      }),
    ).toThrow(/"variant"/);
  });

  it("reports a bad identifier before a missing required option", () => {
    expect(() =>
      resolveOptions(pattern, {
        options: { emitScope: "binding-only" },
        identifiers: { entityName: "class" },
      }),
    ).toThrow(InvalidIdentifierError);
  });
});

describe("immutability", () => {
  it("does not mutate the caller's request", () => {
    const options = { includeTests: false };
    const identifiers = { entityName: "Person" };
    resolveOptions(pattern, { options, identifiers });

    expect(options).toEqual({ includeTests: false });
    expect(identifiers).toEqual({ entityName: "Person" });
  });

  it("returns the same result for the same input", () => {
    const request = {
      options: { retries: 2 },
      identifiers: { entityName: "Person" },
    };
    expect(resolveOptions(pattern, request)).toEqual(
      resolveOptions(pattern, request),
    );
  });
});
