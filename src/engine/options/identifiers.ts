/**
 * Validation of caller-supplied identifiers before they reach generation
 * (FR-032, FR-033).
 *
 * Two things are being prevented. The obvious one is uncompilable output: a
 * reserved word interpolated into a declaration site cannot parse. The less
 * obvious one is injection — an identifier is the one caller-controlled string
 * that lands in code and in file paths, so the accepted shape is an allowlist
 * pattern rather than an escaping pass. Nothing outside `[A-Za-z0-9_$]` gets
 * through, which also rules out path separators and traversal sequences.
 */

/** Deliberately ASCII-only. See `checkIdentifier`. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The default cap. Long enough for any real domain name, short enough that a
 * derived member or file name built from it stays within filesystem limits after
 * the derivation table appends suffixes.
 */
export const MAX_IDENTIFIER_LENGTH = 64;

/** Reserved and strictly-reserved words: unusable at a declaration site. */
const RESERVED_WORDS: readonly string[] = [
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "arguments",
  "eval",
];

/**
 * TypeScript's built-in type names. Legal identifiers, so the compiler accepts
 * them at a declaration site — but a class named `string` shadows the type in
 * every annotation the same bundle emits, and the result does not compile. They
 * are refused for the same reason keywords are, just one step later.
 */
const TYPE_NAMES: readonly string[] = [
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
];

/**
 * Globals a generated bundle refers to by name. Shadowing one is legal and
 * compiles, then fails at the point the bundle's own machinery tries to use it —
 * a failure that surfaces far from its cause, so it is refused up front.
 */
const SHADOWED_GLOBALS: readonly string[] = [
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Function",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "WeakMap",
  "WeakSet",
  "globalThis",
];

const DENYLIST: ReadonlySet<string> = new Set([
  ...RESERVED_WORDS,
  ...TYPE_NAMES,
  ...SHADOWED_GLOBALS,
]);

export interface IdentifierCheckOptions {
  /**
   * Additional names to refuse — in practice the identifiers the requested
   * pattern itself emits. A domain name colliding with a generated helper
   * produces uncompilable output just as surely as a keyword does, and the
   * generator is the only party that knows what it is about to emit.
   */
  readonly reserved?: Iterable<string>;
  readonly maxLength?: number;
  /** Used in messages, e.g. `entityName`. */
  readonly label?: string;
}

export type IdentifierCheck =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Checks one identifier, reporting the first rule it breaks.
 *
 * Rules are applied in a fixed order so that a given input always produces the
 * same message: a caller correcting a refusal should not see the complaint
 * change underneath them.
 *
 * Returns a result rather than throwing. The error taxonomy is defined in
 * T014's `errors.ts`; mapping a broken rule onto a caller-correctable error is
 * that module's job, not this one's.
 */
export function checkIdentifier(
  value: string,
  options: IdentifierCheckOptions = {},
): IdentifierCheck {
  const label = options.label ?? "identifier";
  const maxLength = options.maxLength ?? MAX_IDENTIFIER_LENGTH;

  if (value.length === 0) {
    return { ok: false, problem: `${label} must not be empty` };
  }

  if (value.length > maxLength) {
    return {
      ok: false,
      problem: `${label} "${truncate(value)}" is ${value.length} characters; the limit is ${maxLength}`,
    };
  }

  if (!IDENTIFIER.test(value)) {
    return {
      ok: false,
      problem:
        `${label} "${truncate(value)}" is not a valid identifier; it must match ` +
        `${IDENTIFIER.source} — ASCII letters, digits, underscore and dollar only, ` +
        `not starting with a digit`,
    };
  }

  if (DENYLIST.has(value)) {
    return {
      ok: false,
      problem: `${label} "${value}" is reserved and cannot be used as a generated name`,
    };
  }

  for (const reserved of options.reserved ?? []) {
    if (reserved === value) {
      return {
        ok: false,
        problem:
          `${label} "${value}" collides with an identifier this pattern emits; ` +
          `choose another name`,
      };
    }
  }

  return { ok: true };
}

/** Whether `value` is refused by the built-in denylist. */
export function isReservedIdentifier(value: string): boolean {
  return DENYLIST.has(value);
}

/**
 * Truncated for messages. An unbounded echo of caller input into an error is
 * how a refusal becomes its own denial-of-service.
 */
function truncate(value: string, limit = 32): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
