/**
 * Choosing a verification path.
 *
 * The flag is a parameter rather than an environment variable on purpose. `process.env` in the engine
 * would make generation depend on ambient state, which is the thing Principle I exists to prevent, and
 * it would put the choice out of reach of a test. Whoever owns the process — the server or the CLI —
 * decides, and passes it in.
 */

import { FallbackTypechecker } from "./typecheck-fallback.js";
import { Typechecker } from "./typecheck.js";
import type { Verifier } from "./typecheck.js";

export type VerifierEngine = "fast" | "stable";

export interface VerifierOptions {
  /**
   * `fast` is the unstable TypeScript 7 API, roughly an order of magnitude quicker warm. `stable` is
   * the pinned TypeScript 6 `createProgram` path, for when the unstable one breaks.
   */
  readonly engine?: VerifierEngine;
  /** Only meaningful for `fast`, which is the path that holds a subprocess. */
  readonly timeoutMs?: number;
}

export function createVerifier(options: VerifierOptions = {}): Verifier {
  if (options.engine === "stable") return new FallbackTypechecker();
  // Omitted rather than passed as undefined, so the default applies under exactOptionalPropertyTypes.
  return new Typechecker(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
}

export { FallbackTypechecker, fallbackCompilerVersion } from "./typecheck-fallback.js";
export { Typechecker, compilerOptionsFor, compilerVersion } from "./typecheck.js";
export type {
  BundleFile,
  TypecheckOutcome,
  VerificationDiagnostic,
  Verifier,
} from "./typecheck.js";
export { createVerificationFileSystem, createMutableVerificationFileSystem, isLibPath } from "./vfs.js";
