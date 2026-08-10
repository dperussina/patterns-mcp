/**
 * The MCP server (contracts/mcp-tools.md, contracts/mcp-resources.md).
 *
 * An adapter, and nothing more: it translates protocol into engine calls. Generation lives behind
 * `src/index.ts`, which is why a CLI can offer the same capability without sharing a line of this file
 * (Principle X).
 */

import { McpServer } from "@modelcontextprotocol/server";

import { disposeEngine } from "../engine/generate/index.js";
import { CATALOG_CACHE_HINT, registerCatalogResources } from "./resources/catalog.js";
import { describeInput, describeOutput, handleDescribe } from "./tools/describe.js";
import { generateInput, generateOutput, handleGenerate } from "./tools/generate.js";
import { handleList, listInput, listOutput } from "./tools/list.js";

/**
 * Read-only, non-destructive, idempotent, closed-world — all four true of every tool here, because
 * generation writes nothing and consults nothing outside the request.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Generation is cacheable keyed on the whole input, which is a consequence of determinism rather than
 * an optimisation: the same request cannot produce a different bundle, so a cached response cannot be
 * stale (Principle I).
 *
 * Carried in `_meta` rather than as a protocol cache hint because `tools/call` is not one of the
 * revision's cacheable results — that closed list covers the various `list` operations,
 * `resources/read`, and `server/discover`. So this is an annotation a client may act on, not a protocol
 * guarantee, and the cache hints that *are* protocol-level are declared on the server below.
 */
const CACHEABLE = { "io.modelcontextprotocol/cache-hint": { cacheable: true, scope: "public" } };

/**
 * The catalogue ships with the build and generation is a pure function of its input, so nothing this
 * server can answer changes while it is running. The tool and resource *lists* are therefore fixed:
 * `listChanged: false` is a fact about the design rather than an unimplemented feature.
 *
 * `logging` is absent because the revision deprecates it and diagnostics go to stderr. Sampling and
 * roots are absent because a pure function has nothing to ask a client for.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false, subscribe: false },
} as const;

/**
 * Short on purpose: it is prepended to a caller's context on every session, so length is a tax paid per
 * conversation. It states the call order and the one guarantee that changes how a caller should treat
 * the output — that it has already been compiled and tested, so it does not need reviewing for whether
 * it builds.
 */
const INSTRUCTIONS =
  "Call list_patterns to see what exists, describe_pattern for one pattern's options and rules, then " +
  "generate_pattern. Generated code is typechecked and its tests are executed before it is returned, " +
  "and identical requests return identical bytes.";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "patterns", version: "0.1.0" },
    {
      capabilities: CAPABILITIES,
      instructions: INSTRUCTIONS,
      /**
       * Every list the SDK builds itself describes build-time data, so all of them get the catalogue's
       * hint. `resources/read` is included as the per-operation fallback; individual resources set the
       * same hint, and this makes a resource added later cacheable by default rather than by memory.
       */
      cacheHints: {
        "tools/list": CATALOG_CACHE_HINT,
        "resources/list": CATALOG_CACHE_HINT,
        "resources/templates/list": CATALOG_CACHE_HINT,
        "resources/read": CATALOG_CACHE_HINT,
        "server/discover": CATALOG_CACHE_HINT,
      },
    },
  );

  server.registerTool(
    "list_patterns",
    {
      title: "List available patterns",
      description:
        "Browse the pattern catalog. Returns a summary of each pattern — name, intent, category — " +
        "which is enough to choose one. Cheap and cacheable; call this first.",
      inputSchema: listInput,
      outputSchema: listOutput,
      annotations: READ_ONLY,
      _meta: CACHEABLE,
    },
    async (args) => await handleList(args),
  );

  server.registerTool(
    "describe_pattern",
    {
      title: "Describe one pattern",
      description:
        "Everything needed to call generate_pattern correctly the first time: every option with its " +
        "permitted values and default, and the rules that would refuse a request.",
      inputSchema: describeInput,
      outputSchema: describeOutput,
      annotations: READ_ONLY,
      _meta: CACHEABLE,
    },
    async (args) => await handleDescribe(args),
  );

  server.registerTool(
    "generate_pattern",
    {
      title: "Generate a pattern implementation",
      description:
        "Generate a complete, reusable TypeScript module implementing a known pattern, fitted to your " +
        "project's conventions. Every bundle is typechecked before it is returned, and its tests are " +
        "executed, so what you receive compiles and passes. Identical requests return identical bytes.",
      inputSchema: generateInput,
      outputSchema: generateOutput,
      annotations: READ_ONLY,
      _meta: CACHEABLE,
    },
    async (args) => await handleGenerate(args),
  );

  registerCatalogResources(server);
  releaseEngineOnClose(server);

  return server;
}

/**
 * Releases the compiler when the server closes.
 *
 * The engine keeps one warm compiler subprocess for the life of the process, which is what makes a check
 * cost ~13ms rather than ~130ms. Nothing else knows when that stops being wanted: the engine cannot tell a
 * pause between requests from the end of the session, and the subprocess is an active handle, so a host
 * that closed its server would sit there unable to exit. So the server, which is the thing whose lifetime
 * matches the engine's, ends it — wrapping `close` rather than using `onclose`, because that hook belongs
 * to whoever constructed the server and taking it would silently discard theirs.
 */
function releaseEngineOnClose(server: McpServer): void {
  const close = server.close.bind(server);

  server.close = async (): Promise<void> => {
    await close();
    await disposeEngine();
  };
}
