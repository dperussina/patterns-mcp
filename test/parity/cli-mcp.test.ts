/**
 * The same request through both surfaces, compared byte for byte (SC-010, Principle X).
 *
 * Two surfaces reach one engine, and the promise is that they are two ways of asking rather than two
 * tools that mostly agree. That promise is cheap to make and easy to break: either adapter can add a
 * field, rename one, or drop one it thought was internal, and every other test in the repository would
 * still pass — the unit suites exercise the engine, the contract suites exercise MCP, and nothing
 * compares them.
 *
 * So the comparison is on serialised bytes rather than on a deep-equality check over parsed objects.
 * Deep equality would tolerate exactly the drift worth catching: key order changing under a rewritten
 * adapter, a number arriving as a string, an absent field versus one explicitly `null`. A caller who
 * pipes `--json` into a diff against a recorded MCP response notices all three, so this notices them
 * too.
 *
 * The CLI is invoked as a function, not as a subprocess. `run()` takes its streams as arguments for this
 * reason: spawning would add a build step between the test and the code, and would leave the suite
 * asserting against whatever was last compiled into `dist/` rather than against the source it is meant
 * to be guarding.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.js";
import { connect } from "../contract/client.js";

import type { Session } from "../contract/client.js";

let session: Session;

beforeAll(async () => {
  session = await connect();
});

afterAll(async () => {
  await session.close();
});

/** `run()` with stdout and stderr captured, and the exit code it chose. */
async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

/**
 * What the CLI printed under `--json`, normalised only by trimming the trailing newline.
 *
 * The newline is the one difference that is *correct*: a shell expects a line, a protocol field does
 * not. Nothing else is normalised, deliberately — every remaining difference is a real one.
 */
function cliJson(out: string): string {
  return out.trimEnd();
}

/** MCP's `structuredContent`, serialised the way the CLI serialises: two-space indent, key order kept. */
function mcpJson(structured: unknown): string {
  return JSON.stringify(structured, null, 2);
}

describe("a generate request", () => {
  it.each([
    { name: "defaults only", argv: ["generate", "result", "--json"], mcp: { pattern: "result" } },
    {
      name: "identifiers and options",
      argv: [
        "generate",
        "circuit-breaker",
        "--identifier",
        "entity=PaymentGateway",
        "--option",
        "halfOpen=sampled",
        "--json",
      ],
      mcp: {
        pattern: "circuit-breaker",
        identifiers: { entity: "PaymentGateway" },
        options: { halfOpen: "sampled" },
      },
    },
    {
      name: "conventions",
      argv: [
        "generate",
        "semaphore",
        "--conventions",
        "./test/fixtures/conventions/cjs-loose.json",
        "--json",
      ],
      mcp: {
        pattern: "semaphore",
        conventions: {
          strictness: "loose",
          moduleStyle: "cjs",
          importExtensions: "none",
          typeImports: "inline",
          testFramework: "node-test",
          runtime: "node",
          prettierConfig: { printWidth: 100, singleQuote: true, semi: true },
        },
      },
    },
    {
      // The other end of the same axis set, because a single fixture proves the file is read and not that
      // the values in it travel. Loose CJS and strictest ESM disagree on every field, so a surface that
      // dropped one and defaulted it would match on the first case and diverge here.
      name: "conventions at the opposite extreme",
      argv: [
        "generate",
        "semaphore",
        "--conventions",
        "./test/fixtures/conventions/esm-strictest.json",
        "--json",
      ],
      mcp: {
        pattern: "semaphore",
        conventions: {
          strictness: "strictest",
          moduleStyle: "esm",
          importExtensions: "js",
          typeImports: "separate",
          testFramework: "vitest",
          runtime: "neutral",
          prettierConfig: { printWidth: 80, singleQuote: false, trailingComma: "all" },
        },
      },
    },
    {
      name: "tests suppressed",
      argv: ["generate", "debounce", "--option", "includeTests=false", "--json"],
      mcp: { pattern: "debounce", options: { includeTests: false } },
    },
    {
      name: "an advisory pattern",
      argv: ["generate", "singleton", "--json"],
      mcp: { pattern: "singleton" },
    },
  ])("serialises identically on both surfaces — $name", async ({ argv, mcp }) => {
    const fromCli = await cli(argv);
    expect(fromCli.err, "the CLI reported an error, so there is nothing to compare").toBe("");
    expect(fromCli.code).toBe(0);

    const fromMcp = await session.client.callTool({ name: "generate_pattern", arguments: mcp });
    expect(fromMcp.isError, "MCP reported an error, so there is nothing to compare").toBeFalsy();

    expect(cliJson(fromCli.out)).toBe(mcpJson(fromMcp.structuredContent));
  }, 180_000);
});

describe("a catalogue listing", () => {
  it.each([
    { name: "everything", argv: ["list", "--json"], mcp: {} },
    {
      name: "filtered by category",
      argv: ["list", "--category", "async-resilience", "--json"],
      mcp: { category: "async-resilience" },
    },
    { name: "filtered by tier", argv: ["list", "--tier", "1", "--json"], mcp: { tier: 1 } },
    {
      name: "filtered to advisory entries",
      argv: ["list", "--kind", "advisory", "--json"],
      mcp: { kind: "advisory" },
    },
  ])("serialises identically on both surfaces — $name", async ({ argv, mcp }) => {
    const fromCli = await cli(argv);
    expect(fromCli.err).toBe("");

    const fromMcp = await session.client.callTool({ name: "list_patterns", arguments: mcp });

    expect(cliJson(fromCli.out)).toBe(mcpJson(fromMcp.structuredContent));
  });
});

describe("a description", () => {
  it.each(["circuit-breaker", "repository", "singleton"])(
    "serialises identically on both surfaces — %s",
    async (pattern) => {
      const fromCli = await cli(["describe", pattern, "--json"]);
      expect(fromCli.err).toBe("");

      const fromMcp = await session.client.callTool({
        name: "describe_pattern",
        arguments: { pattern },
      });

      expect(cliJson(fromCli.out)).toBe(mcpJson(fromMcp.structuredContent));
    },
  );
});

/**
 * The clauses each surface uses for its own commands, replaced with a token before comparing.
 *
 * The one licensed difference. A refusal has to tell the caller what to do next in words that caller can
 * act on, and "Call list_patterns" is meaningless at a shell prompt while "Run `patterns list`" is
 * meaningless to a model holding a tool list. Everything else in the sentence — which field was wrong,
 * what it accepts, why — is the same fact and is compared exactly.
 *
 * Enumerated here rather than matched by a pattern, so that a surface inventing a *third* difference is
 * a failure rather than something a loose regular expression absorbs.
 */
const SURFACE_CLAUSES: readonly (readonly [string, string])[] = [
  ["Call list_patterns", "«list»"],
  ["Run `patterns list`", "«list»"],
  ["Call describe_pattern", "«describe»"],
  ["Run `patterns describe <pattern>`", "«describe»"],
];

function withoutSurfaceVocabulary(text: string): string {
  return SURFACE_CLAUSES.reduce(
    (rewritten, [clause, token]) => rewritten.replaceAll(clause, token),
    text.trimEnd(),
  );
}

describe("a refusal", () => {
  /**
   * The refusal *text* is compared, not the transport shape around it.
   *
   * The shapes cannot match and should not: MCP answers with a result carrying `isError` and `_meta`
   * because a protocol has to hand the model something it can read, while a shell has a stderr stream
   * and an exit code for exactly this. What must match is the sentence, since that is the part written
   * for whoever has to fix the request, and a divergence there would mean one surface's callers get
   * worse advice than the other's — which is what this found: the CLI was printing the engine's raw
   * message, so the same mistake was explained two different ways and only one of them was sanitised.
   */
  it.each([
    {
      name: "an unknown pattern with a near miss",
      argv: ["generate", "retyr"],
      mcp: { pattern: "retyr" },
    },
    {
      name: "an unknown pattern with nothing close to it",
      argv: ["generate", "zzzzzzzz"],
      mcp: { pattern: "zzzzzzzz" },
    },
    {
      name: "an option value that does not exist",
      argv: ["generate", "circuit-breaker", "--option", "halfOpen=sometimes"],
      mcp: { pattern: "circuit-breaker", options: { halfOpen: "sometimes" } },
    },
    {
      name: "an option the pattern does not declare",
      argv: ["generate", "result", "--option", "halfOpen=sampled"],
      mcp: { pattern: "result", options: { halfOpen: "sampled" } },
    },
    {
      name: "an identifier the pattern does not read",
      argv: ["generate", "result", "--identifier", "aggregate=Order"],
      mcp: { pattern: "result", identifiers: { aggregate: "Order" } },
    },
    {
      // A reserved word rather than, say, a lowercase name: casing is normalised rather than refused, so
      // `entity=order` is a legitimate request and asserting it were refused would have been asserting a
      // defect. This is the refusal that exists.
      name: "an identifier that cannot be declared",
      argv: ["generate", "result", "--identifier", "entity=interface"],
      mcp: { pattern: "result", identifiers: { entity: "interface" } },
    },
    {
      name: "an identifier with a character that has no place in one",
      argv: ["generate", "result", "--identifier", "entity=Order-2"],
      mcp: { pattern: "result", identifiers: { entity: "Order-2" } },
    },
    {
      name: "a required option left out",
      argv: ["generate", "repository", "--emit-scope", "binding-only"],
      mcp: { pattern: "repository", options: { emitScope: "binding-only" } },
    },
    {
      name: "a formatting option that cannot be set",
      argv: [
        "generate",
        "result",
        "--conventions",
        "./test/fixtures/conventions/unconfigurable.json",
      ],
      mcp: { pattern: "result", conventions: { prettierConfig: { plugins: ["evil"] } } },
    },
  ])("says the same thing on both surfaces — $name", async ({ argv, mcp }) => {
    // `--dry-run` because a case that stops being a refusal must not become a case that writes files
    // into the repository. It happened: one of these named an identifier that turned out to be
    // legitimate, the CLI generated a bundle into the working directory, and the failure that followed
    // was a lint error about generated code rather than a test naming the wrong assumption.
    const fromCli = await cli([...argv, "--dry-run"]);
    expect(fromCli.code, "a refusal the caller can fix exits 1").toBe(1);
    expect(fromCli.out, "nothing goes to stdout on a refusal").toBe("");

    const fromMcp = await session.client.callTool({ name: "generate_pattern", arguments: mcp });
    expect(fromMcp.isError).toBe(true);

    const text = (fromMcp.content as readonly { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");

    expect(withoutSurfaceVocabulary(fromCli.err)).toBe(withoutSurfaceVocabulary(text));
  }, 60_000);

  it("names its own surface when it tells the caller what to do next", async () => {
    const fromCli = await cli(["generate", "zzzzzzzz"]);
    const fromMcp = await session.client.callTool({
      name: "generate_pattern",
      arguments: { pattern: "zzzzzzzz" },
    });
    const text = (fromMcp.content as readonly { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");

    // Stated as its own assertion because the normalisation above would happily pass two surfaces that
    // both said nothing at all: a refusal with the clause removed rather than translated.
    expect(fromCli.err).toContain("patterns list");
    expect(text).toContain("list_patterns");
  });
});
