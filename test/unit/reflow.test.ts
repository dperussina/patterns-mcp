/**
 * What matters here is not that wrapping works, but that nothing else is touched.
 *
 * The pass rewrites source text, so a false positive corrupts a generated bundle: `//` inside a URL,
 * `/*` inside a regex, and either inside a template literal all look like comments to anything that
 * reads the file as text. Those cases are the reason this uses the parser, and they are the first
 * cases below.
 */

import { describe, expect, it } from "vitest";

import { formatSource } from "../../src/engine/format/prettier.js";
import { reflowComments } from "../../src/engine/format/reflow.js";

const LIMIT = 80;

function widest(text: string): number {
  return Math.max(...text.split("\n").map((line) => line.length));
}

/** How many lines the wrapped prose occupies, as a proxy for the width it was wrapped to. */
function proseLines(text: string): number {
  return text.split("\n").filter((line) => line.includes("word")).length;
}

describe("things that only look like comments", () => {
  it("leaves a line comment inside a template literal alone", () => {
    const source =
      "const a = `" +
      "// ".repeat(40) +
      "`;\n";
    expect(reflowComments(source)).toBe(source);
  });

  it("leaves a block comment inside a template literal alone, substitutions and all", () => {
    // The case that rules out a bare scanner: with no parser driving it, the substitution ends the
    // template as far as the scanner is concerned, and it reports the rest as a comment.
    const source = "const a = `${1} /* " + "x".repeat(90) + " */`;\n";
    expect(reflowComments(source)).toBe(source);
  });

  it("leaves a URL in a string alone", () => {
    const source = `const a = "https://example.com/${"path/".repeat(20)}";\n`;
    expect(reflowComments(source)).toBe(source);
  });

  it("leaves a regex containing comment markers alone", () => {
    const source = `const a = /\\/\\/ ${"y".repeat(90)}/;\n`;
    expect(reflowComments(source)).toBe(source);
  });
});

describe("comments that already fit", () => {
  it("are returned byte-identical, so this cannot churn a diff", () => {
    const source = ["/** Short. */", "// Also short.", "export const a = 1;", ""].join("\n");
    expect(reflowComments(source)).toBe(source);
  });

  it("keeps a long comment that has nothing over the limit", () => {
    const source = ["/**", " * One.", " *", " * Two.", " */", "export const a = 1;", ""].join("\n");
    expect(reflowComments(source)).toBe(source);
  });
});

describe("a block comment over the limit", () => {
  const long = `export const a = 1;\n/**\n * ${"word ".repeat(40).trim()}\n */\n`;

  it("is wrapped to the width", () => {
    const output = reflowComments(long);
    expect(widest(output)).toBeLessThanOrEqual(LIMIT);
  });

  it("keeps its indentation, and accounts for it", () => {
    const nested = `class A {\n  /**\n   * ${"word ".repeat(40).trim()}\n   */\n  b = 1;\n}\n`;
    const output = reflowComments(nested);

    expect(widest(output)).toBeLessThanOrEqual(LIMIT);
    // The indent is preserved rather than flattened, or the result would not survive re-formatting.
    for (const line of output.split("\n").filter((l) => l.includes("*"))) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });

  it("keeps paragraph breaks", () => {
    const source = `/**\n * ${"word ".repeat(30).trim()}\n *\n * Second.\n */\nexport const a = 1;\n`;
    const output = reflowComments(source);
    expect(output).toContain(" *\n");
    expect(output).toContain("Second.");
  });

  it("starts a new line for a tag, which the author broke on purpose", () => {
    const source = `/**\n * ${"word ".repeat(30).trim()}\n * @throws when it fails\n */\nexport const a = 1;\n`;
    const output = reflowComments(source);
    const tagLine = output.split("\n").find((line) => line.includes("@throws"));
    expect(tagLine?.trim()).toBe("* @throws when it fails");
  });

  it("expands a one-liner only when it cannot fit as one", () => {
    const fits = `/** ${"word ".repeat(10).trim()} */\nexport const a = 1;\n`;
    expect(reflowComments(fits)).toBe(fits);

    const output = reflowComments(`/** ${"word ".repeat(30).trim()} */\nexport const a = 1;\n`);
    expect(output.startsWith("/**\n")).toBe(true);
    expect(widest(output)).toBeLessThanOrEqual(LIMIT);
  });

  it("leaves a fenced example alone, since its layout is the point", () => {
    const source = `/**\n * \`\`\`ts\n * const x = ${"1".repeat(90)};\n * \`\`\`\n */\nexport const a = 1;\n`;
    expect(reflowComments(source)).toBe(source);
  });
});

describe("a run of line comments over the limit", () => {
  it("is rewrapped as one paragraph, not line by line", () => {
    // Line by line would leave the first line long and the second short, which is the state the
    // templates were already in.
    const source = `// ${"word ".repeat(30).trim()}\n// and a short tail.\nexport const a = 1;\n`;
    const output = reflowComments(source);

    expect(widest(output)).toBeLessThanOrEqual(LIMIT);
    expect(output).toContain("and a short tail.");
  });

  it("does not join across a line of code", () => {
    const source = `// ${"word ".repeat(30).trim()}\nexport const a = 1;\n// short\n`;
    const output = reflowComments(source);

    expect(output).toContain("export const a = 1;");
    const afterCode = output.split("export const a = 1;\n")[1];
    expect(afterCode).toBe("// short\n");
  });

  it("leaves a trailing comment alone, because wrapping would detach it from its line", () => {
    const source = `export const a = 1; // ${"word ".repeat(30).trim()}\n`;
    expect(reflowComments(source)).toBe(source);
  });

  it("reaches a comment alone between braces, which belongs to no node", () => {
    // An empty `catch` whose only content is a note saying why. Nothing leads the comment and
    // nothing precedes it on its line, so a pass that only looks at node boundaries walks straight
    // past it — which is what happened, and what the emitted bundles then failed the width check on.
    const source = [
      "try {",
      "  risky();",
      "} catch {",
      `  // ${"word ".repeat(30).trim()}`,
      "}",
      "",
    ].join("\n");
    const output = reflowComments(source);

    expect(widest(output)).toBeLessThanOrEqual(LIMIT);
    expect(output).toContain("} catch {");
    expect(output).toContain("  risky();");
  });
});

describe("the width", () => {
  it("follows the caller's printWidth", async () => {
    const source = `/**\n * ${"word ".repeat(30).trim()}\n */\nexport const a = 1;\n`;

    const narrow = await formatSource(source, { printWidth: 60 });
    expect(widest(narrow)).toBeLessThanOrEqual(60);

    const wide = await formatSource(source, { printWidth: 120 });
    expect(widest(wide)).toBeLessThanOrEqual(120);

    // The same prose, so a wider limit has to mean fewer lines. Asserting only the ceiling would pass
    // for an implementation that ignored the option and wrapped everything at 80.
    expect(proseLines(wide)).toBeLessThan(proseLines(narrow));
  });
});

describe("stability", () => {
  const messy = [
    "/**",
    ` * ${"word ".repeat(40).trim()}`,
    " */",
    "export class A {",
    `  // ${"note ".repeat(30).trim()}`,
    "  b = 1;",
    "}",
    "",
  ].join("\n");

  it("is idempotent, so output cannot drift on a second pass", () => {
    const once = reflowComments(messy);
    expect(reflowComments(once)).toBe(once);
  });

  it("survives re-formatting, so the pass and Prettier agree", async () => {
    const formatted = await formatSource(messy);
    expect(await formatSource(formatted)).toBe(formatted);
  });
});
