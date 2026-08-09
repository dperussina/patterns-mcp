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
  | "invalid_identifier"
  | "missing_required_option"
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
  readonly field: string;

  constructor(field: string, problem: string) {
    super(problem);
    this.field = field;
  }
}

export class MissingRequiredOptionError extends CorrectableError {
  readonly code = "missing_required_option";
  readonly option: string;

  constructor(option: string, because: string) {
    super(`Option "${option}" is required ${because}.`);
    this.option = option;
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
