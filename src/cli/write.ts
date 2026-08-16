/**
 * Putting a bundle on disk, refusing to overwrite anything (contracts/cli.md, "Output modes").
 *
 * The refusal is the whole reason this is its own module. Generated files carry a provenance header
 * saying "regenerate rather than edit", and the failure that advice exists to prevent is someone editing
 * one anyway and then regenerating over it. A tool that silently overwrote would destroy exactly the work
 * the header warns about, and it would do it at the moment the caller felt safest — a second `generate`
 * with one flag changed, which looks like a smaller act than it is.
 *
 * So a collision stops everything, and nothing is written at all: the paths are all checked before the
 * first byte goes out. A partial write would leave the caller with a bundle whose files disagree about
 * which request produced them, and no way to tell which ones are new.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Bundle } from "../engine/generate/index.js";

/** A path that already exists, or one that would escape `--out`. Correctable by the caller. */
export class WriteRefusedError extends Error {
  readonly paths: readonly string[];

  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = "WriteRefusedError";
    this.paths = paths;
  }
}

/**
 * Where each file of `bundle` would go, relative to the working directory.
 *
 * Separate from writing so that `--dry-run` reports the same paths the real run would use, rather than a
 * second calculation of them that could differ.
 */
export function destinations(bundle: Bundle, out: string): readonly string[] {
  const root = resolve(out);

  return bundle.files.map((file) => {
    const target = resolve(root, file.path);

    // Belt to `assertEmittablePath`'s braces (FR-033). That guard runs inside the engine and already
    // refuses absolute paths and `..` segments, so this cannot fire today; it is here because this is the
    // one place in the program where a path is handed to the filesystem, and the check that matters at a
    // boundary is the one written at the boundary.
    const inside = relative(root, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new WriteRefusedError(
        `Refusing to write outside ${out}: the bundle names ${file.path}. This is our defect — ` +
          `please report it.`,
        [file.path],
      );
    }

    return target;
  });
}

/**
 * Writes every file, or none.
 *
 * @throws WriteRefusedError naming every colliding path, not just the first. A caller who has to run the
 * command again to discover the second collision learns their situation one file at a time.
 */
export async function writeBundle(
  bundle: Bundle,
  out: string,
  exists: (path: string) => Promise<boolean>,
): Promise<readonly string[]> {
  const targets = destinations(bundle, out);

  const collisions: string[] = [];
  for (const [index, target] of targets.entries()) {
    if (await exists(target)) collisions.push(bundle.files[index]?.path ?? target);
  }

  if (collisions.length > 0) {
    throw new WriteRefusedError(
      `Refusing to overwrite ${String(collisions.length)} existing ` +
        `file${collisions.length === 1 ? "" : "s"}: ${collisions.join(", ")}. ` +
        `Generated files carry a header asking to be regenerated rather than edited, and overwriting ` +
        `one silently is how an edit gets lost. Write to an empty directory with --out, or move the ` +
        `existing files aside. Nothing was written.`,
      collisions,
    );
  }

  for (const [index, target] of targets.entries()) {
    const file = bundle.files[index];
    if (file === undefined) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }

  return targets;
}

/**
 * A path as the caller would type it: relative when it is under the working directory, absolute when it
 * is not.
 *
 * One function because both `--dry-run` and the real write print these, and they disagreed when each
 * computed its own — the dry run printing `/tmp/out/order.ts` and the write printing
 * `../../../../tmp/out/order.ts` for the same file. Either spelling is defensible; two spellings for one
 * path make a reader wonder whether two different places were meant.
 */
export function displayPath(target: string): string {
  const nearby = relative(process.cwd(), target);
  return nearby === "" || nearby.startsWith("..") ? target : nearby;
}

/** Joined here rather than inline so tests can build the same paths without repeating the rule. */
export function within(out: string, path: string): string {
  return join(resolve(out), path);
}
