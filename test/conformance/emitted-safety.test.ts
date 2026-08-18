/**
 * What generated code is forbidden to contain, checked against generated code (FR-034, T096).
 *
 * The requirement bans three things a bundle could carry — dynamically executed source, a credential, and
 * anything that runs at install time — and until now all three were beliefs. True beliefs: the corpus was
 * clean when this was written. The trouble with that is what it takes to make it false, which is one
 * template gaining one line, in a pattern whose review is about whether its abstraction is any good.
 * Nothing else in the gate would object: such a file typechecks, its tests pass, and it is byte-identical
 * from one run to the next, so every guarantee this project makes about a bundle would hold of a bundle
 * with a hardcoded key in it.
 *
 * The network half of FR-034 is `network.test.ts`, which is a different shape of question — declared or
 * not — where these three are unconditional.
 *
 * Read off rendered bundles across every branch, for the reason T144 recorded: a line reachable only under
 * one option value is reachable, and a sweep over the defaults inspects the lines that happened to be in
 * view. The corpus is every generative pattern, so a pattern added later is covered without anyone
 * remembering to add it here.
 */
import { describe, expect, it } from "vitest";

import { loadCatalog } from "../../src/engine/catalog/load.js";
import { CorrectableError } from "../../src/engine/errors.js";
import { branchesOf } from "../branches.js";
import { generateBundle } from "../bundle.js";

import type { GenerativePattern } from "../../src/engine/catalog/schema.js";

const catalog = await loadCatalog();

const patterns = catalog.patterns.filter(
  (candidate): candidate is GenerativePattern => candidate.kind === "generative",
);

const CONVENTIONS = { testFramework: "node-test" } as const;

interface Rule {
  /** What a sighting means, phrased as the thing to fix rather than as the thing matched. */
  readonly why: string;
  readonly pattern: RegExp;
}

/**
 * Source that is executed rather than read.
 *
 * The point is not that these are exotic — no pattern here has any use for them — it is that generated
 * code is code the caller did not write and will read less carefully than their own. A `new Function` in a
 * file stamped "generated, verified" is trusted on the strength of that stamp.
 *
 * `import(` and `require(` are matched only with a non-literal argument, and only in expression position.
 * A static specifier is how every module in every bundle is loaded; one assembled at runtime is a
 * different act, and only the second can name something the reader cannot see. The position requirement is
 * not fastidiousness — `repository` and `unit-of-work` both declare a method called `require`, since
 * "fetch this or fail" is the operation those patterns are about, and the first version of this rule
 * reported ten sightings across two patterns for the crime of naming a method well.
 */
const CALL_POSITION = String.raw`(?:[=(,]|\breturn|\bawait)\s*(?:await\s+)?`;

const EXECUTES_SOURCE: readonly Rule[] = [
  { why: "evaluates a string as source", pattern: /(?<![.\w$])eval\s*\(/u },
  { why: "constructs a function from a string", pattern: /new\s+Function\s*\(/u },
  {
    why: "imports a specifier assembled at runtime",
    pattern: new RegExp(`${CALL_POSITION}import\\s*\\(\\s*(?!["'\`])`, "u"),
  },
  {
    why: "requires a specifier assembled at runtime",
    pattern: new RegExp(`${CALL_POSITION}require\\s*\\(\\s*(?!["'\`])`, "u"),
  },
  { why: "reaches a module whose purpose is running other code", pattern: /\bnode:(?:vm|child_process|worker_threads)\b/u },
];

/**
 * A secret written into a file, or read from somewhere the caller did not choose.
 *
 * The environment reads are here beside the literals because they are the same defect wearing better
 * clothes. `chat-model-port` needs a key; it takes one as a config field, which puts the caller in charge
 * of where it comes from. A template that reached for `process.env.OPENAI_API_KEY` instead would look
 * responsible — no secret in the file — while quietly deciding on the caller's behalf that their key lives
 * in an environment variable of our choosing, and failing at runtime rather than at the type level when it
 * does not.
 */
const CARRIES_A_SECRET: readonly Rule[] = [
  {
    why: "reads a credential out of the ambient environment instead of taking it from the caller",
    pattern: /(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)\b/u,
  },
  { why: "contains a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { why: "contains an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { why: "contains a provider key", pattern: /\bsk-[A-Za-z0-9]{16,}\b/u },
];

/**
 * A credential-named field assigned a string literal, other than an obvious stand-in.
 *
 * Separate from the rules above because the shape it matches is legitimate and common: every emitted
 * example and test for `chat-model-port` constructs a config, and a config with a key in it needs
 * *something* in that field. What distinguishes the acceptable form is that the value announces itself as
 * not a key — the corpus says `apiKey: "placeholder"` — so the allowance is the announcement, and a value
 * that does not make it has to be added to this list deliberately rather than slipping past a regex that
 * was only ever looking for high entropy.
 */
const CREDENTIAL_FIELD =
  /\b(?:password|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)["']?\s*[:=]\s*(["'])((?:(?!\1|\$\{)[^\n])*)\1/giu;

const PLACEHOLDER = /^(?:|placeholder|test|example|redacted|dummy|unused|your-[\w-]+|<[^>]+>|\.\.\.)$/iu;

/**
 * Paths whose presence in a bundle would make it something other than source to read.
 *
 * Two of these turn out to be unreachable by accident, which is worth writing down rather than relying on:
 * a `package.json` is refused by the formatter, because every emitted file is formatted as TypeScript and
 * a JSON object is not a TypeScript statement. That is a control nobody chose and nobody documented, so it
 * is the kind that goes away silently — the day a pattern legitimately needs to emit a non-TS file, the
 * formatter grows an exception and this rule is the only thing left. A `setup.sh` holding valid TypeScript
 * gets all the way through today, which is how the rule was falsified.
 */
const NOT_SOURCE = [
  { why: "a manifest whose scripts run on install", pattern: /(?:^|\/)package(?:-lock)?\.json$/u },
  { why: "a registry configuration", pattern: /(?:^|\/)\.(?:npmrc|yarnrc|yarnrc\.yml)$/u },
  { why: "a shell script", pattern: /\.(?:sh|bash|zsh|ps1|bat|cmd)$/u },
  { why: "a build recipe that runs commands", pattern: /(?:^|\/)(?:Makefile|Dockerfile|docker-compose\.ya?ml)$/u },
];

interface Sighting {
  readonly where: string;
  readonly why: string;
  readonly line: string;
}

/**
 * Every rule violation across every branch of one pattern.
 *
 * Comment text is stripped before matching. A pattern explaining why it takes a transport rather than
 * calling one is not calling one, and a guard that cannot tell prose from code produces failures its
 * reader learns to wave through — which is the same failure as no guard, arrived at more slowly.
 */
async function sightingsIn(pattern: GenerativePattern): Promise<readonly Sighting[]> {
  const found: Sighting[] = [];
  let rendered = 0;

  for (const branch of branchesOf(pattern)) {
    const identifiers = Object.fromEntries(pattern.identifiers.map((role) => [role.name, "Zebra"]));

    let files: readonly { readonly path: string; readonly contents: string }[];
    try {
      const bundle = await generateBundle({
        pattern: pattern.name,
        options: { includeTests: true, ...branch.options },
        conventions: CONVENTIONS,
        identifiers,
      });
      files = bundle.files;
    } catch (error) {
      // A combination the catalogue declares illegal is not this suite's business, and only that class is
      // skipped. Catching every `Error` was the first version, and it hid the falsification of this very
      // suite: a template made to emit `package.json` is refused by the assembler, the skip swallowed the
      // refusal, and the failure that arrived said "rendered under no branch" — true, unhelpful, and
      // pointing at the harness rather than at the file. Counted as well as narrowed, since a pattern
      // that refused every branch would otherwise pass this vacuously.
      if (error instanceof CorrectableError) continue;
      throw error;
    }

    rendered += 1;

    for (const file of files) {
      const at = `${pattern.name} [${branch.label}] ${file.path}`;

      for (const rule of NOT_SOURCE) {
        if (rule.pattern.test(file.path)) {
          found.push({ where: at, why: rule.why, line: file.path });
        }
      }

      for (const [index, raw] of file.contents.split("\n").entries()) {
        const code = raw.replace(/\/\/.*$/u, "").replace(/^\s*\*.*$/u, "");
        const line = `${String(index + 1)}: ${raw.trim()}`;

        for (const rule of [...EXECUTES_SOURCE, ...CARRIES_A_SECRET]) {
          if (rule.pattern.test(code)) found.push({ where: at, why: rule.why, line });
        }

        for (const match of code.matchAll(CREDENTIAL_FIELD)) {
          if (!PLACEHOLDER.test(match[2] ?? "")) {
            found.push({ where: at, why: "assigns a literal to a credential field", line });
          }
        }
      }
    }
  }

  if (rendered === 0) throw new Error(`${pattern.name} rendered under no branch, so nothing was read`);

  return found;
}

describe("generated code carries nothing it should not", () => {
  it.each(patterns.map((pattern) => pattern.name))(
    "%s",
    async (name) => {
      const pattern = patterns.find((candidate) => candidate.name === name);
      if (pattern === undefined) throw new Error(`${name} left the catalogue mid-run`);

      const sightings = await sightingsIn(pattern);

      // Reported all at once rather than one per assertion, so a template that introduced several shows
      // all of them in one run instead of one per fix.
      if (sightings.length > 0) {
        expect.fail(
          `${pattern.name} emits code that violates FR-034:\n` +
            sightings
              .map((sighting) => `  ${sighting.where} ${sighting.why}\n    ${sighting.line}`)
              .join("\n"),
        );
      }
    },
    240_000,
  );
});

describe("the rules themselves", () => {
  // A sweep whose rules match nothing is indistinguishable from a sweep with no rules, and the corpus is
  // clean, so nothing else here would notice a regex that had stopped compiling to anything. These are the
  // lines the rules exist to catch, written out, so the suite is known to be able to fail.
  const shouldMatch: readonly (readonly [string, string])[] = [
    ["eval", 'const result = eval(source);'],
    ["dynamic function", "const fn = new Function('return 1');"],
    ["computed import", "const mod = await import(specifier);"],
    ["computed require", "const mod = require(name);"],
    ["child process", 'import { spawn } from "node:child_process";'],
    ["environment credential", "const key = process.env.OPENAI_API_KEY;"],
    ["provider key", 'const key = "sk-abcdefghijklmnopqrstuv";'],
    ["aws key", 'const id = "AKIAIOSFODNN7EXAMPLE";'],
  ];

  it.each(shouldMatch)("catches %s", (_label, line) => {
    const rules = [...EXECUTES_SOURCE, ...CARRIES_A_SECRET];
    expect(rules.some((rule) => rule.pattern.test(line))).toBe(true);
  });

  const shouldNotMatch: readonly (readonly [string, string])[] = [
    // Every one of these appears in the corpus, and each is the reason a rule is written the way it is
    // rather than the way it first was.
    ["a static import", 'import { Result } from "./result.js";'],
    ["a declared transport field", "readonly fetch?: FetchLike;"],
    ["an injected transport", "const response = await (config.fetch ?? fetch)(url, init);"],
    ["a placeholder key", 'const config = { apiKey: "placeholder" };'],
    ["a key taken from the caller", "authorization: `Bearer ${config.apiKey}`,"],
    ["a method named eval on someone else", "const value = policy.evaluate(input);"],
    ["a method declaration called require", "  async require(key: K): Promise<T> {"],
    ["its signature in an interface", "  require(id: T[\"id\"]): Promise<Tracked<T, \"id\">>;"],
  ];

  it.each([
    ["package.json", true],
    ["src/.npmrc", true],
    ["scripts/setup.sh", true],
    ["Dockerfile", true],
    ["zebra-repository.ts", false],
    ["zebra-repository.test-d.ts", false],
  ] as const)("judges the path %s", (path, forbidden) => {
    expect(NOT_SOURCE.some((rule) => rule.pattern.test(path))).toBe(forbidden);
  });

  it.each(shouldNotMatch)("leaves %s alone", (_label, line) => {
    const rules = [...EXECUTES_SOURCE, ...CARRIES_A_SECRET];
    expect(rules.some((rule) => rule.pattern.test(line))).toBe(false);

    const literals = [...line.matchAll(CREDENTIAL_FIELD)].map((match) => match[2] ?? "");
    expect(literals.filter((literal) => !PLACEHOLDER.test(literal))).toEqual([]);
  });
});
