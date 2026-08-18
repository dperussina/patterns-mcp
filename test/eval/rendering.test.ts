/**
 * T094: whether the response body should be Markdown or a serialized structure.
 *
 * The open item says the two "measurably affect agent performance, with no universal winner" and to decide
 * with an evaluation set rather than by preference. That framing turns out to skip the question that comes
 * first. Before either rendering can be compared on how well it reads, it has to be **lossless** — a
 * reader cannot act on a file it received three quarters of, and a serialized structure round-trips by
 * construction while Markdown does so only if nothing in the payload can terminate its own container.
 *
 * Markdown as implemented was not lossless; it was correct by luck. A fenced block ends at the first line
 * whose backtick run is at least as long as the opening fence, and the renderer opened every block with
 * three. Seven files in the catalogue contain three backticks — inside a doc comment or a string literal,
 * so each is preceded by ` * ` or a quote and closes nothing. Nothing chose that and nothing held it: a
 * pattern emitting a template literal that holds Markdown, which `structured-output` already holds inside
 * single quotes, would have put three backticks at the start of a line and cut the response there. Silent,
 * and the caller compiles what arrives.
 *
 * So the decision is Markdown, with the fence sized to the payload, and this file is the reason it can be
 * called a decision: every file of every branch is parsed back out of the rendered text and compared byte
 * for byte. A serialized body is rejected on the grounds that it buys nothing — `structuredContent`
 * already carries the bundle verbatim for a caller who would rather parse than read, so a serialized
 * `content` block would be the same bytes twice and the only remaining question was whether the readable
 * copy is faithful.
 */

import { describe, expect, it } from "vitest";

import { fenceFor, handleGenerate } from "../../src/mcp/tools/generate.js";
import { branchesOf } from "../branches.js";
import { generativePatterns, goldenIdentifiers } from "../golden/harness.js";

import type { CallToolResult } from "@modelcontextprotocol/server";

interface Rendered {
  readonly path: string;
  readonly contents: string;
}

/**
 * The files a reader can recover from the text, by the rules Markdown actually uses.
 *
 * Written against CommonMark rather than against the renderer: a parser that knew how the text was
 * produced would agree with it by construction, including about a fence that closes early. The opening
 * fence's length is captured and the block ends at the first line that is a run of at least that many
 * backticks and nothing else, which is exactly the rule a host's renderer applies.
 */
function parse(text: string): readonly Rendered[] {
  const lines = text.split("\n");
  const files: Rendered[] = [];

  for (let at = 0; at < lines.length; at += 1) {
    const heading = /^### (.+)$/u.exec(lines[at] ?? "");
    if (heading === null) continue;

    const opening = /^(`{3,})ts$/u.exec(lines[at + 2] ?? "");
    if (opening === null) continue;

    const fence = opening[1] ?? "";
    const closing = new RegExp(`^ {0,3}\`{${String(fence.length)},}\\s*$`, "u");
    const body: string[] = [];

    let cursor = at + 3;
    while (cursor < lines.length && !closing.test(lines[cursor] ?? "")) {
      body.push(lines[cursor] ?? "");
      cursor += 1;
    }

    files.push({ path: heading[1] ?? "", contents: `${body.join("\n")}\n` });
    at = cursor;
  }

  return files;
}

/** Whether the response omitted contents on purpose, which is a different promise and says so. */
function isSummary(text: string): boolean {
  return text.includes("File contents were omitted from this message");
}

/**
 * The one refusal that is not a defect here: a bundle too large to return at all.
 *
 * `chat-model-port` at its defaults is the single request in the catalogue that reaches it (T087), and it
 * reaches it with `verbosity: "full"` too, since the ceiling is measured against the smallest rendering.
 * There is no text to round-trip, so the case is skipped — but it is skipped by *recognising the refusal*
 * rather than by tolerating `isError`, because every other refusal in this suite would be a real failure.
 */
function isOversized(result: CallToolResult): boolean {
  return result._meta?.["com.perussina.patterns/errorCode"] === "response_too_large";
}

function textOf(result: CallToolResult): string {
  const [block] = result.content;
  if (block === undefined || block.type !== "text") throw new Error("no text block in the result");
  return block.text;
}

const patterns = await generativePatterns();

describe.each(patterns.map((pattern) => ({ pattern, name: pattern.name })))(
  "$name",
  ({ pattern }) => {
    it(
      "renders every file so that it can be read back exactly",
      async () => {
        const losses: string[] = [];

        for (const branch of branchesOf(pattern)) {
          const result = await handleGenerate({
            pattern: pattern.name,
            identifiers: goldenIdentifiers(pattern),
            options: branch.options,
            verbosity: "full",
          });

          if (isOversized(result)) continue;
          expect(result.isError, `${branch.label} was refused`).not.toBe(true);

          const text = textOf(result);
          // An oversized bundle is summarised even when `full` was asked for, which is a stated choice
          // rather than a loss: the contents are in the structured result and the text says where. Nothing
          // to round-trip, so nothing to compare.
          if (isSummary(text)) continue;

          const structured = result.structuredContent as { files: readonly Rendered[] };
          const recovered = parse(text);

          if (recovered.length !== structured.files.length) {
            losses.push(
              `${branch.label}: ${String(structured.files.length)} files rendered, ` +
                `${String(recovered.length)} recoverable`,
            );
            continue;
          }

          for (const [index, file] of structured.files.entries()) {
            const read = recovered[index];
            if (read?.path !== file.path) {
              losses.push(`${branch.label}: expected ${file.path}, read ${read?.path ?? "nothing"}`);
              continue;
            }
            if (read.contents !== file.contents) {
              losses.push(`${branch.label}: ${file.path} did not survive the rendering`);
            }
          }
        }

        expect(losses).toEqual([]);
      },
      300_000,
    );
  },
);

describe("the fence", () => {
  it("cannot be closed by the payload it contains", () => {
    // The falsification the round-trip cannot perform. Every fence in the catalogue today sits behind ` * `
    // or a quote, so a three-backtick opener round-trips all 26 patterns and the rule that replaced it
    // would go untested by the evidence that recommended it. These are the payloads a pattern has not
    // written yet: a template literal holding Markdown, and one holding a longer fence than that.
    const hazards = [
      "const doc = `\n```ts\nconst x = 1;\n```\n`;\n",
      "const doc = `\n````md\n```ts\n```\n````\n`;\n",
      "const plain = 1;\n",
    ];

    for (const contents of hazards) {
      const fence = fenceFor(contents);
      const closing = new RegExp(`^ {0,3}\`{${String(fence.length)},}\\s*$`, "u");
      const closesItself = contents.split("\n").some((line) => closing.test(line));

      expect(closesItself, `a fence of ${String(fence.length)} is closed by its own payload`).toBe(false);

      // And the parser above agrees, which is what makes the previous assertion about Markdown rather than
      // about a regular expression written next to it.
      const rendered = `### synthetic.ts\n\n${fence}ts\n${contents}${fence}`;
      expect(parse(rendered)).toEqual([{ path: "synthetic.ts", contents }]);
    }
  });

  it("outgrows anything the payload can put at the start of a line", async () => {
    // The falsification. `structured-output` emits a regex over Markdown fences and a fixture containing
    // them, so it is the pattern where the hazard is nearest the surface — but every occurrence today sits
    // behind a quote or a comment marker, which is why a three-backtick fence survived. Asserting on the
    // rendering rather than on the sources is what keeps this true for a pattern that has not been written
    // yet: what matters is not that no file starts a line with a fence, it is that starting one cannot cut
    // the response.
    // Without the suite, so the response is small enough to be rendered in full: a summarised one omits
    // contents by design and would pass this by having nothing to lose.
    const result = await handleGenerate({
      pattern: "structured-output",
      verbosity: "full",
      options: { strategy: "prompt", includeTests: false },
    });

    const text = textOf(result);
    expect(isSummary(text), "nothing was rendered, so nothing was proved").toBe(false);

    const structured = result.structuredContent as { files: readonly Rendered[] };
    const fenced = structured.files.filter((file) => file.contents.includes("```"));

    expect(fenced.length, "the pattern that provokes this stopped provoking it").toBeGreaterThan(0);

    const recovered = parse(text);
    expect(recovered.length).toBe(structured.files.length);
    // The fenced file specifically, byte for byte. A count that matched while the block holding the fence
    // came back short is the exact failure a three-backtick fence produced, and the one worth naming here.
    for (const file of fenced) {
      const read = recovered.find((entry) => entry.path === file.path);
      expect(read?.contents).toBe(file.contents);
    }
  }, 300_000);
});
