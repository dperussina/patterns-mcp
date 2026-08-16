/**
 * A connected client and server sharing a process, for the contract suites.
 *
 * Contract tests go through the protocol rather than calling handlers directly, because most of what
 * this layer promises only exists once a request has been serialized: schema validation of the
 * arguments, `structuredContent` against the declared `outputSchema`, and `isError` as a result
 * rather than a thrown exception. Calling a handler in isolation would assert none of it.
 *
 * **Which era, and why it has to be said out loud.** Revision `2026-07-28` removed the `initialize`
 * handshake: a modern client states its protocol version on every request instead, and a server that
 * serves both eras behaves differently depending on how the connection opened. The SDK's client defaults
 * to `mode: 'legacy'` — the 2025 sequence — so a suite that just calls `connect()` tests the older of the
 * two paths, and does so invisibly. That is how the protocol's cache fields came to be declared, asserted,
 * and never once observed: they only appear on a modern session, and nothing here opened one.
 *
 * So the era is a parameter, and both are real: a host on either side of the revision is a host we serve.
 * The session is opened through `serveStdioOn` over a linked pair rather than by connecting an `McpServer`
 * directly, because the era decision belongs to that entry point — a directly connected server answers
 * `initialize` and nothing else, so "modern" would have been unreachable from here.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { serveStdioOn } from "../../src/mcp/transports/stdio.js";

/** The revision under test. Modern sessions pin it exactly, so a drift shows up as a failed connect. */
export const REVISION = "2026-07-28";

/**
 * `legacy` opens with `initialize` (2025-11-25 and earlier); `modern` carries version and capabilities
 * in each request's `_meta` (`2026-07-28`).
 */
export type Era = "legacy" | "modern";

export interface Session {
  readonly client: Client;
  readonly era: Era;
  close(): Promise<void>;
}

export async function connect(era: Era = "legacy"): Promise<Session> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdioOn({ transport: serverTransport });

  const client = new Client(
    { name: "contract-tests", version: "0.0.0" },
    // `pin` rather than `auto`: it probes with `server/discover` and fails loudly if the revision is not
    // offered, where `auto` would quietly fall back to `initialize` and hand back a legacy session under
    // a modern name — the failure this parameter exists to prevent.
    era === "modern" ? { versionNegotiation: { mode: { pin: REVISION } } } : {},
  );

  await client.connect(clientTransport);

  return {
    client,
    era,
    async close() {
      await client.close();
      // Closes the pinned server instance, which is what releases the engine's warm compiler.
      await handle.close();
    },
  };
}
