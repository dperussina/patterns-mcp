/**
 * The engine's public API (contracts/engine-api.md).
 *
 * The engine is the product; MCP, the CLI, and the agent skill are adapters over it (Principle X).
 * Nothing here may import an MCP package — that boundary is what keeps a second adapter possible, and
 * it is enforced by lint rather than left to discipline.
 */

import { describePattern as describeIn } from "./engine/catalog/describe.js";
import { listPatterns as listIn } from "./engine/catalog/list.js";
import type { ListFilters, PatternSummary } from "./engine/catalog/list.js";
import { catalogOnce } from "./engine/catalog/load.js";

import type { PatternDetail } from "./engine/catalog/describe.js";

export { generate, disposeEngine } from "./engine/generate/index.js";
export type {
  GenerateRequest,
  GenerateResult,
  Bundle,
  Advisory,
} from "./engine/generate/index.js";

export type { ListFilters, PatternSummary } from "./engine/catalog/list.js";
export type { PatternDetail } from "./engine/catalog/describe.js";
export type { Category, Option, PatternKind, Tier, LegalityRule } from "./engine/catalog/schema.js";

/**
 * Discovery, with the catalogue bound.
 *
 * The functions underneath take a catalogue explicitly, which is what makes them testable against a
 * fixture; these are the same functions with the shipped catalogue supplied. Adapters call these rather
 * than loading it themselves, so there is one answer to "what is in the catalogue" per process.
 *
 * Both are `async` where contracts/engine-api.md shows them synchronous. The catalogue is read from
 * disk, and the only way to keep the documented signature would be a synchronous read — which means a
 * second loader and therefore a second cache, the duplication these exist to avoid. `generate` is
 * already async, so a caller awaiting all three is not paying a new cost.
 */
export async function listPatterns(filter?: ListFilters): Promise<readonly PatternSummary[]> {
  return listIn(await catalogOnce(), filter);
}

export interface Listing {
  readonly patterns: readonly PatternSummary[];
  /**
   * How many matched. `patterns.length` today, and reported separately because it is the field that
   * stays meaningful if a response ever has to be truncated.
   */
  readonly total: number;
}

/**
 * A listing as every surface returns it.
 *
 * The envelope is here rather than in an adapter because three places answer this question — the MCP
 * tool, the MCP catalogue resource, and the CLI — and they must not answer it differently. It lived in
 * the MCP tool while the CLI printed a bare array under `--json`, so the two surfaces disagreed about
 * the shape of the one response a script is most likely to parse, and the byte-for-byte parity test
 * (T073) is what found it.
 */
export async function listCatalogue(filter?: ListFilters): Promise<Listing> {
  const patterns = await listPatterns(filter);
  return { patterns, total: patterns.length };
}

/** @throws UnknownPatternError naming the nearest catalogue entries. */
export async function describePattern(name: string): Promise<PatternDetail> {
  return describeIn(await catalogOnce(), name);
}

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
  UnsupportedRuntimeError,
  VerificationError,
  isCorrectable,
} from "./engine/errors.js";
export type { ErrorCode } from "./engine/errors.js";

export { VERSION as version } from "./version.js";
