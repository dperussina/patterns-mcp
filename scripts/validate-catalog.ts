/**
 * Validates the catalogue under `data/patterns/`. Wired into `pnpm check` as
 * `pnpm catalog:check`.
 *
 * Most of what this task originally specified is now enforced upstream and
 * inherited here rather than re-implemented, which is deliberate — a rule
 * checked in two places is a rule that can disagree with itself:
 *
 * - Licence terms, `provenance` presence, and the advisory invariants are
 *   structural in `PatternSchema`, so parsing enforces them.
 * - Cross-shard name uniqueness and `relatedPatterns` resolution live in
 *   `buildCatalog`, because both need every shard merged first.
 *
 * What is genuinely this script's own is the file-name convention: relating a
 * shard's name to the categories its entries declare. No per-document schema
 * can see that, since it spans a file's name and its contents.
 *
 * An empty catalogue passes. Shards are authored incrementally (T012 onward),
 * and a minimum-count assertion here would hold the gate red for a reason
 * unrelated to correctness. The tier-1 count is asserted by the task that
 * completes the tier, where the assertion can actually be satisfied.
 */
import {
  CatalogError,
  buildCatalog,
  checkShardCategoryNaming,
  readShards,
} from "../src/engine/catalog/load.js";

async function main(): Promise<number> {
  const shards = await readShards();

  const problems: string[] = [];
  let patternCount = 0;

  try {
    patternCount = buildCatalog(shards).patterns.length;
  } catch (error) {
    if (!(error instanceof CatalogError)) {
      throw error;
    }
    problems.push(...error.problems);
  }

  problems.push(...checkShardCategoryNaming(shards));

  if (problems.length > 0) {
    process.stderr.write(
      `Catalog validation failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `Catalog OK: ${patternCount} pattern(s) across ${shards.length} shard(s).\n`,
  );
  return 0;
}

process.exitCode = await main();
