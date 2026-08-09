/**
 * Assembly is where iteration order would leak into output if it were going to. A pattern renders its
 * files in whatever order its template happens to read most clearly; the bundle a caller receives is
 * sorted by role and then by path, so the same request lists the same files in the same places
 * forever (Principle I, FR-004).
 */

import { describe, expect, it } from "vitest";

import { assembleBundle, ROLE_ORDER } from "../../src/engine/generate/assemble.js";
import type { EmitScope } from "../../src/engine/generate/assemble.js";
import type { RenderedFile } from "../../src/engine/patterns/types.js";

const file = (path: string, role: RenderedFile["role"]): RenderedFile => ({
  path,
  role,
  contents: `// ${path}\n`,
});

/** One of every role, deliberately in the reverse of the expected order. */
const oneOfEach: readonly RenderedFile[] = [
  file("types.ts", "types"),
  file("example.ts", "example"),
  file("result.test.ts", "test"),
  file("adapter.ts", "adapter"),
  file("binding.ts", "binding"),
  file("result.ts", "core"),
];

function assemble(
  files: readonly RenderedFile[],
  emitScope: EmitScope = "full",
): readonly string[] {
  return assembleBundle({ pattern: "result", files, emitScope }).map((f) => f.path);
}

describe("ordering", () => {
  it("orders by role first, in the declared sequence", () => {
    expect(ROLE_ORDER).toEqual(["types", "core", "binding", "adapter", "example", "test"]);
    expect(assemble(oneOfEach)).toEqual([
      "types.ts",
      "result.ts",
      "binding.ts",
      "adapter.ts",
      "example.ts",
      "result.test.ts",
    ]);
  });

  it("orders by path within a role, not by the order the template emitted them", () => {
    const files = [
      file("z.ts", "core"),
      file("a.ts", "core"),
      file("nested/b.ts", "core"),
      file("m.ts", "core"),
      file("example.ts", "example"),
    ];
    expect(assemble(files)).toEqual(["a.ts", "m.ts", "nested/b.ts", "z.ts", "example.ts"]);
  });

  it("gives the same order however the input is shuffled", () => {
    const rotations: string[][] = [];
    for (let i = 0; i < oneOfEach.length; i++) {
      rotations.push(assemble([...oneOfEach.slice(i), ...oneOfEach.slice(0, i)]) as string[]);
    }
    for (const rotation of rotations) {
      expect(rotation).toEqual(rotations[0]);
    }
  });

  it("sorts by code unit, so ordering does not depend on the host's locale", () => {
    // localeCompare would order these differently under some collations, and the collation available
    // depends on the ICU build the host's Node was compiled with.
    const files = [
      file("Z.ts", "core"),
      file("a.ts", "core"),
      file("B.ts", "core"),
      file("example.ts", "example"),
    ];
    expect(assemble(files)).toEqual(["B.ts", "Z.ts", "a.ts", "example.ts"]);
  });
});

describe("paths a caller could not have chosen", () => {
  it.each([
    ["/etc/passwd", "absolute"],
    ["../escape.ts", "traversal"],
    ["nested/../../escape.ts", "traversal through a nested segment"],
    ["c:\\windows\\file.ts", "a drive letter"],
    ["back\\slash.ts", "backslashes"],
    ["", "empty"],
  ])("refuses %s (%s)", (path) => {
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file(path, "core"), file("example.ts", "example")],
        emitScope: "full",
      }),
    ).toThrow(/path/i);
  });

  it("refuses two files at the same path rather than letting one win", () => {
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file("result.ts", "core"), file("result.ts", "types"), file("example.ts", "example")],
        emitScope: "full",
      }),
    ).toThrow(/result\.ts/);
  });
});

describe("emit scope", () => {
  it("emits everything under full", () => {
    expect(assemble(oneOfEach, "full")).toHaveLength(6);
  });

  it("keeps the machinery and drops the per-type binding under core-only", () => {
    expect(assemble(oneOfEach, "core-only")).toEqual([
      "types.ts",
      "result.ts",
      "example.ts",
      "result.test.ts",
    ]);
  });

  it("keeps only the binding and its adapter under binding-only", () => {
    // The caller already has the machinery; re-emitting it would overwrite a file they may have
    // edited, and re-emitting its tests would duplicate a suite they are already running.
    expect(assemble(oneOfEach, "binding-only")).toEqual(["binding.ts", "adapter.ts"]);
  });

  it("refuses a scope that would emit nothing, rather than returning an empty bundle", () => {
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file("result.ts", "core"), file("example.ts", "example")],
        emitScope: "binding-only",
      }),
    ).toThrow(/binding-only/);
  });
});

describe("a usage example is part of the promise", () => {
  it("refuses a full bundle with no example, which FR-004 requires", () => {
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file("result.ts", "core"), file("result.test.ts", "test")],
        emitScope: "full",
      }),
    ).toThrow(/example/i);
  });

  it("does not accept the test file as the example", () => {
    // A test shows the API being exercised, an example shows it being adopted. They read differently
    // and US1 acceptance scenario 1 asks for both.
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file("result.ts", "core"), file("example.test.ts", "test")],
        emitScope: "full",
      }),
    ).toThrow(/example/i);
  });

  it("does not require one where nothing is emitted for a caller to adopt", () => {
    expect(() =>
      assembleBundle({
        pattern: "result",
        files: [file("binding.ts", "binding")],
        emitScope: "binding-only",
      }),
    ).not.toThrow();
  });
});

describe("what assembly carries through", () => {
  it("keeps contents byte-for-byte and reports each file's role", () => {
    const assembled = assembleBundle({
      pattern: "result",
      files: [file("result.ts", "core"), file("example.ts", "example")],
      emitScope: "full",
    });
    expect(assembled[0]).toMatchObject({
      path: "result.ts",
      role: "core",
      contents: "// result.ts\n",
    });
    expect(assembled.map((f) => f.role)).toEqual(["core", "example"]);
  });
});
