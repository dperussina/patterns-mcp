/**
 * The agent skill, held to the CLI it drives (Principle X, T089).
 *
 * The skill is the third delivery surface, and it is prose — which is exactly why it needs this. The
 * other two adapters are code and fail the gate when they diverge; a document can go stale silently and
 * has one reader who will not notice, since an agent following a wrong instruction produces a refusal
 * it attributes to itself. Principle X says the three surfaces must not diverge in behaviour, and for a
 * document that means every command it shows has to be a command the CLI accepts and every claim it
 * makes about the catalogue has to be true of the catalogue.
 *
 * So the skill is treated the same way T148 treats the README: as a set of checkable claims. Its
 * command lines go through the CLI's own parser, its pattern names and option values are checked
 * against the catalogue that would receive them, its category list is checked against the categories
 * that exist, its exit-code table against the constant, and the two behaviours it tells an agent to
 * rely on — a reserved name being refused, an advisory entry exiting zero — are round-tripped through
 * `run` rather than asserted against the sentence that describes them.
 *
 * What this deliberately does not check is the prose. Whether the explanation is any good is not a
 * property a test can hold; whether it is *wrong* about the interface is, and that is the failure that
 * costs an agent a turn.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describePattern, listCatalogue } from "../../src/index.js";
import { CATEGORIES } from "../../src/engine/catalog/schema.js";
import { parseCommand } from "../../src/cli/args.js";
import { EXIT, run } from "../../src/cli/run.js";

import type { GenerateCommand } from "../../src/cli/args.js";
import type { Streams } from "../../src/cli/run.js";

const SKILL = fileURLToPath(new URL("../../skills/patterns/SKILL.md", import.meta.url));

const contents = await readFile(SKILL, "utf8");
const catalogue = await listCatalogue({});

interface Invocation {
  /** 1-based, so a failure names a line the reader can open. */
  readonly line: number;
  readonly argv: readonly string[];
}

/**
 * Every `patterns …` invocation the document shows, as argv.
 *
 * Read from fenced blocks only. Inline `patterns describe <pattern>` in a sentence is a reference to
 * the command rather than a command to run — it carries a placeholder in angle brackets — and treating
 * it as one would mean the prose could not mention a command without supplying real arguments.
 */
function invocationsIn(text: string): Invocation[] {
  const lines = text.split("\n");
  const found: Invocation[] = [];
  let fenced = false;

  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith("patterns ")) continue;

    found.push({ line: index + 1, argv: split(trimmed.slice("patterns ".length)) });
  }

  return found;
}

/**
 * A command line split the way a shell would, for the quoting this document uses.
 *
 * Whitespace and paired quotes, which covers every form here and refuses to grow: a document needing
 * shell substitution or a line continuation to express a command is a document showing something an
 * agent should not be copying verbatim.
 */
function split(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  return parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
}

/** A `run` call with its two streams collected, so an exit code can be asserted beside what was said. */
function capture(): { readonly written: { out: string; err: string }; readonly sink: Streams } {
  const written = { out: "", err: "" };
  return {
    written,
    sink: {
      out: (text: string) => {
        written.out += text;
      },
      err: (text: string) => {
        written.err += text;
      },
    },
  };
}

const invocations = invocationsIn(contents);
const generations = invocations.filter(
  (invocation) => invocation.argv[0] === "generate",
) as readonly Invocation[];

describe("every command the skill shows", () => {
  it("is found at all, so a silent zero cannot pass this suite", () => {
    expect(invocations.length).toBeGreaterThan(0);
    expect(generations.length).toBeGreaterThan(0);
  });

  it.each(invocations)("parses as a command — line $line", ({ argv }) => {
    // The parser rather than a regular expression, so an unknown flag, a missing `key=value` and a
    // subcommand that does not exist all fail here for the same reason they would fail for a caller.
    expect(() => parseCommand(argv)).not.toThrow();
  });

  it.each(invocations)("names a pattern that exists — line $line", async ({ argv }) => {
    const command = parseCommand(argv);
    const name =
      command.command === "describe"
        ? command.pattern
        : command.command === "generate"
          ? command.request.pattern
          : undefined;
    if (name === undefined) return;

    // `describePattern` refuses an unknown name with the nearest matches, which is a better failure
    // here than a membership test: the message names what the document should have said.
    await expect(describePattern(name)).resolves.toMatchObject({ name });
  });

  it.each(generations)("sends only options the pattern declares — line $line", async ({ argv }) => {
    const command = parseCommand(argv) as GenerateCommand;
    const detail = await describePattern(command.request.pattern);
    const declared = new Map(detail.options.map((option) => [option.name, option]));

    const wrong: string[] = [];
    for (const [name, value] of Object.entries(command.optionStrings ?? {})) {
      const option = declared.get(name);
      if (option === undefined) {
        wrong.push(`${name} is not an option of ${command.request.pattern}`);
        continue;
      }
      // Enums are the only kind whose value space is closed, and the only kind a document can get
      // wrong in a way the parser cannot see — which is the defect T148 found in the README.
      if (option.type === "enum" && !option.values.includes(value)) {
        wrong.push(`${name}=${value} is not one of ${option.values.join(", ")}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it.each(generations)("sends only identifiers the pattern declares — line $line", async ({ argv }) => {
    const command = parseCommand(argv) as GenerateCommand;
    const detail = await describePattern(command.request.pattern);
    const roles = detail.identifiers.map((role) => role.name);

    const undeclared = Object.keys(command.request.identifiers ?? {}).filter(
      (name) => !roles.includes(name),
    );
    expect(undeclared).toEqual([]);
  });
});

describe("every claim the skill makes about the catalogue", () => {
  it("lists exactly the categories that have patterns in them", () => {
    // The document's own sentence, read as the list it claims to be. Both directions matter and they
    // fail differently: a name that returns nothing sends an agent to `--category` for an empty list
    // and no explanation, and a category left out hides part of the catalogue from one that trusts the
    // list is complete.
    //
    // Compared against the *populated* categories rather than against `CATEGORIES`, which is what
    // writing this found: the schema declares `functional` and no pattern is in it, so listing every
    // declared name would document a filter that matches nothing. `CATEGORIES` stays imported as the
    // check that the document is not naming something the schema would reject outright — a different
    // mistake, and one an agent meets as a refusal rather than as an empty list.
    const sentence = /^Categories are (.+?)\.$/msu.exec(contents)?.[1] ?? "";
    const listed = [...sentence.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");

    const populated = [...new Set(catalogue.patterns.map((pattern) => pattern.category))];
    expect(listed.toSorted()).toEqual(populated.toSorted());
    expect(listed.filter((name) => !CATEGORIES.some((category) => category === name))).toEqual([]);
  });

  it("states the number of generative patterns correctly", () => {
    const generative = catalogue.patterns.filter((pattern) => pattern.kind === "generative").length;
    expect(contents).toContain(`${String(generative)} generative patterns`);
  });

  it("states the number of advisory entries correctly", () => {
    const advisory = catalogue.patterns.filter((pattern) => pattern.kind === "advisory").length;
    expect(contents).toContain(`${String(advisory)} catalogue entries are marked`);
  });

  it("states every exit code the CLI can return, with no invented ones", () => {
    // The table's own first column, so a code renamed in `EXIT` and left in the document fails, and
    // so does a code documented that the CLI cannot return — an agent branching on a code that never
    // arrives is as stuck as one meeting a code it was not told about.
    const documented = [...contents.matchAll(/^\| *(\d+) \|/gmu)].map((match) => Number(match[1]));
    expect(documented.toSorted((a, b) => a - b)).toEqual(
      Object.values(EXIT).toSorted((a, b) => a - b),
    );
  });
});

/**
 * The two behaviours the skill tells an agent to rely on, exercised rather than described.
 *
 * Both are places where believing the document and being wrong is expensive: an agent that thinks a
 * reserved name is available spends a turn being refused, and one that reads an advisory exit as a
 * failure abandons a correct answer.
 */
describe("the behaviour the skill promises", () => {
  it("refuses a reserved name as a correctable request, in the casing the document warns about", async () => {
    for (const spelling of ["Repository", "repository"]) {
      const captured = capture();
      // `--dry-run` because a refusal test that unexpectedly succeeds writes files into the repository.
      const code = await run(
        ["generate", "repository", "--identifier", `entity=${spelling}`, "--dry-run"],
        captured.sink,
      );
      expect(code, `entity=${spelling}`).toBe(EXIT.CORRECTABLE);
      expect(captured.written.out).toBe("");
    }
  });

  it("answers an advisory entry with advice and a success code", async () => {
    const advisory = catalogue.patterns.find((pattern) => pattern.kind === "advisory");
    expect(advisory).toBeDefined();

    const captured = capture();
    const code = await run(["generate", advisory?.name ?? "", "--dry-run"], captured.sink);

    expect(code).toBe(EXIT.SUCCESS);
    expect(captured.written.out).toContain("superseded");
  });
});
