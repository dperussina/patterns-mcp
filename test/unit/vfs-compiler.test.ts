/**
 * Compiler-backed tests for the verification file system.
 *
 * The pure tests in `vfs.test.ts` assert what the callbacks return. These assert that the real
 * compiler agrees, which is the only way to catch a tri-state mistake: a VFS that looks correct and
 * reports every global as missing is exactly the failure this module exists to prevent.
 *
 * These spawn the tsgo subprocess, so they cost roughly a second each. They stay because the
 * alternative is trusting a contract we would otherwise only have read about.
 */

import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import type { FileSystem } from "typescript/unstable/fs";
import { afterEach, describe, expect, it } from "vitest";

import { createVerificationFileSystem } from "../../src/engine/verify/vfs.js";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "es2022",
    lib: ["es2022"],
    module: "preserve",
    moduleResolution: "bundler",
    noEmit: true,
  },
  include: ["**/*.ts"],
});

interface Diagnostic {
  readonly code: number;
  readonly text?: string;
}

const openApis: API[] = [];

afterEach(async () => {
  // The API owns a subprocess; leaking one per test would outlive the run.
  await Promise.all(openApis.splice(0).map((api) => api.close()));
});

async function diagnose(fs: FileSystem, cwd = "/v"): Promise<readonly Diagnostic[] | undefined> {
  const api = new API({ fs, cwd });
  openApis.push(api);
  const snapshot = await api.updateSnapshot({ openProjects: [`${cwd}/tsconfig.json`] });
  const project = snapshot.getProjects()[0];
  if (project === undefined) return undefined;
  return (await project.program.getSemanticDiagnostics()) as readonly Diagnostic[];
}

describe("lib resolution", () => {
  it("resolves globals through the lib fall-through", async () => {
    const files = {
      "/v/tsconfig.json": TSCONFIG,
      "/v/index.ts":
        "export const p: Promise<number> = Promise.resolve(1);\n" +
        "export const m = new Map<string, number>();\n",
    };
    expect(await diagnose(createVerificationFileSystem({ files }))).toEqual([]);
  });

  it("reports missing globals when lib fall-through is sealed", async () => {
    // Pins the trap this module documents. Returning null for lib paths does not fail cleanly; it
    // fails as a pile of "Cannot find name" errors that read like a defect in the generated bundle.
    const files = {
      "/v/tsconfig.json": TSCONFIG,
      "/v/index.ts":
        "export const p: Promise<number> = Promise.resolve(1);\n" +
        "export const m = new Map<string, number>();\n",
    };
    const sealed = createVerificationFileSystem({ files, readThrough: () => false });
    const diagnostics = await diagnose(sealed);

    expect(diagnostics?.length).toBeGreaterThan(0);
    // TS2583: "Cannot find name X. Do you need to change your target library?"
    expect(diagnostics?.every((d) => d.code === 2583)).toBe(true);
    expect(diagnostics?.some((d) => d.text?.includes("Cannot find name 'Promise'"))).toBe(true);
  });

  it("still reports genuine type errors", async () => {
    const files = {
      "/v/tsconfig.json": TSCONFIG,
      "/v/index.ts": "export const x: string = 1;\n",
    };
    const diagnostics = await diagnose(createVerificationFileSystem({ files }));
    // TS2322: type not assignable.
    expect(diagnostics?.map((d) => d.code)).toEqual([2322]);
  });
});

describe("hermetic boundary", () => {
  it("does not resolve a module that exists only on the real filesystem", async () => {
    const files = {
      "/v/tsconfig.json": TSCONFIG,
      "/v/index.ts": 'import { x } from "/etc/hosts.ts";\nexport const y = x;\n',
    };
    const diagnostics = await diagnose(createVerificationFileSystem({ files }));
    // TS2307: cannot find module.
    expect(diagnostics?.map((d) => d.code)).toEqual([2307]);
  });

  it("refuses to open a tsconfig that is only on disk, where the built-in helper opens it", async () => {
    // The verified reason this module exists rather than deferring to createVirtualFileSystem. The
    // repository root holds a real tsconfig.json with strict enabled; the risk is not this file in
    // particular but that compiler options come from disk at all, so a bundle could be certified
    // under settings we never selected.
    const cwd = process.cwd();
    const files = { [`${cwd}/index.ts`]: "export const x = 1;\n" };

    expect(await diagnose(createVerificationFileSystem({ files }), cwd)).toBeUndefined();

    const viaBuiltin = await diagnose(createVirtualFileSystem(files), cwd);
    expect(viaBuiltin).toBeDefined();
  });
});
