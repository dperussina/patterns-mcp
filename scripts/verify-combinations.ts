/**
 * Scratch driver: verify every documented combination of one pattern, and report which fail.
 *
 * `pnpm exec tsx scripts/verify-combinations.ts discriminated-union`
 *
 * The golden suite already generates every combination, so this looks redundant and is not. A golden test
 * fails on any change to the output, so it cannot distinguish "the pattern stopped compiling" from "the
 * stored bytes moved" — which makes it the wrong instrument for mutation testing, where the whole question
 * is whether an assertion inside the bundle fired. This reports the verification outcome and nothing else.
 *
 * A second argument overrides the conventions, for checking a strictness the goldens do not cover:
 *
 * `pnpm exec tsx scripts/verify-combinations.ts branded-type '{"strictness":"loose"}'`
 */
import { loadCatalog } from "../src/engine/catalog/load.js";
import { disposeEngine, generate } from "../src/engine/generate/index.js";
import {
  documentedCombinations,
  goldenIdentifiers,
  splitCombinations,
} from "../test/golden/harness.js";

const name = process.argv[2];
if (name === undefined) {
  throw new Error("usage: verify-combinations.ts <pattern> [conventionsJson]");
}
const conventions = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;

const catalog = await loadCatalog();
const pattern = catalog.patterns.find((candidate) => candidate.name === name);
if (pattern === undefined || pattern.kind !== "generative") {
  throw new Error(`no generative pattern named "${name}"`);
}

const combinations = [...documentedCombinations(pattern), ...splitCombinations(pattern)];
let failures = 0;

try {
  for (const combination of combinations) {
    const label = Object.entries(combination)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(",");

    try {
      await generate({
        pattern: name,
        identifiers: goldenIdentifiers(pattern),
        options: combination,
        conventions,
      });
      console.log(`PASS  ${label}`);
    } catch (error) {
      failures += 1;
      const failed = error as { message?: string; diagnostics?: readonly string[]; stage?: string };
      console.log(`FAIL  ${label}  [${failed.stage ?? "?"}]`);
      for (const detail of failed.diagnostics ?? [failed.message ?? String(error)]) {
        console.log(`      ${detail}`);
      }
    }
  }
} finally {
  await disposeEngine();
}

console.log(
  failures === 0
    ? `\nall ${String(combinations.length)} combinations verified`
    : `\n${String(failures)} of ${String(combinations.length)} failed`,
);
