import { readFile, readdir } from "node:fs/promises";

import { dataPath } from "../data-root.js";

import { CATEGORIES, CatalogShardSchema, type Pattern } from "./schema.js";

/** One shard as read from disk, paired with where it came from for error reporting. */
export interface ShardSource {
  /** Identifies the shard in diagnostics, e.g. `type-safety.json`. */
  readonly source: string;
  readonly contents: unknown;
}

export interface Catalog {
  /** Every pattern, ordered by `name`. Iteration order is part of the contract. */
  readonly patterns: readonly Pattern[];
  get(name: string): Pattern | undefined;
  has(name: string): boolean;
}

/**
 * Raised with every problem found, not just the first. A catalogue author fixing
 * hand-authored shards should see the whole list in one pass; failing fast on
 * problem one turns a single review into a sequence of them.
 */
export class CatalogError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Catalog is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CatalogError";
    this.problems = problems;
  }
}

/** The shipped catalogue. Resolved on use rather than at import, so `dataRoot` can throw at a caller. */
function defaultDirectory(): string {
  return dataPath("patterns");
}

/**
 * Validates and merges shards into a single catalogue.
 *
 * Pure: takes already-read contents rather than paths, so the merge rules can be
 * exercised without fixtures on disk and so the only I/O in this module sits in
 * `loadCatalog`.
 */
export function buildCatalog(shards: readonly ShardSource[]): Catalog {
  const problems: string[] = [];
  const byName = new Map<string, Pattern>();
  const originOf = new Map<string, string>();

  // Shards are visited in a caller-supplied order that `loadCatalog` sorts, so
  // duplicate-detection reports the same "first definition" every run.
  for (const { source, contents } of shards) {
    const parsed = CatalogShardSchema.safeParse(contents);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        problems.push(`${source}: ${path}: ${issue.message}`);
      }
      continue;
    }

    for (const pattern of parsed.data.patterns) {
      const existing = originOf.get(pattern.name);
      if (existing !== undefined) {
        problems.push(
          `duplicate pattern name "${pattern.name}" in ${source}; already defined in ${existing}`,
        );
        continue;
      }
      originOf.set(pattern.name, source);
      byName.set(pattern.name, pattern);
    }
  }

  // `relatedPatterns` is a closed reference set, so it can only be checked once
  // every shard has been merged — a relation may legitimately cross categories.
  for (const [name, pattern] of [...byName].toSorted(([a], [b]) =>
    compareNames(a, b),
  )) {
    for (const related of pattern.relatedPatterns) {
      if (!byName.has(related)) {
        problems.push(
          `${originOf.get(name) ?? "unknown shard"}: pattern "${name}" relates to ` +
            `"${related}", which is not defined in any shard`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new CatalogError(problems);
  }

  const patterns = [...byName.values()].toSorted((a, b) =>
    compareNames(a.name, b.name),
  );
  const ordered = new Map(patterns.map((p) => [p.name, p] as const));

  return {
    patterns,
    get: (name) => ordered.get(name),
    has: (name) => ordered.has(name),
  };
}

/**
 * Reads every `*.json` shard from `directory` and merges it.
 *
 * File names are sorted before reading. `readdir` order is filesystem-dependent,
 * and an unordered traversal would let duplicate-name diagnostics — and any
 * future order-sensitive merge rule — differ between machines.
 */
export async function loadCatalog(directory?: string): Promise<Catalog> {
  return buildCatalog(await readShards(directory));
}

/**
 * Reads shards without merging them, for callers that need the per-shard view —
 * the catalogue validator checks each file name against the categories its own
 * entries declare, which is only answerable before the merge flattens them.
 */
export async function readShards(directory?: string): Promise<ShardSource[]> {
  const resolved = directory ?? defaultDirectory();
  const entries = await readdir(resolved);
  const shardFiles = entries
    .filter((entry) => entry.endsWith(".json"))
    .toSorted(compareNames);

  const shards: ShardSource[] = [];
  for (const file of shardFiles) {
    const raw = await readFile(
      new URL(file, pathToDirectoryUrl(resolved)),
      "utf8",
    );
    shards.push({ source: file, contents: parseJson(file, raw) });
  }

  return shards;
}

/**
 * Checks the `data/patterns/{category}.json` naming convention: a shard's file
 * name must be a known category, and every entry in it must declare that
 * category.
 *
 * This lives outside the schema because it relates a file's name to its
 * contents, which no per-document schema can see. Left unchecked, a pattern
 * filed under the wrong shard still validates, and the category a caller
 * filters on silently disagrees with where the entry actually lives.
 *
 * Shards that fail schema validation are skipped rather than reported twice;
 * `buildCatalog` is the authority on those.
 */
export function checkShardCategoryNaming(
  shards: readonly ShardSource[],
): string[] {
  const problems: string[] = [];

  for (const { source, contents } of shards) {
    const parsed = CatalogShardSchema.safeParse(contents);
    if (!parsed.success) {
      continue;
    }

    const stem = source.replace(/\.json$/, "");
    if (!(CATEGORIES as readonly string[]).includes(stem)) {
      problems.push(
        `${source}: file name is not a known category; expected one of ${CATEGORIES.join(", ")}`,
      );
      continue;
    }

    for (const pattern of parsed.data.patterns) {
      if (pattern.category !== stem) {
        problems.push(
          `${source}: pattern "${pattern.name}" declares category "${pattern.category}" ` +
            `but is filed under "${stem}"`,
        );
      }
    }
  }

  return problems;
}

function parseJson(source: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new CatalogError([
      `${source}: not valid JSON: ${cause instanceof Error ? cause.message : "unknown error"}`,
    ]);
  }
}

function pathToDirectoryUrl(directory: string): URL {
  const url = new URL(`file://${directory}`);
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

/**
 * Code-unit comparison, pinned rather than locale-aware. `localeCompare` varies
 * with ICU data and environment, which would make catalogue ordering — and so
 * generated output that iterates it — a function of the host.
 */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
