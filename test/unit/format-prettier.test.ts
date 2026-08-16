import { describe, expect, it } from "vitest";

import { FormatConfigError } from "../../src/engine/errors.js";
import {
  FormatError,
  formatSource,
  mergeFormatOptions,
  warmFormatter,
} from "../../src/engine/format/prettier.js";

describe("formatSource", () => {
  it("formats TypeScript", async () => {
    expect(await formatSource("const a={b:1,c:2}")).toBe(
      "const a = { b: 1, c: 2 };\n",
    );
  });

  it("is idempotent, so re-formatting emitted output changes nothing", async () => {
    const once = await formatSource("export type A = {a:string}");
    expect(await formatSource(once)).toBe(once);
  });

  it("produces the same bytes for the same input", async () => {
    const source = "export class A { constructor(readonly b: string) {} }";
    expect(await formatSource(source)).toBe(await formatSource(source));
  });

  it("normalises CRLF input to LF output, so encoding does not leak into output", async () => {
    expect(await formatSource("const a = 1;\r\nconst b = 2;\r\n")).toBe(
      "const a = 1;\nconst b = 2;\n",
    );
  });

  it("applies caller style options", async () => {
    expect(await formatSource("const a = 'x'", { singleQuote: true })).toBe(
      "const a = 'x';\n",
    );
    expect(await formatSource("const a = 1", { semi: false })).toBe(
      "const a = 1\n",
    );
  });

  it("indents with tabs when asked, which takes indented code to observe", async () => {
    // A single-line statement has no indentation, so asserting useTabs against
    // one would pass whatever the setting did.
    const source = "export function f() { return 1; }";
    expect(await formatSource(source, { useTabs: true })).toContain(
      "\n\treturn 1;",
    );
    expect(
      await formatSource(source, { useTabs: false, tabWidth: 4 }),
    ).toContain("\n    return 1;");
  });

  it("honours printWidth", async () => {
    const source =
      "export const value = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };";
    expect(await formatSource(source, { printWidth: 40 })).toContain("\n");
    expect(await formatSource(source, { printWidth: 200 })).not.toContain(
      ",\n",
    );
  });
});

describe("invalid source is our defect, and its detail stays out of the message", () => {
  it("throws FormatError for unparseable source", async () => {
    await expect(formatSource("export class {{{")).rejects.toThrow(FormatError);
  });

  it("says the source is not valid TypeScript without quoting the code frame", async () => {
    try {
      await formatSource("export class {{{");
      throw new Error("expected a refusal");
    } catch (error) {
      const failure = error as FormatError;
      expect(failure.message).toBe(
        "Generated source could not be formatted, which means it is not valid TypeScript.",
      );
      // Prettier's own message carries a code frame and absolute paths; it is
      // kept for logs and off the message a caller could see (FR-038).
      expect(failure.message).not.toContain("SyntaxError");
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("caller configuration is an allowlist", () => {
  it("refuses plugins, which Prettier would import()", () => {
    // Verified against the pinned version: a plugins entry is resolved and
    // imported, so accepting it would make this an arbitrary-module-loading
    // surface rather than a style setting.
    expect(() => mergeFormatOptions({ plugins: ["./evil.js"] })).toThrow(
      FormatConfigError,
    );
  });

  it("refuses a parser override, since every file we emit is TypeScript", () => {
    expect(() => mergeFormatOptions({ parser: "babel" })).toThrow(
      FormatConfigError,
    );
  });

  it("pins the parser even if a caller somehow supplies one", () => {
    expect(mergeFormatOptions({}).parser).toBe("typescript");
  });

  it.each([
    "filepath",
    "rangeStart",
    "cursorOffset",
    "plugins",
    "parser",
    "nonsense",
  ])("refuses the non-configurable option %s", (option) => {
    expect(() => mergeFormatOptions({ [option]: 1 })).toThrow(
      FormatConfigError,
    );
  });

  it("names the configurable options so a caller can correct the call", () => {
    try {
      mergeFormatOptions({ nonsense: 1 });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as FormatConfigError).message).toContain("printWidth");
      expect((error as FormatConfigError).option).toBe("nonsense");
    }
  });

  it("refuses an unknown key rather than dropping it", () => {
    // A silently ignored setting leaves the caller believing they configured
    // something that had no effect.
    expect(() => mergeFormatOptions({ printWidthh: 100 })).toThrow(
      /not configurable/,
    );
  });

  it('refuses endOfLine "auto", which makes output depend on the input encoding', () => {
    expect(() => mergeFormatOptions({ endOfLine: "auto" })).toThrow(
      /makes output depend on the line endings/,
    );
  });

  it.each(["lf", "crlf"])("accepts the explicit endOfLine %s", (value) => {
    expect(mergeFormatOptions({ endOfLine: value }).endOfLine).toBe(value);
  });

  /**
   * A width narrower than the code can be proven at is refused, rather than attempted and blamed on us.
   *
   * A `@ts-expect-error` asserts about the line below it, so a width that wraps that line moves the
   * assertion off the expression it was written for: the directive is reported unused, the error it was
   * suppressing escapes, and the pattern fails its own verification. Three patterns do that below 40, and
   * what the caller received was `Generated code failed to compile. This is a defect in the pattern` —
   * true of every other cause of that message and useless here, since the one thing that would fix it is
   * the setting they chose.
   */
  it("refuses a print width narrower than the generated code is verified at", () => {
    expect(() => mergeFormatOptions({ printWidth: 30 })).toThrow(/narrowest width/);
  });

  it.each([40, 80, 120])("accepts the print width %i", (printWidth) => {
    expect(mergeFormatOptions({ printWidth }).printWidth).toBe(printWidth);
  });

  it("accepts every allowlisted option", () => {
    const merged = mergeFormatOptions({
      arrowParens: "avoid",
      bracketSpacing: false,
      printWidth: 100,
      quoteProps: "consistent",
      semi: false,
      singleQuote: true,
      tabWidth: 4,
      trailingComma: "none",
      useTabs: true,
    });
    expect(merged).toMatchObject({
      printWidth: 100,
      semi: false,
      parser: "typescript",
    });
  });
});

describe("warmFormatter", () => {
  it("is idempotent and safe to call concurrently", async () => {
    await Promise.all([warmFormatter(), warmFormatter(), warmFormatter()]);
    await expect(warmFormatter()).resolves.toBeUndefined();
  });

  it("carries nothing between calls: options still fully determine output", async () => {
    await warmFormatter();
    const wide = await formatSource("const a = 1", { printWidth: 200 });
    await formatSource("const b = 2", { semi: false });
    expect(await formatSource("const a = 1", { printWidth: 200 })).toBe(wide);
  });
});
