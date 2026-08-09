/**
 * A connected client and server sharing a process, for the contract suites.
 *
 * Contract tests go through the protocol rather than calling handlers directly, because most of what
 * this layer promises only exists once a request has been serialized: schema validation of the
 * arguments, `structuredContent` against the declared `outputSchema`, and `isError` as a result
 * rather than a thrown exception. Calling a handler in isolation would assert none of it.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createServer } from "../../src/mcp/server.js";

export interface Session {
  readonly client: Client;
  close(): Promise<void>;
}

export async function connect(): Promise<Session> {
  const server = createServer();
  const client = new Client({ name: "contract-tests", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
