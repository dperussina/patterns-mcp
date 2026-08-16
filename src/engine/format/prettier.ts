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
 *
 * The import is `prettier/standalone` with the two plugins named, rather than `prettier`. The full entry
 * registers every language Prettier supports, so the bundler inlined parsers for Babel, Flow, Markdown,
 * YAML, HTML, PostCSS, GraphQL, Angular and Glimmer — about three megabytes shipped to format the one
 * language this project emits. Standalone also cannot reach the filesystem for a config file or resolve a
 * plugin by name, which is the property the paragraphs above describe wanting; getting it structurally is
 * better than getting it by never calling the function that would.
 *
 * Byte-for-byte identical output, which is not an assumption: the golden and determinism suites compare
 * every pattern's every option combination against recorded bytes, so a formatter that printed anything
 * differently would fail several hundred assertions rather than none.
 */
import * as prettier from "prettier/standalone";
import * as estree from "prettier/plugins/estree";
import * as typescript from "prettier/plugins/typescript";

import type { Options } from "prettier";

import { FormatConfigError } from "../errors.js";
import { DEFAULT_PRINT_WIDTH, reflowComments } from "./reflow.js";

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
 * The narrowest width every pattern is verified at.
 *
 * Not a style opinion — a statement about what can be proven. A `@ts-expect-error` asserts about the
 * line below it, so a width that wraps that line moves the assertion off the expression it was written
 * for: the directive is reported unused and the error it suppressed escapes, and the pattern fails its
 * own verification. Three patterns do that below this width, and the caller who set it would receive
 * `Generated code failed to compile`, which blames us and tells them nothing to change. Refusing here
 * names the setting instead. 40 is already far narrower than a project uses — Prettier's own default is
 * 80 — so the floor costs a real caller nothing and is swept at 40, 80 and 120 by
 * `test/conformance/conventions.test.ts`.
 */
const MINIMUM_PRINT_WIDTH = 40;

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
  /**
   * Named here because standalone registers nothing on its own.
   *
   * Module objects rather than the strings a `.prettierrc` would use, which is what keeps the warning at
   * the top of this file true: a string is resolved and `import()`ed, and these are already-loaded
   * modules. Pinned alongside `parser` for the same reason — a caller cannot substitute either, and the
   * allowlist refuses `plugins` before this merge is even reached.
   *
   * `estree` is the printer every JavaScript-family language shares; `typescript` is only the parser.
   * Omitting it produces "couldn't find a printer for the language" rather than unformatted output.
   */
  plugins: [typescript, estree],
} as const satisfies Options;

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
): Options {
  const merged: Record<string, unknown> = {};

  for (const key of Object.keys(callerConfig).toSorted(compare)) {
    if (!ALLOWED.has(key)) {
      throw new FormatConfigError(key, ALLOWED_OPTIONS);
    }

    const value = callerConfig[key];

    if (key === "printWidth" && typeof value === "number" && value < MINIMUM_PRINT_WIDTH) {
      throw new FormatConfigError(
        "printWidth",
        ALLOWED_OPTIONS,
        `${String(MINIMUM_PRINT_WIDTH)} is the narrowest width the generated code is verified at. ` +
          `Below it, a wrapped line can carry a type-level assertion away from the expression it ` +
          `asserts about, which fails the pattern's own verification.`,
      );
    }

    if (key === "endOfLine" && value === "auto") {
      throw new FormatConfigError(
        "endOfLine",
        ALLOWED_OPTIONS,
        '"auto" makes output depend on the line endings of the input. Use "lf" or "crlf".',
      );
    }

    merged[key] = value;
  }

  return { ...merged, ...PINNED_OPTIONS };
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
    const formatted = await prettier.format(source, options);
    // Prettier reflows code and never comments, so this is the only step that can hold a generated
    // comment to the width its code was formatted to. See reflow.ts for why a template cannot.
    return reflowComments(formatted, printWidthOf(options));
  } catch (cause) {
    throw new FormatError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function printWidthOf(options: Options): number {
  return typeof options.printWidth === "number"
    ? options.printWidth
    : DEFAULT_PRINT_WIDTH;
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
 *
 * The standalone entry exports `version` at runtime but omits it from its declarations, so it is read
 * defensively rather than cast. Throwing beats writing `prettier@undefined` into a header a caller may
 * later use to reproduce the bundle: a provenance line that names no formatter is worse than absent,
 * because it looks like an answer.
 */
export function formatterVersion(): string {
  const reported = (prettier as { version?: unknown }).version;

  if (typeof reported !== "string") {
    throw new Error(
      "prettier/standalone reported no version, so the provenance header cannot name the formatter.",
    );
  }

  return `prettier@${reported}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
