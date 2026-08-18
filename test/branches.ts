/**
 * Every option value a pattern can be generated under, for the suites that read what it emitted.
 *
 * One copy rather than three. Two suites had written this independently and they had already drifted:
 * one supplied the `coreModule` a narrowed `emitScope` requires and the other did not, so the same sweep
 * covered the split branches in one file and silently skipped them in the other — a difference nothing
 * would report, since a branch that refuses to render looks exactly like a branch with nothing in it. T144
 * is the same class of defect one level down: a guard drawn from one configuration checks the names that
 * happened to be in view.
 *
 * The defaults plus one render per non-default value, which is a sweep over values and not over their
 * combinations. The product is thousands of bundles at roughly 150ms each; this is dozens. What it buys is
 * that every line a pattern can emit is emitted at least once, which is what the readers here need — they
 * ask what appears anywhere, not what appears together.
 */

import type { GenerativePattern } from "../src/engine/catalog/schema.js";

export type BranchOptions = Readonly<Record<string, string | number | boolean>>;

export interface Branch {
  /** How to name this render in a failure message, so a sighting can be reproduced. */
  readonly label: string;
  readonly options: BranchOptions;
}

export function branchesOf(pattern: GenerativePattern): readonly Branch[] {
  const branches: Branch[] = [{ label: "defaults", options: {} }];

  for (const option of pattern.options) {
    // Excluded because it does not open a branch so much as remove one: the suites here pass it
    // explicitly, and enumerating it would double the sweep to re-read the same implementation files.
    if (option.name === "includeTests") continue;

    // A free-form string or integer option has no enumerable value space, so only these two branch.
    const values: readonly (string | number | boolean)[] =
      option.type === "enum" ? option.values : option.type === "boolean" ? [true, false] : [];

    for (const value of values) {
      if (value === option.default) continue;

      branches.push({
        label: `${option.name}=${String(value)}`,
        options: {
          [option.name]: value,
          // A `binding-only` bundle imports its machinery from somewhere and the engine requires being
          // told where (FR-018), so without this that branch refuses and a branch that never renders is a
          // branch whose contents go unread. Only that scope: `core-only` carries its own machinery, and
          // sending a specifier no file would import is refused rather than ignored.
          ...(option.name === "emitScope" && value === "binding-only" ? { coreModule: "./core.js" } : {}),
        },
      });
    }
  }

  return branches;
}
