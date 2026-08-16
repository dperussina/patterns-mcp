/**
 * The server driven by raw JSON-RPC frames, with no client library in between.
 *
 * Two suites need this and they need it for different reasons. `stdio.test.ts` asserts that stdout
 * carries nothing but protocol frames, which is only observable if the test holds the stream itself.
 * `revision.test.ts` asserts what a `2026-07-28` client receives, and parts of that are invisible through
 * a typed client: it validates results against schemas and drops what they do not mention, so
 * `resultType` — a field the revision requires on every result — never reaches the caller.
 *
 * Real frames over injected streams rather than a spawned process: the SDK's transport takes its streams
 * as constructor arguments, so the wire format, the framing, and the era decision are all genuinely
 * exercised without a build step standing between the test and the code.
 */

import { PassThrough } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { serveStdioOn } from "../../src/mcp/transports/stdio.js";

export interface Frames {
  send(message: Record<string, unknown>): void;
  /** Resolves with the response bearing `id`, or rejects if none arrives. */
  response(id: number): Promise<Record<string, unknown>>;
  /** Sends a request and resolves with its response. */
  request(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Every line stdout has emitted so far, blank lines dropped. */
  lines(): readonly string[];
  logged: string[];
  close(): Promise<void>;
}

/**
 * Opens a connection with nothing sent on it.
 *
 * Fresh per call, and that matters more than it looks: the entry point pins the connection to whichever
 * era opens it, so a legacy request arriving after a modern one is answered as a violation rather than as
 * a legacy request. Any test comparing the two eras needs one of these each.
 */
export function frames(timeoutMs = 15_000): Frames {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logged: string[] = [];

  const handle = serveStdioOn({
    transport: new StdioServerTransport(stdin, stdout),
    log: (line) => logged.push(line),
  });

  let buffered = "";
  const lines: string[] = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();

  stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim() === "") continue;
      lines.push(part);
      const parsed = JSON.parse(part) as Record<string, unknown>;
      const id = typeof parsed.id === "number" ? parsed.id : undefined;
      if (id !== undefined) waiting.get(id)?.(parsed);
    }
  });

  const self: Frames = {
    send(message) {
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    async response(id) {
      return await new Promise((resolve, reject) => {
        const found = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((message) => message.id === id);
        if (found !== undefined) {
          resolve(found);
          return;
        }
        waiting.set(id, resolve);
        setTimeout(() => {
          reject(new Error(`no response to request ${String(id)} within ${String(timeoutMs)}ms`));
        }, timeoutMs);
      });
    },
    async request(id, method, params = {}) {
      self.send({ jsonrpc: "2.0", id, method, params });
      return await self.response(id);
    },
    lines: () => lines,
    logged,
    async close() {
      await handle.close();
    },
  };

  return self;
}
