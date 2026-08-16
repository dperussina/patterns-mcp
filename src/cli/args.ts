/**
 * The command line, parsed into a request the engine already understands (contracts/cli.md).
 *
 * Pure, and separate from `run.ts` for one reason: every interesting question about a command line —
 * whether `--identifier entity=User` reaches the right field, whether an unknown flag is a usage error
 * rather than a silently ignored string, whether `--no-tests` and `--option includeTests=true` disagree —
 * is answerable without a filesystem, a compiler, or a spawned process. Tests that had to generate a
 * bundle to check argument handling would take seconds each and would fail for reasons that had nothing
 * to do with arguments.
 *
 * Every flag is the same name and the same value space as its `generate_pattern` field, so that what a
 * caller learns from `describe` transfers in both directions (contracts/cli.md). The two surfaces reach
 * the same engine with the same values, which is what makes the parity test a real check rather than a
 * comparison of two independent implementations.
 */

import { parseArgs } from "node:util";

import { safe } from "../refusals.js";

import type { GenerateRequest } from "../engine/generate/index.js";
import type { ListFilters } from "../engine/catalog/list.js";
import type { Option } from "../engine/catalog/schema.js";

/** Raised for a command line that cannot be parsed at all — exit `2`, distinct from a refusal. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ListCommand {
  readonly command: "list";
  readonly filters: ListFilters;
  readonly json: boolean;
}

export interface DescribeCommand {
  readonly command: "describe";
  readonly pattern: string;
  readonly json: boolean;
}

export interface GenerateCommand {
  readonly command: "generate";
  /** Everything the command line could express with the types the engine wants. Options are not here. */
  readonly request: GenerateRequest;
  /**
   * The `--option` values as they arrived: strings, because that is all a command line carries.
   *
   * Kept separate from `request` because giving them back their declared types needs the catalogue, and
   * this module is pure — `run.ts` does the conversion with `retypeOptions` and puts them in the request.
   * `undefined` when none were supplied, which is distinct from an empty record: an empty `options` in a
   * request is a claim that the caller set some.
   */
  readonly optionStrings: Readonly<Record<string, string>> | undefined;
  readonly json: boolean;
  readonly dryRun: boolean;
  /** Where a bundle is written when neither `--json` nor `--dry-run` is given. */
  readonly out: string;
  /** Read here rather than in the engine, so that generation stays pure (contracts/cli.md). */
  readonly conventionsPath: string | undefined;
}

export interface HelpCommand {
  readonly command: "help";
  /** Set when help is being shown because the caller asked, rather than because they erred. */
  readonly requested: boolean;
}

export type Command = ListCommand | DescribeCommand | GenerateCommand | HelpCommand;

/**
 * Flags shared by every subcommand, declared once.
 *
 * `parseArgs` is strict, so an unknown flag throws and becomes a usage error. That is the behaviour worth
 * having: a mistyped `--emit-scop` that parsed and was ignored would generate a full bundle and report
 * success, which is the same silent-ignore failure the tool schemas were made strict to prevent
 * (FR-051).
 */
const COMMON = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const LIST_FLAGS = {
  ...COMMON,
  category: { type: "string" },
  kind: { type: "string" },
  tier: { type: "string" },
} as const;

const GENERATE_FLAGS = {
  ...COMMON,
  variant: { type: "string" },
  "emit-scope": { type: "string" },
  "core-module": { type: "string" },
  "error-mode": { type: "string" },
  async: { type: "string" },
  cancellation: { type: "string" },
  "no-tests": { type: "boolean" },
  identifier: { type: "string", multiple: true },
  option: { type: "string", multiple: true },
  conventions: { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

/**
 * Flags that are pattern options under another spelling, and the option each one sets.
 *
 * A table rather than a chain of `if`s so that the mapping is one fact in one place: the flag name, the
 * option name, and nothing else. Values are passed through untouched — the engine owns which values an
 * option permits, and a CLI that pre-validated them would be a second copy of the value space, free to
 * disagree with the catalogue about what `errorMode` accepts.
 */
const OPTION_FLAGS: readonly (readonly [keyof typeof GENERATE_FLAGS, string])[] = [
  ["emit-scope", "emitScope"],
  ["core-module", "coreModule"],
  ["error-mode", "errorMode"],
  ["async", "async"],
  ["cancellation", "cancellation"],
];

export function parseCommand(argv: readonly string[]): Command {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return { command: "help", requested: subcommand !== undefined };
  }

  switch (subcommand) {
    case "list":
      return parseList(rest);
    case "describe":
      return parseDescribe(rest);
    case "generate":
      return parseGenerate(rest);
    case "help":
      return { command: "help", requested: true };
    default:
      throw new UsageError(
        `Unknown command "${trimmed(subcommand)}". Expected list, describe, or generate.`,
      );
  }
}

function parseList(argv: readonly string[]): Command {
  const { values, positionals } = guardUsage(() =>
    parseArgs({ args: [...argv], options: LIST_FLAGS, allowPositionals: true, strict: true }),
  );

  if (values.help === true) return { command: "help", requested: true };
  if (positionals.length > 0) {
    throw new UsageError(
      `list takes no arguments, but received "${trimmed(positionals[0] ?? "")}". ` +
        `Filters are flags: --category, --kind, --tier.`,
    );
  }

  return {
    command: "list",
    // Cast rather than validated: `listPatterns` filters on equality, so a category that does not exist
    // yields an empty list, which is the documented answer for a filter nothing matches. Rejecting it
    // here would put a copy of the category vocabulary in the CLI.
    filters: {
      ...(values.category === undefined ? {} : { category: values.category as never }),
      ...(values.kind === undefined ? {} : { kind: values.kind as never }),
      ...(values.tier === undefined ? {} : { tier: tierOf(values.tier) }),
    },
    json: values.json === true,
  };
}

function parseDescribe(argv: readonly string[]): Command {
  const { values, positionals } = guardUsage(() =>
    parseArgs({ args: [...argv], options: COMMON, allowPositionals: true, strict: true }),
  );

  if (values.help === true) return { command: "help", requested: true };

  const pattern = positionals[0];
  if (pattern === undefined) {
    throw new UsageError("describe needs a pattern name: patterns describe <pattern>.");
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `describe takes one pattern, but received ${String(positionals.length)}. ` +
        `Name them one call at a time.`,
    );
  }

  return { command: "describe", pattern, json: values.json === true };
}

function parseGenerate(argv: readonly string[]): Command {
  const { values, positionals } = guardUsage(() =>
    parseArgs({ args: [...argv], options: GENERATE_FLAGS, allowPositionals: true, strict: true }),
  );

  if (values.help === true) return { command: "help", requested: true };

  const pattern = positionals[0];
  if (pattern === undefined) {
    throw new UsageError("generate needs a pattern name: patterns generate <pattern> [options].");
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `generate takes one pattern, but received ${String(positionals.length)}. ` +
        `Identifiers and options are flags: --identifier key=value, --option key=value.`,
    );
  }

  const options: Record<string, string> = {};

  for (const [flag, option] of OPTION_FLAGS) {
    const value = values[flag];
    if (typeof value === "string") options[option] = value;
  }

  // `--no-tests` before `--option`, so that an explicit `--option includeTests=...` wins. The same
  // precedence the MCP adapter gives the explicit record over its flat fields, and for the same reason:
  // a caller who wrote both expressed one intention, and the more specific spelling is the one they
  // reached for deliberately.
  //
  // `"false"` rather than `false`, so that everything here is a string and one conversion handles the
  // lot. A boolean smuggled in beside the strings would make the record's type a lie and would be the
  // one value `retypeOptions` never saw.
  if (values["no-tests"] === true) options["includeTests"] = "false";

  Object.assign(options, pairs(values.option, "--option"));

  const identifiers = pairs(values.identifier, "--identifier");

  return {
    command: "generate",
    request: {
      pattern,
      ...(values.variant === undefined ? {} : { variant: values.variant }),
      ...(Object.keys(identifiers).length === 0 ? {} : { identifiers }),
    },
    optionStrings: Object.keys(options).length === 0 ? undefined : options,
    json: values.json === true,
    dryRun: values["dry-run"] === true,
    out: values.out ?? ".",
    conventionsPath: values.conventions,
  };
}

/**
 * Option values retyped against what the pattern declares.
 *
 * Every argument on a command line is a string, and most option values are strings, so this looks
 * unnecessary until a boolean appears: `--option includeTests=false` sent `"false"`, the engine compared
 * it against the declared `false`, and the call was refused with "does not accept that value. Permitted
 * values: true, false" — naming the value the caller had just written. `includeTests` is declared by
 * nearly every pattern, so no CLI caller could suppress a test suite except through `--no-tests`, and
 * nothing said why.
 *
 * The conversion reads the catalogue rather than guessing: a supplied string becomes the declared value
 * whose own spelling it matches. That is what distinguishes it from coercing `"false"` to `false`
 * unconditionally — an option that genuinely declared the *string* `"false"` would still receive a
 * string, and a value matching nothing declared is passed through untouched so the engine produces its
 * usual refusal, with the permitted list, rather than this inventing a worse one.
 *
 * Options the catalogue does not declare are also passed through: `UnknownOptionError` is a better
 * answer than a silent drop, and it is the engine's to raise.
 */
export function retypeOptions(
  supplied: Readonly<Record<string, string>>,
  declared: readonly Option[],
): Readonly<Record<string, unknown>> {
  const retyped: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(supplied)) {
    retyped[name] = retype(value, declared.find((option) => option.name === name)?.type);
  }

  return retyped;
}

function retype(value: string, type: Option["type"] | undefined): unknown {
  switch (type) {
    case "boolean":
      // Only the two spellings the engine would accept. Anything else stays a string and is refused by
      // name, rather than being coerced by truthiness into the opposite of what was asked for — which is
      // how `--option includeTests=no` would otherwise have switched tests *on*.
      return value === "true" ? true : value === "false" ? false : value;

    case "integer": {
      // `Number` alone accepts `"0x10"`, `" 7 "`, and `"1e3"`, none of which a caller writing an integer
      // meant; and it maps `""` to zero. The pattern is the narrow one so that anything else reaches the
      // engine as a string and is refused.
      const integer = /^-?\d+$/u.test(value) ? Number(value) : undefined;
      return integer ?? value;
    }

    // An enum's values are strings, a string option's value is a string, and an option the catalogue does
    // not declare is not ours to interpret — `UnknownOptionError` is a better answer than a guess.
    default:
      return value;
  }
}

/**
 * `key=value` repeated, folded into a record.
 *
 * Values may contain `=` — a `--option` whose value is a path or an expression legitimately does — so
 * only the first one separates. A missing `=` is a usage error rather than a key with an empty value,
 * because `--identifier entity` is much more likely a caller who forgot the value than one who meant to
 * send an empty string, and generating from the second interpretation would name things after nothing.
 */
function pairs(
  supplied: readonly string[] | undefined,
  flag: string,
): Record<string, string> {
  const record: Record<string, string> = {};

  for (const entry of supplied ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new UsageError(
        `${flag} expects key=value, but received "${trimmed(entry)}". ` +
          `For example: ${flag} entity=Order.`,
      );
    }
    record[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return record;
}

/**
 * A tier as the engine types it.
 *
 * The one filter value parsed here rather than passed through, because it is the one whose *type* the
 * command line cannot carry: every argument is a string, and `listPatterns` compares tier against a
 * number. `"2"` would match nothing and report an empty catalogue, which is a wrong answer rather than a
 * refusal — the failure mode this converts into a usage error.
 */
function tierOf(value: string): 1 | 2 | 3 {
  if (value === "1" || value === "2" || value === "3") return Number(value) as 1 | 2 | 3;
  throw new UsageError(`--tier expects 1, 2, or 3, but received "${trimmed(value)}".`);
}

/**
 * `parseArgs` with its failures translated, and with its inference intact.
 *
 * The callback exists so that `parseArgs` sees each flag table as a literal and infers `string` where the
 * table says `string`. An earlier version took the table as a generic parameter and returned a mapped
 * type, which typechecked and then made every value `string | boolean | string[]` at the call sites —
 * pushing casts into the parsing logic, which is the one place they would hide a real mistake.
 */
function guardUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? withoutEcho(error.message) : "unparseable arguments",
    );
  }
}

/**
 * `parseArgs`'s own wording, with the token it quotes put through the same test every other caller value
 * on either surface is put through (FR-035).
 *
 * Its messages are well written and name the offending flag, which is why they are kept. What they also
 * do is echo that flag unbounded: `--ignore previous instructions and…` is a single argv element, so
 * `Unknown option '<all of it>'` is a verbatim reflection of caller prose into stderr. This file
 * previously called that safe because a terminal is not a model's context, but the CLI exists to be
 * driven by an agent (contracts/cli.md) and an agent reads captured stderr, so the exemption was
 * arguing against the reason the surface is here.
 *
 * The token is always single-quoted by `parseArgs`, which is what makes substitution possible without
 * reconstructing its messages. Nothing depends on that holding: a message it stopped quoting would
 * simply pass through unchanged and stay subject to the length bound.
 */
function withoutEcho(message: string): string {
  // Not `trimmed`, which bounds a *value* at 40 characters and would cut these sentences mid-word. The
  // substitution above already bounds every caller-supplied part of the message, so this is a backstop
  // against wording we have not seen rather than the mechanism.
  const sanitised = message.replaceAll(/'([^']*)'/gu, (_, token: string) => safe(token));
  return sanitised.length <= 200 ? sanitised : `${sanitised.slice(0, 200)}…`;
}

/**
 * Caller text bounded before it is quoted back.
 *
 * The same rule as FR-035 on the MCP side, for the same reason and one more: a usage error is written
 * before anything has been validated, so the value in it is the least trustworthy string the program
 * ever holds, and an unbounded echo of it is how a terminal ends up rendering someone's paste.
 */
function trimmed(value: string): string {
  const collapsed = value.replaceAll(/\s+/gu, " ");
  return collapsed.length <= 40 ? collapsed : `${collapsed.slice(0, 40)}…`;
}
