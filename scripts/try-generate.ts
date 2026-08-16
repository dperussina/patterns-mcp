/**
 * Scratch driver: generate one bundle and print it. Not part of `check`.
 *
 * `pnpm exec tsx scripts/try-generate.ts repository '{"emitScope":"core-only"}'`
 *
 * A third argument is the conventions, for checking a pattern under a strictness or a module style the
 * golden snapshots do not cover:
 *
 * `pnpm exec tsx scripts/try-generate.ts builder '{}' '{"strictness":"loose"}'`
 */
import { loadCatalog } from "../src/engine/catalog/load.js";
import { disposeEngine, generate } from "../src/engine/generate/index.js";
import { goldenIdentifiers } from "../test/golden/harness.js";

const name = process.argv[2] ?? "repository";
const options = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;
const conventions = JSON.parse(process.argv[4] ?? "{}") as Record<string, unknown>;

// `entity` only where the pattern declares it, so this driver works for the six that read none
// instead of being refused by them. `ENTITY=Invoice` to generate under a different noun.
const catalog = await loadCatalog();
const pattern = catalog.patterns.find((candidate) => candidate.name === name);
if (pattern === undefined || pattern.kind !== "generative") {
  throw new Error(`no generative pattern named "${name}"`);
}
const identifiers = Object.fromEntries(
  Object.keys(goldenIdentifiers(pattern)).map((role) => [role, process.env["ENTITY"] ?? "Order"]),
);

try {
  const bundle = await generate({ pattern: name, identifiers, options, conventions });
  // Unreachable: the entry was checked for `generative` above. Narrowing rather than asserting, so that
  // this driver keeps compiling if the union grows a third case.
  if (bundle.kind !== "bundle") throw new Error(`"${name}" is advisory: ${bundle.alternative}`);

  for (const file of bundle.files) {
    process.stdout.write(`\n${"=".repeat(90)}\n${file.path}  [${file.role}]\n${"=".repeat(90)}\n`);
    process.stdout.write(file.contents);
  }

  if (bundle.notes.length > 0) {
    process.stdout.write(`\nNOTES\n${bundle.notes.map((n) => `- ${n}`).join("\n")}\n`);
  }
  process.stdout.write(`\n${JSON.stringify(bundle.verification, null, 2)}\n`);
} finally {
  // Without this the warm compiler subprocess keeps this process alive after the output is written,
  // which reads as a hang and leaves an orphaned `tsc --api` behind when it is killed (T028).
  await disposeEngine();
}
