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
 * What is genuinely this script's own are the two rules that span a file and
 * something outside it, which no per-document schema can see: the shard
 * file-name convention, relating a shard's name to the categories its entries
 * declare, and the LICENSE file's claim about the catalogue (SC-012).
 *
 * An empty catalogue passes. Shards are authored incrementally (T012 onward),
 * and a minimum-count assertion here would hold the gate red for a reason
 * unrelated to correctness. The tier-1 count is asserted by the task that
 * completes the tier, where the assertion can actually be satisfied.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CatalogError,
  buildCatalog,
  checkShardCategoryNaming,
  readShards,
} from "../src/engine/catalog/load.js";

import type { Catalog } from "../src/engine/catalog/load.js";

/**
 * The sentence in LICENSE that the catalogue has to keep true.
 *
 * It is quoted rather than paraphrased so that rewording the licence breaks this check, which is the
 * point: the check exists to stop the two drifting, and it cannot tell that a reworded sentence still
 * makes the same promise.
 */
const ORIGINALITY_CLAIM =
  "Every pattern in this catalogue is an original implementation.";

async function main(): Promise<number> {
  const shards = await readShards();

  const problems: string[] = [];
  let patternCount = 0;

  try {
    const catalog = buildCatalog(shards);
    patternCount = catalog.patterns.length;
    problems.push(...(await checkLicenseClaim(catalog)));
    problems.push(...(await checkReadmeCounts(catalog)));
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

/**
 * Keeps LICENSE and the catalogue from contradicting each other.
 *
 * The licence tells a reader that nothing the generator emits carries a third-party condition, which is
 * only true while every entry is our own work. A borrowed implementation would be a perfectly ordinary
 * thing to add — the schema's licence allowlist exists to permit it — and it would silently falsify a
 * sentence in the one file a lawyer reads. Nothing else can catch that, since each artefact is
 * internally consistent; only the pair is wrong.
 */
async function checkLicenseClaim(catalog: Catalog): Promise<string[]> {
  const path = join(import.meta.dirname, "..", "LICENSE");

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [
      `LICENSE is missing, though package.json declares one; npm would publish the ` +
        `declaration without the terms it refers to`,
    ];
  }

  const problems: string[] = [];

  if (!text.includes(ORIGINALITY_CLAIM)) {
    problems.push(
      `LICENSE no longer contains the sentence "${ORIGINALITY_CLAIM}", which this script checks ` +
        `the catalogue against; restore it, or point ORIGINALITY_CLAIM in ` +
        `scripts/validate-catalog.ts at the wording that replaced it`,
    );
  }

  const borrowed = catalog.patterns.filter(
    (pattern) => pattern.license !== "original",
  );

  if (borrowed.length > 0) {
    const named = borrowed
      .map((pattern) => `${pattern.name} (${pattern.license})`)
      .join(", ");
    problems.push(
      `LICENSE states that every pattern is an original implementation, but these entries ` +
        `carry third-party terms: ${named}. Either the entry's licence field is wrong, or the ` +
        `licence needs a paragraph saying which emitted files carry a condition`,
    );
  }

  return problems;
}

/**
 * Keeps the README's counts honest.
 *
 * It is the page npm shows, and a wrong number there is the first thing a reader can check and the
 * last thing anyone remembers to update. Nothing else notices: adding a shard entry is a complete,
 * coherent change on its own.
 *
 * Two numbers rather than one, because the kinds are not interchangeable. A total of 33 would be
 * arithmetically true and would still mislead, since seven of those entries return advice and no code —
 * a reader who came for generators and counted them would find six missing. Stating both means the page
 * cannot be accurate about the total while being wrong about what arrives.
 */
async function checkReadmeCounts(catalog: Catalog): Promise<string[]> {
  const generative = catalog.patterns.filter((p) => p.kind === "generative").length;
  const advisory = catalog.patterns.length - generative;

  const claims = [
    `${generative} patterns`,
    `${advisory} advisory`,
  ];

  const readme = await readFile(join(import.meta.dirname, "..", "README.md"), "utf8");

  return claims
    .filter((claim) => !readme.includes(claim))
    .map(
      (claim) =>
        `README does not say "${claim}"; the catalogue holds ${generative} generative and ` +
        `${advisory} advisory entries, and the numbers on the page a reader sees first have to be those`,
    );
}

process.exitCode = await main();
