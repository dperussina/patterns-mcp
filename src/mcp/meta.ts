/**
 * The `_meta` keys this server mints, and the prefix they are allowed to sit under.
 *
 * The revision closes the question of who may name what. A `_meta` key is a prefix and a name, and
 * "any prefix where the second label is `modelcontextprotocol` or `mcp` is reserved for MCP use" —
 * `io.modelcontextprotocol/`, `dev.mcp/`, and `com.mcp.tools/` alike. Only the specification and its
 * official extensions allocate keys there; everything else "use[s] their own vendor prefix".
 *
 * That rule caught this server minting `io.modelcontextprotocol/cache-hint`, which was chosen on the
 * reasoning that reusing the protocol's own vocabulary spared a client from learning a second spelling.
 * The reasoning was wrong twice over: the specification defines no such key, so no client could have
 * recognised it, and a key sitting in the reserved namespace is precisely what a future revision is
 * entitled to define differently — at which point our annotation would not be unrecognised but
 * *misread*, which is the one outcome worse than being ignored.
 *
 * So the prefix is one we can prove we hold. `perussina.com` is the domain that establishes this
 * server's registry namespace, `com.perussina/patterns` is the name it publishes under, and
 * `com.perussina.patterns/` is the same identity in the shape `_meta` asks for: reverse DNS, second
 * label `perussina`, therefore ours to allocate in.
 *
 * Gathered in one module because the keys are the server's vocabulary rather than any one feature's,
 * and because two features already needed them: a refusal carries both its error code and its
 * cacheability. A test asserts that nothing anywhere emits a key outside this prefix.
 */

/**
 * Reverse DNS for a domain this publisher holds, with a second label that is not `modelcontextprotocol`
 * or `mcp`, so the specification leaves the space below it to us.
 */
export const META_PREFIX = "com.perussina.patterns/";

/**
 * The engine's error code — `unknown_pattern`, `invalid_identifier`, and the rest.
 *
 * The text of a refusal is written for a reader; this is the same fact in a form a caller can branch on
 * without matching prose that is free to be reworded.
 */
export const ERROR_CODE_META_KEY = `${META_PREFIX}errorCode`;

/**
 * Whether the caller can fix this by changing the request.
 *
 * Derivable from the code by a caller holding a table of ours, which is the reason it is stated
 * separately: the distinction that decides whether to retry differently or to stop should not depend on
 * a table that can fall out of date.
 */
export const CORRECTABLE_META_KEY = `${META_PREFIX}correctable`;

/**
 * Cacheability for the results the protocol's own fields cannot describe — see `cache.ts` for why
 * `tools/call` is permanently among them.
 */
export const CACHE_HINT_META_KEY = `${META_PREFIX}cacheHint`;

/** Every key this server mints, for the test that no other one reaches the wire. */
export const META_KEYS = [
  ERROR_CODE_META_KEY,
  CORRECTABLE_META_KEY,
  CACHE_HINT_META_KEY,
] as const;
