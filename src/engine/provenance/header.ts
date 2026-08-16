/**
 * The header every generated file carries (FR-020, FR-021).
 *
 * It answers one question for whoever finds the file later: what produced this, and from what request.
 * That is what makes reuse possible — an agent reading a repository can tell that the machinery is
 * already installed and under which options, instead of regenerating it and overwriting edits.
 *
 * Three decisions, each of which the alternative would undo:
 *
 * **Pattern and options hash only, no versions.** A generator or compiler version in the header would
 * rewrite the first lines of every generated file in every repository on every release — a diff touching
 * everything and meaning nothing, which is exactly what FR-021 forbids and what would train a reader to
 * ignore these lines.
 *
 * **Tag-per-line, and short.** The format step wraps comments to the caller's `printWidth`, so a header
 * written as prose would be re-wrapped at a narrow width and its fields run together. Every line is a
 * `@tag`, which the wrapper treats as its own paragraph, and every line is short enough that at ordinary
 * widths it is not touched at all.
 *
 * **In the contents, not beside them.** data-model.md lists `provenance` as a field of `File`, and it is
 * modelled here as the header the contents carry rather than as a second copy alongside them. The point
 * of provenance is that it survives being pasted into a repository, which a response field does not, and
 * two copies of one fact are a chance for them to disagree.
 */

import type { RenderedFile } from "../patterns/types.js";

import { optionsHash } from "./hash.js";
import type { HashInput } from "./hash.js";

/**
 * Marks the file as machine-produced.
 *
 * `@generated` is a widely recognised convention — review tools, diff viewers, and linters look for it —
 * so a reader's tooling gets the signal without being taught this format.
 */
const GENERATED_TAG = "@generated";

/**
 * Matches a header this module wrote: anchored at the start of the file, and required to carry the
 * `@generated` tag on its first line. Matching any leading block comment would strip a template's own
 * module documentation from a file that has no provenance header, which is a silent way to make the
 * harness pass.
 */
const HEADER = new RegExp(String.raw`^/\*\*\n \* ${GENERATED_TAG}[^\n]*\n(?: \*[^\n]*\n)* \*/\n\n`);

export interface Provenance {
  readonly pattern: string;
  readonly optionsHash: string;
}

/**
 * The header text, ending in the blank line that separates it from whatever the template wrote.
 *
 * Emitted before formatting, so these bytes are the bytes that get typechecked and the bytes the caller
 * receives. A header added after verification would mean returning a file that had not been verified in
 * the form it was returned.
 */
export function renderHeader(provenance: Provenance): string {
  return [
    "/**",
    ` * ${GENERATED_TAG} by patterns — regenerate rather than edit.`,
    ` * @pattern ${provenance.pattern}`,
    ` * @options ${provenance.optionsHash}`,
    " */",
    "",
    "",
  ].join("\n");
}

/**
 * The header for a file that belongs to every pattern rather than one (FR-020).
 *
 * Naming a pattern and an options hash here would be two lies and a bug. The file's content does not
 * depend on either, so the hash would attribute it to whichever request happened to produce it; and
 * since the bytes would then differ per request, two bundles unpacked into one directory would
 * overwrite each other's copy — leaving whichever suite lost pointing at a header for a pattern it is
 * not part of. Fixed bytes are what make the collision a no-op instead of a broken build.
 */
export function renderSharedHeader(): string {
  return [
    "/**",
    ` * ${GENERATED_TAG} by patterns — regenerate rather than edit.`,
    " * @shared by every pattern, and identical in every bundle.",
    " */",
    "",
    "",
  ].join("\n");
}

/**
 * The option that decides which files exist rather than what any of them says.
 *
 * `includeTests` cannot appear in a file: it selects the suite, and a suite that exists was asked for. Its
 * presence in the hash meant a caller who regenerated without tests got a rewritten header on every file
 * they kept — identical code, a different attribution — which is the same misinformation as the machinery
 * case below, on a smaller scale.
 */
const SELECTS_FILES = new Set(["includeTests"]);

/**
 * Inputs that decide which files a request gets back, not what the machinery says.
 *
 * `emitScope` selects from what was rendered, and `coreModule` is where a binding looks for machinery it is
 * not being given. Neither can reach the machinery's own text. Both *can* reach a binding's or an example's
 * — a `core-only` example declares a sample binding inline, and a binding imports the specifier verbatim —
 * so they are excluded here and kept in the ordinary header.
 */
const EMISSION_ONLY = new Set([...SELECTS_FILES, "emitScope", "coreModule"]);

/**
 * Roles that make up the shared half of a split pattern: the machinery, not a binding over it.
 *
 * A role alone is not enough to identify machinery. Nearly every pattern calls its principal module `core`,
 * and for the twenty-three that do not split, that module *is* the caller's type written out — attributing
 * it without the identifiers would claim two genuinely different files came from the same request. Only a
 * pattern that offers `emitScope` has a half defined not to know the entity, so only there does the
 * question arise.
 */
const MACHINERY = new Set<RenderedFile["role"]>(["core", "types"]);

/** Whether this pattern separates machinery from bindings, which is what `emitScope` selects between. */
function splits(request: HashInput): boolean {
  return "emitScope" in request.options;
}

/**
 * What the machinery's header identifies: the options that shape the machinery, and nothing else.
 *
 * The identifiers are dropped as well as the emission-only options, because the machinery is by
 * construction the half that does not know the caller's type — that is what makes it shareable, and what
 * makes a second entity's request able to reuse it.
 */
function machineryInput(request: HashInput): HashInput {
  return { ...without(request, EMISSION_ONLY), identifiers: {} };
}

/** The same request with some options left out of what its header will identify. */
function without(request: HashInput, excluded: ReadonlySet<string>): HashInput {
  return {
    pattern: request.pattern,
    options: Object.fromEntries(
      Object.entries(request.options).filter(([name]) => !excluded.has(name)),
    ),
    identifiers: request.identifiers,
    variant: request.variant,
  };
}

/**
 * Prepends a header to every file. Roles are consulted only to decide *which* header: FR-020 says every
 * file carries one.
 *
 * Three attributions, for three kinds of file, and the two beyond the ordinary one exist for the same
 * reason. A path that two requests both emit must carry identical bytes, or the second request silently
 * rewrites the first caller's file.
 *
 * A **shared support file** belongs to every pattern, so it names none.
 *
 * The **machinery of a split pattern** belongs to every request against that pattern: `repository-core.ts`
 * comes back with every `full` request, so a project with two repositories has been sent it twice. Hashing
 * the whole request there attributed shared machinery to whichever entity asked last — two `full`
 * requests differing only in their entity produced byte-different cores, identical but for the header —
 * and made the option-match check in research.md §11 useless, since two cores generated under the same
 * pagination and id style did not agree on a hash. Now they do, and a hash that differs means the
 * machinery genuinely differs.
 */
export function withProvenance(
  files: readonly RenderedFile[],
  request: HashInput,
): readonly RenderedFile[] {
  const header = renderHeader({
    pattern: request.pattern,
    optionsHash: optionsHash(without(request, SELECTS_FILES)),
  });
  const machinery = splits(request)
    ? renderHeader({
        pattern: request.pattern,
        optionsHash: optionsHash(machineryInput(request)),
      })
    : header;
  const shared = renderSharedHeader();

  return files.map((file) => ({
    ...file,
    contents:
      (file.provenance === "shared" ? shared : MACHINERY.has(file.role) ? machinery : header) +
      file.contents,
  }));
}

/**
 * The same file with its header removed, or unchanged when it has none.
 *
 * The diff-stability harness needs this. The header carries the options hash, so *every* option changes
 * it — which would make the harness report every option as affecting every file and say nothing about
 * the code. Stripping it is what lets the harness ask its real question: did anything the option does
 * not govern change (SC-005)?
 */
export function withoutHeader(contents: string): string {
  return contents.replace(HEADER, "");
}

/**
 * Just the header, as the difference between a file and the same file without one. Empty when it has none.
 *
 * The complement of `withoutHeader`, and defined beside it so the two cannot disagree about where a header
 * ends. Callers that need to compare attributions rather than code use this: comparing whole files answers
 * a different question, since a body that differs hides a header that has stopped distinguishing anything.
 */
export function headerOf(contents: string): string {
  return contents.slice(0, contents.length - withoutHeader(contents).length);
}
