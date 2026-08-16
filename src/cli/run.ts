/**
 * The CLI, as a function of its arguments and its streams (contracts/cli.md).
 *
 * Principle X in one file: this is a thin adapter over the same engine the MCP server calls, holding no
 * generation logic of its own. What it does hold is everything MCP does differently — exit codes instead
 * of `isError`, files on disk instead of a response, a terminal rendering instead of Markdown — and the
 * test that the two surfaces have not diverged compares their `--json` output byte for byte (T073).
 *
 * Streams and `exists` are parameters rather than reached for, so the whole surface is testable in
 * process. A CLI tested only by spawning it is a CLI whose failure modes are tested by string matching
 * against a terminal, and the interesting cases here — a collision refusal, an exit code, a refusal
 * written to stderr while stdout stays parseable — are all cheaper and clearer to assert directly.
 */

import { access, readFile } from "node:fs/promises";

// Through the engine's public API rather than its internals, so the CLI is held to the same surface a
// third-party consumer gets: the catalogue-bound `listPatterns` and `describePattern` are defined there,
// and reaching past them would mean this adapter loading its own copy of the catalogue.
import { describePattern, generate, listCatalogue } from "../index.js";
import { EngineError } from "../engine/errors.js";
import { detailOf, messageFor, referenceFor, safe } from "../refusals.js";
import { UsageError, parseCommand, retypeOptions } from "./args.js";
import { HELP, renderAdvisory, renderBundle, renderDetail, renderList } from "./render.js";
import { WriteRefusedError, destinations, displayPath, writeBundle } from "./write.js";

import type { Command, GenerateCommand } from "./args.js";

/**
 * Exit codes, as documented (contracts/cli.md, "Exit codes").
 *
 * `SUCCESS` covers advice: an advisory answer is the correct response to a legitimate question, and a
 * non-zero exit would make every script treat it as a failure and stop (FR-022).
 *
 * `INTERNAL` is `70` — `EX_SOFTWARE` from sysexits — and is kept distinct from `1` because the two ask
 * different things of whoever sees them. `1` means change the request; `70` means the request was fine
 * and we broke, so report it rather than retrying.
 */
export const EXIT = {
  SUCCESS: 0,
  CORRECTABLE: 1,
  USAGE: 2,
  INTERNAL: 70,
} as const;

/**
 * How this surface names what a caller should do next. The MCP counterpart is in `mcp/errors.ts`.
 *
 * A refusal telling someone at a shell prompt to "call list_patterns" names something they cannot
 * invoke. This is the only licensed difference between the two surfaces' refusals, and the parity suite
 * normalises exactly these clauses before comparing the rest.
 */
const VOCABULARY = {
  listCatalogue: "Run `patterns list`",
  describePattern: "Run `patterns describe <pattern>`",
} as const;

export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Environment {
  /** Injected so a test can describe a filesystem without building one. */
  exists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
}

export async function run(
  argv: readonly string[],
  streams: Streams,
  environment: Environment = {},
): Promise<number> {
  const exists = environment.exists ?? defaultExists;
  const read = environment.readFile ?? (async (path: string) => await readFile(path, "utf8"));

  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      streams.err(`${error.message}\n\nRun \`patterns --help\` for usage.\n`);
      return EXIT.USAGE;
    }
    throw error;
  }

  try {
    switch (command.command) {
      case "help":
        // Requested help is an answer and goes to stdout; help shown because nothing was asked is a
        // prompt, and a script piping stdout should not receive it as output.
        (command.requested ? streams.out : streams.err)(HELP);
        return command.requested ? EXIT.SUCCESS : EXIT.USAGE;

      case "list": {
        // `listCatalogue` rather than `listPatterns`, because `--json` is promised to be byte-comparable
        // against what MCP puts in `structuredContent` (contracts/cli.md) and that is the envelope, count
        // and all. Printing the bare array was a divergence a script would hit on its first parse.
        const result = await listCatalogue(command.filters);
        streams.out(command.json ? `${json(result)}\n` : renderList(result.patterns));
        return EXIT.SUCCESS;
      }

      case "describe": {
        const detail = await describePattern(command.pattern);
        streams.out(command.json ? `${json(detail)}\n` : renderDetail(detail));
        return EXIT.SUCCESS;
      }

      case "generate":
        return await runGenerate(command, streams, exists, read);
    }
  } catch (error) {
    return report(error, streams);
  }
}

async function runGenerate(
  command: GenerateCommand,
  streams: Streams,
  exists: (path: string) => Promise<boolean>,
  read: (path: string) => Promise<string>,
): Promise<number> {
  const conventions = await conventionsFrom(command.conventionsPath, read);
  const options = await typedOptions(command);

  const result = await generate({
    ...command.request,
    ...(options === undefined ? {} : { options }),
    ...(conventions === undefined ? {} : { conventions }),
  });

  // `--json` prints the structure and writes nothing, on both kinds of result. The engine's value
  // verbatim, with no field added or renamed, which is what makes it comparable to MCP's
  // `structuredContent` (SC-010).
  if (command.json) {
    streams.out(`${json(result)}\n`);
    return EXIT.SUCCESS;
  }

  if (result.kind === "advisory") {
    streams.out(renderAdvisory(result));
    return EXIT.SUCCESS;
  }

  if (command.dryRun) {
    const would = destinations(result, command.out).map(displayPath);
    streams.out(renderBundle(result, would, true));
    return EXIT.SUCCESS;
  }

  const written = await writeBundle(result, command.out, exists);
  streams.out(renderBundle(result, written.map(displayPath), false));
  return EXIT.SUCCESS;
}

/**
 * The `--option` values, given back the types the command line took from them.
 *
 * The catalogue is consulted here rather than in `args.ts` because the parser is pure and this needs to
 * know what the pattern declares. `describePattern` is the same call a caller would make, and the
 * catalogue is loaded once per process, so this costs a lookup rather than a read.
 *
 * An unknown pattern is left to `generate`, which refuses it with the nearest names — the answer this
 * caller needs, and one that would be worse if raised from here, where it would arrive before the
 * options had even been considered.
 */
async function typedOptions(
  command: GenerateCommand,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const supplied = command.optionStrings;
  if (supplied === undefined) return undefined;

  try {
    const detail = await describePattern(command.request.pattern);
    return retypeOptions(supplied, detail.options);
  } catch {
    return supplied;
  }
}

/**
 * The conventions file, read here in the adapter (contracts/cli.md).
 *
 * Deliberately not merged with anything discovered from the working directory. Reading the caller's
 * `tsconfig.json` is a documented possibility and a genuinely nice ergonomic, but it is also a guess
 * about which of their many compiler options are the ones they meant for generated code — and a wrong
 * guess would show up as a bundle verified under settings the caller never named, which is worse than
 * asking them to name a file. Where nothing is supplied, the engine's defaults apply, and those are the
 * strictest reasonable configuration (Principle IX).
 */
async function conventionsFrom(
  path: string | undefined,
  read: (path: string) => Promise<string>,
): Promise<unknown> {
  if (path === undefined) return undefined;

  let contents: string;
  try {
    contents = await read(path);
  } catch {
    throw new UsageError(`Cannot read conventions file ${safe(path)}.`);
  }

  try {
    return JSON.parse(contents);
  } catch {
    // The parser's own message is dropped rather than quoted. It reports a position, not a fix, and it
    // does so by echoing the surrounding bytes — which for a malformed file is arbitrary file content
    // reaching stderr, the one thing FR-035 exists to prevent. The path, sanitised, is the actionable
    // part: the caller opens the file and their editor says where the comma is.
    throw new UsageError(`Conventions file ${safe(path)} is not valid JSON.`);
  }
}

/**
 * Maps a thrown value to an exit code and a message on stderr.
 *
 * Human-readable errors go to stderr so that `--json` output on stdout stays parseable even on failure
 * (contracts/cli.md) — a script that pipes stdout to a JSON parser must not have a sentence appear in the
 * middle of it.
 */
function report(error: unknown, streams: Streams): number {
  if (error instanceof UsageError) {
    streams.err(`${error.message}\n`);
    return EXIT.USAGE;
  }

  if (error instanceof WriteRefusedError) {
    streams.err(`${error.message}\n`);
    return EXIT.CORRECTABLE;
  }

  if (error instanceof EngineError) {
    // The shared composer, not `error.message`. Printing the engine's own sentence was the divergence
    // the parity suite found: MCP composed a refusal from the error's fields and sanitised the caller's
    // values, while this printed the raw one, so the same mistake was explained two different ways and
    // only one of them had been reviewed. An agent reading captured stderr is a real caller here
    // (contracts/cli.md), which makes FR-035 this surface's business too.
    streams.err(`${messageFor(error, VOCABULARY)}\n`);
    return error.correctable ? EXIT.CORRECTABLE : EXIT.INTERNAL;
  }

  // Anything else is a defect with no message written for a caller, so it gets the generic form rather
  // than whatever internal text it happens to carry (FR-038). The reference is derived from the failure,
  // so two reports of one bug quote the same one, and the detail goes to stderr *after* the message
  // because here the reader and the operator are the same person.
  const reference = referenceFor(error);
  streams.err(
    `patterns failed with an internal error. This is a defect in the tool, not in your request. ` +
      `Reference ${reference} when reporting it.\n${detailOf(error)}\n`,
  );
  return EXIT.INTERNAL;
}

/** Two-space indent, matching what the MCP resources serialise to, so the surfaces stay comparable. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
