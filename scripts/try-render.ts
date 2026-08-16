/**
 * Scratch driver: render and format one bundle without verifying it. Not part of `check`.
 *
 * `try-generate.ts` is the one to reach for normally. This exists for the case that driver cannot
 * serve: when the bundle fails to compile and the thing worth seeing is the file that failed.
 *
 * `pnpm exec tsx scripts/try-render.ts builder '{"collections":false}'`
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCatalog } from "../src/engine/catalog/load.js";
import { formatSource } from "../src/engine/format/prettier.js";
import { MODULES } from "../src/engine/generate/index.js";
import { deriveNames, loadNameTable } from "../src/engine/options/names.js";
import { resolveOptions } from "../src/engine/options/resolve.js";

const name = process.argv[2] ?? "builder";
const options = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;

const catalog = await loadCatalog();
const pattern = catalog.patterns.find((candidate) => candidate.name === name);
if (pattern === undefined || pattern.kind !== "generative") {
  throw new Error(`no generative pattern named "${name}"`);
}

const module = MODULES.find((candidate) => candidate.name === name);
if (module === undefined) {
  throw new Error(`no module named "${name}"`);
}

// `ENTITY=Invoice` to render under a different noun. Worth reaching for: a name two characters
// longer than `Order` wraps lines the golden suite never sees wrapped.
const entity = process.env["ENTITY"] ?? "Order";
const identifiers = { entity };
const resolved = resolveOptions(pattern, { options, identifiers });
const derived = deriveNames(entity, await loadNameTable());
if (!derived.ok) {
  throw new Error(derived.problem);
}

const files = module.render({
  options: resolved.options,
  conventions: resolved.conventions,
  identifiers,
  names: { entity: derived.names },
  variant: resolved.variant,
});

const directory = process.argv[4];

for (const file of files) {
  const contents = await formatSource(file.contents, resolved.conventions.prettierConfig);

  if (directory === undefined) {
    process.stdout.write(`\n${"=".repeat(90)}\n${file.path}  [${file.role}]\n${"=".repeat(90)}\n`);
    process.stdout.write(contents);
    continue;
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, file.path), contents);
  process.stdout.write(`${join(directory, file.path)}\n`);
}
