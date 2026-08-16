/**
 * Every request written in the documentation, sent through the schema that would receive it.
 *
 * The defect this exists for was in the README's one worked example: `testFramework: "node"`, where the
 * accepted spellings are `vitest` and `node-test`. The schemas are strict, so a reader copying the
 * example got a refusal on their first call — the worst possible first minute, and the one place a
 * wrong value costs the most, since it is what a reader trusts before they have anything else to
 * compare it against.
 *
 * It survived because nothing read the README. The gate proves the generator against the schema and the
 * schema against itself, and the prose sat outside both. This closes that by treating a documented
 * request as a claim the schema can check: any fenced JSON block naming a `pattern` is parsed and
 * validated, so the documentation cannot drift from the interface without failing.
 *
 * Validation only, deliberately. Whether these requests *generate* is T098's job, and it runs them
 * against the real server; what fails here is a request the server would not even accept, which is a
 * different defect with a much cheaper test.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateInput } from "../../src/mcp/tools/generate.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Documents that show a caller what to send. Add one here when it starts carrying examples. */
const DOCUMENTS = ["README.md", "specs/001-typescript-pattern-mcp/quickstart.md"] as const;

interface Example {
  document: string;
  /** 1-based, so a failure names a line the reader can open. */
  line: number;
  request: unknown;
}

/**
 * Fenced JSON blocks that name a `pattern`, which is what distinguishes a generation request from the
 * client configuration and the response samples sharing the same fence.
 */
function examplesIn(document: string, contents: string): Example[] {
  const found: Example[] = [];
  const lines = contents.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "```json") continue;
    const start = index + 1;
    let end = start;
    while (end < lines.length && lines[end]?.trim() !== "```") end += 1;

    const body = lines.slice(start, end).join("\n");
    index = end;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A block that is not valid JSON is its own defect, reported by the test below.
      found.push({ document, line: start + 1, request: body });
      continue;
    }

    if (typeof parsed === "object" && parsed !== null && "pattern" in parsed) {
      found.push({ document, line: start + 1, request: parsed });
    }
  }

  return found;
}

const documents = await Promise.all(
  DOCUMENTS.map(async (name) => ({
    name,
    contents: await readFile(`${ROOT}${name}`, "utf8"),
  })),
);

const examples = documents.flatMap(({ name, contents }) => examplesIn(name, contents));

describe("a request the documentation shows", () => {
  it("is found at all, so a silent zero cannot pass this suite", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("is accepted by the schema — $document line $line", ({ request }) => {
    const outcome = generateInput.safeParse(request);
    const complaint =
      outcome.success === true
        ? ""
        : outcome.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    expect(complaint).toBe("");
  });
});

describe("every fenced JSON block in the documentation", () => {
  it.each(documents)("parses as JSON — $name", ({ name, contents }) => {
    const lines = contents.split("\n");
    const broken: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.trim() !== "```json") continue;
      const start = index + 1;
      let end = start;
      while (end < lines.length && lines[end]?.trim() !== "```") end += 1;
      try {
        JSON.parse(lines.slice(start, end).join("\n"));
      } catch (error) {
        broken.push(`${name} line ${String(start + 1)}: ${(error as Error).message}`);
      }
      index = end;
    }

    expect(broken).toEqual([]);
  });
});
