/**
 * Engine errors, as tool results.
 *
 * Two rules shape this file.
 *
 * A refusal is a **result**, not a protocol error: SDK v2 tool handlers return results, and protocol
 * errors are reserved for malformed requests (contracts/mcp-tools.md). A caller that asked for an
 * illegal combination sent a well-formed request and got a well-formed answer — "no, because".
 *
 * And no caller-supplied value reaches the message unless it is inert (FR-035). The engine's own
 * messages quote the offending value, which is right for a library whose caller is a program. Here the
 * caller is a model, and the message may well be pasted into another prompt, so a value that could
 * read as an instruction is described rather than echoed.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  EngineError,
  InvalidIdentifierError,
  InvalidOptionValueError,
  MissingRequiredOptionError,
  UnknownOptionError,
  UnknownPatternError,
  VerificationError,
  isCorrectable,
} from "../engine/errors.js";
import { stderrLog } from "./log.js";
import type { Logger } from "./log.js";

/**
 * A value safe to quote back: identifier-shaped, punctuation-free, and short.
 *
 * Whitespace is the important exclusion. Prose is what carries an injected instruction, and a value
 * with no spaces cannot be read as a sentence however it is framed.
 */
const INERT = /^[A-Za-z0-9_$.\-/]{1,64}$/;

/** Quotes a caller value when it is inert, and describes it otherwise. Never echoes prose. */
function safe(value: string): string {
  return INERT.test(value) ? `"${value}"` : "the value you supplied";
}

function list(values: readonly string[], ifEmpty: string): string {
  return values.length > 0 ? values.join(", ") : ifEmpty;
}

/**
 * Rebuilds the caller-facing message from the error's structured fields.
 *
 * Deliberately not `error.message`. Passing that through would make every future change to an engine
 * message a silent change to what this adapter sends a model, and would carry the engine's own
 * quoting of caller values with it.
 */
function messageFor(error: EngineError): string {
  if (error instanceof UnknownPatternError) {
    return (
      `No pattern named ${safe(error.requested)}. ` +
      (error.nearest.length > 0
        ? `Did you mean: ${error.nearest.join(", ")}?`
        : `Call list_patterns to see which patterns exist.`)
    );
  }

  if (error instanceof UnknownOptionError) {
    return (
      `Option ${safe(error.option)} is not declared for this pattern. ` +
      `Declared options: ${list(error.declared, "(none)")}. ` +
      `Call describe_pattern for what each one accepts.`
    );
  }

  if (error instanceof InvalidOptionValueError) {
    return (
      `Option "${error.option}" does not accept that value. ` +
      `Permitted values: ${list(error.permitted, "(none)")}.`
    );
  }

  if (error instanceof MissingRequiredOptionError) {
    return `Option "${error.option}" is required for this combination of options.`;
  }

  if (error instanceof InvalidIdentifierError) {
    // The engine's text states the rule and quotes the offending name; the rule is the useful half.
    return `Identifier "${error.field}" is not usable as a generated name: ${withoutQuotedValues(error.message)}`;
  }

  // Correctable errors not named above still state their rule in prose, and that prose is ours: the
  // legality rule text is authored with the pattern and surfaced verbatim (FR-009).
  if (isCorrectable(error)) return error.message;

  // Not correctable — our defect. The message already withholds diagnostics, and this must never
  // start returning them: compiler output names sandbox paths for files the caller never received.
  return error.message;
}

/**
 * Strips quoted spans from an engine message, so a rule can be quoted without the value it rejected.
 *
 * The engine truncates the values it quotes, which bounds the damage but does not remove it; a
 * 32-character span is ample room for an instruction.
 */
function withoutQuotedValues(message: string): string {
  return message.replace(/"[^"]*"/g, "the supplied value");
}

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
    return messageFor(error);
  }

  log(`internal_error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return "The server failed to handle this request. This is a defect, not a problem with your input.";
}

export function toErrorResult(error: unknown, log: Logger = stderrLog): CallToolResult {
  if (error instanceof EngineError) {
    record(error, log);
    return {
      isError: true,
      content: [{ type: "text", text: messageFor(error) }],
      // `structuredContent` is deliberately absent. The output schema describes a bundle, and there
      // is no bundle: the request was refused before anything was generated.
      _meta: { "dev.patterns/errorCode": error.code, "dev.patterns/correctable": error.correctable },
    };
  }

  // Anything else escaped a boundary that should have classified it. Say so without speculating, and
  // log the stack — this is the case where we have no idea what happened and will need to find out.
  log(`internal_error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "The server failed to handle this request. This is a defect, not a problem with your input.",
      },
    ],
    _meta: { "dev.patterns/errorCode": "internal_error", "dev.patterns/correctable": false },
  };
}
