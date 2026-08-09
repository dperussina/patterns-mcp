/**
 * The record is evidence, not decoration (data-model.md). Its whole purpose is that a caller can tell
 * what was actually checked, so the two states it must never represent are a bundle that failed and a
 * bundle whose tests were never run but are reported as passing.
 */

import { describe, expect, it } from "vitest";

import { buildVerificationRecord } from "../../src/engine/verify/record.js";
import type { File } from "../../src/engine/generate/assemble.js";

const files: readonly File[] = [
  { path: "result.ts", role: "core", contents: "export const ok = 1;\n" },
  { path: "result.test.ts", role: "test", contents: "// tests\n" },
];

const base = {
  files,
  compilerVersion: "7.0.2",
  formatterVersion: "prettier@3.9.6",
  compilerOptions: { strict: true, target: "es2023" },
  diagnostics: [] as readonly unknown[],
};

describe("a record only exists for a bundle that passed", () => {
  it("reports zero diagnostics and passing tests", () => {
    const record = buildVerificationRecord({ ...base, testOutcome: "passed" });
    expect(record).toMatchObject({
      compilerVersion: "7.0.2",
      formatterVersion: "prettier@3.9.6",
      diagnosticCount: 0,
      testOutcome: "passed",
    });
    expect(record.compilerOptions).toEqual({ strict: true, target: "es2023" });
  });

  it("refuses to record a bundle that produced diagnostics", () => {
    // Principle III: a bundle that failed verification is our defect and is thrown, never returned.
    // If this path were reachable the record would be a claim that nothing checked.
    expect(() =>
      buildVerificationRecord({
        ...base,
        diagnostics: ["result.ts(1,1): error TS2322"],
        testOutcome: "passed",
      }),
    ).toThrow(/diagnostic/i);
  });

  it("refuses to claim tests passed when the bundle contains none", () => {
    expect(() =>
      buildVerificationRecord({
        ...base,
        files: [files[0]!],
        testOutcome: "passed",
      }),
    ).toThrow(/test/i);
  });

  it("refuses to claim tests were skipped when the bundle contains some", () => {
    expect(() => buildVerificationRecord({ ...base, testOutcome: "skipped" })).toThrow(/test/i);
  });

  it("records skipped for a bundle with no tests", () => {
    const record = buildVerificationRecord({
      ...base,
      files: [files[0]!],
      testOutcome: "skipped",
    });
    expect(record.testOutcome).toBe("skipped");
    expect(record.diagnosticCount).toBe(0);
  });
});

describe("the content hash", () => {
  it("covers every file's path and contents", () => {
    const record = buildVerificationRecord({ ...base, testOutcome: "passed" });
    const changedContents = buildVerificationRecord({
      ...base,
      files: [{ ...files[0]!, contents: "export const ok = 2;\n" }, files[1]!],
      testOutcome: "passed",
    });
    const changedPath = buildVerificationRecord({
      ...base,
      files: [{ ...files[0]!, path: "outcome.ts" }, files[1]!],
      testOutcome: "passed",
    });
    expect(changedContents.contentHash).not.toBe(record.contentHash);
    expect(changedPath.contentHash).not.toBe(record.contentHash);
  });

  it("is stable across calls, so a caller can compare it to detect drift", () => {
    const first = buildVerificationRecord({ ...base, testOutcome: "passed" });
    const second = buildVerificationRecord({ ...base, testOutcome: "passed" });
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("does not change when the toolchain does", () => {
    // The hash exists so a caller can tell whether the *bundle* drifted. Folding the compiler version
    // in would change it on every release and report drift that no file experienced (FR-021).
    const record = buildVerificationRecord({ ...base, testOutcome: "passed" });
    const laterCompiler = buildVerificationRecord({
      ...base,
      compilerVersion: "7.1.0",
      formatterVersion: "prettier@4.0.0",
      testOutcome: "passed",
    });
    expect(laterCompiler.contentHash).toBe(record.contentHash);
  });

  it("distinguishes a reordering of the same files", () => {
    // Order is part of the bundle: files arrive sorted, so a different order is a different bundle.
    const reversed = buildVerificationRecord({
      ...base,
      files: [files[1]!, files[0]!],
      testOutcome: "passed",
    });
    expect(reversed.contentHash).not.toBe(
      buildVerificationRecord({ ...base, testOutcome: "passed" }).contentHash,
    );
  });
});
