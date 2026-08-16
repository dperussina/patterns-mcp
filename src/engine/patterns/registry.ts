/**
 * The registered pattern modules, keyed by the catalog name each implements.
 *
 * Separate from the pipeline because two callers need it and only one of them generates. `describe_pattern`
 * has to tell a caller which names a pattern keeps for itself (FR-052), and those names are declared next
 * to the template that writes them — deliberately, since a copy in the catalogue data would drift the first
 * time a template gained a helper. Reading them means reading the modules, and a description asking the
 * generator for them would put the catalogue downstream of the pipeline it describes.
 */

import { adapterPattern } from "./adapter/index.js";
import { asyncQueuePattern } from "./async-queue/index.js";
import { brandedTypePattern } from "./branded-type/index.js";
import { builderPattern } from "./builder/index.js";
import { chatModelPortPattern } from "./chat-model-port/index.js";
import { circuitBreakerPattern } from "./circuit-breaker/index.js";
import { contextBudgetPattern } from "./context-budget/index.js";
import { debouncePattern } from "./debounce/index.js";
import { decoratorPattern } from "./decorator/index.js";
import { discriminatedUnionPattern } from "./discriminated-union/index.js";
import { factoryPattern } from "./factory/index.js";
import { gatewayPattern } from "./gateway/index.js";
import { modelMiddlewarePattern } from "./model-middleware/index.js";
import { parseDontValidatePattern } from "./parse-dont-validate/index.js";
import { repositoryPattern } from "./repository/index.js";
import { resultPattern } from "./result/index.js";
import { retryPattern } from "./retry/index.js";
import { semaphorePattern } from "./semaphore/index.js";
import { specificationPattern } from "./specification/index.js";
import { streamAccumulatorPattern } from "./stream-accumulator/index.js";
import { structuredOutputPattern } from "./structured-output/index.js";
import { tokenBucketPattern } from "./token-bucket/index.js";
import { toolLoopPattern } from "./tool-loop/index.js";
import { typedEmitterPattern } from "./typed-emitter/index.js";
import { typestatePattern } from "./typestate/index.js";
import { unitOfWorkPattern } from "./unit-of-work/index.js";

import type { PatternModule } from "./types.js";

export const MODULES: readonly PatternModule[] = [
  adapterPattern,
  asyncQueuePattern,
  brandedTypePattern,
  builderPattern,
  chatModelPortPattern,
  circuitBreakerPattern,
  contextBudgetPattern,
  debouncePattern,
  decoratorPattern,
  discriminatedUnionPattern,
  factoryPattern,
  gatewayPattern,
  modelMiddlewarePattern,
  parseDontValidatePattern,
  repositoryPattern,
  resultPattern,
  retryPattern,
  semaphorePattern,
  specificationPattern,
  streamAccumulatorPattern,
  structuredOutputPattern,
  tokenBucketPattern,
  toolLoopPattern,
  typedEmitterPattern,
  typestatePattern,
  unitOfWorkPattern,
];

/**
 * @throws Error when the catalogue advertises a pattern nothing implements. That is our defect, and it
 * must not be reported as though the caller asked for something invalid.
 */
export function moduleFor(name: string): PatternModule {
  const module = MODULES.find((candidate) => candidate.name === name);

  if (module === undefined) {
    throw new Error(
      `catalog advertises pattern "${name}" but no module implements it; ` +
        `the catalog entry and src/engine/patterns/ have diverged`,
    );
  }

  return module;
}

/**
 * The names this pattern writes literally, which a caller's name therefore cannot be.
 *
 * Empty for a pattern that reads no identifier, since nothing a caller sends reaches a declaration site
 * there, and for one whose every name is derived.
 */
export function reservedNames(pattern: string): readonly string[] {
  return [...(MODULES.find((candidate) => candidate.name === pattern)?.emits ?? [])].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
