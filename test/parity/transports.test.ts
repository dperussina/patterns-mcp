/**
 * The same request over both transports, compared byte for byte (FR-029, FR-030).
 *
 * FR-029 makes it a MUST that every surface produce identical results for identical inputs, and the
 * transports are the pair most likely to drift without anyone noticing: the local one is what every other
 * contract suite drives and what the author uses, while the remote one is served by a different SDK entry —
 * `createMcpHandler` rather than `serveStdio` — with its own era classification, its own response shaping,
 * and an SSE upgrade path stdio has no equivalent of. Everything else in the repository would still pass if
 * one of them started returning a different envelope.
 *
 * Serialised bytes rather than deep equality, for the reason the CLI/MCP suite gives: deep equality
 * tolerates exactly the drift worth catching, and a caller comparing a recorded response against a live one
 * is comparing bytes.
 *
 * `_meta` is excluded from the comparison and checked separately. It is legitimately allowed to differ —
 * the cache hint is a property of the transport's caching story, not of the answer — so demanding equality
 * there would be asserting something the specification does not require. What FR-029 is about is the
 * result.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { httpHandler } from "../../src/mcp/transports/http.js";
import type { HttpHandler } from "../../src/mcp/transports/http.js";
import { REVISION } from "../contract/client.js";
import { frames } from "../contract/frames.js";
import type { Frames } from "../contract/frames.js";

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

let local: Frames;
let remote: HttpHandler;

/**
 * Raw frames on the local side rather than the SDK's typed client, which is not a stylistic choice.
 *
 * The typed client validates each result against the schema it holds and drops anything the schema omits,
 * so `resultType` — required on every result by the revision — never reaches the caller. Reading raw frames
 * on one side and a typed client on the other reports a difference on every case, and the difference is the
 * harness rather than the server. Both sides are read the way a wire reads them.
 *
 * Modern on both sides for the same reason: an HTTP request carrying the per-request envelope is served in
 * the modern era, so a legacy stdio connection would be the wrong comparison.
 */
beforeAll(() => {
  local = frames();
  remote = httpHandler({ log: () => {} });
});

afterAll(async () => {
  await local.close();
  await remote.close();
});

let nextId = 1;

/** Calls a tool over the local transport, framed the way the revision requires. */
async function overStdio(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frame = await local.request(nextId++, "tools/call", { name, arguments: args, _meta: ENVELOPE });
  expect(frame.error, `${name} failed over stdio: ${JSON.stringify(frame.error)}`).toBeUndefined();
  return (frame.result ?? {}) as Record<string, unknown>;
}

/** Calls a tool over HTTP and returns the result object, with the headers the revision requires. */
async function overHttp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await remote.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, _meta: ENVELOPE },
      }),
    }),
  );

  const text = await response.text();
  const frame = (
    response.headers.get("content-type")?.includes("text/event-stream") === true
      ? JSON.parse(
          text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .at(-1) ?? "{}",
        )
      : JSON.parse(text)
  ) as { result?: Record<string, unknown>; error?: unknown };

  expect(frame.error, `${name} failed over HTTP: ${JSON.stringify(frame.error)}`).toBeUndefined();
  return frame.result ?? {};
}

/**
 * A tool list reduced to what a client decides from: names and schemas, sorted, without `_meta`.
 *
 * A difference here is a client that works against one transport and refuses on the other, which is the
 * failure this comparison exists to catch.
 */
function shape(tools: readonly Record<string, unknown>[]): string {
  return JSON.stringify(
    tools
      .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name))),
    null,
    2,
  );
}

/** Everything but `_meta`, serialised the way the parity comparison wants it. */
function comparable(result: Record<string, unknown>): string {
  const { _meta: _ignored, ...rest } = result;
  return JSON.stringify(rest, null, 2);
}

describe("a tool call over each transport", () => {
  it.each([
    { name: "list_patterns", args: {} },
    { name: "list_patterns", args: { kind: "advisory" } },
    { name: "describe_pattern", args: { pattern: "circuit-breaker" } },
    // An advisory pattern, whose result is a different shape from a bundle and so a different chance to
    // diverge.
    { name: "generate_pattern", args: { pattern: "singleton" } },
    // A refusal. Both transports compose their own message, and a refusal is where a transport is most
    // tempted to add something of its own.
    { name: "generate_pattern", args: { pattern: "no-such-pattern" } },
  ])("returns identical bytes for $name $args", async ({ name, args }) => {
    expect(comparable(await overHttp(name, args))).toBe(comparable(await overStdio(name, args)));
  });

  it("returns identical bytes for a real generation, which is the expensive path", async () => {
    const args = { pattern: "result", identifiers: { entity: "Invoice" }, options: { includeTests: false } };

    // Includes the provenance header and the verification record, so this also proves the two transports
    // agree about the compiler options a bundle was checked under.
    expect(comparable(await overHttp("generate_pattern", args))).toBe(
      comparable(await overStdio("generate_pattern", args)),
    );
  });
});

describe("the tool list itself", () => {
  it("advertises the same tools with the same schemas", async () => {
    const response = await remote.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: ENVELOPE } }),
      }),
    );
    const { result } = (await response.json()) as { result: { tools: readonly Record<string, unknown>[] } };

    const listed = await local.request(nextId++, "tools/list", { _meta: ENVELOPE });
    const viaStdio = listed.result as { tools: readonly Record<string, unknown>[] };

    expect(shape(result.tools)).toBe(shape(viaStdio.tools));
  });
});
