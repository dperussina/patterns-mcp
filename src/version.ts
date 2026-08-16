/**
 * The release number, and the name the registry knows this server by.
 *
 * Both are written here because each was on its way to having several copies: the version appeared in
 * `package.json`, in the engine's public API, and in the handshake the server sends, and publication
 * adds a fourth in `server.json`. The MCP registry rejects a submission whose `server.json` version
 * disagrees with the published package's, and it does so without saying which field is wrong.
 *
 * The two files outside TypeScript cannot import this, so a test compares them against it instead —
 * the same arrangement as the Node floor, and for the same reason: a constant and a manifest are the
 * pair most likely to drift, because nothing about editing one suggests the other.
 */

export const VERSION = "0.1.0";

/**
 * The reverse-DNS name under which this server is published.
 *
 * A namespace the publisher can prove they own is what the registry requires, and `com.perussina` is
 * proven by a DNS record rather than by a code host, which keeps the identity attached to the domain
 * instead of to an account on a service.
 *
 * Sent as the handshake's `name`, with a human-readable `title` beside it, which is the division the
 * protocol draws: `name` identifies, `title` is what a person reads.
 */
export const SERVER_NAME = "com.perussina/patterns";

export const SERVER_TITLE = "Patterns";
