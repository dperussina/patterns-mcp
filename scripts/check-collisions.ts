/**
 * Scratch driver: which paths do two patterns both emit, and do they agree on the bytes?
 *
 * `pnpm exec tsx scripts/check-collisions.ts`
 *
 * A caller unpacks bundles into one directory, so two patterns emitting one path is a silent overwrite
 * unless the bytes match. The conformance suite composes four patterns chosen to collide; this asks the
 * question across all of them, which is how to tell whether that list is a sample or the whole set.
 *
 * Every pattern is generated with the same entity on purpose: sharing a noun is what makes two patterns
 * derive the same file stem, so it is the arrangement most likely to collide rather than a fair one.
 */
import { loadCatalog } from "../src/engine/catalog/load.js";
import { disposeEngine, generate } from "../src/engine/generate/index.js";
import { goldenIdentifiers } from "../test/golden/harness.js";

const catalog = await loadCatalog();
const patterns = catalog.patterns.filter((candidate) => candidate.kind === "generative");

/** For each path: which patterns emitted it, and how many distinct renderings they produced. */
interface Entry {
  readonly patterns: string[];
  /** Rendering to the patterns that produced it, so a conflict can name both sides. */
  readonly contents: Map<string, string[]>;
}

const byPath = new Map<string, Entry>();

try {
  for (const pattern of patterns) {
    const bundle = await generate({
      pattern: pattern.name,
      identifiers: goldenIdentifiers(pattern),
      conventions: { testFramework: "node-test", importExtensions: "ts" },
    });
    // The sweep is over generative entries, so this cannot fire; narrowed rather than cast so a new
    // union case is a compile error here instead of a runtime surprise.
    if (bundle.kind !== "bundle") continue;

    for (const file of bundle.files) {
      const entry: Entry = byPath.get(file.path) ?? { patterns: [], contents: new Map() };
      entry.patterns.push(pattern.name);
      entry.contents.set(file.contents, [...(entry.contents.get(file.contents) ?? []), pattern.name]);
      byPath.set(file.path, entry);
    }

    process.stdout.write(`${pattern.name}: ${String(bundle.files.length)} files\n`);
  }
} finally {
  await disposeEngine();
}

const shared = [...byPath].filter(([, entry]) => entry.patterns.length > 1);

process.stdout.write(`\n${String(patterns.length)} patterns, ${String(byPath.size)} distinct paths\n`);
process.stdout.write(`${String(shared.length)} paths emitted by more than one pattern:\n\n`);

let disagreements = 0;

for (const [path, entry] of shared) {
  const agrees = entry.contents.size === 1;
  if (!agrees) disagreements += 1;

  process.stdout.write(
    `${agrees ? "AGREE   " : "CONFLICT"} ${path}  (${String(entry.patterns.length)} patterns, ${String(entry.contents.size)} versions)\n`,
  );

  if (!agrees) {
    for (const [, owners] of entry.contents) {
      process.stdout.write(`           version: ${owners.join(", ")}\n`);
    }
  }
}

process.stdout.write(`\n${String(disagreements)} conflicting paths\n`);
process.exit(disagreements === 0 ? 0 : 1);
