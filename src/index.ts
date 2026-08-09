/**
 * The engine's public API (contracts/engine-api.md).
 *
 * The engine is the product; MCP, the CLI, and the agent skill are adapters over it (Principle X).
 * Nothing here may import an MCP package — that boundary is what keeps a second adapter possible, and
 * it is enforced by lint rather than left to discipline.
 *
 * `listPatterns` and `describePattern` are part of this surface and arrive with the catalog story
 * (T046, T047); they are absent rather than stubbed, so a caller cannot bind to a placeholder.
 */

export { generate, disposeEngine } from "./engine/generate/index.js";
export type { GenerateRequest, GenerateResult, Bundle } from "./engine/generate/index.js";

export type { File, EmitScope } from "./engine/generate/assemble.js";
export type { VerificationRecord, TestOutcome } from "./engine/verify/record.js";
export type { Conventions } from "./engine/options/conventions.js";

export {
  EngineError,
  CorrectableError,
  UnknownPatternError,
  UnknownOptionError,
  InvalidOptionValueError,
  IllegalCombinationError,
  InvalidIdentifierError,
  MissingRequiredOptionError,
  VerificationError,
  isCorrectable,
} from "./engine/errors.js";
export type { ErrorCode } from "./engine/errors.js";

export const version = "0.1.0";
