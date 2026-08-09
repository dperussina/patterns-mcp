import { describe, expect, it } from "vitest";

import { createVerificationFileSystem, isLibPath } from "../../src/engine/verify/vfs.js";

const files = {
  "/v/src/index.ts": "export const a = 1;\n",
  "/v/src/nested/deep.ts": "export const b = 2;\n",
  "/v/empty.ts": "",
  "/v/tsconfig.json": "{}",
};

const fs = createVerificationFileSystem({ files });

describe("isLibPath", () => {
  it("recognises lib declaration files wherever they live", () => {
    expect(isLibPath("/anywhere/lib.d.ts")).toBe(true);
    expect(isLibPath("/p/@typescript/typescript-darwin-arm64/lib/lib.es2022.d.ts")).toBe(true);
    expect(isLibPath("lib.dom.iterable.d.ts")).toBe(true);
    expect(isLibPath("/x/lib.esnext.collection.d.ts")).toBe(true);
  });

  it("does not mistake ordinary files for lib files", () => {
    expect(isLibPath("/v/src/index.ts")).toBe(false);
    expect(isLibPath("/v/lib.ts")).toBe(false);
    expect(isLibPath("/v/library.d.ts")).toBe(false);
    // A directory named lib is not a lib file.
    expect(isLibPath("/node_modules/typescript/lib")).toBe(false);
    // Nor is a file that merely lives beside them.
    expect(isLibPath("/typescript/lib/tsc.js")).toBe(false);
  });
});

describe("readFile tri-state", () => {
  it("returns content for files we own", () => {
    expect(fs.readFile?.("/v/src/index.ts")).toBe("export const a = 1;\n");
  });

  it("distinguishes an empty file from a missing one", () => {
    // The whole point of the tri-state: "" is content, and must not be confused with absence.
    expect(fs.readFile?.("/v/empty.ts")).toBe("");
    expect(fs.readFile?.("/v/absent.ts")).toBeNull();
  });

  it("returns undefined for lib paths so they resolve from disk", () => {
    // Returning null here is the documented trap: lib resolution stops and every global appears
    // to be missing.
    expect(fs.readFile?.("/pkg/lib/lib.es2022.d.ts")).toBeUndefined();
    expect(fs.readFile?.("/pkg/lib/lib.d.ts")).toBeUndefined();
  });

  it("returns null for unknown non-lib paths rather than reaching for disk", () => {
    // Distinct from the built-in createVirtualFileSystem, which returns undefined here and lets
    // generated code read real files.
    expect(fs.readFile?.("/etc/passwd")).toBeNull();
    expect(fs.readFile?.("/v/src/../../secrets.ts")).toBeNull();
    expect(fs.readFile?.("/Users/someone/.ssh/id_rsa")).toBeNull();
  });

  it("keeps null and undefined apart, since the compiler treats them differently", () => {
    const missing = fs.readFile?.("/v/absent.ts");
    const libFile = fs.readFile?.("/pkg/lib.es2022.d.ts");
    expect(missing).toBeNull();
    expect(libFile).toBeUndefined();
    expect(missing).not.toBe(libFile);
  });
});

describe("fileExists", () => {
  it("reports files we own", () => {
    expect(fs.fileExists?.("/v/src/index.ts")).toBe(true);
    expect(fs.fileExists?.("/v/empty.ts")).toBe(true);
  });

  it("has no opinion on lib paths", () => {
    // Returning false blocks lib resolution just as effectively as returning null from readFile,
    // which is what the built-in helper does.
    expect(fs.fileExists?.("/pkg/lib/lib.es2022.d.ts")).toBeUndefined();
  });

  it("denies unknown non-lib paths", () => {
    expect(fs.fileExists?.("/etc/passwd")).toBe(false);
  });
});

describe("directories", () => {
  it("knows the ancestors of every file it holds", () => {
    expect(fs.directoryExists?.("/v")).toBe(true);
    expect(fs.directoryExists?.("/v/src")).toBe(true);
    expect(fs.directoryExists?.("/v/src/nested")).toBe(true);
    expect(fs.directoryExists?.("/")).toBe(true);
  });

  it("defers on directories outside its tree", () => {
    // Answering false would break resolution for the directory holding the lib files.
    expect(fs.directoryExists?.("/usr/local")).toBeUndefined();
  });

  it("lists immediate children only", () => {
    expect(fs.getAccessibleEntries?.("/v/src")).toEqual({
      files: ["index.ts"],
      directories: ["nested"],
    });
    expect(fs.getAccessibleEntries?.("/v")).toEqual({
      files: ["empty.ts", "tsconfig.json"],
      directories: ["src"],
    });
  });

  it("returns sorted entries regardless of insertion order", () => {
    const shuffled = createVerificationFileSystem({
      files: { "/v/z.ts": "", "/v/a.ts": "", "/v/m.ts": "" },
    });
    expect(shuffled.getAccessibleEntries?.("/v")?.files).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("declines to enumerate directories it does not own", () => {
    expect(fs.getAccessibleEntries?.("/usr/local")).toBeUndefined();
  });
});

describe("realpath", () => {
  it("is the identity inside our tree", () => {
    expect(fs.realpath?.("/v/src/index.ts")).toBe("/v/src/index.ts");
    expect(fs.realpath?.("/v/src")).toBe("/v/src");
  });

  it("defers outside our tree", () => {
    expect(fs.realpath?.("/usr/local/bin/node")).toBeUndefined();
  });
});

describe("readThrough override", () => {
  it("widens the fall-through set when a caller opts in", () => {
    const permissive = createVerificationFileSystem({
      files,
      readThrough: (path) => isLibPath(path) || path.startsWith("/allowed/"),
    });
    expect(permissive.readFile?.("/allowed/thing.ts")).toBeUndefined();
    expect(permissive.fileExists?.("/allowed/thing.ts")).toBeUndefined();
    expect(permissive.readFile?.("/pkg/lib.es2022.d.ts")).toBeUndefined();
    expect(permissive.readFile?.("/denied/thing.ts")).toBeNull();
  });

  it("can be narrowed to nothing, which then blocks lib resolution", () => {
    // Documents the consequence rather than endorsing it.
    const sealed = createVerificationFileSystem({ files, readThrough: () => false });
    expect(sealed.readFile?.("/pkg/lib.es2022.d.ts")).toBeNull();
  });
});

describe("isolation from caller-supplied content", () => {
  it("does not mutate or retain the caller's files object", () => {
    const mutable: Record<string, string> = { "/v/a.ts": "original" };
    const created = createVerificationFileSystem({ files: mutable });
    mutable["/v/a.ts"] = "changed";
    mutable["/v/b.ts"] = "added";
    expect(created.readFile?.("/v/a.ts")).toBe("original");
    expect(created.readFile?.("/v/b.ts")).toBeNull();
  });
});
