/**
 * The remote transport (FR-030), stateless by construction (FR-031).
 *
 * Two layers, because they fail differently and are worth driving separately. `httpHandler` is fetch-shaped
 * and holds every decision: which requests are refused before the protocol sees them, which path is
 * served, and where errors are reported. `serveHttp` binds that handler to a port. A contract test drives
 * the first with a `Request` and never opens a socket; the operator gets the second.
 *
 * Statelessness is `createMcpHandler`'s contract rather than something enforced here: it calls the factory
 * once per HTTP request, so no instance outlives the request that made it and there is nowhere for
 * cross-request state to accumulate. That is also what satisfies FR-037's prohibition on session
 * identifiers — `legacy: "stateless"` builds the 2025-era leg with no session generator, so none is minted,
 * and one that arrives in a header is neither read nor echoed. Every clause of that paragraph is asserted
 * in `test/contract/http.test.ts`, because all of it is a promise about somebody else's code.
 */

import { createServer as createHttpServer } from "node:http";
import type { Server as NodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

import { toNodeHandler } from "@modelcontextprotocol/node";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";

import { warmEngine } from "../../engine/generate/index.js";
import { MINIMUM_NODE, runtimeSupported } from "../../engine/verify/runtime.js";
import { stderrLog } from "../log.js";
import type { Logger } from "../log.js";
import { createServer } from "../server.js";

/** The address bound when none is named: reachable from this machine and nowhere else. */
export const DEFAULT_HOST = "127.0.0.1";
/** The port bound when none is named. */
export const DEFAULT_PORT = 3000;
/** The path served when none is named. */
export const DEFAULT_PATH = "/mcp";

/** The addresses that reach only this machine, and so need no allowlist of their own. */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpOptions {
  /** The path requests are served on. Anything else is answered `404`. Defaults to `/mcp`. */
  readonly path?: string;
  /**
   * Hostnames a request may name in `Host`, without ports. Defaults to the localhost set.
   *
   * This is the DNS-rebinding defence (FR-037). A browser tricked into resolving an attacker's name to
   * this address still sends that name in `Host`, and it is not on this list.
   */
  readonly allowedHosts?: readonly string[];
  /** Hostnames a request may name in `Origin`, without scheme or port. Defaults to the localhost set. */
  readonly allowedOrigins?: readonly string[];
  /** Where out-of-band errors go. Defaults to stderr. */
  readonly log?: Logger;
}

export interface HttpHandler {
  /** Serves one request. Web-standard, so a test needs no socket. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Releases the handler's resources. Opens and closes no socket. */
  readonly close: () => Promise<void>;
}

/**
 * The request-level server: everything except the socket.
 *
 * The gate's order is deliberate. `Host` and `Origin` are checked before the path, so a request that fails
 * either is refused for that reason rather than told which paths exist, and both are checked before the
 * protocol, so a refused request never constructs a server instance or reaches a tool.
 */
export function httpHandler(options: HttpOptions = {}): HttpHandler {
  const log = options.log ?? stderrLog;
  const path = options.path ?? DEFAULT_PATH;
  const hosts = [...(options.allowedHosts ?? localhostAllowedHostnames())];
  const origins = [...(options.allowedOrigins ?? localhostAllowedOrigins())];

  const handler = createMcpHandler(() => createServer(), {
    // Both eras, matching stdio, so a client is served rather than told to upgrade. Because serving is
    // per-request, the SDK answers the two session operations the 2025 era has — `GET` and `DELETE` — with
    // `405`, which is FR-037's "refuse superseded request forms" without code of our own.
    legacy: "stateless",
    onerror: (error: Error) => {
      log(`error: ${error.message}`);
    },
  });

  return {
    fetch: async (request: Request): Promise<Response> =>
      hostHeaderValidationResponse(request, hosts) ??
      originValidationResponse(request, origins) ??
      (new URL(request.url).pathname === path
        ? await handler.fetch(request)
        : notFound(path)),
    close: async (): Promise<void> => {
      await handler.close();
    },
  };
}

/**
 * A path that is not the endpoint.
 *
 * JSON-RPC in the body as well as the status, because the caller here is a client library that will try to
 * parse what it gets: a bare HTML or empty `404` is reported to its user as a parse failure, which sends
 * them looking for a protocol bug instead of at their URL.
 */
function notFound(path: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: `Not found. This server serves MCP on ${path}.` },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

export interface ServeHttpOptions extends HttpOptions {
  /** Defaults to 3000. Zero binds an arbitrary free port, which is what the tests use. */
  readonly port?: number;
  /** The address to bind. Defaults to loopback. */
  readonly host?: string;
}

export interface HttpServerHandle {
  /** The port actually bound, which is what a caller passing `port: 0` needs. */
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Binds the handler to a port.
 *
 * The Node bridge comes from the SDK's adapter rather than being written here, and that is not laziness:
 * a modern exchange upgrades to SSE the moment a handler emits anything before its result, and a bridge
 * that buffered the response body — the obvious way to write one — would hold a stream open forever
 * instead of forwarding it. The adapter honours write backpressure for exactly that case.
 */
export async function serveHttp(options: ServeHttpOptions = {}): Promise<HttpServerHandle> {
  const log = options.log ?? stderrLog;
  const handler = httpHandler(options);
  const bridge = toNodeHandler(handler, {
    onerror: (error: Error) => {
      log(`error: ${error.message}`);
    },
  });

  const server: NodeHttpServer = createHttpServer((request, response) => {
    // The adapter's structural type declares `method?: string`; Node's declares `string | undefined`, and
    // under `exactOptionalPropertyTypes` those are different claims. The difference is real but not ours:
    // `IncomingMessage` is shared with client-side responses, which have no method, while a request handed
    // to a server's request handler always has one. Sound at this call site and nowhere else, which is why
    // it is written here rather than by widening the option.
    void bridge(request as NodeIncomingMessageLike, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST, resolve);
  });

  const bound = server.address() as AddressInfo;

  // Once bound, so the port is open before the compiler starts and a client is never refused a connection
  // while this runs. Not awaited, for the reason `stdio.ts` gives at length: warming is reuse rather than a
  // precondition, and a request that arrives first is answered correctly and merely pays for what is
  // missing. Here it belongs to `serveHttp` rather than to `httpHandler` because the handler is what the
  // contract tests build, and warming there would start a compiler subprocess in every one of them.
  void warmEngine().catch((error: unknown) => {
    log(`warm failed, serving cold: ${error instanceof Error ? error.message : "unknown"}`);
  });

  return {
    port: bound.port,
    close: async (): Promise<void> => {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Why this process must not serve over HTTP, or `undefined` when it may.
 *
 * Two reasons, and the second is the one worth having. The runtime check is the promise stdio makes: a
 * bundle is returned only once its tests have run inside the sandbox, and a runtime without the flag would
 * answer every default request with a defect report about a pattern that has none.
 *
 * The host check closes the gap between binding and allowing. A server bound beyond loopback while its
 * allowlist still says `localhost` would accept connections and refuse every one with a `403` — which
 * reads as a broken server rather than as the omission it is. The hostnames clients will use are exactly
 * the input the rebinding defence needs, so they are required rather than inferred: adding the bound
 * address automatically would defeat the check it appears to satisfy.
 */
export function httpRefusal(
  options: { readonly host?: string; readonly allowedHosts?: readonly string[] } = {},
  version: string = process.versions.node,
): string | undefined {
  if (!runtimeSupported(version)) {
    return (
      `Refusing to start: this server needs Node ${MINIMUM_NODE} or newer and this is Node ${version}. ` +
      `Every generated bundle is proved by running its tests inside Node's permission model, and the ` +
      `flag that enables it is not recognised here, so each request would be answered with a defect ` +
      `report about the pattern rather than with code. Upgrade Node and start it again.`
    );
  }

  const host = options.host ?? DEFAULT_HOST;
  if (LOOPBACK.has(host) || options.allowedHosts !== undefined) return undefined;

  return (
    `Refusing to start: --host ${host} accepts connections from other machines, but the Host allowlist ` +
    `still permits only ${[...LOOPBACK].join(", ")}, so every one of those connections would be answered ` +
    `with 403. Pass --allow-host with the hostname clients will use. It is required rather than taken from ` +
    `--host because that allowlist is what stops a browser being tricked into treating this server as the ` +
    `attacker's own, and a list the server wrote for itself would stop nothing.`
  );
}

const USAGE = `patterns-mcp-http — serves the pattern catalogue over HTTP

  --port <number>          port to bind (default ${String(DEFAULT_PORT)})
  --host <address>         address to bind (default ${DEFAULT_HOST}, this machine only)
  --path <path>            path to serve on (default ${DEFAULT_PATH})
  --allow-host <hostname>  a hostname requests may name in Host; repeatable
  --allow-origin <host>    a hostname requests may name in Origin; repeatable
  --help

Binding beyond ${DEFAULT_HOST} requires at least one --allow-host: the Host allowlist is what stops a
browser being tricked into treating this server as an attacker's own, and it cannot be inferred from
--host without defeating itself.

For a local client, use the stdio binary instead — patterns-mcp — which needs no port.
`;

/** Parses the command line, or explains why it cannot. */
export function parseServeArgs(
  argv: readonly string[],
):
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | {
      readonly kind: "serve";
      readonly port: number;
      readonly host: string;
      readonly path: string;
      readonly allowedHosts?: readonly string[];
      readonly allowedOrigins?: readonly string[];
    } {
  let values: {
    port?: string;
    host?: string;
    path?: string;
    "allow-host"?: string[];
    "allow-origin"?: string[];
    help?: boolean;
  };

  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string" },
        host: { type: "string" },
        path: { type: "string" },
        "allow-host": { type: "string", multiple: true },
        "allow-origin": { type: "string", multiple: true },
        help: { type: "boolean" },
      },
      // Refused rather than ignored, for the reason the tool schemas are strict (FR-051): a flag we do not
      // know is a request we are not honouring, and honouring most of a request is worse than refusing it.
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { kind: "usage", message: error instanceof Error ? error.message : "could not read the arguments" };
  }

  if (values.help === true) return { kind: "help" };

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    // The value is echoed because it came from this machine's own operator at their own shell, and the
    // number they typed is the whole content of the message.
    return { kind: "usage", message: `--port must be a whole number from 0 to 65535, not ${String(values.port)}` };
  }

  return {
    kind: "serve",
    port,
    host: values.host ?? DEFAULT_HOST,
    path: values.path ?? DEFAULT_PATH,
    // Absent rather than empty when not given, because the transport reads absence as "use the localhost
    // default" and an empty list as "allow nothing".
    ...(values["allow-host"] === undefined ? {} : { allowedHosts: values["allow-host"] }),
    ...(values["allow-origin"] === undefined ? {} : { allowedOrigins: values["allow-origin"] }),
  };
}

/** Runs the server until the process ends. Returns the exit code when it declines to start. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseServeArgs(argv);

  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (parsed.kind === "usage") {
    stderrLog(parsed.message);
    stderrLog("");
    stderrLog(USAGE);
    return 2;
  }

  const refusal = httpRefusal(parsed);
  if (refusal !== undefined) {
    stderrLog(refusal);
    return 1;
  }

  const handle = await serveHttp(parsed);

  // stderr, so that a script piping stdout gets nothing it did not ask for. The bound port rather than the
  // requested one, because `--port 0` is a legitimate request and the answer is only known now.
  stderrLog(
    `patterns-mcp-http listening on http://${parsed.host}:${String(handle.port)}${parsed.path}` +
      (parsed.allowedHosts === undefined ? " (this machine only)" : ` (Host: ${parsed.allowedHosts.join(", ")})`),
  );

  return 0;
}
