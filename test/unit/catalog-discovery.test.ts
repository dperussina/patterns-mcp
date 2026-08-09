/**
 * `listPatterns` and `describePattern`, against fixtures rather than the shipped catalogue.
 *
 * The contract suites exercise these over the protocol, which is the right level for the promises they
 * make to a caller. What those suites cannot cover is the shape the catalogue does not contain yet: no
 * shipped pattern is advisory, and none has a legality rule. Both branches are reachable by design and
 * would otherwise first be exercised by the release that adds such an entry.
 */

import { describe, expect, it } from "vitest";

import { describePattern } from "../../src/engine/catalog/describe.js";
import { listPatterns } from "../../src/engine/catalog/list.js";
import { buildCatalog } from "../../src/engine/catalog/load.js";
import type { Catalog } from "../../src/engine/catalog/load.js";
import { UnknownPatternError } from "../../src/engine/errors.js";

const RULE = {
  when: { operator: "eq", option: "errorMode", value: "throw" },
  forbids: { option: "emitScope", values: ["binding-only"] },
  rule: "A binding cannot throw when the core it binds to returns a result.",
  alternatives: ["Set errorMode to result", "Request the full bundle instead"],
} as const;

function generative(name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name,
    title: `Title of ${name}`,
    category: "type-safety",
    kind: "generative",
    intent: `Intent for ${name}.`,
    supportsSplit: false,
    variants: [],
    options: [
      {
        name: "includeTests",
        type: "boolean",
        default: true,
        description: "Emit an executable test suite alongside the implementation.",
        affects: ["files"],
      },
    ],
    legality: [],
    relatedPatterns: [],
    provenance: "original",
    license: "original",
    tier: 1,
    ...overrides,
  };
}

function advisory(name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name,
    title: `Title of ${name}`,
    category: "creational",
    kind: "advisory",
    intent: `Intent for ${name}.`,
    advisory: {
      alternative: "a module with exported functions",
      rationale: "A singleton is a global with extra steps in a language that already has modules.",
    },
    relatedPatterns: [],
    provenance: "original",
    license: "original",
    tier: 2,
    ...overrides,
  };
}

function catalogOf(...patterns: unknown[]): Catalog {
  return buildCatalog([{ source: "type-safety.json", contents: { patterns } }]);
}

describe("listPatterns", () => {
  it("returns summary fields only, so browsing does not pay for documentation", () => {
    const catalog = catalogOf(generative("result", { legality: [RULE] }));

    const [summary] = listPatterns(catalog);

    expect(Object.keys(summary ?? {}).toSorted()).toEqual([
      "category",
      "intent",
      "kind",
      "name",
      "supportsSplit",
      "tier",
      "title",
    ]);
  });

  it("reports an advisory pattern as not splitting, rather than omitting the field", () => {
    const catalog = catalogOf(advisory("singleton"));

    const [summary] = listPatterns(catalog);

    expect(summary?.supportsSplit).toBe(false);
    expect(summary?.kind).toBe("advisory");
  });

  it("applies filters conjunctively, and an empty match is not an error", () => {
    const catalog = catalogOf(
      generative("result"),
      generative("brand", { tier: 2 }),
      advisory("singleton"),
    );

    expect(listPatterns(catalog, { kind: "generative" }).map((p) => p.name)).toEqual([
      "brand",
      "result",
    ]);
    expect(listPatterns(catalog, { kind: "generative", tier: 2 }).map((p) => p.name)).toEqual([
      "brand",
    ]);
    expect(listPatterns(catalog, { category: "creational", tier: 1 })).toEqual([]);
  });
});

describe("describePattern", () => {
  it("surfaces legality rules verbatim, including the words a refusal will use", () => {
    const catalog = catalogOf(generative("result", { legality: [RULE] }));

    const described = describePattern(catalog, "result");

    expect(described.legality).toEqual([RULE]);
    expect(described.legality[0]?.rule).toBe(RULE.rule);
    expect(described.legality[0]?.alternatives).toEqual(RULE.alternatives);
  });

  it("describes an advisory pattern with its alternative and empty collections", () => {
    const catalog = catalogOf(advisory("singleton"));

    const described = describePattern(catalog, "singleton");

    expect(described.advisory?.alternative).toBe("a module with exported functions");
    // Iterating these must be safe without first branching on `kind`.
    expect(described.options).toEqual([]);
    expect(described.legality).toEqual([]);
    expect(described.variants).toEqual([]);
    expect(described.supportsSplit).toBe(false);
  });

  it("omits advisory content from a generative pattern rather than emptying it", () => {
    const catalog = catalogOf(generative("result"));

    expect(describePattern(catalog, "result").advisory).toBeUndefined();
  });

  it("names the nearest entries for a typo", () => {
    const catalog = catalogOf(generative("result"), generative("retry", { category: "type-safety" }));

    expect(() => describePattern(catalog, "reslt")).toThrow(UnknownPatternError);

    try {
      describePattern(catalog, "reslt");
      expect.unreachable("describing an unknown pattern must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPatternError);
      expect((error as UnknownPatternError).nearest).toContain("result");
    }
  });

  it("reports the provenance a caller pasting the code has an interest in", () => {
    const catalog = catalogOf(generative("result", { license: "MIT", provenance: "Adapted from X." }));

    const described = describePattern(catalog, "result");

    expect(described.license).toBe("MIT");
    expect(described.provenance).toBe("Adapted from X.");
  });
});
