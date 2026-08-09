/**
 * Emits `data/schema.json` from the runtime Zod schema, so the published
 * catalogue schema is derived from the validator rather than maintained
 * alongside it. Hand-maintaining both guarantees they diverge; deriving one
 * makes divergence unrepresentable.
 *
 * Run with no arguments to write the file. Run with `--check` to verify the
 * committed file matches what the current schema produces — that is the form
 * wired into `pnpm check`, so a schema change that is not accompanied by a
 * regenerated artefact fails the gate instead of shipping.
 *
 * Caveat, deliberately recorded here because it is easy to over-trust this
 * file: JSON Schema cannot express the cross-field refinements the Zod schema
 * carries — that an enum option's `default` is a member of its own `values`,
 * and that a pattern holds no self-edge. Those checks exist only in the Zod
 * validator. This artefact is therefore necessary but not sufficient: it gives
 * editors completion and shape-checking for hand-authored shards, while
 * `scripts/validate-catalog.ts` remains the authority on admissibility.
 */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CatalogShardSchema } from "../src/engine/catalog/schema.js";

const OUTPUT_PATH = fileURLToPath(new URL("../data/schema.json", import.meta.url));

function render(): string {
  const schema = z.toJSONSchema(CatalogShardSchema, { target: "draft-2020-12" });
  // Two-space indent and a trailing newline, so the artefact is a stable,
  // reviewable diff rather than one long line.
  return `${JSON.stringify(schema, null, 2)}\n`;
}

async function main(): Promise<number> {
  const rendered = render();
  const checkOnly = process.argv.includes("--check");

  if (!checkOnly) {
    await writeFile(OUTPUT_PATH, rendered, "utf8");
    return 0;
  }

  let committed: string;
  try {
    committed = await readFile(OUTPUT_PATH, "utf8");
  } catch {
    process.stderr.write(
      "data/schema.json is missing. Run `pnpm schema:emit` and commit the result.\n",
    );
    return 1;
  }

  if (committed !== rendered) {
    process.stderr.write(
      "data/schema.json is out of date with src/engine/catalog/schema.ts.\n" +
        "Run `pnpm schema:emit` and commit the result.\n",
    );
    return 1;
  }

  return 0;
}

process.exitCode = await main();
