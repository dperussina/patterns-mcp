/**
 * Where the package's shipped data lives.
 *
 * The obvious way to find it — a fixed relative path from the importing module, `../../../data` — is
 * correct in the source tree and wrong in the published package, because the bundler flattens
 * `src/engine/catalog/` and `src/engine/options/` into one output directory and the path then resolves
 * three levels above the package root. The failure is total and silent until runtime: the built server
 * cannot read its own catalogue or its own name table, so every request fails with a missing-file error
 * naming a path outside the installation.
 *
 * Walking up from this module instead is indifferent to how deep it ends up. A directory qualifies only
 * if it holds both `package.json` and `data`, so the walk cannot stop at an unrelated `data` directory
 * belonging to something else on the way up.
 *
 * Lives at the engine root, and is shared, because it was two separate copies of the same relative path
 * that produced two separate instances of this bug.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved once, on first use rather than at import, so a failure lands on a caller and not a loader. */
let cached: string | undefined;

export function dataRoot(): string {
  if (cached !== undefined) return cached;

  const start = dirname(fileURLToPath(import.meta.url));
  let directory = start;

  for (;;) {
    const candidate = join(directory, "data");
    if (existsSync(join(directory, "package.json")) && existsSync(candidate)) {
      cached = candidate;
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    `could not locate the package data directory: no ancestor of ${start} holds both package.json and data/`,
  );
}

/** A path inside the shipped data directory, e.g. `dataPath("names.json")`. */
export function dataPath(...segments: readonly string[]): string {
  return join(dataRoot(), ...segments);
}
