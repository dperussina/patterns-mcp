/**
 * Engine errors, as tool results.
 *
 * A refusal is a **result**, not a protocol error: SDK v2 tool handlers return results, and protocol
 * errors are reserved for malformed requests (contracts/mcp-tools.md). A caller that asked for an
 * illegal combination sent a well-formed request and got a well-formed answer — "no, because".
 *
 * The sentence itself is composed in `../refusals.ts`, which both surfaces share. What remains here is
 * everything the protocol adds around it: the result envelope, the machine-readable `_meta`, and the
 * decision about what gets logged rather than returned.
 */

import { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { EngineError, VerificationError } from "../engine/errors.js";
import { detailOf, list, messageFor, referenceFor, safe } from "../refusals.js";
import { cacheHintMeta } from "./cache.js";
import { stderrLog } from "./log.js";
import { CORRECTABLE_META_KEY, ERROR_CODE_META_KEY } from "./meta.js";
import type { Logger } from "./log.js";

/**
 * The names a project convention can have, for telling a caller who wrote one at the top level where it
 * goes. Duplicated from the tool's own schema by necessity — the schema cannot ask itself what its keys are
 * while it is being defined — and held to that by a test.
 */
const CONVENTIONS = [
  "strictness",
  "moduleStyle",
  "importExtensions",
  "typeImports",
  "testFramework",
  "runtime",
  "prettierConfig",
] as const;

/**
 * A schema that refuses an argument it does not declare, saying where the value belongs.
 *
 * Strict rather than stripping, which is Zod's default and was the defect: an unknown key vanished, so a
 * caller who put an option beside `options` instead of inside it got the pattern's defaults and a
 * successful-looking response. Strict here also makes the *published* schema say `additionalProperties:
 * false`, which is what lets a client catch the mistake before the call is even sent.
 *
 * It lives in this file because what it produces is a refusal, and every refusal this adapter sends is
 * worded here — the alternative is a schema in one file quietly deciding message text that every other
 * error type has reviewed in another.
 */
export function strictObject<Shape extends z.ZodRawShape>(
  shape: Shape,
  /**
   * What one of these keys is, for the refusal to call it by name. A nested object needs its own: told that
   * `moduleStyle` "is not an argument of this tool", a caller would go looking for it at the top level,
   * which is the mistake being corrected.
   */
  kind: "argument of this tool" | "convention" = "argument of this tool",
): z.ZodObject<Shape> {
  const accepted = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? unrecognisedArguments(issue.keys, accepted, kind)
        : // Every other issue keeps the SDK's own wording, which already names the field and what it
          // expected. Replacing that wholesale would mean re-deriving messages for every value type here.
          undefined,
  });
}

/**
 * The refusal for an argument this tool does not have (FR-051).
 *
 * An option, an identifier and a convention are all things a caller legitimately wants to send; getting one
 * into the wrong place is the commonest way to phrase a request wrongly, and it used to be answered with
 * silence — so a caller who asked for offset pagination received cursor and was told nothing.
 *
 * Keys are caller-supplied, so they are quoted only when inert, like every other echoed value here.
 */
export function unrecognisedArguments(
  keys: readonly string[],
  accepted: readonly string[],
  kind: "argument of this tool" | "convention" = "argument of this tool",
): string {
  // Only worth splitting out at the top level: inside `conventions` these names are what belongs there, so
  // a key reaching this point is misspelled rather than misplaced.
  const misplaced =
    kind === "convention"
      ? []
      : keys.filter((key) => (CONVENTIONS as readonly string[]).includes(key));
  const unknown = keys.filter((key) => !misplaced.includes(key));

  const sentences: string[] = [];

  if (misplaced.length > 0) {
    sentences.push(
      `${misplaced.map(safe).join(", ")} ${misplaced.length === 1 ? "is a project convention" : "are project conventions"}: ` +
        `send ${misplaced.length === 1 ? "it" : "them"} inside "conventions".`,
    );
  }

  if (unknown.length > 0) {
    sentences.push(
      `${unknown.map(safe).join(", ")} ${describeKind(kind, unknown.length)}. ` +
        (kind === "convention"
          ? `The conventions you can set are ${list(accepted, "(none)")}.`
          : `Its arguments are ${list(accepted, "(none)")}.${elsewhere(accepted)}`),
    );
  }

  return sentences.join(" ");
}

/**
 * Where the two families of caller-supplied name belong — mentioned only by a tool that has somewhere to put
 * them. `describe_pattern` takes a pattern and nothing else, and telling its caller about `options` and
 * `identifiers` would send them looking for arguments that tool does not have.
 */
function elsewhere(accepted: readonly string[]): string {
  const homes = [
    accepted.includes("options") ? `A pattern's own options go inside "options"` : undefined,
    accepted.includes("identifiers") ? `names to generate around inside "identifiers"` : undefined,
  ].filter((home): home is string => home !== undefined);

  if (homes.length === 0) return "";

  const sentence = homes.join(", and ");
  return ` ${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}.`;
}

/** Agreement in number, written out because the plural of each phrase falls in a different place. */
function describeKind(
  kind: "argument of this tool" | "convention",
  count: number,
): string {
  if (kind === "convention") {
    return count === 1 ? "is not a convention" : "are not conventions";
  }
  return count === 1
    ? "is not an argument of this tool"
    : "are not arguments of this tool";
}

/**
 * How this surface names what a caller should do next. The CLI's counterpart is in `cli/run.ts`.
 *
 * A model holding a tool list calls a tool; it has no shell. Naming the tools is what makes a refusal
 * actionable in one turn (SC-007) rather than sending the caller to guess at a capability by
 * description.
 */
const VOCABULARY = {
  listCatalogue: "Call list_patterns",
  describePattern: "Call describe_pattern",
} as const;

/**
 * Records the detail a caller is not shown, against the identifier they are.
 *
 * This is the other half of withholding diagnostics. A correlation identifier that leads nowhere is
 * worse than no identifier at all — it invites a caller to report a defect that the operator then has
 * no way to look up (FR-038). A correctable refusal is not logged: it is the caller's business, it is
 * fully described in the message they received, and logging every typo would bury the real failures.
 */
function record(error: EngineError, log: Logger): void {
  if (error instanceof VerificationError) {
    log(
      `verification_failed ${error.correlationId} at ${error.stage}: ${error.diagnostics.join(" | ")}`,
    );
    return;
  }

  if (!error.correctable) log(`${error.code}: ${error.message}`);
}

/**
 * The caller-facing text for an error, without the tool-result envelope.
 *
 * Resources fail with protocol errors rather than results — there is no `isError` on a
 * `resources/read` — so the resource handlers need the message without the wrapper. Sharing this is
 * what keeps FR-035 from being a property of the tool path alone: the sanitising happens here, and a
 * new surface gets it by using this rather than by remembering to.
 */
export function safeMessage(error: unknown, log: Logger = stderrLog): string {
  if (error instanceof EngineError) {
    record(error, log);
    return messageFor(error, VOCABULARY);
  }

  return unclassified(error, log);
}

/**
 * The message for a failure nothing classified, with its detail recorded against the identifier it
 * quotes.
 *
 * A `VerificationError` arrives already carrying a correlation identifier, and this is the other branch
 * — the one where a defect escaped a boundary that should have named it. FR-038 does not exempt it, and
 * it is the branch a caller is *most* likely to report, since its message tells them nothing else. It
 * shipped without an identifier: the stack went to the log and the caller got prose, so an operator had
 * a record nobody could point at.
 *
 * The identifier is derived from the error's own identity rather than generated, which is the same
 * reasoning the engine records for the verification one: an arbitrary identifier would be unique and
 * useless, while a derived one is reproducible, so two reports of the same defect arrive under the same
 * reference and an operator can grep for it. The stack is excluded from what is hashed on purpose —
 * including it would move the identifier whenever a line number did, which is exactly when two reports
 * of one bug most need to agree.
 */
function unclassified(error: unknown, log: Logger): string {
  const correlationId = referenceFor(error);

  log(`internal_error ${correlationId}: ${detailOf(error)}`);

  return (
    "The server failed to handle this request. This is a defect, not a problem with your input. " +
    `Reference ${correlationId} when reporting it.`
  );
}

export function toErrorResult(
  error: unknown,
  log: Logger = stderrLog,
): CallToolResult {
  if (error instanceof EngineError) {
    record(error, log);
    return {
      isError: true,
      content: [{ type: "text", text: messageFor(error, VOCABULARY) }],
      // `structuredContent` is deliberately absent. The output schema describes a bundle, and there
      // is no bundle: the request was refused before anything was generated.
      _meta: {
        [ERROR_CODE_META_KEY]: error.code,
        [CORRECTABLE_META_KEY]: error.correctable,
        // As reusable as a success and for the same reason: the request decides the answer, so the
        // same bad request is refused identically. Saying nothing here would leave a caller retrying
        // a call whose outcome cannot change, which is the expensive half of a refusal.
        ...cacheHintMeta(),
      },
    };
  }

  // Anything else escaped a boundary that should have classified it. Say so without speculating, and
  // log the stack — this is the case where we have no idea what happened and will need to find out.
  return {
    isError: true,
    content: [{ type: "text", text: unclassified(error, log) }],
    // No cache hint, and this is the one result that must not carry one. A defect is not a fact about
    // the request: the next attempt may well succeed, once the defect is fixed or the race that caused
    // it does not recur. Caching it would make one failure permanent for as long as the entry lives.
    _meta: {
      [ERROR_CODE_META_KEY]: "internal_error",
      [CORRECTABLE_META_KEY]: false,
    },
  };
}
