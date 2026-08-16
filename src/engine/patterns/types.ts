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
  /**
   * Set on a support file that is byte-identical in every bundle, whatever pattern or options produced
   * it — currently only the `node:test` assertion shim.
   *
   * It changes how the file is attributed. An ordinary file names the pattern and options it came from,
   * which is what lets a reader tell whether machinery is already installed. A shared file cannot: it
   * belongs to every pattern equally, and a header naming whichever one happened to ask for it is both
   * false and the thing that makes two bundles unsafe to unpack side by side. Two patterns emitting the
   * same path must emit the same bytes, or the second overwrites the first and the first's suite stops
   * compiling — which is invisible here, because each bundle is verified alone.
   */
  readonly provenance?: "shared";
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
   * Names this template writes literally, which a name derived from the caller's identifier must
   * therefore not equal.
   *
   * A template writes some names whatever it is asked for: a core export the binding imports, an
   * illustrative second type an example needs in order to contrast with the first, the type-level
   * assertion helpers. A caller whose entity derives to one of those gets a module that imports a
   * name and declares it, which does not compile — and because the compiler runs before the bundle
   * is returned, the caller is told the pattern is defective. Accurate, and no use to them: nothing
   * in the answer says which of their names caused it or that another would work.
   *
   * Declared here rather than in the catalog because the list is a fact about this file. A list kept
   * anywhere else drifts the first time a template gains a helper, silently, back into the failure it
   * was added to prevent. `conformance/emitted-names` keeps it honest by reading the names out of a
   * rendered bundle and requiring each one to be either usable or refused.
   *
   * Only names that would actually break belong here. A template able to step aside instead should
   * do that, since a refusal spends the caller's turn on a name we chose, not one they did.
   */
  readonly emits?: readonly string[];
  /**
   * Pure and synchronous. Formatting, verification, ordering, and provenance headers all happen after
   * this returns, so a template's only job is to produce correct content.
   */
  render(context: RenderContext): readonly RenderedFile[];
}
