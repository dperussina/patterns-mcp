/**
 * The sentence a caller reads when a request is refused — written once, for both surfaces.
 *
 * The engine's own messages quote the offending value, which is right for a library whose caller is a
 * program. Neither of this project's surfaces has that caller. Over MCP the reader is a model and the
 * text may well be pasted into another prompt; on the command line the reader is a person, or — since
 * an agent driving a CLI is the reason the CLI exists (contracts/cli.md) — a model reading captured
 * stderr. So a value that could be read as an instruction is described rather than echoed (FR-035),
 * regardless of which surface asked.
 *
 * It lives at the top level rather than inside `mcp/` because it began there, and being there was the
 * defect: the CLI printed `error.message` instead, so one refusal reached a caller sanitised and
 * composed while the other arrived raw. Two surfaces reaching one engine (Principle X) is not just
 * about the results — a caller told different things by the two is being told the wrong thing by one of
 * them, and a parity test comparing only successful output would never say which.
 *
 * `messageFor` switches on the error's code rather than testing classes in sequence, which is what makes
 * the exhaustiveness check at the bottom possible: a new `ErrorCode` fails to compile until it has been
 * worded here. That replaces the fallback this file used to end with — `return error.message` for any
 * correctable error not named above, which passed the caller a sentence nothing had reviewed and would
 * have carried an interpolated caller value straight through the moment one appeared in a new class.
 */

import {
  ContradictoryConventionsError,
  EngineError,
  FormatConfigError,
  IllegalCombinationError,
  InvalidIdentifierError,
  InvalidOptionValueError,
  MissingRequiredOptionError,
  SplitUnsupportedError,
  UnknownIdentifierError,
  UnknownOptionError,
  UnknownPatternError,
  UnsupportedRuntimeError,
  VerificationError,
} from "./engine/errors.js";
import { hashCanonical } from "./engine/provenance/hash.js";

/**
 * A value safe to quote back: identifier-shaped, punctuation-free, and short.
 *
 * Whitespace is the important exclusion. Prose is what carries an injected instruction, and a value
 * with no spaces cannot be read as a sentence however it is framed.
 */
const INERT = /^[A-Za-z0-9_$.\-/]{1,64}$/;

/** Quotes a caller value when it is inert, and describes it otherwise. Never echoes prose. */
export function safe(value: string): string {
  return INERT.test(value) ? `"${value}"` : "the value you supplied";
}

/** Whether a value would be quoted, for a sentence that has to reword itself when it would not. */
export function quotable(value: string): boolean {
  return INERT.test(value);
}

export function list(values: readonly string[], ifEmpty: string): string {
  return values.length > 0 ? values.join(", ") : ifEmpty;
}

/**
 * How a surface names the two things a refusal sends a caller to do next.
 *
 * The one licensed difference between what the two surfaces say. "Call `list_patterns`" is exactly
 * right for a model holding a tool list and meaningless at a shell prompt; "Run `patterns list`" is the
 * reverse. Forcing one wording on both would make a refusal name something its reader cannot invoke,
 * which is worse than a difference the parity test can account for — and it does account for it, by
 * normalising these clauses before comparing.
 *
 * Whole clauses rather than bare names, because the verb differs too: one is called, the other run.
 */
export interface Vocabulary {
  /** Imperative clause for enumerating the catalogue — "Call list_patterns". */
  readonly listCatalogue: string;
  /** Imperative clause for reading one pattern's options — "Call describe_pattern". */
  readonly describePattern: string;
}

/**
 * Rebuilds the caller-facing message from the error's structured fields.
 *
 * Deliberately not `error.message`. Passing that through would make every future change to an engine
 * message a silent change to what a caller is told, and would carry the engine's own quoting of caller
 * values with it.
 */
export function messageFor(error: EngineError, vocabulary: Vocabulary): string {
  switch (error.code) {
    case "unknown_pattern": {
      const it = error as UnknownPatternError;
      return (
        `No pattern named ${safe(it.requested)}. ` +
        (it.nearest.length > 0
          ? `Did you mean: ${it.nearest.join(", ")}?`
          : `${vocabulary.listCatalogue} to see which patterns exist.`)
      );
    }

    case "unknown_option": {
      const it = error as UnknownOptionError;
      return (
        `Option ${safe(it.option)} is not declared for this pattern. ` +
        `Declared options: ${list(it.declared, "(none)")}. ` +
        `${vocabulary.describePattern} for what each one accepts.`
      );
    }

    case "invalid_option_value": {
      const it = error as InvalidOptionValueError;
      return (
        `Option "${it.option}" does not accept that value. ` +
        `Permitted values: ${list(it.permitted, "(none)")}.`
      );
    }

    case "illegal_combination": {
      const it = error as IllegalCombinationError;
      // Rule and alternatives are catalogue text, surfaced verbatim (FR-009). Rewording them here is
      // how the explanation a caller reads drifts from the constraint actually enforced.
      return `${it.rule} Valid alternatives: ${list(it.alternatives, "(none)")}.`;
    }

    case "missing_required_option": {
      const it = error as MissingRequiredOptionError;
      // Both clauses, not just the first: the requirement and the way to withdraw it are equally
      // actionable, and a caller shown only the requirement guesses a path.
      const required = `Option "${it.option}" is required ${it.because}.`;
      return it.resolutions.length === 0 ? required : `${required} ${list(it.resolutions, "")}.`;
    }

    case "split_unsupported": {
      const it = error as SplitUnsupportedError;
      // `pattern` reached this only by being found in the catalogue, so it is one of our names rather
      // than caller text — but it arrived as caller text, and `safe` costs nothing to keep that true.
      return (
        `Pattern ${safe(it.pattern)} emits a single module, so there is no scope to select. ` +
        `It has no machinery to share between domain types and no per-type binding to emit separately: ` +
        `request it without emitScope and the whole bundle is the answer.`
      );
    }

    case "unconfigurable_format_option": {
      const it = error as FormatConfigError;
      // The key is a caller value, unlike every option name above, which comes from the catalogue. A
      // `prettierConfig` is often lifted wholesale out of a file the caller did not write, so this is the
      // one option name that can arrive as prose and has to go through `safe`.
      //
      // Two different refusals share this error: an option that cannot be set at all, and a value that a
      // configurable option cannot take. Said the same way, the second one contradicts itself — the list
      // of configurable options names the very option it has just refused — so the value case says so and
      // omits the list, which is not what that caller needs to know.
      return it.reason === undefined
        ? `Formatting option ${safe(it.option)} cannot be set here. ` +
            `Configurable options: ${list(it.permitted, "(none)")}.`
        : `Formatting option ${safe(it.option)} cannot take that value. ${it.reason}`;
    }

    case "contradictory_conventions": {
      const it = error as ContradictoryConventionsError;
      // Every part of this is ours — the pair, the conflict and the resolutions are all written in
      // `conventions.ts` against literal values the caller was matched to — so none of it goes through
      // `safe`. Nothing the caller typed is repeated, which is why the message can name both settings.
      return (
        `Conventions ${it.settings[0]} and ${it.settings[1]} cannot both hold: ${it.conflict} ` +
        `Change one of: ${it.resolutions.join("; ")}.`
      );
    }

    case "unknown_identifier": {
      const it = error as UnknownIdentifierError;
      // The role name comes from the caller, so it goes through `safe` — unlike an option name, which
      // the branch above takes from the catalogue.
      return it.declared.length > 0
        ? `Identifier ${safe(it.identifier)} is not one this pattern generates around. ` +
            `Declared identifiers: ${list(it.declared, "(none)")}. ` +
            `${vocabulary.describePattern} for what each one names.`
        : `Identifier ${safe(it.identifier)} is not used by this pattern, which takes none: it ` +
            `emits one module named after itself. Call it again without identifiers.`;
    }

    case "invalid_identifier": {
      const it = error as InvalidIdentifierError;
      // Composed from the fields, like every branch above, rather than by filtering the engine's
      // sentence. Filtering it produced the worst of both: the value a caller had to change was
      // replaced by "the supplied value", the role was quoted in its place as though it were the
      // offender, and the engine's own trailing clause repeated the opening one.
      //
      // `safe` returns a bare phrase for a value it will not echo, which does not read after the word
      // "Identifier". The subject is chosen rather than the value being interpolated into a fixed frame.
      const subject = quotable(it.value) ? `Identifier "${it.value}"` : "The value you supplied";
      return `${subject} cannot be used for "${it.field}": ${it.rule}`;
    }

    case "unsupported_runtime": {
      const it = error as UnsupportedRuntimeError;
      // Not the caller's to fix and not a defect in the catalogue, so it names the version required and
      // stops. Both values are read from `process.versions` and from a constant, never from a request.
      return (
        `Generated tests cannot be executed on Node ${it.running}. They run inside Node's permission ` +
        `model, which is how a bundle is proved to work without being granted the filesystem, and the ` +
        `flag enabling it is not recognised before Node ${it.required}. Upgrade the runtime.`
      );
    }

    case "verification_failed": {
      const it = error as VerificationError;
      // Diagnostics are withheld, and this must never start returning them: compiler output names
      // sandbox paths for files the caller never received (FR-038).
      return (
        `Generated code failed ${it.stage === "typecheck" ? "to compile" : "its tests"}. ` +
        `This is a defect in the pattern, not in your request. ` +
        `Reference ${it.correlationId} when reporting it.`
      );
    }

    default: {
      // Unreachable while `ErrorCode` is exhausted above, and a compile error the moment it is not.
      const unhandled: never = error.code;
      return String(unhandled);
    }
  }
}

/**
 * A reference for a failure nothing classified, derived from the failure itself.
 *
 * Derived rather than generated, for the reason the engine records for its verification identifier: an
 * arbitrary one would be unique and useless, while a derived one is reproducible, so two reports of the
 * same defect arrive under the same reference and an operator can grep for it. The stack is excluded
 * from what is hashed on purpose — including it would move the identifier whenever a line number did,
 * which is exactly when two reports of one bug most need to agree.
 */
export function referenceFor(error: unknown): string {
  return hashCanonical(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
}

/** The detail recorded against that reference, never shown to the caller. */
export function detailOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
