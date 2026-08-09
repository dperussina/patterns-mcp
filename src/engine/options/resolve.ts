/**
 * Option resolution: the step that turns a caller's partial request into the
 * complete, fully determined option set that uniquely determines one output
 * (Principle I).
 *
 * The validation order is fixed by data-model.md because it decides which error
 * a caller receives when their request breaks more than one rule. A caller
 * correcting one complaint at a time must not see the complaint change
 * underneath them, so the order is asserted by test, not merely followed.
 *
 * Legality evaluation is step 6 and lives in `legality.ts` (T016). It runs after
 * defaults are applied, since a rule can only be evaluated against a complete
 * option set.
 */
import {
  InvalidIdentifierError,
  InvalidOptionValueError,
  MissingRequiredOptionError,
  UnknownOptionError,
} from "../errors.js";
import { ConventionsSchema, type Conventions } from "./conventions.js";
import { checkIdentifier } from "./identifiers.js";
import type { GenerativePattern, Option } from "../catalog/schema.js";

export type OptionValue = string | number | boolean;

export interface ResolveRequest {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly identifiers?: Readonly<Record<string, string>>;
  readonly conventions?: unknown;
  readonly variant?: string;
}

export interface ResolvedRequest {
  readonly pattern: string;
  /** Complete after defaults. Key order normalised by sort, never insertion order. */
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly conventions: Conventions;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly variant: string | undefined;
}

/**
 * Resolves a request against a pattern, or throws the first rule it breaks.
 *
 * Note that unknown option names are rejected rather than ignored. Silently
 * dropping an unrecognised option is the worse failure: the caller believes they
 * configured something, the output does not reflect it, and nothing says so.
 */
export function resolveOptions(
  pattern: GenerativePattern,
  request: ResolveRequest = {},
): ResolvedRequest {
  const declared = new Map(
    pattern.options.map((option) => [option.name, option]),
  );
  const supplied = request.options ?? {};

  // Step 2 — unknown option names. Iterated in sorted order so a request with
  // two unknown options always reports the same one first.
  for (const name of Object.keys(supplied).toSorted(compare)) {
    if (!declared.has(name)) {
      throw new UnknownOptionError(
        name,
        pattern.options.map((option) => option.name),
      );
    }
  }

  // Step 3 — declared type and value space, in the pattern's declared option
  // order rather than the caller's key order, so the error does not depend on
  // how the request object happened to be written.
  const resolved = new Map<string, OptionValue>();
  for (const option of pattern.options) {
    const value = supplied[option.name];

    if (value === undefined) {
      continue;
    }

    resolved.set(option.name, coerceOption(option, value));
  }

  // Step 3b — `variant` is a request field rather than a declared option, but it
  // is a value-space check like the others, so it is checked here (T101/FR-013).
  const variant = resolveVariant(pattern, request.variant);

  // Step 4 — identifiers. Checked before defaults are applied because an invalid
  // identifier is the caller's most likely mistake, and reporting it should not
  // depend on unrelated defaulting succeeding first.
  const identifiers: Record<string, string> = {};
  for (const field of Object.keys(request.identifiers ?? {}).toSorted(
    compare,
  )) {
    const value = (request.identifiers ?? {})[field] ?? "";
    const check = checkIdentifier(value, { label: field });
    if (!check.ok) {
      throw new InvalidIdentifierError(field, check.problem);
    }
    identifiers[field] = value;
  }

  // Step 5 — defaults for everything left unspecified.
  for (const option of pattern.options) {
    if (!resolved.has(option.name)) {
      resolved.set(option.name, option.default);
    }
  }

  requireCoreModule(resolved);

  return {
    pattern: pattern.name,
    options: normaliseKeyOrder(resolved),
    conventions: ConventionsSchema.parse(request.conventions),
    identifiers: normaliseKeyOrder(new Map(Object.entries(identifiers))),
    variant,
  };
}

function resolveVariant(
  pattern: GenerativePattern,
  requested: string | undefined,
): string | undefined {
  if (requested === undefined) {
    return undefined;
  }

  if (!pattern.variants.includes(requested)) {
    throw new InvalidOptionValueError("variant", requested, pattern.variants);
  }

  return requested;
}

/**
 * `coreModule` has no usable default: it names a module only the caller knows
 * about. It is therefore declared as an ordinary option but required once
 * `emitScope` is `binding-only`, which is a dependency between two options and
 * so cannot be expressed as a default (FR-018).
 */
function requireCoreModule(resolved: ReadonlyMap<string, OptionValue>): void {
  if (resolved.get("emitScope") !== "binding-only") {
    return;
  }

  const coreModule = resolved.get("coreModule");
  if (typeof coreModule !== "string" || coreModule.trim() === "") {
    throw new MissingRequiredOptionError(
      "coreModule",
      'when emitScope is "binding-only"',
    );
  }
}

function coerceOption(option: Option, value: unknown): OptionValue {
  switch (option.type) {
    case "enum": {
      if (typeof value !== "string" || !option.values.includes(value)) {
        throw new InvalidOptionValueError(option.name, value, option.values);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new InvalidOptionValueError(option.name, value, [
          "true",
          "false",
        ]);
      }
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new InvalidOptionValueError(option.name, value, ["an integer"]);
      }
      return value;
    }
    case "string": {
      if (typeof value !== "string") {
        throw new InvalidOptionValueError(option.name, value, ["a string"]);
      }
      return value;
    }
  }
}

/**
 * Rebuilds a record in sorted key order.
 *
 * Object key order is insertion order in JavaScript, so without this the
 * canonical serialisation behind `optionsHash` (T017) would differ between two
 * requests that specified the same options in a different sequence — and two
 * identical requests would then hash differently.
 */
function normaliseKeyOrder<T>(
  entries: ReadonlyMap<string, T>,
): Readonly<Record<string, T>> {
  const sorted: Record<string, T> = {};
  for (const key of [...entries.keys()].toSorted(compare)) {
    const value = entries.get(key);
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return sorted;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
