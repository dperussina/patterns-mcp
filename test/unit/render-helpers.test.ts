import { describe, expect, it } from "vitest";

import {
  dedent,
  indent,
  joinLines,
  sortBy,
  when,
} from "../../src/engine/render/helpers.js";

describe("dedent", () => {
  it("strips the indentation a template is written at", () => {
    const rendered = dedent`
      export class Person {
        readonly id: string;
      }
    `;

    expect(rendered).toBe("export class Person {\n  readonly id: string;\n}");
  });

  it("drops leading and trailing blank lines but keeps interior ones", () => {
    expect(dedent`
      first

      second
    `).toBe("first\n\nsecond");
  });

  it("re-indents a multi-line interpolation to its placeholder's column", () => {
    const members = "readonly id: string;\nreadonly name: string;";

    expect(dedent`
      export interface Person {
        ${members}
      }
    `).toBe(
      "export interface Person {\n  readonly id: string;\n  readonly name: string;\n}",
    );
  });

  it("leaves a single-line interpolation alone", () => {
    expect(dedent`
      const name = ${"'Person'"};
    `).toBe("const name = 'Person';");
  });

  it("joins an interpolated array as lines, at the placeholder's column", () => {
    expect(dedent`
      export interface Person {
        ${["readonly id: string;", "readonly name: string;"]}
      }
    `).toBe(
      "export interface Person {\n  readonly id: string;\n  readonly name: string;\n}",
    );
  });

  it("renders an absent interpolation as nothing rather than 'undefined'", () => {
    expect(dedent`before${undefined}after`).toBe("beforeafter");
    expect(dedent`before${null}after`).toBe("beforeafter");
  });

  it("does not indent blank lines inside an interpolation", () => {
    const block = "first\n\nsecond";
    expect(dedent`
      wrapper {
        ${block}
      }
    `).toBe("wrapper {\n  first\n\n  second\n}");
  });

  it("normalises CRLF, so output does not depend on the checkout that built it", () => {
    expect(dedent`a${"one\r\ntwo"}b`).toBe("aone\ntwob");
  });

  it("is idempotent for already-flush templates", () => {
    expect(dedent`a\nb`).toBe("a\nb");
  });
});

describe("indent", () => {
  it("prefixes non-blank lines and leaves blank lines empty", () => {
    expect(indent("a\n\nb")).toBe("  a\n\n  b");
  });

  it("accepts an explicit width", () => {
    expect(indent("a", 4)).toBe("    a");
  });
});

describe("when", () => {
  it("emits the branch that holds", () => {
    expect(when(true, "yes")).toBe("yes");
    expect(when(false, "yes")).toBe("");
    expect(when(false, "yes", "no")).toBe("no");
  });

  it("yields an empty string that joinLines can drop, not a blank line", () => {
    expect(joinLines("a", when(false, "middle"), "b")).toBe("a\nb");
  });
});

describe("joinLines", () => {
  it("drops blank and whitespace-only parts", () => {
    expect(joinLines("a", "", "   ", "b")).toBe("a\nb");
  });

  it("flattens nested arrays, so a mapped result needs no spreading", () => {
    expect(joinLines(["a", "b"], "c")).toBe("a\nb\nc");
  });

  it("splits multi-line parts so a blank line inside one is still dropped", () => {
    expect(joinLines("a\n\nb")).toBe("a\nb");
  });
});

describe("sortBy", () => {
  it("sorts by a derived string key without mutating the input", () => {
    const input = [{ n: "c" }, { n: "a" }, { n: "b" }];
    const sorted = sortBy(input, (item) => item.n);

    expect(sorted.map((i) => i.n)).toEqual(["a", "b", "c"]);
    expect(input.map((i) => i.n)).toEqual(["c", "a", "b"]);
  });

  it("sorts numeric keys numerically rather than as strings", () => {
    const sorted = sortBy([{ n: 10 }, { n: 9 }, { n: 100 }], (item) => item.n);
    expect(sorted.map((i) => i.n)).toEqual([9, 10, 100]);
  });

  it("accepts any iterable", () => {
    expect(sortBy(new Set(["b", "a"]), (s) => s)).toEqual(["a", "b"]);
  });
});
