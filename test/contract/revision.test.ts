/**
 * What a client of protocol revision `2026-07-28` receives (FR-054).
 *
 * The revision is the largest break the protocol has had. It removes the `initialize` handshake and makes
 * every request self-describing, requires `server/discover`, puts a `resultType` on every result, renumbers
 * resource-not-found from `-32002` to `-32602`, deletes `ping`, `logging/setLevel`, and the `resources`
 * subscribe pair, and closes the question of who may name a `_meta` key. Almost all of that arrives through
 * the SDK rather than through code of ours, which is exactly why it needs a suite: a dependency can stop
 * providing a guarantee, and the ones here are guarantees the server's own description of itself depends on.
 *
 * It also covers a blind spot rather than a hypothetical one. The SDK's client opens a *legacy* session
 * unless told otherwise, so every contract suite here spoke the older protocol while the revision's fields
 * went unobserved — and the host this server was written for is modern. These tests open the modern era
 * deliberately, most of them through raw frames, because a typed client validates results against schemas
 * and drops what they omit: `resultType` never survives the trip.
 */

import { describe, expect, it } from "vitest";

import { CACHE_TTL_MS } from "../../src/mcp/cache.js";
import { META_KEYS, META_PREFIX } from "../../src/mcp/meta.js";
import { SERVER_NAME, SERVER_TITLE, VERSION } from "../../src/version.js";
import { REVISION, connect } from "./client.js";
import { frames } from "./frames.js";
import type { Frames } from "./frames.js";

/**
 * The per-request envelope the revision replaced the handshake with. `protocolVersion` and
 * `clientCapabilities` are required on every request; `clientInfo` is a SHOULD, and included because a
 * server ought to be exercised the way clients are told to behave.
 */
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "revision-tests", version: "0.0.0" },
} as const;

const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/** A modern request: no handshake before it, and its own `_meta` envelope. */
async function cold(
  session: Frames,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await session.request(id, method, { ...params, _meta: ENVELOPE });
}

function resultOf(frame: Record<string, unknown>, method: string): Record<string, unknown> {
  expect(frame.error, `${method} failed: ${JSON.stringify(frame.error)}`).toBeUndefined();
  return frame.result as Record<string, unknown>;
}

function errorOf(frame: Record<string, unknown>, method: string): { code: number; message: string; data?: unknown } {
  expect(frame.error, `${method} was answered rather than refused`).toBeDefined();
  return frame.error as { code: number; message: string; data?: unknown };
}

describe("server/discover", () => {
  /**
   * A MUST, and the one request that has to work before anything else can.
   *
   * It is also how a dual-era *client* decides what this server is: the stdio binding says to probe with
   * `server/discover` and fall back to `initialize` on any answer that is not a recognized modern one. A
   * server that failed this would be treated as legacy by every client that follows that advice.
   */
  it("is answered on a connection where nothing has been sent before it", async () => {
    const session = frames();
    try {
      const result = resultOf(await cold(session, 1, "server/discover"), "server/discover");

      expect(result.supportedVersions, "the revision is not among the versions offered").toContain(REVISION);
      expect(result.capabilities).toMatchObject({
        tools: { listChanged: false },
        resources: { listChanged: false },
      });
      // Prepended to a caller's context, so its absence is a silent loss of the call order and the
      // guarantee that generated code is already proved.
      expect(result.instructions).toContain("generate_pattern");
    } finally {
      await session.close();
    }
  });

  it("identifies the server by the name its registry entry uses", async () => {
    const session = frames();
    try {
      const result = resultOf(await cold(session, 1, "server/discover"), "server/discover");
      expect(result._meta).toMatchObject({
        [SERVER_INFO_KEY]: { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
      });
    } finally {
      await session.close();
    }
  });
});

describe("a stateless request", () => {
  /**
   * The point of the revision, asserted end to end: a tool call that generates, with no session
   * established beforehand and nothing carried between requests but the envelope.
   */
  it("is served with no handshake, and generation works the same way", async () => {
    const session = frames(120_000);
    try {
      const call = resultOf(
        await cold(session, 1, "tools/call", {
          name: "generate_pattern",
          arguments: { pattern: "result", identifiers: { entity: "Order" } },
        }),
        "tools/call",
      );

      expect(call.isError, "generation was refused, so this asserts nothing about statelessness").not.toBe(true);
      const structured = call.structuredContent as { files?: readonly unknown[] } | undefined;
      expect(structured?.files?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
    // Generation compiles a bundle and runs its tests, so this is the one case here that needs more than
    // the default timeout — it passes in under a second alone and takes several under a loaded gate.
  }, 120_000);

  /**
   * A request of this revision missing a required field is malformed and MUST be refused with `-32602`.
   *
   * "Of this revision" is the part worth being precise about, and it is decided by the version claim alone.
   * A request carrying no claim is not a malformed modern request but an era-ambiguous one, and this server
   * serves those as legacy — which is what makes a 2025-era client work at all, since that client sends no
   * `_meta` and would otherwise be answered with an error naming a revision it has never heard of.
   */
  it("is refused when it claims the revision but leaves out a field the revision requires", async () => {
    const session = frames();
    try {
      const error = errorOf(
        await session.request(1, "tools/list", {
          _meta: { "io.modelcontextprotocol/protocolVersion": REVISION },
        }),
        "a request with no client capabilities",
      );

      expect(error.code).toBe(-32_602);
      expect(error.message).toContain("clientCapabilities");
    } finally {
      await session.close();
    }
  });

  /**
   * And once a connection is speaking the revision, a request that stops carrying the envelope cannot be
   * quietly re-read as a legacy one: the era is a property of the connection, so the alternative to
   * refusing is answering under semantics the client did not ask for.
   */
  it("is refused when it drops the envelope on a connection already speaking the revision", async () => {
    const session = frames();
    try {
      resultOf(await cold(session, 1, "tools/list"), "tools/list");

      const error = errorOf(await session.request(2, "tools/list"), "a later request with no envelope");
      expect(error.code).toBe(-32_602);
    } finally {
      await session.close();
    }
  });

  /**
   * A version this server does not speak has to be named as such, with the versions it does speak.
   *
   * This is the whole of a modern client's recovery path: there is no handshake to renegotiate in, so a
   * client that asked for the wrong revision learns what to ask for from `data.supported` or not at all.
   */
  it("is refused with the supported versions when it claims one we do not speak", async () => {
    const session = frames();
    try {
      const error = errorOf(
        await session.request(1, "tools/list", {
          _meta: { ...ENVELOPE, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
        }),
        "a request claiming 2099-01-01",
      );

      expect(error.code).toBe(-32_022);
      expect((error.data as { supported?: readonly string[] } | undefined)?.supported).toContain(REVISION);
    } finally {
      await session.close();
    }
  });
});

describe("every result", () => {
  /**
   * `resultType` is required on all of them, and its absence means something specific: a client must read a
   * result without it as coming from an earlier-protocol server. Omitting it would therefore not be a
   * missing field but a misrepresentation of which protocol this server speaks.
   */
  it("says it is complete, since none of this server's work needs a second round trip", async () => {
    const session = frames(120_000);
    try {
      const methods: readonly [string, Record<string, unknown>][] = [
        ["server/discover", {}],
        ["tools/list", {}],
        ["resources/list", {}],
        ["resources/templates/list", {}],
        ["resources/read", { uri: "pattern://catalog" }],
        ["tools/call", { name: "list_patterns", arguments: {} }],
      ];

      let id = 0;
      for (const [method, params] of methods) {
        const result = resultOf(await cold(session, ++id, method, params), method);
        expect(result.resultType, `${method} does not declare its result type`).toBe("complete");
      }
    } finally {
      await session.close();
    }
  });

  it("carries the server's identity, which is all a stateless client has to go on", async () => {
    const session = frames();
    try {
      const result = resultOf(await cold(session, 1, "tools/list"), "tools/list");
      expect(result._meta).toMatchObject({ [SERVER_INFO_KEY]: { name: SERVER_NAME, version: VERSION } });
    } finally {
      await session.close();
    }
  });
});

describe("the operations the revision makes cacheable", () => {
  /**
   * The protocol's own fields, on the wire, in the era that defines them.
   *
   * This is the assertion that was missing while the declaration in `server.ts` was gated on the SDK's
   * *legacy* version list — a list that will never contain this revision, so the gate never opened and the
   * fields were never once observed. See `cache-hints.test.ts` for the `tools/call` half.
   */
  it("state a lifetime and a scope rather than falling back to zero and private", async () => {
    const session = frames();
    try {
      const methods = [
        "server/discover",
        "tools/list",
        "resources/list",
        "resources/templates/list",
      ] as const;

      let id = 0;
      for (const method of methods) {
        const result = resultOf(await cold(session, ++id, method), method);
        expect(result.ttlMs, `${method} gives no lifetime`).toBe(CACHE_TTL_MS);
        expect(result.cacheScope, `${method} does not say who may cache it`).toBe("public");
      }

      const read = resultOf(await cold(session, ++id, "resources/read", { uri: "pattern://catalog" }), "resources/read");
      expect(read.ttlMs).toBe(CACHE_TTL_MS);
      expect(read.cacheScope).toBe("public");
    } finally {
      await session.close();
    }
  });
});

describe("error codes", () => {
  /**
   * `-32002` is retired: implementations of this revision MUST NOT emit it, and a resource that does not
   * exist is invalid params like any other bad argument.
   */
  it("report a resource that does not exist as invalid params, never as the retired -32002", async () => {
    const session = frames();
    try {
      const error = errorOf(
        await cold(session, 1, "resources/read", { uri: "pattern://catalog/no-such-pattern" }),
        "reading a resource that does not exist",
      );

      expect(error.code).toBe(-32_602);
      expect(error.code, "the code this revision retired").not.toBe(-32_002);
      // The refusal still has to be useful: a caller who guessed a name needs to know where the real ones are.
      expect(error.message).toContain("list_patterns");
    } finally {
      await session.close();
    }
  });

  /**
   * `-32020` to `-32099` belongs to the specification, and an implementation MUST NOT emit a code in it
   * that the specification has not defined. Ours are `-32602` and `-32601`, with `-32022` coming from the
   * SDK; nothing here allocates a code of its own, and this is the check that keeps it that way.
   */
  it("stay out of the range the specification reserves for itself", async () => {
    const session = frames();
    try {
      const defined = new Set([-32_020, -32_021, -32_022]);
      const requests: readonly [string, Record<string, unknown>][] = [
        ["resources/read", { uri: "pattern://catalog/no-such-pattern" }],
        ["resources/read", { uri: "not-even-a-pattern-uri" }],
        ["no/such/method", {}],
        ["tools/call", { name: "no_such_tool", arguments: {} }],
      ];

      let id = 0;
      for (const [method, params] of requests) {
        const frame = await cold(session, ++id, method, params);
        const code = (frame.error as { code?: number } | undefined)?.code;
        if (code === undefined) continue;
        if (code <= -32_020 && code >= -32_099) {
          expect(defined, `${method} answered with ${String(code)}, a reserved code the spec does not define`)
            .toContain(code);
        }
      }
    } finally {
      await session.close();
    }
  });
});

describe("the methods the revision removed", () => {
  /**
   * Kept as a test rather than trusted, because each of these would be *worse* than absent if it answered:
   * a client seeing `ping` succeed would conclude it is talking to a server of an earlier revision.
   */
  it("are gone, and are reported as unknown methods", async () => {
    const session = frames();
    try {
      const removed: readonly [string, Record<string, unknown>][] = [
        ["ping", {}],
        ["logging/setLevel", { level: "debug" }],
        ["resources/subscribe", { uri: "pattern://catalog" }],
        ["resources/unsubscribe", { uri: "pattern://catalog" }],
      ];

      let id = 0;
      for (const [method, params] of removed) {
        const error = errorOf(await cold(session, ++id, method, params), method);
        expect(error.code, `${method} was answered, so this server looks like a pre-revision one`).toBe(-32_601);
      }
    } finally {
      await session.close();
    }
  });

  /**
   * Roots, sampling, and logging are deprecated by this revision and new implementations should not adopt
   * them. A pure function has nothing to ask a client for and writes its diagnostics to stderr, so the
   * absence costs nothing — but a capability added by habit would commit us to a feature on its way out.
   */
  it("are not advertised as capabilities either", async () => {
    const session = frames();
    try {
      const result = resultOf(await cold(session, 1, "server/discover"), "server/discover");
      const capabilities = result.capabilities as Record<string, unknown>;

      for (const deprecated of ["logging", "roots", "sampling", "elicitation"]) {
        expect(capabilities[deprecated], `${deprecated} is deprecated and this server does not implement it`)
          .toBeUndefined();
      }
    } finally {
      await session.close();
    }
  });
});

describe("tools/list", () => {
  /**
   * A SHOULD, and one this server gets for free from registering in a fixed order — worth pinning because
   * it is what lets a client cache the list and keeps an LLM's prompt cache warm across calls.
   */
  it("returns tools in the same order every time", async () => {
    const session = frames();
    try {
      const order = async (id: number): Promise<readonly string[]> =>
        ((resultOf(await cold(session, id, "tools/list"), "tools/list").tools as readonly { name: string }[]) ?? []).map(
          (tool) => tool.name,
        );

      const first = await order(1);
      expect(first.length).toBeGreaterThan(0);
      expect(await order(2)).toEqual(first);
      expect(await order(3)).toEqual(first);
    } finally {
      await session.close();
    }
  });
});

describe("a legacy client", () => {
  /**
   * Still served, because the revision permits a dual-era server and hosts on both sides of it exist. A
   * legacy client has no fall-forward mechanism: if `initialize` stopped working, it could not discover
   * that a modern path was available, so this is the compatibility that has to be checked rather than
   * assumed.
   */
  it("can still open a session with initialize and use the tools", async () => {
    const session = frames();
    try {
      const init = resultOf(
        await session.request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.0" },
        }),
        "initialize",
      );
      expect(init.protocolVersion).toBe("2025-11-25");
      expect(init.serverInfo).toMatchObject({ name: SERVER_NAME, version: VERSION });

      session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const tools = resultOf(await session.request(2, "tools/list"), "tools/list");
      expect((tools.tools as readonly { name: string }[]).map((tool) => tool.name)).toContain("generate_pattern");
    } finally {
      await session.close();
    }
  });
});

describe("the _meta keys this server mints", () => {
  /**
   * The rule that caught a real mistake: a prefix whose second label is `modelcontextprotocol` or `mcp` is
   * reserved for MCP use, and this server had been annotating results with
   * `io.modelcontextprotocol/cache-hint` — a key the specification does not define and therefore no client
   * could read, sitting in the one namespace a future revision is free to give a different meaning.
   */
  it("sit under a prefix that is ours to allocate in", () => {
    for (const key of META_KEYS) {
      expect(key.startsWith(META_PREFIX), `${key} is not under this server's prefix`).toBe(true);

      const [prefix, name] = key.split("/");
      const labels = (prefix ?? "").split(".");
      expect(labels[1], `${key} sits in a namespace reserved for MCP`).not.toBe("modelcontextprotocol");
      expect(labels[1], `${key} sits in a namespace reserved for MCP`).not.toBe("mcp");
      // Reverse DNS, and a name the key-format rules accept.
      expect(labels[0]).toBe("com");
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
    }
  });

  /**
   * Asserted on the wire rather than by reading the source, because the source can only be searched for the
   * mistakes already thought of. Every key a client actually receives is either one the specification
   * defines or one of ours.
   */
  it("are the only unreserved keys a client receives", async () => {
    const session = await connect("modern");
    try {
      const spelled = new Set<string>(META_KEYS);
      const seen = new Set<string>();

      const collect = (meta: unknown): void => {
        for (const key of Object.keys((meta ?? {}) as Record<string, unknown>)) seen.add(key);
      };

      const { tools } = await session.client.listTools();
      for (const tool of tools) collect(tool._meta);

      collect((await session.client.callTool({ name: "list_patterns", arguments: {} }))._meta);
      // A refusal, which is where this server attaches the most metadata of its own.
      collect(
        (await session.client.callTool({ name: "generate_pattern", arguments: { pattern: "no-such-pattern" } }))._meta,
      );
      collect((await session.client.readResource({ uri: "pattern://catalog" }))._meta);

      expect(seen.size, "no metadata was collected, so this asserts nothing").toBeGreaterThan(0);
      for (const key of seen) {
        if (key.startsWith("io.modelcontextprotocol/")) {
          // Minted by the SDK from the specification's own vocabulary, not by us.
          expect(key).toBe(SERVER_INFO_KEY);
          continue;
        }
        expect(spelled, `${key} reaches clients but is not one of this server's declared keys`).toContain(key);
      }
    } finally {
      await session.close();
    }
  }, 60_000);
});
