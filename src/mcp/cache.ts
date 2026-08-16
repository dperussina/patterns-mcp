/**
 * What a caller may cache, stated rather than left to a default (FR-042).
 *
 * Everything this server answers is a pure function of build-time data: the catalogue ships with the
 * package and generation is deterministic, so no answer can go stale while the process lives. Saying so
 * is worth a module because the SDK's fallback is the opposite — `ttlMs: 0`, `cacheScope: 'private'` —
 * and a conservative default here is not a safe choice but a wrong description, paid for on every
 * repeated call an agent makes while working through one task.
 *
 * **Two vehicles, because the protocol has one and it does not reach far enough.** The revision's
 * cacheable results are a closed list — the `list` operations, `resources/read`, `server/discover` — and
 * `tools/call` is deliberately not on it, so no protocol field will ever carry this for the three tools
 * that do the work. Those results carry it in `_meta` instead. That is an annotation a client may act on
 * rather than a protocol guarantee, which is the strongest thing available on that path, and it goes on
 * each *result* rather than only on the tool descriptor because a descriptor read once at discovery is
 * not a statement about the answer in hand.
 *
 * The annotation keeps the protocol's own *field* names, `ttlMs` and `cacheScope`, under a key of ours
 * (`meta.ts`): the field names are what a client would have to learn twice, while the key is the part
 * the revision reserves for itself.
 */

import type { CacheHint } from "@modelcontextprotocol/server";

import { CACHE_HINT_META_KEY } from "./meta.js";

/**
 * A day.
 *
 * The data cannot change without a new package version, so no TTL is wrong on the data's own terms and
 * the bound exists for the one case an unbounded one would break: an upgraded deployment answering a
 * client that still holds yesterday's response. Over stdio even that cannot happen, since a new version
 * is a new process — this is the remote transport's number.
 */
export const CACHE_TTL_MS = 86_400_000;

/**
 * Public, because every answer is identical for every caller.
 *
 * Nothing here reads authentication, a session, or anything else that varies between callers, so a
 * shared cache holding one copy for all of them cannot serve anybody the wrong thing. `private` would
 * be the honest value for a response shaped by who asked, and none of ours is.
 */
export const PUBLIC_CACHE_HINT: CacheHint = { ttlMs: CACHE_TTL_MS, cacheScope: "public" };

/**
 * The operations whose results the protocol itself can mark cacheable, each declared rather than left to
 * the fallback.
 *
 * The list is closed by the revision — `tools/call` is absent by design, not omission — so this is the
 * complete set, and a member missing from it would silently take `ttlMs: 0, cacheScope: 'private'`. Held
 * here as data so the declaration can be checked against that list directly, rather than only through the
 * wire: the SDK emits these fields on a modern session, so a legacy client sees none of them, and a suite
 * that only ever connected the way the SDK client connects by default would not notice a missing member.
 */
export const PROTOCOL_CACHE_HINTS: Readonly<Record<string, CacheHint>> = {
  "tools/list": PUBLIC_CACHE_HINT,
  "resources/list": PUBLIC_CACHE_HINT,
  "resources/templates/list": PUBLIC_CACHE_HINT,
  "resources/read": PUBLIC_CACHE_HINT,
  "server/discover": PUBLIC_CACHE_HINT,
};

/**
 * The hint as result metadata, for the results the protocol's own fields cannot reach.
 *
 * Returned fresh rather than shared so a caller can spread it into a `_meta` alongside other entries
 * without the risk of mutating one object every result points at.
 */
export function cacheHintMeta(): Record<string, unknown> {
  return { [CACHE_HINT_META_KEY]: { ...PUBLIC_CACHE_HINT } };
}
