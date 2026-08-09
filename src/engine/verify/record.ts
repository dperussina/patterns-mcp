/**
 * The evidence attached to every returned bundle (FR-006).
 *
 * Principle III says a bundle that failed verification is never returned, which makes the record's
 * `diagnosticCount: 0` and `testOutcome` more than description — they are the assertion that the
 * principle held for this response. So this builder refuses to construct a record that would state
 * something verification did not establish, rather than trusting its caller to only ask when it is
 * true. The failure mode it exists to prevent is a bundle with no tests reporting that tests passed.
 */

import { hashCanonical } from "../provenance/hash.js";
import type { File } from "../generate/assemble.js";

/** `failed` is deliberately absent: it is not a returnable state (data-model.md). */
export type TestOutcome = "passed" | "skipped";

export interface VerificationRecord {
  readonly compilerVersion: string;
  readonly formatterVersion: string;
  /** What was actually verified against — the caller's conventions, once resolved. */
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  readonly diagnosticCount: 0;
  readonly testOutcome: TestOutcome;
  /** Over the ordered files, so a caller can detect drift in what they installed. */
  readonly contentHash: string;
}

export interface RecordInput {
  readonly files: readonly File[];
  readonly compilerVersion: string;
  readonly formatterVersion: string;
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly unknown[];
  readonly testOutcome: TestOutcome;
}

export function buildVerificationRecord(input: RecordInput): VerificationRecord {
  if (input.diagnostics.length > 0) {
    throw new RecordError(
      `cannot record a verified bundle carrying ${String(input.diagnostics.length)} diagnostic(s); ` +
        `a bundle that did not typecheck is thrown, not returned`,
    );
  }

  const hasTests = input.files.some((file) => file.role === "test");

  if (input.testOutcome === "passed" && !hasTests) {
    throw new RecordError(
      "cannot record testOutcome \"passed\" for a bundle containing no test files; " +
        "the correct record is \"skipped\"",
    );
  }

  if (input.testOutcome === "skipped" && hasTests) {
    throw new RecordError(
      "cannot record testOutcome \"skipped\" for a bundle containing test files; " +
        "those tests must be executed before the bundle is returned",
    );
  }

  return {
    compilerVersion: input.compilerVersion,
    formatterVersion: input.formatterVersion,
    compilerOptions: input.compilerOptions,
    diagnosticCount: 0,
    testOutcome: input.testOutcome,
    contentHash: contentHash(input.files),
  };
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

/**
 * Covers each file's path and contents in the order they will be returned, and nothing else. Folding
 * the compiler or formatter version in would change the hash on every release and report drift that no
 * file experienced, which is the same reasoning that keeps them out of the provenance header (FR-021).
 *
 * Order is included rather than sorted away: files arrive already sorted by assembly, so a different
 * order means a different bundle.
 */
function contentHash(files: readonly File[]): string {
  return hashCanonical(
    JSON.stringify(files.map((file) => [file.path, file.contents])),
  );
}
