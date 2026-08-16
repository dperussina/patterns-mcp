import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CatalogError,
  buildCatalog,
  checkShardCategoryNaming,
  loadCatalog,
  type ShardSource,
} from "../../src/engine/catalog/load.js";

function pattern(name: string, relatedPatterns: string[] = []): unknown {
  return {
    name,
    title: name,
    category: "type-safety",
    kind: "generative",
    intent: `Intent for ${name}.`,
    supportsSplit: false,
    variants: [],
    identifiers: [],
    // Every generative pattern must declare this (data-model.md §"Shared base options"), so even a
    // fixture that cares only about names and relations has to carry it.
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
    relatedPatterns,
    provenance: "original",
    license: "original",
    tier: 1,
  };
}

function shard(source: string, patterns: unknown[]): ShardSource {
  return { source, contents: { patterns } };
}

describe("buildCatalog", () => {
  it("merges shards and orders patterns by name", () => {
    const catalog = buildCatalog([
      shard("structural.json", [pattern("zebra"), pattern("adapter")]),
      shard("type-safety.json", [pattern("mango")]),
    ]);

    expect(catalog.patterns.map((p) => p.name)).toEqual([
      "adapter",
      "mango",
      "zebra",
    ]);
  });

  it("orders hyphens and digits by code unit, pinning the one ordering callers see", () => {
    const catalog = buildCatalog([
      shard("a.json", [
        pattern("zip2"),
        pattern("zipcode"),
        pattern("zip-code"),
        pattern("zip"),
      ]),
    ]);
    // "-" (U+002D) precedes digits, which precede letters.
    expect(catalog.patterns.map((p) => p.name)).toEqual([
      "zip",
      "zip-code",
      "zip2",
      "zipcode",
    ]);
  });

  it("resolves patterns by name", () => {
    const catalog = buildCatalog([shard("a.json", [pattern("result-type")])]);
    expect(catalog.get("result-type")?.name).toBe("result-type");
    expect(catalog.has("result-type")).toBe(true);
    expect(catalog.get("absent")).toBeUndefined();
    expect(catalog.has("absent")).toBe(false);
  });

  it("accepts an empty catalog, since shards are authored incrementally", () => {
    expect(buildCatalog([]).patterns).toEqual([]);
  });

  it("rejects a duplicate name across shards, naming both shards", () => {
    let error: unknown;
    try {
      buildCatalog([
        shard("a.json", [pattern("result-type")]),
        shard("b.json", [pattern("result-type")]),
      ]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).problems).toEqual([
      'duplicate pattern name "result-type" in b.json; already defined in a.json',
    ]);
  });

  it("rejects a duplicate name within a single shard", () => {
    expect(() =>
      buildCatalog([
        shard("a.json", [pattern("result-type"), pattern("result-type")]),
      ]),
    ).toThrow(CatalogError);
  });

  it("rejects a relation that resolves to nothing", () => {
    let error: unknown;
    try {
      buildCatalog([
        shard("a.json", [pattern("result-type", ["absent-pattern"])]),
      ]);
    } catch (caught) {
      error = caught;
    }

    expect((error as CatalogError).problems).toEqual([
      'a.json: pattern "result-type" relates to "absent-pattern", which is not defined in any shard',
    ]);
  });

  it("accepts a relation that crosses shards, which is why relations resolve after merging", () => {
    const catalog = buildCatalog([
      shard("structural.json", [pattern("adapter", ["result-type"])]),
      shard("type-safety.json", [pattern("result-type")]),
    ]);

    expect(catalog.patterns).toHaveLength(2);
  });

  it("reports every problem in one pass rather than only the first", () => {
    let error: unknown;
    try {
      buildCatalog([
        shard("a.json", [
          pattern("one", ["missing-a"]),
          pattern("two", ["missing-b"]),
        ]),
      ]);
    } catch (caught) {
      error = caught;
    }

    expect((error as CatalogError).problems).toHaveLength(2);
  });

  it("reports problems in a stable order across runs", () => {
    const build = (): readonly string[] => {
      try {
        buildCatalog([
          shard("a.json", [
            pattern("two", ["missing-b"]),
            pattern("one", ["missing-a"]),
          ]),
        ]);
      } catch (caught) {
        return (caught as CatalogError).problems;
      }
      throw new Error("expected buildCatalog to reject");
    };

    expect(build()).toEqual(build());
    expect(build()[0]).toContain('"one"');
  });

  it("attributes a schema failure to the shard it came from", () => {
    let error: unknown;
    try {
      buildCatalog([
        shard("broken.json", [{ ...(pattern("ok") as object), tier: 9 }]),
      ]);
    } catch (caught) {
      error = caught;
    }

    const problems = (error as CatalogError).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.json");
    expect(problems[0]).toContain("patterns.0");
  });

  it("continues past a malformed shard so other shards are still reported on", () => {
    let error: unknown;
    try {
      buildCatalog([
        shard("broken.json", [{ nonsense: true }]),
        shard("also-broken.json", [pattern("x", ["missing"])]),
      ]);
    } catch (caught) {
      error = caught;
    }

    const problems = (error as CatalogError).problems.join("\n");
    expect(problems).toContain("broken.json");
    expect(problems).toContain("also-broken.json");
  });
});

async function directoryWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "patterns-catalog-"));
  for (const [name, contents] of Object.entries(files).toSorted(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    await writeFile(join(dir, name), contents, "utf8");
  }
  return dir;
}

describe("checkShardCategoryNaming", () => {
  it("accepts entries filed under the shard named for their category", () => {
    expect(
      checkShardCategoryNaming([
        shard("type-safety.json", [pattern("result-type")]),
      ]),
    ).toEqual([]);
  });

  it("rejects an entry whose declared category disagrees with its file", () => {
    const problems = checkShardCategoryNaming([
      shard("structural.json", [pattern("result-type")]),
    ]);
    expect(problems).toEqual([
      'structural.json: pattern "result-type" declares category "type-safety" ' +
        'but is filed under "structural"',
    ]);
  });

  it("rejects a shard whose file name is not a known category", () => {
    const problems = checkShardCategoryNaming([
      shard("misc.json", [pattern("result-type")]),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not a known category");
  });

  it("leaves schema-invalid shards to buildCatalog rather than reporting them twice", () => {
    expect(
      checkShardCategoryNaming([
        shard("type-safety.json", [{ nonsense: true }]),
      ]),
    ).toEqual([]);
  });

  it("accepts a shard that references the published schema", () => {
    const withRef: ShardSource = {
      source: "type-safety.json",
      contents: {
        $schema: "../schema.json",
        patterns: [pattern("result-type")],
      },
    };
    expect(checkShardCategoryNaming([withRef])).toEqual([]);
    expect(buildCatalog([withRef]).patterns).toHaveLength(1);
  });
});

describe("loadCatalog", () => {
  it("reads and merges every shard in a directory", async () => {
    const dir = await directoryWith({
      "structural.json": JSON.stringify({ patterns: [pattern("adapter")] }),
      "type-safety.json": JSON.stringify({
        patterns: [pattern("result-type")],
      }),
    });

    const catalog = await loadCatalog(dir);
    expect(catalog.patterns.map((p) => p.name)).toEqual([
      "adapter",
      "result-type",
    ]);
  });

  it("ignores non-JSON files, so notes and fixtures can live beside shards", async () => {
    const dir = await directoryWith({
      "type-safety.json": JSON.stringify({
        patterns: [pattern("result-type")],
      }),
      "README.md": "# notes",
    });

    const catalog = await loadCatalog(dir);
    expect(catalog.patterns.map((p) => p.name)).toEqual(["result-type"]);
  });

  it("attributes malformed JSON to its file", async () => {
    const dir = await directoryWith({ "broken.json": "{ not json" });

    await expect(loadCatalog(dir)).rejects.toThrow(
      /broken\.json: not valid JSON/,
    );
  });

  it("returns an empty catalog for a directory with no shards yet", async () => {
    const catalog = await loadCatalog(await directoryWith({}));
    expect(catalog.patterns).toEqual([]);
  });

  /**
   * The shipped catalogue, with no directory supplied.
   *
   * This is the call every real request makes, and the one that was broken in the published package
   * while every test here passed: the location was a fixed relative path from this module, correct in
   * the source tree and three levels too high once bundling flattened it. Asserting the default
   * resolves — and finds actual patterns — is what makes that a test failure rather than a discovery
   * made by running the built binary.
   */
  it("finds the shipped catalogue when no directory is given", async () => {
    const catalog = await loadCatalog();
    expect(catalog.patterns.length).toBeGreaterThan(0);
    expect(catalog.patterns.map((entry) => entry.name)).toContain("result");
  });

  it("reports duplicates against the alphabetically first shard, not the first one readdir returns", async () => {
    const duplicate = JSON.stringify({ patterns: [pattern("result-type")] });
    // Written in reverse order on purpose: if readdir order leaked through, the
    // attribution below would flip depending on the filesystem.
    const dir = await directoryWith({
      "z-late.json": duplicate,
      "a-early.json": duplicate,
    });

    await expect(loadCatalog(dir)).rejects.toThrow(
      /duplicate pattern name "result-type" in z-late\.json; already defined in a-early\.json/,
    );
  });
});
