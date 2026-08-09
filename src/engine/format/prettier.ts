/**
 * Formatting. One Prettier configuration, applied to every emitted file, so
 * formatting is never a source of output variation (Principle I).
 *
 * Two properties of Prettier's own API are load-bearing here, and both were
 * verified rather than assumed:
 *
 * 1. A `plugins` entry in an options object is `import()`ed. Passing caller
 *    configuration through unfiltered would therefore turn a style setting into
 *    an arbitrary-module-loading surface. Options are an allowlist for that
 *    reason, not for tidiness.
 * 2. `endOfLine: "auto"` preserves whatever line endings the input had, which
 *    makes output bytes a function of the input's encoding. It is refused.
 *
 * `resolveConfig` is never called. It walks the filesystem upwards looking for
 * a `.prettierrc`, which would make generated output depend on where the process
 * happens to be running.
 */
import * as prettier from "prettier";

/**
 * Style options a caller may set.
 *
 * An allowlist rather than a denylist: a denylist would have to anticipate every
 * present and future Prettier option that loads code or reads the filesystem,
 * and miss exactly one to be wrong.
 */
const ALLOWED_OPTIONS = [
  "arrowParens",
  "bracketSameLine",
  "bracketSpacing",
  "endOfLine",
  "experimentalTernaries",
  "jsxSingleQuote",
  "objectWrap",
  "printWidth",
  "quoteProps",
  "semi",
  "singleAttributePerLine",
  "singleQuote",
  "tabWidth",
  "trailingComma",
  "useTabs",
] as const;

export type AllowedOption = (typeof ALLOWED_OPTIONS)[number];

const ALLOWED = new Set<string>(ALLOWED_OPTIONS);

/**
 * Pinned regardless of caller configuration.
 *
 * `parser` is fixed because every file we emit is TypeScript; letting a caller
 * change it would mean formatting our output as another language. Everything
 * else is left at Prettier's own defaults deliberately — inventing a house style
 * here would impose it on every consumer, and a caller who wants one can say so.
 */
const PINNED_OPTIONS = {
  parser: "typescript",
} as const satisfies prettier.Options;

/** Thrown when generated source cannot be parsed. Always our defect. */
export class FormatError extends Error {
  /** Prettier's message, for logs. Kept off `message` per FR-038. */
  readonly detail: string;

  constructor(detail: string) {
    super(
      "Generated source could not be formatted, which means it is not valid TypeScript.",
    );
    this.name = "FormatError";
    this.detail = detail;
  }
}

/**
 * Validates and merges caller style options.
 *
 * Unknown keys are refused rather than dropped, for the same reason unknown
 * options are refused in `resolve.ts`: a silently ignored setting leaves the
 * caller believing they configured something that had no effect.
 */
export function mergeFormatOptions(
  callerConfig: Readonly<Record<string, unknown>> = {},
): prettier.Options {
  const merged: Record<string, unknown> = {};

  for (const key of Object.keys(callerConfig).toSorted(compare)) {
    if (!ALLOWED.has(key)) {
      throw new FormatConfigError(key);
    }

    const value = callerConfig[key];

    if (key === "endOfLine" && value === "auto") {
      throw new FormatConfigError(
        "endOfLine",
        '"auto" makes output depend on the line endings of the input. Use "lf" or "crlf".',
      );
    }

    merged[key] = value;
  }

  return { ...merged, ...PINNED_OPTIONS };
}

export class FormatConfigError extends Error {
  readonly option: string;

  constructor(option: string, reason?: string) {
    super(
      reason ??
        `Prettier option "${option}" is not configurable here. ` +
          `Configurable options: ${ALLOWED_OPTIONS.join(", ")}.`,
    );
    this.name = "FormatConfigError";
    this.option = option;
  }
}

/**
 * Formats one file's source.
 *
 * Prettier's parse errors carry code frames and absolute paths, so the thrown
 * error keeps them on a separate property rather than in `message` (FR-038).
 */
export async function formatSource(
  source: string,
  callerConfig: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const options = mergeFormatOptions(callerConfig);

  try {
    return await prettier.format(source, options);
  } catch (cause) {
    throw new FormatError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

let warming: Promise<void> | undefined;

/**
 * Loads Prettier's TypeScript parser ahead of first use.
 *
 * Prettier 3 resolves parsers lazily, so without this the first request of a
 * process pays the load cost. Idempotent, and safe to call concurrently: the
 * promise is cached rather than the work repeated.
 *
 * This is a cache, not state. Warming carries nothing between requests — every
 * call to `formatSource` supplies its complete option set (contracts §4).
 */
export async function warmFormatter(): Promise<void> {
  warming ??= prettier
    .format("const warm = 1;\n", PINNED_OPTIONS)
    .then(() => undefined);
  await warming;
}

/**
 * The exact formatter a bundle was produced with, for its verification record. Read from Prettier
 * itself rather than from our own package manifest, so it cannot drift from the version that actually
 * formatted the bytes.
 */
export function formatterVersion(): string {
  return `prettier@${prettier.version}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
