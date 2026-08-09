/**
 * The stdio entry point (T041).
 *
 * One property dominates this transport: **stdout is the protocol**. A single stray `console.log` from
 * anywhere in the process — our code, a dependency, a warning — lands in the middle of the JSON-RPC
 * stream and desynchronises the client, which is a failure mode that looks like a parse error a long
 * way from its cause. So these tests assert stdout purity as directly as they can, and assert that
 * writes which would have gone there are diverted to stderr instead.
 *
 * Real frames over injected streams rather than a spawned process: the SDK's transport takes its
 * streams as constructor arguments, so the wire format, the framing, and the handshake are all
 * genuinely exercised without a build step standing between the test and the code.
 */

import { PassThrough } from "node:stream";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stderrLog } from "../../src/mcp/log.js";
import { serveStdioOn } from "../../src/mcp/transports/stdio.js";

interface Harness {
  send(message: Record<string, unknown>): void;
  /** Resolves with the response bearing `id`, or rejects if the stream closes first. */
  response(id: number): Promise<Record<string, unknown>>;
  /** Every line stdout has emitted so far, blank lines dropped. */
  lines(): readonly string[];
  logged: string[];
  close(): Promise<void>;
}

function harness(): Harness {
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

  return {
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
          reject(new Error(`no response to request ${String(id)} within 10s`));
        }, 10_000);
      });
    },
    lines: () => lines,
    logged,
    async close() {
      await handle.close();
    },
  };
}

async function initialized(): Promise<Harness> {
  const session = harness();
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stdio-contract-tests", version: "0.0.0" },
    },
  });
  await session.response(1);
  session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return session;
}

let open: Harness | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("serving over stdio", () => {
  it("completes the handshake and names the server", async () => {
    open = harness();
    open.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stdio-contract-tests", version: "0.0.0" },
      },
    });

    const response = await open.response(1);
    const result = response.result as { serverInfo?: { name?: string } };
    expect(result.serverInfo?.name).toBe("patterns");
  });

  it("offers the same tools it offers in process", async () => {
    open = await initialized();
    open.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const response = await open.response(2);
    const result = response.result as { tools: readonly { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain("generate_pattern");
  });

  it("writes nothing to stdout that is not a protocol frame", async () => {
    open = await initialized();
    open.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await open.response(2);

    // Parsing every line is the assertion: a log line, a banner, or a warning would throw here.
    for (const line of open.lines()) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.jsonrpc).toBe("2.0");
    }
    expect(open.lines().length).toBeGreaterThan(0);
  });
});

describe("diagnostics", () => {
  it("report a malformed frame to the log sink and not to stdout", async () => {
    open = await initialized();
    // Well-formed JSON, but `method` is not a string, so it is not a message the server can answer.
    // The SDK surfaces this out of band — the path that would corrupt the stream if it took stdout.
    open.send({ jsonrpc: "2.0", id: 99, method: 12_345 });
    open.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    await open.response(3);

    expect(open.logged.join("\n")).toContain("error:");
    const parsed = open.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.every((message) => message.jsonrpc === "2.0")).toBe(true);
    expect(parsed.some((message) => message.id === 99)).toBe(false);
  });

  it("answer an unknown method in band, because that is a protocol reply and not a diagnostic", async () => {
    open = await initialized();
    open.send({ jsonrpc: "2.0", id: 4, method: "no/such/method", params: {} });

    const response = await open.response(4);
    expect((response.error as { code?: number }).code).toBe(-32_601);
  });

  it("are written to stderr by the default sink, never to stdout", () => {
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    try {
      stderrLog("something worth knowing");
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }

    expect(stderrWrites.join("")).toContain("something worth knowing");
    expect(stdoutWrites).toEqual([]);
  });
});
