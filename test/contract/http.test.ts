/**
 * The remote transport: FR-030's second connection kind, and FR-037's rules about how it must refuse.
 *
 * Most of what is asserted here is behaviour the SDK provides rather than code of ours, and that is the
 * argument for asserting it. FR-037 is a list of MUSTs — validate the declared origin and target host,
 * reject a request whose declared operation contradicts its content, refuse superseded request forms,
 * never create or echo a session identifier — and "the handler does that" is a claim about a dependency
 * that can change under us in a patch release. A conformance requirement satisfied by accident is one
 * nobody notices losing.
 *
 * Driven through `handler.fetch` with `Request` objects rather than over a socket, except where the point
 * is the socket. The handler is the whole server at request level; a port adds a listener and no behaviour,
 * and a suite that bound one per case would trade determinism for nothing.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST,
  DEFAULT_PATH,
  httpHandler,
  httpRefusal,
  parseServeArgs,
  serveHttp,
} from "../../src/mcp/transports/http.js";
import { REVISION } from "./client.js";

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

const ENDPOINT = `http://localhost${DEFAULT_PATH}`;

/** A modern request, framed the way the revision requires: envelope in `_meta`, method named in a header. */
function post(
  method: string,
  params: Record<string, unknown> = {},
  overrides: { readonly url?: string; readonly headers?: Record<string, string>; readonly id?: number } = {},
): Request {
  const url = overrides.url ?? ENDPOINT;

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "Mcp-Method": method,
      // Set explicitly because a constructed `Request` has no `Host` header — the runtime adds it when the
      // request is actually sent — whereas anything arriving over a socket always does. Omitting it here
      // would test a request no client can make, and every case would be refused for that reason.
      host: new URL(url).host,
      // `Mcp-Name` is required, not merely checked when present, on any request whose params carry a
      // `name`. Asserted below; mirrored here so the ordinary cases are framed the way a client must frame
      // them.
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      ...overrides.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: overrides.id ?? 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
}

async function jsonOf(response: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await response.text();
  // SSE when the exchange upgraded; the frame is the last `data:` line either way.
  if (response.headers.get("content-type")?.includes("text/event-stream") === true) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    return JSON.parse(data.at(-1) ?? "{}") as { result?: Record<string, unknown> };
  }
  return JSON.parse(text) as { result?: Record<string, unknown> };
}

/** Runs `body` against a fresh handler and disposes it, whatever happens. */
async function withHandler<T>(
  options: Parameters<typeof httpHandler>[0],
  body: (fetch: (request: Request) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const handler = httpHandler({ log: () => {}, ...options });
  try {
    return await body(handler.fetch);
  } finally {
    await handler.close();
  }
}

describe("serving the protocol over HTTP (FR-030)", () => {
  it("answers a modern request with no handshake before it", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list"));
      expect(response.status).toBe(200);

      const { result } = await jsonOf(response);
      const tools = (result?.tools ?? []) as readonly { name: string }[];
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([
        "describe_pattern",
        "generate_pattern",
        "list_patterns",
      ]);
    });
  });

  it("serves the same catalogue the local transport does", async () => {
    await withHandler({}, async (fetch) => {
      const { result } = await jsonOf(await fetch(post("tools/call", { name: "list_patterns", arguments: {} })));
      const structured = result?.structuredContent as { total?: number } | undefined;
      expect(structured?.total).toBeGreaterThan(0);
    });
  });

  it("holds nothing between requests (FR-031)", async () => {
    await withHandler({}, async (fetch) => {
      // Two requests on one handler, the second identical to the first. A server keeping per-connection
      // state would need the handshake the first one did not perform, and would refuse this.
      const first = await jsonOf(await fetch(post("tools/list", {}, { id: 1 })));
      const second = await jsonOf(await fetch(post("tools/list", {}, { id: 2 })));
      expect(second.error).toBeUndefined();
      expect(second.result).toEqual(first.result);
    });
  });
});

describe("the host and origin a request declares (FR-037)", () => {
  it("refuses a Host it does not recognise, before the protocol sees it", async () => {
    await withHandler({}, async (fetch) => {
      // The DNS-rebinding case: a browser resolved the attacker's name to this address, so the request
      // arrives here carrying that name.
      const response = await fetch(post("tools/list", {}, { headers: { host: "attacker.example" } }));
      expect(response.status).toBe(403);

      const { result } = await jsonOf(response);
      expect(result, "a refused request must not be served").toBeUndefined();
    });
  });

  it("refuses a request naming no host at all", async () => {
    await withHandler({}, async (fetch) => {
      const headerless = new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "Mcp-Method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: ENVELOPE } }),
      });
      // Deny on absence rather than pass: `Host` is mandatory in HTTP/1.1, so a request without one is
      // either malformed or constructed to evade the check, and neither deserves service.
      expect((await fetch(headerless)).status).toBe(403);
    });
  });

  it("refuses an Origin it does not recognise", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list", {}, { headers: { origin: "https://attacker.example" } }));
      expect(response.status).toBe(403);
    });
  });

  it("allows a request with no Origin, which is every non-browser client", async () => {
    await withHandler({}, async (fetch) => {
      expect((await fetch(post("tools/list"))).status).toBe(200);
    });
  });

  it("honours an allowlist the operator supplies", async () => {
    await withHandler({ allowedHosts: ["patterns.internal"], allowedOrigins: ["patterns.internal"] }, async (fetch) => {
      const allowed = await fetch(
        post("tools/list", {}, {
          url: "http://patterns.internal/mcp",
          headers: { host: "patterns.internal", origin: "https://patterns.internal" },
        }),
      );
      expect(allowed.status).toBe(200);

      // And the default set is replaced rather than extended, or naming a host would widen the surface
      // instead of narrowing it.
      const refused = await fetch(post("tools/list", {}, { headers: { host: "localhost" } }));
      expect(refused.status).toBe(403);
    });
  });
});

/**
 * The header/body agreement rule, which the specification makes a MUST and the SDK turned out to enforce.
 *
 * These were written to answer whether we had to implement it (research.md open item 1, T082). We do not —
 * so what they do now is hold the dependency to it. Were a future SDK to stop checking, a request whose
 * header says one operation and whose body performs another would be served, which is the confusion the
 * rule exists to prevent.
 */
describe("a request whose headers contradict its body (FR-037)", () => {
  it("refuses a Mcp-Method naming a different method", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list", {}, { headers: { "Mcp-Method": "tools/call" } }));
      expect(response.status).toBe(400);

      const { error } = await jsonOf(response);
      expect(error?.code).toBe(-32020);
      expect(error?.message).toContain("Mcp-Method");
    });
  });

  it("refuses a request with no Mcp-Method at all", async () => {
    await withHandler({}, async (fetch) => {
      const bare = new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: ENVELOPE } }),
      });
      const { error } = await jsonOf(await fetch(bare));
      expect(error?.code).toBe(-32020);
    });
  });

  it("requires Mcp-Name on a call, rather than only checking one that is present", async () => {
    await withHandler({}, async (fetch) => {
      // Worth its own case because the asymmetry is invisible from the specification's wording and is the
      // likeliest way a client written against the local transport fails when pointed at this one: over
      // stdio there are no headers to omit. Built by hand rather than through `post`, which supplies the
      // header precisely because it is required.
      const response = await fetch(
        new Request(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            host: "localhost",
            "Mcp-Method": "tools/call",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_patterns", arguments: {}, _meta: ENVELOPE },
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect((await jsonOf(response)).error?.code).toBe(-32020);
    });
  });

  it("refuses a Mcp-Name naming a different tool", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(
        post("tools/call", { name: "list_patterns", arguments: {} }, { headers: { "Mcp-Name": "generate_pattern" } }),
      );
      expect(response.status).toBe(400);
      expect((await jsonOf(response)).error?.code).toBe(-32020);
    });
  });

  it("refuses a MCP-Protocol-Version disagreeing with the envelope", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list", {}, { headers: { "MCP-Protocol-Version": "2099-01-01" } }));
      expect(response.status).toBe(400);
      expect((await jsonOf(response)).error?.code).toBe(-32020);
    });
  });
});

describe("superseded request forms and session identifiers (FR-037)", () => {
  it.each([["GET"], ["DELETE"]])("answers a 2025-era %s session operation with 405", async (method) => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(new Request(ENDPOINT, { method, headers: { host: "localhost" } }));
      // Not 403: the host gate passed, so this is the transport declining the operation itself rather
      // than the request being turned away at the door.
      expect(response.status).toBe(405);
    });
  });

  it("never mints a session identifier", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list"));
      expect(response.headers.get("mcp-session-id")).toBeNull();
    });
  });

  it("neither reads nor echoes one a client sends", async () => {
    await withHandler({}, async (fetch) => {
      const response = await fetch(post("tools/list", {}, { headers: { "Mcp-Session-Id": "smuggled" } }));
      // Served on its own terms, and the identifier is not reflected: nothing here is keyed on it.
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
    });
  });
});

describe("the endpoint path", () => {
  it("serves the configured path and nothing else", async () => {
    await withHandler({}, async (fetch) => {
      expect((await fetch(post("tools/list", {}, { url: "http://localhost/mcp" }))).status).toBe(200);

      const elsewhere = await fetch(post("tools/list", {}, { url: "http://localhost/" }));
      expect(elsewhere.status).toBe(404);
      // Parseable JSON-RPC rather than a bare status, so a client library reports the URL instead of a
      // parse failure that sends its user looking for a protocol bug.
      const { error } = await jsonOf(elsewhere);
      expect(error?.message).toContain("/mcp");
    });
  });

  it("can be mounted somewhere else", async () => {
    await withHandler({ path: "/rpc" }, async (fetch) => {
      expect((await fetch(post("tools/list", {}, { url: "http://localhost/rpc" }))).status).toBe(200);
      expect((await fetch(post("tools/list", {}, { url: "http://localhost/mcp" }))).status).toBe(404);
    });
  });
});

describe("refusing to start", () => {
  it("says so when the runtime cannot sandbox tests (FR-053)", () => {
    expect(httpRefusal({}, "20.11.0")).toContain("22.13.0");
    expect(httpRefusal({}, "22.13.0")).toBeUndefined();
  });

  it("refuses a public bind whose allowlist would refuse every caller", () => {
    // The failure this prevents is a server that starts, listens, and 403s everything — which reads as
    // broken rather than as unconfigured.
    const refusal = httpRefusal({ host: "0.0.0.0" });
    expect(refusal).toContain("--allow-host");

    expect(httpRefusal({ host: "0.0.0.0", allowedHosts: ["patterns.internal"] })).toBeUndefined();
    expect(httpRefusal({ host: "127.0.0.1" })).toBeUndefined();
  });
});

describe("the command line the operator types", () => {
  it("defaults to a port on this machine only", () => {
    const parsed = parseServeArgs([]);
    expect(parsed).toMatchObject({ kind: "serve", host: DEFAULT_HOST, path: DEFAULT_PATH, port: 3000 });
  });

  it("reads the port as a number, since every argument arrives as text", () => {
    expect(parseServeArgs(["--port", "8080"])).toMatchObject({ port: 8080 });
    // Zero is legitimate — bind anything free — so the check is a range rather than a truthiness test.
    expect(parseServeArgs(["--port", "0"])).toMatchObject({ port: 0 });
    expect(parseServeArgs(["--port", "not-a-port"])).toMatchObject({ kind: "usage" });
    expect(parseServeArgs(["--port", "70000"])).toMatchObject({ kind: "usage" });
  });

  it("collects repeated allowlist flags rather than keeping the last", () => {
    const parsed = parseServeArgs([
      "--allow-host",
      "one.internal",
      "--allow-host",
      "two.internal",
      "--allow-origin",
      "app.internal",
    ]);
    expect(parsed).toMatchObject({
      allowedHosts: ["one.internal", "two.internal"],
      allowedOrigins: ["app.internal"],
    });
  });

  it("leaves the allowlists absent when unnamed, which is not the same as empty", () => {
    // Absent means "the localhost default"; empty would mean "allow nothing", and a flag that silently
    // turned the first into the second would produce a server refusing every request.
    const parsed = parseServeArgs([]);
    expect(parsed).not.toHaveProperty("allowedHosts");
  });

  it("refuses a flag it does not know rather than ignoring it (FR-051)", () => {
    const parsed = parseServeArgs(["--porte", "8080"]);
    expect(parsed).toMatchObject({ kind: "usage" });
  });

  it("explains itself when asked", () => {
    expect(parseServeArgs(["--help"])).toEqual({ kind: "help" });
  });
});

describe("bound to a real port", () => {
  it("serves over a socket, and stops when closed", async () => {
    // One case that opens a port, because the bridge from Node's streams to a web `Request` is real code
    // and nothing above this exercises it.
    const handle = await serveHttp({ port: 0, log: () => {} });
    try {
      const response = await fetch(
        post("tools/list", {}, { url: `http://127.0.0.1:${String(handle.port)}/mcp`, headers: { host: `127.0.0.1:${String(handle.port)}` } }),
      );
      expect(response.status).toBe(200);
      expect((await jsonOf(response)).error).toBeUndefined();
    } finally {
      await handle.close();
    }

    await expect(fetch(`http://127.0.0.1:${String(handle.port)}/mcp`)).rejects.toThrow();
  });
});
