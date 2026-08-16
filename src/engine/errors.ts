/**
 * The engine's error taxonomy (contracts/engine-api.md).
 *
 * The split that matters is caller-correctable against internal defect. A
 * correctable error names the field, states the rule, and enumerates the
 * alternatives, so an agent can fix its call without a second discovery round
 * trip (SC-007). An internal defect deliberately tells the caller almost
 * nothing, because there is nothing they can do with compiler output except be
 * misled by it (FR-038).
 *
 * Errors are thrown here and mapped by each adapter to its own idiom —
 * `isError: true` results for MCP, exit codes for the CLI. The engine does not
 * know which adapter is calling it, so it does not shape messages for one.
 */

/** Machine-readable discriminant, stable across releases. */
export type ErrorCode =
  | "unknown_pattern"
  | "unknown_option"
  | "invalid_option_value"
  | "illegal_combination"
  | "unknown_identifier"
  | "invalid_identifier"
  | "missing_required_option"
  | "split_unsupported"
  | "unconfigurable_format_option"
  | "contradictory_conventions"
  | "unsupported_runtime"
  | "verification_failed";

export abstract class EngineError extends Error {
  abstract readonly code: ErrorCode;
  /**
   * Whether the caller can fix this by changing their request. Adapters branch
   * on this rather than on the concrete class, so a new correctable error does
   * not require every adapter to be updated.
   */
  abstract readonly correctable: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Base for everything a caller can fix by changing their request. */
export abstract class CorrectableError extends EngineError {
  readonly correctable = true;
}

export class UnknownPatternError extends CorrectableError {
  readonly code = "unknown_pattern";
  readonly requested: string;
  /** Nearest catalogue names, so the caller can retry without listing first. */
  readonly nearest: readonly string[];

  constructor(requested: string, nearest: readonly string[]) {
    super(
      `Unknown pattern "${requested}".` +
        (nearest.length > 0
          ? ` Did you mean: ${nearest.join(", ")}?`
          : // Deliberately does not name a tool. The MCP adapter calls this
            // capability `list_patterns` and the CLI calls it something else;
            // naming one here would put adapter vocabulary in engine output.
            " List the catalog to see the available patterns."),
    );
    this.requested = requested;
    this.nearest = nearest;
  }
}

export class UnknownOptionError extends CorrectableError {
  readonly code = "unknown_option";
  readonly option: string;
  readonly declared: readonly string[];

  constructor(option: string, declared: readonly string[]) {
    super(
      `Option "${option}" is not declared for this pattern. ` +
        `Declared options: ${declared.length > 0 ? declared.join(", ") : "(none)"}.`,
    );
    this.option = option;
    this.declared = declared;
  }
}

/**
 * An identifier role the pattern does not read.
 *
 * Separate from `UnknownOptionError` because the remedy is different: a mistyped option name is
 * usually a near miss on a name in the list, while an undeclared *identifier* is most often a
 * habit — `entity` supplied to every pattern, including the ones that emit a single module named
 * after themselves and have nothing to name after a caller's type. So the message distinguishes a
 * pattern that takes other roles from one that takes none at all, since the second is not a typo
 * and re-reading the list would not help.
 */
export class UnknownIdentifierError extends CorrectableError {
  readonly code = "unknown_identifier";
  readonly identifier: string;
  readonly declared: readonly string[];

  constructor(identifier: string, declared: readonly string[]) {
    super(
      declared.length > 0
        ? `Identifier "${identifier}" is not one this pattern generates around. ` +
            `Declared identifiers: ${declared.join(", ")}.`
        : `Identifier "${identifier}" is not used by this pattern, which takes none: it emits one ` +
            `module named after itself. Omit identifiers entirely.`,
    );
    this.identifier = identifier;
    this.declared = declared;
  }
}

export class InvalidOptionValueError extends CorrectableError {
  readonly code = "invalid_option_value";
  readonly option: string;
  readonly permitted: readonly string[];

  constructor(option: string, value: unknown, permitted: readonly string[]) {
    super(
      `Option "${option}" does not accept ${describeValue(value)}. ` +
        `Permitted values: ${permitted.join(", ")}.`,
    );
    this.option = option;
    this.permitted = permitted;
  }
}

export class IllegalCombinationError extends CorrectableError {
  readonly code = "illegal_combination";
  readonly rule: string;
  readonly alternatives: readonly string[];

  /**
   * `rule` and `alternatives` are surfaced verbatim from the catalogue rather
   * than reworded here (FR-009). The rule text is reviewed once, with the
   * pattern; paraphrasing it at the throw site is how the explanation a caller
   * sees drifts from the constraint actually enforced.
   */
  constructor(rule: string, alternatives: readonly string[]) {
    super(`${rule} Valid alternatives: ${alternatives.join(", ")}.`);
    this.rule = rule;
    this.alternatives = alternatives;
  }
}

export class InvalidIdentifierError extends CorrectableError {
  readonly code = "invalid_identifier";
  /** The role the value was supplied for, e.g. `entity`. */
  readonly field: string;
  /**
   * The value that was refused.
   *
   * Structured rather than left inside `message`, because an adapter that has to decide whether
   * echoing a caller value is safe cannot make that decision about a sentence. Without it, the MCP
   * adapter scrubbed every quoted span out of the message and a refusal named the role instead of
   * the value: "entity the supplied value is reserved", for a request that sent `Error`.
   */
  readonly value: string;
  /** The constraint alone, free of both the value and the role. */
  readonly rule: string;

  constructor(field: string, value: string, problem: string, rule: string) {
    super(problem);
    this.field = field;
    this.value = value;
    this.rule = rule;
  }
}

/**
 * The caller asked a single-module pattern to emit part of itself.
 *
 * Mechanically this is an unknown option — `emitScope` is declared only by patterns that split, which
 * the schema enforces in both directions — and `UnknownOptionError` would be accurate. It is a poor
 * answer, though: "not declared for this pattern, here are the options that are" leaves the caller to
 * infer why a pattern they know supports scopes elsewhere does not support them here, and the likely
 * next move is to ask again with a different scope. Saying what the pattern does instead ends the
 * exchange (US3 acceptance scenario 3).
 */
export class SplitUnsupportedError extends CorrectableError {
  readonly code = "split_unsupported";
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      `Pattern "${pattern}" emits a single module, so there is no scope to select. ` +
        `It has no machinery to share between domain types and no per-type binding to emit ` +
        `separately: request it without emitScope and the whole bundle is the answer.`,
    );
    this.pattern = pattern;
  }
}

export class MissingRequiredOptionError extends CorrectableError {
  readonly code = "missing_required_option";
  readonly option: string;
  /**
   * The condition that makes the option required, as a clause — `when emitScope is "binding-only"`.
   *
   * A field rather than only a sentence, because an adapter rebuilds what the caller reads from these
   * fields, and without it the best either surface could say was "required for this combination of
   * options": true, and useless to a caller trying to work out which part of their combination to
   * change. Our own literal text, never a caller value, so it is safe to surface verbatim (FR-009).
   */
  readonly because: string;
  /**
   * The ways out, as imperative clauses — `supply it`, `or request emitScope "full"`.
   *
   * Naming the option and the condition says what is wrong and leaves the caller to work out the move,
   * and there are always two: satisfy the requirement, or withdraw the setting that created it. The
   * second one is the one worth stating, because a caller who reached `binding-only` by copying an
   * example may not want the split at all, and without it the obvious next attempt is to guess a path.
   * Our own literal text, never a caller value, so it is surfaced verbatim (FR-009).
   */
  readonly resolutions: readonly string[];

  constructor(option: string, because: string, resolutions: readonly string[]) {
    super(`Option "${option}" is required ${because}. ${resolutions.join(", ")}.`);
    this.option = option;
    this.because = because;
    this.resolutions = resolutions;
  }
}

/**
 * A formatter option the caller may not set, or may not set to that.
 *
 * Correctable, and it was not: the class began life beside the allowlist that enforces it, extending
 * plain `Error`, so it fell through every adapter's classification and a caller who mistyped
 * `printWidth` was told the server had a defect. They were told to report it, and the message that
 * would have fixed their call in one round trip — the option named, the permitted ones enumerated — was
 * discarded on the way out.
 *
 * It lives here rather than with the allowlist for that reason. This file is the taxonomy adapters
 * branch on, and an error class defined outside it is one nothing will think to classify. The permitted
 * list arrives as an argument so the taxonomy does not have to import the formatter to describe it.
 */
export class FormatConfigError extends CorrectableError {
  readonly code = "unconfigurable_format_option";
  readonly option: string;
  readonly permitted: readonly string[];
  /**
   * Why this value in particular is refused, for an option that is otherwise configurable.
   *
   * Carried as a field rather than left inside `message` because the MCP adapter rebuilds what a caller
   * reads from these fields, and without it the two refusals here reached the caller as "printWidth
   * cannot be set here" beside a list naming `printWidth` as configurable — a contradiction the caller
   * cannot act on. MUST NOT interpolate an unvalidated caller value: it reaches a model verbatim, which
   * is the guarantee `safe` exists to keep, and the only caller text either of these quotes is a literal
   * they were matched against.
   */
  readonly reason: string | undefined;

  constructor(option: string, permitted: readonly string[], reason?: string) {
    super(
      reason ??
        `Prettier option "${option}" is not configurable here. ` +
          `Configurable options: ${permitted.join(", ")}.`,
    );
    this.option = option;
    this.permitted = permitted;
    this.reason = reason;
  }
}

/**
 * Two convention settings that are each valid and cannot both be honoured.
 *
 * Distinct from `IllegalCombinationError`, which is about a *pattern's* declared rules: those live in the
 * catalogue and differ per pattern, while these hold for every pattern because they are about the caller's
 * project rather than about what is being generated. Keeping them apart also keeps the refusal honest — a
 * caller told their combination is illegal for `result` would reasonably try another pattern.
 *
 * Named as a pair rather than as one offending field. There is no fact about which of the two is wrong:
 * a caller who set `runtime` to `browser` and `testFramework` to `node-test` may have meant either, so
 * naming one as the error picks a side, and the fix has to mention both anyway.
 */
export class ContradictoryConventionsError extends CorrectableError {
  readonly code = "contradictory_conventions";
  /** The two settings, as `field: value`, in the order the message names them. */
  readonly settings: readonly [string, string];
  /** Why they cannot both hold, written for the caller. */
  readonly conflict: string;
  /** What to change, naming both directions, since either may be the one they meant. */
  readonly resolutions: readonly string[];

  constructor(
    settings: readonly [string, string],
    conflict: string,
    resolutions: readonly string[],
  ) {
    super(
      `Conventions ${settings[0]} and ${settings[1]} contradict each other: ${conflict} ` +
        `Change one of: ${resolutions.join("; ")}.`,
    );
    this.settings = settings;
    this.conflict = conflict;
    this.resolutions = resolutions;
  }
}

/**
 * The runtime is too old to execute a generated test safely.
 *
 * Neither of the two kinds above, which is why it needs its own class rather than either. The caller's
 * request is fine and would succeed elsewhere, so calling it correctable would send an agent looking
 * for a field to change; and the catalogue is fine, so reporting it as a defect in the pattern — which
 * is what happened before this existed — sends a bug report about our code for someone else's Node
 * version. It is the operator's to fix, and the message names what they have to do.
 *
 * `correctable` is false because the flag means "can the caller fix this by changing the request", and
 * they cannot. The distinction between our defect and the environment's is carried by the code.
 */
export class UnsupportedRuntimeError extends EngineError {
  readonly code = "unsupported_runtime";
  readonly correctable = false;
  readonly required: string;
  readonly running: string;

  constructor(required: string, running: string) {
    super(
      `Generated tests cannot be executed on Node ${running}. They run inside Node's permission ` +
        `model, which is how a bundle is proved to work without being granted the filesystem, and the ` +
        `flag enabling it is not recognised before Node ${required}. Upgrade the runtime.`,
    );
    this.required = required;
    this.running = running;
  }
}

/**
 * The generated bundle failed to compile, or its own tests failed.
 *
 * Always our defect, never the caller's (Principle III). The caller asked for a
 * legal combination and we produced something broken, so the message says so
 * plainly instead of implying they can fix it.
 *
 * Diagnostics are carried for our logs and are deliberately absent from
 * `message` (FR-038). Compiler output names paths inside the verification
 * sandbox and refers to files the caller never receives; returning it invites an
 * agent to "fix" code it cannot see.
 */
export class VerificationError extends EngineError {
  readonly code = "verification_failed";
  readonly correctable = false;
  /** For our logs only. Never rendered into a caller-facing response. */
  readonly diagnostics: readonly string[];
  readonly correlationId: string;
  readonly stage: "typecheck" | "tests";

  /**
   * `correlationId` is supplied by the caller rather than generated here. A
   * generated one would need a clock or a random source, which would make the
   * same failing request produce a different message every run and put a
   * non-deterministic value on the engine's own error path.
   */
  constructor(
    stage: "typecheck" | "tests",
    correlationId: string,
    diagnostics: readonly string[],
  ) {
    super(
      `Generated code failed ${stage === "typecheck" ? "to compile" : "its tests"}. ` +
        `This is a defect in the pattern, not in your request. ` +
        `Reference ${correlationId} when reporting it.`,
    );
    this.stage = stage;
    this.correlationId = correlationId;
    this.diagnostics = diagnostics;
  }
}

/** Narrowing helper for adapters. */
export function isCorrectable(error: unknown): error is CorrectableError {
  return error instanceof EngineError && error.correctable;
}

/**
 * Describes a rejected value without echoing it unbounded — an error that
 * reflects arbitrary caller input back at full length is its own amplification
 * vector.
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    const shown = value.length <= 32 ? value : `${value.slice(0, 32)}…`;
    return `"${shown}"`;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  if (value === undefined) {
    return "no value";
  }
  return `a value of type ${typeof value}`;
}
