# result

## Resolved options

{
  "includeAsync": false,
  "includeCollections": true,
  "includeTests": false
}

## order-result.ts (core)

```ts
/**
 * OrderResult: the outcome of an operation that can fail, as a value.
 *
 * Narrow with `isOk` or `isErr` to reach either arm:
 *
 * ```ts
 * const outcome = parse(input);
 * if (isOk(outcome)) {
 *   use(outcome.value);
 * } else {
 *   report(outcome.error);
 * }
 * ```
 *
 * Testing `outcome.ok` directly reads the same way and works in a project with
 * `strictNullChecks` on. The predicates additionally narrow without it, so they are what the
 * combinators below use and what this module recommends.
 */
export type OrderResult<T, E = Error> = Ok<T> | Err<E>;
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
/**
 * Wraps a successful value.
 *
 * The return type is the whole union with `never` on the failure side, not `Ok<T>` alone.
 * That is what lets `andThen(result, (n) => ok(n + 1))` infer: a bare `Ok<T>` carries no
 * information about the error arm, so the error type would infer as `unknown` and every call
 * site would need a type argument written by hand.
 */
export function ok<T>(value: T): OrderResult<T, never> {
  return { ok: true, value };
}
/** Wraps a failure. Mirrors `ok`, with `never` on the success side for the same reason. */
export function err<E>(error: E): OrderResult<never, E> {
  return { ok: false, error };
}
/**
 * Narrowing helpers, used by every combinator below as well as by callers.
 *
 * They are not a convenience here, they are load-bearing. Reading `result.ok` narrows the
 * union only when `strictNullChecks` is on; under a `strict: false` project the discriminant
 * stops narrowing and `result.error` becomes an error on the success arm. A type predicate
 * narrows the same way under every configuration, so the module compiles for every caller.
 */
export function isOk<T, E>(result: OrderResult<T, E>): result is Ok<T> {
  return result.ok;
}
export function isErr<T, E>(result: OrderResult<T, E>): result is Err<E> {
  return !result.ok;
}
/** Transforms the success arm, leaving a failure untouched. */
export function map<T, U, E>(
  result: OrderResult<T, E>,
  transform: (value: T) => U,
): OrderResult<U, E> {
  return isOk(result) ? ok(transform(result.value)) : err(result.error);
}
/** Transforms the failure arm, leaving a success untouched. */
export function mapErr<T, E, F>(
  result: OrderResult<T, E>,
  transform: (error: E) => F,
): OrderResult<T, F> {
  return isErr(result) ? err(transform(result.error)) : ok(result.value);
}
/** Chains an operation that can itself fail, without nesting the results. */
export function andThen<T, U, E>(
  result: OrderResult<T, E>,
  next: (value: T) => OrderResult<U, E>,
): OrderResult<U, E> {
  return isOk(result) ? next(result.value) : err(result.error);
}
/** Supplies a replacement for a failure, for recovery paths. */
export function orElse<T, E, F>(
  result: OrderResult<T, E>,
  recover: (error: E) => OrderResult<T, F>,
): OrderResult<T, F> {
  return isErr(result) ? recover(result.error) : ok(result.value);
}
/** Extracts the value, or returns `fallback` for a failure. */
export function unwrapOr<T, E>(result: OrderResult<T, E>, fallback: T): T {
  return isOk(result) ? result.value : fallback;
}
/** Extracts the value, computing a fallback from the error only when needed. */
export function unwrapOrElse<T, E>(
  result: OrderResult<T, E>,
  fallback: (error: E) => T,
): T {
  return isOk(result) ? result.value : fallback(result.error);
}
/**
 * Extracts the value or throws.
 *
 * Provided for the boundary where a value-typed error has to become an exception again — a test
 * assertion, or a framework that reports thrown errors. Prefer the combinators inside your own
 * code; this exists so the escape hatch is explicit rather than improvised.
 */
export function unwrap<T, E>(result: OrderResult<T, E>): T {
  if (isOk(result)) {
    return result.value;
  }
  throw result.error instanceof Error
    ? result.error
    : new Error(String(result.error));
}
/** Collapses both arms to one type, so a caller can render either outcome in one expression. */
export function match<T, E, U>(
  result: OrderResult<T, E>,
  cases: { readonly ok: (value: T) => U; readonly err: (error: E) => U },
): U {
  return isOk(result) ? cases.ok(result.value) : cases.err(result.error);
}
/** Runs a throwing function and captures its exception as a failure. */
export function attempt<T>(operation: () => T): OrderResult<T, Error> {
  try {
    return ok(operation());
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
/**
 * Collects many results into one. Returns the first failure in order, so the outcome does not
 * depend on which operation happened to finish first.
 */
export function all<T, E>(
  results: Iterable<OrderResult<T, E>>,
): OrderResult<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (isErr(result)) {
      return err(result.error);
    }
    values.push(result.value);
  }
  return ok(values);
}
/** Splits results into successes and failures, preserving order within each. */
export function partition<T, E>(
  results: Iterable<OrderResult<T, E>>,
): { readonly values: T[]; readonly errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (isOk(result)) {
      values.push(result.value);
    } else {
      errors.push(result.error);
    }
  }
  return { values, errors };
}
```

## order-result-example.ts (example)

```ts
/**
 * How to adopt OrderResult.
 *
 * A parser is the shortest honest example: it has a real failure case, and the failure carries
 * information the caller needs rather than being a bare null.
 */

import { andThen, err, map, match, ok, unwrapOr } from "./order-result.js";
import type { OrderResult } from "./order-result.js";

interface Config {
  readonly port: number;
}

function parsePort(raw: string): OrderResult<number, string> {
  const port = Number(raw);
  if (!Number.isInteger(port)) {
    return err(`port must be an integer, received ${JSON.stringify(raw)}`);
  }
  if (port < 1 || port > 65535) {
    return err(`port must be between 1 and 65535, received ${String(port)}`);
  }
  return ok(port);
}

export function readConfig(raw: string): OrderResult<Config, string> {
  return map(parsePort(raw), (port) => ({ port }));
}

/** Chaining: each step runs only if the one before it succeeded. */
export function describeConfig(raw: string): string {
  const described = andThen(readConfig(raw), (config) =>
    ok(`listening on ${String(config.port)}`),
  );

  return match(described, {
    ok: (message) => message,
    err: (problem) => `configuration rejected: ${problem}`,
  });
}

/** Falling back without branching, where a default is genuinely acceptable. */
export function portOrDefault(raw: string): number {
  return unwrapOr(parsePort(raw), 8080);
}
```
