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

/** Prepends the header to every file. Roles are not consulted: FR-020 says every file. */
export function withProvenance(
  files: readonly RenderedFile[],
  request: HashInput,
): readonly RenderedFile[] {
  const header = renderHeader({ pattern: request.pattern, optionsHash: optionsHash(request) });

  return files.map((file) => ({ ...file, contents: header + file.contents }));
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
