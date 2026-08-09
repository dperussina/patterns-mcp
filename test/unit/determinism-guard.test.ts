/**
 * Principle I says the same request produces byte-identical output forever. That is a property of
 * the whole engine, so it cannot be proved by any one module's tests — it is lost the first time
 * something reachable from generation reads a clock, a random number, an environment variable, or a
 * directory listing, and it is lost silently.
 *
 * Lint catches the three named calls (see the src/engine override in .oxlintrc.json). This file
 * covers what lint cannot: that the guard is still configured at all, that no generation-path module
 * reaches the filesystem, and that nothing in the foundational pipeline depends on the order a
 * caller happened to write their options in.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PatternSchema, type GenerativePattern } from "../../src/engine/catalog/schema.js";
import { DEFAULT_CONVENTIONS } from "../../src/engine/options/conventions.js";
import { deriveNames, loadNameTable } from "../../src/engine/options/names.js";
import { resolveOptions } from "../../src/engine/options/resolve.js";
import { formatSource } from "../../src/engine/format/prettier.js";
import { canonicalize, hashResolvedRequest } from "../../src/engine/provenance/hash.js";

/**
 * Every engine module that participates in producing output. Loading the catalog and the name table
 * is deliberately absent: both read files once, in sorted order, before any request is served, and
 * both have their own tests for that ordering. Verification is absent because spawning a compiler
 * and running tests in a subprocess is its entire purpose.
 */
const GENERATION_PATH = [
  "src/engine/catalog/schema.ts",
  "src/engine/errors.ts",
  "src/engine/format/prettier.ts",
  "src/engine/options/conventions.ts",
  "src/engine/options/identifiers.ts",
  "src/engine/options/legality.ts",
  "src/engine/options/resolve.ts",
  "src/engine/provenance/hash.ts",
  "src/engine/render/helpers.ts",
] as const;

function generative(input: unknown): GenerativePattern {
  const parsed = PatternSchema.parse(input);
  if (parsed.kind !== "generative") {
    throw new Error("expected a generative pattern");
  }
  return parsed;
}

async function source(path: string): Promise<string> {
  return await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** Strips comments, so prose describing a hazard is not mistaken for the hazard. */
function code(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("nondeterministic inputs in the generation path", () => {
  it.each(GENERATION_PATH)("%s reads no clock, randomness, or environment", async (path) => {
    const text = code(await source(path));
    expect(text).not.toMatch(/\bDate\.now\b/);
    expect(text).not.toMatch(/\bnew Date\b/);
    expect(text).not.toMatch(/\bMath\.random\b/);
    expect(text).not.toMatch(/\bperformance\.now\b/);
    expect(text).not.toMatch(/\bprocess\.(env|hrtime|argv|cwd)\b/);
  });

  it.each(GENERATION_PATH)("%s does not reach the filesystem", async (path) => {
    const text = code(await source(path));
    expect(text).not.toMatch(/from "node:fs(\/promises)?"/);
    expect(text).not.toMatch(/\brequire\("node:fs/);
    // Prettier walks upwards for a config file, which would make a consumer's output depend on
    // whichever directory the server was started in.
    expect(text).not.toMatch(/\bresolveConfig\b/);
  });

  it("still restricts those calls in lint, so a new module is caught before review", async () => {
    const config: unknown = JSON.parse(await source(".oxlintrc.json"));
    const text = JSON.stringify(config);
    expect(text).toContain("no-restricted-properties");
    expect(text).toContain("no-restricted-globals");
    expect(text).toContain("Date");
    expect(text).toContain("random");
  });
});

const pattern: GenerativePattern = generative({
  name: "result-type",
  title: "Result Type",
  category: "type-safety",
  kind: "generative",
  intent: "Model failure as a value.",
  // Splits, because the fixture offers an `emitScope` — a pattern may only offer a scope it can
  // actually honour, and an enum option is worth keeping in the hashing tests below.
  supportsSplit: true,
  variants: ["tagged"],
  options: [
    {
      name: "emitScope",
      type: "enum",
      // The full documented space, since a base option may not narrow its own vocabulary.
      values: ["full", "core-only", "binding-only"],
      default: "full",
      description: "Which part of the bundle to emit.",
      affects: ["files"],
    },
    {
      name: "includeTests",
      type: "boolean",
      default: true,
      description: "Emit tests.",
      affects: ["files"],
    },
    {
      name: "maxDepth",
      type: "integer",
      default: 3,
      description: "Nesting depth.",
      affects: ["body"],
    },
  ],
  legality: [],
  relatedPatterns: [],
  provenance: "original",
  license: "original",
  tier: 1,
});

describe("insensitivity to the order a caller writes options in", () => {
  const forwards = {
    options: { emitScope: "core-only", includeTests: false, maxDepth: 7 },
    identifiers: { entity: "Order" },
    conventions: DEFAULT_CONVENTIONS,
    variant: "tagged",
  } as const;

  // The same request with every object literal's keys reversed. JSON.stringify and Object.keys both
  // follow insertion order, so anything that iterates a request without sorting first diverges here.
  const backwards = {
    variant: "tagged",
    conventions: DEFAULT_CONVENTIONS,
    identifiers: { entity: "Order" },
    options: { maxDepth: 7, includeTests: false, emitScope: "core-only" },
  } as const;

  it("resolves to the same options in the same key order", () => {
    const a = resolveOptions(pattern, forwards);
    const b = resolveOptions(pattern, backwards);
    expect(Object.keys(b.options)).toEqual(Object.keys(a.options));
    expect(b).toEqual(a);
  });

  it("canonicalises and hashes to the same bytes", () => {
    const a = resolveOptions(pattern, forwards);
    const b = resolveOptions(pattern, backwards);
    expect(canonicalize(b)).toBe(canonicalize(a));
    expect(hashResolvedRequest(b)).toBe(hashResolvedRequest(a));
  });

  it("hashes partial and defaulted requests identically when they resolve alike", () => {
    // Omitting an option that defaults to the supplied value must not change the hash, or a caller
    // gets a different provenance line for a request that produced the same bytes.
    const explicit = resolveOptions(pattern, {
      options: { emitScope: "full", includeTests: true, maxDepth: 3 },
      identifiers: { entity: "Order" },
    });
    const defaulted = resolveOptions(pattern, { identifiers: { entity: "Order" } });
    expect(hashResolvedRequest(defaulted)).toBe(hashResolvedRequest(explicit));
  });
});

describe("repeating the foundational pipeline", () => {
  it("gives identical results across independent runs", async () => {
    const table = await loadNameTable();

    const run = async (): Promise<string> => {
      const resolved = resolveOptions(pattern, {
        options: { emitScope: "full", maxDepth: 4 },
        identifiers: { entity: "Category" },
        variant: "tagged",
      });
      const names = deriveNames(resolved.identifiers.entity ?? "", table);
      if (!names.ok) throw new Error(names.problem);
      const formatted = await formatSource(
        `export interface ${names.names.pascal}   { id : string }\n` +
          `export const all: ${names.names.pascal}[] = [];\n`,
      );
      return [hashResolvedRequest(resolved), names.names.plural, formatted].join("\n");
    };

    const first = await run();
    for (let i = 0; i < 3; i++) {
      expect(await run()).toBe(first);
    }
  });
});
