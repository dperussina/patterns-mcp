/**
 * What a pattern author writes.
 *
 * A pattern is two things kept deliberately apart. Its *declaration* — options, legality rules,
 * variants, category, licence — is catalog data in `data/patterns/{category}.json`, because
 * `list_patterns` and `describe_pattern` must answer from it without loading any generation code, and
 * because the catalog validator can then check the whole corpus by parsing rather than by importing.
 * Its *template* is the module here.
 *
 * plan.md's source-tree comment describes this directory as holding "template, options, legality,
 * metadata", which reads as though a module declares its own options. It cannot: data-model.md gives
 * those fields to the catalog entry, and duplicating them in a module would create two sources of
 * truth that drift silently — the catalog would document one option set while generation honoured
 * another. A module therefore names the catalog entry it implements, and `render` receives options
 * that have already been resolved and validated against that entry.
 */

import type { Conventions } from "../options/conventions.js";
import type { OptionValue } from "../options/resolve.js";
import type { NameTransform } from "../options/names.js";

/**
 * Why a file is in the bundle. Ordering and `emitScope` filtering both key off this, so it is part of
 * a pattern's output rather than a label applied afterwards (FR-004).
 */
export type FileRole = "types" | "core" | "binding" | "adapter" | "example" | "test";

/**
 * A file as its template produced it: content and role, with a path derived from validated inputs.
 * Callers never supply paths (FR-033), and a template never sees a caller-supplied one.
 */
export interface RenderedFile {
  readonly path: string;
  readonly contents: string;
  readonly role: FileRole;
}

/**
 * Everything a template is allowed to read. Deliberately closed: a template that needed the clock, the
 * environment, or the filesystem would break Principle I, and the way to make that impossible is to
 * hand it a complete, resolved value and nothing else.
 */
export interface RenderContext {
  /** Complete after defaults, key order normalised (FR-007). */
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly conventions: Conventions;
  /** Validated identifiers, keyed by the role the pattern asked for. */
  readonly identifiers: Readonly<Record<string, string>>;
  /**
   * Casings and plurals for each identifier, derived once so that two templates cannot disagree about
   * how the same name pluralises.
   */
  readonly names: Readonly<Record<string, NameTransform>>;
  readonly variant: string | undefined;
}

export interface PatternModule {
  /** The catalog entry this implements. Checked against the catalog at load time. */
  readonly name: string;
  /**
   * Pure and synchronous. Formatting, verification, ordering, and provenance headers all happen after
   * this returns, so a template's only job is to produce correct content.
   */
  render(context: RenderContext): readonly RenderedFile[];
}
