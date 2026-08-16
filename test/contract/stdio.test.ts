/**
 * The stdio entry point (T041).
 *
 * One property dominates this transport: **stdout is the protocol**. A single stray `console.log` from
 * anywhere in the process — our code, a dependency, a warning — lands in the middle of the JSON-RPC
 * stream and desynchronises the client, which is a failure mode that looks like a parse error a long
 * way from its cause. So these tests assert stdout purity as directly as they can, and assert that
 * writes which would have gone there are diverted to stderr instead.
 *
 * Real frames over injected streams rather than a spawned process, through the harness in `frames.ts`:
 * the SDK's transport takes its streams as constructor arguments, so the wire format, the framing, and
 * the handshake are all genuinely exercised without a build step standing between the test and the code.
 */

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stderrLog } from "../../src/mcp/log.js";
import { SERVER_NAME, SERVER_TITLE, VERSION } from "../../src/version.js";
import { frames } from "./frames.js";
import type { Frames } from "./frames.js";

/** The 2025-era opening, which is what this suite is about; `revision.test.ts` covers the modern one. */
async function initialized(): Promise<Frames> {
  const session = frames();
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

let open: Frames | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("serving over stdio", () => {
  it("completes the handshake and names the server", async () => {
    open = frames();
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
    const result = response.result as {
      serverInfo?: { name?: string; title?: string; version?: string };
    };
    // The registry name, not a display name: `name` identifies and `title` is what a person reads, so a
    // client can show "Patterns" while still being able to match the server to its registry entry.
    expect(result.serverInfo?.name).toBe(SERVER_NAME);
    expect(result.serverInfo?.title).toBe(SERVER_TITLE);
    expect(result.serverInfo?.version).toBe(VERSION);
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

  /**
   * The same property across a session that does the work, rather than one that only lists.
   *
   * Listing is the cheap path and it exercises none of the machinery that writes: generation runs a
   * compiler in a subprocess, executes the emitted tests, and formats every file. Any of those could put
   * a warning on the process's stdout, and a refusal is the path where our own diagnostics are written.
   * A session that stops at `tools/list` would not notice.
   *
   * `smoke-packaged.ts` makes the same assertion against the built binary in a spawned process, which is
   * the only place a subprocess inheriting the real file descriptor could be caught. This one covers the
   * sequence — discovery, generation, refusal — and catches it a great deal earlier.
   */
  it("keeps stdout clean across a session that generates and refuses", async () => {
    open = await initialized();

    open.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await open.response(2);

    open.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "describe_pattern", arguments: { pattern: "result" } },
    });
    await open.response(3);

    open.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "generate_pattern",
        arguments: { pattern: "result", identifiers: { entity: "Order" } },
      },
    });
    const generated = await open.response(4);
    expect((generated.result as { isError?: boolean }).isError, "generation failed, so this proves little")
      .not.toBe(true);

    open.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "generate_pattern", arguments: { pattern: "no-such-pattern" } },
    });
    const refused = await open.response(5);
    expect((refused.result as { isError?: boolean }).isError, "the refusal path was not taken").toBe(true);

    open.send({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "pattern://catalog" } });
    await open.response(6);

    const parsed = open.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.every((message) => message.jsonrpc === "2.0")).toBe(true);
    // Every request answered, so nothing was lost to a desynchronised stream rather than kept clean.
    expect(parsed.map((message) => message.id).filter((id) => id !== undefined).toSorted()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  }, 120_000);
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
