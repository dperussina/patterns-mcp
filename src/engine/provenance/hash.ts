/**
 * Canonical serialisation and the options hash.
 *
 * The hash identifies the *inputs* that produced a bundle, so a later agent can
 * read a repository and tell what is already installed and how it was asked for
 * (FR-020). It deliberately excludes generator and toolchain versions: embedding
 * them would rewrite the header of every generated file on every release, and
 * destroy the diff-stability the header exists to support (FR-021).
 */
import { createHash } from "node:crypto";

import type { ResolvedRequest } from "../options/resolve.js";

/**
 * Hash length in hex characters, 64 bits.
 *
 * Named rather than inlined so the header emitter (T057) does not re-decide it.
 * Full SHA-256 is 64 characters, which makes a header line unreadable for no
 * gain here: the hash distinguishes request inputs, it is not a security
 * boundary, and nothing downstream trusts it to be unforgeable.
 */
export const HASH_LENGTH = 16;

/** What the hash covers. See `optionsHash` for what is deliberately absent. */
export interface HashInput {
  readonly pattern: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly variant: string | undefined;
}

/**
 * Deterministic JSON: object keys sorted at every depth, array order preserved
 * because it is semantic, and no whitespace.
 *
 * Plain `JSON.stringify` is not enough. Object key order in JavaScript is
 * insertion order, so two requests carrying the same options in a different
 * sequence would serialise differently and hash differently — the same output
 * with two provenance headers.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value, []));
}

/**
 * The hash of a request's inputs.
 *
 * `variant` is included. data-model.md names pattern, options and identifiers,
 * and predates the `variant` field; omitting it would give two bundles with
 * materially different content the same provenance, which is the one thing this
 * value must not do.
 *
 * `conventions` is excluded, following data-model.md. Note that conventions do
 * affect output bytes, so two bundles differing only by `moduleStyle` share a
 * hash — see specs/.../blockers.md, where that question is recorded for review
 * rather than settled here.
 */
export function optionsHash(input: HashInput): string {
  return hashCanonical(
    canonicalize({
      pattern: input.pattern,
      options: input.options,
      identifiers: input.identifiers,
      // Always present as a key, so adding a variant to a pattern does not
      // change the hash of requests that do not use one.
      variant: input.variant ?? null,
    }),
  );
}

/** Convenience for the common case of hashing a fully resolved request. */
export function hashResolvedRequest(resolved: ResolvedRequest): string {
  return optionsHash({
    pattern: resolved.pattern,
    options: resolved.options,
    identifiers: resolved.identifiers,
    variant: resolved.variant,
  });
}

export function hashCanonical(canonical: string): string {
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

/**
 * Rebuilds a value with sorted keys, rejecting anything JSON would quietly
 * mangle.
 *
 * `NaN` and `Infinity` serialise to `null`, and a function or symbol property
 * vanishes. Each would let two different inputs hash identically, so they are
 * refused instead. `path` is threaded through purely to name the offender.
 */
function canonicalValue(value: unknown, path: readonly string[]): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${describePath(path)} is ${String(value)}, which has no canonical form`,
      );
    }
    // Normalises -0 to 0; they are indistinguishable to a caller but not to
    // JSON.stringify in every position.
    return value === 0 ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalValue(item, [...path, String(index)]),
    );
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).toSorted(compare)) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      sorted[key] = canonicalValue(entry, [...path, key]);
    }
    return sorted;
  }

  throw new TypeError(
    `${describePath(path)} is of type ${typeof value}, which has no canonical form`,
  );
}

function describePath(path: readonly string[]): string {
  return path.length === 0 ? "value" : `value at ${path.join(".")}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
